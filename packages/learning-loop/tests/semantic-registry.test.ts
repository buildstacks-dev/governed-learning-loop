// #30b1 semantic registry and normalized-source profile conformance.
import { describe, expect, it } from "vitest";
import type {
  DetectorPackManifest,
  DetectorRegistration,
  LearningLensRegistration,
  RegisteredSource,
  ScopePolicy,
  SemanticRegistryConfig,
  SourceSemanticProfile,
} from "../src/index.js";
import {
  conservativePolicy,
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
  scopeDigest,
  semanticRegistryDigest,
  sha256HexOfCanonicalJson,
  sourceSemanticProfileDigest,
  toJsonValue,
} from "../src/index.js";
import type { ManualEvidenceInput } from "../src/testing/index.js";
import {
  createExactScopePolicy,
  createInMemoryStore,
  createManualEvidenceSource,
  createStructuredContentPolicy,
  createTestIdentityPort,
} from "../src/testing/index.js";

const CONTENT_POLICY_ID = "semantic-registry-structured";
const PROJECT_SCOPE = [{ type: "project", id: "semantic-project" }] as const;

function digest(value: unknown): string {
  return sha256HexOfCanonicalJson(toJsonValue(value));
}

function canonicalKey(value: unknown): string {
  return JSON.stringify(toJsonValue(value));
}

function sorted<T>(values: readonly T[], key: (value: T) => string): readonly T[] {
  return [...values].sort((left, right) => {
    const a = key(left);
    const b = key(right);
    return a < b ? -1 : a > b ? 1 : 0;
  });
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

function lens(input: {
  readonly scopePolicyDigest: string;
  readonly id?: string;
  readonly version?: string;
  readonly objective?: string;
}): LearningLensRegistration {
  const objective = input.objective ?? "Interpret operational evidence for a host-defined purpose.";
  const qualitativeRubric = { relevance: "required", uncertainty: "explicit" };
  const validationStrategy = { method: "held-out-comparable-episodes" };
  const base: Omit<LearningLensRegistration, "schemaVersion" | "registrationDigest"> = {
    id: input.id ?? "host-purpose",
    version: input.version ?? "1.0.0",
    objective,
    objectiveDigest: digest(objective),
    scopePolicyDigest: input.scopePolicyDigest,
    applicableScopes: {
      mode: "exact",
      scopes: [{ scope: PROJECT_SCOPE, scopeDigest: scopeDigest(PROJECT_SCOPE) }],
    },
    episodeClasses: { mode: "include", values: ["interactive"] },
    learningClasses: ["system_meta"],
    evidenceRequirements: [{ kind: "observation", minimumTrust: "advisory", minimumCompleteness: "partial" }],
    qualitativeRubric,
    qualitativeRubricDigest: digest(qualitativeRubric),
    requiredFingerprintKinds: ["implementation"],
    requiredCalibrationIds: [],
    permittedDestinationIds: ["host/report-note"],
    permittedDestinationKinds: ["report-note"],
    generatorPolicy: {
      allowedKinds: ["deterministic"],
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

function detector(input: {
  readonly scopePolicyDigest: string;
  readonly lens: LearningLensRegistration;
  readonly id?: string;
  readonly version?: string;
  readonly configurationTag?: string;
  readonly maturity?: DetectorRegistration["maturity"];
  readonly supersedes?: DetectorRegistration["supersedes"];
  readonly outputKind?: DetectorRegistration["outputKind"];
  readonly lensConstraint?: DetectorRegistration["lensConstraint"];
}): DetectorRegistration {
  const configuration = { tag: input.configurationTag ?? "baseline" };
  const falsePositivePolicy = { policy: "fixture-calibrated" };
  const proposedValidationCriterion = { metric: "repeat-rate", direction: "decrease" };
  const base: Omit<DetectorRegistration, "schemaVersion" | "registrationDigest"> = {
    id: input.id ?? "host.detector",
    version: input.version ?? "1.0.0",
    maturity: input.maturity ?? "experimental",
    implementationDigest: "5".repeat(64),
    configuration,
    configurationDigest: digest(configuration),
    thresholds: null,
    thresholdDigest: null,
    observationVocabularyDigest: "6".repeat(64),
    requiredCapabilities: ["operation.state"],
    acceptedObservationKinds: ["operation.completed"],
    minimumTrust: "advisory",
    minimumCompleteness: "partial",
    episodeClasses: { mode: "include", values: ["interactive"] },
    scopePolicyDigest: input.scopePolicyDigest,
    scopeConstraint: { mode: "invocation" },
    lensConstraint: input.lensConstraint ?? {
      mode: "required",
      selection: "allowlist",
      registrations: [lensRef(input.lens)],
    },
    normalizationPolicyDigest: "7".repeat(64),
    comparabilityPolicyDigest: null,
    outputKind: input.outputKind ?? "insight_derivation",
    positiveFixtureDigests: ["8".repeat(64)],
    negativeFixtureDigests: ["9".repeat(64)],
    falsePositivePolicy,
    falsePositivePolicyDigest: digest(falsePositivePolicy),
    calibrationPopulation: null,
    calibrationPopulationDigest: null,
    calibrationEvidenceDigest: null,
    privacy: {
      signatureTreatment: "public_structural",
      transientContent: "forbidden",
      policyDigest: "a".repeat(64),
    },
    proposedValidationCriterion,
    proposedValidationCriterionDigest: digest(proposedValidationCriterion),
    supersedes: input.supersedes ?? null,
  };
  return parseDetectorRegistration({
    schemaVersion: 1,
    ...base,
    registrationDigest: detectorRegistrationDigest(base),
  });
}

function pack(input: {
  readonly detectors: readonly DetectorRegistration[];
  readonly lenses: readonly LearningLensRegistration[];
  readonly id?: string;
  readonly version?: string;
}): DetectorPackManifest {
  const base: Omit<DetectorPackManifest, "schemaVersion" | "manifestDigest"> = {
    id: input.id ?? "host-pack",
    version: input.version ?? "1.0.0",
    kind: "host",
    detectors: sorted(input.detectors.map(detectorRef), canonicalKey),
    lenses: sorted(input.lenses.map(lensRef), canonicalKey),
    changelogDigest: "b".repeat(64),
    supersedes: null,
  };
  return parseDetectorPackManifest({
    schemaVersion: 1,
    ...base,
    manifestDigest: detectorPackManifestDigest(base),
  });
}

function profile(input: {
  readonly sourceId: string;
  readonly sourceRegistrationRevision: string;
  readonly vocabularyDigest?: string;
  readonly capabilities?: readonly string[];
  readonly kinds?: readonly string[];
}): SourceSemanticProfile {
  const base: Omit<SourceSemanticProfile, "schemaVersion" | "profileDigest"> = {
    sourceId: input.sourceId,
    sourceRegistrationRevision: input.sourceRegistrationRevision,
    observationVocabularyDigest: input.vocabularyDigest ?? "6".repeat(64),
    capabilities: input.capabilities ?? ["operation.state"],
    observationKinds: input.kinds ?? ["operation.completed"],
  };
  return parseSourceSemanticProfile({
    schemaVersion: 1,
    ...base,
    profileDigest: sourceSemanticProfileDigest(base),
  });
}

function registry(input: {
  readonly scopePolicyDigest: string;
  readonly detectors: readonly DetectorRegistration[];
  readonly packs: readonly DetectorPackManifest[];
  readonly lenses: readonly LearningLensRegistration[];
  readonly sourceProfiles?: readonly SourceSemanticProfile[];
  readonly selectedDetectorRefs?: SemanticRegistryConfig["selectedDetectorRefs"];
  readonly selectedPackRefs?: SemanticRegistryConfig["selectedPackRefs"];
  readonly selectedLensRefs?: SemanticRegistryConfig["selectedLensRefs"];
}): SemanticRegistryConfig {
  const base: Omit<SemanticRegistryConfig, "schemaVersion" | "registryDigest"> = {
    scopePolicyDigest: input.scopePolicyDigest,
    detectors: sorted(input.detectors, (value) => canonicalKey(detectorRef(value))),
    packs: sorted(input.packs, (value) => canonicalKey(packRef(value))),
    lenses: sorted(input.lenses, (value) => canonicalKey(lensRef(value))),
    sourceProfiles: sorted(input.sourceProfiles ?? [], (value) =>
      canonicalKey([value.sourceId, value.sourceRegistrationRevision, value.profileDigest]),
    ),
    selectedDetectorRefs: input.selectedDetectorRefs ?? sorted(input.detectors.map(detectorRef), canonicalKey),
    selectedPackRefs: input.selectedPackRefs ?? sorted(input.packs.map(packRef), canonicalKey),
    selectedLensRefs: input.selectedLensRefs ?? sorted(input.lenses.map(lensRef), canonicalKey),
  };
  return parseSemanticRegistryConfig({
    schemaVersion: 1,
    ...base,
    registryDigest: semanticRegistryDigest(base),
  });
}

function manualSource(): RegisteredSource<ManualEvidenceInput> {
  return defineSourceRegistration({
    source: createManualEvidenceSource(),
    trustCeiling: "observed",
    contentPolicyId: CONTENT_POLICY_ID,
  });
}

function createLoop(input: {
  readonly source: RegisteredSource<ManualEvidenceInput>;
  readonly scopePolicy: ScopePolicy;
  readonly semanticRegistry?: SemanticRegistryConfig;
}) {
  return createLearningLoop({
    store: createInMemoryStore(),
    policy: conservativePolicy(),
    identity: createTestIdentityPort(),
    scopePolicy: input.scopePolicy,
    contentPolicies: [createStructuredContentPolicy({ id: CONTENT_POLICY_ID })],
    sources: [input.source],
    ...(input.semanticRegistry === undefined ? {} : { semanticRegistry: input.semanticRegistry }),
  });
}

describe("SourceSemanticProfile", () => {
  it("round-trips unknown, drops unknown fields, binds every field, and pins a golden", () => {
    const source = manualSource();
    const value = profile({ sourceId: source.id, sourceRegistrationRevision: source.registryRevision });
    expect(parseSourceSemanticProfile({ ...value, future: true })).toEqual(value);
    expect(value.profileDigest).toBe("b1f8db678a6af48412f323c655a9ff929ff0d797bb6da44a37560c57f3125eec");
    expect(sourceSemanticProfileDigest({ ...value, observationVocabularyDigest: "0".repeat(64) })).not.toBe(
      value.profileDigest,
    );
    expect(() => parseSourceSemanticProfile({ ...value, sourceId: "changed" })).toThrowError(
      expect.objectContaining({ code: "schema.corrupt" }),
    );
  });

  it("rejects schema/missing/wrong types, slash source ids, and unsorted or duplicate sets", () => {
    const source = manualSource();
    const value = profile({ sourceId: source.id, sourceRegistrationRevision: source.registryRevision });
    expect(() => parseSourceSemanticProfile({ ...value, schemaVersion: 2 })).toThrowError(
      expect.objectContaining({ code: "schema.unsupported_version" }),
    );
    expect(() => parseSourceSemanticProfile({ ...value, capabilities: 42 })).toThrowError(
      expect.objectContaining({ code: "schema.invalid" }),
    );
    expect(() => parseSourceSemanticProfile({ ...value, sourceId: "host/source" })).toThrowError(
      expect.objectContaining({ code: "schema.invalid" }),
    );
    for (const mutation of [
      { capabilities: ["z", "a"] },
      { capabilities: ["a", "a"] },
      { observationKinds: ["z", "a"] },
      { observationKinds: ["a", "a"] },
    ]) {
      expect(() => parseSourceSemanticProfile({ ...value, ...mutation })).toThrowError(
        expect.objectContaining({ code: "schema.invalid" }),
      );
    }
  });
});

describe("SemanticRegistryConfig", () => {
  function fixture() {
    const scopePolicy = createExactScopePolicy();
    const source = manualSource();
    const configuredLens = lens({ scopePolicyDigest: scopePolicy.digest });
    const configuredDetector = detector({ scopePolicyDigest: scopePolicy.digest, lens: configuredLens });
    const configuredPack = pack({ detectors: [configuredDetector], lenses: [configuredLens] });
    const sourceProfile = profile({ sourceId: source.id, sourceRegistrationRevision: source.registryRevision });
    const semanticRegistry = registry({
      scopePolicyDigest: scopePolicy.digest,
      detectors: [configuredDetector],
      packs: [configuredPack],
      lenses: [configuredLens],
      sourceProfiles: [sourceProfile],
    });
    return { scopePolicy, source, configuredLens, configuredDetector, configuredPack, sourceProfile, semanticRegistry };
  }

  it("round-trips exact selected refs, drops unknown fields, and pins a golden", () => {
    const { semanticRegistry } = fixture();
    expect(parseSemanticRegistryConfig({ ...semanticRegistry, future: true })).toEqual(semanticRegistry);
    expect(semanticRegistry.registryDigest).toBe("480c124c406f7f5e59bbf999d2382c77c073fbe6643606fda998563f0afd1326");
  });

  it("rejects same logical detector/lens/pack or source revision under another digest", () => {
    const value = fixture();
    const changedDetector = detector({
      scopePolicyDigest: value.scopePolicy.digest,
      lens: value.configuredLens,
      id: value.configuredDetector.id,
      version: value.configuredDetector.version,
      configurationTag: "changed",
    });
    const changedLens = lens({
      scopePolicyDigest: value.scopePolicy.digest,
      id: value.configuredLens.id,
      version: value.configuredLens.version,
      objective: "Changed objective under the same logical version.",
    });
    const changedPackBase = {
      ...value.configuredPack,
      changelogDigest: "c".repeat(64),
    };
    const changedPack = parseDetectorPackManifest({
      ...changedPackBase,
      manifestDigest: detectorPackManifestDigest(changedPackBase),
    });
    const changedProfile = profile({
      sourceId: value.source.id,
      sourceRegistrationRevision: value.source.registryRevision,
      capabilities: ["other.capability"],
    });
    for (const mutation of [
      { detectors: sorted([value.configuredDetector, changedDetector], (item) => canonicalKey(detectorRef(item))) },
      { lenses: sorted([value.configuredLens, changedLens], (item) => canonicalKey(lensRef(item))) },
      { packs: sorted([value.configuredPack, changedPack], (item) => canonicalKey(packRef(item))) },
      {
        sourceProfiles: sorted([value.sourceProfile, changedProfile], (item) =>
          canonicalKey([item.sourceId, item.sourceRegistrationRevision, item.profileDigest]),
        ),
      },
    ]) {
      const bound = { ...value.semanticRegistry, ...mutation };
      expect(() =>
        parseSemanticRegistryConfig({ ...bound, registryDigest: semanticRegistryDigest(bound) }),
      ).toThrowError(expect.objectContaining({ code: expect.stringMatching(/^(config|schema)\./) }));
    }
  });

  it("rejects missing/deprecated pack refs and selected records outside selected packs", () => {
    const value = fixture();
    const missingDetectorPack = pack({
      detectors: [
        detector({
          scopePolicyDigest: value.scopePolicy.digest,
          lens: value.configuredLens,
          id: "missing-detector",
        }),
      ],
      lenses: [value.configuredLens],
    });
    expect(() =>
      registry({
        scopePolicyDigest: value.scopePolicy.digest,
        detectors: [value.configuredDetector],
        packs: [missingDetectorPack],
        lenses: [value.configuredLens],
      }),
    ).toThrowError(expect.objectContaining({ code: "config.invalid" }));

    const deprecated = detector({
      scopePolicyDigest: value.scopePolicy.digest,
      lens: value.configuredLens,
      id: value.configuredDetector.id,
      version: "2.0.0",
      maturity: "deprecated",
      supersedes: detectorRef(value.configuredDetector),
    });
    const deprecatedPack = pack({ detectors: [deprecated], lenses: [value.configuredLens] });
    expect(() =>
      registry({
        scopePolicyDigest: value.scopePolicy.digest,
        detectors: [value.configuredDetector, deprecated],
        packs: [deprecatedPack],
        lenses: [value.configuredLens],
        selectedDetectorRefs: [detectorRef(deprecated)],
        selectedPackRefs: [packRef(deprecatedPack)],
      }),
    ).toThrowError(expect.objectContaining({ code: "config.invalid" }));

    const emptyPack = pack({ id: "empty-lens-pack", detectors: [value.configuredDetector], lenses: [] });
    expect(() =>
      registry({
        scopePolicyDigest: value.scopePolicy.digest,
        detectors: [value.configuredDetector],
        packs: [value.configuredPack, emptyPack],
        lenses: [value.configuredLens],
        selectedPackRefs: [packRef(emptyPack)],
        selectedDetectorRefs: [detectorRef(value.configuredDetector)],
        selectedLensRefs: [lensRef(value.configuredLens)],
      }),
    ).toThrowError(expect.objectContaining({ code: "config.invalid" }));
  });

  it("rejects scope-policy mismatch and unresolved insight lens constraints even when unselected", () => {
    const value = fixture();
    const wrongScopeDetector = detector({ scopePolicyDigest: "0".repeat(64), lens: value.configuredLens });
    expect(() =>
      registry({
        scopePolicyDigest: value.scopePolicy.digest,
        detectors: [wrongScopeDetector],
        packs: [],
        lenses: [value.configuredLens],
        selectedDetectorRefs: [],
        selectedPackRefs: [],
        selectedLensRefs: [],
      }),
    ).toThrowError(expect.objectContaining({ code: "config.invalid" }));

    const missingLens = lens({ scopePolicyDigest: value.scopePolicy.digest, id: "missing-lens" });
    const unresolvedLensDetector = detector({
      scopePolicyDigest: value.scopePolicy.digest,
      lens: missingLens,
      id: "unselected-but-invalid",
    });
    expect(() =>
      registry({
        scopePolicyDigest: value.scopePolicy.digest,
        detectors: [unresolvedLensDetector],
        packs: [],
        lenses: [value.configuredLens],
        selectedDetectorRefs: [],
        selectedPackRefs: [],
        selectedLensRefs: [],
      }),
    ).toThrowError(expect.objectContaining({ code: "config.invalid" }));
  });

  it("resolves exact selected membership and requires a compatible selected lens", () => {
    const value = fixture();
    expect(value.semanticRegistry.selectedDetectorRefs).toEqual([detectorRef(value.configuredDetector)]);
    expect(() =>
      registry({
        scopePolicyDigest: value.scopePolicy.digest,
        detectors: [value.configuredDetector],
        packs: [value.configuredPack],
        lenses: [value.configuredLens],
        selectedLensRefs: [],
      }),
    ).toThrowError(expect.objectContaining({ code: "config.invalid" }));
    expect(() =>
      registry({
        scopePolicyDigest: value.scopePolicy.digest,
        detectors: [value.configuredDetector],
        packs: [value.configuredPack],
        lenses: [value.configuredLens],
        selectedDetectorRefs: [{ ...detectorRef(value.configuredDetector), registrationDigest: "0".repeat(64) }],
      }),
    ).toThrowError(expect.objectContaining({ code: "config.invalid" }));

    const detectorOnlyPack = pack({
      id: "detector-only-pack",
      detectors: [value.configuredDetector],
      lenses: [],
    });
    const companionDetector = detector({
      scopePolicyDigest: value.scopePolicy.digest,
      lens: value.configuredLens,
      id: "lens-pack-companion",
      outputKind: "evidence_health",
      lensConstraint: { mode: "independent" },
    });
    const lensOnlyPack = pack({
      id: "lens-only-pack",
      detectors: [companionDetector],
      lenses: [value.configuredLens],
    });
    expect(() =>
      registry({
        scopePolicyDigest: value.scopePolicy.digest,
        detectors: [value.configuredDetector, companionDetector],
        packs: [detectorOnlyPack, lensOnlyPack],
        lenses: [value.configuredLens],
        selectedDetectorRefs: [detectorRef(value.configuredDetector)],
        selectedPackRefs: sorted([packRef(detectorOnlyPack), packRef(lensOnlyPack)], canonicalKey),
        selectedLensRefs: [lensRef(value.configuredLens)],
      }),
    ).toThrowError(expect.objectContaining({ code: "config.invalid" }));

    expect(
      registry({
        scopePolicyDigest: value.scopePolicy.digest,
        detectors: [value.configuredDetector],
        packs: [value.configuredPack],
        lenses: [value.configuredLens],
      }).selectedPackRefs,
    ).toEqual([packRef(value.configuredPack)]);
  });

  it("binds every semantic/profile field group into registry and loop registry identity", async () => {
    const value = fixture();
    const changedProfile = profile({
      sourceId: value.source.id,
      sourceRegistrationRevision: value.source.registryRevision,
      capabilities: ["operation.other"],
      kinds: ["operation.completed"],
    });
    const changedRegistry = registry({
      scopePolicyDigest: value.scopePolicy.digest,
      detectors: [value.configuredDetector],
      packs: [value.configuredPack],
      lenses: [value.configuredLens],
      sourceProfiles: [changedProfile],
    });
    const changedDetector = detector({
      scopePolicyDigest: value.scopePolicy.digest,
      lens: value.configuredLens,
      version: "1.0.1",
      configurationTag: "changed-version",
    });
    const changedDetectorPack = pack({ detectors: [changedDetector], lenses: [value.configuredLens] });
    const detectorRegistry = registry({
      scopePolicyDigest: value.scopePolicy.digest,
      detectors: [changedDetector],
      packs: [changedDetectorPack],
      lenses: [value.configuredLens],
      sourceProfiles: [value.sourceProfile],
    });
    const changedLens = lens({
      scopePolicyDigest: value.scopePolicy.digest,
      version: "1.0.1",
      objective: "Changed host purpose semantics.",
    });
    const changedLensDetector = detector({
      scopePolicyDigest: value.scopePolicy.digest,
      lens: changedLens,
      version: "1.0.1",
    });
    const changedLensPack = pack({ detectors: [changedLensDetector], lenses: [changedLens] });
    const lensRegistry = registry({
      scopePolicyDigest: value.scopePolicy.digest,
      detectors: [changedLensDetector],
      packs: [changedLensPack],
      lenses: [changedLens],
      sourceProfiles: [value.sourceProfile],
    });
    const changedPack = pack({
      detectors: [value.configuredDetector],
      lenses: [value.configuredLens],
      version: "1.0.1",
    });
    const packRegistry = registry({
      scopePolicyDigest: value.scopePolicy.digest,
      detectors: [value.configuredDetector],
      packs: [changedPack],
      lenses: [value.configuredLens],
      sourceProfiles: [value.sourceProfile],
    });
    for (const semantic of [changedRegistry, detectorRegistry, lensRegistry, packRegistry]) {
      expect(semantic.registryDigest).not.toBe(value.semanticRegistry.registryDigest);
    }

    const first = createLoop({
      source: value.source,
      scopePolicy: value.scopePolicy,
      semanticRegistry: value.semanticRegistry,
    });
    const equivalentSource = manualSource();
    const equivalentScopePolicy = createExactScopePolicy();
    const second = createLoop({
      source: equivalentSource,
      scopePolicy: equivalentScopePolicy,
      semanticRegistry: registry({
        scopePolicyDigest: equivalentScopePolicy.digest,
        detectors: [value.configuredDetector],
        packs: [value.configuredPack],
        lenses: [value.configuredLens],
        sourceProfiles: [
          profile({ sourceId: equivalentSource.id, sourceRegistrationRevision: equivalentSource.registryRevision }),
        ],
      }),
    });
    const evidence = { observations: [{ id: "allowed", episodeId: "episode", kind: "operation.completed", data: {} }] };
    const firstReceipt = await first.ingest(value.source, evidence);
    const secondReceipt = await second.ingest(equivalentSource, evidence);
    expect(secondReceipt.registryRevision).toBe(firstReceipt.registryRevision);
    const changedRevisions: string[] = [];
    for (const semanticRegistry of [changedRegistry, detectorRegistry, lensRegistry, packRegistry]) {
      const changedLoop = createLoop({ source: value.source, scopePolicy: value.scopePolicy, semanticRegistry });
      changedRevisions.push((await changedLoop.ingest(value.source, evidence)).registryRevision);
    }
    expect(new Set([firstReceipt.registryRevision, ...changedRevisions]).size).toBe(5);
  });

  it("snapshots semantic registry mutation and enforces declared kinds while profile omission remains compatible", async () => {
    const value = fixture();
    const mutableRegistry = structuredClone(value.semanticRegistry);
    const learning = createLoop({
      source: value.source,
      scopePolicy: value.scopePolicy,
      semanticRegistry: mutableRegistry,
    });
    const before = await learning.ingest(value.source, {
      observations: [{ id: "declared", episodeId: "episode", kind: "operation.completed", data: {} }],
    });
    const mutableProfile = mutableRegistry.sourceProfiles[0];
    if (mutableProfile === undefined) throw new Error("missing mutable semantic profile");
    Reflect.set(mutableProfile, "observationKinds", ["forged.kind"]);
    const after = await learning.ingest(value.source, {
      observations: [{ id: "declared-again", episodeId: "episode", kind: "operation.completed", data: {} }],
    });
    expect(after.observationIds).toHaveLength(1);
    expect(after.registryRevision).toBe(before.registryRevision);

    const refused = await learning.ingest(value.source, {
      observations: [{ id: "undeclared", episodeId: "episode", kind: "forged.kind", data: {} }],
    });
    expect(refused.observationIds).toEqual([]);
    expect(refused.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: "schema.invalid" })]));

    const compatibleRegistry = registry({
      scopePolicyDigest: value.scopePolicy.digest,
      detectors: [value.configuredDetector],
      packs: [value.configuredPack],
      lenses: [value.configuredLens],
      sourceProfiles: [],
    });
    const compatible = createLoop({
      source: value.source,
      scopePolicy: value.scopePolicy,
      semanticRegistry: compatibleRegistry,
    });
    const accepted = await compatible.ingest(value.source, {
      observations: [{ id: "legacy-kind", episodeId: "episode", kind: "unprofiled.kind", data: {} }],
    });
    expect(accepted.observationIds).toHaveLength(1);
  });

  it("rejects source profiles that do not match an exact configured source revision", () => {
    const value = fixture();
    const wrongRevision = profile({
      sourceId: value.source.id,
      sourceRegistrationRevision: "0".repeat(64),
    });
    const semanticRegistry = registry({
      scopePolicyDigest: value.scopePolicy.digest,
      detectors: [value.configuredDetector],
      packs: [value.configuredPack],
      lenses: [value.configuredLens],
      sourceProfiles: [wrongRevision],
    });
    expect(() => createLoop({ source: value.source, scopePolicy: value.scopePolicy, semanticRegistry })).toThrowError(
      expect.objectContaining({ code: "config.invalid" }),
    );
    expect(() =>
      createLoop({
        source: value.source,
        scopePolicy: createExactScopePolicy({ id: "different-loop-scope-policy" }),
        semanticRegistry: value.semanticRegistry,
      }),
    ).toThrowError(expect.objectContaining({ code: "config.invalid" }));
  });

  it("omitting semanticRegistry preserves the pre-#30b loop registry bytes", async () => {
    const source = manualSource();
    const learning = createLoop({ source, scopePolicy: createExactScopePolicy() });
    const receipt = await learning.ingest(source, { observations: [] });
    expect(receipt.registryRevision).toBe("f161559521583dc678083415bcecab5decb3ac8a5d3f75abe4f5506fd306ac82");
  });
});
