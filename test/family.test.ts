import { describe, test, expect } from "vitest";
import { getDb } from "../src/db";
import { familyOf } from "../src/family";

const heads = (mark: string, opts = {}) =>
  familyOf(getDb(), mark, opts).families[0].members.map((m) => [m.headword, m.shortened ?? false]);

describe("word families and shortened names", () => {
  test("a name built on the root shortened is in the root's family, last", () => {
    const members = heads("mihxael.0o");
    expect(members.at(-1)?.[1]).toBe(true);
    expect(members.filter(([, short]) => short).map(([h]) => h)).toEqual(["Miĉjo", "Miĉjo Muso"]);
    expect(members.findIndex(([, short]) => short)).toBe(members.length - 2);
  });

  test("in place or not at all, as asked; the entry asked about stays in its own family", () => {
    expect(heads("mihxael.0o", { shortened: "hidden" }).some(([, short]) => short)).toBe(false);
    expect(heads("mihxael.0cxjo", { shortened: "hidden" }).map(([h]) => h)).toContain("Miĉjo");
    const inPlace = heads("mihxael.0o", { shortened: "normal" }).map(([h]) => h);
    expect(inPlace.indexOf("Miĉjo")).toBeLessThan(inPlace.indexOf("Monto Sankta Miĥaelo"));
  });

  test("the letters a name shortens a root to are no family of their own", () => {
    const mi = familyOf(getDb(), "mi.0").families.find((f) => f.root === "mi")!;
    expect(mi.members.map((m) => m.headword)).not.toContain("Miĉjo");
    expect(mi.members.map((m) => m.headword)).not.toContain("Ho-Ĉi-Min-Urbo");
  });
});
