import { describe, expect, it } from "vitest";
import type { CandidateReview, ReviewFinding } from "../src/records/review.js";
import { reviewInvalidReasons } from "../src/records/review.js";

function review(disposition: CandidateReview["disposition"], findings: readonly ReviewFinding[]): CandidateReview {
  return {
    schemaVersion: 1,
    id: "review-1",
    candidateId: "cand-1",
    candidateDigest: "d".repeat(64),
    reviewer: { id: "reviewer-b", kind: "agent", independenceDomain: "provider-b" },
    reviewerAttestationDigest: "attest-2",
    reviewerImplementation: { id: "reviewer-workflow-b", version: "1.0.0" },
    disposition,
    findings,
    reviewedAt: "2026-08-16T10:10:00.000Z",
  };
}

describe("reviewInvalidReasons", () => {
  it("accepts a clean accept", () => {
    expect(reviewInvalidReasons(review("accept", []))).toEqual([]);
  });

  it("accepts an accept with only info and warning findings", () => {
    const findings: readonly ReviewFinding[] = [
      { code: "style.nit", severity: "info", message: "cosmetic" },
      { code: "scope.broad", severity: "warning", message: "consider narrowing" },
    ];
    expect(reviewInvalidReasons(review("accept", findings))).toEqual([]);
  });

  it("rejects an accept with a blocking finding, naming its path", () => {
    const findings: readonly ReviewFinding[] = [
      { code: "style.nit", severity: "info", message: "cosmetic" },
      { code: "evidence.missing", severity: "blocking", message: "no evidence for the claim" },
    ];
    const reasons = reviewInvalidReasons(review("accept", findings));
    expect(reasons).toHaveLength(1);
    expect(reasons[0]?.code).toBe("review.accept_with_blocking_finding");
    expect(reasons[0]?.severity).toBe("error");
    expect(reasons[0]?.path).toEqual(["findings", 1]);
  });

  it("reports every blocking finding on an accept", () => {
    const findings: readonly ReviewFinding[] = [
      { code: "a", severity: "blocking", message: "first" },
      { code: "b", severity: "blocking", message: "second" },
    ];
    expect(reviewInvalidReasons(review("accept", findings))).toHaveLength(2);
  });

  it("permits blocking findings on non-accept dispositions", () => {
    const findings: readonly ReviewFinding[] = [{ code: "a", severity: "blocking", message: "why it must change" }];
    expect(reviewInvalidReasons(review("revise", findings))).toEqual([]);
    expect(reviewInvalidReasons(review("reject", findings))).toEqual([]);
    expect(reviewInvalidReasons(review("escalate", findings))).toEqual([]);
  });
});
