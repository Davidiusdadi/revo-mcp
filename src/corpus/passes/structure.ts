/**
 * Pass `structure`: what finds an entry and names it, derived from the stored
 * articles.
 *
 * - `node`: the structural elements (art, subart, drv, subdrv, snc, subsnc)
 *   under the element's own id. What is under one is the id range
 *   id..last_id in every table, and `mask` names the tables with rows in that
 *   range (articles.ts inMask), so reading a node back queries those alone.
 *   `kap_id` is its headword: its own first <kap>, else its parent's.
 * - `headword`: every <kap> under its id, its text with the tildes expanded;
 *   a variant (<var><kap>) names the headword it is a variant of.
 * - `translation`: every <trd> under its id, in the language its <trdgrp>
 *   gives it, its text without klr, pr, baz and ofc; `in_ekz` marks one that
 *   translates an example sentence, which no lookup lists.
 *
 * Content and its owners are content.ts's. The pass also checks what an entry
 * read at runtime relies on: an article's roots are its `rad` and the
 * `<rad var>` rows in its range (content.ts rootsFrom), so an entry's text is
 * rendered without reading the rest of its article.
 */
import { kapForms, type Element } from "voko-xml";
import { COMMENT, TEXT, idOf, lastIdOf, storedTablesOf } from "../../articles";
import { contentOf, childText, rootsFrom, textIn, OMIT } from "../../content";
import { articleTrees } from "../documents";
import type { Pass } from "../pass";

export const structurePass: Pass = {
  name: "structure",
  version: 1,
  tables: ["node", "headword", "translation"],
  run(db, log) {
    db.run(`
      CREATE TABLE node (
        id         INTEGER PRIMARY KEY,  -- the element's id
        article_id INTEGER NOT NULL,
        parent_id  INTEGER,              -- the node it is in
        kind       TEXT NOT NULL,        -- art | subart | drv | subdrv | snc | subsnc
        mrk        TEXT,
        kap_id     INTEGER,              -- its headword: its own first <kap>, else its parent's
        last_id    INTEGER NOT NULL,     -- the last id of its subtree
        mask       BLOB NOT NULL         -- the tables with rows in id..last_id
      )`);
    db.run(`
      CREATE TABLE headword (
        id      INTEGER PRIMARY KEY,     -- the <kap>'s id
        node_id INTEGER NOT NULL,
        main_id INTEGER,                 -- a variant's headword
        txt     TEXT NOT NULL,           -- 'malsanulejo'
        norm    TEXT NOT NULL            -- txt lowercased (NOCASE folds ASCII alone)
      )`);
    db.run(`
      CREATE TABLE translation (
        id      INTEGER PRIMARY KEY,     -- the <trd>'s id
        node_id INTEGER NOT NULL,
        lng     TEXT NOT NULL,           -- its own lng, else its <trdgrp>'s
        txt     TEXT NOT NULL,           -- klr, pr, baz and ofc left out
        ind     TEXT,                    -- the <ind> it is filed under, if any
        in_ekz  INTEGER NOT NULL         -- 1: translates an example sentence
      )`);
    const insNode = db.prepare("INSERT INTO node VALUES (?,?,?,?,?,?,?,?)");
    const insHeadword = db.prepare("INSERT INTO headword VALUES (?,?,?,?,?)");
    const insTranslation = db.prepare("INSERT INTO translation VALUES (?,?,?,?,?,?)");
    const variantRoots = db.query<{ var: string; txt: string | null }, [number, number]>(
      "SELECT var, txt FROM rad WHERE id BETWEEN ? AND ? AND var IS NOT NULL ORDER BY id");

    const tables = storedTablesOf(db);
    const tableOf = new Map(tables.map((t, i) => [t.name, i]));
    const bits = (name: string): [number, number] => {
      const i = tableOf.get(name)!;
      return i < 32 ? [1 << i, 0] : [0, 1 << (i - 32)];
    };

    let nNodes = 0, nHeadwords = 0, nTranslations = 0;
    for (const { article, art, roots, nodes } of articleTrees(db)) {
      const stored = rootsFrom(article.rad, variantRoots.all(article.id, article.last_id));
      if (stored.rad !== roots.rad || JSON.stringify(stored.byVar) !== JSON.stringify(roots.byVar)) {
        throw new Error(`${article.file}: its rad and <rad var> rows give roots ${JSON.stringify(stored)}, the article ${JSON.stringify(roots)}`);
      }

      const isNode = new Set(nodes.map((n) => n.el));
      const masks = new Map<Element, Uint8Array>();
      const maskUnder = (el: Element): [number, number] => {
        let [lo, hi] = bits(el.name);
        for (const c of el.children) {
          if (idOf(c) === undefined) continue;
          const [l, h] = c.type === "element" ? maskUnder(c) : bits(c.type === "text" ? TEXT : COMMENT);
          lo |= l;
          hi |= h;
        }
        if (isNode.has(el)) masks.set(el, maskBytes(lo, hi));
        return [lo, hi];
      };
      maskUnder(art);

      const kapOf = new Map<Element, number | null>();
      for (const n of nodes) {
        const id = idOf(n.el)!;
        let kap: number | null = null;
        for (const c of contentOf(n.el)) {
          if (c.el.name === "kap") {
            const forms = kapForms(c.el, roots);
            insHeadword.run(idOf(c.el)!, id, c.main ? idOf(c.main)! : null, forms.txt, forms.norm);
            if (kap === null && !c.main) kap = idOf(c.el)!;
            nHeadwords++;
          } else if (c.el.name === "trd") {
            insTranslation.run(idOf(c.el)!, id, c.lng!, textIn(c.el, roots, OMIT.trd), childText(c.el, "ind", roots),
              c.owner === "ekz" ? 1 : 0);
            nTranslations++;
          }
        }
        kap ??= n.parent ? kapOf.get(n.parent.el)! : null;
        kapOf.set(n.el, kap);
        insNode.run(id, article.id, n.parent ? idOf(n.parent.el)! : null, n.kind, n.mrk, kap, lastIdOf(n.el), masks.get(n.el)!);
        nNodes++;
      }
    }
    db.run("CREATE INDEX idx_node_mrk ON node(mrk)");
    log(`node ${nNodes}, headword ${nHeadwords}, translation ${nTranslations}; roots of every article check`);
    return nNodes + nHeadwords + nTranslations;
  },
};

/** Table bits 0–31 and 32–63 as a mask, without trailing zero bytes. */
function maskBytes(lo: number, hi: number): Uint8Array {
  const bytes = [0, 8, 16, 24].map((s) => (lo >>> s) & 0xff).concat([0, 8, 16, 24].map((s) => (hi >>> s) & 0xff));
  while (bytes.length > 0 && bytes[bytes.length - 1] === 0) bytes.pop();
  return Uint8Array.from(bytes);
}
