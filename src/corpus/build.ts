#!/usr/bin/env bun
/**
 * Builds data/voko.db from the VOKO XML: the articles stored as tables (L1,
 * src/corpus/documents.ts), then the passes of the requested stage.
 *
 *   bun run corpus:build                 full rebuild: core + enrichment passes
 *   bun run corpus:build --stage core    articles + structure + search, what a browser downloads
 *   bun run corpus:build --pass fts      run one pass on the existing DB
 *   bun run corpus:build --limit 200     dev: first N articles only
 *   bun run corpus:build --overlay DIR   merge that directory instead of corpus/overlay
 *   bun run corpus:build --out x.db
 *
 * The core stage answers search, lookup, entries and languages; the full stage
 * adds the enrichment the server's other tools read (FTS, morphology, the
 * reference graph) and the indexes they need. Both hold every article whole,
 * so a core file is raised to full later with `--pass` on each enrichment pass,
 * without the sources. Every build ends with VACUUM, so tables lie in
 * contiguous pages, and writes `<out>.gz` next to the file.
 *
 * The import fails on an element or attribute the DTD does not declare, and
 * on an article that does not read back from the tables as its file parsed,
 * so nothing upstream adds slips through.
 */
import { Database } from "bun:sqlite";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { plainText, childElements, substituteEntities, parse, type Roots } from "voko-xml";
import lingvoj from "voko-xml/data/cfg/lingvoj.json";
import fakoj from "voko-xml/data/cfg/fakoj.json";
import stiloj from "voko-xml/data/cfg/stiloj.json";
import mallongigoj from "voko-xml/data/cfg/mallongigoj.json";
import { runPass, type Pass } from "./pass";
import { importDocuments } from "./documents";
import { structurePass } from "./passes/structure";
import { searchPass } from "./passes/search";
import { indexPass } from "./passes/index";
import { ftsPass } from "./passes/fts";
import { tldLinksPass } from "./passes/tld-links";
import { refsPass } from "./passes/refs";
import { morphPass } from "./passes/morph";
import { ROOT, VENDOR, FONTO, GRUNDO, corpusArticles } from "./sources";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUT = join(ROOT, "data", "voko.db");

export type Stage = "core" | "full";
/** What every runtime needs: nodes, headwords and translations, and the search tables over them. */
export const CORE_PASSES: Pass[] = [structurePass, searchPass];
/** Enrichment for the server's other tools, and the indexes they read through. */
export const ENRICHMENT_PASSES: Pass[] = [indexPass, ftsPass, tldLinksPass, refsPass, morphPass];
export const PASSES: Pass[] = [...CORE_PASSES, ...ENRICHMENT_PASSES];

export function passesOf(stage: Stage): Pass[] {
  return stage === "core" ? CORE_PASSES : PASSES;
}

// ---------------------------------------------------------------------------

function loadCfg(db: Database): void {
  const ins = (sql: string, rows: Record<string, string>[], cols: string[]) => {
    const s = db.prepare(sql);
    for (const r of rows) s.run(...cols.map((c) => r[c] ?? null));
  };
  ins("INSERT OR REPLACE INTO lng (kodo, nomo, flago) VALUES (?,?,?)", lingvoj as any, ["kodo", "nomo", "flago"]);
  ins("INSERT OR REPLACE INTO fako (kodo, nomo, vinjeto) VALUES (?,?,?)", fakoj as any, ["kodo", "nomo", "vinjeto"]);
  ins("INSERT OR REPLACE INTO stilo (kodo, nomo) VALUES (?,?)", stiloj as any, ["kodo", "nomo"]);
  ins("INSERT OR REPLACE INTO mallongigo (mll, nomo) VALUES (?,?)", mallongigoj as any, ["mll", "nomo"]);
}

/** cfg/bibliogr.xml declares a few private entities in its internal DTD subset. */
function loadBibliogr(db: Database): number {
  const path = join(FONTO, "cfg", "bibliogr.xml");
  if (!existsSync(path)) return 0;
  let src = readFileSync(path, "utf8");
  const local: Record<string, string> = {};
  for (const m of src.matchAll(/<!ENTITY\s+(\w+)\s+"([^"]*)">/g)) local[m[1]] = m[2];
  src = src.replace(/<!DOCTYPE[\s\S]*?\]>/, "");
  src = src.replace(/&(\w+);/g, (w, n) => (n in local ? local[n] : w));
  const doc = parse(substituteEntities(src, path), path);
  const roots: Roots = { rad: "", byVar: {} };
  const s = db.prepare("INSERT OR REPLACE INTO bibliogr (mll, tip, tit, url, aut, trd, ald, eld) VALUES (?,?,?,?,?,?,?,?)");
  let n = 0;
  for (const vrk of childElements(doc.root, "vrk")) {
    const t = (name: string) => {
      const parts = childElements(vrk, name).map((c) => plainText(c, { roots, omit: new Set() }));
      return parts.length ? parts.join("; ") : null;
    };
    const eld = childElements(vrk, "eld").map((e) => {
      const r: Record<string, string> = {};
      for (const c of childElements(e)) r[c.name] = plainText(c, { roots, omit: new Set() });
      return r;
    });
    s.run(vrk.attrs.mll, vrk.attrs.tip ?? null, t("tit"), t("url"), t("aut"), t("trd"), t("ald"),
      eld.length ? JSON.stringify(eld) : null);
    n++;
  }
  return n;
}

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------

/** The commit `name` was fetched at, as recorded by scripts/fetch-sources.ts. */
function pinnedRev(name: string): string | null {
  const file = join(VENDOR, "SOURCES.json");
  if (!existsSync(file)) return null;
  try {
    const pins = JSON.parse(readFileSync(file, "utf8")) as { name: string; commit: string }[];
    return pins.find((p) => p.name === name)?.commit ?? null;
  } catch {
    return null;
  }
}

/**
 * Which commit of the sources this database was built from.
 *
 * A development tree answers with git over the submodule checkout. A container
 * build has no git at all (see scripts/fetch-sources.ts), so the pins that the
 * fetch recorded stand in — the provenance is the same either way.
 */
function gitRev(dir: string, name: string): string {
  try {
    const p = Bun.spawnSync(["git", "-C", dir, "rev-parse", "HEAD"]);
    if (p.exitCode === 0) return p.stdout.toString().trim();
  } catch {
    // No git binary: not an error here, the pins below are authoritative.
  }
  return pinnedRev(name) ?? "unknown";
}

// ---------------------------------------------------------------------------

/** Version 3: the articles stored whole, one table per element; node, headword and translation derived. */
export const SCHEMA_VERSION = 3;

/**
 * `limit`: first N articles only (dev, tests); `extra`: article keys added to
 * that slice; `overlay`: the directory merged over the submodule by file name
 * (tests point it at a fixture).
 */
export function buildArticles(out: string, limit?: number, extra: string[] = [], overlay?: string): Database {
  if (existsSync(out)) unlinkSync(out);
  const db = new Database(out);
  db.exec("PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF; PRAGMA cache_size = -200000; PRAGMA temp_store = MEMORY;");
  db.exec(readFileSync(join(__dirname, "schema.sql"), "utf8"));

  loadCfg(db);
  const nBib = loadBibliogr(db);
  console.log(`cfg: ${(lingvoj as any[]).length} lng, ${(fakoj as any[]).length} fako, ${(stiloj as any[]).length} stilo, ${nBib} bibliogr`);

  let articles = corpusArticles(overlay);
  if (limit) articles = articles.filter((a, i) => i < limit || extra.includes(a.key));
  for (const a of articles) if (a.source === "overlay") console.log(`  overlay: ${a.key}`);
  const t0 = Date.now();
  const inv = importDocuments(db, articles, { log: (m) => process.stdout.write(`\r  ${m}`) });
  console.log(`\narticles stored and read back in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const meta = db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?,?)");
  meta.run("schema", "voko");
  meta.run("schema_version", String(SCHEMA_VERSION));
  meta.run("built_at", new Date().toISOString());
  meta.run("fonto_rev", gitRev(FONTO, "revo-fonto"));
  meta.run("voko_grundo_rev", gitRev(GRUNDO, "voko-grundo"));
  meta.run("articles", String(articles.length));
  meta.run("inventory", JSON.stringify(inv.elements));
  return db;
}

/**
 * Makes a built database ready to ship: statistics for the planner, then
 * VACUUM, which rewrites every table and index into contiguous pages (so a
 * range scan over HTTP reads neighbouring pages), then the gzip copy a browser
 * downloads once.
 *
 * The file's revision is its `user_version`, the time it was finished in Unix
 * seconds. It sits in the 100-byte file header, so a browser compares its local
 * copy with the published file by fetching those bytes alone.
 */
export function finish(db: Database, out: string): void {
  db.exec(`PRAGMA user_version = ${Math.floor(Date.now() / 1000)}`);
  db.exec("ANALYZE");
  db.exec("VACUUM");
  db.close();
  writeFileSync(`${out}.gz`, Bun.gzipSync(readFileSync(out), { level: 9 }));
}

function main() {
  const args = process.argv.slice(2);
  const opt = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const out = opt("--out") ?? DEFAULT_OUT;
  const only = opt("--pass");
  const limit = opt("--limit") ? Number(opt("--limit")) : undefined;
  const overlay = opt("--overlay");
  const stage = (opt("--stage") ?? "full") as Stage;
  if (stage !== "core" && stage !== "full") throw new Error(`no such stage: ${stage} (have core, full)`);

  let db: Database;
  if (only) {
    db = new Database(out);
    const pass = PASSES.find((p) => p.name === only);
    if (!pass) throw new Error(`no such pass: ${only} (have ${PASSES.map((p) => p.name).join(", ")})`);
    runPass(db, pass);
    // a core file that has been given every enrichment pass is a full one
    const ran = new Set(db.query<{ pass: string }, []>("SELECT pass FROM meta_pass").all().map((r) => r.pass));
    db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('stage', ?)", [PASSES.every((p) => ran.has(p.name)) ? "full" : "core"]);
  } else {
    db = buildArticles(out, limit, [], overlay);
    if (!args.includes("--no-passes")) for (const p of passesOf(stage)) runPass(db, p);
    db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('stage', ?)", [stage]);
  }
  finish(db, out);
  const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);
  console.log(`${out}: ${mb(Bun.file(out).size)} MB, ${out}.gz: ${mb(Bun.file(`${out}.gz`).size)} MB`);
}

if (import.meta.main) main();
