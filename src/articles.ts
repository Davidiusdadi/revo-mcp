/**
 * The stored articles: layer L1 of voko.db, the VOKO XML itself as tables.
 *
 * Every element type has a table named after it (`-` written `_`), with its
 * declared attributes as columns; text in mixed content and comments have
 * `text` and `comment`. All of them share one id sequence, the document order
 * of the whole corpus, so an article, an entry or any element is one id range
 * in every table. A row names its parent by the distance back to it, `up`;
 * the virtual column `parent` spells the id out.
 *
 * What an element holds is folded into its own row where that is the common
 * case, which is most of why the tables are smaller than the files:
 * - content that is one text node is the element's `txt`, not a `text` row;
 * - whitespace-only text before a row is that row's `ws`, and before the
 *   closing tag the element's `ws_end`. NULL there is the standard
 *   indentation for the depth (see indentation()), '' is no whitespace;
 * - `open` = 1 marks an empty element written `<x></x>` rather than `<x/>`.
 *
 * `meta.elements` lists the tables in order, each with its attribute
 * columns; the XML declaration and the doctype, the same in every file, are
 * `meta.xml_decl` and `meta.doctype`.
 *
 * A range read back is the tree the parser made of the file: the same
 * elements, attribute values, text and comments (domEqual). What XML itself
 * leaves open is not kept: the order of attributes, and which characters a
 * file wrote as entities.
 */

import type { SqlReader } from "./sql";
import type { Document, Element, Node } from "voko-xml/view";

export const TEXT = "#text";
export const COMMENT = "#comment";

/** One L1 table: the element (or #text, #comment) it stores and how its rows are read. */
export interface StoredTable {
  name: string;
  table: string;
  attributes: string[];
  /** the rows of an id range, `?` and `?` the first and last id */
  select: string;
}

/** A row of an L1 table, as select reads it. */
export interface StoredRow {
  id: number;
  up: number | null;
  txt: string | null;
  ws: string | null;
  ws_end?: string | null;
  open?: number | null;
  [attribute: string]: string | number | null | undefined;
}

export function tableName(name: string): string {
  return name === TEXT ? "text" : name === COMMENT ? "comment" : name.replace(/-/g, "_");
}

/** The tables for `meta.elements`: each entry the element name, then its attributes. */
export function storedTables(elements: string[][]): StoredTable[] {
  return elements.map(([name, ...attributes]) => {
    const table = tableName(name);
    const columns = name === TEXT ? "id, up, txt, '' AS ws"
      : name === COMMENT ? "id, up, txt, ws"
      : ["id, up, txt, ws, ws_end, open", ...attributes].join(", ");
    return { name, table, attributes, select: `SELECT ${columns} FROM ${table} WHERE id BETWEEN ? AND ?` };
  });
}

const tablesByDb = new WeakMap<SqlReader, StoredTable[]>();

/** The database's L1 tables, in the order `meta.elements` gives them. */
export function storedTablesOf(db: SqlReader): StoredTable[] {
  let tables = tablesByDb.get(db);
  if (!tables) {
    const row = db.query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'elements'").get();
    if (!row) throw new Error("This database does not store the articles (no meta.elements).");
    tables = storedTables(JSON.parse(row.value));
    tablesByDb.set(db, tables);
  }
  return tables;
}

/**
 * The whitespace a pretty-printed article puts before an element at `depth`
 * (the root `<vortaro>` is 0): a new line, and two spaces for every level
 * below `<art>`'s children. Nine in ten whitespace nodes of the corpus are
 * exactly this, and are stored as NULL.
 */
export function indentation(depth: number): string {
  return "\n" + "  ".repeat(Math.max(0, depth - 2));
}

function writtenWhitespace(stored: string | null, standard: string): string | null {
  return stored === null ? standard : stored === "" ? null : stored;
}

const ids = new WeakMap<Node, number>();

/** The id of a node read from the tables; undefined for what no row holds (folded text and whitespace). */
export function idOf(node: Node): number | undefined {
  return ids.get(node);
}

/** The last id of a node's subtree: its own, when nothing below it is a row. */
export function lastIdOf(node: Node): number {
  if (node.type === "element") {
    for (let i = node.children.length - 1; i >= 0; i--) {
      if (ids.has(node.children[i])) return lastIdOf(node.children[i]);
    }
  }
  const id = ids.get(node);
  if (id === undefined) throw new Error("lastIdOf: not a node read from the tables");
  return id;
}

/**
 * Rows back into nodes. Rows come in id order; a row whose parent is not among
 * them starts a tree of its own, at `depth`.
 */
export class TreeReader {
  private readonly top: Node[] = [];
  private readonly placed = new Map<number, { el: Element; depth: number }>();
  private readonly ends: { el: Element; ws: string | null; depth: number; own: number }[] = [];

  constructor(private readonly depth = 0) {}

  add(table: StoredTable, row: StoredRow): void {
    const parent = row.up === null ? undefined : this.placed.get(row.id - row.up);
    const depth = parent ? parent.depth + 1 : this.depth;
    const siblings = parent ? parent.el.children : this.top;
    if (parent) {
      const ws = writtenWhitespace(row.ws, indentation(depth));
      if (ws !== null) siblings.push({ type: "text", value: ws });
    }
    if (table.name === TEXT || table.name === COMMENT) {
      const node: Node = { type: table.name === TEXT ? "text" : "comment", value: row.txt ?? "" };
      ids.set(node, row.id);
      siblings.push(node);
      return;
    }
    const attrs: Record<string, string> = {};
    for (const a of table.attributes) {
      const value = row[a];
      if (typeof value === "string") attrs[a] = value;
    }
    const el: Element = { type: "element", name: table.name, attrs, children: [], selfClosing: row.open !== 1, parent: parent?.el ?? null };
    if (row.txt !== null) el.children.push({ type: "text", value: row.txt });
    ids.set(el, row.id);
    siblings.push(el);
    this.placed.set(row.id, { el, depth });
    this.ends.push({ el, ws: row.ws_end ?? null, depth, own: el.children.length });
  }

  /** The trees read, with the whitespace before each closing tag in place. */
  finish(): Node[] {
    for (const { el, ws, depth, own } of this.ends) {
      // no rows below the element: nothing before its closing tag was folded
      if (el.children.length === own) continue;
      const value = writtenWhitespace(ws, indentation(depth));
      if (value !== null) el.children.push({ type: "text", value });
    }
    return this.top;
  }
}

/** Whether bit `i` of a table mask is set: the i-th table of storedTablesOf has rows in the range. */
export function inMask(mask: Uint8Array, i: number): boolean {
  return (i >> 3) < mask.length && (mask[i >> 3] & (1 << (i & 7))) !== 0;
}

/** The mask naming table indexes, without trailing zero bytes. */
export function maskOf(indexes: Iterable<number>): Uint8Array {
  const bytes: number[] = [];
  for (const i of indexes) {
    while (bytes.length <= i >> 3) bytes.push(0);
    bytes[i >> 3] |= 1 << (i & 7);
  }
  return Uint8Array.from(bytes);
}

export interface RangeOptions {
  /** only the tables this mask names; a node's mask names every table its range has rows in */
  mask?: Uint8Array | null;
  /**
   * Depth of the range's first row. Whitespace stored as the standard
   * indentation comes back indented for it; text read from the range does
   * not depend on it.
   */
  depth?: number;
}

/** The rows of an id range in every table (or those `mask` names), in id order. */
function rowsIn(db: SqlReader, first: number, last: number, mask?: Uint8Array | null): [StoredTable, StoredRow][] {
  const rows: [StoredTable, StoredRow][] = [];
  storedTablesOf(db).forEach((table, i) => {
    if (mask && !inMask(mask, i)) return;
    for (const row of db.query<StoredRow, [number, number]>(table.select).all(first, last)) rows.push([table, row]);
  });
  return rows.sort((a, b) => a[1].id - b[1].id);
}

/** The nodes of an id range, rebuilt: for an element's range, that element. */
export function readRange(db: SqlReader, first: number, last: number, options: RangeOptions = {}): Node[] {
  const reader = new TreeReader(options.depth ?? 0);
  for (const [table, row] of rowsIn(db, first, last, options.mask)) reader.add(table, row);
  return reader.finish();
}

/** A whole article's nodes (readRange from its first id to its last) as the document they are. */
export function documentOf(nodes: Node[], xmlDecl: string | null, doctype: string | null): Document {
  const at = nodes.findIndex((n) => n.type === "element");
  if (at < 0) throw new Error("no root element in the range");
  return {
    xmlDecl,
    doctype,
    prolog: nodes.flatMap((n, i) =>
      n.type === "comment" ? [{ comment: n.value, position: i < at ? "before" as const : "after" as const }] : []),
    root: nodes[at] as Element,
  };
}

/** A row of `article`: one file's id range. */
export interface StoredArticle {
  id: number;
  last_id: number;
  /** the article key, the file name without `.xml` */
  file: string;
  source: string;
  /** the main root, as rootsOf() reads it */
  rad: string;
}

/**
 * The stored articles rebuilt, in id order, from the one starting at id
 * `from` on. Each batch of articles is one range query per table.
 */
export function* documentsOf(db: SqlReader, { from = 1, batch = 500 } = {}): Generator<{ article: StoredArticle; doc: Document }> {
  const meta = (key: string) =>
    db.query<{ value: string }, [string]>("SELECT value FROM meta WHERE key = ?").get(key)?.value ?? null;
  const xmlDecl = meta("xml_decl");
  const doctype = meta("doctype");
  const page = db.query<StoredArticle, [number, number]>(
    "SELECT id, last_id, file, source, rad FROM article WHERE id >= ? ORDER BY id LIMIT ?");
  for (let at = from; ;) {
    const articles = page.all(at, batch);
    if (articles.length === 0) return;
    const rows = rowsIn(db, articles[0].id, articles[articles.length - 1].last_id);
    let r = 0;
    for (const article of articles) {
      const reader = new TreeReader();
      for (; r < rows.length && rows[r][1].id <= article.last_id; r++) reader.add(rows[r][0], rows[r][1]);
      yield { article, doc: { ...documentOf(reader.finish(), xmlDecl, doctype), file: article.file } };
    }
    at = articles[articles.length - 1].last_id + 1;
  }
}
