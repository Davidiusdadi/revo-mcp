#!/usr/bin/env bun
/**
 * A page that starts the dictionary Worker on a database and searches once:
 * `bun run browser:smoke:build [out] [database]`, then serve `out` with range
 * support. `?access=remote` keeps the Worker from storing a local copy.
 */
import { copyFile, mkdir, rm, symlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const output = resolve(process.argv[2] ?? "dist/browser-smoke");
const database = resolve(process.argv[3] ?? "data/voko.db");
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
  symlink(database, resolve(output, "voko.db")),
  existsSync(`${database}.gz`) ? symlink(`${database}.gz`, resolve(output, "voko.db.gz")) : undefined,
]);
console.log(output);
