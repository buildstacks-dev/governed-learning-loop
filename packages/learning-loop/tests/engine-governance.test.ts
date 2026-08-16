// GovernanceView fold, tested as a pure function. The standing invariants of
// the Observe+Govern milestone: publication is NEVER eligible and validation
// is always "untested" — authorized ≠ validated, missing measurement is never
// a pass.
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

function view(reviews: readonly CandidateReview[], requiresIndependentReview = true) {
  return computeGovernanceView({ candidateDigest: CURRENT_DIGEST, requiresIndependentReview, reviews });
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

  it("NEVER reports publication eligible in this milestone, whatever the review state", () => {
    const states = [
      view([]),
      view([review("rev-1", "accept")]),
      view([review("rev-1", "reject")]),
      view([review("rev-1", "revise")]),
      view([review("rev-1", "escalate")]),
      view([], false),
    ];
    for (const governance of states) {
      expect(governance.publication).toBe("blocked");
      expect(governance.validation).toBe("untested");
      expect(governance.reasons.some((reason) => reason.code === "policy.blocked" && reason.severity === "error")).toBe(
        true,
      );
    }
  });
});
