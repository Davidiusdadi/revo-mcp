import { describe, test, expect } from "bun:test";
import { lemmaCandidates, segment, formatSegments, type Inventory, type Morph } from "../src/morph";
import { Pairs } from "../src/corpus/passes/morph";

const first = (w: string) => lemmaCandidates(w)[0]?.lemma;
const lemmas = (w: string) => lemmaCandidates(w).map((c) => c.lemma);

describe("lemmaCandidates", () => {
  test("the ending picks the dictionary form", () => {
    expect(first("amikojn")).toBe("amiko");
    expect(first("amikon")).toBe("amiko");
    expect(first("grandaj")).toBe("granda");
    expect(first("grandan")).toBe("granda");
    for (const f of ["manĝas", "manĝis", "manĝos", "manĝus", "manĝu"]) expect(first(f)).toBe("manĝi");
    expect(first("hejmen")).toBe("hejme");
  });

  test("pronouns and correlatives drop -n/-j", () => {
    expect(lemmas("kiun")).toContain("kiu");
    expect(lemmas("tiujn")).toContain("tiu");
    expect(lemmas("min")).toContain("mi");
  });

  test("plural headwords are reachable from the accusative", () => {
    const c = lemmas("penatojn");
    expect(c.indexOf("penato")).toBeLessThan(c.indexOf("penatoj"));
  });

  test("word-class fallbacks follow the source class", () => {
    expect(lemmas("rapide").slice(0, 2)).toEqual(["rapida", "rapido"]);
    expect(lemmas("belan")[0]).toBe("bela");
    expect(lemmas("antaŭe")).toContain("antaŭ");
  });

  test("participles lead to the verb, after the participle's own forms", () => {
    const c = lemmas("manĝantaj");
    expect(c[0]).toBe("manĝanta");
    expect(c).toContain("manĝanto");
    expect(c.at(-1)).toBe("manĝi");
    expect(lemmas("legitan")).toContain("legi");
  });

  test("never proposes the word itself", () => {
    expect(lemmas("amiko")).not.toContain("amiko");
  });
});

const inv: Inventory = {
  roots: new Set(["san", "hund", "ĉas", "lern", "instru", "viv", "daŭr", "mal", "ul", "ej", "ist", "long", "ĉar", "kiu", "tag"]),
  prefixes: new Set(["mal", "re", "ek"]),
  suffixes: new Set(["ul", "ej", "ist", "ant", "id", "ig", "in", "et"]),
  words: new Set(["ĉar", "kiu", "ĉiu"]),
};
const seg = (w: string, fixed?: { at: number; root: string }) => {
  const s = segment(w, inv, fixed);
  return s ? formatSegments(s) : null;
};

describe("segment", () => {
  test("prefix, root, suffixes, ending", () => {
    expect(seg("malsanulejo")).toEqual({ seg: "mal|san|ul|ej|o", kinds: "PRSSE" });
    expect(seg("lernanto")).toEqual({ seg: "lern|ant|o", kinds: "RSE" });
    expect(seg("instruisto")).toEqual({ seg: "instru|ist|o", kinds: "RSE" });
    expect(seg("mallongigis")).toEqual({ seg: "mal|long|ig|is", kinds: "PRSE" });
  });

  test("an affix article's root reading is used when nothing else fits", () => {
    expect(seg("ulo")).toEqual({ seg: "ul|o", kinds: "RE" });
    expect(seg("malo")).toEqual({ seg: "mal|o", kinds: "RE" });
  });

  test("pair evidence decides between two readings the inventory allows", () => {
    // montaro: mont|ar|o (mountain range) or mon|tar|o (money + tare); both are
    // roots, and on their own the two splits cost the same
    const both: Inventory = { ...inv, roots: new Set([...inv.roots, "mont", "mon", "tar"]), suffixes: new Set([...inv.suffixes, "ar"]) };
    const seg = (pairs: Map<string, number>) => formatSegments(segment("montaro", { ...both, pairs })!).seg;
    expect(seg(new Map([["mont+ar", 3]]))).toBe("mont|ar|o");
    expect(seg(new Map([["mon+tar", 3]]))).toBe("mon|tar|o");
  });

  test("among near-equal readings, a short root with few derivations loses", () => {
    // flankeniri: flan|ken|ir|i costs about as much as flank|en|ir|i, but flan
    // and ken have one derivation each, flank has 27 (counts as in ReVo)
    const sides: Inventory = {
      ...inv,
      roots: new Set([...inv.roots, "flan", "ken", "flank", "ir", "en"]),
      prefixes: new Set([...inv.prefixes, "en"]),
      pairs: new Map([["en+ir", 9], ["flank+en", 1], ["ken+ir", 2]]),
      rootWeight: new Map([["flan", 1], ["ken", 1], ["flank", 27], ["ir", 55], ["en", 12]]),
    };
    expect(formatSegments(segment("flankeniri", sides)!).seg).toBe("flank|en|ir|i");
    // the same split with well-used short roots stays as the costs have it
    const rich = new Map([...sides.rootWeight!, ["flan", 30], ["ken", 30]]);
    expect(formatSegments(segment("flankeniri", { ...sides, rootWeight: rich })!).seg).toBe("flan|ken|ir|i");
  });

  test("a pair the corpus never writes is dearer, not forbidden", () => {
    const pairs = new Map([["mal+san", 5]]);
    expect(formatSegments(segment("malsanulejo", { ...inv, pairs })!).seg).toBe("mal|san|ul|ej|o");
    // hund|o|ŝip|o: none of its pairs are in the evidence, it still gets its linking vowel
    const ships: Inventory = { ...inv, roots: new Set([...inv.roots, "ŝip"]), pairs };
    expect(formatSegments(segment("hundoŝipo", ships)!).seg).toBe("hund|o|ŝip|o");
  });

  test("a one-letter root is dearer than a two-letter one", () => {
    // ŝipeliro: ŝip + e + lir (the lira) or ŝip + el + ir; the letter e is in
    // the inventory because it has an article of its own
    const roots = new Set([...inv.roots, "ŝip", "e", "el", "ir", "lir"]);
    const pairs = new Map([["el+ir", 7]]);
    expect(formatSegments(segment("ŝipeliro", { ...inv, roots, pairs })!).seg).toBe("ŝip|el|ir|o");
  });

  test("compounds and the linking vowel", () => {
    expect(seg("ĉashundo")).toEqual({ seg: "ĉas|hund|o", kinds: "RRE" });
    expect(seg("vivodaŭro")).toEqual({ seg: "viv|o|daŭr|o", kinds: "RLRE" });
  });

  test("endingless words, with -n", () => {
    expect(seg("ĉar")).toEqual({ seg: "ĉar", kinds: "W" });
    expect(seg("kiun")).toEqual({ seg: "kiu|n", kinds: "WE" });
    expect(seg("ĉiutaga")?.seg).toBe("ĉiu|tag|a");
  });

  test("a piece keeps its ending inside a compound", () => {
    // an endingless word keeps its -n: ĉio|n|pov|a, si|n|defend|o
    const pron: Inventory = { ...inv, roots: new Set([...inv.roots, "pov", "defend"]), words: new Set([...inv.words, "ĉio", "si"]) };
    expect(formatSegments(segment("ĉionpova", pron)!)).toEqual({ seg: "ĉio|n|pov|a", kinds: "WLRE" });
    expect(formatSegments(segment("sindefendo", pron)!)).toEqual({ seg: "si|n|defend|o", kinds: "WLRE" });
    // a root keeps its a/e only before a root the corpus writes after that vowel
    const grade: Inventory = { ...inv, roots: new Set([...inv.roots, "cert", "grad", "agr"]), suffixes: new Set([...inv.suffixes, "ad"]) };
    expect(formatSegments(segment("certagrade", { ...grade, pairs: new Map([["a+grad", 3]]) })!)).toEqual({ seg: "cert|a|grad|e", kinds: "RLRE" });
    expect(formatSegments(segment("certagrade", { ...grade, pairs: new Map([["mal+san", 5]]) })!).seg).toBe("cert|agr|ad|e");
    // so brit|e|lir|o (the lira) cannot undercut brit|el|ir|o
    const exits: Inventory = { ...inv, roots: new Set([...inv.roots, "brit", "el", "ir", "lir"]), pairs: new Map([["el+ir", 7]]) };
    expect(formatSegments(segment("briteliro", exits)!).seg).toBe("brit|el|ir|o");
    // i as well: daŭr|i|pov|a, the i an ending and not the letter's root
    const pova: Inventory = { ...inv, roots: new Set([...inv.roots, "pov", "i"]), pairs: new Map([["i+pov", 2]]) };
    expect(formatSegments(segment("daŭripova", pova)!)).toEqual({ seg: "daŭr|i|pov|a", kinds: "RLRE" });
  });

  test("without pair evidence only the linking o is kept inside", () => {
    // the build's first pass has no pairs yet; a cheap inner a would let it
    // learn a+grad from its own guess
    const grade: Inventory = { ...inv, roots: new Set([...inv.roots, "cert", "grad", "agr"]), suffixes: new Set([...inv.suffixes, "ad"]) };
    expect(formatSegments(segment("certagrade", grade)!).seg).toBe("cert|agr|ad|e");
    expect(seg("vivodaŭro")).toEqual({ seg: "viv|o|daŭr|o", kinds: "RLRE" });
  });

  test("a pinned root is kept", () => {
    expect(seg("malsanulejo", { at: 3, root: "san" })).toEqual({ seg: "mal|san|ul|ej|o", kinds: "PRSSE" });
    // pinning an unknown root still segments around it
    expect(seg("malzorgulo", { at: 3, root: "zorg" })).toEqual({ seg: "mal|zorg|ul|o", kinds: "PRSE" });
  });

  test("a pin the word does not bear is ignored", () => {
    // an offset and a root read off different occurrences produced pins like
    // these, and the span was stamped R anyway ("ĉevalo" came out "ĉeva|lo")
    expect(seg("hundo", { at: 1, root: "hund" })).toEqual({ seg: "hund|o", kinds: "RE" });
    expect(seg("hundo", { at: 3, root: "hund" })).toEqual({ seg: "hund|o", kinds: "RE" });
    expect(seg("hundo", { at: 0, root: "" })).toEqual({ seg: "hund|o", kinds: "RE" });
    expect(seg("malsanulejo", { at: 4, root: "san" })).toEqual({ seg: "mal|san|ul|ej|o", kinds: "PRSSE" });
  });

  test("uncoverable words give null", () => {
    expect(seg("xyzo")).toBeNull();
    expect(seg("")).toBeNull();
  });
});

describe("Pairs", () => {
  test("each marked root vouches for its own neighbours", () => {
    // artefarita is filed under art and under far: the same split, two marks
    const ms: Morph[] = [{ m: "art", k: "R" }, { m: "e", k: "L" }, { m: "far", k: "R" }, { m: "it", k: "S" }, { m: "a", k: "E" }];
    const pairs = new Pairs();
    pairs.add(ms, 0);
    pairs.add(ms, 4);
    expect(pairs.counts.get("art+e")).toBe(1);
    expect(pairs.counts.get("e+far")).toBe(1);
    // an inflection of the same derivation, same mark: counted once
    pairs.add([...ms.slice(0, 4), { m: "aj", k: "E" }], 4);
    expect(pairs.counts.get("e+far")).toBe(1);
  });
});
