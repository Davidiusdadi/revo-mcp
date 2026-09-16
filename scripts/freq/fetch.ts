#!/usr/bin/env bun
/**
 * Downloads the corpora the word frequencies are counted from, into
 * data/freq/sources/, and records what was fetched (URL, date, bytes, sha256,
 * licence) in data/freq/sources/SOURCES.json — the provenance every later
 * step quotes.
 *
 *   bun run scripts/freq/fetch.ts [--only hplt|tekstaro]
 *
 * A file whose sha256 already matches the record is not downloaded again.
 *
 * - HPLT v2, cleaned, epo_Latn: web Esperanto, CC0. The map file lists the
 *   shard(s); Esperanto has one, about 1.1 GB.
 * - Tekstaro de Esperanto, TEI XML with morpheme boundaries: the corpus ReVo
 *   cites. No licence stated; the text is used locally, only counts leave.
 */
import { existsSync, mkdirSync, statSync } from "fs";
import { join } from "path";
import { FREQ, SOURCES_FILE, type SourceRecord } from "./paths";

const args = process.argv.slice(2);
const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : undefined;

interface Source {
  name: string;
  licence: string;
  /** The files to fetch: from a map file listing URLs, or fixed URLs. */
  urls: () => Promise<string[]>;
  /** Run once after the files are in place (unzip). */
  after?: (dir: string, files: string[]) => Promise<void>;
}

const SOURCES: Source[] = [
  {
    name: "hplt",
    licence: "CC0 1.0 (HPLT v2, cleaned, epo_Latn; https://hplt-project.org/datasets/v2.0)",
    urls: async () => {
      const map = "https://data.hplt-project.org/two/cleaned/epo_Latn_map.txt";
      const res = await fetch(map);
      if (!res.ok) throw new Error(`${map} → HTTP ${res.status}`);
      return (await res.text()).split("\n").map((l) => l.trim()).filter(Boolean);
    },
  },
  {
    name: "tekstaro",
    licence: "no licence stated (https://tekstaro.com/elshuti.html); text used locally only",
    urls: async () => ["https://tekstaro.com/elshutebla/tekstaro_de_esperanto_xml_kun_streketoj.zip"],
    after: async (dir, files) => {
      for (const f of files) {
        const p = Bun.spawn(["unzip", "-oq", f, "-d", join(dir, "xml")], { stdout: "inherit", stderr: "inherit" });
        if ((await p.exited) !== 0) throw new Error(`unzip ${f} failed`);
      }
    },
  },
];

async function sha256(path: string): Promise<string> {
  const h = new Bun.CryptoHasher("sha256");
  for await (const chunk of Bun.file(path).stream()) h.update(chunk);
  return h.digest("hex");
}

async function download(url: string, dest: string): Promise<void> {
  const res = await fetch(url, { headers: { "user-agent": "revo-mcp frequency build" } });
  if (!res.ok || !res.body) throw new Error(`${url} → HTTP ${res.status}`);
  const total = Number(res.headers.get("content-length") ?? 0);
  const tmp = `${dest}.part`;
  const out = Bun.file(tmp).writer();
  let done = 0, shown = -1;
  for await (const chunk of res.body) {
    out.write(chunk);
    done += chunk.length;
    const pct = total ? Math.floor((100 * done) / total) : -1;
    if (pct !== shown && pct % 5 === 0) { shown = pct; process.stdout.write(`\r  ${(done / 1e6).toFixed(0)} MB${total ? ` (${pct} %)` : ""}`); }
  }
  await out.end();
  process.stdout.write("\n");
  await Bun.write(dest, Bun.file(tmp));
  await Bun.file(tmp).delete();
}

mkdirSync(FREQ, { recursive: true });
const records: Record<string, SourceRecord> = existsSync(SOURCES_FILE) ? await Bun.file(SOURCES_FILE).json() : {};

for (const s of SOURCES) {
  if (only && s.name !== only) continue;
  const dir = join(FREQ, "sources", s.name);
  mkdirSync(dir, { recursive: true });
  const urls = await s.urls();
  const files: string[] = [];
  const rec: SourceRecord = records[s.name] ?? { licence: s.licence, files: [] };
  rec.licence = s.licence;
  for (const url of urls) {
    const name = url.slice(url.lastIndexOf("/") + 1);
    const dest = join(dir, name);
    files.push(dest);
    const known = rec.files.find((f) => f.url === url);
    if (known && existsSync(dest) && statSync(dest).size === known.bytes && (await sha256(dest)) === known.sha256) {
      console.log(`${s.name}: ${name} already fetched (${(known.bytes / 1e6).toFixed(0)} MB, ${known.fetched})`);
      continue;
    }
    console.log(`${s.name}: ${url}`);
    await download(url, dest);
    const entry = { url, file: name, bytes: statSync(dest).size, sha256: await sha256(dest), fetched: new Date().toISOString().slice(0, 10) };
    rec.files = [...rec.files.filter((f) => f.url !== url), entry];
    console.log(`  ${(entry.bytes / 1e6).toFixed(0)} MB, sha256 ${entry.sha256.slice(0, 12)}…`);
  }
  if (s.after) await s.after(dir, files);
  records[s.name] = rec;
  await Bun.write(SOURCES_FILE, JSON.stringify(records, null, 2) + "\n");
}
console.log(`wrote ${SOURCES_FILE}`);
