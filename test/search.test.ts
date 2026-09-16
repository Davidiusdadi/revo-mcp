import { Database } from "../src/runtime/node-database";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { ArticleSource } from "voko-xml";
import { importDocuments } from "../src/corpus/documents";
import { searchPass } from "../src/corpus/passes/search";
import { structurePass } from "../src/corpus/passes/structure";
import { getDb } from "../src/db";
import { searchDefinitions, thesaurusOf } from "../src/db-voko";
import { searchDictionary } from "../src/search";
import type { SqlReader } from "../src/sql";
import { executeEntry, type SearchInput } from "../src/tools/search";

const search = (input: Partial<SearchInput> & { query: string }, db: SqlReader = getDb()) =>
  searchDictionary(db, { languages: [], limit: 20, ...input });

describe("search over the dictionary", () => {
  test("finds a translation and returns what a result card shows", () => {
    const result = search({ query: "Hund", languages: ["de", "en"], limit: 5 });
    expect(result.results[0].entry.headword).toBe("hundo");
    expect(result.results[0].matchReasons).toContainEqual({ language: "de", text: "Hund", kind: "translation" });
    expect(result.results[0].entry.translations.length).toBeGreaterThan(0);
    expect(result.results[0].entry.translations.every(({ lng }) => ["de", "en"].includes(lng))).toBe(true);
    // Senses are the entry tool's: a result page reads no more than its cards.
    expect(result.results[0].entry.senses).toEqual([]);
  });

  test("stems Esperanto forms", () => {
    const result = search({ query: "amikojn", languages: ["en"], limit: 5 });
    expect(result.results[0].entry.headword).toBe("amiko");
  });

  test("loads a complete entry by its ReVo mark", () => {
    const { entry } = executeEntry({ mark: "nic.0o", languages: ["en", "de"] });
    expect(entry.headword).toBe("Nico");
    expect(entry.usageDomains).toEqual(["GEOG", "POL"]);
    expect(entry.translations.map(({ trd }) => trd)).toContain("Nice");
    expect(entry.translations.every(({ lng }) => ["de", "en"].includes(lng))).toBe(true);
    expect(executeEntry({ mark: "hund.0o" }).entry.senses.length).toBeGreaterThan(0);
    expect(() => executeEntry({ mark: "hund.0nenio" })).toThrow("No dictionary entry has the mark hund.0nenio.");
  });

  test("only prefix-matches the literal Esperanto query", () => {
    const result = search({ query: "gle", languages: ["de", "en"], limit: 20 });
    expect(result.results[0].entry.headword).toBe("glekomo");
    expect(result.results.map(({ entry }) => entry.headword)).not.toContain("glabelo");
    for (const { matchReasons } of result.results) {
      expect(new Set(matchReasons.map((reason) => JSON.stringify(reason))).size).toBe(matchReasons.length);
    }
  });

  test("shares source-language reductions with gloss search", () => {
    const result = search({ query: "dogs", languages: ["en"], limit: 5 });
    expect(result.results[0].entry.headword).toBe("hundo");
    expect(result.results[0].matchReasons).toContainEqual({
      language: "en",
      text: "dog",
      kind: "translation-reduced",
      via: "dog",
    });
  });

  test("keeps every language interpretation of an ambiguous spelling", () => {
    const result = search({ query: "nice", languages: ["de", "en", "fr"], limit: 10 });
    const city = result.results.find(({ entry }) => entry.headword === "Nico");
    const adjective = result.results.find(({ entry }) => entry.headword === "plaĉa");
    // English matched the city exactly and Esperanto only through a stem, so English names it.
    expect(city?.matchReasons[0]).toMatchObject({ language: "en", text: "Nice", kind: "translation" });
    expect(city?.matchReasons.some(({ language, text }) => language === "eo" && text === "Nico")).toBe(true);
    expect(adjective?.matchReasons[0]).toMatchObject({ language: "en", text: "nice", kind: "translation" });
  });

  test("lists an entry under every language it matched in", () => {
    const byLanguage = (matchLanguage: string) =>
      search({ query: "nice", languages: ["eo", "de", "en"], limit: 30, matchLanguage });
    const [esperanto, english] = [byLanguage("eo"), byLanguage("en")];
    const titles = (output: typeof english) => Object.fromEntries(output.results.map(({ entry, matchReasons }) =>
      [entry.headword, `${matchReasons[0].language} ${matchReasons[0].text}`]));
    expect(titles(esperanto).Nico).toBe("eo Nico");
    expect(titles(esperanto).plaĉa).toBeUndefined();
    expect(titles(english)).toMatchObject({ Nico: "en Nice", plaĉa: "en nice" });
    expect(english.languageMatches).toEqual(esperanto.languageMatches);
    expect(english.languageMatches.map(({ language }) => language)).toEqual(["eo", "de", "en"]);
  });

  test("reaches a late language's matches that a first page leaves out", () => {
    const languages = ["eo", "de", "en", "br"];
    const combined = search({ query: "mal", languages, limit: 30 });
    const breton = search({ query: "mal", languages, limit: 50, matchLanguage: "br" });
    const count = (language: string) => combined.languageMatches.find((match) => match.language === language)!.count;
    expect(count("eo")).toBeGreaterThan(30);
    expect(breton.total).toBe(count("br"));
    expect(breton.results).toHaveLength(count("br"));
    // Every entry any language matched is somewhere in the combined ranking.
    expect(combined.total).toBeGreaterThanOrEqual(Math.max(...languages.map(count)));
    const last = search({ query: "mal", languages, limit: 50, offset: combined.total - 50 });
    const lastMarks = new Set(last.results.map(({ entry }) => entry.mrk));
    const bretonOnly = breton.results.filter(({ matchReasons }) => matchReasons.every(({ language }) => language === "br"));
    expect(bretonOnly.length).toBeGreaterThan(0);
    for (const { entry } of bretonOnly) expect(lastMarks.has(entry.mrk)).toBe(true);
  });

  test("narrows a search to the entries of one usage domain", () => {
    const all = search({ query: "hund", languages: ["de", "en"], limit: 50 });
    const zoology = all.domainMatches.find(({ domain }) => domain === "ZOO");
    expect(zoology?.count).toBeGreaterThan(0);
    const narrowed = search({ query: "hund", languages: ["de", "en"], limit: 50, domain: "ZOO" });
    expect(narrowed.total).toBe(zoology!.count);
    expect(narrowed.results).toHaveLength(zoology!.count);
    for (const { entry } of narrowed.results) expect(entry.usageDomains).toContain("ZOO");
    expect(narrowed.results.map(({ entry }) => entry.headword)).toContain("hundo");
  });

  test("titles a source-language match in ReVo's spelling", () => {
    const result = search({ query: "gleichmäßig", languages: ["eo", "de", "en"], limit: 10 });
    expect(result.results.map(({ entry }) => entry.headword)).toContain("egala");
    for (const { matchReasons } of result.results) {
      expect(matchReasons[0]).toMatchObject({ language: "de", text: "gleichmäßig", kind: "translation" });
    }
  });
});

describe("search ranking", () => {
  interface FixtureEntry {
    mrk: string;
    headword: string;
    translations?: { lng: string; txt: string; ind?: string }[];
    domains?: string[];
  }

  /** A database of the given entries, an article per mark root, built as the corpus is. */
  function fixture(entries: FixtureEntry[]): SqlReader {
    const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;");
    const articles = new Map<string, string[]>();
    for (const { mrk, headword, translations = [], domains = [] } of entries) {
      const key = mrk.split(".")[0];
      const drvs = articles.get(key) ?? [];
      articles.set(key, drvs);
      drvs.push([
        `<drv mrk="${mrk}">`,
        `  <kap>${escape(headword)}</kap>`,
        ...domains.map((txt) => `  <uzo tip="fak">${txt}</uzo>`),
        // an index form files the translation under a word of its own text
        ...translations.map(({ lng, txt, ind }) => `  <trd lng="${lng}">${
          ind ? escape(txt).replace(escape(ind), `<ind>${escape(ind)}</ind>`) : escape(txt)}</trd>`),
        "</drv>",
      ].join("\n"));
    }
    const dir = mkdtempSync(join(tmpdir(), "search-ranking-"));
    const sources = [...articles].map(([key, drvs]): ArticleSource => {
      const path = join(dir, `${key}.xml`);
      writeFileSync(path, `<?xml version="1.0"?>\n<!DOCTYPE vortaro SYSTEM "../dtd/vokoxml.dtd">\n<vortaro>
<art mrk="$Id: ${key}.xml,v 1.1 2026/01/01 00:00:00 revo Exp $">
<kap><rad>${key}</rad></kap>
${drvs.join("\n")}
</art>
</vortaro>
`);
      return { key, path, source: "overlay" };
    });
    const db = new Database(":memory:");
    try {
      db.exec(readFileSync("src/corpus/schema.sql", "utf8"));
      importDocuments(db, sources);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    structurePass.run(db, () => undefined);
    searchPass.run(db, () => undefined);
    return db as unknown as SqlReader;
  }

  const db = fixture([
    { mrk: "brak.0o", headword: "brako", translations: [{ lng: "de", txt: "Hand" }], domains: ["ANA"] },
    { mrk: "dis.0doni", headword: "disdoni", translations: [{ lng: "de", txt: "etwas verteilen", ind: "verteilen" }] },
    { mrk: "disig.0i", headword: "disigi", translations: [{ lng: "de", txt: "sich Verteilen lassen", ind: "Verteilen" }] },
    { mrk: "man.0o", headword: "mano", translations: [{ lng: "en", txt: "hand" }], domains: ["ANA", "FIG"] },
    { mrk: "man.0plato", headword: "manplato", translations: [{ lng: "en", txt: "palm" }] },
    { mrk: "palm.0dimanco", headword: "palmdimanĉo", translations: [{ lng: "de", txt: "Palmsonntag" }] },
    { mrk: "palm.0o", headword: "palmo", translations: [{ lng: "fr", txt: "palms" }] },
  ]);
  const headwords = (output: ReturnType<typeof search>) => output.results.map(({ entry }) => entry.headword);

  test("names a filed translation by its expression and the form it is filed under", () => {
    const result = search({ query: "verteilen", languages: ["de"], limit: 5 }, db);
    expect(headwords(result)).toEqual(["disdoni", "disigi"]);
    expect(result.results[0].matchReasons).toEqual([
      { language: "de", text: "etwas verteilen", kind: "translation-indexed", via: "verteilen" },
    ]);
    expect(result.results[1].matchReasons).toEqual([
      { language: "de", text: "sich Verteilen lassen", kind: "translation-indexed", via: "Verteilen" },
    ]);
  });

  test("ranks exact before reduced before prefix, whatever the language order", () => {
    const result = search({ query: "palms", languages: ["de", "en", "fr"], limit: 5 }, db);
    expect(headwords(result)).toEqual(["palmo", "manplato", "palmdimanĉo"]);
    expect(result.results.map(({ matchReasons }) => matchReasons[0].kind))
      .toEqual(["translation", "translation-reduced", "translation-prefix"]);
    expect(result.results[1].matchReasons[0]).toMatchObject({ text: "palm", via: "palm" });
  });

  test("breaks ties by the requested language order", () => {
    const germanFirst = search({ query: "hand", languages: ["de", "en"], limit: 5 }, db);
    const englishFirst = search({ query: "Hand", languages: ["en", "eo", "de"], limit: 5 }, db);
    expect(germanFirst.languages).toEqual(["de", "en"]);
    expect(headwords(germanFirst)).toEqual(["brako", "mano"]);
    expect(germanFirst.results[0].matchReasons[0]).toMatchObject({ language: "de", text: "Hand" });
    expect(headwords(englishFirst)).toEqual(["mano", "brako"]);
  });

  test("counts each searched language's matches in request order", () => {
    const result = search({ query: "palms", languages: ["de", "en", "fr"], limit: 5 }, db);
    expect(result.languageMatches).toEqual([
      { language: "eo", count: 0 },
      { language: "de", count: 1 },
      { language: "en", count: 1 },
      { language: "fr", count: 1 },
    ]);
  });

  test("pages through every result, whatever the page size", () => {
    for (const query of ["verteilen", "verteil"]) {
      const pages = [0, 1, 2].map((offset) => search({ query, languages: ["de"], limit: 1, offset }, db));
      expect(pages.map((page) => headwords(page))).toEqual([["disdoni"], ["disigi"], []]);
      for (const page of pages) {
        expect(page.total).toBe(2);
        expect(page.languageMatches).toContainEqual({ language: "de", count: 2 });
      }
    }
    const first = search({ query: "hand", languages: ["de", "en"], limit: 1 }, db);
    const second = search({ query: "hand", languages: ["de", "en"], limit: 1, offset: 1 }, db);
    expect([...headwords(first), ...headwords(second)]).toEqual(["brako", "mano"]);
    expect(second.results[0].matchReasons[0]).toMatchObject({ language: "en", text: "hand" });
  });

  test("counts usage domains among the results and narrows to one", () => {
    const all = search({ query: "hand", languages: ["de", "en"], limit: 5 }, db);
    expect(all.domainMatches).toEqual([{ domain: "ANA", count: 2 }, { domain: "FIG", count: 1 }]);
    expect(all.results.map(({ entry }) => entry.usageDomains)).toEqual([["ANA"], ["ANA", "FIG"]]);

    const figurative = search({ query: "hand", languages: ["de", "en"], limit: 5, domain: "FIG" }, db);
    expect(headwords(figurative)).toEqual(["mano"]);
    expect(figurative.total).toBe(1);
    // The counts describe the list before the domain narrowed it, so another can be chosen.
    expect(figurative.domainMatches).toEqual(all.domainMatches);
    const second = search({ query: "hand", languages: ["de", "en"], limit: 1, offset: 1, domain: "ANA" }, db);
    expect(headwords(second)).toEqual(["mano"]);

    // Within one language's list, only its entries count.
    const german = search({ query: "hand", languages: ["de", "en"], limit: 5, matchLanguage: "de", domain: "FIG" }, db);
    expect(german.results).toEqual([]);
    expect(german.total).toBe(0);
    expect(german.domainMatches).toEqual([{ domain: "ANA", count: 1 }]);

    // An entry without domains is listed and counts toward none.
    const palms = search({ query: "palms", languages: ["de", "en", "fr"], limit: 5 }, db);
    expect(palms.domainMatches).toEqual([]);
    expect(palms.total).toBe(3);
  });

  test("narrows results to one language, ranked and named by that match", () => {
    const english = search({ query: "hand", languages: ["de", "en"], limit: 5, matchLanguage: "en" }, db);
    expect(headwords(english)).toEqual(["mano"]);
    expect(english.results[0].matchReasons[0]).toMatchObject({ language: "en", text: "hand" });
    expect(english.languageMatches.map(({ count }) => count)).toEqual([0, 1, 1]);

    // Under Esperanto the headword names the entry; under English its translation does.
    const esperanto = search({ query: "mano", languages: ["en"], limit: 5, matchLanguage: "eo" }, db);
    expect(headwords(esperanto)).toEqual(["mano"]);
    expect(esperanto.results[0].matchReasons[0]).toEqual({ language: "eo", text: "mano", kind: "headword" });
    const unmatched = search({ query: "mano", languages: ["en"], limit: 5, matchLanguage: "en" }, db);
    expect(unmatched.results).toEqual([]);
    expect(unmatched.total).toBe(0);
    expect(unmatched.languageMatches).toEqual([
      { language: "eo", count: 1 },
      { language: "en", count: 0 },
    ]);
  });

  test("a database built without the enrichment passes says so when asked for them", () => {
    expect(() => thesaurusOf(db, "mano")).toThrow(
      "The thesaurus needs the refs, index passes, which this database was built without (a core build).");
    expect(() => searchDefinitions(db, "mano")).toThrow("Reverse lookup needs the fts pass");
  });
});
