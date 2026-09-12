/// <reference lib="webworker" />
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { configureDatabase } from "../db";
import { createMcpServer } from "../server";
import { connectWorkerServer } from "./connect-worker-server";
import { openTransientDatabase } from "./sqlite-wasm-reader";
import { openHttpDatabase } from "./http-sqlite-reader";
import type { RevoWorkerEvent, RevoWorkerInit } from "./protocol";
import { ShardRepository } from "./shard-repository";
import { createShardMcpServer } from "./create-shard-server";

const worker = self as unknown as DedicatedWorkerGlobalScope;
let initialized = false;

function emit(event: RevoWorkerEvent): void {
  worker.postMessage(event);
}

async function download(url: string): Promise<Uint8Array> {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`Dictionary download failed (${response.status}).`);
  const total = Number(response.headers.get("content-length") ?? 0) || undefined;
  if (!response.body) return new Uint8Array(await response.arrayBuffer());
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    emit({ type: "revo:loading", phase: "database", loaded, total });
  }
  const bytes = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

worker.addEventListener("message", async (event: MessageEvent<RevoWorkerInit>) => {
  if (event.data?.type !== "revo:init" || initialized) return;
  initialized = true;
  try {
    if ((event.data.access ?? "shards") === "shards") {
      emit({ type: "revo:loading", phase: "mcp" });
      await connectWorkerServer(
        createShardMcpServer(new ShardRepository(event.data.databaseUrl)),
        event.data.mcpPort,
      );
      emit({ type: "revo:ready", engine: "shards" });
      return;
    }
    emit({ type: "revo:loading", phase: "sqlite" });
    if (event.data.access === "range") {
      const remote = await openHttpDatabase(event.data.databaseUrl);
      configureDatabase(remote.reader);
    } else {
      const sqlite3 = await sqlite3InitModule();
      emit({ type: "revo:loading", phase: "database" });
      const bytes = await download(event.data.databaseUrl);
      configureDatabase(openTransientDatabase(sqlite3, bytes));
    }
    emit({ type: "revo:loading", phase: "mcp" });
    await connectWorkerServer(createMcpServer(), event.data.mcpPort);
    emit({ type: "revo:ready", engine: "sqlite-wasm" });
  } catch (error) {
    emit({ type: "revo:error", message: error instanceof Error ? error.message : String(error) });
  }
});
