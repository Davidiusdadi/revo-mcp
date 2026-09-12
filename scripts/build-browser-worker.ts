#!/usr/bin/env bun
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const args = process.argv.slice(2);
const outputArg = args[0] === "--out" ? args[1] : args[0];
if (args[0] === "--out" && !outputArg) throw new Error("--out requires a file path");
const output = resolve(outputArg ?? "dist/browser/revo-worker.js");
await mkdir(dirname(output), { recursive: true });
const result = await Bun.build({
  entrypoints: ["src/browser/shard-worker-entry.ts"],
  outdir: dirname(output),
  naming: output.slice(dirname(output).length + 1),
  target: "browser",
  minify: true,
  sourcemap: args.includes("--sourcemap") ? "external" : "none",
});
if (!result.success) throw new AggregateError(result.logs, "Could not build the ReVo browser Worker");
console.log(output);
