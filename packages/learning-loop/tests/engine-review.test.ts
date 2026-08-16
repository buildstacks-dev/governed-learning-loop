// Review conformance: independence enforcement, exact content binding, and
// the accept-with-blocking-finding refusal. Generation and review must be
// attributed and independent (kernel invariant 2).
import { describe, expect, it } from "vitest";
import { candidateInput, createHarness, reviewerFor } from "./engine-harness.js";

describe("learning.reviewCandidate", () => {
  it("refuses a self-review: the proposer cannot provide the decisive review", async () => {
    const { learning, proposer } = await createHarness();
    const { candidate } = await learning.propose(candidateInput(proposer));
    await expect(
      learning.reviewCandidate({ id: "rev-1", candidateId: candidate.id, reviewer: reviewerFor(proposer) }),
    ).rejects.toMatchObject({ name: "LearningLoopError", code: "review.not_independent" });
  });

  it("refuses a same-independence-domain review at effective risk T2", async () => {
    const { learning, proposer, reviewerSameDomain } = await createHarness();
    const { candidate } = await learning.propose(candidateInput(proposer, { proposedRisk: "T2" }));
    await expect(
      learning.reviewCandidate({ id: "rev-1", candidateId: candidate.id, reviewer: reviewerFor(reviewerSameDomain) }),
    ).rejects.toMatchObject({ name: "LearningLoopError", code: "review.not_independent" });
  });

  it("permits a same-domain (different principal) review below T2 under the conservative policy", async () => {
    const { learning, proposer, reviewerSameDomain } = await createHarness();
    const { candidate } = await learning.propose(candidateInput(proposer, { proposedRisk: "T1" }));
    const review = await learning.reviewCandidate({
      id: "rev-1",
      candidateId: candidate.id,
      reviewer: reviewerFor(reviewerSameDomain),
    });
    expect(review.disposition).toBe("accept");
    expect(review.reviewer.id).toBe("reviewer-a2");
  });

  it("refuses a review whose binding carries a stale digest after the content changed", async () => {
    const { learning, proposer, reviewerB } = await createHarness();
    const v1 = await learning.propose(candidateInput(proposer));
    const v2 = await learning.propose(
      candidateInput(proposer, {
        id: "cand-2",
        hypothesis: "A stricter preflight, including lint, will catch the failures.",
        supersedes: v1.candidate.id,
      }),
    );
    expect(v2.candidate.contentDigest).not.toBe(v1.candidate.contentDigest);

    const staleReviewer = reviewerFor(reviewerB, (input) => ({
      candidateId: input.candidate.id,
      candidateDigest: v1.candidate.contentDigest,
      disposition: "accept",
      findings: [],
    }));
    await expect(
      learning.reviewCandidate({ id: "rev-1", candidateId: v2.candidate.id, reviewer: staleReviewer }),
    ).rejects.toMatchObject({ name: "LearningLoopError", code: "review.binding_mismatch" });
  });

  it("refuses an accept that carries a blocking finding", async () => {
    const { learning, proposer, reviewerB } = await createHarness();
    const { candidate } = await learning.propose(candidateInput(proposer));
    const contradictory = reviewerFor(reviewerB, (input) => ({
      candidateId: input.candidate.id,
      candidateDigest: input.candidate.contentDigest,
      disposition: "accept",
      findings: [{ code: "evidence.missing", severity: "blocking", message: "no evidence for the claim" }],
    }));
    await expect(
      learning.reviewCandidate({ id: "rev-1", candidateId: candidate.id, reviewer: contradictory }),
    ).rejects.toMatchObject({ name: "LearningLoopError", code: "review.accept_with_blocking_finding" });
  });

  it("refuses a malformed reviewer result at the unknown boundary", async () => {
    const { learning, proposer, reviewerB } = await createHarness();
    const { candidate } = await learning.propose(candidateInput(proposer));
    const malformed = reviewerFor(reviewerB, () => ({ verdict: "looks good" }));
    await expect(
      learning.reviewCandidate({ id: "rev-1", candidateId: candidate.id, reviewer: malformed }),
    ).rejects.toMatchObject({ name: "LearningLoopError", code: "schema.invalid" });
  });

  it("persists an accepted review with attribution and flips governance to accepted (publication still blocked)", async () => {
    const { learning, proposer, reviewerB } = await createHarness();
    const { candidate } = await learning.propose(candidateInput(proposer));
    const review = await learning.reviewCandidate({
      id: "rev-1",
      candidateId: candidate.id,
      reviewer: reviewerFor(reviewerB),
    });
    expect(review.candidateDigest).toBe(candidate.contentDigest);
    expect(review.reviewer).toEqual({ id: "reviewer-b", kind: "agent", independenceDomain: "provider-b" });
    expect(review.reviewerAttestationDigest).toBe(reviewerB.attestationDigest);
    expect(review.reviewerImplementation).toEqual({ id: "reviewer-workflow", version: "1.0.0" });

    // Re-proposing identical content folds the stored review into governance.
    const after = await learning.propose(candidateInput(proposer));
    expect(after.governance.review).toBe("accepted");
    expect(after.governance.publication).toBe("blocked");
    expect(after.governance.validation).toBe("untested");
  });

  it("a reject review blocks the candidate with reasons", async () => {
    const { learning, proposer, reviewerB } = await createHarness();
    const { candidate } = await learning.propose(candidateInput(proposer));
    const rejecting = reviewerFor(reviewerB, (input) => ({
      candidateId: input.candidate.id,
      candidateDigest: input.candidate.contentDigest,
      disposition: "reject",
      findings: [{ code: "scope.too_broad", severity: "blocking", message: "narrow the scope" }],
    }));
    await learning.reviewCandidate({ id: "rev-1", candidateId: candidate.id, reviewer: rejecting });
    const after = await learning.propose(candidateInput(proposer));
    expect(after.governance.review).toBe("blocked");
    expect(after.governance.reasons.some((reason) => reason.code === "review.blocked")).toBe(true);
    expect(after.governance.reasons.some((reason) => reason.code === "scope.too_broad")).toBe(true);
  });

  it("reviewing a missing candidate is a typed refusal", async () => {
    const { learning, reviewerB } = await createHarness();
    await expect(
      learning.reviewCandidate({ id: "rev-1", candidateId: "no-such-candidate", reviewer: reviewerFor(reviewerB) }),
    ).rejects.toMatchObject({ name: "LearningLoopError", code: "review.candidate_not_found" });
  });
});
