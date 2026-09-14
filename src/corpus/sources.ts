/**
 * Where the corpus comes from: the revo-fonto checkout, voko-grundo, and our
 * overlay articles. The database keeps no copy of the XML, so the passes that
 * need the markup itself (tld-links, morph) read the articles from here, the
 * same files the L2 build read.
 */
import type { Database } from "bun:sqlite";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { listArticles, readArticle, articleOf, type ArticleSource, type Element } from "voko-xml";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(__dirname, "..", "..");
export const VENDOR = join(ROOT, "vendor");
export const FONTO = join(VENDOR, "revo-fonto");
export const GRUNDO = join(VENDOR, "voko-grundo");
export const OVERLAY = join(ROOT, "corpus", "overlay");

export function corpusArticles(): ArticleSource[] {
  return listArticles({ fonto: join(FONTO, "revo"), overlay: OVERLAY });
}

/**
 * The `<art>` element of every article the database holds, in `art.id` order.
 * A database built with `--limit` holds a slice, so the rows lead and the
 * files follow; a row whose file is gone means the sources moved on since the
 * build, and the pass must not guess.
 */
export function* articlesOf(db: Database): Generator<{ id: number; file: string; art: Element }> {
  const byKey = new Map(corpusArticles().map((a) => [a.key, a]));
  for (const row of db.query<{ id: number; file: string; source: string }, []>(
    "SELECT id, file, source FROM art ORDER BY id").iterate()) {
    const src = byKey.get(row.file);
    if (!src || src.source !== row.source) {
      throw new Error(`${row.file}: the article the database was built from is not in the sources any more; rebuild`);
    }
    yield { id: row.id, file: row.file, art: articleOf(readArticle(src)) };
  }
}
