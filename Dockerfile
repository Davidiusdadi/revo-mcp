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
# Stage 1 — the VOKO sources.
#
# The submodules cannot be relied on here: builders that clone from GitHub
# (Railway among them) fetch neither the submodule contents nor .git, so an
# in-image `git submodule update` has nothing to work from. Installing git is
# not worth it either: it ties the build to Debian's package mirrors, which for
# an older release have already 404ed on the versions its indexes named. So the
# sources are downloaded as pinned tarballs, with the fetch and tar the image
# already has.
#
# The script runs on Node's own type stripping: it imports nothing but Node's
# built-in modules, so this stage needs no dependency install, and a change to
# the dependencies does not invalidate the download.
#
# Keep the SHAs in step with the submodules — test/deploy-pins.test.ts fails if
# they drift. Both repositories are public, so this needs no credentials.
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-slim AS sources

ARG REVO_FONTO_REPO=Davidiusdadi/revo-fonto
ARG REVO_FONTO_SHA=f6da172934c3dbca3e3ad698c89cf0cdf30ea6fb
ARG VOKO_GRUNDO_REPO=revuloj/voko-grundo
ARG VOKO_GRUNDO_SHA=cb1c84d605af268b341751e273acc48a8c2300c2

WORKDIR /sources
COPY scripts/fetch-sources.ts ./scripts/
# ARGs above are in the environment for RUN; the script reads the pins from it
# and unpacks only the directories the corpus build reads.
ENV VENDOR_DIR=/sources/vendor
RUN node scripts/fetch-sources.ts

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
COPY --from=sources /sources/vendor/ ./vendor/

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
