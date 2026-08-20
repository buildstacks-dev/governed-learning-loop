// Claude Code adapter: emitted kinds, redacted shapes, episode boundaries,
// cursor resumability, and probe banding — over synthetic fixtures only.
import { afterEach, describe, expect, it } from "vitest";
import { CLAUDE_CODE_ADAPTER_VERSION, createClaudeCodeTranscriptSource } from "../src/index.js";
import {
  allPages,
  expectedBranchLocator,
  expectedCwdLocator,
  expectedSessionLocator,
  expectedSourceRef,
  expectedSourceRevision,
  inputOf,
  kindsOf,
  makeFixtureDir,
  ofKind,
  writeJsonl,
} from "./support.js";

const SESSION_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const CWD = "/workspaces/sample-project";

function baseRecord(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    sessionId: SESSION_ID,
    cwd: CWD,
    gitBranch: "feature/sample",
    version: "2.1.900",
    isSidechain: false,
    uuid: "u-1",
    parentUuid: null,
    ...overrides,
  };
}

function validSession(): readonly unknown[] {
  return [
    // line 1: plain human request (no correction words planted)
    baseRecord({
      type: "user",
      timestamp: "2026-08-01T10:00:00.000Z",
      message: { role: "user", content: "Please add a retry helper" },
    }),
    // line 2: agent text + thinking + tool_use, with reported usage
    baseRecord({
      type: "assistant",
      timestamp: "2026-08-01T10:00:05.000Z",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "synthetic reasoning" },
          { type: "text", text: "Adding the helper." },
          { type: "tool_use", id: "toolu-1", name: "Edit", input: { file_path: "client.ts" } },
        ],
        usage: { input_tokens: 1200, output_tokens: 250 },
      },
    }),
    // line 3: successful tool result (is_error false)
    baseRecord({
      type: "user",
      timestamp: "2026-08-01T10:00:09.000Z",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu-1", content: "ok", is_error: false }],
      },
      toolUseResult: { stdout: "ok" },
    }),
    // line 4: agent tool-only turn
    baseRecord({
      type: "assistant",
      timestamp: "2026-08-01T10:00:12.000Z",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu-2", name: "Bash", input: { command: "pnpm test" } }],
        usage: { input_tokens: 300, output_tokens: 40 },
      },
    }),
    // line 5: failing tool result (is_error true)
    baseRecord({
      type: "user",
      timestamp: "2026-08-01T10:00:20.000Z",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu-2", content: "boom", is_error: true }],
      },
    }),
    // line 6: human correction + tool_result with no is_error and unknown tool id
    baseRecord({
      type: "user",
      timestamp: "2026-08-01T10:00:30.000Z",
      message: {
        role: "user",
        content: [
          { type: "text", text: "That is the wrong file - please fix the helper" },
          { type: "tool_result", tool_use_id: "toolu-9", content: "late" },
        ],
      },
    }),
    // line 7: known content-bearing type, deliberately silent
    { type: "ai-title", sessionId: SESSION_ID, aiTitle: "synthetic title" },
    // line 8: known queue noise, deliberately silent
    baseRecord({ type: "queue-operation", timestamp: "2026-08-01T10:00:31.000Z", operation: "enqueue" }),
    // line 9: unknown record type stays visible without its payload
    baseRecord({ type: "wibble-op", timestamp: "2026-08-01T10:00:32.000Z", payloadText: "not projected" }),
  ];
}

describe("claude-code transcript source", () => {
  const fixtures: (() => void)[] = [];
  afterEach(() => {
    for (const cleanup of fixtures.splice(0)) cleanup();
  });
  function fixtureDir(): string {
    const fixture = makeFixtureDir();
    fixtures.push(() => fixture.cleanup());
    return fixture.dir;
  }

  it("projects one page per session file with minimized observations", async () => {
    const dir = fixtureDir();
    const path = writeJsonl(dir, "session.jsonl", validSession());
    const source = createClaudeCodeTranscriptSource();
    const pages = await allPages(source, inputOf([path]));

    expect(pages).toHaveLength(1);
    const page = pages[0];
    if (page === undefined) throw new Error("missing page");
    const sessionLocator = expectedSessionLocator("claude-code", SESSION_ID);
    const cwdLocator = expectedCwdLocator(CWD);
    expect(page.sourceRef).toBe(expectedSourceRef(path));
    expect(page.pageRef).toBe("session");
    expect(page.state).toEqual({
      status: "available",
      sourceRevision: expectedSourceRevision(path),
      completeness: "complete",
    });
    expect(page.nextCursor).toBeUndefined();
    expect(page.measurements).toEqual([]);
    expect(page.diagnostics).toEqual([]);

    // Episode: status is ALWAYS "unknown"; boundaries from first/last timestamps.
    expect(page.episodes).toHaveLength(1);
    const episode = page.episodes[0];
    if (episode === undefined) throw new Error("missing episode");
    expect(episode.episodeId).toBe(`claude-code/${sessionLocator}`);
    expect(episode.sourceRecordId).toBe(`claude-code/${sessionLocator}/0#0`);
    expect(episode.scope).toEqual([
      { type: "provider", id: "claude-code" },
      { type: "project", id: cwdLocator },
    ]);
    expect(episode.openedAt).toBe("2026-08-01T10:00:00.000Z");
    expect(episode.closedAt).toBe("2026-08-01T10:00:32.000Z");
    expect(episode.status).toBe("unknown");
    expect(episode.measurementSourceRecordIds).toEqual([]);

    // Session meta: keyed locator, cwd basename only, provider version band.
    const meta = ofKind(page, "transcript.session.meta");
    expect(meta).toHaveLength(1);
    expect(meta[0]?.sourceRecordId).toBe(`claude-code/${sessionLocator}/1#0`);
    expect(meta[0]?.data).toEqual({
      provider: "claude-code",
      adapterVersion: CLAUDE_CODE_ADAPTER_VERSION,
      providerVersionBand: "2.1.900",
      cwdLocator,
      branchLocator: expectedBranchLocator("feature/sample"),
    });

    // Messages: char counts and flags only, never text.
    const messages = ofKind(page, "transcript.message");
    expect(messages.map((observation) => observation.data)).toEqual([
      { actor: "human", charCount: "Please add a retry helper".length },
      { actor: "agent", charCount: "Adding the helper.".length, hasToolBlocks: true },
      { actor: "agent", charCount: 0, hasToolBlocks: true },
      {
        actor: "human",
        charCount: "That is the wrong file - please fix the helper".length,
        hasToolBlocks: true,
        correctionSignal: true,
      },
    ]);

    // Tool completions: names correlated via tool_use ids; outcome structural.
    expect(ofKind(page, "transcript.tool.completed").map((observation) => observation.data)).toEqual([
      { toolName: "Edit", outcome: "success" },
      { toolName: "Bash", outcome: "failure" },
      { toolName: "unknown", outcome: "unknown" },
    ]);

    // Usage: reported provider numbers only.
    expect(ofKind(page, "transcript.usage").map((observation) => observation.data)).toEqual([
      { tokensIn: 1200, tokensOut: 250, quality: "reported" },
      { tokensIn: 300, tokensOut: 40, quality: "reported" },
    ]);

    // Unknown types stay visible without their payload.
    expect(ofKind(page, "transcript.unknown").map((observation) => observation.data)).toEqual([
      { nativeType: "wibble-op" },
    ]);

    // Source and episode ids carry only the tenant-keyed session locator.
    for (const observation of page.observations) {
      expect(observation.episodeId).toBe(`claude-code/${sessionLocator}`);
      expect(observation.sourceRecordId).toMatch(new RegExp(`^claude-code/${sessionLocator}/\\d+#\\d+$`));
      expect(observation.completeness).toBe("complete");
    }
    expect(JSON.stringify(page)).not.toContain(SESSION_ID);
    expect(JSON.stringify(page)).not.toContain(path);
    expect(JSON.stringify(page)).not.toContain(CWD);
    expect(JSON.stringify(page)).not.toContain("sample-project");
    expect(JSON.stringify(page)).not.toContain("feature/sample");
    expect(kindsOf(page)).toHaveLength(1 + 4 + 3 + 2 + 1);
  });

  it("pages one file at a time with an index cursor", async () => {
    const dir = fixtureDir();
    const first = writeJsonl(dir, "one.jsonl", validSession());
    const second = writeJsonl(dir, "two.jsonl", [
      baseRecord({
        type: "user",
        sessionId: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff",
        timestamp: "2026-08-02T09:00:00.000Z",
        message: { role: "user", content: "Second synthetic session" },
      }),
    ]);
    const source = createClaudeCodeTranscriptSource();
    const input = inputOf([first, second]);

    const pages = await allPages(source, input);
    expect(pages).toHaveLength(2);
    expect(pages[0]?.nextCursor).toBe("1");
    expect(pages[1]?.nextCursor).toBeUndefined();

    const resumed = await allPages(source, input, "1");
    expect(resumed).toHaveLength(1);
    expect(JSON.stringify(resumed[0])).toBe(JSON.stringify(pages[1]));

    const finished = await allPages(source, input, "2");
    expect(finished).toHaveLength(0);
  });

  it("uses a source-scoped unresolved project locator when cwd is absent", async () => {
    const dir = fixtureDir();
    const path = writeJsonl(dir, "no-cwd.jsonl", [
      {
        type: "user",
        sessionId: SESSION_ID,
        version: "2.1.900",
        timestamp: "2026-08-02T10:00:00.000Z",
        message: { role: "user", content: "Synthetic request without cwd metadata" },
      },
    ]);
    const pages = await allPages(createClaudeCodeTranscriptSource(), inputOf([path]));
    const page = pages[0];
    if (page === undefined) throw new Error("missing page");
    const unresolved = `unresolved-${expectedSourceRef(path)}`;

    expect(page.episodes[0]?.scope).toEqual([
      { type: "provider", id: "claude-code" },
      { type: "project", id: unresolved },
    ]);
    expect(ofKind(page, "transcript.session.meta")[0]?.data).toMatchObject({ cwdLocator: unresolved });
    expect(JSON.stringify(page)).not.toContain(SESSION_ID);
    expect(JSON.stringify(page)).not.toContain(path);
  });

  it("probes cheaply and refuses foreign bands", async () => {
    const dir = fixtureDir();
    const claudePath = writeJsonl(dir, "claude.jsonl", validSession());
    const codexShaped = writeJsonl(dir, "codex.jsonl", [
      { timestamp: "2026-08-01T10:00:00.000Z", type: "session_meta", payload: { id: "x", cwd: "/workspaces/p" } },
    ]);
    const source = createClaudeCodeTranscriptSource();

    const supported = await source.probe(inputOf([claudePath]));
    expect(supported.supported).toBe(true);
    expect(supported.diagnostics).toEqual([]);

    const foreign = await source.probe(inputOf([codexShaped]));
    expect(foreign.supported).toBe(false);
    expect(foreign.diagnostics[0]?.code).toBe("source.unsupported_format");
  });
});
