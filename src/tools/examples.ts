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
    .min(3)
    .max(200)
    .describe(
      "Substring to search for in Esperanto example sentences. Minimum 3 characters. " +
      "Matches anywhere inside words by default (e.g. 'ema' finds 'manĝema', " +
      "'nulejo' finds 'malsanulejo'). " +
      "Diacritics and case are folded: 'songo' matches 'sonĝo', 'cirkau' matches 'Ĉirkaŭ'. " +
      "Word-boundary tip: leading/trailing spaces are significant and act as boundary " +
      "markers. ' ema ' (space-ema-space) matches only the standalone word 'ema' (not " +
      "'manĝema'); ' hom' matches word-initial 'hom' (homo, homaro) but not 'prahomo'; " +
      "'hom ' matches word-final 'hom'. Use this to find inflected forms, compounds, " +
      "proper nouns, or phrases that only appear inside example sentences."
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
