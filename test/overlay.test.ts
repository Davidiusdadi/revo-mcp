/**
 * The overlay path: `corpus/overlay/*.xml` merged over the submodule by file
 * name. The directory ships empty, so without a test the mechanism is a claim
 * in a README; here a fixture overlay is built and its effect measured.
 *
 * The effect is the point. An overlay usage sample is a real usage sample: it
 * lands in `ekz`, the `tld-links` and `morph` passes pick it up, and a word
 * that `gloss` could only call a *regular derivation* becomes an *attested*
 * form. That is how a word ReVo never lists gets evidence behind it.
 */
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { Database } from "../src/runtime/node-database";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { buildArticles, PASSES } from "../src/corpus/build";
import { runPass } from "../src/corpus/pass";
import { classify, inventoryOf } from "../src/gloss";
import { assembleEntry, entryNodeByMark, searchDefinitions } from "../src/db-voko";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "overlay");
// ardez + tabul + et carry the compound in the fixture's usage sample; superardez is
// overlay-only, so the slice filter has to be told about it by key; so is difardez, a
// sense whose definition is also given in German
const EXTRA = ["ardez", "tabul", "et", "superardez", "difardez"];

let dir: string;
let db: Database;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "voko-overlay-"));
  db = buildArticles(join(dir, "slice.db"), 120, EXTRA, FIXTURE);
  for (const p of PASSES) runPass(db, p, () => {});
});
afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true });
});

const one = <T>(sql: string, ...params: unknown[]) => db.query(sql).get(...(params as [])) as T;

describe("overlay merge", () => {
  test("an overlay file replaces the upstream article of the same name", () => {
    const art = one<{ source: string }>("SELECT source FROM article WHERE file = 'ardez'");
    expect(art.source).toBe("overlay");
    // upstream ardez.xml has two derivations, ardezo and ardeza; the fixture has only the first
    expect(one<{ c: number }>("SELECT COUNT(*) c FROM headword WHERE norm = 'ardeza'").c).toBe(0);
    expect(
      one<{ c: number }>(
        "SELECT COUNT(*) c FROM node WHERE kind = 'drv' AND article_id = (SELECT id FROM article WHERE file = 'ardez')"
      ).c
    ).toBe(1);
  });

  test("an overlay file with a new name adds an article", () => {
    const art = one<{ source: string }>("SELECT source FROM article WHERE file = 'superardez'");
    expect(art.source).toBe("overlay");
    expect(one<{ txt: string }>("SELECT txt FROM headword WHERE norm = 'superardezo'").txt).toBe("superardezo");
  });

  test("articles left alone stay marked as coming from the submodule", () => {
    expect(one<{ source: string }>("SELECT source FROM article WHERE file = 'tabul'").source).toBe("fonto");
  });

  test("an overlay usage sample reaches the enrichment tables", () => {
    const tok = one<{ n: number }>("SELECT n FROM x_token WHERE norm = 'ardeztabuletoj'");
    expect(tok?.n).toBe(1);
  });

  test("and turns a derivation gloss could only infer into an attested form", () => {
    const term = classify(db, "ardeztabuletoj", inventoryOf(db));
    expect(term.verdict).toBe("attested");
    expect(term.attested).toBe(1);
    expect(term.seg).toBe("ardez|tabul|et|oj");
  });
});

describe("a definition in another language", () => {
  const entry = (languages?: string[]) => assembleEntry(db as never, entryNodeByMark(db as never, "difardez.0o")!, { languages });

  test("is kept, with its source, beside the Esperanto one", () => {
    const [sense] = entry().senses;
    expect(sense.definition).toBe("Elpensita ŝtono, ekzistanta nur en testo.");
    expect(sense.definitions).toEqual([
      { lng: "de", txt: "Ein erfundener Schieferstein, difardezo genannt.", fnt: "AI: tradukis claude-opus-5-5" },
    ]);
  });

  test("follows the languages asked for", () => {
    expect(entry(["de", "en"]).senses[0].definitions).toHaveLength(1);
    expect(entry(["en"]).senses[0].definitions).toBeUndefined();
  });

  test("stays out of what reads Esperanto: definition search and tilde links", () => {
    expect(searchDefinitions(db as never, "Schieferstein")).toEqual([]);
    expect(searchDefinitions(db as never, "elpensita ŝtono").length).toBeGreaterThan(0);
    const owners = db.query("SELECT owner_kind FROM x_tld_occ WHERE article_id = (SELECT id FROM article WHERE file = 'difardez')").all() as { owner_kind: string }[];
    // the headword's tilde alone; the one in the German definition is no Esperanto word
    expect(owners.map((r) => r.owner_kind)).toEqual(["kap"]);
  });
});
