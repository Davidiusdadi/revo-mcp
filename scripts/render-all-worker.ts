/**
 * Worker for render-all-articles.ts. Receives row batches, runs each through
 * the lookup + format pipeline, and returns aggregated counts plus failures.
 */
import { lookupEsperanto, closeDb } from "../src/db";
import { formatResults } from "../src/formatter";

interface Row { kap: string; art: string; mrk: string }
interface Failure {
  kap: string; art: string; mrk: string;
  kind: "crash" | "empty" | "no-senses";
  message?: string; stack?: string;
}

declare const self: Worker;

self.onmessage = (e: MessageEvent) => {
  const msg = e.data as { type: "work"; batch: Row[] } | { type: "done" };

  if (msg.type === "done") {
    closeDb();
    self.postMessage({ type: "exiting" });
    self.close();
    return;
  }

  let ok = 0, empty = 0, noSenses = 0, crashed = 0;
  const failures: Failure[] = [];

  for (const { kap, art, mrk } of msg.batch) {
    try {
      const results = lookupEsperanto(kap, 1);
      if (results.length === 0) {
        empty++;
        failures.push({ kap, art, mrk, kind: "empty" });
        continue;
      }
      const hasContent = results.some(
        (r) => r.senses.length > 0 || r.translations.length > 0
      );
      const md = formatResults(results, ["en"]);
      if (typeof md !== "string" || md.length === 0) {
        crashed++;
        failures.push({ kap, art, mrk, kind: "crash", message: "formatResults returned empty" });
      } else if (!hasContent) {
        noSenses++;
        failures.push({ kap, art, mrk, kind: "no-senses" });
      } else {
        ok++;
      }
    } catch (err) {
      crashed++;
      const e = err as Error;
      failures.push({ kap, art, mrk, kind: "crash", message: e.message, stack: e.stack });
    }
  }

  self.postMessage({
    type: "result",
    processed: msg.batch.length,
    ok, empty, noSenses, crashed, failures,
  });
};

self.postMessage({ type: "ready" });
