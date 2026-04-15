FROM oven/bun:1

WORKDIR /app

# Install dependencies
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Copy source
COPY src/ ./src/
COPY tsconfig.json ./

# Download the Reta Vortaro database and build FTS indexes
RUN bun run setup

ENV PORT=3000
EXPOSE 3000

CMD ["bun", "run", "src/http.ts"]
