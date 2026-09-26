/// <reference lib="webworker" />
/**
 * The dictionary Worker: the ReVo MCP server over one database file, voko.db.
 *
 * Without a local copy it reads the published file remotely, page by page over
 * HTTP range requests, so the first search answers at once. A copy in OPFS is
 * downloaded once, reporting progress, by itself ("auto") or when the page asks
 * ("on-request"), and then answers every query. On later starts the copy
 * answers at once, and a newer published revision replaces it the same way,
 * or is offered to the page first.
 */
import type { Sqlite3Static } from "@sqlite.org/sqlite-wasm";
import { configureDatabase } from "../db";
import { createMcpServer } from "../server";
import { connectWorkerServer } from "./connect-worker-server";
import { databaseBytes, fetchHeader, revisionInUrl, type DatabaseHeader } from "./database-file";
import { initSqlite, openRemoteDatabase } from "./http-sqlite-reader";
import { LocalCopies, type LocalCopy } from "./local-copy";
import type { RevoEngine, RevoWorkerCommand, RevoWorkerEvent, RevoWorkerInit } from "./protocol";
import { RevoTrouble } from "./trouble";

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
  /** why no copies could be opened, said when the page asks for one */
  unavailable?: RevoTrouble;
}

/**
 * How long the browser's storage gets to answer. A call into it can hang for
 * good, as it has on a phone after an update, and no query may wait for it.
 */
const STORAGE_MS = 4000;
/** How long a download may go without a byte before it gives up, rather than stand at the same percentage for good. */
const STALL_MS = 30_000;
const TIMED_OUT = Symbol("timed out");

function within<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<typeof TIMED_OUT>((resolve) => { timer = setTimeout(() => resolve(TIMED_OUT), ms); });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

/** Whether the copies can be opened now, are held by another Worker, or the storage does not answer. */
async function storage(wait = 0): Promise<"free" | "held" | "silent"> {
  const free = await within(LocalCopies.free(wait).catch(() => true), wait + STORAGE_MS);
  return free === TIMED_OUT ? "silent" : free ? "free" : "held";
}

function silentStorage(): RevoTrouble {
  return new RevoTrouble("copy/storage-silent", "The browser's storage does not answer, so the dictionary keeps no local copy for now and reads the published file.");
}

let started = false;
let session: Session | undefined;

function emit(event: RevoWorkerEvent): void {
  worker.postMessage(event);
}

/**
 * What a failure says, for a page that reads English and for one that writes
 * its own words: the sentence, and the code behind it when there is one.
 */
function said(error: unknown): { message: string; code?: RevoTrouble["code"]; detail?: string } {
  if (error instanceof RevoTrouble) return { message: error.message, code: error.code, detail: error.detail };
  return { message: error instanceof Error ? error.message : String(error) };
}

function notice(error: unknown): void {
  // Deleting the copy cancels its download on purpose.
  if (error instanceof Error && error.name === "AbortError") return;
  emit({ type: "revo:notice", ...said(error) });
}

worker.addEventListener("message", (event: MessageEvent<RevoWorkerInit | RevoWorkerCommand>) => {
  const message = event.data;
  if (message?.type === "revo:init" && !started) {
    started = true;
    start(message).catch((error) => {
      emit({ type: "revo:error", ...said(error) });
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
  // one then starts remotely and takes them over once they are free. Remote
  // access touches the storage only once it answers queries, since it needs
  // none: it deletes a copy stored before, and a download command makes one.
  if (access !== "remote") emit({ type: "revo:loading", phase: "storage" });
  let now = access !== "remote" ? await storage() : "held";
  if (now === "free") await openCopies(current, access);
  let published: DatabaseHeader | undefined;
  if (!usedStored(current)) {
    emit({ type: "revo:loading", phase: "file" });
    try {
      // The range VFS takes any answer to its HEAD request for the file, so a
      // missing file is reported here rather than as a malformed database.
      published = await fetchHeader(databaseUrl);
      configureDatabase(openRemoteDatabase(sqlite3, databaseUrl));
    } catch (error) {
      // Offline right after a reload, the copy the previous page's Worker
      // still holds is the only way to answer: it is waited for.
      if (access === "remote" || now !== "held") throw error;
      now = await storage(3000);
      if (now !== "free") throw error;
      await openCopies(current, access);
      if (!usedStored(current)) throw error;
    }
  }
  session = current;

  emit({ type: "revo:loading", phase: "mcp" });
  await connectWorkerServer(createMcpServer(), mcpPort);
  emit({ type: "revo:ready", engine: current.engine });
  if (now !== "free") {
    current.attaching = attachCopies(current, access, published).catch(notice).finally(() => {
      current.attaching = undefined;
    });
  } else if (current.copies) {
    keepUp(current, access, published).catch(notice);
  }
}

/** Replaces an older copy by itself, or offers the newer revision to the page; stores a first copy only by itself. */
function keepUp(current: Session, access: NonNullable<RevoWorkerInit["access"]>, published?: DatabaseHeader): Promise<void> {
  if (access === "auto") return download(current, published);
  if (access === "on-request") return offerUpdate(current, published);
  return Promise.resolve();
}

/**
 * Tells the page when the copy in use is older than the published file. A
 * URL that names its revision answers without the network; any other costs
 * the 100-byte header, and offline says nothing, as the copy is for that.
 */
async function offerUpdate(current: Session, known?: DatabaseHeader): Promise<void> {
  if (!current.local) return;
  const named = revisionInUrl(current.url);
  const revision = known?.revision ?? named ?? (await fetchHeader(current.url).catch(() => undefined))?.revision;
  if (revision === undefined || revision === current.local.revision) return;
  emit({ type: "revo:update", revision });
}

async function openCopies(current: Session, access: NonNullable<RevoWorkerInit["access"]>): Promise<void> {
  try {
    const copies = await within(LocalCopies.open(current.sqlite3), STORAGE_MS);
    if (copies === TIMED_OUT) throw silentStorage();
    current.copies = copies;
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    current.unavailable = error instanceof RevoTrouble
      ? error
      : new RevoTrouble("copy/none-in-tab", `The dictionary keeps no local copy in this tab: ${why}`, why);
    if (access === "auto") notice(current.unavailable);
  }
}

/** Takes the copies over from the Worker that held them at start, then goes on as a start with them would. */
async function attachCopies(current: Session, access: NonNullable<RevoWorkerInit["access"]>, published?: DatabaseHeader): Promise<void> {
  // A reload's previous Worker lets go within moments; another tab's does not.
  const now = await storage(3000);
  if (now !== "free") {
    current.unavailable = now === "silent" ? silentStorage() : new RevoTrouble("copy/another-tab", "The dictionary keeps no local copy in this tab; another tab holds it.");
    if (access === "auto") notice(current.unavailable);
    return;
  }
  await openCopies(current, access);
  if (!current.copies) return;
  if (access === "remote") return current.copies.removeAllBut(undefined);
  const stored = current.copies.latest();
  if (stored && useCopy(current, stored)) emit({ type: "revo:engine", engine: "local" });
  await keepUp(current, access, published);
}

/** Whether a stored copy now answers queries. */
function usedStored(current: Session): boolean {
  const stored = current.copies?.latest();
  return !!stored && useCopy(current, stored);
}

/** Answers queries from a stored copy; one that cannot serve them is deleted. */
function useCopy(current: Session, copy: LocalCopy): boolean {
  try {
    configureDatabase(current.copies!.read(copy));
  } catch (error) {
    current.copies!.removeAllBut(current.local);
    const why = error instanceof Error ? error.message : String(error);
    notice(new RevoTrouble("copy/deleted", `The local copy of the dictionary was deleted: ${why}`, why));
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
  if (!copies) throw current.unavailable ?? new RevoTrouble("copy/none-in-tab", "The dictionary keeps no local copy in this tab.");
  let published: DatabaseHeader;
  try {
    published = known ?? await fetchHeader(current.url);
  } catch (error) {
    // Offline with a local copy is the copy's purpose, not a problem. A file
    // the host no longer has is: only a newer page can name the one it has.
    if (current.local && !(error instanceof RevoTrouble && error.code === "file/gone")) return;
    throw error;
  }
  if (current.local?.revision === published.revision) return;

  const estimate = await navigator.storage?.estimate?.();
  if (estimate?.quota !== undefined && estimate.quota - (estimate.usage ?? 0) < published.size) {
    const megabytes = `${Math.ceil(published.size / 1e6)} MB`;
    throw new RevoTrouble("copy/too-little-storage", `The browser allows too little storage for a local copy of the dictionary (${megabytes}).`, megabytes);
  }

  const total = published.size;
  let loaded = 0;
  let reported = 0;
  emit({ type: "revo:download", loaded, total });
  // A connection that stops sending without closing would otherwise leave the
  // download waiting for good; the page is told, and may ask again.
  const stall = new AbortController();
  signal.addEventListener("abort", () => stall.abort(signal.reason), { once: true });
  const unlessStalled = async <T>(promise: Promise<T>): Promise<T> => {
    const result = await within(promise, STALL_MS);
    if (result !== TIMED_OUT) return result;
    stall.abort();
    throw new RevoTrouble("download/stalled", `The dictionary download stopped: nothing arrived for ${STALL_MS / 1000} s.`, String(STALL_MS / 1000));
  };
  const next = await unlessStalled(databaseBytes(current.url, stall.signal));
  const copy = await copies.import(published.revision, async () => {
    const chunk = await unlessStalled(next());
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
    throw new RevoTrouble("download/revision-mismatch", `The downloaded dictionary (${current.url}.zst) is not the revision of ${current.url}; they are published together.`);
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
  if (!current.copies) throw current.unavailable ?? new RevoTrouble("copy/another-tab", "The dictionary keeps no local copy in this tab; another tab holds it.");
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
