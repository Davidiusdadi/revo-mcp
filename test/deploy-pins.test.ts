import { describe, test, expect } from "vitest";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const dockerfile = readFileSync(join(ROOT, "Dockerfile"), "utf8");

/** `ARG name=value` defaults declared in the Dockerfile. */
function dockerfileArgs(): Record<string, string> {
  const args: Record<string, string> = {};
  for (const line of dockerfile.split("\n")) {
    const m = line.match(/^ARG\s+([A-Z0-9_]+)=(\S+)\s*$/);
    if (m) args[m[1]] = m[2];
  }
  return args;
}

describe("deploy pins", () => {
  // The submodules are the only record of which source commits are built. A
  // commit repeated in the Dockerfile would be a second record, free to drift.
  test("the Dockerfile names no commit; the sources come from the submodules", () => {
    expect(dockerfile).not.toMatch(/\b[0-9a-f]{40}\b/);
    expect(dockerfile).toContain('git fetch -q --depth 1 origin "$RAILWAY_GIT_COMMIT_SHA"');
    expect(dockerfile).toContain("sh scripts/fonto.sh --checkout");
  });

  // A floating tag such as `node:24-slim` means the build runs whatever image
  // is cached where it happens to run, which can be far older than the one the
  // passes were written against. An exact version makes the build reproducible.
  test("the base image is pinned to an exact Node version in every stage", () => {
    expect(dockerfileArgs().NODE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);

    const froms = dockerfile.split("\n").filter((l) => l.startsWith("FROM "));
    expect(froms.length).toBeGreaterThan(0);
    for (const from of froms) expect(from).toContain("${NODE_VERSION}");
  });
});
