/**
 * MCP tools: search and entry — the application dictionary contract.
 *
 * `search` ranks every match of a query in Esperanto and the requested
 * languages, counts each language's matches and the usage domains among them,
 * narrows to one of each, and pages through all results; a result carries what
 * a result card shows. `entry` loads one complete entry by its mark.
 */

import { z } from "zod";
import { getDb, lookupMarks } from "../db";
import { searchDictionary } from "../search";

export const searchInputSchema = z.object({
  query: z.string().min(1).max(200),
  languages: z.array(z.string().min(2).max(12)).max(174).default([]),
  limit: z.number().int().min(1).max(50).default(20),
  matchLanguage: z.string().min(2).max(12).optional()
    .describe("Only return results that matched in this searched language, ranked and named by that match."),
  domain: z.string().min(1).max(12).optional()
    .describe("Only return results whose entry carries this ReVo usage domain, such as ZOO or KUI."),
  offset: z.number().int().min(0).optional()
    .describe("Skip this many ranked results; with limit as the page size, this pages through all of them."),
});

export const matchReasonSchema = z.object({
  language: z.string(),
  text: z.string(),
  kind: z.string(),
  via: z.string().optional(),
});

export const searchOutputSchema = z.object({
  query: z.string(),
  languages: z.array(z.string()),
  results: z.array(z.object({
    entry: z.any(),
    matchReasons: z.array(matchReasonSchema),
  })),
  total: z.number().int().describe("Results the search found across all pages."),
  languageMatches: z.array(z.object({
    language: z.string(),
    count: z.number().int(),
  })).describe("Entries matched in each searched language, in request order."),
  domainMatches: z.array(z.object({
    domain: z.string(),
    count: z.number().int(),
  })).describe("Usage domains among the results before a domain narrows them, most common first."),
});

export type SearchInput = z.infer<typeof searchInputSchema>;
export type SearchOutput = z.infer<typeof searchOutputSchema>;

/** Search the configured database. */
export function executeSearch(input: SearchInput): SearchOutput {
  return searchDictionary(getDb(), input);
}

export const entryInputSchema = z.object({
  mark: z.string().min(1).max(200).describe("The entry's ReVo mark, such as hund.0o."),
  languages: z.array(z.string().min(2).max(12)).max(174).optional()
    .describe("Translation languages to include; all of them when omitted."),
});

export const entryOutputSchema = z.object({ entry: z.any() });

export type EntryInput = z.infer<typeof entryInputSchema>;

export function executeEntry({ mark, languages }: EntryInput) {
  const selected = languages && [...new Set(languages.filter((language) => language !== "eo"))];
  const entry = lookupMarks([mark], 1, { languages: selected })[0];
  if (!entry) throw new Error(`No dictionary entry has the mark ${mark}.`);
  return { entry };
}
