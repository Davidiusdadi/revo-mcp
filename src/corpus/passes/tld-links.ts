/**
 * Pass `tld-links`: every `<tld/>` in the corpus as a link from the word it
 * sits in to the article's root. `mal<tld/>ulejo` under `san` gives the token
 * "malsanulejo" = "mal" + "san" + "ulejo". These are author-marked form→root
 * links, the attested half of the morphology `morph` builds on.
 *
 * Owner = the innermost element with its own L2 row (kap, dif, ekz, rim, trd,
 * ref, bld), else the structural node. Rows are matched to elements by
 * replaying build.ts's traversal (nodes in document order, each node's own
 * content preorder); every owner is checked against its row's stored `xml`.
 */
import type { Database } from "bun:sqlite";
import {
  parse, articleOf, rootsOf, nodes, expandTld, outerXml, NODE_KIND_SET,
  type Element, type Node, type Roots,
} from "voko-xml";
import type { Pass } from "../pass";

const OWNERS = ["kap", "dif", "ekz", "rim", "trd", "ref", "bld"] as const;
type Owner = (typeof OWNERS)[number];
const OWNER_SET: ReadonlySet<string> = new Set(OWNERS);

export const tldLinksPass: Pass = {
  name: "tld-links",
  version: 1,
  tables: ["x_tld_occ"],
  run(db, log) {
    db.run(`
      CREATE TABLE x_tld_occ (
        id         INTEGER PRIMARY KEY,
        art_id     INTEGER NOT NULL,
        node_id    INTEGER NOT NULL,   -- nearest structural node
        owner_kind TEXT NOT NULL,      -- kap | dif | ekz | rim | trd | ref | bld | node
        owner_id   INTEGER NOT NULL,
        ord        INTEGER NOT NULL,   -- nth <tld/> within the owner
        rad        TEXT NOT NULL,      -- what the tilde stands for, lit applied
        var        TEXT,
        lit        TEXT,
        pre        TEXT NOT NULL,      -- letters glued on before the tilde
        post       TEXT NOT NULL,      -- … and after
        token      TEXT NOT NULL,      -- pre + rad + post
        norm       TEXT NOT NULL       -- token, lowercased
      )`);

    const nodeByKey = new Map<string, number>();
    for (const r of db.query<{ id: number; key: string }, []>("SELECT id, key FROM node").iterate()) {
      nodeByKey.set(r.key, r.id);
    }
    const rowsOf = rowRanges(db);
    const xmlOf = new Map(OWNERS.map((t) => [t, db.query<{ xml: string }, [number]>(`SELECT xml FROM ${t} WHERE id = ?`)]));
    const ins = db.prepare(
      `INSERT INTO x_tld_occ (art_id, node_id, owner_kind, owner_id, ord, rad, var, lit, pre, post, token, norm)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
    );

    let rows = 0;
    const byOwner: Record<string, number> = {};
    for (const a of db.query<{ id: number; file: string; xml: string }, []>("SELECT id, file, xml FROM art ORDER BY id").iterate()) {
      const art = articleOf(parse(a.xml, a.file));
      const roots = rootsOf(art);
      const used: Partial<Record<Owner, number>> = {};
      const tldOrd = new Map<string, number>();
      const checked = new Set<string>();

      const rowOf = (t: Owner): number => {
        const i = (used[t] = (used[t] ?? 0) + 1) - 1;
        const range = rowsOf.get(t)!.get(a.id);
        if (!range || i >= range.n) throw new Error(`${a.file}: more <${t}> elements than ${t} rows`);
        return range.first + i;
      };

      const walk = (el: Element, nodeId: number, kind: string, ownerId: number, ownerEl: Element | null): void => {
        for (const c of el.children) {
          if (c.type !== "element" || NODE_KIND_SET.has(c.name)) continue;
          if (OWNER_SET.has(c.name)) {
            walk(c, nodeId, c.name, rowOf(c.name as Owner), c);
            continue;
          }
          if (c.name !== "tld") {
            walk(c, nodeId, kind, ownerId, ownerEl);
            continue;
          }
          const k = `${kind}:${ownerId}`;
          if (ownerEl && !checked.has(k)) {
            checked.add(k);
            if (xmlOf.get(kind as Owner)!.get(ownerId)?.xml !== outerXml(ownerEl)) {
              throw new Error(`${a.file}: <${kind}> matched to row ${ownerId}, but the row's xml differs`);
            }
          }
          const ord = tldOrd.get(k) ?? 0;
          tldOrd.set(k, ord + 1);
          const sib = c.parent!.children;
          const i = sib.indexOf(c);
          const pre = glued(sib, i, -1, roots);
          const post = glued(sib, i, 1, roots);
          const rad = expandTld(c, roots);
          const token = pre + rad + post;
          ins.run(a.id, nodeId, kind, ownerId, ord, rad, c.attrs.var ?? null, c.attrs.lit ?? null, pre, post, token, token.toLowerCase());
          byOwner[kind] = (byOwner[kind] ?? 0) + 1;
          rows++;
        }
      };

      for (const n of nodes(art, a.file)) {
        const nodeId = nodeByKey.get(n.key);
        if (nodeId === undefined) throw new Error(`${a.file}: no node row for ${n.key}`);
        walk(n.el, nodeId, "node", nodeId, null);
      }
      for (const t of OWNERS) {
        const want = rowsOf.get(t)!.get(a.id)?.n ?? 0;
        if ((used[t] ?? 0) !== want) throw new Error(`${a.file}: ${used[t] ?? 0} <${t}> elements vs ${want} rows`);
      }
    }

    db.run(`CREATE INDEX idx_x_tld_occ_norm ON x_tld_occ(norm)`);
    db.run(`CREATE INDEX idx_x_tld_occ_owner ON x_tld_occ(owner_kind, owner_id)`);
    db.run(`CREATE INDEX idx_x_tld_occ_node ON x_tld_occ(node_id)`);
    const glue = db.query<{ pre: number; post: number }, []>(
      `SELECT SUM(pre <> '') pre, SUM(post <> '') post FROM x_tld_occ`).get()!;
    log(`x_tld_occ: ${Object.entries(byOwner).map(([k, v]) => `${k} ${v}`).join(", ")}`);
    log(`  ${glue.pre} with letters before the tilde, ${glue.post} after`);
    return rows;
  },
};

/** First row id and row count per article for each owner table (build writes an article's rows contiguously). */
function rowRanges(db: Database): Map<Owner, Map<number, { first: number; n: number }>> {
  const out = new Map<Owner, Map<number, { first: number; n: number }>>();
  for (const t of OWNERS) {
    const m = new Map<number, { first: number; n: number }>();
    for (const r of db.query<{ art_id: number; first: number; last: number; n: number }, []>(
      `SELECT n.art_id, MIN(t.id) first, MAX(t.id) last, COUNT(*) n FROM ${t} t JOIN node n ON n.id = t.node_id GROUP BY n.art_id`
    ).iterate()) {
      if (r.last - r.first + 1 !== r.n) throw new Error(`${t} rows of article ${r.art_id} are not contiguous`);
      m.set(r.art_id, { first: r.first, n: r.n });
    }
    out.set(t, m);
  }
  return out;
}

const LEADING = /^[\p{L}\p{M}]*/u;
const TRAILING = /[\p{L}\p{M}]*$/u;

/**
 * Letters glued to the tilde at sib[i], read outwards across text and adjacent
 * tildes (`<tld/><tld/>`), up to the first non-letter or other element.
 */
function glued(sib: Node[], i: number, dir: -1 | 1, roots: Roots): string {
  let s = "";
  for (let j = i + dir; j >= 0 && j < sib.length; j += dir) {
    const c = sib[j];
    if (c.type === "comment") continue;
    let piece: string;
    if (c.type === "text") piece = c.value;
    else if (c.name === "tld") piece = expandTld(c, roots);
    else break;
    const m = (dir < 0 ? TRAILING : LEADING).exec(piece)![0];
    s = dir < 0 ? m + s : s + m;
    if (m.length < piece.length) break;
  }
  return s;
}
