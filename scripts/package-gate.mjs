#!/usr/bin/env node
/** Packaging gate 9: inspect and consume the exact pnpm-pack tarball. */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageDirectory = join(root, "packages", "learning-loop");
const dryRun = process.argv.slice(2).includes("--dry-run");

function fail(message) {
  throw new Error(`[package-gate] ${message}`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    encoding: "utf8",
    env: process.env,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    fail(`${command} ${args.join(" ")} failed with exit ${String(result.status)}\n${result.stdout}${result.stderr}`);
  }
  return result.stdout;
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch {
    fail(`${label} returned invalid JSON`);
  }
}

function normalizePath(path) {
  return path.startsWith("package/") ? path.slice("package/".length) : path;
}

function packagePathsFromDryRun(text) {
  const parsed = parseJson(text, "npm pack --dry-run");
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    fail("npm pack --dry-run must describe exactly one package");
  }
  const record = parsed[0];
  if (typeof record !== "object" || record === null || !("files" in record) || !Array.isArray(record.files)) {
    fail("npm pack --dry-run returned an invalid files record");
  }
  return record.files.map((file) => {
    if (typeof file !== "object" || file === null || !("path" in file) || typeof file.path !== "string") {
      fail("npm pack --dry-run returned an invalid file path");
    }
    return normalizePath(file.path);
  });
}

function packagePathsFromTarball(tarball) {
  return run("tar", ["-tzf", tarball])
    .split("\n")
    .filter((path) => path.length > 0 && !path.endsWith("/"))
    .map(normalizePath);
}

function validatePackagePaths(inputPaths) {
  const paths = [...new Set(inputPaths)].sort();
  const present = new Set(paths);
  const required = [
    "package.json",
    "README.md",
    "LICENSE",
    "NOTICE",
    "src/index.ts",
    "src/node/index.ts",
    "src/testing/index.ts",
    "src/reference-detectors/index.ts",
    "src/workflows/index.ts",
    "dist/index.js",
    "dist/index.d.ts",
    "dist/node/index.js",
    "dist/node/index.d.ts",
    "dist/testing/index.js",
    "dist/testing/index.d.ts",
    "dist/reference-detectors/index.js",
    "dist/reference-detectors/index.d.ts",
    "dist/workflows/index.js",
    "dist/workflows/index.d.ts",
  ];
  for (const requiredPath of required) {
    if (!present.has(requiredPath)) fail(`required path is missing: ${requiredPath}`);
  }

  const allowedTopLevel = new Set(["dist", "src", "LICENSE", "NOTICE", "README.md", "package.json"]);
  for (const path of paths) {
    const [topLevel] = path.split("/");
    if (!topLevel || !allowedTopLevel.has(topLevel)) fail(`unexpected top-level path: ${path}`);
    if (/(?:^|\/)tests?(?:\/|$)/iu.test(path)) fail(`test content must not ship: ${path}`);
    if (/(?:^|\/)docs?(?:\/|$)/iu.test(path)) fail(`documentation directories must not ship: ${path}`);
    if (/(?:^|\/)fixtures?(?:\/|$)/iu.test(path)) fail(`fixture directories must not ship: ${path}`);
    if (/(?:^|\/)\.env(?:[.-][^/]*)?(?:\/|$)/iu.test(path) || /\.env$/iu.test(basename(path))) {
      fail(`environment-shaped content must not ship: ${path}`);
    }
    if (/\.test\.[cm]?[jt]sx?$/iu.test(path)) fail(`test module must not ship: ${path}`);
    if (/\.(?:js|d\.ts)\.map$/u.test(path)) fail(`source map must not ship: ${path}`);
  }

  const sources = paths.filter((path) => path.startsWith("src/") && path.endsWith(".ts"));
  for (const source of sources) {
    const stem = source.slice("src/".length, -".ts".length);
    if (!present.has(`dist/${stem}.js`)) fail(`compiled JavaScript is missing for ${source}`);
    if (!present.has(`dist/${stem}.d.ts`)) fail(`declaration is missing for ${source}`);
  }

  console.log(`[package-gate] accepted ${String(paths.length)} package files`);
}

function assertPackageIdentity(tarball, consumerDirectory) {
  const installedManifestPath = join(consumerDirectory, "node_modules", "@cormidia", "learning-loop", "package.json");
  const manifest = parseJson(readFileSync(installedManifestPath, "utf8"), "installed package manifest");
  const sourceManifest = parseJson(readFileSync(join(packageDirectory, "package.json"), "utf8"), "source manifest");
  if (typeof manifest !== "object" || manifest === null) fail("installed package manifest is not an object");
  if (typeof sourceManifest !== "object" || sourceManifest === null) fail("source manifest is not an object");
  if (!("name" in manifest) || manifest.name !== "@cormidia/learning-loop") fail("installed package name drifted");
  if (!("version" in manifest) || manifest.version !== "0.1.1") fail("installed package version drifted");
  if (!("license" in manifest) || manifest.license !== "Apache-2.0") fail("installed package license drifted");
  if ("private" in sourceManifest) {
    if (sourceManifest.private !== true || !("private" in manifest) || manifest.private !== true) {
      fail("packed manifest must retain the preparation branch's private guard");
    }
  } else if ("private" in manifest) {
    fail("packed manifest retained a removed private guard");
  }
  if ("dependencies" in manifest) {
    if (typeof manifest.dependencies !== "object" || manifest.dependencies === null) {
      fail("installed package dependencies field is invalid");
    }
    if (Object.keys(manifest.dependencies).length > 0) fail("runtime dependencies must remain empty");
  }
  if (!tarball.endsWith("cormidia-learning-loop-0.1.1.tgz")) fail("tarball filename does not bind version 0.1.1");
}

function installAndCompile(tarball, temporaryDirectory) {
  const consumerDirectory = join(temporaryDirectory, "consumer");
  mkdirSync(consumerDirectory);
  writeFileSync(
    join(consumerDirectory, "package.json"),
    `${JSON.stringify({ name: "strict-package-consumer", private: true, type: "module" }, null, 2)}\n`,
  );
  writeFileSync(
    join(consumerDirectory, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          target: "ES2023",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          exactOptionalPropertyTypes: true,
          noUncheckedIndexedAccess: true,
          noEmit: true,
          skipLibCheck: false,
        },
        include: ["consumer.ts"],
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(consumerDirectory, "consumer.ts"),
    `import { createLearningLoop } from "@cormidia/learning-loop";
import { createFileStore } from "@cormidia/learning-loop/node";
import { createReferenceDetectorBundle } from "@cormidia/learning-loop/reference-detectors";
import { createInMemoryStore } from "@cormidia/learning-loop/testing";
import { createSemanticWorkflowBundle } from "@cormidia/learning-loop/workflows";

const documentedExports: readonly unknown[] = [
  createLearningLoop,
  createFileStore,
  createReferenceDetectorBundle,
  createInMemoryStore,
  createSemanticWorkflowBundle,
];

void documentedExports;
`,
  );
  writeFileSync(
    join(consumerDirectory, "consumer.mjs"),
    `import { createLearningLoop } from "@cormidia/learning-loop";
import { createFileStore } from "@cormidia/learning-loop/node";
import { createReferenceDetectorBundle } from "@cormidia/learning-loop/reference-detectors";
import { createInMemoryStore } from "@cormidia/learning-loop/testing";
import { createSemanticWorkflowBundle } from "@cormidia/learning-loop/workflows";

for (const value of [createLearningLoop, createFileStore, createReferenceDetectorBundle, createInMemoryStore, createSemanticWorkflowBundle]) {
  if (typeof value !== "function") throw new Error("documented export did not resolve to a function");
}
`,
  );

  run(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["install", tarball, "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false"],
    { cwd: consumerDirectory },
  );
  assertPackageIdentity(tarball, consumerDirectory);

  const dependencyTree = parseJson(
    run(process.platform === "win32" ? "npm.cmd" : "npm", ["ls", "--all", "--json"], {
      cwd: consumerDirectory,
    }),
    "npm ls",
  );
  if (typeof dependencyTree !== "object" || dependencyTree === null || !("dependencies" in dependencyTree)) {
    fail("npm ls returned an invalid dependency tree");
  }
  const dependencies = dependencyTree.dependencies;
  if (typeof dependencies !== "object" || dependencies === null) fail("npm ls dependencies are invalid");
  if (Object.keys(dependencies).join(",") !== "@cormidia/learning-loop") {
    fail(`consumer installed unexpected packages: ${Object.keys(dependencies).join(", ")}`);
  }

  run(process.execPath, [join(root, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.json"], {
    cwd: consumerDirectory,
  });
  run(process.execPath, ["consumer.mjs"], { cwd: consumerDirectory });
  console.log("[package-gate] strict TypeScript and runtime consumers passed with zero transitive packages");
}

function runDryRun() {
  const output = run(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["pack", "--dry-run", "--json", "--ignore-scripts"],
    { cwd: packageDirectory },
  );
  validatePackagePaths(packagePathsFromDryRun(output));
}

function runFullGate() {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "learning-loop-package-gate-"));
  try {
    run("pnpm", ["pack", "--pack-destination", temporaryDirectory], { cwd: packageDirectory });
    const tarballs = readdirSync(temporaryDirectory)
      .filter((path) => path.endsWith(".tgz"))
      .map((path) => join(temporaryDirectory, path));
    if (tarballs.length !== 1 || !tarballs[0]) fail("pnpm pack must produce exactly one tarball");
    validatePackagePaths(packagePathsFromTarball(tarballs[0]));
    installAndCompile(tarballs[0], temporaryDirectory);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

if (dryRun) runDryRun();
else runFullGate();
