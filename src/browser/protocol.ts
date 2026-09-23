/** Messages between a page and the dictionary Worker (worker-entry.ts). */
import type { RevoTroubleCode } from "./trouble";

/** Where queries read the database: the published file over HTTP ranges, or the local copy. */
export type RevoEngine = "remote" | "local";

export type RevoWorkerInit = {
  type: "revo:init";
  mcpPort: MessagePort;
  /** The database file, voko.db; its gzip copy, when published, is this URL + ".gz". */
  databaseUrl: string;
  /**
   * "auto" (default): read remotely until a local copy is downloaded, and keep
   * it up to date. "remote": keep no local copy, deleting one stored before,
   * unless a "download" command asks for one.
   */
  access?: "auto" | "remote";
};

/** Download a local copy now (when there is none, or the published file is newer), or delete it. */
export type RevoWorkerCommand = { type: "revo:local"; action: "download" | "delete" };

export type RevoWorkerEvent =
  // What the start is doing, so a page can say where one that never finished stopped.
  | { type: "revo:loading"; phase: "sqlite" | "storage" | "file" | "mcp" }
  | { type: "revo:ready"; engine: RevoEngine }
  /** Progress of the local copy, in bytes of the database file. */
  | { type: "revo:download"; loaded: number; total: number }
  /** Queries read from this engine from now on. */
  | { type: "revo:engine"; engine: RevoEngine }
  /** The Worker goes on without what the message names, such as a local copy. */
  | { type: "revo:notice"; message: string; code?: RevoTroubleCode; detail?: string }
  | { type: "revo:error"; message: string; code?: RevoTroubleCode; detail?: string };
