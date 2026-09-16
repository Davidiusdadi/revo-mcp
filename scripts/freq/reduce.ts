/**
 * The counts file the build reads: corpus/freq/counts.tsv.
 *
 * From data/freq/words.tsv keep every lemma ReVo lists (headword, inflection
 * or attested verdict — zero counts included, so a word never seen stays
 * visible as such) and every other lemma used at least HPLT_MIN times on the
 * web or TEKSTARO_MIN times in Tekstaro. A headword that is itself an
 * inflected form (a plural taxon, *fervojoj*) is left out: `lemmaOf` files
 * every occurrence under the singular, so its own row could only ever be 0. Rows are sorted by lemma so a
 * regeneration diffs cleanly. The header records where the counts came from
 * (URL, hash, date, licence, tokens counted) so the numbers can be traced and
 * reproduced; src/corpus/passes/freq.ts parses it.
 *
 *   bun run scripts/freq/reduce.ts [--out FILE]
 */
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { COUNTS_FILE, FREQ, SOURCE_NAMES, SOURCES_FILE, TOTALS_FILE, WORDS_FILE, type SourceName, type SourceRecord } from "./paths";
import { tsvRows } from "./lemmatise";
import { lemmaOf } from "../../src/morph";

const HPLT_MIN = 50;
const TEKSTARO_MIN = 5;
const REVO = new Set(["headword", "inflection", "attested"]);

const args = process.argv.slice(2);
const out = args.includes("--out") ? args[args.indexOf("--out") + 1] : COUNTS_FILE;

const sources = JSON.parse(readFileSync(SOURCES_FILE, "utf8")) as Record<SourceName, SourceRecord>;
const totals = JSON.parse(readFileSync(TOTALS_FILE, "utf8")) as Record<SourceName, { documents: number; esperanto: number }>;
const edition: Partial<Record<SourceName, string>> = {
  tekstaro: /<edition>([^<]*?)\.?<\/edition>/.exec(
    readFileSync(join(FREQ, "sources", "tekstaro", "xml", "tekstaro_de_esperanto_xml_kun_streketoj", "tekstaro.xml"), "utf8"))?.[1],
};

const q = (s: string) => `"${s.replace(/"/g, "'")}"`;
const header = [
  `# Usage counts of Esperanto lemmas, generated ${new Date().toISOString().slice(0, 10)} by scripts/freq/reduce.ts; see corpus/freq/README.md`,
  ...SOURCE_NAMES.map((s) => {
    const f = sources[s].files[0];
    const kv = [
      `tokens=${totals[s].esperanto}`, `documents=${totals[s].documents}`, `licence=${q(sources[s].licence)}`,
      `url=${f.url}`, `sha256=${f.sha256}`, `bytes=${f.bytes}`, `fetched=${f.fetched}`,
    ];
    if (edition[s]) kv.push(`edition=${q(edition[s]!)}`);
    return `# source ${s}: ${kv.join(" ")}`;
  }),
  `# rows: every lemma ReVo lists (zero counts kept) and every other lemma with hplt >= ${HPLT_MIN} or tekstaro >= ${TEKSTARO_MIN}`,
  `# lemma\thplt\ttekstaro`,
];

const rows: [string, number, number][] = [];
let revo = 0, zero = 0;
for await (const r of tsvRows(WORDS_FILE)) {
  const [lemma, verdict] = r;
  if (lemma === "lemma") continue; // header
  const hplt = Number(r[8]), tekstaro = Number(r[9]);
  const listed = REVO.has(verdict);
  if (!listed && hplt < HPLT_MIN && tekstaro < TEKSTARO_MIN) continue;
  if (listed && lemmaOf(lemma) !== lemma) continue; // counted under its dictionary form
  if (listed) revo++;
  if (hplt + tekstaro === 0) zero++;
  rows.push([lemma, hplt, tekstaro]);
}
rows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, header.join("\n") + "\n" + rows.map((r) => r.join("\t")).join("\n") + "\n");
console.log(`${out}: ${rows.length} lemmas (${revo} ReVo lists, ${zero} never seen), ${(Bun.file(out).size / 1e6).toFixed(1)} MB`);
