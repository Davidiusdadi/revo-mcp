/** How the tools that return an entry's translations describe one (db-voko.ts Translation). */

import { z } from "zod";

const noteSchema = z.object({
  klr: z.string(),
  tip: z.enum(["ind", "amb"]).optional()
    .describe("Where ReVo shows the note: without tip beside the entry's senses, 'ind' in a list without them, 'amb' in both."),
});

export const translationSchema = z.object({
  lng: z.string(),
  trd: z.string().describe("The translation, without its notes."),
  ind: z.string().optional().describe("The word inside it that ReVo files the entry under."),
  parts: z.array(z.union([z.string(), noteSchema])).optional().describe("The translation with its notes in place."),
  pr: z.string().optional().describe("Its reading, as kana or pinyin."),
  fnt: z.string().optional()
    .describe("Where it was found, when ReVo says: 'Vikt: de en; juĝis <model>' is taken from Wiktionary and judged by a model, " +
      "'AI: pl fr; proponis <model>; kontrolis <model>' proposed by a model from those languages' words and checked by another; " +
      "'; kontrolita' after either: checked by a person since."),
  kod: z.string().optional().describe("Its style or field code (ARK dated, VULG vulgar …), when it has one."),
  sense: z.number().int().optional().describe("Which of the entry's senses it translates, counted from 0."),
});
