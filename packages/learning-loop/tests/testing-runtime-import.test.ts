import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

function plainNodeEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const name of Object.keys(environment)) {
    if (name.startsWith("VITEST") || name === "NODE_OPTIONS" || name === "NODE_PATH") {
      delete environment[name];
    }
  }
  return environment;
}

describe("the TypeScript /testing entrypoint", () => {
  it("loads and exposes callable helpers in plain Node without Vitest state", () => {
    const hook = fileURLToPath(new URL("./fixtures/testing-typescript-resolution-hook.mjs", import.meta.url));
    const child = fileURLToPath(new URL("./fixtures/testing-runtime-child.mjs", import.meta.url));
    const result = spawnSync(process.execPath, ["--import", pathToFileURL(hook).href, child], {
      cwd: fileURLToPath(new URL("../../..", import.meta.url)),
      encoding: "utf8",
      env: plainNodeEnvironment(),
    });

    if (result.status !== 0) {
      throw new Error(`standalone /testing import failed:\n${result.stderr}`);
    }
    expect(JSON.parse(result.stdout)).toEqual({
      suiteNames: ["LearningStore conformance"],
      registeredTestCount: 10,
      firstRegisteredTest: "create-only: same key + same digest is an idempotent exists_same",
      firstTime: "2026-08-20T00:00:00.000Z",
      secondTime: "2026-08-20T00:00:00.250Z",
      ids: ["standalone-record-1", "standalone-record-2"],
    });
  });
});
