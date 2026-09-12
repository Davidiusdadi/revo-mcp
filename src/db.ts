/**
 * Database connection and query functions for the Revo dictionary.
 *
 * Queries the corpus `bun run setup` builds from the VOKO XML (data/voko.db):
 * the L2 tables through the compatibility views, and the FTS5 indexes the
 * `fts` pass writes. Supports:
 * - Esperanto headword lookup (exact, prefix, stemmed, FTS)
 * - Translation lookup by language (exact, FTS)
 * - Cross-language search
 */

import { Database } from "bun:sqlite";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { generateStems, normalizeQuery, fromXSystem, hasXSystem } from "./stemmer";
import { lemmaCandidates } from "./morph";
import {
  isVokoDb,
  sensesOf,
  thesaurusOf,
  searchDefinitions as searchDefinitionsIn,
  type ThesaurusResult,
  type DefinitionHit,
} from "./db-voko";

const __dirname = dirname(fileURLToPath(import.meta.url));
// The XML-built corpus is the database the server reads; `bun run setup`
// builds it. REVO_DB points at a different file (e.g. an older revo.db).
const DB_PATH = process.env.REVO_DB ?? join(__dirname, "..", "data", "voko.db");

export interface NodoRow {
  mrk: string;
  art: string;
  kap: string;
  num: string | null;
}

export interface TradukoRow {
  mrk: string;
  lng: string;
  /** the <ind> when the translation has one, else the whole translation */
  trd: string;
  /** the whole translation, pronunciation appended */
  txt: string;
  /** set when the translation is filed under an index form rather than being it */
  ind: string | null;
}

export interface LookupResult {
  headword: string;
  article: string;
  mrk: string;
  senses: {
    num?: string;
    definition: string;
    examples: string[];
    domain?: string;
  }[];
  translations: { lng: string; trd: string }[];
  crossRefs: { target: string; type: string; targetKap?: string }[];
  usageDomains: string[];
  matchedVia?: string; // How the result was found (e.g., "stem:amik", "translation:en:friend")
}

let _db: Database | null = null;

export function getDb(): Database {
  if (_db) return _db;
  // Opened into a local: a database that fails the check is closed again and
  // never cached, so every later call reports the same error instead of
  // handing out the rejected handle.
  const db = new Database(DB_PATH, { readonly: true });
  db.exec("PRAGMA cache_size = -64000"); // 64MB cache
  // Fail here rather than on a missing table further in: everything below
  // reads the XML-built schema (or the compat views over it).
  if (!isVokoDb(db)) {
    db.close();
    throw new Error(
      `${DB_PATH} is not an XML-built corpus (meta.schema is not 'voko'). ` +
        "Run `bun run setup` to build data/voko.db."
    );
  }
  _db = db;
  return _db;
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

/** Reference graph around a word, grouped by relation. */
export function lookupThesaurus(word: string): ThesaurusResult | null {
  return thesaurusOf(getDb(), word);
}

/** Reverse dictionary: words whose definition matches a description (voko.db only). */
export function searchDefinitions(query: string, limit: number = 20): DefinitionHit[] {
  return searchDefinitionsIn(getDb(), query, limit);
}

/**
 * Look up an Esperanto word. Tries in order:
 * 1. Exact match on nodo.kap
 * 2. Variant match on var.kap
 * 3. Stemmed matches (strip grammatical endings)
 * 4. FTS5 prefix search
 */
export function lookupEsperanto(
  query: string,
  limit: number = 5
): LookupResult[] {
  const db = getDb();
  let normalized = normalizeQuery(query);

  if (normalized.length === 0) return [];

  // 1. Exact match (uses idx_nodo_kap_norm; Unicode-aware via pre-folded column)
  let nodes = db
    .query<NodoRow, [string]>(
      "SELECT DISTINCT mrk, art, kap, num FROM nodo WHERE kap_norm = ? ORDER BY length(mrk)"
    )
    .all(normalized);

  if (nodes.length > 0) {
    return assembleResults(nodes, limit);
  }

  // 2. Variant match (uses idx_var_kap_norm)
  const variants = db
    .query<{ mrk: string; kap: string }, [string]>(
      "SELECT mrk, kap FROM var WHERE kap_norm = ?"
    )
    .all(normalized);

  if (variants.length > 0) {
    const mrks = variants.map((v) => v.mrk);
    nodes = db
      .query<NodoRow, []>(
        `SELECT DISTINCT mrk, art, kap, num FROM nodo WHERE mrk IN (${mrks
          .map(() => "?")
          .join(",")}) ORDER BY length(mrk)`
      )
      .all(...(mrks as []));

    if (nodes.length > 0) {
      return assembleResults(nodes, limit);
    }
  }

  // 3. Inflected forms: the ending says which dictionary form to look for
  //    (morph.ts); the older ending-stripping heuristic is the fallback.
  const stems = new Set([...lemmaCandidates(normalized).map((c) => c.lemma), ...generateStems(normalized)]);
  for (const stem of stems) {
    if (stem === normalized) continue; // Already tried
    nodes = db
      .query<NodoRow, [string]>(
        "SELECT DISTINCT mrk, art, kap, num FROM nodo WHERE kap_norm = ? ORDER BY length(mrk)"
      )
      .all(stem);

    if (nodes.length > 0) {
      const results = assembleResults(nodes, limit);
      for (const r of results) r.matchedVia = `stem:${stem}`;
      return results;
    }
  }

  // 4. Prefix match
  nodes = db
    .query<NodoRow, [string, number]>(
      "SELECT DISTINCT mrk, art, kap, num FROM nodo WHERE kap_norm LIKE ? || '%' ORDER BY length(kap), kap LIMIT ?"
    )
    .all(normalized, limit * 5);

  if (nodes.length > 0) {
    const results = assembleResults(nodes, limit);
    for (const r of results) r.matchedVia = `prefix:${normalized}`;
    return results;
  }

  // 5. FTS5 fallback
  try {
    const ftsRows = db
      .query<{ kap: string; rowid: number }, [string]>(
        `SELECT kap, rowid FROM fts_kap WHERE kap MATCH ? || '*' LIMIT ?`
      )
      .all(normalized);

    if (ftsRows.length > 0) {
      const kaps = [...new Set(ftsRows.map((r) => r.kap.toLowerCase()))];
      const allNodes: NodoRow[] = [];
      for (const kap of kaps.slice(0, limit)) {
        const n = db
          .query<NodoRow, [string]>(
            "SELECT DISTINCT mrk, art, kap, num FROM nodo WHERE kap_norm = ? ORDER BY length(mrk)"
          )
          .all(kap);
        allNodes.push(...n);
      }
      if (allNodes.length > 0) {
        const results = assembleResults(allNodes, limit);
        for (const r of results) r.matchedVia = `fts:${normalized}`;
        return results;
      }
    }
  } catch {
    // FTS query might fail with special characters — ignore
  }

  return [];
}

/**
 * Look up a word in a specific translation language.
 */
// ReVo files a translation under its <ind> headword, so a query also matches
// idioms that merely contain it: "Hund" finds hundo and "vor die Hunde gehen"
// (degradiĝi) alike. Without an order the older row won. A translation that is
// the searched word itself outranks one filed under it — that is exactly
// "has no <ind>" — and among the rest the shorter index form comes first.
const TRD_RANK = "ORDER BY (ind IS NULL) DESC, length(trd), rowid";

// The same order for rows gathered one by one (the FTS path).
function rankTrds(trds: TradukoRow[]): TradukoRow[] {
  const filed = (t: TradukoRow) => (t.ind === null ? 0 : 1);
  return trds.sort((a, b) => filed(a) - filed(b) || a.trd.length - b.trd.length);
}

// The translation row behind a result. Rows are keyed by the nearest marked
// node, often a sense ("degrad.0igxi.FIG"), while results carry the derivation
// ("degrad.0igxi"); trds is ranked, so the first fitting row is the best one.
function trdFor(trds: TradukoRow[], mrk: string): TradukoRow | undefined {
  return trds.find((t) => t.mrk === mrk || t.mrk.startsWith(mrk + "."));
}

// "translation:de:Hund" names what matched; a translation only filed under
// that index form also shows its full text, so an idiom
// ("translation:de:Hund (vor die Hunde gehen)") is not read as the word's
// meaning. Without an <ind> the two are the same text, pronunciation aside.
function translationVia(lng: string, t: TradukoRow | undefined, query: string): string {
  if (!t) return `translation:${lng}:${query}`;
  return `translation:${lng}:${t.trd}${t.ind === null ? "" : ` (${t.txt})`}`;
}

export function lookupTranslation(
  query: string,
  lang: string,
  limit: number = 5
): LookupResult[] {
  const db = getDb();
  const normalized = query.trim().toLowerCase();

  if (normalized.length === 0) return [];

  // 1. Exact match (uses idx_traduko_lng_trd COLLATE NOCASE on trd)
  let trds = db
    .query<TradukoRow, [string, string]>(
      `SELECT mrk, lng, trd, txt, ind FROM traduko WHERE lng = ? AND trd = ? COLLATE NOCASE ${TRD_RANK} LIMIT 50`
    )
    .all(lang, normalized);

  if (trds.length === 0) {
    // 2. FTS match
    try {
      const ftsRows = db
        .query<{ trd: string; rowid: number }, [string]>(
          `SELECT trd, rowid FROM fts_trd WHERE trd MATCH '"' || ? || '"' LIMIT 100`
        )
        .all(normalized);

      // Filter by language using the traduko table
      if (ftsRows.length > 0) {
        const rowids = ftsRows.map((r) => r.rowid);
        // Get matching traduko rows filtered by language
        for (const rowid of rowids) {
          const row = db
            .query<TradukoRow, [number, string]>(
              "SELECT mrk, lng, trd, txt, ind FROM traduko WHERE rowid = ? AND lng = ?"
            )
            .get(rowid, lang);
          if (row) trds.push(row);
        }
        trds = rankTrds(trds);
      }
    } catch {
      // FTS query might fail — ignore
    }
  }

  if (trds.length === 0) {
    // 3. LIKE partial match
    trds = db
      .query<TradukoRow, [string, string]>(
        `SELECT mrk, lng, trd, txt, ind FROM traduko WHERE lng = ? AND trd LIKE '%' || ? || '%' COLLATE NOCASE ${TRD_RANK} LIMIT 50`
      )
      .all(lang, normalized);
  }

  if (trds.length === 0) return [];

  // Get unique mrk values and look up the nodes
  const uniqueMrks = [...new Set(trds.map((t) => t.mrk))];
  const allNodes: NodoRow[] = [];
  for (const mrk of uniqueMrks.slice(0, limit * 3)) {
    const node = db
      .query<NodoRow, [string]>(
        "SELECT mrk, art, kap, num FROM nodo WHERE mrk = ?"
      )
      .get(mrk);
    if (node) allNodes.push(node);
  }

  const results = assembleResults(allNodes, limit);
  for (const r of results) {
    r.matchedVia = translationVia(lang, trdFor(trds, r.mrk), query);
  }
  return results;
}

/**
 * Look up a word across all languages.
 */
export function lookupAllLanguages(
  query: string,
  limit: number = 5
): LookupResult[] {
  const db = getDb();
  const normalized = query.trim().toLowerCase();

  // Also try as Esperanto headword
  const eoResults = lookupEsperanto(query, limit);

  // Search translations across all languages
  let trds = db
    .query<TradukoRow, [string]>(
      `SELECT mrk, lng, trd, txt, ind FROM traduko WHERE trd = ? COLLATE NOCASE ${TRD_RANK} LIMIT 100`
    )
    .all(normalized);

  if (trds.length === 0) {
    // FTS fallback
    try {
      trds = rankTrds(
        db
          .query<TradukoRow, [string]>(
            `SELECT t.mrk, t.lng, t.trd, t.txt, t.ind
             FROM fts_trd f
             JOIN traduko t ON f.rowid = t.rowid
             WHERE f.trd MATCH '"' || ? || '"'
             LIMIT 100`
          )
          .all(normalized)
      );
    } catch {
      // ignore FTS errors
    }
  }

  const uniqueMrks = [...new Set(trds.map((t) => t.mrk))];
  const allNodes: NodoRow[] = [];
  for (const mrk of uniqueMrks.slice(0, limit * 3)) {
    const node = db
      .query<NodoRow, [string]>(
        "SELECT mrk, art, kap, num FROM nodo WHERE mrk = ?"
      )
      .get(mrk);
    if (node) allNodes.push(node);
  }

  const trdResults = assembleResults(allNodes, limit);
  for (const r of trdResults) {
    const matched = trdFor(trds, r.mrk);
    r.matchedVia = translationVia(matched?.lng ?? "?", matched, query);
  }

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
 * Two-step for performance: (1) fetch matching headwords with a COLLATE NOCASE LIKE
 * (uses idx_nodo_kap, ~5ms), (2) batch-fetch all translations for those mrks via
 * idx_traduko_mrk (~25ms). Avoids the LEFT-JOIN-then-LIMIT trap that scanned all
 * 48K rows and ran ~18s in the prior implementation.
 */
export function lookupWildcardCompact(
  pattern: string,
  glossLang: string = "en",
  limit: number = 100,
  offset: number = 0
): { matches: WildcardMatch[]; total: number } {
  const db = getDb();
  // Match against the Unicode-folded column; pattern must be lowercased too.
  const sqlPattern = pattern.toLowerCase().replace(/\*/g, "%");

  const total = (db
    .query<{ c: number }, [string]>(
      `SELECT COUNT(DISTINCT kap) as c FROM nodo WHERE kap_norm LIKE ?`
    )
    .get(sqlPattern))?.c ?? 0;

  // Step 1: fetch matching headwords (one canonical mrk per kap).
  const headwords = db
    .query<{ kap: string; mrk: string }, [string, number, number]>(
      `SELECT kap, MIN(mrk) AS mrk FROM nodo
       WHERE kap_norm LIKE ?
       GROUP BY kap
       ORDER BY length(kap), kap
       LIMIT ? OFFSET ?`
    )
    .all(sqlPattern, limit, offset);

  if (headwords.length === 0) return { matches: [], total };

  // Step 2: batch-fetch all translations in glossLang for those mrks.
  const placeholders = headwords.map(() => "?").join(",");
  const mrks = headwords.map((h) => h.mrk);
  const glossRows = db
    .query<{ mrk: string; trd: string }, (string | string)[]>(
      `SELECT mrk, trd FROM traduko WHERE lng = ? AND mrk IN (${placeholders})`
    )
    .all(glossLang, ...mrks);

  const glossMap = new Map<string, string[]>();
  for (const row of glossRows) {
    let arr = glossMap.get(row.mrk);
    if (!arr) { arr = []; glossMap.set(row.mrk, arr); }
    arr.push(row.trd);
  }

  const matches = headwords.map((h) => ({
    kap: h.kap,
    glosses: glossMap.get(h.mrk) ?? [],
  }));

  return { matches, total };
}

/**
 * Wildcard search for Esperanto headwords (full rich results).
 * Use * as wildcard: '*ejo' (suffix), 'ej*' (prefix), '*ej*' (infix), 'l*ejo' (both).
 */
export function lookupWildcard(
  pattern: string,
  limit: number = 20
): LookupResult[] {
  const db = getDb();
  const sqlPattern = pattern.toLowerCase().replace(/\*/g, "%");

  const nodes = db
    .query<NodoRow, [string, string, number]>(
      `SELECT mrk, art, kap, num FROM (
         SELECT n.mrk, n.art, n.kap, n.num
         FROM nodo n
         WHERE n.kap_norm LIKE ?
         UNION
         SELECT n.mrk, n.art, n.kap, n.num
         FROM nodo n JOIN var v ON n.mrk = v.mrk
         WHERE v.kap_norm LIKE ?
       )
       ORDER BY length(kap), kap
       LIMIT ?`
    )
    .all(sqlPattern, sqlPattern, limit * 5);

  if (nodes.length === 0) return [];

  const results = assembleResults(nodes, limit);
  for (const r of results) r.matchedVia = `wildcard:${pattern}`;
  return results;
}

/**
 * Assemble full lookup results from matched nodo rows.
 * Groups by article, fetches definitions from HTML, translations, etc.
 */
function assembleResults(
  nodes: NodoRow[],
  limit: number
): LookupResult[] {
  const db = getDb();
  const results: LookupResult[] = [];

  // Group by derivation-level mrk (no dot-dot in mrk, or first two segments)
  const drvNodes = new Map<string, NodoRow>();
  for (const node of nodes) {
    const drvMrk = getDrvMrk(node.mrk);
    if (!drvNodes.has(drvMrk)) {
      drvNodes.set(drvMrk, node);
    }
  }

  for (const [drvMrk, node] of drvNodes) {
    if (results.length >= limit) break;

    // Senses, numbering and their examples come from the node/dif/ekz tables.
    const senses: LookupResult["senses"] = sensesOf(db, drvMrk);

    // Fetch translations for this mrk
    const translations = db
      .query<{ lng: string; trd: string }, [string]>(
        "SELECT lng, trd FROM traduko WHERE mrk = ? ORDER BY lng"
      )
      .all(drvMrk);

    // Also fetch translations at sense level. Using a range over the indexed
    // mrk column instead of LIKE — case-insensitive LIKE forces a full scan
    // of the 801K-row traduko table (~80ms vs ~0.02ms via the index).
    const senseTranslations = db
      .query<{ lng: string; trd: string; mrk: string }, [string, string]>(
        "SELECT lng, trd, mrk FROM traduko WHERE mrk >= ? || '.' AND mrk < ? || '/' ORDER BY lng"
      )
      .all(drvMrk, drvMrk);

    const allTranslations = [...translations, ...senseTranslations].map(
      (t) => ({
        lng: t.lng,
        trd: t.trd,
      })
    );

    // Fetch cross-references (range form — see senseTranslations note).
    const refs = db
      .query<{ cel: string; tip: string }, [string, string, string]>(
        "SELECT cel, tip FROM referenco WHERE mrk = ? OR (mrk >= ? || '.' AND mrk < ? || '/')"
      )
      .all(drvMrk, drvMrk, drvMrk);

    const crossRefs = refs.map((r) => {
      // Try to resolve target headword
      const targetNode = db
        .query<{ kap: string }, [string]>(
          "SELECT kap FROM nodo WHERE mrk = ?"
        )
        .get(r.cel);
      return {
        target: r.cel,
        type: r.tip,
        targetKap: targetNode?.kap,
      };
    });

    // Fetch usage domains (range form — see senseTranslations note).
    const uzoj = db
      .query<{ uzo: string }, [string, string, string]>(
        `SELECT DISTINCT uzo FROM uzo_compat WHERE mrk = ? OR (mrk >= ? || '.' AND mrk < ? || '/')`
      )
      .all(drvMrk, drvMrk, drvMrk);
    const usageDomains = uzoj.map((u) => u.uzo);

    results.push({
      headword: node.kap,
      article: node.art,
      mrk: drvMrk,
      senses,
      translations: allTranslations,
      crossRefs,
      usageDomains,
    });
  }

  return results;
}

/**
 * Extract the derivation-level mrk from a potentially sense-level mrk.
 * E.g., "amik.0o.KOMUNE" → "amik.0o"
 */
function getDrvMrk(mrk: string): string {
  const parts = mrk.split(".");
  if (parts.length <= 2) return mrk;
  return parts.slice(0, 2).join(".");
}

export interface FamilyMember {
  headword: string;
  mrk: string;
  translations: { lng: string; trd: string }[];
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
  // compared with real letters: the roots the morph pass lists lowercased, and
  // the headwords' kap_norm. Not with the article's file name, which is in the
  // x-system (cxeval), nor through SQLite's lower(), which leaves Ĉ as it is.
  type ArtRow = { file: string; rad: string };

  // 1. Try treating input as a bare root
  let art = db
    .query<ArtRow, [string]>(
      `SELECT a.file, a.rad FROM x_morpheme m JOIN art a ON a.id = m.art_id
        WHERE m.morph = ? AND m.kind = 'R' ORDER BY a.file LIMIT 1`
    )
    .get(normalized);

  // 2. Try as a word form — look up its article
  const byKap = db.query<ArtRow, [string]>(
    "SELECT a.file, a.rad FROM nodo n JOIN art a ON a.file = n.art WHERE n.kap_norm = ? LIMIT 1"
  );
  if (!art) art = byKap.get(normalized);

  // 3. Inflected forms, as in lookupEsperanto: dictionary forms first, heuristic after
  if (!art) {
    const stems = new Set([...lemmaCandidates(normalized).map((c) => c.lemma), ...generateStems(normalized)]);
    for (const stem of stems) {
      art = byKap.get(stem);
      if (art) break;
    }
  }

  if (!art) return null;
  const root = art.rad;

  // Get all derivation-level members
  const members = db
    .query<{ mrk: string; kap: string }, [string]>(
      `SELECT DISTINCT mrk, kap FROM nodo
       WHERE art = ? AND instr(mrk, '.') > 0
       ORDER BY mrk`
    )
    .all(art.file);

  // Deduplicate to drv-level mrks (strip sense suffixes like .1, .2)
  const seen = new Set<string>();
  const drvMembers: { mrk: string; kap: string }[] = [];
  for (const m of members) {
    const drvMrk = m.mrk.split(".").slice(0, 2).join(".");
    if (!seen.has(drvMrk)) {
      seen.add(drvMrk);
      drvMembers.push({ mrk: drvMrk, kap: m.kap });
    }
  }

  const result: FamilyMember[] = drvMembers.map(({ mrk, kap }) => {
    const trds = db
      .query<{ lng: string; trd: string }, [string, string, string]>(
        "SELECT lng, trd FROM traduko WHERE mrk = ? OR (mrk >= ? || '.' AND mrk < ? || '/') ORDER BY lng"
      )
      .all(mrk, mrk, mrk);
    return { headword: kap, mrk, translations: trds };
  });

  return { root, members: result };
}

/**
 * Get all available languages with their translation counts.
 */
export function getLanguages(): { lng: string; count: number }[] {
  const db = getDb();
  return db
    .query<{ lng: string; count: number }, []>(
      // Counted on trd rather than through the traduko view, whose join costs
      // ~4 s. The view's other condition has to be repeated here, though:
      // translations of example sentences are 12,143 rows that no lookup
      // reaches. What is left out are the ~8 rows under no marked node.
      `SELECT lng, COUNT(*) as count FROM trd WHERE owner_kind <> 'ekz'
        GROUP BY lng ORDER BY count DESC`
    )
    .all();
}

export interface ExampleHit {
  art: string;
  drvMrk: string;
  senseMrk: string | null;
  headword: string;
  ekzMd: string;
  matchedVia: string;
}

/**
 * Search the pre-built example corpus (fts_ekz) for a word or phrase.
 *
 * Uses the trigram tokenizer, so matches are substring-based: 'ema' finds
 * 'manĝema', 'nulejo' finds 'malsanulejo'. Diacritics are folded, so
 * 'songo' finds 'sonĝo' and 'cirkau' finds 'Ĉirkaŭ'. Minimum query length
 * is 3 characters (FTS5 trigram requirement).
 */
export function searchExamples(query: string, limit: number = 20): ExampleHit[] {
  const db = getDb();
  // Same normalization as normalizeQuery EXCEPT we preserve leading/trailing
  // whitespace so callers can use " word " as a word-boundary query under the
  // trigram tokenizer (spaces are tokenizable characters).
  let normalized = query;
  if (hasXSystem(normalized)) normalized = fromXSystem(normalized);
  normalized = normalized.toLowerCase();
  if (normalized.trim().length === 0) return [];
  if (normalized.length < 3) return [];

  const escapedPhrase = normalized.replace(/"/g, '""');
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
              (SELECT kap FROM nodo n WHERE n.mrk = e.drv_mrk LIMIT 1) AS headword
       FROM fts_ekz
       JOIN ekzemplo e ON e.rowid = fts_ekz.rowid
       WHERE fts_ekz MATCH ?
       ORDER BY rank
       LIMIT ?`
    )
    .all(`"${escapedPhrase}"`, limit);

  return rows.map((r) => ({
    art: r.art,
    drvMrk: r.drv_mrk,
    senseMrk: r.sense_mrk,
    ekzMd: r.ekz_md,
    headword: r.headword ?? r.drv_mrk,
    matchedVia: `example:${normalized}`,
  }));
}
