import { canonicalJsonText } from "../canonical/canonical-json.js";
import { toJsonValue } from "../canonical/to-json-value.js";
import { invalid, parseNonEmptyText } from "../parse/toolkit.js";
import type { EngineContext, RecordKind } from "../engine/context.js";
import { createOnly, loadStoredRecord, parseWriteResult, recordDigest } from "../engine/context.js";
import { materializeDetectorWindow } from "../engine/detector-window.js";
import { loadEpisodeIdentityState } from "../engine/episode-identity.js";
import {
  loadDetectorExecutionRecord,
  loadInsightDerivationRecord,
  loadRegistrySnapshot,
} from "../engine/semantic-graph.js";
import { parseDerivations } from "../engine/semantic-validation.js";
import {
  assembleSemanticWorkflowDetectorResult,
  assembleSemanticWorkflowDetectorResultFromCompact,
  parseDetectorResultDraft,
} from "../engine/detector-draft.js";
import type { DetectorExecutionRecord } from "../records/detector-execution.js";
import { parseDetectorExecutionRecord } from "../records/detector-execution.js";
import type { InsightDerivation } from "../records/insight-derivation.js";
import { detectorRefKey, lensRefKey, parseDigestAt } from "../records/semantic-shared.js";
import type { SemanticTurnReservation } from "./semantic-turn-intent.js";
import { parseSemanticDisclosureAuthorization, parseSemanticTurnReservation } from "./semantic-turn-intent.js";
import type { SemanticResultBinding, SemanticTurnReceipt } from "./semantic-turn-outcome.js";
import { parseSemanticDispatchMarker, parseSemanticResultBinding } from "./semantic-turn-outcome.js";
import type {
  SemanticWorkflowCompletionIntent,
  SemanticWorkflowAttemptIndex,
  SemanticWorkflowExecutionBinding,
  SemanticWorkflowExecutionPlanLock,
} from "./semantic-generation-record.js";
import {
  parseSemanticWorkflowCompletionIntent,
  parseSemanticWorkflowAttemptIndex,
  parseSemanticWorkflowExecutionBinding,
  parseSemanticWorkflowExecutionPlanLock,
} from "./semantic-generation-record.js";
import { readSemanticWorkflowFields as readFields } from "./workflow-structure.js";
import type { SemanticTurnPersistenceGraph, SemanticTurnPersistenceState } from "./semantic-turn-persistence.js";
import {
  assertAuthorizationBinding,
  assertResultBinding,
  classifySemanticTurnPersistence,
  loadOptionalGlobalExact,
  loadRequiredGlobal,
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
import { querySemanticTurnsByDefinition } from "./semantic-turn-query.js";

const RESERVATION_KIND: RecordKind = "semantic-workflow-reservation";
const DISPATCH_KIND: RecordKind = "semantic-workflow-dispatch";
const RESULT_KIND: RecordKind = "semantic-workflow-result";
const EXECUTION_PLAN_KIND: RecordKind = "semantic-workflow-execution-plan";
const COMPLETION_INTENT_KIND: RecordKind = "semantic-workflow-completion";
const WORKFLOW_EXECUTION_KIND: RecordKind = "semantic-workflow-execution";
const parseUnknown = (input: unknown): unknown => input;

function attemptNamespace(scopeDigest: string, definitionDigest: string): string {
  return `learning-semantic-workflow-attempt-${scopeDigest}-definition-${definitionDigest}`;
}

function parseStoredAttempt(
  input: unknown,
  expected: {
    readonly scopeDigest: string;
    readonly definitionDigest: string;
    readonly attemptId: string;
  },
): SemanticWorkflowAttemptIndex {
  const fields = readFields(input, ["store", "attempt"]);
  const keyFields = readFields(fields.req("key", parseUnknown), ["store", "attempt", "key"]);
  const key = {
    namespace: keyFields.req("namespace", parseNonEmptyText),
    kind: keyFields.req("kind", parseNonEmptyText),
    id: keyFields.req("id", parseNonEmptyText),
  };
  const value = fields.req("value", parseUnknown);
  const digest = fields.req("digest", parseNonEmptyText);
  if (
    key.namespace !== attemptNamespace(expected.scopeDigest, expected.definitionDigest) ||
    key.kind !== "semantic-workflow-attempt" ||
    key.id !== expected.attemptId ||
    digest !== recordDigest(toJsonValue(value))
  ) {
    throw invalid("store.corrupt", "stored semantic workflow attempt has a foreign envelope", []);
  }
  const attempt = parseSemanticWorkflowAttemptIndex(value);
  if (
    attempt.id !== expected.attemptId ||
    attempt.scopeDigest !== expected.scopeDigest ||
    attempt.definitionDigest !== expected.definitionDigest ||
    !sameCanonicalValue(attempt, value)
  ) {
    throw invalid("store.corrupt", "stored semantic workflow attempt differs from its exact key", []);
  }
  return attempt;
}

export async function loadSemanticWorkflowAttempt(
  context: EngineContext,
  input: { readonly attemptId: string; readonly scopeDigest: string; readonly definitionDigest: string },
): Promise<SemanticWorkflowAttemptIndex | undefined> {
  const raw: unknown = await context.store.get({
    namespace: attemptNamespace(input.scopeDigest, input.definitionDigest),
    kind: "semantic-workflow-attempt",
    id: input.attemptId,
  });
  return raw === undefined ? undefined : parseStoredAttempt(raw, input);
}

function expectedExecutionDerivationRefs(execution: DetectorExecutionRecord): readonly {
  readonly id: string;
  readonly derivationDigest: string;
  readonly scopeDigest: string;
}[] {
  return execution.result.status === "applied" ? execution.result.derivationRefs : [];
}

async function assertSemanticGenerationBundle(
  context: EngineContext,
  reservation: SemanticTurnReservation,
  result: SemanticResultBinding,
  binding: SemanticWorkflowExecutionBinding,
  execution: DetectorExecutionRecord,
  derivations: readonly InsightDerivation[],
  revalidateCurrentWindow = true,
): Promise<void> {
  const target = reservation.target;
  if (
    target.kind !== "generation" ||
    result.status !== "completed" ||
    result.normalizedResult === null ||
    binding.turnKeyDigest !== reservation.turnKeyDigest ||
    binding.reservationDigest !== reservation.reservationDigest ||
    binding.resultBindingDigest !== result.bindingDigest ||
    binding.definitionDigest !== reservation.definition.definitionDigest ||
    binding.detectorExecution.id !== execution.id ||
    binding.detectorExecution.executionKeyDigest !== execution.executionKeyDigest ||
    binding.detectorExecution.executionDigest !== execution.executionDigest ||
    binding.workflowExecutionKeyDigest !== execution.executionKeyDigest ||
    execution.executionKeyDigest !== target.executionKeyDigest ||
    execution.window.windowDigest !== target.windowDigest ||
    execution.scopeDigest !== reservation.scopeDigest ||
    execution.result.status !== "applied"
  ) {
    throw invalid("semantic.workflow_output_invalid", "semantic workflow execution binding is not reciprocal", []);
  }
  const plan = await loadSemanticWorkflowExecutionPlan(context, execution.executionKeyDigest);
  const completionIntent = await loadSemanticWorkflowCompletionIntent(context, execution.executionKeyDigest);
  if (
    plan === undefined ||
    plan.turnKeyDigest !== reservation.turnKeyDigest ||
    plan.reservationId !== reservation.id ||
    plan.reservationDigest !== reservation.reservationDigest ||
    plan.definitionDigest !== reservation.definition.definitionDigest ||
    plan.scopeDigest !== reservation.scopeDigest ||
    plan.request.byteLength !== reservation.request.byteLength ||
    plan.request.estimatedInputTokens !== reservation.request.estimatedInputTokens ||
    plan.request.minimizedBytesDigest !== reservation.request.minimizedBytesDigest ||
    plan.request.keyPolicyDigest !== reservation.request.keyPolicyDigest ||
    completionIntent === undefined ||
    !sameCanonicalValue(completionIntent.result, result) ||
    !sameCanonicalValue(completionIntent.workflowExecution, binding) ||
    !sameCanonicalValue(completionIntent.execution, execution) ||
    !sameCanonicalValue(completionIntent.derivations, derivations)
  ) {
    throw invalid("semantic.workflow_output_invalid", "semantic workflow execution has no exact plan lock", []);
  }
  for (const [index, episode] of execution.window.population.episodes.entries()) {
    const projected = completionIntent.episodeCompleteness[index];
    const identity = await loadEpisodeIdentityState(context, episode.episodeRecordId);
    if (
      projected === undefined ||
      projected.episodeRecordId !== episode.episodeRecordId ||
      projected.episodeViewDigest !== episode.episodeViewDigest ||
      identity.status !== "resolved" ||
      recordDigest(toJsonValue(identity.identity)) !== episode.episodeIdentityDigest ||
      projected.completeness !== identity.identity.completeness
    ) {
      throw invalid("semantic.workflow_output_invalid", "semantic workflow episode completeness is invalid", []);
    }
  }
  const expectedRefs = expectedExecutionDerivationRefs(execution);
  if (
    !sameCanonicalValue(binding.derivationRefs, expectedRefs) ||
    !sameCanonicalValue(
      derivations.map((derivation) => ({
        id: derivation.id,
        derivationDigest: derivation.derivationDigest,
        scopeDigest: derivation.scopeDigest,
      })),
      expectedRefs,
    ) ||
    (execution.result.conditionDetected ? expectedRefs.length === 0 : expectedRefs.length !== 0)
  ) {
    throw invalid(
      "semantic.workflow_output_invalid",
      "semantic workflow derivations do not match the child result",
      [],
    );
  }
  const draft = parseDetectorResultDraft(result.normalizedResult);
  if (
    draft.findings.length !== 0 ||
    (draft.conditionDetected && draft.insights.length === 0) ||
    (!draft.conditionDetected && draft.insights.length !== 0) ||
    execution.result.status !== "applied" ||
    execution.result.conditionDetected !== draft.conditionDetected
  ) {
    throw invalid("semantic.workflow_output_invalid", "semantic generation result has invalid output cardinality", []);
  }
  const draftProjections = draft.insights
    .map((insight) =>
      canonicalJsonText(
        toJsonValue({
          learningClass: insight.learningClass,
          directObservation: insight.directObservation,
          interpretation: insight.interpretation,
          impactHypothesis: insight.impactHypothesis,
          contradictoryEvidenceReferenceDigests: insight.contradictoryEvidenceReferenceDigests,
          evidenceHealthFindingIds: insight.evidenceHealthFindingIds,
          missingEvidence: insight.missingEvidence,
          applicability: insight.applicability,
          candidateIntervention: insight.candidateIntervention,
          validation: insight.validation,
          supersedes: insight.supersedes,
        }),
      ),
    )
    .sort();
  const derivationProjections = derivations
    .map((derivation) =>
      canonicalJsonText(
        toJsonValue({
          learningClass: derivation.learningClass,
          directObservation: {
            statement: derivation.directObservation.statement,
            data: derivation.directObservation.data,
            evidenceReferenceDigests: derivation.directObservation.evidenceRefs.map(
              (reference) => reference.referenceDigest,
            ),
          },
          interpretation: derivation.interpretation,
          impactHypothesis: derivation.impactHypothesis,
          contradictoryEvidenceReferenceDigests: derivation.contradictoryEvidenceRefs.map(
            (reference) => reference.referenceDigest,
          ),
          evidenceHealthFindingIds: derivation.evidenceHealthFindings.map((finding) => finding.id),
          missingEvidence: derivation.missingEvidence,
          applicability: derivation.applicability,
          candidateIntervention: derivation.candidateIntervention,
          validation: derivation.validation,
          supersedes:
            derivation.supersedes === null
              ? null
              : { id: derivation.supersedes.id, digest: derivation.supersedes.derivationDigest },
        }),
      ),
    )
    .sort();
  if (!sameCanonicalValue(draftProjections, derivationProjections)) {
    throw invalid(
      "semantic.workflow_output_invalid",
      "semantic derivations differ from the normalized provider result",
      [],
    );
  }
  const disclosedEvidence = new Set(target.disclosedEvidenceReferenceDigests);
  const disclosedHealth = new Map(
    (target.disclosedEvidenceHealthFindings ?? []).map((finding) => [finding.id, finding.findingDigest]),
  );
  for (const derivation of derivations) {
    const producer = derivation.producer;
    const expectedDisclosure =
      reservation.definition.transport === "outbound"
        ? {
            receiptId: result.id,
            receiptDigest: result.bindingDigest,
            minimizedBytesDigest: reservation.request.minimizedBytesDigest,
          }
        : null;
    if (
      producer.kind !== "semantic_judgment" ||
      producer.implementationId !== reservation.definition.implementation.id ||
      producer.implementationVersion !== reservation.definition.implementation.version ||
      producer.implementationDigest !== reservation.definition.implementation.implementationDigest ||
      !sameCanonicalValue(producer.principal, reservation.definition.principal) ||
      !sameCanonicalValue(producer.attestation, reservation.definition.attestation) ||
      producer.modelFingerprintDigest !== reservation.definition.providerModel.model.modelFingerprintDigest ||
      producer.promptDigest !== reservation.definition.prompt.promptDigest ||
      producer.toolPolicyDigest !== reservation.definition.toolPolicy.policyDigest ||
      producer.budgetPolicyDigest !== reservation.definition.budgetPolicy.policyDigest ||
      !sameCanonicalValue(producer.disclosure, expectedDisclosure) ||
      [...derivation.directObservation.evidenceRefs, ...derivation.contradictoryEvidenceRefs].some(
        (reference) => !disclosedEvidence.has(reference.referenceDigest),
      ) ||
      derivation.evidenceHealthFindings.some((finding) => disclosedHealth.get(finding.id) !== finding.findingDigest)
    ) {
      throw invalid("semantic.workflow_output_invalid", "semantic derivation has invalid workflow lineage", []);
    }
  }
  const recovered = assembleSemanticWorkflowDetectorResultFromCompact({
    executionTemplate: completionIntent.executionTemplate,
    episodeCompleteness: completionIntent.episodeCompleteness.map((entry) => entry.completeness),
    draft,
    definition: reservation.definition,
    reservation,
    result,
  });
  if (!sameCanonicalValue(recovered.execution, execution) || !sameCanonicalValue(recovered.derivations, derivations)) {
    throw invalid(
      "semantic.workflow_output_invalid",
      "semantic workflow recovery assembly differs from its intent",
      [],
    );
  }
  if (!revalidateCurrentWindow) return;
  const detector = context.semanticDetectorsByRef?.get(detectorRefKey(target.detector));
  const lens = context.semanticLensesByRef?.get(lensRefKey(target.lens));
  if (detector === undefined || lens === undefined) {
    throw invalid("semantic.workflow_historical", "semantic generation target is not current", []);
  }
  const materialized = await materializeDetectorWindow({
    context,
    detector,
    pack: target.pack,
    lens: target.lens,
    lensRegistration: lens,
    scope: execution.scope,
    episodeRecordIds: target.episodeRecordIds,
  });
  if (
    !materialized.bindable ||
    materialized.status !== "ready" ||
    materialized.window.windowDigest !== target.windowDigest
  ) {
    throw invalid("semantic.workflow_historical", "semantic generation window changed before persistence", []);
  }
  const assembled = assembleSemanticWorkflowDetectorResult({
    window: materialized.window,
    draft,
    definition: reservation.definition,
    reservation,
    result,
  });
  if (!sameCanonicalValue(assembled.execution, execution) || !sameCanonicalValue(assembled.derivations, derivations)) {
    throw invalid("semantic.workflow_output_invalid", "semantic workflow child graph differs from exact assembly", []);
  }
}

export function loadSemanticWorkflowExecutionPlan(
  context: EngineContext,
  detectorExecutionKeyDigest: string,
): Promise<SemanticWorkflowExecutionPlanLock | undefined> {
  return loadOptionalGlobalExact(
    context,
    EXECUTION_PLAN_KIND,
    `semantic-workflow-execution-plan-${detectorExecutionKeyDigest}`,
    parseSemanticWorkflowExecutionPlanLock,
  );
}

export function loadSemanticWorkflowExecutionBinding(
  context: EngineContext,
  detectorExecutionKeyDigest: string,
): Promise<SemanticWorkflowExecutionBinding | undefined> {
  return loadOptionalGlobalExact(
    context,
    WORKFLOW_EXECUTION_KIND,
    `semantic-workflow-execution-${detectorExecutionKeyDigest}`,
    parseSemanticWorkflowExecutionBinding,
  );
}

export function loadSemanticWorkflowCompletionIntent(
  context: EngineContext,
  detectorExecutionKeyDigest: string,
): Promise<SemanticWorkflowCompletionIntent | undefined> {
  const id = `semantic-workflow-completion-${detectorExecutionKeyDigest}`;
  return loadStoredRecord(context, COMPLETION_INTENT_KIND, id).then((stored) => {
    if (stored === undefined) return undefined;
    const parsed = parseSemanticWorkflowCompletionIntent(stored.value);
    if (parsed.id !== id || !sameCanonicalValue(stored.value, parsed)) {
      throw invalid("store.corrupt", "stored workflow completion intent differs from its exact key", []);
    }
    return parsed;
  });
}

async function persistCompletionIntentExact(
  context: EngineContext,
  intent: SemanticWorkflowCompletionIntent,
): Promise<SemanticWorkflowCompletionIntent> {
  const parsed = parseSemanticWorkflowCompletionIntent(intent);
  const status = await createOnly(
    context,
    COMPLETION_INTENT_KIND,
    parsed.id,
    parsed,
    `semantic-workflow/${COMPLETION_INTENT_KIND}/${parsed.id}`,
  );
  if (status === "conflict") throw invalid("store.conflict", "workflow completion intent conflicts", []);
  const stored = await loadSemanticWorkflowCompletionIntent(context, parsed.detectorExecutionKeyDigest);
  if (stored === undefined || !sameCanonicalValue(stored, parsed)) {
    throw invalid("store.corrupt", "workflow completion intent was not preserved", []);
  }
  return stored;
}

export async function persistSemanticWorkflowExecutionPlan(
  context: EngineContext,
  input: unknown,
): Promise<SemanticWorkflowExecutionPlanLock> {
  const fields = readFields(input, ["semanticWorkflowExecutionPlan"]);
  const candidateReservation = fields.req("reservation", (value) => parseSemanticTurnReservation(value));
  const reservation = await reloadExactCommitted(
    context,
    RESERVATION_KIND,
    candidateReservation,
    parseSemanticTurnReservation,
  );
  const plan = fields.req("plan", parseSemanticWorkflowExecutionPlanLock);
  const target = reservation.target;
  if (
    target.kind !== "generation" ||
    plan.detectorExecutionKeyDigest !== target.executionKeyDigest ||
    plan.turnKeyDigest !== reservation.turnKeyDigest ||
    plan.reservationId !== reservation.id ||
    plan.reservationDigest !== reservation.reservationDigest ||
    plan.definitionDigest !== reservation.definition.definitionDigest ||
    plan.scopeDigest !== reservation.scopeDigest ||
    plan.request.byteLength !== reservation.request.byteLength ||
    plan.request.estimatedInputTokens !== reservation.request.estimatedInputTokens ||
    plan.request.minimizedBytesDigest !== reservation.request.minimizedBytesDigest ||
    plan.request.keyPolicyDigest !== reservation.request.keyPolicyDigest
  ) {
    throw invalid("schema.corrupt", "workflow execution plan does not bind its exact reservation", []);
  }
  return persistGlobalExact(context, EXECUTION_PLAN_KIND, plan, parseSemanticWorkflowExecutionPlanLock);
}

export async function persistSemanticWorkflowAttempt(context: EngineContext, input: unknown): Promise<void> {
  const fields = readFields(input, ["semanticWorkflowAttempt"]);
  const candidateReservation = fields.req("reservation", parseSemanticTurnReservation);
  const reservation = await reloadExactCommitted(
    context,
    RESERVATION_KIND,
    candidateReservation,
    parseSemanticTurnReservation,
  );
  const plan = fields.req("plan", parseSemanticWorkflowExecutionPlanLock);
  await reloadExactCommitted(context, EXECUTION_PLAN_KIND, plan, parseSemanticWorkflowExecutionPlanLock);
  const attempt = fields.req("attempt", parseSemanticWorkflowAttemptIndex);
  const target = reservation.target;
  if (
    target.kind !== "generation" ||
    attempt.scopeDigest !== reservation.scopeDigest ||
    attempt.definitionDigest !== reservation.definition.definitionDigest ||
    attempt.reservationId !== reservation.id ||
    attempt.reservationDigest !== reservation.reservationDigest ||
    attempt.planLockId !== plan.id ||
    attempt.planLockDigest !== plan.lockDigest ||
    attempt.detectorExecutionKeyDigest !== target.executionKeyDigest
  ) {
    throw invalid("schema.corrupt", "semantic workflow attempt does not bind its exact plan", []);
  }
  const value = toJsonValue(attempt);
  const rawResult: unknown = await context.store.create(
    {
      namespace: attemptNamespace(attempt.scopeDigest, attempt.definitionDigest),
      kind: "semantic-workflow-attempt",
      id: attempt.id,
    },
    value,
    recordDigest(value),
    `semantic-workflow/attempt/${attempt.scopeDigest}/${attempt.definitionDigest}/${attempt.id}`,
  );
  const result = parseWriteResult(rawResult);
  if (result.status === "updated") throw invalid("store.corrupt", "semantic workflow attempt was updated", []);
  if (result.status === "conflict") throw invalid("store.conflict", "semantic workflow attempt conflicts", []);
  const stored = await loadSemanticWorkflowAttempt(context, {
    attemptId: attempt.id,
    scopeDigest: attempt.scopeDigest,
    definitionDigest: attempt.definitionDigest,
  });
  if (stored === undefined || !sameCanonicalValue(stored, attempt)) {
    throw invalid("store.corrupt", "semantic workflow attempt was not preserved", []);
  }
}

/**
 * First awaited post-callback write. The intent owns every normalized byte
 * needed for forward completion; raw provider/request bytes are absent.
 */
export async function persistSemanticWorkflowCompletionIntent(
  context: EngineContext,
  input: unknown,
): Promise<SemanticWorkflowCompletionIntent> {
  const fields = readFields(input, ["semanticWorkflowCompletionIntent"]);
  const reservation = fields.req("reservation", parseSemanticTurnReservation);
  const authorization = fields.req("authorization", (value) =>
    value === null ? null : parseSemanticDisclosureAuthorization(value, reservation),
  );
  const dispatch = fields.req("dispatch", parseSemanticDispatchMarker);
  const plan = fields.req("plan", parseSemanticWorkflowExecutionPlanLock);
  const intent = fields.req("intent", parseSemanticWorkflowCompletionIntent);
  assertAuthorizationBinding(reservation, authorization, dispatch);
  assertResultBinding(reservation, dispatch, intent.result);
  const target = reservation.target;
  if (
    target.kind !== "generation" ||
    plan.detectorExecutionKeyDigest !== target.executionKeyDigest ||
    plan.turnKeyDigest !== reservation.turnKeyDigest ||
    plan.reservationId !== reservation.id ||
    plan.reservationDigest !== reservation.reservationDigest ||
    plan.lockDigest !== intent.planLockDigest ||
    intent.detectorExecutionKeyDigest !== target.executionKeyDigest ||
    intent.turnKeyDigest !== reservation.turnKeyDigest ||
    intent.reservationDigest !== reservation.reservationDigest ||
    intent.registrySnapshot.loopRegistryRevision !== reservation.loopRegistryRevision ||
    intent.registrySnapshot.semanticRegistry.registryDigest !== reservation.semanticRegistryDigest
  ) {
    throw invalid("semantic.workflow_output_invalid", "completion intent does not bind its exact prepared plan", []);
  }
  // No await occurs before this create-only intent write.
  const storedIntent = await persistCompletionIntentExact(context, intent);
  const committedReservation = await reloadExactCommitted(
    context,
    RESERVATION_KIND,
    reservation,
    parseSemanticTurnReservation,
  );
  await reloadExactCommitted(context, EXECUTION_PLAN_KIND, plan, parseSemanticWorkflowExecutionPlanLock);
  await reloadExactCommitted(context, DISPATCH_KIND, dispatch, parseSemanticDispatchMarker);
  await reloadAuthorizationInput(context, committedReservation, authorization);
  await assertSemanticGenerationBundle(
    context,
    committedReservation,
    storedIntent.result,
    storedIntent.workflowExecution,
    storedIntent.execution,
    storedIntent.derivations,
    false,
  );
  return storedIntent;
}

/** Outbound-only authorization write after the exact reservation is committed. */

export async function persistSemanticCompletedGeneration(
  context: EngineContext,
  input: unknown,
): Promise<{
  readonly result: SemanticResultBinding;
  readonly workflowExecution: SemanticWorkflowExecutionBinding;
}> {
  const fields = readFields(input, ["semanticCompletedGeneration"]);
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
    throw invalid("schema.invalid", "typed semantic generation persistence requires a completed result", []);
  }
  const workflowExecution = fields.req("workflowExecution", parseSemanticWorkflowExecutionBinding);
  const execution = fields.req("execution", parseDetectorExecutionRecord);
  const derivations = fields.req("derivations", parseDerivations);
  const completionIntent = await loadSemanticWorkflowCompletionIntent(context, execution.executionKeyDigest);
  if (
    completionIntent === undefined ||
    !sameCanonicalValue(completionIntent.result, result) ||
    !sameCanonicalValue(completionIntent.workflowExecution, workflowExecution) ||
    !sameCanonicalValue(completionIntent.execution, execution) ||
    !sameCanonicalValue(completionIntent.derivations, derivations)
  ) {
    throw invalid("semantic.workflow_incomplete", "completed semantic generation has no exact recovery intent", []);
  }
  await assertSemanticGenerationBundle(context, reservation, result, workflowExecution, execution, derivations, false);
  const storedResult = await persistGlobalExact(context, RESULT_KIND, result, parseSemanticResultBinding);
  const storedWorkflowExecution = await persistGlobalExact(
    context,
    WORKFLOW_EXECUTION_KIND,
    workflowExecution,
    parseSemanticWorkflowExecutionBinding,
  );
  return { result: storedResult, workflowExecution: storedWorkflowExecution };
}

export async function persistSemanticCompletedGenerationTerminal(
  context: EngineContext,
  input: unknown,
): Promise<SemanticTurnReceipt> {
  const fields = readFields(input, ["semanticCompletedGenerationTerminal"]);
  const graph = fields.req("graph", parseSemanticTurnPersistenceGraph);
  if (graph.result.status !== "completed" || graph.reservation.target.kind !== "generation") {
    throw invalid("schema.invalid", "completed generation terminal requires a completed generation graph", []);
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
  const workflowExecutionInput = fields.req("workflowExecution", parseSemanticWorkflowExecutionBinding);
  const workflowExecution = await reloadExactCommitted(
    context,
    WORKFLOW_EXECUTION_KIND,
    workflowExecutionInput,
    parseSemanticWorkflowExecutionBinding,
  );
  const execution = await loadDetectorExecutionRecord(context, workflowExecution.detectorExecution.id);
  if (
    execution === undefined ||
    execution.executionKeyDigest !== workflowExecution.detectorExecution.executionKeyDigest ||
    execution.executionDigest !== workflowExecution.detectorExecution.executionDigest
  ) {
    throw invalid("semantic.workflow_incomplete", "semantic workflow child execution receipt is unavailable", []);
  }
  const derivations: InsightDerivation[] = [];
  for (const reference of workflowExecution.derivationRefs) {
    const derivation = await loadInsightDerivationRecord(context, reference.id);
    if (
      derivation === undefined ||
      derivation.derivationDigest !== reference.derivationDigest ||
      derivation.scopeDigest !== reference.scopeDigest
    ) {
      throw invalid("semantic.workflow_incomplete", "semantic workflow child derivation is unavailable", []);
    }
    derivations.push(derivation);
  }
  await assertSemanticGenerationBundle(context, reservation, result, workflowExecution, execution, derivations, false);
  const output = graph.turn.output;
  if (
    (execution.result.status === "applied" &&
      !execution.result.conditionDetected &&
      (output.kind !== "none" || output.reasonCode !== "workflow.condition_not_detected")) ||
    (execution.result.status === "applied" &&
      execution.result.conditionDetected &&
      (output.kind !== "generation" ||
        output.workflowExecutionId !== workflowExecution.id ||
        output.workflowExecutionKeyDigest !== workflowExecution.workflowExecutionKeyDigest ||
        output.workflowExecutionDigest !== workflowExecution.workflowExecutionDigest ||
        !sameCanonicalValue(output.derivationRefs, workflowExecution.derivationRefs)))
  ) {
    throw invalid("schema.corrupt", "semantic workflow terminal output is not reciprocal", []);
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

async function validateSemanticWorkflowExecutionLineageInternal(
  context: EngineContext,
  execution: DetectorExecutionRecord,
  requireTerminal: boolean,
  suppliedDerivations?: readonly InsightDerivation[],
): Promise<void> {
  const plan = await loadSemanticWorkflowExecutionPlan(context, execution.executionKeyDigest);
  const binding = await loadSemanticWorkflowExecutionBinding(context, execution.executionKeyDigest);
  const completionIntent = await loadSemanticWorkflowCompletionIntent(context, execution.executionKeyDigest);
  if (plan === undefined && binding === undefined && completionIntent === undefined) {
    const storedSnapshot = await loadRegistrySnapshot(context, execution.loopRegistryRevision);
    const registry =
      storedSnapshot?.semanticRegistry ??
      (execution.loopRegistryRevision === context.registryRevision ? context.semanticRegistry : undefined);
    const detector = registry?.detectors.find(
      (candidate) => detectorRefKey(candidate) === detectorRefKey(execution.detector),
    );
    const executionLens = execution.lens;
    const lens =
      executionLens === null
        ? undefined
        : registry?.lenses.find((candidate) => lensRefKey(candidate) === lensRefKey(executionLens));
    const workflowDefinitionDigest =
      detector === undefined
        ? undefined
        : readFields(detector.configuration, ["detector", "configuration"]).opt(
            "workflowDefinitionDigest",
            parseDigestAt,
          );
    if (
      workflowDefinitionDigest !== undefined &&
      lens?.generatorPolicy.allowedKinds.includes("semantic_judgment") === true &&
      !lens.generatorPolicy.allowedKinds.includes("deterministic")
    ) {
      throw invalid(
        requireTerminal ? "store.corrupt" : "semantic.workflow_incomplete",
        "semantic execution has no workflow lineage",
        [],
      );
    }
    let semanticProducerPresent =
      suppliedDerivations?.some((derivation) => derivation.producer.kind === "semantic_judgment") === true;
    if (requireTerminal && !semanticProducerPresent) {
      for (const reference of expectedExecutionDerivationRefs(execution)) {
        const derivation = await loadInsightDerivationRecord(context, reference.id);
        if (derivation?.producer.kind === "semantic_judgment") {
          semanticProducerPresent = true;
          break;
        }
      }
    }
    if (semanticProducerPresent) {
      throw invalid(
        requireTerminal ? "store.corrupt" : "semantic.workflow_incomplete",
        "semantic derivation has no workflow lineage",
        [],
      );
    }
    return;
  }
  const references = expectedExecutionDerivationRefs(execution);
  const derivations: InsightDerivation[] = [];
  if (!requireTerminal && completionIntent !== undefined) {
    derivations.push(...completionIntent.derivations);
  } else {
    for (const reference of references) {
      const derivation = await loadInsightDerivationRecord(context, reference.id);
      if (
        derivation === undefined ||
        derivation.derivationDigest !== reference.derivationDigest ||
        derivation.scopeDigest !== reference.scopeDigest
      ) {
        throw invalid("store.corrupt", "semantic workflow derivation lineage is unavailable", []);
      }
      derivations.push(derivation);
    }
  }
  if (
    plan === undefined ||
    binding === undefined ||
    completionIntent === undefined ||
    !sameCanonicalValue(completionIntent.workflowExecution, binding) ||
    !sameCanonicalValue(completionIntent.execution, execution) ||
    !sameCanonicalValue(completionIntent.derivations, derivations)
  ) {
    throw invalid("store.corrupt", "semantic child execution has no exact workflow binding", []);
  }
  const reservation = await loadRequiredGlobal(
    context,
    RESERVATION_KIND,
    plan.reservationId,
    parseSemanticTurnReservation,
  );
  const result = await loadRequiredGlobal(
    context,
    RESULT_KIND,
    `semantic-workflow-result-${reservation.turnKeyDigest}`,
    parseSemanticResultBinding,
  );
  if (!sameCanonicalValue(completionIntent.result, result)) {
    throw invalid("store.corrupt", "semantic child execution result differs from its recovery intent", []);
  }
  await assertSemanticGenerationBundle(context, reservation, result, binding, execution, derivations, false);
  if (!requireTerminal) return;
  const graph = await loadSemanticGenerationTurnByScope(
    context,
    `semantic-workflow-turn-${reservation.turnKeyDigest}`,
    reservation.scopeDigest,
  );
  if (graph === undefined || graph.result.bindingDigest !== result.bindingDigest) {
    throw invalid("store.corrupt", "semantic child execution has no exact terminal workflow receipt", []);
  }
}

export function validateSemanticWorkflowExecutionPrewriteLineage(
  context: EngineContext,
  execution: DetectorExecutionRecord,
  derivations: readonly InsightDerivation[],
): Promise<void> {
  return validateSemanticWorkflowExecutionLineageInternal(context, execution, false, derivations);
}

export function validateSemanticWorkflowExecutionLineage(
  context: EngineContext,
  execution: DetectorExecutionRecord,
): Promise<void> {
  return validateSemanticWorkflowExecutionLineageInternal(context, execution, true);
}

export async function loadSemanticGenerationTurnByScope(
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
  if (target.kind !== "generation") {
    throw invalid("semantic.workflow_output_unavailable", "completed advisory workflow output is unavailable", []);
  }
  const plan = await loadSemanticWorkflowExecutionPlan(context, target.executionKeyDigest);
  const completionIntent = await loadSemanticWorkflowCompletionIntent(context, target.executionKeyDigest);
  const workflowExecution = await loadSemanticWorkflowExecutionBinding(context, target.executionKeyDigest);
  const execution = await loadDetectorExecutionRecord(context, `detector-execution-${target.executionKeyDigest}`);
  if (
    plan === undefined &&
    completionIntent === undefined &&
    workflowExecution === undefined &&
    execution === undefined
  ) {
    throw invalid(
      "semantic.workflow_output_unavailable",
      "completed semantic result has no typed generation integration",
      [],
    );
  }
  if (
    workflowExecution === undefined ||
    execution === undefined ||
    completionIntent === undefined ||
    plan === undefined
  ) {
    throw invalid("store.corrupt", "completed semantic turn has an incomplete generation graph", []);
  }
  const derivations: InsightDerivation[] = [];
  for (const reference of workflowExecution.derivationRefs) {
    const derivation = await loadInsightDerivationRecord(context, reference.id);
    if (
      derivation === undefined ||
      derivation.derivationDigest !== reference.derivationDigest ||
      derivation.scopeDigest !== reference.scopeDigest
    ) {
      throw invalid("store.corrupt", "completed semantic turn has a missing child derivation", []);
    }
    derivations.push(derivation);
  }
  await assertSemanticGenerationBundle(
    context,
    graph.reservation,
    graph.result,
    workflowExecution,
    execution,
    derivations,
    false,
  );
  const output = graph.turn.output;
  if (
    execution.result.status !== "applied" ||
    (!execution.result.conditionDetected &&
      (output.kind !== "none" || output.reasonCode !== "workflow.condition_not_detected")) ||
    (execution.result.conditionDetected &&
      (output.kind !== "generation" ||
        output.workflowExecutionId !== workflowExecution.id ||
        output.workflowExecutionKeyDigest !== workflowExecution.workflowExecutionKeyDigest ||
        output.workflowExecutionDigest !== workflowExecution.workflowExecutionDigest ||
        !sameCanonicalValue(output.derivationRefs, workflowExecution.derivationRefs)))
  ) {
    throw invalid("store.corrupt", "completed semantic turn output is not reciprocal", []);
  }
  return graph;
}

export function classifySemanticGenerationTurnPersistence(
  context: EngineContext,
  reservationInput: unknown,
): Promise<SemanticTurnPersistenceState> {
  return classifySemanticTurnPersistence(context, reservationInput, {
    allowCompleted: true,
    loadGraph: loadSemanticGenerationTurnByScope,
  });
}

export function querySemanticGenerationTurnsByScope(
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
    loadSemanticGenerationTurnByScope(exactContext, turnId, exactScopeDigest, input.definitionDigest),
  );
}
