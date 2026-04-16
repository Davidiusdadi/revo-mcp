/**
 * MCP tool: lookup — Search the Reta Vortaro (Esperanto dictionary).
 */

import { z } from "zod";
import {
  lookupEsperanto,
  lookupTranslation,
  lookupAllLanguages,
  lookupWildcardCompact,
} from "../db";
import { formatResults, formatWildcardCompact } from "../formatter";
import { hasXSystem, fromXSystem } from "../stemmer";

export const lookupInputSchema = z.object({
  query: z
    .string()
    .min(1)
    .max(200)
    .describe(
      "The word or phrase to look up. Use * as a wildcard for Esperanto headword discovery: " +
      "'*ejo' finds all place-words, '*ulo' finds person-words, 'am*' finds words starting with am, " +
      "'*em*' finds any word containing em. Wildcard queries return a compact list of matching " +
      "headwords with short glosses (up to 500); call lookup again on a specific headword for full details."
    ),
  lang: z
    .string()
    .default("eo")
    .describe(
      "Language to search in. Use 'eo' for Esperanto headwords (default), " +
      "'en'/'de'/'fr'/etc. for translation lookups, or 'all' to search across all languages."
    ),
  show_languages: z
    .array(z.string())
    .optional()
    .describe(
      "Which translation languages to show in results (e.g. ['en', 'de']). " +
      "If omitted, shows a default set (en, de, fr, es, ru, zh, ja)."
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(500)
    .default(5)
    .describe(
      "Maximum number of results to return. For normal lookups, 1-20 is typical. " +
      "For wildcard queries (compact mode), larger values up to 500 are supported."
    ),
  offset: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe(
      "Pagination offset for wildcard queries. Use with limit to page through " +
      "large result sets (e.g., offset:100 after limit:100 gets results 101-200). " +
      "Ignored for non-wildcard lookups."
    ),
});

export type LookupInput = z.infer<typeof lookupInputSchema>;

export function handleLookup(args: LookupInput): string {
  let { query, lang, show_languages, limit, offset } = args;

  // Convert x-system if present
  if (hasXSystem(query)) {
    query = fromXSystem(query);
  }

  let results;

  // Wildcard mode: * in query → compact headword list for discovery.
  if (query.includes("*") && lang === "eo") {
    const glossLang = show_languages?.[0] ?? "en";
    // Default to a larger page size for wildcard discovery if user didn't override.
    const pageSize = limit === 5 ? 100 : limit;
    const { matches, total } = lookupWildcardCompact(query, glossLang, pageSize, offset);
    return formatWildcardCompact(matches, query, glossLang, total, offset);
  }

  if (lang === "eo") {
    results = lookupEsperanto(query, limit);
  } else if (lang === "all") {
    results = lookupAllLanguages(query, limit);
  } else {
    results = lookupTranslation(query, lang, limit);
  }

  return formatResults(results, show_languages);
}
