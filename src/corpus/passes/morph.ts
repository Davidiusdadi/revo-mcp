/**
 * Pass `morph`: lexicon-driven morphology (src/morph.ts does the work).
 *
 * - x_morpheme: the inventory — article roots (and `<rad var>` roots; not the
 *   ending articles "-is", nor exclamations that derive nothing "eh"),
 *   prefixes and suffixes from the affix articles (kap "mal-", "-ul"), the
 *   endings, and endingless words (drv kap = bare root: ĉar, hodiaŭ, kiu).
 * - x_morph: a segmentation of every headword, the root pinned where the kap
 *   marks it (`<tld/>`, or the "/" after an article's root).
 * - x_token: every distinct word written with a `<tld/>` outside headwords,
 *   with the article whose root it carries (author-marked), its segmentation,
 *   and the headword of that article it inflects, when there is one.
 * - x_pair: which morphemes the corpus writes next to a marked root, and how
 *   often — evidence for the words that have no mark.
 *
 * The words with a mark are split first, without evidence, to read the pairs
 * off them; then every word is split and stored with the pairs in hand.
 */
import type { Database } from "bun:sqlite";
import { kapForms, outerXml } from "voko-xml";
import type { Pass } from "../pass";
import { idOf } from "../../articles";
import { contentOf } from "../../content";
import { articleTrees } from "../documents";
import { lemmaCandidates, segment, formatSegments, pinFits, ENDINGS, type Inventory, type Morph, type WordClass } from "../../morph";

const WORD = /\p{L}+/gu;
/** Articles for grammatical endings, not word-building affixes. */
const GRAMMATICAL: ReadonlySet<string> = new Set(["o", "a", "e", "i", "u", "as", "is", "os", "us", "j", "n"]);

export const morphPass: Pass = {
  name: "morph",
  version: 9,
  tables: ["x_morpheme", "x_morph", "x_token", "x_pair"],
  run(db, log) {
    const inv = buildInventory(db);
    const nInv = writeInventory(db, inv);
    log(`x_morpheme: ${inv.roots.size} roots, ${inv.prefixes.size} prefixes, ${inv.suffixes.size} suffixes, ${inv.words.size} endingless words`);
    const pairs = new Pairs();
    const heads = segmentHeadwords(db, inv, inv.tildes, pairs, log);
    const toks = attestedTokens(db, inv, pairs, log);
    const nPair = writePairs(db, pairs, log);
    inv.pairs = pairs.counts;
    const nMorph = heads.write(inv);
    const nTok = toks.write(inv);
    return nInv + nMorph + nTok + nPair;
  },
};

interface Built extends Inventory {
  rootArts: Map<string, number[]>;
  /** word class counts as they are stored: by "root@article", the article whose own root it is */
  classRows: Map<string, WordClass>;
  /** derivations per article */
  drv: Map<number, number>;
  /** every headword's display form, root marked ("mal~ulejo", "san/a"), by its id */
  tildes: Map<number, string>;
}

export function buildInventory(db: Database): Built {
  const roots = new Set<string>(), prefixes = new Set<string>(), suffixes = new Set<string>(), words = new Set<string>();
  const rootArts = new Map<string, number[]>();
  const drv = new Map<number, number>();
  const rootWeight = new Map<string, number>();
  const tildes = new Map<number, string>();
  const classes = new Map<string, WordClass>();
  const classRows = new Map<string, WordClass>();
  /**
   * Word class of a root: the headwords that are the root plus one vowel — an
   * article's own kap ("hund/o") and the derivations written "~o", "~a", "~e",
   * "~i". No segmentation is involved, so it says what ReVo builds on the
   * root, not what we guess. Counted per article as well, because that is the
   * row the count is stored on.
   */
  const addClass = (rad: string, art: number, tilde: string) => {
    const r = rad.toLowerCase(), t = tilde.toLowerCase();
    let v: keyof WordClass | null = null;
    if (/^~[oaei]$/.test(t)) v = t[1] as keyof WordClass;
    else if (t.length === r.length + 2 && t.startsWith(`${r}/`) && "oaei".includes(t[t.length - 1])) v = t[t.length - 1] as keyof WordClass;
    if (!r || !v) return;
    for (const [m, key] of [[classes, r], [classRows, `${r}@${art}`]] as const) {
      const c = m.get(key) ?? { o: 0, a: 0, e: 0, i: 0 };
      c[v]++;
      m.set(key, c);
    }
  };
  for (const r of db.query<{ article_id: number; n: number }, []>(
    "SELECT article_id, COUNT(*) n FROM node WHERE kind IN ('drv','subdrv') GROUP BY article_id").iterate()) drv.set(r.article_id, r.n);
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
  // the ending articles ("-is": the past tense) have a root column like any
  // other, but is/as/n/j are not roots: read as one, "is" could sit inside a
  // word and esperant|is|oj would pass
  const endingArts = new Set(db.query<{ id: number }, []>(
    `SELECT n.article_id id FROM node n JOIN headword h ON h.node_id = n.id
     WHERE n.kind = 'art' AND h.txt LIKE '-%'`).all().map((r) => r.id));
  // An article that is only an exclamation or a sound ("eh", "brr", "kva":
  // marked ekkrio/sonimit, nothing derived from it) has a root column too, but
  // an exclamation does not join other roots: mult|eh|ar|a is no reading of
  // multehara. Exclamations ReVo builds on (pafi, halti, jesi) stay roots.
  const EXCLAMATION = /<vspec>(ekkrio|sonimito)<\/vspec>/;
  for (const { article, art, roots: articleRoots, nodes } of articleTrees(db)) {
    // endingless words: a derivation whose headword is the bare root
    for (const n of nodes) {
      for (const c of contentOf(n.el)) {
        if (c.el.name !== "kap") continue;
        const forms = kapForms(c.el, articleRoots);
        tildes.set(idOf(c.el)!, forms.tilde);
        addClass(article.rad, article.id, forms.tilde);
        if ((n.kind === "drv" || n.kind === "subdrv") && forms.tilde === "~" && /^\p{L}+$/u.test(forms.norm)) words.add(forms.norm);
      }
    }
    const rad = article.rad;
    const xml = outerXml(art);
    if (endingArts.has(article.id) && GRAMMATICAL.has(rad.toLowerCase())) continue;
    if (EXCLAMATION.test(xml) && (drv.get(article.id) ?? 0) <= 1) continue;
    addRoot(rad, article.id);
    for (const m of xml.matchAll(/<rad var="[^"]*">([^<]*)<\/rad>/g)) addRoot(m[1].trim(), article.id);
  }
  // affix articles: kap "mal-" / "-ul"; the ending articles ("-o", "-as", "-j") are not
  // affixes, but "-an" and "-on" are (member, fraction) even though they spell endings too
  for (const k of db.query<{ txt: string }, []>(
    "SELECT DISTINCT txt FROM headword WHERE (txt LIKE '-%' OR txt LIKE '%-') AND txt NOT LIKE '% %'").iterate()) {
    const m = k.txt.toLowerCase().replace(/^-|-$/g, "");
    if (!m || GRAMMATICAL.has(m)) continue;
    if (k.txt.endsWith("-") && !k.txt.startsWith("-")) prefixes.add(m);
    else if (k.txt.startsWith("-") && !k.txt.endsWith("-")) suffixes.add(m);
  }
  return { roots, prefixes, suffixes, words, rootArts, drv, rootWeight, tildes, classes, classRows };
}

function writeInventory(db: Database, inv: Built): number {
  db.run(`
    CREATE TABLE x_morpheme (
      morph  TEXT NOT NULL,
      kind   TEXT NOT NULL,      -- R root · P prefix · S suffix · E ending · W endingless word
      article_id INTEGER,        -- for roots: the article (homonym articles share a root)
      drv    INTEGER,            -- for roots: derivations in that article
      o INTEGER, a INTEGER, e INTEGER, i INTEGER  -- for roots: headwords of that class ("~o", "hund/o")
    )`);
  const ins = db.prepare("INSERT INTO x_morpheme VALUES (?,?,?,?,?,?,?,?)");
  let n = 0;
  for (const [r, arts] of inv.rootArts) for (const a of arts) {
    // the class counts sit on the article whose own root this is, so that
    // summing the rows of a root counts each headword once
    const c = inv.classRows.get(`${r}@${a}`) ?? { o: 0, a: 0, e: 0, i: 0 };
    ins.run(r, "R", a, inv.drv.get(a) ?? 0, c.o, c.a, c.e, c.i);
    n++;
  }
  for (const [kind, set] of [["P", inv.prefixes], ["S", inv.suffixes], ["E", ENDINGS], ["W", inv.words]] as const) {
    for (const m of set) { ins.run(m, kind, null, null, null, null, null, null); n++; }
  }
  db.run("CREATE INDEX idx_x_morpheme ON x_morpheme(morph, kind)");
  return n;
}

/**
 * Counts of the morphemes written on either side of a marked root: "dis"
 * before "port", "ist" after it. Only those two neighbours, because the rest
 * of a pinned split is the segmenter's own guess, and its guesses must not
 * become its evidence (a wrong "mon|tar" in montarĉeno would teach it to split
 * montaro the same way). A derivation and its inflections count once per
 * marked root.
 */
export class Pairs {
  readonly counts = new Map<string, number>();
  private readonly seen = new Set<string>();
  add(ms: Morph[], at: number) {
    const core = ms.filter((m) => m.k !== "E");
    // one count per derivation and pin: artefarita is filed under art and
    // under far, and each mark vouches for its own neighbours (art+e, e+far)
    const stem = `${core.map((m) => m.m).join("|")}@${at}`;
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

/** A segmenting function's rows, written once the pairs exist. */
interface Deferred {
  write(inv: Inventory): number;
}

function segmentHeadwords(
  db: Database, inv: Inventory, tildes: Map<number, string>, pairs: Pairs, log: (m: string) => void,
): Deferred {
  db.run(`
    CREATE TABLE x_morph (
      kap_id  INTEGER PRIMARY KEY,
      node_id INTEGER NOT NULL,
      article_id INTEGER NOT NULL,
      form    TEXT NOT NULL,         -- headword.norm
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
  type Kap = { id: number; node_id: number; article_id: number; norm: string; rad: string };
  type Pin = { word: string; at: number; root: string };
  const rows: { k: Kap; pin?: Pin }[] = [];
  let n = 0, ok = 0, pinned = 0;
  const write = (k: Kap, inv: Inventory, pin?: Pin) => {
    const r = segmentForm(k.norm, inv, pin);
    ins.run(k.id, k.node_id, k.article_id, k.norm, r.seg, r.kinds, r.roots, r.pinned ? "tilde" : "free", +r.ok);
    n++;
    if (r.ok) ok++;
    if (r.pinned) pinned++;
  };
  for (const k of db.query<Kap, []>(
    `SELECT h.id, h.node_id, n.article_id, h.norm, a.rad FROM headword h
       JOIN node n ON n.id = h.node_id JOIN article a ON a.id = n.article_id ORDER BY h.id`).iterate()) {
    let pin = marked.get(k.id);
    // article kap "san/a": the root ends at the "/"
    const tilde = tildes.get(k.id)!;
    const slash = tilde.indexOf("/");
    if (!pin && slash > 0 && !tilde.slice(0, slash).includes(" ")) {
      const root = tilde.slice(0, slash).toLowerCase().replace(/^-/, "");
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
    // first round, evidence-free: the neighbours of the pinned root are the pairs
    if (pins(k.norm, pin)) segmentForm(k.norm, inv, pin, pairs);
    rows.push({ k, pin });
  }
  return {
    write(inv) {
      for (const { k, pin } of rows) write(k, inv, pin);
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
export const TOKEN_GROUPS = `SELECT norm, article_id, COUNT(*) n, pre, rad, MIN(id) AS first_id
    FROM x_tld_occ WHERE owner_kind <> 'kap' AND norm <> '' GROUP BY norm, article_id`;

function attestedTokens(db: Database, inv: Inventory, pairs: Pairs, log: (m: string) => void): Deferred {
  db.run(`
    CREATE TABLE x_token (
      id      INTEGER PRIMARY KEY,
      norm    TEXT NOT NULL,          -- the word as written with <tld/>, lowercased
      article_id INTEGER NOT NULL,    -- the article whose root the tilde stands for
      n       INTEGER NOT NULL,       -- occurrences
      seg     TEXT NOT NULL,
      kinds   TEXT NOT NULL,
      ok      INTEGER NOT NULL,
      lemma_kap_id INTEGER,           -- the headword of that article it is a form of
      how     TEXT                    -- kap (is the headword) · infl · class · ptcp
    )`);
  const heads = new Map<number, Map<string, number>>();
  for (const k of db.query<{ article_id: number; norm: string; id: number }, []>(
    `SELECT n.article_id, h.norm, h.id FROM headword h JOIN node n ON n.id = h.node_id
      ORDER BY h.node_id, h.id`).iterate()) {
    const m = heads.get(k.article_id) ?? new Map<string, number>();
    if (!m.has(k.norm)) m.set(k.norm, k.id);
    heads.set(k.article_id, m);
  }
  const ins = db.prepare("INSERT INTO x_token (norm, article_id, n, seg, kinds, ok, lemma_kap_id, how) VALUES (?,?,?,?,?,?,?,?)");
  type Tok = { norm: string; article_id: number; n: number; pre: string; rad: string };
  const rows: Tok[] = [];
  let n = 0, ok = 0, lemma = 0;
  const write = (t: Tok, inv: Inventory, pin: { word: string; at: number; root: string }) => {
    const s = segmentForm(t.norm, inv, pin);
    const h = heads.get(t.article_id);
    let kap: number | undefined, how: string | null = null;
    if (h?.has(t.norm)) [kap, how] = [h.get(t.norm), "kap"];
    else for (const c of lemmaCandidates(t.norm)) {
      if (h?.has(c.lemma)) { [kap, how] = [h.get(c.lemma), c.how]; break; }
    }
    ins.run(t.norm, t.article_id, t.n, s.seg, s.kinds, +s.ok, kap ?? null, how);
    n++;
    if (s.ok) ok++;
    if (kap !== undefined) lemma++;
  };
  for (const t of db.query<Tok, []>(TOKEN_GROUPS).iterate()) {
    const pin = { word: t.norm, at: t.pre.length, root: t.rad.toLowerCase() };
    if (pins(t.norm, pin)) segmentForm(t.norm, inv, pin, pairs); // first round, see segmentHeadwords
    rows.push(t);
  }
  return {
    write(inv) {
      for (const t of rows) write(t, inv, { word: t.norm, at: t.pre.length, root: t.rad.toLowerCase() });
      db.run("CREATE INDEX idx_x_token_norm ON x_token(norm)");
      log(`x_token: ${n} attested forms, ${ok} fully segmented (${pct(ok, n)}), ${lemma} tied to a headword (${pct(lemma, n)})`);
      return n;
    },
  };
}

const pct = (a: number, b: number) => `${((100 * a) / Math.max(1, b)).toFixed(1)}%`;
