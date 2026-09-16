/**
 * Pass `index`: the indexes only the enrichment tools read through.
 *
 * The core database carries the indexes search, lookup, entries and gloss
 * need (the `structure` pass's node(mrk) and headword(norm)). The thesaurus
 * finds a word's nodes by any headword spelling and walks down to the senses,
 * a source-language gloss matches translations by their index form; those
 * indexes are built here, for a database that serves those tools, and are not
 * shipped to browsers.
 */
import type { Pass } from "../pass";

const INDEXES = [
  "CREATE INDEX IF NOT EXISTS idx_headword_node ON headword(node_id)",
  "CREATE INDEX IF NOT EXISTS idx_node_parent ON node(parent_id)",
  // gloss matches COALESCE(ind, txt) case-insensitively within one language
  "CREATE INDEX IF NOT EXISTS idx_translation_lng_key ON translation(lng, COALESCE(ind, txt) COLLATE NOCASE)",
];

export const indexPass: Pass = {
  name: "index",
  version: 3,
  tables: [],
  run(db, log) {
    for (const sql of INDEXES) db.run(sql);
    log(`${INDEXES.length} indexes for the enrichment tools`);
    return INDEXES.length;
  },
};
