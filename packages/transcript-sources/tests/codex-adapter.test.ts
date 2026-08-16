// Codex adapter: emitted kinds, redacted shapes, task signals, structural
// tool outcomes, and probe banding — over synthetic fixtures only.
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { CODEX_ADAPTER_VERSION, createCodexTranscriptSource } from "../src/index.js";
import { TEST_LOCATOR_KEY, allPages, inputOf, makeFixtureDir, ofKind, writeJsonl } from "./support.js";

const SESSION_ID = "01990000-1111-4222-8333-444455556666";
const CWD = "/workspaces/sample-project";

function at(second: number): string {
  return `2026-08-02T09:00:${String(second).padStart(2, "0")}.000Z`;
}

function validSession(): readonly unknown[] {
  return [
    // line 1: session_meta (instructions are content and never projected)
    {
      timestamp: at(0),
      type: "session_meta",
      payload: {
        id: SESSION_ID,
        timestamp: at(0),
        cwd: CWD,
        cli_version: "0.99.0",
        instructions: "synthetic standing instructions",
        model_provider: "synthetic",
        originator: "synthetic_cli",
        source: "cli",
        git: { branch: "main", commit_hash: "0000000" },
      },
    },
    // line 2: turn_context — known, silent
    {
      timestamp: at(1),
      type: "turn_context",
      payload: { cwd: CWD, model: "synthetic-model", approval_policy: "never" },
    },
    // line 3: task lifecycle signal
    { timestamp: at(2), type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } },
    // line 4: human message
    {
      timestamp: at(3),
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Please fix the failing test" }],
      },
    },
    // line 5: developer message — instructions, never projected
    {
      timestamp: at(4),
      type: "response_item",
      payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "synthetic policy text" }] },
    },
    // line 6: reasoning — known, silent
    { timestamp: at(5), type: "response_item", payload: { type: "reasoning", summary: [] } },
    // line 7+8: function_call with a plain-string output → outcome unknown
    {
      timestamp: at(6),
      type: "response_item",
      payload: { type: "function_call", name: "shell", call_id: "call-1", arguments: '{"command":["true"]}' },
    },
    {
      timestamp: at(7),
      type: "response_item",
      payload: { type: "function_call_output", call_id: "call-1", output: "opaque text" },
    },
    // line 9+10: custom tool with structured output → exit_code 0 → success
    {
      timestamp: at(8),
      type: "response_item",
      payload: { type: "custom_tool_call", name: "apply_patch", call_id: "call-2", input: "x" },
    },
    {
      timestamp: at(9),
      type: "response_item",
      payload: {
        type: "custom_tool_call_output",
        call_id: "call-2",
        output: { content: "done", metadata: { exit_code: 0 } },
      },
    },
    // line 11+12: function_call with exit_code 2 → failure
    {
      timestamp: at(10),
      type: "response_item",
      payload: { type: "function_call", name: "shell", call_id: "call-3", arguments: "{}" },
    },
    {
      timestamp: at(11),
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "call-3",
        output: { content: "err", metadata: { exit_code: 2 } },
      },
    },
    // line 13: agent message
    {
      timestamp: at(12),
      type: "response_item",
      payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Fixed." }] },
    },
    // line 14: token_count usage
    {
      timestamp: at(13),
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: { input_tokens: 900, cached_input_tokens: 100, output_tokens: 80, total_tokens: 1080 },
          model_context_window: 200000,
        },
        rate_limits: {},
      },
    },
    // line 15: agent_message event — silent duplicate of line 13
    { timestamp: at(14), type: "event_msg", payload: { type: "agent_message", message: "Fixed." } },
    // lines 16-18: remaining task signals
    { timestamp: at(15), type: "event_msg", payload: { type: "task_complete", turn_id: "turn-1" } },
    { timestamp: at(16), type: "event_msg", payload: { type: "turn_aborted", reason: "synthetic" } },
    { timestamp: at(17), type: "event_msg", payload: { type: "thread_rolled_back" } },
    // line 19: unknown response_item payload type
    { timestamp: at(18), type: "response_item", payload: { type: "ghost_snapshot", ref: "x" } },
    // line 20: unknown top-level type
    { timestamp: at(19), type: "compacted", payload: {} },
  ];
}

describe("codex transcript source", () => {
  const fixtures: (() => void)[] = [];
  afterEach(() => {
    for (const cleanup of fixtures.splice(0)) cleanup();
  });
  function fixtureDir(): string {
    const fixture = makeFixtureDir();
    fixtures.push(() => fixture.cleanup());
    return fixture.dir;
  }

  it("projects one page per rollout file with minimized observations", async () => {
    const dir = fixtureDir();
    const path = writeJsonl(dir, "rollout.jsonl", validSession());
    const source = createCodexTranscriptSource();
    const pages = await allPages(source, inputOf([path]));

    expect(pages).toHaveLength(1);
    const page = pages[0];
    if (page === undefined) throw new Error("missing page");
    expect(page.sourceRevision).toMatch(/^[0-9a-f]{64}$/);
    expect(page.measurements).toEqual([]);
    expect(page.diagnostics).toEqual([]);

    const episode = page.episodes[0];
    if (episode === undefined) throw new Error("missing episode");
    expect(episode.episodeId).toBe(`codex/${SESSION_ID}`);
    expect(episode.scope).toEqual([
      { type: "provider", id: "codex" },
      { type: "project", id: "sample-project" },
    ]);
    expect(episode.openedAt).toBe(at(0));
    expect(episode.closedAt).toBe(at(19));
    expect(episode.status).toBe("unknown");

    const meta = ofKind(page, "transcript.session.meta");
    expect(meta).toHaveLength(1);
    expect(meta[0]?.data).toEqual({
      provider: "codex",
      adapterVersion: CODEX_ADAPTER_VERSION,
      providerVersionBand: "0.99.0",
      projectSlug: "sample-project",
      cwdLocator: createHash("sha256").update(`${TEST_LOCATOR_KEY}:${CWD}`).digest("hex"),
      gitBranch: "main",
    });

    // Messages come from response_item records only; event duplicates and
    // developer prompts are silent.
    expect(ofKind(page, "transcript.message").map((observation) => observation.data)).toEqual([
      { actor: "human", charCount: "Please fix the failing test".length },
      { actor: "agent", charCount: "Fixed.".length },
    ]);

    // Tool outcomes are structural only: a string output stays unknown.
    expect(ofKind(page, "transcript.tool.completed").map((observation) => observation.data)).toEqual([
      { toolName: "shell", outcome: "unknown" },
      { toolName: "apply_patch", outcome: "success" },
      { toolName: "shell", outcome: "failure" },
    ]);

    expect(ofKind(page, "transcript.usage").map((observation) => observation.data)).toEqual([
      { tokensIn: 900, tokensOut: 80, quality: "reported" },
    ]);

    // Task lifecycle events are advisory signals, never an episode status.
    expect(ofKind(page, "transcript.task.signal").map((observation) => observation.data)).toEqual([
      { signal: "started" },
      { signal: "complete" },
      { signal: "aborted" },
      { signal: "rolled_back" },
    ]);

    expect(ofKind(page, "transcript.unknown").map((observation) => observation.data)).toEqual([
      { nativeType: "response_item/ghost_snapshot" },
      { nativeType: "compacted" },
    ]);

    for (const observation of page.observations) {
      expect(observation.episodeId).toBe(`codex/${SESSION_ID}`);
      expect(observation.sourceRecordId).toMatch(new RegExp(`^codex/${SESSION_ID}/\\d+#\\d+$`));
      expect(observation.completeness).toBe("complete");
    }
  });

  it("detects human correction signals transiently", async () => {
    const dir = fixtureDir();
    const path = writeJsonl(dir, "rollout.jsonl", [
      { timestamp: at(0), type: "session_meta", payload: { id: SESSION_ID, cwd: CWD, cli_version: "0.99.0" } },
      {
        timestamp: at(1),
        type: "response_item",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: "No, revert that change" }] },
      },
    ]);
    const pages = await allPages(createCodexTranscriptSource(), inputOf([path]));
    const page = pages[0];
    if (page === undefined) throw new Error("missing page");
    expect(ofKind(page, "transcript.message").map((observation) => observation.data)).toEqual([
      { actor: "human", charCount: "No, revert that change".length, correctionSignal: true },
    ]);
  });

  it("probes cheaply and refuses records without a payload", async () => {
    const dir = fixtureDir();
    const codexPath = writeJsonl(dir, "rollout.jsonl", validSession());
    const claudeShaped = writeJsonl(dir, "claude.jsonl", [
      { type: "user", sessionId: SESSION_ID, timestamp: at(0), message: { role: "user", content: "hello" } },
    ]);
    const source = createCodexTranscriptSource();

    const supported = await source.probe(inputOf([codexPath]));
    expect(supported.supported).toBe(true);
    expect(supported.diagnostics).toEqual([]);

    const foreign = await source.probe(inputOf([claudeShaped]));
    expect(foreign.supported).toBe(false);
    expect(foreign.diagnostics[0]?.code).toBe("source.unsupported_format");
  });
});
