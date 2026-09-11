import { join, dirname } from "path";
import { fileURLToPath } from "url";
const here = dirname(fileURLToPath(import.meta.url));
export const REPO = join(here, "..", "..", "..");
export const FONTO = join(REPO, "vendor", "revo-fonto", "revo");
export const OVERLAY = join(REPO, "corpus", "overlay");
