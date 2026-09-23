/** Builds the dictionary Worker into one file and copies the SQLite wasm it loads from beside it. */
import { build } from "esbuild";
import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const args = process.argv.slice(2);
const outputArg = args[0] === "--out" ? args[1] : args[0];
if (args[0] === "--out" && !outputArg) throw new Error("--out requires a file path");
const output = resolve(outputArg ?? "dist/browser/revo-worker.js");
await mkdir(dirname(output), { recursive: true });
// Throws, with the messages already logged, when the build fails. The
// `new URL("sqlite3.wasm", import.meta.url)` and `new Worker(new URL(…))` in
// the SQLite packages stay as they are and resolve beside the output at run time.
await build({
  entryPoints: ["src/browser/worker-entry.ts"],
  outfile: output,
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: true,
  sourcemap: args.includes("--sourcemap") ? "external" : false,
  logLevel: "warning",
});
await copyFile("node_modules/@sqlite.org/sqlite-wasm/dist/sqlite3.wasm", resolve(dirname(output), "sqlite3.wasm"));
console.log(output);
