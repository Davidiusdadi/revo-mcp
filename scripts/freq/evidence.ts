/**
 * Evidence for the candidate words (data/freq/candidates.tsv), so each can be
 * judged by reading: is it a real, established Esperanto word, or a name, a
 * foreign word, one site's invention, machine-translation debris?
 *
 * One pass over both corpora, reading text exactly as the counts did
 * (`words` in count-forms.ts), collects per candidate:
 * - web: documents, distinct sites and the largest ones with their share, how
 *   often the word is capitalised where a sentence does not start (names), and
 *   example sentences from different sites;
 * - Tekstaro: texts, the years they span, and example sentences from
 *   different texts with what a ReVo citation needs: the text's id, the
 *   section and paragraph ids tekstaro.com links to, title and year.
 *
 * Output (local): data/freq/candidates.evidence.json, the full record, and
 * data/freq/candidates.md, one line per word to read top to bottom, grouped
 * by the article a derived word would go into; unknown words (new roots or not
 * words at all) follow, then the ones that look like names or one site's.
 *
 *   bun run scripts/freq/evidence.ts [--only tekstaro]
 */
import { readdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { lemmaOf } from "../../src/morph";
import { HPLT_FILE, TEKSTARO_DIR, lines, tekstaroText, words } from "./count-forms";
import { readCandidates, type Candidate } from "./candidates";
import { tsvRows } from "./lemmatise";
import { FREQ, formsFile, SOURCE_NAMES } from "./paths";

const EVIDENCE_FILE = join(FREQ, "candidates.evidence.json");
const REPORT_FILE = join(FREQ, "candidates.md");
const SAMPLES = 3;

interface WebSample { text: string; site: string }
interface TekstaroSample { text: string; nomo: string; sekcio: string; id: string; title: string; year: string }
interface Evidence {
  web: { n: number; docs: number; sites: Record<string, number>; inner: number; innerCapital: number; samples: WebSample[] };
  tekstaro: { n: number; texts: Record<string, number>; years: number[]; samples: TekstaroSample[] };
}

const tally = () => ({ tokens: 0, numeric: 0, xsystem: 0, foreign: 0, esperanto: 0 });

/** The sentence of `text` around offset `at`, if it reads as one: capital start, closing stop, a sensible length, no markup. */
function sentenceAt(text: string, at: number): string | null {
  let start = at, end = at;
  while (start > 0 && !/[.!?…]\s/.test(text.slice(start - 2, start))) start--;
  while (end < text.length && !/[.!?…]/.test(text[end])) end++;
  const s = text.slice(start, end + 1).replace(/\s+/g, " ").trim();
  if (s.length < 40 || s.length > 220) return null;
  if (!/^[„“"«(]?\p{Lu}/u.test(s) || !/[.!?…]$/.test(s)) return null;
  if (/https?:|www\.|[{}<>|@#]|\s{2}/.test(s)) return null;
  return s;
}

/** A word starts no sentence: something other than a stop, a colon, a quote or a dash comes before it. */
const insideSentence = (text: string, at: number) => {
  const before = text.slice(Math.max(0, at - 6), at).trimEnd();
  return before.length > 0 && !/[.!?…:;"„“”«»(\-–—]$/.test(before);
};

async function main() {
  const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : null;
  const candidates = readCandidates();
  const wanted = new Set(candidates.map((c) => c.lemma));
  const ev = new Map<string, Evidence>(candidates.map((c) => [c.lemma, {
    web: { n: 0, docs: 0, sites: {}, inner: 0, innerCapital: 0, samples: [] },
    tekstaro: { n: 0, texts: {}, years: [], samples: [] },
  }]));

  // every counted form of a candidate, so a token is matched without lemmatising it
  const lemmaOfForm = new Map<string, string>();
  for (const s of SOURCE_NAMES) for await (const [form] of tsvRows(formsFile(s))) {
    if (!form || lemmaOfForm.has(form)) continue;
    const l = lemmaOf(form);
    if (wanted.has(l)) lemmaOfForm.set(form, l);
  }
  console.log(`${candidates.length} candidates, ${lemmaOfForm.size} forms`);

  // ---- Tekstaro
  for (const f of readdirSync(TEKSTARO_DIR).filter((f) => f.endsWith(".xml")).sort()) {
    const xml = await Bun.file(join(TEKSTARO_DIR, f)).text();
    const head = xml.slice(0, Math.max(0, xml.search(/<text[\s>]/)));
    const nomo = /<TEI[^>]*xml:id="([^"]*)"/.exec(xml)?.[1] ?? f.replace(/\.xml$/, "");
    const title = /<title type="main">([^<]*)<\/title>/.exec(head)?.[1] ?? /<title>([^<]*)<\/title>/.exec(head)?.[1] ?? nomo;
    const year = /<date>([^<]*)<\/date>/.exec(head)?.[1] ?? "";
    const years = [...year.matchAll(/\d{4}/g)].map((m) => Number(m[0]));
    let sekcio = "";
    const body = xml.slice(xml.search(/<text[\s>]/));
    for (const m of body.matchAll(/<div\b[^>]*\bxml:id="([^"]*)"|<p\b([^>]*)>([\s\S]*?)<\/p>/g)) {
      if (m[1] !== undefined) { sekcio = m[1]; continue; }
      const attrs = m[2], id = /xml:id="([^"]*)"/.exec(attrs)?.[1];
      const lang = /xml:lang="([^"]*)"/.exec(attrs)?.[1];
      if (lang && lang !== "eo") continue;
      const text = tekstaroText(`<text>${m[3]}</text>`).replace(/\s+/g, " ").trim();
      for (const w of words(text, tally())) {
        const lemma = lemmaOfForm.get(w.w);
        if (!lemma) continue;
        const e = ev.get(lemma)!.tekstaro;
        e.n++;
        e.texts[nomo] = (e.texts[nomo] ?? 0) + 1;
        for (const y of years) { if (!e.years.length) e.years = [y, y]; e.years = [Math.min(e.years[0], y), Math.max(e.years[1], y)]; }
        if (id && e.samples.length < SAMPLES && !e.samples.some((s) => s.nomo === nomo)) {
          const s = sentenceAt(text, w.at);
          if (s) e.samples.push({ text: s, nomo, sekcio, id, title, year });
        }
      }
    }
  }
  console.log("tekstaro done");

  // ---- web
  if (only !== "tekstaro") {
    const proc = Bun.spawn(["zstd", "-dc", HPLT_FILE], { stdout: "pipe", stderr: "inherit" });
    let docs = 0;
    for await (const line of lines(proc.stdout)) {
      if (!line) continue;
      const doc = JSON.parse(line) as { text: string; seg_langs?: string[]; u?: string };
      const site = (/^[a-z]+:\/\/([^/:]+)/i.exec(doc.u ?? "")?.[1] ?? "?").toLowerCase().replace(/^www\./, "");
      const seen = new Set<string>();
      const segs = doc.text.split("\n");
      for (let i = 0; i < segs.length; i++) {
        if (doc.seg_langs && doc.seg_langs[i] !== "epo_Latn") continue;
        const text = segs[i];
        for (const w of words(text, tally())) {
          const lemma = lemmaOfForm.get(w.w);
          if (!lemma) continue;
          const e = ev.get(lemma)!.web;
          e.n++;
          if (!seen.has(lemma)) { seen.add(lemma); e.docs++; e.sites[site] = (e.sites[site] ?? 0) + 1; }
          if (insideSentence(text, w.at)) { e.inner++; if (w.capital) e.innerCapital++; }
          if (e.samples.length < SAMPLES && !e.samples.some((s) => s.site === site)) {
            const s = sentenceAt(text, w.at);
            if (s) e.samples.push({ text: s, site });
          }
        }
      }
      if (++docs % 100000 === 0) console.log(`  ${docs} documents`);
    }
    if ((await proc.exited) !== 0) throw new Error(`zstd exited with ${proc.exitCode}`);
  }

  writeFileSync(EVIDENCE_FILE, JSON.stringify(Object.fromEntries(candidates.map((c) => [c.lemma, { ...c, ...ev.get(c.lemma)! }]))));
  writeFileSync(REPORT_FILE, report(candidates, ev));
  console.log(`${EVIDENCE_FILE}\n${REPORT_FILE}`);
}

const fmt = (n: number) => n.toLocaleString("en-US");

/** What makes a word doubtful, in words; empty when nothing does. */
function flags(c: Candidate, e: Evidence): string[] {
  const out: string[] = [];
  const sites = Object.entries(e.web.sites).sort((a, b) => b[1] - a[1]);
  if (e.web.inner >= 20 && e.web.innerCapital / e.web.inner >= 0.5) out.push(`capitalised ${Math.round((100 * e.web.innerCapital) / e.web.inner)}%: a name?`);
  if (sites.length < 10) out.push(`only ${sites.length} sites`);
  else if (e.web.docs && sites[0][1] / e.web.docs >= 0.5) out.push(`${Math.round((100 * sites[0][1]) / e.web.docs)}% from ${sites[0][0]}`);
  if (Object.keys(e.tekstaro.texts).length < 3) out.push(`${Object.keys(e.tekstaro.texts).length} Tekstaro texts`);
  if (c.lemma.length <= 3 || c.lemma.includes("-")) out.push("abbreviation?");
  return out;
}

function line(c: Candidate, e: Evidence): string {
  const sites = Object.entries(e.web.sites).sort((a, b) => b[1] - a[1]);
  const texts = Object.keys(e.tekstaro.texts).length;
  const years = e.tekstaro.years.length ? ` ${e.tekstaro.years[0]}–${e.tekstaro.years[1]}` : "";
  const top = sites.slice(0, 2).map(([s, n]) => `${s} ${Math.round((100 * n) / Math.max(1, e.web.docs))}%`).join(", ");
  const f = flags(c, e);
  const out = [
    `- **${c.lemma}**${c.seg ? ` \`${c.seg}\`` : ""}${c.combo === "new" ? " (roots never combined in ReVo)" : ""} · ${c.pm.toFixed(1)}/M` +
      ` · web ${fmt(c.hplt)} in ${fmt(e.web.docs)} docs on ${fmt(sites.length)} sites (${top})` +
      ` · Tekstaro ${fmt(c.tekstaro)} in ${texts} texts${years}${f.length ? ` · ⚠ ${f.join("; ")}` : ""}`,
  ];
  const t = e.tekstaro.samples[0], w = e.web.samples[0];
  if (t) out.push(`  - T: ${t.text} (${t.title}, ${t.year})`);
  if (w) out.push(`  - W: ${w.text} (${w.site})`);
  return out.join("\n");
}

function report(candidates: Candidate[], ev: Map<string, Evidence>): string {
  const doubtful = (c: Candidate) => flags(c, ev.get(c.lemma)!).some((f) => /name\?|only \d+ sites|abbreviation\?/.test(f));
  const out: string[] = [
    "# Candidate words ReVo has no entry for",
    "",
    "Words used at least 1,000 times on the web and 10 times in Tekstaro that ReVo neither lists nor attests.",
    "*Derived* words are built from morphemes ReVo has, so the split says what they mean; they are grouped by the article of their last root.",
    "*Unknown* words have no reading: possible new roots, or not words at all.",
    "Rate per million is both corpora added. ⚠ marks what makes a word doubtful. T: a Tekstaro sentence, W: a web sentence.",
    "Decisions go into corpus/freq/vetted.tsv (lemma, aldoni / ne / poste, note).",
  ];
  const derived = candidates.filter((c) => c.verdict === "derived" && !doubtful(c));
  const groups = new Map<string, Candidate[]>();
  for (const c of derived) {
    const k = c.articles.join(", ") || "(no article)";
    groups.set(k, [...(groups.get(k) ?? []), c]);
  }
  out.push("", `## Derived words (${fmt(derived.length)}), by article`);
  for (const [article, cs] of [...groups].sort((a, b) => b[1][0].pm - a[1][0].pm)) {
    out.push("", `### ${article}.xml`, "", ...cs.map((c) => line(c, ev.get(c.lemma)!)));
  }
  const unknown = candidates.filter((c) => c.verdict === "unknown" && !doubtful(c));
  out.push("", `## Unknown words (${fmt(unknown.length)}): new roots, or not Esperanto`, "", ...unknown.map((c) => line(c, ev.get(c.lemma)!)));
  const rest = candidates.filter(doubtful);
  out.push("", `## Probably names, abbreviations or one site's words (${fmt(rest.length)})`, "",
    ...rest.map((c) => `- ${c.lemma} (${c.verdict}, ${c.pm.toFixed(1)}/M): ${flags(c, ev.get(c.lemma)!).join("; ")}`));
  return out.join("\n") + "\n";
}

if (import.meta.main) await main();
