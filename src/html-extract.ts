/**
 * Extracts structured definition and example data from the HTML article blobs
 * stored in the `artikolo` table of the Revo database.
 *
 * The HTML is machine-generated with consistent CSS classes:
 * - <section class="drv"> — derivation sections
 * - <h2 id="mrk"> — derivation headword (ID = nodo.mrk)
 * - <dt id="mrk.sense">N.</dt> — sense number
 * - <span class="dif"> — definition text
 * - <i class="ekz"> — example sentences
 * - <span class="ekztld"> — root word placeholder in examples
 * - <span class="fntref"> — bibliographic references (to strip)
 * - <span class="klr"> — clarifications
 */

import { parse, HTMLElement, TextNode } from "node-html-parser";

const PARSED_CACHE_MAX = 500;
const parsedCache = new Map<string, HTMLElement>();

function getParsedRoot(htmlBlob: Buffer | Uint8Array, cacheKey?: string): HTMLElement {
  if (cacheKey !== undefined) {
    const hit = parsedCache.get(cacheKey);
    if (hit) {
      // refresh insertion order so this entry survives FIFO eviction
      parsedCache.delete(cacheKey);
      parsedCache.set(cacheKey, hit);
      return hit;
    }
  }
  const root = parse(Buffer.from(htmlBlob).toString("utf-8"));
  if (cacheKey !== undefined) {
    if (parsedCache.size >= PARSED_CACHE_MAX) {
      const oldest = parsedCache.keys().next().value;
      if (oldest !== undefined) parsedCache.delete(oldest);
    }
    parsedCache.set(cacheKey, root);
  }
  return root;
}

export interface DrvEntry {
  mrk: string;
  headword: string;
  senses: SenseEntry[];
}

export interface SenseEntry {
  mrk?: string;
  num?: string;
  definition: string;
  examples: string[];
  domain?: string;
}

/**
 * Extract all derivation entries from an article HTML blob.
 */
export function extractArticle(htmlBlob: Buffer | Uint8Array, cacheKey?: string): DrvEntry[] {
  const root = getParsedRoot(htmlBlob, cacheKey);
  const entries: DrvEntry[] = [];

  const drvSections = root.querySelectorAll("section.drv");

  for (const drv of drvSections) {
    const h2 = drv.querySelector("h2");
    if (!h2) continue;

    const mrk = h2.getAttribute("id") ?? "";
    const headword = cleanText(h2.text);

    const senses = extractSenses(drv, mrk);
    entries.push({ mrk, headword, senses });
  }

  return entries;
}

/**
 * Extract a specific derivation entry by its mrk ID.
 */
export function extractByMrk(
  htmlBlob: Buffer | Uint8Array,
  targetMrk: string,
  cacheKey?: string
): DrvEntry | null {
  const root = getParsedRoot(htmlBlob, cacheKey);

  // Try to find the h2 with this exact ID (derivation level)
  const h2 = root.querySelector(`h2[id="${targetMrk}"]`);
  if (h2) {
    const drv = h2.closest("section.drv");
    if (drv) {
      const headword = cleanText(h2.text);
      const senses = extractSenses(drv, targetMrk);
      return { mrk: targetMrk, headword, senses };
    }
  }

  // Maybe it's a sense-level mrk — find the dt with this ID
  const dt = root.querySelector(`dt[id="${targetMrk}"]`);
  if (dt) {
    const drv = dt.closest("section.drv");
    const drvH2 = drv?.querySelector("h2");
    if (drv && drvH2) {
      const drvMrk = drvH2.getAttribute("id") ?? "";
      const headword = cleanText(drvH2.text);
      // Extract just the one sense
      const dd = dt.nextElementSibling;
      if (dd) {
        const sense = extractSenseFromDd(dd, targetMrk, dt.text.trim());
        return { mrk: drvMrk, headword, senses: [sense] };
      }
    }
  }

  return null;
}

function extractSenses(drv: HTMLElement, drvMrk: string): SenseEntry[] {
  const senses: SenseEntry[] = [];

  // Only select <dt> elements that are NOT translation headings (class="lng")
  // Definition <dt> elements have an id attribute or a numeric content like "1.", "2."
  // Translation <dt> elements have class="lng" and contain language names like "angle:"
  const dts = drv.querySelectorAll("dt");
  const defDts = dts.filter(
    (dt) => !dt.classNames.includes("lng")
  );

  if (defDts.length === 0) {
    // No numbered senses — the whole drv is one definition
    // Look for the first <dd> that's NOT a translation
    const dd = drv.querySelector("dd");
    if (dd && !dd.getAttribute("lang")) {
      senses.push(extractSenseFromDd(dd, drvMrk));
    } else {
      // Try to get definition from the drv content directly
      const dif = drv.querySelector("span.dif");
      if (dif) {
        senses.push({
          mrk: drvMrk,
          definition: cleanDefinition(dif),
          examples: extractExamples(dif.parentNode as HTMLElement),
        });
      }
    }
    return senses;
  }

  for (const dt of defDts) {
    const senseMrk = dt.getAttribute("id");
    const num = dt.text.trim();
    const dd = dt.nextElementSibling;
    if (dd && dd.tagName === "DD") {
      senses.push(extractSenseFromDd(dd, senseMrk ?? undefined, num));
    }
  }

  return senses;
}

function extractSenseFromDd(
  dd: HTMLElement,
  mrk?: string,
  num?: string
): SenseEntry {
  const dif = dd.querySelector("span.dif");
  const definition = dif ? cleanDefinition(dif) : "";
  const examples = extractExamples(dd);

  // Check for usage domain
  const uzo = dd.querySelector("abbr.uzo, span.uzo");
  const domain = uzo ? uzo.text.trim() : undefined;

  return { mrk, num, definition, examples, domain };
}

function extractExamples(container: HTMLElement): string[] {
  const examples: string[] = [];
  const ekzElements = container.querySelectorAll("i.ekz");

  for (const ekz of ekzElements) {
    // Clone to avoid mutating the original
    const clone = parse(ekz.outerHTML);
    // Remove bibliographic references
    for (const ref of clone.querySelectorAll("span.fntref, sup.fntref")) {
      ref.remove();
    }
    const text = cleanText(clone.text);
    if (text.length > 0) {
      examples.push(text);
    }
  }

  return examples;
}

function cleanDefinition(dif: HTMLElement): string {
  // Clone to remove refs without mutating
  const clone = parse(dif.outerHTML);
  // Remove bibliographic references
  for (const ref of clone.querySelectorAll("span.fntref, sup.fntref")) {
    ref.remove();
  }
  // Remove nested examples (they'll be extracted separately)
  for (const ekz of clone.querySelectorAll("i.ekz")) {
    ekz.remove();
  }
  return cleanText(clone.text);
}

/**
 * Clean extracted text: collapse whitespace, trim.
 */
function cleanText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export interface ExampleEntry {
  drvMrk: string;
  senseMrk?: string;
  ekzMd: string;
  position: number;
}

/**
 * Walk every <i class="ekz"> element in the article, rendering each to
 * markdown and recording its enclosing derivation + sense context.
 */
export function extractAllExamples(
  htmlBlob: Buffer | Uint8Array,
  cacheKey?: string
): ExampleEntry[] {
  const root = getParsedRoot(htmlBlob, cacheKey);
  const entries: ExampleEntry[] = [];
  let position = 0;

  for (const drv of root.querySelectorAll("section.drv")) {
    const h2 = drv.querySelector("h2");
    const drvMrk = h2?.getAttribute("id");
    if (!drvMrk) continue;

    for (const ekz of drv.querySelectorAll("i.ekz")) {
      const md = ekzToMarkdown(ekz);
      if (md.length === 0) continue;
      entries.push({
        drvMrk,
        senseMrk: findSenseMrk(ekz) ?? undefined,
        ekzMd: md,
        position: position++,
      });
    }
  }

  return entries;
}

function findSenseMrk(ekz: HTMLElement): string | null {
  const dd = ekz.closest("dd");
  if (!dd) return null;
  let prev = dd.previousElementSibling;
  while (prev) {
    if (prev.tagName === "DT") {
      const id = prev.getAttribute("id");
      return id ?? null;
    }
    prev = prev.previousElementSibling;
  }
  return null;
}

function hasClass(el: HTMLElement, cls: string): boolean {
  const names = el.classNames;
  if (!names) return false;
  return names.split(/\s+/).includes(cls);
}

/**
 * Render an <i class="ekz"> element's inner HTML to markdown.
 *
 * Rules (see plan): ekztld → inlined plain (keeps inflected form as one
 * token), nom → **bold**, klr/pr → literal brackets already in text, ref
 * → plain text no link, fnt/fntref → dropped, anything else → text content.
 */
function ekzToMarkdown(ekz: HTMLElement): string {
  const out: string[] = [];
  walkInline(ekz, out);
  return cleanText(out.join(""));
}

function walkInline(node: HTMLElement, out: string[]): void {
  for (const child of node.childNodes) {
    if (child instanceof TextNode) {
      out.push(child.rawText);
      continue;
    }
    if (!(child instanceof HTMLElement)) continue;

    // Drop bibliographic noise entirely
    if (hasClass(child, "fnt") || hasClass(child, "fntref")) continue;

    if (hasClass(child, "nom")) {
      out.push("**");
      walkInline(child, out);
      out.push("**");
      continue;
    }

    // ekztld / klr / pr / ref / any other inline wrapper: just recurse
    walkInline(child, out);
  }
}
