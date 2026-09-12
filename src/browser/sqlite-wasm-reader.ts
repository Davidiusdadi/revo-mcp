import type { Database, Sqlite3Static } from "@sqlite.org/sqlite-wasm";
import type { SqlReader, SqlStatement } from "../sql";

class WasmStatement<Row> implements SqlStatement<Row> {
  constructor(private readonly database: Database, private readonly sql: string) {}

  all(...params: any[]): Row[] {
    return this.database.exec({
      sql: this.sql,
      bind: params,
      rowMode: "object",
      returnValue: "resultRows",
    }) as Row[];
  }

  get(...params: any[]): Row | null {
    return this.all(...params)[0] ?? null;
  }
}

export class SqliteWasmReader implements SqlReader {
  constructor(private readonly database: Database) {}

  query<Row, Params extends unknown[] = unknown[]>(sql: string): SqlStatement<Row, Params> {
    return new WasmStatement<Row>(this.database, sql);
  }

  exec(sql: string): unknown {
    return this.database.exec(sql);
  }

  close(): void {
    this.database.close();
  }
}

export function openTransientDatabase(
  sqlite3: Sqlite3Static,
  bytes: Uint8Array,
  filename = "/revo.sqlite",
): SqliteWasmReader {
  sqlite3.capi.sqlite3_js_posix_create_file(filename, bytes);
  return new SqliteWasmReader(new sqlite3.oo1.DB(filename, "r"));
}

export async function openOpfsDatabase(
  sqlite3: Sqlite3Static,
  filename = "/revo.sqlite",
): Promise<{ reader: SqliteWasmReader; importDatabase(data: Uint8Array): Promise<number>; remove(): boolean }> {
  const pool = await sqlite3.installOpfsSAHPoolVfs({
    name: "kunirado-revo",
    directory: ".kunirado-revo",
    initialCapacity: 4,
  });
  await pool.reserveMinimumCapacity(4);
  return {
    reader: new SqliteWasmReader(new pool.OpfsSAHPoolDb(filename)),
    importDatabase: (data) => pool.importDb(filename, data),
    remove: () => pool.unlink(filename),
  };
}
