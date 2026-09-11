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
 */
import type { Database } from "bun:sqlite";
import type { Pass } from "../pass";
import { lemmaCandidates, segment, formatSegments, ENDINGS, type Inventory, type Morph } from "../../morph";

const WORD = /\p{L}+/gu;
/** Articles for grammatical endings, not word-building affixes. */
const GRAMMATICAL: ReadonlySet<string> = new Set(["o", "a", "e", "i", "u", "as", "is", "os", "us", "j", "n"]);

export const morphPass: Pass = {
  name: "morph",
  version: 1,
  tables: ["x_morpheme", "x_morph", "x_token"],
  run(db, log) {
    const inv = buildInventory(db);
    const nInv = writeInventory(db, inv);
    log(`x_morpheme: ${inv.roots.size} roots, ${inv.prefixes.size} prefixes, ${inv.suffixes.size} suffixes, ${inv.words.size} endingless words`);
    const nMorph = segmentHeadwords(db, inv, log);
    const nTok = attestedTokens(db, inv, log);
    return nInv + nMorph + nTok;
  },
};

interface Built extends Inventory {
  rootArts: Map<string, number[]>;
}

export function buildInventory(db: Database): Built {
  const roots = new Set<string>(), prefixes = new Set<string>(), suffixes = new Set<string>(), words = new Set<string>();
  const rootArts = new Map<string, number[]>();
  const addRoot = (r: string, art: number) => {
    r = r.toLowerCase();
    if (!r) return;
    roots.add(r);
    const a = rootArts.get(r) ?? [];
    if (!a.includes(art)) a.push(art);
    rootArts.set(r, a);
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
  return { roots, prefixes, suffixes, words, rootArts };
}

function writeInventory(db: Database, inv: Built): number {
  db.run(`
    CREATE TABLE x_morpheme (
      morph  TEXT NOT NULL,
      kind   TEXT NOT NULL,      -- R root · P prefix · S suffix · E ending · W endingless word
      art_id INTEGER             -- for roots: the article (homonym articles share a root)
    )`);
  const ins = db.prepare("INSERT INTO x_morpheme VALUES (?,?,?)");
  let n = 0;
  for (const [r, arts] of inv.rootArts) for (const a of arts) { ins.run(r, "R", a); n++; }
  for (const [kind, set] of [["P", inv.prefixes], ["S", inv.suffixes], ["E", ENDINGS], ["W", inv.words]] as const) {
    for (const m of set) { ins.run(m, kind, null); n++; }
  }
  db.run("CREATE INDEX idx_x_morpheme ON x_morpheme(morph, kind)");
  return n;
}

/** Segment every word of `form`; the word equal to `fixed.word` gets its root pinned. */
function segmentForm(form: string, inv: Inventory, fixed?: { word: string; at: number; root: string }) {
  const segs: string[] = [], kinds: string[] = [], roots: string[] = [];
  let ok = true;
  let pinned = false;
  for (const [w] of form.matchAll(WORD)) {
    const pin = fixed && !pinned && w === fixed.word ? { at: fixed.at, root: fixed.root } : undefined;
    if (pin) pinned = true;
    const s: Morph[] | null = segment(w, inv, pin);
    if (!s) {
      ok = false;
      segs.push(w);
      kinds.push("?");
      continue;
    }
    const f = formatSegments(s);
    segs.push(f.seg);
    kinds.push(f.kinds);
    roots.push(...s.filter((x) => x.k === "R").map((x) => x.m));
  }
  return { seg: segs.join(" "), kinds: kinds.join(" "), roots: roots.join(" "), ok, pinned };
}

function segmentHeadwords(db: Database, inv: Inventory, log: (m: string) => void): number {
  db.run(`
    CREATE TABLE x_morph (
      kap_id  INTEGER PRIMARY KEY,
      node_id INTEGER NOT NULL,
      art_id  INTEGER NOT NULL,
      form    TEXT NOT NULL,         -- kap.norm
      seg     TEXT NOT NULL,         -- "mal|san|ul|ej|o", words separated by " "
      kinds   TEXT NOT NULL,         -- "PRSSE" per word; "?" where the inventory could not cover it
      roots   TEXT NOT NULL,         -- the R morphemes, space-separated
      source  TEXT NOT NULL,         -- tilde: root pinned by the kap · free: inventory only
      ok      INTEGER NOT NULL       -- every word fully segmented
    )`);
  // the kap's own <tld/> tells where the root sits
  const pins = new Map<number, { word: string; at: number; root: string }>();
  for (const o of db.query<{ owner_id: number; pre: string; rad: string; norm: string }, []>(
    "SELECT owner_id, pre, rad, norm FROM x_tld_occ WHERE owner_kind = 'kap' ORDER BY owner_id, ord").iterate()) {
    if (!pins.has(o.owner_id)) pins.set(o.owner_id, { word: o.norm, at: o.pre.length, root: o.rad.toLowerCase() });
  }
  const ins = db.prepare("INSERT INTO x_morph VALUES (?,?,?,?,?,?,?,?,?)");
  let n = 0, ok = 0, pinned = 0;
  for (const k of db.query<{ id: number; node_id: number; art_id: number; norm: string; tilde: string }, []>(
    "SELECT k.id, k.node_id, n.art_id, k.norm, k.tilde FROM kap k JOIN node n ON n.id = k.node_id").iterate()) {
    let pin = pins.get(k.id);
    // article kap "san/a": the root ends at the "/"
    const slash = k.tilde.indexOf("/");
    if (!pin && slash > 0 && !k.tilde.slice(0, slash).includes(" ")) {
      const root = k.tilde.slice(0, slash).toLowerCase().replace(/^-/, "");
      const word = k.norm.match(WORD)?.find((w) => w.startsWith(root));
      if (word) pin = { word, at: 0, root };
    }
    const r = segmentForm(k.norm, inv, pin);
    ins.run(k.id, k.node_id, k.art_id, k.norm, r.seg, r.kinds, r.roots, r.pinned ? "tilde" : "free", +r.ok);
    n++;
    if (r.ok) ok++;
    if (r.pinned) pinned++;
  }
  log(`x_morph: ${n} headwords, ${ok} fully segmented (${pct(ok, n)}), root pinned in ${pinned}`);
  return n;
}

function attestedTokens(db: Database, inv: Inventory, log: (m: string) => void): number {
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
  let n = 0, ok = 0, lemma = 0;
  for (const t of db.query<{ norm: string; art_id: number; n: number; pre: string; rad: string }, []>(
    `SELECT norm, art_id, COUNT(*) n, MIN(pre) pre, MIN(rad) rad FROM x_tld_occ
     WHERE owner_kind <> 'kap' AND norm <> '' GROUP BY norm, art_id`).iterate()) {
    const s = segmentForm(t.norm, inv, { word: t.norm, at: t.pre.length, root: t.rad.toLowerCase() });
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
  }
  db.run("CREATE INDEX idx_x_token_norm ON x_token(norm)");
  log(`x_token: ${n} attested forms, ${ok} fully segmented (${pct(ok, n)}), ${lemma} tied to a headword (${pct(lemma, n)})`);
  return n;
}

const pct = (a: number, b: number) => `${((100 * a) / Math.max(1, b)).toFixed(1)}%`;
