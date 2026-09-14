#!/usr/bin/env bun
/**
 * Builds data/voko.db from the VOKO XML: layer L2 (canonical tables, see
 * schema.sql) followed by the passes of the requested stage.
 *
 *   bun run corpus:build                 full rebuild: core + enrichment passes
 *   bun run corpus:build --stage core    L2 + search, what a browser downloads
 *   bun run corpus:build --pass fts      run one pass on the existing DB
 *   bun run corpus:build --limit 200     dev: first N articles only
 *   bun run corpus:build --out x.db
 *
 * The core stage answers search, lookup, entries and languages; the full stage
 * adds the enrichment the server's other tools read (FTS, morphology, the
 * reference graph) and the indexes they need. A core file leaves the citations
 * (`fnt`, a tenth of it) empty, since no tool reads them; otherwise it can be
 * raised to full later with `--pass` on each enrichment pass. Every build ends
 * with VACUUM, so tables lie in contiguous pages, and writes `<out>.gz` next
 * to the file.
 *
 * The build fails if any XML element type the inventory counted is missing
 * from the tables (coverage check), so nothing upstream adds slips through.
 */
import { Database } from "bun:sqlite";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import {
  type Document, type Element, type Inventory,
  readArticle, articleOf, rootsOf, parseArtId, kapForms, nodes, plainText, textOf,
  inventory, emptyInventory, childElements, firstChild, descendants, substituteEntities, parse,
  NODE_KIND_SET, type Roots, type NodeInfo,
} from "voko-xml";
import lingvoj from "voko-xml/data/cfg/lingvoj.json";
import fakoj from "voko-xml/data/cfg/fakoj.json";
import stiloj from "voko-xml/data/cfg/stiloj.json";
import mallongigoj from "voko-xml/data/cfg/mallongigoj.json";
import { runPass, type Pass } from "./pass";
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
/** What every runtime needs: the search tables over L2. */
export const CORE_PASSES: Pass[] = [searchPass];
/** Enrichment for the server's other tools, and the indexes they read through. */
export const ENRICHMENT_PASSES: Pass[] = [indexPass, ftsPass, tldLinksPass, refsPass, morphPass];
export const PASSES: Pass[] = [...CORE_PASSES, ...ENRICHMENT_PASSES];

export function passesOf(stage: Stage): Pass[] {
  return stage === "core" ? CORE_PASSES : PASSES;
}

// ---------------------------------------------------------------------------

interface Owner { kind: string; id: number | null }

interface Ctx {
  db: Database;
  st: ReturnType<typeof prepare>;
  roots: Roots;
  /** ekzOrdCounter: the node's ekz ordinal, shared by every ctx of that node. */
  node: NodeInfo & { id: number; ekzOrdCounter?: number };
  nodeIds: Map<NodeInfo, number>;
  owner: Owner;
  /** Per-owner ordinal counters, keyed by `${owner.kind}:${owner.id}:${table}`. */
  ord: Map<string, number>;
  /** Enclosing trdgrp / refgrp ordinal, if inside one. */
  grp: number | null;
  grpTip: string | null;
  grpLng: string | null;
}

function prepare(db: Database) {
  return {
    art: db.prepare(`INSERT INTO art (file, rad, rev, modified, source) VALUES (?,?,?,?,?)`),
    node: db.prepare(`INSERT INTO node (art_id, parent_id, kind, mrk, mrk_near, num, ref, ord, last_id) VALUES (?,?,?,?,?,?,?,?,?)`),
    lastId: db.prepare(`UPDATE node SET last_id = ? WHERE id = ?`),
    kap: db.prepare(`INSERT INTO kap (node_id, parent_kap_id, txt, tilde, norm, ofc, rad_var, ord) VALUES (?,?,?,?,?,?,?,?)`),
    dif: db.prepare(`INSERT INTO dif (node_id, ord, lng, txt) VALUES (?,?,?,?)`),
    ekz: db.prepare(`INSERT INTO ekz (node_id, owner_kind, owner_id, ord, mrk, txt, ind) VALUES (?,?,?,?,?,?,?)`),
    rim: db.prepare(`INSERT INTO rim (node_id, ord, num, mrk, txt) VALUES (?,?,?,?,?)`),
    trd: db.prepare(`INSERT INTO trd (node_id, owner_kind, owner_id, lng, grp, ord, txt, ind, baz, pr, klr, ofc, kod, fnt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`),
    ref: db.prepare(`INSERT INTO ref (node_id, owner_kind, owner_id, tip, cel, lst, val, grp, ord, txt) VALUES (?,?,?,?,?,?,?,?,?,?)`),
    fnt: db.prepare(`INSERT INTO fnt (node_id, owner_kind, owner_id, ord, bib, aut, vrk, lok, url, txt) VALUES (?,?,?,?,?,?,?,?,?,?)`),
    uzo: db.prepare(`INSERT INTO uzo (node_id, owner_kind, owner_id, tip, txt, ord) VALUES (?,?,?,?,?,?)`),
    gra: db.prepare(`INSERT INTO gra (node_id, vspec, txt) VALUES (?,?,?)`),
    bld: db.prepare(`INSERT INTO bld (node_id, owner_kind, owner_id, lok, mrk, tip, alt, lrg, prm, txt) VALUES (?,?,?,?,?,?,?,?,?,?)`),
    mlg: db.prepare(`INSERT INTO mlg (node_id, kod, txt) VALUES (?,?,?)`),
    tezrad: db.prepare(`INSERT INTO tezrad (node_id, fak) VALUES (?,?)`),
    lstref: db.prepare(`INSERT INTO lstref (node_id, lst, txt) VALUES (?,?,?)`),
    adm: db.prepare(`INSERT INTO adm (node_id, txt) VALUES (?,?)`),
    sncref: db.prepare(`INSERT INTO sncref (node_id, owner_kind, owner_id, ref) VALUES (?,?,?,?)`),
  };
}

function lastId(db: Database): number {
  return Number((db.query("SELECT last_insert_rowid() AS id").get() as { id: number | bigint }).id);
}

function nextOrd(ctx: Ctx, table: string): number {
  const k = `${ctx.owner.kind}:${ctx.owner.id}:${table}`;
  const n = ctx.ord.get(k) ?? 0;
  ctx.ord.set(k, n + 1);
  return n;
}

const OMIT = {
  // a lone <trd> inside <dif> is running text (mostly Latin names: "(Canis)");
  // a <trdgrp> there is an appended translation list
  dif: new Set(["fnt", "ekz", "trdgrp"]),
  ekz: new Set(["fnt", "trd", "trdgrp", "uzo"]),
  rim: new Set(["fnt", "ekz"]),
  trd: new Set(["klr", "pr", "baz", "ofc"]),
  plain: new Set(["fnt"]),
};

function txtOf(el: Element, ctx: Ctx, omit: ReadonlySet<string> = OMIT.plain): string {
  return plainText(el, { roots: ctx.roots, omit });
}
function childText(el: Element, name: string, ctx: Ctx): string | null {
  const parts = childElements(el, name).map((c) => txtOf(c, ctx));
  return parts.length ? parts.join(" ") : null;
}

// ---------------------------------------------------------------------------

function buildArticle(db: Database, st: Ctx["st"], doc: Document, key: string, source: string): void {
  const art = articleOf(doc);
  const roots = rootsOf(art);
  const id = parseArtId(art.attrs.mrk ?? "");
  st.art.run(key, roots.rad, id.rev ?? null, id.date ?? null, source);
  const artId = lastId(db);

  const infos = nodes(art, key);
  const nodeIds = new Map<NodeInfo, number>();
  const mrkNear = new Map<NodeInfo, string | null>();
  const ordByParent = new Map<NodeInfo | null, Record<string, number>>();
  for (const n of infos) {
    const near = n.mrk ?? (n.parent ? mrkNear.get(n.parent) ?? null : null);
    mrkNear.set(n, near);
    const counters = ordByParent.get(n.parent) ?? {};
    ordByParent.set(n.parent, counters);
    const ord = (counters[n.kind] = (counters[n.kind] ?? 0) + 1) - 1;
    st.node.run(
      artId, n.parent ? nodeIds.get(n.parent)! : null, n.kind, n.mrk, near,
      n.el.attrs.num ?? null, n.el.attrs.ref ?? null, ord, 0
    );
    nodeIds.set(n, lastId(db));
  }
  // Preorder ids: a node's subtree ends at its last descendant.
  const last = new Map<NodeInfo, number>();
  for (const n of infos) {
    const id = nodeIds.get(n)!;
    for (let p: NodeInfo | null = n; p; p = p.parent) last.set(p, id);
  }
  for (const n of infos) st.lastId.run(last.get(n)!, nodeIds.get(n)!);

  for (const n of infos) {
    const ctx: Ctx = {
      db, st, roots, node: Object.assign(n, { id: nodeIds.get(n)! }), nodeIds,
      owner: { kind: "node", id: nodeIds.get(n)! }, ord: new Map(),
      grp: null, grpTip: null, grpLng: null,
    };
    extractChildren(n.el, ctx);
  }
}

/** Walk the descriptive content of an element; structural nodes are skipped (they have their own ctx). */
function extractChildren(el: Element, ctx: Ctx): void {
  for (const c of el.children) {
    if (c.type !== "element") continue;
    if (NODE_KIND_SET.has(c.name)) continue;
    extract(c, ctx);
  }
}

function withOwner(ctx: Ctx, kind: string, id: number | null): Ctx {
  return { ...ctx, owner: { kind, id }, grp: null, grpTip: null, grpLng: null };
}

function extract(el: Element, ctx: Ctx): void {
  const { st } = ctx;
  const nid = ctx.node.id;
  const o = ctx.owner;
  switch (el.name) {
    case "kap": {
      insertKap(el, ctx, null);
      return;
    }
    case "dif": {
      st.dif.run(nid, nextOrd(ctx, "dif"), el.attrs.lng ?? null, txtOf(el, ctx, OMIT.dif));
      extractChildren(el, withOwner(ctx, "dif", lastId(ctx.db)));
      return;
    }
    case "ekz": {
      const ord = ctx.node.ekzOrdCounter ?? 0;
      ctx.node.ekzOrdCounter = ord + 1;
      st.ekz.run(nid, o.kind, o.id, ord, el.attrs.mrk ?? null, txtOf(el, ctx, OMIT.ekz), childText(el, "ind", ctx));
      extractChildren(el, withOwner(ctx, "ekz", lastId(ctx.db)));
      return;
    }
    case "rim": {
      st.rim.run(nid, nextOrd(ctx, "rim"), el.attrs.num ?? null, el.attrs.mrk ?? null, txtOf(el, ctx, OMIT.rim));
      extractChildren(el, withOwner(ctx, "rim", lastId(ctx.db)));
      return;
    }
    case "trdgrp": {
      const g = nextOrd(ctx, "trdgrp");
      const inner: Ctx = { ...ctx, grp: g, grpLng: el.attrs.lng ?? null };
      extractChildren(el, inner);
      return;
    }
    case "trd": {
      const lng = el.attrs.lng ?? ctx.grpLng ?? "";
      st.trd.run(
        nid, o.kind, o.id, lng, ctx.grp, nextOrd(ctx, "trd"),
        txtOf(el, ctx, OMIT.trd), childText(el, "ind", ctx), childText(el, "baz", ctx),
        childText(el, "pr", ctx), childText(el, "klr", ctx), childText(el, "ofc", ctx),
        el.attrs.kod ?? null, el.attrs.fnt ?? null
      );
      // A <trd> is not a leaf: the DTD lets its <klr> hold trd/trdgrp/ekz/ref
      // (vokoxml.dtd, <!ELEMENT klr>), which ReVo uses to gloss a translation
      // in a third language — `unu` carries Finnish inside a Spanish trd, `li`
      // Ido inside an Indonesian one. Descending keeps those rows; the language
      // comes from the nested <trdgrp lng>, since withOwner clears grpLng.
      extractChildren(el, withOwner(ctx, "trd", lastId(ctx.db)));
      return;
    }
    case "refgrp": {
      const g = nextOrd(ctx, "refgrp");
      extractChildren(el, { ...ctx, grp: g, grpTip: el.attrs.tip ?? "vid" });
      return;
    }
    case "ref": {
      st.ref.run(
        nid, o.kind, o.id, el.attrs.tip ?? ctx.grpTip ?? null, el.attrs.cel ?? "", el.attrs.lst ?? null,
        el.attrs.val ?? null, ctx.grp, nextOrd(ctx, "ref"), txtOf(el, ctx)
      );
      extractChildren(el, withOwner(ctx, "ref", lastId(ctx.db))); // sncref inside ref
      return;
    }
    case "fnt": {
      const url = firstChild(el, "url") ?? [...descendants(el, "url")][0];
      st.fnt.run(
        nid, o.kind, o.id, nextOrd(ctx, "fnt"), childText(el, "bib", ctx), childText(el, "aut", ctx),
        childText(el, "vrk", ctx), childText(el, "lok", ctx), url ? url.attrs.ref ?? textOf(url).trim() : null,
        txtOf(el, ctx, new Set())
      );
      return;
    }
    case "uzo": {
      st.uzo.run(nid, o.kind, o.id, el.attrs.tip ?? null, txtOf(el, ctx), nextOrd(ctx, "uzo"));
      return;
    }
    case "gra": {
      st.gra.run(nid, childText(el, "vspec", ctx), txtOf(el, ctx));
      return;
    }
    case "bld": {
      st.bld.run(
        nid, o.kind, o.id, el.attrs.lok ?? "", el.attrs.mrk ?? null, el.attrs.tip ?? null, el.attrs.alt ?? null,
        el.attrs.lrg ?? null, el.attrs.prm ?? null, txtOf(el, ctx, new Set(["fnt", "trd", "trdgrp", "mrk"]))
      );
      extractChildren(el, withOwner(ctx, "bld", lastId(ctx.db)));
      return;
    }
    case "mlg": st.mlg.run(nid, el.attrs.kod ?? null, txtOf(el, ctx)); return;
    case "tezrad": st.tezrad.run(nid, el.attrs.fak ?? null); return;
    case "lstref": st.lstref.run(nid, el.attrs.lst ?? "", txtOf(el, ctx)); return;
    case "adm": st.adm.run(nid, txtOf(el, ctx)); return;
    case "sncref": st.sncref.run(nid, o.kind, o.id, el.attrs.ref ?? null); return;
    case "var": {
      // <var> outside a kap (DTD allows var only inside kap; keep generic)
      extractChildren(el, ctx);
      return;
    }
    case "klr":
    case "ke":
    case "mrk": {
      extractChildren(el, withOwner(ctx, el.name, null));
      return;
    }
    default:
      // Inline styling (tld, em, ctl, nom, …), url outside fnt, ind/pr/baz/mll
      // outside trd: no table of their own; they live in the parent's txt/xml.
      // Still descend, so a ref/ekz nested in styling is not lost.
      extractChildren(el, ctx);
  }
}

/** Writes the headword and everything under it; returns its kap.id. */
function insertKap(kap: Element, ctx: Ctx, parentKapId: number | null): number {
  const forms = kapForms(kap, ctx.roots);
  const radVar = [...descendants(kap, "rad")].find((r) => r.attrs.var !== undefined && !insideVar(r, kap));
  ctx.st.kap.run(
    ctx.node.id, parentKapId, forms.txt, forms.tilde, forms.norm, forms.ofc, radVar?.attrs.var ?? null,
    nextOrd(ctx, "kap")
  );
  const kapId = lastId(ctx.db);
  const inner = withOwner(ctx, "kap", kapId);
  for (const c of kap.children) {
    if (c.type !== "element") continue;
    if (c.name === "var") {
      const vk = firstChild(c, "kap");
      // the variant's own id, not last_insert_rowid(): the call above writes
      // whatever the variant kap holds (aidos has a <fnt> in one), so the last
      // row inserted is not the kap
      const vctx = withOwner(ctx, "var", vk ? insertKap(vk, ctx, kapId) : kapId);
      for (const vc of c.children) if (vc.type === "element" && vc !== vk) extract(vc, vctx);
    } else if (c.name !== "rad" && c.name !== "ofc" && c.name !== "tld") {
      extract(c, inner);
    }
  }
  return kapId;
}

function insideVar(el: Element, until: Element): boolean {
  let p = el.parent;
  while (p && p !== until) {
    if (p.name === "var") return true;
    p = p.parent;
  }
  return false;
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
  const s = db.prepare("INSERT OR REPLACE INTO bib (mll, tip, tit, url, aut, trd, ald, eld) VALUES (?,?,?,?,?,?,?,?)");
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

/** Element type → table whose row count must equal the element count. */
const COVERAGE: Record<string, string> = {
  art: "art", kap: "kap", dif: "dif", ekz: "ekz", rim: "rim", trd: "trd", ref: "ref", fnt: "fnt",
  uzo: "uzo", gra: "gra", bld: "bld", mlg: "mlg", tezrad: "tezrad", lstref: "lstref", adm: "adm", sncref: "sncref",
};

function coverage(db: Database, inv: Inventory): string[] {
  const problems: string[] = [];
  const count = (t: string) => (db.query(`SELECT COUNT(*) c FROM ${t}`).get() as { c: number }).c;
  const rows: string[] = [];
  for (const [elName, table] of Object.entries(COVERAGE)) {
    const want = inv.elements[elName] ?? 0;
    const got = count(table);
    rows.push(`  ${elName.padEnd(7)} ${String(want).padStart(8)} xml ${String(got).padStart(8)} rows${want === got ? "" : "  <-- MISMATCH"}`);
    if (want !== got) problems.push(`${elName}: ${want} in XML, ${got} rows in ${table}`);
  }
  const nodeWant = ["art", "subart", "drv", "subdrv", "snc", "subsnc"].reduce((s, k) => s + (inv.elements[k] ?? 0), 0);
  const nodeGot = count("node");
  rows.push(`  ${"node".padEnd(7)} ${String(nodeWant).padStart(8)} xml ${String(nodeGot).padStart(8)} rows${nodeWant === nodeGot ? "" : "  <-- MISMATCH"}`);
  if (nodeWant !== nodeGot) problems.push(`node: ${nodeWant} in XML, ${nodeGot} rows`);
  console.log("coverage:\n" + rows.join("\n"));
  for (const k of Object.keys(inv.unknownElements)) problems.push(`unknown element <${k}> x${inv.unknownElements[k]}`);
  for (const k of Object.keys(inv.unknownAttributes)) problems.push(`unknown attribute ${k} x${inv.unknownAttributes[k]}`);
  return problems;
}

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

/** Version 2: no stored XML, no path keys, node.last_id, the search tables. */
export const SCHEMA_VERSION = 2;

/** `limit`: first N articles only (dev, tests); `extra`: article keys added to that slice. */
export function buildL2(out: string, limit?: number, extra: string[] = []): Database {
  if (existsSync(out)) unlinkSync(out);
  const db = new Database(out);
  db.exec("PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF; PRAGMA cache_size = -200000; PRAGMA temp_store = MEMORY;");
  db.exec(readFileSync(join(__dirname, "schema.sql"), "utf8"));
  const st = prepare(db);

  loadCfg(db);
  const nBib = loadBibliogr(db);
  console.log(`cfg: ${(lingvoj as any[]).length} lng, ${(fakoj as any[]).length} fako, ${(stiloj as any[]).length} stilo, ${nBib} bib`);

  let articles = corpusArticles();
  if (limit) articles = articles.filter((a, i) => i < limit || extra.includes(a.key));
  const inv = emptyInventory();
  const t0 = Date.now();
  const BATCH = 500;
  for (let i = 0; i < articles.length; i += BATCH) {
    const slice = articles.slice(i, i + BATCH);
    db.transaction(() => {
      for (const a of slice) {
        const doc = readArticle(a);
        inventory(doc, inv);
        if (a.source === "overlay") console.log(`  overlay: ${a.key}`);
        buildArticle(db, st, doc, a.key, a.source);
      }
    })();
    process.stdout.write(`\r  ${Math.min(i + BATCH, articles.length)}/${articles.length} articles`);
  }
  // Headword of every node: its own first <kap>, else inherited from the parent.
  db.run(`UPDATE node SET kap_id = (SELECT k.id FROM kap k WHERE k.node_id = node.id AND k.parent_kap_id IS NULL ORDER BY k.ord LIMIT 1)`);
  for (let depth = 0; depth < 6; depth++) {
    db.run(`UPDATE node SET kap_id = (SELECT p.kap_id FROM node p WHERE p.id = node.parent_id) WHERE kap_id IS NULL AND parent_id IS NOT NULL`);
  }
  console.log(`\nL2 built in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const problems = coverage(db, inv);
  const meta = db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?,?)");
  meta.run("schema", "voko");
  meta.run("schema_version", String(SCHEMA_VERSION));
  meta.run("built_at", new Date().toISOString());
  meta.run("fonto_rev", gitRev(FONTO, "revo-fonto"));
  meta.run("voko_grundo_rev", gitRev(GRUNDO, "voko-grundo"));
  meta.run("articles", String(articles.length));
  meta.run("inventory", JSON.stringify(inv.elements));
  if (problems.length) {
    console.error("COVERAGE PROBLEMS:\n  " + problems.join("\n  "));
    db.close();
    process.exit(1);
  }
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
  const stage = (opt("--stage") ?? "full") as Stage;
  if (stage !== "core" && stage !== "full") throw new Error(`no such stage: ${stage} (have core, full)`);

  let db: Database;
  if (only) {
    db = new Database(out);
    const pass = PASSES.find((p) => p.name === only);
    if (!pass) throw new Error(`no such pass: ${only} (have ${PASSES.map((p) => p.name).join(", ")})`);
    runPass(db, pass);
  } else {
    db = buildL2(out, limit);
    if (!args.includes("--no-passes")) for (const p of passesOf(stage)) runPass(db, p);
    if (stage === "core") db.run("DELETE FROM fnt");
    db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('stage', ?)", [stage]);
  }
  finish(db, out);
  const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);
  console.log(`${out}: ${mb(Bun.file(out).size)} MB, ${out}.gz: ${mb(Bun.file(`${out}.gz`).size)} MB`);
}

if (import.meta.main) main();
