#!/usr/bin/env bun
/**
 * Parity report: upstream's revo.db vs our XML-built voko.db, built from the
 * same source snapshot. Compares *key sets*, not row counts — upstream's
 * traduko has exact duplicates and re-attaches sense rows at drv level.
 * Old-only keys are what switching would lose; each must be zero or explained.
 *
 *   bun run corpus:validate [--old data/revo.db] [--new data/voko.db] [--report data/parity.md]
 */
import { Database } from "bun:sqlite";
import { writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

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
  new: string; // same key columns from voko.db
}

const CMP: Cmp[] = [
  { name: "nodo mrk", old: "SELECT mrk FROM old.nodo", new: "SELECT mrk FROM nodo" },
  { name: "nodo (mrk, kap)", old: "SELECT mrk, kap FROM old.nodo", new: "SELECT mrk, kap FROM nodo" },
  { name: "var kap", old: "SELECT kap FROM old.var", new: "SELECT kap FROM var" },
  { name: "var (mrk, kap)", old: "SELECT mrk, kap FROM old.var", new: "SELECT mrk, kap FROM var" },
  { name: "traduko (lng, trd)", old: "SELECT lng, trd FROM old.traduko", new: "SELECT lng, trd FROM traduko" },
  { name: "traduko (mrk, lng, trd)", old: "SELECT mrk, lng, trd FROM old.traduko", new: "SELECT mrk, lng, trd FROM traduko" },
  { name: "referenco (mrk, cel, tip)", old: "SELECT mrk, cel, COALESCE(tip, '') FROM old.referenco", new: "SELECT mrk, cel, tip FROM referenco" },
  { name: "uzo (mrk, tip, uzo)", old: "SELECT mrk, tip, uzo FROM old.uzo", new: "SELECT mrk, tip, uzo FROM uzo_compat" },
  {
    // whitespace and **bold** markers differ by rendering, not content
    name: "ekzemplo (drv_mrk, text)",
    old: "SELECT drv_mrk, lower(replace(replace(ekz_md, '**', ''), ' ', '')) FROM old.ekzemplo",
    new: "SELECT drv_mrk, lower(replace(ekz_md, ' ', '')) FROM ekzemplo",
  },
  { name: "artikolo", old: "SELECT mrk FROM old.artikolo", new: "SELECT file FROM art" },
];

function keys(sql: string): Set<string> {
  const s = new Set<string>();
  for (const row of db.query(sql).values()) s.add(row.map((v) => String(v ?? "∅")).join("\t"));
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
