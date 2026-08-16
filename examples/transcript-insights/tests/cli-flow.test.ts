// End-to-end consumer journey: ingest (both providers) → idempotent
// re-ingest → distill → dedup on second distill → human review → report.
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { localDayOf } from "../src/discovery.js";
import {
  claudeAssistantToolUse,
  claudeToolResult,
  claudeUserText,
  cli,
  codexEvent,
  codexMessage,
  codexSessionMeta,
  codexToolCall,
  codexToolOutput,
  makeTempDir,
  removeDir,
  writeJsonl,
} from "./support.js";

const stateDir = makeTempDir("ti-flow-state-");
const claudeRoot = makeTempDir("ti-flow-claude-");
const codexRoot = makeTempDir("ti-flow-codex-");
afterAll(() => {
  removeDir(stateDir);
  removeDir(claudeRoot);
  removeDir(codexRoot);
});

// Claude Code day attribution goes by file mtime (local day), so the test
// derives the --day argument from the same mtime it stamps on the fixtures.
const claudeMtime = new Date("2026-08-10T12:00:00.000Z");
const claudeDay = localDayOf(claudeMtime);
const codexDay = "2026-08-10";

function writeFixtures(): void {
  // Project "alpha": 3 Bash failures across 2 sessions AND 3 human
  // correction-signal messages across 2 sessions — two distill clusters.
  writeJsonl(
    join(claudeRoot, "-Users-x-alpha", "s1.jsonl"),
    [
      claudeUserText("2026-08-10T09:00:00.000Z", "please add tests for the parser", {
        id: "sess-a1",
        cwd: "/Users/x/alpha",
      }),
      claudeAssistantToolUse("2026-08-10T09:01:00.000Z", "tu1", "Bash"),
      claudeToolResult("2026-08-10T09:02:00.000Z", "tu1", true),
      claudeAssistantToolUse("2026-08-10T09:03:00.000Z", "tu2", "Bash"),
      claudeToolResult("2026-08-10T09:04:00.000Z", "tu2", true),
      claudeUserText("2026-08-10T09:05:00.000Z", "no, that output is wrong"),
      claudeUserText("2026-08-10T09:06:00.000Z", "actually revert that change"),
    ],
    claudeMtime,
  );
  writeJsonl(
    join(claudeRoot, "-Users-x-alpha", "s2.jsonl"),
    [
      claudeUserText("2026-08-10T14:00:00.000Z", "tidy the readme layout", { id: "sess-a2", cwd: "/Users/x/alpha" }),
      claudeAssistantToolUse("2026-08-10T14:01:00.000Z", "tu1", "Bash"),
      claudeToolResult("2026-08-10T14:02:00.000Z", "tu1", true),
      claudeUserText("2026-08-10T14:03:00.000Z", "stop, use the template file"),
    ],
    claudeMtime,
  );
  writeJsonl(join(codexRoot, "2026", "08", "10", "rollout-1.jsonl"), [
    codexSessionMeta("2026-08-10T10:00:00.000Z", "codex-b1", "/Users/x/bravo"),
    codexEvent("2026-08-10T10:01:00.000Z", "task_started"),
    codexMessage("2026-08-10T10:02:00.000Z", "user", "build the parser feature"),
    codexToolCall("2026-08-10T10:03:00.000Z", "c1", "shell"),
    codexToolOutput("2026-08-10T10:04:00.000Z", "c1", true),
    codexEvent("2026-08-10T10:05:00.000Z", "turn_aborted"),
    {
      timestamp: "2026-08-10T10:06:00.000Z",
      type: "event_msg",
      payload: { type: "token_count", info: { last_token_usage: { input_tokens: 10, output_tokens: 5 } } },
    },
  ]);
}

test("ingest → distill → review → report, with idempotency and dedup", async () => {
  writeFixtures();

  // First claude-code ingest.
  const first = await cli([
    "ingest",
    "--provider",
    "claude-code",
    "--root",
    claudeRoot,
    "--day",
    claudeDay,
    "--state",
    stateDir,
  ]);
  expect(first.code).toBe(0);
  expect(first.text).toContain("files considered: 2");
  // All 16 projected observations survive: sourceRecordIds carry a per-line
  // occurrence suffix, so same-line projections (assistant message+usage;
  // session meta vs the line-1 observation) no longer collide in the
  // engine's derived ids.
  expect(first.text).toContain("observations: 16 new");
  expect(first.text).toContain("episodes: 2 new");
  expect(first.text).not.toContain("store.conflict");

  // Idempotent re-ingest: zero net-new, everything already known.
  const again = await cli([
    "ingest",
    "--provider",
    "claude-code",
    "--root",
    claudeRoot,
    "--day",
    claudeDay,
    "--state",
    stateDir,
  ]);
  expect(again.code).toBe(0);
  expect(again.text).toContain("observations: 0 new");
  expect(again.text).toContain("episodes: 0 new");
  expect(again.text).toContain("already-known records (idempotent re-ingest): 18");

  // Codex ingest: no id collisions, no diagnostics.
  const codex = await cli([
    "ingest",
    "--provider",
    "codex",
    "--root",
    codexRoot,
    "--day",
    codexDay,
    "--state",
    stateDir,
  ]);
  expect(codex.code).toBe(0);
  expect(codex.text).toContain("files considered: 1");
  expect(codex.text).toContain("observations: 6 new");
  expect(codex.text).toContain("episodes: 1 new");
  expect(codex.text).toContain("diagnostics by code: (none)");

  // Distill proposes one inert candidate per qualifying cluster.
  const distill = await cli(["distill", "--state", stateDir]);
  expect(distill.code).toBe(0);
  expect(distill.text).toContain("2 qualifying cluster(s)");
  expect(distill.text).toContain("distill done: 2 new candidate(s), 0 already known");
  const newIds = distill.lines
    .map((line) => /^candidate (\S+) .*— new$/.exec(line)?.[1])
    .filter((id): id is string => id !== undefined);
  expect(newIds).toHaveLength(2);
  const toolCandidate = newIds.find((id) => id.includes("tool-failure"));
  const correctionCandidate = newIds.find((id) => id.includes("correction-signal"));
  expect(toolCandidate).toBeDefined();
  expect(correctionCandidate).toBeDefined();
  if (toolCandidate === undefined || correctionCandidate === undefined) return;

  // Content-digest dedup: a second distill over unchanged data proposes nothing.
  const distillAgain = await cli(["distill", "--state", stateDir]);
  expect(distillAgain.code).toBe(0);
  expect(distillAgain.text).toContain("distill done: 0 new candidate(s), 2 already known");

  // Before review the governance state is "required".
  const reportBefore = await cli(["report", "--state", stateDir]);
  expect(reportBefore.code).toBe(0);
  expect(reportBefore.text).toContain("review: required");

  // Human accepts one candidate, rejects the other; publication stays blocked.
  const accepted = await cli([
    "review",
    "--state",
    stateDir,
    "--candidate",
    toolCandidate,
    "--accept",
    "--note",
    "recurs on my machine too",
  ]);
  expect(accepted.code).toBe(0);
  expect(accepted.text).toContain("disposition: accept");
  expect(accepted.text).toContain("review: accepted");
  expect(accepted.text).toContain("publication: blocked");

  const rejected = await cli(["review", "--state", stateDir, "--candidate", correctionCandidate, "--reject"]);
  expect(rejected.code).toBe(0);
  expect(rejected.text).toContain("disposition: reject");
  expect(rejected.text).toContain("review: blocked");
  expect(rejected.text).toContain("publication: blocked");

  // Final report: counts, governance transitions, advisory footer, wording.
  const report = await cli(["report", "--state", stateDir]);
  expect(report.code).toBe(0);
  expect(report.text).toContain("== Ingestion health ==");
  expect(report.text).toContain("== Friction signals ==");
  expect(report.text).toContain("== Candidates ==");
  expect(report.text).toContain("claude-code/alpha");
  expect(report.text).toContain("codex/bravo");
  expect(report.text).toContain("Bash: 3 across 2 episode(s)");
  expect(report.text).toContain("correction-signals=3 (across 2 episode(s))");
  expect(report.text).toContain("task signals: aborted=1");
  expect(report.text).toContain("tokensIn=10 tokensOut=5");
  expect(report.text).toContain("review: accepted");
  expect(report.text).toContain("review: blocked");
  expect(report.text).toContain(
    "All evidence above is advisory and transcript-derived: it demonstrates recurrence, not causation.",
  );
  expect(report.text).not.toMatch(/improv/i);
});

test("review usage errors are refused", async () => {
  const both = await cli(["review", "--state", stateDir, "--candidate", "x", "--accept", "--reject"]);
  expect(both.code).toBe(2);
  const missing = await cli(["review", "--state", stateDir, "--candidate", "does-not-exist", "--accept"]);
  expect(missing.code).toBe(1);
  expect(missing.text).toContain('candidate "does-not-exist" does not exist');
});

test("help renders and unknown commands are usage errors", async () => {
  const help = await cli(["--help"]);
  expect(help.code).toBe(0);
  expect(help.text).toContain("usage:");
  const none = await cli([]);
  expect(none.code).toBe(2);
  const unknown = await cli(["frobnicate"]);
  expect(unknown.code).toBe(2);
});
