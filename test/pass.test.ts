import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runPass, type Pass } from "../src/corpus/pass";

// meta_pass as schema.sql declares it; a pass needs nothing else of the database.
let db: Database;
beforeEach(() => {
  db = new Database(":memory:");
  db.run(`CREATE TABLE meta_pass (
    pass TEXT PRIMARY KEY, version INTEGER NOT NULL, input_hash TEXT,
    rows INTEGER NOT NULL, ms INTEGER NOT NULL, at TEXT NOT NULL)`);
});

const fill = (label: string): Pass => ({
  name: "probe",
  version: label === "first" ? 1 : 2,
  tables: ["x_probe"],
  run(d) {
    d.run("CREATE TABLE x_probe (label TEXT)");
    d.run("INSERT INTO x_probe VALUES (?)", [label]);
    return 1;
  },
});

const version = () =>
  (db.query("SELECT version FROM meta_pass WHERE pass = 'probe'").get() as { version: number } | null)
    ?.version ?? null;
const labels = () => db.query("SELECT label FROM x_probe").all().map((r) => (r as { label: string }).label);

describe("runPass", () => {
  test("records the run it made", () => {
    runPass(db, fill("first"), () => {});
    expect(labels()).toEqual(["first"]);
    expect(version()).toBe(1);
  });

  test("re-running replaces the tables and the meta_pass row", () => {
    runPass(db, fill("first"), () => {});
    runPass(db, fill("second"), () => {});
    expect(labels()).toEqual(["second"]);
    expect(version()).toBe(2);
  });

  test("a pass that throws leaves the previous result in place", () => {
    runPass(db, fill("first"), () => {});
    const broken: Pass = {
      name: "probe",
      version: 2,
      tables: ["x_probe"],
      run(d) {
        d.run("CREATE TABLE x_probe (label TEXT)");
        throw new Error("half-way");
      },
    };
    expect(() => runPass(db, broken, () => {})).toThrow("half-way");
    // the tables are still there, with the rows of the run meta_pass names
    expect(labels()).toEqual(["first"]);
    expect(version()).toBe(1);
  });
});
