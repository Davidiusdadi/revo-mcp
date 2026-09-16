/**
 * `gloss`: a whole text in, corpus-backed suggestions out. Runs against the
 * built data/voko.db, like lookup.test.ts.
 *
 * The assertions that matter are the negative ones. A bulk tool is read by a
 * translator who will not check every line, so the failure that costs
 * something is a confident wrong answer: a misspelling dressed up as a valid
 * derivation, or a "did you mean" nobody has ever written.
 */
import { describe, test, expect, afterAll } from "bun:test";
import { closeDb, getDb, glossText } from "../src/db";
import { classify, inventoryOf, type EoGloss, type SourceGloss } from "../src/gloss";
import { executeGloss, glossOutputSchema, handleGloss } from "../src/tools/gloss";

afterAll(() => closeDb());

const source = (text: string, lang = "en") => glossText(text, { lang }) as SourceGloss;
const eo = (text: string) => glossText(text, { lang: "eo" }) as EoGloss;
const term = (g: SourceGloss, t: string) => g.terms.find((x) => x.term === t);
const word = (g: EoGloss, w: string) => g.terms.find((x) => x.word === w);

describe("gloss: source text → Esperanto", () => {
  test("glosses every content word of a paragraph in one call", () => {
    const g = source("The twelve jurors were all writing very busily on slates.");
    expect(g.mode).toBe("source");
    expect(term(g, "slates")?.candidates.some((c) => c.eo === "ardezo")).toBe(true);
    // reduced to a form the dictionary has, and the form that hit is reported
    expect(term(g, "slates")?.via).toBe("slate");
  });

  test("names the root to build on when the headword hides it", () => {
    const c = term(source("a magic word"), "magic")?.candidates.find((x) => x.eo === "sorĉo");
    expect(c).toBeDefined();
    // the article file is x-system ('sorcx'); what comes back is readable
    expect(c!.art).toBe("sorĉ");
  });

  test("finds multi-word entries the single words would not give", () => {
    const g = source("He decided to give up.");
    const phrase = g.phrases.find((p) => p.term === "give up");
    expect(phrase).toBeDefined();
    expect(phrase!.candidates.some((c) => c.eo === "rezigni" || c.eo === "cedi")).toBe(true);
  });

  test("reports the words with no entry instead of passing over them", () => {
    const g = source("The twelve jurors wrote busily.");
    expect(g.missing.map((m) => m.term)).toContain("twelve");
    expect(g.terms.map((t) => t.term)).not.toContain("twelve");
  });

  test("function words are left out, content words are not", () => {
    const g = source("The animal is in the world and it was seen by all of us.");
    const terms = g.terms.map((t) => t.term);
    expect(terms).toContain("animal");
    expect(terms).toContain("world");
    for (const stop of ["the", "is", "in", "and", "it", "was", "by", "all", "of", "us"]) {
      expect(terms).not.toContain(stop);
    }
  });

  test("German text is glossed from German", () => {
    const g = source("Das Haus ist möglich.", "de");
    expect(term(g, "haus")?.candidates.some((c) => c.eo === "domo")).toBe(true);
    // 'Haus' is capitalised in ReVo too, and lowercased here: case is folded either way
    expect(term(g, "möglich")).toBeDefined();
  });

  test("caps candidates per word and counts what it left out", () => {
    const g = glossText("an animal", { lang: "en", perTerm: 2 }) as SourceGloss;
    const t = term(g, "animal")!;
    expect(t.candidates.length).toBe(2);
    expect(t.more).toBeGreaterThan(0);
  });
});

describe("gloss: Esperanto audit", () => {
  test("classes a draft word by word", () => {
    const g = eo("La ĵuriano skribis sur tabuletoj.");
    expect(word(g, "ĵuriano")?.verdict).toBe("headword");
    const skribis = word(g, "skribis")!;
    expect(skribis.verdict).toBe("inflection");
    expect(skribis.headword).toBe("skribi");
  });

  test("a regular derivation no article lists is reported as well formed", () => {
    const t = word(eo("Ili uzis ardeztabuletojn."), "ardeztabuletojn")!;
    expect(t.verdict).toBe("derived");
    expect(t.seg).toBe("ardez|tabul|et|ojn");
    // each part carries what the corpus says it means, not a gloss of ours
    const parts = t.parts!.map((p) => p.m);
    expect(parts).toEqual(["ardez", "tabul", "et", "ojn"]);
    expect(t.parts!.find((p) => p.m === "ardez")?.gloss).toBe("ardezo");
    expect(t.parts!.find((p) => p.m === "et")?.gloss).toMatch(/malaltan gradon/);
  });

  test("-end-/-it- derivations resolve through the affix articles", () => {
    const g = eo("Tio estas farenda kaj jam endita.");
    const farenda = word(g, "farenda")!;
    expect(farenda.seg).toBe("far|end|a");
    expect(farenda.parts!.find((p) => p.m === "end")?.gloss).toBe("kiun oni devas fari");
    // ReVo has an article for the root: endi, "to be necessary"
    expect(word(g, "endita")?.headword).toBe("endi");
    expect(word(g, "endita")?.seg).toBe("end|it|a");
  });

  test("a word with two readings gets both", () => {
    const t = word(eo("La legenda teksto."), "legenda")!;
    expect(t.headword).toBe("legendo"); // the cheapest reading: one root
    expect(t.also?.seg).toBe("leg|end|a"); // and the one a long root hides
    expect(t.also?.parts.find((p) => p.m === "leg")?.gloss).toBe("legi");
  });

  test("a second reading needs grounds, not just pieces", () => {
    // dol|ar|oj (a collection of pains) and kok|et|e are legal and meaningless:
    // the corpus never joins the root and suffix, and -ar/-et are not verbal
    expect(word(eo("Dolaroj kokete."), "dolaroj")?.also).toBeUndefined();
    expect(word(eo("Dolaroj kokete."), "kokete")?.also).toBeUndefined();
  });

  test("counts an attested form rather than calling it merely buildable", () => {
    const t = word(eo("Libro leginda."), "leginda")!;
    expect(t.verdict).toBe("attested");
    expect(t.attested).toBeGreaterThan(0);
  });

  test("a misspelling is unknown, and the suggestion is a word that exists", () => {
    const t = word(eo("La teksto ĉanĝiĝis."), "ĉanĝiĝis")!;
    expect(t.verdict).toBe("unknown");
    expect(t.near).toContain("ŝanĝiĝis");
    // ĉan, ĝi and ĝis are all real morphemes, so the segmenter can assemble the
    // misspelling; it must not be reported as a derivation on that basis
    expect(t.seg).toBeUndefined();
  });

  test("an invented compound gets no invented neighbour", () => {
    const t = word(eo("Li estas makilaĵfaranto."), "makilaĵfaranto")!;
    expect(t.verdict).toBe("unknown");
    expect(t.near ?? []).toEqual([]);
  });

  test("a suggestion must be a real form, not just a related stem", () => {
    // brulaĵo is well formed and unlisted; brula shares its stem, but `brulao`
    // is nobody's spelling of anything and must not come back as a real word
    const t = classify(getDb(), "brulaĵo", inventoryOf(getDb()));
    expect(t.verdict).toBe("derived");
    expect(t.near ?? []).not.toContain("brulao");
  });

  test("an affix whose first definition says nothing falls through to the next", () => {
    // ReVo's -aĵ article opens with the bare "Sufikso, kiu:"
    const t = classify(getDb(), "brulaĵo", inventoryOf(getDb()));
    const gloss = t.parts!.find((p) => p.m === "aĵ")!.gloss!;
    expect(gloss.length).toBeGreaterThan(12);
    expect(gloss).not.toBe("kiu");
  });

  test("a root spelled with a hat still reaches its article", () => {
    // the article file is x-system (sxangx); the part is glossed all the same
    const t = classify(getDb(), "ŝanĝita", inventoryOf(getDb()));
    const root = t.parts!.find((p) => p.m === "ŝanĝ")!;
    expect(root.gloss).toBe("ŝanĝi");
    expect(root.art).toBe("ŝanĝ");
  });

  test("x-system input is folded before anything else", () => {
    const t = word(eo("La cxevalo kuras."), "ĉevalo")!;
    expect(t.verdict).toBe("headword");
  });

  test("keeps a word whose reading needs a two-letter root", () => {
    const t = classify(getDb(), "ĉirkaŭirado", inventoryOf(getDb()));
    expect(t.verdict).toBe("derived");
    expect(t.seg).toBe("ĉirkaŭ|ir|ad|o"); // ir is two letters and the word is fine
  });

  test("drops a guess that needs a one-letter root", () => {
    // kelk|e|foj|e: the corpus never writes e before foj, so the e can only be
    // the letter's own article, and a reading built on that is not one anybody meant
    const t = classify(getDb(), "kelkefoje", inventoryOf(getDb()));
    expect(t.verdict).toBe("unknown");
    expect(t.seg).toBeUndefined();
    // whereas el|ir|ej|oj is a reading worth reporting
    const u = classify(getDb(), "elirejoj", inventoryOf(getDb()));
    expect(u.headword).toBe("elirejo");
    expect(u.seg).toBe("el|ir|ej|oj");
  });

  test("a piece may keep its ending inside a compound", () => {
    // mi|a|grad|e: the a is the adjective ending kept inside the compound, as
    // in certagrade, not the letter a; the corpus writes a before grad
    const t = classify(getDb(), "miagrade", inventoryOf(getDb()));
    expect(t.verdict).toBe("derived");
    expect(t.seg).toBe("mi|a|grad|e");
    expect(t.kinds).toBe("RLRE");
    // ĉio|n|vid|a: an endingless word keeps its -n
    const u = classify(getDb(), "ĉionvida", inventoryOf(getDb()));
    expect(u.verdict).toBe("derived");
    expect(u.seg).toBe("ĉio|n|vid|a");
    expect(u.kinds).toBe("WLRE");
  });

  test("a one-letter root does not beat two short pieces the corpus writes together", () => {
    // ŝip + eliro: the letter e plus lir (the lira) used to cost the same as
    // el + ir and won, and the one-letter guard then left the word unknown
    const t = classify(getDb(), "ŝipeliro", inventoryOf(getDb()));
    expect(t.verdict).toBe("derived");
    expect(t.seg).toBe("ŝip|el|ir|o");
  });

  test("a word the corpus has is split the way the corpus stored it", () => {
    // hufofero is filed under fer with no root mark; the segmenter alone
    // would read huf|ofer|o (an offering), the build pinned huf|o|fer|o
    const t = classify(getDb(), "hufofero", inventoryOf(getDb()));
    expect(t.verdict).toBe("headword");
    expect(t.seg).toBe("huf|o|fer|o");
    expect(t.readings?.map((r) => r.art)).toEqual(["fer"]);
    // an inflection carries the headword's split, with its own ending
    const u = classify(getDb(), "hufoferojn", inventoryOf(getDb()));
    expect(u.verdict).toBe("inflection");
    expect(u.seg).toBe("huf|o|fer|ojn");
    expect(u.kinds).toBe("RLRE");
    // a participle: the suffix sits between the stem and the ending
    expect(classify(getDb(), "ŝanĝita", inventoryOf(getDb())).seg).toBe("ŝanĝ|it|a");
  });

  test("a word filed under two articles keeps both readings, longest root first", () => {
    const t = classify(getDb(), "resumi", inventoryOf(getDb()));
    expect(t.readings?.map((r) => [r.seg, r.art])).toEqual([["resum|i", "resum"], ["re|sum|i", "sum"]]);
    expect(t.seg).toBe("resum|i");
    // the second reading is glossed from its own article
    expect(t.readings![1].parts.find((p) => p.m === "sum")?.gloss).toBe("sumo");
  });

  test("a headword written under another article with a root mark keeps that reading too", () => {
    // turdedoj is a headword on the root turded (the thrush family) and is
    // written in the turd article as turd|ed|oj: both are ReVo's
    const t = classify(getDb(), "turdedoj", inventoryOf(getDb()));
    expect(t.verdict).toBe("headword");
    expect(t.readings?.map((r) => [r.seg, r.art])).toEqual([["turded|oj", "turded"], ["turd|ed|oj", "turd"]]);
    // and an inflection: distordata is distordi + -at-, and dis|tord|at|a under tord
    const u = classify(getDb(), "distordata", inventoryOf(getDb()));
    expect(u.verdict).toBe("inflection");
    expect(u.readings?.map((r) => r.seg)).toEqual(["distord|at|a", "dis|tord|at|a"]);
  });

  test("a stored one-letter root between two roots is read as the linking vowel", () => {
    // the build files artefarita as art|e|far|it|a with e a root (the letter's article)
    const t = classify(getDb(), "artefarita", inventoryOf(getDb()));
    expect(t.verdict).toBe("attested");
    expect(t.seg).toBe("art|e|far|it|a");
    expect(t.kinds).toBe("RLRSE");
    expect(t.parts!.find((p) => p.m === "e")?.gloss).toBeUndefined();
  });

  test("a legal compound that is one letter from a real word says so", () => {
    // fin + sit + a is well formed; finita is what was probably meant
    const t = classify(getDb(), "finsita", inventoryOf(getDb()));
    expect(t.verdict).toBe("derived");
    expect(t.near).toContain("finita");
  });
});

describe("gloss: rendering", () => {
  test("the source glossary names its sections and its caveat", () => {
    const md = handleGloss({ text: "The naked eye.", lang: "en", per_word: 3, max_words: 80 });
    expect(md).toStartWith("## Glossary: en → eo");
    expect(md).toContain("**Words**");
    expect(md).toContain("okulo");
  });

  test("the audit leads with what needs attention", () => {
    const md = handleGloss({
      text: "La teksto ĉanĝiĝis kaj estas farenda.",
      lang: "eo",
      per_word: 4,
      max_words: 120,
    });
    expect(md).toStartWith("## Esperanto check");
    expect(md.indexOf("**Unknown**")).toBeLessThan(md.indexOf("**In the dictionary**"));
    expect(md).toContain("did you mean **ŝanĝiĝis**");
    expect(md).toContain("kiun oni devas fari");
  });
});

describe("gloss: what a reader needs to show a word", () => {
  const at = (word: string, languages?: string[]) => classify(getDb(), word, inventoryOf(getDb()), languages);

  test("a dictionary word names its entry by mark", () => {
    expect(at("hundo").mrk).toBe("hund.0o");
    expect(at("hundojn").mrk).toBe("hund.0o");
    // an article's own headword is repeated by its first derivation, the marked one
    expect(at("sana").mrk).toBe("san.0a");
    expect(at("malsanulejo").mrk).toBe("san.mal0ulejo");
  });

  test("lists the entry's translations only in the languages asked for", () => {
    expect(at("hundo").translations).toBeUndefined();
    const t = at("hundoj", ["de", "en"]);
    expect(t.verdict).toBe("inflection");
    expect(t.translations).toContainEqual({ lng: "de", trd: "Hund" });
    expect(t.translations!.every((x) => x.lng === "de" || x.lng === "en")).toBeTrue();
    expect(at("hundo", []).translations).toEqual([]);
  });

  test("each part names the entry that explains it", () => {
    const parts = at("malsanulejo").parts!;
    expect(parts.find((p) => p.m === "mal")).toMatchObject({ k: "P", mrk: "mal.0" });
    expect(parts.find((p) => p.m === "san")).toMatchObject({ k: "R", gloss: "sana", mrk: "san.0a" });
    expect(parts.find((p) => p.m === "ul")?.mrk).toBe("ul.0");
    // the ending has no article
    expect(parts.find((p) => p.m === "o")?.mrk).toBeUndefined();
  });

  test("a word the dictionary lacks has no mark, and its neighbours are still named", () => {
    const t = at("kunirado");
    expect(t.verdict).toBe("derived");
    expect(t.mrk).toBeUndefined();
    expect(t.parts!.find((p) => p.m === "ir")?.mrk).toBeDefined();
  });

  test("the structured result is what the tool's schema says", () => {
    const eoResult = executeGloss({ text: "Hundoj kuras kunirade.", lang: "eo", per_word: 4, max_words: 80, languages: ["de"] });
    expect(glossOutputSchema.parse(eoResult)).toEqual(eoResult);
    expect(eoResult.mode === "eo" && eoResult.terms[0].translations?.length).toBeGreaterThan(0);
    const source = executeGloss({ text: "The dog runs.", lang: "en", per_word: 4, max_words: 80 });
    expect(glossOutputSchema.parse(source)).toEqual(source);
  });
});
