import { describe, test, expect, afterAll } from "bun:test";
import { searchExamples, closeDb } from "../src/db";
import { handleExamples } from "../src/tools/examples";
import { handleLookup } from "../src/tools/lookup";
import { extractAllExamples } from "../src/html-extract";
import { Database } from "bun:sqlite";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, "..", "data", "revo.db");

afterAll(() => closeDb());

describe("extractAllExamples", () => {
  test("extracts examples from a real article with expected markdown shape", () => {
    const db = new Database(DB_PATH, { readonly: true });
    const row = db
      .query<{ txt: Buffer }, [string]>("SELECT txt FROM artikolo WHERE mrk = ?")
      .get("abel");
    db.close();
    expect(row).toBeDefined();
    const examples = extractAllExamples(row!.txt, "abel");
    expect(examples.length).toBeGreaterThan(0);
    // At least one example should mention 'abelojn' (accusative plural)
    const hasAbelojn = examples.some((e) => e.ekzMd.includes("abelojn"));
    expect(hasAbelojn).toBe(true);
    // All entries must have a drvMrk
    for (const e of examples) {
      expect(e.drvMrk.length).toBeGreaterThan(0);
    }
  });
});

describe("searchExamples", () => {
  test("finds inflected form 'abelojn' in examples", () => {
    const hits = searchExamples("abelojn", 10);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].ekzMd.toLowerCase()).toContain("abelojn");
  });

  test("finds proper noun 'Mohéli' via diacritic-stripped FTS", () => {
    const hits = searchExamples("Mohéli", 5);
    expect(hits.length).toBeGreaterThan(0);
    // The nom span becomes **Mohéli** in stored markdown
    expect(hits[0].ekzMd).toContain("Mohéli");
  });

  test("empty query returns no results", () => {
    expect(searchExamples("", 10)).toEqual([]);
  });
});

describe("handleExamples tool", () => {
  test("returns markdown grouped by headword", () => {
    const out = handleExamples({ query: "abelojn", limit: 5 });
    expect(out).toContain("example sentences matching");
    expect(out).toContain("## ");
    expect(out).toContain("abelojn");
  });

  test("graceful empty state for a made-up word", () => {
    const out = handleExamples({ query: "zzzqqqxxxyyyxxxnonexistent", limit: 5 });
    expect(out).toContain("No example sentences match");
  });
});

describe("lookup fallback to examples", () => {
  test("word only in examples triggers fallback message", () => {
    // 'Anjuano' — island name mentioned inside the Komoroj article, not a headword
    const out = handleLookup({
      query: "Anjuano",
      lang: "eo",
      limit: 5,
      offset: 0,
    });
    expect(out).toContain("No dictionary entry for");
    expect(out).toContain("Anjuano");
    expect(out).toContain("example sentence");
  });

  test("regular headword does NOT trigger fallback", () => {
    const out = handleLookup({
      query: "amiko",
      lang: "eo",
      limit: 1,
      offset: 0,
    });
    expect(out).not.toContain("No dictionary entry");
    expect(out).toContain("## amiko");
  });
});
