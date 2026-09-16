/** Pure source-language word reductions shared by glossing and browser search. */

const REDUCTIONS: Record<string, readonly (readonly [RegExp, string])[]> = {
  en: [[/ies$/, "y"], [/ves$/, "f"], [/ves$/, "fe"], [/([sxz]|ch|sh)es$/, "$1"], [/s$/, ""],
    [/([bdgklmnprt])\1(ed|ing)$/, "$1"], [/ied$/, "y"], [/ed$/, ""], [/ed$/, "e"],
    [/ing$/, ""], [/ing$/, "e"], [/est$/, ""], [/er$/, ""], [/ly$/, ""], [/n$/, ""]],
  de: [[/nen$/, "n"], [/en$/, ""], [/ern$/, "er"], [/es$/, ""], [/er$/, ""], [/e$/, ""], [/n$/, ""], [/s$/, ""]],
};

/** Case variants to try before any reduction: as written, lowercased, capitalised. */
export function caseForms(term: string): string[] {
  const lower = term.toLowerCase();
  const title = lower.charAt(0).toUpperCase() + lower.slice(1);
  return [...new Set([term, lower, title])];
}

export function reductionsOf(term: string, lang: string): string[] {
  const rules = REDUCTIONS[lang] ?? [];
  const out: string[] = [];
  const lower = term.toLowerCase();
  for (const [re, replacement] of rules) {
    if (!re.test(lower)) continue;
    const form = lower.replace(re, replacement);
    if (form.length >= 3 && form !== lower && !out.includes(form)) out.push(form);
  }
  return out;
}

export interface SourceFormAttempt {
  forms: string[];
  /** The reduced dictionary form, when this is not the term as written. */
  via?: string;
}

export function sourceFormAttempts(term: string, lang: string): SourceFormAttempt[] {
  return [
    { forms: caseForms(term) },
    ...reductionsOf(term, lang).map((via) => ({ forms: caseForms(via), via })),
  ];
}
