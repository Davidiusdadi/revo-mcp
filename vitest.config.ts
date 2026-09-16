import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The corpus build test builds a slice, and voko-xml's corpus test parses every article.
    testTimeout: 120_000,
    hookTimeout: 300_000,
    // node:sqlite is native, so each file runs in its own process; each opens
    // voko.db with a 64 MB page cache.
    pool: "forks",
    maxWorkers: 4,
    projects: [
      {
        extends: true,
        test: {
          name: "revo-mcp",
          include: ["test/**/*.test.ts"],
          // Opens the database named by REVO_DB (default data/voko.db) for every test file.
          setupFiles: ["test/preload.ts"],
        },
      },
      "packages/voko-xml",
    ],
  },
});
