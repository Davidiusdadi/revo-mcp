import { fromXSystem, generateStems, hasXSystem, normalizeQuery } from "../stemmer";
import { lemmaCandidates } from "../morph";
import type { LookupResult } from "../db";
import type { SearchInput, SearchOutput } from "../tools/search";

// The optional fourth field marks a translation filed under an <ind> key.
// Older three-field exports remain readable and rank as direct translations.
type SearchRow = [key: string, mark: string, label: string, indexed?: 1];
type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
export interface BrowserLanguage { code: string; name: string; count: number }

function entryBucket(mark: string): string {
  let hash = 2166136261;
  for (const byte of new TextEncoder().encode(mark)) hash = Math.imul(hash ^ byte, 16777619);
  return (hash >>> 24).toString(16).padStart(2, "0");
}

export class ShardRepository {
  private readonly cache = new Map<string, Promise<unknown>>();

  constructor(
    private readonly baseUrl: string,
    private readonly fetcher: Fetcher = (input, init) => globalThis.fetch(input, init),
  ) {}

  private json<T>(path: string): Promise<T> {
    let request = this.cache.get(path) as Promise<T> | undefined;
    if (!request) {
      request = this.fetcher(new URL(path, this.baseUrl)).then((response) => {
        if (!response.ok) throw new Error(`Dictionary shard failed (${response.status} ${path}).`);
        return response.json() as Promise<T>;
      });
      this.cache.set(path, request);
    }
    return request;
  }

  languages(): Promise<BrowserLanguage[]> {
    return this.json<BrowserLanguage[]>("languages.json");
  }

  private index(language: string): Promise<SearchRow[]> {
    return this.json<SearchRow[]>(`index/${encodeURIComponent(language)}.json`);
  }

  private entry(mark: string): Promise<LookupResult> {
    return this.json<Record<string, LookupResult>>(`entries/${entryBucket(mark)}.json`)
      .then((entries) => {
        const entry = entries[mark];
        if (!entry) throw new Error(`Dictionary entry is absent from its shard (${mark}).`);
        return entry;
      });
  }

  async lookup(mark: string, languages: string[]): Promise<LookupResult> {
    const selected = [...new Set(languages.filter((language) => language !== "eo"))];
    const entry = await this.entry(mark);
    return {
      ...entry,
      translations: entry.translations.filter(({ lng }) => selected.includes(lng)),
    };
  }

  async search(input: SearchInput): Promise<SearchOutput> {
    const query = hasXSystem(input.query) ? fromXSystem(input.query) : input.query;
    const normalized = normalizeQuery(query);
    const languages = [...new Set(input.languages.filter((language) => language !== "eo"))];
    const matches = new Map<string, { label: string; order: number; reasons: SearchOutput["results"][number]["matchReasons"] }>();
    let sequence = 0;
    const candidates = [normalized, ...lemmaCandidates(normalized).map(({ lemma }) => lemma), ...generateStems(normalized)];

    const merge = async (language: string) => {
      const languageCandidates = language === "eo" ? candidates : [normalized];
      for (const candidate of [...new Set(languageCandidates)]) {
        const rows = await this.index(language);
        const exact = rows.filter(([key]) => key === candidate);
        const selected = exact.length ? exact : rows.filter(([key]) => key.startsWith(candidate)).slice(0, input.limit * 2);
        for (const [key, mark, label] of selected) {
          const reason = {
            language,
            text: language === "eo" ? label : key,
            kind: language === "eo"
              ? (candidate === normalized ? (key === normalized ? "headword" : "prefix") : "stem")
              : (key === normalized ? "translation" : "translation-prefix"),
          };
          const match = matches.get(mark);
          if (match) match.reasons.push(reason);
          else matches.set(mark, { label, order: sequence++, reasons: [reason] });
        }
      }
    };
    await merge("eo");
    for (const language of languages) await merge(language);

    const rank = (match: { reasons: SearchOutput["results"][number]["matchReasons"] }) =>
      Math.min(...match.reasons.map(({ kind }) => ["headword", "translation"].includes(kind) ? 0 : kind === "stem" ? 1 : 2));
    const ordered = [...matches.entries()]
      .sort((a, b) => rank(a[1]) - rank(b[1]) || a[1].order - b[1].order || a[1].label.length - b[1].label.length ||
        a[1].label.localeCompare(b[1].label, "eo"))
      .slice(0, input.limit);
    const entries = await Promise.all(ordered.map(async ([mark, match]) => ({
      entry: await this.lookup(mark, languages),
      matchReasons: match.reasons,
    })));
    return {
      query,
      languages,
      results: entries.map(({ entry, matchReasons }) => ({
        entry,
        matchReasons,
      })),
    };
  }
}
