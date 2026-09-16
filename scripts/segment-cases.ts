/**
 * The words the segmenter is measured and trained on, shared by
 * scripts/eval-segment.ts and scripts/train-segment.ts so both see the same
 * parts.
 *
 * Every word written with a <tld/> in a headword or an example (x_tld_occ,
 * owner kap or ekz) says where its root sits. Words in affix and ending
 * articles are left out (there the tilde stands for the affix), as is the bare
 * root itself.
 *
 * The cases are split by derivation stem (montaro and montaroj land together)
 * into three parts by a stable hash: evidence, tune and report. The pair
 * evidence comes from the evidence part only, the learned weights from the
 * tune part only, so the report part scores words the segmenter has never
 * seen a relative of.
 */
import type { Database } from "bun:sqlite";
import { segment, ENDINGS, type Inventory, type WordClass } from "../src/morph";
import { Pairs } from "../src/corpus/passes/morph";

export type Part = "evidence" | "tune" | "report";
export interface Case {
  word: string;
  at: number;
  root: string;
  owner: "kap" | "ekz";
  part: Part;
}

const ENDING = /(ojn|oj|on|ajn|aj|an|en|as|is|os|us|[oaieu])$/;
const stemOf = (word: string) => word.replace(ENDING, "");
export const partOf = (word: string): Part => (["evidence", "tune", "report"] as const)[Number(Bun.hash(stemOf(word)) % 3n)];
/** A second stable split, into halves by stem, for cross-validation inside one part. */
export const foldOf = (word: string): number => Number(Bun.hash("f" + stemOf(word)) % 2n);

export function segmentCases(db: Database): { inv: Inventory; all: Case[]; pairs: Pairs } {
  const rootWeight = new Map<string, number>();
  const classes = new Map<string, WordClass>();
  const inv: Inventory = { roots: new Set(), prefixes: new Set(), suffixes: new Set(), words: new Set(), rootWeight, classes };
  for (const r of db.query<{ morph: string; kind: string; drv: number; o: number; a: number; e: number; i: number }, []>(
    `SELECT morph, kind, SUM(drv) drv, SUM(o) o, SUM(a) a, SUM(e) e, SUM(i) i FROM x_morpheme GROUP BY morph, kind`).iterate()) {
    const set = { R: inv.roots, P: inv.prefixes, S: inv.suffixes, W: inv.words }[r.kind] as Set<string> | undefined;
    set?.add(r.morph);
    if (r.kind !== "R") continue;
    rootWeight.set(r.morph, r.drv);
    classes.set(r.morph, { o: r.o, a: r.a, e: r.e, i: r.i });
  }
  const affixy = (rad: string) => inv.prefixes.has(rad) || inv.suffixes.has(rad) || ENDINGS.has(rad) || rad === "j" || rad === "n";

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

  // pair evidence, as the build derives it (first pass, no pairs yet), but from the evidence part only
  const pairs = new Pairs();
  for (const c of all) {
    if (c.part !== "evidence") continue;
    const ms = segment(c.word, inv, { at: c.at, root: c.root });
    if (ms) pairs.add(ms, c.at);
  }
  inv.pairs = pairs.counts;
  return { inv, all, pairs };
}
