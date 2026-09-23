/**
 * Builds everything a browser app serves into one directory, from the checked-out
 * sources and this commit's code:
 *
 *   voko.db, voko.db.zst  the full stage, the database revo-mcp's server reads too
 *   revo-worker.js        the dictionary Worker
 *   sqlite3.wasm          the SQLite build it loads
 *
 * The Worker and the database come from the same commit, so they agree on the
 * schema. Kunirado's image runs this and installs the directory with
 * `pnpm revo:fetch DIR`.
 *
 *   pnpm browser:release --out DIR
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const i = args.indexOf("--out");
if (i < 0 || !args[i + 1]) {
  console.error("Usage: pnpm browser:release --out DIR");
  process.exit(1);
}
const out = resolve(args[i + 1]);

const articles = join(ROOT, "vendor", "revo-fonto", "revo");
if (!existsSync(articles) || readdirSync(articles).length === 0) {
  console.error(`${articles} is empty: check the sources out first (\`pnpm fonto\`)`);
  process.exit(1);
}

function step(script: string, ...rest: string[]): void {
  console.log(`\n$ ${script} ${rest.join(" ")}`);
  const run = spawnSync(process.execPath, ["--import", "tsx", script, ...rest], { cwd: ROOT, stdio: "inherit" });
  if (run.status !== 0) process.exit(run.status ?? 1);
}

mkdirSync(out, { recursive: true });
const t0 = Date.now();
// The parser's tables, from the pinned DTDs; a container build has none yet.
step("scripts/gen-entities.ts");
step("src/corpus/build.ts", "--stage", "full", "--out", join(out, "voko.db"));
step("scripts/build-browser-worker.ts", "--out", join(out, "revo-worker.js"));
console.log(`\n${out}: voko.db, voko.db.zst, revo-worker.js, sqlite3.wasm in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
