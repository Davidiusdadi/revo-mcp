import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { searchInputSchema, searchOutputSchema } from "../tools/search";
import type { ShardRepository } from "./shard-repository";

const languagesOutputSchema = z.object({
  languages: z.array(z.object({ code: z.string(), name: z.string(), count: z.number() })),
});

export function createShardMcpServer(repository: ShardRepository): McpServer {
  const server = new McpServer({ name: "revo-vortaro-browser", version: "1.0.0" });
  server.registerTool("search", {
    description: "Search Esperanto headwords and selected translation languages.",
    inputSchema: searchInputSchema,
    outputSchema: searchOutputSchema,
    annotations: { readOnlyHint: true, idempotentHint: true },
  }, async (args) => {
    const structuredContent = await repository.search(args);
    return {
      content: [{ type: "text" as const, text: structuredContent.results.map(({ entry }) => entry.headword).join("\n") }],
      structuredContent,
    };
  });
  server.registerTool("languages", {
    description: "List languages available in the browser dictionary.",
    outputSchema: languagesOutputSchema,
    annotations: { readOnlyHint: true, idempotentHint: true },
  }, async () => ({
    content: [{ type: "text" as const, text: "Available dictionary languages." }],
    structuredContent: { languages: await repository.languages() },
  }));
  return server;
}
