/**
 * Segmenter accuracy, measured on the corpus's own root marks: every word
 * written with a <tld/> in a headword or an example says where its root sits
 * (scripts/segment-cases.ts). The free segmenter (no pin) is run on each such
 * word and counted right when it puts a root morpheme exactly on the marked
 * span.
 *
 * The report part is the honest number: its words' derivational relatives
 * are neither in the pair evidence nor in the tune part the learned weights
 * were fitted on (scripts/train-segment.ts).
 *
 *   bun run scripts/eval-segment.ts [--db data/voko.db] [--show 20]
 */
import { Database } from "bun:sqlite";
import { segment, formatSegments, type Morph } from "../src/morph";
import { segmentCases, type Case } from "./segment-cases";

const args = process.argv.slice(2);
const opt = (name: string, dflt: string) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : dflt;
};
const db = new Database(opt("--db", "data/voko.db"), { readonly: true });
const show = Number(opt("--show", "20"));
const { inv, all, pairs } = segmentCases(db);

// ---- scoring ---------------------------------------------------------------

type Verdict = "right" | "no split" | "swallowed" | "cut up" | "shifted";
function judge(ms: Morph[] | null, c: Case): Verdict {
  if (!ms) return "no split";
  let off = 0;
  const spans = ms.map((m) => ({ ...m, a: off, b: (off += m.m.length) }));
  if (spans.some((s) => (s.k === "R" || s.k === "W") && s.a === c.at && s.m === c.root)) return "right";
  const a = c.at, b = c.at + c.root.length;
  const over = spans.filter((s) => s.a < b && s.b > a);
  if (over.length === 1 && over[0].a <= a && over[0].b >= b) return "swallowed"; // a longer piece covers the root
  if (over.every((s) => s.a >= a && s.b <= b)) return "cut up"; // the root is in pieces
  return "shifted";
}

const verdicts = new Map<Case, Verdict>();
for (const c of all) verdicts.set(c, judge(segment(c.word, inv), c));

const pct = (n: number, d: number) => `${((100 * n) / d).toFixed(2)} %`;
function table(label: string, set: Case[]) {
  const n: Record<Verdict, number> = { right: 0, "no split": 0, swallowed: 0, "cut up": 0, shifted: 0 };
  for (const c of set) n[verdicts.get(c)!]++;
  console.log(`\n${label}: ${set.length} cases, root placed right in ${pct(n.right, set.length)}`);
  for (const k of ["shifted", "swallowed", "cut up", "no split"] as const) {
    if (n[k]) console.log(`  ${k.padEnd(10)} ${String(n[k]).padStart(6)}  ${pct(n[k], set.length)}`);
  }
}
table("headwords", all.filter((c) => c.owner === "kap"));
table("marked words in examples", all.filter((c) => c.owner === "ekz"));
table("all", all);
table(`report part (no relative among the ${pairs.counts.size} evidence pairs)`, all.filter((c) => c.part === "report"));

const misses = all.filter((c) => c.part === "report" && verdicts.get(c) !== "right");
const step = show > 0 ? Math.max(1, Math.floor(misses.length / show)) : 0;
console.log(`\nreport-part misses: ${misses.length}${step ? `, every ${step}th:` : ""}`);
for (let i = 0; step && i < misses.length && i / step < show; i += step) {
  const c = misses[i];
  const free = segment(c.word, inv);
  const pinned = segment(c.word, inv, { at: c.at, root: c.root });
  console.log(
    `  ${c.word.padEnd(22)} [${c.root}]  ${verdicts.get(c)!.padEnd(10)} got ${(free ? formatSegments(free).seg : "-").padEnd(24)} pinned ${pinned ? formatSegments(pinned).seg : "-"}`
  );
}
