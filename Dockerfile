FROM oven/bun:1

WORKDIR /app

# Install dependencies
COPY package.json bun.lock ./
# workspace packages (voko-xml) must be present for the frozen install
COPY packages/ ./packages/
RUN bun install --frozen-lockfile

# Copy source and everything the corpus build reads. vendor/ holds the VOKO XML
# and the DTDs as git submodules: the build context must already have them
# checked out (clone with --recurse-submodules, or run `bun run fonto`), since
# there is no git metadata in the image for the checkout to happen here.
COPY src/ ./src/
COPY scripts/ ./scripts/
COPY corpus/ ./corpus/
COPY vendor/ ./vendor/
COPY tsconfig.json ./

# Build data/voko.db from the XML (L2 + every enrichment pass)
RUN bun run setup

ENV PORT=3000
EXPOSE 3000

CMD ["bun", "run", "src/http.ts"]
