// Import idempotency: unchanged file bytes → identical sourceRevision and
// identical projections (stable sourceRecordIds). The cwd locator is KEYED:
// same key → same locator; different key → different locator (dictionary
// recovery of paths requires the caller's secret).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { createClaudeCodeTranscriptSource, createCodexTranscriptSource } from "../src/index.js";
import { allPages, inputOf, makeFixtureDir, ofKind, writeJsonl } from "./support.js";

const SESSION_ID = "ffffffff-0000-4111-8222-333344445555";
const CWD = "/workspaces/sample-project";

function claudeRecords(): readonly unknown[] {
  return [
    {
      type: "user",
      sessionId: SESSION_ID,
      cwd: CWD,
      version: "2.1.900",
      timestamp: "2026-08-06T06:00:00.000Z",
      message: { role: "user", content: "hello there" },
    },
    {
      type: "assistant",
      sessionId: SESSION_ID,
      cwd: CWD,
      timestamp: "2026-08-06T06:00:01.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "hi" }],
        usage: { input_tokens: 5, output_tokens: 2 },
      },
    },
  ];
}

function codexRecords(): readonly unknown[] {
  return [
    {
      timestamp: "2026-08-06T06:10:00.000Z",
      type: "session_meta",
      payload: { id: SESSION_ID, cwd: CWD, cli_version: "0.99.0" },
    },
    {
      timestamp: "2026-08-06T06:10:01.000Z",
      type: "response_item",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hello there" }] },
    },
  ];
}

describe("idempotency and keyed locator", () => {
  const fixtures: (() => void)[] = [];
  afterEach(() => {
    for (const cleanup of fixtures.splice(0)) cleanup();
  });
  function fixtureDir(): string {
    const fixture = makeFixtureDir();
    fixtures.push(() => fixture.cleanup());
    return fixture.dir;
  }

  it("yields byte-identical pages on repeated reads of an unchanged file", async () => {
    const dir = fixtureDir();
    const claudePath = writeJsonl(dir, "claude.jsonl", claudeRecords());
    const codexPath = writeJsonl(dir, "codex.jsonl", codexRecords());

    const firstClaude = await allPages(createClaudeCodeTranscriptSource(), inputOf([claudePath]));
    const secondClaude = await allPages(createClaudeCodeTranscriptSource(), inputOf([claudePath]));
    expect(JSON.stringify(secondClaude)).toBe(JSON.stringify(firstClaude));

    const firstCodex = await allPages(createCodexTranscriptSource(), inputOf([codexPath]));
    const secondCodex = await allPages(createCodexTranscriptSource(), inputOf([codexPath]));
    expect(JSON.stringify(secondCodex)).toBe(JSON.stringify(firstCodex));

    // sourceRevision is exactly the sha256 of the file bytes.
    expect(firstClaude[0]?.sourceRevision).toBe(createHash("sha256").update(readFileSync(claudePath)).digest("hex"));
    expect(firstCodex[0]?.sourceRevision).toBe(createHash("sha256").update(readFileSync(codexPath)).digest("hex"));

    // sourceRecordIds are stable, line-addressed, and unique: same-line
    // projections carry a deterministic occurrence suffix.
    const ids = firstClaude[0]?.observations.map((observation) => observation.sourceRecordId);
    expect(ids).toEqual([
      `claude-code/${SESSION_ID}/1#0`,
      `claude-code/${SESSION_ID}/1#1`,
      `claude-code/${SESSION_ID}/2#0`,
      `claude-code/${SESSION_ID}/2#1`,
    ]);
  });

  it("changes the cwd locator with the locator key and only then", async () => {
    const dir = fixtureDir();
    const path = writeJsonl(dir, "claude.jsonl", claudeRecords());
    const source = createClaudeCodeTranscriptSource();

    const withKeyA = await allPages(source, inputOf([path], "key-a"));
    const withKeyAAgain = await allPages(source, inputOf([path], "key-a"));
    const withKeyB = await allPages(source, inputOf([path], "key-b"));

    const locatorOf = (pages: typeof withKeyA): unknown => {
      const page = pages[0];
      if (page === undefined) throw new Error("missing page");
      const data: unknown = ofKind(page, "transcript.session.meta")[0]?.data;
      if (typeof data !== "object" || data === null) throw new Error("missing meta data");
      return Reflect.get(data, "cwdLocator");
    };

    const locatorA = locatorOf(withKeyA);
    expect(locatorA).toBe(createHash("sha256").update(`key-a:${CWD}`).digest("hex"));
    expect(locatorOf(withKeyAAgain)).toBe(locatorA);
    expect(locatorOf(withKeyB)).toBe(createHash("sha256").update(`key-b:${CWD}`).digest("hex"));
    expect(locatorOf(withKeyB)).not.toBe(locatorA);
    // The raw cwd itself never appears in the projections.
    expect(JSON.stringify(withKeyA)).not.toContain(CWD);
  });
});
