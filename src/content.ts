/**
 * What an article's descriptive elements say, read off its tree the one way
 * the build's passes and the runtime's entries share.
 *
 * The content of a structural node (art, subart, drv, subdrv, snc, subsnc) is
 * the elements inside it up to the nodes nested in it. Every one has an owner,
 * the element it is part of: the node itself, or the nearest dif, ekz, rim,
 * trd, ref, bld, klr, ke, mrk, kap or var around it. A <trd> takes its
 * language from its lng, else from the <trdgrp> around it; a <ref> its type
 * from its tip, else from the <refgrp> ("vid" when that has none). An owner in
 * between ends the group. Citations, usage tags and the other LEAVES are
 * content, but what is inside them is not.
 *
 * Only reading trees: no parser and no database, so a browser Worker uses it
 * as the build does.
 */

import {
  NODE_KIND_SET, childElements, firstChild, nodes, plainText,
  type Element, type Node, type Roots,
} from "voko-xml/view";

/** Content whose inside does not count: what a citation or a usage tag holds is theirs alone. */
const LEAVES: ReadonlySet<string> = new Set(["fnt", "uzo", "gra", "mlg", "tezrad", "lstref", "adm", "sncref"]);
/** Elements that own what is inside them; kap and var own theirs too (see headword()). */
const OWNERS: ReadonlySet<string> = new Set(["dif", "ekz", "rim", "trd", "ref", "bld", "klr", "ke", "mrk"]);
/** The elements contentOf lists. */
const LISTED: ReadonlySet<string> = new Set(["kap", "dif", "ekz", "rim", "trd", "ref", "bld", ...LEAVES]);

export interface Content {
  el: Element;
  /** the structural node it is content of */
  node: Element;
  /** what it is part of: "node", or the element name of dif, ekz, rim, trd, ref, bld, klr, ke, mrk, kap, var */
  owner: string;
  /** for a variant headword (<kap><var><kap>), the headword it is a variant of */
  main?: Element;
  /** a <trd>'s language */
  lng?: string;
  /** a <ref>'s type */
  tip?: string | null;
}

interface Context {
  node: Element;
  owner: string;
  grpLng: string | null;
  grpTip: string | null;
}

const ownedBy = (ctx: Context, owner: string): Context => ({ node: ctx.node, owner, grpLng: null, grpTip: null });

/**
 * The listed content of one node, in reading order, except that a headword's
 * variants follow the headword before anything else inside its <var>.
 */
export function* contentOf(node: Element): Generator<Content> {
  yield* inside(node, { node, owner: "node", grpLng: null, grpTip: null });
}

/** Every node of a subtree in document order, each with its content: the order the passes write rows in. */
export function* nodesWithContent(root: Element): Generator<{ el: Element; parent: Element | null; content: Content[] }> {
  for (const info of nodes(root, "")) {
    yield { el: info.el, parent: info.parent?.el ?? null, content: [...contentOf(info.el)] };
  }
}

function* inside(el: Element, ctx: Context): Generator<Content> {
  for (const c of el.children) if (c.type === "element" && !NODE_KIND_SET.has(c.name)) yield* element(c, ctx);
}

function* element(el: Element, ctx: Context): Generator<Content> {
  switch (el.name) {
    case "kap":
      yield* headword(el, ctx);
      return;
    case "trdgrp":
      yield* inside(el, { ...ctx, grpLng: el.attrs.lng ?? null });
      return;
    case "refgrp":
      yield* inside(el, { ...ctx, grpTip: el.attrs.tip ?? "vid" });
      return;
    case "trd":
      yield { el, node: ctx.node, owner: ctx.owner, lng: el.attrs.lng ?? ctx.grpLng ?? "" };
      break;
    case "ref":
      yield { el, node: ctx.node, owner: ctx.owner, tip: el.attrs.tip ?? ctx.grpTip ?? null };
      break;
    default:
      if (LISTED.has(el.name)) yield { el, node: ctx.node, owner: ctx.owner };
  }
  if (LEAVES.has(el.name)) return;
  // A <trd> is not a leaf either: the DTD lets its <klr> hold trd, trdgrp, ekz
  // and ref, which ReVo uses to gloss a translation in a third language (`unu`
  // has Finnish inside a Spanish trd). The language then comes from the nested
  // <trdgrp>, as the owner ends the outer group.
  yield* inside(el, OWNERS.has(el.name) ? ownedBy(ctx, el.name) : ctx);
}

function* headword(kap: Element, ctx: Context, main?: Element): Generator<Content> {
  yield main ? { el: kap, node: ctx.node, owner: ctx.owner, main } : { el: kap, node: ctx.node, owner: ctx.owner };
  for (const c of kap.children) {
    if (c.type !== "element") continue;
    if (c.name === "var") {
      const variant = firstChild(c, "kap");
      if (variant) yield* headword(variant, ctx, kap);
      for (const v of c.children) if (v.type === "element" && v !== variant) yield* element(v, ownedBy(ctx, "var"));
    } else if (c.name !== "rad" && c.name !== "ofc" && c.name !== "tld") {
      yield* element(c, ownedBy(ctx, "kap"));
    }
  }
}

/** What an element's text leaves out, by the element. */
export const OMIT = {
  // a lone <trd> inside <dif> is running text (mostly Latin names: "(Canis)");
  // a <trdgrp> there is an appended translation list
  dif: new Set(["fnt", "ekz", "trdgrp"]),
  ekz: new Set(["fnt", "trd", "trdgrp", "uzo"]),
  rim: new Set(["fnt", "ekz"]),
  trd: new Set(["klr", "pr", "baz", "ofc"]),
  plain: new Set(["fnt"]),
} satisfies Record<string, ReadonlySet<string>>;

/** An element's plain text: tildes expanded, `omit` left out, whitespace collapsed. */
export function textIn(el: Element, roots: Roots, omit: ReadonlySet<string> = OMIT.plain): string {
  return plainText(el, { roots, omit });
}

/**
 * A piece of a translation: its text, or one of its <klr> notes. A note's tip
 * says which list ReVo shows it in (revo_trd.xsl, inx_eltiro.xsl): none, the
 * article's, where the sense is in view; "ind", the index's, where it is not
 * ("worker (bee)"); "amb", both.
 */
export type TranslationPart = string | { klr: string; tip?: "ind" | "amb" };

const NOTE_OPEN = "\uE000";
const NOTE_CLOSE = "\uE001";
const OMIT_TRD_NOT_KLR: ReadonlySet<string> = new Set([...OMIT.trd].filter((name) => name !== "klr"));

/**
 * A translation with its notes where they stand, or null when it has none:
 * "<klr>(sich)</klr> verabschieden" is [{ klr: "(sich)" }, " verabschieden"].
 * Each piece keeps the whitespace around it, so the text pieces joined and
 * collapsed are the translation without notes (its `txt`), and any choice of
 * notes put back reads as ReVo writes it. A note inside a note is its text.
 */
export function translationParts(trd: Element, roots: Roots): TranslationPart[] | null {
  const tips: ("ind" | "amb" | undefined)[] = [];
  const marked = (el: Element): Element => ({
    ...el,
    children: el.children.flatMap((c): Node[] => {
      if (c.type !== "element" || OMIT_TRD_NOT_KLR.has(c.name)) return [c];
      if (c.name !== "klr") return [marked(c)];
      const tip = c.attrs.tip;
      tips.push(tip === "ind" || tip === "amb" ? tip : undefined);
      return [{ type: "text", value: NOTE_OPEN }, c, { type: "text", value: NOTE_CLOSE }];
    }),
  });
  const text = plainText(marked(trd), { roots, omit: OMIT_TRD_NOT_KLR });
  if (tips.length === 0) return null;
  const [head, ...rest] = text.split(NOTE_OPEN);
  const parts: TranslationPart[] = head ? [head] : [];
  rest.forEach((piece, i) => {
    const [note, after] = piece.split(NOTE_CLOSE);
    parts.push(tips[i] ? { klr: note, tip: tips[i] } : { klr: note });
    if (after) parts.push(after);
  });
  return parts;
}

/** The text of an element's `name` children, joined; null when it has none. */
export function childText(el: Element, name: string, roots: Roots): string | null {
  const parts = childElements(el, name).map((c) => textIn(c, roots));
  return parts.length ? parts.join(" ") : null;
}

/**
 * An article's roots from what the database keeps of them: the main root, and
 * the text of every `<rad var>` in the article, a later one of a variant
 * replacing an earlier. The build checks this equals rootsOf() for every
 * article (passes/structure.ts).
 */
export function rootsFrom(rad: string, variants: { var: string; txt: string | null }[]): Roots {
  const roots: Roots = { rad, byVar: {} };
  for (const v of variants) roots.byVar[v.var] = (v.txt ?? "").trim();
  return roots;
}

/** Whether text under an element can need a variant root: a `<tld var>` in it. */
export function usesVariantRoots(el: Element): boolean {
  for (const c of el.children) {
    if (c.type !== "element") continue;
    if ((c.name === "tld" && c.attrs.var !== undefined) || usesVariantRoots(c)) return true;
  }
  return false;
}

/**
 * Whether a <dif> is the Esperanto definition: one without lng, or lng="eo".
 * One in another language (<dif lng="de">) translates it, and the passes that
 * read Esperanto (search, attested forms, tilde links) leave it out.
 */
export const inEsperanto = (dif: Element): boolean => (dif.attrs.lng ?? "eo") === "eo";

/** A sense's definition in another language, with where it came from if it says (<dif lng fnt>). */
export interface ForeignDefinition {
  lng: string;
  txt: string;
  fnt?: string;
}

/** One sense of a derivation, as `lookup` renders it under a headword. */
export interface SenseEntry {
  mrk?: string;
  num?: string;
  /** in Esperanto */
  definition: string;
  /** the definition in other languages, when the article gives it */
  definitions?: ForeignDefinition[];
  examples: string[];
  domain?: string;
}

export interface EntryContent {
  senses: SenseEntry[];
  /** The element each sense is read from, in the same order: what a translation under it translates. */
  senseNodes: Element[];
  /** every reference in the entry, the derivation's own first, then its senses' in reading order */
  crossRefs: { target: string; type: string }[];
  /** the fak and stl tags outside examples, once each, in the same order */
  usageDomains: string[];
}

/**
 * What an entry shows, from its derivation's tree.
 *
 * Senses are in document order, numbered as ReVo renders them: snc "1." "2."
 * (unnumbered when alone), subsnc "a)" "b)", subdrv "A." "B.". A sense has its
 * own definitions and examples, not those of the senses inside it. With no
 * Esperanto <dif>, a sense defined by reference reads "= X" (<ref tip="dif">X</ref>).
 */
export function entryContent(drv: Element, roots: Roots): EntryContent {
  const [own, ...below] = [...nodesWithContent(drv)];

  const senseAt = (content: Content[], mrk: string | undefined): SenseEntry => {
    const of = (name: string) => content.filter((c) => c.el.name === name);
    const difs = of("dif");
    let definition = difs.filter((c) => inEsperanto(c.el)).map((c) => textIn(c.el, roots, OMIT.dif)).join(" ");
    const refs = of("ref").filter((c) => c.owner === "node" && c.tip === "dif");
    if (!definition && refs.length > 0) definition = `= ${refs.map((c) => textIn(c.el, roots)).join(", ")}`;
    const sense: SenseEntry = {
      mrk,
      definition,
      examples: of("ekz").map((c) => textIn(c.el, roots, OMIT.ekz)).filter((t) => t.length > 0),
    };
    const foreign = difs.filter((c) => !inEsperanto(c.el)).map((c): ForeignDefinition => {
      const d: ForeignDefinition = { lng: c.el.attrs.lng!, txt: textIn(c.el, roots, OMIT.dif) };
      if (c.el.attrs.fnt) d.fnt = c.el.attrs.fnt;
      return d;
    });
    if (foreign.length > 0) sense.definitions = foreign;
    const domains = of("uzo").filter((c) => c.owner === "node" && c.el.attrs.tip === "fak").map((c) => textIn(c.el, roots));
    if (domains.length > 0) sense.domain = domains.join(", ");
    return sense;
  };

  const siblings = new Map<Element | null, Map<string, number>>();
  for (const n of below) {
    const counts = siblings.get(n.parent) ?? new Map<string, number>();
    counts.set(n.el.name, (counts.get(n.el.name) ?? 0) + 1);
    siblings.set(n.parent, counts);
  }
  const seen = new Map<Element | null, Map<string, number>>();

  const senses: SenseEntry[] = [];
  const senseNodes: Element[] = [];
  const first = senseAt(own.content, drv.attrs.mrk);
  if (first.definition || first.examples.length > 0 || below.length === 0) {
    senses.push(first);
    senseNodes.push(own.el);
  }
  for (const n of below) {
    const counts = seen.get(n.parent) ?? new Map<string, number>();
    const i = counts.get(n.el.name) ?? 0;
    counts.set(n.el.name, i + 1);
    seen.set(n.parent, counts);
    const num =
      n.el.name === "subsnc" ? `${String.fromCharCode(97 + i)})`
      : n.el.name === "subdrv" ? `${String.fromCharCode(65 + i)}.`
      : siblings.get(n.parent)!.get(n.el.name)! > 1 ? `${i + 1}.` : "";
    const sense = senseAt(n.content, n.el.attrs.mrk);
    sense.num = num;
    senses.push(sense);
    senseNodes.push(n.el);
  }

  const all = [own, ...below].flatMap((n) => n.content);
  const usageDomains = new Set(all
    .filter((c) => c.el.name === "uzo" && (c.el.attrs.tip === "fak" || c.el.attrs.tip === "stl") && c.owner !== "ekz")
    .map((c) => textIn(c.el, roots)));
  return {
    senses,
    senseNodes,
    crossRefs: all.filter((c) => c.el.name === "ref").map((c) => ({ target: c.el.attrs.cel ?? "", type: c.tip ?? "" })),
    usageDomains: [...usageDomains],
  };
}
