import { fromXSystem, generateStems, hasXSystem, normalizeQuery } from "../stemmer";
import { lemmaCandidates } from "../morph";
import { reductionsOf } from "../source-forms";
import type { LookupResult } from "../db";
import type { BrowserSearchInput, BrowserSearchOutput } from "./search-schema";

// The optional fourth field marks a translation filed under an <ind> key.
// Older three-field exports remain readable and rank as direct translations.
type SearchRow = [key: string, mark: string, label: string, indexed?: 1, expression?: string];
type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
export interface BrowserLanguage { code: string; name: string; count: number }
type MatchReason = BrowserSearchOutput["results"][number]["matchReasons"][number];
type PendingReason = MatchReason & { key: string; rank: Rank };
interface Ranking {
  ranked: { mark: string; reasons: PendingReason[]; rank: Rank }[];
  languageMatches: BrowserSearchOutput["languageMatches"];
}

function entryBucket(mark: string): string {
  let hash = 2166136261;
  for (const byte of new TextEncoder().encode(mark)) hash = Math.imul(hash ^ byte, 16777619);
  return (hash >>> 24).toString(16).padStart(2, "0");
}

export class ShardRepository {
  private readonly cache = new Map<string, Promise<unknown>>();
  private ranking?: { key: string; value: Promise<Ranking> };

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

  async search(input: BrowserSearchInput): Promise<BrowserSearchOutput> {
    const query = hasXSystem(input.query) ? fromXSystem(input.query) : input.query;
    // Esperanto is always searched; its position in the request only breaks ties.
    const requested = [...new Set(input.languages)];
    const order = requested.includes("eo") ? requested : ["eo", ...requested];
    const languages = order.filter((language) => language !== "eo");
    const focus = input.matchLanguage;
    // Paging asks for the same ranking page after page, so the latest one is kept.
    const key = JSON.stringify([query, order, focus]);
    if (this.ranking?.key !== key) {
      const value = this.rank(query, order, focus);
      this.ranking = { key, value };
      value.catch(() => { if (this.ranking?.value === value) this.ranking = undefined; });
    }
    const { ranked, languageMatches } = await this.ranking.value;
    const offset = input.offset ?? 0;

    const results = await Promise.all(ranked.slice(offset, offset + input.limit).map(async ({ mark, reasons }) => {
      const entry = await this.lookup(mark, languages);
      // A result is named by the match it is ranked by: the narrowed
      // language's, or else its strongest. Either way matchReasons[0] is the title.
      const title = focus ? reasons.findIndex(({ language }) => language === focus) : 0;
      const named = title > 0 ? [reasons[title], ...reasons.filter((_, index) => index !== title)] : reasons;
      const matchReasons = named.map(({ key, rank: _rank, ...reason }): MatchReason => {
        if (reason.language === "eo" || reason.text !== key) return reason;
        // Direct rows only carry the folded key; restore ReVo's own spelling.
        const translation = entry.translations.find(({ lng, trd }) =>
          lng === reason.language && normalizeQuery(trd) === key
        );
        if (!translation) return reason;
        return { ...reason, text: translation.trd, ...(reason.via ? { via: translation.trd } : {}) };
      });
      return { entry, matchReasons };
    }));
    return { query, languages, results, total: ranked.length, languageMatches };
  }

  /** Every match of the query, ranked, and how many entries each language matched. */
  private async rank(query: string, order: string[], focus?: string): Promise<Ranking> {
    const normalized = normalizeQuery(query);
    const matches = new Map<string, PendingReason[]>();
    const matched = new Map(order.map((language) => [language, new Set<string>()]));

    const addRows = (language: string, rows: [SearchRow, number][], kind: string, via?: string, candidate = 0) => {
      const languageRank = order.indexOf(language);
      for (const [[key, mark, label, indexed, expression], position] of rows) {
        // Every form a reason carries is spelled as ReVo wrote it, not as folded.
        const form = language === "eo" && via ? label : indexed ? indexForm(key, expression) : via;
        const reason: PendingReason = {
          language,
          text: language === "eo" ? label : (expression ?? key),
          kind: indexed ? `${kind}-indexed` : kind,
          ...(form ? { via: form } : {}),
          key,
          rank: [kindRank(kind), languageRank, candidate, position],
        };
        matched.get(language)?.add(mark);
        const reasons = matches.get(mark);
        if (!reasons) matches.set(mark, [reason]);
        else if (!reasons.some((item) => sameReason(item, reason))) reasons.push(reason);
      }
    };

    const eoRows = await this.index("eo");
    const eoExact = exactRows(eoRows, normalized);
    if (eoExact.length) {
      addRows("eo", eoExact, "headword");
    } else {
      // Derived candidates must name a headword exactly: a short stem such as
      // "gl" would otherwise prefix-match half the dictionary.
      const candidates = [...new Set([
        ...lemmaCandidates(normalized).map(({ lemma }) => lemma),
        ...generateStems(normalized),
      ].filter((candidate) => candidate !== normalized))];
      let found = false;
      // Morphology lists its likeliest analysis first; keep that ahead of corpus order.
      candidates.forEach((candidate, index) => {
        const rows = exactRows(eoRows, candidate);
        if (rows.length) addRows("eo", rows, "stem", candidate, index);
        found ||= rows.length > 0;
      });
      if (!found) addRows("eo", prefixRows(eoRows, normalized), "prefix");
    }

    for (const language of order.filter((language) => language !== "eo")) {
      const rows = await this.index(language);
      const exact = exactRows(rows, normalized);
      if (exact.length) {
        addRows(language, exact, "translation");
        continue;
      }
      const reduction = reductionsOf(query, language)
        .map((form) => ({ form, rows: exactRows(rows, normalizeQuery(form)) }))
        .find(({ rows }) => rows.length);
      if (reduction) addRows(language, reduction.rows, "translation-reduced", reduction.form);
      else addRows(language, prefixRows(rows, normalized), "translation-prefix");
    }

    const ranked = [...matches.entries()].flatMap(([mark, reasons]) => {
      reasons.sort((a, b) => compareRank(a.rank, b.rank));
      // A result narrowed to one language ranks by its match there alone.
      const lead = focus ? reasons.find(({ language }) => language === focus) : reasons[0];
      return lead ? [{ mark, reasons, rank: lead.rank }] : [];
    }).sort((a, b) => compareRank(a.rank, b.rank));
    const languageMatches = order.map((language) => ({ language, count: matched.get(language)!.size }));
    return { ranked, languageMatches };
  }
}

type Rank = [kind: number, language: number, candidate: number, position: number];

function kindRank(kind: string): number {
  if (kind === "headword" || kind === "translation") return 0;
  if (kind === "stem" || kind === "translation-reduced") return 1;
  return 2;
}

function compareRank(a: Rank, b: Rank): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || a[3] - b[3];
}

function sameReason(a: MatchReason, b: MatchReason): boolean {
  return a.language === b.language && a.text === b.text && a.kind === b.kind && a.via === b.via;
}

function exactRows(rows: SearchRow[], key: string): [SearchRow, number][] {
  const found: [SearchRow, number][] = [];
  rows.forEach((row, position) => { if (row[0] === key) found.push([row, position]); });
  return found;
}

function prefixRows(rows: SearchRow[], prefix: string): [SearchRow, number][] {
  const found: [SearchRow, number][] = [];
  rows.forEach((row, position) => { if (row[0].startsWith(prefix)) found.push([row, position]); });
  return found;
}

/** The index form as ReVo wrote it inside the expression, when it is there. */
function indexForm(key: string, expression?: string): string {
  const start = expression?.toLowerCase().indexOf(key) ?? -1;
  return start >= 0 && expression!.toLowerCase().length === expression!.length
    ? expression!.slice(start, start + key.length)
    : key;
}
