/**
 * Generates packages/voko-xml/data/entities.json and data/cfg/*.json from the
 * vendor/voko-grundo submodule (`pnpm fonto` checks it out and runs this).
 * The VOKO articles depend on ~850 character/abbreviation/URL entities that
 * live in voko-grundo, not in revo-fonto. The generated files are not
 * committed; the submodule pin is the record of where they come from.
 *
 *   pnpm corpus:entities                            # from vendor/voko-grundo
 *   VOKO_GRUNDO=/path/to/voko-grundo pnpm corpus:entities
 */
import { spawnSync } from "child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const GRUNDO = process.env.VOKO_GRUNDO || join(ROOT, "vendor", "voko-grundo");
if (!existsSync(join(GRUNDO, "dtd"))) {
  console.error(`no voko-grundo at ${GRUNDO} — run \`pnpm fonto\`, or set VOKO_GRUNDO`);
  process.exit(1);
}
const OUT = join(ROOT, "packages", "voko-xml", "data");

const DTD_FILES = ["vokosgn.dtd", "vokomll.dtd", "vokourl.dtd"];
// The XML built-ins; the DTDs don't declare them but articles use them.
const BUILTIN: Record<string, string> = { amp: "&", lt: "<", gt: ">", apos: "'", quot: '"' };

function parseDtd(text: string): Map<string, string> {
  const raw = new Map<string, string>();
  // Strip comments so commented-out declarations are ignored.
  const noComments = text.replace(/<!--[\s\S]*?-->/g, "");
  const re = /<!ENTITY\s+([A-Za-z_][\w.\-]*)\s+("([^"]*)"|'([^']*)')\s*>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(noComments))) {
    raw.set(m[1], m[3] ?? m[4] ?? "");
  }
  return raw;
}

function resolve(raw: Map<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  const seen = new Set<string>();
  function expand(name: string): string {
    if (name in out) return out[name];
    if (name in BUILTIN) return BUILTIN[name];
    if (seen.has(name)) throw new Error(`entity cycle at &${name};`);
    const val = raw.get(name);
    if (val === undefined) throw new Error(`undefined entity &${name};`);
    seen.add(name);
    const expanded = val.replace(/&(#x[0-9A-Fa-f]+|#\d+|[A-Za-z_][\w.\-]*);/g, (_, ref: string) => {
      if (ref.startsWith("#x")) return String.fromCodePoint(parseInt(ref.slice(2), 16));
      if (ref.startsWith("#")) return String.fromCodePoint(parseInt(ref.slice(1), 10));
      return expand(ref);
    });
    seen.delete(name);
    out[name] = expanded;
    return expanded;
  }
  for (const name of raw.keys()) expand(name);
  return out;
}

/** Tiny extractor for the flat cfg lists: <tag kodo="X" attr="..">text</tag>. */
function parseCfgList(
  xml: string,
  tag: string,
  entities: Record<string, string>
): { kodo: string; nomo: string; [k: string]: string }[] {
  const body = xml.replace(/<!--[\s\S]*?-->/g, "");
  const re = new RegExp(`<${tag}\\s+([^>]*)>([\\s\\S]*?)</${tag}>`, "g");
  const rows: { kodo: string; nomo: string; [k: string]: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    const attrs: Record<string, string> = {};
    for (const a of m[1].matchAll(/([\w:-]+)="([^"]*)"/g)) attrs[a[1]] = a[2];
    const nomo = decode(m[2].replace(/\s+/g, " ").trim(), entities);
    rows.push({ ...attrs, kodo: attrs.kodo, nomo });
  }
  return rows;
}

function decode(s: string, entities: Record<string, string>): string {
  return s.replace(/&(#x[0-9A-Fa-f]+|#\d+|[A-Za-z_][\w.\-]*);/g, (_, ref: string) => {
    if (ref.startsWith("#x")) return String.fromCodePoint(parseInt(ref.slice(2), 16));
    if (ref.startsWith("#")) return String.fromCodePoint(parseInt(ref.slice(1), 10));
    const v = entities[ref] ?? BUILTIN[ref];
    if (v === undefined) throw new Error(`undefined entity &${ref}; in cfg`);
    return v;
  });
}

function main() {
  const raw = new Map<string, string>();
  for (const f of DTD_FILES) {
    for (const [k, v] of parseDtd(readFileSync(join(GRUNDO, "dtd", f), "utf8"))) {
      if (raw.has(k) && raw.get(k) !== v) throw new Error(`conflicting entity &${k}; in ${f}`);
      raw.set(k, v);
    }
  }
  const entities = resolve(raw);
  mkdirSync(join(OUT, "cfg"), { recursive: true });
  writeFileSync(join(OUT, "entities.json"), JSON.stringify(entities, null, 0) + "\n");
  console.log(`entities.json: ${Object.keys(entities).length} entities`);

  const cfgs: [string, string, string][] = [
    ["lingvoj.xml", "lingvo", "lingvoj.json"],
    ["fakoj.xml", "fako", "fakoj.json"],
    ["stiloj.xml", "stilo", "stiloj.json"],
    ["mallongigoj.xml", "mallongigo", "mallongigoj.json"],
  ];
  for (const [src, tag, dst] of cfgs) {
    const rows = parseCfgList(readFileSync(join(GRUNDO, "cfg", src), "utf8"), tag, entities);
    writeFileSync(join(OUT, "cfg", dst), JSON.stringify(rows, null, 1) + "\n");
    console.log(`cfg/${dst}: ${rows.length} rows`);
  }

  // Best-effort provenance line: a container build has the DTDs but neither
  // git nor a .git directory to ask.
  let rev = "(revision unknown — no git here)";
  // Without git, spawnSync reports the error and no exit status; the pin is
  // recorded by the caller instead.
  const p = spawnSync("git", ["-C", GRUNDO, "rev-parse", "--short", "HEAD"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (p.status === 0) rev = p.stdout.trim();
  console.log(`from voko-grundo ${rev}`);
}

main();
