/**
 * Word families: every entry built on the roots of an entry, whichever article
 * files it.
 *
 * The `morph` pass keys `x_family` by root, so a family is one range of the
 * table (hundherbo, filed under herb, is in the range of hund). An entry has a
 * family per root of its headword (ĉashundo: hund and ĉas), its article's own
 * root first. A root that is also an affix (ulo, ino) lists the words that use
 * the affix too (malsanulejo under ul).
 */

import type { SqlReader } from "./sql";
import { entryNodeByMark, hasTable, translationsOf } from "./db-voko";
import { parseSpans } from "./morph";
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
