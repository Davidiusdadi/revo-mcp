/**
 * A page that starts the dictionary Worker on a database and searches once:
 * `pnpm browser:smoke:build [out] [database]`, then serve `out` with range
 * support. `?access=remote` keeps the Worker from storing a local copy.
 */
import { build } from "esbuild";
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
  await build({
    entryPoints: [entrypoint],
    outfile: resolve(output, naming),
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    logLevel: "warning",
  });
}

await Promise.all([
  copyFile("test/browser/index.html", resolve(output, "index.html")),
  copyFile("node_modules/@sqlite.org/sqlite-wasm/dist/sqlite3.wasm", resolve(output, "sqlite3.wasm")),
  symlink(database, resolve(output, "voko.db")),
  ...[".zst", ".gz"].map((suffix) => existsSync(`${database}${suffix}`) ? symlink(`${database}${suffix}`, resolve(output, `voko.db${suffix}`)) : undefined),
]);
console.log(output);
