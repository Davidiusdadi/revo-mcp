#!/usr/bin/env bun
/**
 * Hardening script: renders every Esperanto headword through the lookup +
 * format pipeline and reports any failures. Parallelized over Bun Workers.
 * Run with: bun run scripts/render-all-articles.ts
 *   Env: REVO_DB_PATH=path/to.db, REVO_WORKERS=8, REVO_BATCH=200
 */
import { Database } from "bun:sqlite";
import { availableParallelism } from "node:os";

const DB_PATH = process.env.REVO_DB_PATH ?? "data/revo.db";
const NUM_WORKERS = Number(process.env.REVO_WORKERS) || Math.max(2, availableParallelism() - 1);
const BATCH_SIZE = Number(process.env.REVO_BATCH) || 200;

interface Row { kap: string; art: string; mrk: string }
interface Failure {
  kap: string; art: string; mrk: string;
  kind: "crash" | "empty" | "no-senses";
  message?: string; stack?: string;
}

function nowHHMMSS(): string {
  return new Date().toLocaleTimeString("en-GB", { hour12: false });
}
function fmtDuration(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return "?";
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return `${m}m ${rem}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m ${rem}s`;
}

const db = new Database(DB_PATH, { readonly: true });
const rows = db
  .query<Row, []>(`SELECT kap, art, mrk FROM nodo ORDER BY art, mrk`)
  .all();
db.close();

console.log(
  `[${nowHHMMSS()}] Rendering ${rows.length} headwords from ${DB_PATH} ` +
  `with ${NUM_WORKERS} workers, batch=${BATCH_SIZE}...`
);

let cursor = 0;
let processed = 0;
let ok = 0, empty = 0, noSenses = 0, crashed = 0;
const failures: Failure[] = [];
const t0 = Date.now();
let nextProgressTick = 100;

function nextBatch(): Row[] | null {
  if (cursor >= rows.length) return null;
  const end = Math.min(cursor + BATCH_SIZE, rows.length);
  const batch = rows.slice(cursor, end);
  cursor = end;
  return batch;
}

function maybePrintProgress() {
  if (processed < nextProgressTick && processed < rows.length) return;
  while (processed >= nextProgressTick && nextProgressTick < rows.length) {
    nextProgressTick = nextProgressTick < 1000 ? nextProgressTick + 100 : nextProgressTick + 1000;
  }
  const elapsedSec = (Date.now() - t0) / 1000;
  const rate = processed / elapsedSec;
  const remaining = (rows.length - processed) / rate;
  const eta = isFinite(remaining)
    ? new Date(Date.now() + remaining * 1000).toLocaleTimeString("en-GB", { hour12: false })
    : "?";
  process.stdout.write(
    `[${nowHHMMSS()}] ${processed}/${rows.length}  ok=${ok} empty=${empty} no-senses=${noSenses} crashed=${crashed}  (${rate.toFixed(0)}/s, ETA ${fmtDuration(remaining)} → ${eta})\n`
  );
}

const workerUrl = new URL("./render-all-worker.ts", import.meta.url).href;
let liveWorkers = NUM_WORKERS;

await new Promise<void>((resolve) => {
  for (let i = 0; i < NUM_WORKERS; i++) {
    const w = new Worker(workerUrl);
    w.onmessage = (e: MessageEvent) => {
      const msg = e.data;
      if (msg.type === "ready" || msg.type === "result") {
        if (msg.type === "result") {
          processed += msg.processed;
          ok += msg.ok;
          empty += msg.empty;
          noSenses += msg.noSenses;
          crashed += msg.crashed;
          if (msg.failures.length > 0) failures.push(...msg.failures);
          maybePrintProgress();
        }
        const batch = nextBatch();
        if (batch === null) {
          w.postMessage({ type: "done" });
        } else {
          w.postMessage({ type: "work", batch });
        }
      } else if (msg.type === "exiting") {
        w.terminate();
        liveWorkers--;
        if (liveWorkers === 0) resolve();
      }
    };
    w.onerror = (e: ErrorEvent) => {
      console.error(`Worker error: ${e.message}`);
      w.terminate();
      liveWorkers--;
      if (liveWorkers === 0) resolve();
    };
  }
});

const elapsed = (Date.now() - t0) / 1000;
console.log(`\n[${nowHHMMSS()}] Done in ${fmtDuration(elapsed)}.`);
console.log(`  ok:        ${ok}`);
console.log(`  empty:     ${empty}`);
console.log(`  no-senses: ${noSenses}`);
console.log(`  crashed:   ${crashed}`);

if (failures.length > 0) {
  const outPath = "scripts/render-all-failures.json";
  await Bun.write(outPath, JSON.stringify(failures, null, 2));
  console.log(`\nFailure details written to ${outPath}`);

  const crashes = failures.filter((f) => f.kind === "crash");
  if (crashes.length > 0) {
    const counts = new Map<string, number>();
    for (const c of crashes) counts.set(c.message ?? "?", (counts.get(c.message ?? "?") ?? 0) + 1);
    console.log(`\nTop crash messages:`);
    for (const [msg, n] of [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
      console.log(`  ${n}× ${msg}`);
    }
  }
}

process.exit(crashed > 0 ? 1 : 0);
