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
import { childText, contentOf, inEsperanto, textIn, OMIT } from "../../content";
import { articleTrees } from "../documents";

export const ftsPass: Pass = {
  name: "fts",
  version: 3,
  tables: ["fts_kap", "fts_trd", "fts_dif", "fts_ekz_fold"],
  run(db, log) {
    if (!db.query("SELECT 1 FROM sqlite_master WHERE name = 'ekzemplo'").get()) {
      throw new Error("The fts pass indexes the examples: run the examples pass first.");
    }
    db.run(`CREATE VIRTUAL TABLE fts_kap USING fts5(kap, tokenize='unicode61 remove_diacritics 2')`);
    db.run(`INSERT INTO fts_kap(rowid, kap) SELECT id, txt FROM headword`);
    const nKap = db.query<{ c: number }, []>("SELECT COUNT(*) c FROM headword").get()!.c;
    log("fts_kap: headwords incl. variants");

    // Translation + its index word, base form and transcription, so pinyin /
    // hiragana / Indonesian base forms are searchable too.
    db.run(`CREATE VIRTUAL TABLE fts_trd USING fts5(trd, ind, baz, pr, tokenize='unicode61 remove_diacritics 2')`);
    // node_id: what the matched definition defines
    db.run(`CREATE VIRTUAL TABLE fts_dif USING fts5(dif, node_id UNINDEXED, tokenize='unicode61 remove_diacritics 2')`);
    const insTrd = db.prepare("INSERT INTO fts_trd(rowid, trd, ind, baz, pr) VALUES (?,?,?,?,?)");
    const insDif = db.prepare("INSERT INTO fts_dif(rowid, dif, node_id) VALUES (?,?,?)");

    let nTrd = 0, nDif = 0;
    for (const { roots, nodes } of articleTrees(db)) {
      for (const n of nodes) {
        const nodeId = idOf(n.el)!;
        for (const c of contentOf(n.el)) {
          const id = idOf(c.el)!;
          if (c.el.name === "trd") {
            insTrd.run(id, textIn(c.el, roots, OMIT.trd), childText(c.el, "ind", roots),
              childText(c.el, "baz", roots), childText(c.el, "pr", roots));
            nTrd++;
          } else if (c.el.name === "dif" && inEsperanto(c.el)) {
            insDif.run(id, textIn(c.el, roots, OMIT.dif), nodeId);
            nDif++;
          }
        }
      }
    }
    log("fts_trd: txt + ind + baz + pr");
    log("fts_dif: definitions (reverse dictionary)");

    db.run(`
      CREATE VIRTUAL TABLE fts_ekz_fold USING fts5(
        ekz_md, content='ekzemplo', content_rowid='rowid',
        tokenize='trigram case_sensitive 0 remove_diacritics 1')`);
    db.run(`INSERT INTO fts_ekz_fold(fts_ekz_fold) VALUES('rebuild')`);
    log("fts_ekz_fold: trigram over ekzemplo, case and diacritics folded");
    return nKap + nTrd + nDif;
  },
};
