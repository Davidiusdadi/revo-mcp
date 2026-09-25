/**
 * Reads that go at the XML-built schema directly (data/voko.db).
 *
 * Words are found through the search pass's `serĉo` rows, clustered by
 * language and folded form. An entry is a derivation with a mark; ids are
 * document order, so everything under it is the one range id..last_id in
 * every table. Its translations are one range of `translation`; its senses,
 * references and domains are read off the derivation itself, rebuilt from the
 * stored articles (articles.ts readRange) and read the way the build reads it
 * (content.ts). The enrichment reads at the bottom of the file need passes a
 * core database is built without; hasPass tells them apart.
 */

import type { SqlReader } from "./sql";
import type { Element, Roots } from "voko-xml/view";
import { generateStems, normalizeQuery } from "./stemmer";
import { lemmaCandidates } from "./morph";
import { idOf, readRange } from "./articles";
import { entryContent, rootsFrom, usesVariantRoots, type Bibliography, type EntryContent, type SenseEntry, type TranslationPart } from "./content";

export type { SenseEntry } from "./content";

/** Version 3: the articles stored whole, one table per element; node, headword and translation derived. */
export const SCHEMA_VERSION = 3;

export interface LookupResult {
  headword: string;
  /** The same word spelled otherwise, as the entry's own kap writes it (anarĥio: anarkio); absent when none. */
  variants?: string[];
  article: string;
  mrk: string;
  senses: SenseEntry[];
  translations: Translation[];
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

/** Whether the database was built with a pass (meta_pass); a core database has only `structure` and `search`. */
export function hasPass(db: SqlReader, name: string): boolean {
  let passes = passesByDb.get(db);
  if (!passes) {
    passes = new Set(db.query<{ pass: string }, []>("SELECT pass FROM meta_pass").all().map((r) => r.pass));
    passesByDb.set(db, passes);
  }
  return passes.has(name);
}

const tablesByDb = new WeakMap<SqlReader, Set<string>>();

/** Whether the database has a table (or virtual table) of this name. */
export function hasTable(db: SqlReader, name: string): boolean {
  let tables = tablesByDb.get(db);
  if (!tables) {
    tables = new Set(db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
    tablesByDb.set(db, tables);
  }
  return tables.has(name);
}

/**
 * An FTS5 query for a text anywhere in `fts_ekz`: its trigrams, all of them.
 * The index keeps no positions (detail=none, half its size), so it cannot
 * match a phrase; what it finds holds every trigram and holds the text itself
 * nearly always, which a reader checks.
 */
export function trigramMatch(text: string): string {
  const chars = [...text];
  const quote = (t: string) => `"${t.replace(/"/g, '""')}"`;
  if (chars.length <= 3) return quote(text);
  const trigrams = new Set(chars.slice(0, -2).map((_, i) => chars.slice(i, i + 3).join("")));
  return `(${[...trigrams].map(quote).join(" AND ")})`;
}

/** Refuses a read the database cannot answer, naming what it lacks. */
export function requirePasses(db: SqlReader, what: string, passes: string[]): void {
  const missing = passes.filter((pass) => !hasPass(db, pass));
  if (missing.length === 0) return;
  throw new Error(
    `${what} needs the ${missing.join(", ")} pass${missing.length > 1 ? "es" : ""}, which this database ` +
      "was built without (a core build). Build the full stage with `pnpm corpus:build`.",
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

/** The derivation node an entry is, with what names it and what reading it back needs. */
export interface EntryNode {
  id: number;
  last_id: number;
  mrk: string;
  headword: string;
  article: string;
  /** the tables with rows in id..last_id */
  mask: Uint8Array;
  article_id: number;
  /** the article's main root */
  rad: string;
}

const ENTRY_NODE = `SELECT n.id, n.last_id, n.mrk, h.txt AS headword, a.file AS article, n.mask, a.id AS article_id, a.rad
  FROM node n JOIN headword h ON h.id = n.kap_id JOIN article a ON a.id = n.article_id`;
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

/** One translation of an entry, and what ReVo says about it beside its text. */
export interface Translation {
  lng: string;
  /** The translation, without its notes. */
  trd: string;
  /**
   * The word inside it that ReVo alphabetises the entry under: "quelle
   * <ind>chose</ind>" is filed under "chose" but means "quelle chose", so the
   * mark comes beside the translation, never in its place.
   */
  ind?: string;
  /** The translation with its notes in place, when it has any; content.ts TranslationPart says which list shows a note. */
  parts?: TranslationPart[];
  /** Its reading, as kana or pinyin. */
  pr?: string;
  /**
   * Where it was found, when the <trd> says: `Vikt: de en; juĝis <model>` is a
   * translation taken from Wiktionary and judged by a model, `; kontrolita`
   * after it one a person has checked since.
   */
  fnt?: string;
  /** Its style or field code (ARK, VULG …), when it carries one. */
  kod?: string;
  /** Which of the entry's `senses` it translates; none when it translates the entry as a whole. */
  sense?: number;
}

const structureByDb = new WeakMap<SqlReader, number>();

/**
 * The structure pass the database was built with: from 3 `translation` keeps
 * the notes and readings, from 4 where each was found. A copy of the database
 * stored in a browser before that is still read.
 */
function structureVersion(db: SqlReader): number {
  let version = structureByDb.get(db);
  if (version === undefined) {
    const row = db.query<{ version: number }, []>("SELECT version FROM meta_pass WHERE pass = 'structure'").get();
    version = row?.version ?? 0;
    structureByDb.set(db, version);
  }
  return version;
}

/**
 * An entry's translations outside examples, by language: the derivation's own
 * first, then its senses' in reading order. `senses` maps the id of each node
 * the entry lists as a sense to its place in the list.
 */
export function translationsOf(
  db: SqlReader,
  node: { id: number; last_id: number },
  languages?: string[],
  senses?: ReadonlyMap<number, number>,
): Translation[] {
  if (languages?.length === 0) return [];
  // `+lng`: the entry's range is the narrow index; a full build's
  // idx_translation_lng_key would otherwise scan a whole language.
  const only = languages ? ` AND +lng IN (${languages.map(() => "?").join(",")})` : "";
  const version = structureVersion(db);
  const notes = (version >= 3 ? ", klr, pr" : ", NULL AS klr, NULL AS pr")
    + (version >= 4 ? ", fnt, kod" : ", NULL AS fnt, NULL AS kod");
  return db
    .query<{ lng: string; trd: string; ind: string | null; klr: string | null; pr: string | null; fnt: string | null; kod: string | null; node_id: number }, unknown[]>(
      `SELECT lng, txt AS trd, ind${notes}, node_id FROM translation
        WHERE id BETWEEN ? AND ? AND in_ekz = 0${only}
        ORDER BY lng, node_id <> ?, node_id, id`,
    )
    .all(node.id, node.last_id, ...(languages ?? []), node.id)
    .map(({ lng, trd, ind, klr, pr, fnt, kod, node_id }) => {
      const translation: Translation = { lng, trd };
      if (ind && ind !== trd) translation.ind = ind;
      if (klr) translation.parts = JSON.parse(klr) as TranslationPart[];
      if (pr) translation.pr = pr;
      if (fnt) translation.fnt = fnt;
      if (kod) translation.kod = kod;
      const sense = senses?.get(node_id);
      if (sense !== undefined) translation.sense = sense;
      return translation;
    });
}

/** The roots an entry's tildes stand for: the article's root, and its variant roots where a tilde names one. */
function rootsAt(db: SqlReader, node: EntryNode, drv: Element): Roots {
  if (!usesVariantRoots(drv)) return rootsFrom(node.rad, []);
  const variants = db
    .query<{ var: string; txt: string | null }, [number, number]>(
      `SELECT var, txt FROM rad
        WHERE id BETWEEN ? AND (SELECT last_id FROM article WHERE id = ?) AND var IS NOT NULL ORDER BY id`,
    )
    .all(node.article_id, node.article_id);
  return rootsFrom(node.rad, variants);
}

/** What an entry's derivation says: its senses, references and usage domains. */
function contentOf(db: SqlReader, node: EntryNode): EntryContent {
  const [drv] = readRange(db, node.id, node.last_id, { mask: node.mask });
  if (drv?.type !== "element") throw new Error(`${node.mrk}: no element at ${node.id}`);
  return entryContent(drv, rootsAt(db, node, drv));
}

/** An entry's usage domains (fak and stl tags outside examples), in document order. */
export function usageDomainsOf(db: SqlReader, node: EntryNode): string[] {
  return contentOf(db, node).usageDomains;
}

/** The headword of each mark that names a node, as far as the marks do. */
function headwordsByMark(db: SqlReader, marks: string[]): Map<string, string> {
  const unique = [...new Set(marks)];
  const headwords = new Map<string, string>();
  if (unique.length === 0) return headwords;
  const rows = db
    .query<{ mrk: string; txt: string }, string[]>(
      `SELECT t.mrk, h.txt FROM node t JOIN headword h ON h.id = t.kap_id
        WHERE t.mrk IN (${unique.map(() => "?").join(",")}) AND t.kind <> 'art' ORDER BY t.id`,
    )
    .all(...unique);
  for (const row of rows) if (!headwords.has(row.mrk)) headwords.set(row.mrk, row.txt);
  return headwords;
}

/** Each listed sense's node id, to its place in `senses`; the derivation itself is the entry as a whole, not a sense. */
function sensesById(content: EntryContent, derivation: number): Map<number, number> {
  const byId = new Map<number, number>();
  content.senseNodes.forEach((el, i) => {
    const id = idOf(el);
    if (id !== undefined && id !== derivation) byId.set(id, i);
  });
  return byId;
}

export function assembleEntry(db: SqlReader, node: EntryNode, options: EntryOptions = {}): LookupResult {
  const full = (options.detail ?? "full") === "full";
  const content = full || !options.domains ? contentOf(db, node) : null;
  let crossRefs: LookupResult["crossRefs"] = [];
  if (full) {
    const targets = headwordsByMark(db, content!.crossRefs.map((ref) => ref.target));
    crossRefs = content!.crossRefs.map(({ target, type }) => {
      const targetKap = targets.get(target);
      return targetKap === undefined ? { target, type } : { target, type, targetKap };
    });
  }
  const variants = variantsOf(db, node);
  return {
    headword: node.headword,
    ...(variants.length ? { variants } : {}),
    article: node.article,
    mrk: node.mrk,
    senses: full ? withBibliography(db, sensesIn(content!.senses, options.languages)) : [],
    translations: translationsOf(db, node, options.languages, full ? sensesById(content!, node.id) : undefined),
    crossRefs,
    usageDomains: options.domains ?? content!.usageDomains,
  };
}

/** The entry's variant headwords, in the order its kap writes them. */
function variantsOf(db: SqlReader, node: EntryNode): string[] {
  return spellingsOf(db, node).filter((txt) => txt !== node.headword);
}

/**
 * Every spelling of an entry's headword, its own first, then its variants as
 * its kap writes them (anarĥio, anarkio). A kap's id lies inside its node's
 * id..last_id, so the primary key finds them without an index on node_id.
 */
export function spellingsOf(db: SqlReader, node: { id: number; last_id: number }): string[] {
  const rows = db
    .query<{ txt: string }, [number, number, number]>(
      "SELECT txt FROM headword WHERE id BETWEEN ? AND ? AND node_id = ? ORDER BY main_id IS NOT NULL, id")
    .all(node.id, node.last_id, node.id)
    .map((r) => r.txt);
  return rows.filter((txt, i) => rows.indexOf(txt) === i);
}

/** The senses with their definitions and their examples' translations kept to the languages asked for; all when none are named. */
function sensesIn(senses: SenseEntry[], languages?: string[]): SenseEntry[] {
  if (!languages) return senses;
  const asked = <T extends { lng: string }>(items: T[] | undefined): T[] => (items ?? []).filter((d) => languages.includes(d.lng));
  return senses.map((sense) => {
    const { definitions, examples, ...rest } = sense;
    const kept: SenseEntry = {
      ...rest,
      examples: examples.map(({ translations, ...example }) => {
        const trds = asked(translations);
        return trds.length > 0 ? { ...example, translations: trds } : example;
      }),
    };
    const defs = asked(definitions);
    if (defs.length > 0) kept.definitions = defs;
    return kept;
  });
}

/** A work of ReVo's bibliography (revo-fonto cfg/bibliogr.xml) as a citation names it. */
function bibliographyOf(db: SqlReader, codes: string[]): Map<string, Bibliography> {
  const works = new Map<string, Bibliography>();
  if (codes.length === 0) return works;
  const rows = db
    .query<{ mll: string; tit: string | null; aut: string | null; url: string | null; eld: string | null }, string[]>(
      `SELECT mll, tit, aut, url, eld FROM bibliogr WHERE mll IN (${codes.map(() => "?").join(",")})`)
    .all(...codes);
  for (const row of rows) {
    const work: Bibliography = {};
    if (row.tit) work.tit = row.tit;
    if (row.aut) work.aut = row.aut;
    const dat = row.eld ? (JSON.parse(row.eld) as { dat?: string }[])[0]?.dat : undefined;
    if (dat) work.dat = dat;
    if (row.url) work.url = row.url;
    works.set(row.mll, work);
  }
  return works;
}

/** The senses with each cited work of the bibliography named beside its code. */
function withBibliography(db: SqlReader, senses: SenseEntry[]): SenseEntry[] {
  const codes = [...new Set(senses.flatMap((s) => s.examples.flatMap((e) => e.source?.bib ?? [])))];
  const works = bibliographyOf(db, codes);
  if (works.size === 0) return senses;
  return senses.map((sense) => ({
    ...sense,
    examples: sense.examples.map((example) => {
      const work = example.source?.bib && works.get(example.source.bib);
      return work ? { ...example, source: { ...example.source, bibliogr: work } } : example;
    }),
  }));
}

/**
 * Senses of a derivation, in document order. Numbering follows the ReVo
 * rendering: snc "1." "2." (unnumbered when alone), subsnc "a)" "b)",
 * subdrv "A." "B.". Each sense carries only its own examples — a subsnc's
 * examples are listed under the subsnc, not repeated under its parent snc.
 */
export function sensesOf(db: SqlReader, node: EntryNode): SenseEntry[] {
  return contentOf(db, node).senses;
}

// ---------------------------------------------------------------------------
// Enrichment reads: the x_* tables and fts_dif, written by the passes in
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
      `SELECT n.id, h.txt, a.file
         FROM headword h JOIN node n ON n.id = h.node_id JOIN article a ON a.id = n.article_id
        WHERE h.norm = ? ORDER BY n.id, h.id`
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
          WHERE NOT EXISTS (SELECT 1 FROM headword h WHERE h.node_id = n.id)
       )
       SELECT e.tip AS tip, e.inferred AS inferred,
              COALESCE(t.label, 'ligilo') AS label,
              a.file AS article, k.txt AS headword, k.norm AS dnorm
         FROM x_ref_edge e
         JOIN src ON src.id = e.src_node
         LEFT JOIN x_ref_tip t ON t.tip = e.tip
         JOIN node dn ON dn.id = e.dst_node
         JOIN article a ON a.id = dn.article_id
         LEFT JOIN headword k ON k.id = dn.kap_id
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
         JOIN node n ON n.id = f.node_id
         JOIN article a ON a.id = n.article_id
         LEFT JOIN headword k ON k.id = n.kap_id
        WHERE fts_dif MATCH ?
        ORDER BY rank
        LIMIT ?`
    )
    .all(terms.join(" AND "), limit)
    .map((r) => ({ article: r.article, headword: r.headword ?? r.article, snippet: r.snippet }));
}
