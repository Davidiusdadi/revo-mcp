/**
 * Pass `tld-links`: every `<tld/>` in the corpus as a link from the word it
 * sits in to the article's root. `mal<tld/>ulejo` under `san` gives the token
 * "malsanulejo" = "mal" + "san" + "ulejo". These are author-marked form→root
 * links, the attested half of the morphology `morph` builds on.
 *
 * Owner = the innermost kap, dif, ekz, rim, trd, ref or bld around the tilde,
 * else the structural node; `owner_id` is that element's id.
 *
 * The walk is `tldOccurrences`, which the `morph` pass reads as well: it
 * belongs to the core stage and this table does not, so the two share the
 * walk rather than the table.
 */
import type { Database } from "../../runtime/node-database";
import {
  expandTld, NODE_KIND_SET,
  type Element, type Node, type Roots,
} from "voko-xml";
import type { Pass } from "../pass";
import { idOf } from "../../articles";
import { articleTrees } from "../documents";

const OWNER_SET: ReadonlySet<string> = new Set(["kap", "dif", "ekz", "rim", "trd", "ref", "bld"]);

/** One `<tld/>` and the word around it, as a row of `x_tld_occ`. */
export interface TldOccurrence {
  article_id: number;
  /** nearest structural node */
  node_id: number;
  /** kap | dif | ekz | rim | trd | ref | bld | node */
  owner_kind: string;
  /** the owner element's id */
  owner_id: number;
  /** nth <tld/> within the owner */
  ord: number;
  /** what the tilde stands for, lit applied */
  rad: string;
  var: string | null;
  lit: string | null;
  /** letters glued on before the tilde */
  pre: string;
  /** … and after */
  post: string;
  /** pre + rad + post */
  token: string;
  /** token, lowercased */
  norm: string;
}

/** Every `<tld/>` of the stored articles, in document order. */
export function* tldOccurrences(db: Database): Generator<TldOccurrence> {
  for (const { article, roots, nodes } of articleTrees(db)) {
    const tldOrd = new Map<number, number>();
    const found: TldOccurrence[] = [];
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
        found.push({
          article_id: article.id, node_id: nodeId, owner_kind: kind, owner_id: ownerId, ord, rad,
          var: c.attrs.var ?? null, lit: c.attrs.lit ?? null, pre, post, token, norm: token.toLowerCase(),
        });
      }
    };
    for (const n of nodes) walk(n.el, idOf(n.el)!, "node", idOf(n.el)!);
    yield* found;
  }
}

/** A form written with a tilde outside headwords, per article: how often, and where its first occurrence puts the root. */
export interface TokenGroup {
  norm: string;
  article_id: number;
  n: number;
  pre: string;
  rad: string;
}

/**
 * One group per distinct form per article, with the pin of its first
 * occurrence.
 *
 * pre and rad have to come from the same occurrence: a prefix taken from one
 * occurrence and a root from another pin a span that no occurrence has — that
 * is how "ĉevalo" came out as "ĉeva|lo", the pin being the empty prefix of one
 * occurrence with the root of a `lit`-capitalised one ("eval").
 */
export function tokenGroups(occurrences: Iterable<TldOccurrence>): TokenGroup[] {
  const groups = new Map<string, TokenGroup>();
  for (const o of occurrences) {
    if (o.owner_kind === "kap" || o.norm === "") continue;
    const key = `${o.article_id}\n${o.norm}`;
    const g = groups.get(key);
    if (g) g.n++;
    else groups.set(key, { norm: o.norm, article_id: o.article_id, n: 1, pre: o.pre, rad: o.rad });
  }
  return [...groups.values()];
}

export const tldLinksPass: Pass = {
  name: "tld-links",
  version: 3,
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
    for (const o of tldOccurrences(db)) {
      ins.run(o.article_id, o.node_id, o.owner_kind, o.owner_id, o.ord, o.rad, o.var, o.lit, o.pre, o.post, o.token, o.norm);
      byOwner[o.owner_kind] = (byOwner[o.owner_kind] ?? 0) + 1;
      rows++;
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
