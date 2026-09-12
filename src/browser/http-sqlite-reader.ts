import { createHttpBackend, initSyncSQLite } from "sqlite-wasm-http";
import { SqliteWasmReader } from "./sqlite-wasm-reader";

export async function openHttpDatabase(url: string): Promise<{
  reader: SqliteWasmReader;
  close(): Promise<void>;
}> {
  const backend = createHttpBackend({
    backendType: "sync",
    maxPageSize: 1024,
    cacheSize: 4096,
    timeout: 15_000,
  });
  try {
    const sqlite3 = await initSyncSQLite({ http: backend });
    const database = new sqlite3.oo1.DB({
      filename: `file:${encodeURI(url)}`,
      vfs: "http",
    });
    const reader = new SqliteWasmReader(database as any);
    return {
      reader,
      async close() {
        reader.close();
        await backend.close();
      },
    };
  } catch (error) {
    await backend.close();
    throw error;
  }
}
