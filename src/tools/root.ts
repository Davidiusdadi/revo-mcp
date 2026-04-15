import { z } from "zod";
import { lookupFamily } from "../db";

export const lookupRootInputSchema = z.object({
  root: z
    .string()
    .min(1)
    .max(100)
    .describe(
      "Esperanto root or any word form (e.g. 'rav', 'ravi', 'amik')"
    ),
  show_languages: z
    .array(z.string())
    .optional()
    .describe(
      "Language codes to show (e.g. ['en', 'de']). Defaults to en, de, fr, es, ru."
    ),
});

export type LookupRootInput = z.infer<typeof lookupRootInputSchema>;

const DEFAULT_LANGS = ["en", "de", "fr", "es", "ru"];

export function handleLookupRoot(args: LookupRootInput): string {
  const { root, show_languages } = args;
  const langs = show_languages?.length ? show_languages : DEFAULT_LANGS;

  const family = lookupFamily(root);
  if (!family) return `No word family found for "${root}".`;

  const lines: string[] = [`## Word family: ${family.root}`];

  for (const member of family.members) {
    const filtered = member.translations.filter((t) => langs.includes(t.lng));
    const byLang = new Map<string, string[]>();
    for (const t of filtered) {
      const existing = byLang.get(t.lng) ?? [];
      existing.push(t.trd);
      byLang.set(t.lng, existing);
    }
    const trdStr = [...byLang.entries()]
      .map(([lng, trds]) => `${lng}: ${[...new Set(trds)].join(", ")}`)
      .join(" | ");

    lines.push(`- **${member.headword}** — ${trdStr || "(no translations)"}`);
  }

  return lines.join("\n");
}
