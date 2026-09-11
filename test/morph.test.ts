import { describe, test, expect } from "bun:test";
import { lemmaCandidates, segment, formatSegments, type Inventory } from "../src/morph";

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

  test("compounds and the linking vowel", () => {
    expect(seg("ĉashundo")).toEqual({ seg: "ĉas|hund|o", kinds: "RRE" });
    expect(seg("vivodaŭro")).toEqual({ seg: "viv|o|daŭr|o", kinds: "RLRE" });
  });

  test("endingless words, with -n", () => {
    expect(seg("ĉar")).toEqual({ seg: "ĉar", kinds: "W" });
    expect(seg("kiun")).toEqual({ seg: "kiu|n", kinds: "WE" });
    expect(seg("ĉiutaga")?.seg).toBe("ĉiu|tag|a");
  });

  test("a pinned root is kept", () => {
    expect(seg("malsanulejo", { at: 3, root: "san" })).toEqual({ seg: "mal|san|ul|ej|o", kinds: "PRSSE" });
    // pinning an unknown root still segments around it
    expect(seg("malzorgulo", { at: 3, root: "zorg" })).toEqual({ seg: "mal|zorg|ul|o", kinds: "PRSE" });
  });

  test("uncoverable words give null", () => {
    expect(seg("xyzo")).toBeNull();
    expect(seg("")).toBeNull();
  });
});
