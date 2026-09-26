/**
 * What the Worker has to say about the local copy, as a code a page can put
 * into its own words.
 *
 * The `message` is the same thing in English, for a log and for a page that
 * does not know the code; `detail` is what the browser itself said, or the
 * number the sentence turns on, and is never translated.
 */
export type RevoTroubleCode =
  /** No copy can be kept in this tab; `detail` says why, when the browser said. */
  | "copy/none-in-tab"
  /** Another tab holds the copy, so this one keeps none. */
  | "copy/another-tab"
  /** The browser's storage does not answer, so no copy is kept or read for now. */
  | "copy/storage-silent"
  /** A stored copy could not serve queries and was deleted; `detail` says why. */
  | "copy/deleted"
  /** The browser allows less storage than the file needs; `detail` is its size in MB. */
  | "copy/too-little-storage"
  /** What was downloaded is not the revision the header announced. */
  | "download/revision-mismatch"
  /** The download did not answer; `detail` is the HTTP status. */
  | "download/failed"
  /** What was downloaded is not a database. */
  | "download/not-sqlite"
  /** The download stopped sending; nothing arrived for half a minute. */
  | "download/stalled"
  /** The published file did not answer; `detail` is the HTTP status. */
  | "file/unreadable"
  /**
   * The host no longer has the file the page names (404 or 410): a host that
   * publishes a folder per revision has moved on, so the page is older than it.
   */
  | "file/gone"
  /** The published file is not a database. */
  | "file/not-sqlite";

/** An Error the page can read twice: as a sentence, or as a code of its own. */
export class RevoTrouble extends Error {
  readonly code: RevoTroubleCode;
  readonly detail?: string;

  constructor(code: RevoTroubleCode, message: string, detail?: string) {
    super(message);
    this.name = "RevoTrouble";
    this.code = code;
    this.detail = detail;
  }
}
