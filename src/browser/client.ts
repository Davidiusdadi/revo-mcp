import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { z } from "zod";
import { MessagePortTransport } from "./message-port-transport";
import type { RevoWorkerCommand, RevoWorkerEvent, RevoWorkerInit } from "./protocol";
import type { SearchOutput, searchInputSchema } from "../tools/search";
import type { FamilyOutput, familyInputSchema } from "../tools/family";
import type { WordExamplesOutput, wordExamplesInputSchema } from "../tools/word-examples";
import { RevoTrouble } from "./trouble";

export interface RevoWorkerLike {
  postMessage(message: unknown, transfer: Transferable[]): void;
  addEventListener(type: "message", listener: (event: MessageEvent<RevoWorkerEvent>) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent<RevoWorkerEvent>) => void): void;
  terminate(): void;
}

export class RevoBrowserClient {
  private readonly client = new Client({ name: "kunirado", version: "1.0.0" });

  private constructor(private readonly worker: RevoWorkerLike) {}

  /**
   * Starts the Worker on the database at `databaseUrl` and resolves once it
   * answers. `onEvent` hears every Worker event, also after that: the local
   * copy's download progress and the switch to it.
   */
  static async connect(
    worker: RevoWorkerLike,
    databaseUrl: string,
    options: { access?: RevoWorkerInit["access"]; onEvent?: (event: RevoWorkerEvent) => void } = {},
  ): Promise<RevoBrowserClient> {
    const browserClient = new RevoBrowserClient(worker);
    const channel = new MessageChannel();
    const ready = new Promise<void>((resolve, reject) => {
      worker.addEventListener("message", (event: MessageEvent<RevoWorkerEvent>) => {
        options.onEvent?.(event.data);
        if (event.data.type === "revo:ready") resolve();
        if (event.data.type === "revo:error") {
          const { message, code, detail } = event.data;
          reject(code ? new RevoTrouble(code, message, detail) : new Error(message));
        }
      });
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

  async search(input: z.input<typeof searchInputSchema>): Promise<SearchOutput> {
    const result = await this.client.callTool({ name: "search", arguments: input });
    if (result.isError) throw new Error((result.content as any[])?.[0]?.text ?? "ReVo search failed.");
    return result.structuredContent as SearchOutput;
  }

  async family(input: z.input<typeof familyInputSchema>): Promise<FamilyOutput> {
    const result = await this.client.callTool({ name: "family", arguments: input });
    if (result.isError) throw new Error((result.content as any[])?.[0]?.text ?? "ReVo family lookup failed.");
    return result.structuredContent as FamilyOutput;
  }

  async wordExamples(input: z.input<typeof wordExamplesInputSchema>): Promise<WordExamplesOutput> {
    const result = await this.client.callTool({ name: "wordExamples", arguments: input });
    if (result.isError) throw new Error((result.content as any[])?.[0]?.text ?? "ReVo word examples failed.");
    return result.structuredContent as WordExamplesOutput;
  }

  async languages(): Promise<{ code: string; name: string; count: number }[]> {
    const result = await this.client.callTool({ name: "languages", arguments: {} });
    if (result.isError) throw new Error("ReVo language lookup failed.");
    return (result.structuredContent as any).languages;
  }

  /** Downloads the local copy now, or deletes it; events report the outcome. */
  local(action: RevoWorkerCommand["action"]): void {
    const command: RevoWorkerCommand = { type: "revo:local", action };
    this.worker.postMessage(command, []);
  }

  async close(): Promise<void> {
    await this.client.close();
    this.worker.terminate();
  }
}
