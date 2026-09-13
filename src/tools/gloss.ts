/**
 * MCP tool: gloss — a whole text in, corpus-backed suggestions out.
 *
 * The other tools answer one word at a time. Translating a paragraph with them
 * costs a call per word, and the words a translator most needs to check are
 * the ones they do not think to look up. This one takes the text itself.
 */

import { z } from "zod";
import { glossText } from "../db";
import type { Candidate, EoGloss, EoTerm, Part, SourceGloss, SourceTerm } from "../gloss";

export const glossInputSchema = z.object({
  text: z
    .string()
    .min(1)
    .max(8000)
    .describe(
      "The text to gloss — a sentence, a paragraph, or a whole passage. " +
        "Pass it as it stands; it is tokenized here."
    ),
  lang: z
    .string()
    .default("en")
    .describe(
      "Language of `text`. A source language ('en', 'de', 'fr', …) glosses it " +
        "into Esperanto: every content word and phrase with the Esperanto roots " +
        "available for it. 'eo' instead audits an Esperanto draft, classing each " +
        "word as a headword, an inflection, an attested form, a regular derivation, " +
        "or unknown."
    ),
  per_word: z
    .number()
    .int()
    .min(1)
    .max(10)
    .default(4)
    .describe("Esperanto candidates listed per source word (1-10)."),
  max_words: z
    .number()
    .int()
    .min(1)
    .max(300)
    .default(80)
    .describe("Cap on distinct words reported, so a long text stays readable."),
});

export type GlossInput = z.infer<typeof glossInputSchema>;

export function handleGloss(args: GlossInput): string {
  const { text, lang, per_word, max_words } = args;
  const result = glossText(text, { lang, perTerm: per_word, maxWords: max_words });
  return result.mode === "eo" ? renderEo(result) : renderSource(result);
}

// ---------------------------------------------------------------------------
// source → Esperanto
// ---------------------------------------------------------------------------

/** `okulo`, or `elorbitigi la okulojn (orbit)` when the headword hides its root. */
function candidate(c: Candidate): string {
  const root = c.eo.toLowerCase().startsWith(c.art) ? "" : ` (${c.art})`;
  const sense = c.src ? ` [${c.src}]` : "";
  return `${c.eo}${root}${sense}`;
}

function termLine(t: SourceTerm): string {
  const via = t.via ? ` _(via ${t.via})_` : "";
  const more = t.more > 0 ? ` _+${t.more}_` : "";
  return `- **${t.term}**${via} — ${t.candidates.map(candidate).join(" · ")}${more}`;
}

function renderSource(g: SourceGloss): string {
  const found = g.terms.length;
  const out: string[] = [
    `## Glossary: ${g.lang} → eo`,
    "",
    `${g.words} words · ${found} glossed · ${g.missing.length} not in the dictionary`,
    "",
  ];

  if (g.phrases.length > 0) {
    out.push("**Phrases** — entries the single words would not give you", "");
    for (const p of g.phrases) out.push(termLine(p));
    out.push("");
  }

  if (found > 0) {
    out.push("**Words**", "");
    for (const t of g.terms) out.push(termLine(t));
    out.push("");
  }

  if (g.missing.length > 0) {
    out.push(
      `**No entry** — ${g.missing.map((m) => m.term).join(", ")}`,
      "",
      "_These need care: the dictionary offers nothing, so anything you write for them " +
        "is your own coinage. Try `reverse_lookup` with an Esperanto description, or " +
        "`examples` for the bare form._",
      ""
    );
  }

  if (g.truncated > 0) out.push(`_${g.truncated} further distinct words not shown (max_words)._`, "");
  out.push(
    "_A bracketed phrase is ReVo's own wording for that sense; a name in parentheses is " +
      "the article, i.e. the root to build on. Call `lookup` for definitions and senses._"
  );
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Esperanto audit
// ---------------------------------------------------------------------------

/** `-end- "kiun oni devas fari"` for an affix, `ardezo` for a root, bare for an ending. */
function part(p: Part): string {
  if (p.k === "E") return `-${p.m}`;
  if (p.k === "P" || p.k === "S") {
    const affix = p.k === "P" ? `${p.m}-` : `-${p.m}-`;
    return p.gloss ? `${affix} "${p.gloss}"` : affix;
  }
  return p.gloss ?? p.m;
}

const build = (parts: Part[] | undefined): string =>
  parts && parts.length > 0 ? parts.map(part).join(" + ") : "";

function renderEo(g: EoGloss): string {
  const c = g.counts;
  const known = c.headword + c.inflection;
  const out: string[] = [
    "## Esperanto check",
    "",
    `${g.words} words · ${g.terms.length} distinct · ${c.unknown} unknown · ` +
      `${c.derived} regular derivation${c.derived === 1 ? "" : "s"} · ` +
      `${c.attested} attested only · ${known} in the dictionary`,
    "",
  ];

  const pick = (v: EoTerm["verdict"]) => g.terms.filter((t) => t.verdict === v);
  const times = (t: EoTerm) => (t.n > 1 ? ` ×${t.n}` : "");

  const unknown = pick("unknown");
  if (unknown.length > 0) {
    out.push("**Unknown** — no article, nothing attested, and no reading from known morphemes", "");
    for (const t of unknown) {
      const hint = t.near?.length ? ` — did you mean **${t.near.join("** / **")}**?` : "";
      out.push(`- **${t.word}**${times(t)}${hint}`);
    }
    out.push("");
  }

  const derived = pick("derived");
  if (derived.length > 0) {
    out.push("**Regular derivations** — well formed, though no article lists them", "");
    for (const t of derived) {
      const near = t.near?.length ? ` _(one letter from **${t.near.join("** / **")}**, which ReVo lists — is that the word?)_` : "";
      out.push(`- **${t.word}**${times(t)} = \`${t.seg}\` — ${build(t.parts)}${near}`);
    }
    out.push("");
  }

  const attested = pick("attested");
  if (attested.length > 0) {
    out.push("**Attested, not a headword** — written in ReVo's own examples", "");
    for (const t of attested) {
      const seg = t.seg ? ` = \`${t.seg}\` — ${build(t.parts)}` : "";
      out.push(`- **${t.word}**${times(t)} (${t.attested}× in the examples)${seg}`);
    }
    out.push("");
  }

  const twice = g.terms.filter((t) => t.also);
  if (twice.length > 0) {
    out.push("**Two readings** — the context has to decide", "");
    for (const t of twice) {
      const first = t.headword ? `${t.headword} (${t.art})` : `\`${t.seg}\``;
      out.push(
        `- **${t.word}**${times(t)} — ${first}` +
          `${t.seg && t.headword ? ` \`${t.seg}\`` : ""}; also \`${t.also!.seg}\` — ${build(t.also!.parts)}`
      );
    }
    out.push("");
  }

  const fine = [...pick("headword"), ...pick("inflection")].filter((t) => !t.also);
  if (fine.length > 0) {
    const listed = fine
      .map((t) => (t.verdict === "inflection" ? `${t.word} → ${t.headword}` : t.word))
      .join(", ");
    out.push(`**In the dictionary** (${fine.length}) — ${listed}`, "");
  }

  if (g.truncated > 0) out.push(`_${g.truncated} further distinct words not shown (max_words)._`, "");
  out.push(
    "_Attested counts come from the example sentences, so a 1 is one author's usage, not a " +
      "frequency. A derivation's parts are quoted from the affix's own ReVo article._"
  );
  return out.join("\n");
}
