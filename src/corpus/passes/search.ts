/**
 * Pass `search`: the rows search and lookup read, clustered for range scans.
 *
 * `serĉo` has one row for every way into an entry: its headword and variants
 * (lng 'eo') and each of its translations, keyed by the folded form a query is
 * compared with (normalizeQuery). The primary key clusters a language's rows
 * by that form, so an exact match is one short range and a prefix match one
 * contiguous run of pages; over HTTP both are a few requests. A row carries all
 * that ranking, counting and narrowing need, so only the page of results
 * shown ever reads an entry: its place in the language's order, the form as
 * written, whether it is only filed under the key, and the entry's usage
 * domains.
 *
 * An entry is a derivation with a mark ("hund.0o"); its rows are those of its
 * subtree, node ids id..last_id. `serĉo_lng` counts each language once, so
 * listing languages reads a few pages instead of every translation.
 */
import type { Database } from "bun:sqlite";
import type { Pass } from "../pass";
import { normalizeQuery } from "../../stemmer";

interface Row {
  norm: string;
  nid: number;
  /** as written; null when that is norm itself */
  txt: string | null;
  ind: 0 | 1;
  /** what rows with the same key sort by: the spelling of the headword they lead to */
  label: string;
}

export const searchPass: Pass = {
  name: "search",
  version: 1,
  tables: ["serĉo", "serĉo_lng"],
  run(db, log) {
    db.run(`
      CREATE TABLE serĉo (
        lng  TEXT NOT NULL,     -- 'eo' for headwords and their variants
        norm TEXT NOT NULL,     -- the form a query is compared with, folded as normalizeQuery does
        ord  INTEGER NOT NULL,  -- place among the language's rows: form, direct before filed, headword
        nid  INTEGER NOT NULL,  -- the entry: its derivation node
        txt  TEXT,              -- the form as written when it is not norm; a filed translation's expression
        ind  INTEGER,           -- 1: filed under norm (a translation's <ind>, a headword's variant)
        fak  TEXT,              -- the entry's usage domains, space-separated
        PRIMARY KEY (lng, norm, ord)
      ) WITHOUT ROWID`);
    db.run(`
      CREATE TABLE serĉo_lng (
        lng TEXT PRIMARY KEY,
        entries INTEGER NOT NULL,       -- entries with a row in the language
        translations INTEGER NOT NULL   -- the language's translations outside examples; eo: 0
      ) WITHOUT ROWID`);

    const maxNode = db.query<{ id: number }, []>("SELECT MAX(id) id FROM node").get()!.id ?? 0;
    const entryOf = new Int32Array(maxNode + 1);
    const entries = new Map<number, { kap: string; fak: string[] }>();
    for (const e of db.query<{ id: number; last_id: number; kap: string }, []>(
      `SELECT n.id, n.last_id, k.txt kap FROM node n JOIN kap k ON k.id = n.kap_id
        WHERE n.kind = 'drv' AND n.mrk IS NOT NULL AND instr(n.mrk, '.') > 0 AND n.mrk NOT GLOB '*.*.*'
        ORDER BY n.id`).iterate()) {
      entries.set(e.id, { kap: e.kap, fak: [] });
      entryOf.fill(e.id, e.id, e.last_id + 1);
    }

    for (const u of db.query<{ node_id: number; txt: string }, []>(
      `SELECT node_id, txt FROM uzo WHERE tip IN ('fak', 'stl') AND owner_kind <> 'ekz' ORDER BY id`).iterate()) {
      const e = entries.get(entryOf[u.node_id]);
      if (e && !e.fak.includes(u.txt)) e.fak.push(u.txt);
    }

    const byLanguage = new Map<string, Row[]>();
    const add = (lng: string, form: string, nid: number, written: string, ind: 0 | 1, label: string) => {
      const norm = normalizeQuery(form);
      if (!norm || !entries.has(nid)) return;
      const rows = byLanguage.get(lng) ?? [];
      rows.push({ norm, nid, txt: written === norm ? null : written, ind, label });
      byLanguage.set(lng, rows);
    };

    for (const [nid, e] of entries) add("eo", e.kap, nid, e.kap, 0, e.kap);
    // A variant beside the article's own headword belongs to no derivation;
    // like upstream, file it under the first one after it.
    const firstEntryAfter = db.query<{ id: number }, [number]>(
      `SELECT d.id FROM node n JOIN node d ON d.id > n.id AND d.id <= n.last_id
        WHERE n.id = ? AND d.kind = 'drv' AND d.mrk IS NOT NULL AND instr(d.mrk, '.') > 0 AND d.mrk NOT GLOB '*.*.*'
        ORDER BY d.id LIMIT 1`);
    for (const v of db.query<{ node_id: number; txt: string }, []>(
      "SELECT node_id, txt FROM kap WHERE parent_kap_id IS NOT NULL ORDER BY id").iterate()) {
      const nid = entryOf[v.node_id] || firstEntryAfter.get(v.node_id)?.id;
      if (nid) add("eo", v.txt, nid, v.txt, 1, v.txt);
    }

    for (const t of db.query<{ node_id: number; lng: string; txt: string; ind: string | null }, []>(
      "SELECT node_id, lng, txt, ind FROM trd WHERE owner_kind <> 'ekz' ORDER BY id").iterate()) {
      const nid = entryOf[t.node_id];
      const e = entries.get(nid);
      if (!e) continue;
      if (t.ind === null) add(t.lng, t.txt, nid, t.txt, 0, e.kap);
      else add(t.lng, t.ind, nid, t.txt, 1, e.kap);
    }

    const collator = new Intl.Collator("eo");
    const ins = db.prepare("INSERT INTO serĉo (lng, norm, ord, nid, txt, ind, fak) VALUES (?,?,?,?,?,?,?)");
    const insLng = db.prepare("INSERT INTO serĉo_lng (lng, entries, translations) VALUES (?,?,?)");
    const translations = new Map(db.query<{ lng: string; n: number }, []>(
      "SELECT lng, COUNT(*) n FROM trd WHERE owner_kind <> 'ekz' GROUP BY lng").all().map((r) => [r.lng, r.n]));
    let written = 0;
    for (const [lng, rows] of [...byLanguage].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      rows.sort((a, b) => collator.compare(a.norm, b.norm) || (a.norm < b.norm ? -1 : a.norm > b.norm ? 1 : 0) ||
        a.ind - b.ind || collator.compare(a.label, b.label) || a.nid - b.nid);
      // One row per key and entry: the direct one when there is one.
      const seen = new Set<string>();
      let ord = 0;
      const nids = new Set<number>();
      for (const r of rows) {
        const key = `${r.norm}\0${r.nid}`;
        if (seen.has(key)) continue;
        seen.add(key);
        nids.add(r.nid);
        const fak = entries.get(r.nid)!.fak;
        ins.run(lng, r.norm, ord++, r.nid, r.txt, r.ind || null, fak.length ? fak.join(" ") : null);
      }
      insLng.run(lng, nids.size, translations.get(lng) ?? 0);
      written += ord;
    }
    log(`serĉo: ${written} rows over ${entries.size} entries in ${byLanguage.size} languages`);
    return written;
  },
};
