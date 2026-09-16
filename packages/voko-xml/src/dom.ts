/**
 * The parser (saxes) and serializer for one VOKO article, over the generic,
 * lossless document tree of tree.ts. Everything the source has is kept:
 * prolog, doctype, comments, attribute order, mixed content order, whitespace
 * text. The typed VOKO view (`model.ts`, `walk.ts`) is built on top of this
 * and never copies data out, so losslessness holds by construction.
 */
import { SaxesParser } from "saxes";
import { substituteEntities, entityFor } from "./entities";
import type { Document, Element, Node } from "./tree";

export * from "./tree";

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
