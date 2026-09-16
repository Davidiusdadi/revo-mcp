/**
 * Typed views over the generic DOM: roots and tildes, headword forms, node
 * paths, plain-text rendering, inventory. Pure functions; nothing here mutates
 * or copies the document.
 */
import {
  type Document, type Element, type Node,
  childElements, firstChild, descendants, ancestor,
} from "./tree";
import { ELEMENT_SET, ATTRIBUTES, NODE_KIND_SET, type NodeKind } from "./model";

// ---- article + roots ------------------------------------------------------

export interface Roots {
  /** The article's main `<rad>` text (e.g. "san"); "" if the article has none. */
  rad: string;
  /** Variant roots, keyed by `<rad var="…">` → text (referenced by `<tld var="…"/>`). */
  byVar: Record<string, string>;
}

export function articleOf(doc: Document): Element {
  const root = doc.root;
  if (root.name === "art") return root;
  const art = firstChild(root, "art");
  if (!art) throw new Error(`${doc.file ?? "document"}: no <art> element`);
  return art;
}

/** CVS "$Id: san.xml,v 1.112 2026/01/17 10:34:34 revo Exp $" → {file, rev, date}. */
export function parseArtId(mrk: string): { file?: string; rev?: string; date?: string } {
  const m = /^\$Id:\s+(\S+),v\s+(\S+)\s+(\S+)\s+(\S+)/.exec(mrk);
  if (!m) return {};
  return { file: m[1], rev: m[2], date: `${m[3].replace(/\//g, "-")} ${m[4]}` };
}

export function rootsOf(art: Element): Roots {
  const kap = firstChild(art, "kap");
  const roots: Roots = { rad: "", byVar: {} };
  if (!kap) return roots;
  let first = "";
  for (const rad of descendants(kap, "rad")) {
    const txt = textOf(rad).trim();
    const v = rad.attrs.var;
    if (!first) first = txt;
    if (v !== undefined) roots.byVar[v] = txt;
    else if (!roots.rad) roots.rad = txt;
  }
  // dardanel.xml has only `<rad var="j">`: a variant-tagged root still is the root.
  if (!roots.rad) roots.rad = first;
  return roots;
}

/** Raw concatenated text content, entities already resolved, no tilde expansion. */
export function textOf(el: Element): string {
  let s = "";
  for (const c of el.children) {
    if (c.type === "text") s += c.value;
    else if (c.type === "element") s += textOf(c);
  }
  return s;
}

/** Expand one `<tld lit var/>` against the roots. `lit` replaces the root's first letter. */
export function expandTld(tld: Element, roots: Roots): string {
  const base = tld.attrs.var !== undefined ? roots.byVar[tld.attrs.var] ?? roots.rad : roots.rad;
  const lit = tld.attrs.lit;
  if (lit !== undefined && base.length > 0) return lit + base.slice(1);
  return base;
}

// ---- plain text -----------------------------------------------------------

export interface TextOptions {
  roots: Roots;
  /** Elements to omit entirely (default: fnt — citations are structured separately). */
  omit?: ReadonlySet<string>;
  /** Render `<tld/>` as "~" (headword display) instead of the expanded root. */
  tildeAsMark?: boolean;
}

const DEFAULT_OMIT: ReadonlySet<string> = new Set(["fnt"]);

/**
 * Plain text of an element: tildes expanded, omitted elements dropped,
 * comments ignored, whitespace collapsed. This is the `txt` column of every
 * text-bearing table in the corpus DB.
 */
export function plainText(el: Element, opts: TextOptions): string {
  const out: string[] = [];
  renderInline(el, opts, out);
  return collapse(out.join(""));
}

function renderInline(el: Element, opts: TextOptions, out: string[]): void {
  const omit = opts.omit ?? DEFAULT_OMIT;
  for (const c of el.children) {
    if (c.type === "text") out.push(c.value);
    else if (c.type === "element") {
      if (omit.has(c.name)) continue;
      if (c.name === "tld") out.push(opts.tildeAsMark ? "~" : expandTld(c, opts.roots));
      else if (c.name === "ctl") {
        // <ctl> is quoted text; ReVo renders the quotes, the XML doesn't carry them
        out.push("„");
        renderInline(c, opts, out);
        out.push("“");
      } else renderInline(c, opts, out);
    }
  }
}

export function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

// ---- headwords ------------------------------------------------------------

export interface KapForms {
  /** Display form with the root marked: "mal~ulejo", "san/a" for article kap. */
  tilde: string;
  /** Full word: "malsanulejo", "sana". The "/" root separator of article kaps is removed. */
  txt: string;
  /** Unicode-lowercased `txt` (SQLite NOCASE only folds ASCII). */
  norm: string;
  ofc: string | null;
  /** Nested `<var><kap>` variants, each with its own forms and its own `<rad var>` if any. */
  variants: KapForms[];
}

const KAP_OMIT: ReadonlySet<string> = new Set(["fnt", "ofc", "var"]);
/** The separator before a <var> ("<tld/>i, <var>…") belongs to neither form. */
const stripSep = (s: string) => s.replace(/[\s,;]+$/, "");

export function kapForms(kap: Element, roots: Roots): KapForms {
  const tilde = stripSep(plainText(kap, { roots, omit: KAP_OMIT, tildeAsMark: true }));
  const txt = stripSep(plainText(kap, { roots, omit: KAP_OMIT }).replace(/\//g, ""));
  const ofcEl = firstChild(kap, "ofc");
  const variants = childElements(kap, "var")
    .map((v) => firstChild(v, "kap"))
    .filter((k): k is Element => !!k)
    .map((k) => kapForms(k, roots));
  return { tilde, txt, norm: txt.toLowerCase(), ofc: ofcEl ? textOf(ofcEl).trim() : null, variants };
}

// ---- structural nodes -----------------------------------------------------

export interface NodeInfo {
  el: Element;
  kind: NodeKind;
  /** Stable key: "san", "san/drv[0]", "san/drv[0]/snc[2]". Independent of mrk. */
  key: string;
  mrk: string | null;
  parent: NodeInfo | null;
  depth: number;
}

/** All structural nodes of an article in document order, with stable path keys. */
export function nodes(art: Element, artKey: string): NodeInfo[] {
  const out: NodeInfo[] = [];
  const root: NodeInfo = { el: art, kind: "art", key: artKey, mrk: null, parent: null, depth: 0 };
  out.push(root);
  walkNodes(art, root, out);
  return out;
}

function walkNodes(el: Element, parent: NodeInfo, out: NodeInfo[]): void {
  const counters: Record<string, number> = {};
  for (const c of el.children) {
    if (c.type !== "element") continue;
    if (NODE_KIND_SET.has(c.name)) {
      const n = (counters[c.name] = (counters[c.name] ?? 0) + 1) - 1;
      const info: NodeInfo = {
        el: c,
        kind: c.name as NodeKind,
        key: `${parent.key}/${c.name}[${n}]`,
        mrk: c.attrs.mrk ?? null,
        parent,
        depth: parent.depth + 1,
      };
      out.push(info);
      walkNodes(c, info, out);
    } else {
      // The DTD forbids structural nodes inside descriptive elements, but the
      // corpus has them (nimb.xml: <snc> inside <dif>). Keep descending with
      // the same parent so they are not lost; their path key still hangs off
      // the nearest enclosing node.
      walkNested(c, parent, out, counters);
    }
  }
}

function walkNested(el: Element, parent: NodeInfo, out: NodeInfo[], counters: Record<string, number>): void {
  for (const c of el.children) {
    if (c.type !== "element") continue;
    if (NODE_KIND_SET.has(c.name)) {
      const n = (counters[c.name] = (counters[c.name] ?? 0) + 1) - 1;
      const info: NodeInfo = {
        el: c, kind: c.name as NodeKind, key: `${parent.key}/${c.name}[${n}]`,
        mrk: c.attrs.mrk ?? null, parent, depth: parent.depth + 1,
      };
      out.push(info);
      walkNodes(c, info, out);
    } else walkNested(c, parent, out, counters);
  }
}

/** The nearest structural node containing an element. */
export function nodeOf(el: Element): Element | null {
  return ancestor(el, (e) => NODE_KIND_SET.has(e.name));
}

// ---- inventory ------------------------------------------------------------

export interface Inventory {
  elements: Record<string, number>;
  attributes: Record<string, number>; // "elem@attr"
  unknownElements: Record<string, number>;
  unknownAttributes: Record<string, number>;
}

export function emptyInventory(): Inventory {
  return { elements: {}, attributes: {}, unknownElements: {}, unknownAttributes: {} };
}

/** Count every element and attribute; flag anything the DTD doesn't declare. */
export function inventory(doc: Document, into: Inventory = emptyInventory()): Inventory {
  const visit = (el: Element) => {
    bump(into.elements, el.name);
    if (!ELEMENT_SET.has(el.name)) bump(into.unknownElements, el.name);
    const declared = ATTRIBUTES[el.name] ?? [];
    for (const a of Object.keys(el.attrs)) {
      bump(into.attributes, `${el.name}@${a}`);
      if (!declared.includes(a)) bump(into.unknownAttributes, `${el.name}@${a}`);
    }
    for (const c of el.children) if (c.type === "element") visit(c);
  };
  visit(doc.root);
  return into;
}

function bump(rec: Record<string, number>, k: string): void {
  rec[k] = (rec[k] ?? 0) + 1;
}

export type { Element, Node, Document };
