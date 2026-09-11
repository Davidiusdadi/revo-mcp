import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  parse, serialize, articleOf, rootsOf, kapForms, nodes, plainText, parseArtId,
  descendants, firstChild, childElements, inventory, substituteEntities, UnknownEntityError,
} from "../src";
import { FONTO } from "./paths";

const san = parse(readFileSync(join(FONTO, "san.xml"), "utf8"), "san.xml");
const art = articleOf(san);
const roots = rootsOf(art);

describe("san.xml", () => {
  test("prolog is preserved", () => {
    expect(san.xmlDecl).toBe('version="1.0"');
    expect(san.doctype).toBe('vortaro SYSTEM "../dtd/vokoxml.dtd"');
    expect(serialize(san).startsWith('<?xml version="1.0"?>\n<!DOCTYPE vortaro SYSTEM "../dtd/vokoxml.dtd">\n<vortaro>')).toBe(true);
  });

  test("CVS id yields file/rev/date", () => {
    expect(parseArtId(art.attrs.mrk)).toEqual({ file: "san.xml", rev: "1.112", date: "2026-01-17 10:34:34" });
  });

  test("root and article headword", () => {
    expect(roots.rad).toBe("san");
    const kap = kapForms(firstChild(art, "kap")!, roots);
    expect(kap.tilde).toBe("san/a");
    expect(kap.txt).toBe("sana");
    expect(kap.ofc).toBe("*");
  });

  test("mal~ulejo keeps its segmentation and expands", () => {
    const drv = [...descendants(art, "drv")].find((d) => d.attrs.mrk === "san.mal0ulejo")!;
    const kap = kapForms(firstChild(drv, "kap")!, roots);
    expect(kap.tilde).toBe("mal~ulejo");
    expect(kap.txt).toBe("malsanulejo");
    expect(kap.norm).toBe("malsanulejo");
    expect(kap.ofc).toBe("*");
  });

  test("tld lit= replaces the root's first letter", () => {
    const snc = [...descendants(art, "snc")].find((s) => s.attrs.mrk === "san.0a.saniga")!;
    const ref = [...descendants(snc, "ref")][0];
    expect(plainText(ref, { roots })).toBe("Sanfavora");
  });

  test("example text drops citations and expands tildes inside words", () => {
    const drv = [...descendants(art, "drv")].find((d) => d.attrs.mrk === "san.mal0ulejo")!;
    const ekz = [...descendants(drv, "ekz")].map((e) => plainText(e, { roots }));
    expect(ekz.some((t) => t.includes("malsanulejon de la malriĉulejo"))).toBe(true);
    expect(ekz.every((t) => !t.includes("Fab"))).toBe(true);
  });

  test("structural nodes get stable path keys and mrks", () => {
    const ns = nodes(art, "san");
    expect(ns[0]).toMatchObject({ kind: "art", key: "san", mrk: null });
    const first = ns.find((n) => n.mrk === "san.0a")!;
    expect(first.key).toBe("san/drv[0]");
    const snc = ns.find((n) => n.mrk === "san.0a.saniga")!;
    expect(snc.key).toBe("san/drv[0]/snc[1]");
    expect(snc.parent).toBe(first);
    expect(ns.filter((n) => n.kind === "drv").length).toBe(childElements(art, "drv").length);
  });

  test("inventory finds no unknown markup", () => {
    const inv = inventory(san);
    expect(inv.unknownElements).toEqual({});
    expect(inv.unknownAttributes).toEqual({});
    expect(inv.elements.tld).toBeGreaterThan(50);
  });
});

describe("entities", () => {
  test("named, nested and builtin entities", () => {
    expect(substituteEntities("&ccirc;u &FE; &amp; &#x16d;")).toBe("ĉu Ekzercaro, § &amp; &#x16d;");
    expect(() => substituteEntities("&nosuch;", "x.xml")).toThrow(UnknownEntityError);
  });
  test("serializer entity mode re-encodes", () => {
    const d = parse('<?xml version="1.0"?>\n<vortaro><art mrk="x"><kap>ĉ&amp;ŭ</kap></art></vortaro>');
    expect(serialize(d, { encode: "entities" })).toContain("<kap>&ccirc;&amp;&ubreve;</kap>");
    expect(serialize(d)).toContain("<kap>ĉ&amp;ŭ</kap>");
  });
});
