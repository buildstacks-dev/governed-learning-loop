// Propose conformance: create-only candidates, atomic content-digest
// deduplication, and the inert-candidate governance view.
import { describe, expect, it } from "vitest";
import type { LearningLoop } from "../src/index.js";
import { createTestIdentityPort } from "../src/testing/index.js";
import { candidateInput, createCandidateHarness, createHarnessIdentityPort } from "./engine-harness.js";

function proposeFromUnknown(learning: LearningLoop, input: unknown): unknown {
  return Reflect.apply(learning.propose, learning, [input]);
}

describe("learning.propose", () => {
  it("records an inert candidate whose governance requires review and blocks publication", async () => {
    const { learning, proposer } = await createCandidateHarness();
    const outcome = await learning.propose(candidateInput(proposer));
    expect(outcome.candidate.schemaVersion).toBe(2);
    expect(outcome.candidate.evidenceRefs).toHaveLength(1);
    expect(outcome.candidate.evidenceRefs[0]).toMatchObject({
      kind: "observation",
      recordId: "manual-evidence/obs-42-typecheck",
      sourceId: "manual-evidence",
    });
    expect(outcome.evidenceHealth.status).toBe("ready");
    expect(outcome.candidate.proposedAt).toBe("2026-08-16T10:00:00.000Z");
    expect(outcome.candidate.proposerAttestationDigest).toBe(proposer.attestationDigest);
    expect(outcome.governance).toMatchObject({
      review: "required",
      publication: "blocked",
      validation: "untested",
    });
  });

  it("refuses the same candidate id with different bytes: create-only, no overwrite", async () => {
    const { learning, proposer } = await createCandidateHarness();
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
    const { learning, proposer } = await createCandidateHarness();
    const first = await learning.propose(candidateInput(proposer));
    const second = await learning.propose(candidateInput(proposer, { id: "cand-1-twin" }));
    expect(second.candidate.id).toBe(first.candidate.id);
    expect(second.candidate.contentDigest).toBe(first.candidate.contentDigest);
    expect(second.governance.reasons.some((reason) => reason.code === "candidate.duplicate_content")).toBe(true);
  });

  it("an identical re-propose (same id, same content) returns the existing candidate", async () => {
    const { learning, proposer } = await createCandidateHarness();
    const first = await learning.propose(candidateInput(proposer));
    const replay = await learning.propose(candidateInput(proposer));
    expect(replay.candidate).toEqual(first.candidate);
    expect(replay.governance.reasons.some((reason) => reason.code === "candidate.duplicate_content")).toBe(true);
  });

  it("validates scope through the configured scope policy", async () => {
    const { learning, proposer } = await createCandidateHarness();
    await expect(learning.propose(candidateInput(proposer, { scope: [] }))).rejects.toMatchObject({
      name: "LearningLoopError",
      code: "schema.invalid",
    });
  });

  it("accepts only handles minted by the exact configured production identity port", async () => {
    const identityA = createHarnessIdentityPort();
    const identityB = createHarnessIdentityPort();
    expect(identityA.registrationDigest).toBe(identityB.registrationDigest);

    const loopA = await createCandidateHarness([], { identity: identityA });
    const loopB = await createCandidateHarness([], { identity: identityB });
    expect(loopA.proposer.ref).toEqual(loopB.proposer.ref);
    expect(loopA.proposer.attestationDigest).toBe(loopB.proposer.attestationDigest);

    await expect(loopA.learning.propose(candidateInput(loopB.proposer))).rejects.toMatchObject({
      name: "LearningLoopError",
      code: "identity.unverified",
    });
    expect(await loopA.learning.getCandidateView({ candidateId: "cand-1" })).toBeUndefined();

    await expect(loopB.learning.propose(candidateInput(loopA.proposer))).rejects.toMatchObject({
      name: "LearningLoopError",
      code: "identity.unverified",
    });
    expect(await loopB.learning.getCandidateView({ candidateId: "cand-1" })).toBeUndefined();

    await expect(loopA.learning.propose(candidateInput(loopA.proposer))).resolves.toMatchObject({
      candidate: { id: "cand-1", proposedBy: loopA.proposer.ref },
    });
    await expect(loopB.learning.propose(candidateInput(loopB.proposer))).resolves.toMatchObject({
      candidate: { id: "cand-1", proposedBy: loopB.proposer.ref },
    });
  });

  it("rejects a test-port handle when a production identity port is configured", async () => {
    const { learning, proposer } = await createCandidateHarness([], { identity: createHarnessIdentityPort() });
    const testIdentity = createTestIdentityPort();
    const foreign = await testIdentity.verify({
      principalId: proposer.ref.id,
      kind: proposer.ref.kind,
      independenceDomain: proposer.ref.independenceDomain,
    });
    expect(foreign.ref).toEqual(proposer.ref);
    expect(foreign.attestationDigest).toBe(proposer.attestationDigest);

    await expect(learning.propose(candidateInput(foreign))).rejects.toMatchObject({
      name: "LearningLoopError",
      code: "identity.unverified",
    });
    expect(await learning.getCandidateView({ candidateId: "cand-1" })).toBeUndefined();
    await expect(learning.propose(candidateInput(proposer))).resolves.toMatchObject({ candidate: { id: "cand-1" } });
  });

  it("rejects unminted, cloned, spread, and serialized principal shapes", async () => {
    const { learning, proposer } = await createCandidateHarness([], { identity: createHarnessIdentityPort() });
    const plainLookalike: unknown = {
      ref: proposer.ref,
      attestationId: proposer.attestationId,
      attestationDigest: proposer.attestationDigest,
    };
    const spreadCopy: unknown = { ...proposer };
    const structuredCopy: unknown = structuredClone(proposer);
    const serializedCopy: unknown = JSON.parse(JSON.stringify(proposer));
    const copies = [plainLookalike, spreadCopy, structuredCopy, serializedCopy];

    for (const copy of copies) {
      const input: unknown = { ...candidateInput(proposer), proposedBy: copy };
      await expect(proposeFromUnknown(learning, input)).rejects.toMatchObject({
        name: "LearningLoopError",
        code: "identity.unverified",
      });
    }
    expect(await learning.getCandidateView({ candidateId: "cand-1" })).toBeUndefined();
  });
});
