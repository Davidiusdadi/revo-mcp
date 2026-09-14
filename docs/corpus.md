# The XML corpus

`data/voko.db` is built from ReVo's VOKO XML sources instead of upstream's
prebuilt database. The XML comes from `vendor/revo-fonto` and its DTDs and name
lists from `vendor/voko-grundo` (both git submodules); `packages/voko-xml`
parses it; `src/corpus/` builds and enriches the database.

```sh
bun run setup                       # both of the next two steps, for a fresh clone
bun run fonto                       # check out both submodules, generate the parser's tables
bun run corpus:build                # XML → data/voko.db, then all passes (~4 min, ~280 MB, + voko.db.gz)
bun run corpus:build --stage core   # what a browser downloads: articles + structure + search (~140 MB, ~60 MB gzipped)
bun run start                       # serve from data/voko.db; REVO_DB=… overrides the path
bun run corpus:validate             # parity report against data/revo.db → data/parity.md
bun run corpus:eval                 # stemming recall on attested word forms
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
vendor/revo-fonto/           submodule: the VOKO articles, sparse to revo/ cfg/   (bun run fonto)
vendor/voko-grundo/          submodule: DTDs and name lists, sparse to dtd/ cfg/  (bun run fonto)
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
scripts/fonto.sh             submodule checkout + entity generation (bun run fonto)
scripts/gen-entities.ts      vendor/voko-grundo → packages/voko-xml/data (bun run corpus:entities)
src/corpus/schema.sql        the build's records (meta, meta_pass) and the cfg lists
src/corpus/build.ts          XML → data/voko.db   (bun run corpus:build [--stage core|full] [--limit N] [--no-passes] [--pass NAME] [--out F])
src/corpus/sources.ts        where the import reads the articles from
src/corpus/documents.ts      articles → one table per element (L1), each batch read back and compared; articleTrees for the passes
src/articles.ts              reading L1: id ranges back into voko-xml trees (runtime-safe)
src/content.ts               what a node's elements say: content, owners, rendered text, senses (runtime-safe)
src/corpus/pass.ts           pass contract, meta_pass bookkeeping
src/corpus/passes/           structure.ts, search.ts, index.ts, fts.ts, tld-links.ts, refs.ts, morph.ts (one per table group)
src/search.ts                the search and entry tools' ranking over serĉo
src/morph.ts                 runtime-safe morphology: lemmaCandidates(), segment() (no DB, no voko-xml)
src/db-voko.ts               entry assembly over node ranges; which passes a database has
scripts/compare-db.ts        parity: old revo.db vs voko.db key sets (bun run corpus:validate → data/parity.md)
scripts/eval-stemming.ts     stemming recall on attested tilde forms (bun run corpus:eval)
```

## Corpus facts

- `<art mrk>` is a CVS `$Id:` stamp, not an ID. Article key = file name;
  `parseArtId()` yields revision and date.
- ~10k of 40.4k `<snc>` have no `mrk`; `subart` (194) and `subdrv` exist.
- The submodule is pinned to the fork's `master` (`d18ad4f`): upstream `c088349`
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
reads the tables and `serĉo`. `fts_kap`, `fts_trd` (+ `ind`, `baz`, `pr`),
`fts_ekz` (trigram over `ekzemplo`) and `fts_dif` (definitions, for reverse
lookup) come from the `fts` pass.

## Stages and revisions

A build is one of two stages of the same file, recorded in `meta.stage`:

| stage | passes | size | gzipped | answers |
|---|---|---:|---:|---|
| `core` | `structure`, `search` | 141.0 MB | 62.5 MB | `search`, `entry`, `lookup`, `lookup_root`, `languages` |
| `full` (default) | `structure`, `search`, `index`, `fts`, `tld-links`, `refs`, `morph` | 280.9 MB | 131.6 MB | every tool |

Measured at `d18ad4f` (13,079 articles). Both files hold every article whole;
the core one has only the index on `node(mrk)`. Of the core file, the articles
take 92 MB (text runs 28.5 MB, `trd` 19.5 MB, comments 6.6 MB), `serĉo`
24.2 MB, `translation` 21.6 MB, `node` 4.0 MB and `headword` 1.5 MB. A core
file becomes a full one by running the enrichment passes on it with `--pass`;
no sources needed. `hasPass`/`requirePasses` in `db-voko.ts` read `meta_pass`, so on
a core file `examples`, `thesaurus`, `reverse_lookup` and `gloss` say which
passes they need instead of failing on a missing table; `lookup` skips its FTS
fallback.

Every build ends in `finish()`: `PRAGMA user_version` = the build time in Unix
seconds, `ANALYZE`, `VACUUM` (so each table and index lies in contiguous
pages), and `<out>.gz` beside the file. `user_version` sits at byte 60 of the
file header, so a browser compares its stored copy with the published file by
reading the first 100 bytes; publish `voko.db` and `voko.db.gz` together, as
the browser checks that the download is the revision it saw.

## Passes (L2)

`bun run corpus:build --pass NAME` reruns one pass on an existing `voko.db`
(and finishes the file again). Order matters: every pass reads `structure`'s
tables, and `morph` reads `x_tld_occ`. Rows at `d18ad4f`:

| pass | tables | rows |
|---|---|---:|
| `structure` | `node`, `headword`, `translation` | 887,186 |
| `search` | `serĉo`, `serĉo_lng` | 758,070 |
| `index` | the indexes the enrichment tools read through | 4 |
| `fts` | `fts_kap`, `fts_trd`, `fts_dif`, `fts_ekz`, `ekzemplo` | 955,026 |
| `tld-links` | `x_tld_occ` | 176,088 |
| `refs` | `x_ref_tip`, `x_ref_edge`, `x_ref_issue` | 113,867 |
| `morph` | `x_morpheme`, `x_morph`, `x_token`, `x_pair` | 152,018 |

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

**`structure`** — `node`, `headword` and `translation`, above.

**`index`** — `headword(node_id)`, `headword(norm)`, `node(parent_id)` and
`translation(lng, COALESCE(ind, txt) COLLATE NOCASE)`, which the thesaurus and
gloss read through and the core file does without. With the last one present, SQLite would scan a whole language for an
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

**`morph`** — a lexicon-driven segmenter (`src/morph.ts`, a DP over morpheme
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
is the segmenter's own reading) are counted into `x_pair`. Then every word,
pinned or not, is split with that evidence: a pair the corpus writes is
cheaper, one it never writes dearer, which is how `montaro` becomes
`mont|ar|o` and not `mon|tar|o` (money, tare).

- `x_morpheme`: the inventory; for roots, the article and its number of
  derivations.
- `x_morph`: every headword (49,489): `mal|san|ul|ej|o` / `PRSSE`, roots,
  `source` = `tilde` (root pinned, 48,957) or `free`; 99.2 % fully segmented.
- `x_token`: every distinct attested word form per article (67,197 from
  `x_tld_occ` outside headwords), segmented with the root pinned (99.3 %), and
  tied to a headword of the same article when one of its dictionary forms is one
  (84 %, `how` = `kap` / `infl` / `class` / `ptcp`).
- `x_pair`: 21,266 morpheme pairs next to a marked root, each with the number
  of derivations that write it.

Without a pin, the segmenter puts the marked root in the right place for
99.3 % of the 68,578 root-marked words (headwords 99.5 %, example forms
99.2 %); `bun run corpus:eval-segment` measures it and lists the misses. The
script takes its pair evidence from one third of the words only and scores
separately the third whose derivational relatives are not in that evidence
(99.2 %), so the number stands for words the segmenter has not seen a relative
of.

**Stemming in the tools.** `lemmaCandidates()` (grammar-driven: the ending says
the dictionary form, then other word classes, then participle → verb) runs
before `generateStems()` in step 3 of `lookupEsperanto` and `lookupFamily`, on
both DBs. Measured by `bun run corpus:eval` on 37,460 attested example forms
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

## Adding a pass

A pass (`src/corpus/pass.ts`) has a `name`, a `version` and the `tables` it
owns; `run(db, log)` creates and fills them and returns the row count.
`runPass` drops those tables, runs the pass in one transaction and records
name, version, rows and time in `meta_pass`.

1. Write `src/corpus/passes/NAME.ts` exporting the `Pass`; name its tables `x_*`.
2. Add it to `PASSES` in `src/corpus/build.ts`, after the passes it reads.
3. `bun run corpus:build --pass NAME` fills it on an existing `voko.db`.
4. Bump `version` whenever its output changes.
5. Test it in `test/corpus-build.test.ts`; the slice build there runs all passes.

Passes never change the articles' tables. Content missing from the XML goes into the
XML (see `corpus/overlay/README.md`), not into a pass.

## Docker

The image builds the database instead of shipping one, in three stages:

1. `sources` — `scripts/fetch-sources.ts` downloads `revo-fonto` and
   `voko-grundo` as tarballs at the commits pinned in the Dockerfile's `ARG`s,
   unpacking only `revo/`, `cfg/`, `dtd/`, and recording them in
   `vendor/SOURCES.json`.
2. `build` — `bun install --frozen-lockfile` (`packages/` is copied first, or
   the workspace dependency fails to resolve), then `bun run setup`.
3. the server — `data/voko.db`, `src/`, `packages/` and `node_modules` only.
   The XML, the DTDs and git stay behind in the earlier stages.

The sources are fetched in-image rather than copied in because builders that
clone from GitHub — Railway among them — ship neither the submodule contents
nor `.git`, leaving an in-image `git submodule update` nothing to work from.
Tarballs rather than `git clone` because the base image is Debian 11, whose
mirrors already 404 on the package versions its own indexes name, so installing
git makes the build hostage to a frozen distro; `fetch` and `tar` are already
there. Both repositories are public, so none of this needs credentials.
`test/deploy-pins.test.ts` fails if the `ARG` commits drift from the pins.

`.dockerignore` keeps `data/`, `vendor/` and the generated parser tables out of
the build context, so `setup.ts` regenerates the tables from the vendored DTDs
— `scripts/gen-entities.ts` reads `dtd/` and `cfg/` and needs no git.

Nothing on the build path requires git, so a container build still records
where it came from: `meta.fonto_rev` and `meta.voko_grundo_rev` fall back to
the commits in `vendor/SOURCES.json` when there is no repository to ask.

The base image is pinned (`ARG BUN_VERSION`) rather than tracking `oven/bun:1`.
The passes stream their queries with `Statement.iterate()`, which older Bun
does not have, so a floating tag makes the build depend on whichever image the
builder has cached — locally that was a two-year-old 1.1.4. Pin and bump
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
4. Tools: `bun test`, which reads `data/voko.db`; `scripts/render-all-articles.ts`
   renders every headword.
5. Each pass: unit test on hand-picked articles + corpus-level count assertions
   (`test/corpus-build.test.ts` builds the first 120 articles plus `san`, `mal`,
   `ul`, `ej`, `hund`, `lup`, `unu`, `li`; the passes also assert their own counts at build).

## Parity with revo.db

`bun run corpus:validate` → `data/parity.md`. Same 2026-02-28 snapshot on both sides;
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
