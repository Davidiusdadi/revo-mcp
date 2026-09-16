# Revo MCP Server

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) server for looking up words in [Reta Vortaro](https://www.reta-vortaro.de/revo/) — the comprehensive, open-source Esperanto dictionary.

Provides Esperanto definitions, examples, and translations across 191 languages
to MCP-compatible clients. It can run as a Bun server or directly in a browser
Worker over a `MessagePort` transport.

## Features

- **Esperanto headword lookup** — definitions in Esperanto with example sentences
- **Translation lookup** — search in English, German, French, or any of 191 languages
- **Cross-language search** — find words across all available languages at once
- **X-system support** — type `cxirkaux` instead of `ĉirkaŭ`
- **Grammatical form stemming** — `amikojn` (plural accusative) automatically finds `amiko`
- **Cross-references** — related words, synonyms, antonyms

## Public Server (Railway)

A hosted instance is available — no setup required:

```
https://revo-mcp-production-b460.up.railway.app/mcp
```

### With Claude Desktop

```json
{
  "mcpServers": {
    "revo": {
      "type": "http",
      "url": "https://revo-mcp-production-b460.up.railway.app/mcp"
    }
  }
}
```

### With `claude` CLI

```json
{
  "mcpServers": {
    "revo": {
      "type": "http",
      "url": "https://revo-mcp-production-b460.up.railway.app/mcp"
    }
  }
}
```

### Deploy your own on Railway

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/new/template?template=https://github.com/Davidiusdadi/revo-mcp)

The image builds the dictionary database from the XML at build time. It
downloads the two source repositories itself as tarballs, pinned to the commits
in the `ARG`s at the top of the `Dockerfile`, so it depends neither on the
builder cloning submodules (Railway does not) nor on git being installable in
the image. Nothing here needs credentials: both repositories are public.

Expect a slow first build (the corpus build alone is ~2 min). Only the database
and the server reach the final image; the XML and the DTDs stay in the build
stages.

---

## Prerequisites

- [Bun](https://bun.sh/) 1.3+ — the corpus build streams its queries with
  `Statement.iterate()`, which older Bun does not have (tested on 1.3.13, which
  is also what the `Dockerfile` pins)
- git, and ~1 GB of free disk space for the sources and the built database

## Setup

```bash
git clone --recurse-submodules https://github.com/Davidiusdadi/revo-mcp.git
cd revo-mcp

# Install dependencies
bun install

# Check out the XML sources and build the dictionary database (~4 min, ~280 MB)
bun run setup
```

`bun run setup` checks out the two source submodules, generates the parser's
entity and name tables from them, then parses all 13,079 VOKO articles into
`data/voko.db`, stores them there whole, and runs the passes that derive the
search and enrichment tables from them. The database is not committed —
it is built from the XML, and rebuilding is one command.

See [docs/corpus.md](docs/corpus.md) for the layers, the schema and the passes.
`REVO_DB=path/to.db` points the server at a different database.

## Usage

### In a browser Worker

The browser build runs the same MCP server in a Web Worker, over the same
database file. It needs no server of its own: a static host serving `voko.db`
with range requests is enough, and a PWA works offline once the file is stored.

```bash
# The database a browser reads: search, lookup, entries, languages and Esperanto glossing (~150 MB, ~66 MB gzipped)
bun run corpus:build --stage core --out ./dist/revo/voko.db

# Bundle the Worker; sqlite3.wasm is copied beside it
bun run browser:build --out ./dist/revo/revo-worker.js
```

The build writes `voko.db.gz` next to `voko.db`; publish both, together.

The Worker answers at once and gets faster later:

1. **Remote.** Without a local copy it opens `voko.db` over HTTP range
   requests (`sqlite-wasm-http`), reading only the pages a query touches,
   4 KB each, and keeping them in a 16 MB cache.
2. **Download.** Meanwhile it downloads the file once, `voko.db.gz` through
   `DecompressionStream` (the uncompressed file if there is no `.gz`), into an
   SQLite pool in the origin private file system, reporting progress.
3. **Local.** When the copy is complete, queries switch to it, and later starts
   open it without waiting for the network. The Worker compares the published
   file's revision (`PRAGMA user_version`, set to the build time; one 100-byte
   request) and downloads a newer one the same way.

One tab at a time can hold the local copy; in a second tab the Worker stays
remote and says so. After a reload the previous page's Worker still holds it
for a moment, so the new one starts remotely and takes the copy over once it
is free. A copy that is interrupted or does not match the published revision is
not used.

```ts
import { RevoBrowserClient } from "./src/browser/client";

const revo = await RevoBrowserClient.connect(
  new Worker("/revo/revo-worker.js", { type: "module" }),
  "/revo/voko.db",
  { onEvent: (event) => console.log(event) }, // access: "remote" keeps no copy until asked
);
const { results, total, languageMatches, domainMatches } =
  await revo.search({ query: "Hund", languages: ["de", "en"], limit: 30 });
revo.local("delete"); // or "download"
```

The Worker reports `revo:loading`, `revo:ready { engine }`,
`revo:download { loaded, total }` (bytes of the database file),
`revo:engine { engine }` when it switches, `revo:notice` for what does not stop
it (too little storage, a second tab, a failed download) and `revo:error` for
what does, such as an unreachable file without a copy
(`src/browser/protocol.ts`).

Measured in Chromium against the core build of `d18ad4f` (13,079 articles,
141.0 MB, 62.5 MB gzipped), requests and bytes per interaction in remote mode:

| interaction | range requests | bytes |
|---|---:|---:|
| open + first search (`Hund`, de/en) | 39 | 169 KB |
| `amikojn` | 11 | 49 KB |
| `Haus` | 15 | 70 KB |
| `dogs` (de/en/fr) | 6 | 25 KB |
| `mal`, first 30 of 923 results | 50 | 406 KB |
| `mal`, next 30 | 45 | 246 KB |
| entry `hund.0o` | 57 | 365 KB |
| languages | 1 | 8 KB |

A search reads `serĉo` and `translation`; an entry rebuilds its derivation
from the tables of the elements in it, a few pages each, and so reads more.
The count of requests, not their size, is what a slow connection feels: they
are made one after another, so at a 100 ms round trip a `mal` page takes about
5 s and `Haus` about 1.5 s. Once the copy is stored a search makes no request
(`mal` ~120 ms, `Haus` ~25 ms) and a start makes one, the revision check.

The core file (150 MB, 66 MB gzipped) holds every article whole, one table
per XML element (92 MB, citations, remarks and markup included), plus the
search table (24 MB), the translations (22 MB), the nodes and headwords
(5.5 MB), and the morphology that glosses an Esperanto word (8 MB). The full
build (`bun run setup`, 281 MB, 132 MB gzipped) adds the enrichment passes and
their indexes.

Search always includes Esperanto and ranks exact matches, then reduced or
inflected forms, then literal prefixes; the request's language order breaks
ties. A result's first match reason names it: the strongest match, which is
also the one the result is ranked by.

Search never stops at a count: `total` gives every result it found, `limit` is
the page size, and `offset` pages through them. `languageMatches` counts the
entries each searched language matched, in request order. Passing
`matchLanguage` keeps only the results that matched in that language, ranked by
that match, which then also names each result. An entry that matched in several
languages appears under each of them.

`domainMatches` counts the usage domains, such as `ZOO` or `KUI`, among those
results, most common first. Passing `domain` keeps only the results whose entry
carries it; the counts still describe the results before that narrowing, so
another domain can be chosen from them.

A result carries what a result card shows: the headword, mark, usage domains
and the translations in the searched languages. `entry` loads the rest by mark.
The `search` and `entry` tools are the same on the Bun server;
`MessagePortTransport` and `connectWorkerServer` connect the server to a Worker
without Node or Bun globals.

A core database answers `search`, `entry`, `lookup`, `lookup_root`,
`languages`, and `gloss` for Esperanto text; `examples`, `thesaurus`,
`reverse_lookup` and a source-language `gloss` need the enrichment of a full
build and say so on a core one.

### With Claude Desktop

Add to your Claude Desktop MCP configuration (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "revo": {
      "command": "bun",
      "args": ["run", "/absolute/path/to/revo-mcp/src/index.ts"]
    }
  }
}
```

### With `claude` CLI

Add to your MCP settings (`.claude/settings.json`):

```json
{
  "mcpServers": {
    "revo": {
      "command": "bun",
      "args": ["run", "/absolute/path/to/revo-mcp/src/index.ts"]
    }
  }
}
```

### Direct start

```bash
bun run start
```

The server communicates via stdio using the MCP protocol.

## MCP Tools

### `lookup`

Search the Esperanto dictionary.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `query` | string | (required) | Word to look up |
| `lang` | string | `"eo"` | `"eo"` for Esperanto, `"en"`/`"de"`/`"fr"`/etc. for translations, `"all"` for any language |
| `show_languages` | string[] | `["en","de","fr","es","ru","zh","ja"]` | Which translation languages to display |
| `limit` | number | `5` | Max results (1-20) |

**Examples:**

- Look up an Esperanto word: `lookup({ query: "amiko" })`
- Find English translation: `lookup({ query: "friend", lang: "en" })`
- Search German: `lookup({ query: "Hund", lang: "de" })`
- X-system input: `lookup({ query: "cxirkaux" })`
- Inflected form: `lookup({ query: "amikojn" })`
- Cross-language: `lookup({ query: "друг", lang: "all" })`

### `languages`

Lists all 191 available languages with translation counts. Takes no parameters.

### `lookup_root`

All derived forms of one root (`rav` → ravi, rava, rave, ravado…), with translations
but no definitions or examples.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `root` | string | (required) | A root (`san`, `ĉeval` or `cxeval`) or any word form of it (`sana`) |
| `show_languages` | string[] | `["en","de","fr","es","ru"]` | Which translation languages to display |

### `examples`

Full-text search over the example sentences of every article. Finds inflected forms,
compounds and proper nouns that are not headwords — `examples({ query: "abelojn" })`.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `query` | string | (required) | Words to find in example sentences |
| `limit` | number | `10` | Max sentences (1-50) |

### `thesaurus`

The reference graph around a word, grouped by relation: synonyms, antonyms, broader
and narrower terms, parts and wholes, see-also. Includes the inverse links the other
article states — `thesaurus({ word: "hundo" })` lists the breeds that declare
themselves a kind of dog, which the `hund` article itself never mentions. The
relations are those of the entry asked for and its senses; the other derivations in
the same article keep their own (`bela` does not inherit `malbeligi`'s synonyms).

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `word` | string | (required) | Esperanto word; inflected forms are stemmed |
| `relations` | string[] | (all) | Keep only these relation types, e.g. `["sin","ant"]` |

### `reverse_lookup`

Reverse dictionary: searches the text of the definitions, so a description finds the
word — `reverse_lookup({ description: "granda birdo" })`. The description must be in
Esperanto, since that is the language the definitions are written in.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `description` | string | (required) | Esperanto description of the meaning |
| `limit` | number | `15` | Max results (1-50) |

### `gloss`

A whole text in, corpus-backed suggestions out — one call instead of one `lookup`
per word. Two directions, chosen by the language of the text.

With a source language, it glosses the text *into* Esperanto: every content word and
every two- or three-word phrase, with the Esperanto roots available for it, and a list
of the words the dictionary has nothing for.

```
gloss({ text: "He decided to give up on the naked eye.", lang: "en" })

**Phrases** — entries the single words would not give you
- **give up** — cedi · fordoni (don) · kapitulaci · rezigni
**Words**
- **decided** (via decide) — decidi
- **naked** — nuda
- **eye** — hokingo · okulo · okulkavo (kav) [cavity of the eye]
```

With `lang: "eo"` it audits an Esperanto draft instead. Each word comes back as a
headword, an inflection of one, a form attested in the examples, a *regular derivation*
no article lists, or unknown — the last with the nearest real word named.

```
gloss({ text: "La teksto ĉanĝiĝis kaj estas farenda.", lang: "eo" })

**Unknown** — no article, nothing attested, and no reading from known morphemes
- **ĉanĝiĝis** — did you mean **ŝanĝiĝis**?
**Attested, not a headword** — written in ReVo's own examples
- **farenda** (4× in the examples) = `far|end|a` — fari + -end- "kiun oni devas fari" + -a
```

The derivation class is what makes the audit usable. ReVo lists `legi` and the suffix
`-end` but never `legenda`, so a checker that knows only headwords flags every
correctly built word in a real text. The segmenter rebuilds the word from the morpheme
inventory and each part is glossed from its own article, so `-end-` is quoted, not
paraphrased. Where a long root hides a second reading both are given: `legenda` is
`legendo` + `-a` *and* `leg|end|a`.

The segmenter only guesses for words the dictionary does not have. A headword, an
inflection of one, or a form written in the examples is split the way the corpus
stored it, following ReVo's own root marks (`hufofero` is `huf|o|fer|o`, not
`huf|ofer|o`), and a word filed under two articles keeps both readings: `resumi` is
`resum|i` under `resum` and `re|sum|i` under `sum`.

A word can be well formed and still be a typo — `finsita` is a real compound of `fin`
and `sit` — so derivations are checked for real words one letter away too, ranked by
how well the corpus attests them.

The same call answers a single word for a reader that shows it. The result is
returned as structured content too: each term carries its dictionary form, the
entry's mark (`mrk`, what `entry` loads), and with `languages` the entry's
translations, and each part of a split carries the mark of the article that
names it, so `mal·san·ul·ej·o` links to `mal.0`, `san.0a`, `ul.0` and `ej.0`.
On a core database the Esperanto side works from the morph tables alone. Read
remotely, a headword with its translations is about 15 page reads (64 KB); a
word the dictionary has to segment first makes the Worker load its morpheme
inventory, about 80 reads (1.6 MB), once per session.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `text` | string | (required) | The text to gloss: a sentence, a paragraph, a passage |
| `lang` | string | `"en"` | Language of `text`; `"eo"` audits an Esperanto draft instead |
| `per_word` | number | `4` | Esperanto candidates listed per source word (1-10) |
| `max_words` | number | `80` | Cap on distinct words reported |
| `languages` | string[] | — | With `lang: "eo"`, list each dictionary word's translations in these languages |

## Testing

```bash
# Run all tests (requires data/voko.db — run `bun run setup` first)
bun test
```

The test suite includes:
- Unit tests for the Esperanto stemmer and the morphology
- Integration tests for the database query layer
- A corpus build over a slice of the XML, checking the schema and every pass
- 100 real-world usage scenarios covering beginner learners, advanced users, x-system input, stemming, multi-language search, and edge cases

## Architecture

```
revo-mcp/
├── src/
│   ├── index.ts           # MCP server entry point (stdio transport)
│   ├── server.ts          # Tool registration
│   ├── db.ts              # SQLite queries (headword, translation, FTS search)
│   ├── setup.ts           # Builds data/voko.db from the XML
│   ├── stemmer.ts         # Esperanto stemmer, x-system, normalization
│   ├── morph.ts           # Morphology: dictionary forms, segmentation
│   ├── formatter.ts       # Format results as Markdown
│   ├── browser/           # The server in a Worker: range reads, local OPFS copy
│   ├── corpus/            # XML → voko.db: schema, build, enrichment passes
│   └── tools/             # One handler per MCP tool
├── packages/voko-xml/     # The VOKO XML parser (lossless DOM + walkers)
├── vendor/                # Source submodules: revo-fonto, voko-grundo
├── test/
└── data/
    └── voko.db            # Built by `bun run setup` (gitignored)
```

`data/voko.db` is parsed from the VOKO XML rather than downloaded, so it keeps
the structure the rendered HTML flattens:
- 64,000+ headword entries, senses kept as senses
- 550,000+ translations across 174 languages, with `ind`/`baz`/`pr` intact
- 13,079 articles stored whole, one table per XML element, each reading back as its file
- A typed reference graph, morphological segmentation, and full-text indexes
  over headwords, translations, examples and definitions

## License

The code in this repository is licensed under the GNU General Public License,
version 2 or (at your option) any later version — see `LICENSE`.

The Reta Vortaro dictionary content is licensed under the
[GNU General Public License v2](https://www.gnu.org/licenses/old-licenses/gpl-2.0.html)
only, and so is anything here derived from it (generated data, VOKO articles,
databases built from the corpus).
