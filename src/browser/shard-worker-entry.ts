/// <reference lib="webworker" />
import { connectWorkerServer } from "./connect-worker-server";
import { createShardMcpServer } from "./create-shard-server";
import type { RevoWorkerEvent, RevoWorkerInit } from "./protocol";
import { ShardRepository } from "./shard-repository";

const worker = self as unknown as DedicatedWorkerGlobalScope;
let initialized = false;
const emit = (event: RevoWorkerEvent) => worker.postMessage(event);

worker.addEventListener("message", async (event: MessageEvent<RevoWorkerInit>) => {
  if (event.data?.type !== "revo:init" || initialized) return;
  initialized = true;
  try {
    emit({ type: "revo:loading", phase: "mcp" });
    await connectWorkerServer(
      createShardMcpServer(new ShardRepository(event.data.databaseUrl)),
      event.data.mcpPort,
    );
    emit({ type: "revo:ready", engine: "shards" });
  } catch (error) {
    emit({ type: "revo:error", message: error instanceof Error ? error.message : String(error) });
  }
});
