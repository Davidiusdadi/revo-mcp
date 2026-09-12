#!/usr/bin/env bun
/**
 * Setup: build data/voko.db from ReVo's VOKO XML.
 *
 * Checks out the source submodules and generates the parser's tables first if
 * that has not happened yet (scripts/fonto.sh), then runs the L2 build and
 * every enrichment pass — the same work as `bun run corpus:build`, so a fresh
 * clone reaches a serving database in one command.
 */

import { existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { buildL2, PASSES } from "./corpus/build";
import { runPass } from "./corpus/pass";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const DATA_DIR = join(ROOT, "data");
const DB_PATH = join(DATA_DIR, "voko.db");

const ARTICLES = join(ROOT, "vendor", "revo-fonto", "revo");
const ENTITIES = join(ROOT, "packages", "voko-xml", "data", "entities.json");

/**
 * Make sure the XML and the generated parser tables are present. Both are
 * produced by scripts/fonto.sh, which needs git; when the sources are already
 * in place (a Docker build context, say) nothing runs.
 */
function sources(): void {
  if (existsSync(ARTICLES) && existsSync(ENTITIES)) {
    console.log("XML sources and parser tables present.");
    return;
  }
  console.log("Checking out the source submodules...");
  const proc = Bun.spawnSync(["sh", join(ROOT, "scripts", "fonto.sh")], {
    stdout: "inherit",
    stderr: "inherit",
  });
  if (proc.exitCode !== 0) {
    throw new Error(
      "scripts/fonto.sh failed. It needs git and the submodules; in a build " +
        "context without them, check out vendor/revo-fonto and vendor/voko-grundo first."
    );
  }
}

function main(): void {
  mkdirSync(DATA_DIR, { recursive: true });
  sources();

  console.log(`Building ${DB_PATH} ...`);
  const t0 = Date.now();
  const db = buildL2(DB_PATH); // replaces the file if it is already there
  for (const pass of PASSES) runPass(db, pass);
  db.exec("PRAGMA optimize");
  db.close();

  const mb = (Bun.file(DB_PATH).size / 1024 / 1024).toFixed(0);
  const s = ((Date.now() - t0) / 1000).toFixed(0);
  console.log(`\nSetup complete: ${DB_PATH} (${mb} MB) in ${s}s.`);
  console.log("Run `bun run start` to start the MCP server.");
}

main();
