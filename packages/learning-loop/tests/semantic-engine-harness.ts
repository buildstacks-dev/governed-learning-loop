import type {
  AuthorityPort,
  DestinationRegistration,
  DetectorExecutionRecord,
  DetectorPackManifest,
  DetectorRegistration,
  EvidenceRef,
  InsightDerivation,
  LearningLensRegistration,
  LearningLoop,
  LearningStore,
  MeasurementEvidenceRefV2,
  ObservationEvidenceRef,
  RegisteredSource,
  Scope,
  SemanticRegistryConfig,
  SourceSemanticProfile,
} from "../src/index.js";
import {
  conservativePolicy,
  createLearningLoop,
  defineSourceRegistration,
  detectorExecutionDigest,
  detectorExecutionKeyDigest,
  detectorPackManifestDigest,
  detectorRegistrationDigest,
  insightDerivationDigest,
  learningLensRegistrationDigest,
  parseDetectorExecutionRecord,
  parseDetectorPackManifest,
  parseDetectorRegistration,
  parseInsightDerivation,
  parseLearningLensRegistration,
  parseSemanticRegistryConfig,
  parseSourceSemanticProfile,
  scopeDigest,
  semanticRegistryDigest,
  sha256HexOfCanonicalJson,
  sourceSemanticProfileDigest,
  toJsonValue,
} from "../src/index.js";
import type { EngineContext } from "../src/engine/context.js";
import { resolveCandidateEvidence } from "../src/engine/evidence-binding.js";
import { loadLatestEpisodeOutcomeClaim } from "../src/engine/episode-outcome.js";
import { extractPolicyRules } from "../src/engine/policy.js";
import { detectorRefKey, lensRefKey, packRefKey } from "../src/records/semantic-shared.js";
import type { ManualEvidenceInput } from "../src/testing/index.js";
import {
  createExactScopePolicy,
  createFixedClock,
  createInMemoryStore,
  createManualEvidenceSource,
  createSequentialIds,
  createStructuredContentPolicy,
  createTestIdentityPort,
} from "../src/testing/index.js";

export const SEMANTIC_SCOPE_A: Scope = [{ type: "project", id: "semantic-project-a" }];
export const SEMANTIC_SCOPE_B: Scope = [{ type: "project", id: "semantic-project-b" }];
export const SEMANTIC_CONTENT_POLICY_ID = "semantic-structured-v1";

function digest(value: unknown): string {
  return sha256HexOfCanonicalJson(toJsonValue(value));
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function detectorRef(detector: DetectorRegistration) {
  return { id: detector.id, version: detector.version, registrationDigest: detector.registrationDigest };
}

function lensRef(lens: LearningLensRegistration) {
  return { id: lens.id, version: lens.version, registrationDigest: lens.registrationDigest };
}

function packRef(pack: DetectorPackManifest) {
  return { id: pack.id, version: pack.version, manifestDigest: pack.manifestDigest };
}

function createLens(
  scopePolicyDigest: string,
  evidenceKind: LearningLensRegistration["evidenceRequirements"][number]["kind"],
  minimumTrust: LearningLensRegistration["evidenceRequirements"][number]["minimumTrust"],
  generatorKinds: LearningLensRegistration["generatorPolicy"]["allowedKinds"] = ["deterministic"],
): LearningLensRegistration {
  const objective = "Improve a registered host purpose without granting activation authority.";
  const qualitativeRubric = { relevance: "required", uncertainty: "explicit" };
  const validationStrategy = { method: "held-out-comparable-episodes" };
  const base: Omit<LearningLensRegistration, "schemaVersion" | "registrationDigest"> = {
    id: "semantic-purpose",
    version: "1.0.0",
    objective,
    objectiveDigest: digest(objective),
    scopePolicyDigest,
    applicableScopes: { mode: "invocation" },
    episodeClasses: { mode: "include", values: ["interactive"] },
    learningClasses: ["system_meta"],
    evidenceRequirements: [{ kind: evidenceKind, minimumTrust, minimumCompleteness: "complete" }],
    qualitativeRubric,
    qualitativeRubricDigest: digest(qualitativeRubric),
    requiredFingerprintKinds: [],
    requiredCalibrationIds: [],
    permittedDestinationIds: ["host/semantic-note"],
    permittedDestinationKinds: ["report-note"],
    generatorPolicy: {
      allowedKinds: generatorKinds,
      identityPolicyDigest: "1".repeat(64),
      fingerprintPolicyDigest: "2".repeat(64),
    },
    reviewerPolicy: {
      independentFromGenerator: true,
      identityPolicyDigest: "3".repeat(64),
      calibrationPolicyDigest: null,
    },
    privacy: { outboundDisclosure: "forbidden", policyDigest: "4".repeat(64) },
    validationStrategy,
    validationStrategyDigest: digest(validationStrategy),
    supersedes: null,
  };
  return parseLearningLensRegistration({
    schemaVersion: 1,
    ...base,
    registrationDigest: learningLensRegistrationDigest(base),
  });
}

function createDetector(
  scopePolicyDigest: string,
  lens: LearningLensRegistration,
  outputKind: DetectorRegistration["outputKind"],
  options: {
    readonly requiredCapabilities?: readonly string[];
    readonly acceptedObservationKinds?: readonly string[];
    readonly minimumTrust?: DetectorRegistration["minimumTrust"];
    readonly minimumCompleteness?: DetectorRegistration["minimumCompleteness"];
    readonly episodeClasses?: DetectorRegistration["episodeClasses"];
    readonly scopeConstraint?: DetectorRegistration["scopeConstraint"];
    readonly workflowDefinitionDigest?: string;
    readonly transientContent?: DetectorRegistration["privacy"]["transientContent"];
    readonly lensGeneratorKinds?: LearningLensRegistration["generatorPolicy"]["allowedKinds"];
  },
): DetectorRegistration {
  const configuration = {
    detector: "semantic-fixture",
    thresholdClass: "exact",
    ...(options.workflowDefinitionDigest === undefined
      ? {}
      : { workflowDefinitionDigest: options.workflowDefinitionDigest }),
  };
  const falsePositivePolicy = { complexLegitimateControls: "required" };
  const proposedValidationCriterion = { metric: "verified-repeat-rate", direction: "decrease" };
  const base: Omit<DetectorRegistration, "schemaVersion" | "registrationDigest"> = {
    id: "host.semantic-fixture",
    version: "1.0.0",
    maturity: "experimental",
    implementationDigest: "5".repeat(64),
    configuration,
    configurationDigest: digest(configuration),
    thresholds: null,
    thresholdDigest: null,
    observationVocabularyDigest: "6".repeat(64),
    requiredCapabilities: options.requiredCapabilities ?? ["operation.state"],
    acceptedObservationKinds: options.acceptedObservationKinds ?? ["tool.process.completed"],
    minimumTrust: options.minimumTrust ?? "advisory",
    minimumCompleteness: options.minimumCompleteness ?? "partial",
    episodeClasses: options.episodeClasses ?? { mode: "include", values: ["interactive"] },
    scopePolicyDigest,
    scopeConstraint: options.scopeConstraint ?? { mode: "invocation" },
    lensConstraint:
      outputKind === "insight_derivation"
        ? { mode: "required", selection: "allowlist", registrations: [lensRef(lens)] }
        : { mode: "independent" },
    normalizationPolicyDigest: "7".repeat(64),
    comparabilityPolicyDigest: null,
    outputKind,
    positiveFixtureDigests: ["8".repeat(64)],
    negativeFixtureDigests: ["9".repeat(64)],
    falsePositivePolicy,
    falsePositivePolicyDigest: digest(falsePositivePolicy),
    calibrationPopulation: null,
    calibrationPopulationDigest: null,
    calibrationEvidenceDigest: null,
    privacy: {
      signatureTreatment: "tenant_keyed_private",
      transientContent: options.transientContent ?? "forbidden",
      policyDigest: "a".repeat(64),
    },
    proposedValidationCriterion,
    proposedValidationCriterionDigest: digest(proposedValidationCriterion),
    supersedes: null,
  };
  return parseDetectorRegistration({
    schemaVersion: 1,
    ...base,
    registrationDigest: detectorRegistrationDigest(base),
  });
}

function createPack(detector: DetectorRegistration, lens: LearningLensRegistration): DetectorPackManifest {
  const base: Omit<DetectorPackManifest, "schemaVersion" | "manifestDigest"> = {
    id: "host-semantic-pack",
    version: "1.0.0",
    kind: "host",
    detectors: [detectorRef(detector)],
    lenses: [lensRef(lens)],
    changelogDigest: "b".repeat(64),
    supersedes: null,
  };
  return parseDetectorPackManifest({
    schemaVersion: 1,
    ...base,
    manifestDigest: detectorPackManifestDigest(base),
  });
}

function createProfile(source: RegisteredSource<ManualEvidenceInput>): SourceSemanticProfile {
  const base: Omit<SourceSemanticProfile, "schemaVersion" | "profileDigest"> = {
    sourceId: source.id,
    sourceRegistrationRevision: source.registryRevision,
    observationVocabularyDigest: "6".repeat(64),
    capabilities: ["operation.state"],
    observationKinds: ["tool.process.completed"],
  };
  return parseSourceSemanticProfile({
    schemaVersion: 1,
    ...base,
    profileDigest: sourceSemanticProfileDigest(base),
  });
}

function createRegistry(input: {
  readonly scopePolicyDigest: string;
  readonly detector: DetectorRegistration;
  readonly pack: DetectorPackManifest;
  readonly lens: LearningLensRegistration;
  readonly profile: SourceSemanticProfile;
}): SemanticRegistryConfig {
  const base: Omit<SemanticRegistryConfig, "schemaVersion" | "registryDigest"> = {
    scopePolicyDigest: input.scopePolicyDigest,
    detectors: [input.detector],
    packs: [input.pack],
    lenses: [input.lens],
    sourceProfiles: [input.profile],
    selectedDetectorRefs: [detectorRef(input.detector)],
    selectedPackRefs: [packRef(input.pack)],
    selectedLensRefs: [lensRef(input.lens)],
  };
  return parseSemanticRegistryConfig({ schemaVersion: 1, ...base, registryDigest: semanticRegistryDigest(base) });
}

export interface SemanticEngineHarness {
  readonly store: LearningStore;
  readonly learning: LearningLoop;
  readonly context: EngineContext;
  readonly source: RegisteredSource<ManualEvidenceInput>;
  readonly registry: SemanticRegistryConfig;
  readonly detector: DetectorRegistration;
  readonly pack: DetectorPackManifest;
  readonly lens: LearningLensRegistration;
  readonly profile: SourceSemanticProfile;
  readonly scope: Scope;
  readonly evidence: ObservationEvidenceRef;
  readonly measurementEvidence?: MeasurementEvidenceRefV2;
  readonly episodeView: {
    readonly episodeRecordId: string;
    readonly episodeRecordDigest: string;
    readonly episodeIdentityDigest: string;
    readonly outcomeClaimDigest: string | null;
    readonly episodeViewDigest: string;
    readonly scopeDigest: string;
  };
}

export async function createSemanticEngineHarness(
  input: {
    readonly scope?: Scope;
    readonly store?: LearningStore;
    readonly label?: string;
    readonly lensEvidenceKind?: LearningLensRegistration["evidenceRequirements"][number]["kind"];
    readonly lensMinimumTrust?: LearningLensRegistration["evidenceRequirements"][number]["minimumTrust"];
    readonly lensGeneratorKinds?: LearningLensRegistration["generatorPolicy"]["allowedKinds"];
    readonly detectorTransientContent?: DetectorRegistration["privacy"]["transientContent"];
    readonly detectorOutputKind?: DetectorRegistration["outputKind"];
    readonly withMeasurement?: boolean;
    readonly observationCount?: number;
    readonly measurementCount?: number;
    readonly measurementEvidenceIds?: readonly string[];
    readonly detectorRequiredCapabilities?: readonly string[];
    readonly detectorAcceptedObservationKinds?: readonly string[];
    readonly detectorMinimumTrust?: DetectorRegistration["minimumTrust"];
    readonly detectorMinimumCompleteness?: DetectorRegistration["minimumCompleteness"];
    readonly detectorEpisodeClasses?: DetectorRegistration["episodeClasses"];
    readonly detectorScopeConstraint?: DetectorRegistration["scopeConstraint"];
    readonly workflowDefinitionDigest?: string;
    /** Decision 0024: optional host destination registrations and authority port for Activate tests. */
    readonly destinations?: readonly DestinationRegistration[];
    readonly authority?: AuthorityPort;
  } = {},
): Promise<SemanticEngineHarness> {
  const scope = input.scope ?? SEMANTIC_SCOPE_A;
  const label = input.label ?? "semantic";
  const observationCount = input.observationCount ?? 1;
  const measurementCount = input.measurementCount ?? (input.withMeasurement === true ? 1 : 0);
  const observationIds = Array.from({ length: observationCount }, (_, index) =>
    index === 0 ? `${label}-observation` : `${label}-observation-${index}`,
  );
  const measurementIds = Array.from({ length: measurementCount }, (_, index) =>
    index === 0 ? `${label}-measurement` : `${label}-measurement-${index}`,
  );
  const measurementEvidenceIds = input.measurementEvidenceIds ?? [`${label}-observation`];
  const store = input.store ?? createInMemoryStore();
  const source = defineSourceRegistration({
    source: createManualEvidenceSource(),
    trustCeiling: "observed",
    contentPolicyId: SEMANTIC_CONTENT_POLICY_ID,
  });
  const scopePolicy = createExactScopePolicy();
  const lens = createLens(
    scopePolicy.digest,
    input.lensEvidenceKind ?? "observation",
    input.lensMinimumTrust ?? "advisory",
    input.lensGeneratorKinds,
  );
  const detector = createDetector(scopePolicy.digest, lens, input.detectorOutputKind ?? "insight_derivation", {
    ...(input.detectorRequiredCapabilities === undefined
      ? {}
      : { requiredCapabilities: input.detectorRequiredCapabilities }),
    ...(input.detectorAcceptedObservationKinds === undefined
      ? {}
      : { acceptedObservationKinds: input.detectorAcceptedObservationKinds }),
    ...(input.detectorMinimumTrust === undefined ? {} : { minimumTrust: input.detectorMinimumTrust }),
    ...(input.detectorMinimumCompleteness === undefined
      ? {}
      : { minimumCompleteness: input.detectorMinimumCompleteness }),
    ...(input.detectorEpisodeClasses === undefined ? {} : { episodeClasses: input.detectorEpisodeClasses }),
    ...(input.detectorScopeConstraint === undefined ? {} : { scopeConstraint: input.detectorScopeConstraint }),
    ...(input.workflowDefinitionDigest === undefined
      ? {}
      : { workflowDefinitionDigest: input.workflowDefinitionDigest }),
    ...(input.detectorTransientContent === undefined ? {} : { transientContent: input.detectorTransientContent }),
  });
  const pack = createPack(detector, lens);
  const profile = createProfile(source);
  const registry = createRegistry({ scopePolicyDigest: scopePolicy.digest, detector, pack, lens, profile });
  const policy = conservativePolicy();
  const identity = createTestIdentityPort();
  const contentPolicy = createStructuredContentPolicy({ id: SEMANTIC_CONTENT_POLICY_ID });
  const clock = createFixedClock("2026-08-20T00:00:00.000Z");
  const ids = createSequentialIds("semantic");
  const learning = createLearningLoop({
    store,
    policy,
    identity,
    scopePolicy,
    contentPolicies: [contentPolicy],
    sources: [source],
    semanticRegistry: registry,
    ...(input.destinations === undefined ? {} : { destinations: input.destinations }),
    ...(input.authority === undefined ? {} : { authority: input.authority }),
    queryCursorScope: "semantic-engine-tests",
    clock,
    ids,
  });
  const observations: NonNullable<ManualEvidenceInput["observations"]> = observationIds.map((id) => ({
    id,
    episodeId: `${label}-episode`,
    occurredAt: "2026-08-20T00:01:00.000Z",
    kind: "tool.process.completed",
    data: { commandClass: "verify", exitCode: 1 },
  }));
  const measurements: NonNullable<ManualEvidenceInput["measurements"]> = measurementIds.map((id) => ({
    id,
    episodeId: `${label}-episode`,
    metric: { name: "verification", valueType: "boolean", unit: "pass", aggregation: "all" },
    value: false,
    evidenceIds: measurementEvidenceIds,
    measuredAt: "2026-08-20T00:01:30.000Z",
  }));
  const receipt = await learning.ingest(source, {
    observations,
    ...(measurements.length > 0 ? { measurements } : {}),
    episodes: [
      {
        id: `${label}-episode`,
        episodeClass: "interactive",
        scope,
        openedAt: "2026-08-20T00:00:00.000Z",
        closedAt: "2026-08-20T00:02:00.000Z",
        ...(measurementIds.length > 0 ? { outcome: { status: "failed" as const, measurementIds } } : {}),
      },
    ],
  });
  const context: EngineContext = {
    store,
    policy,
    policyRules: extractPolicyRules(policy),
    scopePolicy,
    contentPoliciesById: new Map([[contentPolicy.id, contentPolicy]]),
    sources: new Set([source]),
    identity,
    semanticRegistry: registry,
    semanticDetectorsByRef: new Map([[detectorRefKey(detectorRef(detector)), detector]]),
    semanticPacksByRef: new Map([[packRefKey(packRef(pack)), pack]]),
    semanticLensesByRef: new Map([[lensRefKey(lensRef(lens)), lens]]),
    sourceSemanticProfilesBySourceId: new Map([[source.id, profile]]),
    registryRevision: receipt.registryRevision,
    queryCursorScopeDigest: digest({ queryCursorScope: "semantic-engine-tests" }),
    clock,
    ids,
  };
  const resolution = await resolveCandidateEvidence(context, [`${source.id}/${label}-observation`], scope);
  const evidence = resolution.refs[0];
  if (evidence === undefined || evidence.schemaVersion !== 1 || evidence.kind !== "observation") {
    throw new Error("semantic fixture did not resolve one observation EvidenceRef");
  }
  const observationEvidence: ObservationEvidenceRef = { ...evidence, kind: "observation" };
  let measurementEvidence: MeasurementEvidenceRefV2 | undefined;
  if (measurementIds.length > 0) {
    const measurementResolution = await resolveCandidateEvidence(context, [`${source.id}/${label}-measurement`], scope);
    const resolvedMeasurement = measurementResolution.refs[0];
    if (
      resolvedMeasurement === undefined ||
      resolvedMeasurement.schemaVersion !== 2 ||
      resolvedMeasurement.kind !== "measurement"
    ) {
      throw new Error("semantic fixture did not resolve one MeasurementEvidenceRefV2");
    }
    measurementEvidence = resolvedMeasurement;
  }
  const outcome = await loadLatestEpisodeOutcomeClaim(context, observationEvidence.episode.episodeRecordId);
  const episodeBound = {
    episodeRecordId: observationEvidence.episode.episodeRecordId,
    episodeRecordDigest: observationEvidence.episode.episodeRecordDigest,
    episodeIdentityDigest: observationEvidence.episode.episodeIdentityDigest,
    outcomeClaimDigest: outcome.status === "resolved" ? outcome.latest.claimDigest : null,
    scopeDigest: scopeDigest(scope),
  };
  const episodeView = { ...episodeBound, episodeViewDigest: digest(episodeBound) };
  return {
    store,
    learning,
    context,
    source,
    registry,
    detector,
    pack,
    lens,
    profile,
    scope,
    evidence: observationEvidence,
    ...(measurementEvidence === undefined ? {} : { measurementEvidence }),
    episodeView,
  };
}

export function createSemanticFacts(
  harness: SemanticEngineHarness,
  input: {
    readonly withEvidence?: boolean;
    readonly evidenceRef?: EvidenceRef;
    readonly contradictoryEvidenceRefs?: readonly EvidenceRef[];
    readonly observationLabel?: string;
    readonly executionResult?: DetectorExecutionRecord["result"];
  } = {},
): { readonly derivation: InsightDerivation; readonly execution: DetectorExecutionRecord } {
  const episodes = [
    {
      episodeRecordId: harness.episodeView.episodeRecordId,
      episodeViewDigest: harness.episodeView.episodeViewDigest,
      scopeDigest: harness.episodeView.scopeDigest,
    },
  ];
  const normalizationPolicyDigest = harness.detector.normalizationPolicyDigest;
  const comparabilityPolicyDigest = harness.detector.comparabilityPolicyDigest;
  const populationDigest = digest({ episodes, normalizationPolicyDigest, comparabilityPolicyDigest });
  const comparablePopulation = { episodeClass: "interactive", split: "held-out" };
  const evidenceRefs = input.withEvidence === false ? [] : [input.evidenceRef ?? harness.evidence];
  const contradictoryEvidenceRefs = input.contradictoryEvidenceRefs ?? [];
  const derivationBase: Omit<InsightDerivation, "schemaVersion" | "id" | "derivationDigest"> = {
    scope: harness.scope,
    scopeDigest: scopeDigest(harness.scope),
    scopePolicyDigest: harness.detector.scopePolicyDigest,
    learningClass: "system_meta",
    lens: lensRef(harness.lens),
    detector: { ...detectorRef(harness.detector), configurationDigest: harness.detector.configurationDigest },
    pack: packRef(harness.pack),
    population: {
      episodes,
      populationDigest,
      normalizationPolicyDigest,
      comparabilityPolicyDigest,
    },
    directObservation: {
      statement: "The exact evidence window contains a repeatable verification condition.",
      data: { condition: input.observationLabel ?? "verification-condition" },
      evidenceRefs,
      completeness: "complete",
    },
    evidenceHealthFindings: [],
    interpretation: {
      statement: "The condition may be reduced by a deterministic host procedure.",
      confidence: "medium",
      uncertainty: ["Causal impact remains unvalidated."],
    },
    impactHypothesis: { statement: "The procedure may reduce incomplete verification attempts." },
    contradictoryEvidenceRefs,
    missingEvidence: [],
    applicability: { statement: "Applies to this exact project scope.", exclusions: ["benchmark traffic"] },
    producer: {
      kind: "deterministic",
      implementationId: harness.detector.id,
      implementationVersion: harness.detector.version,
      implementationDigest: harness.detector.implementationDigest,
      principal: null,
      attestation: null,
      modelFingerprintDigest: null,
      promptDigest: null,
      toolPolicyDigest: null,
      budgetPolicyDigest: null,
      disclosure: null,
    },
    candidateIntervention: {
      summary: "Run the registered verifier before a completion claim.",
      proposedDestinationKind: "report-note",
      proposedDestinationId: "host/semantic-note",
      contentDraft: { action: "verify-before-completion" },
      rollbackIntent: "Remove the unvalidated draft.",
    },
    validation: {
      method: "comparable-held-out-episodes",
      comparablePopulation,
      comparablePopulationDigest: digest(comparablePopulation),
      successCriterion: "Verifier-backed completion claims increase.",
      guardrails: ["Do not suppress valid failures."],
      strategyDigest: harness.lens.validationStrategyDigest,
    },
    supersedes: null,
  };
  const derivationDigest = insightDerivationDigest(derivationBase);
  const derivation = parseInsightDerivation({
    schemaVersion: 1,
    id: `insight-${derivationDigest}`,
    ...derivationBase,
    derivationDigest,
  });

  const executionEpisodes = [harness.episodeView];
  const executionPopulation = {
    episodes: executionEpisodes,
    normalizationPolicyDigest,
    comparabilityPolicyDigest,
    populationDigest: digest({
      episodes: executionEpisodes,
      normalizationPolicyDigest,
      comparabilityPolicyDigest,
    }),
  };
  const windowBase = {
    sourceProfiles: [harness.profile],
    population: executionPopulation,
    evidenceRefs: [...evidenceRefs, ...contradictoryEvidenceRefs],
    evidenceHealthFindings: [],
    availableCapabilities: [...harness.profile.capabilities],
  };
  const window = { ...windowBase, windowDigest: digest(windowBase) };
  const executionBase = {
    loopRegistryRevision: harness.context.registryRevision,
    detector: {
      ...detectorRef(harness.detector),
      configurationDigest: harness.detector.configurationDigest,
      implementationDigest: harness.detector.implementationDigest,
    },
    pack: packRef(harness.pack),
    lens: harness.detector.outputKind === "insight_derivation" ? lensRef(harness.lens) : null,
    scope: harness.scope,
    scopeDigest: scopeDigest(harness.scope),
    scopePolicyDigest: harness.detector.scopePolicyDigest,
    outputKind: harness.detector.outputKind,
    window,
  };
  const result =
    input.executionResult ??
    ({
      status: "applied",
      conditionDetected: true,
      derivationRefs: [
        { id: derivation.id, derivationDigest: derivation.derivationDigest, scopeDigest: derivation.scopeDigest },
      ],
      evidenceHealthFindings: [],
    } as const);
  const executionKeyDigest = detectorExecutionKeyDigest(executionBase);
  const executionDigest = detectorExecutionDigest({ ...executionBase, result, executionKeyDigest });
  const execution = parseDetectorExecutionRecord({
    schemaVersion: 1,
    id: `detector-execution-${executionKeyDigest}`,
    ...executionBase,
    result,
    executionKeyDigest,
    executionDigest,
  });
  return { derivation, execution };
}

export function sortedExecutionRefs<T extends { readonly executionDigest: string }>(
  values: readonly T[],
): readonly T[] {
  return [...values].sort((left, right) => compareText(left.executionDigest, right.executionDigest));
}
