/**
 * Pass `index`: the indexes only the enrichment tools read through.
 *
 * The core database carries the indexes search, lookup, entries and gloss
 * need (the `structure` pass's node(mrk) and headword(norm)). The thesaurus
 * finds a word's nodes by any headword spelling and walks down to the senses;
 * those indexes are built here, for a database that serves those tools, and are not
 * shipped to browsers.
 */
import type { Pass } from "../pass";

const INDEXES = [
  "CREATE INDEX IF NOT EXISTS idx_headword_node ON headword(node_id)",
  "CREATE INDEX IF NOT EXISTS idx_node_parent ON node(parent_id)",
  // the examples of an entry or an article by mark, for the server's example search
  "CREATE INDEX IF NOT EXISTS idx_ekzemplo_drv ON ekzemplo(drv_mrk)",
  "CREATE INDEX IF NOT EXISTS idx_ekzemplo_art ON ekzemplo(art)",
];

export const indexPass: Pass = {
  name: "index",
  version: 5,
  tables: [],
  run(db, log) {
    // gloss now finds translations by their index form in `serĉo`
    db.run("DROP INDEX IF EXISTS idx_translation_lng_key");
    for (const sql of INDEXES) db.run(sql);
    log(`${INDEXES.length} indexes for the enrichment tools`);
    return INDEXES.length;
  },
};
