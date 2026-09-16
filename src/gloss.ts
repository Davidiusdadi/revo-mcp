/**
 * Bulk glossing: a whole text goes in, corpus-backed suggestions come out.
 *
 * Two directions, chosen by the language of the text:
 *
 * - A **source** text (en, de, …) is glossed *into* Esperanto. Every content
 *   word, and every two- or three-word phrase, is looked up in the 730k
 *   translations, so a translator sees which roots exist before writing a
 *   line — one call instead of one `lookup` per word.
 * - An **Esperanto** text is *audited*. Each word is classed as a headword, an
 *   inflection of one, a form attested in the examples, a regular derivation
 *   the dictionary never lists (`farenda`, `legita`), or unknown — with the
 *   nearest real word named where there is one.
 *
 * The regular-derivation class is what makes the audit usable. ReVo lists
 * `legi` and the suffix `-end` but never `legenda`, so a checker that knows
 * only headwords flags every correctly built word in a real text. Here the
 * segmenter (`src/morph.ts`) rebuilds the word from the morpheme inventory and
 * the affix articles supply each part's own definition, so what comes back is
 * assembled from the corpus rather than invented.
 *
 * The segmenter guesses freely only for words the dictionary does not have.
 * A headword, or an inflection of one, is split with the root of its own
 * article pinned, the way the corpus build does it — and a word filed under
 * two articles keeps both readings. A build with the `splits` pass has those
 * splits stored, pinned by ReVo's own root marks, together with the forms
 * written in the examples; the core file a browser downloads has not, and
 * splits a word when it is asked about.
 */

import type { SqlReader } from "./sql";
import { webUsage } from "./freq";
import { fromXSystem, normalizeQuery } from "./stemmer";
import {
  lemmaCandidates, segment, formatSegments, ENDINGS, type Inventory, type Morph, type MorphKind, type WordClass,
} from "./morph";
import { sourceFormAttempts } from "./source-forms";
import { hasPass, translationsOf } from "./db-voko";

// ---------------------------------------------------------------------------
// shapes
// ---------------------------------------------------------------------------

export interface Candidate {
  /** The Esperanto headword. */
  eo: string;
  /** The root it is built on (`ardez` for `ardezo`), with x-system file names decoded. */
  art: string;
  /** The translation as ReVo writes it, when that is not the term itself ("female friend"). */
  src?: string;
}

export interface SourceTerm {
  term: string;
  /** Occurrences in the text. */
  n: number;
  /** The form that actually matched, when it is not the term ("friends" → "friend"). */
  via?: string;
  candidates: Candidate[];
  /** Candidates beyond the per-term cap. */
  more: number;
}

export interface SourceGloss {
  mode: "source";
  lang: string;
  words: number;
  phrases: SourceTerm[];
  terms: SourceTerm[];
  missing: { term: string; n: number }[];
  /** Distinct content words left out by `maxWords`. */
  truncated: number;
}

export type Verdict = "headword" | "inflection" | "attested" | "derived" | "unknown";

export interface Part {
  m: string;
  k: string;
  /** For an affix, its ReVo definition; for a root, the article's own headword. */
  gloss?: string;
  art?: string;
  /** The mark of the entry that names the part: the affix's, or the root's own headword's. */
  mrk?: string;
}

/** One way of taking a word apart, and the article it comes from. */
export interface Reading {
  seg: string;
  kinds: string;
  parts: Part[];
  /** The article the word is filed under, or whose root the example marked. */
  art: string;
}

export interface EoTerm {
  word: string;
  n: number;
  verdict: Verdict;
  /** headword / inflection: the dictionary form. */
  headword?: string;
  art?: string;
  /** The mark of the dictionary form's entry, what `entry` loads. */
  mrk?: string;
  /** The entry's translations in the languages asked for, as `entry` lists them. */
  translations?: { lng: string; trd: string }[];
  /** How the dictionary form was reached: infl · class · ptcp. */
  how?: string;
  /** attested: occurrences in the example corpus. */
  attested?: number;
  /** The morphological reading: the first of `readings` when there are any, else the segmenter's guess. */
  seg?: string;
  kinds?: string;
  parts?: Part[];
  /**
   * headword / inflection / attested: the word's splits by article, one per
   * article the word is filed under, longest root first. `resumi` is
   * filed under `resum` and under `sum`, so it reads `resum|i` and `re|sum|i`.
   */
  readings?: Reading[];
  /**
   * The guessed reading is built on a different root than the matched
   * headword, so it is a second sense rather than the same word taken apart.
   * Only set when no split of the dictionary form carries over to the word.
   */
  altReading?: boolean;
  /**
   * A second morphological reading, from stripping a known suffix off the
   * stem. The segmenter returns one cheapest split, and a long root shadows
   * the root-plus-suffix reading of the same letters: `legenda` segments as
   * `legend|a` (of a legend) and also reads as `leg|end|a` (that must be
   * read). Both are correct Esperanto, and only the context decides.
   */
  also?: { seg: string; kinds: string; parts: Part[] };
  /**
   * Words one letter away that the dictionary does have. Set on `unknown`, and
   * on `derived` too: a word can be built correctly and still not be the one
   * that was meant.
   */
  near?: string[];
}

export interface EoGloss {
  mode: "eo";
  words: number;
  terms: EoTerm[];
  counts: Record<Verdict, number>;
  truncated: number;
}

export interface GlossOptions {
  lang?: string;
  /** Max candidates listed per term. */
  perTerm?: number;
  /** Max distinct terms reported. */
  maxWords?: number;
  /** Esperanto: the languages each dictionary form's translations are listed in; none when omitted. */
  languages?: string[];
}

// ---------------------------------------------------------------------------
// tokenizing
// ---------------------------------------------------------------------------

/** Letters, plus the apostrophes and hyphens that sit inside words ("don't", "far-off"). */
const SRC_WORD = /\p{L}[\p{L}\p{M}'’-]*/gu;
const EO_WORD = /[\p{L}\p{M}]+/gu;

/**
 * Words carrying no lexical choice. ReVo translates few of them anyway — "the"
 * reaches one article — so this mainly keeps the output short. Particles that
 * do carry meaning inside a phrase ("give up") are still caught by the phrase
 * pass, which runs before this filter.
 */
const FUNCTION_WORDS: Record<string, ReadonlySet<string>> = {
  en: new Set(["a", "an", "the", "and", "or", "but", "if", "of", "to", "in", "on", "at", "by", "for", "with",
    "from", "as", "is", "are", "was", "were", "be", "been", "being", "am", "do", "does", "did", "have", "has",
    "had", "will", "would", "can", "could", "shall", "should", "may", "might", "must", "not", "no", "it", "its",
    "he", "him", "his", "she", "her", "they", "them", "their", "we", "us", "our", "you", "your", "i", "me", "my",
    "this", "that", "these", "those", "there", "then", "than", "so", "too", "very", "s", "t",
    "up", "down", "out", "off", "over", "back", "into", "onto", "upon", "about", "through",
    "which", "who", "whom", "whose", "what", "how", "why", "when", "where", "while",
    "all", "any", "some", "each", "both", "such", "other", "own", "same", "more", "most"]),
  de: new Set(["der", "die", "das", "den", "dem", "des", "ein", "eine", "einen", "einem", "einer", "eines",
    "und", "oder", "aber", "wenn", "von", "zu", "in", "im", "an", "am", "auf", "bei", "für", "mit", "aus",
    "als", "ist", "sind", "war", "waren", "sein", "bin", "hat", "haben", "hatte", "hatten", "wird", "werden",
    "wurde", "wurden", "kann", "können", "soll", "sollen", "muss", "müssen", "nicht", "kein", "keine", "es",
    "er", "ihn", "ihm", "sie", "ihr", "ihre", "wir", "uns", "ich", "mich", "mir", "du", "dich", "dir",
    "dieser", "diese", "dieses", "da", "dann", "so", "auch", "sehr", "nur", "noch", "schon", "man", "sich"]),
};

// ---------------------------------------------------------------------------
// cached corpus reads
// ---------------------------------------------------------------------------

const invCache = new WeakMap<SqlReader, CorpusInventory>();
const affixCache = new WeakMap<SqlReader, Map<string, AffixRow>>();
const byLenCache = new WeakMap<SqlReader, Map<number, string[]>>();

/**
 * The morpheme inventory the `morph` pass wrote, as `segment` wants it: read
 * whole the first time a word is asked about, since every answer splits the
 * word with it — 0.7 MB, two tables scanned once, and then in memory for the
 * session.
 */
class CorpusInventory implements Inventory {
  readonly roots = new Set<string>();
  readonly prefixes = new Set<string>();
  readonly suffixes = new Set<string>();
  readonly words = new Set<string>();
  readonly pairs = new Map<string, number>();
  readonly rootWeight = new Map<string, number>();
  readonly classes = new Map<string, WordClass>();
  /** An article's roots by its id: its own, and the variants it writes (`arĥiv` and `arkiv`). */
  readonly articleRoots = new Map<number, string[]>();

  constructor(db: SqlReader) {
    // the word class columns are per article row; summing them counts each
    // headword of the root once (see the morph pass)
    for (const r of db.query<{ morph: string; kind: string; article_id: number | null; drv: number; o: number; a: number; e: number; i: number }, []>(
      "SELECT morph, kind, article_id, drv, o, a, e, i FROM x_morpheme").all()) {
      if (r.kind === "R") {
        this.roots.add(r.morph);
        this.rootWeight.set(r.morph, (this.rootWeight.get(r.morph) ?? 0) + r.drv);
        const c = this.classes.get(r.morph) ?? { o: 0, a: 0, e: 0, i: 0 };
        this.classes.set(r.morph, { o: c.o + r.o, a: c.a + r.a, e: c.e + r.e, i: c.i + r.i });
        if (r.article_id !== null) {
          const arts = this.articleRoots.get(r.article_id) ?? [];
          arts.push(r.morph);
          this.articleRoots.set(r.article_id, arts);
        }
      } else if (r.kind === "P") this.prefixes.add(r.morph);
      else if (r.kind === "S") this.suffixes.add(r.morph);
      else if (r.kind === "W") this.words.add(r.morph);
    }
    for (const p of db.query<{ a: string; b: string; n: number }, []>("SELECT a, b, n FROM x_pair").all()) {
      this.pairs.set(`${p.a}+${p.b}`, p.n);
    }
  }
}

export function inventoryOf(db: SqlReader): Inventory {
  let inv = invCache.get(db);
  if (!inv) {
    inv = new CorpusInventory(db);
    invCache.set(db, inv);
  }
  return inv;
}

/** Whether the build stored every word's split (`x_morph`, `x_token`), or a split is computed here. */
const splitsStored = (db: SqlReader): boolean => hasPass(db, "splits");

interface AffixRow {
  /** the headword as written: "mal-", "-ul" */
  txt: string;
  /** its definition cut to the phrase that says what it means; empty when the article gives none */
  gloss: string;
  art: string;
  mrk: string | null;
}

/** Every affix article as the `morph` pass stored it (`x_affix`), keyed by the bare morpheme. */
function affixesOf(db: SqlReader): Map<string, AffixRow> {
  const hit = affixCache.get(db);
  if (hit) return hit;
  const out = new Map<string, AffixRow>();
  for (const r of db.query<{ morph: string; txt: string; art: string; mrk: string | null; gloss: string | null }, []>(
    "SELECT morph, txt, art, mrk, gloss FROM x_affix").all()) {
    out.set(r.morph, { txt: r.txt, gloss: r.gloss ?? "", art: r.art, mrk: r.mrk });
  }
  affixCache.set(db, out);
  return out;
}

/** Inventory roots grouped by length, for the near-miss scan. */
function rootsByLength(db: SqlReader): Map<number, string[]> {
  const hit = byLenCache.get(db);
  if (hit) return hit;
  const out = new Map<number, string[]>();
  for (const r of inventoryOf(db).roots) {
    const a = out.get(r.length) ?? [];
    a.push(r);
    out.set(r.length, a);
  }
  byLenCache.set(db, out);
  return out;
}

/**
 * The primary headword of the article a root belongs to — what the root means
 * on its own — and that article's name.
 *
 * The root is looked up through the morpheme inventory, not by article file
 * name: the files are x-system (`sxangx` for `ŝanĝ`) and homonyms are numbered
 * (`tar1`), so the morph itself names no file. A root shared by several
 * articles goes to the one with the most derivations. A plain word wins over
 * the affix spelling: the `end` article leads with the headword `-end`, but
 * `endi` is what names the root. The article's own headword is repeated by
 * its first derivation, which has the mark an entry is loaded by.
 */
function rootHeadword(db: SqlReader, morph: string): { txt: string; art: string; mrk: string | null } | null {
  const row = db
    .query<{ txt: string; art: string; mrk: string | null }, [string]>(
      `SELECT k.txt AS txt, a.file AS art, n.mrk AS mrk
         FROM x_morpheme x
         JOIN article a ON a.id = x.article_id
         JOIN headword k ON k.id BETWEEN a.id AND a.last_id
         JOIN node n ON n.id = k.node_id
        WHERE x.morph = ? AND x.kind IN ('R', 'W')
        ORDER BY x.drv DESC, (k.txt LIKE '-%' OR k.txt LIKE '%-'), (n.mrk IS NULL), k.node_id, k.id LIMIT 1`)
    .get(morph);
  return row ? { txt: row.txt, art: fromXSystem(row.art), mrk: row.mrk } : null;
}

// ---------------------------------------------------------------------------
// source text → Esperanto
// ---------------------------------------------------------------------------

interface TrdRow {
  eo: string;
  art: string;
  txt: string;
}

/** Translations whose index form is one of `forms`, exact on the indexed expression. */
function trdByForm(db: SqlReader, lang: string, forms: string[]): TrdRow[] {
  if (forms.length === 0) return [];
  const qs = forms.map(() => "?").join(",");
  return db
    .query<TrdRow, []>(
      `SELECT k.txt AS eo, a.file AS art, t.txt AS txt
         FROM translation t
         JOIN node n ON n.id = t.node_id
         JOIN article a ON a.id = n.article_id
         JOIN headword k ON k.id = n.kap_id
        WHERE t.lng = ? AND COALESCE(t.ind, t.txt) COLLATE NOCASE IN (${qs})
        ORDER BY t.node_id, t.id`)
    .all(...([lang, ...forms] as unknown as []));
}

/**
 * Candidates for one term: the word as written first, then regular reductions
 * until something hits. Direct translations lead, sub-sense ones follow, so
 * "friend" gives `amiko` before `amikino` ("female friend") — whose own
 * wording is kept, so the difference stays visible.
 */
function candidatesFor(
  db: SqlReader, lang: string, term: string, perTerm: number
): { candidates: Candidate[]; more: number; via?: string } | null {
  for (const t of sourceFormAttempts(term, lang)) {
    const rows = trdByForm(db, lang, t.forms);
    if (rows.length === 0) continue;
    const wanted = new Set(t.forms.map((f) => f.toLowerCase()));
    const direct = (r: TrdRow) => (wanted.has(r.txt.toLowerCase()) ? 0 : 1);
    rows.sort((a, b) => direct(a) - direct(b));
    const seen = new Set<string>();
    const candidates: Candidate[] = [];
    for (const r of rows) {
      if (seen.has(r.eo)) continue;
      seen.add(r.eo);
      const c: Candidate = { eo: r.eo, art: fromXSystem(r.art) };
      if (direct(r) === 1) c.src = r.txt;
      candidates.push(c);
    }
    return {
      candidates: candidates.slice(0, perTerm),
      more: Math.max(0, candidates.length - perTerm),
      via: t.via,
    };
  }
  return null;
}

export function glossSource(db: SqlReader, text: string, opts: GlossOptions = {}): SourceGloss {
  const lang = opts.lang ?? "en";
  const perTerm = opts.perTerm ?? 4;
  const maxWords = opts.maxWords ?? 80;
  const stop = FUNCTION_WORDS[lang] ?? new Set<string>();

  const tokens = [...text.matchAll(SRC_WORD)].map((m) => m[0]);

  // phrases first: a multi-word entry ("give up", "naked eye") is the hit that
  // cannot be reconstructed from the single words
  const phrases: SourceTerm[] = [];
  const phraseSeen = new Set<string>();
  for (let i = 0; i < tokens.length; i++) {
    for (const len of [3, 2]) {
      if (i + len > tokens.length) continue;
      const slice = tokens.slice(i, i + len);
      if (slice.every((w) => stop.has(w.toLowerCase()))) continue;
      const term = slice.join(" ").toLowerCase();
      if (phraseSeen.has(term)) continue;
      const hit = candidatesFor(db, lang, term, perTerm);
      if (!hit) continue;
      phraseSeen.add(term);
      phrases.push({ term, n: countOf(text, term), ...hit });
      break; // longest match at this position wins
    }
  }

  const counts = new Map<string, number>();
  const order: string[] = [];
  for (const w of tokens) {
    const k = w.toLowerCase();
    if (!counts.has(k)) order.push(k);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }

  const content = order.filter((t) => !stop.has(t) && t.length >= 2);
  const terms: SourceTerm[] = [];
  const missing: { term: string; n: number }[] = [];
  for (const term of content.slice(0, maxWords)) {
    const hit = candidatesFor(db, lang, term, perTerm);
    if (hit) terms.push({ term, n: counts.get(term)!, ...hit });
    else missing.push({ term, n: counts.get(term)! });
  }

  return {
    mode: "source",
    lang,
    words: tokens.length,
    phrases,
    terms,
    missing,
    truncated: Math.max(0, content.length - maxWords),
  };
}

function countOf(text: string, phrase: string): number {
  const re = new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+"), "gi");
  return (text.match(re) ?? []).length || 1;
}

// ---------------------------------------------------------------------------
// Esperanto text → audit
// ---------------------------------------------------------------------------

/** The node a headword is under: the entry it names, when the node is marked. */
interface KapNode {
  id: number;
  last_id: number;
  mrk: string | null;
}

/**
 * The first headword spelled `norm`, with its article's file name and root,
 * and its node. An article's own headword is repeated by its first
 * derivation, and that one is marked, so it is the one taken.
 */
function kapByNorm(db: SqlReader, norm: string): { txt: string; art: string; root: string; node: KapNode } | null {
  const row = db
    .query<{ txt: string; art: string; root: string; id: number; last_id: number; mrk: string | null }, [string]>(
      `SELECT k.txt AS txt, a.file AS art, a.rad AS root, n.id AS id, n.last_id AS last_id, n.mrk AS mrk
         FROM headword k JOIN node n ON n.id = k.node_id JOIN article a ON a.id = n.article_id
        WHERE k.norm = ? ORDER BY (n.mrk IS NULL), k.node_id, k.id LIMIT 1`)
    .get(norm);
  return row ? { txt: row.txt, art: row.art, root: row.root, node: { id: row.id, last_id: row.last_id, mrk: row.mrk } } : null;
}

/** A form written with a `<tld/>` somewhere in the examples, with its count. */
function tokenByNorm(
  db: SqlReader, norm: string
): { n: number; art: string; root: string; headword: string | null; node: KapNode | null } | null {
  if (!splitsStored(db)) return null;
  // one row per article the form was written under; the most frequent one names it
  const rows = db
    .query<{ n: number; art: string; root: string; headword: string | null; id: number | null; last_id: number | null; mrk: string | null }, [string]>(
      `SELECT t.n AS n, a.file AS art, a.rad AS root, k.txt AS headword, n.id AS id, n.last_id AS last_id, n.mrk AS mrk
         FROM x_token t
         JOIN article a ON a.id = t.article_id
         LEFT JOIN headword k ON k.id = t.lemma_kap_id
         LEFT JOIN node n ON n.id = k.node_id
        WHERE t.norm = ? ORDER BY t.n DESC, t.id`)
    .all(norm);
  if (rows.length === 0) return null;
  const [first] = rows;
  return {
    n: rows.reduce((s, r) => s + r.n, 0),
    art: first.art,
    root: first.root,
    headword: first.headword,
    node: first.id === null ? null : { id: first.id, last_id: first.last_id!, mrk: first.mrk },
  };
}

/**
 * How many times as often as a word the web must write its neighbour before
 * the neighbour is offered as what was meant. Of 12,267 forms the web writes
 * 200 times or more and the gloss calls derived, 2,817 got a suggestion
 * without counts and 471 at 30 (about 800 at 10, where real words like
 * `finado`, `kronigo` and `donadi` still got one); of 3,000 generated slips
 * the right word was offered for 1,483, against 1,471 without counts.
 */
const NEAR_USAGE_RATIO = 30;

/**
 * Words one letter away from `word` that the dictionary actually has, best
 * evidence first.
 *
 * Two kinds of slip are covered. A *substituted* letter is found by putting
 * every root within one edit of a prefix of the word in its place — this is
 * where the diacritic confusions land, `ĉanĝiĝis` → `ŝanĝiĝis`. A *dropped or
 * doubled* letter is found by deleting each character in turn, which is what
 * separates `finsita` from `finita`.
 *
 * Candidates that the corpus does not have are dropped, and the rest are
 * ranked by how well attested they are, not by the order the scan found them:
 * `finsita` leads with `finita`, a headword written ten times in the examples,
 * ahead of `fiksita`, which is only an inflection of one. An invented compound
 * like `makilaĵfaranto` gets no suggestion at all rather than a
 * plausible-looking one nobody has ever written.
 *
 * A database with usage counts (the `usage` pass) decides instead by how often
 * the web writes each word. A neighbour has to be written NEAR_USAGE_RATIO
 * times as often as the word itself, so a real word one letter from another
 * gets no question: `agado` (115,000 uses) is nobody's slip for `agaco`, while
 * `finsita`, which nobody writes, still gets `fiksita` and `finita`. The most
 * used neighbour comes first.
 */
function nearRoots(db: SqlReader, word: string, limit = 3): string[] {
  const scored = new Map<string, { tier: number; n: number }>();
  let checked = 0;
  const take = (guess: string) => {
    // a letter less than one letter is nothing, though an empty headword exists (korupteco's)
    if (!guess || guess === word || scored.has(guess) || ++checked > 40) return;
    const ev = evidence(db, guess);
    if (ev) scored.set(guess, ev);
  };

  const byLen = rootsByLength(db);
  for (let len = Math.min(word.length - 1, 9); len >= 3; len--) {
    const pre = word.slice(0, len);
    for (const cand of byLen.get(len) ?? []) {
      if (cand !== pre && differsByOne(pre, cand)) take(cand + word.slice(len));
    }
  }
  for (let i = 0; i < word.length; i++) take(word.slice(0, i) + word.slice(i + 1));

  const typed = webUsage(db, word);
  if (typed !== null) {
    const used = new Map([...scored.keys()].map((w) => [w, webUsage(db, w) ?? 0]));
    return [...used.keys()]
      .filter((w) => used.get(w)! >= NEAR_USAGE_RATIO * Math.max(typed, 1))
      .sort((a, b) => used.get(b)! - used.get(a)!)
      .slice(0, limit);
  }
  return [...scored.entries()]
    .sort((a, b) => a[1].tier - b[1].tier || b[1].n - a[1].n)
    .slice(0, limit)
    .map(([w]) => w);
}

/** True when the two equal-length strings differ in exactly one position. */
function differsByOne(a: string, b: string): boolean {
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i] && ++diff > 1) return false;
  }
  return diff === 1;
}

/**
 * How well the corpus backs this exact spelling: tier 0 a headword, tier 1 a
 * form the examples attest (`n` times), tier 2 a grammatical form of a
 * headword, null nothing at all.
 *
 * `class` candidates do not count as forms — `lemmaCandidates` offers `brula`
 * for `brulao` because they share a stem, but nobody writes `brulao`, and
 * counting it let that spelling be suggested as a real word.
 */
function evidence(db: SqlReader, word: string): { tier: number; n: number } | null {
  if (kapByNorm(db, word)) {
    const tok = tokenByNorm(db, word);
    return { tier: 0, n: tok?.n ?? 0 };
  }
  const tok = tokenByNorm(db, word);
  if (tok) return { tier: 1, n: tok.n };
  for (const c of lemmaCandidates(word)) {
    if (c.how !== "class" && kapByNorm(db, c.lemma)) return { tier: 2, n: 0 };
  }
  return null;
}

/**
 * Readings of the form root + suffix + ending that the cheapest segmentation
 * hides, longest suffix first.
 *
 * This is where the regular derivations the dictionary never lists come from:
 * ReVo has `legi` and the suffix `-end`, so `legenda` is a word even though no
 * article mentions it.
 */
function suffixReadings(word: string, inv: Inventory): Morph[][] {
  const m = /^(.{3,})(ojn|ajn|oj|aj|on|an|en|as|is|os|us|[oaieu])$/.exec(word);
  if (!m) return [];
  const [, stem, ending] = m;
  const out: Morph[][] = [];
  const suffixes = [...inv.suffixes].filter((s) => s.length >= 2 && stem.endsWith(s));
  suffixes.sort((a, b) => b.length - a.length);
  for (const suf of suffixes) {
    const base = stem.slice(0, stem.length - suf.length);
    if (base.length < 3 || !inv.roots.has(base)) continue;
    out.push([{ m: base, k: "R" }, { m: suf, k: "S" }, { m: ending, k: "E" }]);
  }
  return out;
}

/** Suffixes any verb takes: the participles and the three modal ones. */
const VERBAL = new Set(["ant", "int", "ont", "at", "it", "ot", "end", "ebl", "ind"]);

/**
 * Whether a root + suffix reading is one somebody would mean, not merely one
 * the inventory allows. `dolaroj` also parses as `dol|ar|oj`, a collection of
 * pains, and `vespera` as `vesp|er|a`; on a sample of 7,639 real words every
 * such reading was of that kind. The reading stands when the corpus writes
 * the root and suffix together, or the suffix is a verbal one on a root that
 * has a verb headword — `leg|end|a` is a word because `legi` is, whether or
 * not any article writes it.
 */
function grounded(db: SqlReader, inv: Inventory, ms: Morph[]): boolean {
  const [root, suf] = ms;
  if ((inv.pairs?.get(`${root.m}+${suf.m}`) ?? 0) > 0) return true;
  return VERBAL.has(suf.m) && kapByNorm(db, root.m + "i") !== null;
}

/** A word split under one article. */
interface Split {
  ms: Morph[];
  /** The article's file name, x-system, at times shortened (`distor`, `hxamel`). */
  art: string;
  /** The article's root as ReVo writes it (`distord`, `ĥameleon`) — what its root mark stands for. */
  root: string;
}

/**
 * The split of every headword spelled `norm`, one per article it is filed
 * under. Stored by the `splits` pass when the build ran it; otherwise
 * computed here with the article's root pinned. Multi-word headwords cannot
 * be one token of the text and are left out.
 */
function headwordSplits(db: SqlReader, norm: string, inv: Inventory): Split[] {
  if (splitsStored(db)) {
    // by way of the headwords, which are indexed by spelling; x_morph is keyed by their ids
    return db
      .query<{ seg: string; kinds: string; art: string; root: string }, [string]>(
        `SELECT m.seg AS seg, m.kinds AS kinds, a.file AS art, a.rad AS root
           FROM headword h JOIN x_morph m ON m.kap_id = h.id JOIN article a ON a.id = m.article_id
          WHERE h.norm = ? AND m.ok = 1 AND m.seg NOT LIKE '% %'
          ORDER BY m.node_id, m.kap_id`)
      .all(norm)
      .map((s) => ({ ms: relabel(parseSplit(s), inv), art: s.art, root: s.root }));
  }
  // the word itself: "-ul" is split as "ul", a two-word headword not at all
  const words = norm.match(EO_WORD) ?? [];
  if (words.length !== 1) return [];
  const out: Split[] = [];
  for (const r of db
    .query<{ id: number; art: string; root: string }, [string]>(
      `SELECT a.id AS id, a.file AS art, a.rad AS root FROM headword h JOIN node n ON n.id = h.node_id JOIN article a ON a.id = n.article_id
        WHERE h.norm = ? ORDER BY h.node_id, h.id`)
    .all(norm)) {
    const ms = pinnedSplit(words[0], articleRoots(db, r.id, r.root), inv);
    if (ms) out.push({ ms: relabel(ms, inv), art: r.art, root: r.root });
  }
  return out;
}

/** An article's roots, its own first, then the variants the inventory lists for it, longest first. */
function articleRoots(db: SqlReader, id: number, rad: string): string[] {
  const own = rad.toLowerCase();
  const inv = inventoryOf(db);
  const variants = inv instanceof CorpusInventory ? inv.articleRoots.get(id) ?? [] : [];
  return [own, ...variants.filter((r) => r !== own).sort((a, b) => b.length - a.length)];
}

/**
 * A headword split the way the `splits` pass would store it: the article's
 * root pinned where it occurs — the first of `roots` that does, exactly once,
 * where the free segmentation does not already read a longer root
 * (`sekvestracio` in `sekvestr`, `hejmo` in `he`); free when none does. The
 * pass also has the kap's own root mark to go by, which this has not, so the
 * two differ on a few hundred of the 49,000 headwords (see docs/corpus.md).
 */
export function pinnedSplit(word: string, roots: string[], inv: Inventory): Morph[] | null {
  const free = segment(word, inv);
  for (const root of roots) {
    const at = root ? word.indexOf(root) : -1;
    if (at < 0 || word === root || word.indexOf(root, at + 1) >= 0) continue;
    let off = 0;
    const longer = free?.some((m) => {
      const hit = (m.k === "R" || m.k === "W") && off === at && m.m.length > root.length;
      off += m.m.length;
      return hit;
    });
    return longer ? free : segment(word, inv, { at, root }) ?? free;
  }
  return free;
}

/** The splits stored for a form the examples write with a root mark, most frequent first; none without the `splits` pass. */
function attestedSplits(db: SqlReader, norm: string, inv: Inventory): Split[] {
  if (!splitsStored(db)) return [];
  return db
    .query<{ seg: string; kinds: string; art: string; root: string }, [string]>(
      `SELECT t.seg AS seg, t.kinds AS kinds, a.file AS art, a.rad AS root
         FROM x_token t JOIN article a ON a.id = t.article_id
        WHERE t.norm = ? AND t.ok = 1
        ORDER BY t.n DESC, t.id`)
    .all(norm)
    .map((s) => ({ ms: relabel(parseSplit(s), inv), art: s.art, root: s.root }));
}

const parseSplit = (s: { seg: string; kinds: string }): Morph[] =>
  s.seg.split("|").map((m, i) => ({ m, k: s.kinds[i] as MorphKind }));

/**
 * A pinned split with two kinds read differently from how the segmenter
 * stamped them.
 *
 * The span a root mark covers is a root, whatever the article: `farenda`,
 * under the `-end` article, splits as `far|end|a` with `end` a root. Read
 * here, a marked root that the inventory lists as a suffix is the suffix when
 * a root precedes it, and one it lists as a prefix is the prefix when a root
 * follows it — so the part is glossed from the affix article, "kiun oni devas
 * fari", not as the verb `endi`.
 *
 * A one-letter root between two roots is a linking vowel. The letters have
 * articles of their own (`e` is the name of the letter), so `artefarita` is
 * split as `art|e|far|it|a` with three roots; `e` joins the two, it is not a
 * third.
 */
export function relabel(ms: Morph[], inv: Inventory): Morph[] {
  const rootish = (x: Morph | undefined) => x !== undefined && (x.k === "R" || x.k === "W");
  for (let i = 0; i < ms.length; i++) {
    const { m, k } = ms[i];
    if (k !== "R") continue;
    const prev = ms[i - 1];
    const next = ms[i + 1];
    if (m.length === 1 && (rootish(prev) || prev?.k === "P") && rootish(next)) ms[i].k = "L";
    else if (inv.suffixes.has(m) && (rootish(prev) || prev?.k === "S")) ms[i].k = "S";
    else if (inv.prefixes.has(m) && (prev === undefined || prev.k === "P") && rootish(next)) ms[i].k = "P";
  }
  return ms;
}

/**
 * The dictionary form's split carried over to an inflected word: the
 * stem as filed, then whatever replaced the lemma's ending — the ending
 * alone (`skrib|is`), or a participle suffix and the ending (`ŝanĝ|it|a`).
 * Null when the word is not that stem plus a tail the inventory can name.
 */
function carryOver(lemma: Morph[], word: string, inv: Inventory): Morph[] | null {
  const base = lemma[lemma.length - 1].k === "E" ? lemma.slice(0, -1) : lemma;
  const stem = base.map((m) => m.m).join("");
  if (word.length <= stem.length || !word.startsWith(stem)) return null;
  const tail = tailMorphs(word.slice(stem.length), inv);
  return tail && [...base, ...tail];
}

/** `ita` → -it- -a, `ojn` → -ojn; null unless the tail is suffixes followed by an ending. */
function tailMorphs(tail: string, inv: Inventory): Morph[] | null {
  if (ENDINGS.has(tail) || tail === "n" || tail === "j" || tail === "jn") return [{ m: tail, k: "E" }];
  const fits = [...inv.suffixes].filter((s) => tail.length > s.length && tail.startsWith(s));
  fits.sort((a, b) => b.length - a.length);
  for (const s of fits) {
    const rest = tailMorphs(tail.slice(s.length), inv);
    if (rest) return [{ m: s, k: "S" }, ...rest];
  }
  return null;
}

/**
 * Distinct readings, the one with the longest root first.
 *
 * Each stored split honours the root its own article marks and guesses the
 * rest, so where several articles mark the same word the guesses can
 * disagree. A split that keeps whole the root another split was made for,
 * and more marked roots besides, is the better guess, and the other is
 * dropped: `hufofero` is `huf|o|fer|o` under `fer` and `huf|ofer|o` under
 * `huf`, and only the first has both `huf` and `fer` in it. Splits made for
 * different roots are all kept — `turdedoj` is `turded|oj` under `turded`
 * and `turd|ed|oj` under `turd`, and neither contains the other's root. A
 * one-letter mark (`birdoj` is written in the `o` article, `kolumbio` in
 * `-i`) is no evidence for a split, so it neither counts nor gets a reading
 * dropped.
 */
function readingsOf(db: SqlReader, rows: Split[]): Reading[] {
  const marks = new Set(rows.map((r) => r.root.toLowerCase()).filter((r) => r.length > 1));
  const keeps = (ms: Morph[]) => new Set([...marks].filter((root) => ms.some((m) => m.m === root)));
  const bySeg = new Map<string, { reading: Reading; keeps: Set<string>; own: Set<string> }>();
  for (const r of rows) {
    const f = formatSegments(r.ms);
    const hit = bySeg.get(f.seg);
    if (hit) hit.own.add(r.root.toLowerCase());
    else {
      bySeg.set(f.seg, {
        reading: { ...f, parts: partsOf(db, r.ms), art: fromXSystem(r.art) },
        keeps: keeps(r.ms),
        own: new Set([r.root.toLowerCase()]),
      });
    }
  }
  const all = [...bySeg.values()];
  const outdone = (a: { keeps: Set<string>; own: Set<string> }) =>
    all.some((b) =>
      b.keeps.size > a.keeps.size &&
      [...a.keeps].every((root) => b.keeps.has(root)) &&
      [...a.own].every((root) => b.keeps.has(root)));
  const longest = (r: Reading) =>
    Math.max(0, ...r.parts.filter((p) => p.k === "R" || p.k === "W").map((p) => p.m.length));
  return all
    .filter((x) => !outdone(x))
    .map((x) => x.reading)
    .sort((a, b) => longest(b) - longest(a));
}

/** The morphemes of a segmentation, each with what the corpus says about it. */
function partsOf(db: SqlReader, ms: Morph[]): Part[] {
  const affixes = affixesOf(db);
  return ms.map((m) => {
    const part: Part = { m: m.m, k: m.k };
    if (m.k === "P" || m.k === "S") {
      const a = affixes.get(m.m);
      if (a) {
        part.art = a.art;
        if (a.gloss) part.gloss = a.gloss;
        if (a.mrk) part.mrk = a.mrk;
      }
    } else if (m.k === "R" || m.k === "W") {
      const head = rootHeadword(db, m.m);
      if (head) {
        part.art = head.art;
        part.gloss = head.txt;
        if (head.mrk) part.mrk = head.mrk;
      }
    }
    return part;
  });
}

/**
 * Whether a segmentation is a word someone could have written.
 *
 * Measured over 72,358 real words (every headword plus every attested form)
 * and 4,000 one-letter mutations of them, of which 1,731 segment at all:
 *
 * | rule                      | real words kept | mutations kept |
 * |---------------------------|-----------------|----------------|
 * | anything that segments    | 100%            | 100%           |
 * | final ending              | 99.8%           | 80.5%          |
 * | + no 1-letter root        | 99.5%           | 54.9%          |
 * | + no root under 3 letters | 95.5%           | 26.2%          |
 *
 * The third row is the rule used. The numbers predate the pair evidence and
 * the retuned costs in `segment()`; the rule they justify did not change.
 * It applies to guesses only: a split the corpus stored is ReVo's and is
 * reported as it is. Tightening further costs real words —
 * `ĉirkaŭ|ir|ad|o` needs its two-letter root — and buys less than it looks,
 * because most of what survives is *legal*: `fin|sit|a` is a well-formed
 * compound of two real roots and merely the wrong word. Morphology cannot rule
 * that out, so the tool does not pretend to. It prints the parts, and names any
 * real word one letter away.
 */
export function plausible(ms: Morph[], word: string, inv: Inventory): boolean {
  const isRoot = (m: Morph) => m.k === "R" || m.k === "W";
  const roots = ms.filter(isRoot);
  if (roots.length === 0 || roots.length > 3) return false;
  if (roots.some((m) => m.m.length < 2)) return false;
  const last = ms[ms.length - 1];
  return last.k === "E" || (ms.length === 1 && inv.words.has(word));
}

export function glossEsperanto(db: SqlReader, text: string, opts: GlossOptions = {}): EoGloss {
  const maxWords = opts.maxWords ?? 120;
  const inv = inventoryOf(db);

  const tokens = [...text.matchAll(EO_WORD)].map((m) => m[0]);
  const counts = new Map<string, number>();
  const order: string[] = [];
  for (const w of tokens) {
    const k = normalizeQuery(w);
    if (!k) continue;
    if (!counts.has(k)) order.push(k);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }

  const terms: EoTerm[] = [];
  const tally: Record<Verdict, number> = { headword: 0, inflection: 0, attested: 0, derived: 0, unknown: 0 };
  for (const word of order.slice(0, maxWords)) {
    const term = classify(db, word, inv, opts.languages);
    term.n = counts.get(word)!;
    tally[term.verdict]++;
    terms.push(term);
  }

  return {
    mode: "eo",
    words: tokens.length,
    terms,
    counts: tally,
    truncated: Math.max(0, order.length - maxWords),
  };
}

/**
 * One word's standing in the corpus, cheapest evidence first: a headword, an
 * inflection of one, a form the examples attest, a word the inventory can
 * build out of known morphemes, or nothing.
 *
 * A word the corpus has is split with its own article's root pinned, or as
 * the build stored it; the segmenter only guesses freely when there is no
 * article to go by. Every verdict but
 * `headword` also carries the reading a long root hides, when there is one,
 * since that is what tells a translator whether an unlisted word is well
 * formed.
 *
 * A word the dictionary has names its entry by mark, and with `languages`
 * lists the entry's translations in them, so a reader can show what the word
 * means without a second call.
 */
export function classify(db: SqlReader, word: string, inv: Inventory, languages?: string[]): EoTerm {
  let guess: { ms: Morph[]; seg: string; kinds: string } | null | undefined;

  /** The entry a dictionary form belongs to, and what it says in the languages asked for. */
  const withEntry = (term: EoTerm, node: KapNode | null): EoTerm => {
    if (!node?.mrk) return term;
    term.mrk = node.mrk;
    if (languages) term.translations = translationsOf(db, node, languages);
    return term;
  };
  const guessed = () => {
    if (guess === undefined) {
      const ms = segment(word, inv);
      guess = ms && plausible(ms, word, inv) ? { ms, ...formatSegments(ms) } : null;
    }
    return guess;
  };

  /** Attach the stored readings, or failing those a guess, plus any reading a long root hides. */
  const withMorph = (term: EoTerm, readings: Reading[], root?: string): EoTerm => {
    const seen = new Set<string>();
    if (readings.length > 0) {
      const [first] = readings;
      Object.assign(term, { seg: first.seg, kinds: first.kinds, parts: first.parts, readings });
      for (const r of readings) seen.add(r.seg);
    } else {
      const morph = guessed();
      if (morph) {
        term.seg = morph.seg;
        term.kinds = morph.kinds;
        term.parts = partsOf(db, morph.ms);
        seen.add(morph.seg);
        const roots = morph.ms.filter((m) => m.k === "R").map((m) => m.m);
        if (root && roots.length > 0 && !roots.includes(root.toLowerCase())) term.altReading = true;
      }
    }
    if (term.verdict === "headword") return term;
    for (const alt of suffixReadings(word, inv)) {
      const f = formatSegments(alt);
      if (seen.has(f.seg) || !grounded(db, inv, alt)) continue;
      term.also = { ...f, parts: partsOf(db, alt) };
      break;
    }
    return term;
  };

  // The examples can write a headword under another article with a root mark
  // of their own — turdedoj is a headword on the root turded and is written
  // in the turd article as turd|ed|oj — so their splits join the readings
  // whatever the verdict.
  const attested = () => attestedSplits(db, word, inv);

  const exact = kapByNorm(db, word);
  if (exact) {
    return withMorph(
      withEntry({ word, n: 1, verdict: "headword", headword: exact.txt, art: exact.art }, exact.node),
      readingsOf(db, [...headwordSplits(db, word, inv), ...attested()])
    );
  }

  for (const c of lemmaCandidates(word)) {
    const hit = kapByNorm(db, c.lemma);
    if (hit) {
      const rows: Split[] = [];
      for (const s of headwordSplits(db, c.lemma, inv)) {
        const ms = carryOver(s.ms, word, inv);
        if (ms) rows.push({ ms, art: s.art, root: s.root });
      }
      return withMorph(
        withEntry({ word, n: 1, verdict: "inflection", headword: hit.txt, art: hit.art, how: c.how }, hit.node),
        readingsOf(db, [...rows, ...attested()]),
        hit.root
      );
    }
  }

  const tok = tokenByNorm(db, word);
  if (tok) {
    const term: EoTerm = { word, n: 1, verdict: "attested", attested: tok.n, art: tok.art };
    if (tok.headword) term.headword = tok.headword;
    return withMorph(withEntry(term, tok.node), readingsOf(db, attested()), tok.root);
  }

  const morph = guessed();
  if (morph) {
    // a legal formation can still be a slip of the finger: `finsita` is a real
    // compound of `fin` and `sit`, and one letter from `finita`
    const term: EoTerm = {
      word, n: 1, verdict: "derived", seg: morph.seg, kinds: morph.kinds, parts: partsOf(db, morph.ms),
    };
    const near = nearRoots(db, word, 2);
    if (near.length > 0) term.near = near;
    return term;
  }

  return { word, n: 1, verdict: "unknown", near: nearRoots(db, word) };
}
