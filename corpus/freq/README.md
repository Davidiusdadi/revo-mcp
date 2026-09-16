# corpus/freq

`counts.tsv`: how often each Esperanto lemma (dictionary form) is used, in two
corpora, one column each. The `freq` pass (`src/corpus/passes/freq.ts`) reads
it at build time, holds every lemma against ReVo and writes `x_freq_word` and
`x_freq_root` into `data/voko.db`; `docs/corpus.md` describes the tables.

Every lemma ReVo lists is in the file, zero counts included, so a word that
never occurs is visible as such. Other lemmas are kept when used at least 50
times on the web or 5 times in Tekstaro; below that, the web is mostly typos
and names. Rows are sorted by lemma, so a regeneration diffs by row.

## Where the numbers come from

The file's own header lines record, per source, the URL, sha256 and date of
the download, the licence, the edition, and the number of Esperanto tokens
counted (the denominator of the rates per million).

- **hplt** — HPLT v2, cleaned, `epo_Latn` (web text, one shard of 1.1 GB).
  Released under CC0 1.0, which places no condition on the counts.
  Only lines the release itself tags as Esperanto (`seg_langs`) are counted.
- **tekstaro** — Tekstaro de Esperanto (tekstaro.com), TEI XML edition with
  morpheme boundaries; 128 texts from 1887 on, the corpus ReVo cites. No
  licence is stated for the text, so the text stays on the machine that
  counts; the file holds counts only.

## How a count is made

1. Text is lowercased and split into tokens: runs of letters, with hyphens and
   apostrophes inside (`s-ro`, `l'`). Letters glued to a digit are dropped.
   An elided ending is restored (`kor'` → koro, `l'` → la). A hyphenated word
   whose parts are all words is counted as its parts; one with a single-letter
   part stays whole (`s-ro`). Tokens in the x-system are converted. A token
   with a letter outside the Esperanto alphabet counts as foreign and is left
   out (the header's `tokens=` excludes it).
2. Each form is folded to its lemma with `lemmaOf` (`src/morph.ts`): `-oj`,
   `-on`, `-ojn` → `-o`; `-aj`, `-an`, `-ajn` → `-a`; `-en` → `-e`; `-as`,
   `-is`, `-os`, `-us`, `-u` → `-i`; table words and pronouns lose only `j`
   and `n`; participles keep their own form; everything else stays as written.
3. The counts of all forms of a lemma are added.

## Regenerating

Needs `zstd` and `unzip`, about 1.4 GB under `data/freq/sources/`, and a built
`data/voko.db`. Intermediate files land in `data/freq/` (git-ignored).

```bash
bun run freq:fetch      # downloads both sources, records data/freq/sources/SOURCES.json
bun run freq:count      # surface forms, then lemmas, per source (~8 min for the web)
bun run freq:classify   # holds every lemma against ReVo, writes data/freq/REPORT.md (~10 min)
bun run freq:reduce     # writes corpus/freq/counts.tsv
bun run corpus:build --pass freq
```

`REPORT.md` is the full picture the file is cut from: coverage curves, the
words ReVo does not list, the headwords never seen, cross-checks against
published lists.

## Words ReVo lacks

```bash
bun run freq:candidates   # after freq:classify; ~15 min for the web pass
```

writes `data/freq/candidates.md`: the words used at least 1,000 times on the
web and 10 times in Tekstaro that ReVo has no entry for, each with its split,
where it is used (documents, sites, Tekstaro texts and years), example
sentences, and warnings for what looks like a name, an abbreviation or one
site's word. Derived words are grouped by the article that would hold them.
