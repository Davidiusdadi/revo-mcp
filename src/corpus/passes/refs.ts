/**
 * Pass `refs`: the typed reference graph. Each `<ref cel>` resolved to the
 * node it names (a node's mrk, an article, or a remark's mrk), plus the
 * inverse edges the VOKO ontology entails (voko-grundo `owl/voko.ttl`),
 * flagged `inferred` so authored and derived edges stay apart. `x_ref_tip`
 * carries the tip semantics so tools can generalise (sin, ant, hom ⊂ vid …).
 */
import type { Database } from "bun:sqlite";
import type { Pass } from "../pass";
import { idOf } from "../../articles";
import { contentOf } from "../../content";
import { articleTrees } from "../documents";

export interface RefTip {
  tip: string;
  label: string;
  /** rdfs:subPropertyOf among the voko: tips. */
  parent: string | null;
  /** SKOS relation at the top of the hierarchy. */
  skos: "related" | "broader" | "narrower" | null;
  inverse: string | null;
  symmetric: boolean;
  transitive: boolean;
  /** false where we go beyond voko.ttl. */
  owl: boolean;
}

const tip = (
  tip: string, label: string, parent: string | null, skos: RefTip["skos"], inverse: string | null,
  flags: { symmetric?: boolean; transitive?: boolean; owl?: boolean } = {}
): RefTip => ({
  tip, label, parent, skos, inverse,
  symmetric: flags.symmetric ?? false, transitive: flags.transitive ?? false, owl: flags.owl ?? true,
});

export const REF_TIPS: RefTip[] = [
  tip("vid", "vidu", null, "related", "vid", { symmetric: true }),
  tip("sin", "sinonimo", "vid", null, "sin", { symmetric: true }),
  tip("ant", "antonimo", "vid", null, "ant", { symmetric: true }),
  // voko.ttl declares hom transitive only; homonymy is symmetric by definition,
  // and 615 of the 705 authored hom refs are reciprocated already
  tip("hom", "homonimo", "vid", null, "hom", { symmetric: true, transitive: true, owl: false }),
  tip("dif", "estas difinita per", "sin", null, null),
  tip("super", "estas speco de", null, "broader", "sub", { transitive: true }),
  tip("sub", "havas specon", null, "narrower", "super", { transitive: true }),
  tip("drv", "derivaĵo", "super", null, "snc"),
  tip("snc", "senco", "sub", null, "drv"),
  tip("lst", "listo", "super", null, null),
  tip("ekz", "ekzemplo", "sub", null, null),
  tip("malprt", "apartenas al", null, "broader", "prt"),
  tip("prt", "havas parton", null, "narrower", "malprt"),
];

interface Edge {
  ref: number;
  src: number;
  dst: number;
  kind: "node" | "art" | "rim";
  rim: number | null;
  tip: string | null;
  inferred: 0 | 1;
}

export const refsPass: Pass = {
  name: "refs",
  version: 2,
  tables: ["x_ref_tip", "x_ref_edge", "x_ref_issue"],
  run(db, log) {
    db.run(`
      CREATE TABLE x_ref_tip (
        tip TEXT PRIMARY KEY, label TEXT NOT NULL, parent TEXT, skos TEXT, inverse TEXT,
        symmetric INTEGER NOT NULL, transitive INTEGER NOT NULL,
        owl INTEGER NOT NULL          -- 0 where we go beyond voko.ttl
      )`);
    const insTip = db.prepare(`INSERT INTO x_ref_tip VALUES (?,?,?,?,?,?,?,?)`);
    for (const t of REF_TIPS) {
      insTip.run(t.tip, t.label, t.parent, t.skos, t.inverse, +t.symmetric, +t.transitive, +t.owl);
    }

    db.run(`
      CREATE TABLE x_ref_edge (
        id       INTEGER PRIMARY KEY,
        ref_id   INTEGER NOT NULL,    -- the authored <ref>; for an inferred edge, the one it follows from
        src_node INTEGER NOT NULL,
        dst_node INTEGER NOT NULL,
        dst_kind TEXT NOT NULL,       -- what cel named: node | art (its art node) | rim (its node)
        dst_rim  INTEGER,
        tip      TEXT,                -- NULL: untyped inline link
        inferred INTEGER NOT NULL     -- 0 authored, 1 entailed inverse
      )`);
    db.run(`CREATE TABLE x_ref_issue (ref_id INTEGER NOT NULL, cel TEXT NOT NULL, problem TEXT NOT NULL)`);

    const edges = resolve(db);
    const issues = edges.issues;
    const inverse = new Map(REF_TIPS.filter((t) => t.inverse).map((t) => [t.tip, t.inverse!]));
    const have = new Set(edges.authored.map((e) => `${e.src}>${e.dst}>${e.tip}`));
    const inferred: Edge[] = [];
    for (const e of edges.authored) {
      const inv = e.tip ? inverse.get(e.tip) : undefined;
      if (!inv) continue;
      const k = `${e.dst}>${e.src}>${inv}`;
      if (have.has(k)) continue;
      have.add(k);
      inferred.push({ ref: e.ref, src: e.dst, dst: e.src, kind: "node", rim: null, tip: inv, inferred: 1 });
    }

    const ins = db.prepare(
      `INSERT INTO x_ref_edge (ref_id, src_node, dst_node, dst_kind, dst_rim, tip, inferred) VALUES (?,?,?,?,?,?,?)`
    );
    for (const e of [...edges.authored, ...inferred]) ins.run(e.ref, e.src, e.dst, e.kind, e.rim, e.tip, e.inferred);
    const insIssue = db.prepare(`INSERT INTO x_ref_issue VALUES (?,?,?)`);
    for (const i of issues) insIssue.run(i.ref, i.cel, i.problem);

    db.run(`CREATE INDEX idx_x_ref_edge_src ON x_ref_edge(src_node, tip)`);
    db.run(`CREATE INDEX idx_x_ref_edge_dst ON x_ref_edge(dst_node, tip)`);

    const byTip: Record<string, number> = {};
    for (const e of inferred) byTip[e.tip!] = (byTip[e.tip!] ?? 0) + 1;
    log(`x_ref_edge: ${edges.authored.length} authored, ${inferred.length} inferred (${
      Object.entries(byTip).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(", ")})`);
    const problems: Record<string, number> = {};
    for (const i of issues) problems[i.problem] = (problems[i.problem] ?? 0) + 1;
    log(`x_ref_issue: ${issues.length ? Object.entries(problems).map(([k, v]) => `${k} ${v}`).join(", ") : "none"}`);
    return REF_TIPS.length + edges.authored.length + inferred.length + issues.length;
  },
};

/** cel → node: a node's mrk first, then an article file, then a remark's mrk. */
function resolve(db: Database): { authored: Edge[]; issues: { ref: number; cel: string; problem: string }[] } {
  const byMrk = new Map<string, number>();
  for (const r of db.query<{ id: number; mrk: string }, []>("SELECT id, mrk FROM node WHERE mrk IS NOT NULL").iterate()) {
    byMrk.set(r.mrk, r.id);
  }
  const byArt = new Map<string, number>();
  for (const r of db.query<{ file: string; id: number }, []>(
    "SELECT a.file, n.id FROM article a JOIN node n ON n.article_id = a.id AND n.kind = 'art'").iterate()) {
    byArt.set(r.file, r.id);
  }

  // the references in reading order, node by node, and the marked remarks
  const refs: { id: number; node: number; tip: string | null; cel: string }[] = [];
  const byRim = new Map<string, { id: number; node: number }>();
  for (const { nodes } of articleTrees(db)) {
    for (const n of nodes) {
      const node = idOf(n.el)!;
      for (const c of contentOf(n.el)) {
        if (c.el.name === "ref") refs.push({ id: idOf(c.el)!, node, tip: c.tip ?? null, cel: c.el.attrs.cel ?? "" });
        else if (c.el.name === "rim" && c.el.attrs.mrk !== undefined) byRim.set(c.el.attrs.mrk, { id: idOf(c.el)!, node });
      }
    }
  }

  const authored: Edge[] = [];
  const issues: { ref: number; cel: string; problem: string }[] = [];
  for (const r of refs) {
    let dst = byMrk.get(r.cel);
    let kind: Edge["kind"] = "node";
    let rim: number | null = null;
    if (dst === undefined && (dst = byArt.get(r.cel)) !== undefined) kind = "art";
    if (dst === undefined) {
      const m = byRim.get(r.cel);
      if (m) [dst, kind, rim] = [m.node, "rim", m.id];
    }
    if (dst === undefined) issues.push({ ref: r.id, cel: r.cel, problem: "dangling" });
    else if (dst === r.node) issues.push({ ref: r.id, cel: r.cel, problem: "self" });
    else authored.push({ ref: r.id, src: r.node, dst, kind, rim, tip: r.tip, inferred: 0 });
  }
  return { authored, issues };
}
