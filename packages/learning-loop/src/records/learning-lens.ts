// Host-neutral purpose lens registration and exact qualitative-policy lineage.
import { sha256HexOfCanonicalJson } from "../canonical/canonical-json.js";
import type { JsonValue } from "../canonical/json.js";
import { toJsonValue } from "../canonical/to-json-value.js";
import { invalid, parseOneOf, readFields } from "../parse/toolkit.js";
import type { EvidenceRef } from "./evidence-ref.js";
import type { Completeness, TrustClass } from "./provenance.js";
import { COMPLETENESS_VALUES, TRUST_CLASSES } from "./provenance.js";
import type { EpisodeClasses, JsonObject, LearningClass, LensRef, ScopeConstraint } from "./semantic-shared.js";
import {
  assertSortedUnique,
  canonicalKey,
  digestOf,
  MAX_SET_VALUES,
  parseBoundedArray,
  parseDigestAt,
  parseEpisodeClassesAt,
  parseId,
  parseJsonObject,
  parseLearningClassAt,
  parseLensRefAt,
  parseNullable,
  parseScopeConstraintAt,
  parseSemVer,
  parseStatement,
  parseTrue,
  verifyJsonDigest,
} from "./semantic-shared.js";

const EVIDENCE_KINDS: readonly ["observation", "measurement", "episode"] = ["observation", "measurement", "episode"];
const GENERATOR_KINDS = ["deterministic", "human", "semantic_judgment"] as const;
const OUTBOUND_DISCLOSURE_POLICIES = ["forbidden", "explicit_disclosure_receipt"] as const;

export interface LearningLensRegistration {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly version: string;
  readonly objective: string;
  readonly objectiveDigest: string;
  readonly scopePolicyDigest: string;
  readonly applicableScopes: ScopeConstraint;
  readonly episodeClasses: EpisodeClasses;
  readonly learningClasses: readonly LearningClass[];
  readonly evidenceRequirements: readonly {
    readonly kind: EvidenceRef["kind"] | "episode";
    readonly minimumTrust: TrustClass;
    readonly minimumCompleteness: Completeness;
  }[];
  readonly qualitativeRubric: JsonObject;
  readonly qualitativeRubricDigest: string;
  readonly requiredFingerprintKinds: readonly string[];
  readonly requiredCalibrationIds: readonly string[];
  readonly permittedDestinationIds: readonly string[];
  readonly permittedDestinationKinds: readonly string[];
  readonly generatorPolicy: {
    readonly allowedKinds: readonly (typeof GENERATOR_KINDS)[number][];
    readonly identityPolicyDigest: string;
    readonly fingerprintPolicyDigest: string;
  };
  readonly reviewerPolicy: {
    readonly independentFromGenerator: true;
    readonly identityPolicyDigest: string;
    readonly calibrationPolicyDigest: string | null;
  };
  readonly privacy: {
    readonly outboundDisclosure: (typeof OUTBOUND_DISCLOSURE_POLICIES)[number];
    readonly policyDigest: string;
  };
  readonly validationStrategy: JsonObject;
  readonly validationStrategyDigest: string;
  readonly supersedes: LensRef | null;
  readonly registrationDigest: string;
}

function lensRegistrationContent(
  input: Omit<LearningLensRegistration, "schemaVersion" | "registrationDigest">,
): JsonValue {
  return toJsonValue({
    id: input.id,
    version: input.version,
    objective: input.objective,
    objectiveDigest: input.objectiveDigest,
    scopePolicyDigest: input.scopePolicyDigest,
    applicableScopes: input.applicableScopes,
    episodeClasses: input.episodeClasses,
    learningClasses: input.learningClasses,
    evidenceRequirements: input.evidenceRequirements,
    qualitativeRubric: input.qualitativeRubric,
    qualitativeRubricDigest: input.qualitativeRubricDigest,
    requiredFingerprintKinds: input.requiredFingerprintKinds,
    requiredCalibrationIds: input.requiredCalibrationIds,
    permittedDestinationIds: input.permittedDestinationIds,
    permittedDestinationKinds: input.permittedDestinationKinds,
    generatorPolicy: input.generatorPolicy,
    reviewerPolicy: input.reviewerPolicy,
    privacy: input.privacy,
    validationStrategy: input.validationStrategy,
    validationStrategyDigest: input.validationStrategyDigest,
    supersedes: input.supersedes,
  });
}

export function learningLensRegistrationDigest(
  input: Omit<LearningLensRegistration, "schemaVersion" | "registrationDigest">,
): string {
  return sha256HexOfCanonicalJson(lensRegistrationContent(input));
}

function parseEvidenceRequirementAt(
  input: unknown,
  path: readonly (string | number)[],
): LearningLensRegistration["evidenceRequirements"][number] {
  const fields = readFields(input, path);
  return {
    kind: fields.req("kind", parseOneOf(EVIDENCE_KINDS)),
    minimumTrust: fields.req("minimumTrust", parseOneOf(TRUST_CLASSES)),
    minimumCompleteness: fields.req("minimumCompleteness", parseOneOf(COMPLETENESS_VALUES)),
  };
}

export function parseLearningLensRegistration(input: unknown): LearningLensRegistration {
  const fields = readFields(input, []);
  const schemaVersion = fields.schemaVersion1();
  const id = fields.req("id", parseId);
  const version = fields.req("version", parseSemVer);
  const objective = fields.req("objective", parseStatement);
  const objectiveDigest = fields.req("objectiveDigest", parseDigestAt);
  if (objectiveDigest !== digestOf(objective)) {
    throw invalid("schema.corrupt", "lens objective digest does not match its text", ["objectiveDigest"]);
  }
  const learningClasses = fields.req(
    "learningClasses",
    parseBoundedArray(parseLearningClassAt, MAX_SET_VALUES, "learning classes"),
  );
  if (learningClasses.length === 0) {
    throw invalid("schema.invalid", "learning lens requires at least one learning class", ["learningClasses"]);
  }
  assertSortedUnique(learningClasses, (value) => value, ["learningClasses"]);
  const evidenceRequirements = fields.req(
    "evidenceRequirements",
    parseBoundedArray(parseEvidenceRequirementAt, MAX_SET_VALUES, "evidence requirements"),
  );
  if (evidenceRequirements.length === 0) {
    throw invalid("schema.invalid", "learning lens requires evidence requirements", ["evidenceRequirements"]);
  }
  assertSortedUnique(evidenceRequirements, canonicalKey, ["evidenceRequirements"]);
  const requiredEvidenceKinds = new Set<string>();
  for (const [index, requirement] of evidenceRequirements.entries()) {
    if (requiredEvidenceKinds.has(requirement.kind)) {
      throw invalid("schema.invalid", "a learning lens may declare one requirement per evidence kind", [
        "evidenceRequirements",
        index,
      ]);
    }
    requiredEvidenceKinds.add(requirement.kind);
  }
  const qualitativeRubric = fields.req("qualitativeRubric", parseJsonObject);
  const qualitativeRubricDigest = fields.req("qualitativeRubricDigest", parseDigestAt);
  verifyJsonDigest(qualitativeRubric, qualitativeRubricDigest, ["qualitativeRubric"]);
  const requiredFingerprintKinds = fields.req(
    "requiredFingerprintKinds",
    parseBoundedArray(parseId, MAX_SET_VALUES, "required fingerprint kinds"),
  );
  assertSortedUnique(requiredFingerprintKinds, (value) => value, ["requiredFingerprintKinds"]);
  const requiredCalibrationIds = fields.req(
    "requiredCalibrationIds",
    parseBoundedArray(parseId, MAX_SET_VALUES, "required calibration ids"),
  );
  assertSortedUnique(requiredCalibrationIds, (value) => value, ["requiredCalibrationIds"]);
  const permittedDestinationIds = fields.req(
    "permittedDestinationIds",
    parseBoundedArray(parseId, MAX_SET_VALUES, "permitted destination ids"),
  );
  assertSortedUnique(permittedDestinationIds, (value) => value, ["permittedDestinationIds"]);
  const permittedDestinationKinds = fields.req(
    "permittedDestinationKinds",
    parseBoundedArray(parseId, MAX_SET_VALUES, "permitted destination kinds"),
  );
  assertSortedUnique(permittedDestinationKinds, (value) => value, ["permittedDestinationKinds"]);
  const generatorFields = readFields(
    fields.req("generatorPolicy", (value) => value),
    ["generatorPolicy"],
  );
  const allowedKinds = generatorFields.req(
    "allowedKinds",
    parseBoundedArray(parseOneOf(GENERATOR_KINDS), GENERATOR_KINDS.length, "allowed generator kinds"),
  );
  if (allowedKinds.length === 0) {
    throw invalid("schema.invalid", "generator policy requires at least one allowed kind", [
      "generatorPolicy",
      "allowedKinds",
    ]);
  }
  assertSortedUnique(allowedKinds, (value) => value, ["generatorPolicy", "allowedKinds"]);
  const generatorPolicy = {
    allowedKinds,
    identityPolicyDigest: generatorFields.req("identityPolicyDigest", parseDigestAt),
    fingerprintPolicyDigest: generatorFields.req("fingerprintPolicyDigest", parseDigestAt),
  };
  const reviewerFields = readFields(
    fields.req("reviewerPolicy", (value) => value),
    ["reviewerPolicy"],
  );
  const reviewerPolicy = {
    independentFromGenerator: reviewerFields.req("independentFromGenerator", parseTrue),
    identityPolicyDigest: reviewerFields.req("identityPolicyDigest", parseDigestAt),
    calibrationPolicyDigest: reviewerFields.req("calibrationPolicyDigest", parseNullable(parseDigestAt)),
  };
  const privacyFields = readFields(
    fields.req("privacy", (value) => value),
    ["privacy"],
  );
  const privacy = {
    outboundDisclosure: privacyFields.req("outboundDisclosure", parseOneOf(OUTBOUND_DISCLOSURE_POLICIES)),
    policyDigest: privacyFields.req("policyDigest", parseDigestAt),
  };
  const validationStrategy = fields.req("validationStrategy", parseJsonObject);
  const validationStrategyDigest = fields.req("validationStrategyDigest", parseDigestAt);
  verifyJsonDigest(validationStrategy, validationStrategyDigest, ["validationStrategy"]);
  const supersedes = fields.req("supersedes", parseNullable(parseLensRefAt));
  if (supersedes !== null && (supersedes.id !== id || supersedes.version === version)) {
    throw invalid("schema.invalid", "lens supersession must reference another version of the same id", ["supersedes"]);
  }
  const base = {
    id,
    version,
    objective,
    objectiveDigest,
    scopePolicyDigest: fields.req("scopePolicyDigest", parseDigestAt),
    applicableScopes: fields.req("applicableScopes", parseScopeConstraintAt),
    episodeClasses: fields.req("episodeClasses", parseEpisodeClassesAt),
    learningClasses,
    evidenceRequirements,
    qualitativeRubric,
    qualitativeRubricDigest,
    requiredFingerprintKinds,
    requiredCalibrationIds,
    permittedDestinationIds,
    permittedDestinationKinds,
    generatorPolicy,
    reviewerPolicy,
    privacy,
    validationStrategy,
    validationStrategyDigest,
    supersedes,
  };
  const registrationDigest = fields.req("registrationDigest", parseDigestAt);
  const registration: LearningLensRegistration = { schemaVersion, ...base, registrationDigest };
  if (registrationDigest !== learningLensRegistrationDigest(base)) {
    throw invalid("schema.corrupt", "learning lens registration digest does not match its bound fields", [
      "registrationDigest",
    ]);
  }
  return registration;
}
