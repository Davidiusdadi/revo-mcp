import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { lookupInputSchema, handleLookup } from "./tools/lookup";
import { handleLanguages } from "./tools/languages";
import { lookupRootInputSchema, handleLookupRoot } from "./tools/root";
import { examplesInputSchema, handleExamples } from "./tools/examples";
import { thesaurusInputSchema, handleThesaurus } from "./tools/thesaurus";
import { reverseLookupInputSchema, handleReverseLookup } from "./tools/reverse";
import { searchInputSchema, searchOutputSchema, executeSearch } from "./tools/search";
import { glossInputSchema, handleGloss } from "./tools/gloss";
import {
  getLanguages,
  getHeadwordCount,
  lookupFamily,
  lookupThesaurus,
  searchDefinitions,
  searchExamples,
} from "./db";
import { languageName } from "./formatter";
import { z } from "zod";

const genericOutputSchema = z.object({ kind: z.string(), data: z.any() });
const languagesOutputSchema = z.object({
  languages: z.array(z.object({ code: z.string(), name: z.string(), count: z.number() })),
});

function toolResponse(
  tool: string,
  args: Record<string, unknown>,
  fn: () => string | { text: string; structuredContent: Record<string, unknown> },
) {
  const argsStr = Object.entries(args)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(" ");
  const t0 = performance.now();
  try {
    const result = fn();
    const text = typeof result === "string" ? result : result.text;
    const ms = (performance.now() - t0).toFixed(0);
    console.error(`[tool] ${tool} ${argsStr} → ${text.length} chars (${ms}ms)`);
    return typeof result === "string"
      ? { content: [{ type: "text" as const, text }] }
      : { content: [{ type: "text" as const, text }], structuredContent: result.structuredContent };
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

  server.registerTool("search", {
    description: "Search Esperanto headwords and the selected translation languages, merging ambiguous matches.",
    inputSchema: searchInputSchema,
    outputSchema: searchOutputSchema,
    annotations: { readOnlyHint: true, idempotentHint: true },
  }, async (args) => toolResponse("search", args as Record<string, unknown>, () => {
    const structuredContent = executeSearch(args);
    return {
      text: structuredContent.results.length
        ? structuredContent.results.map((result) => result.entry.headword).join("\n")
        : "No results found.",
      structuredContent,
    };
  }));

  server.registerTool("lookup", {
    description: "Look up a word in the Reta Vortaro (Esperanto dictionary). " +
      "Search Esperanto headwords (lang='eo'), translations in a specific language " +
      "(lang='en'/'de'/'fr'/etc.), or across all available languages (lang='all'). " +
      "Returns definitions (in Esperanto), examples, translations, and cross-references. " +
      "Supports x-system input (e.g., 'cxirkaux' for 'ĉirkaŭ') and grammatical form stemming " +
      "(e.g., 'amikojn' finds 'amiko').",
    inputSchema: lookupInputSchema,
    outputSchema: genericOutputSchema,
    annotations: { readOnlyHint: true, idempotentHint: true },
  }, async (args) => toolResponse("lookup", args as Record<string, unknown>, () => ({
    text: handleLookup(args),
    structuredContent: { kind: "lookup", data: executeSearch({
      query: args.query,
      languages: args.lang === "eo" ? (args.show_languages ?? []) : [args.lang],
      limit: Math.min(args.limit, 50),
    }) },
  })));

  server.registerTool("languages", {
    description: "List all available languages in the Reta Vortaro dictionary with their translation counts.",
    outputSchema: languagesOutputSchema,
    annotations: { readOnlyHint: true, idempotentHint: true },
  }, async () => toolResponse("languages", {}, () => ({
    text: handleLanguages(),
    structuredContent: {
      languages: [
        { code: "eo", name: "Esperanto", count: getHeadwordCount() },
        ...getLanguages().map(({ lng, count }) => ({ code: lng, name: languageName(lng), count })),
      ],
    },
  })));

  server.registerTool("lookup_root", {
    description: "Look up all derived word forms of an Esperanto root (e.g. 'rav' → ravi, rava, rave, ravado…). " +
      "Returns translations only (no definitions or examples), filtered to the specified languages.",
    inputSchema: lookupRootInputSchema,
    outputSchema: genericOutputSchema,
    annotations: { readOnlyHint: true, idempotentHint: true },
  }, async (args) => toolResponse("lookup_root", args as Record<string, unknown>, () => ({
    text: handleLookupRoot(args),
    structuredContent: { kind: "word_family", data: lookupFamily(args.root) },
  })));

  server.registerTool("examples", {
    description: "Search the corpus of Esperanto example sentences harvested from every article. " +
      "Useful for finding inflected forms (e.g. 'abelojn'), compounds, collocations, " +
      "or proper nouns that don't appear as dictionary headwords. Returns matching " +
      "example sentences grouped by the article they live in.",
    inputSchema: examplesInputSchema,
    outputSchema: genericOutputSchema,
    annotations: { readOnlyHint: true, idempotentHint: true },
  }, async (args) => toolResponse("examples", args as Record<string, unknown>, () => ({
    text: handleExamples(args),
    structuredContent: { kind: "examples", data: searchExamples(args.query, args.limit) },
  })));

  server.registerTool("thesaurus", {
    description: "Show how an Esperanto word relates to others in the Reta Vortaro: synonyms, antonyms, " +
      "broader and narrower terms ('is a kind of' / 'has kind'), parts and wholes, and see-also links. " +
      "Includes inverse links stated by the other article (e.g. 'hundo' lists breeds that declare " +
      "themselves a kind of dog), which do not appear in the article's own text. " +
      "Use it to explore a semantic field; use `lookup` for the word's definition.",
    inputSchema: thesaurusInputSchema,
    outputSchema: genericOutputSchema,
    annotations: { readOnlyHint: true, idempotentHint: true },
  }, async (args) => toolResponse("thesaurus", args as Record<string, unknown>, () => ({
    text: handleThesaurus(args),
    structuredContent: { kind: "thesaurus", data: lookupThesaurus(args.word) },
  })));

  server.registerTool("reverse_lookup", {
    description: "Find an Esperanto word from a description of its meaning, by searching the text of the " +
      "definitions themselves (e.g. 'granda birdo' → ŝubekulo, epiornito, strigo, emuo). " +
      "The description must be in Esperanto. Use this when you know what something is but not " +
      "what it is called; `lookup` searches headwords and translations instead.",
    inputSchema: reverseLookupInputSchema,
    outputSchema: genericOutputSchema,
    annotations: { readOnlyHint: true, idempotentHint: true },
  }, async (args) => toolResponse("reverse_lookup", args as Record<string, unknown>, () => ({
    text: handleReverseLookup(args),
    structuredContent: { kind: "reverse_lookup", data: searchDefinitions(args.description, args.limit) },
  })));

  server.tool(
    "gloss",
    "Gloss a whole text against the dictionary in one call — pass a paragraph or a passage, " +
      "not a single word. With a source language (lang='en'/'de'/…) it returns, for every " +
      "content word and multi-word phrase, the Esperanto roots available for it, so a long " +
      "translation can be planned before it is written and the words with no entry at all are " +
      "visible up front. With lang='eo' it audits an Esperanto draft instead: each word comes " +
      "back as a headword, an inflection, a form attested in the examples, a regular derivation " +
      "no article lists (farenda = far/end/a), or unknown — with the nearest real word named. " +
      "Use it at the start of a translation and again on the draft; use `lookup` for one word's " +
      "definition and senses.",
    glossInputSchema.shape,
    async (args) => toolResponse("gloss", args as Record<string, unknown>, () => handleGloss(args as any))
  );

  return server;
}
