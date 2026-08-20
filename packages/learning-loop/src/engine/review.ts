// learning.reviewCandidate — the engine calls the reviewer implementation,
// parses its result from `unknown`, and REFUSES to persist a review that
// violates the protocol: a binding mismatch against the stored candidate
// digest, a self-review, a same-independence-domain review where policy
// demands a distinct domain, or an `accept` carrying a blocking finding.
// Generation and review stay attributed and independent (kernel invariant 2).
import { canonicalJsonText } from "../canonical/canonical-json.js";
import { toJsonValue } from "../canonical/to-json-value.js";
import { LearningLoopError } from "../diagnostics.js";
import { parseArrayOf, parseNonEmptyText, parseOneOf, parseText, readFields } from "../parse/toolkit.js";
import type { Parse } from "../parse/toolkit.js";
import type { Candidate } from "../records/candidate.js";
import { parseCandidate } from "../records/candidate.js";
import type { MeasurementRecord } from "../records/episode.js";
import type { Observation } from "../records/observation.js";
import type { PrincipalRef, VerifiedPrincipal } from "../records/principal.js";
import type { CandidateReview, ReviewDisposition, ReviewFinding } from "../records/review.js";
import { parseCandidateReview, reviewInvalidReasons } from "../records/review.js";
import type { EngineContext } from "./context.js";
import { createOnly, effectiveRisk, loadStoredRecord } from "./context.js";
import { candidateLineageDiagnostics } from "./candidate-lineage.js";
import { revalidateCandidateEvidence } from "./evidence-binding.js";
import type { CandidateEvidenceResolution } from "./evidence-binding.js";
import { assertVerifiedPrincipal } from "./identity.js";

/** Semantic-judgment port for candidate review (contract §Semantic judgment). */
export interface CandidateReviewer {
  readonly id: string;
  readonly version: string;
  readonly principal: VerifiedPrincipal;
  readonly calibrationDigest?: string;

  review(input: {
    readonly candidate: Candidate;
    readonly evidence: readonly (Observation | MeasurementRecord)[];
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

function assertReviewableEvidence(evidence: CandidateEvidenceResolution): void {
  if (evidence.health.status === "ready") return;
  const code =
    evidence.health.status === "legacy_unbound"
      ? "review.evidence_unbound"
      : evidence.health.status === "incomplete"
        ? "review.evidence_incomplete"
        : "review.evidence_invalid";
  throw new LearningLoopError(code, [
    {
      code,
      severity: "error",
      message: "candidate evidence is not eligible for decisive review",
    },
    ...evidence.health.diagnostics,
  ]);
}

function sameCanonicalValue(left: unknown, right: unknown): boolean {
  return canonicalJsonText(toJsonValue(left)) === canonicalJsonText(toJsonValue(right));
}

function assertIndependentReviewer(context: EngineContext, candidate: Candidate, reviewerRef: PrincipalRef): void {
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
}

export async function runReviewCandidate(
  context: EngineContext,
  input: CandidateReviewInput,
): Promise<CandidateReview> {
  // Capture all caller-owned reviewer and request properties exactly once.
  const reviewerPort = input.reviewer;
  const reviewerPrincipal = reviewerPort.principal;
  assertVerifiedPrincipal(context.identity, reviewerPrincipal, "reviewer.principal");
  const inputFields = readFields(input, ["candidateReviewInput"]);
  const reviewId = inputFields.req("id", parseNonEmptyText);
  const requestedCandidateId = inputFields.req("candidateId", parseNonEmptyText);
  const reviewerId = parseNonEmptyText(reviewerPort.id, ["reviewer", "id"]);
  const reviewerVersion = parseNonEmptyText(reviewerPort.version, ["reviewer", "version"]);
  const configuredCalibrationDigest = reviewerPort.calibrationDigest;
  const calibrationDigest =
    configuredCalibrationDigest === undefined
      ? undefined
      : parseNonEmptyText(configuredCalibrationDigest, ["reviewer", "calibrationDigest"]);
  const reviewFunction = reviewerPort.review;
  if (typeof reviewFunction !== "function") {
    throw refusal("schema.invalid", "candidate reviewer must provide a review function");
  }
  const reviewerRef = Object.freeze({ ...reviewerPrincipal.ref });
  const reviewerAttestationDigest = reviewerPrincipal.attestationDigest;
  const reviewerImplementation = Object.freeze({
    id: reviewerId,
    version: reviewerVersion,
    ...(calibrationDigest !== undefined ? { calibrationDigest } : {}),
  });

  const candidateStored = await loadStoredRecord(context, "candidate", requestedCandidateId);
  if (candidateStored === undefined) {
    throw refusal("review.candidate_not_found", `candidate "${requestedCandidateId}" does not exist`);
  }
  const candidate = parseCandidate(candidateStored.value);
  if (candidate.id !== requestedCandidateId) {
    throw refusal("store.corrupt", "stored candidate id does not match its record key");
  }
  const candidateId = candidate.id;
  const candidateDigest = candidate.contentDigest;

  const existingStored = await loadStoredRecord(context, "review", reviewId);
  if (existingStored !== undefined) {
    const existing = parseCandidateReview(existingStored.value);
    if (existing.id !== reviewId) {
      throw refusal("store.corrupt", "stored review id does not match its record key");
    }
    if (
      existing.candidateId === candidateId &&
      existing.candidateDigest === candidateDigest &&
      existing.reviewerAttestationDigest === reviewerAttestationDigest &&
      sameCanonicalValue(existing.reviewer, reviewerRef) &&
      sameCanonicalValue(existing.reviewerImplementation, reviewerImplementation)
    ) {
      return existing;
    }
    throw refusal("store.conflict", `review "${reviewId}" already belongs to different content`);
  }

  assertIndependentReviewer(context, candidate, reviewerRef);

  const lineageDiagnostics = await candidateLineageDiagnostics(context, candidate);
  if (lineageDiagnostics.length > 0) {
    throw new LearningLoopError("review.lineage_invalid", [
      {
        code: "review.lineage_invalid",
        severity: "error",
        message: "candidate supersession lineage is invalid",
      },
      ...lineageDiagnostics,
    ]);
  }

  const evidence = await revalidateCandidateEvidence(context, candidate);
  assertReviewableEvidence(evidence);

  // The callback receives a detached parsed copy. It cannot mutate the
  // candidate instance used for binding, independence, or persistence.
  const candidateForReviewer = Object.freeze(parseCandidate(toJsonValue(candidate)));
  const raw = await reviewFunction.call(reviewerPort, {
    candidate: candidateForReviewer,
    evidence: evidence.records,
    policyDigest: context.policy.digest,
  });
  const result = parseReviewerResult(raw);

  if (result.candidateId !== candidateId || result.candidateDigest !== candidateDigest) {
    throw refusal(
      "review.binding_mismatch",
      `review binds candidate "${result.candidateId}" digest ${result.candidateDigest}, but the stored candidate is "${candidateId}" digest ${candidateDigest}; a review of stale or foreign content is void`,
    );
  }

  // The reviewer is an external, potentially long-running port. Revalidate
  // after it returns so evidence invalidated during review cannot acquire a
  // decisive persisted disposition. Later invalidation still blocks views.
  const currentStored = await loadStoredRecord(context, "candidate", candidateId);
  if (
    currentStored === undefined ||
    currentStored.revision !== candidateStored.revision ||
    currentStored.digest !== candidateStored.digest
  ) {
    throw refusal("review.binding_mismatch", "candidate changed or disappeared while review was running");
  }
  const currentCandidate = parseCandidate(currentStored.value);
  if (currentCandidate.id !== candidateId || !sameCanonicalValue(currentCandidate, candidate)) {
    throw refusal("review.binding_mismatch", "candidate bytes changed while review was running");
  }
  assertIndependentReviewer(context, currentCandidate, reviewerRef);
  const currentLineageDiagnostics = await candidateLineageDiagnostics(context, currentCandidate);
  if (currentLineageDiagnostics.length > 0) {
    throw new LearningLoopError("review.lineage_invalid", currentLineageDiagnostics);
  }
  assertReviewableEvidence(await revalidateCandidateEvidence(context, currentCandidate));

  const record: CandidateReview = {
    schemaVersion: 1,
    id: reviewId,
    candidateId,
    candidateDigest,
    reviewer: reviewerRef,
    reviewerAttestationDigest,
    reviewerImplementation,
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
