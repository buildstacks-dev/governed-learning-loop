// learning.reviewCandidate — the engine calls the reviewer implementation,
// parses its result from `unknown`, and REFUSES to persist a review that
// violates the protocol: a binding mismatch against the stored candidate
// digest, a self-review, a same-independence-domain review where policy
// demands a distinct domain, or an `accept` carrying a blocking finding.
// Generation and review stay attributed and independent (kernel invariant 2).
import { LearningLoopError } from "../diagnostics.js";
import { parseArrayOf, parseNonEmptyText, parseOneOf, parseText, readFields } from "../parse/toolkit.js";
import type { Parse } from "../parse/toolkit.js";
import type { Candidate } from "../records/candidate.js";
import type { Observation } from "../records/observation.js";
import { parseObservation } from "../records/observation.js";
import type { VerifiedPrincipal } from "../records/principal.js";
import type { CandidateReview, ReviewDisposition, ReviewFinding } from "../records/review.js";
import { parseCandidateReview, reviewInvalidReasons } from "../records/review.js";
import type { EngineContext } from "./context.js";
import { createOnly, effectiveRisk, listAllRecords, loadCandidate } from "./context.js";
import { assertVerifiedPrincipal } from "./identity.js";

/** Semantic-judgment port for candidate review (contract §Semantic judgment). */
export interface CandidateReviewer {
  readonly id: string;
  readonly version: string;
  readonly principal: VerifiedPrincipal;
  readonly calibrationDigest?: string;

  review(input: {
    readonly candidate: Candidate;
    readonly evidence: readonly Observation[];
    readonly policyDigest: string;
  }): Promise<unknown>;
}

export interface CandidateReviewInput {
  readonly id: string;
  readonly candidateId: string;
  readonly reviewer: CandidateReviewer;
}

const REVIEW_DISPOSITIONS: readonly ReviewDisposition[] = ["accept", "revise", "reject", "escalate"];
const FINDING_SEVERITIES = ["info", "warning", "blocking"] as const;

const parseFindingAt: Parse<ReviewFinding> = (input, path) => {
  const fields = readFields(input, path);
  return {
    code: fields.req("code", parseNonEmptyText),
    severity: fields.req("severity", parseOneOf(FINDING_SEVERITIES)),
    message: fields.req("message", parseText),
  };
};

interface ReviewerResult {
  readonly candidateId: string;
  readonly candidateDigest: string;
  readonly disposition: ReviewDisposition;
  readonly findings: readonly ReviewFinding[];
}

function parseReviewerResult(input: unknown): ReviewerResult {
  const fields = readFields(input, ["reviewerResult"]);
  return {
    candidateId: fields.req("candidateId", parseNonEmptyText),
    candidateDigest: fields.req("candidateDigest", parseNonEmptyText),
    disposition: fields.req("disposition", parseOneOf(REVIEW_DISPOSITIONS)),
    findings: fields.req("findings", parseArrayOf(parseFindingAt)),
  };
}

function refusal(code: string, message: string): LearningLoopError {
  return new LearningLoopError(code, [{ code, severity: "error", message }]);
}

/** Observations referenced by the candidate, matched by durable id or source recordRef. */
async function loadEvidence(context: EngineContext, candidate: Candidate): Promise<readonly Observation[]> {
  const wanted = new Set(candidate.evidenceIds);
  const stored = await listAllRecords(context.store, "observation");
  return stored
    .map((record) => parseObservation(record.value))
    .filter(
      (observation) =>
        wanted.has(observation.id) ||
        (observation.provenance.recordRef !== undefined && wanted.has(observation.provenance.recordRef)),
    );
}

export async function runReviewCandidate(
  context: EngineContext,
  input: CandidateReviewInput,
): Promise<CandidateReview> {
  assertVerifiedPrincipal(input.reviewer.principal, "reviewer.principal");
  const candidate = await loadCandidate(context, input.candidateId);
  if (candidate === undefined) {
    throw refusal("review.candidate_not_found", `candidate "${input.candidateId}" does not exist`);
  }

  const evidence = await loadEvidence(context, candidate);
  const raw = await input.reviewer.review({ candidate, evidence, policyDigest: context.policy.digest });
  const result = parseReviewerResult(raw);

  if (result.candidateId !== candidate.id || result.candidateDigest !== candidate.contentDigest) {
    throw refusal(
      "review.binding_mismatch",
      `review binds candidate "${result.candidateId}" digest ${result.candidateDigest}, but the stored candidate is "${candidate.id}" digest ${candidate.contentDigest}; a review of stale or foreign content is void`,
    );
  }

  const reviewerRef = input.reviewer.principal.ref;
  if (reviewerRef.id === candidate.proposedBy.id) {
    throw refusal(
      "review.not_independent",
      `principal "${reviewerRef.id}" proposed this candidate and cannot review it; generation and review must be independent`,
    );
  }
  const riskRule = context.policyRules.risks[effectiveRisk(candidate)];
  if (riskRule.independentDomain && reviewerRef.independenceDomain === candidate.proposedBy.independenceDomain) {
    throw refusal(
      "review.not_independent",
      `policy requires a reviewer from a distinct independence domain at effective risk ${effectiveRisk(candidate)}; "${reviewerRef.id}" shares domain "${reviewerRef.independenceDomain}" with the proposer`,
    );
  }

  const record: CandidateReview = {
    schemaVersion: 1,
    id: input.id,
    candidateId: candidate.id,
    candidateDigest: candidate.contentDigest,
    reviewer: reviewerRef,
    reviewerAttestationDigest: input.reviewer.principal.attestationDigest,
    reviewerImplementation: {
      id: input.reviewer.id,
      version: input.reviewer.version,
      ...(input.reviewer.calibrationDigest !== undefined
        ? { calibrationDigest: input.reviewer.calibrationDigest }
        : {}),
    },
    disposition: result.disposition,
    findings: result.findings,
    reviewedAt: context.clock.now(),
  };
  const review = parseCandidateReview(record);
  const invalidReasons = reviewInvalidReasons(review);
  const firstReason = invalidReasons[0];
  if (firstReason !== undefined) {
    throw new LearningLoopError(firstReason.code, invalidReasons);
  }

  const status = await createOnly(context, "review", review.id, review, `review/${review.id}`);
  if (status === "conflict") {
    throw refusal(
      "store.conflict",
      `review "${review.id}" already exists with different content; reviews are create-only`,
    );
  }
  return review;
}
