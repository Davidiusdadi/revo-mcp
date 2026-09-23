/** Messages between a page and the dictionary Worker (worker-entry.ts). */
import type { RevoTroubleCode } from "./trouble";

/** Where queries read the database: the published file over HTTP ranges, or the local copy. */
export type RevoEngine = "remote" | "local";

export type RevoWorkerInit = {
  type: "revo:init";
  mcpPort: MessagePort;
  /**
   * The database file, voko.db; its compressed copy, when published, is this
   * URL + ".zst" (or ".gz"). A URL of the form …/db/<revision>/voko.db names
   * the file's revision, so a stored copy is compared with it offline.
   */
  databaseUrl: string;
  /**
   * "auto" (default): read remotely until a local copy is downloaded, and keep
   * it up to date. "on-request": read a stored copy when there is one, and
   * download one, or a newer revision, only when a "download" command asks;
   * a newer revision is announced with "revo:update". "remote": keep no local
   * copy, deleting one stored before, unless a "download" command asks for one.
   */
  access?: "auto" | "on-request" | "remote";
};

/** Download a local copy now (when there is none, or the published file is newer), or delete it. */
export type RevoWorkerCommand = { type: "revo:local"; action: "download" | "delete" };

export type RevoWorkerEvent =
  // What the start is doing, so a page can say where one that never finished stopped.
  | { type: "revo:loading"; phase: "sqlite" | "storage" | "file" | "mcp" }
  | { type: "revo:ready"; engine: RevoEngine }
  /** The published file is a newer revision than the local copy in use ("on-request" access). */
  | { type: "revo:update"; revision: number }
  /** Progress of the local copy, in bytes of the database file. */
  | { type: "revo:download"; loaded: number; total: number }
  /** Queries read from this engine from now on. */
  | { type: "revo:engine"; engine: RevoEngine }
  /** The Worker goes on without what the message names, such as a local copy. */
  | { type: "revo:notice"; message: string; code?: RevoTroubleCode; detail?: string }
  | { type: "revo:error"; message: string; code?: RevoTroubleCode; detail?: string };
