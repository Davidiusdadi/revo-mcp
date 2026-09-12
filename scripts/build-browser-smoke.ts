#!/usr/bin/env bun
import { copyFile, cp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const output = resolve(process.argv[2] ?? "dist/browser-smoke");
const dictionary = resolve(process.argv[3] ?? "dist/dictionary");
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

for (const [entrypoint, naming] of [
  ["src/browser/worker-entry.ts", "worker-entry.js"],
  ["test/browser/main.ts", "main.js"],
] as const) {
  const result = await Bun.build({ entrypoints: [entrypoint], outdir: output, target: "browser", naming });
  if (!result.success) throw new AggregateError(result.logs, `Could not build ${entrypoint}`);
}

await Promise.all([
  copyFile("test/browser/index.html", resolve(output, "index.html")),
  copyFile("node_modules/sqlite-wasm-http/deps/dist/sqlite3.wasm", resolve(output, "sqlite3.wasm")),
  cp(dictionary, resolve(output, "dictionary"), { recursive: true }),
]);
console.log(output);
