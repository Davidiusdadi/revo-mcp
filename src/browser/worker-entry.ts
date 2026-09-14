/// <reference lib="webworker" />
/**
 * The dictionary Worker: the ReVo MCP server over one database file, voko.db.
 *
 * Without a local copy it reads the published file remotely, page by page over
 * HTTP range requests, so the first search answers at once; meanwhile it
 * downloads the file once into OPFS, reporting progress, and then answers every
 * query from that copy. On later starts the copy answers at once, and a newer
 * published revision replaces it the same way.
 */
import type { Sqlite3Static } from "@sqlite.org/sqlite-wasm";
import { configureDatabase } from "../db";
import { createMcpServer } from "../server";
import { connectWorkerServer } from "./connect-worker-server";
import { databaseBytes, fetchHeader, type DatabaseHeader } from "./database-file";
import { initSqlite, openRemoteDatabase } from "./http-sqlite-reader";
import { LocalCopies, type LocalCopy } from "./local-copy";
import type { RevoEngine, RevoWorkerCommand, RevoWorkerEvent, RevoWorkerInit } from "./protocol";

const worker = self as unknown as DedicatedWorkerGlobalScope;

interface Session {
  sqlite3: Sqlite3Static;
  url: string;
  copies?: LocalCopies;
  engine: RevoEngine;
  /** the copy queries read, when engine is "local" */
  local?: LocalCopy;
  download?: { done: Promise<void>; abort: AbortController };
  /** while the copies are taken over from a Worker that still holds them */
  attaching?: Promise<void>;
}

let started = false;
let session: Session | undefined;

function emit(event: RevoWorkerEvent): void {
  worker.postMessage(event);
}

function notice(error: unknown): void {
  // Deleting the copy cancels its download on purpose.
  if (error instanceof Error && error.name === "AbortError") return;
  emit({ type: "revo:notice", message: error instanceof Error ? error.message : String(error) });
}

worker.addEventListener("message", (event: MessageEvent<RevoWorkerInit | RevoWorkerCommand>) => {
  const message = event.data;
  if (message?.type === "revo:init" && !started) {
    started = true;
    start(message).catch((error) => {
      emit({ type: "revo:error", message: error instanceof Error ? error.message : String(error) });
    });
  } else if (message?.type === "revo:local" && session) {
    const current = session;
    void (current.attaching ?? Promise.resolve())
      .then(() => (message.action === "delete" ? deleteCopy(current) : download(current)))
      .catch(notice);
  }
});

async function start({ databaseUrl, mcpPort, access = "auto" }: RevoWorkerInit): Promise<void> {
  emit({ type: "revo:loading", phase: "sqlite" });
  const sqlite3 = await initSqlite();
  const current: Session = { sqlite3, url: databaseUrl, engine: "remote" };
  // After a reload the previous page's Worker may still hold the copies; this
  // one then starts remotely and takes them over once they are free.
  const held = !await LocalCopies.free().catch(() => true);
  if (!held) await openCopies(current, access);
  // Remote access keeps no copy, also none stored before; a download command still makes one.
  if (access === "remote") current.copies?.removeAllBut(undefined);
  const stored = access === "auto" ? current.copies?.latest() : undefined;
  let published: DatabaseHeader | undefined;
  if (!stored || !useCopy(current, stored)) {
    // The range VFS takes any answer to its HEAD request for the file, so a
    // missing file is reported here rather than as a malformed database.
    published = await fetchHeader(databaseUrl);
    configureDatabase(openRemoteDatabase(sqlite3, databaseUrl));
  }
  session = current;

  emit({ type: "revo:loading", phase: "mcp" });
  await connectWorkerServer(createMcpServer(), mcpPort);
  emit({ type: "revo:ready", engine: current.engine });
  if (held) {
    current.attaching = attachCopies(current, access, published).catch(notice).finally(() => {
      current.attaching = undefined;
    });
  } else if (access === "auto" && current.copies) {
    download(current, published).catch(notice);
  }
}

async function openCopies(current: Session, access: NonNullable<RevoWorkerInit["access"]>): Promise<void> {
  try {
    current.copies = await LocalCopies.open(current.sqlite3);
  } catch (error) {
    if (access === "auto") notice(`The dictionary keeps no local copy in this tab: ${error instanceof Error ? error.message : error}`);
  }
}

/** Takes the copies over from the Worker that held them at start, then goes on as a start with them would. */
async function attachCopies(current: Session, access: NonNullable<RevoWorkerInit["access"]>, published?: DatabaseHeader): Promise<void> {
  // A reload's previous Worker lets go within moments; another tab's does not.
  if (!await LocalCopies.free(3000)) {
    if (access === "auto") notice("The dictionary keeps no local copy in this tab; another tab holds it.");
    return;
  }
  await openCopies(current, access);
  if (!current.copies) return;
  if (access === "remote") return current.copies.removeAllBut(undefined);
  const stored = current.copies.latest();
  if (stored && useCopy(current, stored)) emit({ type: "revo:engine", engine: "local" });
  await download(current, published);
}

/** Answers queries from a stored copy; one that cannot serve them is deleted. */
function useCopy(current: Session, copy: LocalCopy): boolean {
  try {
    configureDatabase(current.copies!.read(copy));
  } catch (error) {
    current.copies!.removeAllBut(current.local);
    notice(`The local copy of the dictionary was deleted: ${error instanceof Error ? error.message : error}`);
    return false;
  }
  current.engine = "local";
  current.local = copy;
  return true;
}

/** Stores the published revision unless the copy in use is that revision. */
function download(current: Session, published?: DatabaseHeader): Promise<void> {
  if (current.download) return current.download.done;
  const abort = new AbortController();
  const done = refresh(current, abort.signal, published).finally(() => {
    current.download = undefined;
  });
  current.download = { done, abort };
  return done;
}

async function refresh(current: Session, signal: AbortSignal, known?: DatabaseHeader): Promise<void> {
  const copies = current.copies;
  if (!copies) throw new Error("The dictionary keeps no local copy in this tab.");
  let published: DatabaseHeader;
  try {
    published = known ?? await fetchHeader(current.url);
  } catch (error) {
    // Offline with a local copy is the copy's purpose, not a problem.
    if (current.local) return;
    throw error;
  }
  if (current.local?.revision === published.revision) return;

  const estimate = await navigator.storage?.estimate?.();
  if (estimate?.quota !== undefined && estimate.quota - (estimate.usage ?? 0) < published.size) {
    throw new Error(`The browser allows too little storage for a local copy of the dictionary (${Math.ceil(published.size / 1e6)} MB).`);
  }

  const total = published.size;
  let loaded = 0;
  let reported = 0;
  emit({ type: "revo:download", loaded, total });
  const next = await databaseBytes(current.url, signal);
  const copy = await copies.import(published.revision, async () => {
    const chunk = await next();
    if (chunk) {
      loaded += chunk.byteLength;
      // A report per half percent is smooth enough and keeps the page's work small.
      if (loaded - reported >= total / 200 || loaded >= total) {
        reported = loaded;
        emit({ type: "revo:download", loaded: Math.min(loaded, total), total });
      }
    }
    return chunk;
  });

  const reader = copies.read(copy);
  const revision = reader.query<{ user_version: number }>("PRAGMA user_version").get()?.user_version;
  if (revision !== published.revision) {
    reader.close();
    copies.removeAllBut(current.local);
    throw new Error(`The downloaded dictionary (${current.url}.gz) is not the revision of ${current.url}; they are published together.`);
  }
  // Replaces and closes what queries read until now.
  configureDatabase(reader);
  current.engine = "local";
  current.local = copy;
  copies.removeAllBut(copy);
  emit({ type: "revo:engine", engine: "local" });
  await navigator.storage?.persist?.();
}

/** Deletes the local copy; queries read the published file again. */
async function deleteCopy(current: Session): Promise<void> {
  if (!current.copies) throw new Error("The dictionary keeps no local copy in this tab; another tab holds it.");
  if (current.download) {
    current.download.abort.abort();
    await current.download.done.catch(() => undefined);
  }
  if (current.engine === "local") {
    // Offline this throws, and the copy stays in use.
    configureDatabase(openRemoteDatabase(current.sqlite3, current.url));
    current.engine = "remote";
    current.local = undefined;
    emit({ type: "revo:engine", engine: "remote" });
  }
  current.copies.removeAllBut(undefined);
}
