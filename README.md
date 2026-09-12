# Revo MCP Server

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) server for looking up words in [Reta Vortaro](https://www.reta-vortaro.de/revo/) — the comprehensive, open-source Esperanto dictionary.

Provides Esperanto definitions, examples, and translations across 174 languages to any MCP-compatible AI assistant (Claude Desktop, `claude` CLI, etc.).

## Features

- **Esperanto headword lookup** — definitions in Esperanto with example sentences
- **Translation lookup** — search in English, German, French, or any of 174 languages
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

# Check out the XML sources and build the dictionary database (~2 min, ~460 MB)
bun run setup
```

`bun run setup` checks out the two source submodules, generates the parser's
entity and name tables from them, then parses all 13,079 VOKO articles into
`data/voko.db` and runs the enrichment passes. The database is not committed —
it is built from the XML, and rebuilding is one command.

See [docs/corpus.md](docs/corpus.md) for the layers, the schema and the passes.
`REVO_DB=path/to.db` points the server at a different database.

## Usage

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

Lists all 174 available languages with translation counts. Takes no parameters.

### `lookup_root`

All derived forms of one root (`rav` → ravi, rava, rave, ravado…), with translations
but no definitions or examples.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `query` | string | (required) | A root (`san`) or any word form of it (`sana`) |
| `show_languages` | string[] | `["en","de","fr"]` | Which translation languages to display |

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
- 13,079 articles, stored as XML
- A typed reference graph, morphological segmentation, and full-text indexes
  over headwords, translations, examples and definitions

## License

The code in this repository is licensed under the GNU General Public License,
version 2 or (at your option) any later version — see `LICENSE`.

The Reta Vortaro dictionary content is licensed under the
[GNU General Public License v2](https://www.gnu.org/licenses/old-licenses/gpl-2.0.html)
only, and so is anything here derived from it (generated data, VOKO articles,
databases built from the corpus).
