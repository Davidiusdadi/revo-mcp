#!/bin/sh
# Initialise the revo-fonto submodule lean: shallow, blobless, sparse to
# revo/ + cfg/. Git cannot declare sparse checkout in .gitmodules, so this
# script is the supported way to get the source XML into vendor/revo-fonto.
set -eu
cd "$(dirname "$0")/.."
git submodule update --init --depth 1 --filter=blob:none --no-checkout vendor/revo-fonto 2>/dev/null \
  || git submodule update --init --depth 1 vendor/revo-fonto
git -C vendor/revo-fonto sparse-checkout set --cone revo cfg
git -C vendor/revo-fonto checkout --quiet
echo "vendor/revo-fonto at $(git -C vendor/revo-fonto rev-parse --short HEAD): $(ls vendor/revo-fonto/revo | wc -l) articles"
