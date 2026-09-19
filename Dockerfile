# syntax=docker/dockerfile:1

# The base image is pinned to an exact Node release, because a floating tag
# (`node:24-slim`, `node:lts-slim`) runs whatever copy of it the builder happens
# to have cached, while the registry serves a newer one. The passes and the
# server read SQLite through `node:sqlite`, whose API grew over 22.x and 24.x
# (`StatementSync.setReturnArrays()`, which src/runtime/node-database.ts uses,
# arrived in 24.0), and the search tables need its SQLite built with FTS5. The
# pin is the Node the test suite runs on. Bump this deliberately.
ARG NODE_VERSION=24.15.0

# ---------------------------------------------------------------------------
# Stage 1 — the VOKO sources, at the commits the submodules pin.
#
# Railway builds from a snapshot of the repository without .git, so the build
# context has neither the submodules nor their pins: a pin lives only in git's
# tree. This stage asks GitHub instead. It clones revo-mcp itself at the commit
# being built (Railway passes RAILWAY_GIT_COMMIT_SHA to the build) and checks
# out the submodules with scripts/fonto.sh, as a development tree does. The
# submodules stay the only record of which commits are built; nothing here
# repeats them. Both repositories are public, so this needs no credentials.
#
# git comes from Alpine's package index. An earlier Debian-based image hit 404s
# on its mirrors for the package versions its own indexes named.
#
# A local build names a commit that is on GitHub:
#   docker build --build-arg RAILWAY_GIT_COMMIT_SHA=$(git rev-parse HEAD) .
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS sources

RUN apk add --no-cache git

ARG RAILWAY_GIT_REPO_OWNER=Davidiusdadi
ARG RAILWAY_GIT_REPO_NAME=revo-mcp
ARG RAILWAY_GIT_COMMIT_SHA

WORKDIR /src
# SOURCES.json records the commits for the database's meta table, since the
# build stage has no git to ask. It is written here from the submodules, not
# kept anywhere.
RUN set -euo pipefail; \
    if [ -z "${RAILWAY_GIT_COMMIT_SHA:-}" ]; then \
      echo 'RAILWAY_GIT_COMMIT_SHA is empty. Railway sets it; a local build names a pushed commit:' >&2; \
      echo '  docker build --build-arg RAILWAY_GIT_COMMIT_SHA=$(git rev-parse HEAD) .' >&2; \
      exit 1; \
    fi; \
    git init -q; \
    git remote add origin "https://github.com/$RAILWAY_GIT_REPO_OWNER/$RAILWAY_GIT_REPO_NAME.git"; \
    git fetch -q --depth 1 origin "$RAILWAY_GIT_COMMIT_SHA"; \
    git checkout -q FETCH_HEAD; \
    sh scripts/fonto.sh --checkout; \
    git submodule foreach --quiet 'echo "${sm_path#vendor/} $sha1"' \
      | node -e 'const rows = require("fs").readFileSync(0, "utf8").trim().split("\n").map((l) => { const [name, commit] = l.split(" "); return { name, commit }; }); process.stdout.write(JSON.stringify(rows, null, 1) + "\n");' \
      > vendor/SOURCES.json; \
    rm -f vendor/*/.git; \
    cat vendor/SOURCES.json

# ---------------------------------------------------------------------------
# Stage 2 — build the database.
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-slim AS build

WORKDIR /app

# pnpm comes from Corepack, which the Node image ships, at the version
# package.json's `packageManager` names.
RUN corepack enable

# Dependencies first; the workspace package must be present for a frozen install.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/ ./packages/
RUN pnpm install --frozen-lockfile

COPY src/ ./src/
COPY scripts/ ./scripts/
COPY corpus/ ./corpus/
COPY tsconfig.json ./
COPY --from=sources /src/vendor/ ./vendor/

# Generates the parser's entity and cfg tables from the DTDs, then builds
# data/voko.db: L2 from the XML, followed by every enrichment pass.
RUN pnpm db:setup

# ---------------------------------------------------------------------------
# Stage 3 — the server.
#
# Only the database and the code that reads it; the XML and the DTDs stay
# behind in the earlier stages. The server runs its TypeScript through tsx,
# a runtime dependency, so node_modules comes along and pnpm does not.
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-slim

WORKDIR /app

COPY package.json tsconfig.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/src ./src
COPY --from=build /app/data/voko.db ./data/voko.db
COPY --from=build /app/vendor/SOURCES.json ./vendor/SOURCES.json

ENV PORT=3000
EXPOSE 3000

CMD ["node", "--import", "tsx", "src/http.ts"]
