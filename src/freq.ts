/**
 * Usage frequency of a word or a morpheme, from the tables the `freq` pass
 * writes (src/corpus/passes/freq.ts): counts per source and rates per million
 * tokens. One keyed read each; nothing here scans a table.
 */
import { hasPass } from "./db-voko";
import { lemmaOf } from "./morph";
import type { SqlReader } from "./sql";

/** The corpora the counts come from, in column order. */
export const FREQ_SOURCES = ["hplt", "tekstaro"] as const;
export type FreqSource = (typeof FREQ_SOURCES)[number];

/** What the counts file said about a source, as the pass stored it in `meta`. */
export interface FreqSourceInfo {
  /** Esperanto tokens counted; the denominator of the per-million rates. */
  tokens: number;
  [key: string]: string | number;
}

export interface WordFrequency {
  /** The dictionary form the word was filed under (`lemmaOf`). */
  lemma: string;
  /** headword · inflection · attested · derived · unknown, as the gloss tool would say. */
  verdict: string;
  /** The ReVo headword the lemma is, or is a form of. */
  kap_id: number | null;
  seg: string | null;
  kinds: string | null;
  counts: Record<FreqSource, number>;
  perMillion: Record<FreqSource, number>;
}

export interface MorphFrequency {
  morph: string;
  /** R root · W endingless word · P prefix · S suffix */
  kind: string;
  counts: Record<FreqSource, number>;
  perMillion: Record<FreqSource, number>;
  /** Distinct lemmas the morpheme was counted in. */
  lemmas: number;
}

const sourcesCache = new WeakMap<SqlReader, Record<FreqSource, FreqSourceInfo> | null>();

/** The sources behind the counts, or null when the database has no frequency tables. */
export function freqSources(db: SqlReader): Record<FreqSource, FreqSourceInfo> | null {
  if (sourcesCache.has(db)) return sourcesCache.get(db)!;
  let info: Record<FreqSource, FreqSourceInfo> | null = null;
  try {
    const row = db.query<{ value: string }, [string]>("SELECT value FROM meta WHERE key = ?").get("freq_sources");
    if (row) info = JSON.parse(row.value);
  } catch {
    info = null; // no meta table: not a corpus database
  }
  sourcesCache.set(db, info);
  return info;
}

const rates = (counts: Record<FreqSource, number>, info: Record<FreqSource, FreqSourceInfo>) =>
  Object.fromEntries(FREQ_SOURCES.map((s) => [s, info[s]?.tokens ? (1e6 * counts[s]) / info[s].tokens : 0])) as Record<FreqSource, number>;

/** How often `word` (any inflection) is used, or null when it was never counted. */
export function wordFrequency(db: SqlReader, word: string): WordFrequency | null {
  const info = freqSources(db);
  if (!info) return null;
  const lemma = lemmaOf(word);
  const row = db
    .query<{ lemma: string; verdict: string; kap_id: number | null; seg: string | null; kinds: string | null; hplt: number; tekstaro: number }, [string]>(
      "SELECT lemma, verdict, kap_id, seg, kinds, hplt, tekstaro FROM x_freq_word WHERE lemma = ?")
    .get(lemma);
  if (!row) return null;
  const counts = { hplt: row.hplt, tekstaro: row.tekstaro };
  return { lemma: row.lemma, verdict: row.verdict, kap_id: row.kap_id, seg: row.seg, kinds: row.kinds, counts, perMillion: rates(counts, info) };
}

/** How often a morpheme occurs inside counted lemmas; `kind` narrows to R, W, P or S. */
export function morphFrequency(db: SqlReader, morph: string, kind?: string): MorphFrequency[] {
  const info = freqSources(db);
  if (!info) return [];
  const rows = db
    .query<{ morph: string; kind: string; hplt: number; tekstaro: number; lemmas: number }, [string]>(
      "SELECT morph, kind, hplt, tekstaro, lemmas FROM x_freq_root WHERE morph = ? ORDER BY hplt DESC")
    .all(morph.toLowerCase())
    .filter((r) => !kind || r.kind === kind);
  return rows.map((r) => {
    const counts = { hplt: r.hplt, tekstaro: r.tekstaro };
    return { morph: r.morph, kind: r.kind, counts, perMillion: rates(counts, info), lemmas: r.lemmas };
  });
}

/**
 * How often `word` (any inflection) is used on the web, from the `usage` table,
 * which the core file carries too: 0 for a lemma the counts file lacks (it keeps
 * a word ReVo does not list only from 50 uses), null when the database has no
 * counts at all.
 */
export function webUsage(db: SqlReader, word: string): number | null {
  if (!hasPass(db, "usage") || !freqSources(db)) return null;
  const row = db.query<{ hplt: number }, [string]>("SELECT hplt FROM x_usage WHERE lemma = ?").get(lemmaOf(word));
  return row?.hplt ?? 0;
}
