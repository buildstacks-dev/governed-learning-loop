// Unknown-first narrow detector output and kernel-owned semantic record minting.
import type { JsonValue } from "../canonical/json.js";
import { invalid, parseBool, parseJson, parseOneOf, readFields } from "../parse/toolkit.js";
import type { Parse } from "../parse/toolkit.js";
import type { DetectorExecutionRecord } from "../records/detector-execution.js";
import {
  detectorExecutionDigest,
  detectorExecutionKeyDigest,
  parseDetectorExecutionRecord,
} from "../records/detector-execution.js";
import type { EvidenceRef } from "../records/evidence-ref.js";
import type { InsightDerivation, LearningClass } from "../records/semantic.js";
import { insightDerivationDigest, parseInsightDerivation } from "../records/semantic.js";
import {
  assertSortedUnique,
  canonicalKey,
  digestOf,
  MAX_ORDERED_VALUES,
  MAX_SET_VALUES,
  parseBoundedArray,
  parseDigestAt,
  parseDurableId,
  parseId,
  parseLearningClassAt,
  parseNullable,
  parseStatement,
} from "../records/semantic-shared.js";
import type { EvidenceHealthFinding } from "../records/source-health.js";
import { evidenceHealthFindingDigest, parseEvidenceHealthFinding } from "../records/source-health.js";
import type { DetectorWindow } from "./detector-window.js";

const CONFIDENCES = ["high", "medium", "low", "unknown"] as const;
const HEALTH_CODES = [
  "source.missing",
  "source.unreadable",
  "source.unsupported",
  "source.corrupt",
  "source.partial",
  "source.revision_changed",
  "source.record_rejected",
  "source.content_policy_refused",
  "source.adapter_diagnostic",
  "source.ownership_mismatch",
] as const;
const HEALTH_EFFECTS = ["limits_claims", "blocks_audit", "blocks_use"] as const;

export interface DetectorResultDraft {
  readonly conditionDetected: boolean;
  readonly insights: readonly {
    readonly learningClass: LearningClass;
    readonly directObservation: {
      readonly statement: string;
      readonly data: JsonValue;
      readonly evidenceReferenceDigests: readonly string[];
    };
    readonly interpretation: InsightDerivation["interpretation"];
    readonly impactHypothesis: InsightDerivation["impactHypothesis"];
    readonly contradictoryEvidenceReferenceDigests: readonly string[];
    readonly evidenceHealthFindingIds: readonly string[];
    readonly missingEvidence: InsightDerivation["missingEvidence"];
    readonly applicability: InsightDerivation["applicability"];
    readonly candidateIntervention: InsightDerivation["candidateIntervention"];
    readonly validation: InsightDerivation["validation"];
    readonly supersedes: { readonly id: string; readonly digest: string } | null;
  }[];
  readonly findings: readonly Omit<EvidenceHealthFinding, "schemaVersion" | "id" | "findingDigest">[];
}

function parseUniqueStatements(input: unknown, path: readonly (string | number)[]): readonly string[] {
  const values = parseBoundedArray(parseStatement, MAX_SET_VALUES, "statements")(input, path);
  assertSortedUnique(values, (value) => value, path);
  return values;
}

const parseMissingEvidenceAt: Parse<InsightDerivation["missingEvidence"][number]> = (input, path) => {
  const fields = readFields(input, path);
  return {
    capability: fields.req("capability", parseId),
    reasonCode: fields.req("reasonCode", parseId),
    effect: fields.req("effect", parseOneOf(HEALTH_EFFECTS)),
  };
};

const parseFindingDraftAt: Parse<Omit<EvidenceHealthFinding, "schemaVersion" | "id" | "findingDigest">> = (
  input,
  path,
) => {
  const fields = readFields(input, path);
  const affectedRecords = fields.req("affectedRecords", (value, fieldPath) => {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
      throw invalid("detector.result_invalid", "finding affectedRecords must be a nonnegative integer", fieldPath);
    }
    return value;
  });
  const code = fields.req("code", parseOneOf(HEALTH_CODES));
  const effect = fields.req("effect", parseOneOf(HEALTH_EFFECTS));
  if (code === "source.ownership_mismatch" && effect !== "blocks_use") {
    throw invalid("detector.result_invalid", "source ownership mismatch must block use", path);
  }
  return {
    code,
    effect,
    sourceId: fields.req("sourceId", parseId),
    sourceRegistrationRevision: fields.req("sourceRegistrationRevision", parseDigestAt),
    sourceRef: fields.req("sourceRef", parseDurableId),
    pageRef: fields.req("pageRef", parseDurableId),
    completeness: fields.req("completeness", parseOneOf(["complete", "partial", "unknown"])),
    affectedRecords,
  };
};

const parseInsightDraftAt: Parse<DetectorResultDraft["insights"][number]> = (input, path) => {
  const fields = readFields(input, path);
  const directFields = readFields(
    fields.req("directObservation", (value) => value),
    [...path, "directObservation"],
  );
  const interpretation = fields.req(
    "interpretation",
    parseNullable((value, fieldPath) => {
      const nested = readFields(value, fieldPath);
      return {
        statement: nested.req("statement", parseStatement),
        confidence: nested.req("confidence", parseOneOf(CONFIDENCES)),
        uncertainty: nested.req("uncertainty", parseUniqueStatements),
      };
    }),
  );
  const impactHypothesis = fields.req(
    "impactHypothesis",
    parseNullable((value, fieldPath) => {
      const nested = readFields(value, fieldPath);
      return { statement: nested.req("statement", parseStatement) };
    }),
  );
  const applicabilityFields = readFields(
    fields.req("applicability", (value) => value),
    [...path, "applicability"],
  );
  const candidateIntervention = fields.req(
    "candidateIntervention",
    parseNullable((value, fieldPath) => {
      const nested = readFields(value, fieldPath);
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
    parseNullable((value, fieldPath) => {
      const nested = readFields(value, fieldPath);
      const comparablePopulation = nested.req("comparablePopulation", parseNullable(parseJson));
      const comparablePopulationDigest = nested.req("comparablePopulationDigest", parseNullable(parseDigestAt));
      if (
        (comparablePopulation === null) !== (comparablePopulationDigest === null) ||
        (comparablePopulation !== null && comparablePopulationDigest !== digestOf(comparablePopulation))
      ) {
        throw invalid("detector.result_invalid", "validation comparable population digest is invalid", fieldPath);
      }
      const guardrails = nested.req("guardrails", parseBoundedArray(parseStatement, MAX_ORDERED_VALUES, "guardrails"));
      if (new Set(guardrails).size !== guardrails.length) {
        throw invalid("detector.result_invalid", "validation guardrails must be unique", [...fieldPath, "guardrails"]);
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
  const supersedes = fields.req(
    "supersedes",
    parseNullable((value, fieldPath) => {
      const nested = readFields(value, fieldPath);
      const id = nested.req("id", parseDurableId);
      const digest = nested.req("digest", parseDigestAt);
      if (id !== `insight-${digest}`) {
        throw invalid("detector.result_invalid", "superseded derivation id does not match digest", fieldPath);
      }
      return { id, digest };
    }),
  );
  return {
    learningClass: fields.req("learningClass", parseLearningClassAt),
    directObservation: {
      statement: directFields.req("statement", parseStatement),
      data: directFields.req("data", parseJson),
      evidenceReferenceDigests: directFields.req(
        "evidenceReferenceDigests",
        parseBoundedArray(parseDigestAt, MAX_ORDERED_VALUES, "evidence reference digests"),
      ),
    },
    interpretation,
    impactHypothesis,
    contradictoryEvidenceReferenceDigests: fields.req(
      "contradictoryEvidenceReferenceDigests",
      parseBoundedArray(parseDigestAt, MAX_ORDERED_VALUES, "counterevidence reference digests"),
    ),
    evidenceHealthFindingIds: fields.req("evidenceHealthFindingIds", (value, fieldPath) => {
      const ids = parseBoundedArray(parseDurableId, MAX_SET_VALUES, "health finding ids")(value, fieldPath);
      assertSortedUnique(ids, (id) => id, fieldPath);
      return ids;
    }),
    missingEvidence: fields.req("missingEvidence", (value, fieldPath) => {
      const missing = parseBoundedArray(parseMissingEvidenceAt, MAX_SET_VALUES, "missing evidence")(value, fieldPath);
      assertSortedUnique(missing, canonicalKey, fieldPath);
      return missing;
    }),
    applicability: {
      statement: applicabilityFields.req("statement", parseStatement),
      exclusions: applicabilityFields.req("exclusions", parseUniqueStatements),
    },
    candidateIntervention,
    validation,
    supersedes,
  };
};

export function parseDetectorResultDraft(input: unknown): DetectorResultDraft {
  const fields = readFields(input, ["detectorResult"]);
  return {
    conditionDetected: fields.req("conditionDetected", parseBool),
    insights: fields.req("insights", parseBoundedArray(parseInsightDraftAt, 100, "insight drafts")),
    findings: fields.req("findings", parseBoundedArray(parseFindingDraftAt, 100, "finding drafts")),
  };
}

function refsForDigests(window: DetectorWindow, digests: readonly string[]): readonly EvidenceRef[] {
  const byDigest = new Map(window.evidence.map((entry) => [entry.reference.referenceDigest, entry.reference]));
  const seen = new Set<string>();
  return digests.map((digest) => {
    const reference = byDigest.get(digest);
    if (reference === undefined || seen.has(digest)) {
      throw invalid("detector.result_invalid", "draft cites missing or duplicate window evidence", []);
    }
    seen.add(digest);
    return reference;
  });
}

function completenessOf(window: DetectorWindow, refs: readonly EvidenceRef[]): "complete" | "partial" | "unknown" {
  let worst: "complete" | "partial" | "unknown" = "complete";
  if (refs.length === 0) {
    for (const episode of window.population.episodes) {
      const completeness = episode.view.identity.status === "resolved" ? episode.view.identity.completeness : "unknown";
      if (completeness === "unknown") return "unknown";
      if (completeness === "partial") worst = "partial";
    }
    return worst;
  }
  for (const reference of refs) {
    if (reference.completeness === "unknown") return "unknown";
    if (reference.completeness === "partial") worst = "partial";
  }
  return worst;
}

function compactWindow(window: DetectorWindow): DetectorExecutionRecord["window"] {
  return {
    sourceProfiles: window.sourceProfiles,
    population: {
      episodes: window.population.episodes.map((episode) => ({
        episodeRecordId: episode.view.episode.id,
        episodeRecordDigest: episode.episodeRecordDigest,
        episodeIdentityDigest: episode.episodeIdentityDigest,
        outcomeClaimDigest: episode.outcomeClaimDigest,
        episodeViewDigest: episode.episodeViewDigest,
        scopeDigest: episode.scopeDigest,
      })),
      normalizationPolicyDigest: window.population.normalizationPolicyDigest,
      comparabilityPolicyDigest: window.population.comparabilityPolicyDigest,
      populationDigest: window.population.populationDigest,
    },
    evidenceRefs: window.evidence.map((entry) => entry.reference),
    evidenceHealthFindings: window.evidenceHealthFindings,
    availableCapabilities: window.availableCapabilities,
    windowDigest: window.windowDigest,
  };
}

function buildFinding(
  draft: Omit<EvidenceHealthFinding, "schemaVersion" | "id" | "findingDigest">,
): EvidenceHealthFinding {
  const findingDigest = evidenceHealthFindingDigest(draft);
  return parseEvidenceHealthFinding({
    schemaVersion: 1,
    id: `evidence-health-${findingDigest}`,
    ...draft,
    findingDigest,
  });
}

export function assembleAppliedDetectorResult(
  window: DetectorWindow,
  draft: DetectorResultDraft,
): { readonly execution: DetectorExecutionRecord; readonly derivations: readonly InsightDerivation[] } {
  if (!draft.conditionDetected && (draft.insights.length !== 0 || draft.findings.length !== 0)) {
    throw invalid("detector.result_invalid", "negative detector condition cannot carry outputs", []);
  }
  if (
    draft.conditionDetected &&
    ((window.outputKind === "insight_derivation" && (draft.insights.length === 0 || draft.findings.length !== 0)) ||
      (window.outputKind === "evidence_health" && (draft.findings.length === 0 || draft.insights.length !== 0)))
  ) {
    throw invalid("detector.result_invalid", "detector output family does not match its registration", []);
  }
  const findings = draft.findings.map(buildFinding).sort((left, right) => (left.id < right.id ? -1 : 1));
  const healthById = new Map([...window.evidenceHealthFindings, ...findings].map((finding) => [finding.id, finding]));
  const derivations = draft.insights
    .map((insight) => {
      if (window.lens === null) throw invalid("detector.result_invalid", "insight output requires a learning lens", []);
      const directRefs = refsForDigests(window, insight.directObservation.evidenceReferenceDigests);
      const contradictoryRefs = refsForDigests(window, insight.contradictoryEvidenceReferenceDigests);
      const directDigests = new Set(directRefs.map((reference) => reference.referenceDigest));
      if (contradictoryRefs.some((reference) => directDigests.has(reference.referenceDigest))) {
        throw invalid("detector.result_invalid", "direct and contradictory evidence must be disjoint", []);
      }
      const evidenceHealthFindings = insight.evidenceHealthFindingIds.map((id) => {
        const finding = healthById.get(id);
        if (finding === undefined) throw invalid("detector.result_invalid", "draft cites unknown health finding", []);
        return finding;
      });
      const populationEpisodes = window.population.episodes.map((episode) => ({
        episodeRecordId: episode.view.episode.id,
        episodeViewDigest: episode.episodeViewDigest,
        scopeDigest: episode.scopeDigest,
      }));
      const populationDigest = digestOf({
        episodes: populationEpisodes,
        normalizationPolicyDigest: window.population.normalizationPolicyDigest,
        comparabilityPolicyDigest: window.population.comparabilityPolicyDigest,
      });
      const base: Omit<InsightDerivation, "schemaVersion" | "id" | "derivationDigest"> = {
        scope: window.scope,
        scopeDigest: window.scopeDigest,
        scopePolicyDigest: window.scopePolicyDigest,
        learningClass: insight.learningClass,
        lens: window.lens,
        detector: {
          id: window.detector.id,
          version: window.detector.version,
          registrationDigest: window.detector.registrationDigest,
          configurationDigest: window.detector.configurationDigest,
        },
        pack: window.pack,
        population: {
          episodes: populationEpisodes,
          populationDigest,
          normalizationPolicyDigest: window.population.normalizationPolicyDigest,
          comparabilityPolicyDigest: window.population.comparabilityPolicyDigest,
        },
        directObservation: {
          statement: insight.directObservation.statement,
          data: insight.directObservation.data,
          evidenceRefs: directRefs,
          completeness: completenessOf(window, directRefs),
        },
        evidenceHealthFindings,
        interpretation: insight.interpretation,
        impactHypothesis: insight.impactHypothesis,
        contradictoryEvidenceRefs: contradictoryRefs,
        missingEvidence: insight.missingEvidence,
        applicability: insight.applicability,
        producer: {
          kind: "deterministic",
          implementationId: window.detector.id,
          implementationVersion: window.detector.version,
          implementationDigest: window.detector.implementationDigest,
          principal: null,
          attestation: null,
          modelFingerprintDigest: null,
          promptDigest: null,
          toolPolicyDigest: null,
          budgetPolicyDigest: null,
          disclosure: null,
        },
        candidateIntervention: insight.candidateIntervention,
        validation: insight.validation,
        supersedes:
          insight.supersedes === null
            ? null
            : {
                id: insight.supersedes.id,
                derivationDigest: insight.supersedes.digest,
                scopeDigest: window.scopeDigest,
              },
      };
      const derivationDigest = insightDerivationDigest(base);
      return parseInsightDerivation({
        schemaVersion: 1,
        id: `insight-${derivationDigest}`,
        ...base,
        derivationDigest,
      });
    })
    .sort((left, right) => (left.id < right.id ? -1 : 1));
  const executionBase = {
    loopRegistryRevision: window.loopRegistryRevision,
    detector: window.detector,
    pack: window.pack,
    lens: window.lens,
    scope: window.scope,
    scopeDigest: window.scopeDigest,
    scopePolicyDigest: window.scopePolicyDigest,
    outputKind: window.outputKind,
    window: compactWindow(window),
  };
  const result = {
    status: "applied" as const,
    conditionDetected: draft.conditionDetected,
    derivationRefs: derivations.map((derivation) => ({
      id: derivation.id,
      derivationDigest: derivation.derivationDigest,
      scopeDigest: derivation.scopeDigest,
    })),
    evidenceHealthFindings: findings,
  };
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
  return { execution, derivations };
}

export function assembleNonAppliedDetectorResult(
  window: DetectorWindow,
  status: "not_applicable" | "incomplete",
  reasonCodes: readonly string[],
  missingCapabilities: readonly string[],
): DetectorExecutionRecord {
  const executionBase = {
    loopRegistryRevision: window.loopRegistryRevision,
    detector: window.detector,
    pack: window.pack,
    lens: window.lens,
    scope: window.scope,
    scopeDigest: window.scopeDigest,
    scopePolicyDigest: window.scopePolicyDigest,
    outputKind: window.outputKind,
    window: compactWindow(window),
  };
  const result = { status, reasonCodes, missingCapabilities };
  const executionKeyDigest = detectorExecutionKeyDigest(executionBase);
  const executionDigest = detectorExecutionDigest({ ...executionBase, result, executionKeyDigest });
  return parseDetectorExecutionRecord({
    schemaVersion: 1,
    id: `detector-execution-${executionKeyDigest}`,
    ...executionBase,
    result,
    executionKeyDigest,
    executionDigest,
  });
}
