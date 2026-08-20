// Private receipt-last persistence for fully materialized semantic-turn facts.
// This module has no provider callback, redispatch helper, Candidate/Review
// writer, public export, or effect capability.
import { Buffer } from "node:buffer";
import { canonicalJsonText, sha256HexOfCanonicalJson } from "../canonical/canonical-json.js";
import { toJsonValue } from "../canonical/to-json-value.js";
import { invalid, parseNonEmptyText } from "../parse/toolkit.js";
import type { Parse } from "../parse/toolkit.js";
import type { StoredRecord } from "../ports/store.js";
import { detectorRefKey, lensRefKey, packRefKey, parseDigestAt, parseDurableId } from "../records/semantic-shared.js";
import type { EngineContext, RecordKind } from "../engine/context.js";
import { createOnly, loadStoredRecord, parseWriteResult, recordDigest } from "../engine/context.js";
import type { SemanticDisclosureAuthorization, SemanticTurnReservation } from "./semantic-turn-intent.js";
import { parseSemanticDisclosureAuthorization, parseSemanticTurnReservation } from "./semantic-turn-intent.js";
import type {
  SemanticDispatchMarker,
  SemanticResultBinding,
  SemanticTurnReceipt,
  SemanticTurnScopeIndex,
} from "./semantic-turn-outcome.js";
import {
  buildSemanticDispatchMarker,
  parseSemanticDispatchMarker,
  parseSemanticResultBinding,
  parseSemanticTurnReceipt,
  parseSemanticTurnScopeIndex,
} from "./semantic-turn-outcome.js";
import { SEMANTIC_WORKFLOW_MAX_CANONICAL_BYTES } from "./workflow-definition.js";
import {
  assertSemanticWorkflowStructureBound,
  readSemanticWorkflowFields as readFields,
} from "./workflow-structure.js";

const RESERVATION_KIND = "semantic-workflow-reservation";
const AUTHORIZATION_KIND = "semantic-workflow-authorization";
const DISPATCH_KIND = "semantic-workflow-dispatch";
const RESULT_KIND = "semantic-workflow-result";
const TURN_KIND = "semantic-workflow-turn";
const TURN_SCOPE_INDEX_KIND = "semantic-workflow-turn-index";
const PROVIDER_OPERATION_KEY_DOMAIN = "semantic-workflow-provider-operation-key:v1";
const WORKFLOW_FINGERPRINT_KINDS = new Set(["implementation", "model", "prompt", "tool", "budget"]);

export interface SemanticDispatchClaim {
  readonly status: "created" | "existing";
  readonly dispatch: SemanticDispatchMarker;
}

export interface SemanticTurnPersistenceGraph {
  readonly reservation: SemanticTurnReservation;
  readonly authorization: SemanticDisclosureAuthorization | null;
  readonly dispatch: SemanticDispatchMarker;
  readonly result: SemanticResultBinding;
  readonly scopeIndex: SemanticTurnScopeIndex;
  readonly turn: SemanticTurnReceipt;
}

export type SemanticTurnPersistenceState =
  | {
      readonly status: "not_dispatched";
      readonly reservation: SemanticTurnReservation;
    }
  | {
      readonly status: "outcome_unknown";
      readonly reservation: SemanticTurnReservation;
      readonly authorization: SemanticDisclosureAuthorization | null;
      readonly dispatch: SemanticDispatchMarker;
    }
  | {
      readonly status: "result_recorded";
      readonly reservation: SemanticTurnReservation;
      readonly authorization: SemanticDisclosureAuthorization | null;
      readonly dispatch: SemanticDispatchMarker;
      readonly result: SemanticResultBinding;
    }
  | {
      readonly status: "committed";
      readonly graph: SemanticTurnPersistenceGraph;
    };

const parseUnknown: Parse<unknown> = (input) => input;

export function sameCanonicalValue(left: unknown, right: unknown): boolean {
  return canonicalJsonText(toJsonValue(left)) === canonicalJsonText(toJsonValue(right));
}

export function semanticProviderOperationKeyDigest(reservation: SemanticTurnReservation): string {
  return sha256HexOfCanonicalJson(
    toJsonValue({
      domain: PROVIDER_OPERATION_KEY_DOMAIN,
      turnKeyDigest: reservation.turnKeyDigest,
      providerRegistrationDigest: reservation.definition.providerModel.provider.registrationDigest,
      operationKeyPolicyDigest: reservation.definition.providerModel.provider.idempotency.operationKeyPolicyDigest,
    }),
  );
}

function providerOperationBinding(reservation: SemanticTurnReservation): {
  readonly providerOperationId: string;
  readonly idempotencyKey: string;
} {
  const digest = semanticProviderOperationKeyDigest(reservation);
  return {
    providerOperationId: `semantic-workflow-provider-operation-${digest}`,
    idempotencyKey: `semantic-workflow-idempotency-${digest}`,
  };
}

export function assertCanonicalRecordBound(record: unknown): void {
  assertSemanticWorkflowStructureBound(record);
  const bytes = Buffer.byteLength(canonicalJsonText(toJsonValue(record)), "utf8");
  if (bytes > SEMANTIC_WORKFLOW_MAX_CANONICAL_BYTES) {
    throw invalid("semantic.workflow_limit", "semantic workflow record exceeds its canonical byte ceiling", []);
  }
}

function timestampMilliseconds(value: string): number {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw invalid("schema.corrupt", "semantic workflow timestamp is invalid", []);
  }
  return milliseconds;
}

export function assertAuthorizationBinding(
  reservation: SemanticTurnReservation,
  authorization: SemanticDisclosureAuthorization | null,
  dispatch: SemanticDispatchMarker,
): void {
  const outbound = reservation.definition.transport === "outbound";
  if (outbound !== reservation.disclosureExpected || outbound !== (authorization !== null)) {
    throw invalid("schema.corrupt", "semantic turn authorization presence does not match its transport", []);
  }
  const expectedAuthorizationDigest = authorization?.authorizationDigest ?? null;
  const operation = providerOperationBinding(reservation);
  if (
    dispatch.turnKeyDigest !== reservation.turnKeyDigest ||
    dispatch.reservationDigest !== reservation.reservationDigest ||
    dispatch.authorizationDigest !== expectedAuthorizationDigest ||
    dispatch.providerOperationId !== operation.providerOperationId ||
    dispatch.idempotencyKey !== operation.idempotencyKey
  ) {
    throw invalid("schema.corrupt", "semantic dispatch does not match its exact pre-dispatch records", []);
  }
  const startedAt = timestampMilliseconds(dispatch.startedAt);
  if (startedAt >= timestampMilliseconds(reservation.expiresAt)) {
    throw invalid("schema.corrupt", "semantic dispatch occurred after its reservation expired", []);
  }
  if (
    authorization !== null &&
    (startedAt < timestampMilliseconds(authorization.authorizedAt) ||
      startedAt >= timestampMilliseconds(authorization.expiresAt))
  ) {
    throw invalid("schema.corrupt", "semantic dispatch occurred outside its authorization window", []);
  }
}

function assertCurrentDispatchBinding(context: EngineContext, reservation: SemanticTurnReservation): void {
  if (
    reservation.loopRegistryRevision !== context.registryRevision ||
    context.semanticRegistry?.registryDigest !== reservation.semanticRegistryDigest
  ) {
    throw invalid("semantic.workflow_historical", "semantic turn reservation is not current for dispatch", []);
  }
  const configuredSourcesById = new Map([...context.sources].map((source) => [source.id, source]));
  for (const sourcePolicy of reservation.sourcePolicies) {
    const current = context.contentPoliciesById.get(sourcePolicy.contentPolicyId);
    const source = configuredSourcesById.get(sourcePolicy.sourceId);
    if (
      current === undefined ||
      source === undefined ||
      source.contentPolicyId !== sourcePolicy.contentPolicyId ||
      current.id !== sourcePolicy.contentPolicyId ||
      current.digest !== sourcePolicy.contentPolicyDigest ||
      current.outboundUse !== sourcePolicy.outboundUse
    ) {
      throw invalid("semantic.workflow_historical", "semantic turn source policy is not current for dispatch", []);
    }
  }
  const target = reservation.target;
  if (target.kind !== "generation") {
    throw invalid(
      "semantic.workflow_lane_unavailable",
      "advisory review dispatch requires a later calibrated workflow integration",
      [],
    );
  }
  if (reservation.sourcePolicies.length === 0) {
    throw invalid("semantic.workflow_disclosure_forbidden", "semantic generation has no exact source policy set", []);
  }
  const usedSourceIds = new Set<string>();
  for (const episodeRecordId of target.episodeRecordIds) {
    const matching = reservation.sourcePolicies.filter((policy) => episodeRecordId.startsWith(`${policy.sourceId}/`));
    const sourcePolicy = matching[0];
    if (matching.length !== 1 || sourcePolicy === undefined) {
      throw invalid("semantic.workflow_disclosure_forbidden", "semantic episode has no unique source policy", []);
    }
    usedSourceIds.add(sourcePolicy.sourceId);
  }
  if (usedSourceIds.size !== reservation.sourcePolicies.length) {
    throw invalid("semantic.workflow_disclosure_forbidden", "semantic source policy set is not exact", []);
  }
  const registry = context.semanticRegistry;
  const detector = context.semanticDetectorsByRef?.get(detectorRefKey(target.detector));
  const pack = context.semanticPacksByRef?.get(packRefKey(target.pack));
  const lens = context.semanticLensesByRef?.get(lensRefKey(target.lens));
  if (
    registry === undefined ||
    detector === undefined ||
    pack === undefined ||
    lens === undefined ||
    !registry.selectedDetectorRefs.some((reference) => detectorRefKey(reference) === detectorRefKey(target.detector)) ||
    !registry.selectedPackRefs.some((reference) => packRefKey(reference) === packRefKey(target.pack)) ||
    !registry.selectedLensRefs.some((reference) => lensRefKey(reference) === lensRefKey(target.lens)) ||
    !pack.detectors.some((reference) => detectorRefKey(reference) === detectorRefKey(target.detector)) ||
    !pack.lenses.some((reference) => lensRefKey(reference) === lensRefKey(target.lens)) ||
    !lens.generatorPolicy.allowedKinds.includes("semantic_judgment")
  ) {
    throw invalid("semantic.workflow_historical", "semantic generation target is not currently selected", []);
  }
  const detectorConfiguration = readFields(detector.configuration, ["detector", "configuration"]);
  const workflowDefinitionDigest = detectorConfiguration.req("workflowDefinitionDigest", parseDigestAt);
  const lensConstraint = detector.lensConstraint;
  const exactLensPermitted =
    lensConstraint.mode === "required" &&
    (lensConstraint.selection === "any_registered" ||
      lensConstraint.registrations.some((reference) => lensRefKey(reference) === lensRefKey(target.lens)));
  if (
    detector.outputKind !== "insight_derivation" ||
    detector.implementationDigest !== reservation.definition.implementation.implementationDigest ||
    workflowDefinitionDigest !== reservation.definition.definitionDigest ||
    !exactLensPermitted ||
    lens.requiredCalibrationIds.length !== 0 ||
    lens.requiredFingerprintKinds.some((kind) => !WORKFLOW_FINGERPRINT_KINDS.has(kind))
  ) {
    throw invalid("semantic.workflow_definition_mismatch", "semantic detector does not bind the exact workflow", []);
  }
  const privacyEligible =
    reservation.definition.transport === "outbound"
      ? detector.privacy.transientContent === "explicit_disclosure_receipt" &&
        lens.privacy.outboundDisclosure === "explicit_disclosure_receipt"
      : detector.privacy.transientContent === "memory_only";
  if (!privacyEligible) {
    throw invalid("semantic.workflow_disclosure_forbidden", "semantic generation privacy policy forbids dispatch", []);
  }
}

function assertReportedUsageWithinBudget(reservation: SemanticTurnReservation, result: SemanticResultBinding): void {
  const usage = result.usage;
  const budget = reservation.definition.budgetPolicy;
  const maximumCost = budget.maximumCost;
  if (result.status !== "completed") return;
  if (
    maximumCost !== null &&
    (usage.status !== "reported" || usage.costMinorUnits === null || usage.currency === null)
  ) {
    throw invalid("schema.corrupt", "completed semantic usage cannot verify its exact cost ceiling", []);
  }
  if (usage.status !== "reported") return;
  if (
    usage.inputTokens > budget.maximumInputTokens ||
    usage.outputTokens > budget.maximumOutputTokens ||
    usage.durationMs > budget.maximumDurationMs
  ) {
    throw invalid("schema.corrupt", "reported semantic usage exceeds the exact registered budget", []);
  }
  if (
    maximumCost !== null &&
    usage.costMinorUnits !== null &&
    (usage.currency !== maximumCost.currency || usage.costMinorUnits > maximumCost.minorUnits)
  ) {
    throw invalid("schema.corrupt", "reported semantic cost exceeds or mismatches the exact registered budget", []);
  }
}

export function assertResultBinding(
  reservation: SemanticTurnReservation,
  dispatch: SemanticDispatchMarker,
  result: SemanticResultBinding,
): void {
  if (
    result.turnKeyDigest !== reservation.turnKeyDigest ||
    result.reservationDigest !== reservation.reservationDigest ||
    result.dispatchDigest !== dispatch.dispatchDigest
  ) {
    throw invalid("schema.corrupt", "semantic result does not match its exact dispatch", []);
  }
  const response = result.response;
  if (
    response !== null &&
    (response.requestAttestationDigest !== reservation.request.minimizedBytesDigest ||
      response.keyPolicyDigest !== reservation.request.keyPolicyDigest)
  ) {
    throw invalid("schema.corrupt", "semantic response metadata does not match its exact request", []);
  }
  if (
    result.status === "completed" &&
    (response === null || response.responseByteLength > reservation.definition.budgetPolicy.maximumResponseBytes)
  ) {
    throw invalid("schema.corrupt", "completed semantic response exceeds its exact registered budget", []);
  }
  assertReportedUsageWithinBudget(reservation, result);
}

function assertResultPersistenceAvailable(result: SemanticResultBinding): void {
  if (result.status !== "completed") return;
  throw invalid(
    "semantic.workflow_output_unavailable",
    "completed semantic results require a later typed minimization and output integration",
    [],
  );
}

function assertTerminalBinding(
  reservation: SemanticTurnReservation,
  authorization: SemanticDisclosureAuthorization | null,
  dispatch: SemanticDispatchMarker,
  result: SemanticResultBinding,
  scopeIndex: SemanticTurnScopeIndex,
  turn: SemanticTurnReceipt,
): void {
  if (
    turn.turnKeyDigest !== reservation.turnKeyDigest ||
    turn.reservation.id !== reservation.id ||
    turn.reservation.reservationDigest !== reservation.reservationDigest ||
    turn.dispatch.id !== dispatch.id ||
    turn.dispatch.dispatchDigest !== dispatch.dispatchDigest ||
    turn.result.id !== result.id ||
    turn.result.bindingDigest !== result.bindingDigest ||
    turn.lane !== reservation.definition.lane ||
    turn.scopeDigest !== reservation.scopeDigest ||
    turn.status !== result.status
  ) {
    throw invalid("schema.corrupt", "semantic turn receipt does not match its exact graph", []);
  }
  if (
    (authorization === null && turn.authorization !== null) ||
    (authorization !== null &&
      (turn.authorization === null ||
        turn.authorization.id !== authorization.id ||
        turn.authorization.authorizationDigest !== authorization.authorizationDigest))
  ) {
    throw invalid("schema.corrupt", "semantic turn authorization reference is invalid", []);
  }
  if (
    scopeIndex.scopeDigest !== reservation.scopeDigest ||
    scopeIndex.turnId !== turn.id ||
    scopeIndex.turnKeyDigest !== turn.turnKeyDigest ||
    scopeIndex.turnDigest !== turn.turnDigest ||
    (scopeIndex.definitionDigest !== undefined &&
      scopeIndex.definitionDigest !== reservation.definition.definitionDigest)
  ) {
    throw invalid("schema.corrupt", "semantic turn scope index does not match its terminal receipt", []);
  }
}

function assertGraphBindings(graph: SemanticTurnPersistenceGraph): void {
  assertAuthorizationBinding(graph.reservation, graph.authorization, graph.dispatch);
  assertResultBinding(graph.reservation, graph.dispatch, graph.result);
  assertTerminalBinding(
    graph.reservation,
    graph.authorization,
    graph.dispatch,
    graph.result,
    graph.scopeIndex,
    graph.turn,
  );
}

export function parseSemanticTurnPersistenceGraph(input: unknown): SemanticTurnPersistenceGraph {
  const fields = readFields(input, ["semanticTurnPersistenceGraph"]);
  const reservation = fields.req("reservation", (value) => {
    assertCanonicalRecordBound(value);
    return parseSemanticTurnReservation(value);
  });
  const authorization = fields.req("authorization", (value, path) => {
    if (value === null) return null;
    assertCanonicalRecordBound(value);
    try {
      return parseSemanticDisclosureAuthorization(value, reservation);
    } catch (error) {
      if (error instanceof Error) throw error;
      throw invalid("schema.invalid", "semantic authorization parsing failed", path);
    }
  });
  const graph = {
    reservation,
    authorization,
    dispatch: fields.req("dispatch", (value) => {
      assertCanonicalRecordBound(value);
      return parseSemanticDispatchMarker(value);
    }),
    result: fields.req("result", (value) => {
      assertCanonicalRecordBound(value);
      return parseSemanticResultBinding(value);
    }),
    scopeIndex: fields.req("scopeIndex", (value) => {
      assertCanonicalRecordBound(value);
      return parseSemanticTurnScopeIndex(value);
    }),
    turn: fields.req("turn", (value) => {
      assertCanonicalRecordBound(value);
      return parseSemanticTurnReceipt(value);
    }),
  };
  assertGraphBindings(graph);
  return graph;
}

async function persistGlobalExactWithStatus<T extends { readonly id: string }>(
  context: EngineContext,
  kind: RecordKind,
  record: T,
  parseRecord: (input: unknown) => T,
): Promise<{ readonly status: "created" | "existing"; readonly record: T }> {
  assertCanonicalRecordBound(record);
  const status = await createOnly(context, kind, record.id, record, `semantic-workflow/${kind}/${record.id}`);
  if (status === "conflict") {
    throw invalid("store.conflict", "semantic workflow record id already binds different content", []);
  }
  const stored = await loadStoredRecord(context, kind, record.id);
  if (stored === undefined) {
    throw invalid("store.corrupt", "store acknowledged a semantic workflow record without preserving it", []);
  }
  assertCanonicalRecordBound(stored.value);
  const parsed = parseRecord(stored.value);
  if (parsed.id !== record.id || !sameCanonicalValue(stored.value, record) || !sameCanonicalValue(parsed, record)) {
    throw invalid("store.corrupt", "stored semantic workflow record differs from the acknowledged bytes", []);
  }
  return { status: status === "created" ? "created" : "existing", record: parsed };
}

export async function persistGlobalExact<T extends { readonly id: string }>(
  context: EngineContext,
  kind: RecordKind,
  record: T,
  parseRecord: (input: unknown) => T,
): Promise<T> {
  return (await persistGlobalExactWithStatus(context, kind, record, parseRecord)).record;
}

export async function loadOptionalGlobalExact<T extends { readonly id: string }>(
  context: EngineContext,
  kind: RecordKind,
  id: string,
  parseRecord: (input: unknown) => T,
): Promise<T | undefined> {
  const stored = await loadStoredRecord(context, kind, id);
  if (stored === undefined) return undefined;
  assertCanonicalRecordBound(stored.value);
  const parsed = parseRecord(stored.value);
  if (parsed.id !== id || !sameCanonicalValue(stored.value, parsed)) {
    throw invalid("store.corrupt", "stored semantic workflow binding differs from its exact key", []);
  }
  return parsed;
}

export function turnScopeNamespace(exactScopeDigest: string): string {
  return `learning-semantic-workflow-scope-${exactScopeDigest}`;
}

export function turnScopeDefinitionNamespace(exactScopeDigest: string, definitionDigest: string): string {
  return `${turnScopeNamespace(exactScopeDigest)}-definition-${definitionDigest}`;
}

export const parseStoredRecordAt: Parse<StoredRecord> = (input, path) => {
  const fields = readFields(input, path);
  const keyFields = readFields(fields.req("key", parseUnknown), [...path, "key"]);
  return {
    key: {
      namespace: keyFields.req("namespace", parseNonEmptyText),
      kind: keyFields.req("kind", parseNonEmptyText),
      id: keyFields.req("id", parseNonEmptyText),
    },
    value: fields.req("value", parseUnknown),
    revision: fields.req("revision", parseNonEmptyText),
    digest: fields.req("digest", parseNonEmptyText),
  };
};

export function parseStoredScopeIndex(
  input: unknown,
  exactScopeDigest: string,
  expectedTurnId: string | undefined,
  path: readonly (string | number)[],
): SemanticTurnScopeIndex {
  const stored = parseStoredRecordAt(input, path);
  if (
    stored.key.namespace !== turnScopeNamespace(exactScopeDigest) ||
    stored.key.kind !== TURN_SCOPE_INDEX_KIND ||
    (expectedTurnId !== undefined && stored.key.id !== expectedTurnId)
  ) {
    throw invalid("store.corrupt", "store returned a foreign semantic turn scope index", [...path, "key"]);
  }
  const value = toJsonValue(stored.value);
  assertCanonicalRecordBound(value);
  if (stored.digest !== recordDigest(value)) {
    throw invalid("store.corrupt", "semantic turn scope index envelope digest is invalid", [...path, "digest"]);
  }
  const index = parseSemanticTurnScopeIndex(value);
  if (index.scopeDigest !== exactScopeDigest || index.turnId !== stored.key.id || !sameCanonicalValue(value, index)) {
    throw invalid("store.corrupt", "semantic turn scope index does not match its exact key", path);
  }
  return index;
}

async function loadScopeIndex(
  context: EngineContext,
  exactScopeDigest: string,
  turnId: string,
): Promise<SemanticTurnScopeIndex | undefined> {
  const raw: unknown = await context.store.get({
    namespace: turnScopeNamespace(exactScopeDigest),
    kind: TURN_SCOPE_INDEX_KIND,
    id: turnId,
  });
  return raw === undefined
    ? undefined
    : parseStoredScopeIndex(raw, exactScopeDigest, turnId, ["store", "get", TURN_SCOPE_INDEX_KIND]);
}

export function loadSemanticTurnScopeIndex(
  context: EngineContext,
  turnIdInput: unknown,
  exactScopeDigestInput: unknown,
): Promise<SemanticTurnScopeIndex | undefined> {
  const turnId = parseDurableId(turnIdInput, ["turnId"]);
  const exactScopeDigest = parseDigestAt(exactScopeDigestInput, ["scopeDigest"]);
  return loadScopeIndex(context, exactScopeDigest, turnId);
}

export function parseStoredScopedTurn(
  input: unknown,
  exactScopeDigest: string,
  expectedTurnId: string,
  path: readonly (string | number)[],
  definitionDigest?: string,
): SemanticTurnReceipt {
  const stored = parseStoredRecordAt(input, path);
  if (
    stored.key.namespace !==
      (definitionDigest === undefined
        ? turnScopeNamespace(exactScopeDigest)
        : turnScopeDefinitionNamespace(exactScopeDigest, definitionDigest)) ||
    stored.key.kind !== TURN_KIND ||
    stored.key.id !== expectedTurnId
  ) {
    throw invalid("store.corrupt", "store returned a foreign scoped semantic turn receipt", [...path, "key"]);
  }
  const value = toJsonValue(stored.value);
  assertCanonicalRecordBound(value);
  if (stored.digest !== recordDigest(value)) {
    throw invalid("store.corrupt", "scoped semantic turn receipt envelope digest is invalid", [...path, "digest"]);
  }
  const turn = parseSemanticTurnReceipt(value);
  if (turn.id !== expectedTurnId || turn.scopeDigest !== exactScopeDigest || !sameCanonicalValue(value, turn)) {
    throw invalid("store.corrupt", "scoped semantic turn receipt does not match its exact key", path);
  }
  return turn;
}

async function loadScopedTurn(
  context: EngineContext,
  exactScopeDigest: string,
  turnId: string,
  definitionDigest?: string,
): Promise<SemanticTurnReceipt | undefined> {
  const raw: unknown = await context.store.get({
    namespace:
      definitionDigest === undefined
        ? turnScopeNamespace(exactScopeDigest)
        : turnScopeDefinitionNamespace(exactScopeDigest, definitionDigest),
    kind: TURN_KIND,
    id: turnId,
  });
  return raw === undefined
    ? undefined
    : parseStoredScopedTurn(raw, exactScopeDigest, turnId, ["store", "get", TURN_KIND], definitionDigest);
}

export function loadSemanticDefinitionTurn(
  context: EngineContext,
  turnIdInput: unknown,
  exactScopeDigestInput: unknown,
  definitionDigestInput: unknown,
): Promise<SemanticTurnReceipt | undefined> {
  const turnId = parseDurableId(turnIdInput, ["turnId"]);
  const exactScopeDigest = parseDigestAt(exactScopeDigestInput, ["scopeDigest"]);
  const definitionDigest = parseDigestAt(definitionDigestInput, ["definitionDigest"]);
  return loadScopedTurn(context, exactScopeDigest, turnId, definitionDigest);
}

export async function persistScopedTurn(
  context: EngineContext,
  turn: SemanticTurnReceipt,
  definitionDigest?: string,
): Promise<SemanticTurnReceipt> {
  assertCanonicalRecordBound(turn);
  const value = toJsonValue(turn);
  const rawResult: unknown = await context.store.create(
    {
      namespace:
        definitionDigest === undefined
          ? turnScopeNamespace(turn.scopeDigest)
          : turnScopeDefinitionNamespace(turn.scopeDigest, definitionDigest),
      kind: TURN_KIND,
      id: turn.id,
    },
    value,
    recordDigest(value),
    `semantic-workflow/scoped-turn/${turn.scopeDigest}/${turn.id}`,
  );
  const result = parseWriteResult(rawResult);
  if (result.status === "updated") {
    throw invalid("store.corrupt", "store updated a create-only scoped semantic turn receipt", []);
  }
  if (result.status === "conflict") {
    throw invalid("store.conflict", "scoped semantic turn receipt already binds different content", []);
  }
  const stored = await loadScopedTurn(context, turn.scopeDigest, turn.id, definitionDigest);
  if (stored === undefined || !sameCanonicalValue(stored, turn)) {
    throw invalid("store.corrupt", "store acknowledged a scoped semantic turn receipt without preserving it", []);
  }
  return stored;
}

export async function persistScopeIndex(context: EngineContext, index: SemanticTurnScopeIndex): Promise<void> {
  assertCanonicalRecordBound(index);
  const value = toJsonValue(index);
  const rawResult: unknown = await context.store.create(
    {
      namespace: turnScopeNamespace(index.scopeDigest),
      kind: TURN_SCOPE_INDEX_KIND,
      id: index.turnId,
    },
    value,
    recordDigest(value),
    `semantic-workflow/scope-index/${index.scopeDigest}/${index.turnId}`,
  );
  const result = parseWriteResult(rawResult);
  if (result.status === "updated") {
    throw invalid("store.corrupt", "store updated a create-only semantic turn scope index", []);
  }
  if (result.status === "conflict") {
    throw invalid("store.conflict", "semantic turn scope index already binds different content", []);
  }
  const stored = await loadScopeIndex(context, index.scopeDigest, index.turnId);
  if (stored === undefined || !sameCanonicalValue(stored, index)) {
    throw invalid("store.corrupt", "store acknowledged a semantic turn scope index without preserving it", []);
  }
}

export async function reloadExactCommitted<T extends { readonly id: string }>(
  context: EngineContext,
  kind: RecordKind,
  expected: T,
  parseRecord: (input: unknown) => T,
): Promise<T> {
  const stored = await loadStoredRecord(context, kind, expected.id);
  if (stored === undefined) {
    throw invalid("semantic.workflow_incomplete", "required semantic workflow fact is not committed", []);
  }
  assertCanonicalRecordBound(stored.value);
  const parsed = parseRecord(stored.value);
  if (
    parsed.id !== expected.id ||
    !sameCanonicalValue(stored.value, expected) ||
    !sameCanonicalValue(parsed, expected)
  ) {
    throw invalid("store.conflict", "committed semantic workflow fact differs from the exact input", []);
  }
  return parsed;
}

export async function reloadAuthorizationInput(
  context: EngineContext,
  reservation: SemanticTurnReservation,
  authorizationInput: unknown,
): Promise<SemanticDisclosureAuthorization | null> {
  if (!reservation.disclosureExpected) {
    if (authorizationInput !== null) {
      throw invalid("schema.invalid", "local semantic turns cannot carry disclosure authorization", []);
    }
    return null;
  }
  if (authorizationInput === null) {
    throw invalid("semantic.workflow_incomplete", "outbound semantic turn authorization is not committed", []);
  }
  assertCanonicalRecordBound(authorizationInput);
  const authorization = parseSemanticDisclosureAuthorization(authorizationInput, reservation);
  return reloadExactCommitted(context, AUTHORIZATION_KIND, authorization, (value) =>
    parseSemanticDisclosureAuthorization(value, reservation),
  );
}

/** Create-only reservation write and exact post-acknowledgement reload. */
export async function persistSemanticTurnReservation(
  context: EngineContext,
  reservationInput: unknown,
): Promise<SemanticTurnReservation> {
  assertCanonicalRecordBound(reservationInput);
  const reservation = parseSemanticTurnReservation(reservationInput);
  return persistGlobalExact(context, RESERVATION_KIND, reservation, parseSemanticTurnReservation);
}

/**
 * Serializes all semantic generation for one exact DetectorExecution key.
 * A different request or turn for the same child execution is refused before
 * authorization or dispatch can be claimed.
 */
export async function persistSemanticDisclosureAuthorization(
  context: EngineContext,
  reservationInput: unknown,
  authorizationInput: unknown,
): Promise<SemanticDisclosureAuthorization> {
  assertCanonicalRecordBound(reservationInput);
  assertCanonicalRecordBound(authorizationInput);
  const candidateReservation = parseSemanticTurnReservation(reservationInput);
  const reservation = await reloadExactCommitted(
    context,
    RESERVATION_KIND,
    candidateReservation,
    parseSemanticTurnReservation,
  );
  const authorization = parseSemanticDisclosureAuthorization(authorizationInput, reservation);
  return persistGlobalExact(context, AUTHORIZATION_KIND, authorization, (value) =>
    parseSemanticDisclosureAuthorization(value, reservation),
  );
}

/**
 * Claims the one exact provider operation. `created` is necessary but not
 * sufficient for later egress: a future slice must also authenticate an exact
 * factory-bound prepared plan that privately owns the previewed bytes and
 * kernel-materialized window, authenticate the provider/workflow capability
 * and a loop/plan-bound host disclosure-authorization capability, revalidate
 * the current window, and recheck expiry at handoff. `existing` is never
 * permission to redispatch.
 */
export async function claimSemanticDispatch(context: EngineContext, input: unknown): Promise<SemanticDispatchClaim> {
  const fields = readFields(input, ["semanticDispatchClaim"]);
  const candidateReservation = fields.req("reservation", (value) => {
    assertCanonicalRecordBound(value);
    return parseSemanticTurnReservation(value);
  });
  const reservation = await reloadExactCommitted(
    context,
    RESERVATION_KIND,
    candidateReservation,
    parseSemanticTurnReservation,
  );
  const authorizationInput = fields.req("authorization", parseUnknown);
  const authorization = await reloadAuthorizationInput(context, reservation, authorizationInput);
  const dispatchId = `semantic-workflow-dispatch-${reservation.turnKeyDigest}`;
  const existing = await loadStoredRecord(context, DISPATCH_KIND, dispatchId);
  if (existing !== undefined) {
    assertCanonicalRecordBound(existing.value);
    const dispatch = parseSemanticDispatchMarker(existing.value);
    if (dispatch.id !== dispatchId || !sameCanonicalValue(existing.value, dispatch)) {
      throw invalid("store.corrupt", "semantic dispatch id does not match its key", []);
    }
    assertAuthorizationBinding(reservation, authorization, dispatch);
    return { status: "existing", dispatch };
  }

  assertCurrentDispatchBinding(context, reservation);
  const operation = providerOperationBinding(reservation);
  const dispatch = buildSemanticDispatchMarker({
    turnKeyDigest: reservation.turnKeyDigest,
    reservationDigest: reservation.reservationDigest,
    authorizationDigest: authorization?.authorizationDigest ?? null,
    providerOperationId: operation.providerOperationId,
    idempotencyKey: operation.idempotencyKey,
    startedAt: context.clock.now(),
  });
  assertAuthorizationBinding(reservation, authorization, dispatch);
  assertCanonicalRecordBound(dispatch);
  const status = await createOnly(
    context,
    DISPATCH_KIND,
    dispatch.id,
    dispatch,
    `semantic-workflow/${DISPATCH_KIND}/${dispatch.id}`,
  );
  if (status === "conflict") {
    const winning = await loadStoredRecord(context, DISPATCH_KIND, dispatch.id);
    if (winning === undefined) {
      throw invalid("store.corrupt", "conflicting semantic dispatch has no preserved winner", []);
    }
    assertCanonicalRecordBound(winning.value);
    const parsed = parseSemanticDispatchMarker(winning.value);
    if (!sameCanonicalValue(winning.value, parsed)) {
      throw invalid("store.corrupt", "winning semantic dispatch contains non-contract bytes", []);
    }
    assertAuthorizationBinding(reservation, authorization, parsed);
    return { status: "existing", dispatch: parsed };
  }
  const stored = await loadStoredRecord(context, DISPATCH_KIND, dispatch.id);
  if (stored === undefined) {
    throw invalid("store.corrupt", "store acknowledged a semantic dispatch without preserving it", []);
  }
  assertCanonicalRecordBound(stored.value);
  const parsed = parseSemanticDispatchMarker(stored.value);
  if (!sameCanonicalValue(stored.value, dispatch) || !sameCanonicalValue(parsed, dispatch)) {
    throw invalid("store.corrupt", "stored semantic dispatch differs from the acknowledged bytes", []);
  }
  return { status: status === "created" ? "created" : "existing", dispatch: parsed };
}

/** Result write after exact reservation, authorization, and dispatch reload. */
export async function persistSemanticResultBinding(
  context: EngineContext,
  input: unknown,
): Promise<SemanticResultBinding> {
  const fields = readFields(input, ["semanticResultPersistence"]);
  const candidateReservation = fields.req("reservation", (value) => {
    assertCanonicalRecordBound(value);
    return parseSemanticTurnReservation(value);
  });
  const reservation = await reloadExactCommitted(
    context,
    RESERVATION_KIND,
    candidateReservation,
    parseSemanticTurnReservation,
  );
  const authorization = await reloadAuthorizationInput(context, reservation, fields.req("authorization", parseUnknown));
  const candidateDispatch = fields.req("dispatch", (value) => {
    assertCanonicalRecordBound(value);
    return parseSemanticDispatchMarker(value);
  });
  const dispatch = await reloadExactCommitted(context, DISPATCH_KIND, candidateDispatch, parseSemanticDispatchMarker);
  assertAuthorizationBinding(reservation, authorization, dispatch);
  const result = fields.req("result", (value) => {
    assertCanonicalRecordBound(value);
    return parseSemanticResultBinding(value);
  });
  assertResultPersistenceAvailable(result);
  assertResultBinding(reservation, dispatch, result);
  return persistGlobalExact(context, RESULT_KIND, result, parseSemanticResultBinding);
}

/** #13b-only typed completed generation sidecars, before the child graph. */
/** Terminal index and receipt write after every exact sidecar is reloaded. */
export async function persistSemanticTurnTerminal(
  context: EngineContext,
  input: unknown,
): Promise<SemanticTurnReceipt> {
  const graph = parseSemanticTurnPersistenceGraph(input);
  assertResultPersistenceAvailable(graph.result);
  const reservation = await reloadExactCommitted(
    context,
    RESERVATION_KIND,
    graph.reservation,
    parseSemanticTurnReservation,
  );
  const authorization = await reloadAuthorizationInput(context, reservation, graph.authorization);
  const dispatch = await reloadExactCommitted(context, DISPATCH_KIND, graph.dispatch, parseSemanticDispatchMarker);
  const result = await reloadExactCommitted(context, RESULT_KIND, graph.result, parseSemanticResultBinding);
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

export async function loadRequiredGlobal<T extends { readonly id: string }>(
  context: EngineContext,
  kind: RecordKind,
  id: string,
  parseRecord: (input: unknown) => T,
): Promise<T> {
  const stored = await loadStoredRecord(context, kind, id);
  if (stored === undefined) {
    throw invalid("store.corrupt", "terminal semantic turn references a missing sidecar", []);
  }
  assertCanonicalRecordBound(stored.value);
  const record = parseRecord(stored.value);
  if (record.id !== id || !sameCanonicalValue(stored.value, record)) {
    throw invalid("store.corrupt", "semantic turn sidecar id does not match its key", []);
  }
  return record;
}

/**
 * Exact-scope terminal load. The scope-private index is always consulted before
 * the scope-private turn receipt, so a wrong-scope lookup cannot probe a
 * foreign target. An orphaned pre-terminal index remains invisible.
 */
export async function loadSemanticTurnByScopeUnchecked(
  context: EngineContext,
  turnIdInput: unknown,
  exactScopeDigestInput: unknown,
): Promise<SemanticTurnPersistenceGraph | undefined> {
  const turnId = parseDurableId(turnIdInput, ["turnId"]);
  const exactScopeDigest = parseDigestAt(exactScopeDigestInput, ["scopeDigest"]);
  const scopeIndex = await loadScopeIndex(context, exactScopeDigest, turnId);
  if (scopeIndex === undefined) return undefined;
  const turn = await loadScopedTurn(context, exactScopeDigest, turnId, scopeIndex.definitionDigest);
  if (turn === undefined) return undefined;
  if (
    turn.id !== turnId ||
    turn.scopeDigest !== exactScopeDigest ||
    turn.turnDigest !== scopeIndex.turnDigest ||
    turn.turnKeyDigest !== scopeIndex.turnKeyDigest
  ) {
    throw invalid("store.corrupt", "semantic turn receipt does not match its exact scope index", []);
  }
  const reservation = await loadRequiredGlobal(
    context,
    RESERVATION_KIND,
    turn.reservation.id,
    parseSemanticTurnReservation,
  );
  const authorization =
    turn.authorization === null
      ? null
      : await loadRequiredGlobal(context, AUTHORIZATION_KIND, turn.authorization.id, (value) =>
          parseSemanticDisclosureAuthorization(value, reservation),
        );
  const dispatch = await loadRequiredGlobal(context, DISPATCH_KIND, turn.dispatch.id, parseSemanticDispatchMarker);
  const result = await loadRequiredGlobal(context, RESULT_KIND, turn.result.id, parseSemanticResultBinding);
  const graph = parseSemanticTurnPersistenceGraph({ reservation, authorization, dispatch, result, scopeIndex, turn });

  return graph;
}

export async function loadSemanticTurnByScope(
  context: EngineContext,
  turnIdInput: unknown,
  exactScopeDigestInput: unknown,
): Promise<SemanticTurnPersistenceGraph | undefined> {
  const graph = await loadSemanticTurnByScopeUnchecked(context, turnIdInput, exactScopeDigestInput);
  if (graph !== undefined) assertResultPersistenceAvailable(graph.result);
  return graph;
}
async function loadAuthorizationForDispatch(
  context: EngineContext,
  reservation: SemanticTurnReservation,
  dispatch: SemanticDispatchMarker,
): Promise<SemanticDisclosureAuthorization | null> {
  if (!reservation.disclosureExpected) {
    if (dispatch.authorizationDigest !== null) {
      throw invalid("store.corrupt", "local semantic dispatch unexpectedly references authorization", []);
    }
    return null;
  }
  const authorizationId = `semantic-workflow-authorization-${reservation.turnKeyDigest}`;
  const authorization = await loadRequiredGlobal(context, AUTHORIZATION_KIND, authorizationId, (value) =>
    parseSemanticDisclosureAuthorization(value, reservation),
  );
  if (dispatch.authorizationDigest !== authorization.authorizationDigest) {
    throw invalid("store.corrupt", "semantic dispatch authorization digest is invalid", []);
  }
  return authorization;
}

/**
 * Read-only crash classifier. A dispatch marker without a result is permanently
 * reported as outcome_unknown; this module exposes no redispatch operation.
 */
export async function classifySemanticTurnPersistence(
  context: EngineContext,
  reservationInput: unknown,
  options: {
    readonly allowCompleted?: boolean;
    readonly loadGraph?: (
      context: EngineContext,
      turnId: unknown,
      scopeDigest: unknown,
    ) => Promise<SemanticTurnPersistenceGraph | undefined>;
  } = {},
): Promise<SemanticTurnPersistenceState> {
  assertCanonicalRecordBound(reservationInput);
  const candidateReservation = parseSemanticTurnReservation(reservationInput);
  const reservation = await reloadExactCommitted(
    context,
    RESERVATION_KIND,
    candidateReservation,
    parseSemanticTurnReservation,
  );
  const dispatchId = `semantic-workflow-dispatch-${reservation.turnKeyDigest}`;
  const dispatchStored = await loadStoredRecord(context, DISPATCH_KIND, dispatchId);
  if (dispatchStored === undefined) return { status: "not_dispatched", reservation };
  assertCanonicalRecordBound(dispatchStored.value);
  const dispatch = parseSemanticDispatchMarker(dispatchStored.value);
  if (dispatch.id !== dispatchId || !sameCanonicalValue(dispatchStored.value, dispatch)) {
    throw invalid("store.corrupt", "semantic dispatch id does not match its key", []);
  }
  const authorization = await loadAuthorizationForDispatch(context, reservation, dispatch);
  assertAuthorizationBinding(reservation, authorization, dispatch);

  const resultId = `semantic-workflow-result-${reservation.turnKeyDigest}`;
  const resultStored = await loadStoredRecord(context, RESULT_KIND, resultId);
  if (resultStored === undefined) return { status: "outcome_unknown", reservation, authorization, dispatch };
  assertCanonicalRecordBound(resultStored.value);
  const result = parseSemanticResultBinding(resultStored.value);
  if (result.id !== resultId || !sameCanonicalValue(resultStored.value, result)) {
    throw invalid("store.corrupt", "semantic result id does not match its key", []);
  }
  if (options.allowCompleted !== true) assertResultPersistenceAvailable(result);
  assertResultBinding(reservation, dispatch, result);

  const turnId = `semantic-workflow-turn-${reservation.turnKeyDigest}`;
  const graph = await (options.loadGraph ?? loadSemanticTurnByScope)(context, turnId, reservation.scopeDigest);
  if (graph === undefined) {
    return { status: "result_recorded", reservation, authorization, dispatch, result };
  }
  return { status: "committed", graph };
}

export {
  querySemanticTurnsByScope,
  semanticWorkflowSnapshotRevision,
  SEMANTIC_TURN_SCOPE_INDEX_KIND,
} from "./semantic-turn-query.js";
