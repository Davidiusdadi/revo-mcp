import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { lookupInputSchema, handleLookup } from "./tools/lookup";
import { handleLanguages } from "./tools/languages";
import { lookupRootInputSchema, handleLookupRoot } from "./tools/root";
import { closeDb } from "./db";

function toolResponse(fn: () => string) {
  try {
    return { content: [{ type: "text" as const, text: fn() }] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text" as const, text: `Error: ${message}` }],
      isError: true as const,
    };
  }
}

export function createMcpServer(): McpServer {
  const server = new McpServer({ name: "revo-vortaro", version: "1.0.0" });

  server.tool(
    "lookup",
    "Look up a word in the Reta Vortaro (Esperanto dictionary). " +
      "Search Esperanto headwords (lang='eo'), translations in a specific language " +
      "(lang='en'/'de'/'fr'/etc.), or across all 174 languages (lang='all'). " +
      "Returns definitions (in Esperanto), examples, translations, and cross-references. " +
      "Supports x-system input (e.g., 'cxirkaux' for 'ĉirkaŭ') and grammatical form stemming " +
      "(e.g., 'amikojn' finds 'amiko').",
    lookupInputSchema.shape,
    async (args) => toolResponse(() => handleLookup(args as any))
  );

  server.tool(
    "languages",
    "List all available languages in the Reta Vortaro dictionary with their translation counts.",
    {},
    async () => toolResponse(() => handleLanguages())
  );

  server.tool(
    "lookup_root",
    "Look up all derived word forms of an Esperanto root (e.g. 'rav' → ravi, rava, rave, ravado…). " +
      "Returns translations only (no definitions or examples), filtered to the specified languages.",
    lookupRootInputSchema.shape,
    async (args) => toolResponse(() => handleLookupRoot(args as any))
  );

  return server;
}

export function registerShutdownHandlers(): void {
  const shutdown = () => {
    closeDb();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
