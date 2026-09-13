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
import { TOKEN_GROUPS } from "../src/corpus/passes/morph";
import { sensesOf, thesaurusOf, searchDefinitions } from "../src/db-voko";
import { lemmaCandidates } from "../src/morph";
import { parse, descendants } from "voko-xml";

let dir: string;
let db: Database;
// hand-picked on top of the first 120 (which include a subdrv in `a` and a subart in `acx`):
// mal~ulejo needs san plus the mal/ul/ej affix articles; hund prt lup for the ref graph;
// unu and li each hold a <trdgrp> nested inside a translation's <klr>; cxeval writes
// some of its tildes with lit="Ĉ", which is where a wrong root pin came from;
// aidos has a <var> whose kap carries a <fnt> and a <uzo> next to it; in bel the
// synonyms belong to malbeligi and plibeligi, not to bela (figur and ornam hold them);
// fer writes the headword hufofero without a tilde, and ofer is the root that
// swallows the linking o when nothing pins fer
const EXTRA = ["san", "mal", "ul", "ej", "hund", "lup", "unu", "li", "cxeval", "aidos", "bel", "figur", "ornam", "fer", "huf", "ofer"];

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

  // The DTD lets <klr> hold trd/trdgrp, which ReVo uses to gloss a translation
  // in a third language: `unu` has Finnish inside a Spanish trd, `li` Ido inside
  // an Indonesian one. <trd> used to be a leaf to the extractor, so the inventory
  // counted these and no row was written.
  test("translations nested in a translation's <klr> are kept", () => {
    const nested = all<{ file: string; lng: string; txt: string }>(
      `SELECT a.file, t.lng, t.txt FROM trd t
         JOIN node n ON t.node_id = n.id JOIN art a ON n.art_id = a.id
        WHERE t.owner_kind = 'klr' AND a.file IN ('unu', 'li') ORDER BY a.file, t.id`);
    expect(nested.map((r) => `${r.file}:${r.lng}:${r.txt}`)).toEqual([
      "li:io:ilu", "li:io:il", "unu:fi:alayksikkö", "unu:fi:kerrannaisyksikkö",
    ]);

    // the language is the nested <trdgrp lng>, not the enclosing translation's
    const outer = all<{ lng: string }>(
      `SELECT t.lng FROM trd t JOIN node n ON t.node_id = n.id JOIN art a ON n.art_id = a.id
        WHERE a.file IN ('unu', 'li') AND t.owner_kind = 'node' AND t.xml LIKE '%<trdgrp%'`);
    expect(outer.map((r) => r.lng).sort()).toEqual(["es", "id"]);

    // and they reach the compat view, so lookup answers with them
    for (const r of nested) {
      expect(one("SELECT 1 FROM traduko WHERE lng = ? AND trd = ?", r.lng, r.txt)).toBeTruthy();
    }
  });

  test("what stands beside a <var> is filed under the variant headword", () => {
    // aidos: <var><kap>aideso <fnt>SPIV</fnt></kap><uzo>ARK</uzo></var> — the
    // <fnt> inside the variant kap used to be taken for the variant itself
    const u = one<{ txt: string; kap: string | null }>(
      `SELECT u.txt, (SELECT k.txt FROM kap k WHERE k.id = u.owner_id) kap
         FROM uzo u WHERE u.owner_kind = 'var' AND u.txt = 'ARK'
          AND u.owner_id IN (SELECT k.id FROM kap k JOIN node n ON n.id = k.node_id
                              WHERE n.art_id = (SELECT id FROM art WHERE file = 'aidos'))`);
    expect(u.kap).toBe("aideso");

    // and no var owner anywhere points at something that is not a headword
    for (const t of ["uzo", "ekz", "ref", "fnt", "trd"]) {
      expect(one<{ c: number }>(
        `SELECT COUNT(*) c FROM ${t} WHERE owner_kind = 'var'
          AND owner_id NOT IN (SELECT id FROM kap)`).c).toBe(0);
    }
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

  test("a headword written out in full is pinned on its article's root", () => {
    // <kap>hufofero</kap> in fer: free, the segmenter prefers huf|ofer|o
    expect(one<{ seg: string; source: string }>(
      "SELECT seg, source FROM x_morph WHERE form = 'hufofero'")).toEqual(
      { seg: "huf|o|fer|o", source: "tilde" });
  });

  test("every root in a segmentation is a root the inventory knows", () => {
    // The pinned root used to be assembled from two different <tld/> rows (an
    // offset from one, a root from another), which stamped spans like "ĉeva"
    // as roots of words no article has.
    const known = new Set(
      all<{ morph: string }>("SELECT morph FROM x_morpheme WHERE kind = 'R'").map((r) => r.morph)
    );
    const invented = new Set<string>();
    for (const t of all<{ norm: string; seg: string; kinds: string }>(
      "SELECT norm, seg, kinds FROM x_token WHERE ok = 1")) {
      const words = t.seg.split(" ");
      const kinds = t.kinds.split(" ");
      for (let w = 0; w < words.length; w++) {
        const ms = words[w].split("|");
        for (let i = 0; i < ms.length; i++) {
          if (kinds[w][i] === "R" && !known.has(ms[i])) invented.add(`${t.norm}: ${words[w]}`);
        }
      }
    }
    expect([...invented]).toEqual([]);
  });

  test("the tilde pin comes from one occurrence, not two", () => {
    // cxeval writes some tildes as <tld lit="Ĉ"/>, so its occurrences of
    // "ĉevalo" differ in pre and rad; the pass must not mix them.
    const groups = all<{ norm: string; art_id: number; pre: string; rad: string }>(TOKEN_GROUPS);
    expect(groups.length).toBeGreaterThan(100);
    const bad = groups.filter((g) => !one(
      `SELECT 1 FROM x_tld_occ WHERE norm = ? AND art_id = ? AND owner_kind <> 'kap'
         AND pre = ? AND rad = ?`, g.norm, g.art_id, g.pre, g.rad));
    expect(bad.map((g) => `${g.norm}: ${g.pre}|${g.rad}`)).toEqual([]);
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

// The reads behind the thesaurus and reverse_lookup tools. They only work on a
// corpus with the x_* tables, so they are exercised here on the slice rather
// than through db.ts, which is bound to whichever DB REVO_DB names.
describe("enrichment reads", () => {
  test("thesaurus groups a word's relations by type", () => {
    const t = thesaurusOf(db, "hundo")!;
    expect(t.headword).toBe("hundo");
    expect(t.article).toBe("hund");
    expect(t.groups.length).toBeGreaterThan(0);
    // every entry names a real article, and groups carry the ontology's label
    for (const g of t.groups) {
      expect(g.label.length).toBeGreaterThan(0);
      for (const e of g.entries) expect(e.article.length).toBeGreaterThan(0);
    }
  });

  test("thesaurus reports links the word's own article never states", () => {
    const entries = thesaurusOf(db, "hundo")!.groups.flatMap((g) => g.entries);
    expect(entries.map((e) => e.headword)).toContain("lupo");
    // lup states the relation; hund gets it as the entailed inverse
    expect(entries.some((e) => e.inferred)).toBe(true);
  });

  test("a word is not listed as related to itself, but its derivations are", () => {
    const entries = thesaurusOf(db, "hundo")!.groups.flatMap((g) => g.entries);
    expect(entries.map((e) => e.headword)).not.toContain("hundo");
    // refs between senses of hund resolve to 'hundo'; other hund headwords stay
    expect(entries.some((e) => e.article === "hund")).toBe(true);
  });

  test("a word's relations are not its sibling derivations'", () => {
    // bel's article kap reads "bela", so the query matches the article node too
    const bela = thesaurusOf(db, "bela")!;
    expect(bela.groups.find((g) => g.tip === "sin")).toBeUndefined();
    // the synonym stays with the derivation that states it
    const malbeligi = thesaurusOf(db, "malbeligi")!;
    expect(malbeligi.groups.find((g) => g.tip === "sin")!.entries.map((e) => e.headword)).toContain("misfigurigi");
  });

  test("thesaurus accepts an inflected form", () => {
    const t = thesaurusOf(db, "hundojn")!;
    expect(t.headword).toBe("hundo");
    expect(t.matchedVia).toBe("stem:hundo");
  });

  test("thesaurus returns null when nothing matches", () => {
    expect(thesaurusOf(db, "zzzvxq")).toBeNull();
  });

  test("reverse lookup finds a word from its definition", () => {
    const hits = searchDefinitions(db, "dombesto lupo");
    expect(hits.map((h) => h.headword)).toContain("hundo");
    expect(hits[0].snippet).toContain("**"); // the matched terms are marked
  });

  test("reverse lookup needs every term in one definition", () => {
    expect(searchDefinitions(db, "dombesto zzzvxq")).toEqual([]);
    expect(searchDefinitions(db, "   ")).toEqual([]);
  });

  test("reverse lookup treats FTS operators as text", () => {
    expect(() => searchDefinitions(db, 'besto OR "x')).not.toThrow();
  });
});
