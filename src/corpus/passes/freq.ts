/**
 * Pass `freq`: usage frequency of lemmas and morphemes, from the counts file
 * `corpus/freq/counts.tsv` (see corpus/freq/README.md for where the counts
 * come from and how they are regenerated).
 *
 * - `x_freq_word`: one row per lemma of the file, held against ReVo the way
 *   the gloss tool's `classify` does, in the same order: a headword as
 *   written, else an inflection of one (`lemmaCandidates`), else a form the
 *   examples attest (`x_token`), else a word the inventory builds (`segment`),
 *   else unknown. The split comes from the corpus where it stored one (the
 *   headword's `x_morph` row, the token's `x_token` row; an inflection gets
 *   the segmenter with the headword's root pinned) and from the segmenter
 *   otherwise.
 * - `x_freq_root`: every morpheme of those splits — roots, endingless words,
 *   prefixes, suffixes — with the counts of the lemmas containing it. A lemma
 *   the file does not have contributes nothing.
 * - `meta.freq_sources`: what the file's header says about each source
 *   (tokens counted, licence, URL, hash, date), which the rates per million
 *   divide by.
 *
 * Without the file the tables are created empty, so a checkout without the
 * counts still builds.
 */
import type { Database } from "../../runtime/node-database";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { plausible, relabel, inventoryOf } from "../../gloss";
import { FREQ_SOURCES, type FreqSource, type FreqSourceInfo } from "../../freq";
import { formatSegments, lemmaCandidates, pinFits, segment, type Inventory, type Morph, type MorphKind } from "../../morph";
import { ROOT } from "../sources";
import type { Pass } from "../pass";

export const COUNTS_FILE = join(ROOT, "corpus", "freq", "counts.tsv");

export interface CountsFile {
  sources: Record<FreqSource, FreqSourceInfo>;
  rows: { lemma: string; counts: Record<FreqSource, number> }[];
}

/**
 * The counts file: `#` comment lines, among them one `# source NAME: k=v …`
 * per source (values may be double-quoted), then `lemma<TAB>hplt<TAB>tekstaro`.
 */
export function parseCounts(text: string): CountsFile {
  const sources = {} as Record<FreqSource, FreqSourceInfo>;
  const rows: CountsFile["rows"] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    if (line.startsWith("#")) {
      const m = /^# source (\w+):\s*(.*)$/.exec(line);
      if (!m) continue;
      const name = m[1] as FreqSource;
      if (!FREQ_SOURCES.includes(name)) throw new Error(`counts file: unknown source ${name}`);
      const info: FreqSourceInfo = { tokens: 0 };
      for (const kv of m[2].matchAll(/(\w+)=("([^"]*)"|\S+)/g)) {
        const v = kv[3] ?? kv[2];
        info[kv[1]] = /^\d+$/.test(v) ? Number(v) : v;
      }
      if (!info.tokens) throw new Error(`counts file: source ${name} has no tokens=`);
      sources[name] = info;
      continue;
    }
    const cols = line.split("\t");
    if (cols.length !== 1 + FREQ_SOURCES.length) throw new Error(`counts file: bad row ${JSON.stringify(line)}`);
    const counts = {} as Record<FreqSource, number>;
    FREQ_SOURCES.forEach((s, i) => { counts[s] = Number(cols[i + 1]); });
    rows.push({ lemma: cols[0], counts });
  }
  for (const s of FREQ_SOURCES) if (!sources[s]) throw new Error(`counts file: no "# source ${s}:" line`);
  return { sources, rows };
}

interface Verdict { verdict: string; kap_id: number | null; ms: Morph[] | null }
interface Token { seg: string; kinds: string; ok: number; lemma_kap_id: number | null }

/** The lookups `classify` makes per word, read once: headword by norm (first by node, id) and attested form by norm (the most frequent). */
function judge(db: Database, inv: Inventory) {
  const kapByNorm = new Map<string, number>();
  for (const r of db.query<{ norm: string; id: number }, []>("SELECT norm, id FROM headword ORDER BY node_id, id").all())
    if (!kapByNorm.has(r.norm)) kapByNorm.set(r.norm, r.id);
  const tokenByNorm = new Map<string, Token>();
  for (const r of db.query<Token & { norm: string }, []>("SELECT norm, seg, kinds, ok, lemma_kap_id FROM x_token ORDER BY n DESC, id").all())
    if (!tokenByNorm.has(r.norm)) tokenByNorm.set(r.norm, r);
  const morph = db.query<{ seg: string; kinds: string }, [number]>(
    "SELECT seg, kinds FROM x_morph WHERE kap_id = ? AND ok = 1 AND seg NOT LIKE '% %'");
  const stored = (s: { seg: string; kinds: string } | null) =>
    s && relabel(s.seg.split("|").map((m, i) => ({ m, k: s.kinds[i] as MorphKind })), inv);

  /** A lemma held against ReVo in `classify`'s order, with the cheapest split the corpus supports. */
  return function verdictOf(lemma: string): Verdict {
    const guess = () => {
      const ms = segment(lemma, inv);
      return ms && plausible(ms, lemma, inv) ? ms : null;
    };

    const exact = kapByNorm.get(lemma);
    if (exact !== undefined) return { verdict: "headword", kap_id: exact, ms: stored(morph.get(exact)) ?? guess() };

    for (const c of lemmaCandidates(lemma)) {
      const hit = kapByNorm.get(c.lemma);
      if (hit === undefined) continue;
      // the headword's stored split says where its root is; the inflection keeps it there
      const base = stored(morph.get(hit));
      let ms: Morph[] | null = null;
      if (base) {
        let at = 0;
        for (const m of base) {
          if (m.k === "R" && pinFits(lemma, { at, root: m.m })) { ms = segment(lemma, inv, { at, root: m.m }); break; }
          at += m.m.length;
        }
      }
      return { verdict: "inflection", kap_id: hit, ms: ms ?? guess() };
    }

    const tok = tokenByNorm.get(lemma);
    if (tok) return { verdict: "attested", kap_id: tok.lemma_kap_id, ms: tok.ok ? stored(tok) : guess() };

    const ms = guess();
    return ms ? { verdict: "derived", kap_id: null, ms } : { verdict: "unknown", kap_id: null, ms: null };
  };
}

export function freqPassFor(file: string): Pass {
  return {
    name: "freq",
    version: 1,
    tables: ["x_freq_word", "x_freq_root"],
    run(db, log) {
      db.run(`
        CREATE TABLE x_freq_word (
          lemma    TEXT PRIMARY KEY,     -- the dictionary form (morph.ts lemmaOf)
          verdict  TEXT NOT NULL,        -- headword | inflection | attested | derived | unknown
          kap_id   INTEGER,              -- the headword it is, or is a form of
          seg      TEXT,                 -- "mal|san|ul|ej|o"
          kinds    TEXT,                 -- "PRSSE"
          hplt     INTEGER NOT NULL,
          tekstaro INTEGER NOT NULL
        ) WITHOUT ROWID`);
      db.run(`
        CREATE TABLE x_freq_root (
          morph    TEXT NOT NULL,
          kind     TEXT NOT NULL,        -- R root · W endingless word · P prefix · S suffix
          hplt     INTEGER NOT NULL,     -- tokens of the lemmas containing it
          tekstaro INTEGER NOT NULL,
          lemmas   INTEGER NOT NULL,     -- distinct lemmas it was counted in
          PRIMARY KEY (morph, kind)
        ) WITHOUT ROWID`);
      db.run("DELETE FROM meta WHERE key = 'freq_sources'");
      if (!existsSync(file)) {
        log(`no counts file at ${file}: frequency tables left empty`);
        return 0;
      }
      const { sources, rows } = parseCounts(readFileSync(file, "utf8"));
      const inv = inventoryOf(db);
      const verdictOf = judge(db, inv);
      const insWord = db.prepare("INSERT INTO x_freq_word VALUES (?,?,?,?,?,?,?)");
      const roots = new Map<string, { morph: string; kind: MorphKind; n: Record<FreqSource, number>; lemmas: number }>();
      const verdicts: Record<string, number> = {};
      for (const { lemma, counts } of rows) {
        const v = verdictOf(lemma);
        const f = v.ms ? formatSegments(v.ms) : null;
        insWord.run(lemma, v.verdict, v.kap_id, f?.seg ?? null, f?.kinds ?? null, counts.hplt, counts.tekstaro);
        verdicts[v.verdict] = (verdicts[v.verdict] ?? 0) + 1;
        if (!v.ms) continue;
        const seen = new Set<string>();
        for (const m of v.ms) {
          if (!"RWPS".includes(m.k) || seen.has(`${m.k} ${m.m}`)) continue;
          seen.add(`${m.k} ${m.m}`);
          let e = roots.get(`${m.k} ${m.m}`);
          if (!e) roots.set(`${m.k} ${m.m}`, (e = { morph: m.m, kind: m.k, n: { hplt: 0, tekstaro: 0 }, lemmas: 0 }));
          for (const s of FREQ_SOURCES) e.n[s] += counts[s];
          e.lemmas++;
        }
      }
      const insRoot = db.prepare("INSERT INTO x_freq_root VALUES (?,?,?,?,?)");
      for (const e of roots.values()) insRoot.run(e.morph, e.kind, e.n.hplt, e.n.tekstaro, e.lemmas);
      db.run("CREATE INDEX idx_x_freq_word_kap ON x_freq_word(kap_id)");
      db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('freq_sources', ?)", [JSON.stringify(sources)]);
      log(`x_freq_word: ${rows.length} lemmas (${Object.entries(verdicts).map(([k, n]) => `${k} ${n}`).join(", ")})`);
      log(`x_freq_root: ${roots.size} morphemes; sources ${FREQ_SOURCES.map((s) => `${s} ${sources[s].tokens} tokens`).join(", ")}`);
      return rows.length + roots.size;
    },
  };
}

export const freqPass: Pass = freqPassFor(COUNTS_FILE);
