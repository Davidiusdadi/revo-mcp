/**
 * The `freq` pass on the 120-article slice with a fixture counts file: every
 * lemma lands in x_freq_word with the verdict `classify` would give, roots
 * are summed from the splits, the header becomes meta, and a missing file
 * leaves the tables empty instead of failing the build.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { buildArticles, PASSES } from "../src/corpus/build";
import { runPass } from "../src/corpus/pass";
import { classify, inventoryOf } from "../src/gloss";
import { freqPassFor, parseCounts } from "../src/corpus/passes/freq";
import { freqSources, morphFrequency, wordFrequency } from "../src/freq";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "freq", "counts.tsv");
// san carries malsanulejo; hund carries hundejo and hundino (whose suffix article, in, the slice must have too)
const EXTRA = ["san", "mal", "ul", "ej", "in", "hund", "est", "la", "kaj", "et"];

let dir: string;
let db: Database;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "voko-freq-"));
  db = buildArticles(join(dir, "slice.db"), 120, EXTRA);
  for (const p of PASSES) runPass(db, p.name === "freq" ? freqPassFor(FIXTURE) : p, () => {});
});
afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true });
});

const word = (lemma: string) =>
  db.query("SELECT * FROM x_freq_word WHERE lemma = ?").get(lemma) as
    { lemma: string; verdict: string; kap_id: number | null; seg: string | null; kinds: string | null; hplt: number; tekstaro: number } | null;
const kap = (norm: string) => (db.query("SELECT id FROM headword WHERE norm = ? ORDER BY node_id, id").get(norm) as { id: number }).id;

describe("x_freq_word", () => {
  test("a headword keeps its stored split and points at its article", () => {
    const w = word("malsanulejo")!;
    expect(w.verdict).toBe("headword");
    expect(w.kap_id).toBe(kap("malsanulejo"));
    expect(w.seg).toBe("mal|san|ul|ej|o");
    expect(w.kinds).toBe("PRSSE");
    expect([w.hplt, w.tekstaro]).toEqual([20, 2]);
  });

  test("an adverb of a listed word is an inflection, split with the headword's root", () => {
    const w = word("malsane")!;
    expect(w.verdict).toBe("inflection");
    expect(w.kap_id).toBe(kap("malsana"));
    expect(w.seg).toBe("mal|san|e");
  });

  test("a form only the examples show is attested, with the example's split", () => {
    const w = word("malsanulo")!;
    expect(w.verdict).toBe("attested");
    expect(w.seg).toBe("mal|san|ul|o");
  });

  test("a word no article or example has, built from known morphemes, is derived", () => {
    const w = word("malsanulejeto")!;
    expect(w.verdict).toBe("derived");
    expect(w.kap_id).toBeNull();
    expect(w.seg).toBe("mal|san|ul|ej|et|o");
  });

  test("a word the inventory cannot build is unknown and has no split", () => {
    const w = word("ŝtruflo")!;
    expect(w.verdict).toBe("unknown");
    expect(w.seg).toBeNull();
  });

  test("a listed word never seen keeps its zero row", () => {
    const w = word("hundino")!;
    expect(w.verdict).toBe("headword");
    expect([w.hplt, w.tekstaro]).toEqual([0, 0]);
  });

  test("the file's lemmas are stored as written: an inflected key is not folded", () => {
    // the counts file already holds lemmas; a stray inflection is judged as the word it is
    expect(word("hundoj")!.verdict).toBe("inflection");
    expect(word("estis")!.verdict).toBe("inflection");
  });

  test("the pass agrees with classify on every lemma of the file", () => {
    const inv = inventoryOf(db);
    for (const r of db.query("SELECT lemma, verdict FROM x_freq_word").all() as { lemma: string; verdict: string }[]) {
      expect(`${r.lemma}: ${r.verdict}`).toBe(`${r.lemma}: ${classify(db, r.lemma, inv).verdict}`);
    }
  });
});

describe("x_freq_root", () => {
  const root = (morph: string, kind: string) =>
    db.query("SELECT * FROM x_freq_root WHERE morph = ? AND kind = ?").get(morph, kind) as
      { hplt: number; tekstaro: number; lemmas: number } | null;

  test("a root sums the lemmas that contain it, once per lemma", () => {
    // san: malsane 6, malsano 8, malsanulejeto 2, malsanulejo 20, malsanulo 9
    expect(root("san", "R")).toMatchObject({ hplt: 45, tekstaro: 5, lemmas: 5 });
    // hund: hundejo 3, hundino 0, hundoj 5
    expect(root("hund", "R")).toMatchObject({ hplt: 8, tekstaro: 2, lemmas: 3 });
  });

  test("prefixes, suffixes and endingless words are counted by kind", () => {
    expect(root("mal", "P")!.lemmas).toBe(5);
    expect(root("ej", "S")!.hplt).toBe(25); // hundejo 3, malsanulejeto 2, malsanulejo 20
    expect(root("la", "W")).toMatchObject({ hplt: 100, tekstaro: 10, lemmas: 1 });
    expect(root("ŝtrufl", "R")).toBeNull();
  });
});

describe("the runtime helper", () => {
  test("reads the sources from meta and rates per million", () => {
    expect(freqSources(db)!.hplt.tokens).toBe(1000000);
    expect(freqSources(db)!.tekstaro.edition).toBe("test");
    const f = wordFrequency(db, "Malsanulejojn")!;
    expect(f.lemma).toBe("malsanulejo");
    expect(f.counts).toEqual({ hplt: 20, tekstaro: 2 });
    expect(f.perMillion).toEqual({ hplt: 20, tekstaro: 20 });
    expect(wordFrequency(db, "neniamvidita")).toBeNull();
    expect(morphFrequency(db, "san")[0]).toMatchObject({ kind: "R", counts: { hplt: 45, tekstaro: 5 }, perMillion: { hplt: 45, tekstaro: 50 } });
    expect(morphFrequency(db, "san", "P")).toEqual([]);
  });
});

describe("the counts file", () => {
  test("header lines carry the sources; rows the counts", () => {
    const c = parseCounts('# x\n# source hplt: tokens=10 licence="a b" url=u\n# source tekstaro: tokens=5\nla\t3\t1\n');
    expect(c.sources.hplt).toEqual({ tokens: 10, licence: "a b", url: "u" });
    expect(c.rows).toEqual([{ lemma: "la", counts: { hplt: 3, tekstaro: 1 } }]);
    expect(() => parseCounts("# source hplt: tokens=1\nla\t1\t1\n")).toThrow(/tekstaro/);
    expect(() => parseCounts("# source hplt: tokens=1\n# source tekstaro: tokens=1\nla\t1\n")).toThrow(/bad row/);
  });

  test("without the file the tables exist and are empty", () => {
    const empty = new Database(join(dir, "empty.db"));
    try {
      const other = buildArticles(join(dir, "empty.db"), 5, []);
      for (const p of PASSES) runPass(other, p.name === "freq" ? freqPassFor(join(dir, "nope.tsv")) : p, () => {});
      expect((other.query("SELECT COUNT(*) c FROM x_freq_word").get() as { c: number }).c).toBe(0);
      expect(freqSources(other)).toBeNull();
      expect(wordFrequency(other, "la")).toBeNull();
      other.close();
    } finally {
      empty.close();
    }
  });
});
