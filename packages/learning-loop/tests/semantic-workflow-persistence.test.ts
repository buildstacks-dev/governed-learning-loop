// #13a receipt-last workflow persistence: exact write order, dispatch
// linearization, crash classification/recovery, and scope-private reads.
import { describe, expect, it } from "vitest";
import type {
  ContentPolicy,
  DetectorPackManifest,
  DetectorRegistration,
  LearningLensRegistration,
  LearningStore,
  RecordKey,
  RegisteredSource,
  SemanticRegistryConfig,
} from "../src/index.js";
import {
  conservativePolicy,
  defineSourceRegistration,
  detectorPackManifestDigest,
  detectorRegistrationDigest,
  learningLensRegistrationDigest,
  parseDetectorPackManifest,
  parseDetectorRegistration,
  parseLearningLensRegistration,
  parseSemanticRegistryConfig,
  semanticRegistryDigest,
  sha256HexOfCanonicalJson,
  toJsonValue,
} from "../src/index.js";
import type { JsonValue } from "../src/index.js";
import type { EngineContext } from "../src/engine/context.js";
import { extractPolicyRules } from "../src/engine/policy.js";
import { detectorRefKey, lensRefKey, packRefKey } from "../src/records/semantic-shared.js";
import type {
  SemanticDisclosureAuthorization,
  SemanticTurnReservation,
} from "../src/workflows/semantic-turn-intent.js";
import {
  buildSemanticDisclosureAuthorization,
  buildSemanticTurnReservation,
} from "../src/workflows/semantic-turn-intent.js";
import type {
  SemanticDispatchMarker,
  SemanticResponseMetadata,
  SemanticResultBinding,
  SemanticTurnReceipt,
  SemanticTurnScopeIndex,
} from "../src/workflows/semantic-turn-outcome.js";
import {
  buildSemanticResultBinding,
  buildSemanticTurnReceipt,
  buildSemanticTurnScopeIndex,
  semanticNormalizedResultDigest,
} from "../src/workflows/semantic-turn-outcome.js";
import * as workflowPersistence from "../src/workflows/semantic-turn-persistence.js";
import type { SemanticTurnPersistenceGraph } from "../src/workflows/semantic-turn-persistence.js";
import {
  claimSemanticDispatch,
  classifySemanticTurnPersistence,
  loadSemanticTurnByScope,
  persistSemanticDisclosureAuthorization,
  persistSemanticResultBinding,
  persistSemanticTurnReservation,
  persistSemanticTurnTerminal,
  semanticProviderOperationKeyDigest,
  semanticWorkflowSnapshotRevision,
  SEMANTIC_TURN_SCOPE_INDEX_KIND,
} from "../src/workflows/semantic-turn-persistence.js";
import type { SemanticWorkflowDefinition } from "../src/workflows/workflow-definition.js";
import {
  parseSemanticWorkflowDefinition,
  semanticProviderModelDigest,
  semanticProviderRegistrationDigest,
  semanticWorkflowBudgetPolicyDigest,
  semanticWorkflowDefinitionDigest,
  semanticWorkflowDisclosurePolicyDigest,
  semanticWorkflowToolPolicyDigest,
} from "../src/workflows/workflow-definition.js";
import {
  createExactScopePolicy,
  createFixedClock,
  createInMemoryStore,
  createManualEvidenceSource,
  createSequentialIds,
  createTestIdentityPort,
} from "../src/testing/index.js";

const SCOPE_DIGEST = digest("persistence-scope");
const FOREIGN_SCOPE_DIGEST = digest("persistence-foreign-scope");
const SCOPE_POLICY = createExactScopePolicy();
const CONTENT_POLICY_ID = "persistence-content-policy";
const SOURCE = defineSourceRegistration({
  source: createManualEvidenceSource(),
  trustCeiling: "observed",
  contentPolicyId: CONTENT_POLICY_ID,
});
const GLOBAL_KINDS = {
  reservation: "semantic-workflow-reservation",
  authorization: "semantic-workflow-authorization",
  dispatch: "semantic-workflow-dispatch",
  result: "semantic-workflow-result",
} as const;
const SCOPED_TURN_KIND = "semantic-workflow-turn";

type Lane = SemanticWorkflowDefinition["lane"];
type Transport = SemanticWorkflowDefinition["transport"];
type Provider = SemanticWorkflowDefinition["providerModel"]["provider"];
type Budget = SemanticWorkflowDefinition["budgetPolicy"];
type Disclosure = SemanticWorkflowDefinition["disclosurePolicy"];

interface StoreTrace {
  readonly writes: string[];
  readonly gets: RecordKey[];
}

interface CommittedFixture extends SemanticTurnPersistenceGraph {
  readonly dispatchClaimStatus: "created" | "existing";
}

function digest(label: string): string {
  return sha256HexOfCanonicalJson(toJsonValue({ label }));
}

function valueDigest(value: unknown): string {
  return sha256HexOfCanonicalJson(toJsonValue(value));
}

function detectorRef(detector: DetectorRegistration) {
  return { id: detector.id, version: detector.version, registrationDigest: detector.registrationDigest };
}

function packRef(pack: DetectorPackManifest) {
  return { id: pack.id, version: pack.version, manifestDigest: pack.manifestDigest };
}

function lensRef(lens: LearningLensRegistration) {
  return { id: lens.id, version: lens.version, registrationDigest: lens.registrationDigest };
}

function semanticFixture(
  transport: Transport,
  workflowDefinition: SemanticWorkflowDefinition,
): {
  readonly detector: DetectorRegistration;
  readonly pack: DetectorPackManifest;
  readonly lens: LearningLensRegistration;
  readonly registry: SemanticRegistryConfig;
} {
  const objective = "Generate an inert semantic derivation for an exact bounded test population.";
  const qualitativeRubric = { evidence: "exact", uncertainty: "required" };
  const validationStrategy = { method: "advisory-only" };
  const lensBase: Omit<LearningLensRegistration, "schemaVersion" | "registrationDigest"> = {
    id: "persistence-lens",
    version: "1.0.0",
    objective,
    objectiveDigest: valueDigest(objective),
    scopePolicyDigest: SCOPE_POLICY.digest,
    applicableScopes: { mode: "invocation" },
    episodeClasses: { mode: "any" },
    learningClasses: ["system_meta"],
    evidenceRequirements: [{ kind: "observation", minimumTrust: "advisory", minimumCompleteness: "partial" }],
    qualitativeRubric,
    qualitativeRubricDigest: valueDigest(qualitativeRubric),
    requiredFingerprintKinds: ["budget", "implementation", "model", "prompt", "tool"],
    requiredCalibrationIds: [],
    permittedDestinationIds: ["persistence/destination"],
    permittedDestinationKinds: ["report-note"],
    generatorPolicy: {
      allowedKinds: ["semantic_judgment"],
      identityPolicyDigest: digest("persistence-generator-identity-policy"),
      fingerprintPolicyDigest: digest("persistence-generator-fingerprint-policy"),
    },
    reviewerPolicy: {
      independentFromGenerator: true,
      identityPolicyDigest: digest("persistence-reviewer-identity-policy"),
      calibrationPolicyDigest: null,
    },
    privacy: {
      outboundDisclosure: "explicit_disclosure_receipt",
      policyDigest: digest("persistence-lens-privacy-policy"),
    },
    validationStrategy,
    validationStrategyDigest: valueDigest(validationStrategy),
    supersedes: null,
  };
  const lens = parseLearningLensRegistration({
    schemaVersion: 1,
    ...lensBase,
    registrationDigest: learningLensRegistrationDigest(lensBase),
  });
  const configuration = {
    workflow: "provider-neutral",
    result: "inert",
    workflowDefinitionDigest: workflowDefinition.definitionDigest,
  };
  const falsePositivePolicy = { complexLegitimateControl: "required" };
  const proposedValidationCriterion = { outcome: "no-authority" };
  const detectorBase: Omit<DetectorRegistration, "schemaVersion" | "registrationDigest"> = {
    id: "persistence-detector",
    version: "1.0.0",
    maturity: "experimental",
    implementationDigest: workflowDefinition.implementation.implementationDigest,
    configuration,
    configurationDigest: valueDigest(configuration),
    thresholds: null,
    thresholdDigest: null,
    observationVocabularyDigest: digest("persistence-observation-vocabulary"),
    requiredCapabilities: ["persistence.semantic.input"],
    acceptedObservationKinds: ["persistence.semantic.observation"],
    minimumTrust: "advisory",
    minimumCompleteness: "partial",
    episodeClasses: { mode: "any" },
    scopePolicyDigest: SCOPE_POLICY.digest,
    scopeConstraint: { mode: "invocation" },
    lensConstraint: { mode: "required", selection: "allowlist", registrations: [lensRef(lens)] },
    normalizationPolicyDigest: digest("persistence-normalization-policy"),
    comparabilityPolicyDigest: null,
    outputKind: "insight_derivation",
    positiveFixtureDigests: [digest("persistence-positive-fixture")],
    negativeFixtureDigests: [digest("persistence-negative-fixture")],
    falsePositivePolicy,
    falsePositivePolicyDigest: valueDigest(falsePositivePolicy),
    calibrationPopulation: null,
    calibrationPopulationDigest: null,
    calibrationEvidenceDigest: null,
    privacy: {
      signatureTreatment: "none",
      transientContent: transport === "outbound" ? "explicit_disclosure_receipt" : "memory_only",
      policyDigest: digest(`persistence-detector-privacy-${transport}`),
    },
    proposedValidationCriterion,
    proposedValidationCriterionDigest: valueDigest(proposedValidationCriterion),
    supersedes: null,
  };
  const detector = parseDetectorRegistration({
    schemaVersion: 1,
    ...detectorBase,
    registrationDigest: detectorRegistrationDigest(detectorBase),
  });
  const packBase: Omit<DetectorPackManifest, "schemaVersion" | "manifestDigest"> = {
    id: "persistence-pack",
    version: "1.0.0",
    kind: "host",
    detectors: [detectorRef(detector)],
    lenses: [lensRef(lens)],
    changelogDigest: digest("persistence-pack-changelog"),
    supersedes: null,
  };
  const pack = parseDetectorPackManifest({
    schemaVersion: 1,
    ...packBase,
    manifestDigest: detectorPackManifestDigest(packBase),
  });
  const registryBase: Omit<SemanticRegistryConfig, "schemaVersion" | "registryDigest"> = {
    scopePolicyDigest: SCOPE_POLICY.digest,
    detectors: [detector],
    packs: [pack],
    lenses: [lens],
    sourceProfiles: [],
    selectedDetectorRefs: [detectorRef(detector)],
    selectedPackRefs: [packRef(pack)],
    selectedLensRefs: [lensRef(lens)],
  };
  const registry = parseSemanticRegistryConfig({
    schemaVersion: 1,
    ...registryBase,
    registryDigest: semanticRegistryDigest(registryBase),
  });
  return { detector, pack, lens, registry };
}

function definition(lane: Lane, transport: Transport): SemanticWorkflowDefinition {
  const providerBase: Omit<Provider, "registrationDigest"> = {
    id: "persistence-provider",
    version: "1.0.0",
    providerFingerprintDigest: digest("persistence-provider-fingerprint"),
    idempotency: { mode: "required", operationKeyPolicyDigest: digest("persistence-operation-key-policy") },
  };
  const provider = {
    ...providerBase,
    registrationDigest: semanticProviderRegistrationDigest(providerBase),
  };
  const providerModelBase = {
    provider,
    model: { id: "persistence-model", modelFingerprintDigest: digest("persistence-model-fingerprint") },
  };
  const providerModel = {
    ...providerModelBase,
    providerModelDigest: semanticProviderModelDigest(providerModelBase),
  };
  const toolBase = { mode: "none" as const };
  const toolPolicy = { ...toolBase, policyDigest: semanticWorkflowToolPolicyDigest(toolBase) };
  const budgetBase: Omit<Budget, "policyDigest"> = {
    maximumRequestBytes: 4_096,
    maximumResponseBytes: 4_096,
    maximumEpisodes: 10,
    maximumEvidenceRefs: 100,
    maximumInputTokens: 1_000,
    maximumOutputTokens: 500,
    maximumDurationMs: 30_000,
    maximumAttempts: 1,
    tokenEstimatorDigest: digest("persistence-token-estimator"),
    maximumCost: { minorUnits: 10, currency: "USD" },
  };
  const budgetPolicy = { ...budgetBase, policyDigest: semanticWorkflowBudgetPolicyDigest(budgetBase) };
  const disclosureBase: Omit<Disclosure, "policyDigest"> = {
    mode: transport === "outbound" ? "explicit_authorization" : "forbidden",
    minimizationPolicyDigest: digest("persistence-minimization-policy"),
    keyPolicyDigest: digest("persistence-key-policy"),
    authorizationPolicyDigest: digest("persistence-authorization-policy"),
    maximumAuthorizationAgeMs: 60_000,
  };
  const disclosurePolicy = {
    ...disclosureBase,
    policyDigest: semanticWorkflowDisclosurePolicyDigest(disclosureBase),
  };
  const base: Omit<SemanticWorkflowDefinition, "schemaVersion" | "definitionDigest"> = {
    id: `persistence-${lane}-${transport}`,
    version: "1.0.0",
    lane,
    transport,
    implementation: {
      id: "persistence-workflow",
      version: "1.0.0",
      implementationDigest: digest("persistence-implementation"),
    },
    providerModel,
    prompt: { id: "persistence-prompt", version: "1.0.0", promptDigest: digest("persistence-prompt") },
    renderer: {
      id: "persistence-renderer",
      version: "1.0.0",
      rendererDigest: digest("persistence-renderer"),
    },
    outputSchema: {
      id: "persistence-output",
      version: "1.0.0",
      schemaDigest: digest("persistence-output-schema"),
    },
    toolPolicy,
    budgetPolicy,
    disclosurePolicy,
    principal: { id: "persistence-producer", kind: "service", independenceDomain: "persistence-provider-domain" },
    attestation: { id: "persistence-producer-attestation", digest: digest("persistence-producer-attestation") },
    calibration: lane === "generation" ? null : { status: "unverified", calibrationId: null, calibrationDigest: null },
  };
  return parseSemanticWorkflowDefinition({
    schemaVersion: 1,
    ...base,
    definitionDigest: semanticWorkflowDefinitionDigest(base),
  });
}

function contentPolicyDigest(transport: Transport): string {
  return digest(`persistence-content-policy-${transport}`);
}

function reservation(lane: Lane = "generation", transport: Transport = "outbound"): SemanticTurnReservation {
  const workflow = definition(lane, transport);
  const semantic = semanticFixture(transport, workflow);
  const common = {
    runId: `persistence-${lane}-${transport}-run`,
    loopRegistryRevision: digest("persistence-loop-registry"),
    semanticRegistryDigest: semantic.registry.registryDigest,
    scopeDigest: SCOPE_DIGEST,
    definition: workflow,
    request: {
      mediaType: "application/json" as const,
      encoding: "utf-8" as const,
      byteLength: 512,
      minimizedBytesDigest: digest(`persistence-request-${lane}-${transport}`),
      keyPolicyDigest: workflow.disclosurePolicy.keyPolicyDigest,
    },
    sourcePolicies: [
      {
        sourceId: SOURCE.id,
        contentPolicyId: CONTENT_POLICY_ID,
        contentPolicyDigest: contentPolicyDigest(transport),
        outboundUse: transport === "outbound" ? ("explicit_receipt_required" as const) : ("forbidden" as const),
      },
    ],
    disclosureExpected: transport === "outbound",
    expiresAt: "2026-08-20T00:05:00.000Z",
  };
  if (lane === "advisory_review") {
    return buildSemanticTurnReservation({
      ...common,
      target: {
        kind: "advisory_review",
        candidateId: "persistence-candidate",
        candidateDigest: digest("persistence-candidate"),
        derivation: null,
        evidenceSetDigest: digest("persistence-review-evidence"),
      },
    });
  }
  return buildSemanticTurnReservation({
    ...common,
    target: {
      kind: "generation",
      detector: detectorRef(semantic.detector),
      pack: packRef(semantic.pack),
      lens: lensRef(semantic.lens),
      windowDigest: digest("persistence-window"),
      executionKeyDigest: digest("persistence-execution-key"),
      episodeRecordIds: [`${SOURCE.id}/episode-001`],
      disclosedEvidenceReferenceDigests: [digest("persistence-evidence")],
    },
  });
}

function authorization(reserved: SemanticTurnReservation): SemanticDisclosureAuthorization {
  return buildSemanticDisclosureAuthorization(reserved, {
    authorizer: { id: "persistence-authorizer", kind: "human", independenceDomain: "persistence-human-domain" },
    authorizerAttestation: {
      id: "persistence-authorization-attestation",
      digest: digest("persistence-authorization-attestation"),
    },
    authorizedAt: "2026-08-20T00:00:10.000Z",
    expiresAt: "2026-08-20T00:01:00.000Z",
  });
}

function currentContentPolicy(transport: Transport): ContentPolicy {
  const outboundUse = transport === "outbound" ? "explicit_receipt_required" : "forbidden";
  return {
    id: "persistence-content-policy",
    digest: contentPolicyDigest(transport),
    maximumInputBytes: 4_096,
    outboundUse,
    transform: (input) =>
      Promise.resolve({ accepted: toJsonValue(input), classification: "persistence-test", diagnostics: [] }),
  };
}

function context(
  store: LearningStore,
  now = "2026-08-20T00:00:20.000Z",
  transport: Transport = "outbound",
  lane: Lane = "generation",
): EngineContext {
  const policy = conservativePolicy();
  const contentPolicy = currentContentPolicy(transport);
  const semantic = semanticFixture(transport, definition(lane, transport));
  return {
    store,
    policy,
    policyRules: extractPolicyRules(policy),
    scopePolicy: SCOPE_POLICY,
    contentPoliciesById: new Map([[contentPolicy.id, contentPolicy]]),
    sources: new Set<RegisteredSource<unknown>>([SOURCE]),
    identity: createTestIdentityPort(),
    semanticRegistry: semantic.registry,
    semanticDetectorsByRef: new Map([[detectorRefKey(detectorRef(semantic.detector)), semantic.detector]]),
    semanticPacksByRef: new Map([[packRefKey(packRef(semantic.pack)), semantic.pack]]),
    semanticLensesByRef: new Map([[lensRefKey(lensRef(semantic.lens)), semantic.lens]]),
    sourceSemanticProfilesBySourceId: new Map(),
    registryRevision: digest("persistence-loop-registry"),
    queryCursorScopeDigest: digest("persistence-query-cursor-scope"),
    clock: createFixedClock(now),
    ids: createSequentialIds("semantic-workflow-persistence"),
  };
}

function result(
  reserved: SemanticTurnReservation,
  dispatch: SemanticDispatchMarker,
  status: "completed" | "provider_refused" | "result_limit" = "completed",
): SemanticResultBinding {
  const normalizedResult =
    status === "completed" ? toJsonValue({ conditionDetected: true, output: "persistence-structural" }) : null;
  return buildSemanticResultBinding({
    turnKeyDigest: reserved.turnKeyDigest,
    reservationDigest: reserved.reservationDigest,
    dispatchDigest: dispatch.dispatchDigest,
    status,
    response: {
      providerReceiptId: `persistence-provider-receipt-${reserved.runId}`,
      providerReceiptDigest: digest(`persistence-provider-receipt-${reserved.runId}`),
      requestAttestationDigest: reserved.request.minimizedBytesDigest,
      responseByteLength: 256,
      responseKeyedDigest: digest(`persistence-response-${reserved.runId}`),
      keyPolicyDigest: reserved.request.keyPolicyDigest,
    },
    usage: {
      status: "reported",
      inputTokens: 200,
      outputTokens: 50,
      durationMs: 2_000,
      costMinorUnits: 2,
      currency: "USD",
    },
    normalizedResult,
    normalizedResultDigest: normalizedResult === null ? null : semanticNormalizedResultDigest(normalizedResult),
    reasonCodes: status === "completed" ? [] : [`workflow.${status}`],
  });
}

function withResponseMutation(
  reserved: SemanticTurnReservation,
  dispatch: SemanticDispatchMarker,
  mutation: Partial<SemanticResponseMetadata>,
): SemanticResultBinding {
  const exact = result(reserved, dispatch, "provider_refused");
  if (exact.response === null) throw new Error("provider-refused persistence result requires response metadata");
  return { ...exact, response: { ...exact.response, ...mutation } };
}

function output(reserved: SemanticTurnReservation): SemanticTurnReceipt["output"] {
  if (reserved.definition.lane === "advisory_review") {
    const assessmentDigest = digest("persistence-assessment");
    return {
      kind: "advisory_review",
      assessmentId: `semantic-review-assessment-${assessmentDigest}`,
      assessmentDigest,
    };
  }
  const executionKeyDigest = digest("persistence-workflow-execution-key");
  const derivationDigest = digest("persistence-derivation");
  return {
    kind: "generation",
    workflowExecutionId: `semantic-workflow-execution-${executionKeyDigest}`,
    workflowExecutionKeyDigest: executionKeyDigest,
    workflowExecutionDigest: digest("persistence-workflow-execution"),
    derivationRefs: [
      {
        id: `insight-${derivationDigest}`,
        derivationDigest,
        scopeDigest: reserved.scopeDigest,
      },
    ],
  };
}

function terminalRecords(
  reserved: SemanticTurnReservation,
  authorized: SemanticDisclosureAuthorization | null,
  dispatch: SemanticDispatchMarker,
  boundResult: SemanticResultBinding,
): { readonly turn: SemanticTurnReceipt; readonly scopeIndex: SemanticTurnScopeIndex } {
  const turn = buildSemanticTurnReceipt({
    turnKeyDigest: reserved.turnKeyDigest,
    reservation: { id: reserved.id, reservationDigest: reserved.reservationDigest },
    authorization:
      authorized === null ? null : { id: authorized.id, authorizationDigest: authorized.authorizationDigest },
    dispatch: { id: dispatch.id, dispatchDigest: dispatch.dispatchDigest },
    result: { id: boundResult.id, bindingDigest: boundResult.bindingDigest },
    lane: reserved.definition.lane,
    scopeDigest: reserved.scopeDigest,
    status: boundResult.status,
    output:
      boundResult.status === "completed"
        ? output(reserved)
        : { kind: "none", reasonCode: `workflow.${boundResult.status}` },
  });
  return {
    turn,
    scopeIndex: buildSemanticTurnScopeIndex({
      scopeDigest: turn.scopeDigest,
      turnId: turn.id,
      turnKeyDigest: turn.turnKeyDigest,
      turnDigest: turn.turnDigest,
    }),
  };
}

async function commit(
  engine: EngineContext,
  lane: Lane = "generation",
  transport: Transport = "outbound",
): Promise<CommittedFixture> {
  const reserved = reservation(lane, transport);
  await persistSemanticTurnReservation(engine, reserved);
  const authorized = transport === "outbound" ? authorization(reserved) : null;
  if (authorized !== null) await persistSemanticDisclosureAuthorization(engine, reserved, authorized);
  const dispatchClaim = await claimSemanticDispatch(engine, { reservation: reserved, authorization: authorized });
  const boundResult = result(reserved, dispatchClaim.dispatch, "provider_refused");
  await persistSemanticResultBinding(engine, {
    reservation: reserved,
    authorization: authorized,
    dispatch: dispatchClaim.dispatch,
    result: boundResult,
  });
  const terminal = terminalRecords(reserved, authorized, dispatchClaim.dispatch, boundResult);
  await persistSemanticTurnTerminal(engine, {
    reservation: reserved,
    authorization: authorized,
    dispatch: dispatchClaim.dispatch,
    result: boundResult,
    scopeIndex: terminal.scopeIndex,
    turn: terminal.turn,
  });
  return {
    reservation: reserved,
    authorization: authorized,
    dispatch: dispatchClaim.dispatch,
    result: boundResult,
    scopeIndex: terminal.scopeIndex,
    turn: terminal.turn,
    dispatchClaimStatus: dispatchClaim.status,
  };
}

function recordingStore(base: LearningStore, trace: StoreTrace): LearningStore {
  return {
    get: (key) => {
      trace.gets.push(key);
      return base.get(key);
    },
    create: (key, value, recordDigest, operationId) => {
      trace.writes.push(key.kind);
      return base.create(key, value, recordDigest, operationId);
    },
    compareAndSet: (key, expectedRevision, value, recordDigest, operationId) =>
      base.compareAndSet(key, expectedRevision, value, recordDigest, operationId),
    append: (stream, expectedRevision, entries, operationId) =>
      base.append(stream, expectedRevision, entries, operationId),
    tombstone: (input) => base.tombstone(input),
    list: (query) => base.list(query),
  };
}

function failBeforeCreate(base: LearningStore, targetKind: string): LearningStore {
  let failed = false;
  return {
    get: (key) => base.get(key),
    create: (key, value, recordDigest, operationId) => {
      if (!failed && key.kind === targetKind) {
        failed = true;
        throw new Error(`failed before ${targetKind}`);
      }
      return base.create(key, value, recordDigest, operationId);
    },
    compareAndSet: (key, expectedRevision, value, recordDigest, operationId) =>
      base.compareAndSet(key, expectedRevision, value, recordDigest, operationId),
    append: (stream, expectedRevision, entries, operationId) =>
      base.append(stream, expectedRevision, entries, operationId),
    tombstone: (input) => base.tombstone(input),
    list: (query) => base.list(query),
  };
}

function loseCreateAcknowledgement(base: LearningStore, targetKind: string): LearningStore {
  let failed = false;
  return {
    get: (key) => base.get(key),
    create: async (key, value, recordDigest, operationId) => {
      const created = await base.create(key, value, recordDigest, operationId);
      if (!failed && key.kind === targetKind) {
        failed = true;
        throw new Error(`lost ${targetKind} acknowledgement`);
      }
      return created;
    },
    compareAndSet: (key, expectedRevision, value, recordDigest, operationId) =>
      base.compareAndSet(key, expectedRevision, value, recordDigest, operationId),
    append: (stream, expectedRevision, entries, operationId) =>
      base.append(stream, expectedRevision, entries, operationId),
    tombstone: (input) => base.tombstone(input),
    list: (query) => base.list(query),
  };
}

function fakeCreateSuccess(base: LearningStore, targetKind: string): LearningStore {
  let faked = false;
  return {
    get: (key) => base.get(key),
    create: (key, value, recordDigest, operationId) => {
      if (!faked && key.kind === targetKind) {
        faked = true;
        return Promise.resolve({ status: "created" as const, revision: "fake-success" });
      }
      return base.create(key, value, recordDigest, operationId);
    },
    compareAndSet: (key, expectedRevision, value, recordDigest, operationId) =>
      base.compareAndSet(key, expectedRevision, value, recordDigest, operationId),
    append: (stream, expectedRevision, entries, operationId) =>
      base.append(stream, expectedRevision, entries, operationId),
    tombstone: (input) => base.tombstone(input),
    list: (query) => base.list(query),
  };
}

function preserveUnknownField(base: LearningStore, targetKind: string): LearningStore {
  let changed = false;
  return {
    get: (key) => base.get(key),
    create: (key, value, recordDigest, operationId) => {
      if (!changed && key.kind === targetKind) {
        changed = true;
        if (typeof value !== "object" || value === null || Array.isArray(value)) {
          throw new Error("unknown-field persistence fixture requires an object record");
        }
        const mutated: JsonValue = toJsonValue({ ...value, unexpectedDurableField: "PRIVATE-DURABLE-CANARY" });
        return base.create(key, mutated, sha256HexOfCanonicalJson(mutated), operationId);
      }
      return base.create(key, value, recordDigest, operationId);
    },
    compareAndSet: (key, expectedRevision, value, recordDigest, operationId) =>
      base.compareAndSet(key, expectedRevision, value, recordDigest, operationId),
    append: (stream, expectedRevision, entries, operationId) =>
      base.append(stream, expectedRevision, entries, operationId),
    tombstone: (input) => base.tombstone(input),
    list: (query) => base.list(query),
  };
}

function scopeNamespace(scopeDigest: string): string {
  return `learning-semantic-workflow-scope-${scopeDigest}`;
}

async function recordsOf(store: LearningStore, namespace: string, kind: string) {
  return (await store.list({ namespace, kind, limit: 100 })).records;
}

describe("semantic workflow receipt-last persistence", () => {
  it("writes the exact outbound and local receipt-last order and reloads the committed graph", async () => {
    const outboundBase = createInMemoryStore();
    const outboundTrace: StoreTrace = { writes: [], gets: [] };
    const outbound = await commit(context(recordingStore(outboundBase, outboundTrace)));
    expect(outboundTrace.writes).toEqual([
      GLOBAL_KINDS.reservation,
      GLOBAL_KINDS.authorization,
      GLOBAL_KINDS.dispatch,
      GLOBAL_KINDS.result,
      SEMANTIC_TURN_SCOPE_INDEX_KIND,
      SCOPED_TURN_KIND,
    ]);
    await expect(loadSemanticTurnByScope(context(outboundBase), outbound.turn.id, SCOPE_DIGEST)).resolves.toEqual({
      reservation: outbound.reservation,
      authorization: outbound.authorization,
      dispatch: outbound.dispatch,
      result: outbound.result,
      scopeIndex: outbound.scopeIndex,
      turn: outbound.turn,
    });

    const localBase = createInMemoryStore();
    const localTrace: StoreTrace = { writes: [], gets: [] };
    await commit(
      context(recordingStore(localBase, localTrace), "2026-08-20T00:00:20.000Z", "local"),
      "generation",
      "local",
    );
    expect(localTrace.writes).toEqual([
      GLOBAL_KINDS.reservation,
      GLOBAL_KINDS.dispatch,
      GLOBAL_KINDS.result,
      SEMANTIC_TURN_SCOPE_INDEX_KIND,
      SCOPED_TURN_KIND,
    ]);
  });

  it("classifies every crash boundary and exposes no redispatch helper", async () => {
    const store = createInMemoryStore();
    const engine = context(store);
    const reserved = reservation();
    await persistSemanticTurnReservation(engine, reserved);
    await expect(classifySemanticTurnPersistence(engine, reserved)).resolves.toMatchObject({
      status: "not_dispatched",
    });
    const authorized = authorization(reserved);
    await persistSemanticDisclosureAuthorization(engine, reserved, authorized);
    const dispatchClaim = await claimSemanticDispatch(engine, { reservation: reserved, authorization: authorized });
    await expect(classifySemanticTurnPersistence(engine, reserved)).resolves.toMatchObject({
      status: "outcome_unknown",
      dispatch: dispatchClaim.dispatch,
    });
    expect(Object.keys(workflowPersistence).some((name) => name.toLowerCase().includes("redispatch"))).toBe(false);
    const boundResult = result(reserved, dispatchClaim.dispatch, "provider_refused");
    await persistSemanticResultBinding(engine, {
      reservation: reserved,
      authorization: authorized,
      dispatch: dispatchClaim.dispatch,
      result: boundResult,
    });
    await expect(classifySemanticTurnPersistence(engine, reserved)).resolves.toMatchObject({
      status: "result_recorded",
      result: boundResult,
    });
    const terminal = terminalRecords(reserved, authorized, dispatchClaim.dispatch, boundResult);
    await persistSemanticTurnTerminal(engine, {
      reservation: reserved,
      authorization: authorized,
      dispatch: dispatchClaim.dispatch,
      result: boundResult,
      scopeIndex: terminal.scopeIndex,
      turn: terminal.turn,
    });
    await expect(classifySemanticTurnPersistence(engine, reserved)).resolves.toMatchObject({ status: "committed" });
  });

  it("refuses a completed result before persistence until typed minimization and output sidecars exist", async () => {
    const store = createInMemoryStore();
    const engine = context(store);
    const reserved = reservation();
    await persistSemanticTurnReservation(engine, reserved);
    const authorized = authorization(reserved);
    await persistSemanticDisclosureAuthorization(engine, reserved, authorized);
    const dispatchClaim = await claimSemanticDispatch(engine, { reservation: reserved, authorization: authorized });
    const completed = result(reserved, dispatchClaim.dispatch, "completed");
    await expect(
      persistSemanticResultBinding(engine, {
        reservation: reserved,
        authorization: authorized,
        dispatch: dispatchClaim.dispatch,
        result: completed,
      }),
    ).rejects.toMatchObject({ code: "semantic.workflow_output_unavailable" });
    await expect(classifySemanticTurnPersistence(engine, reserved)).resolves.toMatchObject({
      status: "outcome_unknown",
    });
    expect(await recordsOf(store, "learning", GLOBAL_KINDS.result)).toEqual([]);
    expect(await recordsOf(store, scopeNamespace(SCOPE_DIGEST), SEMANTIC_TURN_SCOPE_INDEX_KIND)).toEqual([]);
    expect(await recordsOf(store, scopeNamespace(SCOPE_DIGEST), SCOPED_TURN_KIND)).toEqual([]);
  });

  it("readers reject a manually seeded completed result and terminal graph that bypassed the writer guard", async () => {
    const store = createInMemoryStore();
    const engine = context(store);
    const reserved = reservation();
    await persistSemanticTurnReservation(engine, reserved);
    const authorized = authorization(reserved);
    await persistSemanticDisclosureAuthorization(engine, reserved, authorized);
    const dispatchClaim = await claimSemanticDispatch(engine, { reservation: reserved, authorization: authorized });
    const completed = result(reserved, dispatchClaim.dispatch, "completed");
    const terminal = terminalRecords(reserved, authorized, dispatchClaim.dispatch, completed);
    for (const seeded of [
      {
        namespace: "learning",
        kind: GLOBAL_KINDS.result,
        id: completed.id,
        value: toJsonValue(completed),
      },
      {
        namespace: scopeNamespace(SCOPE_DIGEST),
        kind: SEMANTIC_TURN_SCOPE_INDEX_KIND,
        id: terminal.scopeIndex.turnId,
        value: toJsonValue(terminal.scopeIndex),
      },
      {
        namespace: scopeNamespace(SCOPE_DIGEST),
        kind: SCOPED_TURN_KIND,
        id: terminal.turn.id,
        value: toJsonValue(terminal.turn),
      },
    ]) {
      await store.create(
        { namespace: seeded.namespace, kind: seeded.kind, id: seeded.id },
        seeded.value,
        sha256HexOfCanonicalJson(seeded.value),
        `seed-completed-${seeded.kind}`,
      );
    }
    await expect(loadSemanticTurnByScope(engine, terminal.turn.id, SCOPE_DIGEST)).rejects.toMatchObject({
      code: "semantic.workflow_output_unavailable",
    });
    await expect(classifySemanticTurnPersistence(engine, reserved)).rejects.toMatchObject({
      code: "semantic.workflow_output_unavailable",
    });
  });

  it("retains over-budget response audit metadata only through an explicit result_limit terminal", async () => {
    const store = createInMemoryStore();
    const engine = context(store);
    const reserved = reservation();
    await persistSemanticTurnReservation(engine, reserved);
    const authorized = authorization(reserved);
    await persistSemanticDisclosureAuthorization(engine, reserved, authorized);
    const dispatchClaim = await claimSemanticDispatch(engine, { reservation: reserved, authorization: authorized });
    const limitedBase = result(reserved, dispatchClaim.dispatch, "result_limit");
    if (limitedBase.response === null) throw new Error("result-limit fixture requires response audit metadata");
    const limited = buildSemanticResultBinding({
      turnKeyDigest: limitedBase.turnKeyDigest,
      reservationDigest: limitedBase.reservationDigest,
      dispatchDigest: limitedBase.dispatchDigest,
      status: limitedBase.status,
      response: {
        ...limitedBase.response,
        responseByteLength: reserved.definition.budgetPolicy.maximumResponseBytes + 1,
      },
      usage: limitedBase.usage,
      normalizedResult: null,
      normalizedResultDigest: null,
      reasonCodes: limitedBase.reasonCodes,
    });
    await persistSemanticResultBinding(engine, {
      reservation: reserved,
      authorization: authorized,
      dispatch: dispatchClaim.dispatch,
      result: limited,
    });
    const terminal = terminalRecords(reserved, authorized, dispatchClaim.dispatch, limited);
    await persistSemanticTurnTerminal(engine, {
      reservation: reserved,
      authorization: authorized,
      dispatch: dispatchClaim.dispatch,
      result: limited,
      scopeIndex: terminal.scopeIndex,
      turn: terminal.turn,
    });
    await expect(classifySemanticTurnPersistence(engine, reserved)).resolves.toMatchObject({
      status: "committed",
      graph: {
        result: { status: "result_limit", response: { responseByteLength: 4_097 } },
        turn: { output: { kind: "none", reasonCode: "workflow.result_limit" } },
      },
    });
  });

  it("derives one exact provider operation key and concurrent dispatch claims choose one marker", async () => {
    const store = createInMemoryStore();
    const engine = context(store);
    const reserved = reservation();
    await persistSemanticTurnReservation(engine, reserved);
    const authorized = authorization(reserved);
    await persistSemanticDisclosureAuthorization(engine, reserved, authorized);
    const claims = await Promise.all([
      claimSemanticDispatch(engine, { reservation: reserved, authorization: authorized }),
      claimSemanticDispatch(engine, { reservation: reserved, authorization: authorized }),
    ]);
    expect(claims.map((claim) => claim.status).sort()).toEqual(["created", "existing"]);
    expect(claims[0]?.dispatch).toEqual(claims[1]?.dispatch);
    const operationDigest = semanticProviderOperationKeyDigest(reserved);
    expect(claims[0]?.dispatch.providerOperationId).toBe(`semantic-workflow-provider-operation-${operationDigest}`);
    expect(claims[0]?.dispatch.idempotencyKey).toBe(`semantic-workflow-idempotency-${operationDigest}`);
  });

  it("refuses local authorization, missing outbound authorization, expired reservation, and stale authorization", async () => {
    const localStore = createInMemoryStore();
    const localEngine = context(localStore, "2026-08-20T00:00:20.000Z", "local");
    const local = reservation("generation", "local");
    await persistSemanticTurnReservation(localEngine, local);
    const foreignAuthorization = authorization(reservation());
    await expect(
      persistSemanticDisclosureAuthorization(localEngine, local, foreignAuthorization),
    ).rejects.toMatchObject({
      code: "schema.invalid",
    });

    const outboundStore = createInMemoryStore();
    const outbound = reservation();
    await persistSemanticTurnReservation(context(outboundStore), outbound);
    await expect(
      claimSemanticDispatch(context(outboundStore), { reservation: outbound, authorization: null }),
    ).rejects.toMatchObject({ code: "semantic.workflow_incomplete" });

    const authorized = authorization(outbound);
    await persistSemanticDisclosureAuthorization(context(outboundStore), outbound, authorized);
    await expect(
      claimSemanticDispatch(context(outboundStore, "2026-08-20T00:01:00.000Z"), {
        reservation: outbound,
        authorization: authorized,
      }),
    ).rejects.toMatchObject({ code: "schema.corrupt" });
    await expect(
      claimSemanticDispatch(context(outboundStore, "2026-08-20T00:05:00.000Z"), {
        reservation: outbound,
        authorization: authorized,
      }),
    ).rejects.toMatchObject({ code: "schema.corrupt" });
  });

  it("keeps advisory-review dispatch unavailable until the calibrated 13c integration exists", async () => {
    const store = createInMemoryStore();
    const engine = context(store, "2026-08-20T00:00:20.000Z", "outbound", "advisory_review");
    const reserved = reservation("advisory_review", "outbound");
    await persistSemanticTurnReservation(engine, reserved);
    const authorized = authorization(reserved);
    await persistSemanticDisclosureAuthorization(engine, reserved, authorized);
    await expect(
      claimSemanticDispatch(engine, { reservation: reserved, authorization: authorized }),
    ).rejects.toMatchObject({ code: "semantic.workflow_lane_unavailable" });
    expect(await recordsOf(store, "learning", GLOBAL_KINDS.dispatch)).toEqual([]);
  });

  it("refuses every stale workflow-definition, privacy, source, and registry binding before dispatch", async () => {
    const store = createInMemoryStore();
    const baseline = context(store);
    const reserved = reservation();
    if (reserved.target.kind !== "generation") throw new Error("current-binding fixture requires generation target");
    await persistSemanticTurnReservation(baseline, reserved);
    const authorized = authorization(reserved);
    await persistSemanticDisclosureAuthorization(baseline, reserved, authorized);
    const detectorKey = detectorRefKey(reserved.target.detector);
    const lensKey = lensRefKey(reserved.target.lens);
    const detector = baseline.semanticDetectorsByRef?.get(detectorKey);
    const lens = baseline.semanticLensesByRef?.get(lensKey);
    if (detector === undefined || lens === undefined)
      throw new Error("current-binding fixture omitted semantic records");
    const historicalRegistry = semanticFixture("local", definition("generation", "local")).registry;
    const cases: readonly { readonly name: string; readonly engine: EngineContext; readonly code: string }[] = [
      {
        name: "loop registry",
        engine: { ...baseline, registryRevision: digest("stale-loop-registry") },
        code: "semantic.workflow_historical",
      },
      {
        name: "semantic registry",
        engine: { ...baseline, semanticRegistry: historicalRegistry },
        code: "semantic.workflow_historical",
      },
      {
        name: "source registration",
        engine: { ...baseline, sources: new Set() },
        code: "semantic.workflow_historical",
      },
      {
        name: "content policy",
        engine: { ...baseline, contentPoliciesById: new Map() },
        code: "semantic.workflow_historical",
      },
      {
        name: "definition digest",
        engine: {
          ...baseline,
          semanticDetectorsByRef: new Map([
            [
              detectorKey,
              {
                ...detector,
                configuration: { ...detector.configuration, workflowDefinitionDigest: digest("foreign-definition") },
              },
            ],
          ]),
        },
        code: "semantic.workflow_definition_mismatch",
      },
      {
        name: "implementation digest",
        engine: {
          ...baseline,
          semanticDetectorsByRef: new Map([
            [detectorKey, { ...detector, implementationDigest: digest("foreign-implementation") }],
          ]),
        },
        code: "semantic.workflow_definition_mismatch",
      },
      {
        name: "lens fingerprints",
        engine: {
          ...baseline,
          semanticLensesByRef: new Map([[lensKey, { ...lens, requiredFingerprintKinds: ["unknown"] }]]),
        },
        code: "semantic.workflow_definition_mismatch",
      },
      {
        name: "privacy",
        engine: {
          ...baseline,
          semanticDetectorsByRef: new Map([
            [detectorKey, { ...detector, privacy: { ...detector.privacy, transientContent: "memory_only" } }],
          ]),
        },
        code: "semantic.workflow_disclosure_forbidden",
      },
    ];
    for (const fixture of cases) {
      await expect(
        claimSemanticDispatch(fixture.engine, { reservation: reserved, authorization: authorized }),
        fixture.name,
      ).rejects.toMatchObject({ code: fixture.code });
      expect(await recordsOf(store, "learning", GLOBAL_KINDS.dispatch), fixture.name).toEqual([]);
    }
  });

  it("refuses a reservation that swaps to another current policy not owned by its exact registered source", async () => {
    const store = createInMemoryStore();
    const baseline = context(store);
    const original = reservation();
    const alternatePolicy: ContentPolicy = {
      id: "persistence-content-policy-b",
      digest: digest("persistence-content-policy-b"),
      maximumInputBytes: 4_096,
      outboundUse: "explicit_receipt_required",
      transform: (input) =>
        Promise.resolve({ accepted: toJsonValue(input), classification: "alternate-policy", diagnostics: [] }),
    };
    const originalPolicy = baseline.contentPoliciesById.get(CONTENT_POLICY_ID);
    if (originalPolicy === undefined) throw new Error("source-policy swap fixture omitted its original policy");
    const swapped = buildSemanticTurnReservation({
      runId: original.runId,
      loopRegistryRevision: original.loopRegistryRevision,
      semanticRegistryDigest: original.semanticRegistryDigest,
      scopeDigest: original.scopeDigest,
      target: original.target,
      definition: original.definition,
      request: original.request,
      sourcePolicies: original.sourcePolicies.map((policy) => ({
        ...policy,
        contentPolicyId: alternatePolicy.id,
        contentPolicyDigest: alternatePolicy.digest,
      })),
      disclosureExpected: original.disclosureExpected,
      expiresAt: original.expiresAt,
    });
    const engine = {
      ...baseline,
      contentPoliciesById: new Map([
        [originalPolicy.id, originalPolicy],
        [alternatePolicy.id, alternatePolicy],
      ]),
    };
    await persistSemanticTurnReservation(engine, swapped);
    const authorized = authorization(swapped);
    await persistSemanticDisclosureAuthorization(engine, swapped, authorized);
    await expect(
      claimSemanticDispatch(engine, { reservation: swapped, authorization: authorized }),
    ).rejects.toMatchObject({ code: "semantic.workflow_historical" });
    expect(await recordsOf(store, "learning", GLOBAL_KINDS.dispatch)).toEqual([]);
  });

  for (const failureMode of ["before", "lost_ack", "fake_success"] as const) {
    it(`${failureMode} at every write step fails closed and exact retry converges`, async () => {
      for (const targetKind of [
        GLOBAL_KINDS.reservation,
        GLOBAL_KINDS.authorization,
        GLOBAL_KINDS.dispatch,
        GLOBAL_KINDS.result,
        SEMANTIC_TURN_SCOPE_INDEX_KIND,
        SCOPED_TURN_KIND,
      ]) {
        const base = createInMemoryStore();
        const faulted =
          failureMode === "before"
            ? failBeforeCreate(base, targetKind)
            : failureMode === "lost_ack"
              ? loseCreateAcknowledgement(base, targetKind)
              : fakeCreateSuccess(base, targetKind);
        await expect(commit(context(faulted)), targetKind).rejects.toBeDefined();
        if (failureMode === "lost_ack" && targetKind === GLOBAL_KINDS.dispatch) {
          await expect(classifySemanticTurnPersistence(context(base), reservation())).resolves.toMatchObject({
            status: "outcome_unknown",
          });
          continue;
        }
        const recovered = await commit(context(base));
        await expect(loadSemanticTurnByScope(context(base), recovered.turn.id, SCOPE_DIGEST)).resolves.toMatchObject({
          turn: recovered.turn,
        });
      }
    });
  }

  it("rejects stores that preserve requested records with additional durable fields", async () => {
    const reservationStore = createInMemoryStore();
    await expect(
      persistSemanticTurnReservation(
        context(preserveUnknownField(reservationStore, GLOBAL_KINDS.reservation)),
        reservation(),
      ),
    ).rejects.toMatchObject({ code: "store.corrupt" });

    const dispatchStore = createInMemoryStore();
    const dispatchReservation = reservation();
    await persistSemanticTurnReservation(context(dispatchStore), dispatchReservation);
    const dispatchAuthorization = authorization(dispatchReservation);
    await persistSemanticDisclosureAuthorization(context(dispatchStore), dispatchReservation, dispatchAuthorization);
    await expect(
      claimSemanticDispatch(context(preserveUnknownField(dispatchStore, GLOBAL_KINDS.dispatch)), {
        reservation: dispatchReservation,
        authorization: dispatchAuthorization,
      }),
    ).rejects.toMatchObject({ code: "store.corrupt" });

    const indexStore = createInMemoryStore();
    const indexEngine = context(indexStore);
    const indexReservation = reservation();
    await persistSemanticTurnReservation(indexEngine, indexReservation);
    const indexAuthorization = authorization(indexReservation);
    await persistSemanticDisclosureAuthorization(indexEngine, indexReservation, indexAuthorization);
    const dispatchClaim = await claimSemanticDispatch(indexEngine, {
      reservation: indexReservation,
      authorization: indexAuthorization,
    });
    const boundResult = result(indexReservation, dispatchClaim.dispatch, "provider_refused");
    await persistSemanticResultBinding(indexEngine, {
      reservation: indexReservation,
      authorization: indexAuthorization,
      dispatch: dispatchClaim.dispatch,
      result: boundResult,
    });
    const terminal = terminalRecords(indexReservation, indexAuthorization, dispatchClaim.dispatch, boundResult);
    await expect(
      persistSemanticTurnTerminal(context(preserveUnknownField(indexStore, SEMANTIC_TURN_SCOPE_INDEX_KIND)), {
        reservation: indexReservation,
        authorization: indexAuthorization,
        dispatch: dispatchClaim.dispatch,
        result: boundResult,
        scopeIndex: terminal.scopeIndex,
        turn: terminal.turn,
      }),
    ).rejects.toMatchObject({ code: "store.corrupt" });
    expect(await recordsOf(indexStore, scopeNamespace(SCOPE_DIGEST), SCOPED_TURN_KIND)).toEqual([]);
  });

  it("concurrent and repeated complete graphs converge without duplicate durable facts", async () => {
    const store = createInMemoryStore();
    const [left, right] = await Promise.all([commit(context(store)), commit(context(store))]);
    expect(left.turn).toEqual(right.turn);
    const retried = await commit(context(store));
    expect(retried.dispatchClaimStatus).toBe("existing");
    expect(retried.turn).toEqual(left.turn);
    for (const kind of Object.values(GLOBAL_KINDS)) {
      expect(await recordsOf(store, "learning", kind), kind).toHaveLength(1);
    }
    expect(await recordsOf(store, scopeNamespace(SCOPE_DIGEST), SEMANTIC_TURN_SCOPE_INDEX_KIND)).toHaveLength(1);
    expect(await recordsOf(store, scopeNamespace(SCOPE_DIGEST), SCOPED_TURN_KIND)).toHaveLength(1);
  });

  it("same key with different reservation, result, or terminal bytes conflicts without overwrite", async () => {
    const store = createInMemoryStore();
    const engine = context(store);
    const committed = await commit(engine);
    const changedReservation = buildSemanticTurnReservation({
      runId: committed.reservation.runId,
      loopRegistryRevision: committed.reservation.loopRegistryRevision,
      semanticRegistryDigest: committed.reservation.semanticRegistryDigest,
      scopeDigest: committed.reservation.scopeDigest,
      target: committed.reservation.target,
      definition: committed.reservation.definition,
      request: committed.reservation.request,
      sourcePolicies: committed.reservation.sourcePolicies,
      disclosureExpected: committed.reservation.disclosureExpected,
      expiresAt: "2026-08-20T00:06:00.000Z",
    });
    expect(changedReservation.turnKeyDigest).toBe(committed.reservation.turnKeyDigest);
    await expect(persistSemanticTurnReservation(engine, changedReservation)).rejects.toMatchObject({
      code: "store.conflict",
    });

    const conflictingResult = buildSemanticResultBinding({
      turnKeyDigest: committed.reservation.turnKeyDigest,
      reservationDigest: committed.reservation.reservationDigest,
      dispatchDigest: committed.dispatch.dispatchDigest,
      status: "provider_failed",
      response: null,
      usage: { status: "unreported", reasonCode: "usage.not_reported" },
      normalizedResult: null,
      normalizedResultDigest: null,
      reasonCodes: ["workflow.provider_failed"],
    });
    await expect(
      persistSemanticResultBinding(engine, {
        reservation: committed.reservation,
        authorization: committed.authorization,
        dispatch: committed.dispatch,
        result: conflictingResult,
      }),
    ).rejects.toMatchObject({ code: "store.conflict" });
    await expect(loadSemanticTurnByScope(engine, committed.turn.id, SCOPE_DIGEST)).resolves.toMatchObject({
      result: committed.result,
      turn: committed.turn,
    });
  });

  it("revalidates noncompleted response request attestations and keyed privacy policy", async () => {
    const variants = [
      (reserved: SemanticTurnReservation, dispatch: SemanticDispatchMarker) =>
        withResponseMutation(reserved, dispatch, { requestAttestationDigest: digest("foreign-request") }),
      (reserved: SemanticTurnReservation, dispatch: SemanticDispatchMarker) =>
        withResponseMutation(reserved, dispatch, { keyPolicyDigest: digest("foreign-key-policy") }),
    ];
    for (const [index, mutate] of variants.entries()) {
      const store = createInMemoryStore();
      const engine = context(store);
      const reserved = reservation();
      await persistSemanticTurnReservation(engine, reserved);
      const authorized = authorization(reserved);
      await persistSemanticDisclosureAuthorization(engine, reserved, authorized);
      const claimed = await claimSemanticDispatch(engine, { reservation: reserved, authorization: authorized });
      const raw = mutate(reserved, claimed.dispatch);
      const { schemaVersion: _schemaVersion, id: _id, bindingDigest: _bindingDigest, ...base } = raw;
      const changed = buildSemanticResultBinding(base);
      await expect(
        persistSemanticResultBinding(engine, {
          reservation: reserved,
          authorization: authorized,
          dispatch: claimed.dispatch,
          result: changed,
        }),
        String(index),
      ).rejects.toMatchObject({ code: "schema.corrupt" });
      expect(await recordsOf(store, "learning", GLOBAL_KINDS.result)).toEqual([]);
    }
  });

  it("wrong-scope reads never touch a global target and orphan scope indexes remain invisible", async () => {
    const base = createInMemoryStore();
    const committed = await commit(context(base));
    const trace: StoreTrace = { writes: [], gets: [] };
    await expect(
      loadSemanticTurnByScope(context(recordingStore(base, trace)), committed.turn.id, FOREIGN_SCOPE_DIGEST),
    ).resolves.toBeUndefined();
    expect(
      trace.gets.some((key) => key.namespace === scopeNamespace(FOREIGN_SCOPE_DIGEST) && key.kind === SCOPED_TURN_KIND),
    ).toBe(false);

    const orphanStore = createInMemoryStore();
    const indexValue = toJsonValue(committed.scopeIndex);
    await orphanStore.create(
      {
        namespace: scopeNamespace(committed.scopeIndex.scopeDigest),
        kind: SEMANTIC_TURN_SCOPE_INDEX_KIND,
        id: committed.scopeIndex.turnId,
      },
      indexValue,
      sha256HexOfCanonicalJson(indexValue),
      "seed-orphan-workflow-index",
    );
    await expect(
      loadSemanticTurnByScope(context(orphanStore), committed.turn.id, committed.scopeIndex.scopeDigest),
    ).resolves.toBeUndefined();
  });

  it("scope revision observes the index-before-turn interval and the terminal scoped receipt without foreign churn", async () => {
    const store = createInMemoryStore();
    const engine = context(store);
    const reserved = reservation();
    await persistSemanticTurnReservation(engine, reserved);
    const authorized = authorization(reserved);
    await persistSemanticDisclosureAuthorization(engine, reserved, authorized);
    const dispatchClaim = await claimSemanticDispatch(engine, { reservation: reserved, authorization: authorized });
    const boundResult = result(reserved, dispatchClaim.dispatch, "provider_refused");
    await persistSemanticResultBinding(engine, {
      reservation: reserved,
      authorization: authorized,
      dispatch: dispatchClaim.dispatch,
      result: boundResult,
    });
    const terminal = terminalRecords(reserved, authorized, dispatchClaim.dispatch, boundResult);
    const before = await semanticWorkflowSnapshotRevision(engine, SCOPE_DIGEST);
    const foreignBefore = await semanticWorkflowSnapshotRevision(engine, FOREIGN_SCOPE_DIGEST);
    let releaseTurn: (() => void) | undefined;
    let markTurnReached: (() => void) | undefined;
    const turnGate = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    const turnReached = new Promise<void>((resolve) => {
      markTurnReached = resolve;
    });
    const pausedStore: LearningStore = {
      get: (key) => store.get(key),
      create: async (key, value, recordDigest, operationId) => {
        if (key.namespace === scopeNamespace(SCOPE_DIGEST) && key.kind === SCOPED_TURN_KIND) {
          markTurnReached?.();
          await turnGate;
        }
        return store.create(key, value, recordDigest, operationId);
      },
      compareAndSet: (key, expectedRevision, value, recordDigest, operationId) =>
        store.compareAndSet(key, expectedRevision, value, recordDigest, operationId),
      append: (stream, expectedRevision, entries, operationId) =>
        store.append(stream, expectedRevision, entries, operationId),
      tombstone: (input) => store.tombstone(input),
      list: (query) => store.list(query),
    };
    const pending = persistSemanticTurnTerminal(context(pausedStore), {
      reservation: reserved,
      authorization: authorized,
      dispatch: dispatchClaim.dispatch,
      result: boundResult,
      scopeIndex: terminal.scopeIndex,
      turn: terminal.turn,
    });
    await turnReached;
    const between = await semanticWorkflowSnapshotRevision(engine, SCOPE_DIGEST);
    expect(between).not.toBe(before);
    await expect(loadSemanticTurnByScope(engine, terminal.turn.id, SCOPE_DIGEST)).resolves.toBeUndefined();
    expect(await semanticWorkflowSnapshotRevision(engine, FOREIGN_SCOPE_DIGEST)).toBe(foreignBefore);
    if (releaseTurn === undefined) throw new Error("scoped turn pause was not installed");
    releaseTurn();
    await pending;
    const after = await semanticWorkflowSnapshotRevision(engine, SCOPE_DIGEST);
    expect(after).not.toBe(between);
    expect(await semanticWorkflowSnapshotRevision(engine, FOREIGN_SCOPE_DIGEST)).toBe(foreignBefore);
  });

  it("scope-index and terminal-target corruption fails closed while foreign scope activity stays isolated", async () => {
    const store = createInMemoryStore();
    const committed = await commit(context(store));
    const before = await semanticWorkflowSnapshotRevision(context(store), SCOPE_DIGEST);
    const foreignIndex = buildSemanticTurnScopeIndex({
      scopeDigest: FOREIGN_SCOPE_DIGEST,
      turnId: committed.turn.id,
      turnKeyDigest: committed.turn.turnKeyDigest,
      turnDigest: committed.turn.turnDigest,
    });
    const foreignValue = toJsonValue(foreignIndex);
    await store.create(
      {
        namespace: scopeNamespace(FOREIGN_SCOPE_DIGEST),
        kind: SEMANTIC_TURN_SCOPE_INDEX_KIND,
        id: foreignIndex.turnId,
      },
      foreignValue,
      sha256HexOfCanonicalJson(foreignValue),
      "seed-foreign-workflow-index",
    );
    expect(await semanticWorkflowSnapshotRevision(context(store), SCOPE_DIGEST)).toBe(before);

    const corruptIndexStore: LearningStore = {
      get: async (key) => {
        const stored = await store.get(key);
        if (stored === undefined || key.kind !== SEMANTIC_TURN_SCOPE_INDEX_KIND) return stored;
        return { ...stored, digest: digest("corrupt-index-envelope") };
      },
      create: (key, value, recordDigest, operationId) => store.create(key, value, recordDigest, operationId),
      compareAndSet: (key, expectedRevision, value, recordDigest, operationId) =>
        store.compareAndSet(key, expectedRevision, value, recordDigest, operationId),
      append: (stream, expectedRevision, entries, operationId) =>
        store.append(stream, expectedRevision, entries, operationId),
      tombstone: (input) => store.tombstone(input),
      list: (query) => store.list(query),
    };
    await expect(
      loadSemanticTurnByScope(context(corruptIndexStore), committed.turn.id, SCOPE_DIGEST),
    ).rejects.toMatchObject({ code: "store.corrupt" });

    const corruptTargetStore: LearningStore = {
      get: async (key) => {
        const stored = await store.get(key);
        if (stored === undefined || key.namespace !== scopeNamespace(SCOPE_DIGEST) || key.kind !== SCOPED_TURN_KIND) {
          return stored;
        }
        const changed = toJsonValue({ ...committed.turn, scopeDigest: FOREIGN_SCOPE_DIGEST });
        return { ...stored, value: changed, digest: sha256HexOfCanonicalJson(changed) };
      },
      create: (key, value, recordDigest, operationId) => store.create(key, value, recordDigest, operationId),
      compareAndSet: (key, expectedRevision, value, recordDigest, operationId) =>
        store.compareAndSet(key, expectedRevision, value, recordDigest, operationId),
      append: (stream, expectedRevision, entries, operationId) =>
        store.append(stream, expectedRevision, entries, operationId),
      tombstone: (input) => store.tombstone(input),
      list: (query) => store.list(query),
    };
    await expect(
      loadSemanticTurnByScope(context(corruptTargetStore), committed.turn.id, SCOPE_DIGEST),
    ).rejects.toMatchObject({ code: expect.stringMatching(/^schema\.|^store\./) });
  });
});
