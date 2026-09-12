#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";

type ManifestFile = { url: string; bytes: number; sha256: string };

async function sha256(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  for await (const chunk of Bun.file(path).stream()) hasher.update(chunk);
  return hasher.digest("hex");
}

async function describe(path: string): Promise<ManifestFile> {
  return {
    url: basename(path),
    bytes: (await stat(path)).size,
    sha256: await sha256(path),
  };
}

async function gzip(input: string, output: string): Promise<void> {
  const child = Bun.spawn(["gzip", "-n", "-9", "-c", input], {
    stdout: Bun.file(output),
    stderr: "inherit",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(`gzip exited with ${exitCode}`);
}

export async function exportWebDatabase(inputArg: string, outputDirectoryArg: string): Promise<void> {
  const input = resolve(inputArg);
  const outputDirectory = resolve(outputDirectoryArg);
  await mkdir(outputDirectory, { recursive: true });

  const source = new Database(input, { readonly: true });
  const metaRows = source.query<{ key: string; value: string }, []>(
    "SELECT key, value FROM meta ORDER BY key",
  ).all();
  source.close();
  const meta = Object.fromEntries(metaRows.map(({ key, value }) => [key, value]));
  if (meta.schema !== "voko") throw new Error("The web exporter requires an XML-built voko database.");

  const revision = (meta.source_revision ?? meta.revision ?? "local")
    .replace(/[^a-zA-Z0-9._-]+/g, "-");
  const stem = `revo-${revision}`;
  const raw = resolve(outputDirectory, `${stem}.sqlite`);
  const temporary = `${raw}.partial`;
  const compressed = `${raw}.gz`;
  const manifestPath = resolve(outputDirectory, "dictionary-manifest.json");

  await rm(temporary, { force: true });
  const database = new Database(temporary);
  database.exec("PRAGMA page_size=1024");
  database.exec("PRAGMA journal_mode=DELETE");
  database.exec("PRAGMA synchronous=OFF");
  const quotedInput = input.replaceAll("'", "''");
  database.exec(`ATTACH DATABASE '${quotedInput}' AS source`);
  database.exec("BEGIN");
  // Purpose-built L2 projection: stable IDs are preserved, while raw XML and
  // corpus-build diagnostics remain in the canonical database only.
  const projections: Record<string, string> = {
    meta: "key, value",
    art: "id, file, rad, rev, modified, source",
    node: "id, art_id, parent_id, kind, key, mrk, mrk_near, num, ref, ord, kap_id",
    kap: "id, node_id, parent_kap_id, txt, tilde, norm, ofc, rad_var, ord",
    trd: "id, node_id, owner_kind, owner_id, lng, grp, ord, txt, ind, baz, pr, klr, ofc, kod, fnt",
    dif: "id, node_id, ord, lng, txt",
    ekz: "id, node_id, owner_kind, owner_id, ord, key, mrk, txt, ind",
    ref: "id, node_id, owner_kind, owner_id, tip, cel, lst, val, grp, ord, txt",
    uzo: "id, node_id, owner_kind, owner_id, tip, txt, ord",
    fnt: "id, node_id, owner_kind, owner_id, ord, bib, aut, vrk, lok, url, txt",
    bib: "mll, tip, tit, url, aut, trd, ald, eld",
    lng: "kodo, nomo, flago",
    fako: "kodo, nomo, vinjeto",
    stilo: "kodo, nomo",
    mallongigo: "mll, nomo",
    gra: "id, node_id, vspec, txt",
    ekzemplo: "rowid, art, drv_mrk, sense_mrk, ekz_md",
    x_morph: "kap_id, node_id, art_id, form, seg, kinds, roots, source, ok",
    x_morpheme: "morph, kind, art_id",
    x_ref_edge: "id, ref_id, src_node, dst_node, dst_kind, dst_rim, tip, inferred",
    x_ref_tip: "tip, label, parent, skos, inverse, symmetric, transitive, owl",
  };
  for (const [table, columns] of Object.entries(projections)) {
    database.exec(`CREATE TABLE ${table} AS SELECT ${columns} FROM source.${table}`);
  }
  database.exec("COMMIT");
  database.exec("DETACH DATABASE source");

  database.exec(`
    CREATE UNIQUE INDEX idx_art_id ON art(id);
    CREATE UNIQUE INDEX idx_art_file ON art(file);
    CREATE UNIQUE INDEX idx_node_id ON node(id);
    CREATE INDEX idx_node_art ON node(art_id);
    CREATE INDEX idx_node_parent ON node(parent_id);
    CREATE INDEX idx_node_mrk ON node(mrk);
    CREATE INDEX idx_node_mrk_near ON node(mrk_near);
    CREATE UNIQUE INDEX idx_kap_id ON kap(id);
    CREATE INDEX idx_kap_node ON kap(node_id);
    CREATE INDEX idx_kap_norm ON kap(norm);
    CREATE UNIQUE INDEX idx_trd_id ON trd(id);
    CREATE INDEX idx_trd_node ON trd(node_id);
    CREATE INDEX idx_trd_lng_key ON trd(lng, COALESCE(ind, txt) COLLATE NOCASE);
    CREATE INDEX idx_dif_node ON dif(node_id);
    CREATE INDEX idx_ekz_node ON ekz(node_id);
    CREATE INDEX idx_ref_node ON ref(node_id);
    CREATE INDEX idx_uzo_node ON uzo(node_id);
    CREATE INDEX idx_fnt_node ON fnt(node_id);
    CREATE INDEX idx_fnt_bib ON fnt(bib);
    CREATE INDEX idx_ekzemplo_art ON ekzemplo(art);
    CREATE INDEX idx_ekzemplo_drv ON ekzemplo(drv_mrk);
    CREATE INDEX idx_x_morpheme ON x_morpheme(morph, kind);
    CREATE INDEX idx_x_ref_edge_src ON x_ref_edge(src_node, tip);
    CREATE INDEX idx_x_ref_edge_dst ON x_ref_edge(dst_node, tip);

    CREATE VIEW artikolo AS SELECT file AS mrk, NULL AS txt FROM art;
    CREATE VIEW nodo AS
      SELECT n.mrk, a.file AS art, k.txt AS kap, n.num, k.norm AS kap_norm
      FROM node n JOIN art a ON a.id=n.art_id JOIN kap k ON k.id=n.kap_id
      WHERE n.mrk IS NOT NULL AND n.kind <> 'art';
    CREATE VIEW var AS
      SELECT COALESCE(n.mrk_near,
        (SELECT d.mrk FROM node d WHERE d.art_id=n.art_id AND d.kind='drv'
          AND d.mrk IS NOT NULL ORDER BY d.id LIMIT 1)) AS mrk,
        k.txt AS kap, k.rad_var AS var, k.norm AS kap_norm
      FROM kap k JOIN node n ON n.id=k.node_id WHERE k.parent_kap_id IS NOT NULL;
    CREATE VIEW traduko AS
      SELECT t.id AS rowid, n.mrk_near AS mrk, t.lng,
        COALESCE(t.ind,t.txt) AS trd,
        CASE WHEN t.pr IS NULL THEN t.txt ELSE t.txt || ' ' || t.pr END AS txt
      FROM trd t JOIN node n ON n.id=t.node_id
      WHERE n.mrk_near IS NOT NULL AND t.owner_kind <> 'ekz';
    CREATE VIEW referenco AS
      SELECT n.mrk_near AS mrk, r.cel, COALESCE(r.tip,'') AS tip
      FROM ref r JOIN node n ON n.id=r.node_id WHERE n.mrk_near IS NOT NULL;
    CREATE VIEW uzo_compat AS
      SELECT n.mrk_near AS mrk, CASE u.tip WHEN 'fak' THEN 'uzo' ELSE u.tip END AS tip,
        u.txt AS uzo FROM uzo u JOIN node n ON n.id=u.node_id
      WHERE n.mrk_near IS NOT NULL AND u.tip IN ('fak','stl') AND u.owner_kind <> 'ekz';

    CREATE VIRTUAL TABLE fts_kap USING fts5(kap, tokenize='unicode61 remove_diacritics 2');
    INSERT INTO fts_kap(rowid,kap) SELECT id,txt FROM kap;
    CREATE VIRTUAL TABLE fts_trd USING fts5(trd,ind,baz,pr,tokenize='unicode61 remove_diacritics 2');
    INSERT INTO fts_trd(rowid,trd,ind,baz,pr) SELECT id,txt,ind,baz,pr FROM trd;
    CREATE VIRTUAL TABLE fts_ekz USING fts5(ekz_md,content='ekzemplo',content_rowid='rowid',
      tokenize='trigram case_sensitive 0 remove_diacritics 1');
    INSERT INTO fts_ekz(fts_ekz) VALUES('rebuild');
    INSERT INTO fts_kap(fts_kap) VALUES('optimize');
    INSERT INTO fts_trd(fts_trd) VALUES('optimize');
    INSERT INTO fts_ekz(fts_ekz) VALUES('optimize');
  `);
  database.exec("VACUUM");
  database.exec("PRAGMA optimize");
  const integrity = database.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get();
  database.close();
  if (integrity?.integrity_check !== "ok") throw new Error("Exported web database failed integrity_check.");

  await rm(raw, { force: true });
  await rename(temporary, raw);
  await rm(compressed, { force: true });
  await gzip(raw, compressed);

  const manifest = {
    schemaVersion: 1,
    databaseSchema: meta.schema,
    corpusRevision: revision,
    source: {
      name: "Reta Vortaro",
      repository: "https://github.com/Davidiusdadi/revo-fonto",
      license: "GPL-2.0-or-later",
      meta,
    },
    files: {
      remote: await describe(raw),
      offline: await describe(compressed),
    },
  };
  await Bun.write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Web database: ${raw}`);
  console.log(`Offline archive: ${compressed}`);
  console.log(`Manifest: ${manifestPath}`);
}

if (import.meta.main) {
  const input = process.argv[2] ?? process.env.REVO_DB;
  const outputDirectory = process.argv[3] ?? "dist/dictionary";
  if (!input) {
    console.error("Usage: bun run web:export <voko.db> [output-directory]");
    process.exit(2);
  }
  await exportWebDatabase(input, outputDirectory);
}
