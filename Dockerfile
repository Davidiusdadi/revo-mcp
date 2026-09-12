# syntax=docker/dockerfile:1

# The base image is pinned to the Bun the test suite runs on, because
# `oven/bun:1` floats: a two-year-old copy of that tag (Bun 1.1.4) has no
# Statement.iterate(), which the enrichment passes stream their queries with,
# while the registry serves a much newer one — so an unpinned build depends on
# whatever happens to be cached where it runs. Bump this deliberately.
ARG BUN_VERSION=1.3.13

# ---------------------------------------------------------------------------
# Stage 1 — the VOKO sources.
#
# The submodules cannot be relied on here: builders that clone from GitHub
# (Railway among them) fetch neither the submodule contents nor .git, so an
# in-image `git submodule update` has nothing to work from. Installing git is
# no better — the base image is Debian, whose mirrors already 404 on the
# package versions its indexes name. So the sources are downloaded as pinned
# tarballs, with the fetch and tar the image already has.
#
# Keep the SHAs in step with the submodules — test/deploy-pins.test.ts fails if
# they drift. Both repositories are public, so this needs no credentials.
# ---------------------------------------------------------------------------
FROM oven/bun:${BUN_VERSION} AS sources

ARG REVO_FONTO_REPO=Davidiusdadi/revo-fonto
ARG REVO_FONTO_SHA=b15014fc3b5cf8ec9cead73d7283f2800df5cd29
ARG VOKO_GRUNDO_REPO=revuloj/voko-grundo
ARG VOKO_GRUNDO_SHA=cb1c84d605af268b341751e273acc48a8c2300c2

WORKDIR /sources
COPY scripts/fetch-sources.ts ./scripts/
# ARGs above are in the environment for RUN; the script reads the pins from it
# and unpacks only the directories the corpus build reads.
ENV VENDOR_DIR=/sources/vendor
RUN bun run scripts/fetch-sources.ts

# ---------------------------------------------------------------------------
# Stage 2 — build the database.
# ---------------------------------------------------------------------------
FROM oven/bun:${BUN_VERSION} AS build

WORKDIR /app

# Dependencies first; the workspace package must be present for a frozen install.
COPY package.json bun.lock ./
COPY packages/ ./packages/
RUN bun install --frozen-lockfile

COPY src/ ./src/
COPY scripts/ ./scripts/
COPY corpus/ ./corpus/
COPY tsconfig.json ./
COPY --from=sources /sources/vendor/ ./vendor/

# Generates the parser's entity and cfg tables from the DTDs, then builds
# data/voko.db: L2 from the XML, followed by every enrichment pass.
RUN bun run setup

# ---------------------------------------------------------------------------
# Stage 3 — the server.
#
# Only the database and the code that reads it; the XML and the DTDs stay
# behind in the earlier stages.
# ---------------------------------------------------------------------------
FROM oven/bun:${BUN_VERSION}

WORKDIR /app

COPY package.json tsconfig.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/src ./src
COPY --from=build /app/data/voko.db ./data/voko.db
COPY --from=build /app/vendor/SOURCES.json ./vendor/SOURCES.json

ENV PORT=3000
EXPOSE 3000

CMD ["bun", "run", "src/http.ts"]
