/**
 * Word families: every entry built on the roots of an entry, whichever article
 * files it, and the example sentences that use them.
 *
 * The `morph` pass keys `x_family` by root, so a family is one range of the
 * table (hundherbo, filed under herb, is in the range of hund). An entry has a
 * family per root of its headword (ĉashundo: hund and ĉas), its article's own
 * root first. A root that is also an affix (ulo, ino) lists the words that use
 * the affix too (malsanulejo under ul).
 *
 * The examples are found through `fts_ekz`, which finds the root anywhere in a
 * word, and kept where a word of the sentence belongs to the family: it is a
 * member's headword or an inflection of one, or the inventory splits it with
 * the root in it. So hundiĉo (its own root) and Hundertwasser stay out. An
 * example that uses several of the roots is listed once, under the first.
 */

import type { SqlReader } from "./sql";
import { entryNodeByMark, hasPass, hasTable, translationsOf, trigramMatch } from "./db-voko";
import { inventoryOf } from "./gloss";
import { lemmaCandidates, parseSpans, segment, type Inventory, type Morph } from "./morph";
import { fromXSystem, hasXSystem } from "./stemmer";

export interface FamilySpan {
  morph: string;
  /** R root, W endingless word, P prefix, S suffix */
  kind: "R" | "W" | "P" | "S";
  /** UTF-16 offset in the headword */
  at: number;
}

export interface FamilyWord {
  headword: string;
  /** the headword as its article writes it, the article's root a tilde: "ĉas~o" */
  tilde: string;
  /** its roots, endingless words, prefixes and suffixes */
  spans: FamilySpan[];
}

export interface FamilyMember extends FamilyWord {
  mrk: string;
  /** the file name of the article that files the entry */
  article: string;
  /** that article's root */
  articleRoot: string;
  /** for a variant headword, the headword it is a variant of */
  variantOf?: string;
}

export interface WordFamily {
  /** the root the family is built on, lowercased */
  root: string;
  /** P or S when the root is also a prefix or a suffix */
  affix?: "P" | "S";
  /** the entry's own article root */
  own: boolean;
  /** the articles whose root it is (homonyms share one) */
  articles: { article: string; rad: string }[];
  /** members from offset on, in the family's order */
  members: FamilyMember[];
  /** members in the whole family */
  entries: number;
  offset: number;
  /** how many of the listed members have a translation in each language, most first */
  translated: { language: string; count: number }[];
}

export interface FamilyResult {
  /** false when the database was built without x_family */
  available: boolean;
  entry: FamilyWord & { mrk: string; article: string; articleRoot: string; variants: FamilyWord[] };
  families: WordFamily[];
  /** the listed members' translations, by mark */
  translations: Record<string, { lng: string; trd: string }[]>;
}

export interface FamilyOptions {
  /** translation languages; all of them when omitted */
  languages?: string[];
  /** members listed per family */
  limit?: number;
  /** members skipped per family */
  offset?: number;
  /** only this root's family */
  only?: string;
}

interface FamilyRow {
  kap_id: number;
  node_id: number;
  last_id: number;
  mrk: string;
  variant_of: string | null;
  txt: string;
  tilde: string;
  art: string;
  rad: string;
  spans: string;
}

const FAMILY_ROW = "SELECT kap_id, node_id, last_id, mrk, variant_of, txt, tilde, art, rad, spans FROM x_family";

/** The Esperanto alphabet; what it does not name sorts by code point after it. */
const ALPHABET = "abcĉdefgĝhĥijĵklmnoprsŝtuŭvz";
const LETTER_RANK = new Map([...ALPHABET].map((c, i) => [c, i]));

/** Esperanto alphabetical order, case folded first, then as written. */
export function compareEsperanto(a: string, b: string): number {
  const x = [...a.toLowerCase()], y = [...b.toLowerCase()];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    if (x[i] === y[i]) continue;
    const rx = LETTER_RANK.get(x[i]), ry = LETTER_RANK.get(y[i]);
    // a space or hyphen ends a word, so "hund herbo" sorts before "hundherbo"
    if (rx === undefined || ry === undefined) {
      if (rx !== undefined) return 1;
      if (ry !== undefined) return -1;
      return x[i].codePointAt(0)! - y[i].codePointAt(0)!;
    }
    return rx - ry;
  }
  return x.length - y.length || (a < b ? -1 : a > b ? 1 : 0);
}

/** Anja's order: the root's verb, noun and adjective first (hundi, hundo, hunda), then the rest alphabetically. */
function familyRank(headword: string, root: string): number {
  const i = ["i", "o", "a"].map((ending) => root + ending).indexOf(headword.toLowerCase());
  return i < 0 ? 3 : i;
}

const spansOf = (text: string): FamilySpan[] => parseSpans(text).map((s) => ({ morph: s.m, kind: s.k, at: s.at }));

const member = (r: FamilyRow): FamilyMember => ({
  headword: r.txt,
  tilde: r.tilde,
  spans: spansOf(r.spans),
  mrk: r.mrk,
  article: r.art,
  articleRoot: r.rad,
  ...(r.variant_of ? { variantOf: r.variant_of } : {}),
});

/** A root as a caller may write it: x-system, any case. */
function normalizeRoot(root: string): string {
  return (hasXSystem(root) ? fromXSystem(root) : root).toLowerCase();
}

/** A family's members, one per entry (the main headword over a variant), in the family's order. */
function membersOf(db: SqlReader, root: string): FamilyRow[] {
  const byMark = new Map<string, FamilyRow>();
  for (const r of db.query<FamilyRow, [string]>(`${FAMILY_ROW} WHERE morph = ?`).all(root)) {
    const seen = byMark.get(r.mrk);
    if (!seen || (seen.variant_of !== null && r.variant_of === null)) byMark.set(r.mrk, r);
  }
  return [...byMark.values()].sort((a, b) =>
    familyRank(a.txt, root) - familyRank(b.txt, root) || compareEsperanto(a.txt, b.txt) || (a.mrk < b.mrk ? -1 : 1));
}

/**
 * The families of an entry: one per root and endingless word of its headword,
 * its article's own root first, each listing `limit` members from `offset` on
 * with their translations.
 */
export function familyOf(db: SqlReader, mark: string, opts: FamilyOptions = {}): FamilyResult {
  const node = entryNodeByMark(db, mark);
  if (!node) throw new Error(`No dictionary entry has the mark ${mark}.`);
  const { limit = 200, offset = 0 } = opts;
  const languages = opts.languages && [...new Set(opts.languages.filter((language) => language !== "eo"))];
  const entry: FamilyResult["entry"] = {
    headword: node.headword, tilde: node.headword, spans: [], mrk: node.mrk,
    article: node.article, articleRoot: node.rad, variants: [],
  };
  if (!hasTable(db, "x_family")) return { available: false, entry, families: [], translations: {} };

  const own = new Map<number, FamilyRow>();
  for (const r of db.query<FamilyRow, [number]>(`${FAMILY_ROW} WHERE node_id = ? ORDER BY kap_id`).all(node.id)) {
    if (!own.has(r.kap_id)) own.set(r.kap_id, r);
  }
  const main = [...own.values()].find((r) => r.variant_of === null);
  if (main) Object.assign(entry, { headword: main.txt, tilde: main.tilde, spans: spansOf(main.spans) });
  entry.variants = [...own.values()].filter((r) => r.variant_of !== null)
    .map((r) => ({ headword: r.txt, tilde: r.tilde, spans: spansOf(r.spans) }));

  const articleRoot = node.rad.toLowerCase();
  let roots: string[];
  if (opts.only !== undefined) roots = [normalizeRoot(opts.only)];
  else {
    roots = [...new Set(entry.spans.filter((s) => (s.kind === "R" || s.kind === "W") && s.morph.length >= 2).map((s) => s.morph))];
    // a headword the inventory cannot split still belongs to its article's root
    if (roots.length === 0 && articleRoot.length >= 2) roots = [articleRoot];
    if (roots.includes(articleRoot)) roots = [articleRoot, ...roots.filter((root) => root !== articleRoot)];
  }

  const affixKind = db.query<{ kind: "P" | "S" }, [string]>("SELECT kind FROM x_affix WHERE morph = ?");
  const articlesOf = db.query<{ article: string; rad: string }, [string]>(
    `SELECT a.file AS article, a.rad FROM x_morpheme m JOIN article a ON a.id = m.article_id
      WHERE m.morph = ? AND m.kind = 'R' ORDER BY a.file`);
  const translations: FamilyResult["translations"] = {};
  const families: WordFamily[] = [];
  for (const root of roots) {
    const all = membersOf(db, root);
    if (all.length === 0) continue;
    const listed = all.slice(offset, offset + limit);
    const counts = new Map<string, number>();
    for (const r of listed) {
      translations[r.mrk] ??= translationsOf(db, { id: r.node_id, last_id: r.last_id }, languages);
      for (const language of new Set(translations[r.mrk].map((t) => t.lng))) counts.set(language, (counts.get(language) ?? 0) + 1);
    }
    const affix = affixKind.get(root)?.kind;
    families.push({
      root,
      ...(affix ? { affix } : {}),
      own: root === articleRoot,
      articles: articlesOf.all(root),
      members: listed.map(member),
      entries: all.length,
      offset,
      translated: [...counts].map(([language, count]) => ({ language, count }))
        .sort((a, b) => b.count - a.count || (a.language < b.language ? -1 : 1)),
    });
  }
  return { available: true, entry, families, translations };
}

// ---------------------------------------------------------------------------
// Examples
// ---------------------------------------------------------------------------

export interface ExampleMatch {
  /** the family the word belongs to */
  root: string;
  /** the word: UTF-16 offset and length in the text */
  at: number;
  length: number;
  /** where the root starts in the text */
  rootAt: number;
  /** the member the word is a form of, when it is one */
  headword?: string;
  mrk?: string;
}

export interface FamilyExample {
  id: number;
  text: string;
  /** the file name of the article it is in */
  article: string;
  /** the headword of the entry it is in */
  headword: string;
  /** that entry's mark, when the example is in an entry */
  mrk?: string;
  senseMrk?: string;
  /** it is in an entry of the family */
  memberEntry: boolean;
  /** the words of every requested family in it, in text order */
  matches: ExampleMatch[];
  translations: { lng: string; trd: string }[];
}

export interface FamilyExampleGroup {
  root: string;
  /** the examples from offset on */
  examples: FamilyExample[];
  /** examples of this family: exact, or when totalExact is false the candidates, which it does not exceed */
  total: number;
  totalExact: boolean;
  /** the sentences the index found the root in */
  candidates: number;
  offset: number;
}

export interface FamilyExamplesResult {
  /** false when the database was built without x_family or the examples */
  available: boolean;
  groups: FamilyExampleGroup[];
}

export interface FamilyExamplesOptions {
  /** languages of the examples' translations; all of them when omitted */
  languages?: string[];
  /** examples listed per family */
  limit?: number;
  offset?: number;
  /**
   * Count every example of a family (true), or stop once the page is full and
   * report the candidates as the total. Counting reads every candidate
   * sentence: cheap on a local file, many pages over HTTP for a common root.
   */
  exactTotal?: boolean;
  /** only this root's group; the roots before it still claim their examples */
  only?: string;
  /** leave out the examples of this entry, which its page shows already */
  mark?: string;
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
const APOSTROPHES = "'’";
const IS_ENTRY_MARK = /^[^.]+\.[^.]+$/;
/** Candidate sentences fetched per query. */
const CHUNK = 64;

/** A word of the family: where the root starts in it, and the member it is a form of. */
interface Verdict {
  rootAt: number;
  headword?: string;
  mrk?: string;
}

/** Tells which words of a sentence belong to one family. */
class FamilyMatcher {
  /** member headwords' words that hold the root, lowercased: where the root starts in them, and the member */
  private readonly forms = new Map<string, Required<Verdict>>();
  /** the words judged so far, an elided one with its apostrophe */
  private readonly verdicts = new Map<string, Verdict | null>();
  /** node ranges of the members, sorted */
  readonly ranges: [number, number][];
  private readonly kinds: ReadonlySet<string>;

  constructor(db: SqlReader, readonly root: string, private readonly inv: Inventory) {
    const ranges = new Map<number, number>();
    for (const r of db.query<FamilyRow, [string]>(`${FAMILY_ROW} WHERE morph = ?`).all(root)) {
      ranges.set(r.node_id, r.last_id);
      const spans = parseSpans(r.spans).filter((s) => s.m === root);
      for (const w of r.txt.matchAll(WORD)) {
        const span = spans.find((s) => s.at >= w.index && s.at + s.m.length <= w.index + w[0].length);
        const form = w[0].toLowerCase();
        if (span && !this.forms.has(form)) this.forms.set(form, { rootAt: span.at - w.index, headword: r.variant_of ?? r.txt, mrk: r.mrk });
      }
    }
    this.ranges = [...ranges].sort((a, b) => a[0] - b[0]);
    // an affix family takes the words that use the affix as one, as the index does
    this.kinds = new Set(inv.prefixes.has(root) || inv.suffixes.has(root) ? ["R", "W", "P", "S"] : ["R", "W"]);
  }

  /**
   * The strings the index is asked for: the root, or for a two-letter one
   * (a trigram needs three) the root before a vowel, and the members' words
   * where a consonant follows it (ulkapo).
   */
  phrases(): string[] {
    if (this.root.length >= 3) return [this.root];
    const out = new Set([..."aeiou"].map((vowel) => this.root + vowel));
    for (const [form, { rootAt }] of this.forms) {
      const next = form.slice(rootAt + this.root.length, rootAt + this.root.length + 1);
      if (next && !"aeiou".includes(next)) out.add(this.root + next);
      else if (!next && rootAt > 0) out.add(form.slice(rootAt - 1, rootAt) + this.root);
    }
    return [...out];
  }

  /** Whether a sentence is in a member entry. */
  inMember(id: number): boolean {
    let lo = 0, hi = this.ranges.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const [first, last] = this.ranges[mid];
      if (id < first) hi = mid - 1;
      else if (id > last) lo = mid + 1;
      else return true;
    }
    return false;
  }

  /** The family's words in a text. */
  matches(text: string): ExampleMatch[] {
    const out: ExampleMatch[] = [];
    for (const w of text.matchAll(WORD)) {
      const word = w[0].toLowerCase();
      // a shorter word has no trigram: the index cannot have found the sentence by it
      if (word.length < 3 || !word.includes(this.root)) continue;
      const elided = APOSTROPHES.includes(text.charAt(w.index + w[0].length));
      const key = elided ? `${word}'` : word;
      let verdict = this.verdicts.get(key);
      if (verdict === undefined) this.verdicts.set(key, (verdict = this.judge(word, elided)));
      if (verdict) out.push({ root: this.root, at: w.index, length: w[0].length, ...verdict, rootAt: w.index + verdict.rootAt });
    }
    return out;
  }

  /** Whether a word is the family's: a member's form, or split with the root in it. */
  private judge(word: string, elided: boolean): Verdict | null {
    const form = this.forms.get(word)
      ?? lemmaCandidates(word).map((c) => this.forms.get(c.lemma)).find((f) => f && word.startsWith(this.root, f.rootAt))
      ?? (elided ? this.forms.get(`${word}o`) : undefined);
    if (form) return form;
    const rootAt = this.splitAt(elided ? `${word}o` : word);
    return rootAt >= 0 && word.startsWith(this.root, rootAt) ? { rootAt } : null;
  }

  /** Where the inventory's split of a word has the root, or -1. */
  private splitAt(word: string): number {
    let off = 0;
    for (const m of splitOf(word, this.inv)) {
      if (m.m === this.root && this.kinds.has(m.k)) return off;
      off += m.m.length;
    }
    return -1;
  }
}

/** Splits of example words, kept for the next family: splitting is most of an example scan's time. */
const splits = new WeakMap<Inventory, Map<string, Morph[]>>();
const SPLITS_KEPT = 100_000;

function splitOf(word: string, inv: Inventory): Morph[] {
  let known = splits.get(inv);
  if (!known) splits.set(inv, (known = new Map()));
  let ms = known.get(word);
  if (!ms) {
    if (known.size >= SPLITS_KEPT) known.clear();
    known.set(word, (ms = segment(word, inv) ?? []));
  }
  return ms;
}

/**
 * The example sentences that use the families of `roots`, a group per root in
 * that order. A sentence is in the group of the first root it uses and lists
 * the words of every root. Sentences in the family's own entries come first,
 * then the rest in document order.
 */
export function familyExamples(db: SqlReader, roots: string[], opts: FamilyExamplesOptions = {}): FamilyExamplesResult {
  if (!hasTable(db, "x_family") || !hasPass(db, "examples")) return { available: false, groups: [] };
  const { limit = 200, offset = 0, exactTotal = true } = opts;
  const only = opts.only === undefined ? undefined : normalizeRoot(opts.only);
  const wanted = [...new Set(roots.map(normalizeRoot))].filter((root) => /^\p{L}{2,}$/u.test(root));
  const inv = inventoryOf(db);
  const matchers = wanted.map((root) => new FamilyMatcher(db, root, inv));
  const skip = opts.mark ? entryNodeByMark(db, opts.mark) : null;
  const languages = opts.languages && [...new Set(opts.languages.filter((language) => language !== "eo"))];

  // A sentence quoted in several articles is listed once, and not at all when the entry shows it.
  const told = new Set(skip
    ? db.query<{ ekz_md: string }, [number, number]>("SELECT ekz_md FROM ekzemplo WHERE rowid BETWEEN ? AND ?")
      .all(skip.id, skip.last_id).map((r) => sentenceKey(r.ekz_md))
    : []);

  const groups: FamilyExampleGroup[] = [];
  matchers.forEach((matcher, i) => {
    const seen = new Set(told);
    if (only !== undefined && matcher.root !== only) return;
    const candidates = db
      .query<{ rowid: number }, [string]>("SELECT rowid FROM fts_ekz WHERE fts_ekz MATCH ? ORDER BY rowid")
      .all(matcher.phrases().map(trigramMatch).join(" OR "))
      .map((r) => r.rowid)
      .filter((id) => !skip || id < skip.id || id > skip.last_id);
    const ordered = [...candidates.filter((id) => matcher.inMember(id)), ...candidates.filter((id) => !matcher.inMember(id))];

    const group: FamilyExampleGroup = { root: matcher.root, examples: [], total: 0, totalExact: true, candidates: candidates.length, offset };
    let found = 0;
    scan: for (let c = 0; c < ordered.length; c += CHUNK) {
      const ids = ordered.slice(c, c + CHUNK);
      const rows = new Map(db
        .query<ExampleRow, number[]>(
          `SELECT rowid, art, drv_mrk, sense_mrk, ekz_md, last_id, trd, kap FROM ekzemplo
            WHERE rowid IN (${ids.map(() => "?").join(",")})`)
        .all(...ids)
        .map((r) => [r.rowid, r]));
      for (const id of ids) {
        const row = rows.get(id)!;
        if (matcher.matches(row.ekz_md).length === 0) continue;
        if (matchers.slice(0, i).some((earlier) => earlier.matches(row.ekz_md).length > 0)) continue;
        const key = sentenceKey(row.ekz_md);
        if (seen.has(key)) continue;
        seen.add(key);
        if (found >= offset && found < offset + limit) {
          group.examples.push({
            id,
            text: row.ekz_md,
            article: row.art,
            headword: row.kap ?? row.drv_mrk,
            ...(IS_ENTRY_MARK.test(row.drv_mrk) ? { mrk: row.drv_mrk } : {}),
            ...(row.sense_mrk ? { senseMrk: row.sense_mrk } : {}),
            memberEntry: matcher.inMember(id),
            matches: matchers.flatMap((m) => m.matches(row.ekz_md)).sort((a, b) => a.at - b.at || a.rootAt - b.rootAt),
            translations: row.trd > 0 ? exampleTranslations(db, row, languages) : [],
          });
        }
        found++;
        if (!exactTotal && found >= offset + limit) {
          group.totalExact = c + CHUNK >= ordered.length && id === ids[ids.length - 1];
          break scan;
        }
      }
    }
    group.total = group.totalExact ? found : candidates.length;
    groups.push(group);
  });
  return { available: true, groups };
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
