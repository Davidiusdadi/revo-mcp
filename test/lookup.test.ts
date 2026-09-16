import { describe, test, expect, afterAll } from "bun:test";
import {
  getDb,
  lookupEsperanto,
  lookupTranslation,
  lookupAllLanguages,
  lookupFamily,
  getLanguages,
  closeDb,
} from "../src/db";

afterAll(() => closeDb());

describe("lookupEsperanto", () => {
  test("finds exact headword 'amiko'", () => {
    const results = lookupEsperanto("amiko", 1);
    expect(results.length).toBe(1);
    expect(results[0].headword).toBe("amiko");
    expect(results[0].senses.length).toBeGreaterThan(0);
  });

  test("finds 'hundo' with multiple senses", () => {
    const results = lookupEsperanto("hundo", 1);
    expect(results.length).toBe(1);
    expect(results[0].headword).toBe("hundo");
    expect(results[0].senses.length).toBeGreaterThanOrEqual(3);
  });

  test("finds words with Esperanto characters", () => {
    const results = lookupEsperanto("ĉirkaŭ", 1);
    expect(results.length).toBe(1);
    expect(results[0].headword).toContain("ĉirkaŭ");
  });

  test("returns translations for results", () => {
    const results = lookupEsperanto("amiko", 1);
    expect(results[0].translations.length).toBeGreaterThan(0);
    const enTrd = results[0].translations.find((t) => t.lng === "en");
    expect(enTrd).toBeDefined();
    expect(enTrd!.trd).toBe("friend");
  });
});

describe("lookupTranslation", () => {
  test("finds 'friend' in English", () => {
    const results = lookupTranslation("friend", "en", 2);
    expect(results.length).toBeGreaterThan(0);
    const amiko = results.find((r) => r.headword === "amiko");
    expect(amiko).toBeDefined();
  });

  test("finds 'Hund' in German", () => {
    const results = lookupTranslation("Hund", "de", 1);
    expect(results.length).toBe(1);
    expect(results[0].headword).toBe("hundo");
    expect(results[0].matchedVia).toBe("translation:de:Hund");
  });

  test("names the idiom a hit is only filed under", () => {
    // "vor die Hunde gehen" is <trd><ind>Hund</ind>…</trd> under degradiĝi
    const results = lookupTranslation("Hund", "de", 10);
    const degr = results.find((r) => r.headword.startsWith("degradiĝ"));
    expect(degr).toBeDefined();
    expect(degr!.matchedVia).toBe("translation:de:Hund (vor die Hunde gehen)");
  });

  test("a translation with a pronunciation is not reported as more than itself", () => {
    // trd 犬 carries <pr>いぬ</pr>, which the traduko view appends to txt
    const results = lookupTranslation("犬", "ja", 1);
    expect(results.length).toBe(1);
    expect(results[0].headword).toBe("hundo");
    expect(results[0].matchedVia).toBe("translation:ja:犬");
  });

  test("finds 'chien' in French", () => {
    const results = lookupTranslation("chien", "fr", 5);
    expect(results.length).toBeGreaterThan(0);
    // 'chien' maps to hundo but may also match other entries (e.g., kolĉiko)
    const hundo = results.find((r) => r.headword === "hundo");
    expect(hundo).toBeDefined();
  });

  test("returns empty for non-existent translation", () => {
    const results = lookupTranslation("xyzzy", "en", 5);
    expect(results.length).toBe(0);
  });
});

describe("lookupAllLanguages", () => {
  test("finds 'Hund' across all languages (German)", () => {
    const results = lookupAllLanguages("Hund", 3);
    expect(results.length).toBeGreaterThan(0);
    const hundo = results.find((r) => r.headword === "hundo");
    expect(hundo).toBeDefined();
  });
});

describe("lookupFamily", () => {
  test("finds a root with a hat letter, however it is typed", () => {
    // the article's file is cxeval; the root is ĉeval
    for (const q of ["ĉeval", "cxeval", "ĉevalojn"]) {
      const f = lookupFamily(q)!;
      expect(f.root).toBe("ĉeval");
      expect(f.members.map((m) => m.headword)).toContain("ĉevalo");
    }
  });

  test("finds a word form whose capital is a hat letter", () => {
    expect(lookupFamily("ĉado")?.root).toBe("Ĉad");
  });

  test("still finds a plain root", () => {
    expect(lookupFamily("san")?.members.map((m) => m.headword)).toContain("malsanulejo");
    expect(lookupFamily("zzzvxq")).toBeNull();
  });
});

describe("getLanguages", () => {
  test("returns list of languages", () => {
    const langs = getLanguages();
    expect(langs.length).toBeGreaterThan(100);

    const en = langs.find((l) => l.lng === "en");
    expect(en).toBeDefined();
    expect(en!.count).toBeGreaterThan(10000);
  });

  test("counts the translations a lookup can reach", () => {
    // not the ones under an example sentence
    const total = getLanguages().reduce((sum, l) => sum + l.count, 0);
    const reachable = (getDb().query("SELECT COUNT(*) c FROM translation WHERE in_ekz = 0").get() as { c: number }).c;
    expect(total).toBe(reachable);
  });
});
