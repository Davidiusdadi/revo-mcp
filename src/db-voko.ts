/**
 * Reads specific to the XML-built corpus (data/voko.db, meta.schema = 'voko').
 *
 * db.ts keeps one lookup cascade for both databases: the compat views in
 * src/corpus/schema.sql answer its nodo/var/traduko/referenco queries. The one
 * thing a view can't stand in for is the old HTML scrape of senses — here they
 * come straight from the node/dif/ekz tables.
 */

import type { Database } from "bun:sqlite";
import type { SenseEntry } from "./html-extract";
import { generateStems, normalizeQuery } from "./stemmer";
import { lemmaCandidates } from "./morph";

export function isVokoDb(db: Database): boolean {
  try {
    const row = db
      .query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'schema'")
      .get();
    return row?.value === "voko";
  } catch {
    return false; // upstream revo.db has no meta table
  }
}

interface SenseNode {
  id: number;
  parent_id: number;
  kind: string;
  mrk: string | null;
}

/**
 * Senses of a derivation, in document order. Numbering follows the ReVo
 * rendering: snc "1." "2." (unnumbered when alone), subsnc "a)" "b)",
 * subdrv "A." "B.". Each sense carries only its own examples — a subsnc's
 * examples are listed under the subsnc, not repeated under its parent snc.
 */
export function sensesOf(db: Database, drvMrk: string): SenseEntry[] {
  const root = db
    .query<{ id: number }, [string]>("SELECT id FROM node WHERE mrk = ? LIMIT 1")
    .get(drvMrk);
  if (!root) return [];

  // node ids are assigned in document (pre-)order, so ORDER BY id is reading order
  const nodes = db
    .query<SenseNode, [number]>(
      `WITH RECURSIVE sub(id, parent_id, kind, mrk) AS (
         SELECT id, parent_id, kind, mrk FROM node WHERE parent_id = ?
         UNION ALL
         SELECT n.id, n.parent_id, n.kind, n.mrk FROM node n JOIN sub s ON n.parent_id = s.id
       )
       SELECT id, parent_id, kind, mrk FROM sub ORDER BY id`
    )
    .all(root.id);

  const siblings = new Map<string, number>(); // `${parent}/${kind}` → count
  for (const n of nodes) {
    const k = `${n.parent_id}/${n.kind}`;
    siblings.set(k, (siblings.get(k) ?? 0) + 1);
  }
  const seen = new Map<string, number>();

  const senses: SenseEntry[] = [];
  const own = senseAt(db, root.id, drvMrk);
  if (own.definition || own.examples.length > 0 || nodes.length === 0) senses.push(own);

  for (const n of nodes) {
    const k = `${n.parent_id}/${n.kind}`;
    const i = seen.get(k) ?? 0;
    seen.set(k, i + 1);
    const num =
      n.kind === "subsnc" ? `${String.fromCharCode(97 + i)})`
      : n.kind === "subdrv" ? `${String.fromCharCode(65 + i)}.`
      : siblings.get(k)! > 1 ? `${i + 1}.` : "";
    const s = senseAt(db, n.id, n.mrk ?? undefined);
    s.num = num;
    senses.push(s);
  }
  return senses;
}

function senseAt(db: Database, nodeId: number, mrk: string | undefined): SenseEntry {
  let definition = db
    .query<{ txt: string }, [number]>("SELECT txt FROM dif WHERE node_id = ? ORDER BY ord")
    .all(nodeId)
    .map((d) => d.txt)
    .join(" ");
  if (!definition) {
    // No <dif>: the sense is defined by reference (<ref tip="dif">X</ref> = "see X").
    const refs = db
      .query<{ txt: string }, [number]>(
        "SELECT txt FROM ref WHERE node_id = ? AND owner_kind = 'node' AND tip = 'dif' ORDER BY id"
      )
      .all(nodeId);
    if (refs.length > 0) definition = `= ${refs.map((r) => r.txt).join(", ")}`;
  }
  const examples = db
    .query<{ txt: string }, [number]>("SELECT txt FROM ekz WHERE node_id = ? ORDER BY ord")
    .all(nodeId)
    .map((e) => e.txt)
    .filter((t) => t.length > 0);
  const fak = db
    .query<{ txt: string }, [number]>(
      "SELECT txt FROM uzo WHERE node_id = ? AND owner_kind = 'node' AND tip = 'fak' ORDER BY ord"
    )
    .all(nodeId)
    .map((u) => u.txt);
  const sense: SenseEntry = { mrk, definition, examples };
  if (fak.length > 0) sense.domain = fak.join(", ");
  return sense;
}

// ---------------------------------------------------------------------------
// Enrichment reads (L3). These answer from the x_* tables and fts_dif, which
// only the XML-built corpus has — see isVokoDb.
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
  db: Database,
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
 */
export function thesaurusOf(db: Database, query: string): ThesaurusResult | null {
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
export function searchDefinitions(db: Database, query: string, limit = 20): DefinitionHit[] {
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
