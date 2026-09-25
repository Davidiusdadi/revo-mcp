# The XML corpus

`data/voko.db` is built from ReVo's VOKO XML sources instead of upstream's
prebuilt database. The XML comes from `vendor/revo-fonto` and its DTDs and name
lists from `vendor/voko-grundo` (both git submodules); `packages/voko-xml`
parses it; `src/corpus/` builds and enriches the database.

```sh
pnpm db:setup                   # both of the next two steps, for a fresh clone
pnpm fonto                      # check out both submodules, generate the parser's tables
pnpm corpus:build               # XML → data/voko.db, then all passes (~4 min, ~340 MB, + voko.db.zst)
pnpm corpus:build --stage core  # without the enrichment: articles + structure + search + morph + usage + examples (~184 MB, ~89 MB gzipped)
pnpm start                      # serve from data/voko.db; REVO_DB=… overrides the path
pnpm corpus:validate            # parity report against data/revo.db → data/parity.md
pnpm corpus:eval                # stemming recall on attested word forms
```

## Background

`data/revo.db` (upstream's daily `revosql_*.zip`) is Cetonio's *search index*:
articles are rendered HTML blobs, and the server used to scrape their structure
back out. Senses, citations, translation sub-structure (`ind`/`baz`/`pr`),
morphology (`<tld/>`, the `0` slot in `mrk`) and the typed `ref` graph are
flattened or lost there. Building from the XML keeps all of it, and enrichment
passes add what the XML only implies (word forms, morphology, inverse links).

Design rules: the XML stays in upstream's format, so edits can go to
`revuloj/revo-fonto` as PRs; the database stores the articles whole, exactly as
the XML states them, and everything derived belongs to a versioned pass.

## Layers

```
L0  source XML        vendor/revo-fonto (verbatim) + corpus/overlay/*.xml
L1  stored articles   data/voko.db: one table per DTD element, every article DOM-equal to its file
L2  derived           data/voko.db: node, headword, translation, serĉo, fts_*, x_*; one versioned pass each
```

- L1 holds only what the XML says, all of it: markup, citations, remarks,
  comments, whitespace. No heuristics.
- Every L2 table is owned by one pass (`src/corpus/passes/*.ts`) with a name and
  version, recorded in `meta_pass`. Re-running a pass rewrites only its tables.
- Stable keys: `mrk` where the XML has one, else the path key
  (`san/drv[0]/snc[2]`), which `nodes()` in voko-xml computes and the database
  does not store. Integer ids are positions in the corpus and change between
  builds; L2 tables are rebuilt with the database and use ids, anything kept
  outside it must use keys.
- The passes read the articles back from L1 (`articleTrees` in
  `src/corpus/documents.ts`), not from the sources, so `--pass` runs on a
  database alone. The runtime reads an entry the same way, as the id range of
  its node, and renders its text with `src/content.ts`, the module the passes
  render with: an entry's text is derived one way.
- Content we author goes to XML, never the DB: upstream-acceptable edits in the
  submodule on a fork branch; the rest in `corpus/overlay/` (see its README).

## Repo layout

```
vendor/revo-fonto/           submodule: the VOKO articles, sparse to revo/ cfg/   (pnpm fonto)
vendor/voko-grundo/          submodule: DTDs and name lists, sparse to dtd/ cfg/  (pnpm fonto)
corpus/overlay/              our VOKO articles (currently none)
packages/voko-xml/           the parser package (no SQLite; usable by other projects)
  src/tree.ts                the lossless document tree: node types, walking, domEqual
  src/dom.ts                 parse (saxes), serialize, fragments
  src/view.ts                `voko-xml/view`: tree + model + walk, no parser (browser-safe)
  src/entities.ts            named-entity substitution (hard error on unknown)
  src/model.ts               the 62 DTD elements + declared attributes
  src/walk.ts                roots, tilde expansion, kap forms, node path keys, inventory
  src/corpus.ts              article listing with overlay merge
  data/entities.json         836 resolved entities — generated, not committed
  data/cfg/*.json            lingvoj / fakoj / stiloj / mallongigoj — generated, not committed
scripts/fonto.sh             submodule checkout + entity generation (pnpm fonto)
scripts/gen-entities.ts      vendor/voko-grundo → packages/voko-xml/data (pnpm corpus:entities)
src/corpus/schema.sql        the build's records (meta, meta_pass) and the cfg lists
src/corpus/build.ts          XML → data/voko.db   (pnpm corpus:build [--stage core|full] [--limit N] [--no-passes] [--pass NAME] [--out F])
src/corpus/sources.ts        where the import reads the articles from
src/corpus/documents.ts      articles → one table per element (L1), each batch read back and compared; articleTrees for the passes
src/articles.ts              reading L1: id ranges back into voko-xml trees (runtime-safe)
src/content.ts               what a node's elements say: content, owners, rendered text, senses (runtime-safe)
src/corpus/pass.ts           pass contract, meta_pass bookkeeping
src/corpus/passes/           structure.ts, search.ts, examples.ts, index.ts, fts.ts, tld-links.ts, refs.ts, morph.ts, freq.ts, usage.ts (one per table group; morph.ts holds `morph` and `splits`)
corpus/freq/counts.tsv       usage counts per lemma from two corpora, with their provenance in its header (see corpus/freq/README.md)
src/search.ts                the search and entry tools' ranking over serĉo
src/morph.ts                 runtime-safe morphology: lemmaCandidates(), segment() (no DB, no voko-xml)
src/morph-weights.ts         segment()'s learned weights — generated by train-segment, derived from ReVo (GPL v2 only)
src/freq.ts                  runtime-safe reads of the frequency tables: wordFrequency(), morphFrequency(), webUsage()
src/db-voko.ts               entry assembly over node ranges; which passes a database has
scripts/compare-db.ts        parity: old revo.db vs voko.db key sets (pnpm corpus:validate → data/parity.md)
scripts/eval-stemming.ts     stemming recall on attested tilde forms (pnpm corpus:eval)
scripts/segment-cases.ts     the root-marked words and their evidence / tune / report parts
scripts/eval-segment.ts      segmenter accuracy on those words (pnpm corpus:eval-segment)
scripts/train-segment.ts     fits src/morph-weights.ts on the tune part (pnpm corpus:train-segment)
scripts/freq/                the counting pipeline behind corpus/freq/counts.tsv (pnpm freq:fetch / freq:count / freq:classify / freq:reduce)
```

## Corpus facts

- `<art mrk>` is a CVS `$Id:` stamp, not an ID. Article key = file name;
  `parseArtId()` yields revision and date.
- ~10k of 40.4k `<snc>` have no `mrk`; `subart` (194) and `subdrv` exist.
- The submodule is pinned to the fork's `master` (`f6da172`): upstream `c088349`
  (2026-09-11) plus the fork's own corrections, which are also submitted to ReVo
  through its edit service. The parity run below was measured at the earlier
  `b15014fc` (2026-02-28), the snapshot `data/revo.db` was built from, so that
  comparison is like-for-like.
- All 565 entity names used in the corpus resolve; 836 are defined. `&FE;`-style
  macros expand to text and are not re-encodable; single-codepoint entities are.
- Every article has comments; 4 use single-quoted attributes; 12k use numeric
  char refs. 79 files re-serialize byte-identically in `entities` mode; all
  13,079 round-trip losslessly at the DOM level (the guarantee we rely on).
- `dardanel.xml` is the only article whose root is `<rad var="j">` only.
- ReVo already has full affix articles (`ar`, `et`, `fi`, `ul`, `ej`, …); no
  overlay is needed for them.
- `owl/voko.ttl` gives ref semantics: `prt` inverseOf `malprt`; `sin`, `ant`,
  `hom` ⊂ `vid`; `drv`, `lst` ⊂ `super`; `ekz` ⊂ `sub`; `dif` ⊂ `sin`.
- Old-DB row counts are not clean floors (`traduko` has 12.5k exact duplicates
  and sense rows re-attached at drv level); parity compares key sets.

## Schema

Schema version 3 (`meta.schema_version`; the server refuses older files).

### L1: the articles

```
<element> (id, up, parent, txt, <its declared attributes>, ws, ws_end, open)   one table per DTD element
text      (id, up, parent, txt)            text runs in mixed content
comment   (id, up, parent, txt, ws)
article   (id, last_id, file UNIQUE, source fonto|overlay, rad)
meta      elements (the tables and their columns), xml_decl, doctype
```

- All tables share one id sequence in document order over the whole corpus,
  so an element's subtree is `id BETWEEN element.id AND last_id` in every
  table, and an article is `article.id..last_id`. `up` is the distance back to
  the parent (`parent` = `id - up`, a virtual column); NULL at the root and for
  a comment outside it.
- An element whose only child is one text node keeps it in `txt`. `ws` is the
  whitespace before the tag and `ws_end` before the closing tag: NULL is the
  standard indentation (a newline, two spaces per level below `<art>`), `''`
  none. `open` = 1 for `<x></x>` rather than `<x/>`.
- Table names are the tags: `art` is the `<art>` element, `article` the file;
  `bib` the `<bib>` element, `bibliogr` the list from `cfg/bibliogr.xml`.
- The import (`src/corpus/documents.ts`) refuses an element or attribute the
  DTD does not declare and an XML declaration or doctype other than the
  corpus's, and reads each batch back and compares it with the parsed files.
  Not kept: the order of attributes (XML gives it no meaning; 1,526 articles
  write theirs in another order) and entity spelling (resolved at parse;
  `serialize(doc, { encode: "entities" })` re-encodes).
- `readRange` (`src/articles.ts`) turns an id range back into voko-xml trees
  on any `SqlReader`, over HTTP too; with a node's `mask` it queries only the
  tables that have rows in the range.

### L2: nodes, headwords, translations

The `structure` pass writes what finds an entry and names it, each row under
its element's id:

```
node        (id, article_id, parent_id, kind, mrk, kap_id, last_id, mask)
headword    (id, node_id, main_id, txt, norm)       variants: main_id = the headword they vary
translation (id, node_id, lng, txt, ind, in_ekz)
lng · fako · stilo · mallongigo (data/cfg) · bibliogr (cfg/bibliogr.xml in the submodule)
meta (key, value) · meta_pass (pass, version, input_hash, rows, ms, at)
```

- `node`: the structural elements (`art`, `subart`, `drv`, `subdrv`, `snc`,
  `subsnc`). `kap_id` = the node's own headword, else the nearest ancestor's.
  `mask` is a bit set over the L1 tables with rows in `id..last_id`.
- `translation.lng` is the `<trd>`'s own, else its `<trdgrp>`'s; `txt` leaves
  out `klr`, `pr`, `baz` and `ofc`; `in_ekz` marks the translations of example
  sentences, which no lookup lists.
- Content (`src/content.ts`): a node's content is the elements inside it up to
  the nodes nested in it, each with an owner (the node itself, or the nearest
  `dif`, `ekz`, `rim`, `trd`, `ref`, `bld`, `klr`, `ke`, `mrk`, `kap` or `var`).
  Rendered text drops citations, expands `<tld/>` (`lit` rule applied) and
  quotes `<ctl>` „…“; a definition keeps an inline `<trd>` (Latin names) but
  not a `<trdgrp>`; a headword drops the separator before `<var>`.
- An entry is read as its node: `readRange` over its id range and mask, then
  `entryContent` for senses, references and usage domains, with the roots
  from `article.rad` and, only when a `<tld var>` needs them, the `<rad var>`
  rows of the article (the pass checks these equal the article's roots for
  every article). Its translations come from `translation` by id range. That
  keeps an entry to a few pages when the file is read over HTTP.

Upstream's shapes (`nodo`, `var`, `traduko`, `referenco`, `uzo`) are computed
by `scripts/compare-db.ts` from these tables and the articles; the runtime
reads the tables and `serĉo`. `ekzemplo`, `fts_ekz` (trigram over it) and
`fts_ekz_word` (its words) come from the `examples` pass; `fts_kap`, `fts_trd`
(the translations outside examples, + `ind`, `baz`, `pr` and the language, so a
lookup matches within one language; it keeps no copy of the text, since lookup
reads only the id), `fts_ekz_fold` (trigram over `ekzemplo`, diacritics folded) and `fts_dif`
(definitions, for reverse lookup) from the `fts` pass.

## Stages and revisions

A build is one of two stages of the same file, recorded in `meta.stage`:

| stage | passes | size | gzipped | answers |
|---|---|---:|---:|---|
| `core` | `structure`, `search`, `morph`, `usage`, `examples` | 184.0 MB | 89.1 MB | `search`, `entry`, `lookup`, `lookup_root`, `languages`, `gloss` for Esperanto text, `family`, `wordExamples`, `examples` (case folded only) |
| `full` (default) | `structure`, `search`, `morph`, `usage`, `examples`, `index`, `fts`, `tld-links`, `refs`, `splits`, `freq` | 321.4 MB | 156.8 MB | every tool |

Measured at 13,079 articles (revo-fonto d18ad4f). Both files hold every
article whole; the core one has only the indexes on `node(mrk)`,
`headword(norm)`, `x_morpheme(morph, kind)` and `x_family(node_id)`. Of the
core file, the articles take 92 MB (text runs 28.5 MB, `trd` 19.5 MB, comments
6.6 MB), `serĉo` 24.2 MB, `translation` 21.6 MB, the example sentences 32.4 MB
(`ekzemplo` 14.2 MB, `fts_ekz` 13.6 MB, `fts_ekz_word` 4.6 MB), the word families 5.4 MB
(`x_family` 4.45 MB, its node index 0.96 MB), `node` 4.0 MB, `headword`
1.5 MB, and the morpheme inventory a gloss segments with 0.95 MB
(`x_morpheme` 0.35 MB and its index 0.22 MB, `x_pair` 0.36 MB, `x_affix`),
and the usage counts a gloss weighs its suggestions with 3.7 MB (`x_usage`).
The examples and families grew the core file from 146.3 MB (66.3 MB gzipped)
built from the same sources. The splits of every headword and
attested form (`x_morph`, `x_token`, 6.7 MB with the index) are stored by
the `splits` pass in the full stage only; a browser computes a split when a
word is pointed at. A core file becomes a
full one by running the enrichment passes on it with `--pass`; no sources
needed. `hasPass`/`requirePasses` in `db-voko.ts` read `meta_pass`, so on a
core file `thesaurus`, `reverse_lookup` and a source-language `gloss` say
which passes they need instead of failing on a missing table; `lookup` skips
its FTS fallback, and `examples` finds a word through `fts_ekz`, which folds
case but not diacritics ("songo" finds sonĝo only in a full file).

Every build ends in `finish()`: `PRAGMA user_version` = the build time in Unix
seconds, `ANALYZE`, `VACUUM` (so each table and index lies in contiguous
pages), and `<out>.zst` beside the file (zstd level 19, about 2.5 min). `user_version` sits at byte 60 of the
file header, so a browser compares its stored copy with the published file by
reading the first 100 bytes; publish `voko.db` and `voko.db.zst` together, as
the browser checks that the download is the revision it saw.

## Passes (L2)

`pnpm corpus:build --pass NAME` reruns one pass on an existing `voko.db`
(and finishes the file again). Order matters: every pass reads `structure`'s
tables, and `index` and `fts` index `ekzemplo`, so after `--pass examples` on a
full file run `--pass index` and `--pass fts` again (the build says so). `morph`, `splits` and `tld-links` share one walk over the articles'
`<tld/>`s (`tldOccurrences()` in `tld-links.ts`): `tld-links` stores it, the
other two read it as they go, so the core file carries no `x_tld_occ`. `freq`
reads `x_morph` and `x_token`, so it runs after `splits`; `usage` reads only
the counts file. Rows:

| pass | tables | rows |
|---|---|---:|
| `structure` | `node`, `headword`, `translation` | 887,186 |
| `search` | `serĉo`, `serĉo_lng` | 758,070 |
| `examples` | `ekzemplo`, `fts_ekz`, `fts_ekz_word` | 114,441 |
| `index` | the indexes the enrichment tools read through | 4 |
| `fts` | `fts_kap`, `fts_trd`, `fts_dif`, `fts_ekz_fold` | 840,585 |
| `tld-links` | `x_tld_occ` | 176,088 |
| `refs` | `x_ref_tip`, `x_ref_edge`, `x_ref_issue` | 113,867 |
| `morph` | `x_morpheme`, `x_pair`, `x_affix`, `x_family` | 91,818 |
| `usage` | `x_usage` | 214,377 |
| `splits` | `x_morph`, `x_token` | 116,686 |
| `freq` | `x_freq_word`, `x_freq_root` | 227,919 |

**`search`** — one row in `serĉo` for every way into an entry (a marked drv):
its headword and variants under `lng` 'eo', and each translation outside the
examples under its language, keyed by the form a query is compared with
(`normalizeQuery`: the `<ind>` form when there is one). The table is `WITHOUT
ROWID` with the key `(lng, norm, ord)`, so a language's rows are stored in the
order of their forms: an exact match is one short range and a prefix match one
contiguous run of pages. `ord` fixes the order among equal forms (direct before
filed under, then the headword's spelling), and a row carries the entry node,
the form as written, whether it is filed under the key, and the entry's usage
domains, so ranking, counting languages and domains, and narrowing read no other
table; only the page of results shown loads entries. `serĉo_lng` counts each
language's entries and translations for the `languages` tool.

**`structure`** — `node`, `headword` and `translation`, above, and the index
on `headword(norm)`, which the core file keeps so that `gloss` finds a word's
entry without scanning the headwords.

**`examples`** — every `<ekz>` with text as a row of `ekzemplo` under the
element's id (114,441): the article, the innermost marked `drv`/`subart`
(`drv_mrk`) and its headword (`kap`), the sense's mark, the text without
citations and translations, and `last_id`, so the example's own translations
are the `in_ekz` rows of `translation` in `rowid..last_id`; `trd` counts them,
and a reader skips that lookup for the 97 % that have none (3,483 have some).
`fts_ekz` is a trigram index over the text that finds a word inside another
("hund" in "ĉashundojn"); `fts_ekz_word` (`unicode61`, case folded, diacritics
kept) finds a word as a word of its own ("si" and "sin", not "sinjoro").

`fts_ekz` is `trigram case_sensitive 0`; the `fts` pass adds `fts_ekz_fold`,
diacritics folded as well, for the `examples` tool. A browser reads the file
with the SQLite of `@sqlite.org/sqlite-wasm`, and a table that build cannot
construct fails every query that reaches it: `remove_diacritics` needs 3.45 or
later, which `test/browser-sqlite.test.ts` checks. `fts_ekz` keeps no positions (`detail=none`): 13.6 MB
instead of 28.9 MB (11 MB less gzipped). Without positions FTS5 answers no
phrase longer than a trigram, so a query asks for all of a text's trigrams
(`trigramMatch()` in `db-voko.ts`) and the reader checks the text itself; the
trigrams are in the sentence without the text in a few cases in a thousand
(hund: 355 sentences for 354, domo: 1,051 for 1,030). `fts_ekz_word` keeps no
positions either (4.6 MB), so the words of a headword of several are asked for
together and their order checked in the text.

**`index`** — `headword(node_id)`, `node(parent_id)`,
`translation(lng, COALESCE(ind, txt) COLLATE NOCASE)` and `ekzemplo(drv_mrk)`
and `ekzemplo(art)`, which the thesaurus, the source-language gloss and the
examples tool read through and the core file does without. With
the last one present, SQLite would scan a whole language for an
entry's translations; `db-voko.ts` writes `+lng` to keep it on the entry's
node range.

**`tld-links`** — one row per `<tld/>`: the owner it sits in (`kap` 35.6k, `ekz`
117k, `dif` 14.5k, `ref` 4.7k, `rim` 2.8k, `bld` 1.3k, a few directly in a node),
the root it stands for (`rad`, `var`, `lit`), and the letters glued to it on
either side (`pre`/`post`, across adjacent `<tld/>`s), so `token` is the written
word form: `mal<tld/>ulejo` → pre `mal`, rad `san`, post `ulejo`. `owner_id`
is the owner element's own id, so an owner that is a headword is its
`headword` row.

**`refs`** — `x_ref_tip` is the tip vocabulary with its `owl/voko.ttl`
semantics (parent property, SKOS mapping, inverse, symmetric, transitive).
`x_ref_edge` resolves `cel` to a node (by `mrk`, then article file, then a
`rim` mark): 67,245 authored edges (67,013 to nodes, 163 to whole articles, 69
to remarks) plus 46,600 inferred ones — the inverse of each authored edge
(`prt`→`malprt`, `super`→`sub`, `drv`→`snc`, symmetric `vid`/`sin`/`ant`/`hom`)
unless the article already states it. `inferred` keeps the two apart. Every ref
is an edge or an issue; the only issues are 9 self-references. Deviation from the
OWL: `hom` is treated as symmetric (the ontology only makes it transitive).

**`morph`** and **`splits`** — a lexicon-driven segmenter (`src/morph.ts`, a DP over morpheme
classes with costs) over an inventory built from the corpus itself: 13.3k roots
(`art.rad` and `<rad var>`; not the ending articles such as `-is`, nor an
article that is only an exclamation and derives nothing, such as `eh`), 106
prefixes and 58 suffixes from the affix articles (`mal-`, `-ul`; the
grammatical endings excluded), 304 endingless
words (`ĉar`, `kiu`) from drv headwords with a bare tilde. A `<tld/>` pins the
root span, so the segmenter only has to place affixes around a known root. A
headword written out in full (`hufofero` in `fer`) is pinned where the
article's root occurs, if it occurs exactly once and the free segmentation does
not already read a longer root there (`sekvestracio` in `sekvestr`).

Each piece of a split costs about one; a long piece and a root with many
derivations cost a little less, a one- or two-letter root, a prefix after a
root and an endingless word inside a word cost more. The words with a pinned
root are split first, and the morphemes written on either side of the pin
(`dis`+`port`, `port`+`ist` — only those two, not the rest of the split, which
is the segmenter's own reading) are counted into `x_pair`; that is the
`morph` pass, and the core stage stops there. Then, in `splits`, every word,
pinned or not, is split with that evidence and stored: a pair the corpus
writes is cheaper, one it never writes dearer, which is how `montaro` becomes
`mont|ar|o` and not `mon|tar|o` (money, tare).

In that second pass the search keeps the eight cheapest readings per state,
and up to 16 distinct readings go to a learned scorer (`readingFeatures()` and
`scoreReading()` in `src/morph.ts`), which takes the reading with the lowest
weighted sum of its features:

- the hand cost above the cheapest reading, pieces per kind, Σ length²;
- per root: its length, ln(1 + derivations), at most one derivation, whether
  it is also a prefix, a suffix or an endingless word, whether it has any
  headword of its own word class; the least-derived root of two to four
  letters;
- word class: how well the ending, inner vowel or verbal suffix after a root
  suits it, counted over the root's headwords `~o`, `~a`, `~e`, `~i` while the
  inventory is built (no segmentation involved) and stored in `x_morpheme`, so
  the tools read it back instead of the articles;
- one feature per prefix and per suffix (`P=dis`, `S=ist`): `dis` is a prefix
  far more often than `di`;
- inner endings by letter, an endingless word after the first piece or of two
  letters, pairs the corpus writes or never writes.

So `flank|en|ir|i`, not `flan|ken|ir|i`; `film|far|ad|o`, not `film|farad|o`
(the farad); `supr|en|ramp|i`, `sang|al|flu|o`, `rid|ind|ig|i`. Table words
(`kiu`, `tiajn`, `nenion` — ki-/ti-/i-/ĉi-/neni- with their endings) and words
the inventory lists as endingless (`en`, `aj`) are a closed set and keep the
cheapest reading, which is the whole word or ReVo's own filing (`neni|o`);
the scorer never saw such words in training and would split `en` as `e|n`.
Numbers are the other closed set: when the scorer's pick cuts through the
number a word opens with but ends a piece where the number ends (`dum|il|a`,
`de|kok|a`), the best reading that keeps the number's pieces wins (`du|mil|a`,
`dek|ok|a`). Over the 245,582 words of the counts file and the root marks this
changes four splits and no score of `corpus:eval-segment`.

**Training.** `pnpm corpus:train-segment` (`scripts/train-segment.ts`,
~10 s) fits the weights on the tune part of the root-marked words (below) and
rewrites `src/morph-weights.ts`. For each word, the readings that put the
marked root in the right place should together get the most probability under
P(reading) ∝ exp(−score); the loss is the mean −ln of that plus λ·|w|², λ =
0.001, minimised by L-BFGS from "hand cost only". The general features are
scaled to unit spread first so one λ fits all; the per-affix features are not:
scaled, a rare one gets past the penalty — `P=duon` reached +7.8 from the few
words ReVo files under `du` (`du|on|jar|o`), and the build then split every
`duon-` word as `du|on`. `--cv 0.0001,0.001,0.01` fits each half of the tune
part on the other and prints the misses per λ.

The accuracy count checks only where the root sits, so a wrong split around a
rightly placed root (`du|on|patr|o`) counts as right, and it contains no bare
endingless words. A change to the features or the training is therefore also
checked by rebuilding the corpus and diffing the stored splits (`x_morph`,
`x_token`) against the previous build. Against the rule the scorer replaced
(among readings within 2 of the cheapest, the weakest short root decides),
29 headwords and 34 example forms change: about 36 for the better
(`seks|al|log|a`, `sekv|in|ber|o`, `laŭb|o|bird|o`, `prov|el|don|o`,
`film|far|ad|o`), about 8 for the worse (`ne|tip|a` → `net|ip|a`,
`volv|e|kovr|i` → `volv|ek|ovr|i`, `tro|taks` → `trot|aks`, `parti` →
`part|i`). Segmenting takes about 0.12 ms a word, about twice the rule it
replaced; the `morph` pass about 12 s and `splits` about 21 s.

To try a feature: add it to `readingFeatures()`, retrain, run
`corpus:eval-segment`, rebuild and diff. A feature the weights file does not
name scores 0, so old weights keep working until retrained.

- `x_morpheme`: the inventory; for roots, the article, its number of
  derivations and how many of its headwords are the root plus `o`, `a`, `e` or
  `i` (the word class the scorer reads).
- `x_pair`: 21,266 morpheme pairs next to a marked root, each with the number
  of derivations that write it.
- `x_affix`: the 174 prefixes and suffixes with their own article: the
  headword as written (`-ul`), the entry's mark (`ul.0`), and the clause of
  the definition that `gloss` quotes for the part, cut at build time so a
  reader loads no definition text.

`splits` stores what that inventory says about every word the corpus writes,
for the server's tools and the evaluation scripts:

- `x_morph`: every headword (49,489): `mal|san|ul|ej|o` / `PRSSE`, roots,
  `source` = `tilde` (root pinned, 48,957) or `free`; 99.2 % fully segmented.
- `x_token`: every distinct attested word form per article (67,197 `<tld/>`
  occurrences outside headwords), segmented with the root pinned (99.3 %), and
  tied to a headword of the same article when one of its dictionary forms is one
  (84 %, `how` = `kap` / `infl` / `class` / `ptcp`).

A core file has no stored splits: `gloss` splits a headword when it is asked
about, with a root of the article it is filed under pinned — its own, then
the variants the inventory lists for that article (`arĥiv`, `arkiv`) — where
one occurs exactly once and the free segmentation does not already read a
longer root there (`pinnedSplit()` in `src/gloss.ts`). That agrees with the
stored split for 99.77 % of the 47,039 one-word headwords. The 109 that differ
are kaps whose root mark spells the root as neither the article nor a variant
does (`anaĥoret` → `anakoreto`, stored `anakoret|o`), and marks that stand
where a longer root reads (`far~ado` is stored `far|ad|o` and computed
`farad|o`). A split takes about 70 µs once the inventory is in memory, which
takes 40 ms from disk; the `attested` verdict and its counts need `x_token`,
so a core file gives `derived` for a form only the examples write.

Without a pin, the segmenter puts the marked root in the right place for
99.6 % of the 68,582 root-marked words (headwords 99.7 %, example forms
99.5 %); `pnpm corpus:eval-segment` measures it and lists the misses. The
words are split by derivation stem into three parts (`scripts/segment-cases.ts`):
the pair evidence comes from the first, the scorer's weights from the second,
and the third is scored on its own (99.5 %), so that number stands for words
the segmenter has not seen a relative of. Misses in that report part:

| segmenter | misses of 22,246 |
|---|---:|
| hand costs, cheapest reading | 170 |
| weakest short root decides (the rule before the scorer) | 153 |
| learned scorer, λ 0.01 | 147 |
| learned scorer, λ 0.001 (used; `--cv` on the tune part: 91 against 95 for 0.0001) | 119 |
| learned scorer, λ 0.0001 | 107 |
| learned scorer, every feature scaled, λ 0.001 | 108 |

The last two fit the report part better and the corpus worse. At λ 0.0001
the stored splits change in 110 places instead of 63: besides more good ones
(`volv|e|kovr|i`, `vort|ar|ist|o`) every `sin-` word becomes `si|n|…` and every
`metro-` word `metr|o|…`, a sweeping change the count cannot judge. Every
feature scaled is the `du|on` case above.

**Stemming in the tools.** `lemmaCandidates()` (grammar-driven: the ending says
the dictionary form, then other word classes, then participle → verb) runs
before `generateStems()` in step 3 of `lookupEsperanto` and `lookupFamily`, on
both DBs. Measured by `pnpm corpus:eval` on 37,460 attested example forms
that are not headwords (gold = the article of the tilde):

| method | found | correct | wrong |
|---|---:|---:|---:|
| `generateStems` alone | 66.2 % | 65.4 % | 0.8 % |
| `lemmaCandidates` → `generateStems` (used by the tools) | 77.7 % | 77.3 % | 0.4 % |
| segmenter, head root | 99.5 % | 93.1 % | 6.4 % |
| segmenter, any root | 99.5 % | 97.2 % | 2.3 % |
| `lemmaCandidates` → segmenter if one root → `generateStems` | 87.3 % | 86.7 % | 0.6 % |

Against `generateStems` alone, 4,454 forms gain a correct answer and one loses
it (`farbita` → headword `farbito` of another article: the word-class fallback
runs before the participle rule, which avoids `planta` → `pli`). The tools do
not use the segmenter: it needs the inventory from voko.db, and its errors are
over-segmentation into short roots (`nep|le|naĝ|o`, `ali|ĝis`).

**`freq`** — how often each word and each morpheme is used, from
`corpus/freq/counts.tsv`: one row per lemma (dictionary form) with a count from
each of two corpora, HPLT v2 web text (CC0) and the Tekstaro de Esperanto
(counts only; the text is not redistributed). `corpus/freq/README.md` says how
the file is made and regenerated; its header records each source's URL,
sha256, date, licence and token total, and the pass copies that header into
`meta.freq_sources` so rates per million can be computed at runtime.

The pass holds every lemma of the file against ReVo in the order the `gloss`
tool's `classify` uses, so the two never disagree: a headword as written, else
an inflection of one (`lemmaCandidates`), else a form the examples attest
(`x_token`), else a word the inventory builds (`segment` + the same
plausibility rule as `gloss`), else unknown. The split comes from the corpus
where it stored one (the headword's `x_morph` row, the token's `x_token` row;
an inflection is segmented with the headword's root pinned) and from the
segmenter otherwise. `test/freq.test.ts` checks, on a slice with a fixture
file, that the pass's verdict equals `classify`'s for every lemma.

- `x_freq_word`: lemma, verdict, `kap_id` (the headword it is or is a form
  of), `seg`/`kinds`, `hplt`, `tekstaro`. Every ReVo lemma is in the file with
  its count, zero included: a headword no corpus ever writes is a fact the
  table states, not a gap. Other lemmas are in the file when the web uses them
  at least 50 times or Tekstaro 5 times.
- `x_freq_root`: every morpheme (root, endingless word, prefix, suffix) of
  those splits, with the counts of the lemmas containing it summed once per
  lemma, and how many lemmas that was. Recomputed at every build, so a better
  segmenter changes the root counts without a new counts file.

`src/freq.ts` reads them by key: `wordFrequency(db, word)` lemmatises with
`lemmaOf` (`src/morph.ts`: `-ojn` → `-o`, `-is` → `-i`, table words and
pronouns lose `j`/`n`, participles keep their form) and returns counts and
rates per million; `morphFrequency(db, morph, kind?)` the same for a morpheme.
Both return nothing on a database without the pass. `--freq FILE` points the
build at another counts file; without the file the tables are created empty.

**`usage`** — the same counts, alone: `x_usage` (lemma, `hplt`, `tekstaro`),
one row per lemma of the file, plus `meta.freq_sources`. `freq` needs the
stored splits, so it cannot run on the core file; this table can, and it is
what a gloss needs from the counts. `webUsage(db, word)` reads a word's web
count by `lemmaOf`: 0 for a lemma the file lacks, null on a database without
counts. With it, the gloss tool's "did you mean" (`nearRoots` in `gloss.ts`)
offers a word one letter away only when the web writes it at least 30 times
as often as the word itself, most used first: `agado` (115,000 uses) gets no
question, `finsita` (none) gets `fiksita` and `finita`. Over the 12,267 forms
the web writes 200 times or more that the gloss calls derived, that cuts the
questioned ones from 2,817 to 471, and over 3,000 generated slips the right
word is still offered (1,483 of 2,965, against 1,471 without counts).

## Word families

`morph` also writes `x_family`: for every entry headword (a marked `drv` or
`subart`, variants included) one row per distinct morpheme of two letters or
more in its split — roots (R), endingless words (W), prefixes (P) and
suffixes (S) — with the headword, its tilde form in its own article (`tilde`,
"ĉas~o" for ĉashundo in `hund`), the article and its root, and the morphemes'
places in the headword (`spans`, "mal:P@0 san:R@3 ul:S@6 ej:S@8", UTF-16
offsets). The key is `(morph, kap_id)`, so a family is one contiguous range;
`idx_x_family_node` finds an entry's own rows. 56,313 rows, 13,244 families
over 35,748 entry headwords; 170 headwords have no root the segmenter reads,
and headwords whose written form differs in length from their normalized one
are left out. Families are small (antaŭ- 121 words) except the affixes: 22
have more than 200 words (-ig- 1,138, mal- 897, -aĵ- 830).

`familyOf(db, mark)` (`src/family.ts`, the `family` tool) returns a family per
root of the entry's headword, the article's own root first: members deduped
by mark (the main headword over a variant), ordered root+i, root+o, root+a,
then Esperanto-alphabetically, 200 at a time (`offset`, `only`), each with its
article and the article's root, so a word filed elsewhere (hundherbo under
`herb`) can say so; the translations of the listed members in every language
or the chosen ones, and per family how many listed members each language
translates. A root that is an affix (`x_affix`) says `affix: "P" | "S"`, and
its family holds the words that use it as an affix.

`wordExamples(db, mark)` (`src/word-examples.ts`, the `wordExamples` tool)
finds the examples, in every article, that use the entry's headword or a
variant of it as a word of its own: the word and its inflections
(`wordForms()`: -j, -n, -jn for a noun, an adjective, a correlative in -iu and
unu; -n for a pronoun in -i (sin, ilin) and an adverb in -e (hejmen); a
verb's tenses, moods and imperative; a noun's elision, hund'). A word built on it is another
entry's (sia, siaspeca and sinjoro are not examples of si), and so are the
participles. What does not inflect gets no endings, so nu does not take in
nun. The candidates are the sentences `fts_ekz_word` finds a form in, a
headword of several words (Granda Hundo) all its words in some form; the text
then says where each occurrence is, its words next to each other. The entry's
own examples are left out, and so is the same sentence quoted elsewhere; a
sentence several articles quote alike is listed once. With `exactTotal` every
candidate is read and `total` counts the examples; without it the scan stops
once the page is full and `total` is the candidates, which is what a browser
reading the file over HTTP asks for. The candidates exceed the examples by
about 5 %, the sentences an entry repeats (si 3,389 for 3,214, hundo 237 for
225, siaspeca 7 for 7). Measured locally on the core file: a 200-example page
≤ 15 ms, the exact totals of si 40 ms, kaj 323 ms, la (63,288) 645 ms.

## Adding a pass

A pass (`src/corpus/pass.ts`) has a `name`, a `version` and the `tables` it
owns; `run(db, log)` creates and fills them and returns the row count.
`runPass` drops those tables, runs the pass in one transaction and records
name, version, rows and time in `meta_pass`.

1. Write `src/corpus/passes/NAME.ts` exporting the `Pass`; name its tables `x_*`.
2. Add it to `PASSES` in `src/corpus/build.ts`, after the passes it reads.
3. `pnpm corpus:build --pass NAME` fills it on an existing `voko.db`.
4. Bump `version` whenever its output changes.
5. Test it in `test/corpus-build.test.ts`; the slice build there runs all passes.

Passes never change the articles' tables. Content missing from the XML goes into the
XML (see `corpus/overlay/README.md`), not into a pass.

## Overlay

`corpus/overlay/*.xml` is merged over the submodule by file name: same name
replaces, new name adds, and `article.source` records which is which.
`--overlay DIR` points the build at another directory, which is how
`test/overlay.test.ts` exercises the path against a fixture. That test also
pins what an overlay buys: a usage sample added there reaches `ekz`, then
`x_tld_occ` and `x_token`, so a word the `gloss` tool could only analyse
morphologically becomes an attested form with a count behind it.

## Docker

The image builds the database instead of shipping one, in three stages:

1. `sources` — on `node:${NODE_VERSION}-alpine` with git from Alpine's
   package index: clones this repository at `RAILWAY_GIT_COMMIT_SHA`, runs
   `scripts/fonto.sh --checkout` to check out `revo-fonto` (`revo/`, `cfg/`)
   and `voko-grundo` (`dtd/`, `cfg/`) at their submodule pins, and records the
   two commits in `vendor/SOURCES.json`.
2. `build` — `corepack enable` for the pnpm `package.json` names, then
   `pnpm install --frozen-lockfile` (`pnpm-workspace.yaml` and `packages/` are
   copied first, or the workspace dependency fails to resolve), then
   `pnpm db:setup`.
3. the server — `data/voko.db`, `src/`, `packages/` and `node_modules` only,
   run as `node --import tsx src/http.ts` (tsx is a runtime dependency; pnpm is
   not needed). The XML, the DTDs and git stay behind in the earlier stages.

The sources are checked out in-image rather than copied in because builders
that clone from GitHub — Railway among them — ship neither the submodule
contents nor `.git`, and a submodule's pin lives only in git's tree. So the
stage clones the commit being built, whose tree has the pins: Railway passes
`RAILWAY_GIT_COMMIT_SHA` (and `RAILWAY_GIT_REPO_OWNER`/`_NAME`) to the build,
and a local build passes it by hand, a commit that is on GitHub:
`docker build --build-arg RAILWAY_GIT_COMMIT_SHA=$(git rev-parse HEAD) .`.
Without it the stage stops and says so. The submodules stay the only record of
the source commits; `test/deploy-pins.test.ts` fails if the Dockerfile names a
commit. git comes from Alpine rather than Debian because an earlier Debian 11
base image hit 404s on its mirrors for the package versions its own indexes
named. Both repositories are public, so none of this needs credentials.

`.dockerignore` keeps `data/`, `vendor/` and the generated parser tables out of
the build context, so `setup.ts` regenerates the tables from the vendored DTDs
— `scripts/gen-entities.ts` reads `dtd/` and `cfg/` and needs no git.

The build stage has no git, so a container build records where it came from
through the sources stage: `meta.fonto_rev` and `meta.voko_grundo_rev` fall
back to the commits in `vendor/SOURCES.json` when there is no repository to ask.

The base image is pinned (`ARG NODE_VERSION`, an exact release such as
`24.15.0`, used as `node:${NODE_VERSION}-slim` and `-alpine`) rather than tracking a floating
tag like `node:24-slim`, which makes the build depend on whichever image the
builder has cached — locally that once was a two-year-old copy. The passes and
the server read SQLite through `node:sqlite`, whose API grew over Node 22 and
24 (`src/runtime/node-database.ts` uses `StatementSync.setReturnArrays()`, new
in 24.0), and the search tables need its SQLite built with FTS5. Pin and bump
deliberately; `test/deploy-pins.test.ts` checks every stage uses the `ARG`.

## Validation

1. Losslessness: every file parses and serializes back DOM-equal
   (`packages/voko-xml/test/corpus.test.ts`), and every article reads back from
   its tables DOM-equal at import (`test/documents.test.ts` checks a slice and
   hand-written edge cases).
2. Golden outputs: a schema change is checked by dumping every tool's answers
   for a fixed set of about 300 calls from the old and the new build and
   diffing them.
3. Parity vs `data/revo.db`: key-set diffs, old-only items zero or explained.
4. Tools: `pnpm test`, which reads `data/voko.db`; `scripts/render-all-articles.ts`
   renders every headword.
5. Each pass: unit test on hand-picked articles + corpus-level count assertions
   (`test/corpus-build.test.ts` builds the first 120 articles plus `san`, `mal`,
   `ul`, `ej`, `hund`, `lup`, `unu`, `li`; the passes also assert their own counts at build).

## Parity with revo.db

`pnpm corpus:validate` → `data/parity.md`. Same 2026-02-28 snapshot on both sides;
key sets, not row counts. Measured with schema 1, when `artikolo` still held the
XML; since schema 3 `compare-db.ts` computes upstream's shapes from the derived
tables and the articles, and `artikolo` is compared by article file.

| set | old | new | old-only | new-only |
|---|---:|---:|---:|---:|
| nodo mrk | 48,076 | 64,122 | 1,166 | 17,212 |
| nodo (mrk, kap) | 48,076 | 64,122 | 1,181 | 17,227 |
| var (mrk, kap) | 2,956 | 2,978 | 3 | 25 |
| traduko (lng, trd) | 539,571 | 539,778 | 363 | 570 |
| traduko (mrk, lng, trd) | 789,202 | 715,503 | 94,077 | 20,378 |
| referenco (mrk, cel, tip) | 63,631 | 65,761 | 25,675 | 27,805 |
| uzo (mrk, tip, uzo) | 13,798 | 25,462 | 305 | 11,969 |
| ekzemplo (drv_mrk, text) | 110,472 | 112,511 | 3,176 | 5,215 |
| artikolo | 13,011 | 13,011 | 0 | 0 |

Old-only, explained — nothing found that we lose:

- **Invented sense mrks** (nodo 1,166, uzo 305, a few hundred elsewhere): upstream
  makes up `abon.0o.1`, `abrazi.0o.TEK.1.a` for unmarked senses. We keep those
  senses mrk-less (filed under the drv's mark) with all their content.
- **Placement** (traduko 93.3k, referenco 25.6k, nodo 1.1k): the same value one
  level up or down — upstream files a single-sense drv's rows under the drv, we
  under the `snc` that holds them. db.ts reads drv + `drv.*`, so lookups see both.
- **Upstream text artifacts** (traduko `(lng, trd)` 363, the rest of traduko): several
  `<ind>` glued together ("Amtniederlegen" — ours "Amt niederlegen"), `<klr>` spliced
  without a space ("llumde carretera"), klr kept inline ("літній (про вік)"); nodo:
  variants concatenated into kap ("ritma akcentado ritma akcento", 15 rows).
- **Rendering** (ekzemplo 3,176): upstream prefixes stl labels ("(figure) …"),
  leaves `&nbsp;` literal and formulas in backticks.
- var 3: whitespace ("Novo-Zelando " with a trailing space). referenco: 6 rows
  unexplained.

New-only is granularity upstream drops: 17k sense mrks, usage tags per sense,
translations and references at the node they really sit in. `compare-db.ts`
mirrors upstream's semantics on purpose: `traduko.trd` is the `<ind>` form, and
translations of examples are left out (they stay in `translation`, `in_ekz` = 1).

`scripts/render-all-articles.ts` renders all 64,122 headwords on voko.db
(48,076 on revo.db) with 0 empty / 0 no-senses / 0 crashes.
