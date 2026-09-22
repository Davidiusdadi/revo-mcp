/**
 * Database connection and query functions for the Revo dictionary.
 *
 * Queries the corpus `pnpm db:setup` builds from the VOKO XML (data/voko.db).
 * Words are found through the search pass's `serĉo` rows and entries read as
 * node ranges (db-voko.ts); the FTS indexes the `fts` pass writes are a
 * fallback where the database has them. Supports:
 * - Esperanto headword lookup (exact, variant, stemmed, prefix, FTS)
 * - Translation lookup by language (exact, FTS, partial)
 * - Cross-language search
 */

import type { SqlReader } from "./sql";
import { generateStems, normalizeQuery, fromXSystem, hasXSystem } from "./stemmer";
import { lemmaCandidates } from "./morph";
import { glossEsperanto, glossSource, type EoGloss, type GlossOptions, type SourceGloss } from "./gloss";
import {
  SCHEMA_VERSION,
  IS_ENTRY,
  isVokoDb,
  schemaVersionOf,
  hasPass as hasPassIn,
  hasTable,
  requirePasses,
  trigramMatch,
  exactRows,
  prefixRows,
  spelled,
  indexForm,
  entryNodesById,
  entryNodeByMark,
  assembleEntry,
  translationsOf,
  thesaurusOf,
  searchDefinitions as searchDefinitionsIn,
  type EntryNode,
  type EntryOptions,
  type LookupResult,
  type SearchRow,
  type Translation,
  type ThesaurusResult,
  type DefinitionHit,
} from "./db-voko";

export type { LookupResult, Translation } from "./db-voko";

let _db: SqlReader | null = null;
let _databaseFactory: (() => SqlReader) | null = null;

export function configureDatabase(database: SqlReader): void {
  let problem: string | null = null;
  if (!isVokoDb(database)) {
    problem = "is not an XML-built corpus (meta.schema is not 'voko')";
  } else if (schemaVersionOf(database) < SCHEMA_VERSION) {
    problem = `has schema version ${schemaVersionOf(database)}; this server reads version ${SCHEMA_VERSION}`;
  }
  if (problem) {
    database.close();
    throw new Error(`The configured database ${problem}. Run \`pnpm db:setup\` to build data/voko.db.`);
  }
  if (_db && _db !== database) _db.close();
  _db = database;
}

export function configureDatabaseFactory(factory: () => SqlReader): void {
  _databaseFactory = factory;
}

export function getDb(): SqlReader {
  if (!_db && _databaseFactory) configureDatabase(_databaseFactory());
  if (!_db) throw new Error("Dictionary database has not been configured for this runtime.");
  return _db;
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

/** Whether the configured database was built with an enrichment pass. */
export function hasPass(name: string): boolean {
  return hasPassIn(getDb(), name);
}

/** Reference graph around a word, grouped by relation. */
export function lookupThesaurus(word: string): ThesaurusResult | null {
  return thesaurusOf(getDb(), word);
}

/**
 * Bulk gloss of a whole text: source language in for an Esperanto glossary,
 * `lang: "eo"` in for an audit of an Esperanto draft.
 */
export function glossText(text: string, opts: GlossOptions = {}): SourceGloss | EoGloss {
  const db = getDb();
  // an Esperanto gloss reads the morph tables, which the core stage carries; a
  // source-language one matches translations through the index pass's key
  if ((opts.lang ?? "en") === "eo") {
    requirePasses(db, "Gloss", ["morph"]);
    return glossEsperanto(db, text, opts);
  }
  requirePasses(db, "Gloss", ["index"]);
  return glossSource(db, text, opts);
}

/** Reverse dictionary: words whose definition matches a description (voko.db only). */
export function searchDefinitions(query: string, limit: number = 20): DefinitionHit[] {
  return searchDefinitionsIn(getDb(), query, limit);
}

/**
 * Full entries for search rows, one per entry in the rows' order (or `order`,
 * which sees only what names an entry), until the limit. `via` names how an
 * entry was found.
 */
function resultsOf(
  db: SqlReader,
  rows: SearchRow[],
  limit: number,
  { order, via }: { order?: (a: EntryNode, b: EntryNode) => number; via?: (nid: number) => string } = {},
): LookupResult[] {
  const ids = [...new Set(rows.map((row) => row.nid))];
  const nodes = entryNodesById(db, order ? ids : ids.slice(0, limit));
  const listed = ids.flatMap((id) => nodes.get(id) ?? []);
  if (order) listed.sort(order);
  return listed.slice(0, limit).map((node) => {
    const result = assembleEntry(db, node);
    if (via) result.matchedVia = via(node.id);
    return result;
  });
}

// Of several entries with one headword, the shorter mark is the plainer word
// ("bank.0o" before "bank.0o2"), as the lookup always listed them.
const shorterMark = (a: EntryNode, b: EntryNode) => a.mrk.length - b.mrk.length;

/** Rows that are the form itself rather than filed under it; else all of them. */
function directFirst(rows: SearchRow[]): SearchRow[] {
  const direct = rows.filter((row) => !row.ind);
  return direct.length > 0 ? direct : rows;
}

/**
 * Look up an Esperanto word. Tries in order:
 * 1. Exact match on a headword
 * 2. Exact match on a variant
 * 3. Stemmed matches (strip grammatical endings)
 * 4. Prefix match on headwords
 * 5. FTS5 prefix search, where the database has it
 */
export function lookupEsperanto(
  query: string,
  limit: number = 5
): LookupResult[] {
  const db = getDb();
  const normalized = normalizeQuery(query);

  if (normalized.length === 0) return [];

  // 1–2. Headwords, else variants
  const exact = exactRows(db, "eo", normalized);
  if (exact.length > 0) return resultsOf(db, directFirst(exact), limit, { order: shorterMark });

  // 3. Inflected forms: the ending says which dictionary form to look for
  //    (morph.ts); the older ending-stripping heuristic is the fallback.
  const stems = new Set([...lemmaCandidates(normalized).map((c) => c.lemma), ...generateStems(normalized)]);
  for (const stem of stems) {
    if (stem === normalized) continue; // Already tried
    const rows = exactRows(db, "eo", stem).filter((row) => !row.ind);
    if (rows.length > 0) return resultsOf(db, rows, limit, { order: shorterMark, via: () => `stem:${stem}` });
  }

  // 4. Prefix match, shortest headwords first
  const prefixed = prefixRows(db, "eo", normalized)
    .filter((row) => !row.ind)
    .sort((a, b) => a.norm.length - b.norm.length || a.ord - b.ord);
  if (prefixed.length > 0) return resultsOf(db, prefixed, limit, { via: () => `prefix:${normalized}` });

  // 5. FTS5 fallback
  if (!hasPassIn(db, "fts")) return [];
  try {
    const ftsRows = db
      .query<{ kap: string }, [string]>(
        `SELECT kap FROM fts_kap WHERE kap MATCH ? || '*' LIMIT 50`
      )
      .all(normalized);

    const kaps = [...new Set(ftsRows.map((r) => normalizeQuery(r.kap)))].slice(0, limit);
    const rows = kaps.flatMap((kap) => exactRows(db, "eo", kap));
    if (rows.length > 0) return resultsOf(db, rows, limit, { via: () => `fts:${normalized}` });
  } catch {
    // FTS query might fail with special characters — ignore
  }

  return [];
}

/** A translation row a lookup found, in whichever language. */
interface TranslationHit {
  lng: string;
  row: SearchRow;
}

// "translation:de:Hund" names what matched; a translation only filed under
// that index form also shows its full text, so an idiom
// ("translation:de:Hund (vor die Hunde gehen)") is not read as the word's
// meaning. Without an <ind> the two are the same text.
function translationVia({ lng, row }: TranslationHit): string {
  if (!row.ind) return `translation:${lng}:${spelled(row)}`;
  return `translation:${lng}:${indexForm(row.norm, row.txt)} (${spelled(row)})`;
}

/** One result per entry, named by the first hit that led to it. */
function translationResults(db: SqlReader, hits: TranslationHit[], limit: number): LookupResult[] {
  const firstHit = new Map<number, TranslationHit>();
  for (const hit of hits) if (!firstHit.has(hit.row.nid)) firstHit.set(hit.row.nid, hit);
  return resultsOf(db, hits.map((hit) => hit.row), limit, { via: (nid) => translationVia(firstHit.get(nid)!) });
}

/** The entry a node belongs to: itself or its nearest derivation ancestor that is one. */
function entryIdAt(db: SqlReader, nodeId: number): number | null {
  const step = db.query<{ id: number; parent_id: number | null; is_entry: number }, [number]>(
    `SELECT n.id, n.parent_id, COALESCE(${IS_ENTRY}, 0) AS is_entry FROM node n WHERE n.id = ?`,
  );
  for (let id: number | null = nodeId; id !== null; ) {
    const n = step.get(id);
    if (!n) return null;
    if (n.is_entry) return n.id;
    id = n.parent_id;
  }
  return null;
}

export function lookupTranslation(
  query: string,
  lang: string,
  limit: number = 5
): LookupResult[] {
  const db = getDb();
  const normalized = normalizeQuery(query);

  if (normalized.length === 0) return [];

  // 1. Exact match: a translation that is the word itself comes before one
  //    only filed under it ("Hund" before "vor die Hunde gehen"), which the
  //    rows' order already says.
  let hits: TranslationHit[] = exactRows(db, lang, normalized).map((row) => ({ lng: lang, row }));
  let matchKind: LookupResult["matchKind"] = hits.length > 0 ? "exact" : undefined;

  if (hits.length === 0 && hasPassIn(db, "fts")) {
    // 2. FTS match, mapped back to the entries' rows
    try {
      const ftsRows = db
        .query<{ node_id: number; lng: string; txt: string; ind: string | null }, [string, string]>(
          `SELECT t.node_id, t.lng, t.txt, t.ind FROM fts_trd f JOIN translation t ON t.id = f.rowid
            WHERE fts_trd MATCH '"' || ? || '"' AND t.lng = ? AND t.in_ekz = 0 LIMIT 100`
        )
        .all(normalized, lang);
      const found = ftsRows.flatMap((t) => {
        const nid = entryIdAt(db, t.node_id);
        const row: SearchRow = { norm: normalizeQuery(t.ind ?? t.txt), ord: 0, nid: nid ?? 0, txt: t.txt, ind: t.ind === null ? null : 1, fak: null };
        return nid === null ? [] : [{ lng: lang, row }];
      });
      hits = found.sort((a, b) => (a.row.ind ?? 0) - (b.row.ind ?? 0) || a.row.norm.length - b.row.norm.length);
      if (hits.length > 0) matchKind = "fts";
    } catch {
      // FTS query might fail — ignore
    }
  }

  if (hits.length === 0) {
    // 3. Partial match: the form contains the query
    hits = db
      .query<SearchRow, [string, string]>(
        `SELECT norm, ord, nid, txt, ind, fak FROM serĉo WHERE lng = ? AND instr(norm, ?) > 0
          ORDER BY ind IS NOT NULL, length(norm), ord LIMIT 50`
      )
      .all(lang, normalized)
      .map((row) => ({ lng: lang, row }));
    if (hits.length > 0) matchKind = "partial";
  }

  if (hits.length === 0) return [];

  const results = translationResults(db, hits, limit);
  for (const r of results) r.matchKind = matchKind;
  return results;
}

/** The translation languages, most translations first. */
function translationLanguages(db: SqlReader): string[] {
  return db
    .query<{ lng: string }, []>("SELECT lng FROM serĉo_lng WHERE lng <> 'eo' ORDER BY translations DESC, lng")
    .all()
    .map((r) => r.lng);
}

/**
 * Look up a word across all languages.
 */
export function lookupAllLanguages(
  query: string,
  limit: number = 5
): LookupResult[] {
  const db = getDb();
  const normalized = normalizeQuery(query);
  if (normalized.length === 0) return [];

  // Also try as Esperanto headword
  const eoResults = lookupEsperanto(query, limit);

  // The form in every language: direct translations before filed ones, then
  // the languages with the most translations.
  const hits = translationLanguages(db)
    .flatMap((lng, rank) => exactRows(db, lng, normalized).map((row) => ({ lng, row, rank })))
    .sort((a, b) => (a.row.ind ?? 0) - (b.row.ind ?? 0) || a.rank - b.rank || a.row.ord - b.row.ord)
    .slice(0, 100);
  const trdResults = translationResults(db, hits, limit);

  // Merge eo results + translation results, dedup by mrk
  const seen = new Set<string>();
  const merged: LookupResult[] = [];
  for (const r of [...eoResults, ...trdResults]) {
    if (!seen.has(r.mrk)) {
      seen.add(r.mrk);
      merged.push(r);
    }
  }
  return merged.slice(0, limit);
}

export interface WildcardMatch {
  kap: string;
  glosses: string[];
}

/**
 * Compact wildcard search: returns just headwords + all glosses in glossLang.
 * Used for discovery when * is in the query — fits hundreds of results in one response.
 *
 * Matches the Esperanto headword rows; a pattern with a literal start reads
 * only that range of them. Glosses are read for the page shown.
 */
export function lookupWildcardCompact(
  pattern: string,
  glossLang: string = "en",
  limit: number = 100,
  offset: number = 0
): { matches: WildcardMatch[]; total: number } {
  const db = getDb();
  // Match against the folded forms; the pattern is folded the same way.
  const folded = pattern.toLowerCase();
  const sqlPattern = folded.replace(/\*/g, "%");
  const start = folded.split("*")[0];

  const rows = db
    .query<SearchRow, [string, string, string]>(
      `SELECT norm, ord, nid, txt, ind, fak FROM serĉo
        WHERE lng = 'eo' AND ind IS NULL AND norm >= ? AND norm < ? AND norm LIKE ?`
    )
    .all(start, `${start}\u{10FFFF}`, sqlPattern);

  // One canonical entry per headword spelling: the first in the rows' order.
  const byKap = new Map<string, SearchRow>();
  for (const row of rows.sort((a, b) => a.ord - b.ord)) {
    const kap = spelled(row);
    if (!byKap.has(kap)) byKap.set(kap, row);
  }
  const headwords = [...byKap].sort(([a], [b]) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0));
  const total = headwords.length;
  const page = headwords.slice(offset, offset + limit);
  if (page.length === 0) return { matches: [], total };

  const nodes = entryNodesById(db, page.map(([, row]) => row.nid));
  const matches = page.map(([kap, row]) => {
    const node = nodes.get(row.nid);
    const glosses = node ? [...new Set(translationsOf(db, node, [glossLang]).map((t) => t.trd))] : [];
    return { kap, glosses };
  });

  return { matches, total };
}

/**
 * Canonical dictionary entries for known derivation marks, in the marks'
 * order; a sense's mark gives its derivation's entry.
 */
export function lookupMarks(mrks: string[], limit: number = mrks.length, options: EntryOptions = {}): LookupResult[] {
  if (mrks.length === 0 || limit <= 0) return [];
  const db = getDb();
  const results: LookupResult[] = [];
  const seen = new Set<number>();
  for (const mrk of mrks) {
    if (results.length >= limit) break;
    const node = entryNodeByMark(db, mrk);
    if (!node || seen.has(node.id)) continue;
    seen.add(node.id);
    results.push(assembleEntry(db, node, options));
  }
  return results;
}

export interface FamilyMember {
  headword: string;
  mrk: string;
  translations: Translation[];
}

export interface FamilyResult {
  root: string; // the root as the article writes it (e.g. "rav", "ĉeval")
  members: FamilyMember[];
}

/**
 * Look up all derived word forms belonging to the same Esperanto root.
 * Input may be a bare root (e.g. "rav") or any word form (e.g. "ravi").
 */
export function lookupFamily(query: string): FamilyResult | null {
  const db = getDb();
  const normalized = normalizeQuery(query);
  if (!normalized) return null;

  // The query is in real letters (normalizeQuery turns cx into ĉ), so it is
  // compared with real letters: the roots, lowercased, and the headwords'
  // folded forms. Not with the article's file name, which is in the x-system
  // (cxeval), nor through SQLite's lower(), which leaves Ĉ as it is.
  type ArtRow = { id: number; last_id: number; file: string; rad: string };

  // 1. Try treating input as a bare root: the morph pass lists every root;
  //    without it, the articles' own roots.
  let art: ArtRow | null | undefined = hasPassIn(db, "morph")
    ? db
        .query<ArtRow, [string]>(
          `SELECT a.id, a.last_id, a.file, a.rad FROM x_morpheme m JOIN article a ON a.id = m.article_id
            WHERE m.morph = ? AND m.kind = 'R' ORDER BY a.file LIMIT 1`
        )
        .get(normalized)
    : db
        .query<ArtRow, []>("SELECT id, last_id, file, rad FROM article ORDER BY file")
        .all()
        .find((a) => a.rad.toLowerCase() === normalized);

  // 2. Try as a word form — look up its article
  const artOfEntry = db.query<ArtRow, [number]>(
    "SELECT a.id, a.last_id, a.file, a.rad FROM node n JOIN article a ON a.id = n.article_id WHERE n.id = ?"
  );
  const byKap = (form: string) => {
    const row = exactRows(db, "eo", form).find((r) => !r.ind);
    return row ? artOfEntry.get(row.nid) : null;
  };
  if (!art) art = byKap(normalized);

  // 3. Inflected forms, as in lookupEsperanto: dictionary forms first, heuristic after
  if (!art) {
    const stems = new Set([...lemmaCandidates(normalized).map((c) => c.lemma), ...generateStems(normalized)]);
    for (const stem of stems) {
      art = byKap(stem);
      if (art) break;
    }
  }

  if (!art) return null;

  const entries = db
    .query<{ id: number; last_id: number; mrk: string; kap: string }, [number, number]>(
      `SELECT n.id, n.last_id, n.mrk, h.txt AS kap FROM node n JOIN headword h ON h.id = n.kap_id
        WHERE n.id BETWEEN ? AND ? AND ${IS_ENTRY} ORDER BY n.mrk`
    )
    .all(art.id, art.last_id);

  const members: FamilyMember[] = entries.map((e) => ({
    headword: e.kap,
    mrk: e.mrk,
    translations: translationsOf(db, e),
  }));

  return { root: art.rad, members };
}

/**
 * Get all available languages with their translation counts.
 */
export function getLanguages(): { lng: string; count: number }[] {
  // Counted by the search pass: translations outside example sentences, which
  // no lookup reaches.
  return getDb()
    .query<{ lng: string; count: number }, []>(
      "SELECT lng, translations AS count FROM serĉo_lng WHERE lng <> 'eo' ORDER BY translations DESC, lng"
    )
    .all();
}

export function getHeadwordCount(): number {
  return getDb().query<{ count: number }, []>(
    "SELECT entries AS count FROM serĉo_lng WHERE lng = 'eo'"
  ).get()?.count ?? 0;
}

export interface ExampleHit {
  art: string;
  drvMrk: string;
  senseMrk: string | null;
  headword: string;
  ekzMd: string;
  matchedVia: string;
}

/** Whether the configured database holds the example sentences (the core stage's `examples` pass). */
export function hasExamples(): boolean {
  return hasPassIn(getDb(), "examples");
}

/**
 * Search the pre-built example corpus for a word or phrase.
 *
 * Uses the trigram tokenizer, so matches are substring-based: 'ema' finds
 * 'manĝema', 'nulejo' finds 'malsanulejo'. A full build folds diacritics as
 * well (fts_ekz_fold), so 'songo' finds 'sonĝo' and 'cirkau' finds 'Ĉirkaŭ';
 * a core build folds case alone (fts_ekz). Minimum query length is 3
 * characters (FTS5 trigram requirement).
 */
export function searchExamples(query: string, limit: number = 20): ExampleHit[] {
  const db = getDb();
  requirePasses(db, "Example search", ["examples"]);
  const index = hasTable(db, "fts_ekz_fold") ? "fts_ekz_fold" : "fts_ekz";
  // Same normalization as normalizeQuery EXCEPT we preserve leading/trailing
  // whitespace so callers can use " word " as a word-boundary query under the
  // trigram tokenizer (spaces are tokenizable characters).
  let normalized = query;
  if (hasXSystem(normalized)) normalized = fromXSystem(normalized);
  normalized = normalized.toLowerCase();
  if (normalized.trim().length === 0) return [];
  if (normalized.length < 3) return [];

  // fts_ekz_fold, in a full build, matches the phrase and folds diacritics;
  // a core build's fts_ekz finds the trigrams, and the text is checked here
  const folded = index === "fts_ekz_fold";
  const rows = db
    .query<
      {
        art: string;
        drv_mrk: string;
        sense_mrk: string | null;
        ekz_md: string;
        headword: string | null;
      },
      [string, number]
    >(
      `SELECT e.art, e.drv_mrk, e.sense_mrk, e.ekz_md,
              e.kap AS headword
       FROM ${index} f
       JOIN ekzemplo e ON e.rowid = f.rowid
       WHERE ${index} MATCH ?
       ORDER BY rank
       LIMIT ?`
    )
    .all(folded ? `"${normalized.replace(/"/g, '""')}"` : trigramMatch(normalized), folded ? limit : limit * 2 + 20)
    .filter((row) => folded || row.ekz_md.toLowerCase().includes(normalized))
    .slice(0, limit);

  return rows.map((r) => ({
    art: r.art,
    drvMrk: r.drv_mrk,
    senseMrk: r.sense_mrk,
    ekzMd: r.ekz_md,
    headword: r.headword ?? r.drv_mrk,
    matchedVia: `example:${normalized}`,
  }));
}
