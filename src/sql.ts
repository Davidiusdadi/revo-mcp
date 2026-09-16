/** Runtime-neutral subset of SQLite used by the dictionary query layer. */
export interface SqlStatement<Row, Params extends unknown[] = unknown[]> {
  all(...params: any[]): Row[];
  get(...params: any[]): Row | null;
}

export interface SqlReader {
  query<Row, Params extends unknown[] = unknown[]>(sql: string): SqlStatement<Row, Params>;
  exec(sql: string): unknown;
  close(): void;
}
