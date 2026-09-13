import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { lookupInputSchema, handleLookup } from "./tools/lookup";
import { handleLanguages } from "./tools/languages";
import { lookupRootInputSchema, handleLookupRoot } from "./tools/root";
import { examplesInputSchema, handleExamples } from "./tools/examples";
import { thesaurusInputSchema, handleThesaurus } from "./tools/thesaurus";
import { reverseLookupInputSchema, handleReverseLookup } from "./tools/reverse";
import { closeDb } from "./db";

/**
 * Runs a tool handler and logs the call. The log goes to stderr: stdout is the
 * stdio transport's JSON-RPC stream, and a plain-text line in it is a parse
 * error at the client.
 */
function toolResponse(tool: string, args: Record<string, unknown>, fn: () => string) {
  const argsStr = Object.entries(args)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(" ");
  const t0 = performance.now();
  try {
    const text = fn();
    const ms = (performance.now() - t0).toFixed(0);
    console.error(`[tool] ${tool} ${argsStr} → ${text.length} chars (${ms}ms)`);
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

  server.tool(
    "thesaurus",
    "Show how an Esperanto word relates to others in the Reta Vortaro: synonyms, antonyms, " +
      "broader and narrower terms ('is a kind of' / 'has kind'), parts and wholes, and see-also links. " +
      "Includes inverse links stated by the other article (e.g. 'hundo' lists breeds that declare " +
      "themselves a kind of dog), which do not appear in the article's own text. " +
      "Use it to explore a semantic field; use `lookup` for the word's definition.",
    thesaurusInputSchema.shape,
    async (args) => toolResponse("thesaurus", args as Record<string, unknown>, () => handleThesaurus(args as any))
  );

  server.tool(
    "reverse_lookup",
    "Find an Esperanto word from a description of its meaning, by searching the text of the " +
      "definitions themselves (e.g. 'granda birdo' → ŝubekulo, epiornito, strigo, emuo). " +
      "The description must be in Esperanto. Use this when you know what something is but not " +
      "what it is called; `lookup` searches headwords and translations instead.",
    reverseLookupInputSchema.shape,
    async (args) => toolResponse("reverse_lookup", args as Record<string, unknown>, () => handleReverseLookup(args as any))
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
