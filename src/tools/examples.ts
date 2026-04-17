/**
 * MCP tool: examples — search the pre-built example-sentence corpus.
 *
 * Complements `lookup`: finds inflected forms, compounds, and proper nouns
 * that only appear inside example sentences and aren't reachable through
 * the headword index.
 */

import { z } from "zod";
import { searchExamples } from "../db";
import { formatExampleHits } from "../formatter";

export const examplesInputSchema = z.object({
  query: z
    .string()
    .min(1)
    .max(200)
    .describe(
      "Word or short phrase to search for in Esperanto example sentences. " +
      "Exact-token match first, then falls back to prefix-of-stem to catch " +
      "inflected forms. Use this when `lookup` returns nothing or when you want " +
      "to see how a word is actually used."
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(20)
    .describe("Maximum number of example sentences to return (1-100)."),
});

export type ExamplesInput = z.infer<typeof examplesInputSchema>;

export function handleExamples(args: ExamplesInput): string {
  const { query, limit } = args;
  const hits = searchExamples(query, limit);
  return formatExampleHits(hits, query, false);
}
