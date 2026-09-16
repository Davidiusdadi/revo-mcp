/**
 * The document tree itself: node types and the helpers that walk them. No
 * parser and no file access, so code that only reads trees (a browser Worker
 * rebuilding articles from a database) can import it through `voko-xml/view`
 * without bundling saxes.
 */

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
