#!/usr/bin/env bun
/**
 * Profiles where time is actually spent inside lookupEsperanto + format
 * for a sample of headwords. Run: bun run scripts/profile-lookup.ts
 */
import { Database } from "bun:sqlite";
import { lookupEsperanto, closeDb, getDb } from "../src/db";
import { formatResults } from "../src/formatter";
import { extractByMrk } from "../src/html-extract";

const DB_PATH = process.env.REVO_DB_PATH ?? "data/revo.db";
const SAMPLE = 200;

const db = new Database(DB_PATH, { readonly: true });
const sample = db
  .query<{ kap: string; art: string; mrk: string }, [number]>(
    `SELECT kap, art, mrk FROM nodo ORDER BY random() LIMIT ?`
  )
  .all(SAMPLE);
db.close();

// Warm up the shared db connection used by lookupEsperanto
getDb();
lookupEsperanto(sample[0].kap, 1);

let tLookup = 0n;
let tFormat = 0n;
let tParseOnly = 0n;
let tSqlOnly = 0n;
const ns = (a: bigint, b: bigint) => Number(b - a) / 1e6;

const liveDb = getDb();

for (const row of sample) {
  // Phase A: full lookup (SQL + parse + traduko + referenco)
  const a0 = process.hrtime.bigint();
  const results = lookupEsperanto(row.kap, 1);
  const a1 = process.hrtime.bigint();
  tLookup += a1 - a0;

  // Phase B: format
  const f0 = process.hrtime.bigint();
  formatResults(results, ["en"]);
  const f1 = process.hrtime.bigint();
  tFormat += f1 - f0;

  // Phase C: parse-only cost (re-fetch artikolo blob, force a fresh parse without cache)
  const artRow = liveDb
    .query<{ txt: Buffer }, [string]>(`SELECT txt FROM artikolo WHERE mrk = ?`)
    .get(row.art);
  if (artRow?.txt) {
    const p0 = process.hrtime.bigint();
    extractByMrk(artRow.txt, row.mrk); // no cacheKey → forces fresh parse
    const p1 = process.hrtime.bigint();
    tParseOnly += p1 - p0;
  }

  // Phase D: SQL-only cost (the exact-match query that lookupEsperanto starts with)
  const s0 = process.hrtime.bigint();
  liveDb
    .query<{ mrk: string; art: string; kap: string; num: number }, [string]>(
      "SELECT DISTINCT mrk, art, kap, num FROM nodo WHERE kap = ? COLLATE NOCASE ORDER BY length(mrk)"
    )
    .all(row.kap);
  const s1 = process.hrtime.bigint();
  tSqlOnly += s1 - s0;
}

closeDb();

const n = sample.length;
console.log(`Profile over ${n} random headwords (avg per call):`);
console.log(`  lookupEsperanto + format:  ${(ns(0n, tLookup) / n).toFixed(2)} ms (${ns(0n, tFormat / BigInt(n)).toFixed(2)} of which is format)`);
console.log(`  parse-only (cold):         ${(ns(0n, tParseOnly) / n).toFixed(2)} ms`);
console.log(`  exact-match SQL only:      ${(ns(0n, tSqlOnly) / n).toFixed(2)} ms`);
console.log();
console.log(`Total wall:`);
console.log(`  lookup:  ${(ns(0n, tLookup) / 1000).toFixed(2)} s`);
console.log(`  parse:   ${(ns(0n, tParseOnly) / 1000).toFixed(2)} s`);
console.log(`  sql:     ${(ns(0n, tSqlOnly) / 1000).toFixed(2)} s`);
