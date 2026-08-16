// Gate: no `as` casts in library or example source. `as const` is the only
// sanctioned form; `unknown` plus a runtime validator is the exit for trust
// boundaries. Tests are exempt (malformed inputs there are plain `unknown`).
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

function scan(path) {
  const lines = readFileSync(path, "utf8").split("\n");
  lines.forEach((line, index) => {
    const code = line.replace(/\/\/.*$/, "");
    if (castPattern.test(code)) {
      violations.push(`${path}:${index + 1}: ${line.trim()}`);
    }
  });
}

for (const root of roots) walk(root);

if (violations.length > 0) {
  console.error("check-casts: `as` casts are gate failures (use unknown + a validator):");
  for (const violation of violations) console.error(`  ${violation}`);
  process.exit(1);
}
console.log("check-casts: ok");
