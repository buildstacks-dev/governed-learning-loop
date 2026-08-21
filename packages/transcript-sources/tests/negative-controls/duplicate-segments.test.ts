// Negative control: duplicated transcript segments never become independent
// recurrence. A repeated explicit path is refused typed; a byte-identical copy
// under another path creates no net-new derivative and the same episode; a
// re-logged segment inside one file collapses to one projection; Codex's
// event duplicates of response items stay silent.
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createClaudeCodeTranscriptSource, createCodexTranscriptSource } from "../../src/index.js";
import { allPages, inputOf, makeFixtureDir, ofKind, writeJsonl } from "../support.js";
import { collect, kernelHarness } from "./support.js";

const SESSION_ID = "dddd4444-eeee-4fff-8000-111155556666";

function claudeSegment(): readonly unknown[] {
  const base = (second: number) => ({
    sessionId: SESSION_ID,
    uuid: `u-${second}`,
    cwd: "/workspaces/sample",
    timestamp: `2026-08-11T06:00:${String(second).padStart(2, "0")}.000Z`,
  });
  return [
    { ...base(0), type: "user", message: { role: "user", content: "please fix the build" } },
    {
      ...base(1),
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "t-1", name: "Bash", input: {} }],
        usage: { input_tokens: 5, output_tokens: 2 },
      },
    },
    {
      ...base(2),
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t-1", is_error: true }] },
    },
    { ...base(3), type: "user", message: { role: "user", content: "no, that is wrong, revert" } },
  ];
}

describe("negative control: duplicated segments are not independent recurrence", () => {
  const fixtures: (() => void)[] = [];
  afterEach(() => {
    for (const cleanup of fixtures.splice(0)) cleanup();
  });
  function fixtureDir(): string {
    const fixture = makeFixtureDir();
    fixtures.push(() => fixture.cleanup());
    return fixture.dir;
  }

  it("collapses a re-logged segment inside one file to a single projection set", async () => {
    const dir = fixtureDir();
    const once = writeJsonl(dir, "once.jsonl", claudeSegment());
    const twice = writeJsonl(dir, "twice.jsonl", [...claudeSegment(), ...claudeSegment(), ...claudeSegment()]);
    const source = createClaudeCodeTranscriptSource();
    const [oncePage] = await allPages(source, inputOf([once]));
    const [twicePage] = await allPages(source, inputOf([twice]));
    if (oncePage === undefined || twicePage === undefined) throw new Error("missing page");

    expect(twicePage.observations.map((observation) => observation.kind)).toEqual(
      oncePage.observations.map((observation) => observation.kind),
    );
    // Two human texts plus one agent tool-only turn: exactly one segment's worth.
    expect(ofKind(twicePage, "transcript.message")).toHaveLength(3);
    expect(ofKind(twicePage, "transcript.tool.completed")).toHaveLength(1);
    expect(twicePage.episodes).toHaveLength(1);
    expect(twicePage.episodes[0]?.closedAt).toBe(oncePage.episodes[0]?.closedAt);
    // Collapsing is visible and is not incompleteness.
    expect(twicePage.state).toMatchObject({ status: "available", completeness: "complete" });
    expect(twicePage.diagnostics).toEqual([
      expect.objectContaining({
        code: "source.duplicate_segment",
        severity: "info",
        details: { fileIndex: 0, duplicateRecordCount: 8 },
      }),
    ]);
    expect(oncePage.diagnostics).toEqual([]);
  });

  it("refuses the same explicit path twice and folds a byte-identical copy into the same episode", async () => {
    const dir = fixtureDir();
    const original = writeJsonl(dir, "original.jsonl", claudeSegment());
    const copy = writeJsonl(dir, "copy.jsonl", claudeSegment());
    const { learning, registered } = kernelHarness(createClaudeCodeTranscriptSource(), join(dir, ".store"));

    await expect(learning.ingest(registered, inputOf([original, original]))).rejects.toMatchObject({
      code: "schema.invalid",
    });

    const receipt = await learning.ingest(registered, inputOf([original, copy]));
    const singleCopyCount = (await allPages(createClaudeCodeTranscriptSource(), inputOf([original])))[0]?.observations
      .length;
    expect(receipt.observationIds).toHaveLength(singleCopyCount ?? -1);
    expect(receipt.episodeIds).toHaveLength(1);
    const episodes = await collect(learning.queryEpisodes({ limit: 10 }));
    expect(episodes).toHaveLength(1);
    const observations = await collect(learning.queryObservations({ sourceIds: [registered.id], limit: 100 }));
    expect(observations).toHaveLength(singleCopyCount ?? -1);
    // The copy's page receipt records the refusal to double-count, durably.
    const pages = await collect(learning.querySourcePageReceipts({ receiptIds: receipt.pageReceiptIds, limit: 10 }));
    expect(pages).toHaveLength(2);
    expect(pages[0]?.derivatives.length).toBe((singleCopyCount ?? 0) + 1);
    expect(pages[1]?.derivatives).toEqual([]);
    expect(pages[1]?.projectionCounts).toMatchObject({ rejected: singleCopyCount, reused: 1 });
    const findings = await collect(learning.queryEvidenceHealthFindings({ sourceIds: [registered.id], limit: 20 }));
    expect(findings.map((finding) => finding.code)).toContain("source.record_rejected");
  });

  it("keeps Codex event duplicates of response items silent", async () => {
    const dir = fixtureDir();
    const at = (second: number) => `2026-08-11T07:00:${String(second).padStart(2, "0")}.000Z`;
    const path = writeJsonl(dir, "rollout.jsonl", [
      { timestamp: at(0), type: "session_meta", payload: { id: SESSION_ID, cwd: "/workspaces/sample" } },
      {
        timestamp: at(1),
        type: "response_item",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: "no, revert it" }] },
      },
      { timestamp: at(1), type: "event_msg", payload: { type: "user_message", message: "no, revert it" } },
      {
        timestamp: at(2),
        type: "response_item",
        payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Reverted." }] },
      },
      { timestamp: at(2), type: "event_msg", payload: { type: "agent_message", message: "Reverted." } },
      { timestamp: at(2), type: "event_msg", payload: { type: "agent_message", message: "Reverted." } },
    ]);
    const [page] = await allPages(createCodexTranscriptSource(), inputOf([path]));
    if (page === undefined) throw new Error("missing page");
    expect(ofKind(page, "transcript.message").map((observation) => observation.data)).toEqual([
      { actor: "human", charCount: "no, revert it".length, correctionSignal: true },
      { actor: "agent", charCount: "Reverted.".length },
    ]);
    expect(page.diagnostics).toEqual([]);
  });
});
