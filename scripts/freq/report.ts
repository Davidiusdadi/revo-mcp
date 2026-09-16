/**
 * data/freq/REPORT.md: what the counts say — totals per source, how much of
 * real text ReVo covers, coverage curves, the unlisted words counted up,
 * sanity words, cross-checks against two published lists (read from
 * data/freq/sources/ref/, never redistributed), and the size of a reduced
 * counts file at candidate thresholds.
 *
 *   tsx scripts/freq/report.ts
 */
import { existsSync, readFileSync, writeFileSync } from "fs";
import { gzipSync } from "zlib";
import { join } from "path";
import { tsvRows } from "./lemmatise";
import { lemmaOf } from "../../src/morph";
import { Database } from "../../src/runtime/node-database";
import { DB, FREQ, isMain, lemmasFile, REPORT_FILE, ROOTS_FILE, SOURCES_FILE, SOURCE_NAMES, TOTALS_FILE, WORDS_FILE, type SourceName, type SourceRecord } from "./paths";
import type { Totals } from "./count-forms";

const REF = join(FREQ, "sources", "ref");
const VANEGE = join(REF, "vanege-tekstaro-15000.txt");
const REMUSH = join(REF, "remush-chiuj.tsv");

interface Word { lemma: string; verdict: string; kap_id: string; headword: string; seg: string; kinds: string; roots: string; combo: string; n: Record<SourceName, number>; forms: Record<SourceName, number> }
interface Morph { morph: string; kind: string; n: Record<SourceName, number>; lemmas: number }

const fmt = (n: number) => n.toLocaleString("en-US");
const pct = (a: number, b: number, d = 1) => b ? `${((100 * a) / b).toFixed(d)}%` : "–";
const pm = (n: number, total: number) => ((1e6 * n) / total).toFixed(n * 1e6 / total < 10 ? 2 : 0);
const table = (head: string[], rows: (string | number)[][]) =>
  [`| ${head.join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`, ...rows.map((r) => `| ${r.map((c) => String(c).replace(/\|/g, "\\|")).join(" | ")} |`)].join("\n");

/** Items needed, from the top, to cover each share of the total. */
function coverage(counts: number[], shares = [0.5, 0.8, 0.9, 0.95, 0.99]): Record<string, number> {
  const total = counts.reduce((a, b) => a + b, 0);
  const out: Record<string, number> = {};
  let acc = 0, i = 0;
  for (const s of shares) {
    while (i < counts.length && acc < s * total) acc += counts[i++];
    out[`${s * 100}%`] = i;
  }
  return out;
}

function spearman(a: string[], b: string[]): { shared: number; rho: number } {
  const rb = new Map(b.map((x, i) => [x, i]));
  const pairs = a.map((x, i) => [i, rb.get(x)] as const).filter((p): p is [number, number] => p[1] !== undefined);
  // rank the shared items among themselves
  const ra = pairs.map((p) => p[0]).sort((x, y) => x - y), rbb = [...pairs.map((p) => p[1])].sort((x, y) => x - y);
  const n = pairs.length;
  let d2 = 0;
  for (const [x, y] of pairs) d2 += (ra.indexOf(x) - rbb.indexOf(y)) ** 2;
  return { shared: n, rho: n > 1 ? 1 - (6 * d2) / (n * (n * n - 1)) : NaN };
}

async function main() {
  const totals = JSON.parse(readFileSync(TOTALS_FILE, "utf8")) as Record<SourceName, Totals>;
  const sources = JSON.parse(readFileSync(SOURCES_FILE, "utf8")) as Record<SourceName, SourceRecord>;
  const words: Word[] = [];
  const byLemma = new Map<string, Word>();
  let header = true;
  for await (const r of tsvRows(WORDS_FILE)) {
    if (header) { header = false; continue; }
    if (r.length < 12) continue;
    const w: Word = { lemma: r[0], verdict: r[1], kap_id: r[2], headword: r[3], seg: r[4], kinds: r[5], roots: r[6], combo: r[7],
      n: { hplt: Number(r[8]), tekstaro: Number(r[9]) }, forms: { hplt: Number(r[10]), tekstaro: Number(r[11]) } };
    words.push(w);
    byLemma.set(w.lemma, w);
  }
  const multiword = (new Database(DB, { readonly: true }).query("SELECT COUNT(DISTINCT norm) c FROM headword WHERE norm LIKE '% %'").get() as { c: number }).c;
  const morphs: Morph[] = [];
  header = true;
  for await (const r of tsvRows(ROOTS_FILE)) {
    if (header) { header = false; continue; }
    if (r.length < 5) continue;
    morphs.push({ morph: r[0], kind: r[1], n: { hplt: Number(r[2]), tekstaro: Number(r[3]) }, lemmas: Number(r[4]) });
  }
  // every lemma of each source, for the share the selection leaves out
  const lemmaTotals: Record<SourceName, { lemmas: number; tokens: number; ranked: string[] }> = { hplt: { lemmas: 0, tokens: 0, ranked: [] }, tekstaro: { lemmas: 0, tokens: 0, ranked: [] } };
  for (const s of SOURCE_NAMES) {
    for await (const [lemma, n] of tsvRows(lemmasFile(s))) {
      if (!lemma) continue;
      lemmaTotals[s].lemmas++;
      lemmaTotals[s].tokens += Number(n);
      lemmaTotals[s].ranked.push(lemma);
    }
  }

  const out: string[] = [];
  const h = (s: string) => out.push(`\n## ${s}\n`);
  out.push(`# Usage frequency — Esperanto words and roots\n\nGenerated ${new Date().toISOString().slice(0, 10)} by scripts/freq/report.ts from the files in data/freq/.\n`);

  // ---- sources and totals
  h("Sources and totals");
  for (const s of SOURCE_NAMES) out.push(`- **${s}**: ${sources[s].licence}; ${sources[s].files.map((f) => `${f.url} (${fmt(f.bytes)} bytes, fetched ${f.fetched})`).join(", ")}`);
  out.push("");
  out.push(table(["", ...SOURCE_NAMES], [
    ["documents", ...SOURCE_NAMES.map((s) => fmt(totals[s].documents))],
    ["lines read / kept (hplt: labelled Esperanto)", ...SOURCE_NAMES.map((s) => `${fmt(totals[s].lines)} / ${fmt(totals[s].kept)}`)],
    ["tokens (runs of letters)", ...SOURCE_NAMES.map((s) => fmt(totals[s].tokens))],
    ["Esperanto tokens (alphabet only)", ...SOURCE_NAMES.map((s) => `${fmt(totals[s].esperanto)} (${pct(totals[s].esperanto, totals[s].tokens)})`)],
    ["foreign tokens (other letters)", ...SOURCE_NAMES.map((s) => fmt(totals[s].foreign))],
    ["x-system tokens converted", ...SOURCE_NAMES.map((s) => fmt(totals[s].xsystem))],
    ["surface forms (types)", ...SOURCE_NAMES.map((s) => fmt(totals[s].types))],
    ["lemmas (lemmaOf)", ...SOURCE_NAMES.map((s) => fmt(lemmaTotals[s].lemmas))],
  ]));
  out.push("\nTekstaro's own word count is 14,879,073 (the `<extent>` of its 128 texts); the tokeniser splits at hyphens and apostrophes, hence the 1% more. HPLT's `epo_Latn` release claims 471.6M words before the per-line language filter.");

  // ---- verdicts
  h("How much of real text ReVo covers");
  out.push("Every lemma with a count of at least 2 in either source, plus every ReVo headword, was held against ReVo with the gloss tool's `classify`: **headword** (a ReVo headword as written), **inflection** (a form of one), **attested** (a form the examples write, with a stored split), **derived** (buildable from known morphemes, but not in ReVo), **unknown** (nothing fits: typos, names, foreign words). Lemmas seen once are not classified; their share is `not classified`.\n");
  const verdicts = ["headword", "inflection", "attested", "derived", "unknown"];
  const vRows = verdicts.map((v) => {
    const ws = words.filter((w) => w.verdict === v);
    return [v, fmt(ws.length), ...SOURCE_NAMES.map((s) => { const n = ws.reduce((a, w) => a + w.n[s], 0); return `${fmt(n)} (${pct(n, totals[s].esperanto)})`; })];
  });
  const selectedTokens = (s: SourceName) => words.reduce((a, w) => a + w.n[s], 0);
  vRows.push(["not classified (lemma seen once)", fmt(SOURCE_NAMES.reduce((a, s) => a + lemmaTotals[s].lemmas, 0) - words.length) + "*", ...SOURCE_NAMES.map((s) => { const n = totals[s].esperanto - selectedTokens(s); return `${fmt(n)} (${pct(n, totals[s].esperanto)})`; })]);
  out.push(table(["verdict", "lemmas", ...SOURCE_NAMES.map((s) => `${s} tokens`)], vRows));
  out.push("\n\\* lemma rows of both sources added up, so a lemma seen once in each is counted twice here.");
  for (const s of SOURCE_NAMES) {
    const ws = words.filter((w) => w.n[s] > 0);
    const known = ws.filter((w) => ["headword", "inflection", "attested"].includes(w.verdict));
    out.push(`\nOf the lemmas seen at least twice in **${s}**: ${fmt(ws.length)}; in ReVo one way or another ${fmt(known.length)} (${pct(known.length, ws.length)}), derived ${fmt(ws.filter((w) => w.verdict === "derived").length)}, unknown ${fmt(ws.filter((w) => w.verdict === "unknown").length)}.`);
  }

  // ---- coverage
  h("Coverage curves");
  out.push("How many items, taken from the most frequent down, cover a share of the tokens. Roots: the counts are over the morphemes of the split of each classified lemma (a lemma with two roots counts for both); `R+W` includes the endingless words (la, kaj, mi), `R` is roots alone. remush.be's reference for its Monato-based corpus: 653 roots cover 90%, 1,350 cover 95%, 3,813 cover 99%.\n");
  const covRows: (string | number)[][] = [];
  for (const s of SOURCE_NAMES) {
    const lemmaCounts = words.map((w) => w.n[s]).filter((n) => n > 0).sort((a, b) => b - a);
    const rw = morphs.filter((m) => m.kind === "R" || m.kind === "W").map((m) => m.n[s]).filter((n) => n > 0).sort((a, b) => b - a);
    const r = morphs.filter((m) => m.kind === "R").map((m) => m.n[s]).filter((n) => n > 0).sort((a, b) => b - a);
    for (const [label, counts] of [["lemmas", lemmaCounts], ["roots R+W", rw], ["roots R", r]] as const) {
      const c = coverage(counts);
      covRows.push([s, label, fmt(counts.length), ...Object.values(c).map(fmt)]);
    }
  }
  out.push(table(["source", "items", "total", "50%", "80%", "90%", "95%", "99%"], covRows));

  // ---- top roots
  h("Top 60 roots and endingless words");
  // a morpheme can be listed under two kinds (la as W and as R); the ranking keeps its first, largest count
  const rank = (s: SourceName, kinds: string) => {
    const seen = new Set<string>();
    return morphs.filter((m) => kinds.includes(m.kind) && m.n[s] > 0).sort((a, b) => b.n[s] - a.n[s]).filter((m) => !seen.has(m.morph) && seen.add(m.morph));
  };
  const topH = rank("hplt", "RW"), topT = rank("tekstaro", "RW");
  const rankT = new Map(topT.map((m, i) => [m.morph, i + 1]));
  out.push(table(["#", "hplt", "per million", "tekstaro rank", "", "tekstaro", "per million", "hplt rank"], Array.from({ length: 60 }, (_, i) => {
    const a = topH[i], b = topT[i];
    const rankH = b ? topH.findIndex((m) => m.morph === b.morph) + 1 : 0;
    return [i + 1, a ? `${a.morph} (${a.kind})` : "", a ? pm(a.n.hplt, totals.hplt.esperanto) : "", (a && rankT.get(a.morph)) ?? "–", "",
      b ? `${b.morph} (${b.kind})` : "", b ? pm(b.n.tekstaro, totals.tekstaro.esperanto) : "", rankH || "–"];
  })));
  const topP = rank("hplt", "P").slice(0, 15), topS = rank("hplt", "S").slice(0, 25);
  out.push("\nPrefixes and suffixes, by hplt (counts are lemma tokens containing them):\n");
  out.push(table(["prefix", "hplt", "tekstaro", "lemmas", "", "suffix", "hplt", "tekstaro", "lemmas"], topS.map((sfx, i) => {
    const p = topP[i];
    return [p?.morph ?? "", p ? fmt(p.n.hplt) : "", p ? fmt(p.n.tekstaro) : "", p ? fmt(p.lemmas) : "", "", sfx.morph, fmt(sfx.n.hplt), fmt(sfx.n.tekstaro), fmt(sfx.lemmas)];
  })));

  // ---- sanity
  h("Sanity words");
  const sanity = ["la", "kaj", "esti", "mi", "hundo", "hundoj", "malsanulejo", "komputilo", "retpoŝto", "interreto", "esperanto", "saluton", "ĉu", "plu", "tamen", "unu", "ĵus", "manĝanta", "rapide", "rapida", "ino", "ege"];
  out.push(table(["lemma", "verdict", "headword", "split", "hplt", "per M", "tekstaro", "per M", "forms h/t"], sanity.map((l) => {
    const w = byLemma.get(l);
    if (!w) return [l, "–", "", "", "", "", "", "", ""];
    return [l, w.verdict, w.headword, w.seg, fmt(w.n.hplt), pm(w.n.hplt, totals.hplt.esperanto), fmt(w.n.tekstaro), pm(w.n.tekstaro, totals.tekstaro.esperanto), `${w.forms.hplt}/${w.forms.tekstaro}`];
  })));
  const rootSanity = ["hund", "san", "komput", "ret", "est", "mal", "ge", "ul", "ej", "in", "ig", "iĝ", "ind", "ebl"];
  out.push("\nMorphemes:\n");
  out.push(table(["morph", "kind", "hplt", "per M", "tekstaro", "per M", "lemmas"], rootSanity.flatMap((r) => morphs.filter((m) => m.morph === r).map((m) => [m.morph, m.kind, fmt(m.n.hplt), pm(m.n.hplt, totals.hplt.esperanto), fmt(m.n.tekstaro), pm(m.n.tekstaro, totals.tekstaro.esperanto), fmt(m.lemmas)]))));

  // ---- unlisted words
  h("Unlisted words, counted up");
  const derived = words.filter((w) => w.verdict === "derived");
  const newCombos = derived.filter((w) => w.combo === "new"), knownCombos = derived.filter((w) => w.combo === "known"), single = derived.filter((w) => !w.combo);
  out.push(`**derived**: ${fmt(derived.length)} lemmas ReVo does not list but its morphemes build — ${fmt(single.length)} on one root (a derivation), ${fmt(knownCombos.length)} on a root combination ReVo has in another headword, ${fmt(newCombos.length)} on a **root combination new to ReVo**. Tokens: hplt ${fmt(derived.reduce((a, w) => a + w.n.hplt, 0))}, tekstaro ${fmt(derived.reduce((a, w) => a + w.n.tekstaro, 0))}.\n`);
  const wordRows = (ws: Word[], s: SourceName, n: number) => table(["#", "lemma", "split", "roots", "combo", "hplt", "tekstaro", "forms h/t"],
    [...ws].sort((a, b) => b.n[s] - a.n[s]).slice(0, n).map((w, i) => [i + 1, w.lemma, w.seg, w.roots, w.combo, fmt(w.n.hplt), fmt(w.n.tekstaro), `${w.forms.hplt}/${w.forms.tekstaro}`]));
  out.push("### Derived, top 300 by hplt\n");
  out.push(wordRows(derived, "hplt", 300));
  out.push("\n### Derived, top 150 by Tekstaro\n");
  out.push(wordRows(derived, "tekstaro", 150));
  out.push("\n### New root combinations, top 150 by hplt\n");
  out.push(wordRows(newCombos, "hplt", 150));
  const unknown = words.filter((w) => w.verdict === "unknown");
  out.push(`\n### Unknown, top 120 by hplt (${fmt(unknown.length)} lemmas; hplt ${fmt(unknown.reduce((a, w) => a + w.n.hplt, 0))} tokens, tekstaro ${fmt(unknown.reduce((a, w) => a + w.n.tekstaro, 0))})\n`);
  const unknownRows = (s: SourceName, n: number) => table(["#", "lemma", "hplt", "tekstaro", "forms h/t"], [...unknown].sort((a, b) => b.n[s] - a.n[s]).slice(0, n).map((w, i) => [i + 1, w.lemma, fmt(w.n.hplt), fmt(w.n.tekstaro), `${w.forms.hplt}/${w.forms.tekstaro}`]));
  out.push(unknownRows("hplt", 120));
  out.push("\n### Unknown, top 60 by Tekstaro\n");
  out.push(unknownRows("tekstaro", 60));
  const infl = words.filter((w) => w.verdict === "inflection");
  out.push(`\n### Inflection verdicts, top 40 by hplt (${fmt(infl.length)} lemmas: the lemma is not a headword as written, but lemmaCandidates reaches one — class changes like rapide → rapida, participles, plural headwords)\n`);
  out.push(table(["#", "lemma", "headword", "split", "hplt", "tekstaro"], [...infl].sort((a, b) => b.n.hplt - a.n.hplt).slice(0, 40).map((w, i) => [i + 1, w.lemma, w.headword, w.seg, fmt(w.n.hplt), fmt(w.n.tekstaro)])));

  // ---- ReVo words never seen
  h("ReVo headwords never seen");
  // a headword that is itself an inflected form (fervojoj, dorsen) is filed under its dictionary form by lemmaOf and can only score 0 here
  const heads = words.filter((w) => w.verdict === "headword" && lemmaOf(w.lemma) === w.lemma);
  const inflectedHeads = words.filter((w) => w.verdict === "headword" && lemmaOf(w.lemma) !== w.lemma).length;
  const never = heads.filter((w) => w.n.hplt + w.n.tekstaro === 0);
  const absent = (s: SourceName) => heads.filter((w) => w.n[s] === 0).length;
  out.push(`Of the ${fmt(heads.length)} single-word headwords ReVo lists, ${fmt(never.length)} occur in neither corpus (${fmt(absent("hplt"))} are absent from the web, ${fmt(absent("tekstaro"))} from Tekstaro). A word never written in 434M tokens is rare by any measure; the list is where rare taxa, chemistry and archaisms end up, but also where a lemmatisation mismatch would show, so it is worth reading. Not counted at all: headwords of more than one word (${fmt(multiword)} in ReVo, e.g. *arda maro*). A headword listed in an inflected form (${fmt(inflectedHeads)}: plural taxa such as *fervojoj*, adverbs in *-en*) is filed under its dictionary form by \`lemmaOf\` and is left out here.\n`);
  const every = Math.max(1, Math.floor(never.length / 200));
  out.push(`One in ${every}, alphabetically:\n`);
  out.push([...never].sort((a, b) => a.lemma.localeCompare(b.lemma, "eo")).filter((_, i) => i % every === 0).map((w) => w.lemma).join(", "));
  const rareTek = heads.filter((w) => w.n.tekstaro === 0 && w.n.hplt > 0).sort((a, b) => b.n.hplt - a.n.hplt).slice(0, 40);
  out.push(`\nHeadwords Tekstaro lacks that the web uses most (${fmt(absent("tekstaro") - never.length)} such): ${rareTek.map((w) => `${w.lemma} (${fmt(w.n.hplt)})`).join(", ")}`);
  const rareWeb = heads.filter((w) => w.n.hplt === 0 && w.n.tekstaro > 0).sort((a, b) => b.n.tekstaro - a.n.tekstaro).slice(0, 40);
  out.push(`\nHeadwords the web lacks that Tekstaro uses most (${fmt(absent("hplt") - never.length)} such): ${rareWeb.map((w) => `${w.lemma} (${fmt(w.n.tekstaro)})`).join(", ")}`);

  // ---- cross-checks
  h("Cross-checks against published lists");
  if (existsSync(VANEGE)) {
    const theirs = readFileSync(VANEGE, "utf8").split("\n").map((l) => l.trim()).filter(Boolean);
    const ours = lemmaTotals.tekstaro.ranked;
    const ourRank = new Map(ours.map((l, i) => [l, i + 1]));
    for (const n of [1000, 5000, 15000]) {
      const t = theirs.slice(0, n), o = new Set(ours.slice(0, n));
      const shared = t.filter((l) => o.has(l)).length;
      const sp = spearman(t, ours.slice(0, n));
      out.push(`- Vanege's Tekstaro-2023 lemma list (CC BY-SA 4.0), top ${fmt(n)} vs our Tekstaro top ${fmt(n)}: ${fmt(shared)} shared (${pct(shared, n)}), Spearman ρ over the shared ${sp.rho.toFixed(3)}.`);
    }
    const missing = theirs.slice(0, 1000).filter((l) => !ourRank.has(l) || ourRank.get(l)! > 2000);
    out.push(`- In their top 1,000 but past rank 2,000 in ours (${missing.length}): ${missing.slice(0, 40).map((l) => `${l}${ourRank.has(l) ? ` (${ourRank.get(l)})` : " (absent)"}`).join(", ")}`);
    const theirSet = new Set(theirs);
    const oursMissing = ours.slice(0, 1000).filter((l) => !theirSet.has(l));
    out.push(`- In our top 1,000 but absent from their 15,000 (${oursMissing.length}): ${oursMissing.slice(0, 40).join(", ")}`);
  } else out.push(`- Vanege list not found at ${VANEGE}.`);
  if (existsSync(REMUSH)) {
    const theirs: { m: string; n: number }[] = [];
    for await (const [m, , n] of tsvRows(REMUSH)) if (m && n) theirs.push({ m: m.trim(), n: Number(n) });
    const ourMorphs = new Map(morphs.filter((m) => m.kind === "R" || m.kind === "W").map((m) => [m.morph, m]));
    const theirRoots = theirs.filter((t) => ourMorphs.has(t.m)).sort((a, b) => b.n - a.n).map((t) => t.m);
    const oursT = rank("tekstaro", "RW").map((m) => m.morph), oursH = rank("hplt", "RW").map((m) => m.morph);
    for (const n of [500, 1000, 3000]) {
      const t = theirRoots.slice(0, n);
      const sT = spearman(t, oursT.slice(0, n)), sH = spearman(t, oursH.slice(0, n));
      out.push(`- remush.be's morpheme counts (Monato and other texts; only the ${fmt(theirRoots.length)} morphemes that are roots or endingless words in our inventory), top ${fmt(n)}: shared with our Tekstaro top ${fmt(n)} ${fmt(sT.shared)} (ρ ${sT.rho.toFixed(3)}), with our hplt top ${fmt(n)} ${fmt(sH.shared)} (ρ ${sH.rho.toFixed(3)}).`);
    }
    const theirCov = coverage(theirs.filter((t) => ourMorphs.has(t.m)).map((t) => t.n).sort((a, b) => b - a));
    out.push(`- Their coverage over those morphemes: ${Object.entries(theirCov).map(([k, v]) => `${k} → ${fmt(v)}`).join(", ")} (see the coverage table above for ours).`);
  } else out.push(`- remush list not found at ${REMUSH}.`);

  // ---- thresholds
  h("Size of a reduced counts file at candidate thresholds");
  out.push("Rows `lemma\\thplt\\ttekstaro`, plain and gzipped. `ReVo` = lemmas with a headword/inflection/attested verdict; `others` = derived and unknown lemmas above the threshold in either source.\n");
  const revo = words.filter((w) => ["headword", "inflection", "attested"].includes(w.verdict));
  const others = words.filter((w) => !["headword", "inflection", "attested"].includes(w.verdict));
  const sizeRows: (string | number)[][] = [];
  const size = (label: string, ws: Word[]) => {
    const text = ws.map((w) => `${w.lemma}\t${w.n.hplt}\t${w.n.tekstaro}\n`).join("");
    const bytes = Buffer.byteLength(text);
    sizeRows.push([label, fmt(ws.length), fmt(bytes), fmt(gzipSync(Buffer.from(text)).length)]);
  };
  size("ReVo lemmas only", revo);
  for (const [h, t] of [[20, 3], [50, 5], [100, 10], [200, 20]] as const) size(`ReVo + others at hplt ≥ ${h} or tekstaro ≥ ${t}`, [...revo, ...others.filter((w) => w.n.hplt >= h || w.n.tekstaro >= t)]);
  size("everything classified (≥ 2 in either)", words);
  out.push(table(["file", "rows", "bytes", "gzipped"], sizeRows));

  writeFileSync(REPORT_FILE, out.join("\n") + "\n");
  console.log(`${REPORT_FILE}: ${fmt(Buffer.byteLength(out.join("\n")))} bytes`);
}

if (isMain(import.meta.url)) await main();
