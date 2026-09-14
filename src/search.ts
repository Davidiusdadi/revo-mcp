/**
 * The dictionary search of every runtime: the hosted server's `search` tool
 * and the browser's, over the same database.
 *
 * A query is looked for in the search rows (`serĉo`) of each searched
 * language: Esperanto headwords exactly, else the dictionary forms its ending
 * points to, else as a prefix; each translation language exactly, else a
 * reduced source form ("dogs" → dog), else as a prefix. An entry found in
 * several ways is ranked by its strongest match. The rows carry the entries'
 * usage domains, so counting and narrowing read no entry; only the page shown
 * does, and only what a result card shows of it.
 */

import type { SqlReader } from "./sql";
import { fromXSystem, generateStems, hasXSystem, normalizeQuery } from "./stemmer";
import { lemmaCandidates } from "./morph";
import { reductionsOf } from "./source-forms";
import {
  assembleEntry,
  entryNodesById,
  exactRows,
  indexForm,
  prefixRows,
  spelled,
  type SearchRow,
} from "./db-voko";
import type { SearchInput, SearchOutput } from "./tools/search";

type MatchReason = SearchOutput["results"][number]["matchReasons"][number];
type Rank = [kind: number, language: number, candidate: number, position: number];

/**
 * A match before its entry is read. An Esperanto match is named by the entry's
 * headword (`text` unset), and a stem match names the headword it reached
 * (`viaHeadword`); both are filled in for the page shown.
 */
interface PendingReason {
  language: string;
  kind: string;
  text?: string;
  via?: string;
  viaHeadword?: true;
  rank: Rank;
}

interface Ranking {
  ranked: { nid: number; reasons: PendingReason[]; rank: Rank; domains: string[] }[];
  languageMatches: SearchOutput["languageMatches"];
}

// Paging asks for the same ranking page after page, so the latest one is kept.
let latest: { db: SqlReader; key: string; ranking: Ranking } | undefined;

export function searchDictionary(db: SqlReader, input: SearchInput): SearchOutput {
  const query = hasXSystem(input.query) ? fromXSystem(input.query) : input.query;
  // Esperanto is always searched; its position in the request only breaks ties.
  const requested = [...new Set(input.languages)];
  const order = requested.includes("eo") ? requested : ["eo", ...requested];
  const languages = order.filter((language) => language !== "eo");
  const focus = input.matchLanguage;
  const key = JSON.stringify([query, order, focus]);
  if (latest?.db !== db || latest.key !== key) latest = { db, key, ranking: rank(db, query, order, focus) };
  const { ranked, languageMatches } = latest.ranking;

  const counts = new Map<string, number>();
  for (const { domains } of ranked) {
    for (const domain of domains) counts.set(domain, (counts.get(domain) ?? 0) + 1);
  }
  const domainMatches = [...counts].map(([domain, count]) => ({ domain, count }))
    .sort((a, b) => b.count - a.count || a.domain.localeCompare(b.domain));
  const domain = input.domain;
  const listed = domain ? ranked.filter(({ domains }) => domains.includes(domain)) : ranked;
  const offset = input.offset ?? 0;
  const page = listed.slice(offset, offset + input.limit);

  const nodes = entryNodesById(db, page.map(({ nid }) => nid));
  const results = page.map(({ nid, reasons, domains }) => {
    const node = nodes.get(nid);
    if (!node) throw new Error(`The search rows name an entry the database lacks (node ${nid}); rebuild it.`);
    const entry = assembleEntry(db, node, { detail: "summary", languages, domains });
    // A result is named by the match it is ranked by: the narrowed
    // language's, or else its strongest. Either way matchReasons[0] is the title.
    const title = focus ? reasons.findIndex(({ language }) => language === focus) : 0;
    const named = title > 0 ? [reasons[title], ...reasons.filter((_, index) => index !== title)] : reasons;
    const matchReasons = named.map(({ language, kind, text, via, viaHeadword }): MatchReason => ({
      language,
      text: text ?? entry.headword,
      kind,
      ...(viaHeadword ? { via: entry.headword } : via !== undefined ? { via } : {}),
    }));
    return { entry, matchReasons };
  });
  return { query, languages, results, total: listed.length, languageMatches, domainMatches };
}

/** Every match of the query, ranked, and how many entries each language matched. */
function rank(db: SqlReader, query: string, order: string[], focus?: string): Ranking {
  const normalized = normalizeQuery(query);
  const matches = new Map<number, { reasons: PendingReason[]; domains: string[] }>();
  const matched = new Map(order.map((language) => [language, new Set<number>()]));

  const addRows = (language: string, rows: SearchRow[], kind: string, via?: string, candidate = 0) => {
    const languageRank = order.indexOf(language);
    for (const row of rows) {
      const rank: Rank = [kindRank(kind), languageRank, candidate, row.ord];
      const filed = row.ind ? `${kind}-indexed` : kind;
      // Every form a reason carries is spelled as ReVo wrote it, not as folded.
      const reason: PendingReason = language === "eo"
        ? { language, kind: filed, ...(row.ind ? { via: spelled(row) } : via ? { viaHeadword: true } : {}), rank }
        : row.ind
          ? { language, kind: filed, text: spelled(row), via: indexForm(row.norm, row.txt), rank }
          : { language, kind, text: spelled(row), ...(via ? { via: spelled(row) } : {}), rank };
      matched.get(language)?.add(row.nid);
      const found = matches.get(row.nid);
      if (!found) matches.set(row.nid, { reasons: [reason], domains: row.fak ? row.fak.split(" ") : [] });
      else if (!found.reasons.some((item) => sameReason(item, reason))) found.reasons.push(reason);
    }
  };

  if (normalized) {
    const eoExact = exactRows(db, "eo", normalized);
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
        const rows = exactRows(db, "eo", candidate);
        if (rows.length) addRows("eo", rows, "stem", candidate, index);
        found ||= rows.length > 0;
      });
      if (!found) addRows("eo", prefixRows(db, "eo", normalized), "prefix");
    }

    for (const language of order.filter((language) => language !== "eo")) {
      const exact = exactRows(db, language, normalized);
      if (exact.length) {
        addRows(language, exact, "translation");
        continue;
      }
      let reduced = false;
      for (const form of reductionsOf(query, language)) {
        const rows = exactRows(db, language, normalizeQuery(form));
        if (!rows.length) continue;
        addRows(language, rows, "translation-reduced", form);
        reduced = true;
        break;
      }
      if (!reduced) addRows(language, prefixRows(db, language, normalized), "translation-prefix");
    }
  }

  const ranked = [...matches].flatMap(([nid, { reasons, domains }]) => {
    reasons.sort((a, b) => compareRank(a.rank, b.rank));
    // A result narrowed to one language ranks by its match there alone.
    const lead = focus ? reasons.find(({ language }) => language === focus) : reasons[0];
    return lead ? [{ nid, reasons, rank: lead.rank, domains }] : [];
  }).sort((a, b) => compareRank(a.rank, b.rank));
  const languageMatches = order.map((language) => ({ language, count: matched.get(language)!.size }));
  return { ranked, languageMatches };
}

function kindRank(kind: string): number {
  if (kind === "headword" || kind === "translation") return 0;
  if (kind === "stem" || kind === "translation-reduced") return 1;
  return 2;
}

function compareRank(a: Rank, b: Rank): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || a[3] - b[3];
}

function sameReason(a: PendingReason, b: PendingReason): boolean {
  return a.language === b.language && a.text === b.text && a.kind === b.kind &&
    a.via === b.via && a.viaHeadword === b.viaHeadword;
}
