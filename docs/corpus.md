# The XML corpus

`data/voko.db` is built from ReVo's VOKO XML sources instead of upstream's
prebuilt database. The XML comes from `vendor/revo-fonto` and its DTDs and name
lists from `vendor/voko-grundo` (both git submodules); `packages/voko-xml`
parses it; `src/corpus/` builds and enriches the database.

```sh
bun run setup                       # both of the next two steps, for a fresh clone
bun run fonto                       # check out both submodules, generate the parser's tables
bun run corpus:build                # XML → data/voko.db, then all passes (~1.5 min, ~460 MB)
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
`revuloj/revo-fonto` as PRs; L2 holds only what the XML states, and everything
inferred belongs to a versioned pass.

## Layers

```
L0  source XML        vendor/revo-fonto (verbatim) + corpus/overlay/*.xml
L1  canonical model   packages/voko-xml: lossless DOM + typed walkers, round-trips to XML
L2  canonical DB      data/voko.db tables mirroring the XML 1:1 (+ FTS)
L3  enrichment        data/voko.db x_* tables, one versioned pass each
```

- L2 holds only what the XML says. No heuristics.
- Every L3 table is owned by one pass (`src/corpus/passes/*.ts`) with a name and
  version, recorded in `meta_pass`. Re-running a pass rewrites only its tables.
- Stable keys: `mrk` where the XML has one, else the path key
  (`san/drv[0]/snc[2]`). Integer ids change between builds; L3 tables are
  rebuilt with the database and use ids, anything kept outside it must use keys.
- Content we author goes to XML, never the DB: upstream-acceptable edits in the
  submodule on a fork branch; the rest in `corpus/overlay/` (see its README).

## Repo layout

```
vendor/revo-fonto/           submodule: the VOKO articles, sparse to revo/ cfg/   (bun run fonto)
vendor/voko-grundo/          submodule: DTDs and name lists, sparse to dtd/ cfg/  (bun run fonto)
corpus/overlay/              our VOKO articles (currently none)
packages/voko-xml/           the parser package (no SQLite; usable by other projects)
  src/dom.ts                 lossless DOM, parse (saxes), serialize, fragments
  src/entities.ts            named-entity substitution (hard error on unknown)
  src/model.ts               the 62 DTD elements + declared attributes
  src/walk.ts                roots, tilde expansion, kap forms, node path keys, inventory
  src/corpus.ts              article listing with overlay merge
  data/entities.json         836 resolved entities — generated, not committed
  data/cfg/*.json            lingvoj / fakoj / stiloj / mallongigoj — generated, not committed
scripts/fonto.sh             submodule checkout + entity generation (bun run fonto)
scripts/gen-entities.ts      vendor/voko-grundo → packages/voko-xml/data (bun run corpus:entities)
src/corpus/schema.sql        L2 DDL + compat views
src/corpus/build.ts          XML → data/voko.db   (bun run corpus:build [--limit N] [--no-passes] [--pass NAME])
src/corpus/pass.ts           pass contract, meta_pass bookkeeping
src/corpus/passes/           fts.ts, tld-links.ts, refs.ts, morph.ts (one per L3 table group)
src/morph.ts                 runtime-safe morphology: lemmaCandidates(), segment() (no DB, no voko-xml)
src/db-voko.ts               what db.ts reads differently on voko.db (senses from dif/ekz)
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

## L2 schema

Integer PK everywhere. `key` = stable path key, `mrk` kept where present,
`xml` = exact fragment so unmodelled detail stays recoverable. `owner_kind`/
`owner_id` say which element a row sits in (node, dif, ekz, rim, klr, …);
`node_id` is always the nearest enclosing structural node.

```
art    (id, file UNIQUE, rad, rev, modified, source fonto|overlay, xml)
node   (id, art_id, parent_id, kind, key UNIQUE, mrk, mrk_near, num, ref, ord, kap_id)
kap    (id, node_id, parent_kap_id, txt, tilde, norm, ofc, rad_var, ord, xml)   variants: parent_kap_id set
dif    (id, node_id, ord, lng, txt, xml)
ekz    (id, node_id, owner_kind, owner_id, ord, key UNIQUE, mrk, txt, ind, xml)
trd    (id, node_id, owner_kind, owner_id, lng, grp, ord, txt, ind, baz, pr, klr, ofc, kod, fnt, xml)
ref    (id, node_id, owner_kind, owner_id, tip, cel, lst, val, grp, ord, txt, xml)
fnt    (id, node_id, owner_kind, owner_id, ord, bib, aut, vrk, lok, url, txt, xml)
uzo    (id, node_id, owner_kind, owner_id, tip, txt, ord)
bld    (id, node_id, owner_kind, owner_id, lok, mrk, tip, alt, lrg, prm, txt, xml)
rim · gra · mlg · tezrad · lstref · adm · sncref
lng · fako · stilo · mallongigo (data/cfg) · bib (cfg/bibliogr.xml in the submodule)
meta (key, value) · meta_pass (pass, version, input_hash, rows, ms, at)
```

- `mrk_near` = own mrk, else the nearest ancestor's (10k `snc` have none).
- `kap_id` = the node's own headword, else the nearest ancestor's.
- Text columns: citations dropped, `<tld/>` expanded (`lit` rule applied),
  `<ctl>` quoted „…“. `dif.txt` keeps an inline `<trd>` (Latin names) but not a
  `<trdgrp>`; `kap.txt` drops the separator before `<var>`.

Compat views answer `src/db.ts`'s queries unchanged: `nodo`, `var` (article-level
variants filed under the first drv, as upstream does), `traduko` (`rowid` =
`fts_trd.rowid`; `trd` = the `<ind>` form when marked, as upstream), `referenco`,
`uzo_compat` (upstream's tip names), `artikolo` (XML instead of HTML). The only
query-level switch in `db.ts` is senses: `db-voko.ts` reads them from
`dif`/`ekz` instead of scraping HTML. `fts_kap`, `fts_trd` (+ `ind`, `baz`,
`pr`), `fts_ekz` (trigram over `ekzemplo`) and `fts_dif` (definitions, for reverse lookup) come from the
`fts` pass.

## Enrichment passes (L3)

`bun run corpus:build --pass NAME` reruns one pass on an existing `voko.db`.
Order matters: `morph` reads `x_tld_occ`.

| pass | tables | rows | time |
|---|---|---:|---:|
| `fts` | `fts_kap`, `fts_trd`, `fts_dif`, `fts_ekz`, `ekzemplo` | 933,800 | 8 s |
| `tld-links` | `x_tld_occ` | 173,285 | 12 s |
| `refs` | `x_ref_tip`, `x_ref_edge`, `x_ref_issue` | 111,733 | 1 s |
| `morph` | `x_morpheme`, `x_morph`, `x_token` | 129,028 | 3 s |

**`tld-links`** — one row per `<tld/>`: the owner it sits in (`kap` 35k, `ekz`
115k, `dif` 14k, `ref` 4.7k, `rim` 2.8k, `bld` 1.3k, a few directly in a node),
the root it stands for (`rad`, `var`, `lit`), and the letters glued to it on
either side (`pre`/`post`, across adjacent `<tld/>`s), so `token` is the written
word form: `mal<tld/>ulejo` → pre `mal`, rad `san`, post `ulejo`. The pass
re-walks each article's DOM in build order and maps an owner element to its L2
row by position; it fails if an owner's stored `xml` differs or counts disagree.

**`refs`** — `x_ref_tip` is the tip vocabulary with its `owl/voko.ttl`
semantics (parent property, SKOS mapping, inverse, symmetric, transitive).
`x_ref_edge` resolves `cel` to a node (by `mrk`, then article file, then a
`rim` mark): 66,066 authored edges (111k to nodes, 343 to whole articles, 69 to
remarks) plus 45,645 inferred ones — the inverse of each authored edge
(`prt`→`malprt`, `super`→`sub`, `drv`→`snc`, symmetric `vid`/`sin`/`ant`/`hom`)
unless the article already states it. `inferred` keeps the two apart. Every ref
is an edge or an issue; the only issues are 9 self-references. Deviation from the
OWL: `hom` is treated as symmetric (the ontology only makes it transitive).

**`morph`** — a lexicon-driven segmenter (`src/morph.ts`, a DP over morpheme
classes with costs) over an inventory built from the corpus itself: 13.5k roots
(`art.rad` and `<rad var>`), 80 prefixes and 57 suffixes from the affix
articles (`mal-`, `-ul`; the grammatical endings excluded), 303 endingless
words (`ĉar`, `kiu`) from drv headwords with a bare tilde. A `<tld/>` pins the
root span, so the segmenter only has to place affixes around a known root.

- `x_morph`: every headword (48,845): `mal|san|ul|ej|o` / `PRSSE`, roots,
  `source` = `tilde` (root pinned, 48,274) or `free`; 99.2 % fully segmented.
- `x_token`: every distinct attested word form per article (66,183 from
  `x_tld_occ` outside headwords), segmented with the root pinned (99.3 %), and
  tied to a headword of the same article when one of its dictionary forms is one
  (84 %, `how` = `kap` / `infl` / `class` / `ptcp`).

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

Passes never change the L2 tables. Content missing from the XML goes into the
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

1. Coverage: XML element counts == table rows; inventory has no unknown markup.
2. Losslessness: DOM round-trip over every file (`packages/voko-xml/test/corpus.test.ts`).
3. Parity vs `data/revo.db`: key-set diffs, old-only items zero or explained.
4. Tools: `bun test`, which reads `data/voko.db`; `scripts/render-all-articles.ts`
   renders every headword.
5. Each pass: unit test on hand-picked articles + corpus-level count assertions
   (`test/corpus-build.test.ts` builds the first 120 articles plus `san`, `mal`,
   `ul`, `ej`, `hund`, `lup`, `unu`, `li`; the passes also assert their own counts at build).

## Parity with revo.db

`bun run corpus:validate` → `data/parity.md`. Same 2026-02-28 snapshot on both sides;
key sets, not row counts.

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
  senses mrk-less (`mrk_near` = the drv) with all their content.
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
translations and references at the node they really sit in. Upstream semantics
are mirrored in the views on purpose: `traduko.trd` is the `<ind>` form, and
translations of examples are left out (they stay in `trd`).

`scripts/render-all-articles.ts` renders all 64,122 headwords on voko.db
(48,076 on revo.db) with 0 empty / 0 no-senses / 0 crashes.
