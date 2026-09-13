/**
 * Segmenter accuracy, measured on the corpus's own root marks: every word
 * written with a <tld/> in a headword or an example (x_tld_occ, owner kap or
 * ekz) says where its root sits. The free segmenter (no pin) is run on each
 * such word and counted right when it puts a root morpheme exactly on the
 * marked span. Words in affix and ending articles are left out (there the
 * tilde stands for the affix), as is the bare root itself.
 *
 * The cases are split by derivation stem (montaro and montaroj land together)
 * into three parts by a stable hash: evidence, tune and report. Weights are
 * tuned on the tune part and anything the segmenter learns from the corpus is
 * taken from the evidence part, so the report score is for words the
 * segmenter has never seen a relative of.
 *
 *   bun run scripts/eval-segment.ts [--db data/voko.db] [--show 20]
 */
import { Database } from "bun:sqlite";
import { segment, formatSegments, ENDINGS, type Inventory, type Morph } from "../src/morph";
import { Pairs } from "../src/corpus/passes/morph";

const args = process.argv.slice(2);
const opt = (name: string, dflt: string) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : dflt;
};
const db = new Database(opt("--db", "data/voko.db"), { readonly: true });
const show = Number(opt("--show", "20"));

const rootWeight = new Map<string, number>();
const inv: Inventory = { roots: new Set(), prefixes: new Set(), suffixes: new Set(), words: new Set(), rootWeight };
for (const r of db.query<{ morph: string; kind: string; drv: number }, []>(
  "SELECT morph, kind, SUM(drv) drv FROM x_morpheme GROUP BY morph, kind").iterate()) {
  const set = { R: inv.roots, P: inv.prefixes, S: inv.suffixes, W: inv.words }[r.kind] as Set<string> | undefined;
  set?.add(r.morph);
  if (r.kind === "R") rootWeight.set(r.morph, r.drv);
}
const affixy = (rad: string) => inv.prefixes.has(rad) || inv.suffixes.has(rad) || ENDINGS.has(rad) || rad === "j" || rad === "n";

// ---- gold ------------------------------------------------------------------

export type Part = "evidence" | "tune" | "report";
interface Case {
  word: string;
  at: number;
  root: string;
  owner: "kap" | "ekz";
  part: Part;
}
const ENDING = /(ojn|oj|on|ajn|aj|an|en|as|is|os|us|[oaieu])$/;
export const partOf = (word: string): Part => {
  const stem = word.replace(ENDING, "");
  return (["evidence", "tune", "report"] as const)[Number(Bun.hash(stem) % 3n)];
};

const cases = new Map<string, Case>();
for (const o of db.query<{ owner_kind: "kap" | "ekz"; pre: string; rad: string; norm: string }, []>(
  // kap first, so a word that is both a headword and an example form counts as a headword
  "SELECT owner_kind, pre, rad, norm FROM x_tld_occ WHERE owner_kind IN ('kap','ekz') ORDER BY owner_kind DESC, id").iterate()) {
  const root = o.rad.toLowerCase();
  if (!root || o.norm === root || !/^\p{L}+$/u.test(o.norm) || affixy(root)) continue;
  const at = o.pre.length;
  if (o.norm.slice(at, at + root.length) !== root) continue; // pre and rad from a lit-capitalised occurrence can disagree
  const key = `${o.norm}@${at}`;
  if (!cases.has(key)) cases.set(key, { word: o.norm, at, root, owner: o.owner_kind, part: partOf(o.norm) });
}
const all = [...cases.values()];

// pair evidence, as the build derives it, but from the evidence part only
const pairs = new Pairs();
for (const c of all) {
  if (c.part !== "evidence") continue;
  const ms = segment(c.word, inv, { at: c.at, root: c.root });
  if (ms) pairs.add(ms, c.at);
}
inv.pairs = pairs.counts;

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
