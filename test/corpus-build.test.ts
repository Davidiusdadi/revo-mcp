/**
 * Builds a small slice of the corpus into a temp DB and checks the L2 tables,
 * coverage, derived text, and the compatibility views. The full-corpus
 * coverage check runs inside `bun run corpus:build` itself.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { buildL2, PASSES } from "../src/corpus/build";
import { runPass } from "../src/corpus/pass";
import { sensesOf } from "../src/db-voko";
import { lemmaCandidates } from "../src/morph";
import { parse, descendants } from "voko-xml";

let dir: string;
let db: Database;
// hand-picked on top of the first 120 (which include a subdrv in `a` and a subart in `acx`):
// mal~ulejo needs san plus the mal/ul/ej affix articles; hund prt lup for the ref graph
const EXTRA = ["san", "mal", "ul", "ej", "hund", "lup"];

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "voko-build-"));
  db = buildL2(join(dir, "slice.db"), 120, EXTRA);
  for (const p of PASSES) runPass(db, p, () => {});
});
afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true });
});

const one = <T>(sql: string, ...params: unknown[]) => db.query(sql).get(...(params as [])) as T;
const all = <T>(sql: string, ...params: unknown[]) => db.query(sql).all(...(params as [])) as T[];

describe("corpus build", () => {
  test("meta describes the build", () => {
    expect(one<{ value: string }>("SELECT value FROM meta WHERE key='schema'").value).toBe("voko");
    expect(Number(one<{ value: string }>("SELECT value FROM meta WHERE key='articles'").value)).toBe(120 + EXTRA.length);
    const passes = all<{ pass: string }>("SELECT pass FROM meta_pass").map((r) => r.pass);
    for (const p of PASSES) expect(passes).toContain(p.name);
  });

  test("article, nodes and headwords", () => {
    const art = one<{ id: number; rad: string; rev: string }>("SELECT id, rad, rev FROM art WHERE file='abel'");
    expect(art.rad).toBe("abel");
    expect(art.rev).toMatch(/^\d+\.\d+$/);
    const drvs = all<{ mrk: string; key: string; mrk_near: string }>(
      "SELECT mrk, key, mrk_near FROM node WHERE art_id=? AND kind='drv' ORDER BY ord", art.id);
    expect(drvs[0].key).toBe("abel/drv[0]");
    expect(drvs[0].mrk).toBe("abel.0o");
    const kap = one<{ txt: string; tilde: string }>(
      "SELECT txt, tilde FROM kap WHERE node_id=(SELECT id FROM node WHERE mrk='abel.0ujo')");
    expect(kap).toEqual({ txt: "abelujo", tilde: "~ujo" });
    // sense without mrk inherits the drv's mrk as mrk_near
    const near = all<{ mrk: string | null; mrk_near: string }>(
      "SELECT mrk, mrk_near FROM node WHERE kind='snc' AND mrk IS NULL LIMIT 5");
    for (const n of near) expect(n.mrk_near).toBeTruthy();
  });

  test("examples drop citations, keep the citation structured", () => {
    const e = one<{ id: number; txt: string; owner_kind: string }>(
      "SELECT id, txt, owner_kind FROM ekz WHERE node_id IN (SELECT id FROM node WHERE mrk_near LIKE 'abel.0o%') ORDER BY id LIMIT 1");
    expect(e.txt.length).toBeGreaterThan(5);
    expect(e.txt).not.toMatch(/PIV|Fab|MT/);
    expect(e.owner_kind).toBe("dif");
    const f = one<{ c: number }>("SELECT COUNT(*) c FROM fnt WHERE owner_kind='ekz' AND owner_id=?", e.id);
    expect(f.c).toBeGreaterThanOrEqual(0);
    expect(one<{ c: number }>("SELECT COUNT(*) c FROM fnt WHERE bib IS NOT NULL").c).toBeGreaterThan(50);
  });

  test("translations keep lng from trdgrp and split pr/ind/klr", () => {
    const grp = one<{ c: number }>("SELECT COUNT(*) c FROM trd WHERE grp IS NOT NULL AND lng <> ''").c;
    expect(grp).toBeGreaterThan(0);
    expect(one<{ c: number }>("SELECT COUNT(*) c FROM trd WHERE lng = ''").c).toBe(0);
    const pr = one<{ txt: string; pr: string }>("SELECT txt, pr FROM trd WHERE pr IS NOT NULL LIMIT 1");
    expect(pr.txt).not.toContain(pr.pr);
    const klr = one<{ txt: string; klr: string; xml: string }>("SELECT txt, klr, xml FROM trd WHERE klr IS NOT NULL LIMIT 1");
    expect(klr.xml).toContain("<klr");
    expect(klr.txt).not.toContain("<");
    expect(klr.txt).not.toContain(`(${klr.klr})`);
  });

  test("references inherit tip from refgrp", () => {
    expect(one<{ c: number }>("SELECT COUNT(*) c FROM ref WHERE grp IS NOT NULL AND tip IS NULL").c).toBe(0);
    expect(one<{ c: number }>("SELECT COUNT(*) c FROM ref WHERE cel = ''").c).toBe(0);
  });

  test("compat views have the old shapes", () => {
    const n = one<{ mrk: string; art: string; kap: string; kap_norm: string }>(
      "SELECT mrk, art, kap, kap_norm FROM nodo WHERE mrk='abel.0ujo'");
    expect(n).toEqual({ mrk: "abel.0ujo", art: "abel", kap: "abelujo", kap_norm: "abelujo" });
    const t = all<{ lng: string; trd: string }>("SELECT lng, trd FROM traduko WHERE mrk='abel.0o' AND lng='en'");
    expect(t.map((r) => r.trd)).toContain("bee");
    expect(all("SELECT * FROM referenco LIMIT 3").length).toBe(3);
    expect(all("SELECT * FROM uzo_compat LIMIT 3").length).toBe(3);
  });

  test("fts tables answer", () => {
    expect(all("SELECT rowid FROM fts_kap WHERE fts_kap MATCH 'abelujo'").length).toBeGreaterThan(0);
    expect(all("SELECT rowid FROM fts_ekz WHERE fts_ekz MATCH '\"abel\"' LIMIT 3").length).toBeGreaterThan(0);
    const word = one<{ txt: string }>("SELECT txt FROM dif WHERE length(txt) > 40 LIMIT 1").txt.match(/\p{L}{5,}/u)![0];
    expect(all("SELECT rowid FROM fts_dif WHERE fts_dif MATCH ? LIMIT 3", word).length).toBeGreaterThan(0);
  });
});

describe("reading L2 the way db.ts does", () => {
  test("definitions keep inline <trd> (Latin names) as running text", () => {
    const rows = all<{ dif: string; trd: string }>(
      "SELECT d.txt dif, t.txt trd FROM trd t JOIN dif d ON d.id = t.owner_id WHERE t.owner_kind='dif' AND t.grp IS NULL LIMIT 20");
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.dif).toContain(r.trd);
  });

  test("traduko.rowid is fts_trd.rowid", () => {
    const r = one<{ mrk: string; trd: string }>(
      "SELECT t.mrk, t.trd FROM fts_trd f JOIN traduko t ON t.rowid = f.rowid WHERE f.trd MATCH 'bee' LIMIT 1");
    expect(r.trd.toLowerCase()).toContain("bee");
    expect(r.mrk).toBeTruthy();
  });

  test("sensesOf: numbered senses with their own examples", () => {
    const multi = one<{ mrk: string; n: number }>(
      `SELECT d.mrk, COUNT(*) n FROM node d JOIN node s ON s.parent_id = d.id
       WHERE d.kind='drv' AND s.kind='snc' GROUP BY d.id HAVING n > 1
         -- flat: only snc children, none with subsenses
         AND NOT EXISTS (SELECT 1 FROM node c WHERE c.parent_id = d.id AND c.kind <> 'snc')
         AND NOT EXISTS (SELECT 1 FROM node g JOIN node c ON g.parent_id = c.id WHERE c.parent_id = d.id)
       LIMIT 1`);
    const senses = sensesOf(db, multi.mrk);
    expect(senses.map((s) => s.num).slice(-multi.n)).toEqual(
      Array.from({ length: multi.n }, (_, i) => `${i + 1}.`));
    for (const s of senses) expect(s.definition.length + s.examples.length).toBeGreaterThan(0);
    const ekz = one<{ c: number }>(
      `SELECT COUNT(*) c FROM ekz WHERE node_id IN
         (SELECT id FROM node WHERE id = (SELECT id FROM node WHERE mrk = ?) OR parent_id = (SELECT id FROM node WHERE mrk = ?))`,
      multi.mrk, multi.mrk).c;
    expect(senses.reduce((a, s) => a + s.examples.length, 0)).toBe(ekz);
  });

  test("sensesOf: a single sense is unnumbered, subsenses get letters", () => {
    const single = one<{ mrk: string }>(
      `SELECT d.mrk FROM node d JOIN node s ON s.parent_id = d.id
       WHERE d.kind='drv' AND s.kind='snc' GROUP BY d.id HAVING COUNT(*) = 1
         AND NOT EXISTS (SELECT 1 FROM node g JOIN node c ON g.parent_id = c.id WHERE c.parent_id = d.id)
       LIMIT 1`);
    expect(sensesOf(db, single.mrk).at(-1)!.num).toBe("");
    const sub = one<{ mrk: string } | null>(
      `SELECT d.mrk FROM node x JOIN node s ON s.id = x.parent_id JOIN node d ON d.id = s.parent_id
       WHERE x.kind='subsnc' AND d.kind='drv' AND d.mrk IS NOT NULL LIMIT 1`);
    expect(sub).toBeTruthy();
    expect(sensesOf(db, sub!.mrk).map((s) => s.num)).toContain("a)");
  });

  test("sensesOf: unknown mrk gives no senses", () => {
    expect(sensesOf(db, "ne.0ekzistas")).toEqual([]);
  });
});

describe("fixes from the parity report", () => {
  test("headwords drop the separator before <var>", () => {
    expect(one<{ c: number }>(
      "SELECT COUNT(*) c FROM kap WHERE txt LIKE '%,' OR tilde LIKE '%,' OR txt LIKE '% '").c).toBe(0);
  });

  test("article-level variants are filed under the first derivation", () => {
    expect(one<{ c: number }>("SELECT COUNT(*) c FROM var WHERE mrk IS NULL").c).toBe(0);
  });

  test("<ctl> renders with quotes", () => {
    const rows = all<{ txt: string }>("SELECT txt FROM ekz WHERE xml LIKE '%<ctl>%' LIMIT 10");
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.txt).toContain("„");
  });

  test("traduko.trd is the <ind> form when marked", () => {
    const t = one<{ id: number; ind: string; txt: string }>(
      "SELECT id, ind, txt FROM trd WHERE ind IS NOT NULL AND ind <> txt AND owner_kind <> 'ekz' LIMIT 1");
    const v = one<{ trd: string; txt: string }>("SELECT trd, txt FROM traduko WHERE rowid = ?", t.id);
    expect(v.trd).toBe(t.ind);
    expect(v.txt).toContain(t.txt);
  });

  test("traduko leaves out translations of examples, as upstream", () => {
    const e = one<{ id: number }>("SELECT id FROM trd WHERE owner_kind = 'ekz' LIMIT 1");
    expect(e).toBeTruthy();
    expect(one("SELECT 1 FROM traduko WHERE rowid = ?", e.id)).toBeNull();
  });
});

describe("pass tld-links", () => {
  test("every <tld/> is one row", () => {
    let n = 0;
    for (const { xml } of all<{ xml: string }>("SELECT xml FROM art")) n += [...descendants(parse(xml).root, "tld")].length;
    expect(one<{ c: number }>("SELECT COUNT(*) c FROM x_tld_occ").c).toBe(n);
  });

  test("the token is in its owner's text", () => {
    const rows = all<{ norm: string; txt: string }>(
      `SELECT o.norm, COALESCE(e.txt, d.txt, r.txt, k.txt) txt FROM x_tld_occ o
       LEFT JOIN ekz e ON o.owner_kind = 'ekz' AND e.id = o.owner_id
       LEFT JOIN dif d ON o.owner_kind = 'dif' AND d.id = o.owner_id
       LEFT JOIN rim r ON o.owner_kind = 'rim' AND r.id = o.owner_id
       LEFT JOIN kap k ON o.owner_kind = 'kap' AND k.id = o.owner_id
       WHERE o.owner_kind IN ('ekz','dif','rim','kap')`);
    expect(rows.length).toBeGreaterThan(1000);
    const found = rows.filter((r) => r.txt.toLowerCase().includes(r.norm)).length;
    expect(found / rows.length).toBeGreaterThan(0.99);
  });

  test("a headword's tilde splits it into prefix, root and rest", () => {
    const o = one<{ pre: string; rad: string; post: string }>(
      `SELECT o.pre, o.rad, o.post FROM x_tld_occ o JOIN kap k ON k.id = o.owner_id
       WHERE o.owner_kind = 'kap' AND k.norm = 'malsanulejo'`);
    expect(o).toEqual({ pre: "mal", rad: "san", post: "ulejo" });
  });
});

describe("pass refs", () => {
  test("every ref is an authored edge or an issue", () => {
    const refs = one<{ c: number }>("SELECT COUNT(*) c FROM ref").c;
    const authored = one<{ c: number }>("SELECT COUNT(*) c FROM x_ref_edge WHERE inferred = 0").c;
    const issues = one<{ c: number }>("SELECT COUNT(*) c FROM x_ref_issue").c;
    expect(authored + issues).toBe(refs);
  });

  test("inferred edges are the ontology's inverses and never repeat an authored edge", () => {
    expect(one<{ c: number }>("SELECT COUNT(*) c FROM x_ref_edge WHERE inferred = 1").c).toBeGreaterThan(0);
    expect(one<{ c: number }>(
      `SELECT COUNT(*) c FROM x_ref_edge e JOIN ref r ON r.id = e.ref_id JOIN x_ref_tip t ON t.tip = r.tip
       WHERE e.inferred = 1 AND t.inverse IS NOT e.tip`).c).toBe(0);
    expect(one<{ c: number }>(
      `SELECT COUNT(*) c FROM x_ref_edge e WHERE e.inferred = 1 AND EXISTS (
         SELECT 1 FROM x_ref_edge a WHERE a.inferred = 0 AND a.src_node = e.src_node
           AND a.dst_node = e.dst_node AND a.tip IS e.tip)`).c).toBe(0);
  });

  test("hundo has lupo as a part, so lupo belongs to hundo", () => {
    const e = all<{ tip: string }>(
      `SELECT e.tip FROM x_ref_edge e JOIN node s ON s.id = e.src_node JOIN node d ON d.id = e.dst_node
       WHERE s.mrk = 'lup.0o' AND d.mrk_near LIKE 'hund.0o%'`);
    expect(e.map((r) => r.tip)).toContain("malprt");
  });
});

describe("pass morph", () => {
  test("every headword gets a segmentation", () => {
    expect(one<{ c: number }>("SELECT COUNT(*) c FROM x_morph").c).toBe(one<{ c: number }>("SELECT COUNT(*) c FROM kap").c);
  });

  test("mal~ulejo = mal|san|ul|ej|o, root pinned by the tilde", () => {
    expect(one<{ seg: string; kinds: string; source: string }>(
      "SELECT seg, kinds, source FROM x_morph WHERE form = 'malsanulejo'")).toEqual(
      { seg: "mal|san|ul|ej|o", kinds: "PRSSE", source: "tilde" });
  });

  test("attested forms are tied to a headword of their own article", () => {
    expect(one<{ c: number }>(
      `SELECT COUNT(*) c FROM x_token t JOIN kap k ON k.id = t.lemma_kap_id JOIN node n ON n.id = k.node_id
       WHERE n.art_id <> t.art_id`).c).toBe(0);
    const infl = all<{ norm: string; lemma: string }>(
      `SELECT t.norm, k.norm lemma FROM x_token t JOIN kap k ON k.id = t.lemma_kap_id WHERE t.how = 'infl'`);
    expect(infl.length).toBeGreaterThan(50);
    for (const r of infl) expect(lemmaCandidates(r.norm).map((c) => c.lemma)).toContain(r.lemma);
  });
});
