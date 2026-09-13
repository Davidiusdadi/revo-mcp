import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { MessagePortTransport } from "./message-port-transport";
import type { RevoWorkerEvent, RevoWorkerInit } from "./protocol";
import type { BrowserSearchInput, BrowserSearchOutput } from "./search-schema";

export interface RevoWorkerLike {
  postMessage(message: unknown, transfer: Transferable[]): void;
  addEventListener(type: "message", listener: (event: MessageEvent<RevoWorkerEvent>) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent<RevoWorkerEvent>) => void): void;
  terminate(): void;
}

export type RevoBrowserProgress = Extract<RevoWorkerEvent, { type: "revo:loading" }>;

export class RevoBrowserClient {
  private readonly client = new Client({ name: "kunirado", version: "1.0.0" });

  private constructor(private readonly worker: RevoWorkerLike) {}

  static async connect(
    worker: RevoWorkerLike,
    databaseUrl: string,
    options: { access?: "shards" | "range" | "download"; onProgress?: (progress: RevoBrowserProgress) => void } = {},
  ): Promise<RevoBrowserClient> {
    const browserClient = new RevoBrowserClient(worker);
    const channel = new MessageChannel();
    const ready = new Promise<void>((resolve, reject) => {
      const listener = (event: MessageEvent<RevoWorkerEvent>) => {
        if (event.data.type === "revo:loading") options.onProgress?.(event.data);
        if (event.data.type === "revo:ready" || event.data.type === "revo:error") {
          worker.removeEventListener("message", listener);
          if (event.data.type === "revo:ready") resolve();
          else reject(new Error(event.data.message));
        }
      };
      worker.addEventListener("message", listener);
    });
    const message: RevoWorkerInit = {
      type: "revo:init",
      mcpPort: channel.port2,
      databaseUrl: new URL(databaseUrl, globalThis.location?.href).href,
      access: options.access,
    };
    worker.postMessage(message, [channel.port2]);
    await Promise.all([
      browserClient.client.connect(new MessagePortTransport(channel.port1)),
      ready,
    ]);
    return browserClient;
  }

  async search(input: BrowserSearchInput): Promise<BrowserSearchOutput> {
    const result = await this.client.callTool({ name: "search", arguments: input });
    if (result.isError) throw new Error((result.content as any[])?.[0]?.text ?? "ReVo search failed.");
    return result.structuredContent as BrowserSearchOutput;
  }

  async languages(): Promise<{ code: string; name: string; count: number }[]> {
    const result = await this.client.callTool({ name: "languages", arguments: {} });
    if (result.isError) throw new Error("ReVo language lookup failed.");
    return (result.structuredContent as any).languages;
  }

  async close(): Promise<void> {
    await this.client.close();
    this.worker.terminate();
  }
}
