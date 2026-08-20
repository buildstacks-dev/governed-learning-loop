// Registered semantic learning records (#30a): immutable detector, pack,
// purpose-lens, and insight-derivation semantics with unknown-first parsing,
// exact digests, canonical set ordering, and host-neutral role data.
import { describe, expect, it } from "vitest";
import type {
  DetectorPackManifest,
  DetectorRegistration,
  EvidenceHealthFinding,
  EvidenceRefV1,
  InsightDerivation,
  LearningLensRegistration,
  ObservationEvidenceRef,
  Scope,
} from "../src/index.js";
import { evidenceHealthFindingDigest } from "../src/records/source-health.js";
import {
  canonicalJsonText,
  detectorPackManifestDigest,
  detectorRegistrationDigest,
  evidenceRefDigest,
  insightDerivationDigest,
  learningLensRegistrationDigest,
  parseDetectorPackManifest,
  parseDetectorRegistration,
  parseInsightDerivation,
  parseLearningLensRegistration,
  scopeDigest,
  sha256HexOfCanonicalJson,
  toJsonValue,
} from "../src/index.js";

const PROJECT_A: Scope = [{ type: "project", id: "customer-portal" }];
const PROJECT_B: Scope = [{ type: "project", id: "documentation-site" }];
const SCOPE_POLICY_DIGEST = "1".repeat(64);

function digest(value: unknown): string {
  return sha256HexOfCanonicalJson(toJsonValue(value));
}

function sorted<T>(values: readonly T[], key: (value: T) => string): readonly T[] {
  return [...values].sort((left, right) => {
    const a = key(left);
    const b = key(right);
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

function canonicalKey(value: unknown): string {
  return canonicalJsonText(toJsonValue(value));
}

function detectorDigestFromUnknown(value: unknown): string {
  const result: unknown = Reflect.apply(detectorRegistrationDigest, undefined, [value]);
  if (typeof result !== "string") throw new Error("detector digest fixture did not return text");
  return result;
}

function lensDigestFromUnknown(value: unknown): string {
  const result: unknown = Reflect.apply(learningLensRegistrationDigest, undefined, [value]);
  if (typeof result !== "string") throw new Error("lens digest fixture did not return text");
  return result;
}

function digestPopulation(
  episodes: readonly unknown[],
  normalizationPolicyDigest: string,
  comparabilityPolicyDigest: string | null,
): string {
  return digest({ episodes, normalizationPolicyDigest, comparabilityPolicyDigest });
}

function lensRegistration(input: {
  readonly id: string;
  readonly objective: string;
  readonly scope: Scope;
  readonly rubric: { readonly [key: string]: string };
  readonly destinationId: string;
  readonly destinationKind: string;
  readonly validationMetric: string;
  readonly version?: string;
  readonly supersedes?: LearningLensRegistration["supersedes"];
}): LearningLensRegistration {
  const objectiveDigest = digest(input.objective);
  const qualitativeRubric = input.rubric;
  const validationStrategy = { metric: input.validationMetric, method: "held-out-comparable-episodes" };
  const base: Omit<LearningLensRegistration, "schemaVersion" | "registrationDigest"> = {
    id: input.id,
    version: input.version ?? "1.0.0",
    objective: input.objective,
    objectiveDigest,
    scopePolicyDigest: SCOPE_POLICY_DIGEST,
    applicableScopes: {
      mode: "exact",
      scopes: [{ scope: input.scope, scopeDigest: scopeDigest(input.scope) }],
    },
    episodeClasses: { mode: "include", values: ["interactive"] },
    learningClasses: ["host:customer_service", "human_agent_interaction", "role_craft"],
    evidenceRequirements: [{ kind: "observation", minimumTrust: "advisory", minimumCompleteness: "partial" }],
    qualitativeRubric,
    qualitativeRubricDigest: digest(qualitativeRubric),
    requiredFingerprintKinds: ["implementation", "prompt"],
    requiredCalibrationIds: ["human-rubric-v1"],
    permittedDestinationIds: [input.destinationId],
    permittedDestinationKinds: [input.destinationKind],
    generatorPolicy: {
      allowedKinds: ["deterministic", "human", "semantic_judgment"],
      identityPolicyDigest: "2".repeat(64),
      fingerprintPolicyDigest: "3".repeat(64),
    },
    reviewerPolicy: {
      independentFromGenerator: true,
      identityPolicyDigest: "4".repeat(64),
      calibrationPolicyDigest: "5".repeat(64),
    },
    privacy: {
      outboundDisclosure: "explicit_disclosure_receipt",
      policyDigest: "6".repeat(64),
    },
    validationStrategy,
    validationStrategyDigest: digest(validationStrategy),
    supersedes: input.supersedes ?? null,
  };
  return parseLearningLensRegistration({
    schemaVersion: 1,
    ...base,
    registrationDigest: learningLensRegistrationDigest(base),
  });
}

const SUPPORT_LENS = lensRegistration({
  id: "support-purpose",
  objective: "Resolve customer issues accurately with safe intake and escalation.",
  scope: PROJECT_A,
  rubric: { accuracy: "required", escalation: "safe", intake: "context-complete" },
  destinationId: "support/intake-procedure",
  destinationKind: "response-procedure",
  validationMetric: "first-contact-resolution",
});

const DOCUMENTATION_LENS = lensRegistration({
  id: "documentation-purpose",
  objective: "Make product guidance findable, current, and independently usable.",
  scope: PROJECT_A,
  rubric: { coverage: "complete", findability: "high", freshness: "current" },
  destinationId: "docs/discoverability",
  destinationKind: "documentation-content",
  validationMetric: "self-service-task-success",
});

function lensRef(lens: LearningLensRegistration) {
  return { id: lens.id, version: lens.version, registrationDigest: lens.registrationDigest };
}

function detectorRegistration(
  input: {
    readonly id?: string;
    readonly version?: string;
    readonly maturity?: DetectorRegistration["maturity"];
    readonly outputKind?: DetectorRegistration["outputKind"];
    readonly lensConstraint?: DetectorRegistration["lensConstraint"];
    readonly calibration?: boolean;
    readonly supersedes?: DetectorRegistration["supersedes"];
  } = {},
): DetectorRegistration {
  const configuration = { recurrenceKey: "tenant-keyed", window: "episode" };
  const thresholds = { minimumEpisodes: 2, minimumEvents: 3 };
  const falsePositivePolicy = { maximumRate: 0.05, population: "interactive-support" };
  const calibrationPopulation = input.calibration === true ? { episodes: 250, stratum: "interactive-support" } : null;
  const proposedValidationCriterion = { metric: "repeat-redirection-rate", direction: "decrease" };
  const lenses = sorted([lensRef(DOCUMENTATION_LENS), lensRef(SUPPORT_LENS)], canonicalKey);
  const base: Omit<DetectorRegistration, "schemaVersion" | "registrationDigest"> = {
    id: input.id ?? "interaction.repeated-redirection",
    version: input.version ?? "1.0.0",
    maturity: input.maturity ?? "experimental",
    implementationDigest: "7".repeat(64),
    configuration,
    configurationDigest: digest(configuration),
    thresholds,
    thresholdDigest: digest(thresholds),
    observationVocabularyDigest: "8".repeat(64),
    requiredCapabilities: ["interaction.attribution", "interaction.correction", "session.classification"],
    acceptedObservationKinds: ["interaction.correction", "interaction.turn"],
    minimumTrust: "advisory",
    minimumCompleteness: "partial",
    episodeClasses: { mode: "include", values: ["interactive"] },
    scopePolicyDigest: SCOPE_POLICY_DIGEST,
    scopeConstraint: {
      mode: "exact",
      scopes: [{ scope: PROJECT_A, scopeDigest: scopeDigest(PROJECT_A) }],
    },
    lensConstraint: input.lensConstraint ?? { mode: "required", selection: "allowlist", registrations: lenses },
    normalizationPolicyDigest: "9".repeat(64),
    comparabilityPolicyDigest: "a".repeat(64),
    outputKind: input.outputKind ?? "insight_derivation",
    positiveFixtureDigests: sorted(["b".repeat(64), "c".repeat(64)], (value) => value),
    negativeFixtureDigests: sorted(["d".repeat(64), "e".repeat(64)], (value) => value),
    falsePositivePolicy,
    falsePositivePolicyDigest: digest(falsePositivePolicy),
    calibrationPopulation,
    calibrationPopulationDigest: calibrationPopulation === null ? null : digest(calibrationPopulation),
    calibrationEvidenceDigest: input.calibration === true ? "f".repeat(64) : null,
    privacy: {
      signatureTreatment: "tenant_keyed_private",
      transientContent: "forbidden",
      policyDigest: "0".repeat(64),
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

const DETECTOR = detectorRegistration();

function detectorRef(detector: DetectorRegistration) {
  return { id: detector.id, version: detector.version, registrationDigest: detector.registrationDigest };
}

function packManifest(
  input: {
    readonly id?: string;
    readonly version?: string;
    readonly detectors?: readonly ReturnType<typeof detectorRef>[];
    readonly lenses?: readonly ReturnType<typeof lensRef>[];
    readonly supersedes?: DetectorPackManifest["supersedes"];
  } = {},
): DetectorPackManifest {
  const base: Omit<DetectorPackManifest, "schemaVersion" | "manifestDigest"> = {
    id: input.id ?? "reference-interaction-pack",
    version: input.version ?? "1.0.0",
    kind: "reference_operational",
    detectors: input.detectors ?? [detectorRef(DETECTOR)],
    lenses: input.lenses ?? sorted([lensRef(DOCUMENTATION_LENS), lensRef(SUPPORT_LENS)], canonicalKey),
    changelogDigest: "1".repeat(64),
    supersedes: input.supersedes ?? null,
  };
  return parseDetectorPackManifest({
    schemaVersion: 1,
    ...base,
    manifestDigest: detectorPackManifestDigest(base),
  });
}

const PACK = packManifest();

function withoutField(value: object, field: string): object {
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== field));
}

describe("semantic record unknown-first parsers", () => {
  const cases: readonly {
    readonly name: string;
    readonly parse: (input: unknown) => unknown;
    readonly fixture: object;
    readonly requiredField: string;
    readonly wrongTypeField: string;
  }[] = [
    {
      name: "DetectorRegistration",
      parse: parseDetectorRegistration,
      fixture: DETECTOR,
      requiredField: "implementationDigest",
      wrongTypeField: "requiredCapabilities",
    },
    {
      name: "DetectorPackManifest",
      parse: parseDetectorPackManifest,
      fixture: PACK,
      requiredField: "detectors",
      wrongTypeField: "lenses",
    },
    {
      name: "LearningLensRegistration",
      parse: parseLearningLensRegistration,
      fixture: SUPPORT_LENS,
      requiredField: "objective",
      wrongTypeField: "learningClasses",
    },
  ];

  for (const fixtureCase of cases) {
    it(`${fixtureCase.name} round-trips valid unknown and drops unknown fields`, () => {
      expect(fixtureCase.parse(fixtureCase.fixture)).toEqual(fixtureCase.fixture);
      expect(fixtureCase.parse({ ...fixtureCase.fixture, futureField: "ignored" })).toEqual(fixtureCase.fixture);
    });

    it(`${fixtureCase.name} rejects schema, missing, wrong-typed, and non-object inputs`, () => {
      expect(() => fixtureCase.parse({ ...fixtureCase.fixture, schemaVersion: 2 })).toThrowError(
        expect.objectContaining({ code: "schema.unsupported_version" }),
      );
      expect(() => fixtureCase.parse(withoutField(fixtureCase.fixture, fixtureCase.requiredField))).toThrowError(
        expect.objectContaining({ code: "schema.invalid" }),
      );
      expect(() => fixtureCase.parse({ ...fixtureCase.fixture, [fixtureCase.wrongTypeField]: 42 })).toThrowError(
        expect.objectContaining({ code: "schema.invalid" }),
      );
      expect(() => fixtureCase.parse(null)).toThrowError(expect.objectContaining({ code: "schema.invalid" }));
    });
  }
});

describe("DetectorRegistration invariants", () => {
  it("pins a golden and rejects any stale content or registration digest", () => {
    expect(DETECTOR.registrationDigest).toBe("ba31559250859ae75ffd80e13f775125803c16bb494bb2ed19b71615876e75ed");
    expect(() => parseDetectorRegistration({ ...DETECTOR, implementationDigest: "2".repeat(64) })).toThrowError(
      expect.objectContaining({ code: "schema.corrupt" }),
    );
    expect(() => parseDetectorRegistration({ ...DETECTOR, configuration: { changed: true } })).toThrowError(
      expect.objectContaining({ code: "schema.corrupt" }),
    );
    expect(() => parseDetectorRegistration({ ...DETECTOR, thresholds: { minimumEvents: 99 } })).toThrowError(
      expect.objectContaining({ code: "schema.corrupt" }),
    );
    expect(() => parseDetectorRegistration({ ...DETECTOR, falsePositivePolicy: { changed: true } })).toThrowError(
      expect.objectContaining({ code: "schema.corrupt" }),
    );
    expect(() =>
      parseDetectorRegistration({ ...DETECTOR, proposedValidationCriterion: { changed: true } }),
    ).toThrowError(expect.objectContaining({ code: "schema.corrupt" }));
  });

  it("requires canonical SemVer", () => {
    for (const version of ["v1.0.0", "1.0", "01.0.0", "1.0.0-01", "1.0.0+"]) {
      expect(() => parseDetectorRegistration({ ...DETECTOR, version })).toThrowError(
        expect.objectContaining({ code: "schema.invalid" }),
      );
    }
    expect(detectorRegistration({ version: "1.2.3-alpha.1+build.5" }).version).toBe("1.2.3-alpha.1+build.5");
  });

  it("requires every set-like field sorted and unique", () => {
    for (const mutation of [
      { requiredCapabilities: [...DETECTOR.requiredCapabilities].reverse() },
      { requiredCapabilities: [DETECTOR.requiredCapabilities[0], DETECTOR.requiredCapabilities[0]] },
      { acceptedObservationKinds: [...DETECTOR.acceptedObservationKinds].reverse() },
      { positiveFixtureDigests: [...DETECTOR.positiveFixtureDigests].reverse() },
      { negativeFixtureDigests: [...DETECTOR.negativeFixtureDigests].reverse() },
      { episodeClasses: { mode: "include", values: ["interactive", "interactive"] } },
      {
        lensConstraint: {
          mode: "required",
          selection: "allowlist",
          registrations: [
            ...(DETECTOR.lensConstraint.mode === "required" ? DETECTOR.lensConstraint.registrations : []),
          ].reverse(),
        },
      },
    ]) {
      expect(() => parseDetectorRegistration({ ...DETECTOR, ...mutation })).toThrowError(
        expect.objectContaining({ code: "schema.invalid" }),
      );
    }
    const exactScopes = sorted(
      [
        { scope: PROJECT_A, scopeDigest: scopeDigest(PROJECT_A) },
        { scope: PROJECT_B, scopeDigest: scopeDigest(PROJECT_B) },
      ],
      (value) => value.scopeDigest,
    );
    expect(() =>
      parseDetectorRegistration({
        ...DETECTOR,
        scopeConstraint: { mode: "exact", scopes: [...exactScopes].reverse() },
      }),
    ).toThrowError(expect.objectContaining({ code: "schema.invalid" }));
  });

  it("verifies exact scope digests and nullable content/digest pairs", () => {
    expect(() =>
      parseDetectorRegistration({
        ...DETECTOR,
        scopeConstraint: { mode: "exact", scopes: [{ scope: PROJECT_A, scopeDigest: "0".repeat(64) }] },
      }),
    ).toThrowError(expect.objectContaining({ code: "schema.corrupt" }));
    expect(() => parseDetectorRegistration({ ...DETECTOR, thresholdDigest: null })).toThrowError(
      expect.objectContaining({ code: "schema.invalid" }),
    );
    expect(() =>
      parseDetectorRegistration({
        ...DETECTOR,
        calibrationPopulation: null,
        calibrationPopulationDigest: "0".repeat(64),
      }),
    ).toThrowError(expect.objectContaining({ code: "schema.invalid" }));
  });

  it("requires object-valued configuration, policies, criteria, thresholds, and calibration populations", () => {
    const requiredObjects = [
      ["configuration", "configurationDigest"],
      ["falsePositivePolicy", "falsePositivePolicyDigest"],
      ["proposedValidationCriterion", "proposedValidationCriterionDigest"],
    ] as const;
    for (const [field, digestField] of requiredObjects) {
      for (const invalidValue of [null, "text", 7, true, []]) {
        const bound = { ...DETECTOR, [field]: invalidValue, [digestField]: digest(invalidValue) };
        const registrationDigest = detectorDigestFromUnknown(bound);
        expect(() => parseDetectorRegistration({ ...bound, registrationDigest })).toThrowError(
          expect.objectContaining({ code: "schema.invalid" }),
        );
      }
    }

    const nullableObjects = [
      ["thresholds", "thresholdDigest"],
      ["calibrationPopulation", "calibrationPopulationDigest"],
    ] as const;
    for (const [field, digestField] of nullableObjects) {
      for (const invalidValue of ["text", 7, true, []]) {
        const bound = { ...DETECTOR, [field]: invalidValue, [digestField]: digest(invalidValue) };
        const registrationDigest = detectorDigestFromUnknown(bound);
        expect(() => parseDetectorRegistration({ ...bound, registrationDigest })).toThrowError(
          expect.objectContaining({ code: "schema.invalid" }),
        );
      }
    }
    const noThresholds = { ...DETECTOR, thresholds: null, thresholdDigest: null };
    expect(
      parseDetectorRegistration({
        ...noThresholds,
        registrationDigest: detectorRegistrationDigest(noThresholds),
      }).thresholds,
    ).toBeNull();
    expect(detectorRegistration({ id: "no-threshold-detector" }).calibrationPopulation).toBeNull();
  });

  it("enforces maturity, calibration, deprecation, and output/lens rules", () => {
    expect(() => parseDetectorRegistration({ ...DETECTOR, maturity: "stable" })).toThrowError(
      expect.objectContaining({ code: "schema.invalid" }),
    );
    expect(detectorRegistration({ maturity: "stable", calibration: true }).maturity).toBe("stable");
    expect(() => parseDetectorRegistration({ ...DETECTOR, maturity: "deprecated" })).toThrowError(
      expect.objectContaining({ code: "schema.invalid" }),
    );
    expect(
      detectorRegistration({
        maturity: "deprecated",
        version: "2.0.0",
        supersedes: detectorRef(DETECTOR),
      }).maturity,
    ).toBe("deprecated");
    expect(() =>
      parseDetectorRegistration({
        ...DETECTOR,
        supersedes: { ...detectorRef(DETECTOR), id: "another-detector" },
      }),
    ).toThrowError(expect.objectContaining({ code: "schema.invalid" }));
    expect(() => parseDetectorRegistration({ ...DETECTOR, lensConstraint: { mode: "independent" } })).toThrowError(
      expect.objectContaining({ code: "schema.invalid" }),
    );
    expect(
      detectorRegistration({
        id: "evidence.coverage",
        outputKind: "evidence_health",
        lensConstraint: { mode: "independent" },
      }).outputKind,
    ).toBe("evidence_health");
    expect(() =>
      parseDetectorRegistration({
        ...DETECTOR,
        outputKind: "evidence_health",
      }),
    ).toThrowError(expect.objectContaining({ code: "schema.invalid" }));
  });

  it("includes every semantic field group in registration identity", () => {
    const baseline = detectorRegistrationDigest(DETECTOR);
    const mutations: readonly DetectorRegistration[] = [
      { ...DETECTOR, id: "interaction.other" },
      { ...DETECTOR, version: "1.0.1" },
      { ...DETECTOR, maturity: "calibrated" },
      { ...DETECTOR, implementationDigest: "1".repeat(64) },
      { ...DETECTOR, configuration: { changed: true } },
      { ...DETECTOR, configurationDigest: "1".repeat(64) },
      { ...DETECTOR, thresholds: { minimumEvents: 4 } },
      { ...DETECTOR, thresholdDigest: "2".repeat(64) },
      { ...DETECTOR, observationVocabularyDigest: "3".repeat(64) },
      { ...DETECTOR, requiredCapabilities: ["other"] },
      { ...DETECTOR, acceptedObservationKinds: ["other.kind"] },
      { ...DETECTOR, minimumTrust: "observed" },
      { ...DETECTOR, minimumCompleteness: "complete" },
      { ...DETECTOR, episodeClasses: { mode: "any" } },
      { ...DETECTOR, scopePolicyDigest: "4".repeat(64) },
      { ...DETECTOR, scopeConstraint: { mode: "invocation" } },
      { ...DETECTOR, lensConstraint: { mode: "independent" } },
      { ...DETECTOR, normalizationPolicyDigest: "1".repeat(64) },
      { ...DETECTOR, comparabilityPolicyDigest: null },
      { ...DETECTOR, outputKind: "evidence_health" },
      { ...DETECTOR, positiveFixtureDigests: ["1".repeat(64)] },
      { ...DETECTOR, negativeFixtureDigests: ["2".repeat(64)] },
      { ...DETECTOR, falsePositivePolicy: { changed: true } },
      { ...DETECTOR, falsePositivePolicyDigest: "5".repeat(64) },
      { ...DETECTOR, calibrationPopulation: { population: "changed" } },
      { ...DETECTOR, calibrationPopulationDigest: "6".repeat(64) },
      { ...DETECTOR, calibrationEvidenceDigest: "7".repeat(64) },
      { ...DETECTOR, privacy: { ...DETECTOR.privacy, signatureTreatment: "mixed" } },
      { ...DETECTOR, proposedValidationCriterion: { metric: "changed" } },
      { ...DETECTOR, proposedValidationCriterionDigest: "8".repeat(64) },
      { ...DETECTOR, supersedes: detectorRef(DETECTOR) },
    ];
    for (const mutation of mutations) expect(detectorRegistrationDigest(mutation)).not.toBe(baseline);
  });
});

describe("DetectorPackManifest invariants", () => {
  it("pins exact refs and a golden", () => {
    expect(PACK.manifestDigest).toBe("1c7fd9ef2109d3a782aa3ca3672931920b5ca4097173419a30c1e1765ce75a7a");
    expect(parseDetectorPackManifest(PACK)).toEqual(PACK);
  });

  it("requires one detector and sorted unique exact detector/lens refs", () => {
    expect(() => parseDetectorPackManifest({ ...PACK, detectors: [] })).toThrowError(
      expect.objectContaining({ code: "schema.invalid" }),
    );
    expect(() =>
      parseDetectorPackManifest({ ...PACK, detectors: [PACK.detectors[0], PACK.detectors[0]] }),
    ).toThrowError(expect.objectContaining({ code: "schema.invalid" }));
    expect(() => parseDetectorPackManifest({ ...PACK, lenses: [...PACK.lenses].reverse() })).toThrowError(
      expect.objectContaining({ code: "schema.invalid" }),
    );
  });

  it("enforces SemVer, same-id supersession, digest inclusion, and tamper rejection", () => {
    expect(() => parseDetectorPackManifest({ ...PACK, version: "1" })).toThrowError(
      expect.objectContaining({ code: "schema.invalid" }),
    );
    expect(() =>
      parseDetectorPackManifest({
        ...PACK,
        supersedes: { id: "other-pack", version: "0.9.0", manifestDigest: "2".repeat(64) },
      }),
    ).toThrowError(expect.objectContaining({ code: "schema.invalid" }));
    expect(detectorPackManifestDigest({ ...PACK, changelogDigest: "3".repeat(64) })).not.toBe(PACK.manifestDigest);
    expect(
      detectorPackManifestDigest({ ...PACK, detectors: [{ ...detectorRef(DETECTOR), version: "1.0.1" }] }),
    ).not.toBe(PACK.manifestDigest);
    expect(detectorPackManifestDigest({ ...PACK, id: "other-pack" })).not.toBe(PACK.manifestDigest);
    expect(detectorPackManifestDigest({ ...PACK, version: "1.0.1" })).not.toBe(PACK.manifestDigest);
    expect(detectorPackManifestDigest({ ...PACK, kind: "host" })).not.toBe(PACK.manifestDigest);
    expect(detectorPackManifestDigest({ ...PACK, lenses: [lensRef(SUPPORT_LENS)] })).not.toBe(PACK.manifestDigest);
    expect(
      detectorPackManifestDigest({
        ...PACK,
        supersedes: { id: PACK.id, version: "0.9.0", manifestDigest: "9".repeat(64) },
      }),
    ).not.toBe(PACK.manifestDigest);
    expect(() => parseDetectorPackManifest({ ...PACK, changelogDigest: "4".repeat(64) })).toThrowError(
      expect.objectContaining({ code: "schema.corrupt" }),
    );
  });
});

describe("LearningLensRegistration invariants", () => {
  it("pins goldens and keeps Support and Documentation as ordinary host data", () => {
    expect(SUPPORT_LENS.registrationDigest).toBe("932b70e756db918cb05a3a68ec08bccda743c5a89e9495b38e4af93adec1437f");
    expect(DOCUMENTATION_LENS.registrationDigest).toBe(
      "ff8401ba7aa5d016e1a2fd5435709add35d963a0b64507117d21ca97eed9174a",
    );
    expect(SUPPORT_LENS.registrationDigest).not.toBe(DOCUMENTATION_LENS.registrationDigest);
    expect(SUPPORT_LENS.id).toBe("support-purpose");
    expect(DOCUMENTATION_LENS.id).toBe("documentation-purpose");
  });

  it("keeps two exact project scopes distinct", () => {
    const otherProject = lensRegistration({
      id: SUPPORT_LENS.id,
      version: "1.1.0",
      objective: SUPPORT_LENS.objective,
      scope: PROJECT_B,
      rubric: { accuracy: "required", escalation: "safe", intake: "context-complete" },
      destinationId: "support/intake-procedure",
      destinationKind: "response-procedure",
      validationMetric: "first-contact-resolution",
      supersedes: lensRef(SUPPORT_LENS),
    });
    expect(scopeDigest(PROJECT_A)).not.toBe(scopeDigest(PROJECT_B));
    expect(otherProject.registrationDigest).not.toBe(SUPPORT_LENS.registrationDigest);
  });

  it("registers episode population evidence as a distinct digest-bound requirement", () => {
    const { schemaVersion: _schemaVersion, registrationDigest: _registrationDigest, ...supportBase } = SUPPORT_LENS;
    const base: Omit<LearningLensRegistration, "schemaVersion" | "registrationDigest"> = {
      ...supportBase,
      evidenceRequirements: [{ kind: "episode", minimumTrust: "observed", minimumCompleteness: "complete" }],
    };
    const episodeLens = parseLearningLensRegistration({
      schemaVersion: 1,
      ...base,
      registrationDigest: learningLensRegistrationDigest(base),
    });
    expect(parseLearningLensRegistration(episodeLens)).toEqual(episodeLens);
    expect(episodeLens.registrationDigest).not.toBe(SUPPORT_LENS.registrationDigest);
    expect(episodeLens.registrationDigest).toBe("5a1558a3807aed487fd95f6e3fd0cea999d0fe0916ff39979350c23502b5da47");

    const duplicateRequirements: LearningLensRegistration["evidenceRequirements"] = [
      { kind: "episode", minimumTrust: "advisory", minimumCompleteness: "partial" },
      { kind: "episode", minimumTrust: "observed", minimumCompleteness: "complete" },
    ];
    const duplicateBase = {
      ...base,
      evidenceRequirements: duplicateRequirements,
    };
    expect(() =>
      parseLearningLensRegistration({
        schemaVersion: 1,
        ...duplicateBase,
        registrationDigest: learningLensRegistrationDigest(duplicateBase),
      }),
    ).toThrowError(expect.objectContaining({ code: "schema.invalid" }));
  });

  it("verifies objective, rubric, validation, and exact scope digests", () => {
    expect(() => parseLearningLensRegistration({ ...SUPPORT_LENS, objective: "changed" })).toThrowError(
      expect.objectContaining({ code: "schema.corrupt" }),
    );
    expect(() => parseLearningLensRegistration({ ...SUPPORT_LENS, qualitativeRubric: { changed: true } })).toThrowError(
      expect.objectContaining({ code: "schema.corrupt" }),
    );
    expect(() =>
      parseLearningLensRegistration({ ...SUPPORT_LENS, validationStrategy: { changed: true } }),
    ).toThrowError(expect.objectContaining({ code: "schema.corrupt" }));
    expect(() =>
      parseLearningLensRegistration({
        ...SUPPORT_LENS,
        applicableScopes: { mode: "exact", scopes: [{ scope: PROJECT_A, scopeDigest: "0".repeat(64) }] },
      }),
    ).toThrowError(expect.objectContaining({ code: "schema.corrupt" }));
  });

  it("requires qualitative rubric and validation strategy to be JSON objects", () => {
    for (const [field, digestField] of [
      ["qualitativeRubric", "qualitativeRubricDigest"],
      ["validationStrategy", "validationStrategyDigest"],
    ] as const) {
      for (const invalidValue of [null, "text", 7, true, []]) {
        const bound = { ...SUPPORT_LENS, [field]: invalidValue, [digestField]: digest(invalidValue) };
        const registrationDigest = lensDigestFromUnknown(bound);
        expect(() => parseLearningLensRegistration({ ...bound, registrationDigest })).toThrowError(
          expect.objectContaining({ code: "schema.invalid" }),
        );
      }
    }
  });

  it("requires sorted unique classes, requirements, fingerprints, calibrations, destinations, and generator kinds", () => {
    const mutations = [
      { learningClasses: [...SUPPORT_LENS.learningClasses].reverse() },
      { learningClasses: [SUPPORT_LENS.learningClasses[0], SUPPORT_LENS.learningClasses[0]] },
      { evidenceRequirements: [SUPPORT_LENS.evidenceRequirements[0], SUPPORT_LENS.evidenceRequirements[0]] },
      { requiredFingerprintKinds: ["prompt", "implementation"] },
      { requiredCalibrationIds: ["z", "a"] },
      { permittedDestinationIds: ["z", "a"] },
      { permittedDestinationKinds: ["z", "a"] },
      { generatorPolicy: { ...SUPPORT_LENS.generatorPolicy, allowedKinds: ["human", "deterministic"] } },
    ];
    for (const mutation of mutations) {
      expect(() => parseLearningLensRegistration({ ...SUPPORT_LENS, ...mutation })).toThrowError(
        expect.objectContaining({ code: "schema.invalid" }),
      );
    }
    const exactScopes = sorted(
      [
        { scope: PROJECT_A, scopeDigest: scopeDigest(PROJECT_A) },
        { scope: PROJECT_B, scopeDigest: scopeDigest(PROJECT_B) },
      ],
      (value) => value.scopeDigest,
    );
    expect(() =>
      parseLearningLensRegistration({
        ...SUPPORT_LENS,
        applicableScopes: { mode: "exact", scopes: [...exactScopes].reverse() },
      }),
    ).toThrowError(expect.objectContaining({ code: "schema.invalid" }));
  });

  it("enforces canonical SemVer and same-id supersession", () => {
    expect(() => parseLearningLensRegistration({ ...SUPPORT_LENS, version: "1.0" })).toThrowError(
      expect.objectContaining({ code: "schema.invalid" }),
    );
    expect(() =>
      parseLearningLensRegistration({
        ...SUPPORT_LENS,
        version: "1.1.0",
        supersedes: { ...lensRef(SUPPORT_LENS), id: "other-lens" },
      }),
    ).toThrowError(expect.objectContaining({ code: "schema.invalid" }));
  });

  it("includes every purpose field group in registration identity", () => {
    const baseline = learningLensRegistrationDigest(SUPPORT_LENS);
    const mutations: readonly LearningLensRegistration[] = [
      { ...SUPPORT_LENS, id: "other-lens" },
      { ...SUPPORT_LENS, version: "1.0.1" },
      { ...SUPPORT_LENS, objective: "changed" },
      { ...SUPPORT_LENS, objectiveDigest: "1".repeat(64) },
      { ...SUPPORT_LENS, scopePolicyDigest: "0".repeat(64) },
      { ...SUPPORT_LENS, applicableScopes: { mode: "invocation" } },
      { ...SUPPORT_LENS, episodeClasses: { mode: "any" } },
      { ...SUPPORT_LENS, learningClasses: ["system_meta"] },
      {
        ...SUPPORT_LENS,
        evidenceRequirements: [{ kind: "measurement", minimumTrust: "observed", minimumCompleteness: "complete" }],
      },
      { ...SUPPORT_LENS, qualitativeRubric: { changed: true } },
      { ...SUPPORT_LENS, qualitativeRubricDigest: "2".repeat(64) },
      { ...SUPPORT_LENS, requiredFingerprintKinds: ["other"] },
      { ...SUPPORT_LENS, requiredCalibrationIds: ["other"] },
      { ...SUPPORT_LENS, permittedDestinationIds: ["other"] },
      { ...SUPPORT_LENS, permittedDestinationKinds: ["other"] },
      { ...SUPPORT_LENS, generatorPolicy: { ...SUPPORT_LENS.generatorPolicy, identityPolicyDigest: "0".repeat(64) } },
      { ...SUPPORT_LENS, reviewerPolicy: { ...SUPPORT_LENS.reviewerPolicy, calibrationPolicyDigest: null } },
      { ...SUPPORT_LENS, privacy: { ...SUPPORT_LENS.privacy, outboundDisclosure: "forbidden" } },
      { ...SUPPORT_LENS, validationStrategy: { metric: "changed" } },
      { ...SUPPORT_LENS, validationStrategyDigest: "3".repeat(64) },
      { ...SUPPORT_LENS, supersedes: lensRef(SUPPORT_LENS) },
    ];
    for (const mutation of mutations) expect(learningLensRegistrationDigest(mutation)).not.toBe(baseline);
  });
});

function observationEvidence(scope: Scope, completeness: "complete" | "partial" | "unknown" = "complete") {
  const episode = {
    sourceId: "synthetic-interactions",
    episodeId: "interaction-episode",
    episodeRecordId: "synthetic-interactions/episode-record",
    episodeRecordDigest: "2".repeat(64),
    episodeIdentityDigest: "3".repeat(64),
    scopeDigest: scopeDigest(scope),
    pageReceiptId: `source-page-${"4".repeat(64)}`,
    pageReceiptDigest: "4".repeat(64),
  };
  const bound: Omit<EvidenceRefV1, "schemaVersion" | "referenceDigest"> = {
    kind: "observation",
    recordId: "synthetic-interactions/redirection-1",
    recordDigest: "5".repeat(64),
    sourceId: "synthetic-interactions",
    sourceRegistrationRevision: "6".repeat(64),
    sourceRef: "tenant-keyed-artifact",
    sourceRevision: "interaction-revision",
    sourceRecordId: "redirection-1",
    pageRef: "interaction-page",
    pageReceiptId: `source-page-${"7".repeat(64)}`,
    pageReceiptDigest: "7".repeat(64),
    loopRegistryRevision: "8".repeat(64),
    trust: "advisory",
    completeness,
    episode,
  };
  const reference: ObservationEvidenceRef = {
    schemaVersion: 1,
    ...bound,
    kind: "observation",
    referenceDigest: evidenceRefDigest(bound),
  };
  return reference;
}

const EVIDENCE_A = observationEvidence(PROJECT_A);
const EVIDENCE_B = observationEvidence(PROJECT_B);

const HEALTH_FINDING_BASE = {
  code: "source.partial" as const,
  effect: "limits_claims" as const,
  sourceId: "synthetic-interactions",
  sourceRegistrationRevision: "d".repeat(64),
  sourceRef: "tenant-keyed-artifact",
  pageRef: "interaction-page",
  completeness: "partial" as const,
  affectedRecords: 1,
};
const HEALTH_FINDING_DIGEST = evidenceHealthFindingDigest(HEALTH_FINDING_BASE);
const HEALTH_FINDING: EvidenceHealthFinding = {
  schemaVersion: 1,
  id: `evidence-health-${HEALTH_FINDING_DIGEST}`,
  ...HEALTH_FINDING_BASE,
  findingDigest: HEALTH_FINDING_DIGEST,
};

function derivation(input: {
  readonly lens: LearningLensRegistration;
  readonly scope?: Scope;
  readonly evidence?: ObservationEvidenceRef;
  readonly destinationKind: string;
  readonly destinationId: string;
  readonly interventionSummary: string;
  readonly successCriterion: string;
  readonly versionLabel?: string;
  readonly producer?: InsightDerivation["producer"];
  readonly withIntervention?: boolean;
}): InsightDerivation {
  const scope = input.scope ?? PROJECT_A;
  const evidence = input.evidence ?? EVIDENCE_A;
  const episodes = [
    {
      episodeRecordId: evidence.episode.episodeRecordId,
      episodeViewDigest: "9".repeat(64),
      scopeDigest: scopeDigest(scope),
    },
  ];
  const comparablePopulation = { episodeClass: "interactive", split: "held-out", lens: input.lens.id };
  const normalizationPolicyDigest = DETECTOR.normalizationPolicyDigest;
  const comparabilityPolicyDigest = DETECTOR.comparabilityPolicyDigest;
  const producer: InsightDerivation["producer"] = input.producer ?? {
    kind: "deterministic",
    implementationId: "reference-redirection-detector",
    implementationVersion: "1.0.0",
    implementationDigest: "b".repeat(64),
    principal: null,
    attestation: null,
    modelFingerprintDigest: null,
    promptDigest: null,
    toolPolicyDigest: null,
    budgetPolicyDigest: null,
    disclosure: null,
  };
  const withIntervention = input.withIntervention ?? true;
  const base: Omit<InsightDerivation, "schemaVersion" | "id" | "derivationDigest"> = {
    scope,
    scopeDigest: scopeDigest(scope),
    scopePolicyDigest: SCOPE_POLICY_DIGEST,
    learningClass: "human_agent_interaction",
    lens: lensRef(input.lens),
    detector: { ...detectorRef(DETECTOR), configurationDigest: DETECTOR.configurationDigest },
    pack: { id: PACK.id, version: PACK.version, manifestDigest: PACK.manifestDigest },
    population: {
      episodes,
      populationDigest: digestPopulation(episodes, normalizationPolicyDigest, comparabilityPolicyDigest),
      normalizationPolicyDigest,
      comparabilityPolicyDigest,
    },
    directObservation: {
      statement: "Attributed human redirection recurred in comparable interactive episodes.",
      data: { condition: "repeated-redirection", countClass: "recurrent", version: input.versionLabel ?? "a" },
      evidenceRefs: [evidence],
      completeness: evidence.completeness,
    },
    evidenceHealthFindings: [HEALTH_FINDING],
    interpretation: {
      statement: "The observed redirection may indicate an avoidable purpose-specific friction.",
      confidence: "medium",
      uncertainty: ["Causal impact is not measured.", "One cited turn may have task-specific context."],
    },
    impactHypothesis: { statement: "A purpose-specific intervention may reduce repeated clarification." },
    contradictoryEvidenceRefs: [],
    missingEvidence: [
      { capability: "interaction.semantic_context", reasonCode: "turn_review_pending", effect: "limits_claims" },
    ],
    applicability: {
      statement: "Applies only to interactive human traffic under the selected purpose lens.",
      exclusions: ["automation traffic", "benchmark traffic", "reviewer traffic"],
    },
    candidateIntervention: withIntervention
      ? {
          summary: input.interventionSummary,
          proposedDestinationKind: input.destinationKind,
          proposedDestinationId: input.destinationId,
          contentDraft: { text: input.interventionSummary },
          rollbackIntent: "Remove the unvalidated draft.",
        }
      : null,
    validation: withIntervention
      ? {
          method: "comparable-held-out-episodes",
          comparablePopulation,
          comparablePopulationDigest: digest(comparablePopulation),
          successCriterion: input.successCriterion,
          guardrails: ["Do not increase unsafe escalation.", "Preserve factual accuracy."],
          strategyDigest: "c".repeat(64),
        }
      : null,
    producer,
    supersedes: null,
  };
  const derivationDigest = insightDerivationDigest(base);
  return parseInsightDerivation({
    schemaVersion: 1,
    id: `insight-${derivationDigest}`,
    ...base,
    derivationDigest,
  });
}

const SUPPORT_DERIVATION = derivation({
  lens: SUPPORT_LENS,
  destinationKind: "response-procedure",
  destinationId: "support/intake-procedure",
  interventionSummary: "Collect product version and environment before choosing an escalation path.",
  successCriterion: "First-contact resolution increases without unsafe escalation.",
});

const DOCUMENTATION_DERIVATION = derivation({
  lens: DOCUMENTATION_LENS,
  destinationKind: "documentation-content",
  destinationId: "docs/discoverability",
  interventionSummary: "Add a findable troubleshooting entry linked from the product guide.",
  successCriterion: "Held-out users find the correct guidance without support escalation.",
});

describe("InsightDerivation unknown-first parsing and identity", () => {
  it("round-trips valid unknown, drops unknown fields, and pins Support/Documentation goldens", () => {
    expect(parseInsightDerivation(SUPPORT_DERIVATION)).toEqual(SUPPORT_DERIVATION);
    expect(parseInsightDerivation({ ...SUPPORT_DERIVATION, futureField: "ignored" })).toEqual(SUPPORT_DERIVATION);
    expect(SUPPORT_DERIVATION.derivationDigest).toBe(
      "e1b3055a9a14c695e4b789e94dcf4e5a26ad405cdaa0b7c1bf1e0583d13dc95f",
    );
    expect(DOCUMENTATION_DERIVATION.derivationDigest).toBe(
      "cda853ca1e40c20e84243d9b69a53f87ee77c2e52750c9a51428a2450d202c1c",
    );
  });

  it("requires schema and every required field with correct types", () => {
    expect(() => parseInsightDerivation({ ...SUPPORT_DERIVATION, schemaVersion: 2 })).toThrowError(
      expect.objectContaining({ code: "schema.unsupported_version" }),
    );
    expect(() => parseInsightDerivation(withoutField(SUPPORT_DERIVATION, "producer"))).toThrowError(
      expect.objectContaining({ code: "schema.invalid" }),
    );
    expect(() => parseInsightDerivation({ ...SUPPORT_DERIVATION, population: 42 })).toThrowError(
      expect.objectContaining({ code: "schema.invalid" }),
    );
    expect(() => parseInsightDerivation(null)).toThrowError(expect.objectContaining({ code: "schema.invalid" }));
  });

  it("uses a content-addressed id and rejects any stale digest or semantic tamper", () => {
    expect(SUPPORT_DERIVATION.id).toBe(`insight-${SUPPORT_DERIVATION.derivationDigest}`);
    expect(() => parseInsightDerivation({ ...SUPPORT_DERIVATION, id: `insight-${"0".repeat(64)}` })).toThrowError(
      expect.objectContaining({ code: "schema.corrupt" }),
    );
    expect(() =>
      parseInsightDerivation({
        ...SUPPORT_DERIVATION,
        directObservation: { ...SUPPORT_DERIVATION.directObservation, statement: "tampered" },
      }),
    ).toThrowError(expect.objectContaining({ code: "schema.corrupt" }));
  });

  it("requires exact scope and evidence completeness", () => {
    expect(() => parseInsightDerivation({ ...SUPPORT_DERIVATION, scopeDigest: "0".repeat(64) })).toThrowError(
      expect.objectContaining({ code: "schema.corrupt" }),
    );
    const partial = observationEvidence(PROJECT_A, "partial");
    const partialBound = {
      ...SUPPORT_DERIVATION,
      directObservation: {
        ...SUPPORT_DERIVATION.directObservation,
        evidenceRefs: [partial],
        completeness: SUPPORT_DERIVATION.directObservation.completeness,
      },
    };
    const partialDigest = insightDerivationDigest(partialBound);
    expect(() =>
      parseInsightDerivation({
        ...partialBound,
        id: `insight-${partialDigest}`,
        derivationDigest: partialDigest,
      }),
    ).toThrowError(expect.objectContaining({ code: "schema.corrupt" }));

    const wrongScopeBound = {
      ...SUPPORT_DERIVATION,
      directObservation: { ...SUPPORT_DERIVATION.directObservation, evidenceRefs: [EVIDENCE_B] },
    };
    const wrongScopeDigest = insightDerivationDigest(wrongScopeBound);
    expect(() =>
      parseInsightDerivation({
        ...wrongScopeBound,
        id: `insight-${wrongScopeDigest}`,
        derivationDigest: wrongScopeDigest,
      }),
    ).toThrowError(expect.objectContaining({ code: "schema.corrupt" }));

    const contradictoryScopeBound = {
      ...SUPPORT_DERIVATION,
      contradictoryEvidenceRefs: [EVIDENCE_B],
    };
    const contradictoryScopeDigest = insightDerivationDigest(contradictoryScopeBound);
    expect(() =>
      parseInsightDerivation({
        ...contradictoryScopeBound,
        id: `insight-${contradictoryScopeDigest}`,
        derivationDigest: contradictoryScopeDigest,
      }),
    ).toThrowError(expect.objectContaining({ code: "schema.corrupt" }));

    const crossProjectEpisodes = [
      {
        episodeRecordId: "synthetic-interactions/project-b-episode",
        episodeViewDigest: "4".repeat(64),
        scopeDigest: scopeDigest(PROJECT_B),
      },
    ];
    const crossPopulationBound = {
      ...SUPPORT_DERIVATION,
      population: {
        ...SUPPORT_DERIVATION.population,
        episodes: crossProjectEpisodes,
        populationDigest: digestPopulation(
          crossProjectEpisodes,
          SUPPORT_DERIVATION.population.normalizationPolicyDigest,
          SUPPORT_DERIVATION.population.comparabilityPolicyDigest,
        ),
      },
      directObservation: { ...SUPPORT_DERIVATION.directObservation, evidenceRefs: [] },
    };
    const crossPopulationDigest = insightDerivationDigest(crossPopulationBound);
    expect(() =>
      parseInsightDerivation({
        ...crossPopulationBound,
        id: `insight-${crossPopulationDigest}`,
        derivationDigest: crossPopulationDigest,
      }),
    ).toThrowError(expect.objectContaining({ code: "schema.corrupt" }));
  });

  it("requires at least one exact evidence reference or population episode", () => {
    const emptyPopulation = {
      episodes: [],
      populationDigest: digestPopulation([], "9".repeat(64), null),
      normalizationPolicyDigest: "9".repeat(64),
      comparabilityPolicyDigest: null,
    };
    const emptyBound = {
      ...SUPPORT_DERIVATION,
      population: emptyPopulation,
      directObservation: { ...SUPPORT_DERIVATION.directObservation, evidenceRefs: [] },
    };
    const emptyDigest = insightDerivationDigest(emptyBound);
    expect(() =>
      parseInsightDerivation({ ...emptyBound, id: `insight-${emptyDigest}`, derivationDigest: emptyDigest }),
    ).toThrowError(expect.objectContaining({ code: "schema.invalid" }));
  });

  it("binds normalization and comparability policy into population identity", () => {
    const changedNormalization = {
      ...SUPPORT_DERIVATION.population,
      normalizationPolicyDigest: "d".repeat(64),
    };
    const staleBound = { ...SUPPORT_DERIVATION, population: changedNormalization };
    const staleDigest = insightDerivationDigest(staleBound);
    expect(() =>
      parseInsightDerivation({
        ...staleBound,
        id: `insight-${staleDigest}`,
        derivationDigest: staleDigest,
      }),
    ).toThrowError(expect.objectContaining({ code: "schema.corrupt" }));

    const changedComparability = "e".repeat(64);
    const updatedPopulation = {
      ...changedNormalization,
      comparabilityPolicyDigest: changedComparability,
      populationDigest: digestPopulation(
        changedNormalization.episodes,
        changedNormalization.normalizationPolicyDigest,
        changedComparability,
      ),
    };
    const updatedBound = { ...SUPPORT_DERIVATION, population: updatedPopulation };
    const updatedDigest = insightDerivationDigest(updatedBound);
    const updated = parseInsightDerivation({
      ...updatedBound,
      id: `insight-${updatedDigest}`,
      derivationDigest: updatedDigest,
    });
    expect(updated.population.populationDigest).toBe(updatedPopulation.populationDigest);
    expect(updated.derivationDigest).not.toBe(SUPPORT_DERIVATION.derivationDigest);
  });

  it("accepts durable population episode ids through 4096 characters and rejects longer ids", () => {
    const baseEpisode = SUPPORT_DERIVATION.population.episodes[0];
    if (baseEpisode === undefined) throw new Error("missing population episode fixture");
    const acceptedEpisodes = [{ ...baseEpisode, episodeRecordId: "e".repeat(1_500) }];
    const acceptedPopulation = {
      ...SUPPORT_DERIVATION.population,
      episodes: acceptedEpisodes,
      populationDigest: digestPopulation(
        acceptedEpisodes,
        SUPPORT_DERIVATION.population.normalizationPolicyDigest,
        SUPPORT_DERIVATION.population.comparabilityPolicyDigest,
      ),
    };
    const acceptedBound = { ...SUPPORT_DERIVATION, population: acceptedPopulation };
    const acceptedDigest = insightDerivationDigest(acceptedBound);
    expect(
      parseInsightDerivation({
        ...acceptedBound,
        id: `insight-${acceptedDigest}`,
        derivationDigest: acceptedDigest,
      }).population.episodes[0]?.episodeRecordId,
    ).toHaveLength(1_500);

    const oversizedEpisodes = [{ ...baseEpisode, episodeRecordId: "e".repeat(4_097) }];
    const oversizedPopulation = {
      ...SUPPORT_DERIVATION.population,
      episodes: oversizedEpisodes,
      populationDigest: digestPopulation(
        oversizedEpisodes,
        SUPPORT_DERIVATION.population.normalizationPolicyDigest,
        SUPPORT_DERIVATION.population.comparabilityPolicyDigest,
      ),
    };
    const oversizedBound = { ...SUPPORT_DERIVATION, population: oversizedPopulation };
    const oversizedDigest = insightDerivationDigest(oversizedBound);
    expect(() =>
      parseInsightDerivation({
        ...oversizedBound,
        id: `insight-${oversizedDigest}`,
        derivationDigest: oversizedDigest,
      }),
    ).toThrowError(expect.objectContaining({ code: "schema.invalid" }));
  });

  it("binds supersession to the exact same derivation scope", () => {
    const priorDigest = "f".repeat(64);
    const sameScopeBound = {
      ...SUPPORT_DERIVATION,
      directObservation: { ...SUPPORT_DERIVATION.directObservation, data: { revision: 2 } },
      supersedes: {
        id: `insight-${priorDigest}`,
        derivationDigest: priorDigest,
        scopeDigest: SUPPORT_DERIVATION.scopeDigest,
      },
    };
    const sameScopeDigest = insightDerivationDigest(sameScopeBound);
    expect(
      parseInsightDerivation({
        ...sameScopeBound,
        id: `insight-${sameScopeDigest}`,
        derivationDigest: sameScopeDigest,
      }).supersedes,
    ).toMatchObject({ scopeDigest: SUPPORT_DERIVATION.scopeDigest });

    const crossScopeBound = {
      ...sameScopeBound,
      supersedes: { ...sameScopeBound.supersedes, scopeDigest: scopeDigest(PROJECT_B) },
    };
    const crossScopeDigest = insightDerivationDigest(crossScopeBound);
    expect(() =>
      parseInsightDerivation({
        ...crossScopeBound,
        id: `insight-${crossScopeDigest}`,
        derivationDigest: crossScopeDigest,
      }),
    ).toThrowError(expect.objectContaining({ code: "schema.corrupt" }));
  });

  it("requires candidate intervention and validation together with paired comparable-population digest", () => {
    expect(() => parseInsightDerivation({ ...SUPPORT_DERIVATION, validation: null })).toThrowError(
      expect.objectContaining({ code: "schema.invalid" }),
    );
    expect(() => parseInsightDerivation({ ...SUPPORT_DERIVATION, candidateIntervention: null })).toThrowError(
      expect.objectContaining({ code: "schema.invalid" }),
    );
    expect(() =>
      parseInsightDerivation({
        ...SUPPORT_DERIVATION,
        validation: { ...SUPPORT_DERIVATION.validation, comparablePopulationDigest: null },
      }),
    ).toThrowError(expect.objectContaining({ code: "schema.invalid" }));
    expect(
      derivation({
        lens: SUPPORT_LENS,
        destinationKind: "unused",
        destinationId: "unused",
        interventionSummary: "unused",
        successCriterion: "unused",
        withIntervention: false,
      }).candidateIntervention,
    ).toBeNull();
  });

  it("enforces sorted/unique evidence health, missing evidence, uncertainty, exclusions, populations, and guardrails", () => {
    const mutations = [
      {
        directObservation: {
          ...SUPPORT_DERIVATION.directObservation,
          evidenceRefs: [EVIDENCE_A, EVIDENCE_A],
        },
      },
      { contradictoryEvidenceRefs: [EVIDENCE_A, EVIDENCE_A] },
      {
        evidenceHealthFindings: [
          SUPPORT_DERIVATION.evidenceHealthFindings[0],
          SUPPORT_DERIVATION.evidenceHealthFindings[0],
        ],
      },
      { missingEvidence: [SUPPORT_DERIVATION.missingEvidence[0], SUPPORT_DERIVATION.missingEvidence[0]] },
      {
        interpretation: {
          ...SUPPORT_DERIVATION.interpretation,
          uncertainty: ["z uncertainty", "a uncertainty"],
        },
      },
      { applicability: { ...SUPPORT_DERIVATION.applicability, exclusions: ["z", "a"] } },
      {
        population: {
          ...SUPPORT_DERIVATION.population,
          episodes: [SUPPORT_DERIVATION.population.episodes[0], SUPPORT_DERIVATION.population.episodes[0]],
        },
      },
      { validation: { ...SUPPORT_DERIVATION.validation, guardrails: ["duplicate", "duplicate"] } },
    ];
    for (const mutation of mutations) {
      expect(() => parseInsightDerivation({ ...SUPPORT_DERIVATION, ...mutation })).toThrowError(
        expect.objectContaining({ code: expect.stringMatching(/^schema\./) }),
      );
    }
  });

  it("enforces producer principal/attestation and semantic fingerprint rules", () => {
    const expectProducerInvalid = (producer: InsightDerivation["producer"]): void => {
      const bound = { ...SUPPORT_DERIVATION, producer };
      const derivationDigest = insightDerivationDigest(bound);
      expect(() =>
        parseInsightDerivation({ ...bound, id: `insight-${derivationDigest}`, derivationDigest }),
      ).toThrowError(expect.objectContaining({ code: "schema.invalid" }));
    };
    expect(() =>
      parseInsightDerivation({
        ...SUPPORT_DERIVATION,
        producer: { ...SUPPORT_DERIVATION.producer, principal: { id: "p", kind: "human", independenceDomain: "org" } },
      }),
    ).toThrowError(expect.objectContaining({ code: "schema.invalid" }));
    expect(() =>
      parseInsightDerivation({
        ...SUPPORT_DERIVATION,
        producer: {
          ...SUPPORT_DERIVATION.producer,
          kind: "human",
          principal: null,
          attestation: null,
        },
      }),
    ).toThrowError(expect.objectContaining({ code: "schema.invalid" }));
    expect(() =>
      parseInsightDerivation({
        ...SUPPORT_DERIVATION,
        producer: { ...SUPPORT_DERIVATION.producer, modelFingerprintDigest: "d".repeat(64) },
      }),
    ).toThrowError(expect.objectContaining({ code: "schema.invalid" }));

    const semanticProducer: InsightDerivation["producer"] = {
      kind: "semantic_judgment",
      implementationId: "semantic-port",
      implementationVersion: "1.0.0",
      implementationDigest: "d".repeat(64),
      principal: { id: "semantic-agent", kind: "agent", independenceDomain: "generator-domain" },
      attestation: { id: "attestation-1", digest: "e".repeat(64) },
      modelFingerprintDigest: "f".repeat(64),
      promptDigest: "0".repeat(64),
      toolPolicyDigest: "1".repeat(64),
      budgetPolicyDigest: "2".repeat(64),
      disclosure: null,
    };
    const humanProducer: InsightDerivation["producer"] = {
      kind: "human",
      implementationId: "human-workflow",
      implementationVersion: "1.0.0",
      implementationDigest: "4".repeat(64),
      principal: { id: "support-lead", kind: "human", independenceDomain: "support-team" },
      attestation: { id: "human-attestation", digest: "5".repeat(64) },
      modelFingerprintDigest: null,
      promptDigest: null,
      toolPolicyDigest: null,
      budgetPolicyDigest: null,
      disclosure: null,
    };
    for (const kind of ["agent", "service"] as const) {
      expectProducerInvalid({
        ...humanProducer,
        principal: { id: "wrong-human-principal", kind, independenceDomain: "support-team" },
      });
    }
    expectProducerInvalid({
      ...semanticProducer,
      principal: { id: "human-generator", kind: "human", independenceDomain: "generator-domain" },
    });
    expect(
      derivation({
        lens: SUPPORT_LENS,
        destinationKind: "response-procedure",
        destinationId: "support/intake-procedure",
        interventionSummary: "Semantically reviewed intake change.",
        successCriterion: "Held-out resolution improves.",
        producer: semanticProducer,
      }).producer.kind,
    ).toBe("semantic_judgment");
    expect(
      derivation({
        lens: SUPPORT_LENS,
        destinationKind: "response-procedure",
        destinationId: "support/intake-procedure",
        interventionSummary: "Human-attributed intake change.",
        successCriterion: "Held-out resolution improves.",
        producer: humanProducer,
      }).producer.kind,
    ).toBe("human");
    expect(
      derivation({
        lens: SUPPORT_LENS,
        destinationKind: "response-procedure",
        destinationId: "support/intake-procedure",
        interventionSummary: "Service-produced semantic intake change.",
        successCriterion: "Held-out resolution improves.",
        producer: {
          ...semanticProducer,
          principal: { id: "semantic-service", kind: "service", independenceDomain: "generator-domain" },
        },
      }).producer.principal,
    ).toMatchObject({ kind: "service" });
    expect(
      derivation({
        lens: SUPPORT_LENS,
        destinationKind: "response-procedure",
        destinationId: "support/intake-procedure",
        interventionSummary: "Disclosed semantic intake change.",
        successCriterion: "Held-out resolution improves.",
        producer: {
          ...semanticProducer,
          disclosure: {
            receiptId: "disclosure-receipt",
            receiptDigest: "6".repeat(64),
            minimizedBytesDigest: "7".repeat(64),
          },
        },
      }).producer.disclosure,
    ).toMatchObject({ receiptId: "disclosure-receipt" });
    expect(() =>
      parseInsightDerivation({
        ...SUPPORT_DERIVATION,
        producer: { ...semanticProducer, promptDigest: null },
      }),
    ).toThrowError(expect.objectContaining({ code: "schema.invalid" }));
    expect(() =>
      parseInsightDerivation({
        ...SUPPORT_DERIVATION,
        producer: { ...semanticProducer, disclosure: { receiptId: "r", receiptDigest: "3".repeat(64) } },
      }),
    ).toThrowError(expect.objectContaining({ code: "schema.invalid" }));
  });

  it("binds every semantic field group into the derivation digest", () => {
    const baseline = insightDerivationDigest(SUPPORT_DERIVATION);
    const mutations: readonly InsightDerivation[] = [
      { ...SUPPORT_DERIVATION, scope: PROJECT_B },
      { ...SUPPORT_DERIVATION, scopeDigest: scopeDigest(PROJECT_B) },
      { ...SUPPORT_DERIVATION, scopePolicyDigest: "0".repeat(64) },
      { ...SUPPORT_DERIVATION, learningClass: "system_meta" },
      { ...SUPPORT_DERIVATION, lens: lensRef(DOCUMENTATION_LENS) },
      { ...SUPPORT_DERIVATION, detector: { ...SUPPORT_DERIVATION.detector, configurationDigest: "0".repeat(64) } },
      { ...SUPPORT_DERIVATION, pack: null },
      {
        ...SUPPORT_DERIVATION,
        population: { ...SUPPORT_DERIVATION.population, normalizationPolicyDigest: "0".repeat(64) },
      },
      {
        ...SUPPORT_DERIVATION,
        population: { ...SUPPORT_DERIVATION.population, populationDigest: "1".repeat(64) },
      },
      {
        ...SUPPORT_DERIVATION,
        directObservation: { ...SUPPORT_DERIVATION.directObservation, data: { changed: true } },
      },
      {
        ...SUPPORT_DERIVATION,
        directObservation: { ...SUPPORT_DERIVATION.directObservation, statement: "changed" },
      },
      { ...SUPPORT_DERIVATION, evidenceHealthFindings: [] },
      { ...SUPPORT_DERIVATION, interpretation: null },
      { ...SUPPORT_DERIVATION, impactHypothesis: null },
      { ...SUPPORT_DERIVATION, contradictoryEvidenceRefs: [EVIDENCE_A] },
      { ...SUPPORT_DERIVATION, missingEvidence: [] },
      { ...SUPPORT_DERIVATION, applicability: { statement: "changed", exclusions: [] } },
      { ...SUPPORT_DERIVATION, producer: { ...SUPPORT_DERIVATION.producer, implementationDigest: "0".repeat(64) } },
      { ...SUPPORT_DERIVATION, candidateIntervention: null, validation: null },
      {
        ...SUPPORT_DERIVATION,
        supersedes: {
          id: `insight-${"3".repeat(64)}`,
          derivationDigest: "3".repeat(64),
          scopeDigest: SUPPORT_DERIVATION.scopeDigest,
        },
      },
    ];
    for (const mutation of mutations) expect(insightDerivationDigest(mutation)).not.toBe(baseline);
  });

  it("uses the same evidence under Support and Documentation lenses but derives distinct purpose semantics", () => {
    expect(SUPPORT_DERIVATION.directObservation.evidenceRefs).toEqual(
      DOCUMENTATION_DERIVATION.directObservation.evidenceRefs,
    );
    expect(SUPPORT_DERIVATION.detector).toEqual(DOCUMENTATION_DERIVATION.detector);
    expect(SUPPORT_DERIVATION.lens).not.toEqual(DOCUMENTATION_DERIVATION.lens);
    expect(SUPPORT_DERIVATION.candidateIntervention?.proposedDestinationKind).toBe("response-procedure");
    expect(DOCUMENTATION_DERIVATION.candidateIntervention?.proposedDestinationKind).toBe("documentation-content");
    expect(SUPPORT_DERIVATION.derivationDigest).not.toBe(DOCUMENTATION_DERIVATION.derivationDigest);
  });
});

describe("semantic logical-identity and causal-chain adversarial controls", () => {
  it("rejects duplicate lens evidence kinds even when requirements differ", () => {
    const evidenceRequirements: LearningLensRegistration["evidenceRequirements"] = [
      { kind: "observation", minimumTrust: "advisory", minimumCompleteness: "partial" },
      { kind: "observation", minimumTrust: "observed", minimumCompleteness: "complete" },
    ];
    const bound = { ...SUPPORT_LENS, evidenceRequirements };
    const registrationDigest = learningLensRegistrationDigest(bound);
    expect(() => parseLearningLensRegistration({ ...bound, registrationDigest })).toThrowError(
      expect.objectContaining({ code: "schema.invalid" }),
    );
  });

  it("rejects same detector/lens logical ref under different digests in packs and detector allowlists", () => {
    const detectorCollision = sorted(
      [detectorRef(DETECTOR), { ...detectorRef(DETECTOR), registrationDigest: "0".repeat(64) }],
      canonicalKey,
    );
    const detectorPack = { ...PACK, detectors: detectorCollision };
    expect(() =>
      parseDetectorPackManifest({ ...detectorPack, manifestDigest: detectorPackManifestDigest(detectorPack) }),
    ).toThrowError(expect.objectContaining({ code: "schema.invalid" }));

    const lensCollision = sorted(
      [lensRef(SUPPORT_LENS), { ...lensRef(SUPPORT_LENS), registrationDigest: "0".repeat(64) }],
      canonicalKey,
    );
    const lensPack = { ...PACK, lenses: lensCollision };
    expect(() =>
      parseDetectorPackManifest({ ...lensPack, manifestDigest: detectorPackManifestDigest(lensPack) }),
    ).toThrowError(expect.objectContaining({ code: "schema.invalid" }));

    const detectorWithCollision = {
      ...DETECTOR,
      lensConstraint: { mode: "required" as const, selection: "allowlist" as const, registrations: lensCollision },
    };
    expect(() =>
      parseDetectorRegistration({
        ...detectorWithCollision,
        registrationDigest: detectorRegistrationDigest(detectorWithCollision),
      }),
    ).toThrowError(expect.objectContaining({ code: "schema.invalid" }));
  });

  it("rejects one population episode id under multiple view digests", () => {
    const first = SUPPORT_DERIVATION.population.episodes[0];
    if (first === undefined) throw new Error("missing population fixture");
    const episodes = [first, { ...first, episodeViewDigest: "0".repeat(64) }];
    const population = {
      ...SUPPORT_DERIVATION.population,
      episodes,
      populationDigest: digestPopulation(
        episodes,
        SUPPORT_DERIVATION.population.normalizationPolicyDigest,
        SUPPORT_DERIVATION.population.comparabilityPolicyDigest,
      ),
    };
    const bound = { ...SUPPORT_DERIVATION, population };
    const derivationDigest = insightDerivationDigest(bound);
    expect(() =>
      parseInsightDerivation({ ...bound, id: `insight-${derivationDigest}`, derivationDigest }),
    ).toThrowError(expect.objectContaining({ code: "schema.invalid" }));
  });

  it("rejects duplicate full evidence-health findings and any effect tamper", () => {
    const health = SUPPORT_DERIVATION.evidenceHealthFindings[0];
    if (health === undefined) throw new Error("missing health fixture");
    const duplicateBound = { ...SUPPORT_DERIVATION, evidenceHealthFindings: [health, health] };
    const duplicateDigest = insightDerivationDigest(duplicateBound);
    expect(() =>
      parseInsightDerivation({
        ...duplicateBound,
        id: `insight-${duplicateDigest}`,
        derivationDigest: duplicateDigest,
      }),
    ).toThrowError(expect.objectContaining({ code: "schema.invalid" }));

    const effectTamperBound = {
      ...SUPPORT_DERIVATION,
      evidenceHealthFindings: [{ ...health, effect: "blocks_use" as const }],
    };
    const effectTamperDigest = insightDerivationDigest(effectTamperBound);
    expect(() =>
      parseInsightDerivation({
        ...effectTamperBound,
        id: `insight-${effectTamperDigest}`,
        derivationDigest: effectTamperDigest,
      }),
    ).toThrowError(expect.objectContaining({ code: "schema.corrupt" }));
  });

  it("rejects disclosure on deterministic production", () => {
    const bound = {
      ...SUPPORT_DERIVATION,
      producer: {
        ...SUPPORT_DERIVATION.producer,
        disclosure: {
          receiptId: "deterministic-disclosure",
          receiptDigest: "0".repeat(64),
          minimizedBytesDigest: "1".repeat(64),
        },
      },
    };
    const derivationDigest = insightDerivationDigest(bound);
    expect(() =>
      parseInsightDerivation({ ...bound, id: `insight-${derivationDigest}`, derivationDigest }),
    ).toThrowError(expect.objectContaining({ code: "schema.invalid" }));
  });

  it("rejects impact without interpretation and intervention without an impact hypothesis", () => {
    const impactWithoutInterpretation = { ...SUPPORT_DERIVATION, interpretation: null };
    const firstDigest = insightDerivationDigest(impactWithoutInterpretation);
    expect(() =>
      parseInsightDerivation({
        ...impactWithoutInterpretation,
        id: `insight-${firstDigest}`,
        derivationDigest: firstDigest,
      }),
    ).toThrowError(expect.objectContaining({ code: "schema.invalid" }));

    const interventionWithoutImpact = { ...SUPPORT_DERIVATION, impactHypothesis: null };
    const secondDigest = insightDerivationDigest(interventionWithoutImpact);
    expect(() =>
      parseInsightDerivation({
        ...interventionWithoutImpact,
        id: `insight-${secondDigest}`,
        derivationDigest: secondDigest,
      }),
    ).toThrowError(expect.objectContaining({ code: "schema.invalid" }));
  });

  it("rejects calibration evidence without its exact calibration population pair", () => {
    const bound = { ...DETECTOR, calibrationEvidenceDigest: "0".repeat(64) };
    expect(() =>
      parseDetectorRegistration({ ...bound, registrationDigest: detectorRegistrationDigest(bound) }),
    ).toThrowError(expect.objectContaining({ code: "schema.invalid" }));
  });
});
