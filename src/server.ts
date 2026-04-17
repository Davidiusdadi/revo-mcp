import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { lookupInputSchema, handleLookup } from "./tools/lookup";
import { handleLanguages } from "./tools/languages";
import { lookupRootInputSchema, handleLookupRoot } from "./tools/root";
import { examplesInputSchema, handleExamples } from "./tools/examples";
import { closeDb } from "./db";

function toolResponse(tool: string, args: Record<string, unknown>, fn: () => string) {
  const argsStr = Object.entries(args)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(" ");
  const t0 = performance.now();
  try {
    const text = fn();
    const ms = (performance.now() - t0).toFixed(0);
    console.log(`[tool] ${tool} ${argsStr} → ${text.length} chars (${ms}ms)`);
    return { content: [{ type: "text" as const, text }] };
  } catch (err) {
    const ms = (performance.now() - t0).toFixed(0);
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[tool] ${tool} ${argsStr} → ERROR: ${message} (${ms}ms)`);
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
    async (args) => toolResponse("lookup", args as Record<string, unknown>, () => handleLookup(args as any))
  );

  server.tool(
    "languages",
    "List all available languages in the Reta Vortaro dictionary with their translation counts.",
    {},
    async (args) => toolResponse("languages", {}, () => handleLanguages())
  );

  server.tool(
    "lookup_root",
    "Look up all derived word forms of an Esperanto root (e.g. 'rav' → ravi, rava, rave, ravado…). " +
      "Returns translations only (no definitions or examples), filtered to the specified languages.",
    lookupRootInputSchema.shape,
    async (args) => toolResponse("lookup_root", args as Record<string, unknown>, () => handleLookupRoot(args as any))
  );

  server.tool(
    "examples",
    "Search the corpus of Esperanto example sentences harvested from every article. " +
      "Useful for finding inflected forms (e.g. 'abelojn'), compounds, collocations, " +
      "or proper nouns that don't appear as dictionary headwords. Returns matching " +
      "example sentences grouped by the article they live in.",
    examplesInputSchema.shape,
    async (args) => toolResponse("examples", args as Record<string, unknown>, () => handleExamples(args as any))
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
