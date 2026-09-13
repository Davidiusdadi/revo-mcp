/**
 * Esperanto morphology over a lexicon: inflection analysis and segmentation.
 * Pure functions, no database.
 *
 * - `lemmaCandidates` lists the dictionary forms a word can be an inflection
 *   of. The ending decides, so "belan" looks for "bela" before "belo" — unlike
 *   stemmer.ts's `generateStems`, which tries every shorter string.
 * - `segment` splits a word into prefixes, roots, suffixes and ending, using a
 *   morpheme inventory (the `morph` pass builds it from the corpus: article
 *   roots, affix articles, endingless words). A known root position (from a
 *   `<tld/>`) can be fixed.
 */

export interface Candidate {
  lemma: string;
  /** infl: inflection removed · class: same stem, another word class · ptcp: participle → its verb */
  how: "infl" | "class" | "ptcp";
}

/** Other word classes of the same stem, most likely first (rapide → rapida before rapido). */
const CLASS_ORDER: Record<string, string> = { o: "aie", a: "oie", e: "aoi", i: "oae" };

export function lemmaCandidates(word: string): Candidate[] {
  const w = word.toLowerCase();
  const infl: string[] = [];
  const cls: string[] = [];
  const ptcp: string[] = [];
  let stem: string | null = null;
  let vowel = "o";
  let m: RegExpExecArray | null;

  if ((m = /^(.{2,})([oa])(jn|j|n)$/.exec(w))) { infl.push(m[1] + m[2]); [stem, vowel] = [m[1], m[2]]; }
  else if ((m = /^(.{2,})en$/.exec(w))) { infl.push(m[1] + "e"); [stem, vowel] = [m[1], "e"]; }
  else if ((m = /^(.{2,})(as|is|os|us|u)$/.exec(w))) { infl.push(m[1] + "i"); [stem, vowel] = [m[1], "i"]; }
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
}

export const ENDINGS: ReadonlySet<string> = new Set([
  "o", "a", "e", "i", "u", "as", "is", "os", "us", "oj", "on", "ojn", "aj", "an", "ajn", "en",
]);
const WORD_ENDINGS: ReadonlySet<string> = new Set(["n", "j", "jn"]);
const MAX_MORPH = 24;

// phases: 0 start / after a prefix · 1 after a root or suffix · 2 after a linking
// vowel (a root must follow) · 3 after an endingless word · 4 done
interface Cell {
  cost: number;
  from: number;
  fromKey: string;
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

// Costs. Measured with `bun run corpus:eval-segment` on the words whose root
// the corpus marks; each term earned its place there, and a term that lowered
// the score (a bigger length bonus, a penalty on proper-name roots, linking
// a/e/i) was left out.
const ONE_LETTER = 3; // a one-letter root (the letter's own article): ŝip|el|ir over ŝip|e|lir
const LEN_BONUS = 0.005; // × len², so faj|rob|rig loses to fajr|o|brigad
const DRV_BONUS = 0.02; // × ln(1 + derivations): mont over tar, by a hair
const LINK = 0.25; // the linking o
const WORD_LATE = 2; // an endingless word (ĝis) as anything but the first piece
const PAIR_BONUS = 0.25; // × ln(1 + n) for a pair the corpus writes
const PAIR_UNSEEN = 0.5; // for a pair it never writes

/**
 * Cheapest split of `word` into morphemes; null if the inventory can't cover
 * it. Each piece costs about one, less for a long one and for a root with many
 * derivations, more for a 1–2 letter root or word, a prefix after a root, an
 * endingless word inside the word; so "mal|san|ul|ej|o" beats readings with
 * more or shorter pieces. With `inv.pairs`, two neighbouring pieces the corpus
 * writes together (dis+port) are cheaper and two it never joins dearer, which
 * is why the search keeps the last piece in its state. Affix articles are
 * roots too (ulo, ejo), so an affix reading is priced just below the root
 * reading of the same string. `fixed` pins a root at a known offset.
 */
export function segment(word: string, inv: Inventory, fixed?: { at: number; root: string }): Morph[] | null {
  const w = word.toLowerCase();
  const n = w.length;
  if (n === 0) return null;
  // one cell per (position, phase, last morpheme): the pair term needs the last piece
  const best: Map<string, Cell>[] = Array.from({ length: n + 1 }, () => new Map());
  best[0].set("0", { cost: 0, from: -1, fromKey: "", morph: null });
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

  for (let i = 0; i < n; i++) {
    if (best[i].size === 0) continue;
    for (let j = i + 1; j <= Math.min(n, i + MAX_MORPH); j++) {
      const isFixed = i === fAt && j === fEnd;
      if (pin && !isFixed && i < fEnd && j > fAt) continue; // nothing may straddle the fixed root
      const s = w.slice(i, j);
      const atEnd = j === n;
      for (const [key, cell] of best[i]) {
        const ph = Number(key[0]);
        const prev = cell.morph;
        const relax = (next: number, k: MorphKind, cost: number) => {
          let c = cell.cost + cost;
          if (pairs && prev && prev.k !== "E" && k !== "E") {
            const m = pairs.get(`${prev.m}+${s}`);
            c += m ? -PAIR_BONUS * Math.log1p(m) : PAIR_UNSEEN;
          }
          const nk = `${next}${s}`;
          const cur = best[j].get(nk);
          if (!cur || c < cur.cost) best[j].set(nk, { cost: c, from: i, fromKey: key, morph: { m: s, k } });
        };
        if (isFixed) {
          relax(1, "R", 0.5);
          if (inv.words.has(s)) relax(3, "W", 0.5);
          continue;
        }
        if (inv.roots.has(s)) relax(1, "R", rootCost(s));
        if (ph === 2) continue; // after a linking vowel only a root fits
        if (inv.words.has(s)) relax(3, "W", (s.length <= 2 ? 2.5 : 1) - bonus(s) + (ph === 0 ? 0 : WORD_LATE));
        if (inv.prefixes.has(s)) relax(0, "P", (ph === 0 ? 0.9 : 2.5) - bonus(s));
        if (ph === 1 || ph === 3) {
          if (inv.suffixes.has(s)) relax(1, "S", 0.9 - bonus(s));
          if (atEnd && ENDINGS.has(s)) relax(4, "E", 0.5);
        }
        if (ph === 1 && s === "o" && !atEnd) relax(2, "L", LINK);
        if (ph === 3 && atEnd && WORD_ENDINGS.has(s)) relax(4, "E", 0.5);
      }
    }
  }

  // finished: an ending (phase 4), or an endingless word (phase 3); on a tie the ending
  let end: { key: string; cell: Cell } | undefined;
  for (const [key, cell] of best[n]) {
    if (key[0] !== "4" && key[0] !== "3") continue;
    if (!end || cell.cost < end.cell.cost || (cell.cost === end.cell.cost && key[0] === "4" && end.key[0] === "3")) end = { key, cell };
  }
  if (!end) return null;
  const out: Morph[] = [];
  for (let i = n, key = end.key; i > 0; ) {
    const c = best[i].get(key)!;
    out.push(c.morph!);
    [i, key] = [c.from, c.fromKey];
  }
  return out.reverse();
}

/** "mal|san|ul|ej|o" and "PRSSE" */
export function formatSegments(ms: Morph[]): { seg: string; kinds: string } {
  return { seg: ms.map((x) => x.m).join("|"), kinds: ms.map((x) => x.k).join("") };
}
