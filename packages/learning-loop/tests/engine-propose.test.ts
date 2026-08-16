// Propose conformance: create-only candidates, atomic content-digest
// deduplication, and the inert-candidate governance view.
import { describe, expect, it } from "vitest";
import { candidateInput, createHarness } from "./engine-harness.js";

describe("learning.propose", () => {
  it("records an inert candidate whose governance requires review and blocks publication", async () => {
    const { learning, proposer } = await createHarness();
    const outcome = await learning.propose(candidateInput(proposer));
    expect(outcome.candidate.schemaVersion).toBe(1);
    expect(outcome.candidate.proposedAt).toBe("2026-08-16T10:00:00.000Z");
    expect(outcome.candidate.proposerAttestationDigest).toBe(proposer.attestationDigest);
    expect(outcome.governance).toMatchObject({
      review: "required",
      publication: "blocked",
      validation: "untested",
    });
  });

  it("refuses the same candidate id with different bytes: create-only, no overwrite", async () => {
    const { learning, proposer } = await createHarness();
    await learning.propose(candidateInput(proposer));
    await expect(
      learning.propose(candidateInput(proposer, { problem: "A different problem statement entirely." })),
    ).rejects.toMatchObject({ name: "LearningLoopError", code: "store.conflict" });

    // The refused content was never claimed: it can still be proposed under its own id.
    const retried = await learning.propose(
      candidateInput(proposer, { id: "cand-2", problem: "A different problem statement entirely." }),
    );
    expect(retried.candidate.id).toBe("cand-2");
  });

  it("deduplicates identical content under a different id: same candidate, no twin", async () => {
    const { learning, proposer } = await createHarness();
    const first = await learning.propose(candidateInput(proposer));
    const second = await learning.propose(candidateInput(proposer, { id: "cand-1-twin" }));
    expect(second.candidate.id).toBe(first.candidate.id);
    expect(second.candidate.contentDigest).toBe(first.candidate.contentDigest);
    expect(second.governance.reasons.some((reason) => reason.code === "candidate.duplicate_content")).toBe(true);
  });

  it("an identical re-propose (same id, same content) returns the existing candidate", async () => {
    const { learning, proposer } = await createHarness();
    const first = await learning.propose(candidateInput(proposer));
    const replay = await learning.propose(candidateInput(proposer));
    expect(replay.candidate).toEqual(first.candidate);
    expect(replay.governance.reasons.some((reason) => reason.code === "candidate.duplicate_content")).toBe(true);
  });

  it("validates scope through the configured scope policy", async () => {
    const { learning, proposer } = await createHarness();
    await expect(learning.propose(candidateInput(proposer, { scope: [] }))).rejects.toMatchObject({
      name: "LearningLoopError",
      code: "schema.invalid",
    });
  });
});
