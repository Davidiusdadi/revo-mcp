/**
 * Pass `morph`: lexicon-driven morphology (src/morph.ts does the work).
 *
 * - x_morpheme: the inventory — article roots (and `<rad var>` roots), prefixes
 *   and suffixes from the affix articles (kap "mal-", "-ul"), the endings,
 *   and endingless words (drv kap = bare root: ĉar, hodiaŭ, kiu).
 * - x_morph: a segmentation of every headword, the root pinned where the kap
 *   marks it (`<tld/>`, or the "/" after an article's root).
 * - x_token: every distinct word written with a `<tld/>` outside headwords,
 *   with the article whose root it carries (author-marked), its segmentation,
 *   and the headword of that article it inflects, when there is one.
 * - x_pair: which morphemes the corpus writes next to a marked root, and how
 *   often — evidence for the words that have no mark.
 *
 * The words with a mark are split first; the pairs read off them then price
 * the splits of the words without one.
 */
import type { Database } from "bun:sqlite";
import type { Pass } from "../pass";
import { lemmaCandidates, segment, formatSegments, pinFits, ENDINGS, type Inventory, type Morph } from "../../morph";

const WORD = /\p{L}+/gu;
/** Articles for grammatical endings, not word-building affixes. */
const GRAMMATICAL: ReadonlySet<string> = new Set(["o", "a", "e", "i", "u", "as", "is", "os", "us", "j", "n"]);

export const morphPass: Pass = {
  name: "morph",
  version: 4,
  tables: ["x_morpheme", "x_morph", "x_token", "x_pair"],
  run(db, log) {
    const inv = buildInventory(db);
    const nInv = writeInventory(db, inv);
    log(`x_morpheme: ${inv.roots.size} roots, ${inv.prefixes.size} prefixes, ${inv.suffixes.size} suffixes, ${inv.words.size} endingless words`);
    const pairs = new Pairs();
    const heads = segmentHeadwords(db, inv, pairs, log);
    const toks = attestedTokens(db, inv, pairs, log);
    const nPair = writePairs(db, pairs, log);
    inv.pairs = pairs.counts;
    const nMorph = heads.free(inv);
    const nTok = toks.free(inv);
    return nInv + nMorph + nTok + nPair;
  },
};

interface Built extends Inventory {
  rootArts: Map<string, number[]>;
  /** derivations per article */
  drv: Map<number, number>;
}

export function buildInventory(db: Database): Built {
  const roots = new Set<string>(), prefixes = new Set<string>(), suffixes = new Set<string>(), words = new Set<string>();
  const rootArts = new Map<string, number[]>();
  const drv = new Map<number, number>();
  const rootWeight = new Map<string, number>();
  for (const r of db.query<{ art_id: number; n: number }, []>(
    "SELECT art_id, COUNT(*) n FROM node WHERE kind IN ('drv','subdrv') GROUP BY art_id").iterate()) drv.set(r.art_id, r.n);
  const addRoot = (r: string, art: number) => {
    r = r.toLowerCase();
    if (!r) return;
    roots.add(r);
    const a = rootArts.get(r) ?? [];
    if (a.includes(art)) return;
    a.push(art);
    rootArts.set(r, a);
    rootWeight.set(r, (rootWeight.get(r) ?? 0) + (drv.get(art) ?? 0));
  };
  for (const a of db.query<{ id: number; rad: string; xml: string }, []>("SELECT id, rad, xml FROM art").iterate()) {
    addRoot(a.rad, a.id);
    for (const m of a.xml.matchAll(/<rad var="[^"]*">([^<]*)<\/rad>/g)) addRoot(m[1].trim(), a.id);
  }
  // affix articles: kap "mal-" / "-ul"; the ending articles ("-o", "-as", "-j") are not
  // affixes, but "-an" and "-on" are (member, fraction) even though they spell endings too
  for (const k of db.query<{ txt: string }, []>(
    "SELECT DISTINCT txt FROM kap WHERE (txt LIKE '-%' OR txt LIKE '%-') AND txt NOT LIKE '% %'").iterate()) {
    const m = k.txt.toLowerCase().replace(/^-|-$/g, "");
    if (!m || GRAMMATICAL.has(m)) continue;
    if (k.txt.endsWith("-") && !k.txt.startsWith("-")) prefixes.add(m);
    else if (k.txt.startsWith("-") && !k.txt.endsWith("-")) suffixes.add(m);
  }
  // endingless words: a derivation whose headword is the bare root
  for (const k of db.query<{ norm: string }, []>(
    `SELECT DISTINCT k.norm FROM kap k JOIN node n ON n.id = k.node_id
     WHERE n.kind IN ('drv','subdrv') AND k.tilde = '~'`).iterate()) {
    if (/^\p{L}+$/u.test(k.norm)) words.add(k.norm);
  }
  return { roots, prefixes, suffixes, words, rootArts, drv, rootWeight };
}

function writeInventory(db: Database, inv: Built): number {
  db.run(`
    CREATE TABLE x_morpheme (
      morph  TEXT NOT NULL,
      kind   TEXT NOT NULL,      -- R root · P prefix · S suffix · E ending · W endingless word
      art_id INTEGER,            -- for roots: the article (homonym articles share a root)
      drv    INTEGER             -- for roots: derivations in that article
    )`);
  const ins = db.prepare("INSERT INTO x_morpheme VALUES (?,?,?,?)");
  let n = 0;
  for (const [r, arts] of inv.rootArts) for (const a of arts) { ins.run(r, "R", a, inv.drv.get(a) ?? 0); n++; }
  for (const [kind, set] of [["P", inv.prefixes], ["S", inv.suffixes], ["E", ENDINGS], ["W", inv.words]] as const) {
    for (const m of set) { ins.run(m, kind, null, null); n++; }
  }
  db.run("CREATE INDEX idx_x_morpheme ON x_morpheme(morph, kind)");
  return n;
}

/**
 * Counts of the morphemes written on either side of a marked root: "dis"
 * before "port", "ist" after it. Only those two neighbours, because the rest
 * of a pinned split is the segmenter's own guess, and its guesses must not
 * become its evidence (a wrong "mon|tar" in montarĉeno would teach it to split
 * montaro the same way). A derivation and its inflections count once.
 */
export class Pairs {
  readonly counts = new Map<string, number>();
  private readonly seen = new Set<string>();
  add(ms: Morph[], at: number) {
    const core = ms.filter((m) => m.k !== "E");
    const stem = core.map((m) => m.m).join("|");
    if (this.seen.has(stem)) return;
    this.seen.add(stem);
    let off = 0;
    for (let i = 0; i < core.length; off += core[i++].m.length) {
      if (off !== at) continue;
      if (i > 0) this.bump(core[i - 1].m, core[i].m);
      if (i + 1 < core.length) this.bump(core[i].m, core[i + 1].m);
      return;
    }
  }
  private bump(a: string, b: string) {
    const k = `${a}+${b}`;
    this.counts.set(k, (this.counts.get(k) ?? 0) + 1);
  }
}

function writePairs(db: Database, pairs: Pairs, log: (m: string) => void): number {
  db.run(`
    CREATE TABLE x_pair (
      a TEXT NOT NULL,            -- the morpheme before
      b TEXT NOT NULL,            -- the morpheme after
      n INTEGER NOT NULL          -- pinned splits (one per derivation) that write them side by side
    )`);
  const ins = db.prepare("INSERT INTO x_pair VALUES (?,?,?)");
  for (const [k, n] of pairs.counts) {
    const [a, b] = k.split("+");
    ins.run(a, b, n);
  }
  db.run("CREATE INDEX idx_x_pair ON x_pair(a, b)");
  log(`x_pair: ${pairs.counts.size} morpheme pairs next to a marked root`);
  return pairs.counts.size;
}

/** Segment every word of `form`; the word equal to `fixed.word` gets its root pinned. */
function segmentForm(form: string, inv: Inventory, fixed?: { word: string; at: number; root: string }, pairs?: Pairs) {
  const segs: string[] = [], kinds: string[] = [], roots: string[] = [];
  let ok = true;
  let pinned = false;
  for (const [w] of form.matchAll(WORD)) {
    const candidate = fixed && !pinned && w === fixed.word ? { at: fixed.at, root: fixed.root } : undefined;
    // segment() ignores a pin the word does not bear; say so here too, so the
    // recorded source ("tilde" vs "free") is what actually happened.
    const pin = candidate && pinFits(w, candidate) ? candidate : undefined;
    if (pin) pinned = true;
    const s: Morph[] | null = segment(w, inv, pin);
    if (!s) {
      ok = false;
      segs.push(w);
      kinds.push("?");
      continue;
    }
    if (pin) pairs?.add(s, pin.at);
    const f = formatSegments(s);
    segs.push(f.seg);
    kinds.push(f.kinds);
    roots.push(...s.filter((x) => x.k === "R").map((x) => x.m));
  }
  return { seg: segs.join(" "), kinds: kinds.join(" "), roots: roots.join(" "), ok, pinned };
}

/** Does `fixed` pin a word of `form`? Mirrors what segmentForm will do with it. */
const pins = (form: string, fixed?: { word: string; at: number; root: string }) =>
  !!fixed && [...form.matchAll(WORD)].some(([w]) => w === fixed.word && pinFits(w, fixed));

/** The rows a segmenting function put off until the pairs exist. */
interface Deferred {
  free(inv: Inventory): number;
}

function segmentHeadwords(db: Database, inv: Inventory, pairs: Pairs, log: (m: string) => void): Deferred {
  db.run(`
    CREATE TABLE x_morph (
      kap_id  INTEGER PRIMARY KEY,
      node_id INTEGER NOT NULL,
      art_id  INTEGER NOT NULL,
      form    TEXT NOT NULL,         -- kap.norm
      seg     TEXT NOT NULL,         -- "mal|san|ul|ej|o", words separated by " "
      kinds   TEXT NOT NULL,         -- "PRSSE" per word; "?" where the inventory could not cover it
      roots   TEXT NOT NULL,         -- the R morphemes, space-separated
      source  TEXT NOT NULL,         -- tilde: root pinned by the kap (or found once in it) · free: inventory only
      ok      INTEGER NOT NULL       -- every word fully segmented
    )`);
  // the kap's own <tld/> tells where the root sits
  const marked = new Map<number, { word: string; at: number; root: string }>();
  for (const o of db.query<{ owner_id: number; pre: string; rad: string; norm: string }, []>(
    "SELECT owner_id, pre, rad, norm FROM x_tld_occ WHERE owner_kind = 'kap' ORDER BY owner_id, ord").iterate()) {
    if (!marked.has(o.owner_id)) marked.set(o.owner_id, { word: o.norm, at: o.pre.length, root: o.rad.toLowerCase() });
  }
  const ins = db.prepare("INSERT INTO x_morph VALUES (?,?,?,?,?,?,?,?,?)");
  type Kap = { id: number; node_id: number; art_id: number; norm: string; tilde: string; rad: string };
  const later: Kap[] = [];
  let n = 0, ok = 0, pinned = 0;
  const write = (k: Kap, inv: Inventory, pin?: { word: string; at: number; root: string }) => {
    const r = segmentForm(k.norm, inv, pin, pairs);
    ins.run(k.id, k.node_id, k.art_id, k.norm, r.seg, r.kinds, r.roots, r.pinned ? "tilde" : "free", +r.ok);
    n++;
    if (r.ok) ok++;
    if (r.pinned) pinned++;
  };
  for (const k of db.query<Kap, []>(
    "SELECT k.id, k.node_id, n.art_id, k.norm, k.tilde, a.rad FROM kap k JOIN node n ON n.id = k.node_id JOIN art a ON a.id = n.art_id").iterate()) {
    let pin = marked.get(k.id);
    // article kap "san/a": the root ends at the "/"
    const slash = k.tilde.indexOf("/");
    if (!pin && slash > 0 && !k.tilde.slice(0, slash).includes(" ")) {
      const root = k.tilde.slice(0, slash).toLowerCase().replace(/^-/, "");
      const word = k.norm.match(WORD)?.find((w) => w.startsWith(root));
      if (word) pin = { word, at: 0, root };
    }
    // a kap written out in full ("hufofero" in fer): the article's root, where it
    // occurs exactly once — twice ("ferfero") would leave the choice to the segmenter
    const root = k.rad.toLowerCase();
    if (!pin && root) {
      const at = k.norm.indexOf(root);
      const word = at >= 0 && k.norm.indexOf(root, at + 1) < 0 ? k.norm.match(WORD)?.find((w) => w.includes(root)) : undefined;
      if (word && word !== root) {
        const cand = { word, at: word.indexOf(root), root };
        // a longer root starting there is a word of its own (sekvestraci over sekvestr, hej over he)
        let off = 0;
        const longer = segment(word, inv)?.some((m) => {
          const hit = (m.k === "R" || m.k === "W") && off === cand.at && m.m.length > root.length;
          off += m.m.length;
          return hit;
        });
        if (!longer) pin = cand;
      }
    }
    if (pins(k.norm, pin)) write(k, inv, pin);
    else later.push(k);
  }
  return {
    free(inv) {
      for (const k of later) write(k, inv);
      log(`x_morph: ${n} headwords, ${ok} fully segmented (${pct(ok, n)}), root pinned in ${pinned}`);
      return n;
    },
  };
}

/**
 * One row per distinct form per article: the form, how often it occurs, and
 * where the tilde puts the root.
 *
 * pre and rad have to come from the same occurrence: a prefix taken from one
 * row and a root from another pin a span that no row has — that is how
 * "ĉevalo" came out as "ĉeva|lo", the pin being the empty prefix of one
 * occurrence with the root of a `lit`-capitalised one ("eval"). With exactly
 * one min/max aggregate in the query SQLite takes the bare columns from the
 * row it picked, so MIN(id) makes that the first occurrence. Exported so the
 * test can hold the pin against the occurrences it came from.
 */
export const TOKEN_GROUPS = `SELECT norm, art_id, COUNT(*) n, pre, rad, MIN(id) AS first_id
    FROM x_tld_occ WHERE owner_kind <> 'kap' AND norm <> '' GROUP BY norm, art_id`;

function attestedTokens(db: Database, inv: Inventory, pairs: Pairs, log: (m: string) => void): Deferred {
  db.run(`
    CREATE TABLE x_token (
      id      INTEGER PRIMARY KEY,
      norm    TEXT NOT NULL,          -- the word as written with <tld/>, lowercased
      art_id  INTEGER NOT NULL,       -- the article whose root the tilde stands for
      n       INTEGER NOT NULL,       -- occurrences
      seg     TEXT NOT NULL,
      kinds   TEXT NOT NULL,
      ok      INTEGER NOT NULL,
      lemma_kap_id INTEGER,           -- the headword of that article it is a form of
      how     TEXT                    -- kap (is the headword) · infl · class · ptcp
    )`);
  const heads = new Map<number, Map<string, number>>();
  for (const k of db.query<{ art_id: number; norm: string; id: number }, []>(
    "SELECT n.art_id, k.norm, k.id FROM kap k JOIN node n ON n.id = k.node_id ORDER BY k.id").iterate()) {
    const m = heads.get(k.art_id) ?? new Map<string, number>();
    if (!m.has(k.norm)) m.set(k.norm, k.id);
    heads.set(k.art_id, m);
  }
  const ins = db.prepare("INSERT INTO x_token (norm, art_id, n, seg, kinds, ok, lemma_kap_id, how) VALUES (?,?,?,?,?,?,?,?)");
  type Tok = { norm: string; art_id: number; n: number; pre: string; rad: string };
  const later: Tok[] = [];
  let n = 0, ok = 0, lemma = 0;
  const write = (t: Tok, inv: Inventory, pin?: { word: string; at: number; root: string }) => {
    const s = segmentForm(t.norm, inv, pin, pairs);
    const h = heads.get(t.art_id);
    let kap: number | undefined, how: string | null = null;
    if (h?.has(t.norm)) [kap, how] = [h.get(t.norm), "kap"];
    else for (const c of lemmaCandidates(t.norm)) {
      if (h?.has(c.lemma)) { [kap, how] = [h.get(c.lemma), c.how]; break; }
    }
    ins.run(t.norm, t.art_id, t.n, s.seg, s.kinds, +s.ok, kap ?? null, how);
    n++;
    if (s.ok) ok++;
    if (kap !== undefined) lemma++;
  };
  for (const t of db.query<Tok, []>(TOKEN_GROUPS).iterate()) {
    const pin = { word: t.norm, at: t.pre.length, root: t.rad.toLowerCase() };
    if (pins(t.norm, pin)) write(t, inv, pin);
    else later.push(t);
  }
  return {
    free(inv) {
      for (const t of later) write(t, inv);
      db.run("CREATE INDEX idx_x_token_norm ON x_token(norm)");
      log(`x_token: ${n} attested forms, ${ok} fully segmented (${pct(ok, n)}), ${lemma} tied to a headword (${pct(lemma, n)})`);
      return n;
    },
  };
}

const pct = (a: number, b: number) => `${((100 * a) / Math.max(1, b)).toFixed(1)}%`;
