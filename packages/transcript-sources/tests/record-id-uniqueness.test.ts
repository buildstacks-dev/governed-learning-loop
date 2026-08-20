// Detector for the same-line sourceRecordId collision: one source line can
// yield several projections (assistant message + usage; session meta vs the
// first record; a user record carrying several tool_result blocks). Ids must
// be unique within a page and stable across re-reads, or the engine drops
// every later same-line observation as a store conflict.
import { afterEach, expect, test } from "vitest";
import { createClaudeCodeTranscriptSource, createCodexTranscriptSource } from "../src/index.js";
import { allPages, inputOf, makeFixtureDir, ofKind, writeJsonl } from "./support.js";

const SESSION_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

function claudeSessionWithSameLineProjections(): readonly unknown[] {
  const base = {
    sessionId: SESSION_ID,
    cwd: "/workspaces/sample-project",
    version: "2.1.900",
    isSidechain: false,
    parentUuid: null,
  };
  return [
    // line 1: also the anchor line for the session.meta observation.
    {
      ...base,
      uuid: "u-1",
      type: "user",
      timestamp: "2026-08-01T10:00:00.000Z",
      message: { role: "user", content: "please add a retry helper" },
    },
    // line 2: assistant record projecting BOTH a message and a usage
    // observation from the same line.
    {
      ...base,
      uuid: "u-2",
      type: "assistant",
      timestamp: "2026-08-01T10:01:00.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        usage: { input_tokens: 12, output_tokens: 3 },
      },
    },
    // line 3: user record carrying TWO tool_result blocks on one line.
    {
      ...base,
      uuid: "u-3",
      type: "user",
      timestamp: "2026-08-01T10:02:00.000Z",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tu-1", is_error: false },
          { type: "tool_result", tool_use_id: "tu-2", is_error: true },
        ],
      },
    },
  ];
}

test("claude-code same-line projections get unique, stable sourceRecordIds", async () => {
  const fixture = makeFixtureDir();
  cleanup = fixture.cleanup;
  const path = writeJsonl(fixture.dir, `${SESSION_ID}.jsonl`, claudeSessionWithSameLineProjections());
  const source = createClaudeCodeTranscriptSource();

  const pages = await allPages(source, inputOf([path]));
  const observations = pages.flatMap((page) => page.observations);
  const ids = observations.map((observation) => observation.sourceRecordId);

  expect(new Set(ids).size).toBe(ids.length);
  expect(JSON.stringify(pages)).not.toContain(SESSION_ID);
  expect(JSON.stringify(pages)).not.toContain(path);
  // The collision previously swallowed usage observations entirely.
  expect(pages.some((page) => ofKind(page, "transcript.usage").length > 0)).toBe(true);

  const again = await allPages(source, inputOf([path]));
  expect(again.flatMap((page) => page.observations.map((observation) => observation.sourceRecordId))).toEqual(ids);
});

test("codex projections keep unique sourceRecordIds", async () => {
  const fixture = makeFixtureDir();
  cleanup = fixture.cleanup;
  const path = writeJsonl(fixture.dir, "rollout-2026-08-01T10-00-00-abc.jsonl", [
    {
      timestamp: "2026-08-01T10:00:00.000Z",
      type: "session_meta",
      payload: {
        id: "codex-session-1",
        timestamp: "2026-08-01T10:00:00.000Z",
        cwd: "/workspaces/sample-project",
        cli_version: "0.9.0",
        model_provider: "provider",
        originator: "cli",
        source: "cli",
        instructions: "irrelevant",
      },
    },
    {
      timestamp: "2026-08-01T10:01:00.000Z",
      type: "event_msg",
      payload: { type: "task_started" },
    },
    {
      timestamp: "2026-08-01T10:02:00.000Z",
      type: "event_msg",
      payload: { type: "token_count", info: { last_token_usage: { input_tokens: 5, output_tokens: 2 } } },
    },
  ]);
  const source = createCodexTranscriptSource();

  const pages = await allPages(source, inputOf([path]));
  const ids = pages.flatMap((page) => page.observations.map((observation) => observation.sourceRecordId));
  expect(new Set(ids).size).toBe(ids.length);
  expect(JSON.stringify(pages)).not.toContain("codex-session-1");
  expect(JSON.stringify(pages)).not.toContain(path);
});
