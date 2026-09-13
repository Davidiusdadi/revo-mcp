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
      text: "hund",
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
});
