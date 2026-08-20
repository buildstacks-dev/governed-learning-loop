import type {
  DetectorOrchestrationPolicy,
  DetectorPackManifest,
  DetectorRecurrenceLocator,
  DetectorRegistration,
  DetectorRunInput,
  DetectorWindow,
  LearningLoop,
  LearningStore,
  Scope,
  SemanticRegistryConfig,
} from "../src/index.js";
import {
  conservativePolicy,
  createLearningLoop,
  defineDetectorImplementation,
  detectorOrchestrationPolicyDigest,
  detectorPackManifestDigest,
  detectorRegistrationDigest,
  parseDetectorPackManifest,
  parseDetectorOrchestrationPolicy,
  parseDetectorRegistration,
  parseSemanticRegistryConfig,
  semanticRegistryDigest,
  sha256HexOfCanonicalJson,
  toJsonValue,
} from "../src/index.js";
import type { EngineContext } from "../src/engine/context.js";
import { detectorRefKey, lensRefKey, packRefKey } from "../src/records/semantic-shared.js";
import { createInMemoryStore } from "../src/testing/index.js";
import { createSemanticEngineHarness } from "./semantic-engine-harness.js";

export const PRIVATE_KEY_POLICY_DIGEST = "a".repeat(64);
export const PRIVATE_LOCATOR = {
  treatment: "tenant_keyed_private",
  keyedDigest: "d".repeat(64),
  keyPolicyDigest: PRIVATE_KEY_POLICY_DIGEST,
} satisfies DetectorRecurrenceLocator;
export const PUBLIC_LOCATOR = {
  treatment: "public_structural",
  structuralLabel: "status_poll",
} satisfies DetectorRecurrenceLocator;

export function createDetectorOrchestrationPolicy(
  input: {
    readonly maximumInvocationsPerRun?: number;
    readonly maximumInsightGroupsPerRun?: number;
    readonly maximumEvidenceHealthGroupsPerRun?: number;
    readonly rejectionSuppression?: DetectorOrchestrationPolicy["rejectionSuppression"];
  } = {},
): DetectorOrchestrationPolicy {
  const rejectionSuppression: DetectorOrchestrationPolicy["rejectionSuppression"] = input.rejectionSuppression ?? {
    mode: "disabled",
  };
  const base = {
    id: "host.detector-orchestration",
    version: "1.0.0",
    caps: {
      maximumInvocationsPerRun: input.maximumInvocationsPerRun ?? 100,
      maximumInsightGroupsPerRun: input.maximumInsightGroupsPerRun ?? 100,
      maximumEvidenceHealthGroupsPerRun: input.maximumEvidenceHealthGroupsPerRun ?? 100,
    },
    rejectionSuppression,
  };
  return parseDetectorOrchestrationPolicy({
    schemaVersion: 1,
    ...base,
    policyDigest: detectorOrchestrationPolicyDigest(base),
  });
}

function digest(value: unknown): string {
  return sha256HexOfCanonicalJson(toJsonValue(value));
}

export function detectorRef(detector: DetectorRegistration) {
  return { id: detector.id, version: detector.version, registrationDigest: detector.registrationDigest };
}

export function packRef(pack: DetectorPackManifest) {
  return { id: pack.id, version: pack.version, manifestDigest: pack.manifestDigest };
}

function lensRef(input: { readonly id: string; readonly version: string; readonly registrationDigest: string }) {
  return { id: input.id, version: input.version, registrationDigest: input.registrationDigest };
}

export interface RecurrenceRunnerHarness {
  readonly learning: LearningLoop;
  readonly context: EngineContext;
  readonly detector: DetectorRegistration;
  readonly pack: DetectorPackManifest;
  readonly registry: SemanticRegistryConfig;
  readonly scope: Scope;
  readonly episodeRecordIds: readonly string[];
  readonly store: LearningStore;
  readonly callbacks: () => number;
}

export async function createRecurrenceRunnerHarness(
  input: {
    readonly treatment?: DetectorRegistration["privacy"]["signatureTreatment"];
    readonly privacyPolicyDigest?: string;
    readonly evaluate?: (window: DetectorWindow) => unknown;
    readonly store?: LearningStore;
    readonly label?: string;
    readonly episodeCount?: number;
    readonly detectorId?: string;
    readonly detectorVersion?: string;
    readonly packId?: string;
    readonly implementation?: boolean;
    readonly detectorRequiredCapabilities?: readonly string[];
    readonly detectorOrchestrationPolicy?: DetectorOrchestrationPolicy;
    readonly scope?: Scope;
  } = {},
): Promise<RecurrenceRunnerHarness> {
  const template = await createSemanticEngineHarness({
    label: `template-${input.label ?? "recurrence"}`,
    ...(input.scope === undefined ? {} : { scope: input.scope }),
  });
  const {
    schemaVersion: _detectorSchema,
    registrationDigest: _detectorDigest,
    ...detectorTemplate
  } = template.detector;
  const detectorBase = {
    ...detectorTemplate,
    id: input.detectorId ?? detectorTemplate.id,
    version: input.detectorVersion ?? detectorTemplate.version,
    requiredCapabilities: input.detectorRequiredCapabilities ?? detectorTemplate.requiredCapabilities,
    privacy: {
      ...detectorTemplate.privacy,
      signatureTreatment: input.treatment ?? "tenant_keyed_private",
      policyDigest: input.privacyPolicyDigest ?? PRIVATE_KEY_POLICY_DIGEST,
    },
    supersedes: null,
  };
  const detector = parseDetectorRegistration({
    schemaVersion: 1,
    ...detectorBase,
    registrationDigest: detectorRegistrationDigest(detectorBase),
  });
  const packBase = {
    id: input.packId ?? template.pack.id,
    version: template.pack.version,
    kind: template.pack.kind,
    detectors: [detectorRef(detector)],
    lenses: [lensRef(template.lens)],
    changelogDigest: template.pack.changelogDigest,
    supersedes: null,
  };
  const pack = parseDetectorPackManifest({
    schemaVersion: 1,
    ...packBase,
    manifestDigest: detectorPackManifestDigest(packBase),
  });
  const registryBase = {
    scopePolicyDigest: template.registry.scopePolicyDigest,
    detectors: [detector],
    packs: [pack],
    lenses: [template.lens],
    sourceProfiles: [template.profile],
    selectedDetectorRefs: [detectorRef(detector)],
    selectedPackRefs: [packRef(pack)],
    selectedLensRefs: [lensRef(template.lens)],
  };
  const registry = parseSemanticRegistryConfig({
    schemaVersion: 1,
    ...registryBase,
    registryDigest: semanticRegistryDigest(registryBase),
  });
  let callbackCount = 0;
  const implementation = defineDetectorImplementation({
    registration: detector,
    evaluate: (window) => {
      callbackCount += 1;
      return input.evaluate?.(window) ?? { conditionDetected: false, insights: [], findings: [] };
    },
  });
  const store = input.store ?? createInMemoryStore();
  const policy = conservativePolicy();
  const learning = createLearningLoop({
    store,
    policy,
    identity: template.context.identity,
    scopePolicy: template.context.scopePolicy,
    contentPolicies: [...template.context.contentPoliciesById.values()],
    sources: [template.source],
    semanticRegistry: registry,
    ...(input.implementation === false ? {} : { detectorImplementations: [implementation] }),
    ...(input.detectorOrchestrationPolicy === undefined
      ? {}
      : { detectorOrchestrationPolicy: input.detectorOrchestrationPolicy }),
    queryCursorScope: `detector-recurrence-${input.label ?? "fixture"}`,
    clock: template.context.clock,
    ids: template.context.ids,
  });
  const label = input.label ?? "recurrence";
  const episodeCount = input.episodeCount ?? 1;
  const episodeIds = Array.from({ length: episodeCount }, (_, index) => `${label}-episode-${index}`);
  const receipt = await learning.ingest(template.source, {
    observations: episodeIds.map((episodeId, index) => ({
      id: `${label}-observation-${index}`,
      episodeId,
      occurredAt: `2026-08-20T00:0${String(index + 1)}:00.000Z`,
      kind: "tool.process.completed",
      data: { index },
    })),
    episodes: episodeIds.map((episodeId, index) => ({
      id: episodeId,
      episodeClass: "interactive",
      scope: template.scope,
      openedAt: `2026-08-20T00:0${String(index)}:00.000Z`,
      closedAt: `2026-08-20T00:1${String(index)}:00.000Z`,
    })),
  });
  const context: EngineContext = {
    ...template.context,
    store,
    policy,
    semanticRegistry: registry,
    semanticDetectorsByRef: new Map([[detectorRefKey(detectorRef(detector)), detector]]),
    semanticPacksByRef: new Map([[packRefKey(packRef(pack)), pack]]),
    semanticLensesByRef: new Map([[lensRefKey(lensRef(template.lens)), template.lens]]),
    sourceSemanticProfilesBySourceId: new Map([[template.source.id, template.profile]]),
    detectorImplementationsByRef:
      input.implementation === false ? new Map() : new Map([[detectorRefKey(implementation.detector), implementation]]),
    ...(input.detectorOrchestrationPolicy === undefined
      ? {}
      : { detectorOrchestrationPolicy: input.detectorOrchestrationPolicy }),
    registryRevision: receipt.registryRevision,
  };
  return {
    learning,
    context,
    detector,
    pack,
    registry,
    scope: template.scope,
    episodeRecordIds: episodeIds.map((episodeId) => `${template.source.id}/${episodeId}`),
    store,
    callbacks: () => callbackCount,
  };
}

export function recurrenceRunInput(
  harness: RecurrenceRunnerHarness,
  mode: DetectorRunInput["mode"],
  episodeRecordIds: readonly string[] = harness.episodeRecordIds,
): DetectorRunInput {
  return {
    mode,
    detector: detectorRef(harness.detector),
    pack: packRef(harness.pack),
    lens: harness.detector.outputKind === "insight_derivation" ? (harness.registry.selectedLensRefs[0] ?? null) : null,
    scope: harness.scope,
    episodeRecordIds,
  };
}

export function detectedInsightDraft(window: DetectorWindow, recurrenceLocator?: unknown): unknown {
  const evidenceDigest = window.evidence[0]?.reference.referenceDigest;
  const draft = {
    conditionDetected: true,
    insights: [
      {
        learningClass: "system_meta",
        directObservation: {
          statement: "A deterministic recurrence condition was observed.",
          data: { condition: "recurrence" },
          evidenceReferenceDigests: evidenceDigest === undefined ? [] : [evidenceDigest],
        },
        interpretation: {
          statement: "The condition may represent a repeated operational pattern.",
          confidence: "medium",
          uncertainty: ["Causal impact remains unvalidated."],
        },
        impactHypothesis: { statement: "A reversible intervention may reduce recurrence." },
        contradictoryEvidenceReferenceDigests: [],
        evidenceHealthFindingIds: [],
        missingEvidence: [],
        applicability: { statement: "Applies only to the exact registered scope.", exclusions: ["benchmark traffic"] },
        candidateIntervention: {
          summary: "Record a reversible recurrence note.",
          proposedDestinationKind: "report-note",
          proposedDestinationId: "host/semantic-note",
          contentDraft: { action: "observe-recurrence" },
          rollbackIntent: "Remove the unvalidated note.",
        },
        validation: {
          method: "comparable-held-out-episodes",
          comparablePopulation: null,
          comparablePopulationDigest: null,
          successCriterion: "The declared exact metric changes.",
          guardrails: ["Do not infer harm from recurrence alone."],
          strategyDigest: digest({ method: "held-out-comparable-episodes" }),
        },
        supersedes: null,
      },
    ],
    findings: [],
  };
  return recurrenceLocator === undefined ? draft : { ...draft, recurrenceLocator };
}
