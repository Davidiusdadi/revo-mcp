import { afterAll, describe, expect, test } from "vitest";
import { closeDb, lookupEsperanto, type LookupResult } from "../src/db";
import { citation, formatResults } from "../src/formatter";

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

describe("Examples", () => {
  test("name where they are quoted from, as a reader cites a work", () => {
    expect(citation({ bib: "F", lok: "Ekzercaro, § 12", bibliogr: { tit: "Fundamento de Esperanto", aut: "L. L. Zamenhof" } }))
      .toBe("L. L. Zamenhof, *Fundamento de Esperanto*, Ekzercaro, § 12");
    // the article's own author and work come first; the work of the bibliography it appeared in after them
    expect(citation({ aut: "C. Minnaja", vrk: "Lingvo kaj popolo", bib: "LOdE", lok: "2007:3", bibliogr: { tit: "La Ondo de Esperanto" } }))
      .toBe("C. Minnaja, *Lingvo kaj popolo*, *La Ondo de Esperanto*, 2007:3");
    // a code the bibliography lacks stands for itself, and a place that only repeats the title is left out
    expect(citation({ bib: "Prv" })).toBe("*Prv*");
    expect(citation({ bib: "FK", lok: "Fundamenta Krestomatio", bibliogr: { tit: "Fundamenta Krestomatio" } })).toBe("*Fundamenta Krestomatio*");
  });

  test("hundo's proverb carries its translations under it", () => {
    const text = formatResults(lookupEsperanto("hundo", 1), ["de"]);
    expect(text).toContain("  - *oni lin konas kiel makulharan hundon (li estas de ĉiuj konata)* — *Prv*\n    - (de) er ist bekannt wie ein bunter Hund");
  });
});
