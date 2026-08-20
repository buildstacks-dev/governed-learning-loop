import { sha256HexOfCanonicalJson } from "../canonical/canonical-json.js";
import type { JsonValue } from "../canonical/json.js";
import { toJsonValue } from "../canonical/to-json-value.js";
import { defineDetectorImplementation } from "../engine/detector-implementation.js";
import { invalid, readFields } from "../parse/toolkit.js";
import type { DetectorPackManifest } from "../records/detector-pack.js";
import { detectorPackManifestDigest, parseDetectorPackManifest } from "../records/detector-pack.js";
import type { DetectorRegistration } from "../records/detector-registration.js";
import { detectorRegistrationDigest, parseDetectorRegistration } from "../records/detector-registration.js";
import type { LearningLensRegistration } from "../records/learning-lens.js";
import { parseLearningLensRegistration } from "../records/learning-lens.js";
import type { DetectorRef, JsonObject, LearningClass, LensRef } from "../records/semantic-shared.js";
import {
  detectorRefKey,
  lensRefKey,
  MAX_SET_VALUES,
  parseBoundedArray,
  parseDigestAt,
  parseId,
  parseJsonObject,
} from "../records/semantic-shared.js";
import {
  CONTEXT_CAPABILITY,
  CONTEXT_COMPACTION_KIND,
  CONTEXT_UTILIZATION_KIND,
  COORDINATION_CAPABILITY,
  COORDINATION_POPULATION_KIND,
  evaluateReferenceDetector,
  INTERACTION_CAPABILITY,
  INTERACTION_TURN_KIND,
  OPERATION_CAPABILITY,
  OPERATION_KIND,
  parseReferenceDetectorPolicy,
  TRAFFIC_CAPABILITY,
} from "./evaluate.js";
import { REFERENCE_FIXTURES } from "./fixtures.js";
import type { ReferenceDetectorBundle, ReferenceDetectorFamily, ReferenceDetectorPackFragment } from "./types.js";

const CATALOG_VERSION: "0.1.0" = "0.1.0";
const MAX_REGISTRATION_NAMESPACE_LENGTH = 850;
const REQUIRED_LEARNING_CLASSES: readonly LearningClass[] = [
  "human_agent_interaction",
  "mechanical_execution",
  "system_meta",
];

interface ParsedBundleInput {
  readonly registrationNamespace: string;
  readonly scopePolicyDigest: string;
  readonly lenses: readonly LearningLensRegistration[];
}

interface DetectorSpec {
  readonly family: ReferenceDetectorFamily;
  readonly distribution: "core_structural" | "reference_operational";
  readonly requiredCapabilities: readonly string[];
  readonly acceptedObservationKinds: readonly string[];
  readonly configuration: JsonObject;
  readonly thresholds: JsonObject | null;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

function jsonObject(input: unknown): JsonObject {
  return parseJsonObject(input, []);
}

function exactLensRef(lens: LearningLensRegistration): LensRef {
  return { id: lens.id, version: lens.version, registrationDigest: lens.registrationDigest };
}

function exactDetectorRef(detector: DetectorRegistration): DetectorRef {
  return { id: detector.id, version: detector.version, registrationDigest: detector.registrationDigest };
}

function parseLens(input: unknown): LearningLensRegistration {
  return parseLearningLensRegistration(input);
}

function parseInput(input: unknown): ParsedBundleInput {
  const fields = readFields(input, []);
  fields.schemaVersion1();
  const registrationNamespace = fields.req("registrationNamespace", parseId);
  if (registrationNamespace.length > MAX_REGISTRATION_NAMESPACE_LENGTH) {
    throw invalid("config.invalid", "reference detector registration namespace is too long", ["registrationNamespace"]);
  }
  const scopePolicyDigest = fields.req("scopePolicyDigest", parseDigestAt);
  const parsedLenses = fields.req("lenses", parseBoundedArray(parseLens, MAX_SET_VALUES, "reference detector lenses"));
  if (parsedLenses.length === 0) {
    throw invalid("config.invalid", "reference detector bundle requires at least one exact learning lens", ["lenses"]);
  }
  const lenses = [...parsedLenses].sort((left, right) =>
    compareText(lensRefKey(exactLensRef(left)), lensRefKey(exactLensRef(right))),
  );
  const exactRefs = new Set<string>();
  const logicalVersions = new Set<string>();
  for (const [index, lens] of lenses.entries()) {
    const exactKey = lensRefKey(exactLensRef(lens));
    const logicalKey = JSON.stringify([lens.id, lens.version]);
    if (exactRefs.has(exactKey) || logicalVersions.has(logicalKey)) {
      throw invalid("config.invalid", "reference detector lenses must be unique by exact id and version", [
        "lenses",
        index,
      ]);
    }
    exactRefs.add(exactKey);
    logicalVersions.add(logicalKey);
    if (lens.scopePolicyDigest !== scopePolicyDigest) {
      throw invalid("config.invalid", "reference detector lens scope policy does not match the bundle", [
        "lenses",
        index,
        "scopePolicyDigest",
      ]);
    }
    if (!lens.generatorPolicy.allowedKinds.includes("deterministic")) {
      throw invalid("config.invalid", "reference detector lenses must allow deterministic generation", [
        "lenses",
        index,
        "generatorPolicy",
      ]);
    }
    if (
      lens.requiredFingerprintKinds.some((kind) => kind !== "implementation") ||
      lens.requiredCalibrationIds.length !== 0
    ) {
      throw invalid("config.invalid", "reference detector lens runtime requirements are not deterministic-only", [
        "lenses",
        index,
      ]);
    }
    if (lens.evidenceRequirements.length !== 1 || lens.evidenceRequirements[0]?.kind !== "observation") {
      throw invalid("config.invalid", "reference detector lenses must use exact observation-only evidence", [
        "lenses",
        index,
        "evidenceRequirements",
      ]);
    }
    if (REQUIRED_LEARNING_CLASSES.some((learningClass) => !lens.learningClasses.includes(learningClass))) {
      throw invalid("config.invalid", "reference detector lenses must admit every shipped learning class", [
        "lenses",
        index,
        "learningClasses",
      ]);
    }
  }
  return { registrationNamespace, scopePolicyDigest, lenses };
}

const VOCABULARY_CONTENT: JsonValue = toJsonValue({
  schemaVersion: 1,
  id: "cormidia.reference-observation-vocabulary",
  version: CATALOG_VERSION,
  capabilities: [
    CONTEXT_CAPABILITY,
    COORDINATION_CAPABILITY,
    INTERACTION_CAPABILITY,
    OPERATION_CAPABILITY,
    TRAFFIC_CAPABILITY,
  ].sort(compareText),
  observationKinds: [
    CONTEXT_COMPACTION_KIND,
    CONTEXT_UTILIZATION_KIND,
    COORDINATION_POPULATION_KIND,
    INTERACTION_TURN_KIND,
    OPERATION_KIND,
  ].sort(compareText),
  observationSchemas: [
    {
      kind: CONTEXT_COMPACTION_KIND,
      fields: {
        sequence: { type: "safe_integer", minimum: 0 },
        beforeUtilizationBasisPoints: { type: "safe_integer", minimum: 0, maximum: 10_000 },
        afterUtilizationBasisPoints: { type: "safe_integer", minimum: 0, maximum: 10_000 },
        trafficClass: {
          type: "enum",
          values: ["automated", "benchmark", "delegated", "guardian", "primary", "replay", "reviewer"],
        },
      },
      constraints: [
        "afterUtilizationBasisPoints < beforeUtilizationBasisPoints",
        "sequence_unique_across_context_kinds_per_episode",
      ],
      unknownFieldPolicy: "ignored",
    },
    {
      kind: CONTEXT_UTILIZATION_KIND,
      fields: {
        sequence: { type: "safe_integer", minimum: 0 },
        utilizationBasisPoints: { type: "safe_integer", minimum: 0, maximum: 10_000 },
        trafficClass: {
          type: "enum",
          values: ["automated", "benchmark", "delegated", "guardian", "primary", "replay", "reviewer"],
        },
      },
      constraints: ["sequence_unique_across_context_kinds_per_episode"],
      unknownFieldPolicy: "ignored",
    },
    {
      kind: COORDINATION_POPULATION_KIND,
      fields: {
        closedPopulation: { type: "boolean", requiredValue: true },
        trafficClass: { type: "enum", values: ["delegated"] },
      },
      constraints: ["exactly_one_marker", "marker_episode_is_root"],
      unknownFieldPolicy: "ignored",
    },
    {
      kind: INTERACTION_TURN_KIND,
      fields: {
        sequence: { type: "safe_integer", minimum: 0 },
        actor: { type: "enum", values: ["agent", "human"] },
        correction: { type: "boolean" },
        replyToSequence: { type: "nullable_safe_integer", minimum: 0 },
        trafficClass: {
          type: "enum",
          values: ["automated", "benchmark", "delegated", "guardian", "primary", "replay", "reviewer"],
        },
      },
      constraints: ["sequence_unique_per_episode", "reply_target_earlier_in_same_episode"],
      unknownFieldPolicy: "ignored",
    },
    {
      kind: OPERATION_KIND,
      fields: {
        sequence: { type: "safe_integer", minimum: 0 },
        intent: { type: "enum", values: ["progress", "status_poll", "tool", "wait"] },
        state: { type: "enum", values: ["changed", "failed", "succeeded", "unchanged", "unknown"] },
        operationClass: { type: "bounded_control_free_id", maximumCodeUnits: 1_000 },
        targetKeyedDigest: { type: "lowercase_sha256", treatment: "tenant_keyed" },
        signatureKeyedDigest: { type: "lowercase_sha256", treatment: "tenant_keyed" },
        trafficClass: {
          type: "enum",
          values: ["automated", "benchmark", "delegated", "guardian", "primary", "replay", "reviewer"],
        },
      },
      constraints: ["sequence_unique_per_episode"],
      unknownFieldPolicy: "ignored",
    },
  ],
  rules: {
    keyedIdentity: "tenant_keyed_sha256",
    sequence: "nonnegative_safe_integer_unique_per_episode",
    traffic: "explicit_closed_classification",
    malformedTargetedData: "fail_closed",
    population: "single_source_closed_episodes",
  },
});
const OBSERVATION_VOCABULARY_DIGEST = sha256HexOfCanonicalJson(VOCABULARY_CONTENT);
const NORMALIZATION_POLICY_DIGEST = sha256HexOfCanonicalJson({
  domain: "reference-detector-normalization",
  catalogVersion: CATALOG_VERSION,
  vocabularyDigest: OBSERVATION_VOCABULARY_DIGEST,
});
const PRIVACY_POLICY_DIGEST = sha256HexOfCanonicalJson({
  domain: "reference-detector-privacy",
  catalogVersion: CATALOG_VERSION,
  rawIdentifiersInOutput: "forbidden",
  recurrenceLocator: "forbidden",
});

const DETECTOR_SPECS: readonly DetectorSpec[] = [
  {
    family: "coordination_attribution_integrity",
    distribution: "core_structural",
    requiredCapabilities: [COORDINATION_CAPABILITY, TRAFFIC_CAPABILITY].sort(compareText),
    acceptedObservationKinds: [COORDINATION_POPULATION_KIND],
    configuration: jsonObject({
      algorithm: "closed-parent-graph-integrity",
      closedEpisodePopulation: true,
      closedPopulationRequired: true,
      singleSourcePopulation: true,
      trafficClass: "delegated",
    }),
    thresholds: null,
  },
  {
    family: "attributed_human_redirection",
    distribution: "reference_operational",
    requiredCapabilities: [INTERACTION_CAPABILITY, TRAFFIC_CAPABILITY].sort(compareText),
    acceptedObservationKinds: [INTERACTION_TURN_KIND],
    configuration: jsonObject({
      algorithm: "exact-cited-human-to-agent-pairs",
      closedEpisodePopulation: true,
      eligibleTrafficClass: "primary",
      excludedTrafficClasses: ["automated", "benchmark", "delegated", "guardian", "replay", "reviewer"],
      singleSourcePopulation: true,
    }),
    thresholds: jsonObject({ minimumDistinctEpisodes: 2, minimumExactPairs: 2 }),
  },
  {
    family: "context_pressure_compaction",
    distribution: "reference_operational",
    requiredCapabilities: [CONTEXT_CAPABILITY, TRAFFIC_CAPABILITY].sort(compareText),
    acceptedObservationKinds: [CONTEXT_COMPACTION_KIND, CONTEXT_UTILIZATION_KIND].sort(compareText),
    configuration: jsonObject({
      algorithm: "ordered-utilization-and-explicit-compaction",
      closedEpisodePopulation: true,
      compactionInferenceFromTokenDrop: "forbidden",
      eligibleTrafficClass: "primary",
      singleSourcePopulation: true,
    }),
    thresholds: jsonObject({
      highUtilizationBasisPoints: 9_000,
      minimumConsecutiveHighSamples: 3,
      minimumExplicitCompactions: 2,
    }),
  },
  {
    family: "coordination_fanout",
    distribution: "reference_operational",
    requiredCapabilities: [COORDINATION_CAPABILITY, TRAFFIC_CAPABILITY].sort(compareText),
    acceptedObservationKinds: [COORDINATION_POPULATION_KIND],
    configuration: jsonObject({
      algorithm: "closed-parent-graph-fanout",
      closedEpisodePopulation: true,
      closedPopulationRequired: true,
      singleSourcePopulation: true,
      trafficClass: "delegated",
    }),
    thresholds: jsonObject({ minimumDescendants: 6, minimumDirectChildren: 4 }),
  },
  {
    family: "repeated_status_polling",
    distribution: "reference_operational",
    requiredCapabilities: [OPERATION_CAPABILITY, TRAFFIC_CAPABILITY].sort(compareText),
    acceptedObservationKinds: [OPERATION_KIND],
    configuration: jsonObject({
      algorithm: "consecutive-unchanged-keyed-target",
      closedEpisodePopulation: true,
      eligibleTrafficClass: "primary",
      progressBreaksRun: true,
      singleSourcePopulation: true,
    }),
    thresholds: jsonObject({ minimumConsecutiveUnchangedPolls: 4 }),
  },
  {
    family: "tool_use_concentration",
    distribution: "reference_operational",
    requiredCapabilities: [OPERATION_CAPABILITY, TRAFFIC_CAPABILITY].sort(compareText),
    acceptedObservationKinds: [OPERATION_KIND],
    configuration: jsonObject({
      algorithm: "complete-operation-denominator",
      closedEpisodePopulation: true,
      eligibleIntent: "tool",
      eligibleTrafficClass: "primary",
      singleSourcePopulation: true,
    }),
    thresholds: jsonObject({
      dominantOperationClassBasisPoints: 7_500,
      minimumCompletedOperations: 12,
      minimumRepeatedSignatureCount: 4,
    }),
  },
];

function fixtureDigests(family: ReferenceDetectorFamily, control: "positive" | "negative"): readonly string[] {
  return REFERENCE_FIXTURES.filter((fixture) => fixture.detectorFamily === family && fixture.control === control)
    .map((fixture) => fixture.fixtureDigest)
    .sort(compareText);
}

function detectorId(namespace: string, family: ReferenceDetectorFamily, hostBindingDigest: string): string {
  return `${namespace}.reference.${family}.${hostBindingDigest}`;
}

function buildDetector(input: {
  readonly namespace: string;
  readonly hostBindingDigest: string;
  readonly scopePolicyDigest: string;
  readonly lensRefs: readonly LensRef[];
  readonly spec: DetectorSpec;
}): DetectorRegistration {
  const configuration = jsonObject({ ...input.spec.configuration, family: input.spec.family });
  const thresholds = input.spec.thresholds;
  const falsePositivePolicy = jsonObject({
    countsAloneEstablishNoQualityClaim: true,
    complexLegitimateControlsRequired: input.spec.family === "tool_use_concentration",
    family: input.spec.family,
    malformedOrOpenDomainState: "fail_closed",
    negativeControlsRequired: true,
  });
  const proposedValidationCriterion = jsonObject({
    candidateUtilityClaim: "none",
    heldOutCalibrationOwner: "issue-26",
    requiredControls: ["negative", "positive"],
  });
  const base: Omit<DetectorRegistration, "schemaVersion" | "registrationDigest"> = {
    id: detectorId(input.namespace, input.spec.family, input.hostBindingDigest),
    version: CATALOG_VERSION,
    maturity: "experimental",
    implementationDigest: sha256HexOfCanonicalJson({
      catalogVersion: CATALOG_VERSION,
      family: input.spec.family,
      implementation: "cormidia-reference-detector",
    }),
    configuration,
    configurationDigest: sha256HexOfCanonicalJson(configuration),
    thresholds,
    thresholdDigest: thresholds === null ? null : sha256HexOfCanonicalJson(thresholds),
    observationVocabularyDigest: OBSERVATION_VOCABULARY_DIGEST,
    requiredCapabilities: input.spec.requiredCapabilities,
    acceptedObservationKinds: input.spec.acceptedObservationKinds,
    minimumTrust: "advisory",
    minimumCompleteness: "complete",
    episodeClasses: { mode: "any" },
    scopePolicyDigest: input.scopePolicyDigest,
    scopeConstraint: { mode: "invocation" },
    lensConstraint: { mode: "required", selection: "allowlist", registrations: input.lensRefs },
    normalizationPolicyDigest: NORMALIZATION_POLICY_DIGEST,
    comparabilityPolicyDigest: null,
    outputKind: "insight_derivation",
    positiveFixtureDigests: fixtureDigests(input.spec.family, "positive"),
    negativeFixtureDigests: fixtureDigests(input.spec.family, "negative"),
    falsePositivePolicy,
    falsePositivePolicyDigest: sha256HexOfCanonicalJson(falsePositivePolicy),
    calibrationPopulation: null,
    calibrationPopulationDigest: null,
    calibrationEvidenceDigest: null,
    privacy: {
      signatureTreatment: "none",
      transientContent: "forbidden",
      policyDigest: PRIVACY_POLICY_DIGEST,
    },
    proposedValidationCriterion,
    proposedValidationCriterionDigest: sha256HexOfCanonicalJson(proposedValidationCriterion),
    supersedes: null,
  };
  return parseDetectorRegistration({
    schemaVersion: 1,
    ...base,
    registrationDigest: detectorRegistrationDigest(base),
  });
}

function buildPack(input: {
  readonly namespace: string;
  readonly hostBindingDigest: string;
  readonly kind: "core_structural" | "reference_operational";
  readonly detectors: readonly DetectorRegistration[];
  readonly lensRefs: readonly LensRef[];
}): DetectorPackManifest {
  const detectors = input.detectors
    .map(exactDetectorRef)
    .sort((left, right) => compareText(detectorRefKey(left), detectorRefKey(right)));
  const family = input.kind === "core_structural" ? "core_structural" : "reference_operational";
  const base: Omit<DetectorPackManifest, "schemaVersion" | "manifestDigest"> = {
    id: `${input.namespace}.reference.${family}.${input.hostBindingDigest}`,
    version: CATALOG_VERSION,
    kind: input.kind,
    detectors,
    lenses: input.lensRefs,
    changelogDigest: sha256HexOfCanonicalJson({
      catalogVersion: CATALOG_VERSION,
      detectorRegistrationDigests: detectors.map((detector) => detector.registrationDigest),
      family,
    }),
    supersedes: null,
  };
  return parseDetectorPackManifest({
    schemaVersion: 1,
    ...base,
    manifestDigest: detectorPackManifestDigest(base),
  });
}

function buildFragment(input: {
  readonly namespace: string;
  readonly hostBindingDigest: string;
  readonly kind: "core_structural" | "reference_operational";
  readonly detectors: readonly DetectorRegistration[];
  readonly lensRefs: readonly LensRef[];
}): ReferenceDetectorPackFragment {
  const detectors = [...input.detectors].sort((left, right) =>
    compareText(detectorRefKey(exactDetectorRef(left)), detectorRefKey(exactDetectorRef(right))),
  );
  const implementations = detectors.map((detector) => {
    const family = DETECTOR_SPECS.find(
      (spec) => detector.id === detectorId(input.namespace, spec.family, input.hostBindingDigest),
    )?.family;
    if (family === undefined) {
      throw invalid("config.invalid", "reference detector implementation family is not registered", []);
    }
    const policy = parseReferenceDetectorPolicy(family, detector);
    return defineDetectorImplementation({
      registration: detector,
      evaluate: (window) => evaluateReferenceDetector(policy, window),
    });
  });
  return {
    pack: buildPack({
      namespace: input.namespace,
      hostBindingDigest: input.hostBindingDigest,
      kind: input.kind,
      detectors,
      lensRefs: input.lensRefs,
    }),
    detectors,
    implementations,
  };
}

export function createReferenceDetectorBundle(input: unknown): ReferenceDetectorBundle {
  const parsed = parseInput(input);
  const lensRefs = parsed.lenses.map(exactLensRef);
  const hostBindingDigest = sha256HexOfCanonicalJson(
    toJsonValue({
      domain: "reference-detector-host-binding:v1",
      registrationNamespace: parsed.registrationNamespace,
      scopePolicyDigest: parsed.scopePolicyDigest,
      lenses: lensRefs,
    }),
  );
  const detectors = DETECTOR_SPECS.map((spec) =>
    buildDetector({
      namespace: parsed.registrationNamespace,
      hostBindingDigest,
      scopePolicyDigest: parsed.scopePolicyDigest,
      lensRefs,
      spec,
    }),
  );
  const coreDetectors = detectors.filter((detector) =>
    DETECTOR_SPECS.some(
      (spec) =>
        spec.distribution === "core_structural" &&
        detector.id === detectorId(parsed.registrationNamespace, spec.family, hostBindingDigest),
    ),
  );
  const operationalDetectors = detectors.filter((detector) =>
    DETECTOR_SPECS.some(
      (spec) =>
        spec.distribution === "reference_operational" &&
        detector.id === detectorId(parsed.registrationNamespace, spec.family, hostBindingDigest),
    ),
  );
  const sourceRequirements = [...detectors]
    .sort((left, right) => compareText(left.id, right.id))
    .map((detector) => ({
      detectorId: detector.id,
      requiredCapabilities: detector.requiredCapabilities,
      acceptedObservationKinds: detector.acceptedObservationKinds,
    }));
  const bundle: ReferenceDetectorBundle = {
    schemaVersion: 1,
    catalogVersion: CATALOG_VERSION,
    registrationNamespace: parsed.registrationNamespace,
    hostBindingDigest,
    scopePolicyDigest: parsed.scopePolicyDigest,
    lenses: parsed.lenses,
    sourceRequirements: {
      observationVocabularyDigest: OBSERVATION_VOCABULARY_DIGEST,
      detectors: sourceRequirements,
    },
    coreStructural: buildFragment({
      namespace: parsed.registrationNamespace,
      hostBindingDigest,
      kind: "core_structural",
      detectors: coreDetectors,
      lensRefs,
    }),
    referenceOperational: buildFragment({
      namespace: parsed.registrationNamespace,
      hostBindingDigest,
      kind: "reference_operational",
      detectors: operationalDetectors,
      lensRefs,
    }),
    fixtures: REFERENCE_FIXTURES,
  };
  return deepFreeze(bundle);
}
