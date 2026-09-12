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

// src/corpus/build.ts imports the generated cfg tables, so it cannot be loaded
// until sources() has produced them — hence the dynamic import in main().

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const DATA_DIR = join(ROOT, "data");
const DB_PATH = join(DATA_DIR, "voko.db");

const ARTICLES = join(ROOT, "vendor", "revo-fonto", "revo");
const ENTITIES = join(ROOT, "packages", "voko-xml", "data", "entities.json");

function run(cmd: string[], whatFailed: string): void {
  const proc = Bun.spawnSync(cmd, { stdout: "inherit", stderr: "inherit" });
  if (proc.exitCode !== 0) throw new Error(whatFailed);
}

/**
 * Make sure the XML and the generated parser tables are both present.
 *
 * Two ways in, because only one of them has git: a fresh clone checks out the
 * submodules and generates the tables in one go, while a container build gets
 * the XML from outside (the Dockerfile's `sources` stage) and needs nothing but
 * the DTDs to generate the tables.
 */
function sources(): void {
  if (!existsSync(ARTICLES)) {
    console.log("Checking out the source submodules...");
    run(
      ["sh", join(ROOT, "scripts", "fonto.sh")],
      "scripts/fonto.sh failed. It needs git and the submodules; in a build " +
        "context without them, put the sources at vendor/revo-fonto and " +
        "vendor/voko-grundo first."
    );
    return;
  }
  if (!existsSync(ENTITIES)) {
    // The XML is here but the generated tables are not, so the sources arrived
    // without git. gen-entities.ts only reads vendor/voko-grundo/{dtd,cfg}.
    console.log("Generating the parser's entity and cfg tables...");
    run(
      ["bun", "run", join(ROOT, "scripts", "gen-entities.ts")],
      "scripts/gen-entities.ts failed — is vendor/voko-grundo present?"
    );
    return;
  }
  console.log("XML sources and parser tables present.");
}

async function main(): Promise<void> {
  mkdirSync(DATA_DIR, { recursive: true });
  sources();

  const { buildL2, PASSES } = await import("./corpus/build");
  const { runPass } = await import("./corpus/pass");

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

await main();
