/**
 * Where the corpus comes from: the revo-fonto checkout, voko-grundo, and our
 * overlay articles. Only the import reads them; the passes read the articles
 * the database stores (documents.ts articleTrees).
 */
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { listArticles, type ArticleSource } from "voko-xml";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(__dirname, "..", "..");
export const VENDOR = join(ROOT, "vendor");
export const FONTO = join(VENDOR, "revo-fonto");
export const GRUNDO = join(VENDOR, "voko-grundo");
export const OVERLAY = join(ROOT, "corpus", "overlay");

/** `overlay`: the directory merged over the submodule (tests point it at a fixture). */
export function corpusArticles(overlay: string = OVERLAY): ArticleSource[] {
  return listArticles({ fonto: join(FONTO, "revo"), overlay });
}
