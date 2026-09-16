/**
 * Fetches the VOKO sources as pinned tarballs, for builds that have no git.
 *
 * `scripts/fonto.sh` is the development path: it checks out the submodules, and
 * the superproject's gitlinks are then the record of which commits are in use.
 * A container build has neither git nor `.git` — builders that clone from
 * GitHub (Railway among them) ship no submodule contents — and installing git
 * there means depending on a Debian 11 package mirror that has already started
 * returning 404s for the base image's pinned versions. So the same two commits
 * are downloaded from GitHub instead, using only fetch and the image's tar.
 * Both repositories are public: no credentials.
 *
 * The commits come from the environment (the Dockerfile's ARGs), so they are
 * not duplicated here; test/deploy-pins.test.ts keeps those in step with the
 * submodule pins.
 *
 *   REVO_FONTO_SHA=… VOKO_GRUNDO_SHA=… pnpm exec tsx scripts/fetch-sources.ts
 *   VENDOR_DIR=/sources/vendor … pnpm exec tsx scripts/fetch-sources.ts
 */
import { spawnSync } from "child_process";
import { createWriteStream, existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import type { ReadableStream } from "stream/web";
import { fileURLToPath } from "url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEST = process.env.VENDOR_DIR || join(ROOT, "vendor");

interface Source {
  name: string;
  repo: string;
  sha: string;
  /** Only these directories are unpacked; the rest of the repo is not read. */
  dirs: string[];
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(
      `${name} is not set. Pass the pinned commits, e.g.\n` +
        `  REVO_FONTO_SHA=<sha> VOKO_GRUNDO_SHA=<sha> pnpm exec tsx scripts/fetch-sources.ts\n` +
        "or use `pnpm fonto` instead, which checks out the submodules with git."
    );
  }
  return v;
}

async function fetchSource(s: Source): Promise<void> {
  const dest = join(DEST, s.name);
  const url = `https://codeload.github.com/${s.repo}/tar.gz/${s.sha}`;
  const tmp = join(DEST, `.${s.name}.tar.gz`);

  console.log(`${s.name}: ${s.repo} at ${s.sha.slice(0, 7)}`);
  const res = await fetch(url, { headers: { "user-agent": "revo-mcp build" } });
  if (!res.ok || !res.body) throw new Error(`${url} → HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body as ReadableStream<Uint8Array>), createWriteStream(tmp));

  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });

  // GitHub's archive wraps everything in <repo>-<sha>/, hence the strip.
  const members = s.dirs.map((d) => `${s.name}-${s.sha}/${d}`);
  const tar = spawnSync("tar", ["-xzf", tmp, "--strip-components=1", "-C", dest, ...members], {
    stdio: ["ignore", "inherit", "inherit"],
  });
  rmSync(tmp, { force: true });
  if (tar.status !== 0) throw new Error(`tar failed to unpack ${s.name}`);

  for (const d of s.dirs) {
    if (!existsSync(join(dest, d))) {
      throw new Error(`${s.name}: ${d}/ is missing after unpacking — wrong commit?`);
    }
  }
  console.log(`  → ${dest} (${s.dirs.join(", ")})`);
}

const SOURCES: Source[] = [
  {
    name: "revo-fonto",
    repo: process.env.REVO_FONTO_REPO || "Davidiusdadi/revo-fonto",
    sha: required("REVO_FONTO_SHA"),
    dirs: ["revo", "cfg"],
  },
  {
    name: "voko-grundo",
    repo: process.env.VOKO_GRUNDO_REPO || "revuloj/voko-grundo",
    sha: required("VOKO_GRUNDO_SHA"),
    dirs: ["dtd", "cfg"],
  },
];

mkdirSync(DEST, { recursive: true });
for (const s of SOURCES) await fetchSource(s);

// Provenance for anything looking at a built image, where git cannot answer.
writeFileSync(
  join(DEST, "SOURCES.json"),
  JSON.stringify(
    SOURCES.map((s) => ({ name: s.name, repo: s.repo, commit: s.sha })),
    null,
    1
  ) + "\n"
);
console.log(`wrote ${join(DEST, "SOURCES.json")}`);
