/** Where the frequency pipeline keeps its files: data/freq/, git-ignored. */
import { realpathSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { FREQ_SOURCES, type FreqSource } from "../../src/freq";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const FREQ = join(ROOT, "data", "freq");
export const SOURCES_FILE = join(FREQ, "sources", "SOURCES.json");
export const DB = join(ROOT, "data", "voko.db");

/** Whether the module at `url` is the script being run, not an import (tsx leaves import.meta.main unset). */
export const isMain = (url: string): boolean => !!process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(url);

/** The sources the counts come from, in the column order of the counts file. */
export const SOURCE_NAMES = FREQ_SOURCES;
export type SourceName = FreqSource;

export interface SourceRecord {
  licence: string;
  files: { url: string; file: string; bytes: number; sha256: string; fetched: string }[];
}

export const formsFile = (s: SourceName) => join(FREQ, `forms.${s}.tsv`);
export const lemmasFile = (s: SourceName) => join(FREQ, `lemmas.${s}.tsv`);
export const TOTALS_FILE = join(FREQ, "totals.json");
export const WORDS_FILE = join(FREQ, "words.tsv");
export const ROOTS_FILE = join(FREQ, "roots.tsv");
export const REPORT_FILE = join(FREQ, "REPORT.md");
/** The reduced file the build reads. */
export const COUNTS_FILE = join(ROOT, "corpus", "freq", "counts.tsv");
