#!/usr/bin/env bun
/** Bundles the dictionary Worker and copies the SQLite wasm it loads from beside it. */
import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const args = process.argv.slice(2);
const outputArg = args[0] === "--out" ? args[1] : args[0];
if (args[0] === "--out" && !outputArg) throw new Error("--out requires a file path");
const output = resolve(outputArg ?? "dist/browser/revo-worker.js");
await mkdir(dirname(output), { recursive: true });
const result = await Bun.build({
  entrypoints: ["src/browser/worker-entry.ts"],
  outdir: dirname(output),
  naming: output.slice(dirname(output).length + 1),
  target: "browser",
  minify: true,
  sourcemap: args.includes("--sourcemap") ? "external" : "none",
});
if (!result.success) throw new AggregateError(result.logs, "Could not build the ReVo browser Worker");
await copyFile("node_modules/sqlite-wasm-http/deps/dist/sqlite3.wasm", resolve(dirname(output), "sqlite3.wasm"));
console.log(output);
