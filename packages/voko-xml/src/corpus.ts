/**
 * Locating and loading articles: the revo-fonto checkout plus an overlay
 * directory of our own articles in the same dialect. Overlay files replace or
 * add articles by file name.
 */
import { readdirSync, readFileSync, existsSync } from "fs";
import { join, basename } from "path";
import { parse, type Document } from "./dom";

export interface ArticleSource {
  /** Article key = file name without `.xml` ("san"). */
  key: string;
  path: string;
  source: "fonto" | "overlay";
}

export interface CorpusPaths {
  /** Directory holding revo-fonto's `revo/*.xml`. */
  fonto: string;
  /** Optional directory of overlay articles. */
  overlay?: string;
}

export function listArticles(paths: CorpusPaths): ArticleSource[] {
  const byKey = new Map<string, ArticleSource>();
  for (const f of xmlFiles(paths.fonto)) {
    byKey.set(keyOf(f), { key: keyOf(f), path: join(paths.fonto, f), source: "fonto" });
  }
  if (paths.overlay && existsSync(paths.overlay)) {
    for (const f of xmlFiles(paths.overlay)) {
      byKey.set(keyOf(f), { key: keyOf(f), path: join(paths.overlay, f), source: "overlay" });
    }
  }
  return [...byKey.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

export function readArticle(src: ArticleSource): Document {
  const doc = parse(readFileSync(src.path, "utf8"), src.path);
  doc.file = src.path;
  return doc;
}

function xmlFiles(dir: string): string[] {
  return readdirSync(dir).filter((f) => f.endsWith(".xml")).sort();
}
function keyOf(f: string): string {
  return basename(f, ".xml");
}
