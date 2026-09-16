# voko-xml/data

`entities.json` and `cfg/*.json` are generated, not committed: `pnpm fonto`
checks out the `vendor/voko-grundo` submodule and runs `scripts/gen-entities.ts`
over it (`pnpm corpus:entities` regenerates them alone).

- `entities.json` — the named entities declared in voko-grundo's DTDs, fully resolved
- `cfg/*.json` — the language, subject, style and abbreviation lists from voko-grundo's `cfg/`

The submodule pin records which voko-grundo commit they come from. The data is
voko-grundo's, under the GNU GPL v2 only; the package's code is GPL v2 or later.
