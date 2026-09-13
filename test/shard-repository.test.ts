import { describe, expect, test } from "bun:test";
import { ShardRepository } from "../src/browser/shard-repository";

const root = process.env.REVO_SHARDS ?? "/tmp/revo-shards-smoke";
const localFetch = (input: string | URL | Request): Promise<Response> => {
  const url = new URL(input instanceof Request ? input.url : input.toString());
  const file = Bun.file(`${root}${url.pathname}`);
  return file.exists().then((exists) => exists
    ? new Response(file, { headers: { "content-type": "application/json" } })
    : new Response("missing", { status: 404 }));
};

describe("ShardRepository", () => {
  test("finds a translation and returns a complete structured entry", async () => {
    const repository = new ShardRepository("https://dictionary.invalid/", localFetch as typeof fetch);
    const result = await repository.search({ query: "Hund", languages: ["de", "en"], limit: 5 });
    expect(result.results[0].entry.headword).toBe("hundo");
    expect(result.results[0].entry.senses.length).toBeGreaterThan(0);
    expect(result.results[0].matchReasons).toContainEqual({
      language: "de",
      text: "Hund",
      kind: "translation",
    });
    expect(result.results[0].entry.translations.every(({ lng }) => ["de", "en"].includes(lng))).toBeTrue();
  });

  test("stems Esperanto forms before loading an entry", async () => {
    const repository = new ShardRepository("https://dictionary.invalid/", localFetch as typeof fetch);
    const result = await repository.search({ query: "amikojn", languages: ["en"], limit: 5 });
    expect(result.results[0].entry.headword).toBe("amiko");
  });

  test("loads a stable entry URL target by ReVo mark", async () => {
    const repository = new ShardRepository("https://dictionary.invalid/", localFetch as typeof fetch);
    const entry = await repository.lookup("nic.0o", ["en", "de"]);
    expect(entry.headword).toBe("Nico");
    expect(entry.usageDomains).toEqual(["GEOG", "POL"]);
    expect(entry.translations.map(({ trd }) => trd)).toContain("Nice");
  });

  test("only prefix-matches the literal Esperanto query", async () => {
    const repository = new ShardRepository("https://dictionary.invalid/", localFetch as typeof fetch);
    const result = await repository.search({ query: "gle", languages: ["de", "en"], limit: 20 });
    expect(result.results[0].entry.headword).toBe("glekomo");
    expect(result.results.map(({ entry }) => entry.headword)).not.toContain("glabelo");
    for (const { matchReasons } of result.results) {
      expect(new Set(matchReasons.map((reason) => JSON.stringify(reason))).size).toBe(matchReasons.length);
    }
  });

  test("shares source-language reductions with gloss search", async () => {
    const repository = new ShardRepository("https://dictionary.invalid/", localFetch as typeof fetch);
    const result = await repository.search({ query: "dogs", languages: ["en"], limit: 5 });
    expect(result.results[0].entry.headword).toBe("hundo");
    expect(result.results[0].matchReasons).toContainEqual({
      language: "en",
      text: "dog",
      kind: "translation-reduced",
      via: "dog",
    });
  });

  test("keeps every language interpretation of an ambiguous spelling", async () => {
    const repository = new ShardRepository("https://dictionary.invalid/", localFetch as typeof fetch);
    const result = await repository.search({ query: "nice", languages: ["de", "en", "fr"], limit: 10 });
    const city = result.results.find(({ entry }) => entry.headword === "Nico");
    const adjective = result.results.find(({ entry }) => entry.headword === "plaĉa");
    // Esperanto names the city even though English matched it more strongly.
    expect(city?.matchReasons[0]).toMatchObject({ language: "eo", text: "Nico" });
    expect(city?.matchReasons.some(({ language, text }) => language === "en" && text === "Nice")).toBeTrue();
    expect(adjective?.matchReasons[0]).toMatchObject({ language: "en", text: "nice", kind: "translation" });
  });

  test("lists an entry under every language it matched in", async () => {
    const repository = new ShardRepository("https://dictionary.invalid/", localFetch as typeof fetch);
    const search = (matchLanguage: string) =>
      repository.search({ query: "nice", languages: ["eo", "de", "en"], limit: 30, matchLanguage });
    const [esperanto, english] = await Promise.all([search("eo"), search("en")]);
    const titles = (output: typeof english) => Object.fromEntries(output.results.map(({ entry, matchReasons }) =>
      [entry.headword, `${matchReasons[0].language} ${matchReasons[0].text}`]));
    expect(titles(esperanto).Nico).toBe("eo Nico");
    expect(titles(esperanto).plaĉa).toBeUndefined();
    expect(titles(english)).toMatchObject({ Nico: "en Nice", plaĉa: "en nice" });
    expect(english.languageMatches).toEqual(esperanto.languageMatches);
    expect(english.languageMatches.map(({ language }) => language)).toEqual(["eo", "de", "en"]);
  });

  test("titles a source-language match in ReVo's spelling", async () => {
    const repository = new ShardRepository("https://dictionary.invalid/", localFetch as typeof fetch);
    const result = await repository.search({ query: "gleichmäßig", languages: ["eo", "de", "en"], limit: 10 });
    expect(result.results.map(({ entry }) => entry.headword)).toContain("egala");
    for (const { matchReasons } of result.results) {
      expect(matchReasons[0]).toMatchObject({ language: "de", text: "gleichmäßig", kind: "translation" });
    }
  });
});

describe("ShardRepository ranking and shard rows", () => {
  const entry = (mrk: string, headword: string, translations: [string, string][] = []) => ({
    headword, article: mrk.split(".")[0], mrk, senses: [], crossRefs: [], usageDomains: [],
    translations: translations.map(([lng, trd]) => ({ lng, trd })),
  });
  const files: Record<string, unknown> = {
    "index/eo.json": [["brako", "brak.0o", "brako"], ["disdoni", "dis.0doni", "disdoni"], ["mano", "man.0o", "mano"]],
    // Version-1 rows stop after the key, mark, label and index flag;
    // version-2 index rows add the complete expression.
    "index/de.json": [
      ["hand", "brak.0o", "brako"],
      ["palmsonntag", "palm.0dimanco", "palmdimanĉo"],
      ["verteilen", "dis.0doni", "disdoni", 1],
      ["verteilen", "disig.0i", "disigi", 1, "sich Verteilen lassen"],
    ],
    "index/en.json": [["hand", "man.0o", "mano"], ["palm", "man.0plato", "manplato"]],
    "index/fr.json": [["palms", "palm.0o", "palmo"]],
  };
  const entries = Object.fromEntries([
    entry("brak.0o", "brako", [["de", "Hand"]]),
    entry("dis.0doni", "disdoni", [["de", "etwas verteilen"]]),
    entry("disig.0i", "disigi", [["de", "sich Verteilen lassen"]]),
    entry("man.0o", "mano", [["en", "hand"]]),
    entry("man.0plato", "manplato", [["en", "palm"]]),
    entry("palm.0dimanco", "palmdimanĉo", [["de", "Palmsonntag"]]),
    entry("palm.0o", "palmo", [["fr", "palms"]]),
  ].map((item) => [item.mrk, item]));
  const repository = () => new ShardRepository("https://fixture.invalid/", async (input) => {
    const path = new URL(String(input)).pathname.slice(1);
    const body = path.startsWith("entries/") ? entries : files[path];
    return body ? Response.json(body) : new Response("missing", { status: 404 });
  });

  test("reads version-1 and version-2 index rows alike", async () => {
    const result = await repository().search({ query: "verteilen", languages: ["de"], limit: 5 });
    expect(result.results.map(({ entry }) => entry.headword)).toEqual(["disdoni", "disigi"]);
    expect(result.results[0].matchReasons).toEqual([
      { language: "de", text: "verteilen", kind: "translation-indexed", via: "verteilen" },
    ]);
    expect(result.results[1].matchReasons).toEqual([
      { language: "de", text: "sich Verteilen lassen", kind: "translation-indexed", via: "Verteilen" },
    ]);
  });

  test("ranks exact before reduced before prefix, whatever the language order", async () => {
    const result = await repository().search({ query: "palms", languages: ["de", "en", "fr"], limit: 5 });
    expect(result.results.map(({ entry }) => entry.headword)).toEqual(["palmo", "manplato", "palmdimanĉo"]);
    expect(result.results.map(({ matchReasons }) => matchReasons[0].kind))
      .toEqual(["translation", "translation-reduced", "translation-prefix"]);
    expect(result.results[1].matchReasons[0]).toMatchObject({ text: "palm", via: "palm" });
  });

  test("breaks ties by the requested language order", async () => {
    const germanFirst = await repository().search({ query: "hand", languages: ["de", "en"], limit: 5 });
    const englishFirst = await repository().search({ query: "Hand", languages: ["en", "eo", "de"], limit: 5 });
    expect(germanFirst.languages).toEqual(["de", "en"]);
    expect(germanFirst.results.map(({ entry }) => entry.headword)).toEqual(["brako", "mano"]);
    expect(germanFirst.results[0].matchReasons[0]).toMatchObject({ language: "de", text: "Hand" });
    expect(englishFirst.results.map(({ entry }) => entry.headword)).toEqual(["mano", "brako"]);
  });

  test("counts each searched language's matches in request order", async () => {
    const result = await repository().search({ query: "palm", languages: ["de", "en", "fr"], limit: 5 });
    expect(result.languageMatches).toEqual([
      { language: "eo", count: 0, more: false },
      { language: "de", count: 1, more: false },
      { language: "en", count: 1, more: false },
      { language: "fr", count: 1, more: false },
    ]);
  });

  test("marks a language whose matches run past the limit", async () => {
    for (const query of ["verteilen", "verteil"]) {
      const capped = await repository().search({ query, languages: ["de"], limit: 1 });
      expect(capped.results).toHaveLength(1);
      expect(capped.languageMatches).toContainEqual({ language: "de", count: 1, more: true });
      const complete = await repository().search({ query, languages: ["de"], limit: 2 });
      expect(complete.languageMatches).toContainEqual({ language: "de", count: 2, more: false });
    }
  });

  test("narrows results to one language, ranked and named by that match", async () => {
    const english = await repository().search({ query: "hand", languages: ["de", "en"], limit: 5, matchLanguage: "en" });
    expect(english.results.map(({ entry }) => entry.headword)).toEqual(["mano"]);
    expect(english.results[0].matchReasons[0]).toMatchObject({ language: "en", text: "hand" });
    expect(english.languageMatches.map(({ count }) => count)).toEqual([0, 1, 1]);

    // Under Esperanto the headword names the entry; under English its translation does.
    const esperanto = await repository().search({ query: "mano", languages: ["en"], limit: 5, matchLanguage: "eo" });
    expect(esperanto.results.map(({ entry }) => entry.headword)).toEqual(["mano"]);
    const unmatched = await repository().search({ query: "mano", languages: ["en"], limit: 5, matchLanguage: "en" });
    expect(unmatched.results).toEqual([]);
    expect(unmatched.languageMatches).toEqual([
      { language: "eo", count: 1, more: false },
      { language: "en", count: 0, more: false },
    ]);
  });
});
