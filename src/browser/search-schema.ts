import { z } from "zod";
import { searchInputSchema, searchOutputSchema } from "../tools/search";

// The browser dictionary groups its results by language: it counts every
// searched language's matches, can list the results of one at a time, and
// pages through all of them instead of stopping at a limit.
export const browserSearchInputSchema = searchInputSchema.extend({
  matchLanguage: z.string().min(2).max(12).optional()
    .describe("Only return results that matched in this searched language, ranked and named by that match."),
  offset: z.number().int().min(0).optional()
    .describe("Skip this many ranked results; with limit as the page size, this pages through all of them."),
});

export const browserSearchOutputSchema = searchOutputSchema.extend({
  total: z.number().int().describe("Results the search found across all pages."),
  languageMatches: z.array(z.object({
    language: z.string(),
    count: z.number().int(),
  })).describe("Entries matched in each searched language, in request order."),
});

export type BrowserSearchInput = z.infer<typeof browserSearchInputSchema>;
export type BrowserSearchOutput = z.infer<typeof browserSearchOutputSchema>;
