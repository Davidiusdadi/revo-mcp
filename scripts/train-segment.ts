/**
 * Fits the weights of segment()'s learned scorer and writes src/morph-weights.ts.
 *
 * Data: the root-marked words of scripts/segment-cases.ts, tune part only
 * (the report part stays for scripts/eval-segment.ts). For each word the
 * candidates are the readings `readings()` finishes with, the pin hidden; a
 * reading is right when it puts a root exactly on the marked span. Words where
 * every reading is right or none is teach nothing and are skipped, as are table
 * words, which segment() never rescores.
 *
 * Model: P(reading) ∝ exp(−w·f) over one word's readings, f from
 * `readingFeatures()`. The loss is the mean over words of −ln P(some right
 * reading) + λ·|w|², with the general features scaled to unit spread over
 * the tune readings so that one λ fits all (the per-affix ones not, see
 * below); minimised by L-BFGS from "hand cost only".
 * The weights written are in the features' own units.
 *
 *   pnpm corpus:train-segment [--db data/voko.db] [--lambda 0.001] [--cv 0.0001,0.001,0.01] [--dry]
 *
 * --cv prints, for each λ, the misses on each half of the tune part when
 * fitted on the other half (halves by stem, see foldOf). --dry does not
 * write the weights file.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Database } from "../src/runtime/node-database";
import { readings, readingFeatures, type Reading } from "../src/morph";
import { segmentCases, foldOf, type Case } from "./segment-cases";

const args = process.argv.slice(2);
const opt = (name: string, dflt: string) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : dflt;
};
const db = new Database(opt("--db", "data/voko.db"), { readonly: true });
const lambda = Number(opt("--lambda", "0.001"));
const OUT = fileURLToPath(new URL("../src/morph-weights.ts", import.meta.url));
const CORRELATIVE = /^(ki|ti|i|ĉi|neni)(a|al|am|e|el|es|o|om|u)(j|n|jn)?$/;

const t0 = performance.now();
const { inv, all } = segmentCases(db);

/** One word: its readings as sparse feature rows, and which of them are right. */
interface Row {
  c: Case;
  rs: Reading[];
  idx: Int32Array[];
  val: Float64Array[];
  right: boolean[];
}
const names = new Map<string, number>();
const rows: Row[] = [];
const isRight = (r: Reading, c: Case) => {
  let off = 0;
  for (const m of r.ms) {
    if (off === c.at && (m.k === "R" || m.k === "W") && m.m === c.root) return true;
    off += m.m.length;
  }
  return false;
};
for (const c of all) {
  if (c.part !== "tune" || CORRELATIVE.test(c.word)) continue;
  const rs = readings(c.word, inv);
  if (rs.length === 0) continue;
  const idx: Int32Array[] = [], val: Float64Array[] = [];
  for (const r of rs) {
    const f = readingFeatures(r, rs[0].cost, inv);
    const ks = [...f.keys()].filter((k) => f.get(k) !== 0);
    for (const k of ks) if (!names.has(k)) names.set(k, names.size);
    idx.push(Int32Array.from(ks, (k) => names.get(k)!));
    val.push(Float64Array.from(ks, (k) => f.get(k)!));
  }
  rows.push({ c, rs, idx, val, right: rs.map((r) => isRight(r, c)) });
}
const D = names.size;
const keys = [...names.keys()];

// unit spread per feature over all tune readings (a shift would be the same for every reading of a word, so none)
const mean = new Float64Array(D), sq = new Float64Array(D);
let nReadings = 0;
for (const r of rows) {
  nReadings += r.rs.length;
  r.idx.forEach((ix, i) => ix.forEach((j, t) => { mean[j] += r.val[i][t]; sq[j] += r.val[i][t] ** 2; }));
}
// The per-affix features (P=…, S=…) are left unscaled: they are 0/1 counts
// already, and scaled up a rare one gets past the penalty. Scaled, P=duon
// reached +7.8 from the few words ReVo files under du (du|on|jar|o), and the
// build split every duon- word as du|on — which leaves the root where it was,
// so the root-placement count cannot see it.
const sd = Float64Array.from(mean, (m, j) =>
  keys[j].includes("=") ? 1 : Math.sqrt(Math.max(1e-9, sq[j] / nReadings - (m / nReadings) ** 2)));
for (const r of rows) r.val.forEach((v, i) => r.idx[i].forEach((j, t) => { v[t] /= sd[j]; }));

const useful = (r: Row) => r.right.some(Boolean) && !r.right.every(Boolean);
const score = (r: Row, i: number, w: Float64Array) => {
  let s = 0;
  const ix = r.idx[i], v = r.val[i];
  for (let t = 0; t < ix.length; t++) s += w[ix[t]] * v[t];
  return s;
};

/** Loss and gradient over `data` (see the header). */
function loss(data: Row[], w: Float64Array, g: Float64Array): number {
  g.fill(0);
  let total = 0;
  for (const r of data) {
    const K = r.rs.length;
    const s = new Float64Array(K);
    let lo = Infinity;
    for (let i = 0; i < K; i++) lo = Math.min(lo, (s[i] = score(r, i, w)));
    let zAll = 0, zRight = 0;
    for (let i = 0; i < K; i++) {
      s[i] = Math.exp(lo - s[i]);
      zAll += s[i];
      if (r.right[i]) zRight += s[i];
    }
    total += Math.log(zAll) - Math.log(zRight);
    for (let i = 0; i < K; i++) {
      // d/dw of ln zAll − ln zRight, with score = +w·f entering as exp(−score)
      const coef = -(s[i] / zAll) + (r.right[i] ? s[i] / zRight : 0);
      const ix = r.idx[i], v = r.val[i];
      for (let t = 0; t < ix.length; t++) g[ix[t]] += coef * v[t];
    }
  }
  let reg = 0;
  for (let j = 0; j < D; j++) {
    g[j] = g[j] / data.length + 2 * lambdaNow * w[j];
    reg += w[j] * w[j];
  }
  return total / data.length + lambdaNow * reg;
}
let lambdaNow = lambda;

const dot = (a: Float64Array, b: Float64Array) => {
  let s = 0;
  for (let j = 0; j < a.length; j++) s += a[j] * b[j];
  return s;
};

/** L-BFGS (memory 10) with a backtracking line search. */
function fit(data: Row[], lam: number): Float64Array {
  lambdaNow = lam;
  const w = new Float64Array(D);
  if (names.has("cost")) w[names.get("cost")!] = 1; // start from the hand costs
  let g = new Float64Array(D);
  let fx = loss(data, w, g);
  const S: Float64Array[] = [], Y: Float64Array[] = [];
  for (let it = 0; it < 1000; it++) {
    const q = Float64Array.from(g);
    const alpha: number[] = [];
    for (let i = S.length - 1; i >= 0; i--) {
      alpha[i] = dot(S[i], q) / dot(Y[i], S[i]);
      for (let j = 0; j < D; j++) q[j] -= alpha[i] * Y[i][j];
    }
    const gamma = S.length ? dot(S[S.length - 1], Y[Y.length - 1]) / dot(Y[Y.length - 1], Y[Y.length - 1]) : 1 / Math.max(1, Math.sqrt(dot(g, g)));
    for (let j = 0; j < D; j++) q[j] *= gamma;
    for (let i = 0; i < S.length; i++) {
      const beta = dot(Y[i], q) / dot(Y[i], S[i]);
      for (let j = 0; j < D; j++) q[j] += (alpha[i] - beta) * S[i][j];
    }
    let slope = -dot(g, q);
    if (slope >= 0) { // not a descent direction: forget the curvature and step along the gradient
      S.length = Y.length = 0;
      q.set(g);
      slope = -dot(g, g);
    }
    let step = 1, fNew = Infinity;
    const wNew = new Float64Array(D), gNew = new Float64Array(D);
    for (let tries = 0; tries < 40; tries++, step /= 2) {
      for (let j = 0; j < D; j++) wNew[j] = w[j] - step * q[j];
      fNew = loss(data, wNew, gNew);
      if (fNew <= fx + 1e-4 * step * slope) break;
    }
    const s = Float64Array.from(wNew, (x, j) => x - w[j]);
    const y = Float64Array.from(gNew, (x, j) => x - g[j]);
    if (dot(s, y) > 1e-12) {
      S.push(s);
      Y.push(y);
      if (S.length > 10) { S.shift(); Y.shift(); }
    }
    const done = fx - fNew < 1e-9 * Math.max(1, Math.abs(fx));
    w.set(wNew);
    g = gNew;
    fx = fNew;
    if (done) break;
  }
  return w;
}

/** Words whose lowest-scoring reading is wrong (ties go to the cheaper hand cost, as in segment()). */
function misses(data: Row[], w: Float64Array): number {
  let n = 0;
  for (const r of data) {
    let pick = 0, low = Infinity;
    for (let i = 0; i < r.rs.length; i++) {
      const s = score(r, i, w);
      if (s < low - 1e-9) [pick, low] = [i, s];
    }
    if (!r.right[pick]) n++;
  }
  return n;
}

const handOnly = new Float64Array(D);
if (names.has("cost")) handOnly[names.get("cost")!] = 1;
console.log(`tune part: ${rows.length} words, ${nReadings} readings, ${rows.filter(useful).length} with a right and a wrong reading, ${D} features (${Math.round(performance.now() - t0)} ms)`);
console.log(`hand costs: ${misses(rows, handOnly)} tune misses; no reading right: ${rows.filter((r) => !r.right.some(Boolean)).length}`);

if (args.includes("--cv")) {
  for (const lam of opt("--cv", "").split(",").map(Number)) {
    let m = 0;
    for (const k of [0, 1]) m += misses(rows.filter((r) => foldOf(r.c.word) === k), fit(rows.filter((r) => foldOf(r.c.word) !== k && useful(r)), lam));
    console.log(`  λ ${lam}: ${m} tune misses, each half fitted on the other`);
  }
}

const w = fit(rows.filter(useful), lambda);
// in the features' own units, rounded to 4 significant digits; the rounded weights are the ones measured
const raw: [string, number][] = keys.map((k, j) => [k, Number((w[j] / sd[j]).toPrecision(4))]);
const rounded = Float64Array.from(raw, ([, x], j) => x * sd[j]);
console.log(`learned, λ ${lambda}: ${misses(rows, rounded)} tune misses (fitted on these words; see eval-segment for unseen ones), ${Math.round(performance.now() - t0)} ms`);
console.log("largest weights (per unit spread):");
for (const j of [...keys.keys()].sort((a, b) => Math.abs(w[b]) - Math.abs(w[a])).slice(0, 15)) {
  console.log(`  ${keys[j].padEnd(14)} ${w[j] >= 0 ? "+" : ""}${w[j].toFixed(3)}`);
}

if (!args.includes("--dry")) {
  raw.sort((a, b) => a[0].localeCompare(b[0]));
  const lines = raw.filter(([, x]) => x !== 0).map(([k, x]) => `  ${JSON.stringify(k)}: ${x},`);
  writeFileSync(OUT, `/**
 * Weights of segment()'s learned scorer (src/morph.ts, readingFeatures):
 * a reading's score is the sum of weight × feature, the lowest wins. Written
 * by \`pnpm corpus:train-segment\` — edit the features or the trainer, not
 * this file.
 *
 * Fitted on ${rows.length} root-marked words of the Reta Vortaro (the tune part,
 * λ ${lambda}), so derived from ReVo's content: GPL v2 only, like the corpus.
 */
export const SEGMENT_WEIGHTS: Record<string, number> = {
${lines.join("\n")}
};
`);
  console.log(`wrote ${OUT} (${lines.length} weights)`);
}
