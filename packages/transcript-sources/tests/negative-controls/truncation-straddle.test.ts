// Negative control: secrets/PII straddling every truncation or cut boundary
// the adapters have. Provider identifiers are admitted only by structural
// shape (never truncated), over-ceiling lines are skipped whole, and no
// diagnostic ever echoes bytes — so no fragment of a planted secret can
// survive a cut, because there is no cut.
import { afterEach, describe, expect, it } from "vitest";
import { createClaudeCodeTranscriptSource, createCodexTranscriptSource } from "../../src/index.js";
import { allPages, inputOf, makeFixtureDir, ofKind, writeJsonl, writeRaw } from "../support.js";
import { expectNoFragment, tightenedPolicy } from "./support.js";

const CANARY = "CANARY-STRADDLE-ZQXJ-KWVY-TRUNC";
const SESSION_ID = "11111111-2222-4333-8444-555555555555";

function claudeBase(second: number, overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    sessionId: SESSION_ID,
    cwd: "/workspaces/sample",
    uuid: `u-${second}`,
    timestamp: `2026-08-07T09:00:${String(second).padStart(2, "0")}.000Z`,
    ...overrides,
  };
}

describe("negative control: secrets straddling truncation boundaries", () => {
  const fixtures: (() => void)[] = [];
  afterEach(() => {
    for (const cleanup of fixtures.splice(0)) cleanup();
  });
  function fixtureDir(): string {
    const fixture = makeFixtureDir();
    fixtures.push(() => fixture.cleanup());
    return fixture.dir;
  }

  it("admits provider identifiers by structural shape only, never by truncation", async () => {
    const dir = fixtureDir();
    // Each planted value places the canary across the 64-character mark a
    // naive truncation would cut at, and inside otherwise plausible shapes.
    const typeStraddle = `${"a".repeat(60)}${CANARY}-tail`;
    const toolStraddle = `${"Bash".padEnd(58, "x")}${CANARY}`;
    const lowercaseSecretType = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const keyShapedTool = "sk-live-abcdefghijklmnopqrstuvwxyz0123";
    const path = writeJsonl(dir, "straddle.jsonl", [
      claudeBase(0, {
        type: "user",
        version: `2.1.900-${CANARY}`,
        message: { role: "user", content: "please look at the helper" },
      }),
      claudeBase(1, {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", id: "t-1", name: toolStraddle, input: {} },
            { type: "tool_use", id: "t-2", name: keyShapedTool, input: {} },
            { type: "tool_use", id: "t-3", name: "Bash", input: {} },
          ],
        },
      }),
      claudeBase(2, {
        type: "user",
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "t-1", is_error: false },
            { type: "tool_result", tool_use_id: "t-2", is_error: true },
            { type: "tool_result", tool_use_id: "t-3", is_error: false },
          ],
        },
      }),
      claudeBase(3, { type: typeStraddle, payload: CANARY }),
      claudeBase(4, { type: lowercaseSecretType }),
      claudeBase(5, { type: CANARY.toLowerCase() }),
      claudeBase(6, { type: "queue-operation" }),
      claudeBase(7, { type: "wibble-op" }),
    ]);
    const pages = await allPages(createClaudeCodeTranscriptSource(), inputOf([path]));
    const page = pages[0];
    if (page === undefined) throw new Error("missing page");

    expect(ofKind(page, "transcript.session.meta")[0]?.data).toMatchObject({ providerVersionBand: "2.1.900" });
    expect(ofKind(page, "transcript.tool.completed").map((observation) => observation.data)).toEqual([
      { toolName: "non_conforming", outcome: "success" },
      { toolName: "non_conforming", outcome: "failure" },
      { toolName: "Bash", outcome: "success" },
    ]);
    // The boundary is a SHAPE filter, not a secret detector: a lowercase
    // kebab token is admitted whole (never cut) because it is indistinguishable
    // from a provider type name; every other shape projects as non-conforming.
    expect(ofKind(page, "transcript.unknown").map((observation) => observation.data)).toEqual([
      { nativeType: "non_conforming" },
      { nativeType: "non_conforming" },
      { nativeType: CANARY.toLowerCase() },
      { nativeType: "wibble-op" },
    ]);
    expectNoFragment(JSON.stringify(pages), CANARY);
    expect(JSON.stringify(pages)).not.toContain(lowercaseSecretType);
    expect(JSON.stringify(pages)).not.toContain("sk-live");
  });

  it("projects a version-shaped canary as non-conforming rather than its prefix", async () => {
    const dir = fixtureDir();
    const path = writeJsonl(dir, "version.jsonl", [
      claudeBase(0, { type: "user", version: CANARY, message: { role: "user", content: "hi" } }),
    ]);
    const pages = await allPages(createClaudeCodeTranscriptSource(), inputOf([path]));
    const page = pages[0];
    if (page === undefined) throw new Error("missing page");
    expect(ofKind(page, "transcript.session.meta")[0]?.data).toMatchObject({
      providerVersionBand: "non_conforming",
    });
    expectNoFragment(JSON.stringify(pages), CANARY);
  });

  it("skips whole lines at the line-byte ceiling and never echoes the bytes around the cut", async () => {
    const dir = fixtureDir();
    const policy = tightenedPolicy((content) => {
      content.ceilings.maximumLineBytes = 512;
    });
    // The canary sits exactly across byte 512 of an oversized line.
    const template = JSON.stringify(claudeBase(1, { type: "user", message: { role: "user", content: "" } }));
    const contentOffset = template.indexOf('"content":""') + '"content":"'.length;
    const filler = "f".repeat(512 - 12 - contentOffset);
    const straddlingLine = JSON.stringify(
      claudeBase(1, { type: "user", message: { role: "user", content: `${filler}${CANARY}${"g".repeat(40)}` } }),
    );
    expect(straddlingLine.length).toBeGreaterThan(512);
    expect(straddlingLine.indexOf(CANARY)).toBeLessThan(512);
    expect(straddlingLine.indexOf(CANARY) + CANARY.length).toBeGreaterThan(512);
    const ok = JSON.stringify(claudeBase(0, { type: "user", message: { role: "user", content: "short" } }));
    const path = writeRaw(dir, "line-ceiling.jsonl", `${ok}\n${straddlingLine}\n${ok.replace("u-0", "u-2")}\n`);
    const source = createClaudeCodeTranscriptSource({ privacyPolicy: policy });
    const pages = await allPages(source, inputOf([path]));
    const page = pages[0];
    if (page === undefined) throw new Error("missing page");
    expect(page.state).toMatchObject({ status: "available", completeness: "partial" });
    expect(ofKind(page, "transcript.message")).toHaveLength(2);
    const ceiling = page.diagnostics.filter((diagnostic) => diagnostic.code === "source.limit_exceeded");
    expect(ceiling[0]?.details).toMatchObject({ ceiling: "line_bytes", line: 2 });
    expectNoFragment(JSON.stringify(pages), CANARY);

    // The same oversized line first: the file is refused whole, still silently.
    const refusedPath = writeRaw(dir, "first-line-ceiling.jsonl", `${straddlingLine}\n${ok}\n`);
    const refused = await allPages(source, inputOf([refusedPath]));
    expect(refused[0]?.state).toMatchObject({ status: "corrupt" });
    expect(refused[0]?.observations).toEqual([]);
    const probe = await source.probe(inputOf([refusedPath]));
    expect(probe.supported).toBe(false);
    expectNoFragment(JSON.stringify({ refused, probe }), CANARY);
  });

  it("skips the remainder at the record ceiling without echoing the cut record", async () => {
    const dir = fixtureDir();
    const policy = tightenedPolicy((content) => {
      content.ceilings.maximumRecordsPerFile = 2;
    });
    const path = writeJsonl(dir, "record-ceiling.jsonl", [
      claudeBase(0, { type: "user", message: { role: "user", content: "one" } }),
      claudeBase(1, { type: "user", message: { role: "user", content: "two" } }),
      claudeBase(2, { type: "user", message: { role: "user", content: `three ${CANARY}` } }),
      claudeBase(3, { type: CANARY }),
    ]);
    const pages = await allPages(createClaudeCodeTranscriptSource({ privacyPolicy: policy }), inputOf([path]));
    const page = pages[0];
    if (page === undefined) throw new Error("missing page");
    expect(ofKind(page, "transcript.message")).toHaveLength(2);
    expect(page.state).toMatchObject({ completeness: "partial" });
    expect(page.diagnostics.find((diagnostic) => diagnostic.code === "source.limit_exceeded")?.details).toMatchObject({
      ceiling: "records",
      remainingLines: 2,
    });
    expectNoFragment(JSON.stringify(pages), CANARY);
  });

  it("never echoes a record cut mid-secret by corruption, in either provider", async () => {
    const dir = fixtureDir();
    const cut = `{"type":"user","uuid":"u-9","timestamp":"2026-08-07T09:00:09.000Z","message":{"content":"${CANARY.slice(0, 12)}`;
    const claudePath = writeRaw(
      dir,
      "cut-claude.jsonl",
      `${JSON.stringify(claudeBase(0, { type: "user", message: { role: "user", content: "ok" } }))}\n${cut}\n`,
    );
    const codexPath = writeRaw(
      dir,
      "cut-codex.jsonl",
      `${JSON.stringify({ timestamp: "2026-08-07T09:00:00.000Z", type: "session_meta", payload: { id: SESSION_ID, cwd: "/w" } })}\n{"timestamp":"2026-08-07T09:00:01.000Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"${CANARY}\n`,
    );
    const claude = await allPages(createClaudeCodeTranscriptSource(), inputOf([claudePath]));
    const codex = await allPages(createCodexTranscriptSource(), inputOf([codexPath]));
    expect(claude[0]?.diagnostics.some((diagnostic) => diagnostic.code === "source.unsupported_format")).toBe(true);
    expect(codex[0]?.diagnostics.some((diagnostic) => diagnostic.code === "source.unsupported_format")).toBe(true);
    expectNoFragment(JSON.stringify({ claude, codex }), CANARY);
  });
});
