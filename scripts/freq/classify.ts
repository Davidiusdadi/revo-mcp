/**
 * Hold every counted lemma against ReVo with `classify` (the gloss tool's own
 * verdict: headword, inflection, attested, derived, unknown) and split it into
 * morphemes, then sum the counts per root.
 *
 * Which lemmas: those with a count of at least MIN in either source, plus
 * every ReVo headword whatever its count. The verdicts are cached in
 * data/freq/classified.tsv, so a rerun only classifies what is new
 * (`--fresh` drops the cache). The work is spread over worker processes.
 *
 * Output: data/freq/words.tsv — lemma, verdict, kap_id, headword, seg, kinds,
 * roots, combo (for a word of two roots or more: whether ReVo has a headword
 * with the same roots), then per source count and distinct forms; and
 * data/freq/roots.tsv — every morpheme of the splits (root, endingless word,
 * prefix, suffix), its kind, per-source counts, lemmas contributing.
 *
 *   tsx scripts/freq/classify.ts [--fresh] [--workers N]
 */
import { spawn } from "child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { availableParallelism } from "os";
import { fileURLToPath } from "url";
import { Database } from "../../src/runtime/node-database";
import { wyhash } from "../wyhash";
import { join } from "path";
import { classify, inventoryOf } from "../../src/gloss";
import { tsvRows } from "./lemmatise";
import { DB, FREQ, isMain, lemmasFile, ROOTS_FILE, SOURCE_NAMES, WORDS_FILE, type SourceName } from "./paths";

const MIN = 2;
export const CLASSIFIED_FILE = join(FREQ, "classified.tsv");
const TODO_FILE = join(FREQ, "classify-todo.txt");
const partFile = (i: number) => join(FREQ, `classified.part-${i}.tsv`);

export interface Classified { verdict: string; headword: string; kap_id: number | null; seg: string; kinds: string }
export interface Counts { n: Record<SourceName, number>; forms: Record<SourceName, number> }

const opt = (name: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };

export async function loadCounts(): Promise<Map<string, Counts>> {
  const counts = new Map<string, Counts>();
  for (const s of SOURCE_NAMES) {
    if (!existsSync(lemmasFile(s))) { console.log(`no ${lemmasFile(s)}: ${s} left out`); continue; }
    for await (const [lemma, n, forms] of tsvRows(lemmasFile(s))) {
      let c = counts.get(lemma);
      if (!c) counts.set(lemma, (c = { n: { hplt: 0, tekstaro: 0 }, forms: { hplt: 0, tekstaro: 0 } }));
      c.n[s] = Number(n);
      c.forms[s] = Number(forms);
    }
  }
  return counts;
}

export async function loadClassified(): Promise<Map<string, Classified>> {
  const out = new Map<string, Classified>();
  if (!existsSync(CLASSIFIED_FILE)) return out;
  for await (const [lemma, verdict, headword, kap_id, seg, kinds] of tsvRows(CLASSIFIED_FILE)) {
    if (lemma) out.set(lemma, { verdict, headword, kap_id: kap_id ? Number(kap_id) : null, seg, kinds });
  }
  return out;
}

function classifyWords(db: Database, words: string[], log: (s: string) => void): string[] {
  const inv = inventoryOf(db);
  const kapId = db.query<{ id: number }, [string]>("SELECT id FROM headword WHERE norm = ? ORDER BY main_id IS NOT NULL, id LIMIT 1");
  const rows: string[] = [];
  let i = 0;
  for (const w of words) {
    const t = classify(db, w, inv);
    const id = t.headword ? kapId.get(t.headword.toLowerCase())?.id ?? "" : "";
    rows.push(`${w}\t${t.verdict}\t${t.headword ?? ""}\t${id}\t${t.seg ?? ""}\t${t.kinds ?? ""}\n`);
    if (++i % 20000 === 0) log(`${i}/${words.length}`);
  }
  return rows;
}

async function worker(i: number, n: number) {
  const todo = readFileSync(TODO_FILE, "utf8").split("\n").filter((w) => w && Number(wyhash(new TextEncoder().encode(w)) % BigInt(n)) === i);
  const db = new Database(DB, { readonly: true });
  const rows = classifyWords(db, todo, (s) => console.log(`  worker ${i}: ${s}`));
  writeFileSync(partFile(i), rows.join(""));
}

async function main() {
  const workers = Number(opt("--workers") ?? Math.min(8, availableParallelism()));
  if (process.argv.includes("--fresh") && existsSync(CLASSIFIED_FILE)) unlinkSync(CLASSIFIED_FILE);
  const counts = await loadCounts();
  const db = new Database(DB, { readonly: true });
  const headwords = db.query<{ norm: string }, []>("SELECT DISTINCT norm FROM headword").all()
    .map((r) => r.norm).filter((w) => /^\p{L}+$/u.test(w));
  const selected = new Set(headwords);
  for (const [lemma, c] of counts) if (c.n.hplt >= MIN || c.n.tekstaro >= MIN) selected.add(lemma);
  const classified = await loadClassified();
  const todo = [...selected].filter((w) => !classified.has(w));
  console.log(`${counts.size} lemmas, ${selected.size} selected (${headwords.length} ReVo headwords), ${classified.size} cached, ${todo.length} to classify`);

  if (todo.length > 0) {
    writeFileSync(TODO_FILE, todo.join("\n") + "\n");
    const started = Date.now();
    // each worker is this script again, under the same loader (tsx's flags are in execArgv)
    const codes = await Promise.all(Array.from({ length: workers }, (_, i) => new Promise<number | null>((ok, fail) => {
      const p = spawn(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), "--worker", String(i), "--of", String(workers)], { stdio: "inherit" });
      p.on("error", fail);
      p.on("close", ok);
    })));
    if (codes.some((c) => c !== 0)) throw new Error(`a worker failed: ${codes}`);
    const parts = await Promise.all(Array.from({ length: workers }, (_, i) => readFileSync(partFile(i), "utf8")));
    const old = existsSync(CLASSIFIED_FILE) ? readFileSync(CLASSIFIED_FILE, "utf8") : "";
    writeFileSync(CLASSIFIED_FILE, old + parts.join(""));
    for (let i = 0; i < workers; i++) unlinkSync(partFile(i));
    unlinkSync(TODO_FILE);
    console.log(`classified ${todo.length} in ${((Date.now() - started) / 1000).toFixed(0)}s with ${workers} workers`);
    for (const [lemma, c] of await loadClassified()) classified.set(lemma, c);
  }

  // words.tsv
  const combos = new Set<string>();
  for (const r of db.query<{ roots: string }, []>("SELECT DISTINCT roots FROM x_morph").all()) {
    const rs = r.roots.split(" ").filter(Boolean);
    if (rs.length >= 2) combos.add(rs.sort().join(" "));
  }
  const rootsOf = (c: Classified): { m: string; k: string }[] => {
    if (!c.seg) return [];
    const ms = c.seg.split("|"), ks = c.kinds;
    return ms.map((m, i) => ({ m, k: ks[i] ?? "?" })).filter((p) => "RWPS".includes(p.k));
  };
  const byCount = [...selected].sort((a, b) => {
    const ca = counts.get(a), cb = counts.get(b);
    return (cb?.n.hplt ?? 0) - (ca?.n.hplt ?? 0) || (cb?.n.tekstaro ?? 0) - (ca?.n.tekstaro ?? 0) || (a < b ? -1 : 1);
  });
  const roots = new Map<string, { k: string; n: Record<SourceName, number>; lemmas: number }>();
  const verdicts: Record<string, { lemmas: number; n: Record<SourceName, number> }> = {};
  const lines: string[] = ["lemma\tverdict\tkap_id\theadword\tseg\tkinds\troots\tcombo\thplt\ttekstaro\thplt_forms\ttekstaro_forms\n"];
  for (const lemma of byCount) {
    const c = classified.get(lemma);
    if (!c) throw new Error(`${lemma} not classified`);
    const cnt = counts.get(lemma) ?? { n: { hplt: 0, tekstaro: 0 }, forms: { hplt: 0, tekstaro: 0 } };
    const rs = rootsOf(c);
    const rootNames = rs.filter((r) => r.k === "R" || r.k === "W").map((r) => r.m);
    const combo = rootNames.length >= 2 ? (combos.has([...rootNames].sort().join(" ")) ? "known" : "new") : "";
    lines.push(`${lemma}\t${c.verdict}\t${c.kap_id ?? ""}\t${c.headword}\t${c.seg}\t${c.kinds}\t${rootNames.join(" ")}\t${combo}\t${cnt.n.hplt}\t${cnt.n.tekstaro}\t${cnt.forms.hplt}\t${cnt.forms.tekstaro}\n`);
    const v = (verdicts[c.verdict] ??= { lemmas: 0, n: { hplt: 0, tekstaro: 0 } });
    v.lemmas++;
    v.n.hplt += cnt.n.hplt;
    v.n.tekstaro += cnt.n.tekstaro;
    for (const key of new Set(rs.map((p) => `${p.k} ${p.m}`))) {
      const [k, r] = key.split(" ");
      let e = roots.get(key);
      if (!e) roots.set(key, (e = { k, n: { hplt: 0, tekstaro: 0 }, lemmas: 0 }));
      e.n.hplt += cnt.n.hplt;
      e.n.tekstaro += cnt.n.tekstaro;
      e.lemmas++;
    }
  }
  writeFileSync(WORDS_FILE, lines.join(""));
  const rootRows = [...roots].sort((a, b) => b[1].n.hplt - a[1].n.hplt || b[1].n.tekstaro - a[1].n.tekstaro || (a[0] < b[0] ? -1 : 1));
  writeFileSync(ROOTS_FILE, "morph\tkind\thplt\ttekstaro\tlemmas\n" + rootRows.map(([key, e]) => `${key.split(" ")[1]}\t${e.k}\t${e.n.hplt}\t${e.n.tekstaro}\t${e.lemmas}\n`).join(""));
  console.log(`${WORDS_FILE}: ${lines.length - 1} lemmas; ${ROOTS_FILE}: ${roots.size} morphemes`);
  for (const [v, e] of Object.entries(verdicts)) console.log(`  ${v.padEnd(10)} ${String(e.lemmas).padStart(8)} lemmas  hplt ${e.n.hplt}  tekstaro ${e.n.tekstaro}`);
}

if (isMain(import.meta.url)) {
  const w = opt("--worker");
  if (w !== undefined) await worker(Number(w), Number(opt("--of")));
  else await main();
}
