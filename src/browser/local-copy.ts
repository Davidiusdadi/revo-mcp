import type { SAHPoolUtil, Sqlite3Static } from "@sqlite.org/sqlite-wasm";
import { SqliteWasmReader } from "./sqlite-wasm-reader";

/**
 * Local copies of the database in the origin private file system (OPFS).
 *
 * They live in an SQLite "SAH pool", a directory of files the Worker holds open
 * so SQLite can read them synchronously. A copy is named after its revision
 * (the file header's user_version), and the pool lists a name only once its
 * import has completed, so an interrupted download leaves nothing to open.
 * One Worker at a time can hold the pool: in a second tab `open` fails and that
 * tab reads remotely. After a reload the previous page's Worker still holds it
 * for a moment, which `free` waits out.
 */
export interface LocalCopy {
  name: string;
  revision: number;
}

const copyName = /^\/voko-(-?\d+)\.db$/;
const POOL_DIRECTORY = ".revo-voko";

export class LocalCopies {
  private constructor(private readonly pool: SAHPoolUtil) {}

  /**
   * Whether no other Worker holds the pool, waiting up to `wait` ms for one to
   * let go. Ask before `open`: installing the pool keeps its first result for
   * the Worker's lifetime, and when it fails it deletes the pool's directory,
   * which succeeds, losing the copy, if the other Worker lets go meanwhile.
   */
  static async free(wait = 0): Promise<boolean> {
    let file: FileSystemFileHandle | undefined;
    try {
      const root = await navigator.storage.getDirectory();
      const files = await (await root.getDirectoryHandle(POOL_DIRECTORY)).getDirectoryHandle(".opaque");
      // The holder holds every file of the pool, so one tells.
      for await (const handle of (files as unknown as { values(): AsyncIterable<FileSystemHandle> }).values()) {
        if (handle.kind === "file") {
          file = handle as FileSystemFileHandle;
          break;
        }
      }
    } catch {
      // No pool yet.
    }
    if (!file) return true;
    const deadline = Date.now() + wait;
    for (let delay = 50; ; delay = Math.min(delay * 2, 400)) {
      try {
        (await file.createSyncAccessHandle()).close();
        return true;
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "NoModificationAllowedError")) throw error;
        if (Date.now() >= deadline) return false;
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  static async open(sqlite3: Sqlite3Static): Promise<LocalCopies> {
    const pool: SAHPoolUtil | Error = await sqlite3.installOpfsSAHPoolVfs({
      name: "revo-voko",
      directory: POOL_DIRECTORY,
      // Room for the copy in use and its replacement while that downloads.
      initialCapacity: 4,
    });
    // Older SQLite builds resolve with the error, rather than reject, when the
    // pool's files are held elsewhere, as by the Worker of another tab.
    if (pool instanceof Error) throw pool;
    return new LocalCopies(pool);
  }

  /** The newest complete copy, if there is one. */
  latest(): LocalCopy | undefined {
    return this.pool.getFileNames()
      .flatMap((name) => {
        const match = copyName.exec(name);
        return match ? [{ name, revision: Number(match[1]) }] : [];
      })
      .sort((a, b) => b.revision - a.revision)[0];
  }

  read(copy: LocalCopy): SqliteWasmReader {
    return new SqliteWasmReader(new this.pool.OpfsSAHPoolDb(copy.name));
  }

  /** Writes a copy from the database file's bytes, chunk by chunk. */
  async import(revision: number, next: () => Promise<Uint8Array | undefined>): Promise<LocalCopy> {
    const name = `/voko-${revision}.db`;
    await this.pool.importDb(name, next);
    return { name, revision };
  }

  /** Deletes every file in the pool but `keep`; a copy must be closed first. */
  removeAllBut(keep?: LocalCopy): void {
    for (const name of this.pool.getFileNames()) {
      if (name !== keep?.name) this.pool.unlink(name);
    }
  }
}
