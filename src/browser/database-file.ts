/**
 * The published database file, read without SQLite: its header, to compare
 * revisions, and its bytes, to store a local copy.
 */
import { Decompress } from "fzstd";
import { RevoTrouble } from "./trouble";

export interface DatabaseHeader {
  /** user_version, which the build sets to the time the file was finished */
  revision: number;
  /** bytes: page size × page count */
  size: number;
}

const MAGIC = "SQLite format 3\0";

export function parseHeader(bytes: Uint8Array): DatabaseHeader {
  if (bytes.byteLength < 100 || String.fromCharCode(...bytes.subarray(0, 16)) !== MAGIC) {
    throw new RevoTrouble("file/not-sqlite", "The dictionary file is not an SQLite database.");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, 100);
  const pageSize = view.getUint16(16) === 1 ? 65536 : view.getUint16(16);
  return { revision: view.getInt32(60), size: pageSize * view.getUint32(28) };
}

/** The published file's header: its first 100 bytes, one small request. */
export async function fetchHeader(url: string): Promise<DatabaseHeader> {
  const response = await fetch(url, { headers: { Range: "bytes=0-99" }, cache: "no-store" });
  if (!response.ok) throw new RevoTrouble("file/unreadable", `The dictionary file could not be read (${response.status}).`, String(response.status));
  // A server that ignores the range sends the whole file; its start is the same.
  const reader = response.body!.getReader();
  const header = new Uint8Array(100);
  let filled = 0;
  while (filled < 100) {
    const { done, value } = await reader.read();
    if (done) break;
    const part = value.subarray(0, 100 - filled);
    header.set(part, filled);
    filled += part.byteLength;
  }
  await reader.cancel();
  return parseHeader(header.subarray(0, filled));
}

/**
 * The revision a database URL names, when it names one: revo-mcp's builds are
 * published in a folder per revision (`…/db/<revision>/voko.db`), so a page
 * knows what the published file is without asking the network.
 */
export function revisionInUrl(url: string): number | undefined {
  const match = /\/db\/(-?\d+)\/voko\.db$/.exec(new URL(url).pathname);
  return match ? Number(match[1]) : undefined;
}

/**
 * The database file's bytes, a chunk per call and `undefined` at the end:
 * from its zstd copy (url + ".zst") when that is published, else its gzip
 * copy (".gz", which earlier builds wrote), else the file itself. Static hosts
 * rarely compress a binary file on the fly, so the copy saves most of the
 * download. What arrives is told by its first bytes: a host may decode the
 * copy itself (Content-Encoding) or answer a missing file with its HTML
 * fallback page.
 */
export async function databaseBytes(
  url: string,
  signal: AbortSignal,
): Promise<() => Promise<Uint8Array | undefined>> {
  const bytes = await openBytes(`${url}.zst`, signal) ?? await openBytes(`${url}.gz`, signal) ?? await openBytes(url, signal);
  if (!bytes) throw new RevoTrouble("download/not-sqlite", "The dictionary download is not an SQLite database.");
  return async () => {
    const next = await bytes.read();
    return next.done ? undefined : next.value;
  };
}

async function openBytes(url: string, signal: AbortSignal): Promise<ReadableStreamDefaultReader<Uint8Array> | undefined> {
  const response = await fetch(url, { cache: "no-store", signal });
  if (response.status === 404) return undefined;
  if (!response.ok || !response.body) throw new RevoTrouble("download/failed", `The dictionary download failed (${response.status}).`, String(response.status));
  const body = response.body.getReader();
  const first = await body.read();
  const start = first.done ? new Uint8Array() : first.value;
  const gzipped = start[0] === 0x1f && start[1] === 0x8b;
  const zstd = start[0] === 0x28 && start[1] === 0xb5 && start[2] === 0x2f && start[3] === 0xfd;
  if (!gzipped && !zstd && String.fromCharCode(...start.subarray(0, 16)) !== MAGIC) {
    await body.cancel();
    return undefined;
  }
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(start);
    },
    async pull(controller) {
      const next = await body.read();
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    cancel: (reason) => body.cancel(reason),
  });
  if (zstd) return stream.pipeThrough(zstdDecoder()).getReader();
  if (gzipped) return stream.pipeThrough(new DecompressionStream("gzip") as unknown as ReadableWritablePair<Uint8Array, Uint8Array>).getReader();
  return stream.getReader();
}

/** Browsers decode no zstd of their own yet, so fzstd does, block by block as the bytes arrive. */
function zstdDecoder(): TransformStream<Uint8Array, Uint8Array> {
  let decoder: Decompress;
  return new TransformStream({
    start(controller) {
      // Each block arrives in an array of its own, so it can be passed on as it is.
      decoder = new Decompress((block) => {
        if (block.byteLength) controller.enqueue(block);
      });
    },
    transform(chunk) {
      decoder.push(chunk);
    },
    flush() {
      decoder.push(new Uint8Array(0), true);
    },
  });
}
