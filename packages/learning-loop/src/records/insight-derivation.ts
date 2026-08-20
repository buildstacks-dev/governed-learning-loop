// Advisory, inert semantic lineage between evidence and a possible Candidate.
import { canonicalJsonText, sha256HexOfCanonicalJson } from "../canonical/canonical-json.js";
import type { JsonValue } from "../canonical/json.js";
import { toJsonValue } from "../canonical/to-json-value.js";
import { LearningLoopError } from "../diagnostics.js";
import { invalid, parseJson, parseOneOf, readFields } from "../parse/toolkit.js";
import type { EvidenceRef } from "./evidence-ref.js";
import { parseEvidenceRefAt } from "./evidence-ref.js";
import type { PrincipalRef } from "./principal.js";
import { parsePrincipalRefAt } from "./principal.js";
import type { Completeness } from "./provenance.js";
import { COMPLETENESS_VALUES } from "./provenance.js";
import type { Scope } from "./scope.js";
import type { EvidenceHealthFinding } from "./source-health.js";
import { parseEvidenceHealthFinding } from "./source-health.js";
import type { DetectorRef, LearningClass, LensRef, PackRef } from "./semantic-shared.js";
import {
  assertSortedUnique,
  canonicalKey,
  digestOf,
  MAX_ORDERED_VALUES,
  MAX_SET_VALUES,
  parseBoundedArray,
  parseDetectorRefAt,
  parseDigestAt,
  parseDurableId,
  parseId,
  parseLearningClassAt,
  parseLensRefAt,
  parseNullable,
  parsePackRefAt,
  parseScopeAt,
  parseSemVer,
  parseStatement,
  scopeDigest,
  verifyNullableJsonDigest,
} from "./semantic-shared.js";

const INSIGHT_ID_PATTERN = /^insight-[0-9a-f]{64}$/;
const GENERATOR_KINDS = ["deterministic", "human", "semantic_judgment"] as const;
const INTERPRETATION_CONFIDENCES = ["high", "medium", "low", "unknown"] as const;

export interface InsightDerivation {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly scope: Scope;
  readonly scopeDigest: string;
  readonly scopePolicyDigest: string;
  readonly learningClass: LearningClass;
  readonly lens: LensRef;
  readonly detector: DetectorRef & { readonly configurationDigest: string };
  readonly pack: PackRef | null;
  readonly population: {
    readonly episodes: readonly {
      readonly episodeRecordId: string;
      readonly episodeViewDigest: string;
      readonly scopeDigest: string;
    }[];
    readonly populationDigest: string;
    readonly normalizationPolicyDigest: string;
    readonly comparabilityPolicyDigest: string | null;
  };
  readonly directObservation: {
    readonly statement: string;
    readonly data: JsonValue;
    readonly evidenceRefs: readonly EvidenceRef[];
    readonly completeness: Completeness;
  };
  readonly evidenceHealthFindings: readonly EvidenceHealthFinding[];
  readonly interpretation: {
    readonly statement: string;
    readonly confidence: (typeof INTERPRETATION_CONFIDENCES)[number];
    readonly uncertainty: readonly string[];
  } | null;
  readonly impactHypothesis: { readonly statement: string } | null;
  readonly contradictoryEvidenceRefs: readonly EvidenceRef[];
  readonly missingEvidence: readonly {
    readonly capability: string;
    readonly reasonCode: string;
    readonly effect: EvidenceHealthFinding["effect"];
  }[];
  readonly applicability: {
    readonly statement: string;
    readonly exclusions: readonly string[];
  };
  readonly producer: {
    readonly kind: (typeof GENERATOR_KINDS)[number];
    readonly implementationId: string;
    readonly implementationVersion: string;
    readonly implementationDigest: string;
    readonly principal: PrincipalRef | null;
    readonly attestation: { readonly id: string; readonly digest: string } | null;
    readonly modelFingerprintDigest: string | null;
    readonly promptDigest: string | null;
    readonly toolPolicyDigest: string | null;
    readonly budgetPolicyDigest: string | null;
    readonly disclosure: {
      readonly receiptId: string;
      readonly receiptDigest: string;
      readonly minimizedBytesDigest: string;
    } | null;
  };
  readonly candidateIntervention: {
    readonly summary: string;
    readonly proposedDestinationKind: string;
    readonly proposedDestinationId: string | null;
    readonly contentDraft: JsonValue | null;
    readonly rollbackIntent: string | null;
  } | null;
  readonly validation: {
    readonly method: string;
    readonly comparablePopulation: JsonValue | null;
    readonly comparablePopulationDigest: string | null;
    readonly successCriterion: string;
    readonly guardrails: readonly string[];
    readonly strategyDigest: string;
  } | null;
  readonly supersedes: {
    readonly id: string;
    readonly derivationDigest: string;
    readonly scopeDigest: string;
  } | null;
  readonly derivationDigest: string;
}

function assertOrderedEvidenceUnique(values: readonly EvidenceRef[], path: readonly (string | number)[]): void {
  const digests = new Set<string>();
  const records = new Set<string>();
  for (const [index, value] of values.entries()) {
    const recordKey = canonicalJsonText(toJsonValue([value.kind, value.recordId]));
    if (digests.has(value.referenceDigest) || records.has(recordKey)) {
      throw invalid("schema.invalid", "ordered evidence references must be unique", [...path, index]);
    }
    digests.add(value.referenceDigest);
    records.add(recordKey);
  }
}

function parseEvidenceRefsAt(input: unknown, path: readonly (string | number)[]): readonly EvidenceRef[] {
  const values = parseBoundedArray(parseEvidenceRefAt, MAX_ORDERED_VALUES, "evidence references")(input, path);
  assertOrderedEvidenceUnique(values, path);
  return values;
}

function requireEvidenceScope(
  values: readonly EvidenceRef[],
  exactScopeDigest: string,
  path: readonly (string | number)[],
): void {
  for (const [index, value] of values.entries()) {
    if (value.episode.scopeDigest !== exactScopeDigest) {
      throw invalid("schema.corrupt", "evidence reference scope does not match derivation scope", [...path, index]);
    }
  }
}

function parsePopulationEpisodeAt(
  input: unknown,
  path: readonly (string | number)[],
): InsightDerivation["population"]["episodes"][number] {
  const fields = readFields(input, path);
  return {
    episodeRecordId: fields.req("episodeRecordId", parseDurableId),
    episodeViewDigest: fields.req("episodeViewDigest", parseDigestAt),
    scopeDigest: fields.req("scopeDigest", parseDigestAt),
  };
}

function parseEvidenceHealthFindingAt(input: unknown, path: readonly (string | number)[]): EvidenceHealthFinding {
  try {
    return parseEvidenceHealthFinding(input);
  } catch (error) {
    if (error instanceof LearningLoopError) {
      const diagnostics = error.diagnostics.map((diagnostic) => ({
        ...diagnostic,
        path: [...path, ...(diagnostic.path ?? [])],
      }));
      throw new LearningLoopError(error.code, diagnostics);
    }
    throw error;
  }
}

function parseMissingEvidenceAt(
  input: unknown,
  path: readonly (string | number)[],
): InsightDerivation["missingEvidence"][number] {
  const fields = readFields(input, path);
  return {
    capability: fields.req("capability", parseId),
    reasonCode: fields.req("reasonCode", parseId),
    effect: fields.req("effect", parseOneOf(["limits_claims", "blocks_audit", "blocks_use"])),
  };
}

function parseAttestationAt(
  input: unknown,
  path: readonly (string | number)[],
): NonNullable<InsightDerivation["producer"]["attestation"]> {
  const fields = readFields(input, path);
  return { id: fields.req("id", parseId), digest: fields.req("digest", parseDigestAt) };
}

function parseDisclosureAt(
  input: unknown,
  path: readonly (string | number)[],
): NonNullable<InsightDerivation["producer"]["disclosure"]> {
  const fields = readFields(input, path);
  return {
    receiptId: fields.req("receiptId", parseId),
    receiptDigest: fields.req("receiptDigest", parseDigestAt),
    minimizedBytesDigest: fields.req("minimizedBytesDigest", parseDigestAt),
  };
}

function insightDerivationContent(
  input: Omit<InsightDerivation, "schemaVersion" | "id" | "derivationDigest">,
): JsonValue {
  return toJsonValue({
    scope: input.scope,
    scopeDigest: input.scopeDigest,
    scopePolicyDigest: input.scopePolicyDigest,
    learningClass: input.learningClass,
    lens: input.lens,
    detector: input.detector,
    pack: input.pack,
    population: input.population,
    directObservation: input.directObservation,
    evidenceHealthFindings: input.evidenceHealthFindings,
    interpretation: input.interpretation,
    impactHypothesis: input.impactHypothesis,
    contradictoryEvidenceRefs: input.contradictoryEvidenceRefs,
    missingEvidence: input.missingEvidence,
    applicability: input.applicability,
    producer: input.producer,
    candidateIntervention: input.candidateIntervention,
    validation: input.validation,
    supersedes: input.supersedes,
  });
}

export function insightDerivationDigest(
  input: Omit<InsightDerivation, "schemaVersion" | "id" | "derivationDigest">,
): string {
  return sha256HexOfCanonicalJson(insightDerivationContent(input));
}

export function parseInsightDerivation(input: unknown): InsightDerivation {
  const fields = readFields(input, []);
  const schemaVersion = fields.schemaVersion1();
  const scope = fields.req("scope", parseScopeAt);
  const exactScopeDigest = fields.req("scopeDigest", parseDigestAt);
  if (exactScopeDigest !== scopeDigest(scope)) {
    throw invalid("schema.corrupt", "insight scope digest does not match its exact scope", ["scopeDigest"]);
  }
  const populationFields = readFields(
    fields.req("population", (value) => value),
    ["population"],
  );
  const episodes = populationFields.req(
    "episodes",
    parseBoundedArray(parsePopulationEpisodeAt, MAX_ORDERED_VALUES, "population episodes"),
  );
  const populationEpisodeIds = new Set<string>();
  for (const [index, episode] of episodes.entries()) {
    if (populationEpisodeIds.has(episode.episodeRecordId)) {
      throw invalid("schema.invalid", "ordered population episode record ids must be unique", [
        "population",
        "episodes",
        index,
      ]);
    }
    if (episode.scopeDigest !== exactScopeDigest) {
      throw invalid("schema.corrupt", "population episode scope does not match derivation scope", [
        "population",
        "episodes",
        index,
        "scopeDigest",
      ]);
    }
    populationEpisodeIds.add(episode.episodeRecordId);
  }
  const normalizationPolicyDigest = populationFields.req("normalizationPolicyDigest", parseDigestAt);
  const comparabilityPolicyDigest = populationFields.req("comparabilityPolicyDigest", parseNullable(parseDigestAt));
  const populationDigest = populationFields.req("populationDigest", parseDigestAt);
  if (populationDigest !== digestOf({ episodes, normalizationPolicyDigest, comparabilityPolicyDigest })) {
    throw invalid("schema.corrupt", "population digest does not match its episodes and policies", [
      "population",
      "populationDigest",
    ]);
  }
  const population = {
    episodes,
    populationDigest,
    normalizationPolicyDigest,
    comparabilityPolicyDigest,
  };
  const directObservationFields = readFields(
    fields.req("directObservation", (value) => value),
    ["directObservation"],
  );
  const evidenceRefs = directObservationFields.req("evidenceRefs", parseEvidenceRefsAt);
  requireEvidenceScope(evidenceRefs, exactScopeDigest, ["directObservation", "evidenceRefs"]);
  const observationCompleteness = directObservationFields.req("completeness", parseOneOf(COMPLETENESS_VALUES));
  if (evidenceRefs.length > 0 && observationCompleteness !== worstCompleteness(evidenceRefs)) {
    throw invalid("schema.corrupt", "direct observation completeness does not match its evidence", [
      "directObservation",
      "completeness",
    ]);
  }
  if (episodes.length === 0 && evidenceRefs.length === 0) {
    throw invalid("schema.invalid", "insight derivation requires evidence references or population episodes", [
      "directObservation",
      "evidenceRefs",
    ]);
  }
  const directObservation: InsightDerivation["directObservation"] = {
    statement: directObservationFields.req("statement", parseStatement),
    data: directObservationFields.req("data", parseJson),
    evidenceRefs,
    completeness: observationCompleteness,
  };
  const evidenceHealthFindings = fields.req(
    "evidenceHealthFindings",
    parseBoundedArray(parseEvidenceHealthFindingAt, MAX_SET_VALUES, "evidence-health findings"),
  );
  assertSortedUnique(evidenceHealthFindings, (finding) => canonicalKey([finding.id, finding.findingDigest]), [
    "evidenceHealthFindings",
  ]);
  const evidenceHealthIds = new Set<string>();
  const evidenceHealthDigests = new Set<string>();
  for (const [index, finding] of evidenceHealthFindings.entries()) {
    if (evidenceHealthIds.has(finding.id) || evidenceHealthDigests.has(finding.findingDigest)) {
      throw invalid("schema.invalid", "evidence-health findings may be included only once", [
        "evidenceHealthFindings",
        index,
      ]);
    }
    evidenceHealthIds.add(finding.id);
    evidenceHealthDigests.add(finding.findingDigest);
  }
  const interpretation = fields.req(
    "interpretation",
    parseNullable((value, path) => {
      const nested = readFields(value, path);
      const uncertainty = nested.req(
        "uncertainty",
        parseBoundedArray(parseStatement, MAX_SET_VALUES, "interpretation uncertainty"),
      );
      assertSortedUnique(uncertainty, (entry) => entry, [...path, "uncertainty"]);
      return {
        statement: nested.req("statement", parseStatement),
        confidence: nested.req("confidence", parseOneOf(INTERPRETATION_CONFIDENCES)),
        uncertainty,
      };
    }),
  );
  const impactHypothesis = fields.req(
    "impactHypothesis",
    parseNullable((value, path) => {
      const nested = readFields(value, path);
      return { statement: nested.req("statement", parseStatement) };
    }),
  );
  if (impactHypothesis !== null && interpretation === null) {
    throw invalid("schema.invalid", "an impact hypothesis requires an explicit interpretation", ["impactHypothesis"]);
  }
  const contradictoryEvidenceRefs = fields.req("contradictoryEvidenceRefs", parseEvidenceRefsAt);
  requireEvidenceScope(contradictoryEvidenceRefs, exactScopeDigest, ["contradictoryEvidenceRefs"]);
  const missingEvidence = fields.req(
    "missingEvidence",
    parseBoundedArray(parseMissingEvidenceAt, MAX_SET_VALUES, "missing evidence"),
  );
  assertSortedUnique(missingEvidence, canonicalKey, ["missingEvidence"]);
  const applicabilityFields = readFields(
    fields.req("applicability", (value) => value),
    ["applicability"],
  );
  const exclusions = applicabilityFields.req(
    "exclusions",
    parseBoundedArray(parseStatement, MAX_SET_VALUES, "applicability exclusions"),
  );
  assertSortedUnique(exclusions, (value) => value, ["applicability", "exclusions"]);
  const applicability = {
    statement: applicabilityFields.req("statement", parseStatement),
    exclusions,
  };
  const producerFields = readFields(
    fields.req("producer", (value) => value),
    ["producer"],
  );
  const producerKind = producerFields.req("kind", parseOneOf(GENERATOR_KINDS));
  const principal = producerFields.req("principal", parseNullable(parsePrincipalRefAt));
  const attestation = producerFields.req("attestation", parseNullable(parseAttestationAt));
  if ((principal === null) !== (attestation === null)) {
    throw invalid("schema.invalid", "producer principal and attestation must be present or null together", [
      "producer",
      "attestation",
    ]);
  }
  if (producerKind === "human" && (principal === null || principal.kind !== "human")) {
    throw invalid("schema.invalid", "human producers require an attributed human principal", ["producer", "principal"]);
  }
  if (
    producerKind === "semantic_judgment" &&
    (principal === null || (principal.kind !== "agent" && principal.kind !== "service"))
  ) {
    throw invalid("schema.invalid", "semantic producers require an attributed agent or service principal", [
      "producer",
      "principal",
    ]);
  }
  const modelFingerprintDigest = producerFields.req("modelFingerprintDigest", parseNullable(parseDigestAt));
  const promptDigest = producerFields.req("promptDigest", parseNullable(parseDigestAt));
  const toolPolicyDigest = producerFields.req("toolPolicyDigest", parseNullable(parseDigestAt));
  const budgetPolicyDigest = producerFields.req("budgetPolicyDigest", parseNullable(parseDigestAt));
  const disclosure = producerFields.req("disclosure", parseNullable(parseDisclosureAt));
  const fingerprintDigests = [modelFingerprintDigest, promptDigest, toolPolicyDigest, budgetPolicyDigest];
  if (producerKind === "semantic_judgment" && fingerprintDigests.some((digest) => digest === null)) {
    throw invalid("schema.invalid", "semantic producers require model, prompt, tool, and budget fingerprints", [
      "producer",
    ]);
  }
  if (
    producerKind === "deterministic" &&
    (principal !== null ||
      attestation !== null ||
      disclosure !== null ||
      fingerprintDigests.some((digest) => digest !== null))
  ) {
    throw invalid(
      "schema.invalid",
      "deterministic producers use implementation identity without principals, fingerprints, or disclosure",
      ["producer"],
    );
  }
  const producer = {
    kind: producerKind,
    implementationId: producerFields.req("implementationId", parseId),
    implementationVersion: producerFields.req("implementationVersion", parseSemVer),
    implementationDigest: producerFields.req("implementationDigest", parseDigestAt),
    principal,
    attestation,
    modelFingerprintDigest,
    promptDigest,
    toolPolicyDigest,
    budgetPolicyDigest,
    disclosure,
  };
  const candidateIntervention = fields.req(
    "candidateIntervention",
    parseNullable((value, path) => {
      const nested = readFields(value, path);
      return {
        summary: nested.req("summary", parseStatement),
        proposedDestinationKind: nested.req("proposedDestinationKind", parseId),
        proposedDestinationId: nested.req("proposedDestinationId", parseNullable(parseId)),
        contentDraft: nested.req("contentDraft", parseNullable(parseJson)),
        rollbackIntent: nested.req("rollbackIntent", parseNullable(parseStatement)),
      };
    }),
  );
  const validation = fields.req(
    "validation",
    parseNullable((value, path) => {
      const nested = readFields(value, path);
      const comparablePopulation = nested.req("comparablePopulation", parseNullable(parseJson));
      const comparablePopulationDigest = nested.req("comparablePopulationDigest", parseNullable(parseDigestAt));
      verifyNullableJsonDigest(
        comparablePopulation,
        comparablePopulationDigest,
        [...path, "comparablePopulation"],
        [...path, "comparablePopulationDigest"],
      );
      const guardrails = nested.req(
        "guardrails",
        parseBoundedArray(parseStatement, MAX_ORDERED_VALUES, "validation guardrails"),
      );
      const guardrailSet = new Set<string>();
      for (const [index, guardrail] of guardrails.entries()) {
        if (guardrailSet.has(guardrail)) {
          throw invalid("schema.invalid", "ordered validation guardrails must be unique", [
            ...path,
            "guardrails",
            index,
          ]);
        }
        guardrailSet.add(guardrail);
      }
      return {
        method: nested.req("method", parseId),
        comparablePopulation,
        comparablePopulationDigest,
        successCriterion: nested.req("successCriterion", parseStatement),
        guardrails,
        strategyDigest: nested.req("strategyDigest", parseDigestAt),
      };
    }),
  );
  if ((candidateIntervention === null) !== (validation === null)) {
    throw invalid("schema.invalid", "candidate intervention and validation must be present or null together", [
      "validation",
    ]);
  }
  if (candidateIntervention !== null && impactHypothesis === null) {
    throw invalid("schema.invalid", "a candidate intervention requires an impact hypothesis", [
      "candidateIntervention",
    ]);
  }
  const supersedes = fields.req(
    "supersedes",
    parseNullable((value, path) => {
      const nested = readFields(value, path);
      const id = nested.req("id", parseId);
      const derivationDigest = nested.req("derivationDigest", parseDigestAt);
      const supersededScopeDigest = nested.req("scopeDigest", parseDigestAt);
      if (id !== `insight-${derivationDigest}`) {
        throw invalid("schema.corrupt", "superseded insight id does not match its digest", [...path, "id"]);
      }
      if (supersededScopeDigest !== exactScopeDigest) {
        throw invalid("schema.corrupt", "superseded insight scope does not match derivation scope", [
          ...path,
          "scopeDigest",
        ]);
      }
      return { id, derivationDigest, scopeDigest: supersededScopeDigest };
    }),
  );
  const rawDetector = fields.req("detector", (value) => value);
  const detectorFields = readFields(rawDetector, ["detector"]);
  const detector = {
    ...parseDetectorRefAt(rawDetector, ["detector"]),
    configurationDigest: detectorFields.req("configurationDigest", parseDigestAt),
  };
  const base = {
    scope,
    scopeDigest: exactScopeDigest,
    scopePolicyDigest: fields.req("scopePolicyDigest", parseDigestAt),
    learningClass: fields.req("learningClass", parseLearningClassAt),
    lens: fields.req("lens", parseLensRefAt),
    detector,
    pack: fields.req("pack", parseNullable(parsePackRefAt)),
    population,
    directObservation,
    evidenceHealthFindings,
    interpretation,
    impactHypothesis,
    contradictoryEvidenceRefs,
    missingEvidence,
    applicability,
    producer,
    candidateIntervention,
    validation,
    supersedes,
  };
  const derivationDigest = fields.req("derivationDigest", parseDigestAt);
  const id = fields.req("id", parseId);
  if (!INSIGHT_ID_PATTERN.test(id) || id !== `insight-${derivationDigest}`) {
    throw invalid("schema.corrupt", "insight id does not match its derivation digest", ["id"]);
  }
  if (supersedes !== null && supersedes.id === id) {
    throw invalid("schema.invalid", "insight derivation cannot supersede itself", ["supersedes"]);
  }
  const derivation: InsightDerivation = { schemaVersion, id, ...base, derivationDigest };
  if (derivationDigest !== insightDerivationDigest(base)) {
    throw invalid("schema.corrupt", "insight derivation digest does not match its bound fields", ["derivationDigest"]);
  }
  return derivation;
}

function worstCompleteness(refs: readonly EvidenceRef[]): Completeness {
  let worst: Completeness = "complete";
  for (const reference of refs) {
    if (reference.completeness === "unknown") return "unknown";
    if (reference.completeness === "partial") worst = "partial";
  }
  return worst;
}
