import { describe, test, expect } from "vitest";
import { spawnSync } from "child_process";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** `ARG name=value` defaults declared in the Dockerfile. */
function dockerfileArgs(): Record<string, string> {
  const args: Record<string, string> = {};
  for (const line of readFileSync(join(ROOT, "Dockerfile"), "utf8").split("\n")) {
    const m = line.match(/^ARG\s+([A-Z0-9_]+)=(\S+)\s*$/);
    if (m) args[m[1]] = m[2];
  }
  return args;
}

/** `git submodule status` → path ⇒ commit. */
function submodulePins(): Record<string, string> {
  const out = spawnSync("git", ["-C", ROOT, "submodule", "status"], { encoding: "utf8" }).stdout;
  const pins: Record<string, string> = {};
  for (const line of out.trim().split("\n")) {
    const m = line.match(/^[-+U ]?([0-9a-f]{40})\s+(\S+)/);
    if (m) pins[m[2]] = m[1];
  }
  return pins;
}

// Needs the superproject's git metadata, which a plain source export lacks.
const inGitRepo = (() => {
  try {
    return spawnSync("git", ["-C", ROOT, "rev-parse", "--git-dir"], { encoding: "utf8" }).status === 0;
  } catch {
    return false; // no git installed
  }
})();

describe("deploy pins", () => {
  // The image cannot read the submodule gitlinks (no .git in a Railway build),
  // so the Dockerfile repeats the commits as ARGs. That duplication is only
  // safe while the two agree.
  test.skipIf(!inGitRepo)("Dockerfile source SHAs match the submodule pins", () => {
    const args = dockerfileArgs();
    const pins = submodulePins();

    expect(pins["vendor/revo-fonto"]).toBeDefined();
    expect(pins["vendor/voko-grundo"]).toBeDefined();
    expect(args.REVO_FONTO_SHA).toBe(pins["vendor/revo-fonto"]);
    expect(args.VOKO_GRUNDO_SHA).toBe(pins["vendor/voko-grundo"]);
  });

  // A floating tag such as `node:24-slim` means the build runs whatever image
  // is cached where it happens to run, which can be far older than the one the
  // passes were written against. An exact version makes the build reproducible.
  test("the base image is pinned to an exact Node version in every stage", () => {
    const dockerfile = readFileSync(join(ROOT, "Dockerfile"), "utf8");
    expect(dockerfileArgs().NODE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);

    const froms = dockerfile.split("\n").filter((l) => l.startsWith("FROM "));
    expect(froms.length).toBeGreaterThan(0);
    for (const from of froms) expect(from).toContain("${NODE_VERSION}");
  });

  test("the sources are named as owner/repo, fetched over https by the script", () => {
    const args = dockerfileArgs();
    expect(args.REVO_FONTO_REPO).toMatch(/^[\w.-]+\/[\w.-]+$/);
    expect(args.VOKO_GRUNDO_REPO).toMatch(/^[\w.-]+\/[\w.-]+$/);
    const script = readFileSync(join(ROOT, "scripts", "fetch-sources.ts"), "utf8");
    expect(script).toContain("https://codeload.github.com/");
  });
});
