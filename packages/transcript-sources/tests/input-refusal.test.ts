// Explicit inputs only: the adapter never discovers and never follows links.
// Symlinks, directories, and missing paths are refused with a diagnostic, and
// invalid input or cursors are typed errors.
import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { LearningLoopError } from "@cormidia/learning-loop";
import { afterEach, describe, expect, it } from "vitest";
import { createClaudeCodeTranscriptSource, createCodexTranscriptSource } from "../src/index.js";
import { allPages, inputOf, makeFixtureDir, writeJsonl } from "./support.js";

const SESSION_ID = "dddddddd-eeee-4fff-8000-111122223333";

function validRecords(): readonly unknown[] {
  return [
    {
      type: "user",
      sessionId: SESSION_ID,
      cwd: "/workspaces/sample-project",
      timestamp: "2026-08-04T08:00:00.000Z",
      message: { role: "user", content: "hello" },
    },
  ];
}

describe("input refusal", () => {
  const fixtures: (() => void)[] = [];
  afterEach(() => {
    for (const cleanup of fixtures.splice(0)) cleanup();
  });
  function fixtureDir(): string {
    const fixture = makeFixtureDir();
    fixtures.push(() => fixture.cleanup());
    return fixture.dir;
  }

  it("refuses symlinks even when they point at a valid session file", async () => {
    const dir = fixtureDir();
    const target = writeJsonl(dir, "real.jsonl", validRecords());
    const link = join(dir, "link.jsonl");
    symlinkSync(target, link);

    const source = createClaudeCodeTranscriptSource();
    const pages = await allPages(source, inputOf([link]));
    const page = pages[0];
    if (page === undefined) throw new Error("missing page");
    expect(page.observations).toEqual([]);
    expect(page.episodes).toEqual([]);
    expect(page.sourceRevision).toBe("unavailable");
    expect(page.diagnostics[0]?.code).toBe("source.input_refused");
    expect(page.diagnostics[0]?.message).toContain("symbolic links are refused");

    const probe = await source.probe(inputOf([link]));
    expect(probe.supported).toBe(false);
    expect(probe.diagnostics[0]?.code).toBe("source.input_refused");
  });

  it("refuses directories and missing paths", async () => {
    const dir = fixtureDir();
    const subdir = join(dir, "subdir");
    mkdirSync(subdir);
    const missing = join(dir, "missing.jsonl");

    const pages = await allPages(createCodexTranscriptSource(), inputOf([subdir, missing]));
    expect(pages).toHaveLength(2);
    expect(pages[0]?.diagnostics[0]?.code).toBe("source.input_refused");
    expect(pages[0]?.diagnostics[0]?.message).toContain("not a regular file");
    expect(pages[0]?.nextCursor).toBe("1");
    expect(pages[1]?.diagnostics[0]?.code).toBe("source.input_refused");
    expect(pages[1]?.diagnostics[0]?.message).toContain("does not exist");
  });

  it("refuses malformed input and cursors as typed errors", async () => {
    const source = createClaudeCodeTranscriptSource();
    await expect(source.probe({ kind: "glob", paths: ["*"], locatorKey: "k" } as never)).rejects.toThrow(
      LearningLoopError,
    );
    await expect(allPages(source, { kind: "explicit_files", paths: ["x"], locatorKey: "" })).rejects.toThrow(
      LearningLoopError,
    );
    await expect(allPages(source, inputOf([]), "notanumber")).rejects.toThrow(LearningLoopError);
    await expect(allPages(source, inputOf([]), "1")).rejects.toThrow(LearningLoopError);
  });
});
