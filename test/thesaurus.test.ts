import { describe, test, expect, afterAll } from "bun:test";
import { handleThesaurus } from "../src/tools/thesaurus";
import { closeDb } from "../src/db";

afterAll(() => closeDb());

describe("thesaurus tool", () => {
  test("an empty filter does not claim the relation is absent", () => {
    // bela has malbela, but ReVo marks no antonym for it
    const out = handleThesaurus({ word: "bela", relations: ["ant"] });
    expect(out).toContain('No ant relations recorded for "bela"');
    expect(out).toContain("not that none exists");
  });

  test("a marked relation is listed without the caveat", () => {
    const out = handleThesaurus({ word: "varma", relations: ["ant"] });
    expect(out).toContain("malvarma");
    expect(out).not.toContain("not that none exists");
  });
});
