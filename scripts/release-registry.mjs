#!/usr/bin/env node
/** Read-only npm registry reconciliation for the protected release workflow. */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageName = "@cormidia/learning-loop";

export function tarballIntegrity(path) {
  return `sha512-${createHash("sha512").update(readFileSync(path)).digest("base64")}`;
}

function parseRegistryRecord(text, version) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`npm view ${packageName}@${version} returned invalid JSON`);
  }
  if (typeof value !== "object" || value === null) {
    throw new Error(`npm view ${packageName}@${version} returned a non-object record`);
  }
  return value;
}

export function classifyViewResult(result, expectedVersion, expectedIntegrity) {
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const value = parseRegistryRecord(result.stdout || "null", expectedVersion);
    if (
      "error" in value &&
      typeof value.error === "object" &&
      value.error !== null &&
      "code" in value.error &&
      value.error.code === "E404"
    ) {
      return { state: "missing" };
    }
    throw new Error(
      `npm view ${packageName}@${expectedVersion} was ambiguous (exit ${String(result.status)}):\n${result.stderr || result.stdout}`,
    );
  }

  const value = parseRegistryRecord(result.stdout, expectedVersion);
  const version = "version" in value ? value.version : undefined;
  let integrity;
  if ("dist.integrity" in value) integrity = value["dist.integrity"];
  else if ("dist" in value && typeof value.dist === "object" && value.dist !== null && "integrity" in value.dist) {
    integrity = value.dist.integrity;
  }
  if (version !== expectedVersion || typeof integrity !== "string") {
    throw new Error(`npm view ${packageName}@${expectedVersion} returned an invalid version/integrity record`);
  }
  if (integrity !== expectedIntegrity) {
    throw new Error(
      `${packageName}@${expectedVersion} exists with different integrity; expected ${expectedIntegrity}, registry has ${integrity}`,
    );
  }
  return { state: "matching", integrity };
}

function inspect(version, integrity) {
  const result = spawnSync(
    process.env.NPM_BINARY || "npm",
    ["view", `${packageName}@${version}`, "version", "dist.integrity", "--json"],
    { encoding: "utf8" },
  );
  return classifyViewResult(result, version, integrity);
}

function usage() {
  console.error("usage: release-registry.mjs <plan|verify> <version> <tarball.tgz>");
  return 2;
}

export function main(argv) {
  const [mode, version, tarballPath] = argv;
  if ((mode !== "plan" && mode !== "verify") || !/^\d+\.\d+\.\d+$/u.test(version ?? "") || !tarballPath) {
    return usage();
  }

  try {
    const integrity = tarballIntegrity(resolve(tarballPath));
    const state = inspect(version, integrity);
    console.error(`registry: ${packageName}@${version}=${state.state}`);
    if (mode === "verify") {
      if (state.state !== "matching") {
        throw new Error("Exact tarball integrity is not present in the npm registry");
      }
      return 0;
    }

    const publish = state.state === "missing";
    const output = process.env.GITHUB_OUTPUT;
    if (output) appendFileSync(output, `publish=${String(publish)}\n`);
    console.log(JSON.stringify({ publish }));
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown registry inspection failure";
    console.error(`[release-registry] ${message}`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv.slice(2));
}
