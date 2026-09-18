/**
 * Esperanto morphology over a lexicon: inflection analysis and segmentation.
 * Pure functions, no database.
 *
 * - `lemmaCandidates` lists the dictionary forms a word can be an inflection
 *   of. The ending decides, so "belan" looks for "bela" before "belo" — unlike
 *   stemmer.ts's `generateStems`, which tries every shorter string.
 * - `lemmaOf` picks the one dictionary form a frequency count files a word
 *   under: the inflection removed, nothing else.
 * - `segment` splits a word into prefixes, roots, suffixes and ending, using a
 *   morpheme inventory (the `morph` pass builds it from the corpus: article
 *   roots, affix articles, endingless words). A known root position (from a
 *   `<tld/>`) can be fixed.
 * - `spellsNumber` and `numberLength` recognise the numeral words that make
 *   one number (tri|dek, du|mil), a closed class like the table words.
 */

import { SEGMENT_WEIGHTS } from "./morph-weights";

export interface Candidate {
  lemma: string;
  /** infl: inflection removed · class: same stem, another word class · ptcp: participle → its verb */
  how: "infl" | "class" | "ptcp";
}

/** Other word classes of the same stem, most likely first (rapide → rapida before rapido). */
const CLASS_ORDER: Record<string, string> = { o: "aie", a: "oie", e: "aoi", i: "oae" };

// the inflections, on a stem of at least two letters
const NOMINAL_INFL = /^(.{2,})([oa])(jn|j|n)$/;
const ADVERB_INFL = /^(.{2,})en$/;
const VERB_INFL = /^(.{2,})(as|is|os|us|u)$/;
/** Pronouns: they take -n (and ili -j-less), and are their own lemma. */
const PRONOUN = /^(mi|vi|li|ŝi|ĝi|ni|ili|oni|si|ci)(n)?$/;
/**
 * Endingless words of closed classes that look inflected (tamen → tame,
 * plu → pli, unu → uni): numerals and particles; they are their own lemma.
 */
const INVARIABLE: ReadonlySet<string> = new Set([
  "unu", "du", "tri", "kvar", "kvin", "ses", "sep", "ok", "naŭ", "dek", "cent", "mil",
  "plu", "plus", "minus", "ĵus", "tamen", "amen", "ambaŭ",
]);

export function lemmaCandidates(word: string): Candidate[] {
  const w = word.toLowerCase();
  const infl: string[] = [];
  const cls: string[] = [];
  const ptcp: string[] = [];
  let stem: string | null = null;
  let vowel = "o";
  let m: RegExpExecArray | null;

  if ((m = NOMINAL_INFL.exec(w))) { infl.push(m[1] + m[2]); [stem, vowel] = [m[1], m[2]]; }
  else if ((m = ADVERB_INFL.exec(w))) { infl.push(m[1] + "e"); [stem, vowel] = [m[1], "e"]; }
  else if ((m = VERB_INFL.exec(w))) { infl.push(m[1] + "i"); [stem, vowel] = [m[1], "i"]; }
  else if ((m = /^(.{2,})([oaie])$/.exec(w))) [stem, vowel] = [m[1], m[2]];
  // pronouns and correlatives: min, kiun, tiujn
  if ((m = /^(.+?)(jn|j|n)$/.exec(w))) infl.push(m[1]);
  // accusative of a plural headword: penatojn → penatoj
  if (/^.{3,}jn$/.test(w)) infl.push(w.slice(0, -1));

  if (stem) {
    for (const v of CLASS_ORDER[vowel]) cls.push(stem + v);
    cls.push(stem); // antaŭe → antaŭ
  }
  // participles: manĝantaj → manĝanta → manĝi
  if ((m = /^(.{2,}?)([aio])(n?)t([oae])$/.exec(infl[0] ?? w))) ptcp.push(m[1] + "i");

  const out: Candidate[] = [];
  const seen = new Set([w]);
  const add = (how: Candidate["how"]) => (lemma: string) => {
    if (seen.has(lemma)) return;
    seen.add(lemma);
    out.push({ lemma, how });
  };
  infl.forEach(add("infl"));
  cls.forEach(add("class"));
  ptcp.forEach(add("ptcp"));
  return out;
}

/**
 * The one dictionary form a word is filed under: malsanulejojn → malsanulejo,
 * parolis → paroli, hejmen → hejme, kiujn → kiu, min → mi. A participle keeps
 * its own form (manĝantaj → manĝanta), an endingless word is left alone
 * (la, tamen, unu, plu), and so is anything without a recognisable ending.
 * Lowercases. Deterministic and lexicon-free, so a count and a lookup agree.
 */
export function lemmaOf(word: string): string {
  const w = word.toLowerCase();
  let m: RegExpExecArray | null;
  if (INVARIABLE.has(w)) return w;
  if ((m = PRONOUN.exec(w))) return m[1];
  if ((m = CORRELATIVE.exec(w))) return m[1] + m[2];
  if ((m = NOMINAL_INFL.exec(w))) return m[1] + m[2];
  if ((m = ADVERB_INFL.exec(w))) return m[1] + "e";
  if ((m = VERB_INFL.exec(w))) return m[1] + "i";
  return w;
}

// ---- numbers ---------------------------------------------------------------
//
// PMEG 23.1: the numeral words are nul, unu … naŭ, dek, cent and mil. Tens and
// hundreds are written as one word (dudek, tricent), everything else apart
// (dek du, du mil), though the web joins those too (dekdu 4,496 times, dumil
// 969). Before an ending or -obl-, -on-, -op- the whole number is one word
// (dekdua, dudekkvina, dumildudekoble), and a big number is an O-word that a
// number multiplies (du|milion|a). kelk multiplies like a digit (kelkdek,
// kelkmil). nul does not combine.

const MULT = "(?:(?:du|tri|kvar|kvin|ses|sep|ok|naŭ|kelk) )";
const UNIT = "(?:(?:unu|du|tri|kvar|kvin|ses|sep|ok|naŭ) )";
const BELOW_1000 = `(?:${MULT}?cent )?(?:${MULT}?dek )?${UNIT}?`;
const NUMBER_WORDS = `(?:(?:${BELOW_1000}|kelk )mil )?${BELOW_1000}`;
/** One number, each piece followed by a space: thousands, hundreds, tens, units, largest first. */
const NUMBER = new RegExp(`^${NUMBER_WORDS}$`);
/** A number times a big number: du|milion, dek|du|miliard. */
const NUMBER_BIG = new RegExp(`^${NUMBER_WORDS}(?:milion|miliard|bilion|trilion) $`);
const NUMBER_PIECES: ReadonlySet<string> = new Set([
  "unu", "du", "tri", "kvar", "kvin", "ses", "sep", "ok", "naŭ", "dek", "cent", "mil", "kelk",
  "milion", "miliard", "bilion", "trilion",
]);
/** A piece at the start of a word; the big numbers before mil, so milion is read whole. */
const NUMBER_PIECE = /^(?:milion|miliard|bilion|trilion|kelk|kvar|kvin|cent|unu|tri|ses|sep|naŭ|dek|mil|du|ok)/;

const spaced = (pieces: readonly string[]) => pieces.map((p) => p + " ").join("");

/**
 * Whether `pieces` spell one number that stands without an ending: tri|dek,
 * dek|du, du|mil|kvin|cent. Two pieces at least; ok|ok and dek|cent are no
 * number, and du|milion needs an ending.
 */
export function spellsNumber(pieces: readonly string[]): boolean {
  return pieces.length >= 2 && NUMBER.test(spaced(pieces));
}

/**
 * How many pieces from `from` on make one number of two pieces or more, a big
 * number included: 2 for du|mil|a and for du|milion|a, 0 for tri|angul|o.
 */
export function numberLength(pieces: readonly string[], from = 0): number {
  if (!NUMBER_PIECES.has(pieces[from]) || !NUMBER_PIECES.has(pieces[from + 1])) return 0;
  for (let to = pieces.length; to >= from + 2; to--) {
    const s = spaced(pieces.slice(from, to));
    if (NUMBER.test(s) || NUMBER_BIG.test(s)) return to - from;
  }
  return 0;
}

/** Where the pieces of the number a word opens with end: [2, 5] for du|mil|a, null for trianguloj. */
function numberCuts(w: string): number[] | null {
  const pieces: string[] = [];
  for (let at = 0, m: RegExpExecArray | null; (m = NUMBER_PIECE.exec(w.slice(at))); at += m[0].length) pieces.push(m[0]);
  const n = numberLength(pieces);
  if (n === 0) return null;
  let at = 0;
  return pieces.slice(0, n).map((p) => (at += p.length));
}

/** Whether a piece of `ms` ends at every offset in `cuts`. */
function cutsAt(ms: Morph[], cuts: number[]): boolean {
  const ends = new Set<number>();
  let at = 0;
  for (const m of ms) ends.add((at += m.m.length));
  return cuts.every((c) => ends.has(c));
}

// ---- segmentation ----------------------------------------------------------

/** P prefix · R root · S suffix · L linking vowel · E ending · W endingless word */
export type MorphKind = "P" | "R" | "S" | "L" | "E" | "W";
export interface Morph {
  m: string;
  k: MorphKind;
}

export interface Inventory {
  roots: ReadonlySet<string>;
  prefixes: ReadonlySet<string>;
  suffixes: ReadonlySet<string>;
  /** Words used without an ending (ĉar, hodiaŭ, tiu); they may still take -n/-j. */
  words: ReadonlySet<string>;
  /**
   * How often the corpus writes two morphemes side by side next to a marked
   * root, "dis+port" → n. A split that uses such a pair is cheaper, one that
   * joins two morphemes the corpus never joins is dearer. Optional: without
   * it the pieces are priced on their own.
   */
  pairs?: ReadonlyMap<string, number>;
  /** Derivations per root in the corpus; a root with many is a little cheaper. */
  rootWeight?: ReadonlyMap<string, number>;
  /**
   * Word class of a root: how many of its headwords are the root plus o, a, e
   * or i (hund|o, bel|a, ir|i). The learned scorer asks whether the ending or
   * suffix a reading puts after a root suits it. Optional.
   */
  classes?: ReadonlyMap<string, WordClass>;
}

export interface WordClass {
  o: number;
  a: number;
  e: number;
  i: number;
}

export const ENDINGS: ReadonlySet<string> = new Set([
  "o", "a", "e", "i", "u", "as", "is", "os", "us", "oj", "on", "ojn", "aj", "an", "ajn", "en",
]);
const WORD_ENDINGS: ReadonlySet<string> = new Set(["n", "j", "jn"]);
/** Endings a root may keep inside a compound besides o (certa|grade, multe|nombra, daŭri|pova). */
const VOWEL_LINK: ReadonlySet<string> = new Set(["a", "e", "i"]);
const MAX_MORPH = 24;

// phases: 0 start / after a prefix · 1 after a root or suffix · 2 after an inner
// ending (a root must follow) · 3 after an endingless word · 4 done
interface Cell {
  cost: number;
  from: number;
  fromKey: string;
  /** which of the kept cells at (from, fromKey) this one extends */
  fromIdx: number;
  morph: Morph | null;
}

/**
 * Does `fixed` name a root that really sits at that offset in `word`?
 *
 * The pins come from the corpus (`<tld/>` occurrences), where the root and the
 * offset are read off separate columns, so a mismatch is possible and must not
 * reach the segmenter.
 */
export function pinFits(word: string, fixed: { at: number; root: string }): boolean {
  const w = word.toLowerCase();
  const r = fixed.root.toLowerCase();
  if (r.length === 0 || fixed.at < 0 || fixed.at + r.length > w.length) return false;
  return w.slice(fixed.at, fixed.at + r.length) === r;
}

// Costs. Measured with `pnpm corpus:eval-segment` on the words whose root
// the corpus marks; each term earned its place there, and a term that lowered
// the score (a bigger length bonus, a penalty on proper-name roots, linking
// a/e/i) was left out.
const ONE_LETTER = 3; // a one-letter root (the letter's own article): ŝip|el|ir over ŝip|e|lir
const LEN_BONUS = 0.005; // × len², so faj|rob|rig loses to fajr|o|brigad
const DRV_BONUS = 0.02; // × ln(1 + derivations): mont over tar, by a hair
const LINK = 0.25; // an ending kept inside the word: the linking o, a/e, n after an endingless word
const WORD_LATE = 2; // an endingless word (ĝis) as anything but the first piece
const PAIR_BONUS = 0.25; // × ln(1 + n) for a pair the corpus writes
const PAIR_UNSEEN = 0.5; // for a pair it never writes
const KEEP = 8; // readings kept per search state (with pair evidence)
const MAX_READINGS = 16; // distinct finished readings handed to the scorer

/** A split and its hand cost (the sum of the costs above). */
export interface Reading {
  ms: Morph[];
  cost: number;
}

/**
 * Split of `word` into morphemes; null if the inventory can't cover it.
 *
 * Without `inv.pairs` (the build's first pass) this is the cheapest reading by
 * the hand costs of `readings()`. With pairs, the learned scorer picks among
 * the cheapest readings (see `scoreReading`). Table words (kiu, tiajn, nenion)
 * and the endingless words of the inventory (en, aj) are a closed set and keep
 * the cheapest reading, which is the whole word or what ReVo files (neni|o):
 * the scorer is trained on words with a marked root, never on these, and would
 * read en as e|n.
 *
 * A number keeps its pieces. The scorer reads dumila as dum|il|a and dekoka
 * as de|kok|a; when the reading it picks ends a piece where the number a word
 * opens with ends, but cuts through the number before that, the best reading
 * that keeps the number whole wins instead: du|mil|a, dek|ok|a, du|milion|a.
 * A root that runs on past the number stays, since the number was then a
 * coincidence: dekokt|aĵ|o (a decoction), mild|ul|o, cent|okul|a
 * (hundred-eyed).
 */
export function segment(word: string, inv: Inventory, fixed?: { at: number; root: string }): Morph[] | null {
  const rs = readings(word, inv, fixed);
  if (rs.length === 0) return null;
  const w = word.toLowerCase();
  if (rs.length === 1 || CORRELATIVE.test(w) || inv.words.has(w)) return rs[0].ms;
  const scores = rs.map((r) => scoreReading(r, rs[0].cost, inv));
  let pick = 0;
  scores.forEach((s, i) => {
    if (s < scores[pick] - 1e-9) pick = i;
  });
  const cuts = numberCuts(w);
  if (cuts && cutsAt(rs[pick].ms, cuts.slice(-1)) && !cutsAt(rs[pick].ms, cuts)) {
    let whole = -1;
    rs.forEach((r, i) => {
      if (cutsAt(r.ms, cuts) && (whole < 0 || scores[i] < scores[whole] - 1e-9)) whole = i;
    });
    if (whole >= 0) pick = whole;
  }
  return rs[pick].ms;
}

/**
 * Readings of `word` by hand cost, cheapest first; empty if the inventory
 * can't cover it. Each piece costs about one, less for a long one and for a
 * root with many derivations, more for a 1–2 letter root or word, a prefix
 * after a root, an endingless word inside the word; so "mal|san|ul|ej|o" beats
 * readings with more or shorter pieces. With `inv.pairs`, two neighbouring
 * pieces the corpus writes together (dis+port) are cheaper and two it never
 * joins dearer, which is why the search keeps the last piece in its state.
 * Affix articles are roots too (ulo, ejo), so an affix reading is priced just
 * below the root reading of the same string. `fixed` pins a root at a known
 * offset.
 *
 * A piece may keep its ending inside a compound: the linking o always
 * (hund|o|ŝip|o), n after an endingless word (ĉio|n|pov|a, si|n|defend|o),
 * and a, e or i after a root (cert|a|grad|e, mult|e|nombr|a, daŭr|i|pov|a) —
 * those only before a root the corpus writes after that vowel, or brit|e|lir|o
 * (the lira) would undercut brit|el|ir|o.
 *
 * Without pairs only the cheapest reading is kept (one per search state);
 * with pairs the eight cheapest per state, and up to 16 distinct readings
 * come out.
 */
export function readings(word: string, inv: Inventory, fixed?: { at: number; root: string }): Reading[] {
  const w = word.toLowerCase();
  const n = w.length;
  if (n === 0) return [];
  const keep = inv.pairs ? KEEP : 1;
  // the cheapest cells per (position, phase, last morpheme): the pair term needs the last piece
  const best: Map<string, Cell[]>[] = Array.from({ length: n + 1 }, () => new Map());
  best[0].set("0", [{ cost: 0, from: -1, fromKey: "", fromIdx: -1, morph: null }]);
  // A pin the word does not bear is dropped: the span it names would be
  // stamped as a root whatever text happens to sit there, and straddling it
  // is forbidden, so a wrong pin also rules out every correct reading.
  const pin = fixed && pinFits(w, fixed) ? fixed : undefined;
  const fAt = pin ? pin.at : -1;
  const fEnd = pin ? pin.at + pin.root.length : -1;
  const { pairs, rootWeight } = inv;

  const bonus = (s: string) => LEN_BONUS * s.length * s.length;
  const rootCost = (s: string) =>
    (s.length === 1 ? ONE_LETTER : s.length === 2 ? 2.5 : 1) - bonus(s) - (rootWeight ? DRV_BONUS * Math.log1p(rootWeight.get(s) ?? 0) : 0);
  // insert by cost; an equal cost goes after the cells already there, so the first reading found wins a tie
  const add = (j: number, key: string, cell: Cell) => {
    let cells = best[j].get(key);
    if (!cells) best[j].set(key, (cells = []));
    let at = cells.length;
    while (at > 0 && cell.cost < cells[at - 1].cost) at--;
    if (at >= keep) return;
    cells.splice(at, 0, cell);
    if (cells.length > keep) cells.pop();
  };

  for (let i = 0; i < n; i++) {
    if (best[i].size === 0) continue;
    for (let j = i + 1; j <= Math.min(n, i + MAX_MORPH); j++) {
      const isFixed = i === fAt && j === fEnd;
      if (pin && !isFixed && i < fEnd && j > fAt) continue; // nothing may straddle the fixed root
      const s = w.slice(i, j);
      const atEnd = j === n;
      for (const [key, cells] of best[i]) {
        const ph = Number(key[0]);
        for (let idx = 0; idx < cells.length; idx++) {
          const cell = cells[idx];
          const prev = cell.morph;
          const relax = (next: number, k: MorphKind, cost: number) => {
            let c = cell.cost + cost;
            if (pairs && prev && prev.k !== "E" && k !== "E") {
              const m = pairs.get(`${prev.m}+${s}`);
              c += m ? -PAIR_BONUS * Math.log1p(m) : PAIR_UNSEEN;
            }
            add(j, `${next}${s}`, { cost: c, from: i, fromKey: key, fromIdx: idx, morph: { m: s, k } });
          };
          if (isFixed) {
            relax(1, "R", 0.5);
            if (inv.words.has(s)) relax(3, "W", 0.5);
            continue;
          }
          // after an inner a/e/i only a root the corpus writes after that vowel fits
          const backed = !(ph === 2 && pairs && VOWEL_LINK.has(prev!.m) && !pairs.has(`${prev!.m}+${s}`));
          if (inv.roots.has(s) && backed) relax(1, "R", rootCost(s));
          if (ph === 2) continue; // after an inner ending only a root fits
          if (inv.words.has(s)) relax(3, "W", (s.length <= 2 ? 2.5 : 1) - bonus(s) + (ph === 0 ? 0 : WORD_LATE));
          if (inv.prefixes.has(s)) relax(0, "P", (ph === 0 ? 0.9 : 2.5) - bonus(s));
          if (ph === 1 || ph === 3) {
            if (inv.suffixes.has(s)) relax(1, "S", 0.9 - bonus(s));
            if (atEnd && ENDINGS.has(s)) relax(4, "E", 0.5);
          }
          // without pair evidence (the build's first pass over the marked words)
          // an inner a/e/i is not offered at all: the pass then reads the vowel
          // as the letter's root only where nothing else fits (daŭr|i|pov|a) and
          // learns i+pov from that, instead of nepr|i|pens from a cheap vowel
          if (ph === 1 && !atEnd && (s === "o" || (VOWEL_LINK.has(s) && pairs))) relax(2, "L", LINK);
          if (ph === 3 && atEnd && WORD_ENDINGS.has(s)) relax(4, "E", 0.5);
          if (ph === 3 && !atEnd && s === "n") relax(2, "L", LINK);
        }
      }
    }
  }

  // finished: an ending (phase 4) or an endingless word (phase 3); on a tie the ending
  const ends: { key: string; idx: number; cost: number }[] = [];
  for (const [key, cells] of best[n]) {
    if (key[0] !== "4" && key[0] !== "3") continue;
    cells.forEach((c, idx) => ends.push({ key, idx, cost: c.cost }));
  }
  ends.sort((a, b) => a.cost - b.cost || (a.key[0] === b.key[0] ? 0 : a.key[0] === "4" ? -1 : 1));
  const trace = (key: string, idx: number): Morph[] => {
    const out: Morph[] = [];
    for (let i = n; i > 0; ) {
      const c = best[i].get(key)![idx];
      out.push(c.morph!);
      [i, key, idx] = [c.from, c.fromKey, c.fromIdx];
    }
    return out.reverse();
  };
  const out: Reading[] = [];
  const seen = new Set<string>();
  for (const e of ends) {
    if (out.length >= (keep === 1 ? 1 : MAX_READINGS)) break;
    const ms = trace(e.key, e.idx);
    const id = ms.map((m) => m.m + m.k).join("|");
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ ms, cost: e.cost });
  }
  return out;
}

// ---- learned scorer ----------------------------------------------------------
//
// The hand costs above get the root right for about 99.3 % of unseen words;
// most of what is left is a near tie between readings the costs cannot tell
// apart: di|sport|i against dis|port|i, flan|ken|ir|i against flank|en|ir|i.
// The scorer looks at the readings `readings()` finishes with and describes
// each by the features below; the reading with the lowest weighted sum wins.
// The weights (src/morph-weights.ts) are fitted by scripts/train-segment.ts on
// the "tune" third of the words ReVo marks with <tld/>, so that for each word
// the readings that put the marked root in the right place get the most
// probability (a log-linear model: P(reading) ∝ exp(−score)).
//
// To try a feature: add it here, run `pnpm corpus:train-segment` (rewrites
// the weights and prints the tune misses), then `pnpm corpus:eval-segment`
// (the report third, which training never sees) and compare the stored splits
// of a rebuilt corpus. A feature the weights file does not name scores 0.

/** Table words (correlatives): ki-, ti-, i-, ĉi-, neni- × a, al, am, e, el, es, o, om, u, with j, n, jn. */
const CORRELATIVE = /^(ki|ti|i|ĉi|neni)(a|al|am|e|el|es|o|om|u)(j|n|jn)?$/;
/** Suffixes that make or need a verb (a participle, -ig, -ebl …): they suit a root of class i. */
const VERBAL: ReadonlySet<string> = new Set(["ant", "int", "ont", "at", "it", "ot", "ad", "ig", "iĝ", "ebl", "ind", "end", "em", "ist"]);
/** The word class an ending belongs to. */
const ENDING_CLASS: Record<string, keyof WordClass> = {
  o: "o", oj: "o", on: "o", ojn: "o", a: "a", aj: "a", an: "a", ajn: "a", e: "e", en: "e",
  i: "i", as: "i", is: "i", os: "i", us: "i", u: "i",
};

/**
 * The features of one reading, by name. `best` is the hand cost of the
 * cheapest reading of the same word.
 *
 * - `cost`: hand cost above the cheapest reading.
 * - `n_P` … `n_W`: pieces per kind; `len2`: Σ length²/10 over the non-endings.
 * - roots: `R_len1` … `R_len5` (5 = five or more letters); `R_logdrv`
 *   ln(1 + derivations); `R_drv01` a root with at most one derivation;
 *   `R_isprefix` / `R_issuffix` / `R_isword` a root that is also an affix or
 *   an endingless word; `R_noclass` a root with no headword of its own class.
 * - `weak`: ln 5 − ln(1 + derivations) of the least-derived 2–4 letter root
 *   that is not also an endingless word (0 if none, or ≥ 4 derivations).
 * - word class: `E_classfit` / `L_classfit` ln share of the root's headwords
 *   in the class of the ending or inner vowel after it (smoothed);
 *   `S_verbfit` the same for class i before a verbal suffix.
 * - affixes: `P=dis`, `S=ist` … one feature per prefix / suffix, so each can
 *   be likelier or less likely than its letters suggest (di is rarely a
 *   prefix, dis often); `S_len1` … `S_len3`; `P_late` a prefix after a root.
 * - `L_o`, `L_a`, `L_e`, `L_i`, `L_n`: an inner ending of that letter.
 * - `W_late` an endingless word after the first piece; `W_short` one of ≤ 2 letters.
 * - neighbours (as the hand cost sees them): `pair_seen` / `pair_unseen`
 *   count pairs the corpus writes / never writes, `pair_log` Σ ln(1 + n).
 */
export function readingFeatures(r: Reading, best: number, inv: Inventory): Map<string, number> {
  const f = new Map<string, number>();
  const inc = (k: string, v = 1) => f.set(k, (f.get(k) ?? 0) + v);
  f.set("cost", r.cost - best);
  const classFit = (root: string, v: keyof WordClass) => {
    const c = inv.classes?.get(root);
    const all = c ? c.o + c.a + c.e + c.i : 0;
    return Math.log(((c?.[v] ?? 0) + 0.5) / (all + 2));
  };
  let weakest = Infinity;
  const ms = r.ms;
  ms.forEach((m, i) => {
    const prev = ms[i - 1];
    const next = ms[i + 1];
    inc("n_" + m.k);
    if (m.k !== "E") inc("len2", (m.m.length * m.m.length) / 10);
    if (m.k === "R") {
      const d = inv.rootWeight?.get(m.m) ?? 0;
      inc("R_len" + Math.min(m.m.length, 5));
      inc("R_logdrv", Math.log1p(d));
      if (d <= 1) inc("R_drv01");
      if (m.m.length >= 2 && m.m.length <= 4 && !inv.words.has(m.m)) weakest = Math.min(weakest, d);
      if (inv.prefixes.has(m.m)) inc("R_isprefix");
      if (inv.suffixes.has(m.m)) inc("R_issuffix");
      if (inv.words.has(m.m)) inc("R_isword");
      if (!inv.classes?.has(m.m)) inc("R_noclass");
      if (next?.k === "E" && ENDING_CLASS[next.m]) inc("E_classfit", classFit(m.m, ENDING_CLASS[next.m]));
      if (next?.k === "L" && next.m !== "n") inc("L_classfit", classFit(m.m, next.m as keyof WordClass));
      if (next?.k === "S" && VERBAL.has(next.m)) inc("S_verbfit", classFit(m.m, "i"));
    }
    if (m.k === "W") {
      if (i > 0) inc("W_late");
      if (m.m.length <= 2) inc("W_short");
    }
    if (m.k === "P") {
      inc("P=" + m.m);
      if (prev && prev.k !== "P") inc("P_late");
    }
    if (m.k === "S") {
      inc("S=" + m.m);
      inc("S_len" + Math.min(m.m.length, 3));
    }
    if (m.k === "L") inc("L_" + m.m);
    if (inv.pairs && prev && prev.k !== "E" && m.k !== "E") {
      const n = inv.pairs.get(`${prev.m}+${m.m}`);
      if (n) {
        inc("pair_seen");
        inc("pair_log", Math.log1p(n));
      } else inc("pair_unseen");
    }
  });
  f.set("weak", weakest === Infinity ? 0 : Math.max(0, Math.log1p(4) - Math.log1p(weakest)));
  return f;
}

/** The learned score of a reading: Σ weight × feature (lower is better). */
export function scoreReading(r: Reading, best: number, inv: Inventory, weights: Readonly<Record<string, number>> = SEGMENT_WEIGHTS): number {
  let s = 0;
  for (const [k, v] of readingFeatures(r, best, inv)) s += (weights[k] ?? 0) * v;
  return s;
}

/** "mal|san|ul|ej|o" and "PRSSE" */
export function formatSegments(ms: Morph[]): { seg: string; kinds: string } {
  return { seg: ms.map((x) => x.m).join("|"), kinds: ms.map((x) => x.k).join("") };
}
