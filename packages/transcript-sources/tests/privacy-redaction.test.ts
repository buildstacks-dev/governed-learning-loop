// Redaction before persistence: a secret-looking string planted in every
// content position of a synthetic session must appear ZERO times across the
// JSON of everything the adapters emit — observations, episodes, diagnostics,
// and probe results. This also pins that JSON.parse error text (which quotes
// input bytes) never reaches a diagnostic.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createClaudeCodeTranscriptSource, createCodexTranscriptSource } from "../src/index.js";
import {
  allPages,
  expectedCwdLocator,
  expectedSessionLocator,
  expectedSourceRevision,
  inputOf,
  makeFixtureDir,
  ofKind,
  writeRaw,
} from "./support.js";

const SECRET = "SECRET-ZEBRA-4242-CANARY";
const SESSION_ID = "eeeeeeee-ffff-4000-8111-222233334444";
// The secret sits in a parent path segment; no path segment may project.
const CWD = `/tmp/${SECRET}/workspace`;

function claudeFixture(): string {
  const records: readonly unknown[] = [
    {
      type: "user",
      sessionId: SESSION_ID,
      cwd: CWD,
      gitBranch: `${SECRET}-branch`,
      version: "2.1.900",
      timestamp: "2026-08-05T07:00:00.000Z",
      message: { role: "user", content: `my api key is ${SECRET} please use it` },
    },
    {
      type: "assistant",
      sessionId: SESSION_ID,
      cwd: CWD,
      timestamp: "2026-08-05T07:00:01.000Z",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: `thinking about ${SECRET}` },
          { type: "text", text: `using ${SECRET} now` },
          { type: "tool_use", id: "toolu-1", name: "Bash", input: { command: `echo ${SECRET}` } },
        ],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    },
    {
      type: "user",
      sessionId: SESSION_ID,
      timestamp: "2026-08-05T07:00:02.000Z",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu-1", content: SECRET, is_error: false }],
      },
      toolUseResult: { stdout: SECRET },
    },
    { type: "last-prompt", sessionId: SESSION_ID, lastPrompt: SECRET, leafUuid: "u-9" },
    { type: "attachment", sessionId: SESSION_ID, timestamp: "2026-08-05T07:00:03.000Z", attachment: { text: SECRET } },
    { type: "mystery-op", sessionId: SESSION_ID, timestamp: "2026-08-05T07:00:04.000Z", payloadText: SECRET },
  ];
  // A corrupt line CONTAINING the secret: the parse-error diagnostic must not
  // echo it (V8's JSON error message would).
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n{corrupt ${SECRET}\n`;
}

function codexFixture(): string {
  const records: readonly unknown[] = [
    {
      timestamp: "2026-08-05T07:10:00.000Z",
      type: "session_meta",
      payload: {
        id: SESSION_ID,
        cwd: CWD,
        cli_version: "0.99.0",
        instructions: `always use ${SECRET}`,
        git: { branch: `${SECRET}-branch` },
      },
    },
    {
      timestamp: "2026-08-05T07:10:01.000Z",
      type: "response_item",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: `token: ${SECRET}` }] },
    },
    {
      timestamp: "2026-08-05T07:10:02.000Z",
      type: "response_item",
      payload: {
        type: "function_call",
        name: "shell",
        call_id: "call-1",
        arguments: `{"command":["echo","${SECRET}"]}`,
      },
    },
    {
      timestamp: "2026-08-05T07:10:03.000Z",
      type: "response_item",
      payload: { type: "function_call_output", call_id: "call-1", output: SECRET },
    },
    {
      timestamp: "2026-08-05T07:10:04.000Z",
      type: "response_item",
      payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: `done with ${SECRET}` }] },
    },
    { timestamp: "2026-08-05T07:10:05.000Z", type: "event_msg", payload: { type: "agent_message", message: SECRET } },
    { timestamp: "2026-08-05T07:10:06.000Z", type: "event_msg", payload: { type: "novel_event", detail: SECRET } },
  ];
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n{corrupt ${SECRET}\n`;
}

describe("privacy redaction", () => {
  const fixtures: (() => void)[] = [];
  afterEach(() => {
    for (const cleanup of fixtures.splice(0)) cleanup();
  });
  function fixtureDir(): string {
    const fixture = makeFixtureDir();
    fixtures.push(() => fixture.cleanup());
    return fixture.dir;
  }

  it("emits zero occurrences of planted secrets across all projections and diagnostics", async () => {
    const dir = fixtureDir();
    const privateSourceDir = join(dir, SECRET);
    mkdirSync(privateSourceDir);
    const claudePath = writeRaw(privateSourceDir, "claude.jsonl", claudeFixture());
    const codexPath = writeRaw(privateSourceDir, "codex.jsonl", codexFixture());

    const claude = createClaudeCodeTranscriptSource();
    const codex = createCodexTranscriptSource();
    const claudePages = await allPages(claude, inputOf([claudePath]));
    const codexPages = await allPages(codex, inputOf([codexPath]));
    const probes = [await claude.probe(inputOf([claudePath])), await codex.probe(inputOf([codexPath]))];

    // The projections are non-trivial (the test is not vacuously green)...
    const claudePage = claudePages[0];
    const codexPage = codexPages[0];
    if (claudePage === undefined || codexPage === undefined) throw new Error("missing pages");
    expect(claudePage.observations.length).toBeGreaterThan(3);
    expect(codexPage.observations.length).toBeGreaterThan(3);
    expect(claudePage.diagnostics.length).toBeGreaterThan(0);
    expect(codexPage.diagnostics.length).toBeGreaterThan(0);
    expect(ofKind(claudePage, "transcript.message").length).toBeGreaterThan(0);
    expect(ofKind(codexPage, "transcript.unknown").map((observation) => observation.data)).toEqual([
      { nativeType: "event_msg/novel_event" },
    ]);
    // ...private source/session/revision/cwd/branch identities project only
    // through domain-separated tenant-keyed locators...
    expect(ofKind(claudePage, "transcript.session.meta")[0]?.data).toMatchObject({
      cwdLocator: expectedCwdLocator(CWD),
    });
    expect(ofKind(codexPage, "transcript.session.meta")[0]?.data).toMatchObject({
      cwdLocator: expectedCwdLocator(CWD),
    });
    expect(claudePage.episodes[0]?.episodeId).toBe(`claude-code/${expectedSessionLocator("claude-code", SESSION_ID)}`);
    expect(codexPage.episodes[0]?.episodeId).toBe(`codex/${expectedSessionLocator("codex", SESSION_ID)}`);
    expect(claudePage.state).toMatchObject({ sourceRevision: expectedSourceRevision(claudePath) });
    expect(codexPage.state).toMatchObject({ sourceRevision: expectedSourceRevision(codexPath) });

    // ...and the secret never appears anywhere in anything emitted.
    const everythingEmitted = JSON.stringify({ claudePages, codexPages, probes });
    expect(everythingEmitted).not.toContain(SECRET);
    expect(everythingEmitted).not.toContain(SESSION_ID);
    expect(everythingEmitted).not.toContain("projectSlug");
    expect(everythingEmitted).not.toContain("gitBranch");
    expect(everythingEmitted).not.toContain("workspace");
    // Full filesystem paths and portable raw byte digests never appear either.
    expect(everythingEmitted).not.toContain(CWD);
    expect(everythingEmitted).not.toContain(claudePath);
    expect(everythingEmitted).not.toContain(codexPath);
    expect(everythingEmitted).not.toContain("claude.jsonl");
    expect(everythingEmitted).not.toContain("codex.jsonl");
    expect(everythingEmitted).not.toContain(createHash("sha256").update(readFileSync(claudePath)).digest("hex"));
    expect(everythingEmitted).not.toContain(createHash("sha256").update(readFileSync(codexPath)).digest("hex"));
  });
});
