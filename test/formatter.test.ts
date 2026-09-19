import { afterAll, describe, expect, test } from "vitest";
import { closeDb, lookupEsperanto, type LookupResult } from "../src/db";
import { formatResults } from "../src/formatter";

afterAll(() => closeDb());

const seeAlso = (text: string) => text.slice(text.indexOf("### See also")).split("\n").slice(1).filter(Boolean);

describe("See also", () => {
  test("puts the most telling kinds first and labels them as ReVo reads them", () => {
    const result: LookupResult = {
      headword: "semajno", article: "semajn", mrk: "semajn.0o", senses: [], translations: [], usageDomains: [],
      crossRefs: [
        { target: "a", type: "lst", targetKap: "tempounuo" },
        { target: "b", type: "prt", targetKap: "lundo" },
        { target: "c", type: "malprt", targetKap: "monato" },
        { target: "d", type: "dif", targetKap: "septago" },
        { target: "e", type: "", targetKap: "tago" },
        { target: "f", type: "sin", targetKap: "hebdomado" },
      ],
    };
    expect(seeAlso(formatResults([result]))).toEqual([
      "- Synonym: hebdomado",
      "- Same as: septago",
      "- See: tago",
      "- Part of: monato",
      "- Has part: lundo",
    ]);
  });

  test("hundo keeps its synonym, names the family it belongs to and leaves itself out", () => {
    expect(seeAlso(formatResults(lookupEsperanto("hundo", 1)))).toEqual([
      "- Synonym: domhundo",
      "- Part of: hundedoj",
      "- Has part: lupo",
      "- Has part: ŝakalo",
      "- Has part: kojoto",
    ]);
  });
});
