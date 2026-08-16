// Candidate review (contract §Review). Generation and review are attributed
// and independent; an `accept` with a blocking finding is invalid.
import type { Diagnostic } from "../diagnostics.js";
import { parseArrayOf, parseNonEmptyText, parseOneOf, parseText, readFields } from "../parse/toolkit.js";
import type { Parse } from "../parse/toolkit.js";
import type { PrincipalRef } from "./principal.js";
import { parsePrincipalRefAt } from "./principal.js";

export type ReviewDisposition = "accept" | "revise" | "reject" | "escalate";

const REVIEW_DISPOSITIONS = ["accept", "revise", "reject", "escalate"] as const;
const FINDING_SEVERITIES = ["info", "warning", "blocking"] as const;

export interface ReviewFinding {
  readonly code: string;
  readonly severity: "info" | "warning" | "blocking";
  readonly message: string;
}

export interface CandidateReview {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly candidateId: string;
  readonly candidateDigest: string;
  readonly reviewer: PrincipalRef;
  readonly reviewerAttestationDigest: string;
  readonly reviewerImplementation: {
    readonly id: string;
    readonly version: string;
    readonly calibrationDigest?: string;
  };
  readonly disposition: ReviewDisposition;
  readonly findings: readonly ReviewFinding[];
  readonly reviewedAt: string;
}

const parseFindingAt: Parse<ReviewFinding> = (input, path) => {
  const fields = readFields(input, path);
  return {
    code: fields.req("code", parseNonEmptyText),
    severity: fields.req("severity", parseOneOf(FINDING_SEVERITIES)),
    message: fields.req("message", parseText),
  };
};

const parseReviewerImplementationAt: Parse<CandidateReview["reviewerImplementation"]> = (input, path) => {
  const fields = readFields(input, path);
  const calibrationDigest = fields.opt("calibrationDigest", parseText);
  return {
    id: fields.req("id", parseNonEmptyText),
    version: fields.req("version", parseNonEmptyText),
    ...(calibrationDigest !== undefined ? { calibrationDigest } : {}),
  };
};

export function parseCandidateReview(input: unknown): CandidateReview {
  const fields = readFields(input, []);
  const schemaVersion = fields.schemaVersion1();
  return {
    schemaVersion,
    id: fields.req("id", parseNonEmptyText),
    candidateId: fields.req("candidateId", parseNonEmptyText),
    candidateDigest: fields.req("candidateDigest", parseNonEmptyText),
    reviewer: fields.req("reviewer", parsePrincipalRefAt),
    reviewerAttestationDigest: fields.req("reviewerAttestationDigest", parseNonEmptyText),
    reviewerImplementation: fields.req("reviewerImplementation", parseReviewerImplementationAt),
    disposition: fields.req("disposition", parseOneOf(REVIEW_DISPOSITIONS)),
    findings: fields.req("findings", parseArrayOf(parseFindingAt)),
    reviewedAt: fields.req("reviewedAt", parseNonEmptyText),
  };
}

/**
 * Pure review-validity rule. Returns one diagnostic per violation; an empty
 * result means the review is internally valid. Currently encodes the contract
 * rule that an `accept` disposition with any `blocking` finding is invalid.
 * (Independence and binding checks need engine context and live elsewhere.)
 */
export function reviewInvalidReasons(review: CandidateReview): readonly Diagnostic[] {
  const reasons: Diagnostic[] = [];
  if (review.disposition === "accept") {
    review.findings.forEach((finding, index) => {
      if (finding.severity === "blocking") {
        reasons.push({
          code: "review.accept_with_blocking_finding",
          severity: "error",
          message: `an "accept" review must not carry blocking finding ${finding.code}`,
          path: ["findings", index],
        });
      }
    });
  }
  return reasons;
}
