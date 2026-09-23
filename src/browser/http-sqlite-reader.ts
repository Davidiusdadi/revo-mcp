import sqlite3InitModule, { type Sqlite3Static } from "@sqlite.org/sqlite-wasm";
// sqlite-wasm-http's own entry brings its SQLite build (3.44), which cannot
// read the full stage's diacritic-folding example index; its VFS installs into
// any build, so it is taken on its own and put into the current one.
import { installSyncHttpVfs } from "../../node_modules/sqlite-wasm-http/dist/vfs-sync-http.js";
import { SqliteWasmReader } from "./sqlite-wasm-reader";

/**
 * SQLite for the Worker, with the `http` VFS: a database at a URL is read over
 * HTTP range requests, one page at a time and runs of neighbouring pages in
 * doubling chunks, and the pages read are kept in a 16MB cache. The same
 * instance opens the local copy (local-copy.ts).
 */
export async function initSqlite(): Promise<Sqlite3Static> {
  // Only `http` and the local copy's opfs-sahpool are used: the others would
  // start a Worker of their own and, without cross-origin isolation, log that
  // they could not.
  (globalThis as any).sqlite3ApiConfig = { disable: { vfs: { opfs: true, "opfs-wl": true, kvvfs: true } } };
  const sqlite3 = await sqlite3InitModule();
  // The hook the VFS calls was renamed after the build it was written for.
  const helper = (sqlite3.oo1.DB as any).dbCtorHelper;
  helper.setVfsPostOpenSql ??= helper.setVfsPostOpenCallback;
  installSyncHttpVfs(sqlite3 as any, { maxPageSize: 4096, cacheSize: 16 * 1024, timeout: 15_000 });
  return sqlite3;
}

export function openRemoteDatabase(sqlite3: Sqlite3Static, url: string): SqliteWasmReader {
  return new SqliteWasmReader(new sqlite3.oo1.DB({ filename: `file:${encodeURI(url)}`, vfs: "http" } as any));
}
