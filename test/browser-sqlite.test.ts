/**
 * The database is read in a browser by the SQLite of @sqlite.org/sqlite-wasm,
 * which may differ from node:sqlite: every virtual table in the file has to be
 * one it can construct, or each query that touches it fails.
 */
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { Database } from "../src/runtime/node-database";
import { EKZ_FTS_DDL, EKZ_WORD_FTS_DDL } from "../src/corpus/passes/examples";
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
  test("folds diacritics in trigrams, which the full stage's example index needs (3.45+)", () => {
    const [major, minor] = sqlite3.version.libVersion.split(".").map(Number);
    expect(major * 1000 + minor).toBeGreaterThanOrEqual(3045);
  });

  test("reads the example indexes the core stage writes", () => {
    const path = join(dir, "ekz.db");
    const node = new Database(path);
    node.run("CREATE TABLE ekzemplo (rowid INTEGER PRIMARY KEY, ekz_md TEXT NOT NULL)");
    const ins = node.prepare("INSERT INTO ekzemplo (rowid, ekz_md) VALUES (?, ?)");
    ins.run(1, "Ĉasi kuniklojn;");
    ins.run(2, "li baldaŭ renkontis kuŝantan ĉashundon");
    ins.run(3, "hundo bonrasa estas bona por ĉaso");
    node.run(EKZ_FTS_DDL);
    node.run("INSERT INTO fts_ekz(fts_ekz) VALUES('rebuild')");
    node.run(EKZ_WORD_FTS_DDL);
    node.run("INSERT INTO fts_ekz_word(fts_ekz_word) VALUES('rebuild')");
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
      // the word index: whole words, case folded, diacritics kept
      const words = (query: string) => db.selectValues("SELECT rowid FROM fts_ekz_word WHERE fts_ekz_word MATCH ? ORDER BY rowid", [query]);
      expect(words('"ĉasi" OR "ĉaso"')).toEqual([1, 3]);
      expect(words('"ĉas"')).toEqual([]);
      expect(words('"hundo" AND "bona"')).toEqual([3]);
      expect(words('"casi"')).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("reads the diacritic-folding index the full stage writes", () => {
    const db = new sqlite3.oo1.DB();
    try {
      db.exec("CREATE TABLE ekzemplo (rowid INTEGER PRIMARY KEY, ekz_md TEXT)");
      db.exec("INSERT INTO ekzemplo VALUES (1, 'Ĉirkaŭ la domo'), (2, 'dolĉaj sonĝoj')");
      db.exec(
        "CREATE VIRTUAL TABLE fts_ekz_fold USING fts5(ekz_md, content='ekzemplo', content_rowid='rowid', " +
        "tokenize='trigram case_sensitive 0 remove_diacritics 1')");
      db.exec("INSERT INTO fts_ekz_fold(fts_ekz_fold) VALUES('rebuild')");
      const hits = (query: string) => db.selectValues("SELECT rowid FROM fts_ekz_fold WHERE fts_ekz_fold MATCH ?", [query]);
      expect(hits('"cirkau"')).toEqual([1]);
      expect(hits('"songo"')).toEqual([2]);
    } finally {
      db.close();
    }
  });
});
