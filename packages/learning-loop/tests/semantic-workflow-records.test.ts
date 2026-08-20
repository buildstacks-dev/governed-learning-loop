// #13a private workflow record conformance: unknown-first parsing, immutable
// bytes, exact policy/identity binding, closed outcomes, and inert outputs.
import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { canonicalJsonText, sha256HexOfCanonicalJson, toJsonValue } from "../src/index.js";
import type { JsonValue } from "../src/index.js";
import type {
  SemanticDisclosureAuthorization,
  SemanticTurnReservation,
  SemanticTurnReservationInput,
} from "../src/workflows/semantic-turn-intent.js";
import {
  buildSemanticDisclosureAuthorization,
  buildSemanticTurnReservation,
  parseSemanticDisclosureAuthorization,
  parseSemanticTurnReservation,
  semanticDisclosureAuthorizationDigest,
  semanticTurnKeyDigest,
  semanticTurnReservationDigest,
} from "../src/workflows/semantic-turn-intent.js";
import type {
  SemanticDispatchMarker,
  SemanticResponseMetadata,
  SemanticResultBinding,
  SemanticResultStatus,
  SemanticTurnReceipt,
  SemanticTurnScopeIndex,
  SemanticUsage,
} from "../src/workflows/semantic-turn-outcome.js";
import {
  buildSemanticDispatchMarker,
  buildSemanticResultBinding,
  buildSemanticTurnReceipt,
  buildSemanticTurnScopeIndex,
  parseSemanticDispatchMarker,
  parseSemanticResultBinding,
  parseSemanticTurnReceipt,
  parseSemanticTurnScopeIndex,
  semanticDispatchDigest,
  semanticNormalizedResultDigest,
  semanticResultBindingDigest,
  semanticTurnDigest,
  semanticTurnScopeIndexDigest,
} from "../src/workflows/semantic-turn-outcome.js";
import type { SemanticWorkflowDefinition } from "../src/workflows/workflow-definition.js";
import {
  parseSemanticWorkflowDefinition,
  semanticProviderModelDigest,
  semanticProviderRegistrationDigest,
  semanticWorkflowBudgetPolicyDigest,
  semanticWorkflowDefinitionDigest,
  semanticWorkflowDisclosurePolicyDigest,
  semanticWorkflowToolPolicyDigest,
  SEMANTIC_WORKFLOW_MAX_CANONICAL_BYTES,
  SEMANTIC_WORKFLOW_MAX_DURATION_MS,
  SEMANTIC_WORKFLOW_MAX_EPISODES,
  SEMANTIC_WORKFLOW_MAX_EVIDENCE_REFS,
} from "../src/workflows/workflow-definition.js";
import {
  assertSemanticWorkflowStructureBound,
  SEMANTIC_WORKFLOW_MAX_STRUCTURE_DEPTH,
  SEMANTIC_WORKFLOW_MAX_STRUCTURE_NODES,
} from "../src/workflows/workflow-structure.js";

const SCOPE_DIGEST = digest("scope");
const PRIVATE_PREVIEW_CANARY = "PRIVATE-PREVIEW-CANARY";
const PRIVATE_RESPONSE_CANARY = "PRIVATE-RAW-RESPONSE-CANARY";
const PRIVATE_ERROR_CANARY = "PRIVATE-PROVIDER-ERROR-CANARY";

type DefinitionLane = SemanticWorkflowDefinition["lane"];
type DefinitionTransport = SemanticWorkflowDefinition["transport"];
type DefinitionProvider = SemanticWorkflowDefinition["providerModel"]["provider"];
type DefinitionBudget = SemanticWorkflowDefinition["budgetPolicy"];
type DefinitionDisclosure = SemanticWorkflowDefinition["disclosurePolicy"];

function digest(label: string): string {
  return sha256HexOfCanonicalJson(toJsonValue({ label }));
}

function numberedDigest(index: number): string {
  return index.toString(16).padStart(64, "0");
}

function changedDigest(value: string): string {
  return `${value.startsWith("0") ? "1" : "0"}${value.slice(1)}`;
}

function definitionFixture(input: {
  readonly lane: DefinitionLane;
  readonly transport: DefinitionTransport;
  readonly budget?: Partial<Omit<DefinitionBudget, "policyDigest">>;
}): SemanticWorkflowDefinition {
  const providerBase: Omit<DefinitionProvider, "registrationDigest"> = {
    id: "fixture-provider",
    version: "1.0.0",
    providerFingerprintDigest: digest("provider-fingerprint"),
    idempotency: {
      mode: "required",
      operationKeyPolicyDigest: digest("operation-key-policy"),
    },
  };
  const provider = {
    ...providerBase,
    registrationDigest: semanticProviderRegistrationDigest(providerBase),
  };
  const providerModelBase = {
    provider,
    model: {
      id: "fixture-model",
      modelFingerprintDigest: digest("model-fingerprint"),
    },
  };
  const providerModel = {
    ...providerModelBase,
    providerModelDigest: semanticProviderModelDigest(providerModelBase),
  };
  const toolPolicyBase = { mode: "none" as const };
  const toolPolicy = {
    ...toolPolicyBase,
    policyDigest: semanticWorkflowToolPolicyDigest(toolPolicyBase),
  };
  const budgetBase: Omit<DefinitionBudget, "policyDigest"> = {
    maximumRequestBytes: SEMANTIC_WORKFLOW_MAX_CANONICAL_BYTES,
    maximumResponseBytes: SEMANTIC_WORKFLOW_MAX_CANONICAL_BYTES,
    maximumEpisodes: SEMANTIC_WORKFLOW_MAX_EPISODES,
    maximumEvidenceRefs: SEMANTIC_WORKFLOW_MAX_EVIDENCE_REFS,
    maximumInputTokens: 50_000,
    maximumOutputTokens: 5_000,
    maximumDurationMs: 60_000,
    maximumAttempts: 1,
    tokenEstimatorDigest: digest("token-estimator"),
    maximumCost: { minorUnits: 250, currency: "USD" },
    ...input.budget,
  };
  const budgetPolicy = {
    ...budgetBase,
    policyDigest: semanticWorkflowBudgetPolicyDigest(budgetBase),
  };
  const disclosureBase: Omit<DefinitionDisclosure, "policyDigest"> = {
    mode: input.transport === "outbound" ? "explicit_authorization" : "forbidden",
    minimizationPolicyDigest: digest("minimization-policy"),
    keyPolicyDigest: digest("disclosure-key-policy"),
    authorizationPolicyDigest: digest("authorization-policy"),
    maximumAuthorizationAgeMs: 60_000,
  };
  const disclosurePolicy = {
    ...disclosureBase,
    policyDigest: semanticWorkflowDisclosurePolicyDigest(disclosureBase),
  };
  const base: Omit<SemanticWorkflowDefinition, "schemaVersion" | "definitionDigest"> = {
    id: `fixture-${input.lane}-${input.transport}`,
    version: "1.0.0",
    lane: input.lane,
    transport: input.transport,
    implementation: {
      id: "fixture-workflow",
      version: "1.0.0",
      implementationDigest: digest("implementation"),
    },
    providerModel,
    prompt: { id: "fixture-prompt", version: "1.0.0", promptDigest: digest("prompt") },
    renderer: { id: "fixture-renderer", version: "1.0.0", rendererDigest: digest("renderer") },
    outputSchema: { id: "fixture-output", version: "1.0.0", schemaDigest: digest("output-schema") },
    toolPolicy,
    budgetPolicy,
    disclosurePolicy,
    principal: { id: "fixture-producer", kind: "service", independenceDomain: "fixture-provider-domain" },
    attestation: { id: "fixture-producer-attestation", digest: digest("producer-attestation") },
    calibration:
      input.lane === "generation" ? null : { status: "unverified", calibrationId: null, calibrationDigest: null },
  };
  return parseSemanticWorkflowDefinition({
    schemaVersion: 1,
    ...base,
    definitionDigest: semanticWorkflowDefinitionDigest(base),
  });
}

function generationReservationFixture(transport: DefinitionTransport = "local"): SemanticTurnReservation {
  const definition = definitionFixture({ lane: "generation", transport });
  const input: SemanticTurnReservationInput = {
    runId: `generation-${transport}-run`,
    loopRegistryRevision: digest("loop-registry"),
    semanticRegistryDigest: digest("semantic-registry"),
    scopeDigest: SCOPE_DIGEST,
    target: {
      kind: "generation",
      detector: { id: "fixture-detector", version: "1.0.0", registrationDigest: digest("detector") },
      pack: { id: "fixture-pack", version: "1.0.0", manifestDigest: digest("pack") },
      lens: { id: "fixture-lens", version: "1.0.0", registrationDigest: digest("lens") },
      windowDigest: digest("window"),
      executionKeyDigest: digest("execution-key"),
      episodeRecordIds: ["fixture-source/episode-001"],
      disclosedEvidenceReferenceDigests: [digest("evidence-reference")],
    },
    definition,
    request: {
      mediaType: "application/json",
      encoding: "utf-8",
      byteLength: 512,
      minimizedBytesDigest: digest("minimized-request"),
      keyPolicyDigest: definition.disclosurePolicy.keyPolicyDigest,
    },
    sourcePolicies: [
      {
        sourceId: "fixture-source",
        contentPolicyId: "fixture-content-policy",
        contentPolicyDigest: digest("content-policy"),
        outboundUse: transport === "outbound" ? "explicit_receipt_required" : "forbidden",
      },
    ],
    disclosureExpected: transport === "outbound",
    expiresAt: "2026-08-20T00:02:00.000Z",
  };
  return buildSemanticTurnReservation(input);
}

function advisoryReservationFixture(): SemanticTurnReservation {
  const definition = definitionFixture({ lane: "advisory_review", transport: "outbound" });
  const derivationDigest = digest("review-derivation");
  return buildSemanticTurnReservation({
    runId: "advisory-outbound-run",
    loopRegistryRevision: digest("loop-registry"),
    semanticRegistryDigest: digest("semantic-registry"),
    scopeDigest: SCOPE_DIGEST,
    target: {
      kind: "advisory_review",
      candidateId: "fixture-candidate",
      candidateDigest: digest("candidate"),
      derivation: {
        id: `insight-${derivationDigest}`,
        derivationDigest,
        scopeDigest: SCOPE_DIGEST,
      },
      evidenceSetDigest: digest("review-evidence-set"),
    },
    definition,
    request: {
      mediaType: "application/json",
      encoding: "utf-8",
      byteLength: 384,
      minimizedBytesDigest: digest("review-minimized-request"),
      keyPolicyDigest: definition.disclosurePolicy.keyPolicyDigest,
    },
    sourcePolicies: [
      {
        sourceId: "fixture-source",
        contentPolicyId: "fixture-content-policy",
        contentPolicyDigest: digest("content-policy"),
        outboundUse: "explicit_receipt_required",
      },
    ],
    disclosureExpected: true,
    expiresAt: "2026-08-20T00:02:00.000Z",
  });
}

function authorizationFixture(reservation: SemanticTurnReservation): SemanticDisclosureAuthorization {
  return buildSemanticDisclosureAuthorization(reservation, {
    authorizer: { id: "fixture-authorizer", kind: "human", independenceDomain: "fixture-human-domain" },
    authorizerAttestation: { id: "fixture-authorization-attestation", digest: digest("authorizer-attestation") },
    authorizedAt: "2026-08-20T00:00:10.000Z",
    expiresAt: "2026-08-20T00:01:00.000Z",
  });
}

function dispatchFixture(
  reservation: SemanticTurnReservation,
  authorization: SemanticDisclosureAuthorization | null,
): SemanticDispatchMarker {
  return buildSemanticDispatchMarker({
    turnKeyDigest: reservation.turnKeyDigest,
    reservationDigest: reservation.reservationDigest,
    authorizationDigest: authorization?.authorizationDigest ?? null,
    providerOperationId: `provider-operation-${reservation.runId}`,
    idempotencyKey: `operation-key-${reservation.turnKeyDigest}`,
    startedAt: "2026-08-20T00:00:20.000Z",
  });
}

function responseFixture(reservation: SemanticTurnReservation): SemanticResponseMetadata {
  return {
    providerReceiptId: `provider-receipt-${reservation.runId}`,
    providerReceiptDigest: digest(`provider-receipt-${reservation.runId}`),
    requestAttestationDigest: digest(`request-attestation-${reservation.runId}`),
    responseByteLength: 256,
    responseKeyedDigest: digest(`response-${reservation.runId}`),
    keyPolicyDigest: reservation.definition.disclosurePolicy.keyPolicyDigest,
  };
}

function reportedUsage(): Extract<SemanticUsage, { readonly status: "reported" }> {
  return {
    status: "reported",
    inputTokens: 100,
    outputTokens: 25,
    durationMs: 1_500,
    costMinorUnits: 2,
    currency: "USD",
  };
}

function unreportedUsage(reasonCode = "usage.not_reported"): Extract<SemanticUsage, { readonly status: "unreported" }> {
  return { status: "unreported", reasonCode };
}

function resultFixture(
  reservation: SemanticTurnReservation,
  dispatch: SemanticDispatchMarker,
  status: SemanticResultStatus = "completed",
): SemanticResultBinding {
  const completed = status === "completed";
  const response = status === "provider_failed" || status === "outcome_unknown" ? null : responseFixture(reservation);
  const normalizedResult = completed ? toJsonValue({ conditionDetected: true, result: "structural-only" }) : null;
  return buildSemanticResultBinding({
    turnKeyDigest: reservation.turnKeyDigest,
    reservationDigest: reservation.reservationDigest,
    dispatchDigest: dispatch.dispatchDigest,
    status,
    response,
    usage: status === "outcome_unknown" ? unreportedUsage("usage.outcome_unknown") : reportedUsage(),
    normalizedResult,
    normalizedResultDigest: normalizedResult === null ? null : semanticNormalizedResultDigest(normalizedResult),
    reasonCodes: completed ? [] : [`workflow.${status}`],
  });
}

function generationOutput(
  scopeDigest = SCOPE_DIGEST,
): Extract<SemanticTurnReceipt["output"], { readonly kind: "generation" }> {
  const executionKeyDigest = digest("workflow-execution-key");
  const derivationDigest = digest("generated-derivation");
  return {
    kind: "generation",
    workflowExecutionId: `semantic-workflow-execution-${executionKeyDigest}`,
    workflowExecutionKeyDigest: executionKeyDigest,
    workflowExecutionDigest: digest("workflow-execution"),
    derivationRefs: [{ id: `insight-${derivationDigest}`, derivationDigest, scopeDigest }],
  };
}

function turnFixture(input: {
  readonly reservation: SemanticTurnReservation;
  readonly authorization: SemanticDisclosureAuthorization | null;
  readonly dispatch: SemanticDispatchMarker;
  readonly result: SemanticResultBinding;
  readonly output?: SemanticTurnReceipt["output"];
}): SemanticTurnReceipt {
  const defaultOutput: SemanticTurnReceipt["output"] =
    input.result.status !== "completed"
      ? { kind: "none", reasonCode: `workflow.${input.result.status}` }
      : input.reservation.definition.lane === "generation"
        ? generationOutput(input.reservation.scopeDigest)
        : {
            kind: "advisory_review",
            assessmentId: `semantic-review-assessment-${digest("assessment")}`,
            assessmentDigest: digest("assessment"),
          };
  return buildSemanticTurnReceipt({
    turnKeyDigest: input.reservation.turnKeyDigest,
    reservation: { id: input.reservation.id, reservationDigest: input.reservation.reservationDigest },
    authorization:
      input.authorization === null
        ? null
        : { id: input.authorization.id, authorizationDigest: input.authorization.authorizationDigest },
    dispatch: { id: input.dispatch.id, dispatchDigest: input.dispatch.dispatchDigest },
    result: { id: input.result.id, bindingDigest: input.result.bindingDigest },
    lane: input.reservation.definition.lane,
    scopeDigest: input.reservation.scopeDigest,
    status: input.result.status,
    output: input.output ?? defaultOutput,
  });
}

function indexFixture(turn: SemanticTurnReceipt): SemanticTurnScopeIndex {
  return buildSemanticTurnScopeIndex({
    scopeDigest: turn.scopeDigest,
    turnId: turn.id,
    turnKeyDigest: turn.turnKeyDigest,
    turnDigest: turn.turnDigest,
  });
}

function omitField(input: object, key: string): unknown {
  return Object.fromEntries(Object.entries(input).filter(([field]) => field !== key));
}

function accessorSwap(
  input: object,
  key: string,
  first: unknown,
  second: unknown,
): { readonly value: object; readonly reads: () => number } {
  let reads = 0;
  const value = Object.fromEntries(Object.entries(input).filter(([field]) => field !== key));
  Object.defineProperty(value, key, {
    enumerable: true,
    get: () => {
      reads += 1;
      return reads === 1 ? first : second;
    },
  });
  return { value, reads: () => reads };
}

function inheritedField(input: object, key: string, value: unknown): object {
  const own = Object.fromEntries(Object.entries(input).filter(([field]) => field !== key));
  return Object.assign(Object.create({ [key]: value }), own);
}

function nonEnumerableField(input: object, key: string, value: unknown): object {
  const own = Object.fromEntries(Object.entries(input).filter(([field]) => field !== key));
  Object.defineProperty(own, key, { enumerable: false, value });
  return own;
}

function expectDeepFrozen(input: unknown): void {
  if (typeof input !== "object" || input === null) return;
  expect(Object.isFrozen(input)).toBe(true);
  for (const value of Object.values(input)) expectDeepFrozen(value);
}

function rawDefinitionBase(definition: SemanticWorkflowDefinition) {
  const { schemaVersion: _schemaVersion, definitionDigest: _definitionDigest, ...base } = definition;
  return base;
}

function rebuildDefinition(definition: SemanticWorkflowDefinition): SemanticWorkflowDefinition {
  const providerInput = definition.providerModel.provider;
  const { registrationDigest: _registrationDigest, ...providerBase } = providerInput;
  const provider = { ...providerBase, registrationDigest: semanticProviderRegistrationDigest(providerBase) };
  const providerModelInput = definition.providerModel;
  const providerModelBase = { provider, model: providerModelInput.model };
  const providerModel = {
    ...providerModelBase,
    providerModelDigest: semanticProviderModelDigest(providerModelBase),
  };
  const { policyDigest: _toolPolicyDigest, ...toolPolicyBase } = definition.toolPolicy;
  const toolPolicy = {
    ...toolPolicyBase,
    policyDigest: semanticWorkflowToolPolicyDigest(toolPolicyBase),
  };
  const { policyDigest: _budgetPolicyDigest, ...budgetPolicyBase } = definition.budgetPolicy;
  const budgetPolicy = {
    ...budgetPolicyBase,
    policyDigest: semanticWorkflowBudgetPolicyDigest(budgetPolicyBase),
  };
  const { policyDigest: _disclosurePolicyDigest, ...disclosurePolicyBase } = definition.disclosurePolicy;
  const disclosurePolicy = {
    ...disclosurePolicyBase,
    policyDigest: semanticWorkflowDisclosurePolicyDigest(disclosurePolicyBase),
  };
  const base = {
    ...rawDefinitionBase(definition),
    providerModel,
    toolPolicy,
    budgetPolicy,
    disclosurePolicy,
  };
  return parseSemanticWorkflowDefinition({
    schemaVersion: 1,
    ...base,
    definitionDigest: semanticWorkflowDefinitionDigest(base),
  });
}

function rawReservationBase(reservation: SemanticTurnReservation) {
  const {
    schemaVersion: _schemaVersion,
    id: _id,
    turnKeyDigest: _turnKeyDigest,
    reservationDigest: _reservationDigest,
    ...base
  } = reservation;
  return base;
}

function rawResultBase(result: SemanticResultBinding) {
  const { schemaVersion: _schemaVersion, id: _id, bindingDigest: _bindingDigest, ...base } = result;
  return base;
}

describe("semantic workflow definition and intent records", () => {
  it("round-trips unknown input, drops unknown fields, and recursively freezes all record families", () => {
    const local = generationReservationFixture("local");
    const outbound = generationReservationFixture("outbound");
    const authorization = authorizationFixture(outbound);
    const dispatch = dispatchFixture(outbound, authorization);
    const result = resultFixture(outbound, dispatch);
    const turn = turnFixture({ reservation: outbound, authorization, dispatch, result });
    const index = indexFixture(turn);
    const cases: readonly {
      readonly value: object;
      readonly parse: (input: unknown) => unknown;
    }[] = [
      { value: local.definition, parse: parseSemanticWorkflowDefinition },
      { value: local, parse: parseSemanticTurnReservation },
      { value: authorization, parse: (value) => parseSemanticDisclosureAuthorization(value, outbound) },
      { value: dispatch, parse: parseSemanticDispatchMarker },
      { value: result, parse: parseSemanticResultBinding },
      { value: turn, parse: parseSemanticTurnReceipt },
      { value: index, parse: parseSemanticTurnScopeIndex },
    ];
    for (const fixture of cases) {
      const parsed = fixture.parse({ ...fixture.value, unknownField: PRIVATE_PREVIEW_CANARY });
      expect(parsed).toEqual(fixture.value);
      expect(JSON.stringify(parsed)).not.toContain(PRIVATE_PREVIEW_CANARY);
      expectDeepFrozen(parsed);
    }
  });

  it("rejects non-record boundaries, unsupported schemas, and every missing top-level field", () => {
    const reservation = generationReservationFixture("outbound");
    const authorization = authorizationFixture(reservation);
    const dispatch = dispatchFixture(reservation, authorization);
    const result = resultFixture(reservation, dispatch);
    const turn = turnFixture({ reservation, authorization, dispatch, result });
    const index = indexFixture(turn);
    const cases: readonly {
      readonly value: object;
      readonly parse: (input: unknown) => unknown;
    }[] = [
      { value: reservation.definition, parse: parseSemanticWorkflowDefinition },
      { value: reservation, parse: parseSemanticTurnReservation },
      { value: authorization, parse: (value) => parseSemanticDisclosureAuthorization(value, reservation) },
      { value: dispatch, parse: parseSemanticDispatchMarker },
      { value: result, parse: parseSemanticResultBinding },
      { value: turn, parse: parseSemanticTurnReceipt },
      { value: index, parse: parseSemanticTurnScopeIndex },
    ];
    for (const fixture of cases) {
      for (const malformed of [null, [], "record", 1]) {
        expect(() => fixture.parse(malformed)).toThrowError(expect.objectContaining({ code: "schema.invalid" }));
      }
      expect(() => fixture.parse({ ...fixture.value, schemaVersion: 2 })).toThrowError(
        expect.objectContaining({ code: "schema.unsupported_version" }),
      );
      for (const key of Object.keys(fixture.value)) {
        expect(() => fixture.parse(omitField(fixture.value, key)), key).toThrowError(
          expect.objectContaining({ code: expect.stringMatching(/^schema\./) }),
        );
      }
    }
  });

  it("recomputes every adjacent definition digest and enforces transport, tools, budgets, and calibration", () => {
    const generation = generationReservationFixture("local").definition;
    const review = advisoryReservationFixture().definition;
    const generationBase = rawDefinitionBase(generation);
    expect(semanticProviderRegistrationDigest(generation.providerModel.provider)).toBe(
      generation.providerModel.provider.registrationDigest,
    );
    expect(semanticProviderModelDigest(generation.providerModel)).toBe(generation.providerModel.providerModelDigest);
    const { policyDigest: _toolPolicyDigest, ...toolPolicyBase } = generation.toolPolicy;
    const { policyDigest: _budgetPolicyDigest, ...budgetPolicyBase } = generation.budgetPolicy;
    const { policyDigest: _disclosurePolicyDigest, ...disclosurePolicyBase } = generation.disclosurePolicy;
    expect(semanticWorkflowToolPolicyDigest(toolPolicyBase)).toBe(generation.toolPolicy.policyDigest);
    expect(semanticWorkflowBudgetPolicyDigest(budgetPolicyBase)).toBe(generation.budgetPolicy.policyDigest);
    expect(semanticWorkflowDisclosurePolicyDigest(disclosurePolicyBase)).toBe(generation.disclosurePolicy.policyDigest);
    expect(semanticWorkflowDefinitionDigest(generationBase)).toBe(generation.definitionDigest);

    const adjacentTamper = [
      {
        ...generation,
        providerModel: {
          ...generation.providerModel,
          provider: {
            ...generation.providerModel.provider,
            providerFingerprintDigest: changedDigest(generation.providerModel.provider.providerFingerprintDigest),
          },
        },
      },
      {
        ...generation,
        providerModel: {
          ...generation.providerModel,
          model: {
            ...generation.providerModel.model,
            modelFingerprintDigest: changedDigest(generation.providerModel.model.modelFingerprintDigest),
          },
        },
      },
      { ...generation, toolPolicy: { ...generation.toolPolicy, policyDigest: "0".repeat(64) } },
      { ...generation, budgetPolicy: { ...generation.budgetPolicy, policyDigest: "0".repeat(64) } },
      { ...generation, disclosurePolicy: { ...generation.disclosurePolicy, policyDigest: "0".repeat(64) } },
      { ...generation, definitionDigest: "0".repeat(64) },
    ];
    for (const value of adjacentTamper) {
      expect(() => parseSemanticWorkflowDefinition(value)).toThrowError(
        expect.objectContaining({ code: "schema.corrupt" }),
      );
    }

    expect(() => parseSemanticWorkflowDefinition({ ...generation, transport: "outbound" })).toThrowError(
      expect.objectContaining({ code: "schema.invalid" }),
    );
    expect(() => parseSemanticWorkflowDefinition({ ...generation, calibration: review.calibration })).toThrowError(
      expect.objectContaining({ code: "schema.invalid" }),
    );
    expect(() => parseSemanticWorkflowDefinition({ ...review, calibration: null })).toThrowError(
      expect.objectContaining({ code: "schema.invalid" }),
    );
    expect(() =>
      parseSemanticWorkflowDefinition({
        ...generation,
        toolPolicy: { ...generation.toolPolicy, mode: "read_only" },
      }),
    ).toThrowError(expect.objectContaining({ code: "schema.invalid" }));
    for (const budgetPolicy of [
      { ...generation.budgetPolicy, maximumAttempts: 2 },
      { ...generation.budgetPolicy, maximumDurationMs: SEMANTIC_WORKFLOW_MAX_DURATION_MS + 1 },
      { ...generation.budgetPolicy, maximumRequestBytes: -1 },
      { ...generation.budgetPolicy, maximumCost: { minorUnits: 1, currency: "usd" } },
      { ...generation.budgetPolicy, maximumCost: { minorUnits: Number.MAX_SAFE_INTEGER + 1, currency: "USD" } },
    ]) {
      expect(() => parseSemanticWorkflowDefinition({ ...generation, budgetPolicy })).toThrowError(
        expect.objectContaining({ code: expect.stringMatching(/^schema\./) }),
      );
    }
    expect(() =>
      parseSemanticWorkflowDefinition({
        ...review,
        calibration: { status: "unverified", calibrationId: "forged", calibrationDigest: null },
      }),
    ).toThrowError(expect.objectContaining({ code: "schema.invalid" }));
  });

  it("binds every independently mutable definition fingerprint and identity into full definition identity", () => {
    const definition = generationReservationFixture("local").definition;
    const variants = [
      rebuildDefinition({
        ...definition,
        implementation: { ...definition.implementation, implementationDigest: digest("changed-implementation") },
      }),
      rebuildDefinition({
        ...definition,
        providerModel: {
          ...definition.providerModel,
          provider: {
            ...definition.providerModel.provider,
            providerFingerprintDigest: digest("changed-provider"),
          },
        },
      }),
      rebuildDefinition({
        ...definition,
        providerModel: {
          ...definition.providerModel,
          provider: {
            ...definition.providerModel.provider,
            idempotency: {
              ...definition.providerModel.provider.idempotency,
              operationKeyPolicyDigest: digest("changed-operation-key-policy"),
            },
          },
        },
      }),
      rebuildDefinition({
        ...definition,
        providerModel: {
          ...definition.providerModel,
          model: { ...definition.providerModel.model, modelFingerprintDigest: digest("changed-model") },
        },
      }),
      rebuildDefinition({ ...definition, prompt: { ...definition.prompt, promptDigest: digest("changed-prompt") } }),
      rebuildDefinition({
        ...definition,
        renderer: { ...definition.renderer, rendererDigest: digest("changed-renderer") },
      }),
      rebuildDefinition({
        ...definition,
        outputSchema: { ...definition.outputSchema, schemaDigest: digest("changed-output-schema") },
      }),
      rebuildDefinition({
        ...definition,
        budgetPolicy: { ...definition.budgetPolicy, maximumInputTokens: 49_999 },
      }),
      rebuildDefinition({
        ...definition,
        disclosurePolicy: {
          ...definition.disclosurePolicy,
          minimizationPolicyDigest: digest("changed-minimization-policy"),
        },
      }),
      rebuildDefinition({
        ...definition,
        disclosurePolicy: {
          ...definition.disclosurePolicy,
          keyPolicyDigest: digest("changed-disclosure-key-policy"),
        },
      }),
      rebuildDefinition({
        ...definition,
        principal: { ...definition.principal, id: "changed-producer" },
      }),
      rebuildDefinition({
        ...definition,
        attestation: { ...definition.attestation, digest: digest("changed-attestation") },
      }),
    ];
    for (const [index, variant] of variants.entries()) {
      expect(variant.definitionDigest, String(index)).not.toBe(definition.definitionDigest);
    }
    expect(definitionFixture({ lane: "generation", transport: "outbound" }).definitionDigest).not.toBe(
      definition.definitionDigest,
    );
    expect(definitionFixture({ lane: "advisory_review", transport: "outbound" }).definitionDigest).not.toBe(
      definition.definitionDigest,
    );
  });

  it("binds reservation identity, exact target lane, request policy, source policy, and expiry", () => {
    const local = generationReservationFixture("local");
    const outbound = generationReservationFixture("outbound");
    const advisory = advisoryReservationFixture();
    const localBase = rawReservationBase(local);
    const { expiresAt: _expiresAt, ...semanticInputs } = localBase;
    expect(semanticTurnKeyDigest(semanticInputs)).toBe(local.turnKeyDigest);
    expect(semanticTurnReservationDigest({ ...localBase, turnKeyDigest: local.turnKeyDigest })).toBe(
      local.reservationDigest,
    );
    expect(local.id).toBe(`semantic-workflow-reservation-${local.turnKeyDigest}`);
    expect(outbound.disclosureExpected).toBe(true);
    expect(local.disclosureExpected).toBe(false);
    expect(advisory.target.kind).toBe("advisory_review");

    for (const value of [
      { ...local, id: `semantic-workflow-reservation-${"0".repeat(64)}` },
      { ...local, turnKeyDigest: "0".repeat(64) },
      { ...local, reservationDigest: "0".repeat(64) },
      { ...local, disclosureExpected: true },
      { ...local, request: { ...local.request, keyPolicyDigest: digest("foreign-key-policy") } },
      { ...local, expiresAt: "2026-08-20T00:02:00Z" },
      { ...local, target: { ...local.target, kind: "advisory_review" } },
    ]) {
      expect(() => parseSemanticTurnReservation(value)).toThrowError(
        expect.objectContaining({ code: expect.stringMatching(/^schema\./) }),
      );
    }
    const outboundSource = outbound.sourcePolicies[0];
    if (outboundSource === undefined) throw new Error("outbound fixture requires one source policy");
    expect(() =>
      buildSemanticTurnReservation({
        ...rawReservationBase(outbound),
        sourcePolicies: [{ ...outboundSource, outboundUse: "forbidden" }],
      }),
    ).toThrowError(expect.objectContaining({ code: "schema.invalid" }));

    if (advisory.target.kind !== "advisory_review" || advisory.target.derivation === null) {
      throw new Error("advisory fixture requires exact derivation lineage");
    }
    const advisoryTarget = advisory.target;
    const advisoryDerivation = advisory.target.derivation;
    expect(() =>
      buildSemanticTurnReservation({
        ...rawReservationBase(advisory),
        target: {
          ...advisoryTarget,
          derivation: { ...advisoryDerivation, scopeDigest: digest("foreign-scope") },
        },
      }),
    ).toThrowError(expect.objectContaining({ code: "schema.corrupt" }));
  });

  it("binds every semantic request input into the turn key while expiry changes only full reservation identity", () => {
    const reservation = generationReservationFixture("local");
    if (reservation.target.kind !== "generation") throw new Error("expected generation fixture");
    const base = rawReservationBase(reservation);
    const definitionWithKey = rebuildDefinition({
      ...reservation.definition,
      disclosurePolicy: {
        ...reservation.definition.disclosurePolicy,
        keyPolicyDigest: digest("reservation-changed-key-policy"),
      },
    });
    const variants: readonly SemanticTurnReservation[] = [
      buildSemanticTurnReservation({ ...base, runId: "changed-run" }),
      buildSemanticTurnReservation({ ...base, loopRegistryRevision: digest("changed-loop-registry") }),
      buildSemanticTurnReservation({ ...base, semanticRegistryDigest: digest("changed-semantic-registry") }),
      buildSemanticTurnReservation({ ...base, scopeDigest: digest("changed-scope") }),
      buildSemanticTurnReservation({
        ...base,
        target: { ...reservation.target, windowDigest: digest("changed-window") },
      }),
      buildSemanticTurnReservation({
        ...base,
        request: { ...reservation.request, byteLength: reservation.request.byteLength + 1 },
      }),
      buildSemanticTurnReservation({
        ...base,
        request: { ...reservation.request, minimizedBytesDigest: digest("changed-request") },
      }),
      buildSemanticTurnReservation({
        ...base,
        sourcePolicies: reservation.sourcePolicies.map((policy) => ({
          ...policy,
          contentPolicyDigest: digest("changed-content-policy"),
        })),
      }),
      buildSemanticTurnReservation({
        ...base,
        definition: definitionWithKey,
        request: { ...reservation.request, keyPolicyDigest: definitionWithKey.disclosurePolicy.keyPolicyDigest },
      }),
    ];
    for (const [index, variant] of variants.entries()) {
      expect(variant.turnKeyDigest, String(index)).not.toBe(reservation.turnKeyDigest);
      expect(variant.reservationDigest, String(index)).not.toBe(reservation.reservationDigest);
    }
    const changedExpiry = buildSemanticTurnReservation({
      ...base,
      expiresAt: "2026-08-20T00:03:00.000Z",
    });
    expect(changedExpiry.turnKeyDigest).toBe(reservation.turnKeyDigest);
    expect(changedExpiry.reservationDigest).not.toBe(reservation.reservationDigest);
  });

  it("requires sorted unique generation populations and one sorted content policy per source", () => {
    const reservation = generationReservationFixture("outbound");
    if (reservation.target.kind !== "generation") throw new Error("expected generation fixture");
    const base = rawReservationBase(reservation);
    const evidence = reservation.target.disclosedEvidenceReferenceDigests[0];
    const episode = reservation.target.episodeRecordIds[0];
    const source = reservation.sourcePolicies[0];
    if (evidence === undefined || episode === undefined || source === undefined) {
      throw new Error("generation fixture is incomplete");
    }
    const targets = [
      { ...reservation.target, episodeRecordIds: [] },
      { ...reservation.target, episodeRecordIds: [episode, episode] },
      { ...reservation.target, episodeRecordIds: ["z/episode", "a/episode"] },
      { ...reservation.target, disclosedEvidenceReferenceDigests: [evidence, evidence] },
      {
        ...reservation.target,
        disclosedEvidenceReferenceDigests: [changedDigest(evidence), evidence].sort().reverse(),
      },
    ];
    for (const target of targets) {
      expect(() => buildSemanticTurnReservation({ ...base, target })).toThrowError(
        expect.objectContaining({ code: "schema.invalid" }),
      );
    }
    expect(() => buildSemanticTurnReservation({ ...base, sourcePolicies: [source, source] })).toThrowError(
      expect.objectContaining({ code: "schema.invalid" }),
    );
    expect(() =>
      buildSemanticTurnReservation({
        ...base,
        sourcePolicies: [source, { ...source, contentPolicyId: "z-policy" }],
      }),
    ).toThrowError(expect.objectContaining({ code: "schema.invalid" }));
  });

  it("accepts the exact request, episode, and evidence ceilings and rejects one beyond", () => {
    const reservation = generationReservationFixture("local");
    if (reservation.target.kind !== "generation") throw new Error("expected generation fixture");
    const generationTarget = reservation.target;
    const base = rawReservationBase(reservation);
    expect(
      buildSemanticTurnReservation({
        ...base,
        request: { ...reservation.request, byteLength: SEMANTIC_WORKFLOW_MAX_CANONICAL_BYTES },
      }).request.byteLength,
    ).toBe(SEMANTIC_WORKFLOW_MAX_CANONICAL_BYTES);
    expect(() =>
      buildSemanticTurnReservation({
        ...base,
        request: { ...reservation.request, byteLength: SEMANTIC_WORKFLOW_MAX_CANONICAL_BYTES + 1 },
      }),
    ).toThrowError(expect.objectContaining({ code: "schema.invalid" }));

    const episodeRecordIds = Array.from(
      { length: SEMANTIC_WORKFLOW_MAX_EPISODES },
      (_, index) => `fixture-source/episode-${String(index).padStart(4, "0")}`,
    );
    const evidenceDigests = Array.from({ length: SEMANTIC_WORKFLOW_MAX_EVIDENCE_REFS }, (_, index) =>
      numberedDigest(index + 1),
    );
    const exact = buildSemanticTurnReservation({
      ...base,
      target: { ...generationTarget, episodeRecordIds, disclosedEvidenceReferenceDigests: evidenceDigests },
    });
    if (exact.target.kind !== "generation") throw new Error("expected exact generation target");
    expect(exact.target.episodeRecordIds).toHaveLength(SEMANTIC_WORKFLOW_MAX_EPISODES);
    expect(exact.target.disclosedEvidenceReferenceDigests).toHaveLength(SEMANTIC_WORKFLOW_MAX_EVIDENCE_REFS);
    expect(() =>
      buildSemanticTurnReservation({
        ...base,
        target: {
          ...generationTarget,
          episodeRecordIds: [...episodeRecordIds, "fixture-source/episode-extra"],
        },
      }),
    ).toThrowError(expect.objectContaining({ code: "schema.invalid" }));
    expect(() =>
      buildSemanticTurnReservation({
        ...base,
        target: {
          ...generationTarget,
          disclosedEvidenceReferenceDigests: [...evidenceDigests, numberedDigest(10_000)],
        },
      }),
    ).toThrowError(expect.objectContaining({ code: "schema.invalid" }));
  });

  it("authorizes only an exact outbound reservation inside both authorization and reservation expiry", () => {
    const outbound = generationReservationFixture("outbound");
    const local = generationReservationFixture("local");
    const authorization = authorizationFixture(outbound);
    expect(authorization.id).toBe(`semantic-workflow-authorization-${outbound.turnKeyDigest}`);
    const {
      schemaVersion: _schemaVersion,
      id: _id,
      authorizationDigest: _authorizationDigest,
      ...base
    } = authorization;
    expect(semanticDisclosureAuthorizationDigest(base)).toBe(authorization.authorizationDigest);
    for (const variant of [
      buildSemanticDisclosureAuthorization(outbound, {
        ...base,
        authorizer: { ...base.authorizer, id: "changed-authorizer" },
      }),
      buildSemanticDisclosureAuthorization(outbound, {
        ...base,
        authorizerAttestation: { ...base.authorizerAttestation, digest: digest("changed-authorizer-attestation") },
      }),
      buildSemanticDisclosureAuthorization(outbound, {
        ...base,
        authorizedAt: "2026-08-20T00:00:11.000Z",
      }),
      buildSemanticDisclosureAuthorization(outbound, {
        ...base,
        expiresAt: "2026-08-20T00:00:59.000Z",
      }),
    ]) {
      expect(variant.authorizationDigest).not.toBe(authorization.authorizationDigest);
    }
    expect(() => parseSemanticDisclosureAuthorization(authorization, local)).toThrowError(
      expect.objectContaining({ code: "schema.invalid" }),
    );

    const exactMutations: readonly unknown[] = [
      { ...authorization, turnKeyDigest: digest("foreign-turn") },
      { ...authorization, reservationId: "foreign-reservation" },
      { ...authorization, reservationDigest: digest("foreign-reservation") },
      { ...authorization, scopeDigest: digest("foreign-scope") },
      { ...authorization, request: { ...authorization.request, byteLength: authorization.request.byteLength + 1 } },
      {
        ...authorization,
        request: { ...authorization.request, minimizedBytesDigest: digest("foreign-request") },
      },
      { ...authorization, providerRegistrationDigest: digest("foreign-provider") },
      { ...authorization, authorizationPolicyDigest: digest("foreign-authorization-policy") },
      { ...authorization, id: `semantic-workflow-authorization-${digest("foreign-turn")}` },
      { ...authorization, authorizationDigest: digest("foreign-authorization") },
    ];
    for (const value of exactMutations) {
      expect(() => parseSemanticDisclosureAuthorization(value, outbound)).toThrowError(
        expect.objectContaining({ code: expect.stringMatching(/^schema\./) }),
      );
    }

    for (const window of [
      { authorizedAt: "2026-08-20T00:00:10.000Z", expiresAt: "2026-08-20T00:00:10.000Z" },
      { authorizedAt: "2026-08-20T00:00:10.000Z", expiresAt: "2026-08-20T00:01:10.001Z" },
      { authorizedAt: "2026-08-20T00:01:30.000Z", expiresAt: "2026-08-20T00:02:00.001Z" },
      { authorizedAt: "2026-08-20T00:00:10Z", expiresAt: "2026-08-20T00:00:20.000Z" },
    ]) {
      expect(() => buildSemanticDisclosureAuthorization(outbound, { ...base, ...window })).toThrowError(
        expect.objectContaining({ code: "schema.invalid" }),
      );
    }
  });
});

describe("semantic workflow outcome records", () => {
  it("binds dispatch ids and full content while preserving only structural operation metadata", () => {
    const reservation = generationReservationFixture("outbound");
    const authorization = authorizationFixture(reservation);
    const dispatch = dispatchFixture(reservation, authorization);
    const { schemaVersion: _schemaVersion, id: _id, dispatchDigest: _dispatchDigest, ...base } = dispatch;
    expect(dispatch.id).toBe(`semantic-workflow-dispatch-${reservation.turnKeyDigest}`);
    expect(semanticDispatchDigest(base)).toBe(dispatch.dispatchDigest);
    for (const variant of [
      buildSemanticDispatchMarker({ ...base, providerOperationId: "changed-provider-operation" }),
      buildSemanticDispatchMarker({ ...base, idempotencyKey: "changed-idempotency-key" }),
      buildSemanticDispatchMarker({ ...base, startedAt: "2026-08-20T00:00:21.000Z" }),
    ]) {
      expect(variant.dispatchDigest).not.toBe(dispatch.dispatchDigest);
    }
    for (const value of [
      { ...dispatch, id: `semantic-workflow-dispatch-${"0".repeat(64)}` },
      { ...dispatch, dispatchDigest: "0".repeat(64) },
      { ...dispatch, startedAt: "2026-08-20T00:00:20Z" },
      { ...dispatch, providerOperationId: "" },
    ]) {
      expect(() => parseSemanticDispatchMarker(value)).toThrowError(
        expect.objectContaining({ code: expect.stringMatching(/^schema\./) }),
      );
    }
  });

  it("distinguishes reported zero usage from explicitly unreported usage and refuses unsafe values", () => {
    const reservation = generationReservationFixture("local");
    const dispatch = dispatchFixture(reservation, null);
    const response = responseFixture(reservation);
    const normalizedResult = toJsonValue({ value: "ok" });
    const reportedZero = buildSemanticResultBinding({
      turnKeyDigest: reservation.turnKeyDigest,
      reservationDigest: reservation.reservationDigest,
      dispatchDigest: dispatch.dispatchDigest,
      status: "completed",
      response,
      usage: {
        status: "reported",
        inputTokens: 0,
        outputTokens: 0,
        durationMs: 0,
        costMinorUnits: 0,
        currency: "USD",
      },
      normalizedResult,
      normalizedResultDigest: semanticNormalizedResultDigest(normalizedResult),
      reasonCodes: [],
    });
    expect(reportedZero.usage).toMatchObject({ status: "reported", inputTokens: 0, costMinorUnits: 0 });

    const unknown = resultFixture(reservation, dispatch, "outcome_unknown");
    expect(unknown.usage).toEqual({ status: "unreported", reasonCode: "usage.outcome_unknown" });
    expect(JSON.stringify(unknown.usage)).not.toContain("inputTokens");
    expect(() => parseSemanticResultBinding(omitField(reportedZero, "usage"))).toThrowError(
      expect.objectContaining({ code: "schema.invalid" }),
    );

    const invalidUsage: readonly unknown[] = [
      { ...reportedZero.usage, inputTokens: -1 },
      { ...reportedZero.usage, outputTokens: Number.MAX_SAFE_INTEGER + 1 },
      { ...reportedZero.usage, durationMs: 1.5 },
      { ...reportedZero.usage, costMinorUnits: null, currency: "USD" },
      { ...reportedZero.usage, costMinorUnits: 1, currency: null },
      { ...reportedZero.usage, costMinorUnits: 1, currency: "usd" },
    ];
    for (const usage of invalidUsage) {
      expect(() => parseSemanticResultBinding({ ...reportedZero, usage })).toThrowError(
        expect.objectContaining({ code: "schema.invalid" }),
      );
    }
  });

  it("enforces every closed result status and its response, normalized-result, usage, and reason pairing", () => {
    const reservation = generationReservationFixture("local");
    const dispatch = dispatchFixture(reservation, null);
    const statusDigests = new Set<string>();
    for (const status of [
      "completed",
      "provider_refused",
      "provider_failed",
      "result_invalid",
      "result_limit",
      "outcome_unknown",
    ] as const) {
      const result = resultFixture(reservation, dispatch, status);
      expect(result.status).toBe(status);
      expect(result.id).toBe(`semantic-workflow-result-${reservation.turnKeyDigest}`);
      const { schemaVersion: _schemaVersion, id: _id, bindingDigest: _bindingDigest, ...base } = result;
      expect(semanticResultBindingDigest(base)).toBe(result.bindingDigest);
      statusDigests.add(result.bindingDigest);
    }
    expect(statusDigests.size).toBe(6);

    const completed = resultFixture(reservation, dispatch, "completed");
    const failed = resultFixture(reservation, dispatch, "provider_failed");
    const refused = resultFixture(reservation, dispatch, "provider_refused");
    const invalid = resultFixture(reservation, dispatch, "result_invalid");
    const unknown = resultFixture(reservation, dispatch, "outcome_unknown");
    const mutations: readonly unknown[] = [
      { ...completed, response: null },
      { ...completed, normalizedResult: null, normalizedResultDigest: null },
      { ...completed, reasonCodes: ["unexpected.reason"] },
      { ...completed, normalizedResultDigest: digest("wrong-normalized-result") },
      { ...failed, normalizedResult: toJsonValue({ forged: true }) },
      { ...failed, reasonCodes: [] },
      { ...refused, response: null },
      { ...invalid, response: null },
      { ...unknown, response: responseFixture(reservation) },
      { ...unknown, usage: reportedUsage() },
      { ...unknown, id: `semantic-workflow-result-${digest("foreign-turn")}` },
      { ...unknown, bindingDigest: digest("foreign-binding") },
    ];
    for (const value of mutations) {
      expect(() => parseSemanticResultBinding(value)).toThrowError(
        expect.objectContaining({ code: expect.stringMatching(/^schema\./) }),
      );
    }
    expect(() => parseSemanticResultBinding({ ...failed, reasonCodes: ["z.reason", "a.reason"] })).toThrowError(
      expect.objectContaining({ code: "schema.invalid" }),
    );
    expect(() => parseSemanticResultBinding({ ...failed, reasonCodes: ["same.reason", "same.reason"] })).toThrowError(
      expect.objectContaining({ code: "schema.invalid" }),
    );
  });

  it("requires exact static result and unreported-usage reason codes without echoing malformed canaries", () => {
    const reservation = generationReservationFixture("local");
    const dispatch = dispatchFixture(reservation, null);
    for (const status of [
      "provider_refused",
      "provider_failed",
      "result_invalid",
      "result_limit",
      "outcome_unknown",
    ] as const) {
      const exact = resultFixture(reservation, dispatch, status);
      expect(exact.reasonCodes).toEqual([`workflow.${status}`]);
      expect(() => parseSemanticResultBinding({ ...exact, reasonCodes: ["workflow.wrong_status"] })).toThrowError(
        expect.objectContaining({ code: "schema.corrupt" }),
      );
    }
    const unknown = resultFixture(reservation, dispatch, "outcome_unknown");
    expect(unknown.usage).toEqual({ status: "unreported", reasonCode: "usage.outcome_unknown" });
    const completed = resultFixture(reservation, dispatch, "completed");
    expect(() =>
      parseSemanticResultBinding({
        ...completed,
        usage: { status: "unreported", reasonCode: "usage.not_reported" },
      }),
    ).toThrowError(expect.objectContaining({ code: "schema.corrupt" }));
    const failed = resultFixture(reservation, dispatch, "provider_failed");
    const failedUsage = { status: "unreported" as const, reasonCode: "usage.not_reported" };
    const failedUnreported = parseSemanticResultBinding({
      ...failed,
      usage: failedUsage,
      bindingDigest: semanticResultBindingDigest({ ...rawResultBase(failed), usage: failedUsage }),
    });
    expect(failedUnreported.usage).toEqual(failedUsage);
    const invalid = resultFixture(reservation, dispatch, "result_invalid");
    const invalidUsage = { status: "unreported" as const, reasonCode: "usage.not_reported" };
    const invalidUnreported = parseSemanticResultBinding({
      ...invalid,
      usage: invalidUsage,
      bindingDigest: semanticResultBindingDigest({ ...rawResultBase(invalid), usage: invalidUsage }),
    });
    expect(invalidUnreported.usage).toEqual(invalidUsage);
    for (const [record, reasonCode] of [
      [unknown, "usage.not_reported"],
      [unknown, PRIVATE_ERROR_CANARY],
      [failed, "usage.outcome_unknown"],
      [failed, PRIVATE_ERROR_CANARY],
    ] as const) {
      let serializedError = "";
      try {
        parseSemanticResultBinding({ ...record, usage: { status: "unreported", reasonCode } });
      } catch (error) {
        serializedError = JSON.stringify(error);
      }
      expect(serializedError).not.toBe("");
      expect(serializedError).not.toContain(PRIVATE_ERROR_CANARY);
    }
  });

  it("accepts safe response audit lengths and the exact normalized-result byte ceiling", () => {
    const reservation = generationReservationFixture("local");
    const dispatch = dispatchFixture(reservation, null);
    const completed = resultFixture(reservation, dispatch, "completed");
    const completedBase = rawResultBase(completed);
    const response = completed.response;
    if (response === null) throw new Error("completed fixture requires response metadata");
    expect(
      buildSemanticResultBinding({
        ...completedBase,
        response: { ...response, responseByteLength: Number.MAX_SAFE_INTEGER },
      }).response?.responseByteLength,
    ).toBe(Number.MAX_SAFE_INTEGER);
    expect(() =>
      buildSemanticResultBinding({
        ...completedBase,
        response: { ...response, responseByteLength: Number.MAX_SAFE_INTEGER + 1 },
      }),
    ).toThrowError(expect.objectContaining({ code: "schema.invalid" }));

    const empty = toJsonValue({ padding: "" });
    const emptyBytes = Buffer.byteLength(canonicalJsonText(empty), "utf8");
    const exactResult = toJsonValue({ padding: "x".repeat(SEMANTIC_WORKFLOW_MAX_CANONICAL_BYTES - emptyBytes) });
    const exact = buildSemanticResultBinding({
      ...completedBase,
      normalizedResult: exactResult,
      normalizedResultDigest: semanticNormalizedResultDigest(exactResult),
    });
    expect(Buffer.byteLength(canonicalJsonText(exact.normalizedResult ?? null), "utf8")).toBe(
      SEMANTIC_WORKFLOW_MAX_CANONICAL_BYTES,
    );
    const excessResult = toJsonValue({ padding: "x".repeat(SEMANTIC_WORKFLOW_MAX_CANONICAL_BYTES - emptyBytes + 1) });
    expect(() =>
      buildSemanticResultBinding({
        ...completedBase,
        normalizedResult: excessResult,
        normalizedResultDigest: semanticNormalizedResultDigest(excessResult),
      }),
    ).toThrowError(expect.objectContaining({ code: "semantic.workflow_limit" }));
  }, 30_000);

  it("accepts exact structural depth/node ceilings and rejects one beyond before recursive canonicalization", () => {
    let exactDepth: JsonValue = "leaf";
    for (let depth = 0; depth < SEMANTIC_WORKFLOW_MAX_STRUCTURE_DEPTH; depth += 1) exactDepth = [exactDepth];
    expect(() => assertSemanticWorkflowStructureBound(exactDepth)).not.toThrow();
    expect(() => semanticNormalizedResultDigest(exactDepth)).not.toThrow();
    const excessDepth: JsonValue = [exactDepth];
    expect(() => semanticNormalizedResultDigest(excessDepth)).toThrowError(
      expect.objectContaining({ code: "semantic.workflow_limit" }),
    );

    const exactNodes = toJsonValue(Array.from({ length: SEMANTIC_WORKFLOW_MAX_STRUCTURE_NODES - 1 }, () => 0));
    expect(() => assertSemanticWorkflowStructureBound(exactNodes)).not.toThrow();
    expect(() => semanticNormalizedResultDigest(exactNodes)).not.toThrow();
    const excessNodes = toJsonValue(Array.from({ length: SEMANTIC_WORKFLOW_MAX_STRUCTURE_NODES }, () => 0));
    expect(() => semanticNormalizedResultDigest(excessNodes)).toThrowError(
      expect.objectContaining({ code: "semantic.workflow_limit" }),
    );
  }, 30_000);

  it("enforces terminal status, lane, exact output identity, scope, ordering, and no-output reasons", () => {
    const local = generationReservationFixture("local");
    const dispatch = dispatchFixture(local, null);
    const completed = resultFixture(local, dispatch, "completed");
    const turn = turnFixture({ reservation: local, authorization: null, dispatch, result: completed });
    const { schemaVersion: _schemaVersion, id: _id, turnDigest: _turnDigest, ...base } = turn;
    expect(semanticTurnDigest(base)).toBe(turn.turnDigest);
    expect(turn.id).toBe(`semantic-workflow-turn-${local.turnKeyDigest}`);

    const noCondition = turnFixture({
      reservation: local,
      authorization: null,
      dispatch,
      result: completed,
      output: { kind: "none", reasonCode: "workflow.condition_not_detected" },
    });
    expect(noCondition.output).toEqual({ kind: "none", reasonCode: "workflow.condition_not_detected" });
    expect(noCondition.turnDigest).not.toBe(turn.turnDigest);

    const failureStatuses: readonly Exclude<SemanticResultStatus, "completed">[] = [
      "provider_refused",
      "provider_failed",
      "result_invalid",
      "result_limit",
      "outcome_unknown",
    ];
    for (const status of failureStatuses) {
      const result = resultFixture(local, dispatch, status);
      const failedTurn = turnFixture({ reservation: local, authorization: null, dispatch, result });
      expect(failedTurn.output).toEqual({ kind: "none", reasonCode: `workflow.${status}` });
    }

    const advisory = advisoryReservationFixture();
    const authorization = authorizationFixture(advisory);
    const advisoryDispatch = dispatchFixture(advisory, authorization);
    const advisoryResult = resultFixture(advisory, advisoryDispatch, "completed");
    expect(
      turnFixture({ reservation: advisory, authorization, dispatch: advisoryDispatch, result: advisoryResult }).output
        .kind,
    ).toBe("advisory_review");

    const generation = generationOutput();
    const derivation = generation.derivationRefs[0];
    if (derivation === undefined) throw new Error("generation fixture requires one derivation");
    const turnMutations: readonly unknown[] = [
      { ...turn, id: `semantic-workflow-turn-${digest("foreign-turn")}` },
      { ...turn, turnDigest: digest("foreign-turn-digest") },
      { ...turn, lane: "advisory_review" },
      { ...turn, output: { kind: "advisory_review", assessmentId: "assessment", assessmentDigest: digest("a") } },
      { ...turn, output: { kind: "none", reasonCode: "wrong.reason" } },
      { ...turn, output: { ...generation, derivationRefs: [] } },
      { ...turn, output: { ...generation, workflowExecutionId: "foreign-execution" } },
      {
        ...turn,
        output: { ...generation, derivationRefs: [{ ...derivation, scopeDigest: digest("foreign-scope") }] },
      },
      {
        ...turn,
        output: { ...generation, derivationRefs: [derivation, derivation] },
      },
      {
        ...turn,
        dispatch: { ...turn.dispatch, id: `semantic-workflow-dispatch-${digest("foreign-turn")}` },
      },
      {
        ...turn,
        result: { ...turn.result, id: `semantic-workflow-result-${digest("foreign-turn")}` },
      },
    ];
    for (const value of turnMutations) {
      expect(() => parseSemanticTurnReceipt(value)).toThrowError(
        expect.objectContaining({ code: expect.stringMatching(/^schema\./) }),
      );
    }
  });

  it("binds exact scope-index target identity and digest", () => {
    const reservation = generationReservationFixture("local");
    const dispatch = dispatchFixture(reservation, null);
    const result = resultFixture(reservation, dispatch);
    const turn = turnFixture({ reservation, authorization: null, dispatch, result });
    const index = indexFixture(turn);
    const { schemaVersion: _schemaVersion, indexDigest: _indexDigest, ...base } = index;
    expect(semanticTurnScopeIndexDigest(base)).toBe(index.indexDigest);
    expect(() => parseSemanticTurnScopeIndex({ ...index, turnId: "foreign-turn" })).toThrowError(
      expect.objectContaining({ code: "schema.corrupt" }),
    );
    expect(() => parseSemanticTurnScopeIndex({ ...index, indexDigest: digest("foreign-index") })).toThrowError(
      expect.objectContaining({ code: "schema.corrupt" }),
    );
  });

  it("never serializes preview bytes, raw provider responses/errors, or authority-bearing model fields", () => {
    const reservation = generationReservationFixture("outbound");
    const authorization = authorizationFixture(reservation);
    const dispatch = dispatchFixture(reservation, authorization);
    const result = resultFixture(reservation, dispatch);
    const turn = turnFixture({ reservation, authorization, dispatch, result });
    const index = indexFixture(turn);
    const records = [
      parseSemanticWorkflowDefinition({ ...reservation.definition, preview: PRIVATE_PREVIEW_CANARY }),
      parseSemanticTurnReservation({ ...reservation, preview: PRIVATE_PREVIEW_CANARY }),
      parseSemanticDisclosureAuthorization({ ...authorization, preview: PRIVATE_PREVIEW_CANARY }, reservation),
      parseSemanticDispatchMarker({ ...dispatch, providerError: PRIVATE_ERROR_CANARY }),
      parseSemanticResultBinding({ ...result, rawResponse: PRIVATE_RESPONSE_CANARY }),
      parseSemanticTurnReceipt({
        ...turn,
        Candidate: { id: "forged" },
        Review: { disposition: "accept" },
        publication: true,
        authority: "verified",
        effect: "apply",
      }),
      parseSemanticTurnScopeIndex({ ...index, admission: PRIVATE_PREVIEW_CANARY }),
    ];
    const serialized = JSON.stringify(records);
    for (const canary of [PRIVATE_PREVIEW_CANARY, PRIVATE_RESPONSE_CANARY, PRIVATE_ERROR_CANARY]) {
      expect(serialized).not.toContain(canary);
    }
    for (const forbidden of [
      "rawResponse",
      "providerError",
      "Candidate",
      "Review",
      "publication",
      "authority",
      "effect",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(serialized).toContain(reservation.request.minimizedBytesDigest);
    expect(serialized).toContain(`"byteLength":${reservation.request.byteLength}`);

    let diagnosticText = "";
    try {
      parseSemanticResultBinding({ providerError: PRIVATE_ERROR_CANARY });
    } catch (error) {
      diagnosticText = JSON.stringify(error);
    }
    expect(diagnosticText).not.toContain(PRIVATE_ERROR_CANARY);
  });

  it("rejects accessor swaps statically before changing keys/digests or deeply nested results can be reread", () => {
    const reservation = generationReservationFixture("local");
    const dispatch = dispatchFixture(reservation, null);
    const completed = resultFixture(reservation, dispatch, "completed");
    let deep: unknown = PRIVATE_RESPONSE_CANARY;
    for (let depth = 0; depth < 20_000; depth += 1) deep = [deep];
    const normalizedSwap = accessorSwap({ safe: true }, "payload", { structural: "safe" }, deep);
    const normalizedRecord = {
      ...completed,
      normalizedResult: normalizedSwap.value,
      normalizedResultDigest: completed.normalizedResultDigest,
    };
    expect(() => parseSemanticResultBinding(normalizedRecord)).toThrowError(
      expect.objectContaining({ name: "LearningLoopError", code: expect.stringMatching(/^schema\.|^semantic\./) }),
    );
    expect(normalizedSwap.reads()).toBeLessThanOrEqual(1);

    const swaps = [
      {
        name: "reservation key",
        parse: (value: unknown) => parseSemanticTurnReservation(value),
        swap: accessorSwap(reservation, "turnKeyDigest", reservation.turnKeyDigest, digest("swapped-turn-key")),
      },
      {
        name: "reservation digest",
        parse: (value: unknown) => parseSemanticTurnReservation(value),
        swap: accessorSwap(
          reservation,
          "reservationDigest",
          reservation.reservationDigest,
          digest("swapped-reservation-digest"),
        ),
      },
      {
        name: "result key",
        parse: (value: unknown) => parseSemanticResultBinding(value),
        swap: accessorSwap(completed, "turnKeyDigest", completed.turnKeyDigest, digest("swapped-result-key")),
      },
      {
        name: "result digest",
        parse: (value: unknown) => parseSemanticResultBinding(value),
        swap: accessorSwap(completed, "bindingDigest", completed.bindingDigest, digest("swapped-result-digest")),
      },
    ];
    for (const fixture of swaps) {
      expect(() => fixture.parse(fixture.swap.value), fixture.name).toThrowError(
        expect.objectContaining({ name: "LearningLoopError", code: expect.stringMatching(/^schema\.|^semantic\./) }),
      );
      expect(fixture.swap.reads()).toBeLessThanOrEqual(1);
    }

    for (const fixture of [
      { parse: parseSemanticTurnReservation, value: inheritedField(reservation, "schemaVersion", 1) },
      {
        parse: parseSemanticTurnReservation,
        value: inheritedField(reservation, "turnKeyDigest", reservation.turnKeyDigest),
      },
      {
        parse: parseSemanticTurnReservation,
        value: nonEnumerableField(reservation, "reservationDigest", reservation.reservationDigest),
      },
      { parse: parseSemanticResultBinding, value: inheritedField(completed, "schemaVersion", 1) },
      {
        parse: parseSemanticResultBinding,
        value: inheritedField(completed, "turnKeyDigest", completed.turnKeyDigest),
      },
      {
        parse: parseSemanticResultBinding,
        value: nonEnumerableField(completed, "bindingDigest", completed.bindingDigest),
      },
    ]) {
      expect(() => fixture.parse(fixture.value)).toThrowError(
        expect.objectContaining({ name: "LearningLoopError", code: "schema.invalid" }),
      );
    }

    if (reservation.target.kind !== "generation") throw new Error("accessor-array fixture requires generation");
    let arrayReads = 0;
    const episodeRecordIds = [...reservation.target.episodeRecordIds];
    const firstEpisode = episodeRecordIds[0];
    if (firstEpisode === undefined) throw new Error("accessor-array fixture requires an episode");
    Object.defineProperty(episodeRecordIds, "0", {
      enumerable: true,
      get: () => {
        arrayReads += 1;
        return arrayReads === 1 ? firstEpisode : `${firstEpisode}-changed`;
      },
    });
    expect(() =>
      parseSemanticTurnReservation({
        ...reservation,
        target: { ...reservation.target, episodeRecordIds },
      }),
    ).toThrowError(expect.objectContaining({ name: "LearningLoopError", code: "schema.invalid" }));
    expect(arrayReads).toBeLessThanOrEqual(1);
  });
});
