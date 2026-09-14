/**
 * Pass `fts`: the full-text indexes and the `ekzemplo` compatibility table.
 * Tokenizers match what src/setup.ts used on the old DB so the search code's
 * behaviour carries over: unicode61 for headwords/translations/definitions,
 * trigram for examples (substring + diacritic-folded).
 */
import type { Pass } from "../pass";

export const ftsPass: Pass = {
  name: "fts",
  version: 1,
  tables: ["fts_kap", "fts_trd", "fts_dif", "fts_ekz", "ekzemplo"],
  run(db, log) {
    let rows = 0;

    db.run(`CREATE VIRTUAL TABLE fts_kap USING fts5(kap, tokenize='unicode61 remove_diacritics 2')`);
    db.run(`INSERT INTO fts_kap(rowid, kap) SELECT id, txt FROM kap`);
    rows += count(db, "kap");
    log("fts_kap: headwords incl. variants");

    // Translation + its index word, base form and transcription, so pinyin /
    // hiragana / Indonesian base forms are searchable too.
    db.run(`CREATE VIRTUAL TABLE fts_trd USING fts5(trd, ind, baz, pr, tokenize='unicode61 remove_diacritics 2')`);
    db.run(`INSERT INTO fts_trd(rowid, trd, ind, baz, pr) SELECT id, txt, ind, baz, pr FROM trd`);
    rows += count(db, "trd");
    log("fts_trd: txt + ind + baz + pr");

    db.run(`CREATE VIRTUAL TABLE fts_dif USING fts5(dif, tokenize='unicode61 remove_diacritics 2')`);
    db.run(`INSERT INTO fts_dif(rowid, dif) SELECT id, txt FROM dif`);
    rows += count(db, "dif");
    log("fts_dif: definitions (reverse dictionary)");

    // Same shape src/db.ts::searchExamples reads today.
    db.run(`
      CREATE TABLE ekzemplo (
        rowid INTEGER PRIMARY KEY,
        art TEXT NOT NULL, drv_mrk TEXT NOT NULL, sense_mrk TEXT,
        ekz_md TEXT NOT NULL, position INTEGER NOT NULL
      )`);
    db.run(`
      INSERT INTO ekzemplo (rowid, art, drv_mrk, sense_mrk, ekz_md, position)
      SELECT e.id, a.file,
             -- the innermost marked drv or subart the example sits in (ids are preorder)
             COALESCE((SELECT d.mrk FROM node d
                       WHERE d.art_id = n.art_id AND d.kind IN ('drv','subart') AND d.mrk IS NOT NULL
                         AND n.id BETWEEN d.id AND d.last_id
                       ORDER BY d.id DESC LIMIT 1), n.mrk_near, a.file),
             CASE WHEN n.kind IN ('snc','subsnc') THEN n.mrk ELSE NULL END,
             e.txt, e.ord
      FROM ekz e JOIN node n ON n.id = e.node_id JOIN art a ON a.id = n.art_id
      WHERE length(e.txt) > 0`);
    db.run(`CREATE INDEX idx_ekzemplo_drv ON ekzemplo(drv_mrk)`);
    db.run(`CREATE INDEX idx_ekzemplo_art ON ekzemplo(art)`);
    db.run(`
      CREATE VIRTUAL TABLE fts_ekz USING fts5(
        ekz_md, content='ekzemplo', content_rowid='rowid',
        tokenize='trigram case_sensitive 0 remove_diacritics 1')`);
    db.run(`INSERT INTO fts_ekz(fts_ekz) VALUES('rebuild')`);
    rows += count(db, "ekzemplo");
    log("fts_ekz: trigram over ekzemplo");
    return rows;
  },
};

function count(db: import("bun:sqlite").Database, table: string): number {
  return (db.query<{ c: number }, []>(`SELECT COUNT(*) c FROM ${table}`).get() as { c: number }).c;
}
