import { z } from "zod";
import {
  lookupEsperanto,
  lookupTranslation,
  type LookupResult,
} from "../db";
import { fromXSystem, hasXSystem } from "../stemmer";

export const searchInputSchema = z.object({
  query: z.string().min(1).max(200),
  languages: z.array(z.string().min(2).max(12)).max(174).default([]),
  limit: z.number().int().min(1).max(50).default(20),
});

export const matchReasonSchema = z.object({
  language: z.string(),
  text: z.string(),
  kind: z.string(),
});

export const searchOutputSchema = z.object({
  query: z.string(),
  languages: z.array(z.string()),
  results: z.array(z.object({
    entry: z.any(),
    matchReasons: z.array(matchReasonSchema),
  })),
});

export type SearchInput = z.infer<typeof searchInputSchema>;
export type SearchOutput = z.infer<typeof searchOutputSchema>;

const MATCH_RANK: Record<string, number> = {
  headword: 0,
  translation: 0,
  stem: 1,
  prefix: 2,
  fts: 3,
};

function reasonOf(result: LookupResult, fallbackLanguage: string, query: string) {
  const [rawKind = "headword", language = fallbackLanguage, ...matched] =
    result.matchedVia?.split(":") ?? [];
  const kind = rawKind === "translation" && result.matchKind && result.matchKind !== "exact"
    ? `translation-${result.matchKind}`
    : rawKind;
  return {
    language: kind === "translation" ? language : fallbackLanguage,
    text: matched.join(":") || query,
    kind,
  };
}

/** Multilingual application search with stable deduplication and match labels. */
export function executeSearch(input: SearchInput): SearchOutput {
  const query = hasXSystem(input.query) ? fromXSystem(input.query) : input.query;
  const languages = [...new Set(input.languages.filter((language) => language !== "eo"))];
  const found = new Map<string, { entry: LookupResult; matchReasons: ReturnType<typeof reasonOf>[] }>();

  const merge = (results: LookupResult[], language: string) => {
    for (const result of results) {
      const existing = found.get(result.mrk);
      const reason = reasonOf(result, language, query);
      if (existing) {
        if (!existing.matchReasons.some((item) =>
          item.language === reason.language && item.text === reason.text && item.kind === reason.kind
        )) existing.matchReasons.push(reason);
      } else {
        found.set(result.mrk, { entry: result, matchReasons: [reason] });
      }
    }
  };

  merge(lookupEsperanto(query, input.limit), "eo");
  for (const language of languages) merge(lookupTranslation(query, language, input.limit), language);

  const ranked = [...found.values()].sort((a, b) => {
    const aRank = Math.min(...a.matchReasons.map((reason) => MATCH_RANK[reason.kind] ?? 4));
    const bRank = Math.min(...b.matchReasons.map((reason) => MATCH_RANK[reason.kind] ?? 4));
    return aRank - bRank || a.entry.headword.length - b.entry.headword.length ||
      a.entry.headword.localeCompare(b.entry.headword, "eo");
  });
  const results = ranked.slice(0, input.limit).map(({ entry, matchReasons }) => ({
    entry: {
      ...entry,
      translations: entry.translations.filter((translation) => languages.includes(translation.lng)),
    },
    matchReasons,
  }));

  return { query, languages, results };
}
