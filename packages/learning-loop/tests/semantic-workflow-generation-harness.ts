import { createHmac } from "node:crypto";
import type {
  ContentPolicy,
  Clock,
  DetectorPackManifest,
  DetectorRegistration,
  IdentityPort,
  LearningLensRegistration,
  LearningLoop,
  LearningStore,
  RecordKey,
  RegisteredSource,
  Scope,
  ScopePolicy,
  SemanticRegistryConfig,
  SourceSemanticProfile,
  VerifiedPrincipal,
} from "@cormidia/learning-loop";
import {
  conservativePolicy,
  canonicalJsonText,
  createLearningLoop,
  defineSourceRegistration,
  detectorPackManifestDigest,
  detectorRegistrationDigest,
  learningLensRegistrationDigest,
  parseDetectorPackManifest,
  parseDetectorRegistration,
  parseLearningLensRegistration,
  parseSemanticRegistryConfig,
  parseSourceSemanticProfile,
  semanticRegistryDigest,
  sha256HexOfCanonicalJson,
  sourceSemanticProfileDigest,
  toJsonValue,
} from "@cormidia/learning-loop";
import type { ManualEvidenceInput } from "@cormidia/learning-loop/testing";
import {
  createExactScopePolicy,
  createFixedClock,
  createInMemoryStore,
  createManualEvidenceSource,
  createSequentialIds,
  createTestIdentityPort,
} from "@cormidia/learning-loop/testing";
import type { SemanticWorkflowBundle } from "@cormidia/learning-loop/workflows";
import { createSemanticWorkflowBundle } from "@cormidia/learning-loop/workflows";

type SemanticWorkflowDefinition = ReturnType<typeof createSemanticWorkflowBundle.defineGeneration>;

export const WORKFLOW_SCOPE: Scope = [{ type: "project", id: "semantic-workflow-project" }];
export const WORKFLOW_CONTENT_POLICY_ID = "semantic-workflow-content-policy";
export const WORKFLOW_KEY_POLICY_DIGEST = digest("workflow-key-policy");
export const WORKFLOW_AUTHORIZATION_POLICY_DIGEST = digest("workflow-authorization-policy");
export const WORKFLOW_MINIMIZATION_POLICY_DIGEST = digest("workflow-minimization-policy");
const WORKFLOW_HMAC_KEY = "synthetic-workflow-hmac-key-for-hermetic-tests";
const OBSERVATION_KIND = "workflow.semantic.observation";
const CAPABILITY = "workflow.semantic.input";
const WORKFLOW_RESULT_SCHEMA_ID = createSemanticWorkflowBundle.generationResultSchema.id;
const WORKFLOW_RESULT_SCHEMA_VERSION = createSemanticWorkflowBundle.generationResultSchema.version;

type Transport = SemanticWorkflowDefinition["transport"];

export interface ProviderState {
  readonly calls: unknown[];
  script: (input: unknown) => Promise<unknown>;
}

export interface StoreMutationTrace {
  readonly writes: RecordKey[];
  readonly reads?: RecordKey[];
  readonly lists?: Array<Parameters<LearningStore["list"]>[0]>;
}

export function recordingStore(base: LearningStore, trace: StoreMutationTrace): LearningStore {
  return {
    get: (key) => {
      trace.reads?.push(key);
      return base.get(key);
    },
    create: (key, value, recordDigest, operationId) => {
      trace.writes.push(key);
      return base.create(key, value, recordDigest, operationId);
    },
    compareAndSet: (key, expectedRevision, value, recordDigest, operationId) => {
      trace.writes.push(key);
      return base.compareAndSet(key, expectedRevision, value, recordDigest, operationId);
    },
    append: (stream, expectedRevision, entries, operationId) => {
      trace.writes.push(stream);
      return base.append(stream, expectedRevision, entries, operationId);
    },
    tombstone: (input) => {
      trace.writes.push(input.key);
      return base.tombstone(input);
    },
    list: (query) => {
      trace.lists?.push(query);
      return base.list(query);
    },
  };
}

export function loseCreateAcknowledgement(base: LearningStore, targetKind: string): LearningStore {
  let failed = false;
  return {
    get: (key) => base.get(key),
    create: async (key, value, recordDigest, operationId) => {
      const result = await base.create(key, value, recordDigest, operationId);
      if (!failed && key.kind === targetKind) {
        failed = true;
        throw new Error(`lost ${targetKind} acknowledgement`);
      }
      return result;
    },
    compareAndSet: (key, expectedRevision, value, recordDigest, operationId) =>
      base.compareAndSet(key, expectedRevision, value, recordDigest, operationId),
    append: async (stream, expectedRevision, entries, operationId) => {
      const result = await base.append(stream, expectedRevision, entries, operationId);
      if (!failed && stream.kind === targetKind) {
        failed = true;
        throw new Error(`lost ${targetKind} acknowledgement`);
      }
      return result;
    },
    tombstone: (input) => base.tombstone(input),
    list: (query) => base.list(query),
  };
}

export function failBeforeCreate(base: LearningStore, targetKind: string): LearningStore {
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
    append: (stream, expectedRevision, entries, operationId) => {
      if (!failed && stream.kind === targetKind) {
        failed = true;
        throw new Error(`failed before ${targetKind}`);
      }
      return base.append(stream, expectedRevision, entries, operationId);
    },
    tombstone: (input) => base.tombstone(input),
    list: (query) => base.list(query),
  };
}

export function fakeCreateSuccess(base: LearningStore, targetKind: string): LearningStore {
  let faked = false;
  return {
    get: (key) => base.get(key),
    create: (key, value, recordDigest, operationId) => {
      if (!faked && key.kind === targetKind) {
        faked = true;
        const status: "created" = "created";
        return Promise.resolve({ status, revision: "fake-success" });
      }
      return base.create(key, value, recordDigest, operationId);
    },
    compareAndSet: (key, expectedRevision, value, recordDigest, operationId) =>
      base.compareAndSet(key, expectedRevision, value, recordDigest, operationId),
    append: (stream, expectedRevision, entries, operationId) => {
      if (!faked && stream.kind === targetKind) {
        faked = true;
        const status: "created" = "created";
        return Promise.resolve({ status, revision: "fake-success" });
      }
      return base.append(stream, expectedRevision, entries, operationId);
    },
    tombstone: (input) => base.tombstone(input),
    list: (query) => base.list(query),
  };
}

export interface AuthorityState {
  readonly calls: unknown[];
  script: (input: unknown) => Promise<unknown>;
}

export interface TokenEstimatorState {
  readonly calls: Uint8Array[];
  estimate: (bytes: Uint8Array) => unknown;
}

export interface RendererState {
  readonly calls: unknown[];
  render: (input: unknown) => unknown;
}

export interface GenerationFactoryInput {
  readonly schemaVersion: 1;
  readonly loop: LearningLoop;
  readonly definition: SemanticWorkflowDefinition;
  readonly producer: VerifiedPrincipal;
  readonly renderer: {
    readonly rendererDigest: string;
    readonly render: (input: unknown) => unknown;
  };
  readonly minimizer: {
    readonly minimizationPolicyDigest: string;
    readonly minimize: (input: unknown) => unknown;
  };
  readonly keyedDigester: {
    readonly keyPolicyDigest: string;
    readonly digest: (bytes: Uint8Array) => unknown;
  };
  readonly tokenEstimator: {
    readonly tokenEstimatorDigest: string;
    readonly estimateInputTokens: (bytes: Uint8Array) => unknown;
  };
  readonly provider: {
    readonly registrationDigest: string;
    readonly invoke: (input: unknown) => Promise<unknown>;
  };
  readonly disclosureAuthority?: {
    readonly authorizationPolicyDigest: string;
    readonly authorize: (input: unknown) => Promise<unknown>;
  };
}

export interface GenerationHarness {
  readonly store: LearningStore;
  readonly learning: LearningLoop;
  readonly identity: IdentityPort;
  readonly producer: VerifiedPrincipal;
  readonly authorizer: VerifiedPrincipal;
  readonly source: RegisteredSource<ManualEvidenceInput>;
  readonly contentPolicy: ContentPolicy;
  readonly scopePolicy: ScopePolicy;
  readonly clock: Clock;
  readonly definition: SemanticWorkflowDefinition;
  readonly detector: DetectorRegistration;
  readonly pack: DetectorPackManifest;
  readonly lens: LearningLensRegistration;
  readonly registry: SemanticRegistryConfig;
  readonly scope: Scope;
  readonly episodeRecordIds: readonly string[];
  readonly providerState: ProviderState;
  readonly authorityState: AuthorityState;
  readonly tokenEstimatorState: TokenEstimatorState;
  readonly rendererState: RendererState;
  readonly bundle: SemanticWorkflowBundle;
  readonly factoryInput: GenerationFactoryInput;
  readonly prepareInput: Parameters<SemanticWorkflowBundle["prepareGeneration"]>[0];
}

export interface GenerationHarnessOptions {
  readonly transport?: Transport;
  readonly store?: LearningStore;
  readonly maximumRequestBytes?: number;
  readonly maximumResponseBytes?: number;
  readonly maximumInputTokens?: number;
  readonly maximumOutputTokens?: number;
  readonly maximumDurationMs?: number;
  readonly queryCursorScope?: string;
  readonly episodeCount?: number;
  readonly observationsPerEpisode?: number;
  readonly clock?: Clock;
}

function digest(label: string): string {
  return sha256HexOfCanonicalJson(toJsonValue({ label }));
}

function valueDigest(value: unknown): string {
  return sha256HexOfCanonicalJson(toJsonValue(value));
}

export function workflowKeyedDigest(bytes: Uint8Array): string {
  return createHmac("sha256", WORKFLOW_HMAC_KEY).update(bytes).digest("hex");
}

export function canonicalWorkflowBytes(input: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalJsonText(toJsonValue(input)));
}

export function providerRequestBytes(input: unknown): Uint8Array {
  const request = field(input, "request");
  const bytes = field(request, "bytes");
  if (!(bytes instanceof Uint8Array)) throw new Error("provider request omitted its exact bytes");
  return bytes;
}

export function providerOperation(input: unknown): { readonly id: string; readonly idempotencyKey: string } {
  const operation = field(input, "operation");
  const id = field(operation, "id");
  const idempotencyKey = field(operation, "idempotencyKey");
  if (typeof id !== "string" || typeof idempotencyKey !== "string") {
    throw new Error("provider call omitted its exact operation identity");
  }
  return { id, idempotencyKey };
}

export function providerSignal(input: unknown): AbortSignal {
  const signal = field(input, "signal");
  if (!(signal instanceof AbortSignal)) throw new Error("provider call omitted its abort signal");
  return signal;
}

export function providerResultPayload(input: unknown): unknown {
  return field(input, "result");
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

function contentPolicy(transport: Transport): ContentPolicy {
  const outboundUse = transport === "outbound" ? "explicit_receipt_required" : "forbidden";
  return {
    id: WORKFLOW_CONTENT_POLICY_ID,
    digest: digest(`workflow-content-policy-${transport}`),
    maximumInputBytes: 1_048_576,
    outboundUse,
    transform: (input) =>
      Promise.resolve({ accepted: toJsonValue(input), classification: "workflow-hermetic", diagnostics: [] }),
  };
}

function workflowDefinition(input: {
  readonly transport: Transport;
  readonly producer: VerifiedPrincipal;
  readonly budgets: {
    readonly maximumRequestBytes: number;
    readonly maximumResponseBytes: number;
    readonly maximumInputTokens: number;
    readonly maximumOutputTokens: number;
    readonly maximumDurationMs: number;
  };
}): SemanticWorkflowDefinition {
  const schemaVersion: 1 = 1;
  return createSemanticWorkflowBundle.defineGeneration({
    schemaVersion,
    id: `hermetic-generation-${input.transport}`,
    version: "1.0.0",
    transport: input.transport,
    implementation: {
      id: "hermetic-semantic-workflow",
      version: "1.0.0",
      implementationDigest: digest("hermetic-semantic-workflow-implementation"),
    },
    providerModel: {
      provider: {
        id: "hermetic-provider",
        version: "1.0.0",
        providerFingerprintDigest: digest("hermetic-provider-fingerprint"),
        operationKeyPolicyDigest: digest("hermetic-operation-key-policy"),
      },
      model: { id: "hermetic-model", modelFingerprintDigest: digest("hermetic-model-fingerprint") },
    },
    prompt: { id: "hermetic-prompt", version: "1.0.0", promptDigest: digest("hermetic-prompt") },
    renderer: { id: "hermetic-renderer", version: "1.0.0", rendererDigest: digest("hermetic-renderer") },
    budgetPolicy: {
      maximumRequestBytes: input.budgets.maximumRequestBytes,
      maximumResponseBytes: input.budgets.maximumResponseBytes,
      maximumEpisodes: 500,
      maximumEvidenceRefs: 5_000,
      maximumInputTokens: input.budgets.maximumInputTokens,
      maximumOutputTokens: input.budgets.maximumOutputTokens,
      maximumDurationMs: input.budgets.maximumDurationMs,
      tokenEstimatorDigest: digest("hermetic-token-estimator"),
      maximumCost: { minorUnits: 100, currency: "USD" },
    },
    disclosurePolicy: {
      mode: input.transport === "outbound" ? "explicit_authorization" : "forbidden",
      minimizationPolicyDigest: WORKFLOW_MINIMIZATION_POLICY_DIGEST,
      keyPolicyDigest: WORKFLOW_KEY_POLICY_DIGEST,
      authorizationPolicyDigest: WORKFLOW_AUTHORIZATION_POLICY_DIGEST,
      maximumAuthorizationAgeMs: 60_000,
    },
    principal: input.producer.ref,
    attestation: { id: input.producer.attestationId, digest: input.producer.attestationDigest },
  });
}
function semanticRecords(input: {
  readonly transport: Transport;
  readonly definition: SemanticWorkflowDefinition;
  readonly source: RegisteredSource<ManualEvidenceInput>;
  readonly scopePolicyDigest: string;
}): {
  readonly detector: DetectorRegistration;
  readonly pack: DetectorPackManifest;
  readonly lens: LearningLensRegistration;
  readonly profile: SourceSemanticProfile;
  readonly registry: SemanticRegistryConfig;
} {
  const objective = "Generate one inert provider-neutral derivation from an exact episode population.";
  const rubric = { evidence: "exact", uncertainty: "explicit" };
  const validationStrategy = { status: "advisory" };
  const lensBase: Omit<LearningLensRegistration, "schemaVersion" | "registrationDigest"> = {
    id: "hermetic-generation-lens",
    version: "1.0.0",
    objective,
    objectiveDigest: valueDigest(objective),
    scopePolicyDigest: input.scopePolicyDigest,
    applicableScopes: { mode: "invocation" },
    episodeClasses: { mode: "include", values: ["interactive"] },
    learningClasses: ["system_meta"],
    evidenceRequirements: [{ kind: "episode", minimumTrust: "advisory", minimumCompleteness: "complete" }],
    qualitativeRubric: rubric,
    qualitativeRubricDigest: valueDigest(rubric),
    requiredFingerprintKinds: ["budget", "implementation", "model", "prompt", "tool"],
    requiredCalibrationIds: [],
    permittedDestinationIds: ["host/semantic-note"],
    permittedDestinationKinds: ["report-note"],
    generatorPolicy: {
      allowedKinds: ["semantic_judgment"],
      identityPolicyDigest: digest("hermetic-generator-identity-policy"),
      fingerprintPolicyDigest: digest("hermetic-generator-fingerprint-policy"),
    },
    reviewerPolicy: {
      independentFromGenerator: true,
      identityPolicyDigest: digest("hermetic-reviewer-identity-policy"),
      calibrationPolicyDigest: null,
    },
    privacy: {
      outboundDisclosure: "explicit_disclosure_receipt",
      policyDigest: digest("hermetic-lens-privacy"),
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
    workflowDefinitionDigest: input.definition.definitionDigest,
    algorithm: "provider-neutral-semantic-generation",
  };
  const falsePositivePolicy = { reviewRequired: true };
  const validationCriterion = { claim: "no-default-quality" };
  const detectorBase: Omit<DetectorRegistration, "schemaVersion" | "registrationDigest"> = {
    id: "hermetic-generation-detector",
    version: "1.0.0",
    maturity: "experimental",
    implementationDigest: input.definition.implementation.implementationDigest,
    configuration,
    configurationDigest: valueDigest(configuration),
    thresholds: null,
    thresholdDigest: null,
    observationVocabularyDigest: digest("hermetic-observation-vocabulary"),
    requiredCapabilities: [CAPABILITY],
    acceptedObservationKinds: [OBSERVATION_KIND],
    minimumTrust: "advisory",
    minimumCompleteness: "complete",
    episodeClasses: { mode: "include", values: ["interactive"] },
    scopePolicyDigest: input.scopePolicyDigest,
    scopeConstraint: { mode: "invocation" },
    lensConstraint: { mode: "required", selection: "allowlist", registrations: [lensRef(lens)] },
    normalizationPolicyDigest: digest("hermetic-normalization-policy"),
    comparabilityPolicyDigest: null,
    outputKind: "insight_derivation",
    positiveFixtureDigests: [digest("hermetic-positive-fixture")],
    negativeFixtureDigests: [digest("hermetic-negative-fixture")],
    falsePositivePolicy,
    falsePositivePolicyDigest: valueDigest(falsePositivePolicy),
    calibrationPopulation: null,
    calibrationPopulationDigest: null,
    calibrationEvidenceDigest: null,
    privacy: {
      signatureTreatment: "none",
      transientContent: input.transport === "outbound" ? "explicit_disclosure_receipt" : "memory_only",
      policyDigest: digest(`hermetic-detector-privacy-${input.transport}`),
    },
    proposedValidationCriterion: validationCriterion,
    proposedValidationCriterionDigest: valueDigest(validationCriterion),
    supersedes: null,
  };
  const detector = parseDetectorRegistration({
    schemaVersion: 1,
    ...detectorBase,
    registrationDigest: detectorRegistrationDigest(detectorBase),
  });
  const packBase: Omit<DetectorPackManifest, "schemaVersion" | "manifestDigest"> = {
    id: "hermetic-generation-pack",
    version: "1.0.0",
    kind: "host",
    detectors: [detectorRef(detector)],
    lenses: [lensRef(lens)],
    changelogDigest: digest("hermetic-pack-changelog"),
    supersedes: null,
  };
  const pack = parseDetectorPackManifest({
    schemaVersion: 1,
    ...packBase,
    manifestDigest: detectorPackManifestDigest(packBase),
  });
  const profileBase: Omit<SourceSemanticProfile, "schemaVersion" | "profileDigest"> = {
    sourceId: input.source.id,
    sourceRegistrationRevision: input.source.registryRevision,
    observationVocabularyDigest: detector.observationVocabularyDigest,
    capabilities: [CAPABILITY],
    observationKinds: [OBSERVATION_KIND],
  };
  const profile = parseSourceSemanticProfile({
    schemaVersion: 1,
    ...profileBase,
    profileDigest: sourceSemanticProfileDigest(profileBase),
  });
  const registryBase: Omit<SemanticRegistryConfig, "schemaVersion" | "registryDigest"> = {
    scopePolicyDigest: input.scopePolicyDigest,
    detectors: [detector],
    packs: [pack],
    lenses: [lens],
    sourceProfiles: [profile],
    selectedDetectorRefs: [detectorRef(detector)],
    selectedPackRefs: [packRef(pack)],
    selectedLensRefs: [lensRef(lens)],
  };
  const registry = parseSemanticRegistryConfig({
    schemaVersion: 1,
    ...registryBase,
    registryDigest: semanticRegistryDigest(registryBase),
  });
  return { detector, pack, lens, profile, registry };
}

function evidenceInput(
  label = "semantic-workflow",
  options: { readonly episodeCount?: number; readonly observationsPerEpisode?: number } = {},
): ManualEvidenceInput {
  const episodeCount = options.episodeCount ?? 1;
  const observationsPerEpisode = options.observationsPerEpisode ?? 1;
  const episodes: NonNullable<ManualEvidenceInput["episodes"]>[number][] = [];
  const observations: NonNullable<ManualEvidenceInput["observations"]>[number][] = [];
  for (let episodeIndex = 0; episodeIndex < episodeCount; episodeIndex += 1) {
    const suffix = episodeCount === 1 ? "" : `-${String(episodeIndex).padStart(3, "0")}`;
    const episodeId = `${label}-episode${suffix}`;
    episodes.push({
      id: episodeId,
      episodeClass: "interactive",
      scope: WORKFLOW_SCOPE,
      openedAt: "2026-08-20T00:00:00.000Z",
      closedAt: "2026-08-20T00:01:00.000Z",
    });
    for (let observationIndex = 0; observationIndex < observationsPerEpisode; observationIndex += 1) {
      const observationSuffix = observationsPerEpisode === 1 ? "" : `-${String(observationIndex).padStart(4, "0")}`;
      observations.push({
        id: `${label}-observation${suffix}${observationSuffix}`,
        episodeId,
        occurredAt: "2026-08-20T00:00:30.000Z",
        kind: OBSERVATION_KIND,
        data: { signal: "structural", count: observationIndex + 1 },
      });
    }
  }
  return {
    observations,
    episodes,
  };
}

export async function ingestWorkflowEpisode(harness: GenerationHarness, label: string): Promise<readonly string[]> {
  const receipt = await harness.learning.ingest(harness.source, evidenceInput(label));
  return receipt.episodeIds;
}

function isRecord(input: unknown): input is Readonly<Record<string, unknown>> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function field(input: unknown, key: string): unknown {
  if (!isRecord(input)) throw new Error("workflow callback input must be an object");
  return input[key];
}

export function positiveProviderResult(providerInput?: unknown): unknown {
  if (providerInput !== undefined) providerRequestBytes(providerInput);
  return {
    schemaVersion: 1,
    id: WORKFLOW_RESULT_SCHEMA_ID,
    version: WORKFLOW_RESULT_SCHEMA_VERSION,
    status: "completed",
    providerReceipt: {
      id: "hermetic-provider-receipt",
      digest: digest("hermetic-provider-receipt"),
    },
    usage: {
      status: "reported",
      inputTokens: 100,
      outputTokens: 25,
      durationMs: 50,
      costMinorUnits: 1,
      currency: "USD",
    },
    result: {
      conditionDetected: true,
      recurrenceLocator: null,
      insights: [
        {
          learningClass: "system_meta",
          directObservation: {
            statement: "The exact episode population contains a provider-mediated structural signal.",
            data: { signal: "structural" },
            evidenceReferenceDigests: [],
          },
          interpretation: {
            statement: "The structural signal requires independent human review.",
            confidence: "unknown",
            uncertainty: ["Provider output is not calibrated."],
          },
          impactHypothesis: null,
          contradictoryEvidenceReferenceDigests: [],
          evidenceHealthFindingIds: [],
          missingEvidence: [],
          applicability: { statement: "Applies only to the exact project scope.", exclusions: [] },
          candidateIntervention: null,
          validation: null,
          supersedes: null,
        },
      ],
      findings: [],
    },
  };
}

export function negativeProviderResult(providerInput?: unknown): unknown {
  const positive = positiveProviderResult(providerInput);
  if (!isRecord(positive)) throw new Error("positive provider fixture is malformed");
  return {
    ...positive,
    result: {
      conditionDetected: false,
      recurrenceLocator: null,
      insights: [],
      findings: [],
    },
  };
}

export function refusedProviderResult(providerInput?: unknown): unknown {
  const positive = positiveProviderResult(providerInput);
  if (!isRecord(positive)) throw new Error("positive provider fixture is malformed");
  return { ...positive, status: "provider_refused", result: null };
}

export function failedProviderResult(providerInput?: unknown): unknown {
  const positive = positiveProviderResult(providerInput);
  if (!isRecord(positive)) throw new Error("positive provider fixture is malformed");
  return { ...positive, status: "provider_failed", result: null };
}

export async function createGenerationHarness(options: GenerationHarnessOptions = {}): Promise<GenerationHarness> {
  const transport = options.transport ?? "local";
  const store = options.store ?? createInMemoryStore();
  const identity = createTestIdentityPort();
  const producer = await identity.verify({
    principalId: "semantic-workflow-producer",
    kind: "service",
    independenceDomain: "semantic-workflow-provider-domain",
  });
  const authorizer = await identity.verify({
    principalId: "semantic-workflow-authorizer",
    kind: "human",
    independenceDomain: "semantic-workflow-human-domain",
  });
  const definition = workflowDefinition({
    transport,
    producer,
    budgets: {
      maximumRequestBytes: options.maximumRequestBytes ?? 1_048_576,
      maximumResponseBytes: options.maximumResponseBytes ?? 1_048_576,
      maximumInputTokens: options.maximumInputTokens ?? 10_000,
      maximumOutputTokens: options.maximumOutputTokens ?? 2_000,
      maximumDurationMs: options.maximumDurationMs ?? 1_000,
    },
  });
  const policy = contentPolicy(transport);
  const source = defineSourceRegistration({
    source: createManualEvidenceSource(),
    trustCeiling: "observed",
    contentPolicyId: policy.id,
  });
  const scopePolicy = createExactScopePolicy();
  const clock = options.clock ?? createFixedClock("2026-08-20T00:02:00.000Z");
  const semantic = semanticRecords({
    transport,
    definition,
    source,
    scopePolicyDigest: scopePolicy.digest,
  });
  const learning = createLearningLoop({
    store,
    policy: conservativePolicy(),
    identity,
    scopePolicy,
    contentPolicies: [policy],
    sources: [source],
    semanticRegistry: semantic.registry,
    queryCursorScope: options.queryCursorScope ?? "semantic-workflow-generation-tests",
    clock,
    ids: createSequentialIds("semantic-workflow-generation"),
  });
  const receipt = await learning.ingest(source, evidenceInput("semantic-workflow", options));
  const providerState: ProviderState = {
    calls: [],
    script: (input) => Promise.resolve(positiveProviderResult(input)),
  };
  const authorityState: AuthorityState = {
    calls: [],
    script: () =>
      Promise.resolve({
        principal: authorizer,
        authorizedAt: "2026-08-20T00:01:30.000Z",
        expiresAt: "2026-08-20T00:02:30.000Z",
      }),
  };
  const tokenEstimatorState: TokenEstimatorState = {
    calls: [],
    estimate: (bytes) => Math.ceil(bytes.byteLength / 4),
  };
  const rendererState: RendererState = {
    calls: [],
    render: (input) => ({
      schemaVersion: 1,
      definitionDigest: field(input, "definitionDigest"),
      window: field(input, "window"),
    }),
  };
  const renderer = {
    rendererDigest: definition.renderer.rendererDigest,
    render: (input: unknown) => {
      rendererState.calls.push(input);
      return rendererState.render(input);
    },
  };
  const minimizer = {
    minimizationPolicyDigest: WORKFLOW_MINIMIZATION_POLICY_DIGEST,
    minimize: (input: unknown) => toJsonValue(field(input, "rendered")),
  };
  const keyedDigester = {
    keyPolicyDigest: WORKFLOW_KEY_POLICY_DIGEST,
    digest: (bytes: Uint8Array) => workflowKeyedDigest(bytes),
  };
  const tokenEstimator = {
    tokenEstimatorDigest: definition.budgetPolicy.tokenEstimatorDigest,
    estimateInputTokens: (bytes: Uint8Array) => {
      tokenEstimatorState.calls.push(new Uint8Array(bytes));
      return tokenEstimatorState.estimate(bytes);
    },
  };
  const provider = {
    registrationDigest: definition.providerModel.provider.registrationDigest,
    invoke: (input: unknown) => {
      providerState.calls.push(input);
      return providerState.script(input);
    },
  };
  const disclosureAuthority = {
    authorizationPolicyDigest: WORKFLOW_AUTHORIZATION_POLICY_DIGEST,
    authorize: (input: unknown) => {
      authorityState.calls.push(input);
      return authorityState.script(input);
    },
  };
  const schemaVersion: 1 = 1;
  const factoryInput: GenerationFactoryInput = {
    schemaVersion,
    loop: learning,
    definition,
    producer,
    renderer,
    minimizer,
    keyedDigester,
    tokenEstimator,
    provider,
    ...(transport === "outbound" ? { disclosureAuthority } : {}),
  };
  const bundle = createSemanticWorkflowBundle(factoryInput);
  return {
    store,
    learning,
    identity,
    producer,
    authorizer,
    source,
    contentPolicy: policy,
    scopePolicy,
    clock,
    definition,
    detector: semantic.detector,
    pack: semantic.pack,
    lens: semantic.lens,
    registry: semantic.registry,
    scope: WORKFLOW_SCOPE,
    episodeRecordIds: receipt.episodeIds,
    providerState,
    authorityState,
    tokenEstimatorState,
    rendererState,
    bundle,
    factoryInput,
    prepareInput: {
      detector: detectorRef(semantic.detector),
      pack: packRef(semantic.pack),
      lens: lensRef(semantic.lens),
      scope: WORKFLOW_SCOPE,
      episodeRecordIds: receipt.episodeIds,
      expiresAt: "2026-08-20T00:05:00.000Z",
    },
  };
}
