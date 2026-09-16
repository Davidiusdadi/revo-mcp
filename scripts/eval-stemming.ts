/**
 * Stemming recall, measured on the corpus's own author-marked forms: every
 * distinct word written with a <tld/> in an example (x_tld_occ, owner ekz)
 * that is not itself a headword. Gold = the article whose root the tilde
 * stands for; forms in affix and ending articles are left out (there the
 * tilde stands for the affix). Compares
 *   - lookup: stemmer.ts generateStems (walked as lookupEsperanto step 3 did)
 *     vs morph.ts lemmaCandidates, and the two chained (step 3 now);
 *   - family: the segmenter's roots (the lookupFamily use). Compounds are
 *     filed under either root in ReVo, so "any root" is reported too.
 *
 *   pnpm corpus:eval [--db data/voko.db]
 */
import { Database } from "../src/runtime/node-database";
import { generateStems } from "../src/stemmer";
import { lemmaCandidates, segment, ENDINGS, type Inventory } from "../src/morph";

const args = process.argv.slice(2);
const at = args.indexOf("--db");
const db = new Database(at >= 0 ? args[at + 1] : "data/voko.db", { readonly: true });

const heads = new Map<string, Set<string>>();
for (const r of db.query<{ kap_norm: string; art: string }, []>(
  `SELECT h.norm kap_norm, a.file art FROM node n JOIN headword h ON h.id = n.kap_id
     JOIN article a ON a.id = n.article_id WHERE n.mrk IS NOT NULL AND n.kind <> 'art'`).iterate()) {
  const s = heads.get(r.kap_norm) ?? new Set<string>();
  s.add(r.art);
  heads.set(r.kap_norm, s);
}

const inv = { roots: new Set<string>(), prefixes: new Set<string>(), suffixes: new Set<string>(), words: new Set<string>() };
const rootArts = new Map<string, Set<string>>();
for (const r of db.query<{ morph: string; kind: string; file: string | null }, []>(
  "SELECT m.morph, m.kind, a.file FROM x_morpheme m LEFT JOIN article a ON a.id = m.article_id").iterate()) {
  if (r.kind === "R") {
    inv.roots.add(r.morph);
    const s = rootArts.get(r.morph) ?? new Set<string>();
    s.add(r.file!);
    rootArts.set(r.morph, s);
  } else if (r.kind === "P") inv.prefixes.add(r.morph);
  else if (r.kind === "S") inv.suffixes.add(r.morph);
  else if (r.kind === "W") inv.words.add(r.morph);
}
const affixy = (rad: string) => inv.prefixes.has(rad) || inv.suffixes.has(rad) || ENDINGS.has(rad) || rad === "j" || rad === "n";

const gold = db.query<{ norm: string; art: string; rad: string }, []>(
  `SELECT DISTINCT o.norm, a.file art, lower(o.rad) rad FROM x_tld_occ o JOIN article a ON a.id = o.article_id WHERE o.owner_kind = 'ekz'`
).all().filter((g) => !heads.has(g.norm) && /^\p{L}+$/u.test(g.norm) && !affixy(g.rad));

type Method = (w: string) => Set<string> | null | undefined;
const heuristic: Method = (w) => {
  for (const s of generateStems(w)) if (s !== w && heads.has(s)) return heads.get(s);
  return null;
};
const lemma: Method = (w) => {
  for (const c of lemmaCandidates(w)) if (heads.has(c.lemma)) return heads.get(c.lemma);
  return null;
};
const rootsOf = (w: string) => segment(w, inv as Inventory)?.filter((m) => m.k === "R" || m.k === "W") ?? [];
const headRoot: Method = (w) => {
  const head = rootsOf(w).at(-1);
  return head ? rootArts.get(head.m) ?? null : null;
};
const anyRoot: Method = (w) => {
  const rs = rootsOf(w);
  if (!rs.length) return null;
  return new Set(rs.flatMap((r) => [...(rootArts.get(r.m) ?? [])]));
};
/** Only trust a segmentation with one root: no compound to pick a head from. */
const singleRoot: Method = (w) => {
  const rs = rootsOf(w);
  return rs.length === 1 ? rootArts.get(rs[0].m) ?? null : null;
};
const methods: [string, Method][] = [
  ["heuristic (generateStems)", heuristic],
  ["lemmaCandidates", lemma],
  ["lemmaCandidates → heuristic (step 3 now)", (w) => lemma(w) ?? heuristic(w)],
  ["segmenter: head root", headRoot],
  ["segmenter: any root", anyRoot],
  ["segmenter: single-root words only", (w) => singleRoot(w)],
  ["lemma → head root → heuristic", (w) => lemma(w) ?? headRoot(w) ?? heuristic(w)],
  ["lemma → single root → heuristic", (w) => lemma(w) ?? singleRoot(w) ?? heuristic(w)],
];

console.log(`${gold.length} distinct example forms (not headwords, not in affix articles); gold = the tilde's article\n`);
console.log("| method | found | correct | wrong |\n|---|---:|---:|---:|");
const pct = (n: number) => `${((100 * n) / gold.length).toFixed(1)}%`;
const res = new Map<string, boolean[]>();
for (const [name, f] of methods) {
  let found = 0, ok = 0;
  const hits: boolean[] = [];
  for (const g of gold) {
    const arts = f(g.norm);
    if (arts) found++;
    const hit = !!arts?.has(g.art);
    if (hit) ok++;
    hits.push(hit);
  }
  res.set(name, hits);
  console.log(`| ${name} | ${pct(found)} | ${pct(ok)} | ${pct(found - ok)} |`);
}

const cmp = (a: string, b: string, label: string, show: (g: (typeof gold)[number]) => string) => {
  const ha = res.get(a)!, hb = res.get(b)!;
  const only = gold.filter((_, i) => ha[i] && !hb[i]);
  console.log(`\n${label}: ${only.length}`);
  for (const g of only.slice(0, 10)) console.log(`  ${g.norm} [${g.art}]  ${show(g)}`);
};
const both = (g: { norm: string }) =>
  `heuristic→${generateStems(g.norm).find((s) => s !== g.norm && heads.has(s)) ?? "-"}  lemma→${
    lemmaCandidates(g.norm).find((c) => heads.has(c.lemma))?.lemma ?? "-"}`;
cmp("heuristic (generateStems)", "lemmaCandidates → heuristic (step 3 now)", "heuristic right, step 3 now not", both);
cmp("lemmaCandidates → heuristic (step 3 now)", "heuristic (generateStems)", "step 3 now right, heuristic not", both);
const segOf = (g: { norm: string }) => segment(g.norm, inv as Inventory)?.map((m) => m.m + ":" + m.k).join(" ") ?? "-";
const wrongAny = gold.filter((g, i) => !res.get("segmenter: any root")![i] && anyRoot(g.norm));
console.log(`\nsegmenter wrong on every root: ${wrongAny.length}`);
for (const g of wrongAny.slice(0, 15)) console.log(`  ${g.norm} [${g.rad}]  ${segOf(g)}`);
