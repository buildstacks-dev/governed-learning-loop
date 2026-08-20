// Immutable detector registration and exact executable-semantics lineage.
import { sha256HexOfCanonicalJson } from "../canonical/canonical-json.js";
import type { JsonValue } from "../canonical/json.js";
import { toJsonValue } from "../canonical/to-json-value.js";
import { invalid, parseOneOf, readFields } from "../parse/toolkit.js";
import type { Completeness, TrustClass } from "./provenance.js";
import { COMPLETENESS_VALUES, TRUST_CLASSES } from "./provenance.js";
import type { DetectorRef, EpisodeClasses, JsonObject, LensConstraint, ScopeConstraint } from "./semantic-shared.js";
import {
  assertSortedUnique,
  MAX_SET_VALUES,
  parseBoundedArray,
  parseDetectorRefAt,
  parseDigestAt,
  parseEpisodeClassesAt,
  parseId,
  parseJsonObject,
  parseLensConstraintAt,
  parseNullable,
  parseScopeConstraintAt,
  parseSemVer,
  verifyJsonDigest,
  verifyNullableJsonDigest,
} from "./semantic-shared.js";

const DETECTOR_MATURITIES = ["experimental", "calibrated", "stable", "deprecated"] as const;
const DETECTOR_OUTPUT_KINDS = ["evidence_health", "insight_derivation"] as const;
const SIGNATURE_TREATMENTS = ["none", "public_structural", "tenant_keyed_private", "mixed"] as const;
const TRANSIENT_CONTENT_POLICIES = ["forbidden", "memory_only", "explicit_disclosure_receipt"] as const;

export type DetectorMaturity = (typeof DETECTOR_MATURITIES)[number];
export type DetectorOutputKind = (typeof DETECTOR_OUTPUT_KINDS)[number];

export interface DetectorRegistration {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly version: string;
  readonly maturity: DetectorMaturity;
  readonly implementationDigest: string;
  readonly configuration: JsonObject;
  readonly configurationDigest: string;
  readonly thresholds: JsonObject | null;
  readonly thresholdDigest: string | null;
  readonly observationVocabularyDigest: string;
  readonly requiredCapabilities: readonly string[];
  readonly acceptedObservationKinds: readonly string[];
  readonly minimumTrust: TrustClass;
  readonly minimumCompleteness: Completeness;
  readonly episodeClasses: EpisodeClasses;
  readonly scopePolicyDigest: string;
  readonly scopeConstraint: ScopeConstraint;
  readonly lensConstraint: LensConstraint;
  readonly normalizationPolicyDigest: string;
  readonly comparabilityPolicyDigest: string | null;
  readonly outputKind: DetectorOutputKind;
  readonly positiveFixtureDigests: readonly string[];
  readonly negativeFixtureDigests: readonly string[];
  readonly falsePositivePolicy: JsonObject;
  readonly falsePositivePolicyDigest: string;
  readonly calibrationPopulation: JsonObject | null;
  readonly calibrationPopulationDigest: string | null;
  readonly calibrationEvidenceDigest: string | null;
  readonly privacy: {
    readonly signatureTreatment: (typeof SIGNATURE_TREATMENTS)[number];
    readonly transientContent: (typeof TRANSIENT_CONTENT_POLICIES)[number];
    readonly policyDigest: string;
  };
  readonly proposedValidationCriterion: JsonObject;
  readonly proposedValidationCriterionDigest: string;
  readonly supersedes: DetectorRef | null;
  readonly registrationDigest: string;
}

function detectorRegistrationContent(
  input: Omit<DetectorRegistration, "schemaVersion" | "registrationDigest">,
): JsonValue {
  return toJsonValue({
    id: input.id,
    version: input.version,
    maturity: input.maturity,
    implementationDigest: input.implementationDigest,
    configuration: input.configuration,
    configurationDigest: input.configurationDigest,
    thresholds: input.thresholds,
    thresholdDigest: input.thresholdDigest,
    observationVocabularyDigest: input.observationVocabularyDigest,
    requiredCapabilities: input.requiredCapabilities,
    acceptedObservationKinds: input.acceptedObservationKinds,
    minimumTrust: input.minimumTrust,
    minimumCompleteness: input.minimumCompleteness,
    episodeClasses: input.episodeClasses,
    scopePolicyDigest: input.scopePolicyDigest,
    scopeConstraint: input.scopeConstraint,
    lensConstraint: input.lensConstraint,
    normalizationPolicyDigest: input.normalizationPolicyDigest,
    comparabilityPolicyDigest: input.comparabilityPolicyDigest,
    outputKind: input.outputKind,
    positiveFixtureDigests: input.positiveFixtureDigests,
    negativeFixtureDigests: input.negativeFixtureDigests,
    falsePositivePolicy: input.falsePositivePolicy,
    falsePositivePolicyDigest: input.falsePositivePolicyDigest,
    calibrationPopulation: input.calibrationPopulation,
    calibrationPopulationDigest: input.calibrationPopulationDigest,
    calibrationEvidenceDigest: input.calibrationEvidenceDigest,
    privacy: input.privacy,
    proposedValidationCriterion: input.proposedValidationCriterion,
    proposedValidationCriterionDigest: input.proposedValidationCriterionDigest,
    supersedes: input.supersedes,
  });
}

export function detectorRegistrationDigest(
  input: Omit<DetectorRegistration, "schemaVersion" | "registrationDigest">,
): string {
  return sha256HexOfCanonicalJson(detectorRegistrationContent(input));
}

export function parseDetectorRegistration(input: unknown): DetectorRegistration {
  const fields = readFields(input, []);
  const schemaVersion = fields.schemaVersion1();
  const id = fields.req("id", parseId);
  const version = fields.req("version", parseSemVer);
  const maturity = fields.req("maturity", parseOneOf(DETECTOR_MATURITIES));
  const configuration = fields.req("configuration", parseJsonObject);
  const configurationDigest = fields.req("configurationDigest", parseDigestAt);
  verifyJsonDigest(configuration, configurationDigest, ["configuration"]);
  const thresholds = fields.req("thresholds", parseNullable(parseJsonObject));
  const thresholdDigest = fields.req("thresholdDigest", parseNullable(parseDigestAt));
  verifyNullableJsonDigest(thresholds, thresholdDigest, ["thresholds"], ["thresholdDigest"]);
  const requiredCapabilities = fields.req(
    "requiredCapabilities",
    parseBoundedArray(parseId, MAX_SET_VALUES, "required capabilities"),
  );
  assertSortedUnique(requiredCapabilities, (value) => value, ["requiredCapabilities"]);
  const acceptedObservationKinds = fields.req(
    "acceptedObservationKinds",
    parseBoundedArray(parseId, MAX_SET_VALUES, "accepted observation kinds"),
  );
  assertSortedUnique(acceptedObservationKinds, (value) => value, ["acceptedObservationKinds"]);
  const positiveFixtureDigests = fields.req(
    "positiveFixtureDigests",
    parseBoundedArray(parseDigestAt, MAX_SET_VALUES, "positive fixture digests"),
  );
  if (positiveFixtureDigests.length === 0) {
    throw invalid("schema.invalid", "detector requires at least one positive fixture", ["positiveFixtureDigests"]);
  }
  assertSortedUnique(positiveFixtureDigests, (value) => value, ["positiveFixtureDigests"]);
  const negativeFixtureDigests = fields.req(
    "negativeFixtureDigests",
    parseBoundedArray(parseDigestAt, MAX_SET_VALUES, "negative fixture digests"),
  );
  if (negativeFixtureDigests.length === 0) {
    throw invalid("schema.invalid", "detector requires at least one negative fixture", ["negativeFixtureDigests"]);
  }
  assertSortedUnique(negativeFixtureDigests, (value) => value, ["negativeFixtureDigests"]);
  const falsePositivePolicy = fields.req("falsePositivePolicy", parseJsonObject);
  const falsePositivePolicyDigest = fields.req("falsePositivePolicyDigest", parseDigestAt);
  verifyJsonDigest(falsePositivePolicy, falsePositivePolicyDigest, ["falsePositivePolicy"]);
  const calibrationPopulation = fields.req("calibrationPopulation", parseNullable(parseJsonObject));
  const calibrationPopulationDigest = fields.req("calibrationPopulationDigest", parseNullable(parseDigestAt));
  verifyNullableJsonDigest(
    calibrationPopulation,
    calibrationPopulationDigest,
    ["calibrationPopulation"],
    ["calibrationPopulationDigest"],
  );
  const proposedValidationCriterion = fields.req("proposedValidationCriterion", parseJsonObject);
  const proposedValidationCriterionDigest = fields.req("proposedValidationCriterionDigest", parseDigestAt);
  verifyJsonDigest(proposedValidationCriterion, proposedValidationCriterionDigest, ["proposedValidationCriterion"]);
  const privacyFields = readFields(
    fields.req("privacy", (value) => value),
    ["privacy"],
  );
  const privacy = {
    signatureTreatment: privacyFields.req("signatureTreatment", parseOneOf(SIGNATURE_TREATMENTS)),
    transientContent: privacyFields.req("transientContent", parseOneOf(TRANSIENT_CONTENT_POLICIES)),
    policyDigest: privacyFields.req("policyDigest", parseDigestAt),
  };
  const supersedes = fields.req("supersedes", parseNullable(parseDetectorRefAt));
  if (supersedes !== null && (supersedes.id !== id || supersedes.version === version)) {
    throw invalid("schema.invalid", "detector supersession must reference another version of the same id", [
      "supersedes",
    ]);
  }
  if (maturity === "deprecated" && supersedes === null) {
    throw invalid("schema.invalid", "deprecated detector registration must supersede an executable version", [
      "supersedes",
    ]);
  }
  const calibrationEvidenceDigest = fields.req("calibrationEvidenceDigest", parseNullable(parseDigestAt));
  if (calibrationEvidenceDigest !== null && (calibrationPopulation === null || calibrationPopulationDigest === null)) {
    throw invalid("schema.invalid", "calibration evidence requires an exact calibration population", [
      "calibrationEvidenceDigest",
    ]);
  }
  if (
    (maturity === "calibrated" || maturity === "stable") &&
    (calibrationPopulation === null || calibrationPopulationDigest === null || calibrationEvidenceDigest === null)
  ) {
    throw invalid("schema.invalid", "calibrated and stable detectors require calibration population and evidence", [
      "maturity",
    ]);
  }
  const outputKind = fields.req("outputKind", parseOneOf(DETECTOR_OUTPUT_KINDS));
  const lensConstraint = fields.req("lensConstraint", parseLensConstraintAt);
  if (outputKind === "insight_derivation" && lensConstraint.mode !== "required") {
    throw invalid("schema.invalid", "insight derivation detectors require a learning lens constraint", [
      "lensConstraint",
    ]);
  }
  if (outputKind === "evidence_health" && lensConstraint.mode !== "independent") {
    throw invalid("schema.invalid", "evidence-health detectors must remain lens-independent", ["lensConstraint"]);
  }
  const base = {
    id,
    version,
    maturity,
    implementationDigest: fields.req("implementationDigest", parseDigestAt),
    configuration,
    configurationDigest,
    thresholds,
    thresholdDigest,
    observationVocabularyDigest: fields.req("observationVocabularyDigest", parseDigestAt),
    requiredCapabilities,
    acceptedObservationKinds,
    minimumTrust: fields.req("minimumTrust", parseOneOf(TRUST_CLASSES)),
    minimumCompleteness: fields.req("minimumCompleteness", parseOneOf(COMPLETENESS_VALUES)),
    episodeClasses: fields.req("episodeClasses", parseEpisodeClassesAt),
    scopePolicyDigest: fields.req("scopePolicyDigest", parseDigestAt),
    scopeConstraint: fields.req("scopeConstraint", parseScopeConstraintAt),
    lensConstraint,
    normalizationPolicyDigest: fields.req("normalizationPolicyDigest", parseDigestAt),
    comparabilityPolicyDigest: fields.req("comparabilityPolicyDigest", parseNullable(parseDigestAt)),
    outputKind,
    positiveFixtureDigests,
    negativeFixtureDigests,
    falsePositivePolicy,
    falsePositivePolicyDigest,
    calibrationPopulation,
    calibrationPopulationDigest,
    calibrationEvidenceDigest,
    privacy,
    proposedValidationCriterion,
    proposedValidationCriterionDigest,
    supersedes,
  };
  const registrationDigest = fields.req("registrationDigest", parseDigestAt);
  const registration: DetectorRegistration = { schemaVersion, ...base, registrationDigest };
  if (registrationDigest !== detectorRegistrationDigest(base)) {
    throw invalid("schema.corrupt", "detector registration digest does not match its bound fields", [
      "registrationDigest",
    ]);
  }
  return registration;
}
