// Format drift refuses typed and ceilings fail closed: corrupt lines and
// breaches yield diagnostics plus partial pages or a refused file — never a
// crash, never silent truncation.
import { afterEach, describe, expect, it } from "vitest";
import { MAX_LINE_BYTES, MAX_RECORDS_PER_FILE, createClaudeCodeTranscriptSource } from "../src/index.js";
import {
  allPages,
  expectedSessionLocator,
  expectedSourceRevision,
  inputOf,
  makeFixtureDir,
  ofKind,
  writeJsonl,
  writeRaw,
} from "./support.js";

const SESSION_ID = "cccccccc-dddd-4eee-8fff-000011112222";
const SESSION_LOCATOR = expectedSessionLocator("claude-code", SESSION_ID);

function userLine(second: number, text: string): string {
  return JSON.stringify({
    type: "user",
    sessionId: SESSION_ID,
    cwd: "/workspaces/sample-project",
    timestamp: `2026-08-03T12:00:${String(second).padStart(2, "0")}.000Z`,
    message: { role: "user", content: text },
  });
}

describe("drift and ceilings", () => {
  const fixtures: (() => void)[] = [];
  afterEach(() => {
    for (const cleanup of fixtures.splice(0)) cleanup();
  });
  function fixtureDir(): string {
    const fixture = makeFixtureDir();
    fixtures.push(() => fixture.cleanup());
    return fixture.dir;
  }

  it("skips a corrupt middle line, keeps line numbering, and marks the page partial", async () => {
    const dir = fixtureDir();
    const path = writeRaw(
      dir,
      "corrupt-middle.jsonl",
      `${userLine(0, "first")}\n{{{not json\n${userLine(2, "third")}\n`,
    );
    const pages = await allPages(createClaudeCodeTranscriptSource(), inputOf([path]));
    const page = pages[0];
    if (page === undefined) throw new Error("missing page");

    const drift = page.diagnostics.filter((diagnostic) => diagnostic.code === "source.unsupported_format");
    expect(drift).toHaveLength(1);
    expect(drift[0]?.severity).toBe("warning");
    expect(drift[0]?.path).toEqual([0, 2]);
    const summary = page.diagnostics.filter((diagnostic) => diagnostic.code === "source.incomplete");
    expect(summary[0]?.details).toMatchObject({ skippedLineCount: 1, parsedRecordCount: 2 });

    // Records after the corrupt line keep their physical line numbers.
    const messages = ofKind(page, "transcript.message");
    expect(messages.map((observation) => observation.sourceRecordId)).toEqual([
      // line 1 anchors the session.meta observation first (#0); the
      // message projected from the same line takes the next occurrence.
      `claude-code/${SESSION_LOCATOR}/1#1`,
      `claude-code/${SESSION_LOCATOR}/3#0`,
    ]);
    for (const observation of page.observations) expect(observation.completeness).toBe("partial");
    expect(page.state).toMatchObject({ status: "available", completeness: "partial" });
    expect(page.episodes).toHaveLength(1);
  });

  it("refuses the whole file when the first line is unparseable", async () => {
    const dir = fixtureDir();
    const path = writeRaw(dir, "first-corrupt.jsonl", `not json at all\n${userLine(0, "never read")}\n`);
    const pages = await allPages(createClaudeCodeTranscriptSource(), inputOf([path]));
    const page = pages[0];
    if (page === undefined) throw new Error("missing page");

    expect(page.observations).toEqual([]);
    expect(page.episodes).toEqual([]);
    expect(page.diagnostics).toHaveLength(1);
    expect(page.diagnostics[0]?.code).toBe("source.unsupported_format");
    expect(page.diagnostics[0]?.severity).toBe("error");
    expect(page.diagnostics[0]?.message).toContain("file refused (completeness unknown)");
    // The refused page retains the observed byte digest without pretending
    // the unsupported source is an available revision.
    expect(page.state).toEqual({
      status: "unsupported",
      observedRevision: expectedSourceRevision(path),
    });

    const probe = await createClaudeCodeTranscriptSource().probe(inputOf([path]));
    expect(probe.supported).toBe(false);
  });

  it("marks a parsed file without timestamps unsupported with its observed revision", async () => {
    const dir = fixtureDir();
    const path = writeJsonl(dir, "missing-timestamps.jsonl", [
      {
        type: "user",
        sessionId: SESSION_ID,
        cwd: "/workspaces/sample-project",
        message: { role: "user", content: "synthetic request without a timestamp" },
      },
    ]);
    const pages = await allPages(createClaudeCodeTranscriptSource(), inputOf([path]));
    const page = pages[0];
    if (page === undefined) throw new Error("missing page");

    expect(page.observations).toEqual([]);
    expect(page.episodes).toEqual([]);
    expect(page.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "source.unsupported_format", severity: "error" })]),
    );
    expect(page.state).toEqual({
      status: "unsupported",
      observedRevision: expectedSourceRevision(path),
    });
  });

  it("marks a refused first-line resource breach corrupt with its observed revision", async () => {
    const dir = fixtureDir();
    const oversized = JSON.stringify({
      type: "user",
      sessionId: SESSION_ID,
      timestamp: "2026-08-03T12:00:01.000Z",
      message: { role: "user", content: "a".repeat(MAX_LINE_BYTES) },
    });
    const path = writeRaw(dir, "oversized-first-line.jsonl", `${oversized}\n`);
    const pages = await allPages(createClaudeCodeTranscriptSource(), inputOf([path]));
    const page = pages[0];
    if (page === undefined) throw new Error("missing page");

    expect(page.observations).toEqual([]);
    expect(page.diagnostics[0]?.code).toBe("source.limit_exceeded");
    expect(page.state).toEqual({
      status: "corrupt",
      observedRevision: expectedSourceRevision(path),
    });
  });

  it("skips an oversized line and marks the page partial", async () => {
    const dir = fixtureDir();
    const oversized = JSON.stringify({
      type: "user",
      sessionId: SESSION_ID,
      timestamp: "2026-08-03T12:00:01.000Z",
      message: { role: "user", content: "a".repeat(MAX_LINE_BYTES) },
    });
    const path = writeRaw(dir, "oversized.jsonl", `${userLine(0, "small")}\n${oversized}\n${userLine(2, "after")}\n`);
    const pages = await allPages(createClaudeCodeTranscriptSource(), inputOf([path]));
    const page = pages[0];
    if (page === undefined) throw new Error("missing page");

    const ceiling = page.diagnostics.filter((diagnostic) => diagnostic.code === "source.limit_exceeded");
    expect(ceiling).toHaveLength(1);
    expect(ceiling[0]?.path).toEqual([0, 2]);
    expect(ofKind(page, "transcript.message")).toHaveLength(2);
    for (const observation of page.observations) expect(observation.completeness).toBe("partial");
    expect(page.state).toMatchObject({ status: "available", completeness: "partial" });
  });

  it("stops at the record ceiling and reports the skipped remainder", async () => {
    const dir = fixtureDir();
    const filler = { type: "attachment", sessionId: SESSION_ID };
    const records: unknown[] = [
      {
        type: "user",
        sessionId: SESSION_ID,
        cwd: "/workspaces/sample-project",
        timestamp: "2026-08-03T12:00:00.000Z",
        message: { role: "user", content: "start" },
      },
    ];
    for (let i = 0; i < MAX_RECORDS_PER_FILE + 1; i += 1) records.push(filler);
    const path = writeJsonl(dir, "too-many-records.jsonl", records);

    const pages = await allPages(createClaudeCodeTranscriptSource(), inputOf([path]));
    const page = pages[0];
    if (page === undefined) throw new Error("missing page");
    const ceiling = page.diagnostics.filter((diagnostic) => diagnostic.code === "source.limit_exceeded");
    expect(ceiling).toHaveLength(1);
    expect(ceiling[0]?.details).toMatchObject({ remainingLines: 2 });
    // The parsed prefix still projects; completeness is partial.
    expect(ofKind(page, "transcript.message")).toHaveLength(1);
    for (const observation of page.observations) expect(observation.completeness).toBe("partial");
    expect(page.state).toMatchObject({ status: "available", completeness: "partial" });
  });

  it("refuses a file with no records", async () => {
    const dir = fixtureDir();
    const path = writeRaw(dir, "empty.jsonl", "\n\n");
    const pages = await allPages(createClaudeCodeTranscriptSource(), inputOf([path]));
    const page = pages[0];
    if (page === undefined) throw new Error("missing page");
    expect(page.observations).toEqual([]);
    expect(page.episodes).toEqual([]);
    expect(page.diagnostics[0]?.code).toBe("source.unsupported_format");
    expect(page.state).toMatchObject({ status: "unsupported" });
  });
});
