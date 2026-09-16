/**
 * The example sentences, in every article, that use an entry's headword: the
 * word itself, whole, or an inflection of it (hundo: hundoj, hundon, hund';
 * pafi: pafas, pafu; si: sin; kiu: kiujn). A word built on it (ĉashundo, sia,
 * siaspeca) is another entry's, and a participle is left to the entries of
 * its verb's derivations. The entry shows its own examples, so they are left
 * out, and so is the same sentence quoted elsewhere; a sentence several
 * articles quote alike is listed once.
 *
 * The candidates come from `fts_ekz_word`, the index of the examples' words,
 * which knows "si" from "sinjoro"; it keeps no positions, so the words of a
 * headword of several, and an elision's apostrophe, are checked in the text.
 */

import type { SqlReader } from "./sql";
import { entryNodeByMark, hasTable } from "./db-voko";

export interface WordMatch {
  /** the word, or the words of a headword of several: UTF-16 offset and length in the text */
  at: number;
  length: number;
}

export interface WordExample {
  id: number;
  text: string;
  /** the file name of the article it is in */
  article: string;
  /** the headword of the entry it is in */
  headword: string;
  /** that entry's mark, when the example is in an entry */
  mrk?: string;
  senseMrk?: string;
  /** the headword's occurrences, in text order */
  matches: WordMatch[];
  translations: { lng: string; trd: string }[];
}

export interface WordExamplesResult {
  /** false when the database was built without the examples' word index */
  available: boolean;
  /** the headwords looked for: the entry's own, then its variants */
  headwords: string[];
  /** the examples from offset on */
  examples: WordExample[];
  /** examples of the word: exact, or when totalExact is false the candidates, which it does not exceed */
  total: number;
  totalExact: boolean;
  /** the sentences the index found the forms in */
  candidates: number;
  offset: number;
}

export interface WordExamplesOptions {
  /** languages of the examples' translations; all of them when omitted */
  languages?: string[];
  limit?: number;
  offset?: number;
  /**
   * Count every example (true), or stop once the page is full and report the
   * candidates as the total. Counting reads every candidate sentence: cheap
   * on a local file, many pages over HTTP for a common word.
   */
  exactTotal?: boolean;
}

interface ExampleRow {
  rowid: number;
  art: string;
  drv_mrk: string;
  sense_mrk: string | null;
  ekz_md: string;
  last_id: number;
  trd: number;
  kap: string | null;
}

const WORD = /\p{L}+/gu;
/** A headword's words, an elided one with its apostrophe (l', hund'). */
const HEADWORD_WORD = /\p{L}+(?:['’](?!\p{L}))?/gu;
const APOSTROPHES = "'’";
/** What may stand between the words of a headword of several (Granda Hundo, ex-reĝo). */
const BETWEEN_WORDS = /^[\s\-‐‑]+$/u;
const IS_ENTRY_MARK = /^[^.]+\.[^.]+$/;
/** Candidate sentences fetched per query. */
const CHUNK = 64;

/**
 * A headword's word and its inflections, lowercased, an elided form ending
 * in "'". Only what inflects gets endings, so a short word does not take in
 * another (nu and nun, je and jen).
 */
export function wordForms(word: string): string[] {
  const w = word.toLowerCase().replace(/’$/, "'");
  if (w.endsWith("'")) return [w];
  const out = new Set([w]);
  const add = (...endings: string[]) => endings.forEach((ending) => out.add(w + ending));
  // nouns and adjectives, kia and the other correlatives in -a
  if (/[oa]$/.test(w) && (w.length >= 3 || w === "ia")) add("j", "n", "jn");
  // kiu, tiu, ĉiu, neniu, iu, and unu
  if (/iu$/.test(w) || w === "unu") add("j", "n", "jn");
  // direction: hejmen, tien
  if (/e$/.test(w) && w.length >= 3) add("n");
  if (/i$/.test(w)) {
    // mi, si, ili
    add("n");
    // a verb's tenses, moods and imperative
    if (w.length >= 3) for (const ending of ["as", "is", "os", "us", "u"]) out.add(w.slice(0, -1) + ending);
  }
  if (/o$/.test(w) && w.length >= 3) out.add(`${w.slice(0, -1)}'`);
  return [...out];
}

/** The FTS5 query for sentences that hold every word of one of the headwords, in some form. */
function headwordsQuery(headwords: string[][][]): string {
  const quote = (text: string) => `"${text.replace(/"/g, '""')}"`;
  return headwords.map((words) => `(${words.map((forms) =>
    `(${[...new Set(forms.map((form) => form.replace(/'$/, "")))].map(quote).join(" OR ")})`).join(" AND ")})`).join(" OR ");
}

/** Where a sentence uses one of the headwords, each a list of its words' forms. */
function matchesIn(text: string, headwords: string[][][]): WordMatch[] {
  const tokens = [...text.matchAll(WORD)].map((m) => ({
    word: m[0].toLowerCase(),
    at: m.index,
    end: m.index + m[0].length,
    elided: APOSTROPHES.includes(text.charAt(m.index + m[0].length)),
  }));
  // the longest headword first, so Granda Hundo is one match
  const longest = [...headwords].sort((a, b) => b.length - a.length);
  const out: WordMatch[] = [];
  for (let i = 0; i < tokens.length; i++) {
    for (const words of longest) {
      if (i + words.length > tokens.length) continue;
      let end = -1;
      const fits = words.every((forms, j) => {
        const token = tokens[i + j];
        if (j > 0 && !BETWEEN_WORDS.test(text.slice(end, token.at))) return false;
        if (forms.includes(token.word)) end = token.end;
        else if (token.elided && forms.includes(`${token.word}'`)) end = token.end + 1;
        else return false;
        return true;
      });
      if (fits) {
        out.push({ at: tokens[i].at, length: end - tokens[i].at });
        i += words.length - 1;
        break;
      }
    }
  }
  return out;
}

/**
 * The examples that use the headword of the entry `mark`, or one of its
 * variants, as words of their own, in document order.
 */
export function wordExamples(db: SqlReader, mark: string, opts: WordExamplesOptions = {}): WordExamplesResult {
  const node = entryNodeByMark(db, mark);
  if (!node) throw new Error(`No dictionary entry has the mark ${mark}.`);
  const { limit = 200, offset = 0, exactTotal = true } = opts;
  const txts = db
    .query<{ txt: string }, [number, number, number]>(
      "SELECT txt FROM headword WHERE id BETWEEN ? AND ? AND node_id = ? ORDER BY main_id IS NOT NULL, id")
    .all(node.id, node.last_id, node.id)
    .map((r) => r.txt);
  const result: WordExamplesResult = { available: false, headwords: txts, examples: [], total: 0, totalExact: true, candidates: 0, offset };
  if (!hasTable(db, "fts_ekz_word")) return result;
  result.available = true;

  const headwords = [...new Map(txts
    .map((txt) => [...txt.matchAll(HEADWORD_WORD)].map((w) => wordForms(w[0])))
    .filter((words) => words.length > 0)
    .map((words) => [JSON.stringify(words), words] as const)).values()];
  if (headwords.length === 0) return result;
  const languages = opts.languages && [...new Set(opts.languages.filter((language) => language !== "eo"))];

  // The entry's own sentences, and the same sentences quoted elsewhere, are not listed.
  const seen = new Set(db
    .query<{ ekz_md: string }, [number, number]>("SELECT ekz_md FROM ekzemplo WHERE rowid BETWEEN ? AND ?")
    .all(node.id, node.last_id)
    .map((r) => sentenceKey(r.ekz_md)));
  const candidates = db
    .query<{ rowid: number }, [string]>("SELECT rowid FROM fts_ekz_word WHERE fts_ekz_word MATCH ? ORDER BY rowid")
    .all(headwordsQuery(headwords))
    .map((r) => r.rowid)
    .filter((id) => id < node.id || id > node.last_id);
  result.candidates = candidates.length;

  let found = 0;
  scan: for (let c = 0; c < candidates.length; c += CHUNK) {
    const ids = candidates.slice(c, c + CHUNK);
    const rows = new Map(db
      .query<ExampleRow, number[]>(
        `SELECT rowid, art, drv_mrk, sense_mrk, ekz_md, last_id, trd, kap FROM ekzemplo
          WHERE rowid IN (${ids.map(() => "?").join(",")})`)
      .all(...ids)
      .map((r) => [r.rowid, r]));
    for (const id of ids) {
      const row = rows.get(id)!;
      const matches = matchesIn(row.ekz_md, headwords);
      if (matches.length === 0) continue;
      const key = sentenceKey(row.ekz_md);
      if (seen.has(key)) continue;
      seen.add(key);
      if (found >= offset && found < offset + limit) {
        result.examples.push({
          id,
          text: row.ekz_md,
          article: row.art,
          headword: row.kap ?? row.drv_mrk,
          ...(IS_ENTRY_MARK.test(row.drv_mrk) ? { mrk: row.drv_mrk } : {}),
          ...(row.sense_mrk ? { senseMrk: row.sense_mrk } : {}),
          matches,
          translations: row.trd > 0 ? exampleTranslations(db, row, languages) : [],
        });
      }
      found++;
      if (!exactTotal && found >= offset + limit) {
        result.totalExact = c + CHUNK >= candidates.length && id === ids[ids.length - 1];
        break scan;
      }
    }
  }
  result.total = result.totalExact ? found : candidates.length;
  return result;
}

/** A sentence's words, whatever its case, spacing and punctuation. */
function sentenceKey(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function exampleTranslations(db: SqlReader, row: ExampleRow, languages?: string[]): { lng: string; trd: string }[] {
  if (languages?.length === 0) return [];
  const only = languages ? ` AND +lng IN (${languages.map(() => "?").join(",")})` : "";
  return db
    .query<{ lng: string; trd: string }, unknown[]>(
      `SELECT lng, txt AS trd FROM translation WHERE id BETWEEN ? AND ? AND in_ekz = 1${only} ORDER BY lng, id`)
    .all(row.rowid, row.last_id, ...(languages ?? []));
}
