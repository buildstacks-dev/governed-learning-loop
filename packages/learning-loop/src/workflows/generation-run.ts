import { Buffer } from "node:buffer";
import { canonicalJsonText, sha256HexOfCanonicalJson } from "../canonical/canonical-json.js";
import { toJsonValue } from "../canonical/to-json-value.js";
import { invalid } from "../parse/toolkit.js";
import { LearningLoopError } from "../diagnostics.js";
import { assertVerifiedPrincipal } from "../engine/identity.js";
import { assembleSemanticWorkflowDetectorResult, parseDetectorResultDraft } from "../engine/detector-draft.js";
import { persistSemanticWorkflowDetectorExecution } from "../engine/semantic-persistence.js";
import { buildUnavailableExecutionRecurrenceBinding } from "../engine/detector-recurrence.js";
import { parseDurableId, scopeDigest } from "../records/semantic-shared.js";
import type { EngineContext } from "../engine/context.js";
import { loadStoredRecord } from "../engine/context.js";
import type { SemanticDisclosureAuthorization } from "./semantic-turn-intent.js";
import { buildSemanticDisclosureAuthorization, parseSemanticTurnReservation } from "./semantic-turn-intent.js";
import type { SemanticDispatchMarker, SemanticResultBinding, SemanticTurnReceipt } from "./semantic-turn-outcome.js";
import {
  buildSemanticResultBinding,
  buildSemanticTurnReceipt,
  buildSemanticTurnScopeIndex,
  semanticNormalizedResultDigest,
} from "./semantic-turn-outcome.js";
import {
  buildSemanticWorkflowCompletionIntent,
  buildSemanticWorkflowExecutionBinding,
} from "./semantic-generation-record.js";
import {
  classifySemanticGenerationTurnPersistence,
  loadSemanticWorkflowAttempt,
  loadSemanticWorkflowCompletionIntent,
  loadSemanticWorkflowExecutionPlan,
  persistSemanticCompletedGeneration,
  persistSemanticCompletedGenerationTerminal,
  persistSemanticWorkflowCompletionIntent,
  persistSemanticWorkflowExecutionPlan,
  persistSemanticWorkflowAttempt,
} from "./semantic-generation-persistence.js";
import {
  claimSemanticDispatch,
  loadRequiredGlobal,
  loadSemanticDefinitionTurn,
  persistSemanticDisclosureAuthorization,
  persistSemanticTurnReservation,
} from "./semantic-turn-persistence.js";
import type { SemanticWorkflowBundle } from "./types.js";
import type { SemanticWorkflowDefinition } from "./workflow-definition.js";
import { readSemanticWorkflowFields as readFields, snapshotSemanticWorkflowJson } from "./workflow-structure.js";
import { GENERATION_RESULT_SCHEMA_ID, GENERATION_RESULT_SCHEMA_VERSION } from "./generation-schema.js";
import type { PreparedPlanBinding } from "./generation-internal.js";
import { authorizationCapabilities, bytesOf, preparedPlans } from "./generation-internal.js";
import type { ParsedProviderEnvelope } from "./run-shared.js";
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

function planFor(
  token: object,
  input: unknown,
  path: readonly (string | number)[],
): {
  readonly handle: object;
  readonly binding: PreparedPlanBinding;
} {
  if (typeof input !== "object" || input === null) {
    throw invalid("semantic.workflow_plan_invalid", "semantic generation plan is not a capability", path);
  }
  const binding = preparedPlans.get(input);
  if (binding === undefined || binding.token !== token) {
    throw invalid("semantic.workflow_plan_invalid", "semantic generation plan belongs to another bundle", path);
  }
  return { handle: input, binding };
}

export async function authorizeGeneration(
  token: object,
  input: unknown,
): ReturnType<SemanticWorkflowBundle["authorizeGeneration"]> {
  const fields = readFields(input, ["authorizeGeneration"]);
  const exact = planFor(
    token,
    fields.req("plan", (value) => value),
    ["plan"],
  );
  const plan = exact.binding;
  if (plan.definition.transport !== "outbound" || plan.callbacks.authorize === undefined) {
    throw invalid("semantic.workflow_disclosure_forbidden", "local semantic generation needs no authorization", []);
  }
  if (Date.parse(plan.context.clock.now()) >= Date.parse(plan.reservation.expiresAt)) {
    throw invalid("semantic.workflow_expired", "semantic generation plan has expired", []);
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

function assertAttemptMatchesPreparedPlan(
  winningAttempt: Awaited<ReturnType<typeof loadSemanticWorkflowAttempt>>,
  plan: PreparedPlanBinding,
): void {
  if (
    winningAttempt !== undefined &&
    (winningAttempt.attemptDigest !== plan.attempt.attemptDigest ||
      winningAttempt.reservationDigest !== plan.reservation.reservationDigest ||
      winningAttempt.planLockDigest !== plan.planLock.lockDigest ||
      winningAttempt.definitionDigest !== plan.definition.definitionDigest ||
      winningAttempt.scopeDigest !== plan.reservation.scopeDigest)
  ) {
    throw invalid("store.conflict", "semantic workflow execution key is owned by another prepared request", []);
  }
}

type PersistedGeneration = Pick<PreparedPlanBinding, "context" | "definition" | "reservation">;

function commitNoncompletedGenerationTurn(input: {
  readonly plan: PersistedGeneration;
  readonly authorization: SemanticDisclosureAuthorization | null;
  readonly dispatch: SemanticDispatchMarker;
  readonly result: SemanticResultBinding;
}): Promise<string> {
  return commitNoncompletedTurn({
    context: input.plan.context,
    reservation: input.plan.reservation,
    definitionDigest: input.plan.definition.definitionDigest,
    lane: "generation",
    authorization: input.authorization,
    dispatch: input.dispatch,
    result: input.result,
  });
}

async function completeFromIntent(input: {
  readonly plan: PersistedGeneration;
  readonly authorization: SemanticDisclosureAuthorization | null;
  readonly dispatch: SemanticDispatchMarker;
  readonly intent: ReturnType<typeof buildSemanticWorkflowCompletionIntent>;
  readonly persistence: "committed" | "existing";
  readonly callbackInvoked: boolean;
}): Promise<{
  readonly status: "completed";
  readonly persistence: "committed" | "existing";
  readonly callbackInvoked: boolean;
  readonly turnId: string;
  readonly execution: ReturnType<typeof buildSemanticWorkflowCompletionIntent>["execution"];
  readonly derivations: ReturnType<typeof buildSemanticWorkflowCompletionIntent>["derivations"];
}> {
  const { plan, authorization, dispatch, intent } = input;
  await persistSemanticCompletedGeneration(plan.context, {
    reservation: plan.reservation,
    authorization,
    dispatch,
    result: intent.result,
    workflowExecution: intent.workflowExecution,
    execution: intent.execution,
    derivations: intent.derivations,
  });
  await persistSemanticWorkflowDetectorExecution(
    plan.context,
    intent.execution,
    intent.derivations,
    intent.registrySnapshot,
  );
  const positive = intent.execution.result.status === "applied" && intent.execution.result.conditionDetected;
  const output: SemanticTurnReceipt["output"] = positive
    ? {
        kind: "generation",
        workflowExecutionId: intent.workflowExecution.id,
        workflowExecutionKeyDigest: intent.workflowExecution.workflowExecutionKeyDigest,
        workflowExecutionDigest: intent.workflowExecution.workflowExecutionDigest,
        derivationRefs: intent.workflowExecution.derivationRefs,
      }
    : { kind: "none", reasonCode: "workflow.condition_not_detected" };
  const turn = buildSemanticTurnReceipt({
    turnKeyDigest: plan.reservation.turnKeyDigest,
    reservation: { id: plan.reservation.id, reservationDigest: plan.reservation.reservationDigest },
    authorization:
      authorization === null ? null : { id: authorization.id, authorizationDigest: authorization.authorizationDigest },
    dispatch: { id: dispatch.id, dispatchDigest: dispatch.dispatchDigest },
    result: { id: intent.result.id, bindingDigest: intent.result.bindingDigest },
    lane: "generation",
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
  await persistSemanticCompletedGenerationTerminal(plan.context, {
    graph: {
      reservation: plan.reservation,
      authorization,
      dispatch,
      result: intent.result,
      scopeIndex,
      turn,
    },
    workflowExecution: intent.workflowExecution,
  });
  return {
    status: "completed",
    persistence: input.persistence,
    callbackInvoked: input.callbackInvoked,
    turnId: turn.id,
    execution: intent.execution,
    derivations: intent.derivations,
  };
}

export async function recoverGeneration(
  context: EngineContext,
  definition: SemanticWorkflowDefinition,
  input: unknown,
): ReturnType<SemanticWorkflowBundle["recoverGeneration"]> {
  const fields = readFields(input, ["recoverGeneration"]);
  const attemptId = fields.req("attemptId", parseDurableId);
  const exactScope = Object.freeze(
    context.scopePolicy
      .validate(fields.req("scope", (value) => value))
      .map((segment) => Object.freeze({ type: segment.type, id: segment.id })),
  );
  const exactScopeDigest = scopeDigest(exactScope);
  const attempt = await loadSemanticWorkflowAttempt(context, {
    attemptId,
    scopeDigest: exactScopeDigest,
    definitionDigest: definition.definitionDigest,
  });
  if (attempt === undefined) {
    return {
      status: "not_dispatched",
      persistence: "not_dispatched",
      callbackInvoked: false,
      turnId: null,
      derivations: [],
    };
  }
  const reservation = await loadRequiredGlobal(
    context,
    "semantic-workflow-reservation",
    attempt.reservationId,
    parseSemanticTurnReservation,
  );
  const planLock = await loadSemanticWorkflowExecutionPlan(context, attempt.detectorExecutionKeyDigest);
  if (
    reservation.reservationDigest !== attempt.reservationDigest ||
    reservation.scopeDigest !== exactScopeDigest ||
    reservation.definition.definitionDigest !== definition.definitionDigest ||
    planLock === undefined ||
    planLock.id !== attempt.planLockId ||
    planLock.lockDigest !== attempt.planLockDigest
  ) {
    throw invalid("store.corrupt", "semantic workflow recovery attempt is not reciprocal", []);
  }
  const persisted: PersistedGeneration = { context, definition, reservation };
  const state = await classifySemanticGenerationTurnPersistence(context, reservation);
  const intent = await loadSemanticWorkflowCompletionIntent(context, attempt.detectorExecutionKeyDigest);
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
      throw invalid("store.corrupt", "undispatched semantic attempt has impossible output facts", []);
    }
    return {
      status: "not_dispatched",
      persistence: "not_dispatched",
      callbackInvoked: false,
      turnId: null,
      derivations: [],
    };
  }
  if (intent !== undefined && state.status === "outcome_unknown") {
    return completeFromIntent({
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
      if (intent === undefined) throw invalid("store.corrupt", "completed recovery has no exact intent", []);
      return completeFromIntent({
        plan: persisted,
        authorization: state.authorization,
        dispatch: state.dispatch,
        intent,
        persistence: "committed",
        callbackInvoked: false,
      });
    }
    const turnId = await commitNoncompletedGenerationTurn({
      plan: persisted,
      authorization: state.authorization,
      dispatch: state.dispatch,
      result: state.result,
    });
    return {
      status: state.result.status,
      persistence: "committed",
      callbackInvoked: false,
      turnId,
      derivations: [],
    };
  }
  if (state.status === "committed") {
    if (intent === undefined) {
      return {
        status: state.graph.result.status,
        persistence: "existing",
        callbackInvoked: false,
        turnId: state.graph.turn.id,
        derivations: [],
      };
    }
    return {
      status: state.graph.result.status,
      persistence: "existing",
      callbackInvoked: false,
      turnId: state.graph.turn.id,
      execution: intent.execution,
      derivations: intent.derivations,
    };
  }
  return {
    status: "outcome_unknown",
    persistence: "dispatch_only",
    callbackInvoked: false,
    turnId: null,
    derivations: [],
  };
}

export async function runGeneration(
  token: object,
  input: unknown,
  revalidate: (plan: PreparedPlanBinding) => Promise<void>,
): ReturnType<SemanticWorkflowBundle["runGeneration"]> {
  const fields = readFields(input, ["runGeneration"]);
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
  const winningAttempt = await loadSemanticWorkflowAttempt(plan.context, {
    attemptId: plan.attempt.id,
    scopeDigest: plan.reservation.scopeDigest,
    definitionDigest: plan.definition.definitionDigest,
  });
  assertAttemptMatchesPreparedPlan(winningAttempt, plan);
  const recovered = await recoverGeneration(plan.context, plan.definition, {
    attemptId: plan.attempt.id,
    scope: plan.window.scope,
  });
  if (recovered.status !== "not_dispatched") {
    const winningAfterRecovery = await loadSemanticWorkflowAttempt(plan.context, {
      attemptId: plan.attempt.id,
      scopeDigest: plan.reservation.scopeDigest,
      definitionDigest: plan.definition.definitionDigest,
    });
    if (winningAfterRecovery === undefined) {
      throw invalid("store.corrupt", "recovered semantic workflow has no durable attempt", []);
    }
    assertAttemptMatchesPreparedPlan(winningAfterRecovery, plan);
    if (recovered.persistence === "not_dispatched") {
      throw invalid("store.corrupt", "dispatched recovery has a not-dispatched persistence state", []);
    }
    return {
      status: recovered.status,
      persistence: recovered.persistence === "committed" ? "existing" : recovered.persistence,
      callbackInvoked: recovered.callbackInvoked,
      turnId: recovered.turnId,
      ...(recovered.execution === undefined ? {} : { execution: recovered.execution }),
      derivations: recovered.derivations,
    };
  }
  await revalidate(plan);
  await persistSemanticTurnReservation(plan.context, plan.reservation);
  await persistSemanticWorkflowExecutionPlan(plan.context, {
    reservation: plan.reservation,
    plan: plan.planLock,
  });
  if (authorization !== null) {
    await persistSemanticDisclosureAuthorization(plan.context, plan.reservation, authorization);
  }
  await persistSemanticWorkflowAttempt(plan.context, {
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
    const intent = await loadSemanticWorkflowCompletionIntent(plan.context, plan.executionTemplate.executionKeyDigest);
    if (intent !== undefined) {
      return completeFromIntent({
        plan,
        authorization,
        dispatch: claim.dispatch,
        intent,
        persistence: "existing",
        callbackInvoked: false,
      });
    }
    const state = await classifySemanticGenerationTurnPersistence(plan.context, plan.reservation);
    if (state.status === "result_recorded") {
      const turnId = await commitNoncompletedGenerationTurn({
        plan,
        authorization,
        dispatch: state.dispatch,
        result: state.result,
      });
      return {
        status: state.result.status,
        persistence: "existing",
        callbackInvoked: false,
        turnId,
        derivations: [],
      };
    }
    if (state.status === "committed") {
      return {
        status: state.graph.result.status,
        persistence: "existing",
        callbackInvoked: false,
        turnId: state.graph.turn.id,
        derivations: [],
      };
    }
    return {
      status: "outcome_unknown",
      persistence: "dispatch_only",
      callbackInvoked: false,
      turnId: null,
      derivations: [],
    };
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
    return {
      status: "outcome_unknown",
      persistence: "dispatch_only",
      callbackInvoked: true,
      turnId: null,
      derivations: [],
    };
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
    const turnId = await commitNoncompletedGenerationTurn({ plan, authorization, dispatch: claim.dispatch, result });
    return {
      status,
      persistence: "committed",
      callbackInvoked: true,
      turnId,
      derivations: [],
    };
  }
  const responseByteLength = Buffer.byteLength(responseText, "utf8");
  let envelope: ParsedProviderEnvelope | undefined;
  try {
    envelope = parseProviderEnvelope(responseValue, {
      id: GENERATION_RESULT_SCHEMA_ID,
      version: GENERATION_RESULT_SCHEMA_VERSION,
    });
  } catch (error) {
    void error;
  }
  const providerReceiptDigest = sha256HexOfCanonicalJson(
    toJsonValue({
      domain: "semantic-workflow-provider-receipt:v1",
      responseKeyedDigest: responseDigest,
      providerRegistrationDigest: plan.definition.providerModel.provider.registrationDigest,
    }),
  );
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
    const turnId = await commitNoncompletedGenerationTurn({ plan, authorization, dispatch: claim.dispatch, result });
    return {
      status: "result_limit",
      persistence: "committed",
      callbackInvoked: true,
      turnId,
      derivations: [],
    };
  }
  if (envelope === undefined) {
    const result = buildKnownFailureResult({
      reservation: plan.reservation,
      dispatch: claim.dispatch,
      status: "result_invalid",
      response,
    });
    const turnId = await commitNoncompletedGenerationTurn({ plan, authorization, dispatch: claim.dispatch, result });
    return {
      status: "result_invalid",
      persistence: "committed",
      callbackInvoked: true,
      turnId,
      derivations: [],
    };
  }
  if (usageMeasurementInvalid(plan.definition, envelope.usage, envelope.status === "completed")) {
    const invalidUsage = buildKnownFailureResult({
      reservation: plan.reservation,
      dispatch: claim.dispatch,
      status: "result_invalid",
      response,
    });
    const turnId = await commitNoncompletedGenerationTurn({
      plan,
      authorization,
      dispatch: claim.dispatch,
      result: invalidUsage,
    });
    return {
      status: "result_invalid",
      persistence: "committed",
      callbackInvoked: true,
      turnId,
      derivations: [],
    };
  }
  if (envelope.usage !== null && usageExceedsBudget(plan.definition, envelope.usage)) {
    const limitedUsage = buildKnownFailureResult({
      reservation: plan.reservation,
      dispatch: claim.dispatch,
      status: "result_limit",
      response,
      usage: envelope.usage,
    });
    const turnId = await commitNoncompletedGenerationTurn({
      plan,
      authorization,
      dispatch: claim.dispatch,
      result: limitedUsage,
    });
    return {
      status: "result_limit",
      persistence: "committed",
      callbackInvoked: true,
      turnId,
      derivations: [],
    };
  }
  if (envelope.status !== "completed") {
    const result = buildKnownFailureResult({
      reservation: plan.reservation,
      dispatch: claim.dispatch,
      status: envelope.status,
      response,
      usage: envelope.usage,
    });
    const turnId = await commitNoncompletedGenerationTurn({ plan, authorization, dispatch: claim.dispatch, result });
    return {
      status: envelope.status,
      persistence: "committed",
      callbackInvoked: true,
      turnId,
      derivations: [],
    };
  }
  const completedUsage = envelope.usage;
  if (completedUsage === null) throw invalid("schema.corrupt", "completed provider usage was not retained", []);
  let draft: ReturnType<typeof parseDetectorResultDraft>;
  try {
    draft = parseDetectorResultDraft(toJsonValue(envelope.result));
  } catch (error) {
    void error;
    const result = buildKnownFailureResult({
      reservation: plan.reservation,
      dispatch: claim.dispatch,
      status: "result_invalid",
      response,
      usage: envelope.usage,
    });
    const turnId = await commitNoncompletedGenerationTurn({ plan, authorization, dispatch: claim.dispatch, result });
    return {
      status: "result_invalid",
      persistence: "committed",
      callbackInvoked: true,
      turnId,
      derivations: [],
    };
  }
  const normalizedResult = toJsonValue(draft);
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
  let assembled: ReturnType<typeof assembleSemanticWorkflowDetectorResult>;
  try {
    assembled = assembleSemanticWorkflowDetectorResult({
      window: plan.window,
      draft,
      definition: plan.definition,
      reservation: plan.reservation,
      result,
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
    const turnId = await commitNoncompletedGenerationTurn({
      plan,
      authorization,
      dispatch: claim.dispatch,
      result: invalidResult,
    });
    return {
      status: "result_invalid",
      persistence: "committed",
      callbackInvoked: true,
      turnId,
      derivations: [],
    };
  }
  const workflowExecution = buildSemanticWorkflowExecutionBinding({
    turnKeyDigest: plan.reservation.turnKeyDigest,
    reservationDigest: plan.reservation.reservationDigest,
    resultBindingDigest: result.bindingDigest,
    definitionDigest: plan.definition.definitionDigest,
    execution: assembled.execution,
    derivations: assembled.derivations,
  });
  const recurrenceBinding =
    assembled.execution.result.status === "applied" && assembled.execution.result.conditionDetected
      ? buildUnavailableExecutionRecurrenceBinding(assembled.execution)
      : null;
  const intent = buildSemanticWorkflowCompletionIntent({
    detectorExecutionKeyDigest: assembled.execution.executionKeyDigest,
    turnKeyDigest: plan.reservation.turnKeyDigest,
    reservationDigest: plan.reservation.reservationDigest,
    planLockDigest: plan.planLock.lockDigest,
    registrySnapshot: plan.registrySnapshot,
    executionTemplate: plan.executionTemplate,
    episodeCompleteness: plan.episodeCompleteness,
    detectorOrchestrationPolicy: plan.orchestrationPolicy,
    recurrenceBinding,
    result,
    workflowExecution,
    execution: assembled.execution,
    derivations: assembled.derivations,
  });
  // The completion intent is deliberately the first awaited write after the
  // resolved provider response has been synchronously validated and assembled.
  const storedIntent = await persistSemanticWorkflowCompletionIntent(plan.context, {
    reservation: plan.reservation,
    authorization,
    dispatch: claim.dispatch,
    plan: plan.planLock,
    intent,
  });
  return completeFromIntent({
    plan,
    authorization,
    dispatch: claim.dispatch,
    intent: storedIntent,
    persistence: "committed",
    callbackInvoked: true,
  });
}
