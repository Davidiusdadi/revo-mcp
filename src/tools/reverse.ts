/**
 * MCP tool: reverse_lookup — find a word from a description of its meaning.
 *
 * Searches the definition text itself (fts_dif), which no other tool reaches:
 * `lookup` matches headwords and translations, `examples` matches sentences.
 */

import { z } from "zod";
import { searchDefinitions } from "../db";

export const reverseLookupInputSchema = z.object({
  description: z
    .string()
    .min(2)
    .max(200)
    .describe(
      "Esperanto words describing the meaning, e.g. 'granda birdo' (large bird) or " +
        "'ilo por tranĉi' (tool for cutting). All terms must appear in the same " +
        "definition. Diacritics are folded and x-system input is accepted."
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(15)
    .describe("Maximum number of words to return (1-50)."),
});

export type ReverseLookupInput = z.infer<typeof reverseLookupInputSchema>;

export function handleReverseLookup(args: ReverseLookupInput): string {
  const { description, limit } = args;

  const hits = searchDefinitions(description, limit);
  if (hits.length === 0) {
    return (
      `No definition matches \`${description}\`.\n\n` +
      "_Definitions are written in Esperanto — describe the meaning in Esperanto " +
      "(e.g. `granda birdo`, not `large bird`). Fewer terms match more broadly._"
    );
  }

  const lines: string[] = [
    `Found ${hits.length} definition${hits.length === 1 ? "" : "s"} matching \`${description}\`.`,
    "",
  ];
  for (const hit of hits) {
    lines.push(`- **${hit.headword}** (${hit.article}) — ${hit.snippet}`);
  }
  lines.push("");
  lines.push("_Call `lookup` on any headword above for its full dictionary entry._");
  return lines.join("\n");
}
