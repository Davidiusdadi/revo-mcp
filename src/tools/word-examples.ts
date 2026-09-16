/**
 * MCP tool: wordExamples — the example sentences, in every article, that use
 * an entry's headword as a word of its own, inflected or not.
 */

import { z } from "zod";
import { getDb } from "../db";
import { wordExamples } from "../word-examples";

export const wordExamplesInputSchema = z.object({
  mark: z.string().min(1).max(200).describe("The entry's ReVo mark, such as spec.sia0a."),
  languages: z.array(z.string().min(2).max(12)).max(174).optional()
    .describe("Languages of the examples' translations; all of them when omitted."),
  limit: z.number().int().min(1).max(5000).default(200),
  offset: z.number().int().min(0).default(0),
  exactTotal: z.boolean().default(true)
    .describe("Count every example (true), or stop once the page is full and report the candidates as an upper bound."),
});

export const wordExamplesOutputSchema = z.object({
  available: z.boolean().describe("False when the database has no examples."),
  headwords: z.array(z.string()).describe("The entry's headword, then its variants."),
  examples: z.array(z.object({
    id: z.number().int(),
    text: z.string(),
    article: z.string(),
    headword: z.string(),
    mrk: z.string().optional(),
    senseMrk: z.string().optional(),
    matches: z.array(z.object({ at: z.number().int(), length: z.number().int() })),
    translations: z.array(z.object({ lng: z.string(), trd: z.string() })),
  })),
  total: z.number().int(),
  totalExact: z.boolean(),
  candidates: z.number().int(),
  offset: z.number().int(),
});

export type WordExamplesInput = z.infer<typeof wordExamplesInputSchema>;
export type WordExamplesOutput = z.infer<typeof wordExamplesOutputSchema>;

export function executeWordExamples({ mark, ...opts }: WordExamplesInput): WordExamplesOutput {
  return wordExamples(getDb(), mark, opts);
}

/** A line for the count, then one per example. */
export function renderWordExamples(out: WordExamplesOutput): string {
  const word = out.headwords[0] ?? "";
  if (!out.available) return `${word}: no examples in this database.`;
  return [
    `${word} (${out.totalExact ? out.total : `≤${out.total}`}):`,
    ...out.examples.map((e) => `- ${e.text} (${e.headword})`),
  ].join("\n");
}
