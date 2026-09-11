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
