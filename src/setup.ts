#!/usr/bin/env bun
/**
 * Setup script: downloads the pre-built Revo SQLite database from GitHub releases
 * and augments it with FTS5 indexes for fast lookup.
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { extractAllExamples } from "./html-extract";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "data");
const DB_PATH = join(DATA_DIR, "revo.db");
const REPO = "revuloj/revo-fonto";

async function getLatestReleaseDbUrl(): Promise<string> {
  const resp = await fetch(
    `https://api.github.com/repos/${REPO}/releases/latest`
  );
  if (!resp.ok) throw new Error(`GitHub API error: ${resp.status}`);
  const data = (await resp.json()) as {
    assets: { name: string; browser_download_url: string }[];
  };
  const asset = data.assets.find((a) => a.name.startsWith("revosql_") && a.name.endsWith(".zip"));
  if (!asset) throw new Error("No revosql_*.zip found in latest release");
  return asset.browser_download_url;
}

async function downloadAndExtract(url: string): Promise<void> {
  console.log(`Downloading ${url}...`);
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Download failed: ${resp.status}`);
  const zipData = await resp.arrayBuffer();
  const zipPath = join(DATA_DIR, "revosql.zip");
  await Bun.write(zipPath, zipData);
  console.log(`Downloaded ${(zipData.byteLength / 1024 / 1024).toFixed(1)} MB`);

  console.log("Extracting...");
  const proc = Bun.spawnSync(["unzip", "-o", zipPath, "-d", DATA_DIR]);
  if (proc.exitCode !== 0) {
    throw new Error(`unzip failed: ${proc.stderr.toString()}`);
  }

  // The zip contains revo.db
  const extractedPath = join(DATA_DIR, "revo.db");
  if (!existsSync(extractedPath)) {
    throw new Error("revo.db not found after extraction");
  }

  // Clean up zip
  await Bun.write(zipPath, ""); // truncate
  const { unlinkSync } = await import("fs");
  unlinkSync(zipPath);
  console.log("Extracted revo.db");
}

function augmentWithIndexes(dbPath: string): void {
  console.log("Augmenting database with FTS5 indexes...");
  const db = new Database(dbPath);

  // Standard indexes for common queries
  db.run("CREATE INDEX IF NOT EXISTS idx_nodo_kap ON nodo(kap COLLATE NOCASE)");
  db.run("CREATE INDEX IF NOT EXISTS idx_nodo_art ON nodo(art)");
  db.run("CREATE INDEX IF NOT EXISTS idx_traduko_mrk ON traduko(mrk)");
  db.run(
    "CREATE INDEX IF NOT EXISTS idx_traduko_lng_trd ON traduko(lng, trd COLLATE NOCASE)"
  );
  db.run("CREATE INDEX IF NOT EXISTS idx_var_kap ON var(kap COLLATE NOCASE)");
  db.run("CREATE INDEX IF NOT EXISTS idx_referenco_mrk ON referenco(mrk)");
  db.run("CREATE INDEX IF NOT EXISTS idx_uzo_mrk ON uzo(mrk)");
  console.log("  Standard indexes created.");

  // Unicode-aware case-folded headword column. SQLite's NOCASE collation only
  // folds ASCII; Esperanto's Ĉ Ĝ Ĥ Ĵ Ŝ Ŭ need full Unicode case folding.
  // We pre-compute kap.toLowerCase() (Unicode-aware in JS) into kap_norm and
  // index it, so runtime queries do plain BINARY index lookups.
  for (const table of ["nodo", "var"] as const) {
    const cols = db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all();
    if (!cols.some((c) => c.name === "kap_norm")) {
      db.run(`ALTER TABLE ${table} ADD COLUMN kap_norm TEXT`);
    }
    const todo = db
      .query<{ rowid: number; kap: string }, []>(
        `SELECT rowid, kap FROM ${table} WHERE kap_norm IS NULL`
      )
      .all();
    if (todo.length > 0) {
      const upd = db.prepare(`UPDATE ${table} SET kap_norm = ? WHERE rowid = ?`);
      const tx = db.transaction((rows: typeof todo) => {
        for (const r of rows) upd.run(r.kap?.toLowerCase() ?? null, r.rowid);
      });
      tx(todo);
    }
    db.run(`CREATE INDEX IF NOT EXISTS idx_${table}_kap_norm ON ${table}(kap_norm)`);
  }
  console.log("  Unicode-normalized kap_norm columns + indexes created.");

  // FTS5 for headword search
  const ftsKapExists = db
    .query(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='fts_kap'"
    )
    .get();
  if (!ftsKapExists) {
    db.run(`
      CREATE VIRTUAL TABLE fts_kap USING fts5(
        kap,
        tokenize='unicode61 remove_diacritics 2'
      )
    `);
    db.run("INSERT INTO fts_kap(rowid, kap) SELECT rowid, kap FROM nodo");
    // Include variant headwords
    db.run(`
      INSERT INTO fts_kap(kap)
        SELECT v.kap FROM var v
    `);
    console.log("  FTS5 headword index created.");
  } else {
    console.log("  FTS5 headword index already exists.");
  }

  // FTS5 for translation search
  const ftsTrdExists = db
    .query(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='fts_trd'"
    )
    .get();
  if (!ftsTrdExists) {
    db.run(`
      CREATE VIRTUAL TABLE fts_trd USING fts5(
        trd,
        tokenize='unicode61 remove_diacritics 2'
      )
    `);
    db.run("INSERT INTO fts_trd(rowid, trd) SELECT rowid, trd FROM traduko");
    console.log("  FTS5 translation index created.");
  } else {
    console.log("  FTS5 translation index already exists.");
  }

  // Example-sentence corpus: one row per <i class="ekz">, rendered to
  // markdown, with FTS5 so inflected forms / compounds / proper names that
  // only appear inside example text become searchable.
  buildEkzemploCorpus(db);

  db.close();
  console.log("Database augmentation complete.");
}

function buildEkzemploCorpus(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS ekzemplo (
      rowid INTEGER PRIMARY KEY,
      art       TEXT NOT NULL,
      drv_mrk   TEXT NOT NULL,
      sense_mrk TEXT,
      ekz_md    TEXT NOT NULL,
      position  INTEGER NOT NULL
    )
  `);
  db.run("CREATE INDEX IF NOT EXISTS idx_ekzemplo_drv ON ekzemplo(drv_mrk)");
  db.run("CREATE INDEX IF NOT EXISTS idx_ekzemplo_art ON ekzemplo(art)");
  db.run(`
    CREATE VIRTUAL TABLE IF NOT EXISTS fts_ekz USING fts5(
      ekz_md,
      content='ekzemplo',
      content_rowid='rowid',
      tokenize='unicode61 remove_diacritics 2'
    )
  `);

  const existing = db.query<{ c: number }, []>("SELECT COUNT(*) c FROM ekzemplo").get();
  if (existing && existing.c > 0) {
    console.log(`  Example corpus already populated (${existing.c} rows).`);
    return;
  }

  const arts = db
    .query<{ mrk: string; txt: Buffer }, []>("SELECT mrk, txt FROM artikolo")
    .all();
  console.log(`  Extracting examples from ${arts.length} articles...`);

  const insert = db.prepare(
    "INSERT INTO ekzemplo (art, drv_mrk, sense_mrk, ekz_md, position) VALUES (?, ?, ?, ?, ?)"
  );
  let total = 0;
  const t0 = Date.now();
  const tx = db.transaction((rows: typeof arts) => {
    for (const art of rows) {
      const examples = extractAllExamples(art.txt, art.mrk);
      for (const e of examples) {
        insert.run(art.mrk, e.drvMrk, e.senseMrk ?? null, e.ekzMd, e.position);
        total++;
      }
    }
  });
  tx(arts);

  db.run("INSERT INTO fts_ekz(fts_ekz) VALUES('rebuild')");
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`  Example corpus built: ${total} rows in ${elapsed}s.`);
}

async function main() {
  mkdirSync(DATA_DIR, { recursive: true });

  if (existsSync(DB_PATH)) {
    console.log("revo.db already exists. Re-augmenting indexes...");
  } else {
    const url = await getLatestReleaseDbUrl();
    await downloadAndExtract(url);
  }

  augmentWithIndexes(DB_PATH);
  console.log("\nSetup complete! Run `bun run start` to start the MCP server.");
}

main().catch((err) => {
  console.error("Setup failed:", err);
  process.exit(1);
});
