import { z } from "zod";
import { searchInputSchema, searchOutputSchema } from "../tools/search";

// The browser dictionary groups its results by language: it counts every
// searched language's matches and can list the results of one at a time.
export const browserSearchInputSchema = searchInputSchema.extend({
  matchLanguage: z.string().min(2).max(12).optional()
    .describe("Only return results that matched in this searched language, ranked and named by that match."),
});

export const browserSearchOutputSchema = searchOutputSchema.extend({
  languageMatches: z.array(z.object({
    language: z.string(),
    count: z.number().int(),
    more: z.boolean(),
  })).describe("Entries matched in each searched language, in request order. A count stops at the limit; more says whether it had to."),
});

export type BrowserSearchInput = z.infer<typeof browserSearchInputSchema>;
export type BrowserSearchOutput = z.infer<typeof browserSearchOutputSchema>;
