/**
 * Count surface forms per source: data/freq/forms.<source>.tsv (form, count),
 * sorted by count, and the totals in data/freq/totals.json.
 *
 * A token is a run of letters of the lowercased text, hyphens and apostrophes
 * included (`s-ro`, `l'`). Letters glued to a digit (`5-an`, `10a`) are
 * dropped. An elided noun or article gets its ending back (`kor'` → koro,
 * `l'` → la). A hyphenated word whose parts are all words of their own is
 * counted as those parts (`Esperanto-movado`), one with a single-letter part
 * as a whole (`s-ro`, `k-to`). A token written in the x-system (`cx`, `ux` …)
 * is converted, since `x` is not an Esperanto letter. A token with a letter
 * outside the Esperanto alphabet is `foreign`: counted in the totals, left
 * out of the forms file.
 *
 * - hplt: the `text` of every document of the .jsonl.zst, line by line; only
 *   the lines `seg_langs` labels epo_Latn are kept.
 * - tekstaro: the <text> of every TEI file; elements marked in another
 *   language (xml:lang other than "" or "eo") are left out, and so is the
 *   reformed-Esperanto material; the `_` morpheme boundaries are removed.
 *
 *   bun run scripts/freq/count-forms.ts [--only hplt|tekstaro]
 */
import { existsSync, mkdirSync, readdirSync } from "fs";
import { join } from "path";
import { fromXSystem, hasXSystem } from "../../src/stemmer";
import { FREQ, formsFile, TOTALS_FILE, SOURCE_NAMES, type SourceName } from "./paths";

const HPLT_FILE = join(FREQ, "sources", "hplt", "1.jsonl.zst");
const TEKSTARO_DIR = join(FREQ, "sources", "tekstaro", "xml", "tekstaro_de_esperanto_xml_kun_streketoj", "tekstoj");

const ESPERANTO = /^[abcĉdefgĝhĥiĵjklmnoprsŝtuŭvz]+(?:-[abcĉdefgĝhĥiĵjklmnoprsŝtuŭvz]+)*$/u;
const TOKEN = /[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*['’]?/gu;

export interface Totals {
  documents: number;
  /** lines of text read, and how many were kept (hplt: labelled Esperanto) */
  lines: number;
  kept: number;
  tokens: number;
  esperanto: number;
  foreign: number;
  /** letters glued to a digit, dropped */
  numeric: number;
  xsystem: number;
  types: number;
}

export class Counter {
  readonly counts = new Map<string, number>();
  readonly totals: Totals = { documents: 0, lines: 0, kept: 0, tokens: 0, esperanto: 0, foreign: 0, numeric: 0, xsystem: 0, types: 0 };

  add(text: string) {
    const t = this.totals;
    for (const m of text.toLowerCase().matchAll(TOKEN)) {
      let w = m[0];
      t.tokens++;
      if (/\p{N}/u.test(w)) { t.numeric++; continue; }
      if (/['’]$/.test(w)) w = w === "l'" || w === "l’" ? "la" : w.slice(0, -1) + "o";
      if (hasXSystem(w)) { w = fromXSystem(w); t.xsystem++; }
      if (/['’]/.test(w)) { t.foreign++; continue; } // an apostrophe inside a word is not Esperanto (don't)
      const parts = w.split("-");
      if (parts.length > 1 && parts.every((p) => p.length >= 2)) { for (const p of parts) this.count(p); continue; }
      this.count(w);
    }
  }

  private count(w: string) {
    const t = this.totals;
    if (!ESPERANTO.test(w)) { t.foreign++; return; }
    t.esperanto++;
    this.counts.set(w, (this.counts.get(w) ?? 0) + 1);
  }

  async write(source: SourceName) {
    this.totals.types = this.counts.size;
    const rows = [...this.counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    await Bun.write(formsFile(source), rows.map(([w, n]) => `${w}\t${n}\n`).join(""));
  }
}

async function* lines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let rest = "";
  for await (const chunk of stream) {
    rest += decoder.decode(chunk, { stream: true });
    let at: number;
    while ((at = rest.indexOf("\n")) >= 0) {
      yield rest.slice(0, at);
      rest = rest.slice(at + 1);
    }
  }
  rest += decoder.decode();
  if (rest) yield rest;
}

async function countHplt(c: Counter) {
  const proc = Bun.spawn(["zstd", "-dc", HPLT_FILE], { stdout: "pipe", stderr: "inherit" });
  const t = c.totals;
  for await (const line of lines(proc.stdout)) {
    if (!line) continue;
    const doc = JSON.parse(line) as { text: string; seg_langs?: string[] };
    t.documents++;
    const segs = doc.text.split("\n");
    for (let i = 0; i < segs.length; i++) {
      t.lines++;
      if (doc.seg_langs && doc.seg_langs[i] !== "epo_Latn") continue;
      t.kept++;
      c.add(segs[i]);
    }
    if (t.documents % 50000 === 0) console.log(`  ${t.documents} documents, ${t.esperanto} Esperanto tokens, ${c.counts.size} types`);
  }
  if ((await proc.exited) !== 0) throw new Error(`zstd exited with ${proc.exitCode}`);
}

/** Elements that sit inside a run of text: their tags are dropped, every other tag counts as a space. */
const INLINE = new Set(["hi", "emph", "m", "abbr", "name", "foreign", "mentioned", "s", "span", "quote", "num", "title", "ref", "term", "gloss", "seg", "date", "idno", "w"]);
/** Elements whose text is not running Esperanto prose. */
const SKIP = new Set(["idno", "ptr", "desc"]);
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const decode = (s: string) => s.replace(/&(#x([0-9a-fA-F]+)|#([0-9]+)|[a-z]+);/g,
  (m, name, hex, dec) => hex ? String.fromCodePoint(parseInt(hex, 16)) : dec ? String.fromCodePoint(Number(dec)) : ENTITIES[name] ?? m);

/** The prose of one TEI file: the <text> without the parts in other languages, tags as spaces, `_` removed. */
export function tekstaroText(xml: string): string {
  const start = xml.search(/<text[\s>]/), end = xml.lastIndexOf("</text>");
  if (start < 0 || end < 0) throw new Error("no <text> element");
  const body = xml.slice(start, end);
  const out: string[] = [];
  const stack: { name: string; skip: boolean }[] = [{ name: "", skip: false }];
  for (const m of body.matchAll(/<\/([a-zA-Z]+)\s*>|<([a-zA-Z]+)((?:\s[^>]*?)?)(\/?)>|<!--[\s\S]*?-->|([^<]+)/g)) {
    const [, close, open, attrs, selfClosing, text] = m;
    const top = stack[stack.length - 1];
    if (text !== undefined) {
      if (!top.skip) out.push(decode(text));
    } else if (close) {
      let i = stack.length - 1;
      while (i > 0 && stack[i].name !== close) i--;
      if (i > 0) stack.length = i;
      if (!INLINE.has(close)) out.push(" ");
    } else if (open) {
      const lang = /xml:lang="([^"]*)"/.exec(attrs)?.[1];
      const skip = top.skip || SKIP.has(open) || (lang !== undefined && lang !== "" && lang !== "eo");
      if (!selfClosing) stack.push({ name: open, skip });
      if (!INLINE.has(open)) out.push(" ");
    }
  }
  return out.join("").replace(/_/g, "");
}

async function countTekstaro(c: Counter) {
  const files = readdirSync(TEKSTARO_DIR).filter((f) => f.endsWith(".xml")).sort();
  for (const f of files) {
    const text = tekstaroText(await Bun.file(join(TEKSTARO_DIR, f)).text());
    c.totals.documents++;
    c.totals.lines++;
    c.totals.kept++;
    c.add(text);
  }
  console.log(`  ${files.length} texts, ${c.totals.esperanto} Esperanto tokens, ${c.counts.size} types`);
}

async function main() {
  const only = process.argv.indexOf("--only");
  const sources = only >= 0 ? [process.argv[only + 1] as SourceName] : [...SOURCE_NAMES];
  mkdirSync(FREQ, { recursive: true });
  const totals: Partial<Record<SourceName, Totals>> = existsSync(TOTALS_FILE) ? JSON.parse(await Bun.file(TOTALS_FILE).text()) : {};
  for (const source of sources) {
    if (!SOURCE_NAMES.includes(source)) throw new Error(`unknown source ${source}`);
    console.log(`${source}`);
    const started = Date.now();
    const c = new Counter();
    await (source === "hplt" ? countHplt(c) : countTekstaro(c));
    await c.write(source);
    totals[source] = c.totals;
    await Bun.write(TOTALS_FILE, JSON.stringify(totals, null, 2) + "\n");
    console.log(`  ${JSON.stringify(c.totals)} in ${((Date.now() - started) / 1000).toFixed(1)}s → ${formsFile(source)}`);
  }
}

if (import.meta.main) await main();
