/**
 * Passes: the tables derived from the stored articles (layer L2). A pass owns a
 * set of tables, is versioned, and can be re-run alone: `runPass` drops the
 * pass's tables, runs it inside a transaction and records the outcome in
 * `meta_pass`. New enrichment = a new pass, never a change to the articles'
 * tables (L1).
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
  let rows = 0;
  // Dropping the old tables and recording the run belong to the same
  // transaction as the run itself: a pass that throws half-way then leaves the
  // previous result in place, instead of a database with its tables gone and a
  // meta_pass row that still claims they are there.
  db.transaction(() => {
    for (const t of pass.tables) db.run(`DROP TABLE IF EXISTS ${t}`);
    rows = pass.run(db, (m) => log(`  ${m}`));
    db.run(
      `INSERT OR REPLACE INTO meta_pass (pass, version, input_hash, rows, ms, at)
       VALUES (?, ?, NULL, ?, ?, datetime('now'))`,
      [pass.name, pass.version, rows, Date.now() - t0]
    );
  })();
  log(`  ${rows} rows in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}
