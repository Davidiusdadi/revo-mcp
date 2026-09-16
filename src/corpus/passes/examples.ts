/**
 * Pass `examples`, in the core stage: every example sentence as a row of
 * `ekzemplo`, and `fts_ekz`, the trigram index over them that finds a word
 * anywhere inside another ("hund" in "ĉashundojn").
 *
 * A row is its <ekz> under the element's id, so the example's own translations
 * are the in_ekz rows of `translation` with ids rowid..last_id, and `trd`
 * counts them: a reader skips the lookup for the 97 % of examples that have
 * none.
 *
 * `fts_ekz` keeps no positions (detail=none): 14 MB instead of 29, and a
 * query asks for a text's trigrams rather than the phrase (`trigramMatch`),
 * which finds a sentence without the text in a few cases in a thousand.
 *
 * It folds case but not diacritics. A browser opens the core file with
 * the SQLite that sqlite-wasm-http bundles (3.44.2), whose trigram tokenizer
 * refuses `remove_diacritics`, and a table it cannot construct fails every
 * query that reaches it. The full stage adds `fts_ekz_fold`, which folds them
 * too, for the server's example search (the `fts` pass).
 */
import type { NodeInfo } from "voko-xml";
import type { Pass } from "../pass";
import { idOf, lastIdOf } from "../../articles";
import { contentOf, textIn, OMIT } from "../../content";
import { articleTrees } from "../documents";

/** The index a browser reads: a tokenizer SQLite 3.44 can construct. */
export const EKZ_FTS_DDL = `
  CREATE VIRTUAL TABLE fts_ekz USING fts5(
    ekz_md, content='ekzemplo', content_rowid='rowid',
    tokenize='trigram case_sensitive 0', detail=none)`;

export const examplesPass: Pass = {
  name: "examples",
  version: 1,
  tables: ["fts_ekz", "ekzemplo"],
  run(db, log) {
    db.run(`
      CREATE TABLE ekzemplo (
        rowid     INTEGER PRIMARY KEY,   -- the <ekz>'s id
        art       TEXT NOT NULL,         -- the article's file name
        drv_mrk   TEXT NOT NULL,         -- the innermost marked drv or subart it is in, else the nearest mark
        sense_mrk TEXT,                  -- the sense's mark, when it is in a snc or subsnc
        ekz_md    TEXT NOT NULL,         -- its text, citations and translations left out
        position  INTEGER NOT NULL,      -- its place among the node's examples
        last_id   INTEGER NOT NULL,      -- the last id of its subtree: its translations are in rowid..last_id
        trd       INTEGER NOT NULL,      -- how many translations it has
        kap       TEXT                   -- the headword of the node drv_mrk names
      )`);
    const ins = db.prepare(
      `INSERT INTO ekzemplo (rowid, art, drv_mrk, sense_mrk, ekz_md, position, last_id, trd, kap)
       VALUES (?,?,?,?,?,?,?,?,?)`);
    const kapOf = db.query<{ txt: string }, [string]>(
      "SELECT h.txt FROM node n JOIN headword h ON h.id = n.kap_id WHERE n.mrk = ? LIMIT 1");
    const translated = db.query<{ c: number }, [number, number]>(
      "SELECT COUNT(*) c FROM translation WHERE id BETWEEN ? AND ? AND in_ekz = 1");

    let n = 0, withTrd = 0;
    for (const { article, roots, nodes } of articleTrees(db)) {
      for (const node of nodes) {
        const drvMrk = markOf(node) ?? article.file;
        let position = 0;
        let kap: string | null | undefined;
        for (const c of contentOf(node.el)) {
          if (c.el.name !== "ekz") continue;
          const txt = textIn(c.el, roots, OMIT.ekz);
          if (txt.length > 0) {
            const id = idOf(c.el)!, last = lastIdOf(c.el);
            const trd = translated.get(id, last)!.c;
            kap ??= kapOf.get(drvMrk)?.txt ?? null;
            ins.run(id, article.file, drvMrk, node.kind === "snc" || node.kind === "subsnc" ? node.mrk : null, txt, position, last, trd, kap);
            n++;
            if (trd > 0) withTrd++;
          }
          position++;
        }
      }
    }
    log(`ekzemplo: ${n} examples, ${withTrd} with translations`);
    db.run(EKZ_FTS_DDL);
    db.run(`INSERT INTO fts_ekz(fts_ekz) VALUES('rebuild')`);
    log("fts_ekz: trigram over ekzemplo, case folded");
    return n;
  },
};

/** The innermost marked drv or subart the node is, or is in; else its own or nearest mark. */
function markOf(n: NodeInfo): string | null {
  for (let p: NodeInfo | null = n; p; p = p.parent) {
    if ((p.kind === "drv" || p.kind === "subart") && p.mrk !== null) return p.mrk;
  }
  for (let p: NodeInfo | null = n; p; p = p.parent) if (p.mrk !== null) return p.mrk;
  return null;
}
