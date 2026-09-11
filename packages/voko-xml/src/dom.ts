/**
 * Generic, lossless XML document model for one VOKO article, plus the parser
 * (saxes) and serializer. Everything the source has is kept: prolog, doctype,
 * comments, attribute order, mixed content order, whitespace text. The typed
 * VOKO view (`model.ts`, `walk.ts`) is built on top of this and never copies
 * data out, so losslessness holds by construction.
 */
import { SaxesParser } from "saxes";
import { substituteEntities, entityFor } from "./entities";

export interface TextNode {
  type: "text";
  value: string;
}
export interface CommentNode {
  type: "comment";
  value: string;
}
export interface Element {
  type: "element";
  name: string;
  attrs: Record<string, string>;
  children: Node[];
  /** Set by the parser: `<tld/>` vs `<tld></tld>` — kept for byte-faithful serialization. */
  selfClosing: boolean;
  parent: Element | null;
}
export type Node = TextNode | CommentNode | Element;

export interface Document {
  /** e.g. `version="1.0"`; null if the file had no XML declaration. */
  xmlDecl: string | null;
  /** Raw doctype content between `<!DOCTYPE ` and `>`. */
  doctype: string | null;
  /** Comments before/after the root element, in order (position: before|after). */
  prolog: { comment: string; position: "before" | "after" }[];
  root: Element;
  file?: string;
}

export class VokoParseError extends Error {
  constructor(message: string, public readonly file?: string) {
    super(file ? `${file}: ${message}` : message);
  }
}

export function parse(source: string, file?: string): Document {
  const text = substituteEntities(source, file);
  const parser = new SaxesParser({ position: true, fileName: file });

  let xmlDecl: string | null = null;
  let doctype: string | null = null;
  const prolog: Document["prolog"] = [];
  let root: Element | null = null;
  const stack: Element[] = [];
  let error: Error | null = null;

  parser.on("xmldecl", (d) => {
    const parts: string[] = [];
    if (d.version !== undefined) parts.push(`version="${d.version}"`);
    if (d.encoding !== undefined) parts.push(`encoding="${d.encoding}"`);
    if (d.standalone !== undefined) parts.push(`standalone="${d.standalone}"`);
    xmlDecl = parts.join(" ");
  });
  parser.on("doctype", (d) => {
    doctype = d.trim();
  });
  parser.on("comment", (c) => {
    const top = stack[stack.length - 1];
    if (top) top.children.push({ type: "comment", value: c });
    else prolog.push({ comment: c, position: root ? "after" : "before" });
  });
  parser.on("text", (t) => {
    const top = stack[stack.length - 1];
    if (top) top.children.push({ type: "text", value: t });
    // Whitespace outside the root element carries no information; drop it.
  });
  parser.on("opentag", (tag) => {
    const el: Element = {
      type: "element",
      name: tag.name,
      attrs: { ...(tag.attributes as Record<string, string>) },
      children: [],
      selfClosing: tag.isSelfClosing,
      parent: stack[stack.length - 1] ?? null,
    };
    if (el.parent) el.parent.children.push(el);
    else if (root) error = new VokoParseError("multiple root elements", file);
    else root = el;
    stack.push(el);
  });
  parser.on("closetag", () => {
    stack.pop();
  });
  parser.on("error", (e) => {
    if (!error) error = new VokoParseError(e.message, file);
  });

  parser.write(text).close();
  if (error) throw error;
  if (!root) throw new VokoParseError("no root element", file);
  return { xmlDecl, doctype, prolog, root, file };
}

export interface SerializeOptions {
  /**
   * `unicode` (default): write characters literally, escaping only `& < > "`.
   * `entities`: re-encode characters that have a named entity (&ccirc; …) the
   * way the source files do — closest to upstream's editing style, useful when
   * writing files back for a PR.
   */
  encode?: "unicode" | "entities";
}

export function serialize(doc: Document, opts: SerializeOptions = {}): string {
  const out: string[] = [];
  if (doc.xmlDecl !== null) out.push(`<?xml ${doc.xmlDecl}?>\n`);
  if (doc.doctype !== null) out.push(`<!DOCTYPE ${doc.doctype}>\n`);
  for (const p of doc.prolog) if (p.position === "before") out.push(`<!--${p.comment}-->\n`);
  serializeNode(doc.root, out, opts.encode ?? "unicode");
  out.push("\n");
  for (const p of doc.prolog) if (p.position === "after") out.push(`<!--${p.comment}-->\n`);
  return out.join("");
}

export function serializeNode(node: Node, out: string[], encode: "unicode" | "entities"): void {
  switch (node.type) {
    case "text":
      out.push(escapeText(node.value, encode));
      return;
    case "comment":
      out.push(`<!--${node.value}-->`);
      return;
    case "element": {
      out.push(`<${node.name}`);
      for (const [k, v] of Object.entries(node.attrs)) {
        out.push(` ${k}="${escapeAttr(v, encode)}"`);
      }
      if (node.children.length === 0 && node.selfClosing) {
        out.push("/>");
        return;
      }
      out.push(">");
      for (const c of node.children) serializeNode(c, out, encode);
      out.push(`</${node.name}>`);
    }
  }
}

/** Serialize an element's children only (the "inner XML" fragment). */
export function innerXml(el: Element, encode: "unicode" | "entities" = "unicode"): string {
  const out: string[] = [];
  for (const c of el.children) serializeNode(c, out, encode);
  return out.join("");
}

/** Serialize an element including its own tag (the "outer XML" fragment). */
export function outerXml(el: Element, encode: "unicode" | "entities" = "unicode"): string {
  const out: string[] = [];
  serializeNode(el, out, encode);
  return out.join("");
}

function escapeText(s: string, encode: "unicode" | "entities"): string {
  let r = s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  if (encode === "entities") r = encodeNamed(r);
  return r;
}
function escapeAttr(s: string, encode: "unicode" | "entities"): string {
  let r = s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
  if (encode === "entities") r = encodeNamed(r);
  return r;
}
function encodeNamed(s: string): string {
  let r = "";
  for (const ch of s) {
    if (ch.charCodeAt(0) < 128) {
      r += ch;
      continue;
    }
    const name = entityFor(ch);
    r += name ? `&${name};` : ch;
  }
  return r;
}

// ---- small DOM helpers used by the typed layer ---------------------------

export function isElement(n: Node): n is Element {
  return n.type === "element";
}

export function childElements(el: Element, name?: string): Element[] {
  const r: Element[] = [];
  for (const c of el.children) if (c.type === "element" && (!name || c.name === name)) r.push(c);
  return r;
}

export function firstChild(el: Element, name: string): Element | undefined {
  for (const c of el.children) if (c.type === "element" && c.name === name) return c;
  return undefined;
}

/** Depth-first walk over all descendant elements (document order). */
export function* descendants(el: Element, name?: string): Generator<Element> {
  for (const c of el.children) {
    if (c.type !== "element") continue;
    if (!name || c.name === name) yield c;
    yield* descendants(c, name);
  }
}

export function ancestor(el: Element, pred: (e: Element) => boolean): Element | null {
  let p = el.parent;
  while (p) {
    if (pred(p)) return p;
    p = p.parent;
  }
  return null;
}

/** Deep structural equality, ignoring `parent` back-links. Used by the round-trip test. */
export function domEqual(a: Node, b: Node): boolean {
  if (a.type !== b.type) return false;
  if (a.type !== "element" || b.type !== "element") return (a as TextNode).value === (b as TextNode).value;
  if (a.name !== b.name) return false;
  const ak = Object.keys(a.attrs), bk = Object.keys(b.attrs);
  if (ak.length !== bk.length) return false;
  for (const k of ak) if (a.attrs[k] !== b.attrs[k]) return false;
  const ac = normalizeText(a.children), bc = normalizeText(b.children);
  if (ac.length !== bc.length) return false;
  for (let i = 0; i < ac.length; i++) if (!domEqual(ac[i], bc[i])) return false;
  return true;
}

/** Merge adjacent text nodes (a parser may split text at entity/char-ref boundaries). */
function normalizeText(children: Node[]): Node[] {
  const out: Node[] = [];
  for (const c of children) {
    const last = out[out.length - 1];
    if (c.type === "text" && last && last.type === "text") {
      out[out.length - 1] = { type: "text", value: last.value + c.value };
    } else out.push(c);
  }
  return out;
}
