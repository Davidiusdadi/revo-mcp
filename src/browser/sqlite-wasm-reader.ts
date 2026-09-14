import type { Database } from "@sqlite.org/sqlite-wasm";
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
