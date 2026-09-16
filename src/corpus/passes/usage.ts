/**
 * Pass `usage`: how often each lemma of `corpus/freq/counts.tsv` is used, and
 * nothing else. It is the one frequency table the core file carries: a browser
 * glossing from that file needs the counts to tell a slip of the finger from a
 * rare word (`finsita` is written by nobody, `finita` 11,786 times on the web),
 * but not the splits and verdicts the `freq` pass holds against ReVo, which
 * need the stored splits the core file leaves out.
 *
 * Without the file the table is created empty, as `freq` leaves its own.
 */
import { existsSync, readFileSync } from "fs";
import { COUNTS_FILE, parseCounts } from "./freq";
import type { Pass } from "../pass";

export function usagePassFor(file: string): Pass {
  return {
    name: "usage",
    version: 1,
    tables: ["x_usage"],
    run(db, log) {
      db.run(`
        CREATE TABLE x_usage (
          lemma    TEXT PRIMARY KEY,     -- the dictionary form (morph.ts lemmaOf)
          hplt     INTEGER NOT NULL,
          tekstaro INTEGER NOT NULL
        ) WITHOUT ROWID`);
      if (!existsSync(file)) {
        log(`no counts file at ${file}: usage table left empty`);
        return 0;
      }
      const { sources, rows } = parseCounts(readFileSync(file, "utf8"));
      const ins = db.prepare("INSERT INTO x_usage VALUES (?,?,?)");
      for (const { lemma, counts } of rows) ins.run(lemma, counts.hplt, counts.tekstaro);
      db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('freq_sources', ?)", [JSON.stringify(sources)]);
      log(`x_usage: ${rows.length} lemmas`);
      return rows.length;
    },
  };
}

export const usagePass: Pass = usagePassFor(COUNTS_FILE);
