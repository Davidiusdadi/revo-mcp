/**
 * The core database is read in a browser by the SQLite sqlite-wasm-http
 * bundles, older than node:sqlite: every virtual table in the file has to be
 * one it can construct, or each query that touches it fails.
 */
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import sqlite3InitModule from "sqlite-wasm-http/sqlite3.js";
import { Database } from "../src/runtime/node-database";
import { EKZ_FTS_DDL } from "../src/corpus/passes/examples";
import { trigramMatch } from "../src/db-voko";

let dir: string;
let sqlite3: any;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "browser-sqlite-"));
  sqlite3 = await (sqlite3InitModule as any)({ print: () => {}, printErr: () => {} });
});
afterAll(() => rmSync(dir, { recursive: true }));

/** A database file written by node:sqlite, opened in the wasm SQLite. */
function openInWasm(path: string) {
  const bytes = new Uint8Array(readFileSync(path));
  const pointer = sqlite3.wasm.allocFromTypedArray(bytes);
  const db = new sqlite3.oo1.DB();
  const { capi } = sqlite3;
  const rc = capi.sqlite3_deserialize(db.pointer, "main", pointer, bytes.length, bytes.length,
    capi.SQLITE_DESERIALIZE_FREEONCLOSE | capi.SQLITE_DESERIALIZE_RESIZEABLE);
  expect(rc).toBe(0);
  return db;
}

describe("the browser's SQLite", () => {
  test("is the version the core stage is built for", () => {
    expect(sqlite3.version.libVersion).toBe("3.44.2");
  });

  test("reads the example index the core stage writes", () => {
    const path = join(dir, "ekz.db");
    const node = new Database(path);
    node.run("CREATE TABLE ekzemplo (rowid INTEGER PRIMARY KEY, ekz_md TEXT NOT NULL)");
    const ins = node.prepare("INSERT INTO ekzemplo (rowid, ekz_md) VALUES (?, ?)");
    ins.run(1, "Ĉasi kuniklojn;");
    ins.run(2, "li baldaŭ renkontis kuŝantan ĉashundon");
    ins.run(3, "hundo bonrasa estas bona por ĉaso");
    node.run(EKZ_FTS_DDL);
    node.run("INSERT INTO fts_ekz(fts_ekz) VALUES('rebuild')");
    node.close();

    const db = openInWasm(path);
    try {
      const ids = db.selectValues(`SELECT rowid FROM fts_ekz WHERE fts_ekz MATCH '"ĉas"' ORDER BY rowid`);
      // case folded (Ĉasi), inside a word (ĉashundon), and not across diacritics
      expect(ids).toEqual([1, 2, 3]);
      expect(db.selectValues(`SELECT rowid FROM fts_ekz WHERE fts_ekz MATCH '"cas"'`)).toEqual([]);
      // it keeps no positions: a longer text is asked for as its trigrams
      expect(() => db.selectValues(`SELECT rowid FROM fts_ekz WHERE fts_ekz MATCH '"ĉashund"'`)).toThrow(/phrase queries are not supported/);
      expect(db.selectValues("SELECT rowid FROM fts_ekz WHERE fts_ekz MATCH ?", [trigramMatch("ĉashund")])).toEqual([2]);
    } finally {
      db.close();
    }
  });

  test("cannot construct the diacritic-folding index, which stays in the full stage", () => {
    const db = new sqlite3.oo1.DB();
    try {
      db.exec("CREATE TABLE ekzemplo (rowid INTEGER PRIMARY KEY, ekz_md TEXT)");
      expect(() => db.exec(
        "CREATE VIRTUAL TABLE fts_ekz_fold USING fts5(ekz_md, content='ekzemplo', content_rowid='rowid', " +
        "tokenize='trigram case_sensitive 0 remove_diacritics 1')")).toThrow();
    } finally {
      db.close();
    }
  });
});
