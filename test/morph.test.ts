import { describe, test, expect } from "vitest";
import { lemmaCandidates, lemmaOf, markPin, segment, readings, formatSegments, numberLength, spellsNumber, type Inventory, type Morph } from "../src/morph";
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

  test("lemmaOf picks one form: the inflection removed, nothing else", () => {
    expect(lemmaOf("malsanulejojn")).toBe("malsanulejo");
    expect(lemmaOf("Malsanulejoj")).toBe("malsanulejo");
    expect(lemmaOf("grandan")).toBe("granda");
    for (const f of ["parolas", "parolis", "parolos", "parolus", "parolu"]) expect(lemmaOf(f)).toBe("paroli");
    expect(lemmaOf("hejmen")).toBe("hejme");
    expect(lemmaOf("kiujn")).toBe("kiu");
    expect(lemmaOf("ĉion")).toBe("ĉio");
    expect(lemmaOf("min")).toBe("mi");
    expect(lemmaOf("ilin")).toBe("ili");
    expect(lemmaOf("manĝantaj")).toBe("manĝanta"); // the participle, not the verb
    expect(lemmaOf("rapide")).toBe("rapide"); // no class change
    for (const w of ["la", "tamen", "unu", "plu", "ĵus", "ĉu", "du", "sen", "hodiaŭ", "ĝis"]) expect(lemmaOf(w)).toBe(w);
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
    // roots, and on their own the two splits cost the same. This is the hand
    // cost order; the learned scorer in segment() weighs pairs among other things
    const both: Inventory = { ...inv, roots: new Set([...inv.roots, "mont", "mon", "tar"]), suffixes: new Set([...inv.suffixes, "ar"]) };
    const seg = (pairs: Map<string, number>) => formatSegments(readings("montaro", { ...both, pairs })[0].ms).seg;
    expect(seg(new Map([["mont+ar", 3]]))).toBe("mont|ar|o");
    expect(seg(new Map([["mon+tar", 3]]))).toBe("mon|tar|o");
  });

  test("the learned scorer picks among the cheapest readings", () => {
    // filmfarado: film|farad|o (the farad, a unit) is the cheaper split, but a
    // five-letter root with 3 derivations loses to far (60) + the suffix ad
    // after it, a pair the corpus writes (counts as in ReVo)
    const films: Inventory = {
      ...inv,
      roots: new Set(["film", "far", "farad"]),
      suffixes: new Set(["ad"]),
      pairs: new Map([["far+ad", 9]]),
      rootWeight: new Map([["film", 10], ["far", 60], ["farad", 2]]),
    };
    expect(readings("filmfarado", films)[0].ms.map((m) => m.m).join("|")).toBe("film|farad|o");
    expect(formatSegments(segment("filmfarado", films)!).seg).toBe("film|far|ad|o");
    // sangalfluo: san|gal|flu|o, three roots, costs less than sang|al|flu|o
    const blood: Inventory = {
      ...inv,
      roots: new Set(["sang", "san", "gal", "flu", "al"]),
      prefixes: new Set(["al"]),
      pairs: new Map([["al+flu", 3]]),
      rootWeight: new Map([["sang", 20], ["san", 30], ["gal", 3], ["flu", 25], ["al", 1]]),
    };
    expect(formatSegments(segment("sangalfluo", blood)!).kinds).toBe("RPRE");
  });

  test("an endingless word keeps its own reading", () => {
    // en is an endingless word, and so is e (the letter); e + the ending n is
    // not a reading of the preposition, whatever the scorer would make of it
    const letters: Inventory = { ...inv, words: new Set(["e", "en"]), pairs: new Map([["mal+san", 1]]) };
    expect(formatSegments(segment("en", letters)!)).toEqual({ seg: "en", kinds: "W" });
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

describe("numbers", () => {
  const split = (s: string) => s.split("|");

  test("tens and hundreds, and what the web joins besides", () => {
    for (const n of ["tri|dek", "du|cent", "dek|du", "du|mil", "du|mil|kvin|cent|dek|unu", "kelk|dek", "kelk|mil", "mil|unu"]) {
      expect(`${n} ${spellsNumber(split(n))}`).toBe(`${n} true`);
    }
  });

  test("pieces in the wrong order are no number", () => {
    // units after units, a ten times a ten, and unudek, which nobody says (PMEG 23.1)
    for (const n of ["ok|ok", "du|tri", "dek|cent", "dek|dek", "unu|dek", "mil|mil", "kelk"]) {
      expect(`${n} ${spellsNumber(split(n))}`).toBe(`${n} false`);
    }
    // one numeral word is a word, not a compound
    expect(spellsNumber(["dek"])).toBe(false);
  });

  test("a big number follows what multiplies it, and needs an ending", () => {
    expect(spellsNumber(split("du|milion"))).toBe(false);
    expect(numberLength(split("du|milion|a"))).toBe(2);
  });

  test("the run is measured from where it starts, and stops at the first piece that is no part of it", () => {
    expect(numberLength(split("du|dek|jar|aĝ|a"))).toBe(2);
    expect(numberLength(split("post|du|dek|jar|o"), 1)).toBe(2);
    expect(numberLength(split("tri|angul|o"))).toBe(0);
    // unu|ok|ul|a: one-eyed, and no number
    expect(numberLength(split("unu|ok|ul|a"))).toBe(0);
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

describe("markPin", () => {
  test("a headword that does not spell its root has it where the mark puts it", () => {
    // Miĉjo in Miĥael: the root, then ĉjo — Mi is Miĥael shortened, not the pronoun
    expect(markPin("Miĉjo", "mihxael.0cxjo")).toEqual({ at: 0, root: "mi", rootOnly: true });
    expect(markPin("kazuaro", "kasuar.0o")).toMatchObject({ at: 0, root: "kazuar" });
    expect(markPin("malsanulejo", "san.mal0ulejo")).toMatchObject({ at: 3, root: "san" });
    // a capital before the 0 is the root's first letter, a word before it is not
    expect(markPin("Tifaono", "tifon.T0o")).toMatchObject({ at: 0, root: "tifaon" });
    expect(markPin("Ĉaristo", "cxar1.CX0isto")).toMatchObject({ at: 0, root: "ĉar" });
    expect(markPin("Triangulo", "angul.Tri0o")).toMatchObject({ at: 3, root: "angul" });
  });

  test("nothing where the headword does not fit the mark", () => {
    expect(markPin("Ernjo", "ernest.0ino")).toBeUndefined();
    expect(markPin("ĉjo", "mihxael.0cxjo")).toBeUndefined(); // the root would be empty
    expect(markPin("Miĉjo Muso", "mus.micxj0o")).toBeUndefined();
    expect(markPin("kotopo", "plu.kaj_tiel_0")).toBeUndefined();
    expect(markPin("hundo", null)).toBeUndefined();
  });
});
