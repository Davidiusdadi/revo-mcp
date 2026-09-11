FROM oven/bun:1

WORKDIR /app

# Install dependencies
COPY package.json bun.lock ./
# workspace packages (voko-xml) must be present for the frozen install
COPY packages/ ./packages/
RUN bun install --frozen-lockfile

# Copy source
COPY src/ ./src/
COPY tsconfig.json ./

# Download the Reta Vortaro database and build FTS indexes
RUN apt-get update && apt-get install -y --no-install-recommends unzip && rm -rf /var/lib/apt/lists/*
RUN bun run setup

ENV PORT=3000
EXPOSE 3000

CMD ["bun", "run", "src/http.ts"]
