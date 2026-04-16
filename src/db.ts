/**
 * Database connection and query functions for the Revo dictionary.
 *
 * Queries the pre-built revo.db (augmented with FTS5 indexes by setup.ts).
 * Supports:
 * - Esperanto headword lookup (exact, prefix, stemmed, FTS)
 * - Translation lookup by language (exact, FTS)
 * - Cross-language search
 */

import { Database } from "bun:sqlite";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { generateStems, normalizeQuery, fromXSystem, hasXSystem } from "./stemmer";
import { extractArticle, extractByMrk, type DrvEntry } from "./html-extract";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, "..", "data", "revo.db");

export interface NodoRow {
  mrk: string;
  art: string;
  kap: string;
  num: string | null;
}

export interface TradukoRow {
  mrk: string;
  lng: string;
  trd: string;
  txt: string | null;
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
  if (!_db) {
    _db = new Database(DB_PATH, { readonly: true });
    _db.exec("PRAGMA cache_size = -64000"); // 64MB cache
  }
  return _db;
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
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

  // 3. Stemmed matches
  const stems = generateStems(normalized);
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
      "SELECT mrk, lng, trd, txt FROM traduko WHERE lng = ? AND trd = ? COLLATE NOCASE LIMIT 50"
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
              "SELECT mrk, lng, trd, txt FROM traduko WHERE rowid = ? AND lng = ?"
            )
            .get(rowid, lang);
          if (row) trds.push(row);
        }
      }
    } catch {
      // FTS query might fail — ignore
    }
  }

  if (trds.length === 0) {
    // 3. LIKE partial match
    trds = db
      .query<TradukoRow, [string, string]>(
        "SELECT mrk, lng, trd, txt FROM traduko WHERE lng = ? AND trd LIKE '%' || ? || '%' COLLATE NOCASE LIMIT 50"
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
    const matched = trds.find((t) => t.mrk === r.mrk);
    r.matchedVia = `translation:${lang}:${matched?.trd ?? query}`;
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
      "SELECT mrk, lng, trd, txt FROM traduko WHERE trd = ? COLLATE NOCASE LIMIT 100"
    )
    .all(normalized);

  if (trds.length === 0) {
    // FTS fallback
    try {
      trds = db
        .query<TradukoRow, [string]>(
          `SELECT t.mrk, t.lng, t.trd, t.txt
           FROM fts_trd f
           JOIN traduko t ON f.rowid = t.rowid
           WHERE f.trd MATCH '"' || ? || '"'
           LIMIT 100`
        )
        .all(normalized);
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
    const matched = trds.find((t) => t.mrk === r.mrk);
    r.matchedVia = `translation:${matched?.lng ?? "?"}:${matched?.trd ?? query}`;
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

    // Fetch article HTML
    const artRow = db
      .query<{ txt: Buffer }, [string]>(
        "SELECT txt FROM artikolo WHERE mrk = ?"
      )
      .get(node.art);

    let senses: LookupResult["senses"] = [];
    if (artRow?.txt) {
      const entry = extractByMrk(artRow.txt, drvMrk, node.art);
      if (entry) {
        senses = entry.senses;
      }
    }

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
        "SELECT DISTINCT uzo FROM uzo WHERE mrk = ? OR (mrk >= ? || '.' AND mrk < ? || '/')"
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
  root: string; // resolved root mrk (e.g. "rav")
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

  // 1. Try treating input as a bare root (exists in artikolo)
  let root: string | null = null;
  const artRow = db
    .query<{ mrk: string }, [string]>("SELECT mrk FROM artikolo WHERE mrk = ?")
    .get(normalized);
  if (artRow) {
    root = artRow.mrk;
  }

  // 2. Try as a word form — look up its article
  if (!root) {
    const nodoRow = db
      .query<{ art: string }, [string]>(
        "SELECT art FROM nodo WHERE lower(kap) = ? LIMIT 1"
      )
      .get(normalized);
    if (nodoRow) root = nodoRow.art;
  }

  // 3. Try stemming
  if (!root) {
    for (const stem of generateStems(normalized)) {
      const nodoRow = db
        .query<{ art: string }, [string]>(
          "SELECT art FROM nodo WHERE lower(kap) = ? LIMIT 1"
        )
        .get(stem);
      if (nodoRow) {
        root = nodoRow.art;
        break;
      }
    }
  }

  if (!root) return null;

  // Get all derivation-level members
  const members = db
    .query<{ mrk: string; kap: string }, [string]>(
      `SELECT DISTINCT mrk, kap FROM nodo
       WHERE art = ? AND instr(mrk, '.') > 0
       ORDER BY mrk`
    )
    .all(root);

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
      "SELECT lng, COUNT(*) as count FROM traduko GROUP BY lng ORDER BY count DESC"
    )
    .all();
}
