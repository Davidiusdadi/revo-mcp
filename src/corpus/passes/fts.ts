/**
 * Pass `fts`: the full-text indexes and the `ekzemplo` table the example
 * search reads. Tokenizers match what src/setup.ts used on the old DB so the
 * search code's behaviour carries over: unicode61 for headwords, translations
 * and definitions, trigram for examples (substring + diacritic-folded).
 *
 * Headwords come from the `headword` table; translations, definitions and
 * examples are rendered from the stored articles, each row under its
 * element's id.
 */
import type { NodeInfo } from "voko-xml";
import type { Pass } from "../pass";
import { idOf } from "../../articles";
import { childText, contentOf, textIn, OMIT } from "../../content";
import { articleTrees } from "../documents";

export const ftsPass: Pass = {
  name: "fts",
  version: 2,
  tables: ["fts_kap", "fts_trd", "fts_dif", "fts_ekz", "ekzemplo"],
  run(db, log) {
    db.run(`CREATE VIRTUAL TABLE fts_kap USING fts5(kap, tokenize='unicode61 remove_diacritics 2')`);
    db.run(`INSERT INTO fts_kap(rowid, kap) SELECT id, txt FROM headword`);
    const nKap = db.query<{ c: number }, []>("SELECT COUNT(*) c FROM headword").get()!.c;
    log("fts_kap: headwords incl. variants");

    // Translation + its index word, base form and transcription, so pinyin /
    // hiragana / Indonesian base forms are searchable too.
    db.run(`CREATE VIRTUAL TABLE fts_trd USING fts5(trd, ind, baz, pr, tokenize='unicode61 remove_diacritics 2')`);
    // node_id: what the matched definition defines
    db.run(`CREATE VIRTUAL TABLE fts_dif USING fts5(dif, node_id UNINDEXED, tokenize='unicode61 remove_diacritics 2')`);
    // Same shape src/db.ts::searchExamples reads today.
    db.run(`
      CREATE TABLE ekzemplo (
        rowid INTEGER PRIMARY KEY,
        art TEXT NOT NULL, drv_mrk TEXT NOT NULL, sense_mrk TEXT,
        ekz_md TEXT NOT NULL, position INTEGER NOT NULL
      )`);
    const insTrd = db.prepare("INSERT INTO fts_trd(rowid, trd, ind, baz, pr) VALUES (?,?,?,?,?)");
    const insDif = db.prepare("INSERT INTO fts_dif(rowid, dif, node_id) VALUES (?,?,?)");
    const insEkz = db.prepare("INSERT INTO ekzemplo (rowid, art, drv_mrk, sense_mrk, ekz_md, position) VALUES (?,?,?,?,?,?)");

    let nTrd = 0, nDif = 0, nEkz = 0;
    for (const { article, roots, nodes } of articleTrees(db)) {
      for (const n of nodes) {
        const nodeId = idOf(n.el)!;
        // the innermost marked drv or subart the node is, or is in; else its own or nearest mark
        let drvMrk: string | null = null;
        for (let p: NodeInfo | null = n; p && drvMrk === null; p = p.parent) {
          if ((p.kind === "drv" || p.kind === "subart") && p.mrk !== null) drvMrk = p.mrk;
        }
        for (let p: NodeInfo | null = n; p && drvMrk === null; p = p.parent) drvMrk = p.mrk;
        let position = 0;
        for (const c of contentOf(n.el)) {
          const id = idOf(c.el)!;
          if (c.el.name === "trd") {
            insTrd.run(id, textIn(c.el, roots, OMIT.trd), childText(c.el, "ind", roots),
              childText(c.el, "baz", roots), childText(c.el, "pr", roots));
            nTrd++;
          } else if (c.el.name === "dif") {
            insDif.run(id, textIn(c.el, roots, OMIT.dif), nodeId);
            nDif++;
          } else if (c.el.name === "ekz") {
            const txt = textIn(c.el, roots, OMIT.ekz);
            if (txt.length > 0) {
              insEkz.run(id, article.file, drvMrk ?? article.file, n.kind === "snc" || n.kind === "subsnc" ? n.mrk : null, txt, position);
              nEkz++;
            }
            position++;
          }
        }
      }
    }
    log("fts_trd: txt + ind + baz + pr");
    log("fts_dif: definitions (reverse dictionary)");

    db.run(`CREATE INDEX idx_ekzemplo_drv ON ekzemplo(drv_mrk)`);
    db.run(`CREATE INDEX idx_ekzemplo_art ON ekzemplo(art)`);
    db.run(`
      CREATE VIRTUAL TABLE fts_ekz USING fts5(
        ekz_md, content='ekzemplo', content_rowid='rowid',
        tokenize='trigram case_sensitive 0 remove_diacritics 1')`);
    db.run(`INSERT INTO fts_ekz(fts_ekz) VALUES('rebuild')`);
    log("fts_ekz: trigram over ekzemplo");
    return nKap + nTrd + nDif + nEkz;
  },
};
