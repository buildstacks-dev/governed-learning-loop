// Gate: no `as` casts in library or example source. `as const` is the only
// sanctioned form; `unknown` plus a runtime validator is the exit for trust
// boundaries. Tests are exempt (malformed inputs there are plain `unknown`).
// Import/export rename syntax (`import { x as y }`) and comments are not
// casts and are not flagged.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const roots = ["packages", "examples"];
const violations = [];

function walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === "dist" || entry === "tests") continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      walk(path);
    } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
      scan(path);
    }
  }
}

const castPattern = /\bas\s+(?!const\b)[A-Za-z_$[{(]/;
// Lines that are (part of) import/export statements: rename syntax there is
// module syntax, not a cast. Covers single-line forms and the members of
// multi-line import/export braces.
const moduleSyntaxLine =
  /^\s*(?:import\b|export\s*(?:type\s*)?\{|\}?\s*from\s+["']|(?:type\s+)?[\w$]+\s+as\s+[\w$]+,?\s*$)/;

function scan(path) {
  const source = readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, " "));
  const lines = source.split("\n");
  lines.forEach((line, index) => {
    const code = line.replace(/\/\/.*$/, "");
    if (!castPattern.test(code)) return;
    if (moduleSyntaxLine.test(code)) return;
    violations.push(`${path}:${index + 1}: ${line.trim()}`);
  });
}

for (const root of roots) walk(root);

if (violations.length > 0) {
  console.error("check-casts: `as` casts are gate failures (use unknown + a validator):");
  for (const violation of violations) console.error(`  ${violation}`);
  process.exit(1);
}
console.log("check-casts: ok");
