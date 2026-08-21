// GovernanceView fold, tested as a pure function. Publication is eligible
// only with decisive review, a registered destination, and a configured
// authority — and eligibility is never an authorization; validation is
// always "untested" here — authorized ≠ validated, missing measurement is
// never a pass.
import { describe, expect, it } from "vitest";
import type { CandidateReview, ReviewDisposition, ReviewFinding } from "../src/index.js";
import { computeGovernanceView } from "../src/engine/governance.js";

const CURRENT_DIGEST = "c".repeat(64);
const STALE_DIGEST = "d".repeat(64);

function review(
  id: string,
  disposition: ReviewDisposition,
  candidateDigest: string = CURRENT_DIGEST,
  findings: readonly ReviewFinding[] = [],
): CandidateReview {
  return {
    schemaVersion: 1,
    id,
    candidateId: "cand-1",
    candidateDigest,
    reviewer: { id: "reviewer-b", kind: "agent", independenceDomain: "provider-b" },
    reviewerAttestationDigest: "attest-b",
    reviewerImplementation: { id: "reviewer-workflow", version: "1.0.0" },
    disposition,
    findings,
    reviewedAt: "2026-08-16T10:10:00.000Z",
  };
}

function view(
  reviews: readonly CandidateReview[],
  requiresIndependentReview = true,
  loop: { readonly destinationRegistered: boolean; readonly authorityConfigured: boolean } = {
    destinationRegistered: true,
    authorityConfigured: true,
  },
) {
  return computeGovernanceView({ candidateDigest: CURRENT_DIGEST, requiresIndependentReview, reviews, ...loop });
}

describe("computeGovernanceView", () => {
  it("requires review when no decisive review exists", () => {
    const governance = view([]);
    expect(governance.review).toBe("required");
    expect(governance.reasons.some((reason) => reason.code === "review.required")).toBe(true);
  });

  it("accepts after an accepting review of the current digest", () => {
    expect(view([review("rev-1", "accept")]).review).toBe("accepted");
  });

  it("ignores reviews that bind a stale digest", () => {
    expect(view([review("rev-1", "accept", STALE_DIGEST)]).review).toBe("required");
  });

  it("blocks on reject and escalate, carrying the findings as reasons", () => {
    const findings: readonly ReviewFinding[] = [
      { code: "evidence.missing", severity: "blocking", message: "no evidence" },
    ];
    const rejected = view([review("rev-1", "reject", CURRENT_DIGEST, findings)]);
    expect(rejected.review).toBe("blocked");
    expect(rejected.reasons.some((reason) => reason.code === "review.blocked")).toBe(true);
    expect(rejected.reasons.some((reason) => reason.code === "evidence.missing")).toBe(true);
    expect(view([review("rev-1", "escalate")]).review).toBe("blocked");
  });

  it("a revise disposition returns the candidate to required", () => {
    const governance = view([review("rev-1", "accept"), review("rev-2", "revise")]);
    expect(governance.review).toBe("required");
  });

  it("the latest binding review is decisive", () => {
    expect(view([review("rev-1", "reject"), review("rev-2", "accept")]).review).toBe("accepted");
    expect(view([review("rev-1", "accept"), review("rev-2", "reject")]).review).toBe("blocked");
  });

  it("reports not_required only when policy does not demand review", () => {
    expect(view([], false).review).toBe("not_required");
  });

  it("reports publication eligible only with decisive review, a registered destination, and a configured authority", () => {
    for (const governance of [view([review("rev-1", "accept")]), view([], false)]) {
      expect(governance.publication).toBe("eligible");
      expect(governance.validation).toBe("untested");
      expect(governance.reasons.some((reason) => reason.code === "policy.blocked")).toBe(false);
    }
    for (const governance of [
      view([]),
      view([review("rev-1", "reject")]),
      view([review("rev-1", "revise")]),
      view([review("rev-1", "escalate")]),
    ]) {
      expect(governance.publication).toBe("blocked");
      expect(governance.validation).toBe("untested");
      expect(governance.reasons.some((reason) => reason.code === "policy.blocked" && reason.severity === "error")).toBe(
        true,
      );
    }
    const unregistered = view([review("rev-1", "accept")], true, {
      destinationRegistered: false,
      authorityConfigured: true,
    });
    expect(unregistered.publication).toBe("blocked");
    expect(unregistered.reasons.map((reason) => reason.code)).toEqual(["publication.destination_unknown"]);
    const unauthorized = view([review("rev-1", "accept")], true, {
      destinationRegistered: true,
      authorityConfigured: false,
    });
    expect(unauthorized.publication).toBe("blocked");
    expect(unauthorized.reasons.map((reason) => reason.code)).toEqual(["policy.authority_insufficient"]);
  });

  it("validation never leaves untested through governance: eligibility is not a measured improvement", () => {
    expect(view([review("rev-1", "accept")]).validation).toBe("untested");
  });
});
