// Host discovery day filtering: claude-code by file mtime (local day),
// codex by the day's directory. The adapters never see the other days' files.
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { localDayOf } from "../src/discovery.js";
import { claudeUserText, cli, codexMessage, codexSessionMeta, makeTempDir, removeDir, writeJsonl } from "./support.js";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) removeDir(dir);
});

function tempDir(prefix: string): string {
  const dir = makeTempDir(prefix);
  dirs.push(dir);
  return dir;
}

test("claude-code ingest only picks files whose mtime falls on --day", async () => {
  const stateDir = tempDir("ti-day-state-");
  const root = tempDir("ti-day-claude-");
  const mtimeA = new Date("2026-08-10T12:00:00.000Z");
  const mtimeB = new Date(mtimeA.getTime() + 5 * 86_400_000);
  writeJsonl(
    join(root, "-Users-x-alpha", "a.jsonl"),
    [claudeUserText("2026-08-10T09:00:00.000Z", "hello from alpha", { id: "sess-a", cwd: "/Users/x/alpha" })],
    mtimeA,
  );
  writeJsonl(
    join(root, "-Users-x-alpha", "b.jsonl"),
    [claudeUserText("2026-08-15T09:00:00.000Z", "hello from bravo", { id: "sess-b", cwd: "/Users/x/bravo" })],
    mtimeB,
  );

  const result = await cli([
    "ingest",
    "--provider",
    "claude-code",
    "--root",
    root,
    "--day",
    localDayOf(mtimeA),
    "--state",
    stateDir,
  ]);
  expect(result.code).toBe(0);
  expect(result.text).toContain("files considered: 1");

  const report = await cli(["report", "--state", stateDir]);
  expect(report.text).toMatch(/claude-code\/[0-9a-f]{64}/);
  expect(report.text).not.toContain("alpha");
  expect(report.text).not.toContain("bravo");
});

test("codex ingest reads exactly the day directory", async () => {
  const stateDir = tempDir("ti-day-state-");
  const root = tempDir("ti-day-codex-");
  writeJsonl(join(root, "2026", "08", "10", "rollout-1.jsonl"), [
    codexSessionMeta("2026-08-10T10:00:00.000Z", "codex-1", "/Users/x/charlie"),
    codexMessage("2026-08-10T10:01:00.000Z", "user", "start here"),
  ]);
  writeJsonl(join(root, "2026", "08", "12", "rollout-2.jsonl"), [
    codexSessionMeta("2026-08-12T10:00:00.000Z", "codex-2", "/Users/x/delta"),
    codexMessage("2026-08-12T10:01:00.000Z", "user", "another day"),
  ]);

  const result = await cli([
    "ingest",
    "--provider",
    "codex",
    "--root",
    root,
    "--day",
    "2026-08-10",
    "--state",
    stateDir,
  ]);
  expect(result.code).toBe(0);
  expect(result.text).toContain("files considered: 1");

  const report = await cli(["report", "--state", stateDir]);
  expect(report.text).toMatch(/codex\/[0-9a-f]{64}/);
  expect(report.text).not.toContain("charlie");
  expect(report.text).not.toContain("delta");

  const empty = await cli([
    "ingest",
    "--provider",
    "codex",
    "--root",
    root,
    "--day",
    "2026-08-11",
    "--state",
    stateDir,
  ]);
  expect(empty.code).toBe(0);
  expect(empty.text).toContain("files considered: 0");
});
