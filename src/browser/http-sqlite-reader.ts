import type { Sqlite3Static } from "@sqlite.org/sqlite-wasm";
import { createHttpBackend, initSyncSQLite } from "sqlite-wasm-http";
import { SqliteWasmReader } from "./sqlite-wasm-reader";

/**
 * SQLite for the Worker, with the `http` VFS: a database at a URL is read over
 * HTTP range requests, one page at a time and runs of neighbouring pages in
 * doubling chunks, and the pages read are kept in a 16MB cache. The same
 * instance opens the local copy (local-copy.ts).
 */
export async function initSqlite(): Promise<Sqlite3Static> {
  const backend = createHttpBackend({
    backendType: "sync",
    maxPageSize: 4096,
    cacheSize: 16 * 1024,
    timeout: 15_000,
  });
  return (await initSyncSQLite({ http: backend })) as unknown as Sqlite3Static;
}

export function openRemoteDatabase(sqlite3: Sqlite3Static, url: string): SqliteWasmReader {
  return new SqliteWasmReader(new sqlite3.oo1.DB({ filename: `file:${encodeURI(url)}`, vfs: "http" } as any));
}
