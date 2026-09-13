import { describe, expect, test } from "bun:test";
import { reductionsOf, sourceFormAttempts } from "../src/source-forms";

describe("source-language forms", () => {
  test("reduces common English and German inflections", () => {
    expect(reductionsOf("dogs", "en")).toContain("dog");
    expect(reductionsOf("gleichmäßigen", "de")).toContain("gleichmäßig");
  });

  test("keeps the original attempt first and reports reduced forms", () => {
    const attempts = sourceFormAttempts("Dogs", "en");
    expect(attempts[0].forms).toContain("Dogs");
    expect(attempts.find(({ via }) => via === "dog")?.forms).toContain("dog");
  });

  test("does not invent reductions for unsupported languages", () => {
    expect(reductionsOf("chiens", "fr")).toEqual([]);
  });
});
