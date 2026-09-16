#!/bin/sh
# Check out the source submodules lean (git cannot declare sparse checkout in
# .gitmodules) and generate the parser's entity and cfg tables from them:
#   vendor/revo-fonto   the VOKO articles        sparse: revo/ cfg/
#   vendor/voko-grundo  DTDs and the name lists  sparse: dtd/ cfg/
set -eu
cd "$(dirname "$0")/.."
git submodule update --init --depth 1 --filter=blob:none --no-checkout vendor/revo-fonto 2>/dev/null \
  || git submodule update --init --depth 1 vendor/revo-fonto
git -C vendor/revo-fonto sparse-checkout set --cone revo cfg
git -C vendor/revo-fonto checkout --quiet
echo "vendor/revo-fonto at $(git -C vendor/revo-fonto rev-parse --short HEAD): $(ls vendor/revo-fonto/revo | wc -l) articles"

git submodule update --init --filter=blob:none --no-checkout vendor/voko-grundo 2>/dev/null \
  || git submodule update --init vendor/voko-grundo
git -C vendor/voko-grundo sparse-checkout set --cone dtd cfg
git -C vendor/voko-grundo checkout --quiet
echo "vendor/voko-grundo at $(git -C vendor/voko-grundo rev-parse --short HEAD)"

pnpm exec tsx scripts/gen-entities.ts
