/**
 * Reads that go at the XML-built schema directly (data/voko.db).
 *
 * Words are found through the search pass's `serĉo` rows, clustered by
 * language and folded form. An entry is a derivation with a mark; node ids are
 * preorder, so everything under it is the one range id..last_id, and its
 * translations, references, domains and senses are each one range scan
 * instead of a walk. The L3 enrichment reads at the bottom of the file need
 * passes a core database is built without; hasPass tells them apart.
 */

import type { SqlReader } from "./sql";
import { generateStems, normalizeQuery } from "./stemmer";
import { lemmaCandidates } from "./morph";

/** Version 2: no stored XML, node.last_id, the search pass's tables. */
export const SCHEMA_VERSION = 2;

/** One sense of a derivation, as `lookup` renders it under a headword. */
export interface SenseEntry {
  mrk?: string;
  num?: string;
  definition: string;
  examples: string[];
  domain?: string;
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
  matchKind?: "exact" | "fts" | "partial";
}

export function isVokoDb(db: SqlReader): boolean {
  try {
    const row = db
      .query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'schema'")
      .get();
    return row?.value === "voko";
  } catch {
    return false; // upstream revo.db has no meta table
  }
}

export function schemaVersionOf(db: SqlReader): number {
  const row = db
    .query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'schema_version'")
    .get();
  return Number(row?.value ?? 1);
}

const passesByDb = new WeakMap<SqlReader, Set<string>>();

/** Whether the database was built with a pass (meta_pass); a core database has only `search`. */
export function hasPass(db: SqlReader, name: string): boolean {
  let passes = passesByDb.get(db);
  if (!passes) {
    passes = new Set(db.query<{ pass: string }, []>("SELECT pass FROM meta_pass").all().map((r) => r.pass));
    passesByDb.set(db, passes);
  }
  return passes.has(name);
}

/** Refuses a read the database cannot answer, naming what it lacks. */
export function requirePasses(db: SqlReader, what: string, passes: string[]): void {
  const missing = passes.filter((pass) => !hasPass(db, pass));
  if (missing.length === 0) return;
  throw new Error(
    `${what} needs the ${missing.join(", ")} pass${missing.length > 1 ? "es" : ""}, which this database ` +
      "was built without (a core build). Build the full stage with `bun run corpus:build`.",
  );
}

// ---------------------------------------------------------------------------
// Search rows
// ---------------------------------------------------------------------------

export interface SearchRow {
  /** the folded form (normalizeQuery) the row is filed under */
  norm: string;
  /** place among the language's rows: form, direct before filed, headword */
  ord: number;
  /** the entry's derivation node */
  nid: number;
  /** as written, when that is not norm; a filed translation's whole expression */
  txt: string | null;
  /** 1 when the row is only filed under norm: a translation's <ind>, a headword's variant */
  ind: number | null;
  /** the entry's usage domains, space-separated */
  fak: string | null;
}

const SEARCH_ROW = "SELECT norm, ord, nid, txt, ind, fak FROM serĉo";

/** A language's rows filed under exactly this form, in their order. */
export function exactRows(db: SqlReader, lng: string, norm: string): SearchRow[] {
  return db.query<SearchRow, [string, string]>(`${SEARCH_ROW} WHERE lng = ? AND norm = ? ORDER BY ord`).all(lng, norm);
}

/**
 * A language's rows whose form starts with the prefix: one contiguous range of
 * the table. U+10FFFF sorts after every character a form continues with.
 */
export function prefixRows(db: SqlReader, lng: string, prefix: string): SearchRow[] {
  return db
    .query<SearchRow, [string, string, string]>(`${SEARCH_ROW} WHERE lng = ? AND norm >= ? AND norm < ?`)
    .all(lng, prefix, `${prefix}\u{10FFFF}`)
    .sort((a, b) => a.ord - b.ord);
}

/** The spelling a row stands for: as written, else its folded form. */
export function spelled(row: { norm: string; txt: string | null }): string {
  return row.txt ?? row.norm;
}

/** The index form as ReVo wrote it inside a filed translation, when it is there. */
export function indexForm(key: string, expression: string | null): string {
  const lower = expression?.toLowerCase();
  const start = lower?.indexOf(key) ?? -1;
  return start >= 0 && lower!.length === expression!.length ? expression!.slice(start, start + key.length) : key;
}

// ---------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------

/** The derivation node an entry is, with what names it. */
export interface EntryNode {
  id: number;
  last_id: number;
  mrk: string;
  headword: string;
  article: string;
}

const ENTRY_NODE = `SELECT n.id, n.last_id, n.mrk, k.txt AS headword, a.file AS article
  FROM node n JOIN kap k ON k.id = n.kap_id JOIN art a ON a.id = n.art_id`;
/** An entry's node: a derivation whose mark has exactly one dot ("hund.0o"). */
export const IS_ENTRY = "n.kind = 'drv' AND instr(n.mrk, '.') > 0 AND n.mrk NOT GLOB '*.*.*'";

export function entryNodesById(db: SqlReader, ids: number[]): Map<number, EntryNode> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const rows = db
    .query<EntryNode, number[]>(`${ENTRY_NODE} WHERE n.id IN (${unique.map(() => "?").join(",")})`)
    .all(...unique);
  return new Map(rows.map((row) => [row.id, row]));
}

/** The entry a mark names; a sense's mark ("amik.0o.KOMUNE") names its derivation's. */
export function entryNodeByMark(db: SqlReader, mark: string): EntryNode | null {
  const drv = mark.split(".").slice(0, 2).join(".");
  return db.query<EntryNode, [string]>(`${ENTRY_NODE} WHERE n.mrk = ? AND ${IS_ENTRY} LIMIT 1`).get(drv);
}

export interface EntryOptions {
  /** "summary": what a result card shows, without senses and references */
  detail?: "full" | "summary";
  /** the translation languages to include; all of them when omitted */
  languages?: string[];
  /** usage domains already known, as the search rows carry them */
  domains?: string[];
}

/**
 * An entry's translations outside examples, by language: the derivation's own
 * first, then its senses' in reading order. `trd` is the index form when the
 * translation is filed under one, as upstream lists it.
 */
export function translationsOf(
  db: SqlReader,
  node: { id: number; last_id: number },
  languages?: string[],
): { lng: string; trd: string }[] {
  if (languages?.length === 0) return [];
  // `+lng`: the entry's node range is the narrow index; a full build's
  // idx_trd_lng_key would otherwise scan a whole language.
  const only = languages ? ` AND +lng IN (${languages.map(() => "?").join(",")})` : "";
  return db
    .query<{ lng: string; trd: string }, unknown[]>(
      `SELECT lng, COALESCE(ind, txt) AS trd FROM trd
        WHERE node_id BETWEEN ? AND ? AND owner_kind <> 'ekz'${only}
        ORDER BY lng, node_id <> ?, id`,
    )
    .all(node.id, node.last_id, ...(languages ?? []), node.id);
}

/** An entry's usage domains (fak and stl tags outside examples), in document order. */
export function usageDomainsOf(db: SqlReader, node: { id: number; last_id: number }): string[] {
  const tags = db
    .query<{ txt: string }, [number, number]>(
      `SELECT txt FROM uzo WHERE node_id BETWEEN ? AND ? AND tip IN ('fak', 'stl') AND owner_kind <> 'ekz' ORDER BY id`,
    )
    .all(node.id, node.last_id);
  return [...new Set(tags.map((t) => t.txt))];
}

export function assembleEntry(db: SqlReader, node: EntryNode, options: EntryOptions = {}): LookupResult {
  const full = (options.detail ?? "full") === "full";
  const crossRefs = full
    ? db
        .query<{ target: string; type: string; targetKap: string | null }, [number, number]>(
          `SELECT r.cel AS target, COALESCE(r.tip, '') AS type,
                  (SELECT k.txt FROM node t JOIN kap k ON k.id = t.kap_id
                    WHERE t.mrk = r.cel AND t.kind <> 'art' LIMIT 1) AS targetKap
             FROM ref r WHERE r.node_id BETWEEN ? AND ? ORDER BY r.id`,
        )
        .all(node.id, node.last_id)
        .map(({ target, type, targetKap }) => (targetKap === null ? { target, type } : { target, type, targetKap }))
    : [];
  return {
    headword: node.headword,
    article: node.article,
    mrk: node.mrk,
    senses: full ? sensesOf(db, node) : [],
    translations: translationsOf(db, node, options.languages),
    crossRefs,
    usageDomains: options.domains ?? usageDomainsOf(db, node),
  };
}

interface SenseNode {
  id: number;
  parent_id: number;
  kind: string;
  mrk: string | null;
}

/** Rows of a node range grouped by node, keeping their order. */
function byNode<Row extends { node_id: number }>(rows: Row[]): Map<number, Row[]> {
  const grouped = new Map<number, Row[]>();
  for (const row of rows) {
    const list = grouped.get(row.node_id);
    if (list) list.push(row);
    else grouped.set(row.node_id, [row]);
  }
  return grouped;
}

/**
 * Senses of a derivation, in document order. Numbering follows the ReVo
 * rendering: snc "1." "2." (unnumbered when alone), subsnc "a)" "b)",
 * subdrv "A." "B.". Each sense carries only its own examples — a subsnc's
 * examples are listed under the subsnc, not repeated under its parent snc.
 * Definitions, examples and domains are read once each for the whole range.
 */
export function sensesOf(db: SqlReader, root: { id: number; last_id: number; mrk: string }): SenseEntry[] {
  const range = [root.id, root.last_id] as [number, number];
  const nodes = db
    .query<SenseNode, [number, number]>(
      "SELECT id, parent_id, kind, mrk FROM node WHERE id > ? AND id <= ? ORDER BY id",
    )
    .all(...range);
  const difs = byNode(db
    .query<{ node_id: number; txt: string }, [number, number]>(
      "SELECT node_id, txt FROM dif WHERE node_id BETWEEN ? AND ? ORDER BY node_id, ord",
    )
    .all(...range));
  // No <dif>: the sense is defined by reference (<ref tip="dif">X</ref> = "see X").
  const difRefs = byNode(db
    .query<{ node_id: number; txt: string }, [number, number]>(
      "SELECT node_id, txt FROM ref WHERE node_id BETWEEN ? AND ? AND owner_kind = 'node' AND tip = 'dif' ORDER BY id",
    )
    .all(...range));
  const examples = byNode(db
    .query<{ node_id: number; txt: string }, [number, number]>(
      "SELECT node_id, txt FROM ekz WHERE node_id BETWEEN ? AND ? ORDER BY node_id, ord",
    )
    .all(...range));
  const fak = byNode(db
    .query<{ node_id: number; txt: string }, [number, number]>(
      "SELECT node_id, txt FROM uzo WHERE node_id BETWEEN ? AND ? AND owner_kind = 'node' AND tip = 'fak' ORDER BY node_id, ord",
    )
    .all(...range));

  const senseAt = (nodeId: number, mrk: string | undefined): SenseEntry => {
    let definition = (difs.get(nodeId) ?? []).map((d) => d.txt).join(" ");
    const refs = difRefs.get(nodeId) ?? [];
    if (!definition && refs.length > 0) definition = `= ${refs.map((r) => r.txt).join(", ")}`;
    const sense: SenseEntry = {
      mrk,
      definition,
      examples: (examples.get(nodeId) ?? []).map((e) => e.txt).filter((t) => t.length > 0),
    };
    const domains = (fak.get(nodeId) ?? []).map((u) => u.txt);
    if (domains.length > 0) sense.domain = domains.join(", ");
    return sense;
  };

  const siblings = new Map<string, number>(); // `${parent}/${kind}` → count
  for (const n of nodes) {
    const k = `${n.parent_id}/${n.kind}`;
    siblings.set(k, (siblings.get(k) ?? 0) + 1);
  }
  const seen = new Map<string, number>();

  const senses: SenseEntry[] = [];
  const own = senseAt(root.id, root.mrk);
  if (own.definition || own.examples.length > 0 || nodes.length === 0) senses.push(own);

  for (const n of nodes) {
    const k = `${n.parent_id}/${n.kind}`;
    const i = seen.get(k) ?? 0;
    seen.set(k, i + 1);
    const num =
      n.kind === "subsnc" ? `${String.fromCharCode(97 + i)})`
      : n.kind === "subdrv" ? `${String.fromCharCode(65 + i)}.`
      : siblings.get(k)! > 1 ? `${i + 1}.` : "";
    const s = senseAt(n.id, n.mrk ?? undefined);
    s.num = num;
    senses.push(s);
  }
  return senses;
}

// ---------------------------------------------------------------------------
// Enrichment reads (L3): the x_* tables and fts_dif, written by the passes in
// src/corpus/passes and recorded in meta_pass.
// ---------------------------------------------------------------------------

export interface ThesaurusEntry {
  label: string;
  inferred: boolean;
  headword: string;
  article: string;
}

export interface ThesaurusGroup {
  tip: string | null;
  label: string;
  entries: ThesaurusEntry[];
}

export interface ThesaurusResult {
  headword: string;
  article: string;
  matchedVia?: string;
  groups: ThesaurusGroup[];
}

/** Nodes whose headword (or variant) is exactly `norm`, with the first one's identity. */
function nodesByKap(
  db: SqlReader,
  norm: string
): { ids: number[]; headword: string; article: string; norm: string } | null {
  const rows = db
    .query<{ id: number; txt: string; file: string }, [string]>(
      `SELECT n.id, k.txt, a.file
         FROM kap k JOIN node n ON n.id = k.node_id JOIN art a ON a.id = n.art_id
        WHERE k.norm = ? ORDER BY n.id`
    )
    .all(norm);
  if (rows.length === 0) return null;
  return { ids: rows.map((r) => r.id), headword: rows[0].txt, article: rows[0].file, norm };
}

/**
 * The reference graph around a word, grouped by relation.
 *
 * Includes edges hanging off the headword's senses, not just the headword
 * node, and the inverses the refs pass entailed — so `hundo` lists the breeds
 * that declare themselves a kind of dog, which the `hund` article never states.
 *
 * The descent stops at a node with a <kap> of its own: that is the next
 * headword, and its refs are its own. It matters because an article's own
 * <kap> reads like its first derivation (bel's is "bela"), so `bela` matches
 * the article node too — without the stop, malbeligi's synonym misfigurigi
 * would be reported as a synonym of bela.
 */
export function thesaurusOf(db: SqlReader, query: string): ThesaurusResult | null {
  requirePasses(db, "The thesaurus", ["refs", "index"]);
  const normalized = normalizeQuery(query);
  let hit = nodesByKap(db, normalized);
  let matchedVia: string | undefined;

  if (!hit) {
    // Same cascade as lookupEsperanto step 3: dictionary forms, heuristic after.
    const stems = new Set([
      ...lemmaCandidates(normalized).map((c) => c.lemma),
      ...generateStems(normalized),
    ]);
    for (const stem of stems) {
      if (stem === normalized) continue;
      hit = nodesByKap(db, stem);
      if (hit) {
        matchedVia = `stem:${stem}`;
        break;
      }
    }
  }
  if (!hit) return null;

  const placeholders = hit.ids.map(() => "?").join(",");
  const rows = db
    .query<
      {
        tip: string | null;
        label: string;
        inferred: number;
        article: string;
        headword: string | null;
        dnorm: string | null;
      },
      []
    >(
      `WITH RECURSIVE src(id) AS (
         SELECT id FROM node WHERE id IN (${placeholders})
         UNION
         SELECT n.id FROM node n JOIN src s ON n.parent_id = s.id
          WHERE NOT EXISTS (SELECT 1 FROM kap k WHERE k.node_id = n.id)
       )
       SELECT e.tip AS tip, e.inferred AS inferred,
              COALESCE(t.label, 'ligilo') AS label,
              a.file AS article, k.txt AS headword, k.norm AS dnorm
         FROM x_ref_edge e
         JOIN src ON src.id = e.src_node
         LEFT JOIN x_ref_tip t ON t.tip = e.tip
         JOIN node dn ON dn.id = e.dst_node
         JOIN art a ON a.id = dn.art_id
         LEFT JOIN kap k ON k.id = dn.kap_id
        ORDER BY e.inferred, e.tip, k.txt`
    )
    .all(...(hit.ids as []));

  const groups = new Map<string, ThesaurusGroup>();
  const seen = new Set<string>();
  for (const r of rows) {
    // A ref between two senses of the same article resolves to that article's
    // own headword; listing the word as related to itself says nothing. Other
    // headwords of the same article (hund → ĉashundo) are kept.
    if (r.article === hit.article && r.dnorm === hit.norm) continue;
    const headword = r.headword ?? r.article;
    const key = `${r.tip}|${r.article}|${headword}`;
    if (seen.has(key)) continue;
    seen.add(key);
    let group = groups.get(r.tip ?? "");
    if (!group) {
      group = { tip: r.tip, label: r.label, entries: [] };
      groups.set(r.tip ?? "", group);
    }
    group.entries.push({
      label: r.label,
      inferred: r.inferred === 1,
      headword,
      article: r.article,
    });
  }

  return {
    headword: hit.headword,
    article: hit.article,
    matchedVia,
    groups: [...groups.values()],
  };
}

export interface DefinitionHit {
  article: string;
  headword: string;
  snippet: string;
}

/**
 * Reverse dictionary: words whose definition matches a description.
 *
 * All terms must occur in the same definition (fts_dif is one row per <dif>).
 * Diacritics are folded by the tokenizer, so "granda birdo" and "granda
 * birdó" behave alike; x-system input is converted first.
 */
export function searchDefinitions(db: SqlReader, query: string, limit = 20): DefinitionHit[] {
  requirePasses(db, "Reverse lookup", ["fts"]);
  const terms = normalizeQuery(query)
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .map((t) => `"${t.replace(/"/g, '""')}"`); // quoted: FTS5 operators stay literal
  if (terms.length === 0) return [];

  return db
    .query<{ article: string; headword: string | null; snippet: string }, [string, number]>(
      `SELECT a.file AS article, k.txt AS headword,
              snippet(fts_dif, 0, '**', '**', '…', 14) AS snippet
         FROM fts_dif f
         JOIN dif ON dif.id = f.rowid
         JOIN node n ON n.id = dif.node_id
         JOIN art a ON a.id = n.art_id
         LEFT JOIN kap k ON k.id = n.kap_id
        WHERE fts_dif MATCH ?
        ORDER BY rank
        LIMIT ?`
    )
    .all(terms.join(" AND "), limit)
    .map((r) => ({ article: r.article, headword: r.headword ?? r.article, snippet: r.snippet }));
}
