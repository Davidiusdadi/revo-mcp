/**
 * SQLite for Node: `node:sqlite`, shaped as the handful of calls the query
 * layer (`SqlReader`), the corpus build and the scripts make.
 *
 * `DatabaseSync` offers `exec` and `prepare` only. The wrapper adds what the
 * callers use besides: `run(sql, params)`, a statement cache behind `query`,
 * `transaction(fn)`, a missing row read as `null`, and `undefined`/boolean
 * parameters bound as NULL and 0/1, which `node:sqlite` refuses.
 */
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { configureDatabaseFactory, getDb } from "../db";
import type { SqlReader, SqlStatement } from "../sql";

type Row = Record<string, unknown>;
type RunResult = { changes: number | bigint; lastInsertRowid: number | bigint };

/** A parameter `node:sqlite` binds as it is, or the value it stands for. */
function bindable(params: unknown[]): SQLInputValue[] {
  for (const value of params) {
    if (value === undefined || typeof value === "boolean") {
      return params.map((v) => (v === undefined ? null : typeof v === "boolean" ? Number(v) : v)) as SQLInputValue[];
    }
  }
  return params as SQLInputValue[];
}

/** Positional parameters, given one by one or as a single array. */
const spread = (params: unknown[]): SQLInputValue[] =>
  bindable(params.length === 1 && Array.isArray(params[0]) ? params[0] : params);

/**
 * A function that turns one row, as the array of its column values, into the
 * object `node:sqlite` would have returned. Its own rows have no prototype,
 * which V8 keeps as dictionaries: reading their columns in the build's loops
 * takes about twice as long as reading an object literal's.
 */
function rowMaker(statement: StatementSync): ((values: unknown[]) => Row) | null {
  const names = statement.columns().map((column) => column.name);
  if (names.length === 0) return null;
  // A name given twice keeps its last value, as the object `node:sqlite` builds does.
  const fields = names.map((name, i) => `${JSON.stringify(name)}: v[${i}]`).join(", ");
  return new Function("v", `return { ${fields} };`) as (values: unknown[]) => Row;
}

export class Statement<R = Row, Params extends unknown[] = any[]> implements SqlStatement<R, Params> {
  private readonly row: ((values: unknown[]) => Row) | null;

  constructor(readonly inner: StatementSync) {
    this.row = rowMaker(inner);
    if (this.row) inner.setReturnArrays(true);
  }

  all(...params: Params): R[] {
    const rows = this.inner.all(...spread(params)) as unknown as unknown[][];
    return (this.row ? rows.map(this.row) : rows) as R[];
  }

  get(...params: Params): R | null {
    const values = this.inner.get(...spread(params)) as unknown as unknown[] | undefined;
    if (values === undefined) return null;
    return (this.row ? this.row(values) : values) as R;
  }

  run(...params: Params): RunResult {
    return this.inner.run(...spread(params));
  }

  *iterate(...params: Params): IterableIterator<R> {
    const row = this.row;
    for (const values of this.inner.iterate(...spread(params)) as unknown as Iterable<unknown[]>) {
      yield (row ? row(values) : values) as R;
    }
  }

  /** The rows as arrays of column values. */
  values(...params: Params): unknown[][] {
    return this.inner.all(...spread(params)) as unknown as unknown[][];
  }
}

export class Database implements SqlReader {
  readonly inner: DatabaseSync;
  private readonly cached = new Map<string, Statement<any, any>>();
  private depth = 0;

  constructor(path: string, options: { readonly?: boolean } = {}) {
    this.inner = new DatabaseSync(path, { readOnly: options.readonly ?? false });
  }

  /** A prepared statement, kept for the next call with the same SQL. */
  query<R = Row, Params extends unknown[] = any[]>(sql: string): Statement<R, Params> {
    let statement = this.cached.get(sql);
    if (!statement) this.cached.set(sql, (statement = new Statement(this.inner.prepare(sql))));
    return statement as Statement<R, Params>;
  }

  prepare<R = Row, Params extends unknown[] = any[]>(sql: string): Statement<R, Params> {
    return new Statement(this.inner.prepare(sql));
  }

  /** One statement with parameters, or any number of statements without. */
  run(sql: string, params?: unknown[]): RunResult {
    if (params?.length) return this.inner.prepare(sql).run(...bindable(params));
    this.inner.exec(sql);
    return this.inner.prepare("SELECT changes() AS changes, last_insert_rowid() AS lastInsertRowid").get() as RunResult;
  }

  exec(sql: string): void {
    this.inner.exec(sql);
  }

  /**
   * `fn` wrapped to run in a transaction: committed when it returns, rolled
   * back when it throws. Nested, it runs in a savepoint of the outer one.
   */
  transaction<Args extends unknown[], T>(fn: (...args: Args) => T): (...args: Args) => T {
    return (...args: Args) => {
      const savepoint = `tx${this.depth}`;
      this.inner.exec(this.depth === 0 ? "BEGIN" : `SAVEPOINT ${savepoint}`);
      this.depth++;
      try {
        const result = fn(...args);
        this.depth--;
        this.inner.exec(this.depth === 0 ? "COMMIT" : `RELEASE ${savepoint}`);
        return result;
      } catch (error) {
        this.depth--;
        this.inner.exec(this.depth === 0 ? "ROLLBACK" : `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
        throw error;
      }
    };
  }

  close(): void {
    this.cached.clear();
    if (this.inner.isOpen) this.inner.close();
  }
}

const here = dirname(fileURLToPath(import.meta.url));
const defaultPath = join(here, "..", "..", "data", "voko.db");

export function configureNodeDatabase(path = process.env.REVO_DB ?? defaultPath): SqlReader {
  configureDatabaseFactory(() => {
    const database = new Database(path, { readonly: true });
    database.exec("PRAGMA cache_size = -64000");
    return database;
  });
  return getDb();
}

export function ensureNodeDatabase(): SqlReader {
  try {
    return getDb();
  } catch {
    return configureNodeDatabase();
  }
}
