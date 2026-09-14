/**
 * Writes the articles into their tables (layer L1, described in
 * src/articles.ts) and makes sure every one reads back as the tree its file
 * parsed to. The layout is the DTD's: a table for every declared element with
 * its declared attributes, so an element or attribute the DTD does not know
 * stops the import instead of being dropped.
 */
import type { Database } from "bun:sqlite";
import {
  ELEMENTS, ATTRIBUTES, articleOf, rootsOf, readArticle, inventory, emptyInventory, domEqual,
  type ArticleSource, type Document, type Element, type Inventory, type Node, type TextNode,
} from "voko-xml";
import { COMMENT, TEXT, documentsOf, indentation, tableName } from "../articles";

/** `meta.elements`: every declared element with its attributes, then text and comments. */
export const LAYOUT: string[][] = [...ELEMENTS.map((e) => [e, ...(ATTRIBUTES[e] ?? [])]), [TEXT], [COMMENT]];

export function documentTablesSql(layout: string[][] = LAYOUT): string {
  const tables = layout.map(([name, ...attributes]) => {
    const columns = ["id INTEGER PRIMARY KEY", "up INTEGER", "parent INTEGER GENERATED ALWAYS AS (id - up) VIRTUAL"];
    if (name === TEXT) columns.push("txt TEXT NOT NULL");
    else if (name === COMMENT) columns.push("txt TEXT NOT NULL", "ws TEXT");
    else columns.push("txt TEXT", ...attributes.map((a) => `${a} TEXT`), "ws TEXT", "ws_end TEXT", "open INTEGER");
    return `CREATE TABLE ${tableName(name)} (${columns.join(", ")});`;
  });
  return [
    "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);",
    "CREATE TABLE article (id INTEGER PRIMARY KEY, last_id INTEGER NOT NULL, file TEXT NOT NULL UNIQUE, source TEXT NOT NULL, rad TEXT NOT NULL);",
    ...tables,
  ].join("\n");
}

/** A row to write: one element, text or comment of a document. */
export interface DocumentRow {
  name: string;
  id: number;
  up: number | null;
  txt: string | null;
  ws: string | null;
  wsEnd: string | null;
  open: 1 | null;
  attrs: Record<string, string> | null;
}

const isBlank = (node: Node | undefined): node is TextNode => node?.type === "text" && node.value.trim() === "";

/**
 * A document as rows, in document order with ids from `first`: the comments
 * before the root, the root's tree, the comments after it. A comment outside
 * the root has no parent.
 */
export function rowsOf(doc: Document, first: number): DocumentRow[] {
  const rows: DocumentRow[] = [];
  let next = first;
  const outside = (comment: string) =>
    rows.push({ name: COMMENT, id: next++, up: null, txt: comment, ws: null, wsEnd: null, open: null, attrs: null });

  const element = (el: Element, parent: number | null, depth: number, ws: string | null) => {
    const id = next++;
    const kids = el.children;
    let txt: string | null = null;
    let wsEnd: string | null = null;
    let end = kids.length;
    if (kids.length === 1 && kids[0].type === "text") {
      txt = kids[0].value;
      end = 0;
    } else if (kids.length > 1 && isBlank(kids[kids.length - 1])) {
      wsEnd = (kids[kids.length - 1] as TextNode).value;
      end--;
    }
    rows.push({
      name: el.name,
      id,
      up: parent === null ? null : id - parent,
      txt,
      ws: parent === null ? null : storedWhitespace(ws, indentation(depth)),
      wsEnd: end > 0 ? storedWhitespace(wsEnd, indentation(depth)) : null,
      open: kids.length === 0 && !el.selfClosing ? 1 : null,
      attrs: el.attrs,
    });
    // Whitespace before an element or a comment goes into that row; a text row
    // has none, as text before text would be one run.
    let pending: string | null = null;
    for (let i = 0; i < end; i++) {
      const c = kids[i];
      if (isBlank(c) && i + 1 < end && kids[i + 1].type !== "text") {
        pending = c.value;
        continue;
      }
      if (c.type === "element") element(c, id, depth + 1, pending);
      else {
        const row = next++;
        rows.push({
          name: c.type === "text" ? TEXT : COMMENT, id: row, up: row - id, txt: c.value,
          ws: c.type === "text" ? null : storedWhitespace(pending, indentation(depth + 1)),
          wsEnd: null, open: null, attrs: null,
        });
      }
      pending = null;
    }
  };

  for (const p of doc.prolog) if (p.position === "before") outside(p.comment);
  element(doc.root, null, 0, null);
  for (const p of doc.prolog) if (p.position === "after") outside(p.comment);
  return rows;
}
function storedWhitespace(value: string | null, standard: string): string | null {
  return value === standard ? null : value ?? "";
}

// bun:sqlite drops a leading U+FEFF from a bound string (hipnot and hister
// write `&#65279;C. Baudoin`); bound as UTF-8 bytes and cast, it stays.
const utf8 = new TextEncoder();
function bound(value: string | null | undefined): string | Uint8Array | null {
  return value == null ? null : value.charCodeAt(0) === 0xfeff ? utf8.encode(value) : value;
}

function inserter(db: Database, name: string, attributes: string[]): (row: DocumentRow) => void {
  const table = tableName(name);
  if (name === TEXT) {
    const st = db.prepare(`INSERT INTO ${table} (id, up, txt) VALUES (?, ?, CAST(? AS TEXT))`);
    return (r) => st.run(r.id, r.up, bound(r.txt));
  }
  if (name === COMMENT) {
    const st = db.prepare(`INSERT INTO ${table} (id, up, txt, ws) VALUES (?, ?, CAST(? AS TEXT), CAST(? AS TEXT))`);
    return (r) => st.run(r.id, r.up, bound(r.txt), bound(r.ws));
  }
  const text = (n: number) => Array(n).fill(", CAST(? AS TEXT)").join("");
  const st = db.prepare(
    `INSERT INTO ${table} (${["id", "up", "txt", ...attributes, "ws", "ws_end", "open"].join(", ")})
     VALUES (?, ?${text(1 + attributes.length + 2)}, ?)`);
  return (r) => st.run(r.id, r.up, bound(r.txt), ...attributes.map((a) => bound(r.attrs?.[a])), bound(r.ws), bound(r.wsEnd), r.open);
}

function sameDocument(a: Document, b: Document): boolean {
  return a.xmlDecl === b.xmlDecl && a.doctype === b.doctype
    && JSON.stringify(a.prolog) === JSON.stringify(b.prolog) && domEqual(a.root, b.root);
}

/**
 * Parses `sources` into the tables of a database that has none yet, `batch`
 * articles to a transaction, and reads every batch back: an article that does
 * not come back as it was parsed stops the import. Returns what the articles
 * hold, element and attribute counts.
 */
export function importDocuments(db: Database, sources: ArticleSource[], { batch = 500, log = (_: string) => {} } = {}): Inventory {
  db.exec(documentTablesSql());
  const setMeta = db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)");
  setMeta.run("elements", JSON.stringify(LAYOUT));
  const insert = new Map(LAYOUT.map(([name, ...attributes]) => [name, inserter(db, name, attributes)]));
  const insertArticle = db.prepare("INSERT INTO article (id, last_id, file, source, rad) VALUES (?, ?, ?, ?, ?)");
  const inv = emptyInventory();
  let prolog: Pick<Document, "xmlDecl" | "doctype"> | null = null;
  let next = 1;

  for (let i = 0; i < sources.length; i += batch) {
    const parsed = new Map<string, Document>();
    const first = next;
    db.transaction(() => {
      for (const src of sources.slice(i, i + batch)) {
        const doc = readArticle(src);
        const found = inventory(doc);
        const unknown = [...Object.keys(found.unknownElements).map((e) => `<${e}>`), ...Object.keys(found.unknownAttributes)];
        if (unknown.length) throw new Error(`${src.key}: not in the DTD, so no column holds it: ${unknown.join(", ")}`);
        inventory(doc, inv);
        // One declaration and doctype for the corpus, kept once in meta.
        if (!prolog) {
          prolog = { xmlDecl: doc.xmlDecl, doctype: doc.doctype };
          setMeta.run("xml_decl", doc.xmlDecl);
          setMeta.run("doctype", doc.doctype);
        } else if (doc.xmlDecl !== prolog.xmlDecl || doc.doctype !== prolog.doctype) {
          throw new Error(`${src.key}: <?xml ${doc.xmlDecl}?> <!DOCTYPE ${doc.doctype}> differs from the other articles'`);
        }
        const rows = rowsOf(doc, next);
        for (const row of rows) insert.get(row.name)!(row);
        insertArticle.run(next, next + rows.length - 1, src.key, src.source, rootsOf(articleOf(doc)).rad);
        next += rows.length;
        parsed.set(src.key, doc);
      }
    })();

    let checked = 0;
    for (const { article, doc } of documentsOf(db, { from: first, batch })) {
      if (!sameDocument(parsed.get(article.file)!, doc)) throw new Error(`${article.file}: the stored article does not read back as the file`);
      if (++checked === parsed.size) break;
    }
    log(`${Math.min(i + batch, sources.length)}/${sources.length} articles`);
  }
  return inv;
}
