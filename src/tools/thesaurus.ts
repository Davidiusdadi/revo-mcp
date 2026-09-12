/**
 * MCP tool: thesaurus — the reference graph around a word.
 *
 * Reads the edges the `refs` pass resolved, so it also reports the inverse
 * links the word's own article never states (a breed declares itself a kind
 * of dog; `hundo` gets the breed back).
 */

import { z } from "zod";
import { lookupThesaurus } from "../db";

export const thesaurusInputSchema = z.object({
  word: z
    .string()
    .min(1)
    .max(100)
    .describe(
      "Esperanto word or root (e.g. 'hundo', 'akvo'). Inflected forms are accepted " +
        "('hundojn' finds 'hundo'), as is x-system input ('cxevalo')."
    ),
  relations: z
    .array(z.string())
    .optional()
    .describe(
      "Restrict to these relation types: sin (synonym), ant (antonym), vid (see also), " +
        "super (is a kind of), sub (has kind), prt (has part), malprt (belongs to), " +
        "hom (homonym), lst (list). Defaults to all."
    ),
});

export type ThesaurusInput = z.infer<typeof thesaurusInputSchema>;

export function handleThesaurus(args: ThesaurusInput): string {
  const { word, relations } = args;

  const result = lookupThesaurus(word);
  if (!result) return `No dictionary entry for "${word}".`;

  const groups = relations?.length
    ? result.groups.filter((g) => g.tip !== null && relations.includes(g.tip))
    : result.groups;

  const title = result.matchedVia
    ? `## Relations: ${result.headword} (${result.article}, via ${result.matchedVia})`
    : `## Relations: ${result.headword} (${result.article})`;

  if (groups.length === 0) {
    return relations?.length
      ? `${title}\n\nNo ${relations.join("/")} relations recorded for "${result.headword}".`
      : `${title}\n\nNo relations recorded for "${result.headword}".`;
  }

  const lines: string[] = [title, ""];
  let anyInferred = false;

  for (const group of groups) {
    const entries = group.entries.map((e) => {
      if (e.inferred) anyInferred = true;
      return e.inferred ? `${e.headword}*` : e.headword;
    });
    const tip = group.tip ? ` \`${group.tip}\`` : "";
    lines.push(`**${group.label}**${tip} — ${entries.join(" · ")}`);
  }

  lines.push("");
  if (anyInferred) {
    lines.push("_\\* = inverse link, stated by the other article rather than this one._");
  }
  lines.push("_Call `lookup` on any word above for its full dictionary entry._");
  return lines.join("\n");
}
