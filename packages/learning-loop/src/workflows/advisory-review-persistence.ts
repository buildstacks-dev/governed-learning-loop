// Private receipt-last persistence for the advisory semantic review lane.
// This module has no provider callback, redispatch helper, Candidate/Review
// writer, public export, or effect capability. Its terminal reads are
// scope-and-definition private, and completed output is legal only through
// the typed advisory completion intent and assessment sidecars.
import { invalid, parseNonEmptyText } from "../parse/toolkit.js";
import { toJsonValue } from "../canonical/to-json-value.js";
import type { EngineContext, RecordKind } from "../engine/context.js";
import { parseWriteResult, recordDigest } from "../engine/context.js";
import type { SemanticTurnReservation } from "./semantic-turn-intent.js";
import { parseSemanticDisclosureAuthorization, parseSemanticTurnReservation } from "./semantic-turn-intent.js";
import type { SemanticResultBinding, SemanticTurnReceipt } from "./semantic-turn-outcome.js";
import { parseSemanticDispatchMarker, parseSemanticResultBinding } from "./semantic-turn-outcome.js";
import type {
  SemanticAdvisoryAssessment,
  SemanticAdvisoryAttemptIndex,
  SemanticAdvisoryCompletionIntent,
  SemanticAdvisoryReviewPlanLock,
} from "./advisory-review-record.js";
import {
  advisoryNormalizedResult,
  parseSemanticAdvisoryAssessment,
  parseSemanticAdvisoryAttemptIndex,
  parseSemanticAdvisoryCompletionIntent,
  parseSemanticAdvisoryReviewPlanLock,
  semanticAdvisoryReviewKeyDigest,
} from "./advisory-review-record.js";
import type { SemanticTurnPersistenceGraph, SemanticTurnPersistenceState } from "./semantic-turn-persistence.js";
import {
  assertAuthorizationBinding,
  assertResultBinding,
  classifySemanticTurnPersistence,
  loadOptionalGlobalExact,
  loadSemanticDefinitionTurn,
  loadSemanticTurnScopeIndex,
  loadSemanticTurnByScopeUnchecked,
  parseSemanticTurnPersistenceGraph,
  persistGlobalExact,
  persistScopeIndex,
  persistScopedTurn,
  reloadAuthorizationInput,
  reloadExactCommitted,
  sameCanonicalValue,
} from "./semantic-turn-persistence.js";
import { semanticWorkflowAttemptNamespace } from "./semantic-generation-persistence.js";
import { querySemanticTurnsByDefinition } from "./semantic-turn-query.js";
import { canonicalJsonText } from "../canonical/canonical-json.js";
import { readSemanticWorkflowFields as readFields } from "./workflow-structure.js";

const RESERVATION_KIND: RecordKind = "semantic-workflow-reservation";
const DISPATCH_KIND: RecordKind = "semantic-workflow-dispatch";
const RESULT_KIND: RecordKind = "semantic-workflow-result";
const ADVISORY_PLAN_KIND: RecordKind = "semantic-workflow-advisory-plan";
const ADVISORY_COMPLETION_KIND: RecordKind = "semantic-workflow-advisory-completion";
const ADVISORY_ASSESSMENT_KIND: RecordKind = "semantic-workflow-advisory-assessment";
const ADVISORY_ATTEMPT_KIND = "semantic-workflow-advisory-attempt";
const parseUnknown = (input: unknown): unknown => input;

function parseStoredAttempt(
  input: unknown,
  expected: {
    readonly scopeDigest: string;
    readonly definitionDigest: string;
    readonly attemptId: string;
  },
): SemanticAdvisoryAttemptIndex {
  const fields = readFields(input, ["store", "advisoryAttempt"]);
  const keyFields = readFields(fields.req("key", parseUnknown), ["store", "advisoryAttempt", "key"]);
  const key = {
    namespace: keyFields.req("namespace", parseNonEmptyText),
    kind: keyFields.req("kind", parseNonEmptyText),
    id: keyFields.req("id", parseNonEmptyText),
  };
  const value = fields.req("value", parseUnknown);
  const digest = fields.req("digest", parseNonEmptyText);
  if (
    key.namespace !== semanticWorkflowAttemptNamespace(expected.scopeDigest, expected.definitionDigest) ||
    key.kind !== ADVISORY_ATTEMPT_KIND ||
    key.id !== expected.attemptId ||
    digest !== recordDigest(toJsonValue(value))
  ) {
    throw invalid("store.corrupt", "stored advisory attempt has a foreign envelope", []);
  }
  const attempt = parseSemanticAdvisoryAttemptIndex(value);
  if (
    attempt.id !== expected.attemptId ||
    attempt.scopeDigest !== expected.scopeDigest ||
    attempt.definitionDigest !== expected.definitionDigest ||
    !sameCanonicalValue(attempt, value)
  ) {
    throw invalid("store.corrupt", "stored advisory attempt differs from its exact key", []);
  }
  return attempt;
}

export async function loadSemanticAdvisoryAttempt(
  context: EngineContext,
  input: { readonly attemptId: string; readonly scopeDigest: string; readonly definitionDigest: string },
): Promise<SemanticAdvisoryAttemptIndex | undefined> {
  const raw: unknown = await context.store.get({
    namespace: semanticWorkflowAttemptNamespace(input.scopeDigest, input.definitionDigest),
    kind: ADVISORY_ATTEMPT_KIND,
    id: input.attemptId,
  });
  return raw === undefined ? undefined : parseStoredAttempt(raw, input);
}

export function loadSemanticAdvisoryReviewPlan(
  context: EngineContext,
  reviewKeyDigest: string,
): Promise<SemanticAdvisoryReviewPlanLock | undefined> {
  return loadOptionalGlobalExact(
    context,
    ADVISORY_PLAN_KIND,
    `semantic-workflow-advisory-plan-${reviewKeyDigest}`,
    parseSemanticAdvisoryReviewPlanLock,
  );
}

export function loadSemanticAdvisoryCompletionIntent(
  context: EngineContext,
  reviewKeyDigest: string,
): Promise<SemanticAdvisoryCompletionIntent | undefined> {
  return loadOptionalGlobalExact(
    context,
    ADVISORY_COMPLETION_KIND,
    `semantic-workflow-advisory-completion-${reviewKeyDigest}`,
    parseSemanticAdvisoryCompletionIntent,
  );
}

export function loadSemanticAdvisoryAssessment(
  context: EngineContext,
  assessmentId: string,
): Promise<SemanticAdvisoryAssessment | undefined> {
  return loadOptionalGlobalExact(context, ADVISORY_ASSESSMENT_KIND, assessmentId, parseSemanticAdvisoryAssessment);
}

function advisoryTarget(reservation: SemanticTurnReservation) {
  const target = reservation.target;
  if (target.kind !== "advisory_review") {
    throw invalid("schema.corrupt", "advisory review persistence requires an advisory turn target", []);
  }
  return target;
}

function reviewKeyOf(reservation: SemanticTurnReservation): string {
  const target = advisoryTarget(reservation);
  return semanticAdvisoryReviewKeyDigest({
    candidateId: target.candidateId,
    candidateDigest: target.candidateDigest,
    definitionDigest: reservation.definition.definitionDigest,
    scopeDigest: reservation.scopeDigest,
  });
}

/**
 * Exact reciprocity between one completed advisory result and its assessment.
 * The assessment must bind the exact reservation subject, the definition's
 * reviewer attribution with calibration absent, and the digested normalized
 * result. It grants no Candidate, Review, admission, or effect.
 */
async function assertSemanticAdvisoryBundle(
  context: EngineContext,
  reservation: SemanticTurnReservation,
  result: SemanticResultBinding,
  assessment: SemanticAdvisoryAssessment,
): Promise<void> {
  const target = advisoryTarget(reservation);
  const definition = reservation.definition;
  const expectedNormalized = advisoryNormalizedResult(assessment);
  if (
    definition.lane !== "advisory_review" ||
    result.status !== "completed" ||
    result.normalizedResult === null ||
    canonicalJsonText(result.normalizedResult) !== canonicalJsonText(expectedNormalized) ||
    assessment.turnKeyDigest !== reservation.turnKeyDigest ||
    assessment.reservationDigest !== reservation.reservationDigest ||
    assessment.resultBindingDigest !== result.bindingDigest ||
    assessment.definitionDigest !== definition.definitionDigest ||
    assessment.candidateId !== target.candidateId ||
    assessment.candidateDigest !== target.candidateDigest ||
    assessment.scopeDigest !== reservation.scopeDigest ||
    assessment.evidenceSetDigest !== target.evidenceSetDigest ||
    !sameCanonicalValue(assessment.derivationRef, target.derivation) ||
    assessment.keyPolicyDigest !== definition.disclosurePolicy.keyPolicyDigest ||
    !sameCanonicalValue(assessment.reviewer.principal, definition.principal) ||
    !sameCanonicalValue(assessment.reviewer.attestation, definition.attestation) ||
    assessment.reviewer.implementation.id !== definition.implementation.id ||
    assessment.reviewer.implementation.version !== definition.implementation.version ||
    assessment.reviewer.implementation.digest !== definition.implementation.implementationDigest ||
    assessment.reviewer.modelFingerprintDigest !== definition.providerModel.model.modelFingerprintDigest ||
    assessment.reviewer.promptDigest !== definition.prompt.promptDigest ||
    assessment.reviewer.rendererDigest !== definition.renderer.rendererDigest ||
    assessment.reviewer.outputSchemaDigest !== definition.outputSchema.schemaDigest ||
    assessment.reviewer.toolPolicyDigest !== definition.toolPolicy.policyDigest ||
    assessment.reviewer.budgetPolicyDigest !== definition.budgetPolicy.policyDigest
  ) {
    throw invalid("semantic.workflow_output_invalid", "advisory assessment binding is not reciprocal", []);
  }
  const reviewKeyDigest = reviewKeyOf(reservation);
  const plan = await loadSemanticAdvisoryReviewPlan(context, reviewKeyDigest);
  const completionIntent = await loadSemanticAdvisoryCompletionIntent(context, reviewKeyDigest);
  if (
    plan === undefined ||
    plan.turnKeyDigest !== reservation.turnKeyDigest ||
    plan.reservationId !== reservation.id ||
    plan.reservationDigest !== reservation.reservationDigest ||
    plan.definitionDigest !== definition.definitionDigest ||
    plan.scopeDigest !== reservation.scopeDigest ||
    plan.candidateId !== target.candidateId ||
    plan.candidateDigest !== target.candidateDigest ||
    plan.request.byteLength !== reservation.request.byteLength ||
    plan.request.estimatedInputTokens !== reservation.request.estimatedInputTokens ||
    plan.request.minimizedBytesDigest !== reservation.request.minimizedBytesDigest ||
    plan.request.keyPolicyDigest !== reservation.request.keyPolicyDigest ||
    completionIntent === undefined ||
    !sameCanonicalValue(completionIntent.result, result) ||
    !sameCanonicalValue(completionIntent.assessment, assessment)
  ) {
    throw invalid("semantic.workflow_output_invalid", "advisory assessment has no exact plan lock", []);
  }
}

export async function persistSemanticAdvisoryReviewPlan(
  context: EngineContext,
  input: unknown,
): Promise<SemanticAdvisoryReviewPlanLock> {
  const fields = readFields(input, ["semanticAdvisoryReviewPlan"]);
  const candidateReservation = fields.req("reservation", (value) => parseSemanticTurnReservation(value));
  const reservation = await reloadExactCommitted(
    context,
    RESERVATION_KIND,
    candidateReservation,
    parseSemanticTurnReservation,
  );
  const plan = fields.req("plan", parseSemanticAdvisoryReviewPlanLock);
  const target = advisoryTarget(reservation);
  if (
    plan.reviewKeyDigest !== reviewKeyOf(reservation) ||
    plan.turnKeyDigest !== reservation.turnKeyDigest ||
    plan.reservationId !== reservation.id ||
    plan.reservationDigest !== reservation.reservationDigest ||
    plan.definitionDigest !== reservation.definition.definitionDigest ||
    plan.scopeDigest !== reservation.scopeDigest ||
    plan.candidateId !== target.candidateId ||
    plan.candidateDigest !== target.candidateDigest ||
    plan.request.byteLength !== reservation.request.byteLength ||
    plan.request.estimatedInputTokens !== reservation.request.estimatedInputTokens ||
    plan.request.minimizedBytesDigest !== reservation.request.minimizedBytesDigest ||
    plan.request.keyPolicyDigest !== reservation.request.keyPolicyDigest
  ) {
    throw invalid("schema.corrupt", "advisory review plan does not bind its exact reservation", []);
  }
  return persistGlobalExact(context, ADVISORY_PLAN_KIND, plan, parseSemanticAdvisoryReviewPlanLock);
}

export async function persistSemanticAdvisoryAttempt(context: EngineContext, input: unknown): Promise<void> {
  const fields = readFields(input, ["semanticAdvisoryAttempt"]);
  const candidateReservation = fields.req("reservation", parseSemanticTurnReservation);
  const reservation = await reloadExactCommitted(
    context,
    RESERVATION_KIND,
    candidateReservation,
    parseSemanticTurnReservation,
  );
  const plan = fields.req("plan", parseSemanticAdvisoryReviewPlanLock);
  await reloadExactCommitted(context, ADVISORY_PLAN_KIND, plan, parseSemanticAdvisoryReviewPlanLock);
  const attempt = fields.req("attempt", parseSemanticAdvisoryAttemptIndex);
  advisoryTarget(reservation);
  if (
    attempt.scopeDigest !== reservation.scopeDigest ||
    attempt.definitionDigest !== reservation.definition.definitionDigest ||
    attempt.reservationId !== reservation.id ||
    attempt.reservationDigest !== reservation.reservationDigest ||
    attempt.planLockId !== plan.id ||
    attempt.planLockDigest !== plan.lockDigest ||
    attempt.reviewKeyDigest !== plan.reviewKeyDigest
  ) {
    throw invalid("schema.corrupt", "advisory attempt does not bind its exact plan", []);
  }
  const value = toJsonValue(attempt);
  const rawResult: unknown = await context.store.create(
    {
      namespace: semanticWorkflowAttemptNamespace(attempt.scopeDigest, attempt.definitionDigest),
      kind: ADVISORY_ATTEMPT_KIND,
      id: attempt.id,
    },
    value,
    recordDigest(value),
    `semantic-workflow/advisory-attempt/${attempt.scopeDigest}/${attempt.definitionDigest}/${attempt.id}`,
  );
  const result = parseWriteResult(rawResult);
  if (result.status === "updated") throw invalid("store.corrupt", "advisory attempt was updated", []);
  if (result.status === "conflict") throw invalid("store.conflict", "advisory attempt conflicts", []);
  const stored = await loadSemanticAdvisoryAttempt(context, {
    attemptId: attempt.id,
    scopeDigest: attempt.scopeDigest,
    definitionDigest: attempt.definitionDigest,
  });
  if (stored === undefined || !sameCanonicalValue(stored, attempt)) {
    throw invalid("store.corrupt", "advisory attempt was not preserved", []);
  }
}

/**
 * First awaited post-callback write. The intent owns the digested normalized
 * assessment needed for forward completion; provider statement prose, raw
 * response bytes, and request bytes are absent by construction.
 */
export async function persistSemanticAdvisoryCompletionIntent(
  context: EngineContext,
  input: unknown,
): Promise<SemanticAdvisoryCompletionIntent> {
  const fields = readFields(input, ["semanticAdvisoryCompletionIntent"]);
  const reservation = fields.req("reservation", parseSemanticTurnReservation);
  const authorization = fields.req("authorization", (value) =>
    value === null ? null : parseSemanticDisclosureAuthorization(value, reservation),
  );
  const dispatch = fields.req("dispatch", parseSemanticDispatchMarker);
  const plan = fields.req("plan", parseSemanticAdvisoryReviewPlanLock);
  const intent = fields.req("intent", parseSemanticAdvisoryCompletionIntent);
  assertAuthorizationBinding(reservation, authorization, dispatch);
  assertResultBinding(reservation, dispatch, intent.result);
  const reviewKeyDigest = reviewKeyOf(reservation);
  if (
    plan.reviewKeyDigest !== reviewKeyDigest ||
    plan.turnKeyDigest !== reservation.turnKeyDigest ||
    plan.reservationId !== reservation.id ||
    plan.reservationDigest !== reservation.reservationDigest ||
    plan.lockDigest !== intent.planLockDigest ||
    intent.reviewKeyDigest !== reviewKeyDigest ||
    intent.turnKeyDigest !== reservation.turnKeyDigest ||
    intent.reservationDigest !== reservation.reservationDigest
  ) {
    throw invalid("semantic.workflow_output_invalid", "advisory completion intent does not bind its exact plan", []);
  }
  // No await occurs before this create-only intent write.
  const storedIntent = await persistGlobalExact(
    context,
    ADVISORY_COMPLETION_KIND,
    intent,
    parseSemanticAdvisoryCompletionIntent,
  );
  const committedReservation = await reloadExactCommitted(
    context,
    RESERVATION_KIND,
    reservation,
    parseSemanticTurnReservation,
  );
  await reloadExactCommitted(context, ADVISORY_PLAN_KIND, plan, parseSemanticAdvisoryReviewPlanLock);
  await reloadExactCommitted(context, DISPATCH_KIND, dispatch, parseSemanticDispatchMarker);
  await reloadAuthorizationInput(context, committedReservation, authorization);
  await assertSemanticAdvisoryBundle(context, committedReservation, storedIntent.result, storedIntent.assessment);
  return storedIntent;
}

/** Result binding and assessment writes after the exact intent is committed. */
export async function persistSemanticCompletedAdvisory(
  context: EngineContext,
  input: unknown,
): Promise<{
  readonly result: SemanticResultBinding;
  readonly assessment: SemanticAdvisoryAssessment;
}> {
  const fields = readFields(input, ["semanticCompletedAdvisory"]);
  const candidateReservation = fields.req("reservation", parseSemanticTurnReservation);
  const reservation = await reloadExactCommitted(
    context,
    RESERVATION_KIND,
    candidateReservation,
    parseSemanticTurnReservation,
  );
  const authorization = await reloadAuthorizationInput(context, reservation, fields.req("authorization", parseUnknown));
  const candidateDispatch = fields.req("dispatch", parseSemanticDispatchMarker);
  const dispatch = await reloadExactCommitted(context, DISPATCH_KIND, candidateDispatch, parseSemanticDispatchMarker);
  assertAuthorizationBinding(reservation, authorization, dispatch);
  const result = fields.req("result", parseSemanticResultBinding);
  assertResultBinding(reservation, dispatch, result);
  if (result.status !== "completed") {
    throw invalid("schema.invalid", "typed advisory persistence requires a completed result", []);
  }
  const assessment = fields.req("assessment", parseSemanticAdvisoryAssessment);
  const completionIntent = await loadSemanticAdvisoryCompletionIntent(context, reviewKeyOf(reservation));
  if (
    completionIntent === undefined ||
    !sameCanonicalValue(completionIntent.result, result) ||
    !sameCanonicalValue(completionIntent.assessment, assessment)
  ) {
    throw invalid("semantic.workflow_incomplete", "completed advisory review has no exact recovery intent", []);
  }
  await assertSemanticAdvisoryBundle(context, reservation, result, assessment);
  const storedResult = await persistGlobalExact(context, RESULT_KIND, result, parseSemanticResultBinding);
  const storedAssessment = await persistGlobalExact(
    context,
    ADVISORY_ASSESSMENT_KIND,
    assessment,
    parseSemanticAdvisoryAssessment,
  );
  return { result: storedResult, assessment: storedAssessment };
}

/** Terminal index and receipt write after every exact advisory sidecar is reloaded. */
export async function persistSemanticCompletedAdvisoryTerminal(
  context: EngineContext,
  input: unknown,
): Promise<SemanticTurnReceipt> {
  const fields = readFields(input, ["semanticCompletedAdvisoryTerminal"]);
  const graph = fields.req("graph", parseSemanticTurnPersistenceGraph);
  if (graph.result.status !== "completed" || graph.reservation.target.kind !== "advisory_review") {
    throw invalid("schema.invalid", "completed advisory terminal requires a completed advisory graph", []);
  }
  const reservation = await reloadExactCommitted(
    context,
    RESERVATION_KIND,
    graph.reservation,
    parseSemanticTurnReservation,
  );
  const authorization = await reloadAuthorizationInput(context, reservation, graph.authorization);
  const dispatch = await reloadExactCommitted(context, DISPATCH_KIND, graph.dispatch, parseSemanticDispatchMarker);
  const result = await reloadExactCommitted(context, RESULT_KIND, graph.result, parseSemanticResultBinding);
  const assessmentInput = fields.req("assessment", parseSemanticAdvisoryAssessment);
  const assessment = await reloadExactCommitted(
    context,
    ADVISORY_ASSESSMENT_KIND,
    assessmentInput,
    parseSemanticAdvisoryAssessment,
  );
  await assertSemanticAdvisoryBundle(context, reservation, result, assessment);
  const output = graph.turn.output;
  if (
    output.kind !== "advisory_review" ||
    output.assessmentId !== assessment.id ||
    output.assessmentDigest !== assessment.assessmentDigest
  ) {
    throw invalid("schema.corrupt", "advisory terminal output is not reciprocal", []);
  }
  const exactGraph = parseSemanticTurnPersistenceGraph({
    reservation,
    authorization,
    dispatch,
    result,
    scopeIndex: graph.scopeIndex,
    turn: graph.turn,
  });
  await persistScopeIndex(context, exactGraph.scopeIndex);
  return persistScopedTurn(context, exactGraph.turn, exactGraph.scopeIndex.definitionDigest);
}

/**
 * Exact-scope advisory terminal load. The scope-and-definition namespace is
 * probed first when a definition digest is supplied, so a wrong-scope or
 * wrong-definition lookup cannot probe a foreign target. A completed advisory
 * turn is loadable only with its exact typed plan, intent, and assessment.
 */
export async function loadSemanticAdvisoryTurnByScope(
  context: EngineContext,
  turnIdInput: unknown,
  exactScopeDigestInput: unknown,
  expectedDefinitionDigest?: string,
): Promise<SemanticTurnPersistenceGraph | undefined> {
  if (
    expectedDefinitionDigest !== undefined &&
    (await loadSemanticDefinitionTurn(context, turnIdInput, exactScopeDigestInput, expectedDefinitionDigest)) ===
      undefined
  ) {
    return undefined;
  }
  const scopeIndex = await loadSemanticTurnScopeIndex(context, turnIdInput, exactScopeDigestInput);
  if (
    scopeIndex !== undefined &&
    expectedDefinitionDigest !== undefined &&
    scopeIndex.definitionDigest !== expectedDefinitionDigest
  ) {
    return undefined;
  }
  const graph = await loadSemanticTurnByScopeUnchecked(context, turnIdInput, exactScopeDigestInput);
  if (graph === undefined || graph.result.status !== "completed") return graph;
  const target = graph.reservation.target;
  if (target.kind !== "advisory_review") {
    throw invalid("semantic.workflow_output_unavailable", "completed generation output requires its own loader", []);
  }
  const output = graph.turn.output;
  if (output.kind !== "advisory_review") {
    throw invalid("store.corrupt", "completed advisory turn output is not an assessment", []);
  }
  const reviewKeyDigest = reviewKeyOf(graph.reservation);
  const plan = await loadSemanticAdvisoryReviewPlan(context, reviewKeyDigest);
  const completionIntent = await loadSemanticAdvisoryCompletionIntent(context, reviewKeyDigest);
  const assessment = await loadSemanticAdvisoryAssessment(context, output.assessmentId);
  if (plan === undefined && completionIntent === undefined && assessment === undefined) {
    throw invalid(
      "semantic.workflow_output_unavailable",
      "completed advisory result has no typed assessment integration",
      [],
    );
  }
  if (plan === undefined || completionIntent === undefined || assessment === undefined) {
    throw invalid("store.corrupt", "completed advisory turn has an incomplete assessment graph", []);
  }
  if (assessment.assessmentDigest !== output.assessmentDigest) {
    throw invalid("store.corrupt", "completed advisory turn references a mismatched assessment", []);
  }
  await assertSemanticAdvisoryBundle(context, graph.reservation, graph.result, assessment);
  return graph;
}

export function classifySemanticAdvisoryTurnPersistence(
  context: EngineContext,
  reservationInput: unknown,
): Promise<SemanticTurnPersistenceState> {
  return classifySemanticTurnPersistence(context, reservationInput, {
    allowCompleted: true,
    loadGraph: loadSemanticAdvisoryTurnByScope,
  });
}

export function querySemanticAdvisoryTurnsByScope(
  context: EngineContext,
  input: {
    readonly scopeDigest: string;
    readonly definitionDigest: string;
    readonly limit: number;
    readonly cursor?: string;
  },
): AsyncIterable<{
  readonly graphs: readonly SemanticTurnPersistenceGraph[];
  readonly nextCursor?: string;
  readonly snapshotRevision: string;
}> {
  return querySemanticTurnsByDefinition(context, input, (exactContext, turnId, exactScopeDigest) =>
    loadSemanticAdvisoryTurnByScope(exactContext, turnId, exactScopeDigest, input.definitionDigest),
  );
}
