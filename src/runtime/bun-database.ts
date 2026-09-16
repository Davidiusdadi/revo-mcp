import { Database } from "bun:sqlite";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { configureDatabaseFactory, getDb } from "../db";
import type { SqlReader } from "../sql";

const here = dirname(fileURLToPath(import.meta.url));
const defaultPath = join(here, "..", "..", "data", "voko.db");

export function configureBunDatabase(path = process.env.REVO_DB ?? defaultPath): SqlReader {
  configureDatabaseFactory(() => {
    const database = new Database(path, { readonly: true }) as unknown as SqlReader;
    database.exec("PRAGMA cache_size = -64000");
    return database;
  });
  return getDb();
}

export function ensureBunDatabase(): SqlReader {
  try {
    return getDb();
  } catch {
    return configureBunDatabase();
  }
}
