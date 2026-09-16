/**
 * Fold the surface forms of each source into lemmas with `lemmaOf`:
 * data/freq/lemmas.<source>.tsv (lemma, count, distinct forms), by count.
 *
 *   tsx scripts/freq/lemmatise.ts [--only hplt|tekstaro]
 */
import { createReadStream, existsSync, writeFileSync } from "fs";
import { lemmaOf } from "../../src/morph";
import { formsFile, isMain, lemmasFile, SOURCE_NAMES, type SourceName } from "./paths";

export async function* tsvRows(file: string): AsyncGenerator<string[]> {
  const decoder = new TextDecoder();
  let rest = "";
  for await (const chunk of createReadStream(file)) {
    rest += decoder.decode(chunk, { stream: true });
    let at: number;
    while ((at = rest.indexOf("\n")) >= 0) {
      yield rest.slice(0, at).split("\t");
      rest = rest.slice(at + 1);
    }
  }
  if (rest) yield rest.split("\t");
}

async function main() {
  const only = process.argv.indexOf("--only");
  const sources = only >= 0 ? [process.argv[only + 1] as SourceName] : [...SOURCE_NAMES];
  for (const source of sources) {
    if (!existsSync(formsFile(source))) { console.log(`${source}: no ${formsFile(source)}, skipped`); continue; }
    const lemmas = new Map<string, { n: number; forms: number }>();
    let forms = 0, tokens = 0;
    for await (const [form, count] of tsvRows(formsFile(source))) {
      const n = Number(count);
      const l = lemmaOf(form);
      const e = lemmas.get(l);
      if (e) { e.n += n; e.forms++; } else lemmas.set(l, { n, forms: 1 });
      forms++;
      tokens += n;
    }
    const rows = [...lemmas].sort((a, b) => b[1].n - a[1].n || (a[0] < b[0] ? -1 : 1));
    writeFileSync(lemmasFile(source), rows.map(([l, e]) => `${l}\t${e.n}\t${e.forms}\n`).join(""));
    console.log(`${source}: ${forms} forms → ${lemmas.size} lemmas (${tokens} tokens) → ${lemmasFile(source)}`);
  }
}

if (isMain(import.meta.url)) await main();
