/**
 * Pass `tld-links`: every `<tld/>` in the corpus as a link from the word it
 * sits in to the article's root. `mal<tld/>ulejo` under `san` gives the token
 * "malsanulejo" = "mal" + "san" + "ulejo". These are author-marked form→root
 * links, the attested half of the morphology `morph` builds on.
 *
 * Owner = the innermost kap, dif, ekz, rim, trd, ref or bld around the tilde,
 * else the structural node; `owner_id` is that element's id.
 */
import {
  expandTld, NODE_KIND_SET,
  type Element, type Node, type Roots,
} from "voko-xml";
import type { Pass } from "../pass";
import { idOf } from "../../articles";
import { articleTrees } from "../documents";

const OWNER_SET: ReadonlySet<string> = new Set(["kap", "dif", "ekz", "rim", "trd", "ref", "bld"]);

export const tldLinksPass: Pass = {
  name: "tld-links",
  version: 2,
  tables: ["x_tld_occ"],
  run(db, log) {
    db.run(`
      CREATE TABLE x_tld_occ (
        id         INTEGER PRIMARY KEY,
        article_id INTEGER NOT NULL,
        node_id    INTEGER NOT NULL,   -- nearest structural node
        owner_kind TEXT NOT NULL,      -- kap | dif | ekz | rim | trd | ref | bld | node
        owner_id   INTEGER NOT NULL,   -- the owner element's id
        ord        INTEGER NOT NULL,   -- nth <tld/> within the owner
        rad        TEXT NOT NULL,      -- what the tilde stands for, lit applied
        var        TEXT,
        lit        TEXT,
        pre        TEXT NOT NULL,      -- letters glued on before the tilde
        post       TEXT NOT NULL,      -- … and after
        token      TEXT NOT NULL,      -- pre + rad + post
        norm       TEXT NOT NULL       -- token, lowercased
      )`);
    const ins = db.prepare(
      `INSERT INTO x_tld_occ (article_id, node_id, owner_kind, owner_id, ord, rad, var, lit, pre, post, token, norm)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
    );

    let rows = 0;
    const byOwner: Record<string, number> = {};
    for (const { article, roots, nodes } of articleTrees(db)) {
      const tldOrd = new Map<number, number>();
      // each node's own content in document order; the nodes nested in it are walked as nodes
      const walk = (el: Element, nodeId: number, kind: string, ownerId: number): void => {
        for (const c of el.children) {
          if (c.type !== "element" || NODE_KIND_SET.has(c.name)) continue;
          if (OWNER_SET.has(c.name)) {
            walk(c, nodeId, c.name, idOf(c)!);
            continue;
          }
          if (c.name !== "tld") {
            walk(c, nodeId, kind, ownerId);
            continue;
          }
          const ord = tldOrd.get(ownerId) ?? 0;
          tldOrd.set(ownerId, ord + 1);
          const sib = c.parent!.children;
          const i = sib.indexOf(c);
          const pre = glued(sib, i, -1, roots);
          const post = glued(sib, i, 1, roots);
          const rad = expandTld(c, roots);
          const token = pre + rad + post;
          ins.run(article.id, nodeId, kind, ownerId, ord, rad, c.attrs.var ?? null, c.attrs.lit ?? null, pre, post, token, token.toLowerCase());
          byOwner[kind] = (byOwner[kind] ?? 0) + 1;
          rows++;
        }
      };
      for (const n of nodes) walk(n.el, idOf(n.el)!, "node", idOf(n.el)!);
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
