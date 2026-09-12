import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

// src/db.ts reads REVO_DB when it is imported, so the guard has to be
// exercised in a child process: this one points at a database that is not an
// XML-built corpus and asks for the connection twice.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

let dir: string;
let out: { first: string; second: string };

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "voko-guard-"));
  const wrong = join(dir, "not-voko.db");
  const db = new Database(wrong);
  db.exec("CREATE TABLE kap (mrk TEXT, kap TEXT)"); // no meta table at all
  db.close();

  const script = join(dir, "ask-twice.ts");
  writeFileSync(
    script,
    `import { getDb } from ${JSON.stringify(join(ROOT, "src", "db.ts"))};
     const say = (f: () => unknown) => {
       try { f(); return "no error"; } catch (e) { return (e as Error).message; }
     };
     console.log(JSON.stringify({ first: say(getDb), second: say(getDb) }));\n`
  );

  const proc = Bun.spawnSync(["bun", "run", script], {
    env: { ...process.env, REVO_DB: wrong },
  });
  out = JSON.parse(proc.stdout.toString().trim().split("\n").pop() ?? "{}");
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("getDb", () => {
  test("rejects a database that is not an XML-built corpus", () => {
    expect(out.first).toContain("is not an XML-built corpus");
  });

  test("keeps rejecting it instead of caching the handle", () => {
    expect(out.second).toBe(out.first);
  });
});
