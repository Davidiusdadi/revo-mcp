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
  fromPh: number;
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

/**
 * Cheapest split of `word` into morphemes; null if the inventory can't cover
 * it. Cost counts morphemes, with penalties for 1–2 letter roots and words, prefixes
 * after a root and linking vowels, so "mal|san|ul|ej|o" beats readings with
 * more or shorter pieces. Affix articles are roots too (ulo, ejo), so an
 * affix reading is priced just below the root reading of the same string.
 * `fixed` pins a root at a known offset.
 */
export function segment(word: string, inv: Inventory, fixed?: { at: number; root: string }): Morph[] | null {
  const w = word.toLowerCase();
  const n = w.length;
  if (n === 0) return null;
  const best: (Cell | undefined)[][] = Array.from({ length: n + 1 }, () => []);
  best[0][0] = { cost: 0, from: -1, fromPh: -1, morph: null };
  // A pin the word does not bear is dropped: the span it names would be
  // stamped as a root whatever text happens to sit there, and straddling it
  // is forbidden, so a wrong pin also rules out every correct reading.
  const pin = fixed && pinFits(w, fixed) ? fixed : undefined;
  const fAt = pin ? pin.at : -1;
  const fEnd = pin ? pin.at + pin.root.length : -1;

  const relax = (i: number, ph: number, j: number, next: number, k: MorphKind, s: string, cost: number) => {
    const c = best[i][ph]!.cost + cost;
    const cur = best[j][next];
    if (!cur || c < cur.cost) best[j][next] = { cost: c, from: i, fromPh: ph, morph: { m: s, k } };
  };

  for (let i = 0; i < n; i++) {
    if (!best[i].some(Boolean)) continue;
    for (let j = i + 1; j <= Math.min(n, i + MAX_MORPH); j++) {
      const isFixed = i === fAt && j === fEnd;
      if (pin && !isFixed && i < fEnd && j > fAt) continue; // nothing may straddle the fixed root
      const s = w.slice(i, j);
      for (let ph = 0; ph < 4; ph++) {
        if (!best[i][ph]) continue;
        if (isFixed) {
          relax(i, ph, j, 1, "R", s, 0.5);
          if (inv.words.has(s)) relax(i, ph, j, 3, "W", s, 0.5);
          continue;
        }
        const atEnd = j === n;
        if (inv.roots.has(s)) relax(i, ph, j, 1, "R", s, s.length <= 2 ? 2.5 : 1);
        if (ph === 2) continue; // after a linking vowel only a root fits
        if (inv.words.has(s)) relax(i, ph, j, 3, "W", s, s.length <= 2 ? 2.5 : 1);
        if (inv.prefixes.has(s)) relax(i, ph, j, 0, "P", s, ph === 0 ? 0.9 : 2.5);
        if (ph === 1 || ph === 3) {
          if (inv.suffixes.has(s)) relax(i, ph, j, 1, "S", s, 0.9);
          if (atEnd && ENDINGS.has(s)) relax(i, ph, j, 4, "E", s, 0.5);
        }
        if (ph === 1 && s === "o" && !atEnd) relax(i, ph, j, 2, "L", s, 1.5);
        if (ph === 3 && atEnd && WORD_ENDINGS.has(s)) relax(i, ph, j, 4, "E", s, 0.5);
      }
    }
  }

  const done = [best[n][4], best[n][3]].filter((c): c is Cell => !!c);
  if (!done.length) return null;
  let ph = best[n][4] && (!best[n][3] || best[n][4]!.cost <= best[n][3]!.cost) ? 4 : 3;
  const out: Morph[] = [];
  for (let i = n; i > 0; ) {
    const c = best[i][ph]!;
    out.push(c.morph!);
    [i, ph] = [c.from, c.fromPh];
  }
  return out.reverse();
}

/** "mal|san|ul|ej|o" and "PRSSE" */
export function formatSegments(ms: Morph[]): { seg: string; kinds: string } {
  return { seg: ms.map((x) => x.m).join("|"), kinds: ms.map((x) => x.k).join("") };
}
