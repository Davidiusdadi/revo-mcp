/**
 * The articles stored as tables: a slice of the corpus and a few hand-written
 * files go in, and must come back as the trees they parsed to. The full corpus
 * is checked the same way by the import itself.
 */
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { Database } from "../src/runtime/node-database";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { articleOf, descendants, domEqual, outerXml, readArticle, serialize, type ArticleSource, type Element } from "voko-xml";
import { documentsOf, maskOf, readRange, storedTablesOf, type StoredArticle } from "../src/articles";
import { importDocuments } from "../src/corpus/documents";
import { corpusArticles } from "../src/corpus/sources";

const PROLOG = '<?xml version="1.0"?>\n<!DOCTYPE vortaro SYSTEM "../dtd/vokoxml.dtd">\n';
// what the corpus rarely or never has: comments around the root, <x></x>, a
// byte order mark leading a text, text runs between inline elements, whitespace
// that is not the usual indentation. Its attributes are in the DTD's order, the
// one order they come back in.
const HANDMADE: Record<string, string> = {
  zzprov: `${PROLOG}<!-- antaŭe -->
<vortaro>
<art mrk="$Id: zzprov.xml,v 1.1 2026/01/01 00:00:00 revo Exp $">
<kap><rad>prov</rad>/i</kap>
<drv mrk="zzprov.0i">
  <kap><tld/>i</kap>
  <dif>Fari <ref tip="sin" cel="test.0i">teston</ref>,   por <em>vidi</em>
    ĉu io funkcias.<!-- rim --></dif>
  <ekz>&#65279;<tld/>u ĝin<fnt></fnt></ekz>
  <trd lng="de">versuchen</trd>	<trd lng="en"></trd>
</drv>
</art>
</vortaro>
<!-- poste -->
`,
};

let dir: string;
let db: Database;
let sources: ArticleSource[];

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "voko-documents-"));
  for (const [key, xml] of Object.entries(HANDMADE)) writeFileSync(join(dir, `${key}.xml`), xml);
  const handmade = Object.keys(HANDMADE).map((key): ArticleSource => ({ key, path: join(dir, `${key}.xml`), source: "overlay" }));
  sources = [
    ...corpusArticles().filter((a, i) => i < 40 || ["hipnot", "hister", "san", "cxeval", "aidos", "unu"].includes(a.key)),
    ...handmade,
  ];
  db = new Database(join(dir, "documents.db"));
  importDocuments(db, sources, { batch: 16 });
});
afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true });
});

const articleRow = (file: string) =>
  db.query<StoredArticle, [string]>("SELECT id, last_id, file, source, rad FROM article WHERE file = ?").get(file)!;

/** Where the subtree of the element at `id` ends: before the first row after it whose parent lies before it. */
function lastIdOf(id: number, articleLast: number): number {
  let last = articleLast;
  for (const t of storedTablesOf(db)) {
    const row = db.query<{ m: number | null }, [number, number, number]>(
      `SELECT MIN(id) AS m FROM ${t.table} WHERE id > ? AND id <= ? AND (up IS NULL OR parent < ?)`).get(id, articleLast, id);
    if (row?.m != null) last = Math.min(last, row.m - 1);
  }
  return last;
}

describe("stored articles", () => {
  test("every article reads back as the tree its file parsed to", () => {
    const byKey = new Map(sources.map((s) => [s.key, s]));
    let n = 0;
    for (const { article, doc } of documentsOf(db, { batch: 7 })) {
      const original = readArticle(byKey.get(article.file)!);
      expect(domEqual(doc.root, original.root)).toBe(true);
      expect(doc.prolog).toEqual(original.prolog);
      expect([doc.xmlDecl, doc.doctype]).toEqual([original.xmlDecl, original.doctype]);
      n++;
    }
    expect(n).toBe(sources.length);
  });

  test("a hand-written article comes back byte for byte", () => {
    const [{ doc }] = [...documentsOf(db, { from: articleRow("zzprov").id })];
    expect(serialize(doc)).toBe(serialize(readArticle(sources.find((s) => s.key === "zzprov")!)));
    expect(serialize(doc)).toContain("<!-- poste -->");
    expect(serialize(doc)).toContain("<fnt></fnt>");
    expect(serialize(doc)).toContain("\uFEFF");
  });

  test("the byte order mark in hipnot survives", () => {
    const { id, last_id } = articleRow("hipnot");
    const text = JSON.stringify(readRange(db, id, last_id), (k, v) => (k === "parent" ? undefined : v));
    expect(text).toContain("\uFEFFC. Baudoin");
  });

  test("article rows: file, source, main root", () => {
    expect(articleRow("san")).toMatchObject({ source: "fonto", rad: "san" });
    expect(articleRow("zzprov")).toMatchObject({ source: "overlay", rad: "prov" });
    expect(db.query("SELECT value FROM meta WHERE key = 'doctype'").get()).toEqual({ value: 'vortaro SYSTEM "../dtd/vokoxml.dtd"' });
  });

  test("folding: sole text into txt, standard indentation as NULL", () => {
    const { id, last_id } = articleRow("zzprov");
    const kap = db.query<{ txt: string | null; ws: string | null }, [number, number]>(
      "SELECT txt, ws FROM kap WHERE id BETWEEN ? AND ? ORDER BY id").all(id, last_id);
    expect(kap[0]).toEqual({ txt: null, ws: null });
    expect(kap[1]).toEqual({ txt: null, ws: null });
    const trd = db.query<{ txt: string | null; ws: string | null; open: number | null }, [number, number]>(
      "SELECT txt, ws, open FROM trd WHERE id BETWEEN ? AND ? ORDER BY id").all(id, last_id);
    expect(trd).toEqual([{ txt: "versuchen", ws: null, open: null }, { txt: null, ws: "\t", open: 1 }]);
    expect(db.query("SELECT COUNT(*) AS n FROM text WHERE txt = 'versuchen'").get()).toEqual({ n: 0 });
  });

  test("a subtree read at its depth is the element as the file wrote it", () => {
    const { id, last_id } = articleRow("san");
    const drvs = [...descendants(articleOf(readArticle(sources.find((s) => s.key === "san")!)), "drv")];
    const ids = db.query<{ id: number }, [number, number]>("SELECT id FROM drv WHERE id BETWEEN ? AND ? ORDER BY id").all(id, last_id);
    expect(ids.length).toBe(drvs.length);
    ids.forEach(({ id: drv }, i) => {
      const [el, ...rest] = readRange(db, drv, lastIdOf(drv, last_id), { depth: 2 });
      expect(rest).toEqual([]);
      expect(outerXml(el as Element)).toBe(outerXml(drvs[i]));
    });
  });

  test("a mask limits the tables read", () => {
    const { id, last_id } = articleRow("zzprov");
    const tables = storedTablesOf(db);
    const all = readRange(db, id, last_id);
    const withRows = maskOf(tables.flatMap((t, i) =>
      db.query(`SELECT 1 FROM ${t.table} WHERE id BETWEEN ? AND ? LIMIT 1`).get(id, last_id) ? [i] : []));
    expect(domEqual(readRange(db, id, last_id, { mask: withRows })[1], all[1])).toBe(true);
    const noRef = maskOf(tables.flatMap((t, i) => (t.name === "ref" ? [] : [i])));
    const [, root] = readRange(db, id, last_id, { mask: noRef });
    expect(outerXml(root as Element)).not.toContain("<ref");
    expect(outerXml(root as Element)).toContain("<em>vidi</em>");
  });
});

describe("the import refuses", () => {
  const importing = (key: string, xml: string) => () => {
    const scratch = mkdtempSync(join(tmpdir(), "voko-refused-"));
    try {
      writeFileSync(join(scratch, "a.xml"), `${PROLOG}<vortaro><art mrk="a"><kap>a</kap></art></vortaro>`);
      writeFileSync(join(scratch, `${key}.xml`), xml);
      const into = new Database(":memory:");
      importDocuments(into, ["a", key].map((k): ArticleSource => ({ key: k, path: join(scratch, `${k}.xml`), source: "overlay" })));
    } finally {
      rmSync(scratch, { recursive: true });
    }
  };

  test("an element or attribute the DTD does not declare", () => {
    expect(importing("b", `${PROLOG}<vortaro><art mrk="b"><kap>b</kap><nova/></art></vortaro>`)).toThrow("not in the DTD");
    expect(importing("b", `${PROLOG}<vortaro><art mrk="b" nova="1"><kap>b</kap></art></vortaro>`)).toThrow("art@nova");
  });

  test("a declaration or doctype unlike the other articles'", () => {
    expect(importing("b", `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE vortaro SYSTEM "../dtd/vokoxml.dtd">\n<vortaro><art mrk="b"><kap>b</kap></art></vortaro>`)).toThrow("differs");
  });
});
