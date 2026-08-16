// Privacy: a canary string planted in fixture message text, tool arguments,
// and tool results must never reach the durable state directory nor any CLI
// output. Redaction happens at emission inside the adapters; this test proves
// the whole demo pipeline preserves it end to end.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { localDayOf } from "../src/discovery.js";
import {
  claudeAssistantToolUse,
  claudeToolResult,
  claudeUserText,
  cli,
  codexMessage,
  codexSessionMeta,
  codexToolCall,
  codexToolOutput,
  makeTempDir,
  removeDir,
  writeJsonl,
} from "./support.js";

const CANARY = "CANARY-9f3e58c2a7d34b6f-DO-NOT-PERSIST";

const stateDir = makeTempDir("ti-canary-state-");
const claudeRoot = makeTempDir("ti-canary-claude-");
const codexRoot = makeTempDir("ti-canary-codex-");
afterAll(() => {
  removeDir(stateDir);
  removeDir(claudeRoot);
  removeDir(codexRoot);
});

function walkFiles(dir: string): readonly string[] {
  const files: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) files.push(...walkFiles(path));
    else files.push(path);
  }
  return files;
}

test("the canary never reaches state files or CLI output", async () => {
  const mtime = new Date("2026-08-10T12:00:00.000Z");
  writeJsonl(
    join(claudeRoot, "-Users-x-secret", "s1.jsonl"),
    [
      claudeUserText("2026-08-10T09:00:00.000Z", `context: ${CANARY} appears in my prompt`, {
        id: "sess-c1",
        cwd: "/Users/x/secretproj",
      }),
      claudeAssistantToolUse("2026-08-10T09:01:00.000Z", "tu1", "Bash"),
      claudeToolResult("2026-08-10T09:02:00.000Z", "tu1", true, `stderr says ${CANARY}`),
      claudeUserText("2026-08-10T09:03:00.000Z", `no, ${CANARY} is not what I meant`),
    ],
    mtime,
  );
  writeJsonl(join(codexRoot, "2026", "08", "10", "rollout-1.jsonl"), [
    codexSessionMeta("2026-08-10T10:00:00.000Z", "codex-c1", "/Users/x/secretproj"),
    codexMessage("2026-08-10T10:01:00.000Z", "user", `please handle ${CANARY} carefully`),
    codexToolCall("2026-08-10T10:02:00.000Z", "c1", "shell", `{"command":"echo ${CANARY}"}`),
    codexToolOutput("2026-08-10T10:03:00.000Z", "c1", true, `output containing ${CANARY}`),
  ]);

  const outputs = [
    await cli([
      "ingest",
      "--provider",
      "claude-code",
      "--root",
      claudeRoot,
      "--day",
      localDayOf(mtime),
      "--state",
      stateDir,
    ]),
    await cli(["ingest", "--provider", "codex", "--root", codexRoot, "--day", "2026-08-10", "--state", stateDir]),
    await cli(["distill", "--state", stateDir]),
    await cli(["report", "--state", stateDir]),
  ];
  for (const output of outputs) {
    expect(output.text).not.toContain(CANARY);
  }

  const files = walkFiles(stateDir);
  expect(files.length).toBeGreaterThan(0);
  for (const file of files) {
    expect(readFileSync(file, "utf8")).not.toContain(CANARY);
  }
});
