// learning.report: scope, episode, and time-window filtering over stored
// records; activation-tier id lists are structurally empty with a diagnostic.
import { describe, expect, it } from "vitest";
import { SCOPE, candidateInput, createHarness, journeyEvidence } from "./engine-harness.js";

describe("learning.report", () => {
  it("filters candidates by exact scope", async () => {
    const { learning, proposer } = await createHarness();
    await learning.propose(candidateInput(proposer));
    await learning.propose(
      candidateInput(proposer, {
        id: "cand-other-scope",
        scope: [{ type: "project", id: "other-project" }],
        problem: "A different project has a different problem.",
      }),
    );

    const scoped = await learning.report({ scope: SCOPE });
    expect(scoped.candidateIds).toEqual(["cand-1"]);
    const other = await learning.report({ scope: [{ type: "project", id: "other-project" }] });
    expect(other.candidateIds).toEqual(["cand-other-scope"]);
    const all = await learning.report({});
    expect(all.candidateIds).toEqual(["cand-1", "cand-other-scope"]);
  });

  it("filters by since/until on proposedAt (fixed clock: 2026-08-16T10:00:00Z)", async () => {
    const { learning, proposer } = await createHarness();
    await learning.propose(candidateInput(proposer));
    const before = await learning.report({ until: "2026-08-16T09:59:59.000Z" });
    expect(before.candidateIds).toEqual([]);
    const window = await learning.report({ since: "2026-08-16T10:00:00.000Z", until: "2026-08-16T10:00:00.000Z" });
    expect(window.candidateIds).toEqual(["cand-1"]);
    const after = await learning.report({ since: "2026-08-16T10:00:01.000Z" });
    expect(after.candidateIds).toEqual([]);
    await expect(learning.report({ since: "2026-08-16T10:00:00Z" })).rejects.toMatchObject({
      code: "query.invalid",
    });
  });

  it("rejects unknown report fields instead of broadening the read", async () => {
    const { learning } = await createHarness();
    const misspelled = { scope: SCOPE, sourceId: "manual-evidence" };
    await expect(learning.report(misspelled)).rejects.toMatchObject({ code: "query.invalid" });
  });

  it("filters by episode through the candidates' evidence", async () => {
    const { learning, manual, proposer } = await createHarness();
    await learning.ingest(manual, journeyEvidence());
    await learning.propose(candidateInput(proposer));
    await learning.propose(
      candidateInput(proposer, {
        id: "cand-unrelated",
        evidenceIds: ["obs-from-somewhere-else"],
        problem: "Something unrelated to episode change-42.",
      }),
    );

    const filtered = await learning.report({ sourceIds: ["manual-evidence"], episodeIds: ["change-42"] });
    expect(filtered.candidateIds).toEqual(["cand-1"]);
    const missing = await learning.report({ sourceIds: ["manual-evidence"], episodeIds: ["no-such-episode"] });
    expect(missing.candidateIds).toEqual([]);
    await expect(learning.report({ episodeIds: ["change-42"] })).rejects.toMatchObject({ code: "query.invalid" });
  });

  it("reports empty intervention and evaluation ids with an explanatory diagnostic", async () => {
    const { learning, proposer } = await createHarness();
    await learning.propose(candidateInput(proposer));
    const report = await learning.report({});
    expect(report.interventionIds).toEqual([]);
    expect(report.evaluationIds).toEqual([]);
    expect(report.diagnostics.some((diagnostic) => diagnostic.code === "report.tier_not_implemented")).toBe(true);
  });
});
