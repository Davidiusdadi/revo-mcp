/**
 * Words used often that ReVo has no entry for: data/freq/candidates.tsv, the
 * input of scripts/freq/evidence.ts.
 *
 * From data/freq/words.tsv take the lemmas the gloss tool calls `derived`
 * (built from known morphemes, no article) or `unknown` (no reading at all:
 * new roots, names, foreign words, abbreviations) that the web uses at least
 * HPLT_MIN times and Tekstaro at least TEKSTARO_MIN times. Needing both keeps
 * out words only one site or one book uses. Lemmas already decided in
 * corpus/freq/vetted.tsv are left out, so a rejected word does not come back.
 *
 * Columns: lemma, verdict, seg, kinds, combo (a derived word of two roots or
 * more: whether ReVo has that combination anywhere), articles (the article of
 * the last root, where ReVo files a derivation; several for homonyms), hplt,
 * tekstaro, pm (per million, both corpora added), suffix (the last suffix).
 *
 *   tsx scripts/freq/candidates.ts
 */
import { Database } from "../../src/runtime/node-database";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { tsvRows } from "./lemmatise";
import { DB, FREQ, isMain, ROOT, TOTALS_FILE, WORDS_FILE, type SourceName } from "./paths";

const HPLT_MIN = 1000;
const TEKSTARO_MIN = 10;
export const CANDIDATES_FILE = join(FREQ, "candidates.tsv");
export const VETTED_FILE = join(ROOT, "corpus", "freq", "vetted.tsv");

export interface Candidate {
  lemma: string; verdict: string; seg: string; kinds: string; combo: string; articles: string[];
  hplt: number; tekstaro: number; pm: number; suffix: string;
}

/** The lemmas corpus/freq/vetted.tsv already has a decision for. */
export function vetted(): Map<string, { decision: string; note: string }> {
  const out = new Map<string, { decision: string; note: string }>();
  if (!existsSync(VETTED_FILE)) return out;
  for (const line of readFileSync(VETTED_FILE, "utf8").split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const [lemma, decision, note = ""] = line.split("\t");
    out.set(lemma, { decision, note });
  }
  return out;
}

export function readCandidates(): Candidate[] {
  return readFileSync(CANDIDATES_FILE, "utf8").split("\n").slice(1).filter(Boolean).map((l) => {
    const [lemma, verdict, seg, kinds, combo, articles, hplt, tekstaro, pm, suffix] = l.split("\t");
    return { lemma, verdict, seg, kinds, combo, articles: articles ? articles.split(",") : [], hplt: +hplt, tekstaro: +tekstaro, pm: +pm, suffix };
  });
}

async function main() {
  const totals = JSON.parse(readFileSync(TOTALS_FILE, "utf8")) as Record<SourceName, { esperanto: number }>;
  const db = new Database(DB, { readonly: true });
  const articlesOf = db.query<{ file: string }, [string]>(
    "SELECT DISTINCT a.file FROM x_morpheme m JOIN article a ON a.id = m.article_id WHERE m.kind = 'R' AND m.morph = ? ORDER BY a.file");
  const decided = vetted();
  const out: Candidate[] = [];
  let skipped = 0;
  for await (const r of tsvRows(WORDS_FILE)) {
    const [lemma, verdict, , , seg, kinds, , combo] = r;
    if (verdict !== "derived" && verdict !== "unknown") continue;
    const hplt = Number(r[8]), tekstaro = Number(r[9]);
    if (hplt < HPLT_MIN || tekstaro < TEKSTARO_MIN) continue;
    if (decided.has(lemma)) { skipped++; continue; }
    const ms = seg ? seg.split("|") : [];
    const last = (k: string) => { for (let i = ms.length - 1; i >= 0; i--) if (kinds[i] === k) return ms[i]; return ""; };
    const root = last("R");
    out.push({
      lemma, verdict, seg, kinds, combo, articles: root ? articlesOf.all(root).map((a) => a.file) : [],
      hplt, tekstaro, pm: (1e6 * hplt) / totals.hplt.esperanto + (1e6 * tekstaro) / totals.tekstaro.esperanto, suffix: last("S"),
    });
  }
  out.sort((a, b) => b.pm - a.pm);
  writeFileSync(CANDIDATES_FILE, ["lemma\tverdict\tseg\tkinds\tcombo\tarticles\thplt\ttekstaro\tpm\tsuffix",
    ...out.map((c) => [c.lemma, c.verdict, c.seg, c.kinds, c.combo, c.articles.join(","), c.hplt, c.tekstaro, c.pm.toFixed(2), c.suffix].join("\t"))].join("\n") + "\n");
  const by = (v: string) => out.filter((c) => c.verdict === v).length;
  console.log(`${CANDIDATES_FILE}: ${out.length} candidates (derived ${by("derived")}, unknown ${by("unknown")}), ${skipped} already vetted`);
}

if (isMain(import.meta.url)) await main();
