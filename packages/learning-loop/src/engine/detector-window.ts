// Explicit, bounded, provider-neutral detector window materialization.
import { Buffer } from "node:buffer";
import { canonicalJsonText, sha256HexOfCanonicalJson } from "../canonical/canonical-json.js";
import { toJsonValue } from "../canonical/to-json-value.js";
import { LearningLoopError } from "../diagnostics.js";
import type { DetectorOutputKind, DetectorRegistration } from "../records/detector-registration.js";
import type { LearningLensRegistration } from "../records/learning-lens.js";
import type { MeasurementEvidenceRefV2, ObservationEvidenceRef } from "../records/evidence-ref.js";
import { parseObservationEvidenceRefAt } from "../records/evidence-ref.js";
import type { MeasurementRecord } from "../records/episode.js";
import type { Observation } from "../records/observation.js";
import type { Scope } from "../records/scope.js";
import type { SourceSemanticProfile } from "../records/source-semantic-profile.js";
import type { EvidenceHealthFinding } from "../records/source-health.js";
import type { DetectorExecutionRecord } from "../records/detector-execution.js";
import type { EngineContext } from "./context.js";
import { loadStoredRecord, recordDigest } from "./context.js";
import type { CandidateEvidenceResolution, EvidenceHealthView } from "./evidence-binding.js";
import { resolveCandidateEvidence } from "./evidence-binding.js";
import { loadEpisodeIdentityState } from "./episode-identity.js";
import type { EpisodeView } from "./query.js";
import {
  runEpisodeQuery,
  runEvidenceHealthQuery,
  runMeasurementQuery,
  runObservationQuery,
  runSourcePageReceiptQuery,
} from "./query.js";
import { scopeDigest } from "../records/semantic-shared.js";

const MAX_EPISODES = 500;
const MAX_EVIDENCE = 5_000;
const MAX_WINDOW_BYTES = 16 * 1_048_576;

export interface DetectorWindow {
  readonly schemaVersion: 1;
  readonly loopRegistryRevision: string;
  readonly detector: DetectorExecutionRecord["detector"];
  readonly pack: DetectorExecutionRecord["pack"];
  readonly lens: DetectorExecutionRecord["lens"];
  readonly scope: Scope;
  readonly scopeDigest: string;
  readonly scopePolicyDigest: string;
  readonly outputKind: DetectorOutputKind;
  readonly sourceProfiles: readonly SourceSemanticProfile[];
  readonly population: {
    readonly episodes: readonly {
      readonly view: EpisodeView;
      readonly episodeRecordDigest: string;
      readonly episodeIdentityDigest: string;
      readonly outcomeClaimDigest: string | null;
      readonly episodeViewDigest: string;
      readonly scopeDigest: string;
    }[];
    readonly normalizationPolicyDigest: string;
    readonly comparabilityPolicyDigest: string | null;
    readonly populationDigest: string;
  };
  readonly evidence: readonly (
    | { readonly kind: "observation"; readonly record: Observation; readonly reference: ObservationEvidenceRef }
    | { readonly kind: "measurement"; readonly record: MeasurementRecord; readonly reference: MeasurementEvidenceRefV2 }
  )[];
  readonly evidenceHealthFindings: readonly EvidenceHealthFinding[];
  readonly availableCapabilities: readonly string[];
  readonly windowDigest: string;
}

export interface DetectorWindowMaterialization {
  readonly status: "ready" | "not_applicable" | "incomplete";
  readonly bindable: boolean;
  readonly window: DetectorWindow;
  readonly reasonCodes: readonly string[];
  readonly missingCapabilities: readonly string[];
  readonly evidenceHealth: EvidenceHealthView;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function trustRank(value: "untrusted" | "advisory" | "observed" | "verified"): number {
  if (value === "untrusted") return 0;
  if (value === "advisory") return 1;
  if (value === "observed") return 2;
  return 3;
}

function completenessRank(value: "complete" | "partial" | "unknown"): number {
  if (value === "unknown") return 0;
  if (value === "partial") return 1;
  return 2;
}

function mergeHealth(left: EvidenceHealthView, right: EvidenceHealthView): EvidenceHealthView {
  const rank = { ready: 0, legacy_unbound: 1, incomplete: 2, invalid: 3 } as const;
  const status = rank[left.status] >= rank[right.status] ? left.status : right.status;
  return { status, diagnostics: [...left.diagnostics, ...right.diagnostics] };
}

async function collect<T>(iterable: AsyncIterable<{ readonly items: readonly T[] }>, maximum: number): Promise<T[]> {
  const items: T[] = [];
  for await (const page of iterable) {
    if (items.length + page.items.length > maximum) {
      throw new LearningLoopError("detector.limit_exceeded", [
        { code: "detector.limit_exceeded", severity: "error", message: "detector window exceeded a hard ceiling" },
      ]);
    }
    items.push(...page.items);
  }
  return items;
}

function outcomeDigest(view: EpisodeView): string | null {
  return view.outcomeLineage.status === "resolved" ? view.outcomeLineage.claimDigest : null;
}

function episodeViewDigest(input: {
  readonly episodeRecordId: string;
  readonly episodeRecordDigest: string;
  readonly episodeIdentityDigest: string;
  readonly outcomeClaimDigest: string | null;
  readonly scopeDigest: string;
}): string {
  return sha256HexOfCanonicalJson(toJsonValue(input));
}

function compactWindow(
  window: Omit<DetectorWindow, "schemaVersion" | "windowDigest">,
): Omit<DetectorExecutionRecord["window"], "windowDigest"> {
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
  };
}

export async function materializeDetectorWindow(input: {
  readonly context: EngineContext;
  readonly detector: DetectorRegistration;
  readonly pack: DetectorExecutionRecord["pack"];
  readonly lens: DetectorExecutionRecord["lens"];
  readonly lensRegistration?: LearningLensRegistration;
  readonly scope: Scope;
  readonly episodeRecordIds: readonly string[];
}): Promise<DetectorWindowMaterialization> {
  const { context, detector, pack, lens } = input;
  if (input.episodeRecordIds.length > MAX_EPISODES) {
    throw new LearningLoopError("detector.limit_exceeded", [
      { code: "detector.limit_exceeded", severity: "error", message: "detector episode input exceeds its ceiling" },
    ]);
  }
  const validatedScope = context.scopePolicy.validate(input.scope);
  const scope = deepFreeze(validatedScope.map((segment) => ({ type: segment.type, id: segment.id })));
  const exactScopeDigest = scopeDigest(scope);
  const episodeIds = new Set(input.episodeRecordIds);
  const queriedEpisodes = await collect(
    runEpisodeQuery(context, {
      recordIds: input.episodeRecordIds,
      scope,
      limit: Math.max(1, input.episodeRecordIds.length),
    }),
    MAX_EPISODES,
  );
  const byId = new Map(queriedEpisodes.map((view) => [view.episode.id, view]));
  const views = input.episodeRecordIds.flatMap((id) => {
    const view = byId.get(id);
    return view === undefined ? [] : [view];
  });
  const reasonCodes: string[] = [];
  let bindable = true;
  let status: DetectorWindowMaterialization["status"] = "ready";
  if (input.episodeRecordIds.length === 0 || views.length === 0) {
    status = "not_applicable";
    reasonCodes.push("population.empty");
    if (input.episodeRecordIds.length > 0) bindable = false;
  } else if (views.length !== episodeIds.size) {
    bindable = false;
    status = "not_applicable";
    reasonCodes.push("population.missing");
  } else if (views.some((view) => view.identity.status !== "resolved")) {
    bindable = false;
    status = "incomplete";
    reasonCodes.push("population.unresolved");
  }

  const populationEpisodes: DetectorWindow["population"]["episodes"][number][] = [];
  const sourceIds = new Set<string>();
  const logicalEpisodeIds = new Set<string>();
  const populationPairs = new Set<string>();
  const detectorClasses =
    detector.episodeClasses.mode === "include" ? new Set(detector.episodeClasses.values) : undefined;
  const lensClasses =
    input.lensRegistration?.episodeClasses.mode === "include"
      ? new Set(input.lensRegistration.episodeClasses.values)
      : undefined;
  const episodeRequirement = input.lensRegistration?.evidenceRequirements.find(
    (requirement) => requirement.kind === "episode",
  );
  for (const view of views) {
    const stored = await loadStoredRecord(context, "episode", view.episode.id);
    const identity = await loadEpisodeIdentityState(context, view.episode.id);
    if (stored === undefined || identity.status !== "resolved") {
      bindable = false;
      status = "incomplete";
      reasonCodes.push("population.unresolved");
      continue;
    }
    const profile = context.sourceSemanticProfilesBySourceId?.get(identity.identity.sourceId);
    if (profile === undefined || profile.sourceRegistrationRevision !== identity.identity.registryRevision) {
      bindable = false;
      status = "not_applicable";
      reasonCodes.push("source.profile_missing");
      continue;
    }
    const episodeClass = identity.identity.episodeClass;
    if (
      (detectorClasses !== undefined && (episodeClass === undefined || !detectorClasses.has(episodeClass))) ||
      (lensClasses !== undefined && (episodeClass === undefined || !lensClasses.has(episodeClass)))
    ) {
      status = "not_applicable";
      bindable = false;
      reasonCodes.push("episode_class.not_applicable");
      continue;
    }
    if (
      episodeRequirement !== undefined &&
      (trustRank(identity.identity.trustCeiling) < trustRank(episodeRequirement.minimumTrust) ||
        completenessRank(identity.identity.completeness) < completenessRank(episodeRequirement.minimumCompleteness))
    ) {
      status = "incomplete";
      reasonCodes.push("episode.evidence_floor");
    }
    if (
      trustRank(identity.identity.trustCeiling) < trustRank(detector.minimumTrust) ||
      completenessRank(identity.identity.completeness) < completenessRank(detector.minimumCompleteness)
    ) {
      status = "incomplete";
      reasonCodes.push("episode.detector_floor");
    }
    sourceIds.add(identity.identity.sourceId);
    logicalEpisodeIds.add(identity.identity.episodeId);
    populationPairs.add(JSON.stringify([identity.identity.sourceId, identity.identity.episodeId]));
    const identityDigest = recordDigest(toJsonValue(identity.identity));
    const exactOutcomeDigest = outcomeDigest(view);
    const digestInput = {
      episodeRecordId: view.episode.id,
      episodeRecordDigest: stored.digest,
      episodeIdentityDigest: identityDigest,
      outcomeClaimDigest: exactOutcomeDigest,
      scopeDigest: exactScopeDigest,
    };
    populationEpisodes.push({
      view,
      episodeRecordDigest: stored.digest,
      episodeIdentityDigest: identityDigest,
      outcomeClaimDigest: exactOutcomeDigest,
      episodeViewDigest: episodeViewDigest(digestInput),
      scopeDigest: exactScopeDigest,
    });
  }

  const sourceProfiles = [...sourceIds]
    .flatMap((sourceId) => {
      const profile = context.sourceSemanticProfilesBySourceId?.get(sourceId);
      return profile === undefined ? [] : [profile];
    })
    .sort((left, right) => compareText(left.sourceId, right.sourceId));
  const availableCapabilities = [...new Set(sourceProfiles.flatMap((profile) => profile.capabilities))].sort(
    compareText,
  );
  const missingCapabilities = detector.requiredCapabilities.filter(
    (capability) => !availableCapabilities.includes(capability),
  );
  if (missingCapabilities.length > 0) {
    status = "not_applicable";
    reasonCodes.push("capability.missing");
  }
  if (sourceProfiles.some((profile) => profile.observationVocabularyDigest !== detector.observationVocabularyDigest)) {
    status = "not_applicable";
    reasonCodes.push("vocabulary.mismatch");
  }

  const sourceIdList = [...sourceIds].sort(compareText);
  const episodeIdList = [...logicalEpisodeIds].sort(compareText);
  const queriedObservations = await collect(
    runObservationQuery(context, {
      sourceIds: sourceIdList,
      episodeIds: episodeIdList,
      kinds: detector.acceptedObservationKinds,
      limit: 500,
    }),
    MAX_EVIDENCE,
  );
  const observations = queriedObservations.filter((record) =>
    populationPairs.has(JSON.stringify([record.provenance.sourceId, record.episodeId])),
  );
  const measurements = (
    await collect(
      runMeasurementQuery(context, { sourceIds: sourceIdList, episodeIds: episodeIdList, limit: 500 }),
      MAX_EVIDENCE - queriedObservations.length,
    )
  ).filter((record) => populationPairs.has(JSON.stringify([record.provenance.sourceId, record.episodeId])));
  const records = [...observations, ...measurements].sort((left, right) => compareText(left.id, right.id));
  let resolution: CandidateEvidenceResolution = {
    refs: [],
    records: [],
    health: { status: "ready", diagnostics: [] },
  };
  if (records.length > 0) {
    resolution = await resolveCandidateEvidence(
      context,
      records.map((record) => record.id),
      scope,
    );
  }
  let evidenceHealth = resolution.health;
  if (resolution.refs.length !== records.length && status === "ready") {
    status = "incomplete";
    reasonCodes.push("evidence.unresolved");
  }
  if (evidenceHealth.status !== "ready" && status === "ready") {
    status = "incomplete";
    reasonCodes.push(evidenceHealth.status === "invalid" ? "evidence.invalid" : "evidence.incomplete");
  }

  const evidence: DetectorWindow["evidence"][number][] = [];
  for (const [index, reference] of resolution.refs.entries()) {
    const record = resolution.records[index];
    if (record === undefined) continue;
    if (reference.schemaVersion === 1 && reference.kind === "observation" && "kind" in record) {
      evidence.push({ kind: "observation", record, reference: parseObservationEvidenceRefAt(reference, ["evidence"]) });
    } else if (reference.schemaVersion === 2 && reference.kind === "measurement" && "metric" in record) {
      evidence.push({ kind: "measurement", record, reference });
    }
  }
  if (
    resolution.refs.some(
      (reference) =>
        trustRank(reference.trust) < trustRank(detector.minimumTrust) ||
        completenessRank(reference.completeness) < completenessRank(detector.minimumCompleteness),
    )
  ) {
    if (status !== "not_applicable") status = "incomplete";
    reasonCodes.push("evidence.detector_floor");
  }
  for (const requirement of input.lensRegistration?.evidenceRequirements ?? []) {
    if (requirement.kind === "episode") continue;
    const matching = resolution.refs.filter((reference) => reference.kind === requirement.kind);
    if (
      matching.length === 0 ||
      matching.some(
        (reference) =>
          trustRank(reference.trust) < trustRank(requirement.minimumTrust) ||
          completenessRank(reference.completeness) < completenessRank(requirement.minimumCompleteness),
      )
    ) {
      if (status !== "not_applicable") status = "incomplete";
      reasonCodes.push("evidence.lens_floor");
    }
  }

  const pageKeys = new Set(
    resolution.refs.map((reference) =>
      JSON.stringify([
        reference.sourceId,
        reference.sourceRegistrationRevision,
        reference.sourceRef,
        reference.pageRef,
      ]),
    ),
  );
  const receipts = await collect(
    runSourcePageReceiptQuery(context, { sourceIds: sourceIdList, limit: 500 }),
    MAX_EVIDENCE,
  );
  const populationIds = new Set(populationEpisodes.map((episode) => episode.view.episode.id));
  for (const receipt of receipts) {
    if (receipt.derivatives.some((derivative) => derivative.kind === "episode" && populationIds.has(derivative.id))) {
      pageKeys.add(
        JSON.stringify([receipt.sourceId, receipt.sourceRegistrationRevision, receipt.sourceRef, receipt.pageRef]),
      );
    }
  }
  const findings = await collect(
    runEvidenceHealthQuery(context, { sourceIds: sourceIdList, limit: 500 }),
    MAX_EVIDENCE,
  );
  const evidenceHealthFindings = findings.filter((finding) =>
    pageKeys.has(
      JSON.stringify([finding.sourceId, finding.sourceRegistrationRevision, finding.sourceRef, finding.pageRef]),
    ),
  );
  for (const finding of evidenceHealthFindings) {
    const findingHealth: EvidenceHealthView = {
      status: finding.effect === "blocks_use" ? "invalid" : "incomplete",
      diagnostics: [
        {
          code: finding.effect === "blocks_use" ? "detector.evidence_blocked" : "detector.evidence_limited",
          severity: finding.effect === "blocks_use" ? "error" : "warning",
          message: "detector input is constrained by durable evidence health",
        },
      ],
    };
    evidenceHealth = mergeHealth(evidenceHealth, findingHealth);
  }
  if (evidenceHealth.status !== "ready" && status === "ready") status = "incomplete";

  const compactEpisodes = populationEpisodes.map((episode) => ({
    episodeRecordId: episode.view.episode.id,
    episodeRecordDigest: episode.episodeRecordDigest,
    episodeIdentityDigest: episode.episodeIdentityDigest,
    outcomeClaimDigest: episode.outcomeClaimDigest,
    episodeViewDigest: episode.episodeViewDigest,
    scopeDigest: episode.scopeDigest,
  }));
  const populationDigest = sha256HexOfCanonicalJson(
    toJsonValue({
      episodes: compactEpisodes,
      normalizationPolicyDigest: detector.normalizationPolicyDigest,
      comparabilityPolicyDigest: detector.comparabilityPolicyDigest,
    }),
  );
  const population = {
    episodes: populationEpisodes,
    normalizationPolicyDigest: detector.normalizationPolicyDigest,
    comparabilityPolicyDigest: detector.comparabilityPolicyDigest,
    populationDigest,
  };
  const base: Omit<DetectorWindow, "schemaVersion" | "windowDigest"> = {
    loopRegistryRevision: context.registryRevision,
    detector: {
      id: detector.id,
      version: detector.version,
      registrationDigest: detector.registrationDigest,
      configurationDigest: detector.configurationDigest,
      implementationDigest: detector.implementationDigest,
    },
    pack,
    lens,
    scope,
    scopeDigest: exactScopeDigest,
    scopePolicyDigest: context.scopePolicy.digest,
    outputKind: detector.outputKind,
    sourceProfiles,
    population,
    evidence,
    evidenceHealthFindings,
    availableCapabilities,
  };
  const compact = compactWindow(base);
  const windowDigest = sha256HexOfCanonicalJson(toJsonValue(compact));
  const window = deepFreeze({ schemaVersion: 1 as const, ...base, windowDigest });
  if (Buffer.byteLength(canonicalJsonText(toJsonValue(window)), "utf8") > MAX_WINDOW_BYTES) {
    throw new LearningLoopError("detector.limit_exceeded", [
      { code: "detector.limit_exceeded", severity: "error", message: "detector window bytes exceed its ceiling" },
    ]);
  }
  return {
    status,
    bindable,
    window,
    reasonCodes: [...new Set(reasonCodes)].sort(compareText),
    missingCapabilities: [...missingCapabilities].sort(compareText),
    evidenceHealth,
  };
}
