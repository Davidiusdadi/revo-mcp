import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "voko-xml",
    include: ["test/**/*.test.ts"],
    // The corpus test parses and round-trips every article.
    testTimeout: 120_000,
  },
});
