/**
 * Pass `index`: the L2 indexes only the enrichment tools read through.
 *
 * The core database carries the indexes search, lookup and entries need
 * (schema.sql). The thesaurus finds a word's nodes by any headword spelling,
 * gloss matches translations by their index form, and the compat views join on
 * mrk_near; those indexes are built here, for a database that serves those
 * tools, and are not shipped to browsers.
 */
import type { Pass } from "../pass";

const INDEXES = [
  "CREATE INDEX IF NOT EXISTS idx_kap_node ON kap(node_id)",
  "CREATE INDEX IF NOT EXISTS idx_kap_norm ON kap(norm)",
  "CREATE INDEX IF NOT EXISTS idx_node_parent ON node(parent_id)",
  "CREATE INDEX IF NOT EXISTS idx_node_mrk_near ON node(mrk_near)",
  // gloss matches COALESCE(ind, txt) case-insensitively within one language
  "CREATE INDEX IF NOT EXISTS idx_trd_lng_key ON trd(lng, COALESCE(ind, txt) COLLATE NOCASE)",
];

export const indexPass: Pass = {
  name: "index",
  version: 1,
  tables: [],
  run(db, log) {
    for (const sql of INDEXES) db.run(sql);
    log(`${INDEXES.length} indexes for the enrichment tools`);
    return INDEXES.length;
  },
};
