/**
 * Passes `morph` and `splits`: lexicon-driven morphology (src/morph.ts does
 * the work).
 *
 * `morph`, in the core stage, is what a gloss segments with:
 *
 * - x_morpheme: the inventory — article roots (and their variants' roots; not the
 *   ending articles "-is", nor exclamations that derive nothing "eh"),
 *   prefixes and suffixes from the affix articles (kap "mal-", "-ul"), the
 *   endings, and endingless words (drv kap = bare root: ĉar, hodiaŭ, kiu).
 * - x_pair: which morphemes the corpus writes next to a marked root, and how
 *   often — evidence for the words that have no mark.
 * - x_affix: every affix article (kap "mal-", "-ul") with its definition cut
 *   to the phrase that says what it means, so a gloss names each part of a
 *   word from one row instead of the article's text.
 * - x_family: the word families. A row for every root and endingless word of
 *   an entry's headword, split as `splits` splits it, so one range of the
 *   table lists every entry built on a root, whichever article files it
 *   (hundherbo is in herb, ĉashundo in hund). An affix is a family's key where
 *   some entry is built on it as a root (ulo, ino): malsanulejo is in the
 *   family of ul, not in a family of its own affixes.
 *
 * `splits`, an enrichment pass, stores what that inventory says about every
 * word the corpus writes, for the server's tools and for the evaluation
 * scripts; a browser computes a split when a word is pointed at instead of
 * downloading them all:
 *
 * - x_morph: a segmentation of every headword, the root pinned where the kap
 *   marks it (`<tld/>`, or the "/" after an article's root).
 * - x_token: every distinct word written with a `<tld/>` outside headwords,
 *   with the article whose root it carries (author-marked), its segmentation,
 *   and the headword of that article it inflects, when there is one.
 *
 * Both passes walk the same way: the words with a mark are split first,
 * without evidence, to read the pairs off them; `morph` stores the pairs,
 * `splits` goes on to split every word with the pairs in hand and stores
 * that.
 *
 * The tildes they pin by come from the `tld-links` walk, not its table, which
 * the core stage leaves out.
 */
import type { Database } from "../../runtime/node-database";
import { descendants, firstChild, kapForms, outerXml, textOf } from "voko-xml";
import type { Pass } from "../pass";
import { idOf } from "../../articles";
import { contentOf, inEsperanto, textIn, OMIT } from "../../content";
import { articleTrees } from "../documents";
import { tldOccurrences, tokenGroups, type TokenGroup } from "./tld-links";
import {
  lemmaCandidates, segment, formatSegments, formatSpans, morphSpans, pinFits, ENDINGS,
  type Inventory, type Morph, type MorphSpan, type WordClass,
} from "../../morph";

const WORD = /\p{L}+/gu;
/** Articles for grammatical endings, not word-building affixes. */
const GRAMMATICAL: ReadonlySet<string> = new Set(["o", "a", "e", "i", "u", "as", "is", "os", "us", "j", "n"]);

export const morphPass: Pass = {
  name: "morph",
  version: 13,
  tables: ["x_morpheme", "x_pair", "x_affix", "x_family"],
  run(db, log) {
    const { inv, pairs, heads } = prepare(db, log);
    const nInv = writeInventory(db, inv);
    log(`x_morpheme: ${inv.roots.size} roots, ${inv.prefixes.size} prefixes, ${inv.suffixes.size} suffixes, ${inv.words.size} endingless words`);
    const nAffix = writeAffixes(db, inv);
    log(`x_affix: ${nAffix} affix articles with their definitions`);
    const nPair = writePairs(db, pairs, log);
    // the families split every headword as the splits pass stores it: with the pairs in hand
    inv.pairs = pairs.counts;
    return nInv + nAffix + nPair + heads.family(inv);
  },
};

export const splitsPass: Pass = {
  name: "splits",
  version: 2,
  tables: ["x_morph", "x_token"],
  run(db, log) {
    const { inv, pairs, heads, toks } = prepare(db, log);
    inv.pairs = pairs.counts;
    return heads.write(inv) + toks.write(inv);
  },
};

/**
 * The inventory, and the first, evidence-free round over the marked words:
 * the pairs read off them, and the headwords and attested forms with their
 * pins, ready to be split with the pairs in hand.
 */
function prepare(db: Database, log: (m: string) => void) {
  const inv = buildInventory(db);
  // the kap's own <tld/> tells where the root sits; the other tildes are the attested forms
  const marked = new Map<number, Pin>();
  const occurrences: TokenGroup[] = [];
  {
    const outside = [];
    for (const o of tldOccurrences(db)) {
      if (o.owner_kind === "kap") {
        if (!marked.has(o.owner_id)) marked.set(o.owner_id, { word: o.norm, at: o.pre.length, root: o.rad.toLowerCase() });
      } else outside.push(o);
    }
    occurrences.push(...tokenGroups(outside));
  }
  const pairs = new Pairs();
  const heads = segmentHeadwords(db, inv, inv.tildes, inv.rootArts, marked, pairs, log);
  const toks = attestedTokens(db, inv, occurrences, pairs, log);
  return { inv, pairs, heads, toks };
}

/** Where a headword or attested form puts its root. */
type Pin = { word: string; at: number; root: string };

/** An affix article as `x_affix` stores it. */
interface Affix {
  /** the headword as written: "mal-", "-ul" */
  txt: string;
  /** P: written "mal-" · S: written "-ul" */
  kind: "P" | "S";
  /** the article's file name */
  art: string;
  /** the entry's mark, when a marked node carries the headword */
  mrk: string | null;
  /** the article's definitions in document order, the gloss is cut from the first that says something */
  difs: string[];
}

interface Built extends Inventory {
  rootArts: Map<string, number[]>;
  /** word class counts as they are stored: by "root@article", the article whose own root it is */
  classRows: Map<string, WordClass>;
  /** derivations per article */
  drv: Map<number, number>;
  /** every headword's display form, root marked ("mal~ulejo", "san/a"), by its id */
  tildes: Map<number, string>;
  /** the affix articles by bare morpheme, the first article to write each */
  affixes: Map<string, Affix>;
}

/** "-ul" → "ul"; null for a headword that is not written as an affix. */
function affixMorph(txt: string): string | null {
  if (!(txt.startsWith("-") || txt.endsWith("-")) || txt.includes(" ")) return null;
  const m = txt.toLowerCase().replace(/^-|-$/g, "");
  return m || null;
}

export function buildInventory(db: Database): Built {
  const roots = new Set<string>(), prefixes = new Set<string>(), suffixes = new Set<string>(), words = new Set<string>();
  const rootArts = new Map<string, number[]>();
  const drv = new Map<number, number>();
  const rootWeight = new Map<string, number>();
  const tildes = new Map<number, string>();
  const classes = new Map<string, WordClass>();
  const classRows = new Map<string, WordClass>();
  const affixes = new Map<string, Affix>();
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
  const headNorms = new Map<number, string[]>();
  for (const h of db.query<{ article_id: number; norm: string }, []>(
    "SELECT n.article_id, h.norm FROM headword h JOIN node n ON n.id = h.node_id").iterate()) {
    const a = headNorms.get(h.article_id) ?? [];
    a.push(h.norm);
    headNorms.set(h.article_id, a);
  }
  for (const { article, art, roots: articleRoots, nodes } of articleTrees(db)) {
    // the article's definitions, in document order, for the affix articles among them
    const difs: string[] = [];
    for (const n of nodes) {
      for (const c of contentOf(n.el)) {
        if (c.el.name === "dif") {
          if (inEsperanto(c.el)) difs.push(textIn(c.el, articleRoots, OMIT.dif));
          continue;
        }
        if (c.el.name !== "kap") continue;
        const forms = kapForms(c.el, articleRoots);
        tildes.set(idOf(c.el)!, forms.tilde);
        addClass(article.rad, article.id, forms.tilde);
        // endingless words: a derivation whose headword is the bare root
        if ((n.kind === "drv" || n.kind === "subdrv") && forms.tilde === "~" && /^\p{L}+$/u.test(forms.norm)) words.add(forms.norm);
        // affix articles: kap "mal-" / "-ul"; the first node to write the affix names it, a marked one gives the mark
        const m = affixMorph(forms.txt);
        if (m === null) continue;
        let a = affixes.get(m);
        if (!a) {
          a = { txt: forms.txt, kind: forms.txt.startsWith("-") ? "S" : "P", art: article.file, mrk: null, difs };
          affixes.set(m, a);
        }
        if (a.art === article.file && a.mrk === null && n.mrk !== null) a.mrk = n.mrk;
      }
    }
    const rad = article.rad;
    const xml = outerXml(art);
    if (endingArts.has(article.id) && GRAMMATICAL.has(rad.toLowerCase())) continue;
    if (EXCLAMATION.test(xml) && (drv.get(article.id) ?? 0) <= 1) continue;
    addRoot(rad, article.id);
    // every root the article's head names: `<rad var="…">`, and a variant
    // headword with a root of its own — anarĥi/o's `<var><kap><rad>anarki</rad>/o`,
    // without which anarkio is read as an|ar|kio
    const head = firstChild(art, "kap");
    const own = head ? [...descendants(head, "rad")].map((r) => textOf(r).trim().toLowerCase()).filter(Boolean) : [];
    for (const r of own) addRoot(r, article.id);
    // a root in -i whose -ism and -ist the article's own headwords write with
    // one i, not two (anarkismo, anarkisto in anarĥi/o, next to anarkiismo):
    // that i is the suffix's, and the stem before it is a root too
    const norms = headNorms.get(article.id) ?? [];
    for (const r of own) {
      if (!r.endsWith("i") || r.length < 5) continue;
      // ending the word, so frakcistreko (frakci/strek/o) is no frakc/ist
      const single = new RegExp(`${r}s[mt][oaei]j?n?$`, "u");
      if (norms.some((w) => single.test(w))) addRoot(r.slice(0, -1), article.id);
    }
  }
  // the word-building affixes: the ending articles ("-o", "-as", "-j") are not
  // affixes, but "-an" and "-on" are (member, fraction) even though they spell endings too
  for (const [m, a] of affixes) {
    if (GRAMMATICAL.has(m)) continue;
    if (a.txt.endsWith("-") && !a.txt.startsWith("-")) prefixes.add(m);
    else if (a.txt.startsWith("-") && !a.txt.endsWith("-")) suffixes.add(m);
  }
  return { roots, prefixes, suffixes, words, rootArts, drv, rootWeight, tildes, classes, classRows, affixes };
}

/**
 * An affix definition cut down to the phrase that says what it means.
 *
 * ReVo opens nearly every one the same way ("Sufikso esprimanta …",
 * "Prefikso montranta …"); dropping that leaves the content, and one clause of
 * it is all a per-word line can carry.
 */
export function affixGloss(txt: string): string {
  let s = txt.replace(/\s+/g, " ").trim();
  s = s.replace(
    /^(sufikso|prefikso|vortero|finaĵo)\s*(esprimanta|montranta|almetebla|signifanta|markanta|uzata|de|kiu)?\s*[,:;]?\s*/i,
    ""
  );
  const cut = s.search(/[:;]| — /);
  if (cut > 12) s = s.slice(0, cut);
  if (s.length > 72) s = s.slice(0, 70).replace(/[\s,]+\S*$/, "") + "…";
  return s.charAt(0).toLowerCase() + s.slice(1);
}

/**
 * The definition an affix article gives, as one row per affix.
 *
 * The `-ul` headword itself usually only says "same meaning as the standalone
 * word", so the gloss is taken from the first substantial definition anywhere
 * in the article: the first is sometimes only a colon and a connective
 * ("Sufikso, kiu:"), with the content in the next one.
 */
function writeAffixes(db: Database, inv: Built): number {
  db.run(`
    CREATE TABLE x_affix (
      morph  TEXT PRIMARY KEY,   -- the bare morpheme: mal, ul
      kind   TEXT NOT NULL,      -- P: the headword is written "mal-" · S: "-ul"
      txt    TEXT NOT NULL,      -- the headword as written
      art    TEXT NOT NULL,      -- the article's file name
      mrk    TEXT,               -- the entry's mark, when a marked node carries the headword
      gloss  TEXT                -- its definition cut to the phrase that says what it means
    )`);
  const ins = db.prepare("INSERT INTO x_affix VALUES (?,?,?,?,?,?)");
  const empty = /^(samsignifa|uzata memstare|vortero)/i;
  let n = 0;
  for (const [m, a] of inv.affixes) {
    let gloss: string | null = null;
    for (const d of a.difs.filter((d) => d.length > 8 && !empty.test(d)).slice(0, 5)) {
      const g = affixGloss(d);
      if (g.length >= 12) {
        gloss = g;
        break;
      }
    }
    ins.run(m, a.kind, a.txt, a.art, a.mrk, gloss);
    n++;
  }
  return n;
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
  // a gloss names a root's own headword by this; the inventory itself is read whole
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
  log(`x_pair: ${pairs.counts.size} morpheme pairs next to a marked root`);
  return pairs.counts.size;
}

/** Segment every word of `form`; the word equal to `fixed.word` gets its root pinned. */
function segmentForm(form: string, inv: Inventory, fixed?: { word: string; at: number; root: string }, pairs?: Pairs) {
  const segs: string[] = [], kinds: string[] = [], roots: string[] = [];
  const spans: MorphSpan[] = [];
  let ok = true;
  let pinned = false;
  for (const match of form.matchAll(WORD)) {
    const w = match[0];
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
    spans.push(...morphSpans(s, match.index));
  }
  return { seg: segs.join(" "), kinds: kinds.join(" "), roots: roots.join(" "), spans, ok, pinned };
}

/** Does `fixed` pin a word of `form`? Mirrors what segmentForm will do with it. */
const pins = (form: string, fixed?: { word: string; at: number; root: string }) =>
  !!fixed && [...form.matchAll(WORD)].some(([w]) => w === fixed.word && pinFits(w, fixed));

/** A segmenting function's rows, written once the pairs exist. */
interface Deferred {
  write(inv: Inventory): number;
}

/** An entry is a derivation whose mark has exactly one dot (db-voko.ts IS_ENTRY). */
const isEntryMark = (kind: string, mrk: string | null): mrk is string =>
  kind === "drv" && mrk !== null && /^[^.]+\.[^.]+$/.test(mrk);

function segmentHeadwords(
  db: Database, inv: Inventory, tildes: Map<number, string>, rootArts: Map<string, number[]>,
  marked: Map<number, Pin>, pairs: Pairs, log: (m: string) => void,
): Deferred & { family(inv: Inventory): number } {
  const create = () => db.run(`
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
  // every root an article's head names, the main one and its variants'
  const articleRoots = new Map<number, string[]>();
  for (const [r, arts] of rootArts) for (const art of arts) {
    const a = articleRoots.get(art) ?? [];
    a.push(r);
    articleRoots.set(art, a);
  }
  let ins: ReturnType<Database["prepare"]>;
  type Kap = {
    id: number; node_id: number; article_id: number; norm: string; rad: string;
    txt: string; file: string; kind: string; mrk: string | null; last_id: number; main: string | null;
  };
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
    `SELECT h.id, h.node_id, n.article_id, h.norm, a.rad, h.txt, a.file, n.kind, n.mrk, n.last_id, m.txt AS main
       FROM headword h JOIN node n ON n.id = h.node_id JOIN article a ON a.id = n.article_id
       LEFT JOIN headword m ON m.id = h.main_id ORDER BY h.id`).iterate()) {
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
    // occurs exactly once — twice ("ferfero") would leave the choice to the segmenter.
    // A variant spelled apart is read with the variant's root (anarkio in anarĥi is
    // anarki/o), and a root in -i can lose it before a suffix, as the headwords
    // write it (anarkismo, anarkisto: anark/ism/o)
    const root = pin ? undefined : headRoot(k.norm, k.rad.toLowerCase(), articleRoots.get(k.article_id) ?? [], (r) => {
      const word = k.norm.match(WORD)?.find((w) => w.includes(r));
      return Boolean(word && segment(word, inv, { at: word.indexOf(r), root: r }));
    });
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
      create();
      ins = db.prepare("INSERT INTO x_morph VALUES (?,?,?,?,?,?,?,?,?)");
      for (const { k, pin } of rows) write(k, inv, pin);
      log(`x_morph: ${n} headwords, ${ok} fully segmented (${pct(ok, n)}), root pinned in ${pinned}`);
      return n;
    },
    family(inv) {
      db.run(`
        CREATE TABLE x_family (
          morph      TEXT NOT NULL,     -- the family: a root or endingless word of some entry (hund, ul)
          kap_id     INTEGER NOT NULL,  -- a headword of an entry built on it
          node_id    INTEGER NOT NULL,  -- the entry's derivation
          last_id    INTEGER NOT NULL,  -- its last id: its translations are node_id..last_id
          mrk        TEXT NOT NULL,     -- the entry's mark
          variant_of TEXT,              -- for a variant headword, the headword it is a variant of
          txt        TEXT NOT NULL,     -- the headword as written
          tilde      TEXT NOT NULL,     -- as its article writes it, its root a tilde: "ĉas~o" in hund
          art        TEXT NOT NULL,     -- the article's file name
          rad        TEXT NOT NULL,     -- the article's root
          spans      TEXT NOT NULL,     -- the headword's family morphemes: "mal:P@0 san:R@3 ul:S@6 ej:S@8", UTF-16 offsets in txt
          PRIMARY KEY (morph, kap_id)
        ) WITHOUT ROWID`);
      const ins = db.prepare("INSERT INTO x_family VALUES (?,?,?,?,?,?,?,?,?,?,?)");
      // the offsets are the lowercased form's; they fit the headword as written where lowercasing keeps its length
      const entries = rows.filter(({ k }) => isEntryMark(k.kind, k.mrk) && k.txt.length === k.norm.length);
      const split = entries.map(({ k, pin }) => ({ k, spans: segmentForm(k.norm, inv, pin).spans }));
      // an affix keys a family only where an entry is built on it as a root
      const keys = new Set(split.flatMap(({ spans }) => spans.filter((x) => (x.k === "R" || x.k === "W") && x.m.length >= 2).map((x) => x.m)));
      let n = 0, rootless = 0;
      for (const { k, spans } of split) {
        const morphs = new Set(spans.filter((x) => keys.has(x.m)).map((x) => x.m));
        if (!spans.some((x) => x.k === "R" || x.k === "W")) rootless++;
        for (const m of morphs) {
          ins.run(m, k.id, k.node_id, k.last_id, k.mrk, k.main, k.txt, tildes.get(k.id) ?? k.txt, k.file, k.rad, formatSpans(spans));
          n++;
        }
      }
      db.run("CREATE INDEX idx_x_family_node ON x_family(node_id)");
      log(`x_family: ${n} rows, ${keys.size} families over ${split.length} entry headwords (${rows.length - entries.length} other headwords left out, ${rootless} without a root)`);
      return n;
    },
  };
}

/** One row per distinct form per article (`tokenGroups`): the form, how often it occurs, and where the tilde puts the root. */
function attestedTokens(db: Database, inv: Inventory, groups: TokenGroup[], pairs: Pairs, log: (m: string) => void): Deferred {
  const create = () => db.run(`
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
  let ins: ReturnType<Database["prepare"]>;
  type Tok = TokenGroup;
  const rows: Tok[] = [];
  let n = 0, ok = 0, lemma = 0;
  const write = (t: Tok, inv: Inventory, pin: Pin) => {
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
  for (const t of groups) {
    const pin = { word: t.norm, at: t.pre.length, root: t.rad.toLowerCase() };
    if (pins(t.norm, pin)) segmentForm(t.norm, inv, pin, pairs); // first round, see segmentHeadwords
    rows.push(t);
  }
  return {
    write(inv) {
      create();
      ins = db.prepare("INSERT INTO x_token (norm, article_id, n, seg, kinds, ok, lemma_kap_id, how) VALUES (?,?,?,?,?,?,?,?)");
      for (const t of rows) write(t, inv, { word: t.norm, at: t.pre.length, root: t.rad.toLowerCase() });
      db.run("CREATE INDEX idx_x_token_norm ON x_token(norm)");
      log(`x_token: ${n} attested forms, ${ok} fully segmented (${pct(ok, n)}), ${lemma} tied to a headword (${pct(lemma, n)})`);
      return n;
    },
  };
}

/**
 * The root of an article a headword written out in full is built on: the
 * main root when the word has it, else the longest of the article's other
 * roots it has that the word splits with — a variant's (anarki/o in
 * anarĥi/o), or the stem an -ism word is built on (anark/ism/o, where
 * anarki leaves "smo").
 */
function headRoot(word: string, main: string, roots: string[], splits: (root: string) => boolean): string | undefined {
  if (main && word.includes(main)) return main;
  const found = roots.filter((r) => r !== main && word.includes(r)).sort((a, b) => b.length - a.length);
  return found.find(splits) ?? found[0] ?? (main || undefined);
}

const pct = (a: number, b: number) => `${((100 * a) / Math.max(1, b)).toFixed(1)}%`;
