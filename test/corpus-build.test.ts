/**
 * Builds a small slice of the corpus into a temp DB and checks what the passes
 * derive from the stored articles: nodes, headwords and translations, the
 * entry content read back at runtime, and the enrichment tables. That every
 * article comes back as it parsed is test/documents.test.ts's, and the full
 * corpus's is checked by `bun run corpus:build` itself.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { descendants, domEqual, type Element } from "voko-xml";
import { idOf, readRange } from "../src/articles";
import { contentOf, entryContent, textIn, OMIT } from "../src/content";
import { buildArticles, CORE_PASSES, PASSES } from "../src/corpus/build";
import { articleTrees, type ArticleTree } from "../src/corpus/documents";
import { runPass } from "../src/corpus/pass";
import { tldOccurrences, tokenGroups } from "../src/corpus/passes/tld-links";
import { IS_ENTRY, assembleEntry, entryNodeByMark, sensesOf as sensesAt, thesaurusOf, searchDefinitions, translationsOf } from "../src/db-voko";
import { lemmaCandidates } from "../src/morph";
import { classify, inventoryOf } from "../src/gloss";

let dir: string;
let db: Database;
let trees: ArticleTree[];
// hand-picked on top of the first 120 (which include a subdrv in `a` and a subart in `acx`):
// mal~ulejo needs san plus the mal/ul/ej affix articles; hund prt lup for the ref graph;
// unu and li each hold a <trdgrp> nested inside a translation's <klr>; cxeval writes
// some of its tildes with lit="Ĉ", which is where a wrong root pin came from;
// aidos has a <var> whose kap carries a <fnt> and a <uzo> next to it; in bel the
// synonyms belong to malbeligi and plibeligi, not to bela (figur and ornam hold them);
// fer writes the headword hufofero without a tilde, and ofer is the root that
// swallows the linking o when nothing pins fer
const EXTRA = ["san", "mal", "ul", "ej", "hund", "lup", "unu", "li", "cxeval", "aidos", "bel", "figur", "ornam", "fer", "huf", "ofer", "is", "as", "ej1", "paf"];

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "voko-build-"));
  db = buildArticles(join(dir, "slice.db"), 120, EXTRA);
  for (const p of PASSES) runPass(db, p, () => {});
  trees = [...articleTrees(db)];
});
afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true });
});

const one = <T>(sql: string, ...params: unknown[]) => db.query(sql).get(...(params as [])) as T;
const all = <T>(sql: string, ...params: unknown[]) => db.query(sql).all(...(params as [])) as T[];
const sensesOf = (mrk: string) => {
  const entry = entryNodeByMark(db as never, mrk);
  return entry ? sensesAt(db as never, entry) : [];
};
const treeOf = (file: string) => trees.find((t) => t.article.file === file)!;
/** Every node's content in the slice, with its article. */
const allContent = () => trees.flatMap((tree) => tree.nodes.flatMap((n) => [...contentOf(n.el)].map((c) => ({ tree, c }))));
const ancestor = (el: Element, name: string): Element | null => {
  for (let p = el.parent; p; p = p.parent) if (p.name === name) return p;
  return null;
};

describe("corpus build", () => {
  test("meta describes the build", () => {
    expect(one<{ value: string }>("SELECT value FROM meta WHERE key='schema'").value).toBe("voko");
    expect(one<{ value: string }>("SELECT value FROM meta WHERE key='schema_version'").value).toBe("3");
    expect(Number(one<{ value: string }>("SELECT value FROM meta WHERE key='articles'").value)).toBe(120 + EXTRA.length);
    const passes = all<{ pass: string }>("SELECT pass FROM meta_pass").map((r) => r.pass);
    for (const p of PASSES) expect(passes).toContain(p.name);
  });

  test("article, nodes and headwords", () => {
    const art = one<{ id: number; last_id: number; rad: string }>("SELECT id, last_id, rad FROM article WHERE file='abel'");
    expect(art.rad).toBe("abel");
    expect(one<{ mrk: string }>("SELECT mrk FROM art WHERE id BETWEEN ? AND ?", art.id, art.last_id).mrk).toMatch(/^\$Id: abel\.xml,v \d+\.\d+ /);
    const drvs = all<{ mrk: string }>("SELECT mrk FROM node WHERE article_id=? AND kind='drv' ORDER BY id", art.id);
    expect(drvs[0].mrk).toBe("abel.0o");
    // a node is its element: its subtree is id..last_id, inside its parent's and its article's
    expect(one<{ c: number }>("SELECT COUNT(*) c FROM node WHERE last_id < id").c).toBe(0);
    expect(one<{ c: number }>(
      "SELECT COUNT(*) c FROM node n JOIN node p ON p.id = n.parent_id WHERE n.id <= p.id OR n.last_id > p.last_id").c).toBe(0);
    expect(one<{ c: number }>(
      "SELECT COUNT(*) c FROM node n JOIN article a ON a.id = n.article_id WHERE n.id < a.id OR n.last_id > a.last_id").c).toBe(0);
    expect(one<{ c: number }>(
      "SELECT COUNT(*) c FROM node n LEFT JOIN drv d ON d.id = n.id WHERE n.kind = 'drv' AND d.id IS NULL").c).toBe(0);
    const kap = one<{ txt: string; norm: string }>(
      "SELECT h.txt, h.norm FROM headword h JOIN node n ON n.id = h.node_id WHERE n.mrk = 'abel.0ujo'");
    expect(kap).toEqual({ txt: "abelujo", norm: "abelujo" });
    // a headword is its <kap>
    expect(one<{ c: number }>("SELECT COUNT(*) c FROM headword h LEFT JOIN kap k ON k.id = h.id WHERE k.id IS NULL").c).toBe(0);
  });

  test("a node's mask names every table its subtree has rows in", () => {
    const nodes = all<{ id: number; last_id: number; mask: Uint8Array }>("SELECT id, last_id, mask FROM node");
    expect(nodes.length).toBeGreaterThan(1000);
    for (const n of nodes) {
      const [whole] = readRange(db as never, n.id, n.last_id);
      const [masked] = readRange(db as never, n.id, n.last_id, { mask: n.mask });
      expect(domEqual(masked, whole)).toBeTrue();
    }
  });

  test("examples drop citations, and the citations stay in their tables", () => {
    const e = one<{ ekz_md: string }>("SELECT ekz_md FROM ekzemplo WHERE drv_mrk = 'abel.0o' ORDER BY rowid LIMIT 1");
    expect(e.ekz_md.length).toBeGreaterThan(5);
    expect(e.ekz_md).not.toMatch(/PIV|Fab|MT/);
    expect(one<{ c: number }>("SELECT COUNT(*) c FROM fnt").c).toBeGreaterThan(50);
    expect(one<{ c: number }>("SELECT COUNT(*) c FROM bib").c).toBeGreaterThan(50);
  });

  test("translations keep lng from trdgrp and leave out pr and klr", () => {
    expect(one<{ c: number }>(
      "SELECT COUNT(*) c FROM translation t JOIN trd e ON e.id = t.id WHERE e.lng IS NULL").c).toBeGreaterThan(0);
    expect(one<{ c: number }>("SELECT COUNT(*) c FROM translation WHERE lng = ''").c).toBe(0);
    const pr = one<{ txt: string; pr: string }>(
      "SELECT t.txt, p.txt pr FROM translation t JOIN pr p ON p.parent = t.id WHERE p.txt IS NOT NULL LIMIT 1");
    expect(pr.txt).not.toContain(pr.pr);
    const klr = one<{ txt: string; klr: string }>(
      "SELECT t.txt, k.txt klr FROM translation t JOIN klr k ON k.parent = t.id WHERE k.txt IS NOT NULL LIMIT 1");
    expect(klr.txt).not.toContain("<");
    expect(klr.txt).not.toContain(`(${klr.klr})`);
  });

  // The DTD lets <klr> hold trd/trdgrp, which ReVo uses to gloss a translation
  // in a third language: `unu` has Finnish inside a Spanish trd, `li` Ido inside
  // an Indonesian one.
  test("translations nested in a translation's <klr> are kept", () => {
    const nested = allContent()
      .filter(({ tree, c }) => c.owner === "klr" && c.el.name === "trd" && ["unu", "li"].includes(tree.article.file))
      .map(({ tree, c }) => ({ file: tree.article.file, row: one<{ lng: string; txt: string }>(
        "SELECT lng, txt FROM translation WHERE id = ?", idOf(c.el)) }))
      .sort((a, b) => a.file.localeCompare(b.file));
    expect(nested.map(({ file, row }) => `${file}:${row.lng}:${row.txt}`)).toEqual([
      "li:io:ilu", "li:io:il", "unu:fi:alayksikkö", "unu:fi:kerrannaisyksikkö",
    ]);

    // the language is the nested <trdgrp lng>, not the enclosing translation's
    const outer = ["unu", "li"].flatMap((file) => [...descendants(treeOf(file).art, "trd")])
      .filter((trd) => [...descendants(trd, "trdgrp")].length > 0)
      .map((trd) => trd.attrs.lng ?? trd.parent?.attrs.lng);
    expect(outer.sort()).toEqual(["es", "id"]);

    // and a lookup reaches them
    for (const { row } of nested) {
      expect(one("SELECT 1 FROM translation WHERE lng = ? AND COALESCE(ind, txt) = ? AND in_ekz = 0", row.lng, row.txt)).toBeTruthy();
    }
  });

  test("what stands beside a <var> follows the variant headword", () => {
    // aidos: <var><kap>aideso <fnt>SPIV</fnt></kap><uzo>ARK</uzo></var> — the
    // <fnt> inside the variant kap used to be taken for the variant itself
    const { art } = treeOf("aidos");
    const content = [...contentOf(art)];
    const ark = content.findIndex((c) => c.el.name === "uzo" && c.owner === "var" && textIn(c.el, treeOf("aidos").roots) === "ARK");
    expect(ark).toBeGreaterThan(0);
    const variant = content.slice(0, ark).findLast((c) => c.main !== undefined)!;
    expect(one<{ txt: string }>("SELECT txt FROM headword WHERE id = ? AND main_id = ?", idOf(variant.el), idOf(variant.main!)).txt)
      .toBe("aideso");
    expect(one<{ c: number }>("SELECT COUNT(*) c FROM headword WHERE txt LIKE '%SPIV%'").c).toBe(0);
  });

  test("references inherit tip from refgrp", () => {
    const grouped = allContent().filter(({ c }) => c.el.name === "ref" && ancestor(c.el, "refgrp"));
    expect(grouped.length).toBeGreaterThan(0);
    expect(grouped.filter(({ c }) => !c.tip)).toEqual([]);
    expect(one<{ c: number }>("SELECT COUNT(*) c FROM ref WHERE cel = '' OR cel IS NULL").c).toBe(0);
  });

  test("fts tables answer", () => {
    expect(all("SELECT rowid FROM fts_kap WHERE fts_kap MATCH 'abelujo'").length).toBeGreaterThan(0);
    expect(all("SELECT rowid FROM fts_ekz WHERE fts_ekz MATCH '\"abel\"' LIMIT 3").length).toBeGreaterThan(0);
    const word = one<{ dif: string }>("SELECT dif FROM fts_dif WHERE length(dif) > 40 LIMIT 1").dif.match(/\p{L}{5,}/u)![0];
    expect(all("SELECT rowid FROM fts_dif WHERE fts_dif MATCH ? LIMIT 3", word).length).toBeGreaterThan(0);
  });
});

describe("entries read from the stored articles", () => {
  test("definitions keep inline <trd> (Latin names) as running text", () => {
    const inline = allContent().filter(({ c }) => c.owner === "dif" && c.el.name === "trd" && !ancestor(c.el, "trdgrp")).slice(0, 20);
    expect(inline.length).toBeGreaterThan(0);
    for (const { c } of inline) {
      const dif = one<{ dif: string }>("SELECT dif FROM fts_dif WHERE rowid = ?", idOf(ancestor(c.el, "dif")!)).dif;
      expect(dif).toContain(one<{ txt: string }>("SELECT txt FROM translation WHERE id = ?", idOf(c.el)).txt);
    }
  });

  test("fts_trd.rowid is the translation's id", () => {
    const r = one<{ mrk: string; txt: string }>(
      `SELECT n.mrk, t.txt FROM fts_trd f JOIN translation t ON t.id = f.rowid JOIN node n ON n.id = t.node_id
        WHERE f.trd MATCH 'bee' LIMIT 1`);
    expect(r.txt.toLowerCase()).toContain("bee");
    expect(r.mrk).toBeTruthy();
  });

  test("sensesOf: numbered senses with their own examples", () => {
    const multi = one<{ mrk: string; n: number; id: number; last_id: number }>(
      `SELECT d.mrk, COUNT(*) n, d.id, d.last_id FROM node d JOIN node s ON s.parent_id = d.id
       WHERE d.kind='drv' AND s.kind='snc' GROUP BY d.id HAVING n > 1
         -- flat: only snc children, none with subsenses
         AND NOT EXISTS (SELECT 1 FROM node c WHERE c.parent_id = d.id AND c.kind <> 'snc')
         AND NOT EXISTS (SELECT 1 FROM node g JOIN node c ON g.parent_id = c.id WHERE c.parent_id = d.id)
       LIMIT 1`);
    const senses = sensesOf(multi.mrk);
    expect(senses.map((s) => s.num).slice(-multi.n)).toEqual(
      Array.from({ length: multi.n }, (_, i) => `${i + 1}.`));
    for (const s of senses) expect(s.definition.length + s.examples.length).toBeGreaterThan(0);
    const ekz = one<{ c: number }>("SELECT COUNT(*) c FROM ekzemplo WHERE rowid BETWEEN ? AND ?", multi.id, multi.last_id).c;
    expect(senses.reduce((a, s) => a + s.examples.length, 0)).toBe(ekz);
  });

  test("sensesOf: a single sense is unnumbered, subsenses get letters", () => {
    const single = one<{ mrk: string }>(
      `SELECT d.mrk FROM node d JOIN node s ON s.parent_id = d.id
       WHERE d.kind='drv' AND s.kind='snc' GROUP BY d.id HAVING COUNT(*) = 1
         AND NOT EXISTS (SELECT 1 FROM node g JOIN node c ON g.parent_id = c.id WHERE c.parent_id = d.id)
       LIMIT 1`);
    expect(sensesOf(single.mrk).at(-1)!.num).toBe("");
    const sub = one<{ mrk: string } | null>(
      `SELECT d.mrk FROM node x JOIN node s ON s.id = x.parent_id JOIN node d ON d.id = s.parent_id
       WHERE x.kind='subsnc' AND d.kind='drv' AND d.mrk IS NOT NULL LIMIT 1`);
    expect(sub).toBeTruthy();
    expect(sensesOf(sub!.mrk).map((s) => s.num)).toContain("a)");
  });

  test("sensesOf: unknown mrk gives no senses", () => {
    expect(sensesOf("ne.0ekzistas")).toEqual([]);
  });

  test("an entry reads the same without the tables of a citation's parts", () => {
    // what db-voko leaves out: bib, vrk, lok, aut and url rows inside the entries
    expect(one<{ c: number }>(
      `SELECT COUNT(*) c FROM node n JOIN aut x ON x.id BETWEEN n.id AND n.last_id WHERE ${IS_ENTRY}`).c).toBeGreaterThan(0);
    const marks = all<{ mrk: string }>(`SELECT n.mrk FROM node n WHERE ${IS_ENTRY}`).map((r) => r.mrk);
    expect(marks.length).toBeGreaterThan(400);
    for (const mrk of marks) {
      const node = entryNodeByMark(db as never, mrk)!;
      const [drv] = readRange(db as never, node.id, node.last_id);
      const whole = entryContent(drv as Element, treeOf(node.article).roots);
      const entry = assembleEntry(db as never, node);
      expect({ senses: entry.senses, crossRefs: entry.crossRefs.map(({ target, type }) => ({ target, type })), usageDomains: entry.usageDomains })
        .toEqual(whole);
    }
  });

  test("an entry lists a translation by its <ind> form when it marks one", () => {
    const t = one<{ node_id: number; ind: string; txt: string }>(
      "SELECT node_id, ind, txt FROM translation WHERE ind IS NOT NULL AND ind <> txt AND in_ekz = 0 LIMIT 1");
    const node = one<{ id: number; last_id: number }>("SELECT id, last_id FROM node WHERE id = ?", t.node_id);
    expect(t.txt).toContain(t.ind);
    expect(JSON.stringify(translationsOf(db as never, node))).toContain(JSON.stringify(t.ind));
  });

  test("translations of examples are the ones marked in_ekz", () => {
    const inExamples = allContent().filter(({ c }) => c.el.name === "trd" && c.owner === "ekz").map(({ c }) => idOf(c.el));
    expect(inExamples.length).toBeGreaterThan(0);
    expect(all<{ id: number }>("SELECT id FROM translation WHERE in_ekz = 1 ORDER BY id").map((r) => r.id))
      .toEqual(inExamples.sort((a, b) => a! - b!));
  });
});

describe("fixes from the parity report", () => {
  test("headwords drop the separator before <var>", () => {
    expect(one<{ c: number }>("SELECT COUNT(*) c FROM headword WHERE txt LIKE '%,' OR txt LIKE '% '").c).toBe(0);
  });

  test("<ctl> renders with quotes", () => {
    // a <ctl> of plain text reads „text“ in its example's row
    let quoted = 0;
    for (const { article, art } of trees) {
      const rows = all<{ ekz_md: string }>("SELECT ekz_md FROM ekzemplo WHERE art = ?", article.file).map((r) => r.ekz_md);
      for (const ctl of [...descendants(art, "ekz")].flatMap((ekz) => [...descendants(ekz, "ctl")])) {
        if (ctl.children.some((c) => c.type !== "text")) continue;
        const text = ctl.children.map((c) => (c.type === "text" ? c.value : "")).join("").replace(/\s+/g, " ").trim();
        expect(rows.some((txt) => txt.includes(`„${text}“`))).toBeTrue();
        quoted++;
      }
    }
    expect(quoted).toBeGreaterThan(0);
  });
});

describe("pass tld-links", () => {
  test("every <tld/> is one row", () => {
    expect(one<{ c: number }>("SELECT COUNT(*) c FROM x_tld_occ").c).toBe(one<{ c: number }>("SELECT COUNT(*) c FROM tld").c);
  });

  test("the token is in its owner's text", () => {
    const omits: Partial<Record<string, (typeof OMIT)[keyof typeof OMIT]>> = { dif: OMIT.dif, ekz: OMIT.ekz, rim: OMIT.rim };
    const text = new Map<number, string>();
    for (const { tree, c } of allContent()) {
      const omit = omits[c.el.name];
      if (omit) text.set(idOf(c.el)!, textIn(c.el, tree.roots, omit));
    }
    for (const r of all<{ id: number; txt: string }>("SELECT id, txt FROM headword")) text.set(r.id, r.txt);
    const rows = all<{ norm: string; owner_id: number }>(
      "SELECT norm, owner_id FROM x_tld_occ WHERE owner_kind IN ('ekz','dif','rim','kap')");
    expect(rows.length).toBeGreaterThan(1000);
    const found = rows.filter((r) => (text.get(r.owner_id) ?? "").toLowerCase().includes(r.norm)).length;
    expect(found / rows.length).toBeGreaterThan(0.99);
  });

  test("a headword's tilde splits it into prefix, root and rest", () => {
    const o = one<{ pre: string; rad: string; post: string }>(
      `SELECT o.pre, o.rad, o.post FROM x_tld_occ o JOIN headword k ON k.id = o.owner_id
       WHERE o.owner_kind = 'kap' AND k.norm = 'malsanulejo'`);
    expect(o).toEqual({ pre: "mal", rad: "san", post: "ulejo" });
  });
});

describe("pass refs", () => {
  test("every ref is an authored edge or an issue", () => {
    const refs = allContent().filter(({ c }) => c.el.name === "ref").length;
    const authored = one<{ c: number }>("SELECT COUNT(*) c FROM x_ref_edge WHERE inferred = 0").c;
    const issues = one<{ c: number }>("SELECT COUNT(*) c FROM x_ref_issue").c;
    expect(authored + issues).toBe(refs);
  });

  test("inferred edges are the ontology's inverses and never repeat an authored edge", () => {
    const tipOf = new Map(allContent().filter(({ c }) => c.el.name === "ref").map(({ c }) => [idOf(c.el)!, c.tip ?? null]));
    const inverse = new Map(all<{ tip: string; inverse: string | null }>("SELECT tip, inverse FROM x_ref_tip").map((r) => [r.tip, r.inverse]));
    const inferred = all<{ ref_id: number; tip: string | null }>("SELECT ref_id, tip FROM x_ref_edge WHERE inferred = 1");
    expect(inferred.length).toBeGreaterThan(0);
    expect(inferred.filter((e) => (inverse.get(tipOf.get(e.ref_id)!) ?? null) !== e.tip)).toEqual([]);
    expect(one<{ c: number }>(
      `SELECT COUNT(*) c FROM x_ref_edge e WHERE e.inferred = 1 AND EXISTS (
         SELECT 1 FROM x_ref_edge a WHERE a.inferred = 0 AND a.src_node = e.src_node
           AND a.dst_node = e.dst_node AND a.tip IS e.tip)`).c).toBe(0);
  });

  test("hundo has lupo as a part, so lupo belongs to hundo", () => {
    const e = all<{ tip: string }>(
      `SELECT e.tip FROM x_ref_edge e JOIN node s ON s.id = e.src_node JOIN node d ON d.id = e.dst_node
         JOIN node h ON h.mrk = 'hund.0o'
       WHERE s.mrk = 'lup.0o' AND d.id BETWEEN h.id AND h.last_id`);
    expect(e.map((r) => r.tip)).toContain("malprt");
  });
});

describe("pass morph", () => {
  test("every headword gets a segmentation", () => {
    expect(one<{ c: number }>("SELECT COUNT(*) c FROM x_morph").c).toBe(one<{ c: number }>("SELECT COUNT(*) c FROM headword").c);
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

  test("an ending article is an ending, not a root", () => {
    // "-is" (the past tense) has <rad>is</rad> like any article; as a root it
    // could sit inside a word (esperant|is|oj). "aso" (the ace) is a real root
    const kinds = (m: string) => all<{ kind: string }>("SELECT kind FROM x_morpheme WHERE morph = ? ORDER BY kind", m).map((r) => r.kind);
    expect(kinds("is")).toEqual(["E"]);
    expect(kinds("as")).toEqual(["E", "R"]);
  });

  test("an exclamation is not a root", () => {
    // "ej!" (doubt; spelt "eh" too) is marked ekkrio and derives nothing: no
    // root, or mult|eh|ar|a would read. "paf!" is a root because ReVo builds
    // pafi, pafilo on it
    const kinds = (m: string) => all<{ kind: string }>("SELECT kind FROM x_morpheme WHERE morph = ? ORDER BY kind", m).map((r) => r.kind);
    expect(kinds("eh")).not.toContain("R");
    expect(kinds("paf")).toContain("R");
  });

  test("x_pair counts the neighbours of a marked root", () => {
    // mal|san|ul|ej|o, san pinned: mal before it, ul after it; ul+ej is the
    // segmenter's own reading and not evidence
    const pair = (a: string, b: string) => one<{ n: number } | null>("SELECT n FROM x_pair WHERE a = ? AND b = ?", a, b)?.n;
    expect(pair("mal", "san")).toBeGreaterThan(0);
    expect(pair("san", "ul")).toBeGreaterThan(0);
    expect(pair("ul", "ej")).toBeUndefined();
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
    const groups = tokenGroups(tldOccurrences(db));
    expect(groups.length).toBeGreaterThan(100);
    const bad = groups.filter((g) => !one(
      `SELECT 1 FROM x_tld_occ WHERE norm = ? AND article_id = ? AND owner_kind <> 'kap'
         AND pre = ? AND rad = ?`, g.norm, g.article_id, g.pre, g.rad));
    expect(bad.map((g) => `${g.norm}: ${g.pre}|${g.rad}`)).toEqual([]);
  });

  test("attested forms are tied to a headword of their own article", () => {
    expect(one<{ c: number }>(
      `SELECT COUNT(*) c FROM x_token t JOIN headword k ON k.id = t.lemma_kap_id JOIN node n ON n.id = k.node_id
       WHERE n.article_id <> t.article_id`).c).toBe(0);
    const infl = all<{ norm: string; lemma: string }>(
      `SELECT t.norm, k.norm lemma FROM x_token t JOIN headword k ON k.id = t.lemma_kap_id WHERE t.how = 'infl'`);
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

// A browser downloads the core stage and glosses from it: the morpheme
// inventory is there, the stored splits and the tilde occurrences they were
// built from are not — a word is split when it is asked about.
describe("core stage", () => {
  let core: Database;
  beforeAll(() => {
    core = buildArticles(join(dir, "core.db"), 120, EXTRA);
    for (const p of CORE_PASSES) runPass(core, p, () => {});
  });
  afterAll(() => core.close());
  const tables = () => core.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type IN ('table','index')").all().map((r) => r.name);

  test("carries the morpheme inventory and its affix table, not the stored splits or the tilde occurrences", () => {
    expect(tables()).toEqual(expect.arrayContaining(["x_morpheme", "x_pair", "x_affix", "idx_headword_norm"]));
    for (const t of ["x_morph", "x_token", "x_tld_occ", "fts_dif"]) expect(tables()).not.toContain(t);
  });

  test("splits a headword as the splits pass would have stored it", () => {
    const inv = inventoryOf(core as never);
    // the tilde pins mal~ulejo; hufofero is written out in full and pinned on fer
    expect(classify(core as never, "malsanulejo", inv).seg).toBe("mal|san|ul|ej|o");
    expect(classify(core as never, "hufofero", inv).seg).toBe("huf|o|fer|o");
    // and the same across the slice, but for the few the kap's own mark decides
    const stored = all<{ form: string; seg: string }>(
      "SELECT form, seg FROM x_morph WHERE ok = 1 AND form NOT LIKE '% %' AND form NOT LIKE '%-%'");
    expect(stored.length).toBeGreaterThan(300);
    const differ = stored.filter((r) => classify(core as never, r.form, inv).seg !== r.seg).map((r) => r.form);
    // 0.23 % over the whole corpus; the slice has a few of them at most
    expect(differ.length, differ.join(", ")).toBeLessThanOrEqual(stored.length / 50);
  });

  test("glosses a word with its parts, its entry and its translations", () => {
    const t = classify(core as never, "malsanulejo", inventoryOf(core as never), ["de"]);
    expect(t.verdict).toBe("headword");
    expect(t.seg).toBe("mal|san|ul|ej|o");
    expect(t.mrk).toBe("san.mal0ulejo");
    expect(t.translations).toBeDefined();
    const mal = t.parts!.find((p) => p.m === "mal")!;
    expect(mal.mrk).toBe("mal.0");
    expect(mal.gloss!.length).toBeGreaterThan(12);
    const hund = classify(core as never, "hundoj", inventoryOf(core as never), ["de"]);
    expect(hund.mrk).toBe("hund.0o");
    expect(hund.translations).toContainEqual({ lng: "de", trd: "Hund" });
  });

  test("the affix table says what each affix means, from the article's first telling definition", () => {
    const rows = core.query<{ morph: string; kind: string; txt: string; mrk: string | null; gloss: string | null }, []>(
      "SELECT morph, kind, txt, mrk, gloss FROM x_affix ORDER BY morph").all();
    expect(rows.find((r) => r.morph === "mal")).toMatchObject({ kind: "P", txt: "mal-", mrk: "mal.0" });
    expect(rows.find((r) => r.morph === "ul")).toMatchObject({ kind: "S", txt: "-ul", mrk: "ul.0" });
    for (const r of rows) if (r.gloss) expect(r.gloss).not.toMatch(/^(sufikso|prefikso)/i);
  });
});
