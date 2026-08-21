// Private, inert records for one advisory semantic review of an exact
// Candidate. An assessment is advisory_uncalibrated by construction: it is not
// a CandidateReview, proposal admission, publication, activation, validation,
// authority, calibration, utility, or efficacy claim, and provider finding
// prose never enters durable bytes — only keyed digests and exact lengths.
import { Buffer } from "node:buffer";
import type { JsonValue } from "../canonical/json.js";
import { toJsonValue } from "../canonical/to-json-value.js";
import { invalid, parseOneOf } from "../parse/toolkit.js";
import type { Parse } from "../parse/toolkit.js";
import type { PrincipalRef } from "../records/principal.js";
import { parsePrincipalRefAt } from "../records/principal.js";
import {
  assertSortedUnique,
  digestOf,
  parseDigestAt,
  parseDurableId,
  parseId,
  parseNullable,
  parseSemVer,
  parseStatement,
} from "../records/semantic-shared.js";
import type { SemanticResultBinding } from "./semantic-turn-outcome.js";
import { parseSemanticResultBinding, semanticNormalizedResultDigest } from "./semantic-turn-outcome.js";
import { canonicalJsonText } from "../canonical/canonical-json.js";
import {
  parseSemanticWorkflowArray as parseBoundedArray,
  readSemanticWorkflowFields as readFields,
} from "./workflow-structure.js";

export const SEMANTIC_ADVISORY_MAX_FINDINGS = 100;

const REVIEW_KEY_DOMAIN = "semantic-workflow-advisory-review-key:v1";
const SUBJECT_DOMAIN = "semantic-workflow-advisory-subject:v1";
const EVIDENCE_SET_DOMAIN = "semantic-workflow-advisory-evidence-set:v1";
const ADMISSION_LINEAGE_DOMAIN = "semantic-workflow-advisory-admission-lineage:v1";
const PLAN_LOCK_DOMAIN = "semantic-workflow-advisory-plan-lock:v1";
const ATTEMPT_INDEX_DOMAIN = "semantic-workflow-advisory-attempt-index:v1";
const ASSESSMENT_DOMAIN = "semantic-workflow-advisory-assessment:v1";
const COMPLETION_INTENT_DOMAIN = "semantic-workflow-advisory-completion-intent:v1";

const RECOMMENDATIONS = ["support", "revise", "oppose", "escalate"] as const;
const FINDING_SEVERITIES = ["info", "warning", "blocking"] as const;
const NOT_SUBJECT_REASONS = [
  "manual",
  "recurrence_unbound",
  "policy_unconfigured",
  "historical_pre_admission",
] as const;
const ADMISSION_BASES = [
  "group_available",
  "required_supersession",
  "rejection_override",
  "historical_supersession",
] as const;

export type AdvisoryRecommendation = (typeof RECOMMENDATIONS)[number];

export type AdvisoryAdmissionProjection =
  | {
      readonly status: "not_subject";
      readonly reason: (typeof NOT_SUBJECT_REASONS)[number];
    }
  | {
      readonly status: "resolved" | "historical";
      readonly bindingDigest: string;
      readonly reservationKeyDigest: string;
      readonly reservationDigest: string;
      readonly snapshotDigest: string;
      readonly policyDigest: string;
      readonly basis: (typeof ADMISSION_BASES)[number];
    };

export interface AdvisoryAssessmentFinding {
  readonly code: string;
  readonly severity: (typeof FINDING_SEVERITIES)[number];
  readonly statementKeyedDigest: string;
  readonly statementByteLength: number;
}

export interface SemanticAdvisoryReviewer {
  readonly principal: PrincipalRef;
  readonly attestation: { readonly id: string; readonly digest: string };
  readonly implementation: { readonly id: string; readonly version: string; readonly digest: string };
  readonly modelFingerprintDigest: string;
  readonly promptDigest: string;
  readonly rendererDigest: string;
  readonly outputSchemaDigest: string;
  readonly toolPolicyDigest: string;
  readonly budgetPolicyDigest: string;
  readonly calibration: {
    readonly status: "unverified";
    readonly calibrationId: null;
    readonly calibrationDigest: null;
  };
}

export interface SemanticAdvisoryAssessment {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly turnKeyDigest: string;
  readonly reservationDigest: string;
  readonly resultBindingDigest: string;
  readonly definitionDigest: string;
  readonly qualification: "advisory_uncalibrated";
  readonly candidateId: string;
  readonly candidateDigest: string;
  readonly scopeDigest: string;
  readonly advisoryRecommendation: AdvisoryRecommendation;
  readonly findings: readonly AdvisoryAssessmentFinding[];
  readonly keyPolicyDigest: string;
  readonly subjectSnapshotDigest: string;
  readonly evidenceSetDigest: string;
  readonly derivationRef: {
    readonly id: string;
    readonly derivationDigest: string;
    readonly scopeDigest: string;
  } | null;
  readonly admission: AdvisoryAdmissionProjection;
  readonly admissionLineageDigest: string;
  readonly reviewer: SemanticAdvisoryReviewer;
  readonly assessmentDigest: string;
}

export interface SemanticAdvisoryReviewPlanLock {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly reviewKeyDigest: string;
  readonly turnKeyDigest: string;
  readonly reservationId: string;
  readonly reservationDigest: string;
  readonly definitionDigest: string;
  readonly scopeDigest: string;
  readonly candidateId: string;
  readonly candidateDigest: string;
  readonly request: {
    readonly byteLength: number;
    readonly estimatedInputTokens: number;
    readonly minimizedBytesDigest: string;
    readonly keyPolicyDigest: string;
  };
  readonly lockDigest: string;
}

export interface SemanticAdvisoryAttemptIndex {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly attemptId: string;
  readonly scopeDigest: string;
  readonly definitionDigest: string;
  readonly reservationId: string;
  readonly reservationDigest: string;
  readonly planLockId: string;
  readonly planLockDigest: string;
  readonly reviewKeyDigest: string;
  readonly attemptDigest: string;
}

export interface SemanticAdvisoryCompletionIntent {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly reviewKeyDigest: string;
  readonly turnKeyDigest: string;
  readonly reservationDigest: string;
  readonly planLockDigest: string;
  readonly result: SemanticResultBinding;
  readonly assessment: SemanticAdvisoryAssessment;
  readonly intentDigest: string;
}

export interface AdvisoryReviewResultDraft {
  readonly advisoryRecommendation: AdvisoryRecommendation;
  readonly findings: readonly {
    readonly code: string;
    readonly severity: (typeof FINDING_SEVERITIES)[number];
    readonly statement: string;
  }[];
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

export function semanticAdvisoryReviewKeyDigest(input: {
  readonly candidateId: string;
  readonly candidateDigest: string;
  readonly definitionDigest: string;
  readonly scopeDigest: string;
}): string {
  return digestOf({
    domain: REVIEW_KEY_DOMAIN,
    candidateId: input.candidateId,
    candidateDigest: input.candidateDigest,
    definitionDigest: input.definitionDigest,
    scopeDigest: input.scopeDigest,
  });
}

export function semanticAdvisoryEvidenceSetDigest(referenceDigests: readonly string[]): string {
  assertSortedUnique(referenceDigests, (value) => value, ["evidenceReferenceDigests"]);
  return digestOf({ domain: EVIDENCE_SET_DOMAIN, referenceDigests });
}

export function semanticAdvisorySubjectSnapshotDigest(subject: {
  readonly candidate: JsonValue;
  readonly derivation: JsonValue | null;
  readonly admission: AdvisoryAdmissionProjection;
  readonly evidenceSetDigest: string;
}): string {
  return digestOf({
    domain: SUBJECT_DOMAIN,
    candidate: subject.candidate,
    derivation: subject.derivation,
    admission: subject.admission,
    evidenceSetDigest: subject.evidenceSetDigest,
  });
}

export function semanticAdvisoryAdmissionLineageDigest(admission: AdvisoryAdmissionProjection): string {
  return digestOf({ domain: ADMISSION_LINEAGE_DOMAIN, admission });
}

const parsePositiveSafeInteger: Parse<number> = (input, path) => {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input < 1) {
    throw invalid("schema.invalid", "value must be a positive safe integer", path);
  }
  return input;
};

const parseNonnegativeSafeInteger: Parse<number> = (input, path) => {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input < 0) {
    throw invalid("schema.invalid", "value must be a nonnegative safe integer", path);
  }
  return input;
};

export const parseAdvisoryAdmissionProjectionAt: Parse<AdvisoryAdmissionProjection> = (input, path) => {
  const fields = readFields(input, path);
  const status = fields.req("status", parseOneOf(["not_subject", "resolved", "historical"] as const));
  if (status === "not_subject") {
    return { status, reason: fields.req("reason", parseOneOf(NOT_SUBJECT_REASONS)) };
  }
  return {
    status,
    bindingDigest: fields.req("bindingDigest", parseDigestAt),
    reservationKeyDigest: fields.req("reservationKeyDigest", parseDigestAt),
    reservationDigest: fields.req("reservationDigest", parseDigestAt),
    snapshotDigest: fields.req("snapshotDigest", parseDigestAt),
    policyDigest: fields.req("policyDigest", parseDigestAt),
    basis: fields.req("basis", parseOneOf(ADMISSION_BASES)),
  };
};

const parseFindingDraftAt: Parse<AdvisoryReviewResultDraft["findings"][number]> = (input, path) => {
  const fields = readFields(input, path);
  return {
    code: fields.req("code", parseId),
    severity: fields.req("severity", parseOneOf(FINDING_SEVERITIES)),
    statement: fields.req("statement", parseStatement),
  };
};

/**
 * Unknown-first parse of the typed provider result for one advisory review.
 * The model cannot supply ids, digests, principals, trust, a Candidate, a
 * Review, or an effect; it may only state a closed recommendation and bounded
 * findings. A "support" recommendation cannot carry a blocking finding.
 */
export function parseAdvisoryReviewResultDraft(input: unknown): AdvisoryReviewResultDraft {
  const fields = readFields(input, ["advisoryReviewResult"]);
  const advisoryRecommendation = fields.req("advisoryRecommendation", parseOneOf(RECOMMENDATIONS));
  const findings = fields.req(
    "findings",
    parseBoundedArray(parseFindingDraftAt, SEMANTIC_ADVISORY_MAX_FINDINGS, "advisory review findings"),
  );
  if (advisoryRecommendation === "support" && findings.some((finding) => finding.severity === "blocking")) {
    throw invalid("schema.invalid", "an advisory support recommendation cannot carry a blocking finding", ["findings"]);
  }
  return { advisoryRecommendation, findings };
}

const parseAssessmentFindingAt: Parse<AdvisoryAssessmentFinding> = (input, path) => {
  const fields = readFields(input, path);
  return {
    code: fields.req("code", parseId),
    severity: fields.req("severity", parseOneOf(FINDING_SEVERITIES)),
    statementKeyedDigest: fields.req("statementKeyedDigest", parseDigestAt),
    statementByteLength: fields.req("statementByteLength", parsePositiveSafeInteger),
  };
};

const parseReviewerAt: Parse<SemanticAdvisoryReviewer> = (input, path) => {
  const fields = readFields(input, path);
  const attestationFields = readFields(
    fields.req("attestation", (value) => value),
    [...path, "attestation"],
  );
  const implementationFields = readFields(
    fields.req("implementation", (value) => value),
    [...path, "implementation"],
  );
  const calibrationFields = readFields(
    fields.req("calibration", (value) => value),
    [...path, "calibration"],
  );
  const calibrationId = calibrationFields.req("calibrationId", (value, fieldPath) => {
    if (value !== null) throw invalid("schema.invalid", "advisory reviewer calibration id must be null", fieldPath);
    return null;
  });
  const calibrationDigest = calibrationFields.req("calibrationDigest", (value, fieldPath) => {
    if (value !== null) {
      throw invalid("schema.invalid", "advisory reviewer calibration digest must be null", fieldPath);
    }
    return null;
  });
  return {
    principal: fields.req("principal", parsePrincipalRefAt),
    attestation: {
      id: attestationFields.req("id", parseId),
      digest: attestationFields.req("digest", parseDigestAt),
    },
    implementation: {
      id: implementationFields.req("id", parseId),
      version: implementationFields.req("version", parseSemVer),
      digest: implementationFields.req("digest", parseDigestAt),
    },
    modelFingerprintDigest: fields.req("modelFingerprintDigest", parseDigestAt),
    promptDigest: fields.req("promptDigest", parseDigestAt),
    rendererDigest: fields.req("rendererDigest", parseDigestAt),
    outputSchemaDigest: fields.req("outputSchemaDigest", parseDigestAt),
    toolPolicyDigest: fields.req("toolPolicyDigest", parseDigestAt),
    budgetPolicyDigest: fields.req("budgetPolicyDigest", parseDigestAt),
    calibration: {
      status: calibrationFields.req("status", parseOneOf(["unverified"])),
      calibrationId,
      calibrationDigest,
    },
  };
};

const parseDerivationRefAt: Parse<NonNullable<SemanticAdvisoryAssessment["derivationRef"]>> = (input, path) => {
  const fields = readFields(input, path);
  const derivationDigest = fields.req("derivationDigest", parseDigestAt);
  const id = fields.req("id", parseId);
  if (id !== `insight-${derivationDigest}`) {
    throw invalid("schema.corrupt", "assessment derivation id does not match its digest", [...path, "id"]);
  }
  return { id, derivationDigest, scopeDigest: fields.req("scopeDigest", parseDigestAt) };
};

function assessmentContent(input: Omit<SemanticAdvisoryAssessment, "schemaVersion" | "id" | "assessmentDigest">) {
  return {
    domain: ASSESSMENT_DOMAIN,
    turnKeyDigest: input.turnKeyDigest,
    reservationDigest: input.reservationDigest,
    resultBindingDigest: input.resultBindingDigest,
    definitionDigest: input.definitionDigest,
    qualification: input.qualification,
    candidateId: input.candidateId,
    candidateDigest: input.candidateDigest,
    scopeDigest: input.scopeDigest,
    advisoryRecommendation: input.advisoryRecommendation,
    findings: input.findings,
    keyPolicyDigest: input.keyPolicyDigest,
    subjectSnapshotDigest: input.subjectSnapshotDigest,
    evidenceSetDigest: input.evidenceSetDigest,
    derivationRef: input.derivationRef,
    admission: input.admission,
    admissionLineageDigest: input.admissionLineageDigest,
    reviewer: input.reviewer,
  };
}

export function semanticAdvisoryAssessmentDigest(
  input: Omit<SemanticAdvisoryAssessment, "schemaVersion" | "id" | "assessmentDigest">,
): string {
  return digestOf(assessmentContent(input));
}

/**
 * The advisory normalized result is the digested projection of the provider
 * draft. Provider statement prose is never part of it, so a durable result
 * binding retains only structural lengths and tenant-keyed digests.
 */
export function advisoryNormalizedResult(
  input: Pick<SemanticAdvisoryAssessment, "advisoryRecommendation" | "findings">,
): JsonValue {
  return toJsonValue({
    advisoryRecommendation: input.advisoryRecommendation,
    findings: input.findings.map((finding) => ({
      code: finding.code,
      severity: finding.severity,
      statementKeyedDigest: finding.statementKeyedDigest,
      statementByteLength: finding.statementByteLength,
    })),
  });
}

export function parseSemanticAdvisoryAssessment(input: unknown): SemanticAdvisoryAssessment {
  const fields = readFields(input, []);
  const schemaVersion = fields.schemaVersion1();
  const scopeDigest = fields.req("scopeDigest", parseDigestAt);
  const advisoryRecommendation = fields.req("advisoryRecommendation", parseOneOf(RECOMMENDATIONS));
  const findings = fields.req(
    "findings",
    parseBoundedArray(parseAssessmentFindingAt, SEMANTIC_ADVISORY_MAX_FINDINGS, "advisory assessment findings"),
  );
  if (advisoryRecommendation === "support" && findings.some((finding) => finding.severity === "blocking")) {
    throw invalid("schema.corrupt", "an advisory support assessment cannot carry a blocking finding", ["findings"]);
  }
  const derivationRef = fields.req("derivationRef", parseNullable(parseDerivationRefAt));
  if (derivationRef !== null && derivationRef.scopeDigest !== scopeDigest) {
    throw invalid("schema.corrupt", "assessment derivation reference belongs to another scope", [
      "derivationRef",
      "scopeDigest",
    ]);
  }
  const admission = fields.req("admission", parseAdvisoryAdmissionProjectionAt);
  const admissionLineageDigest = fields.req("admissionLineageDigest", parseDigestAt);
  if (admissionLineageDigest !== semanticAdvisoryAdmissionLineageDigest(admission)) {
    throw invalid("schema.corrupt", "assessment admission lineage digest does not match its projection", [
      "admissionLineageDigest",
    ]);
  }
  const base = {
    turnKeyDigest: fields.req("turnKeyDigest", parseDigestAt),
    reservationDigest: fields.req("reservationDigest", parseDigestAt),
    resultBindingDigest: fields.req("resultBindingDigest", parseDigestAt),
    definitionDigest: fields.req("definitionDigest", parseDigestAt),
    qualification: fields.req("qualification", parseOneOf(["advisory_uncalibrated"] as const)),
    candidateId: fields.req("candidateId", parseDurableId),
    candidateDigest: fields.req("candidateDigest", parseDigestAt),
    scopeDigest,
    advisoryRecommendation,
    findings,
    keyPolicyDigest: fields.req("keyPolicyDigest", parseDigestAt),
    subjectSnapshotDigest: fields.req("subjectSnapshotDigest", parseDigestAt),
    evidenceSetDigest: fields.req("evidenceSetDigest", parseDigestAt),
    derivationRef,
    admission,
    admissionLineageDigest,
    reviewer: fields.req("reviewer", parseReviewerAt),
  };
  const assessmentDigest = fields.req("assessmentDigest", parseDigestAt);
  if (assessmentDigest !== semanticAdvisoryAssessmentDigest(base)) {
    throw invalid("schema.corrupt", "advisory assessment digest does not match its bound fields", ["assessmentDigest"]);
  }
  const id = fields.req("id", parseDurableId);
  if (id !== `semantic-review-assessment-${assessmentDigest}`) {
    throw invalid("schema.corrupt", "advisory assessment id does not match its digest", ["id"]);
  }
  return deepFreeze({ schemaVersion, id, ...base, assessmentDigest });
}

export function buildSemanticAdvisoryAssessment(
  input: Omit<SemanticAdvisoryAssessment, "schemaVersion" | "id" | "assessmentDigest">,
): SemanticAdvisoryAssessment {
  const assessmentDigest = semanticAdvisoryAssessmentDigest(input);
  return parseSemanticAdvisoryAssessment({
    schemaVersion: 1,
    id: `semantic-review-assessment-${assessmentDigest}`,
    ...input,
    assessmentDigest,
  });
}

function planLockDigest(input: Omit<SemanticAdvisoryReviewPlanLock, "schemaVersion" | "id" | "lockDigest">): string {
  return digestOf({ domain: PLAN_LOCK_DOMAIN, ...input });
}

export function parseSemanticAdvisoryReviewPlanLock(input: unknown): SemanticAdvisoryReviewPlanLock {
  const fields = readFields(input, []);
  const schemaVersion = fields.schemaVersion1();
  const requestFields = readFields(
    fields.req("request", (value) => value),
    ["request"],
  );
  const base = {
    reviewKeyDigest: fields.req("reviewKeyDigest", parseDigestAt),
    turnKeyDigest: fields.req("turnKeyDigest", parseDigestAt),
    reservationId: fields.req("reservationId", parseDurableId),
    reservationDigest: fields.req("reservationDigest", parseDigestAt),
    definitionDigest: fields.req("definitionDigest", parseDigestAt),
    scopeDigest: fields.req("scopeDigest", parseDigestAt),
    candidateId: fields.req("candidateId", parseDurableId),
    candidateDigest: fields.req("candidateDigest", parseDigestAt),
    request: {
      byteLength: requestFields.req("byteLength", parsePositiveSafeInteger),
      estimatedInputTokens: requestFields.req("estimatedInputTokens", parseNonnegativeSafeInteger),
      minimizedBytesDigest: requestFields.req("minimizedBytesDigest", parseDigestAt),
      keyPolicyDigest: requestFields.req("keyPolicyDigest", parseDigestAt),
    },
  };
  if (
    base.reviewKeyDigest !==
    semanticAdvisoryReviewKeyDigest({
      candidateId: base.candidateId,
      candidateDigest: base.candidateDigest,
      definitionDigest: base.definitionDigest,
      scopeDigest: base.scopeDigest,
    })
  ) {
    throw invalid("schema.corrupt", "advisory plan lock review key does not match its subject", ["reviewKeyDigest"]);
  }
  const id = fields.req("id", parseDurableId);
  if (id !== `semantic-workflow-advisory-plan-${base.reviewKeyDigest}`) {
    throw invalid("schema.corrupt", "advisory plan lock id does not match its review key", ["id"]);
  }
  const lockDigest = fields.req("lockDigest", parseDigestAt);
  if (lockDigest !== planLockDigest(base)) {
    throw invalid("schema.corrupt", "advisory plan lock digest does not match its exact content", ["lockDigest"]);
  }
  return deepFreeze({ schemaVersion, id, ...base, lockDigest });
}

export function buildSemanticAdvisoryReviewPlanLock(
  input: Omit<SemanticAdvisoryReviewPlanLock, "schemaVersion" | "id" | "lockDigest">,
): SemanticAdvisoryReviewPlanLock {
  return parseSemanticAdvisoryReviewPlanLock({
    schemaVersion: 1,
    id: `semantic-workflow-advisory-plan-${input.reviewKeyDigest}`,
    ...input,
    lockDigest: planLockDigest(input),
  });
}

function attemptIndexDigest(
  input: Omit<SemanticAdvisoryAttemptIndex, "schemaVersion" | "id" | "attemptDigest">,
): string {
  return digestOf({ domain: ATTEMPT_INDEX_DOMAIN, ...input });
}

export function parseSemanticAdvisoryAttemptIndex(input: unknown): SemanticAdvisoryAttemptIndex {
  const fields = readFields(input, []);
  const schemaVersion = fields.schemaVersion1();
  const base = {
    attemptId: fields.req("attemptId", parseDurableId),
    scopeDigest: fields.req("scopeDigest", parseDigestAt),
    definitionDigest: fields.req("definitionDigest", parseDigestAt),
    reservationId: fields.req("reservationId", parseDurableId),
    reservationDigest: fields.req("reservationDigest", parseDigestAt),
    planLockId: fields.req("planLockId", parseDurableId),
    planLockDigest: fields.req("planLockDigest", parseDigestAt),
    reviewKeyDigest: fields.req("reviewKeyDigest", parseDigestAt),
  };
  const id = fields.req("id", parseDurableId);
  if (id !== base.attemptId || id !== `semantic-workflow-advisory-attempt-${base.reviewKeyDigest}`) {
    throw invalid("schema.corrupt", "advisory attempt identity does not match its review key", ["id"]);
  }
  if (base.planLockId !== `semantic-workflow-advisory-plan-${base.reviewKeyDigest}`) {
    throw invalid("schema.corrupt", "advisory attempt plan lock id does not match its review key", ["planLockId"]);
  }
  const attemptDigest = fields.req("attemptDigest", parseDigestAt);
  if (attemptDigest !== attemptIndexDigest(base)) {
    throw invalid("schema.corrupt", "advisory attempt digest does not match its exact content", ["attemptDigest"]);
  }
  return deepFreeze({ schemaVersion, id, ...base, attemptDigest });
}

export function buildSemanticAdvisoryAttemptIndex(
  input: Omit<SemanticAdvisoryAttemptIndex, "schemaVersion" | "id" | "attemptDigest">,
): SemanticAdvisoryAttemptIndex {
  return parseSemanticAdvisoryAttemptIndex({
    schemaVersion: 1,
    id: input.attemptId,
    ...input,
    attemptDigest: attemptIndexDigest(input),
  });
}

function completionIntentDigest(
  input: Omit<SemanticAdvisoryCompletionIntent, "schemaVersion" | "id" | "intentDigest">,
): string {
  return digestOf({ domain: COMPLETION_INTENT_DOMAIN, ...input });
}

export function parseSemanticAdvisoryCompletionIntent(input: unknown): SemanticAdvisoryCompletionIntent {
  const fields = readFields(input, []);
  const schemaVersion = fields.schemaVersion1();
  const base = {
    reviewKeyDigest: fields.req("reviewKeyDigest", parseDigestAt),
    turnKeyDigest: fields.req("turnKeyDigest", parseDigestAt),
    reservationDigest: fields.req("reservationDigest", parseDigestAt),
    planLockDigest: fields.req("planLockDigest", parseDigestAt),
    result: fields.req("result", parseSemanticResultBinding),
    assessment: fields.req("assessment", parseSemanticAdvisoryAssessment),
  };
  const id = fields.req("id", parseDurableId);
  if (id !== `semantic-workflow-advisory-completion-${base.reviewKeyDigest}`) {
    throw invalid("schema.corrupt", "advisory completion intent id does not match its review key", ["id"]);
  }
  const expectedNormalized = advisoryNormalizedResult(base.assessment);
  if (
    base.result.status !== "completed" ||
    base.result.turnKeyDigest !== base.turnKeyDigest ||
    base.result.reservationDigest !== base.reservationDigest ||
    base.assessment.turnKeyDigest !== base.turnKeyDigest ||
    base.assessment.reservationDigest !== base.reservationDigest ||
    base.assessment.resultBindingDigest !== base.result.bindingDigest ||
    base.reviewKeyDigest !==
      semanticAdvisoryReviewKeyDigest({
        candidateId: base.assessment.candidateId,
        candidateDigest: base.assessment.candidateDigest,
        definitionDigest: base.assessment.definitionDigest,
        scopeDigest: base.assessment.scopeDigest,
      }) ||
    base.result.normalizedResult === null ||
    canonicalJsonText(base.result.normalizedResult) !== canonicalJsonText(expectedNormalized) ||
    base.result.normalizedResultDigest !== semanticNormalizedResultDigest(expectedNormalized)
  ) {
    throw invalid("schema.corrupt", "advisory completion intent graph is not exactly reciprocal", []);
  }
  const intentDigest = fields.req("intentDigest", parseDigestAt);
  if (intentDigest !== completionIntentDigest(base)) {
    throw invalid("schema.corrupt", "advisory completion intent digest does not match its graph", ["intentDigest"]);
  }
  return deepFreeze({ schemaVersion, id, ...base, intentDigest });
}

export function buildSemanticAdvisoryCompletionIntent(
  input: Omit<SemanticAdvisoryCompletionIntent, "schemaVersion" | "id" | "intentDigest">,
): SemanticAdvisoryCompletionIntent {
  return parseSemanticAdvisoryCompletionIntent({
    schemaVersion: 1,
    id: `semantic-workflow-advisory-completion-${input.reviewKeyDigest}`,
    ...input,
    intentDigest: completionIntentDigest(input),
  });
}

/** Exact statement measurement: UTF-8 byte length of the exact provider prose. */
export function advisoryStatementByteLength(statement: string): number {
  return Buffer.byteLength(statement, "utf8");
}
