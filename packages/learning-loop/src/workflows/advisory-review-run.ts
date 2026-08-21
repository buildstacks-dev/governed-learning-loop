// Advisory semantic review of one exact Candidate (#13c). Preparation is
// zero-write and zero-provider-call; a run persists reservation, advisory
// plan lock, outbound authorization, and the scope-and-definition attempt
// index before one create-only dispatch claim and at most one provider
// callback. The completed output is an advisory_uncalibrated assessment —
// never a Candidate, decisive Review, admission, publication, activation,
// effect, authority, calibration, utility, or efficacy claim.
import { Buffer } from "node:buffer";
import { canonicalJsonText } from "../canonical/canonical-json.js";
import { toJsonValue } from "../canonical/to-json-value.js";
import type { JsonValue } from "../canonical/json.js";
import { invalid } from "../parse/toolkit.js";
import { LearningLoopError } from "../diagnostics.js";
import type { Diagnostic } from "../diagnostics.js";
import { assertVerifiedPrincipal } from "../engine/identity.js";
import type { EngineContext } from "../engine/context.js";
import { effectiveRisk, loadCandidate, loadStoredRecord } from "../engine/context.js";
import { loadCandidateScopeMembership } from "../engine/candidate-scope-index.js";
import { revalidateCandidateDerivation } from "../engine/derivation-binding.js";
import { loadCandidateAdmissionLineageRecords } from "../engine/recurrence-admission.js";
import type { Candidate, CandidateV2 } from "../records/candidate.js";
import type { EvidenceRef } from "../records/evidence-ref.js";
import type { InsightDerivation } from "../records/insight-derivation.js";
import type { PrincipalRef } from "../records/principal.js";
import type { Scope } from "../records/scope.js";
import { digestOf, parseDurableId, scopeDigest } from "../records/semantic-shared.js";
import type { SemanticDisclosureAuthorization, SemanticTurnReservation } from "./semantic-turn-intent.js";
import {
  buildSemanticDisclosureAuthorization,
  buildSemanticTurnReservation,
  parseSemanticTurnReservation,
} from "./semantic-turn-intent.js";
import type { SemanticDispatchMarker, SemanticResultBinding, SemanticTurnReceipt } from "./semantic-turn-outcome.js";
import {
  buildSemanticResultBinding,
  buildSemanticTurnReceipt,
  buildSemanticTurnScopeIndex,
  semanticNormalizedResultDigest,
} from "./semantic-turn-outcome.js";
import {
  claimSemanticDispatch,
  loadRequiredGlobal,
  loadSemanticDefinitionTurn,
  persistSemanticDisclosureAuthorization,
  persistSemanticTurnReservation,
} from "./semantic-turn-persistence.js";
import type {
  AdvisoryAdmissionProjection,
  SemanticAdvisoryAssessment,
  SemanticAdvisoryCompletionIntent,
} from "./advisory-review-record.js";
import {
  advisoryNormalizedResult,
  advisoryStatementByteLength,
  buildSemanticAdvisoryAssessment,
  buildSemanticAdvisoryAttemptIndex,
  buildSemanticAdvisoryCompletionIntent,
  buildSemanticAdvisoryReviewPlanLock,
  parseAdvisoryReviewResultDraft,
  semanticAdvisoryAdmissionLineageDigest,
  semanticAdvisoryEvidenceSetDigest,
  semanticAdvisoryReviewKeyDigest,
  semanticAdvisorySubjectSnapshotDigest,
} from "./advisory-review-record.js";
import {
  classifySemanticAdvisoryTurnPersistence,
  loadSemanticAdvisoryAssessment,
  loadSemanticAdvisoryAttempt,
  loadSemanticAdvisoryCompletionIntent,
  loadSemanticAdvisoryReviewPlan,
  persistSemanticAdvisoryAttempt,
  persistSemanticAdvisoryCompletionIntent,
  persistSemanticAdvisoryReviewPlan,
  persistSemanticCompletedAdvisory,
  persistSemanticCompletedAdvisoryTerminal,
} from "./advisory-review-persistence.js";
import type { SemanticWorkflowBundle } from "./types.js";
import type { SemanticWorkflowDefinition } from "./workflow-definition.js";
import { SEMANTIC_WORKFLOW_MAX_DURATION_MS } from "./workflow-definition.js";
import {
  assertSemanticWorkflowStructureBound,
  readSemanticWorkflowFields as readFields,
  snapshotSemanticWorkflowJson,
} from "./workflow-structure.js";
import { ADVISORY_REVIEW_RESULT_SCHEMA_ID, ADVISORY_REVIEW_RESULT_SCHEMA_VERSION } from "./generation-schema.js";
import type {
  AdvisoryCapabilityCallbacks,
  AdvisoryPreparedPlanBinding,
  SemanticAdvisoryReviewSubject,
} from "./generation-internal.js";
import { advisoryPreparedPlans, authorizationCapabilities, bytesOf } from "./generation-internal.js";
import {
  authorizationFor,
  buildKnownFailureResult,
  commitNoncompletedTurn,
  invokeProviderWithTimeout,
  parseCanonicalTimestamp,
  parseKeyedDigest,
  parseProviderEnvelope,
  usageExceedsBudget,
  usageMeasurementInvalid,
} from "./run-shared.js";

type RunAdvisoryResult = Awaited<ReturnType<SemanticWorkflowBundle["runAdvisoryReview"]>>;
type AssessmentView = NonNullable<RunAdvisoryResult["assessment"]>;

export function advisoryAssessmentView(assessment: SemanticAdvisoryAssessment): AssessmentView {
  return {
    id: assessment.id,
    assessmentDigest: assessment.assessmentDigest,
    qualification: assessment.qualification,
    candidateId: assessment.candidateId,
    candidateDigest: assessment.candidateDigest,
    advisoryRecommendation: assessment.advisoryRecommendation,
    findings: assessment.findings,
    subjectSnapshotDigest: assessment.subjectSnapshotDigest,
    evidenceSetDigest: assessment.evidenceSetDigest,
    derivationRef: assessment.derivationRef,
    admission: assessment.admission,
    admissionLineageDigest: assessment.admissionLineageDigest,
    reviewer: assessment.reviewer,
  };
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function subjectUnavailable(code: string): {
  readonly status: "incomplete";
  readonly preview: null;
  readonly diagnostics: readonly Diagnostic[];
} {
  return {
    status: "incomplete",
    preview: null,
    diagnostics: [{ code, severity: "warning", message: "advisory review subject is unavailable" }],
  };
}

function parseNonnegativeInteger(input: unknown, path: readonly (string | number)[]): number {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input < 0) {
    throw invalid("schema.invalid", "value must be a nonnegative safe integer", path);
  }
  return input;
}

function estimateTokens(callback: AdvisoryCapabilityCallbacks["estimateInputTokens"], bytes: Uint8Array): number {
  return parseNonnegativeInteger(callback(new Uint8Array(bytes)), ["tokenEstimator", "result"]);
}

function validatedScope(context: EngineContext, input: unknown): Scope {
  return Object.freeze(
    context.scopePolicy.validate(input).map((segment) => Object.freeze({ type: segment.type, id: segment.id })),
  );
}

function evidenceSourceIds(candidate: CandidateV2, derivation: InsightDerivation | null): readonly string[] {
  const references: EvidenceRef[] = [...candidate.evidenceRefs];
  if (derivation !== null) {
    references.push(...derivation.directObservation.evidenceRefs, ...derivation.contradictoryEvidenceRefs);
  }
  return [...new Set(references.map((reference) => reference.sourceId))];
}

function sourcePoliciesForSubject(
  context: EngineContext,
  definition: SemanticWorkflowDefinition,
  sourceIds: readonly string[],
) {
  const sources = new Map([...context.sources].map((source) => [source.id, source]));
  return sourceIds
    .map((sourceId) => {
      const source = sources.get(sourceId);
      const policy = source === undefined ? undefined : context.contentPoliciesById.get(source.contentPolicyId);
      if (source === undefined || policy === undefined) {
        throw invalid("semantic.workflow_disclosure_forbidden", "advisory subject source policy is unavailable", []);
      }
      if (definition.transport === "outbound" && policy.outboundUse !== "explicit_receipt_required") {
        throw invalid("semantic.workflow_disclosure_forbidden", "source content policy forbids outbound use", []);
      }
      return {
        sourceId: source.id,
        contentPolicyId: policy.id,
        contentPolicyDigest: policy.digest,
        outboundUse: policy.outboundUse,
      };
    })
    .sort((left, right) => compareText(canonicalJsonText(toJsonValue(left)), canonicalJsonText(toJsonValue(right))));
}

/**
 * Kernel invariant 2 at the advisory boundary: the definition's reviewer must
 * not be the proposer, must not be the derivation producer or share its
 * independence domain or implementation, and — when the effective risk policy
 * demands it — must not share the proposer's independence domain.
 */
function assertReviewerIndependence(
  context: EngineContext,
  definition: SemanticWorkflowDefinition,
  candidate: Candidate,
  producerPrincipal: PrincipalRef | null,
  producerImplementation: { readonly id: string; readonly version: string } | undefined,
): void {
  const reviewer = definition.principal;
  const riskRule = context.policyRules.risks[effectiveRisk(context, candidate)];
  if (
    reviewer.id === candidate.proposedBy.id ||
    (riskRule.independentDomain && reviewer.independenceDomain === candidate.proposedBy.independenceDomain) ||
    (producerPrincipal !== null &&
      (reviewer.id === producerPrincipal.id || reviewer.independenceDomain === producerPrincipal.independenceDomain)) ||
    (producerImplementation !== undefined &&
      definition.implementation.id === producerImplementation.id &&
      definition.implementation.version === producerImplementation.version)
  ) {
    throw invalid(
      "semantic.workflow_reviewer_not_independent",
      "advisory reviewer is not independent from the proposal lineage",
      [],
    );
  }
}

interface ResolvedAdvisorySubject {
  readonly candidate: CandidateV2;
  readonly derivation: InsightDerivation | null;
  readonly producerPrincipal: PrincipalRef | null;
  readonly producerImplementation: { readonly id: string; readonly version: string } | undefined;
  readonly admission: AdvisoryAdmissionProjection;
  readonly subject: SemanticAdvisoryReviewSubject;
  readonly subjectSnapshotDigest: string;
  readonly evidenceSetDigest: string;
  readonly admissionLineageDigest: string;
}

/**
 * Resolves the exact immutable review subject. Every consulted fact —
 * recurrence lock, derivation, admission binding, scope membership — is
 * create-only and durably precedes the Candidate receipt, so a loaded
 * Candidate's subject graph cannot change under this read.
 */
async function resolveAdvisorySubject(
  context: EngineContext,
  exactScopeDigest: string,
  candidateId: string,
): Promise<
  { readonly status: "incomplete"; readonly code: string } | ({ readonly status: "ready" } & ResolvedAdvisorySubject)
> {
  const membership = await loadCandidateScopeMembership(context, { scopeDigest: exactScopeDigest, candidateId });
  if (membership === undefined) return { status: "incomplete", code: "workflow.candidate_unavailable" };
  const candidate = await loadCandidate(context, candidateId);
  if (
    candidate === undefined ||
    candidate.contentDigest !== membership.candidateDigest ||
    scopeDigest(candidate.scope) !== exactScopeDigest
  ) {
    return { status: "incomplete", code: "workflow.candidate_unavailable" };
  }
  if (candidate.schemaVersion !== 2) {
    return { status: "incomplete", code: "workflow.candidate_legacy_unbound" };
  }
  const derivationBinding = await revalidateCandidateDerivation(context, candidate);
  if (derivationBinding.status === "invalid") {
    return { status: "incomplete", code: "workflow.candidate_derivation_invalid" };
  }
  const derivation = derivationBinding.status === "resolved" ? derivationBinding.resolved.derivation : null;
  const producerPrincipal =
    derivationBinding.status === "resolved" ? derivationBinding.resolved.producerPrincipal : null;
  const producerImplementation =
    derivationBinding.status === "resolved" ? derivationBinding.resolved.producerImplementation : undefined;
  const admissionRecords = await loadCandidateAdmissionLineageRecords(context, candidate);
  if (admissionRecords.status === "invalid") {
    return { status: "incomplete", code: "workflow.candidate_admission_invalid" };
  }
  const admission: AdvisoryAdmissionProjection =
    admissionRecords.status === "not_subject"
      ? { status: "not_subject", reason: admissionRecords.reason }
      : {
          status: admissionRecords.policyStatus === "configured" ? "resolved" : "historical",
          bindingDigest: admissionRecords.binding.bindingDigest,
          reservationKeyDigest: admissionRecords.binding.reservationKeyDigest,
          reservationDigest: admissionRecords.binding.reservationDigest,
          snapshotDigest: admissionRecords.binding.snapshotDigest,
          policyDigest: admissionRecords.binding.policyDigest,
          basis: admissionRecords.reservation.basis,
        };
  const evidenceSetDigest = semanticAdvisoryEvidenceSetDigest(
    [...candidate.evidenceRefs.map((reference) => reference.referenceDigest)].sort(compareText),
  );
  const subject: SemanticAdvisoryReviewSubject = {
    schemaVersion: 1,
    candidate: toJsonValue(candidate),
    derivation: derivation === null ? null : toJsonValue(derivation),
    admission,
    evidenceSetDigest,
  };
  return {
    status: "ready",
    candidate,
    derivation,
    producerPrincipal,
    producerImplementation,
    admission,
    subject,
    subjectSnapshotDigest: semanticAdvisorySubjectSnapshotDigest(subject),
    evidenceSetDigest,
    admissionLineageDigest: semanticAdvisoryAdmissionLineageDigest(admission),
  };
}

function renderAdvisoryRequest(
  callbacks: AdvisoryCapabilityCallbacks,
  definition: SemanticWorkflowDefinition,
  subject: SemanticAdvisoryReviewSubject,
  subjectSnapshotDigest: string,
): {
  readonly text: string;
  readonly byteLength: number;
  readonly digest: string;
  readonly estimatedInputTokens: number;
} {
  const rendered = callbacks.render({ subject, definitionDigest: definition.definitionDigest });
  assertSemanticWorkflowStructureBound(rendered);
  const minimized = callbacks.minimize({ rendered, subjectSnapshotDigest });
  assertSemanticWorkflowStructureBound(minimized);
  const instructions = toJsonValue(minimized);
  const text = canonicalJsonText(
    toJsonValue({
      schemaVersion: 1,
      definition: {
        id: definition.id,
        version: definition.version,
        definitionDigest: definition.definitionDigest,
      },
      prompt: definition.prompt,
      instructions,
      subject,
    }),
  );
  const bytes = bytesOf(text);
  if (bytes.byteLength < 1 || bytes.byteLength > definition.budgetPolicy.maximumRequestBytes) {
    throw invalid("semantic.workflow_limit", "minimized advisory request exceeds its byte budget", []);
  }
  const digest = parseKeyedDigest(callbacks.digest, bytes);
  const estimatedInputTokens = estimateTokens(callbacks.estimateInputTokens, bytes);
  if (estimatedInputTokens > definition.budgetPolicy.maximumInputTokens) {
    throw invalid("semantic.workflow_limit", "advisory request exceeds its input-token budget", []);
  }
  return { text, byteLength: bytes.byteLength, digest, estimatedInputTokens };
}

export async function prepareAdvisoryReview(
  token: object,
  context: EngineContext,
  definition: SemanticWorkflowDefinition,
  callbacks: AdvisoryCapabilityCallbacks,
  input: unknown,
): ReturnType<SemanticWorkflowBundle["prepareAdvisoryReview"]> {
  const fields = readFields(input, ["prepareAdvisoryReview"]);
  const candidateId = fields.req("candidateId", parseDurableId);
  const scope = validatedScope(
    context,
    fields.req("scope", (value) => value),
  );
  const expiresAt = fields.req("expiresAt", parseCanonicalTimestamp);
  const now = Date.parse(context.clock.now());
  const expiry = Date.parse(expiresAt);
  if (expiry <= now || expiry - now > SEMANTIC_WORKFLOW_MAX_DURATION_MS) {
    throw invalid("schema.invalid", "workflow plan expiry must be within the next 24 hours", ["expiresAt"]);
  }
  const registry = context.semanticRegistry;
  if (registry === undefined) throw invalid("semantic.registry_required", "semantic registry is unavailable", []);
  const exactScopeDigest = scopeDigest(scope);
  const resolved = await resolveAdvisorySubject(context, exactScopeDigest, candidateId);
  if (resolved.status === "incomplete") return subjectUnavailable(resolved.code);
  assertReviewerIndependence(
    context,
    definition,
    resolved.candidate,
    resolved.producerPrincipal,
    resolved.producerImplementation,
  );
  const sourcePolicies = sourcePoliciesForSubject(
    context,
    definition,
    evidenceSourceIds(resolved.candidate, resolved.derivation),
  );
  const request = renderAdvisoryRequest(callbacks, definition, resolved.subject, resolved.subjectSnapshotDigest);
  const reviewKeyDigest = semanticAdvisoryReviewKeyDigest({
    candidateId,
    candidateDigest: resolved.candidate.contentDigest,
    definitionDigest: definition.definitionDigest,
    scopeDigest: exactScopeDigest,
  });
  const runIdDigest = digestOf({ domain: "semantic-workflow-advisory-run:v1", reviewKeyDigest });
  const reservation = buildSemanticTurnReservation({
    runId: `semantic-workflow-run-${runIdDigest}`,
    loopRegistryRevision: context.registryRevision,
    semanticRegistryDigest: registry.registryDigest,
    scopeDigest: exactScopeDigest,
    target: {
      kind: "advisory_review",
      candidateId,
      candidateDigest: resolved.candidate.contentDigest,
      derivation:
        resolved.derivation === null
          ? null
          : {
              id: resolved.derivation.id,
              derivationDigest: resolved.derivation.derivationDigest,
              scopeDigest: exactScopeDigest,
            },
      evidenceSetDigest: resolved.evidenceSetDigest,
    },
    definition,
    request: {
      mediaType: "application/json",
      encoding: "utf-8",
      byteLength: request.byteLength,
      estimatedInputTokens: request.estimatedInputTokens,
      minimizedBytesDigest: request.digest,
      keyPolicyDigest: definition.disclosurePolicy.keyPolicyDigest,
    },
    sourcePolicies,
    disclosureExpected: definition.transport === "outbound",
    expiresAt,
  });
  const planLock = buildSemanticAdvisoryReviewPlanLock({
    reviewKeyDigest,
    turnKeyDigest: reservation.turnKeyDigest,
    reservationId: reservation.id,
    reservationDigest: reservation.reservationDigest,
    definitionDigest: definition.definitionDigest,
    scopeDigest: exactScopeDigest,
    candidateId,
    candidateDigest: resolved.candidate.contentDigest,
    request: {
      byteLength: request.byteLength,
      estimatedInputTokens: request.estimatedInputTokens,
      minimizedBytesDigest: request.digest,
      keyPolicyDigest: definition.disclosurePolicy.keyPolicyDigest,
    },
  });
  const attemptId = `semantic-workflow-advisory-attempt-${reviewKeyDigest}`;
  const attempt = buildSemanticAdvisoryAttemptIndex({
    attemptId,
    scopeDigest: exactScopeDigest,
    definitionDigest: definition.definitionDigest,
    reservationId: reservation.id,
    reservationDigest: reservation.reservationDigest,
    planLockId: planLock.id,
    planLockDigest: planLock.lockDigest,
    reviewKeyDigest,
  });
  const handle = Object.freeze({});
  advisoryPreparedPlans.set(handle, {
    token,
    context,
    definition,
    callbacks,
    scope,
    candidate: resolved.candidate,
    subject: resolved.subject,
    subjectSnapshotDigest: resolved.subjectSnapshotDigest,
    admissionLineageDigest: resolved.admissionLineageDigest,
    reservation,
    planLock,
    attempt,
    requestText: request.text,
  });
  return {
    status: "prepared",
    plan: handle,
    attemptId,
    preview: {
      mediaType: "application/json",
      encoding: "utf-8",
      bytes: bytesOf(request.text),
      byteLength: request.byteLength,
      estimatedInputTokens: request.estimatedInputTokens,
      minimizedBytesDigest: request.digest,
      keyPolicyDigest: definition.disclosurePolicy.keyPolicyDigest,
    },
    candidateDigest: resolved.candidate.contentDigest,
    snapshotDigest: resolved.subjectSnapshotDigest,
  };
}

function planFor(
  token: object,
  input: unknown,
  path: readonly (string | number)[],
): { readonly handle: object; readonly binding: AdvisoryPreparedPlanBinding } {
  if (typeof input !== "object" || input === null) {
    throw invalid("semantic.workflow_plan_invalid", "advisory review plan is not a capability", path);
  }
  const binding = advisoryPreparedPlans.get(input);
  if (binding === undefined || binding.token !== token) {
    throw invalid("semantic.workflow_plan_invalid", "advisory review plan belongs to another bundle", path);
  }
  return { handle: input, binding };
}

/**
 * Twice-run current check: the exact immutable subject must still load byte
 * for byte, its admission projection and source policies must be unchanged,
 * and the plan must be unexpired. The dispatch claim separately verifies the
 * current loop/semantic registry and source-policy currency.
 */
export async function revalidateAdvisoryPlan(plan: AdvisoryPreparedPlanBinding): Promise<void> {
  if (Date.parse(plan.context.clock.now()) >= Date.parse(plan.reservation.expiresAt)) {
    throw invalid("semantic.workflow_expired", "advisory review plan has expired", []);
  }
  const target = plan.reservation.target;
  if (target.kind !== "advisory_review") throw invalid("schema.corrupt", "advisory plan has another lane", []);
  const exactScopeDigest = plan.reservation.scopeDigest;
  const resolved = await resolveAdvisorySubject(plan.context, exactScopeDigest, target.candidateId);
  if (
    resolved.status !== "ready" ||
    !(
      canonicalJsonText(toJsonValue(resolved.candidate)) === canonicalJsonText(toJsonValue(plan.candidate)) &&
      resolved.subjectSnapshotDigest === plan.subjectSnapshotDigest &&
      resolved.admissionLineageDigest === plan.admissionLineageDigest &&
      resolved.evidenceSetDigest === target.evidenceSetDigest
    )
  ) {
    throw invalid("semantic.workflow_historical", "advisory review subject changed before dispatch", []);
  }
  assertReviewerIndependence(
    plan.context,
    plan.definition,
    resolved.candidate,
    resolved.producerPrincipal,
    resolved.producerImplementation,
  );
  const currentSourcePolicies = sourcePoliciesForSubject(
    plan.context,
    plan.definition,
    evidenceSourceIds(resolved.candidate, resolved.derivation),
  );
  if (
    currentSourcePolicies.length !== plan.reservation.sourcePolicies.length ||
    !currentSourcePolicies.every(
      (policy, index) =>
        canonicalJsonText(toJsonValue(policy)) ===
        canonicalJsonText(toJsonValue(plan.reservation.sourcePolicies[index])),
    )
  ) {
    throw invalid("semantic.workflow_plan_invalid", "advisory review source policies changed", []);
  }
}

export async function authorizeAdvisoryReview(
  token: object,
  input: unknown,
): ReturnType<SemanticWorkflowBundle["authorizeAdvisoryReview"]> {
  const fields = readFields(input, ["authorizeAdvisoryReview"]);
  const exact = planFor(
    token,
    fields.req("plan", (value) => value),
    ["plan"],
  );
  const plan = exact.binding;
  if (plan.definition.transport !== "outbound" || plan.callbacks.authorize === undefined) {
    throw invalid("semantic.workflow_disclosure_forbidden", "local advisory review needs no authorization", []);
  }
  if (Date.parse(plan.context.clock.now()) >= Date.parse(plan.reservation.expiresAt)) {
    throw invalid("semantic.workflow_expired", "advisory review plan has expired", []);
  }
  const evidence = fields.req("evidence", (value) => value);
  const rawAuthorization = await plan.callbacks.authorize({
    preview: {
      mediaType: "application/json",
      encoding: "utf-8",
      bytes: bytesOf(plan.requestText),
      byteLength: plan.reservation.request.byteLength,
      estimatedInputTokens: plan.planLock.request.estimatedInputTokens,
      minimizedBytesDigest: plan.reservation.request.minimizedBytesDigest,
      keyPolicyDigest: plan.reservation.request.keyPolicyDigest,
    },
    scopeDigest: plan.reservation.scopeDigest,
    definitionDigest: plan.definition.definitionDigest,
    evidence,
  });
  const authorizationFields = readFields(rawAuthorization, ["disclosureAuthorization"]);
  const principal = authorizationFields.req("principal", (value) => value);
  assertVerifiedPrincipal(plan.context.identity, principal, "authorizer");
  const authorizedAt = authorizationFields.req("authorizedAt", parseCanonicalTimestamp);
  const expiresAt = authorizationFields.req("expiresAt", parseCanonicalTimestamp);
  const record = buildSemanticDisclosureAuthorization(plan.reservation, {
    authorizer: principal.ref,
    authorizerAttestation: { id: principal.attestationId, digest: principal.attestationDigest },
    authorizedAt,
    expiresAt,
  });
  const handle = Object.freeze({});
  authorizationCapabilities.set(handle, { token, plan: exact.handle, record });
  return { authorization: handle, authorizedAt, expiresAt };
}

interface PersistedAdvisory {
  readonly context: EngineContext;
  readonly definition: SemanticWorkflowDefinition;
  readonly reservation: SemanticTurnReservation;
}

function commitNoncompletedAdvisoryTurn(input: {
  readonly plan: PersistedAdvisory;
  readonly authorization: SemanticDisclosureAuthorization | null;
  readonly dispatch: SemanticDispatchMarker;
  readonly result: SemanticResultBinding;
}): Promise<string> {
  return commitNoncompletedTurn({
    context: input.plan.context,
    reservation: input.plan.reservation,
    definitionDigest: input.plan.definition.definitionDigest,
    lane: "advisory_review",
    authorization: input.authorization,
    dispatch: input.dispatch,
    result: input.result,
  });
}

async function completeAdvisoryFromIntent(input: {
  readonly plan: PersistedAdvisory;
  readonly authorization: SemanticDisclosureAuthorization | null;
  readonly dispatch: SemanticDispatchMarker;
  readonly intent: SemanticAdvisoryCompletionIntent;
  readonly persistence: "committed" | "existing";
  readonly callbackInvoked: boolean;
}): Promise<{
  readonly status: "completed";
  readonly persistence: "committed" | "existing";
  readonly callbackInvoked: boolean;
  readonly turnId: string;
  readonly assessment: AssessmentView;
}> {
  const { plan, authorization, dispatch, intent } = input;
  await persistSemanticCompletedAdvisory(plan.context, {
    reservation: plan.reservation,
    authorization,
    dispatch,
    result: intent.result,
    assessment: intent.assessment,
  });
  const output: SemanticTurnReceipt["output"] = {
    kind: "advisory_review",
    assessmentId: intent.assessment.id,
    assessmentDigest: intent.assessment.assessmentDigest,
  };
  const turn = buildSemanticTurnReceipt({
    turnKeyDigest: plan.reservation.turnKeyDigest,
    reservation: { id: plan.reservation.id, reservationDigest: plan.reservation.reservationDigest },
    authorization:
      authorization === null ? null : { id: authorization.id, authorizationDigest: authorization.authorizationDigest },
    dispatch: { id: dispatch.id, dispatchDigest: dispatch.dispatchDigest },
    result: { id: intent.result.id, bindingDigest: intent.result.bindingDigest },
    lane: "advisory_review",
    scopeDigest: plan.reservation.scopeDigest,
    status: "completed",
    output,
  });
  const scopeIndex = buildSemanticTurnScopeIndex({
    scopeDigest: plan.reservation.scopeDigest,
    definitionDigest: plan.definition.definitionDigest,
    turnId: turn.id,
    turnKeyDigest: turn.turnKeyDigest,
    turnDigest: turn.turnDigest,
  });
  await persistSemanticCompletedAdvisoryTerminal(plan.context, {
    graph: {
      reservation: plan.reservation,
      authorization,
      dispatch,
      result: intent.result,
      scopeIndex,
      turn,
    },
    assessment: intent.assessment,
  });
  return {
    status: "completed",
    persistence: input.persistence,
    callbackInvoked: input.callbackInvoked,
    turnId: turn.id,
    assessment: advisoryAssessmentView(intent.assessment),
  };
}

function assertAttemptMatchesAdvisoryPlan(
  winningAttempt: Awaited<ReturnType<typeof loadSemanticAdvisoryAttempt>>,
  plan: AdvisoryPreparedPlanBinding,
): void {
  if (
    winningAttempt !== undefined &&
    (winningAttempt.attemptDigest !== plan.attempt.attemptDigest ||
      winningAttempt.reservationDigest !== plan.reservation.reservationDigest ||
      winningAttempt.planLockDigest !== plan.planLock.lockDigest ||
      winningAttempt.definitionDigest !== plan.definition.definitionDigest ||
      winningAttempt.scopeDigest !== plan.reservation.scopeDigest)
  ) {
    throw invalid("store.conflict", "advisory review key is owned by another prepared request", []);
  }
}

export async function recoverAdvisoryReview(
  context: EngineContext,
  definition: SemanticWorkflowDefinition,
  input: unknown,
): ReturnType<SemanticWorkflowBundle["recoverAdvisoryReview"]> {
  const fields = readFields(input, ["recoverAdvisoryReview"]);
  const attemptId = fields.req("attemptId", parseDurableId);
  const exactScope = validatedScope(
    context,
    fields.req("scope", (value) => value),
  );
  const exactScopeDigest = scopeDigest(exactScope);
  const attempt = await loadSemanticAdvisoryAttempt(context, {
    attemptId,
    scopeDigest: exactScopeDigest,
    definitionDigest: definition.definitionDigest,
  });
  if (attempt === undefined) {
    return { status: "not_dispatched", persistence: "not_dispatched", callbackInvoked: false, turnId: null };
  }
  const reservation = await loadRequiredGlobal(
    context,
    "semantic-workflow-reservation",
    attempt.reservationId,
    parseSemanticTurnReservation,
  );
  const planLock = await loadSemanticAdvisoryReviewPlan(context, attempt.reviewKeyDigest);
  if (
    reservation.reservationDigest !== attempt.reservationDigest ||
    reservation.scopeDigest !== exactScopeDigest ||
    reservation.definition.definitionDigest !== definition.definitionDigest ||
    planLock === undefined ||
    planLock.id !== attempt.planLockId ||
    planLock.lockDigest !== attempt.planLockDigest
  ) {
    throw invalid("store.corrupt", "advisory recovery attempt is not reciprocal", []);
  }
  const persisted: PersistedAdvisory = { context, definition, reservation };
  const state = await classifySemanticAdvisoryTurnPersistence(context, reservation);
  const intent = await loadSemanticAdvisoryCompletionIntent(context, attempt.reviewKeyDigest);
  if (state.status === "not_dispatched") {
    const result = await loadStoredRecord(
      context,
      "semantic-workflow-result",
      `semantic-workflow-result-${reservation.turnKeyDigest}`,
    );
    const terminal = await loadSemanticDefinitionTurn(
      context,
      `semantic-workflow-turn-${reservation.turnKeyDigest}`,
      reservation.scopeDigest,
      definition.definitionDigest,
    );
    if (intent !== undefined || result !== undefined || terminal !== undefined) {
      throw invalid("store.corrupt", "undispatched advisory attempt has impossible output facts", []);
    }
    return { status: "not_dispatched", persistence: "not_dispatched", callbackInvoked: false, turnId: null };
  }
  if (intent !== undefined && state.status === "outcome_unknown") {
    return completeAdvisoryFromIntent({
      plan: persisted,
      authorization: state.authorization,
      dispatch: state.dispatch,
      intent,
      persistence: "committed",
      callbackInvoked: false,
    });
  }
  if (state.status === "result_recorded") {
    if (state.result.status === "completed") {
      if (intent === undefined) throw invalid("store.corrupt", "completed advisory recovery has no exact intent", []);
      return completeAdvisoryFromIntent({
        plan: persisted,
        authorization: state.authorization,
        dispatch: state.dispatch,
        intent,
        persistence: "committed",
        callbackInvoked: false,
      });
    }
    const turnId = await commitNoncompletedAdvisoryTurn({
      plan: persisted,
      authorization: state.authorization,
      dispatch: state.dispatch,
      result: state.result,
    });
    return { status: state.result.status, persistence: "committed", callbackInvoked: false, turnId };
  }
  if (state.status === "committed") {
    const output = state.graph.turn.output;
    if (output.kind !== "advisory_review") {
      return {
        status: state.graph.result.status,
        persistence: "existing",
        callbackInvoked: false,
        turnId: state.graph.turn.id,
      };
    }
    const assessment = await loadSemanticAdvisoryAssessment(context, output.assessmentId);
    if (assessment === undefined || assessment.assessmentDigest !== output.assessmentDigest) {
      throw invalid("store.corrupt", "committed advisory turn references a missing assessment", []);
    }
    return {
      status: state.graph.result.status,
      persistence: "existing",
      callbackInvoked: false,
      turnId: state.graph.turn.id,
      assessment: advisoryAssessmentView(assessment),
    };
  }
  return { status: "outcome_unknown", persistence: "dispatch_only", callbackInvoked: false, turnId: null };
}

export async function runAdvisoryReview(
  token: object,
  input: unknown,
  revalidate: (plan: AdvisoryPreparedPlanBinding) => Promise<void>,
): ReturnType<SemanticWorkflowBundle["runAdvisoryReview"]> {
  const fields = readFields(input, ["runAdvisoryReview"]);
  const exact = planFor(
    token,
    fields.req("plan", (value) => value),
    ["plan"],
  );
  const plan = exact.binding;
  const authorization = authorizationFor(
    token,
    exact.handle,
    plan.definition.transport,
    fields.req("authorization", (value) => value),
  ).record;
  const winningAttempt = await loadSemanticAdvisoryAttempt(plan.context, {
    attemptId: plan.attempt.id,
    scopeDigest: plan.reservation.scopeDigest,
    definitionDigest: plan.definition.definitionDigest,
  });
  assertAttemptMatchesAdvisoryPlan(winningAttempt, plan);
  const recovered = await recoverAdvisoryReview(plan.context, plan.definition, {
    attemptId: plan.attempt.id,
    scope: plan.scope,
  });
  if (recovered.status !== "not_dispatched") {
    const winningAfterRecovery = await loadSemanticAdvisoryAttempt(plan.context, {
      attemptId: plan.attempt.id,
      scopeDigest: plan.reservation.scopeDigest,
      definitionDigest: plan.definition.definitionDigest,
    });
    if (winningAfterRecovery === undefined) {
      throw invalid("store.corrupt", "recovered advisory review has no durable attempt", []);
    }
    assertAttemptMatchesAdvisoryPlan(winningAfterRecovery, plan);
    if (recovered.persistence === "not_dispatched") {
      throw invalid("store.corrupt", "dispatched advisory recovery has a not-dispatched persistence state", []);
    }
    return {
      status: recovered.status,
      persistence: recovered.persistence === "committed" ? "existing" : recovered.persistence,
      callbackInvoked: recovered.callbackInvoked,
      turnId: recovered.turnId,
      ...(recovered.assessment === undefined ? {} : { assessment: recovered.assessment }),
    };
  }
  await revalidate(plan);
  await persistSemanticTurnReservation(plan.context, plan.reservation);
  await persistSemanticAdvisoryReviewPlan(plan.context, {
    reservation: plan.reservation,
    plan: plan.planLock,
  });
  if (authorization !== null) {
    await persistSemanticDisclosureAuthorization(plan.context, plan.reservation, authorization);
  }
  await persistSemanticAdvisoryAttempt(plan.context, {
    reservation: plan.reservation,
    plan: plan.planLock,
    attempt: plan.attempt,
  });
  await revalidate(plan);
  const claim = await claimSemanticDispatch(plan.context, {
    reservation: plan.reservation,
    authorization,
  });
  if (claim.status === "existing") {
    const intent = await loadSemanticAdvisoryCompletionIntent(plan.context, plan.attempt.reviewKeyDigest);
    if (intent !== undefined) {
      return completeAdvisoryFromIntent({
        plan,
        authorization,
        dispatch: claim.dispatch,
        intent,
        persistence: "existing",
        callbackInvoked: false,
      });
    }
    const state = await classifySemanticAdvisoryTurnPersistence(plan.context, plan.reservation);
    if (state.status === "result_recorded") {
      const turnId = await commitNoncompletedAdvisoryTurn({
        plan,
        authorization,
        dispatch: state.dispatch,
        result: state.result,
      });
      return { status: state.result.status, persistence: "existing", callbackInvoked: false, turnId };
    }
    if (state.status === "committed") {
      return {
        status: state.graph.result.status,
        persistence: "existing",
        callbackInvoked: false,
        turnId: state.graph.turn.id,
      };
    }
    return { status: "outcome_unknown", persistence: "dispatch_only", callbackInvoked: false, turnId: null };
  }
  const settled = await invokeProviderWithTimeout(
    plan.callbacks.invokeProvider,
    {
      operation: {
        id: claim.dispatch.providerOperationId,
        idempotencyKey: claim.dispatch.idempotencyKey ?? claim.dispatch.providerOperationId,
      },
      request: {
        mediaType: "application/json",
        encoding: "utf-8",
        bytes: bytesOf(plan.requestText),
        byteLength: plan.reservation.request.byteLength,
        estimatedInputTokens: plan.planLock.request.estimatedInputTokens,
        minimizedBytesDigest: plan.reservation.request.minimizedBytesDigest,
        keyPolicyDigest: plan.reservation.request.keyPolicyDigest,
      },
      model: plan.definition.providerModel.model,
      toolPolicy: plan.definition.toolPolicy,
      budgetPolicy: {
        maximumInputTokens: plan.definition.budgetPolicy.maximumInputTokens,
        maximumOutputTokens: plan.definition.budgetPolicy.maximumOutputTokens,
        maximumDurationMs: plan.definition.budgetPolicy.maximumDurationMs,
        maximumCost: plan.definition.budgetPolicy.maximumCost,
      },
    },
    plan.definition.budgetPolicy.maximumDurationMs,
  );
  if (settled.status === "unknown") {
    return { status: "outcome_unknown", persistence: "dispatch_only", callbackInvoked: true, turnId: null };
  }
  const hardResponseBytes = 16 * 1_048_576;
  let responseValue: ReturnType<typeof toJsonValue>;
  let responseText: string;
  let responseDigest: string;
  try {
    responseValue = snapshotSemanticWorkflowJson(settled.value, hardResponseBytes);
    responseText = canonicalJsonText(responseValue);
    responseDigest = parseKeyedDigest(plan.callbacks.digest, bytesOf(responseText));
  } catch (error) {
    const status =
      error instanceof LearningLoopError && error.code === "semantic.workflow_response_limit"
        ? "result_limit"
        : "result_invalid";
    const result = buildKnownFailureResult({
      reservation: plan.reservation,
      dispatch: claim.dispatch,
      status,
      response: null,
    });
    const turnId = await commitNoncompletedAdvisoryTurn({ plan, authorization, dispatch: claim.dispatch, result });
    return { status, persistence: "committed", callbackInvoked: true, turnId };
  }
  const responseByteLength = Buffer.byteLength(responseText, "utf8");
  let envelope: ReturnType<typeof parseProviderEnvelope> | undefined;
  try {
    envelope = parseProviderEnvelope(responseValue, {
      id: ADVISORY_REVIEW_RESULT_SCHEMA_ID,
      version: ADVISORY_REVIEW_RESULT_SCHEMA_VERSION,
    });
  } catch (error) {
    void error;
  }
  const providerReceiptDigest = digestOf({
    domain: "semantic-workflow-provider-receipt:v1",
    responseKeyedDigest: responseDigest,
    providerRegistrationDigest: plan.definition.providerModel.provider.registrationDigest,
  });
  const response = {
    providerReceiptId: `semantic-workflow-provider-receipt-${providerReceiptDigest}`,
    providerReceiptDigest,
    requestAttestationDigest: plan.reservation.request.minimizedBytesDigest,
    responseByteLength,
    responseKeyedDigest: responseDigest,
    keyPolicyDigest: plan.reservation.request.keyPolicyDigest,
  };
  if (responseByteLength > plan.definition.budgetPolicy.maximumResponseBytes) {
    const result = buildKnownFailureResult({
      reservation: plan.reservation,
      dispatch: claim.dispatch,
      status: "result_limit",
      response,
      ...(envelope === undefined ? {} : { usage: envelope.usage }),
    });
    const turnId = await commitNoncompletedAdvisoryTurn({ plan, authorization, dispatch: claim.dispatch, result });
    return { status: "result_limit", persistence: "committed", callbackInvoked: true, turnId };
  }
  if (envelope === undefined) {
    const result = buildKnownFailureResult({
      reservation: plan.reservation,
      dispatch: claim.dispatch,
      status: "result_invalid",
      response,
    });
    const turnId = await commitNoncompletedAdvisoryTurn({ plan, authorization, dispatch: claim.dispatch, result });
    return { status: "result_invalid", persistence: "committed", callbackInvoked: true, turnId };
  }
  if (usageMeasurementInvalid(plan.definition, envelope.usage, envelope.status === "completed")) {
    const invalidUsage = buildKnownFailureResult({
      reservation: plan.reservation,
      dispatch: claim.dispatch,
      status: "result_invalid",
      response,
    });
    const turnId = await commitNoncompletedAdvisoryTurn({
      plan,
      authorization,
      dispatch: claim.dispatch,
      result: invalidUsage,
    });
    return { status: "result_invalid", persistence: "committed", callbackInvoked: true, turnId };
  }
  if (envelope.usage !== null && usageExceedsBudget(plan.definition, envelope.usage)) {
    const limitedUsage = buildKnownFailureResult({
      reservation: plan.reservation,
      dispatch: claim.dispatch,
      status: "result_limit",
      response,
      usage: envelope.usage,
    });
    const turnId = await commitNoncompletedAdvisoryTurn({
      plan,
      authorization,
      dispatch: claim.dispatch,
      result: limitedUsage,
    });
    return { status: "result_limit", persistence: "committed", callbackInvoked: true, turnId };
  }
  if (envelope.status !== "completed") {
    const result = buildKnownFailureResult({
      reservation: plan.reservation,
      dispatch: claim.dispatch,
      status: envelope.status,
      response,
      usage: envelope.usage,
    });
    const turnId = await commitNoncompletedAdvisoryTurn({ plan, authorization, dispatch: claim.dispatch, result });
    return { status: envelope.status, persistence: "committed", callbackInvoked: true, turnId };
  }
  const completedUsage = envelope.usage;
  if (completedUsage === null) throw invalid("schema.corrupt", "completed provider usage was not retained", []);
  const target = plan.reservation.target;
  if (target.kind !== "advisory_review") throw invalid("schema.corrupt", "advisory plan has another lane", []);
  let assessment: SemanticAdvisoryAssessment | undefined;
  let completedResult: SemanticResultBinding | undefined;
  try {
    const draft = parseAdvisoryReviewResultDraft(envelope.result);
    const findings = draft.findings.map((finding) => ({
      code: finding.code,
      severity: finding.severity,
      statementKeyedDigest: parseKeyedDigest(plan.callbacks.digest, bytesOf(finding.statement)),
      statementByteLength: advisoryStatementByteLength(finding.statement),
    }));
    const normalizedResult: JsonValue = advisoryNormalizedResult({
      advisoryRecommendation: draft.advisoryRecommendation,
      findings,
    });
    const result = buildSemanticResultBinding({
      turnKeyDigest: plan.reservation.turnKeyDigest,
      reservationDigest: plan.reservation.reservationDigest,
      dispatchDigest: claim.dispatch.dispatchDigest,
      status: "completed",
      response,
      usage: completedUsage,
      normalizedResult,
      normalizedResultDigest: semanticNormalizedResultDigest(normalizedResult),
      reasonCodes: [],
    });
    completedResult = result;
    assessment = buildSemanticAdvisoryAssessment({
      turnKeyDigest: plan.reservation.turnKeyDigest,
      reservationDigest: plan.reservation.reservationDigest,
      resultBindingDigest: result.bindingDigest,
      definitionDigest: plan.definition.definitionDigest,
      qualification: "advisory_uncalibrated",
      candidateId: target.candidateId,
      candidateDigest: target.candidateDigest,
      scopeDigest: plan.reservation.scopeDigest,
      advisoryRecommendation: draft.advisoryRecommendation,
      findings,
      keyPolicyDigest: plan.definition.disclosurePolicy.keyPolicyDigest,
      subjectSnapshotDigest: plan.subjectSnapshotDigest,
      evidenceSetDigest: target.evidenceSetDigest,
      derivationRef: target.derivation,
      admission: plan.subject.admission,
      admissionLineageDigest: plan.admissionLineageDigest,
      reviewer: {
        principal: plan.definition.principal,
        attestation: plan.definition.attestation,
        implementation: {
          id: plan.definition.implementation.id,
          version: plan.definition.implementation.version,
          digest: plan.definition.implementation.implementationDigest,
        },
        modelFingerprintDigest: plan.definition.providerModel.model.modelFingerprintDigest,
        promptDigest: plan.definition.prompt.promptDigest,
        rendererDigest: plan.definition.renderer.rendererDigest,
        outputSchemaDigest: plan.definition.outputSchema.schemaDigest,
        toolPolicyDigest: plan.definition.toolPolicy.policyDigest,
        budgetPolicyDigest: plan.definition.budgetPolicy.policyDigest,
        calibration: { status: "unverified", calibrationId: null, calibrationDigest: null },
      },
    });
  } catch (error) {
    void error;
    const invalidResult = buildKnownFailureResult({
      reservation: plan.reservation,
      dispatch: claim.dispatch,
      status: "result_invalid",
      response,
      usage: envelope.usage,
    });
    const turnId = await commitNoncompletedAdvisoryTurn({
      plan,
      authorization,
      dispatch: claim.dispatch,
      result: invalidResult,
    });
    return { status: "result_invalid", persistence: "committed", callbackInvoked: true, turnId };
  }
  if (assessment === undefined || completedResult === undefined) {
    throw invalid("schema.corrupt", "completed advisory assessment was not assembled", []);
  }
  const intent = buildSemanticAdvisoryCompletionIntent({
    reviewKeyDigest: plan.attempt.reviewKeyDigest,
    turnKeyDigest: plan.reservation.turnKeyDigest,
    reservationDigest: plan.reservation.reservationDigest,
    planLockDigest: plan.planLock.lockDigest,
    result: completedResult,
    assessment,
  });
  // The completion intent is deliberately the first awaited write after the
  // resolved provider response has been synchronously validated and digested.
  const storedIntent = await persistSemanticAdvisoryCompletionIntent(plan.context, {
    reservation: plan.reservation,
    authorization,
    dispatch: claim.dispatch,
    plan: plan.planLock,
    intent,
  });
  return completeAdvisoryFromIntent({
    plan,
    authorization,
    dispatch: claim.dispatch,
    intent: storedIntent,
    persistence: "committed",
    callbackInvoked: true,
  });
}
