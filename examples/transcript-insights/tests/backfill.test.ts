// Backfill: one line per day, continues past per-day failures, and re-running
// the same range is safe because ingestion is idempotent.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { cli, codexMessage, codexSessionMeta, makeTempDir, removeDir, writeJsonl } from "./support.js";

const stateDir = makeTempDir("ti-backfill-state-");
const root = makeTempDir("ti-backfill-codex-");
afterAll(() => {
  removeDir(stateDir);
  removeDir(root);
});

test("backfill iterates days, survives a failing day, and is resumable", async () => {
  writeJsonl(join(root, "2026", "08", "10", "rollout-1.jsonl"), [
    codexSessionMeta("2026-08-10T10:00:00.000Z", "codex-1", "/Users/x/echo"),
    codexMessage("2026-08-10T10:01:00.000Z", "user", "day ten"),
  ]);
  // A regular file where the 2026-08-11 day DIRECTORY belongs: discovery for
  // that day fails (ENOTDIR) while the neighbouring days keep working.
  mkdirSync(join(root, "2026", "08"), { recursive: true });
  writeFileSync(join(root, "2026", "08", "11"), "not a directory\n", "utf8");
  writeJsonl(join(root, "2026", "08", "12", "rollout-2.jsonl"), [
    codexSessionMeta("2026-08-12T10:00:00.000Z", "codex-2", "/Users/x/echo"),
    codexMessage("2026-08-12T10:01:00.000Z", "user", "day twelve"),
  ]);

  const first = await cli([
    "backfill",
    "--provider",
    "codex",
    "--root",
    root,
    "--from",
    "2026-08-10",
    "--to",
    "2026-08-12",
    "--state",
    stateDir,
  ]);
  expect(first.code).toBe(1);
  expect(first.lines[0]).toBe(`backfill: start state=${stateDir} provider=codex days=2026-08-10..2026-08-12`);
  expect(first.text).toContain("backfill: day=2026-08-10 provider=codex files=1 start");
  expect(first.lines.some((line) => line.startsWith("2026-08-10") && line.includes("files=1"))).toBe(true);
  expect(first.lines.some((line) => line.startsWith("2026-08-11") && line.includes("FAILED"))).toBe(true);
  expect(first.lines.some((line) => line.startsWith("2026-08-12") && line.includes("files=1"))).toBe(true);
  expect(first.text).toContain("backfill done: 2 day(s) ingested, 1 day(s) failed");

  // Resume by re-running the same range: already-ingested days are all
  // already-known, zero net-new.
  const second = await cli([
    "backfill",
    "--provider",
    "codex",
    "--root",
    root,
    "--from",
    "2026-08-10",
    "--to",
    "2026-08-12",
    "--state",
    stateDir,
  ]);
  expect(second.code).toBe(1);
  const dayTen = second.lines.find((line) => line.startsWith("2026-08-10"));
  expect(dayTen).toBeDefined();
  expect(dayTen).toContain("new-obs=0");
  expect(dayTen).toContain("known=3");
});

test("an inverted range is a usage-level error", async () => {
  const result = await cli([
    "backfill",
    "--provider",
    "codex",
    "--root",
    root,
    "--from",
    "2026-08-12",
    "--to",
    "2026-08-10",
    "--state",
    stateDir,
  ]);
  expect(result.code).toBe(1);
  expect(result.text).toContain("is after");
});
