/**
 * MCP tools: family and familyExamples — the word families under an entry.
 *
 * `family` lists the entries built on each root of an entry's headword, in
 * whichever article, with their translations; a large family comes in pages.
 * `familyExamples` finds the example sentences that use those families, a
 * group per root.
 */

import { z } from "zod";
import { getDb } from "../db";
import { familyExamples, familyOf } from "../family";

const languagesField = z.array(z.string().min(2).max(12)).max(174).optional();

export const familyInputSchema = z.object({
  mark: z.string().min(1).max(200).describe("The entry's ReVo mark, such as hund.cxas0o."),
  languages: languagesField.describe("Translation languages to include; all of them when omitted."),
  limit: z.number().int().min(1).max(2000).default(200).describe("Members listed per family."),
  offset: z.number().int().min(0).default(0).describe("Members skipped per family, in the family's order."),
  only: z.string().min(1).max(60).optional().describe("Only the family of this root, such as hund."),
});

const spanSchema = z.object({ morph: z.string(), kind: z.enum(["R", "W", "P", "S"]), at: z.number().int() });
const wordSchema = z.object({ headword: z.string(), tilde: z.string(), spans: z.array(spanSchema) });
const translationSchema = z.object({ lng: z.string(), trd: z.string() });

export const familyOutputSchema = z.object({
  available: z.boolean().describe("False when the database has no word families."),
  entry: wordSchema.extend({
    mrk: z.string(),
    article: z.string(),
    articleRoot: z.string(),
    variants: z.array(wordSchema),
  }),
  families: z.array(z.object({
    root: z.string(),
    affix: z.enum(["P", "S"]).optional(),
    own: z.boolean().describe("The root of the entry's own article."),
    articles: z.array(z.object({ article: z.string(), rad: z.string() })),
    members: z.array(wordSchema.extend({
      mrk: z.string(),
      article: z.string(),
      articleRoot: z.string(),
      variantOf: z.string().optional(),
    })),
    entries: z.number().int().describe("Members in the whole family."),
    offset: z.number().int(),
    translated: z.array(z.object({ language: z.string(), count: z.number().int() }))
      .describe("Listed members with a translation in each language, most first."),
  })),
  translations: z.record(z.string(), z.array(translationSchema)).describe("The listed members' translations, by mark."),
});

export const familyExamplesInputSchema = z.object({
  roots: z.array(z.string().min(2).max(60)).min(1).max(8)
    .describe("Family roots in priority order; an example is listed under the first one it uses."),
  languages: languagesField.describe("Languages of the examples' translations; all of them when omitted."),
  limit: z.number().int().min(1).max(5000).default(200).describe("Examples listed per root."),
  offset: z.number().int().min(0).default(0),
  exactTotal: z.boolean().default(true)
    .describe("Count every example (true), or stop once the page is full and report the candidates as an upper bound."),
  only: z.string().min(2).max(60).optional().describe("Only this root's group; earlier roots still claim their examples."),
  mark: z.string().min(1).max(200).optional().describe("Leave out this entry's own examples, and the same sentences quoted elsewhere."),
});

const matchSchema = z.object({
  root: z.string(),
  at: z.number().int(),
  length: z.number().int(),
  rootAt: z.number().int(),
  headword: z.string().optional(),
  mrk: z.string().optional(),
});

export const familyExamplesOutputSchema = z.object({
  available: z.boolean().describe("False when the database has no word families or examples."),
  groups: z.array(z.object({
    root: z.string(),
    examples: z.array(z.object({
      id: z.number().int(),
      text: z.string(),
      article: z.string(),
      headword: z.string(),
      mrk: z.string().optional(),
      senseMrk: z.string().optional(),
      memberEntry: z.boolean(),
      matches: z.array(matchSchema),
      translations: z.array(translationSchema),
    })),
    total: z.number().int(),
    totalExact: z.boolean(),
    candidates: z.number().int(),
    offset: z.number().int(),
  })),
});

export type FamilyInput = z.infer<typeof familyInputSchema>;
export type FamilyOutput = z.infer<typeof familyOutputSchema>;
export type FamilyExamplesInput = z.infer<typeof familyExamplesInputSchema>;
export type FamilyExamplesOutput = z.infer<typeof familyExamplesOutputSchema>;

export function executeFamily({ mark, ...opts }: FamilyInput): FamilyOutput {
  return familyOf(getDb(), mark, opts);
}

export function executeFamilyExamples({ roots, ...opts }: FamilyExamplesInput): FamilyExamplesOutput {
  return familyExamples(getDb(), roots, opts);
}

/** One line per family, then its members. */
export function renderFamily(out: FamilyOutput): string {
  if (!out.available) return `${out.entry.headword}: no word families in this database.`;
  return out.families.map((family) => {
    const shown = family.members.map((m) => m.headword).join(", ");
    const more = family.entries > family.offset + family.members.length ? ", …" : "";
    return `${family.root} (${family.entries}): ${shown}${more}`;
  }).join("\n") || `${out.entry.headword}: no family.`;
}

/** One line per example, under its root. */
export function renderFamilyExamples(out: FamilyExamplesOutput): string {
  if (!out.available) return "No word families or examples in this database.";
  return out.groups.map((group) =>
    [`${group.root} (${group.totalExact ? group.total : `≤${group.total}`}):`, ...group.examples.map((e) => `- ${e.text} (${e.headword})`)].join("\n"),
  ).join("\n");
}
