// Export ratchet: every public symbol of @cormidia/learning-loop is an
// explicit decision. This script extracts exported names from the three
// entrypoints and compares them with docs/public-api.txt. To change the
// public surface, update the snapshot in the same PR and say why in the body.
import { readFileSync } from "node:fs";

const entrypoints = [
  ["root", "packages/learning-loop/src/index.ts"],
  ["node", "packages/learning-loop/src/node/index.ts"],
  ["testing", "packages/learning-loop/src/testing/index.ts"],
];

const namedExport =
  /^export\s+(?:declare\s+)?(?:const|function|class|interface|type|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)/;
const braceExport = /^export\s+(?:type\s+)?\{([^}]*)\}/;

function exportedNames(source) {
  const names = [];
  for (const rawLine of source.split("\n")) {
    const line = rawLine.trim();
    const named = namedExport.exec(line);
    if (named?.[1]) {
      names.push(named[1]);
      continue;
    }
    const braced = braceExport.exec(line);
    if (braced?.[1]) {
      for (const piece of braced[1].split(",")) {
        const name = piece
          .split(" as ")
          .pop()
          ?.replace(/^type\s+/, "")
          .trim();
        if (name) names.push(name);
      }
    }
  }
  return names;
}

const actual = [];
for (const [label, path] of entrypoints) {
  let source = "";
  try {
    source = readFileSync(path, "utf8");
  } catch {
    continue;
  }
  for (const name of exportedNames(source)) actual.push(`${label}:${name}`);
}
actual.sort();

const snapshot = readFileSync("docs/public-api.txt", "utf8")
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line.length > 0 && !line.startsWith("#"))
  .sort();

const added = actual.filter((name) => !snapshot.includes(name));
const removed = snapshot.filter((name) => !actual.includes(name));

if (added.length > 0 || removed.length > 0) {
  console.error("check-exports: public surface changed without a snapshot decision (docs/public-api.txt):");
  for (const name of added) console.error(`  + ${name}`);
  for (const name of removed) console.error(`  - ${name}`);
  process.exit(1);
}
console.log(`check-exports: ok (${actual.length} public symbols)`);
