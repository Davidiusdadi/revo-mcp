/**
 * Enrichment passes (layer L3). A pass owns a set of tables, is versioned, and
 * can be re-run alone: `runPass` drops the pass's tables, runs it inside a
 * transaction and records the outcome in `meta_pass`. New enrichment = a new
 * pass, never a change to the canonical L2 tables.
 */
import type { Database } from "bun:sqlite";

export interface Pass {
  name: string;
  version: number;
  /** Tables (and virtual tables) this pass creates; dropped before each run. */
  tables: string[];
  /** Creates the tables and fills them; returns the number of rows written. */
  run(db: Database, log: (msg: string) => void): number;
}

export function runPass(db: Database, pass: Pass, log: (msg: string) => void = console.log): void {
  const t0 = Date.now();
  log(`pass ${pass.name} v${pass.version}`);
  for (const t of pass.tables) db.run(`DROP TABLE IF EXISTS ${t}`);
  let rows = 0;
  db.transaction(() => {
    rows = pass.run(db, (m) => log(`  ${m}`));
  })();
  const ms = Date.now() - t0;
  db.run(
    `INSERT OR REPLACE INTO meta_pass (pass, version, input_hash, rows, ms, at)
     VALUES (?, ?, NULL, ?, ?, datetime('now'))`,
    [pass.name, pass.version, rows, ms]
  );
  log(`  ${rows} rows in ${(ms / 1000).toFixed(1)}s`);
}
