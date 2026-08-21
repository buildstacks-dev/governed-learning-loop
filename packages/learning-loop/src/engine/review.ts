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
import { parseDurableId } from "../records/semantic-shared.js";
import type { Parse } from "../parse/toolkit.js";
import type { Candidate } from "../records/candidate.js";
import { parseCandidate } from "../records/candidate.js";
import type { MeasurementRecord } from "../records/episode.js";
import type { InsightDerivation } from "../records/insight-derivation.js";
import { parseInsightDerivation } from "../records/insight-derivation.js";
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
import type { CandidateDerivationBinding } from "./derivation-binding.js";
import { revalidateCandidateDerivation } from "./derivation-binding.js";
import { appendCandidateReviewReference, verifyExistingCandidateReviewReference } from "./candidate-review-index.js";
import { loadCandidateAdmissionLineageRecords } from "./recurrence-admission.js";

/** Semantic-judgment port for candidate review (contract §Semantic judgment). */
export interface CandidateReviewer {
  readonly id: string;
  readonly version: string;
  readonly principal: VerifiedPrincipal;
  readonly calibrationDigest?: string;

  review(input: {
    readonly candidate: Candidate;
    readonly evidence: readonly (Observation | MeasurementRecord)[];
    readonly derivation: InsightDerivation | null;
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

function assertReviewableDerivation(binding: CandidateDerivationBinding): void {
  if (binding.status !== "invalid") return;
  throw new LearningLoopError("review.derivation_invalid", [
    { code: "review.derivation_invalid", severity: "error", message: "candidate derivation is not reviewable" },
    ...binding.diagnostics,
  ]);
}

async function assertReviewableAdmission(context: EngineContext, candidate: Candidate): Promise<void> {
  if (candidate.schemaVersion !== 2) return;
  const admission = await loadCandidateAdmissionLineageRecords(context, candidate);
  if (admission.status !== "invalid") return;
  throw new LearningLoopError("review.admission_invalid", [
    {
      code: "review.admission_invalid",
      severity: "error",
      message: "Candidate admission lineage is structurally invalid",
    },
  ]);
}

function sameCanonicalValue(left: unknown, right: unknown): boolean {
  return canonicalJsonText(toJsonValue(left)) === canonicalJsonText(toJsonValue(right));
}

function assertIndependentReviewer(
  context: EngineContext,
  candidate: Candidate,
  reviewerRef: PrincipalRef,
  reviewerImplementation: { readonly id: string; readonly version: string },
  derivationBinding: CandidateDerivationBinding,
): void {
  if (reviewerRef.id === candidate.proposedBy.id) {
    throw refusal(
      "review.not_independent",
      `principal "${reviewerRef.id}" proposed this candidate and cannot review it; generation and review must be independent`,
    );
  }
  const producerPrincipal =
    derivationBinding.status === "resolved"
      ? derivationBinding.resolved.producerPrincipal
      : derivationBinding.status === "invalid"
        ? derivationBinding.producerPrincipal
        : undefined;
  const producerImplementation =
    derivationBinding.status === "resolved"
      ? derivationBinding.resolved.producerImplementation
      : derivationBinding.status === "invalid"
        ? derivationBinding.producerImplementation
        : undefined;
  if (producerPrincipal !== null && producerPrincipal !== undefined && reviewerRef.id === producerPrincipal.id) {
    throw refusal("review.not_independent", "derivation producer principal cannot decisively review its Candidate");
  }
  if (
    producerPrincipal !== null &&
    producerPrincipal !== undefined &&
    reviewerRef.independenceDomain === producerPrincipal.independenceDomain
  ) {
    throw refusal("review.not_independent", "reviewer shares a prohibited generation independence domain");
  }
  if (
    producerImplementation !== undefined &&
    reviewerImplementation.id === producerImplementation.id &&
    reviewerImplementation.version === producerImplementation.version
  ) {
    throw refusal(
      "review.not_independent",
      "derivation producer implementation cannot decisively review its Candidate",
    );
  }
  const riskRule = context.policyRules.risks[effectiveRisk(context, candidate)];
  if (riskRule.independentDomain && reviewerRef.independenceDomain === candidate.proposedBy.independenceDomain) {
    throw refusal("review.not_independent", "reviewer shares a prohibited generation independence domain");
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
  const reviewId = inputFields.req("id", parseDurableId);
  const requestedCandidateId = inputFields.req("candidateId", parseDurableId);
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
  const derivationBinding = await revalidateCandidateDerivation(context, candidate);
  assertIndependentReviewer(context, candidate, reviewerRef, reviewerImplementation, derivationBinding);
  assertReviewableDerivation(derivationBinding);
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
  await assertReviewableAdmission(context, candidate);

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
      await verifyExistingCandidateReviewReference(context, candidate, existing);
      return existing;
    }
    throw refusal("store.conflict", `review "${reviewId}" already belongs to different content`);
  }

  const evidence = await revalidateCandidateEvidence(context, candidate);
  assertReviewableEvidence(evidence);

  // The callback receives a detached parsed copy. It cannot mutate the
  // candidate instance used for binding, independence, or persistence.
  const candidateForReviewer = Object.freeze(parseCandidate(toJsonValue(candidate)));
  const derivationForReviewer =
    derivationBinding.status === "resolved"
      ? Object.freeze(parseInsightDerivation(toJsonValue(derivationBinding.resolved.derivation)))
      : null;
  const raw = await reviewFunction.call(reviewerPort, {
    candidate: candidateForReviewer,
    evidence: evidence.records,
    derivation: derivationForReviewer,
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
  assertVerifiedPrincipal(context.identity, reviewerPrincipal, "reviewer.principal");
  const currentDerivationBinding = await revalidateCandidateDerivation(context, currentCandidate);
  assertIndependentReviewer(context, currentCandidate, reviewerRef, reviewerImplementation, currentDerivationBinding);
  assertReviewableDerivation(currentDerivationBinding);
  const currentLineageDiagnostics = await candidateLineageDiagnostics(context, currentCandidate);
  if (currentLineageDiagnostics.length > 0) {
    throw new LearningLoopError("review.lineage_invalid", currentLineageDiagnostics);
  }
  assertReviewableEvidence(await revalidateCandidateEvidence(context, currentCandidate));
  await assertReviewableAdmission(context, currentCandidate);

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

  await appendCandidateReviewReference(context, currentCandidate, review);

  const status = await createOnly(context, "review", review.id, review, `review/${review.id}`);
  if (status === "conflict") {
    throw refusal(
      "store.conflict",
      `review "${review.id}" already exists with different content; reviews are create-only`,
    );
  }
  const terminalStored = await loadStoredRecord(context, "review", review.id);
  if (terminalStored === undefined) {
    throw refusal("store.corrupt", "review receipt was not preserved after a successful write");
  }
  const terminalReview = parseCandidateReview(terminalStored.value);
  if (terminalReview.id !== review.id || !sameCanonicalValue(terminalReview, review)) {
    throw refusal("store.corrupt", "terminal review bytes differ from the exact indexed result");
  }
  return terminalReview;
}
