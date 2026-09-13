#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { configureDatabase, getLanguages, lookupMarks, type LookupResult } from "../db";
import { languageName } from "../formatter";
import { normalizeQuery } from "../stemmer";

type SearchRow = [key: string, mark: string, label: string, indexed?: 1, expression?: string];

function entryBucket(mark: string): string {
  let hash = 2166136261;
  for (const byte of new TextEncoder().encode(mark)) hash = Math.imul(hash ^ byte, 16777619);
  return (hash >>> 24).toString(16).padStart(2, "0");
}

function derivationMark(mark: string): string {
  return mark.split(".").slice(0, 2).join(".");
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await Bun.write(path, `${JSON.stringify(value)}\n`);
}

function add(
  shards: Map<string, SearchRow[]>,
  language: string,
  key: string,
  mark: string,
  label: string,
  indexed = false,
  expression?: string,
): void {
  const normalized = normalizeQuery(key);
  if (!normalized) return;
  const rows = shards.get(language) ?? [];
  rows.push(indexed ? [normalized, mark, label, 1, expression] : [normalized, mark, label]);
  shards.set(language, rows);
}

export async function exportWebShards(inputArg: string, outputArg: string): Promise<void> {
  const input = resolve(inputArg);
  const output = resolve(outputArg);
  await rm(output, { recursive: true, force: true });
  await mkdir(`${output}/entries`, { recursive: true });
  await mkdir(`${output}/index`, { recursive: true });

  const database = new Database(input, { readonly: true });
  database.exec("PRAGMA cache_size=-128000");
  configureDatabase(database as never);
  const metaRows = database.query<{ key: string; value: string }, []>(
    "SELECT key, value FROM meta ORDER BY key",
  ).all();
  const meta = Object.fromEntries(metaRows.map(({ key, value }) => [key, value]));
  if (meta.schema !== "voko") throw new Error("The shard exporter requires an XML-built voko database.");

  const nodes = database.query<{ mrk: string; kap: string }, []>(
    `SELECT mrk, kap FROM nodo
      WHERE mrk IS NOT NULL AND instr(mrk, '.') > 0
        AND mrk NOT GLOB '*.*.*'
      ORDER BY mrk`,
  ).all();
  const shards = new Map<string, SearchRow[]>();
  const marks = [...new Set(nodes.map(({ mrk }) => mrk))];
  for (const { mrk, kap } of nodes) add(shards, "eo", kap, mrk, kap);

  const translations = database.query<{ lng: string; txt: string; expression: string; mrk: string; kap: string; indexed: number }, []>(
    `SELECT t.lng, COALESCE(t.ind,t.txt) AS txt, t.txt AS expression, n.mrk_near AS mrk, k.txt AS kap,
            (t.ind IS NOT NULL) AS indexed
       FROM trd t JOIN node n ON n.id=t.node_id
       JOIN node d ON d.mrk=n.mrk_near JOIN kap k ON k.id=d.kap_id
      WHERE n.mrk_near IS NOT NULL AND t.owner_kind <> 'ekz'
      ORDER BY t.lng, txt`,
  );
  for (const row of translations.iterate()) {
    add(shards, row.lng, row.txt, derivationMark(row.mrk), row.kap, row.indexed === 1, row.expression);
  }

  const entryBuckets: Record<string, Record<string, LookupResult>> = {};
  let written = 0;
  for (const mark of marks) {
    const entry = lookupMarks([mark], 1)[0];
    if (entry) (entryBuckets[entryBucket(mark)] ??= {})[mark] = entry;
    written += 1;
    if (written % 1000 === 0) console.log(`entries ${written}/${marks.length}`);
  }
  for (const [bucket, entries] of Object.entries(entryBuckets)) {
    await writeJson(`${output}/entries/${bucket}.json`, entries);
  }

  const shardFiles: Record<string, string> = {};
  for (const [language, rows] of shards) {
    const deduped = [...new Map(rows.map((row) => [`${row[0]}\0${row[1]}`, row])).values()]
      .sort((a, b) => a[0].localeCompare(b[0]) || (a[3] ?? 0) - (b[3] ?? 0) ||
        a[2].localeCompare(b[2], "eo"));
    await writeJson(`${output}/index/${language}.json`, deduped);
    shardFiles[language] = `${language}.json`;
  }

  const languages = [
    { code: "eo", name: "Esperanto", count: marks.length },
    ...getLanguages().map(({ lng, count }) => ({ code: lng, name: languageName(lng), count })),
  ];
  await writeJson(`${output}/languages.json`, languages);
  await writeJson(`${output}/manifest.json`, {
    schemaVersion: 2,
    corpusRevision: meta.source_revision ?? meta.revision ?? "local",
    source: {
      name: "Reta Vortaro",
      url: "https://reta-vortaro.de/",
      repository: "https://github.com/Davidiusdadi/revo-fonto",
      license: "GPL-2.0-or-later",
      meta,
    },
    entries: marks.length,
    indexes: shardFiles,
  });
  database.close();
  console.log(`Web shards: ${output}`);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const option = (name: string) => {
    const index = args.indexOf(name);
    if (index === -1) return undefined;
    if (!args[index + 1]) throw new Error(`${name} requires a path`);
    return args[index + 1];
  };
  const positional = args.filter((arg, index) => !arg.startsWith("--") && !args[index - 1]?.startsWith("--"));
  const input = option("--db") ?? positional[0] ?? process.env.REVO_DB ?? "data/voko.db";
  const output = option("--out") ?? positional[1] ?? "dist/dictionary";
  await exportWebShards(input, output);
}
