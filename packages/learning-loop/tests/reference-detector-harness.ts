import type {
  DetectorPackManifest,
  DetectorRegistration,
  EvidenceSource,
  LearningLensRegistration,
  LearningLoop,
  LearningStore,
  RegisteredSource,
  Scope,
  SemanticRegistryConfig,
  SourceSemanticProfile,
} from "@cormidia/learning-loop";
import {
  canonicalJsonText,
  conservativePolicy,
  createLearningLoop,
  defineSourceRegistration,
  detectorPackManifestDigest,
  learningLensRegistrationDigest,
  parseLearningLensRegistration,
  parseSemanticRegistryConfig,
  parseSourceSemanticProfile,
  semanticRegistryDigest,
  sha256HexOfCanonicalJson,
  sourceSemanticProfileDigest,
  toJsonValue,
} from "@cormidia/learning-loop";
import type { ReferenceDetectorBundle } from "@cormidia/learning-loop/reference-detectors";
import { createReferenceDetectorBundle } from "@cormidia/learning-loop/reference-detectors";
import type { ManualEvidenceInput } from "@cormidia/learning-loop/testing";
import {
  createExactScopePolicy,
  createInMemoryStore,
  createManualEvidenceSource,
  createStructuredContentPolicy,
  createTestIdentityPort,
} from "@cormidia/learning-loop/testing";

export const REFERENCE_SCOPE_A: Scope = [{ type: "project", id: "reference-project-a" }];
export const REFERENCE_SCOPE_B: Scope = [{ type: "project", id: "reference-project-b" }];
export const REFERENCE_CRAFT_SCOPE: Scope = [{ type: "craft", id: "reference-cross-project-craft" }];
export const REFERENCE_CONTENT_POLICY_ID = "reference-structured-v1";

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function referenceDigest(value: unknown): string {
  return sha256HexOfCanonicalJson(toJsonValue(value));
}

function detectorKey(value: DetectorRegistration): string {
  return canonicalJsonText(toJsonValue([value.id, value.version, value.registrationDigest]));
}

function packKey(value: DetectorPackManifest): string {
  return canonicalJsonText(toJsonValue([value.id, value.version, value.manifestDigest]));
}

function lensKey(value: LearningLensRegistration): string {
  return canonicalJsonText(toJsonValue([value.id, value.version, value.registrationDigest]));
}

export function detectorRef(detector: DetectorRegistration): {
  readonly id: string;
  readonly version: string;
  readonly registrationDigest: string;
} {
  return { id: detector.id, version: detector.version, registrationDigest: detector.registrationDigest };
}

export function packRef(pack: DetectorPackManifest): {
  readonly id: string;
  readonly version: string;
  readonly manifestDigest: string;
} {
  return { id: pack.id, version: pack.version, manifestDigest: pack.manifestDigest };
}

export function lensRef(lens: LearningLensRegistration): {
  readonly id: string;
  readonly version: string;
  readonly registrationDigest: string;
} {
  return { id: lens.id, version: lens.version, registrationDigest: lens.registrationDigest };
}

export function createReferenceLens(input: {
  readonly id: string;
  readonly objective: string;
  readonly scopePolicyDigest: string;
}): LearningLensRegistration {
  const qualitativeRubric = { evidence: "exact", interpretation: "claim-limited" };
  const validationStrategy = { method: "host-reviewed-reference-control" };
  const base: Omit<LearningLensRegistration, "schemaVersion" | "registrationDigest"> = {
    id: input.id,
    version: "1.0.0",
    objective: input.objective,
    objectiveDigest: referenceDigest(input.objective),
    scopePolicyDigest: input.scopePolicyDigest,
    applicableScopes: { mode: "invocation" },
    episodeClasses: { mode: "any" },
    learningClasses: ["human_agent_interaction", "mechanical_execution", "system_meta"],
    evidenceRequirements: [{ kind: "observation", minimumTrust: "observed", minimumCompleteness: "complete" }],
    qualitativeRubric,
    qualitativeRubricDigest: referenceDigest(qualitativeRubric),
    requiredFingerprintKinds: [],
    requiredCalibrationIds: [],
    permittedDestinationIds: [],
    permittedDestinationKinds: [],
    generatorPolicy: {
      allowedKinds: ["deterministic"],
      identityPolicyDigest: referenceDigest({ policy: "reference-generator" }),
      fingerprintPolicyDigest: referenceDigest({ policy: "reference-fingerprint" }),
    },
    reviewerPolicy: {
      independentFromGenerator: true,
      identityPolicyDigest: referenceDigest({ policy: "reference-reviewer" }),
      calibrationPolicyDigest: null,
    },
    privacy: { outboundDisclosure: "forbidden", policyDigest: referenceDigest({ policy: "reference-privacy" }) },
    validationStrategy,
    validationStrategyDigest: referenceDigest(validationStrategy),
    supersedes: null,
  };
  return parseLearningLensRegistration({
    schemaVersion: 1,
    ...base,
    registrationDigest: learningLensRegistrationDigest(base),
  });
}

export function createReferenceBundle(
  input: {
    readonly registrationNamespace?: string;
    readonly lenses?: readonly LearningLensRegistration[];
    readonly extra?: Readonly<Record<string, unknown>>;
  } = {},
): ReferenceDetectorBundle {
  const scopePolicy = createExactScopePolicy();
  const lenses = input.lenses ?? [
    createReferenceLens({
      id: "reference-documentation-purpose",
      objective: "Interpret structural evidence for independently usable documentation.",
      scopePolicyDigest: scopePolicy.digest,
    }),
    createReferenceLens({
      id: "reference-support-purpose",
      objective: "Interpret structural evidence for accurate support interactions.",
      scopePolicyDigest: scopePolicy.digest,
    }),
  ];
  return createReferenceDetectorBundle({
    schemaVersion: 1,
    registrationNamespace: input.registrationNamespace ?? "reference.synthetic",
    scopePolicyDigest: scopePolicy.digest,
    lenses,
    ...(input.extra ?? {}),
  });
}

export function allReferenceDetectors(bundle: ReferenceDetectorBundle): readonly DetectorRegistration[] {
  return [...bundle.coreStructural.detectors, ...bundle.referenceOperational.detectors].sort((left, right) =>
    compareText(detectorKey(left), detectorKey(right)),
  );
}

export function allReferencePacks(bundle: ReferenceDetectorBundle): readonly DetectorPackManifest[] {
  return [bundle.coreStructural.pack, bundle.referenceOperational.pack].sort((left, right) =>
    compareText(packKey(left), packKey(right)),
  );
}

export function createHostReferenceProfile(
  bundle: ReferenceDetectorBundle,
  source: RegisteredSource<ManualEvidenceInput>,
  options: {
    readonly capabilities?: readonly string[];
    readonly observationKinds?: readonly string[];
    readonly observationVocabularyDigest?: string;
  } = {},
): SourceSemanticProfile {
  const capabilities =
    options.capabilities ??
    [...new Set(bundle.sourceRequirements.detectors.flatMap((detector) => detector.requiredCapabilities))].sort(
      compareText,
    );
  const observationKinds =
    options.observationKinds ??
    [...new Set(bundle.sourceRequirements.detectors.flatMap((detector) => detector.acceptedObservationKinds))].sort(
      compareText,
    );
  const base: Omit<SourceSemanticProfile, "schemaVersion" | "profileDigest"> = {
    sourceId: source.id,
    sourceRegistrationRevision: source.registryRevision,
    observationVocabularyDigest:
      options.observationVocabularyDigest ?? bundle.sourceRequirements.observationVocabularyDigest,
    capabilities,
    observationKinds,
  };
  return parseSourceSemanticProfile({
    schemaVersion: 1,
    ...base,
    profileDigest: sourceSemanticProfileDigest(base),
  });
}

export function createReferenceRegistry(
  bundle: ReferenceDetectorBundle,
  sourceProfiles: readonly SourceSemanticProfile[],
): SemanticRegistryConfig {
  const detectors = allReferenceDetectors(bundle);
  const packs = allReferencePacks(bundle);
  const lenses = [...bundle.lenses].sort((left, right) => compareText(lensKey(left), lensKey(right)));
  const base: Omit<SemanticRegistryConfig, "schemaVersion" | "registryDigest"> = {
    scopePolicyDigest: bundle.scopePolicyDigest,
    detectors,
    packs,
    lenses,
    sourceProfiles: [...sourceProfiles].sort((left, right) => compareText(left.sourceId, right.sourceId)),
    selectedDetectorRefs: detectors.map(detectorRef),
    selectedPackRefs: packs.map(packRef),
    selectedLensRefs: lenses.map(lensRef),
  };
  return parseSemanticRegistryConfig({
    schemaVersion: 1,
    ...base,
    registryDigest: semanticRegistryDigest(base),
  });
}

export interface ReferenceHarness {
  readonly bundle: ReferenceDetectorBundle;
  readonly store: LearningStore;
  readonly learning: LearningLoop;
  readonly source: RegisteredSource<ManualEvidenceInput>;
  readonly profile?: SourceSemanticProfile;
  readonly scopePolicy: ReturnType<typeof createExactScopePolicy>;
  readonly identity: ReturnType<typeof createTestIdentityPort>;
}

function fixtureRecord(input: unknown, label: string): Readonly<Record<string, unknown>> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error(`${label} must be an object`);
  }
  return Object.fromEntries(Object.entries(input));
}

function fixtureArray(input: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(input)) throw new Error(`${label} must be an array`);
  return input;
}

function fixtureString(input: unknown, label: string): string {
  if (typeof input !== "string" || input.length === 0) throw new Error(`${label} must be nonempty text`);
  return input;
}

function fixtureOptionalString(input: unknown, label: string): string | undefined {
  return input === undefined ? undefined : fixtureString(input, label);
}

function fixtureOutcome(input: unknown): NonNullable<ManualEvidenceInput["episodes"]>[number]["outcome"] {
  const record = fixtureRecord(input, "fixture outcome");
  const rawStatus = record.status;
  if (rawStatus !== "succeeded" && rawStatus !== "failed" && rawStatus !== "cancelled" && rawStatus !== "unknown") {
    throw new Error("fixture outcome status is invalid");
  }
  const measurementIds = fixtureArray(record.measurementIds, "fixture outcome measurement ids").map((value, index) =>
    fixtureString(value, `fixture outcome measurement id ${String(index)}`),
  );
  return { status: rawStatus, measurementIds };
}

export function parseReferenceFixtureInput(input: unknown): ManualEvidenceInput {
  const record = fixtureRecord(input, "reference fixture input");
  const observations = fixtureArray(record.observations, "reference fixture observations").map((value, index) => {
    const observation = fixtureRecord(value, `reference fixture observation ${String(index)}`);
    const occurredAt = fixtureOptionalString(
      observation.occurredAt,
      `reference fixture observation ${String(index)} occurredAt`,
    );
    return {
      id: fixtureString(observation.id, `reference fixture observation ${String(index)} id`),
      episodeId: fixtureString(observation.episodeId, `reference fixture observation ${String(index)} episodeId`),
      ...(occurredAt === undefined ? {} : { occurredAt }),
      kind: fixtureString(observation.kind, `reference fixture observation ${String(index)} kind`),
      data: toJsonValue(observation.data),
    };
  });
  const episodes = fixtureArray(record.episodes, "reference fixture episodes").map((value, index) => {
    const episode = fixtureRecord(value, `reference fixture episode ${String(index)}`);
    const parentEpisodeId = fixtureOptionalString(
      episode.parentEpisodeId,
      `reference fixture episode ${String(index)} parentEpisodeId`,
    );
    const episodeClass = fixtureOptionalString(
      episode.episodeClass,
      `reference fixture episode ${String(index)} episodeClass`,
    );
    const closedAt = fixtureOptionalString(episode.closedAt, `reference fixture episode ${String(index)} closedAt`);
    const outcome = episode.outcome === undefined ? undefined : fixtureOutcome(episode.outcome);
    return {
      id: fixtureString(episode.id, `reference fixture episode ${String(index)} id`),
      ...(parentEpisodeId === undefined ? {} : { parentEpisodeId }),
      ...(episodeClass === undefined ? {} : { episodeClass }),
      scope: createExactScopePolicy().validate(episode.scope),
      openedAt: fixtureString(episode.openedAt, `reference fixture episode ${String(index)} openedAt`),
      ...(closedAt === undefined ? {} : { closedAt }),
      ...(outcome === undefined ? {} : { outcome }),
    };
  });
  return { observations, episodes };
}

export function createReferenceHarness(
  input: {
    readonly bundle?: ReferenceDetectorBundle;
    readonly profileMode?: "full" | "absent";
    readonly profileOptions?: Parameters<typeof createHostReferenceProfile>[2];
    readonly store?: LearningStore;
    readonly sourceAdapter?: EvidenceSource<ManualEvidenceInput>;
  } = {},
): ReferenceHarness {
  const bundle = input.bundle ?? createReferenceBundle();
  const scopePolicy = createExactScopePolicy();
  const source = defineSourceRegistration({
    source: input.sourceAdapter ?? createManualEvidenceSource(),
    trustCeiling: "observed",
    contentPolicyId: REFERENCE_CONTENT_POLICY_ID,
  });
  const profile =
    input.profileMode === "absent" ? undefined : createHostReferenceProfile(bundle, source, input.profileOptions);
  const store = input.store ?? createInMemoryStore();
  const identity = createTestIdentityPort();
  const contentPolicy = createStructuredContentPolicy({ id: REFERENCE_CONTENT_POLICY_ID });
  const learning = createLearningLoop({
    store,
    policy: conservativePolicy(),
    identity,
    scopePolicy,
    contentPolicies: [contentPolicy],
    sources: [source],
    semanticRegistry: createReferenceRegistry(bundle, profile === undefined ? [] : [profile]),
    detectorImplementations: [...bundle.coreStructural.implementations, ...bundle.referenceOperational.implementations],
    queryCursorScope: `reference-detectors-${bundle.hostBindingDigest}`,
  });
  return {
    bundle,
    store,
    learning,
    source,
    ...(profile === undefined ? {} : { profile }),
    scopePolicy,
    identity,
  };
}

export function recomputePackDigest(pack: DetectorPackManifest): string {
  return detectorPackManifestDigest(pack);
}
