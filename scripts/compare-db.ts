/**
 * Parity report: upstream's revo.db vs our XML-built voko.db, built from the
 * same source snapshot. Compares *key sets*, not row counts — upstream's
 * traduko has exact duplicates and re-attaches sense rows at drv level.
 * Old-only keys are what switching would lose; each must be zero or explained.
 *
 *   pnpm corpus:validate [--old data/revo.db] [--new data/voko.db] [--report data/parity.md]
 */
import { Database } from "../src/runtime/node-database";
import { writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import type { NodeInfo, Roots } from "voko-xml";
import { contentOf, textIn, type Content } from "../src/content";
import { articleTrees } from "../src/corpus/documents";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const opt = (name: string, def: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};
const OLD = opt("--old", join(ROOT, "data", "revo.db"));
const NEW = opt("--new", join(ROOT, "data", "voko.db"));
const REPORT = opt("--report", join(ROOT, "data", "parity.md"));
const SAMPLE = 30;

const db = new Database(NEW, { readonly: true });
db.run(`ATTACH DATABASE '${OLD.replace(/'/g, "''")}' AS old`);

interface Cmp {
  name: string;
  old: string; // SELECT against old.* producing the key columns
  new: string | (() => Iterable<unknown[]>); // same key columns from voko.db
}

// Upstream files a row under the nearest mark: the node's own, else its parent's.
const NEAR = `WITH RECURSIVE near(id, mrk) AS (
    SELECT id, mrk FROM node WHERE parent_id IS NULL
    UNION ALL SELECT n.id, COALESCE(n.mrk, near.mrk) FROM node n JOIN near ON n.parent_id = near.id)`;

/** Content rows of every node, under the node's nearest mark, as upstream's referenco and uzo list them. */
function* nearContent(pick: (c: Content, roots: Roots) => unknown[] | null): Generator<unknown[]> {
  for (const { roots, nodes } of articleTrees(db)) {
    const near = new Map<NodeInfo, string | null>();
    for (const n of nodes) {
      const mrk = n.mrk ?? (n.parent ? near.get(n.parent) ?? null : null);
      near.set(n, mrk);
      if (mrk === null) continue;
      for (const c of contentOf(n.el)) {
        const key = pick(c, roots);
        if (key) yield [mrk, ...key];
      }
    }
  }
}

const CMP: Cmp[] = [
  { name: "nodo mrk", old: "SELECT mrk FROM old.nodo", new: "SELECT mrk FROM node WHERE mrk IS NOT NULL AND kind <> 'art' AND kap_id IS NOT NULL" },
  {
    name: "nodo (mrk, kap)", old: "SELECT mrk, kap FROM old.nodo",
    new: "SELECT n.mrk, h.txt FROM node n JOIN headword h ON h.id = n.kap_id WHERE n.mrk IS NOT NULL AND n.kind <> 'art'",
  },
  { name: "var kap", old: "SELECT kap FROM old.var", new: "SELECT txt FROM headword WHERE main_id IS NOT NULL" },
  {
    // an article-level variant has no mark of its own; upstream files it under the article's first derivation
    name: "var (mrk, kap)", old: "SELECT mrk, kap FROM old.var",
    new: `${NEAR} SELECT COALESCE(near.mrk,
            (SELECT d.mrk FROM node d WHERE d.article_id = n.article_id AND d.kind = 'drv'
               AND d.mrk IS NOT NULL ORDER BY d.id LIMIT 1)), h.txt
          FROM headword h JOIN node n ON n.id = h.node_id JOIN near ON near.id = n.id
          WHERE h.main_id IS NOT NULL`,
  },
  {
    name: "traduko (lng, trd)", old: "SELECT lng, trd FROM old.traduko",
    new: `${NEAR} SELECT t.lng, COALESCE(t.ind, t.txt) FROM translation t JOIN near ON near.id = t.node_id
          WHERE near.mrk IS NOT NULL AND t.in_ekz = 0`,
  },
  {
    name: "traduko (mrk, lng, trd)", old: "SELECT mrk, lng, trd FROM old.traduko",
    new: `${NEAR} SELECT near.mrk, t.lng, COALESCE(t.ind, t.txt) FROM translation t JOIN near ON near.id = t.node_id
          WHERE near.mrk IS NOT NULL AND t.in_ekz = 0`,
  },
  {
    name: "referenco (mrk, cel, tip)", old: "SELECT mrk, cel, COALESCE(tip, '') FROM old.referenco",
    new: () => nearContent((c) => c.el.name === "ref" ? [c.el.attrs.cel ?? "", c.tip ?? ""] : null),
  },
  {
    // upstream names the fak tip 'uzo' and has no klr/reg rows, nor the usage of an example
    name: "uzo (mrk, tip, uzo)", old: "SELECT mrk, tip, uzo FROM old.uzo",
    new: () => nearContent((c, roots) => {
      const tip = c.el.attrs.tip;
      if (c.el.name !== "uzo" || (tip !== "fak" && tip !== "stl") || c.owner === "ekz") return null;
      return [tip === "fak" ? "uzo" : tip, textIn(c.el, roots)];
    }),
  },
  {
    // whitespace and **bold** markers differ by rendering, not content
    name: "ekzemplo (drv_mrk, text)",
    old: "SELECT drv_mrk, lower(replace(replace(ekz_md, '**', ''), ' ', '')) FROM old.ekzemplo",
    new: "SELECT drv_mrk, lower(replace(ekz_md, ' ', '')) FROM ekzemplo",
  },
  { name: "artikolo", old: "SELECT mrk FROM old.artikolo", new: "SELECT file FROM article" },
];

function keys(source: Cmp["new"]): Set<string> {
  const s = new Set<string>();
  const rows = typeof source === "string" ? db.query(source).values() : source();
  for (const row of rows) s.add(row.map((v) => String(v ?? "∅")).join("\t"));
  return s;
}

const summary = ["| set | old | new | old-only | new-only |", "|---|---:|---:|---:|---:|"];
const details: string[] = [];
for (const c of CMP) {
  const t0 = Date.now();
  const o = keys(c.old);
  const n = keys(c.new);
  const oldOnly = [...o].filter((k) => !n.has(k));
  const newOnly = [...n].filter((k) => !o.has(k));
  summary.push(`| ${c.name} | ${o.size} | ${n.size} | ${oldOnly.length} | ${newOnly.length} |`);
  console.log(
    `${c.name.padEnd(28)} old ${String(o.size).padStart(7)}  new ${String(n.size).padStart(7)}` +
      `  old-only ${String(oldOnly.length).padStart(6)}  new-only ${String(newOnly.length).padStart(6)}  ${Date.now() - t0}ms`
  );
  const fmt = (k: string) => "- " + k.split("\t").map((v) => "`" + v.slice(0, 80) + "`").join(" · ");
  details.push(
    `## ${c.name}`, "",
    `old-only (${oldOnly.length}), sample:`, "", ...oldOnly.slice(0, SAMPLE).map(fmt), "",
    `new-only (${newOnly.length}), sample:`, "", ...newOnly.slice(0, SAMPLE).map(fmt), ""
  );
}

writeFileSync(
  REPORT,
  [`# Parity: \`${OLD}\` (old) vs \`${NEW}\` (new)`, "", `Generated ${new Date().toISOString()}`, "", ...summary, "", ...details].join("\n")
);
console.log(`report → ${REPORT}`);
