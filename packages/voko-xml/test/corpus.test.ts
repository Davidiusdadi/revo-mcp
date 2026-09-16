/**
 * Whole-corpus guarantees: every article parses, round-trips losslessly, and
 * uses only markup the DTD declares. Runs over all 13k files (+ overlay).
 */
import { describe, test, expect } from "vitest";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  parse, serialize, domEqual, listArticles, inventory, emptyInventory, articleOf, rootsOf, kapForms,
  firstChild,
} from "../src";
import { FONTO, OVERLAY } from "./paths";

const articles = listArticles({ fonto: FONTO, overlay: OVERLAY });

describe("corpus", () => {
  test("lists the fonto snapshot", () => {
    expect(articles.length).toBeGreaterThanOrEqual(13011);
    expect(articles.find((a) => a.key === "san")?.source).toBe("fonto");
  });

  test("overlay replaces by file name and adds new keys", () => {
    const dir = mkdtempSync(join(tmpdir(), "voko-overlay-"));
    try {
      writeFileSync(join(dir, "san.xml"), "<vortaro/>");
      writeFileSync(join(dir, "zzz-nova.xml"), "<vortaro/>");
      const merged = listArticles({ fonto: FONTO, overlay: dir });
      expect(merged.length).toBe(articles.length + 1);
      expect(merged.find((a) => a.key === "san")?.source).toBe("overlay");
      expect(merged.find((a) => a.key === "zzz-nova")?.source).toBe("overlay");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("every article parses, round-trips, and is DTD-clean", () => {
    const inv = emptyInventory();
    const failures: string[] = [];
    let byteIdentical = 0;
    let noRad = 0;
    const t0 = Date.now();
    for (const a of articles) {
      const src = readFileSync(a.path, "utf8");
      let doc;
      try {
        doc = parse(src, a.path);
      } catch (e) {
        failures.push(`${a.key}: ${(e as Error).message}`);
        continue;
      }
      inventory(doc, inv);
      const again = parse(serialize(doc), a.path);
      if (!domEqual(doc.root, again.root)) failures.push(`${a.key}: round-trip differs`);
      if (serialize(doc, { encode: "entities" }) === src) byteIdentical++;
      const art = articleOf(doc);
      const roots = rootsOf(art);
      if (!roots.rad) noRad++;
      const kap = firstChild(art, "kap");
      if (!kap) failures.push(`${a.key}: no kap`);
      else if (!kapForms(kap, roots).txt) failures.push(`${a.key}: empty headword`);
    }
    const ms = Date.now() - t0;
    console.log(
      `corpus: ${articles.length} articles in ${ms}ms; byte-identical re-encode ${byteIdentical}; ` +
      `no <rad> ${noRad}; elements ${Object.keys(inv.elements).length}`
    );
    expect(failures.slice(0, 20)).toEqual([]);
    expect(inv.unknownElements).toEqual({});
    expect(inv.unknownAttributes).toEqual({});
  }, 120_000);
});
