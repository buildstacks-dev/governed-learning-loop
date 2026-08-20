import type {
  CandidateInput,
  DetectorExecutionQuery,
  DetectorExecutionRecord,
  DetectorExecutionView,
  DetectorOrchestrationPolicy,
  DetectorOrchestrationDisposition,
  DetectorPackManifest,
  DetectorPackRunInput,
  DetectorPackRunResult,
  DetectorRecurrenceLocator,
  DetectorRegistration,
  DetectorResultDraft,
  DetectorRunInput,
  DetectorRunResult,
  DetectorWindow,
  EvidenceSource,
  InsightDerivationQuery,
  InsightDerivationView,
  RegisteredDetectorImplementation,
  SemanticRegistryConfig,
  SourceSemanticProfile,
} from "@cormidia/learning-loop";
import {
  conservativePolicy,
  createExactScopePolicy,
  createLearningLoop,
  detectorExecutionDigest,
  detectorExecutionKeyDigest,
  detectorOrchestrationPolicyDigest,
  detectorPackManifestDigest,
  detectorRegistrationDigest,
  defineDetectorImplementation,
  defineSourceRegistration,
  parseDetectorExecutionRecord,
  parseDetectorOrchestrationPolicy,
  parseDetectorPackManifest,
  parseDetectorRegistration,
  parseSemanticRegistryConfig,
  parseSourceSemanticProfile,
  scopeDigest,
  semanticRegistryDigest,
  sha256HexOfCanonicalJson,
  sourceSemanticProfileDigest,
  toJsonValue,
} from "@cormidia/learning-loop";
import {
  createInMemoryStore,
  createStructuredContentPolicy,
  createTestIdentityPort,
} from "@cormidia/learning-loop/testing";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { foldStore } from "../src/fold.js";
import { cli, makeTempDir, removeDir } from "./support.js";

test("a multi-page fold reports aggregate page progress before completion", async () => {
  const contentPolicyId = "progress-structured-v1";
  const source: EvidenceSource<null> = {
    descriptor: { id: "progress-source", adapterVersion: "1.0.0" },
    probe: () => Promise.resolve({ supported: true, sourceRevision: "progress-revision", diagnostics: [] }),
    read: async function* () {
      yield {
        sourceRef: "progress-input",
        pageRef: "page-0",
        state: { status: "available", sourceRevision: "progress-revision", completeness: "complete" as const },
        observations: Array.from({ length: 201 }, (_, index) => ({
          sourceRecordId: `obs-${String(index).padStart(3, "0")}`,
          episodeId: "progress-episode",
          kind: "test.progress",
          data: { index },
          completeness: "complete" as const,
        })),
        measurements: [],
        episodes: [
          {
            sourceRecordId: "episode-record",
            episodeId: "progress-episode",
            scope: [
              { type: "provider", id: "test" },
              { type: "project", id: "progress" },
            ],
            openedAt: "2026-08-19T00:00:00.000Z",
            status: "unknown" as const,
            measurementSourceRecordIds: [],
          },
        ],
        diagnostics: [],
      };
    },
  };
  const registered = defineSourceRegistration({ source, trustCeiling: "observed", contentPolicyId });
  const learning = createLearningLoop({
    store: createInMemoryStore(),
    policy: conservativePolicy(),
    identity: createTestIdentityPort(),
    scopePolicy: createExactScopePolicy(),
    contentPolicies: [createStructuredContentPolicy({ id: contentPolicyId })],
    sources: [registered],
  });
  await learning.ingest(registered, null);

  const progress: { readonly records: number; readonly pages: number; readonly heartbeat: boolean }[] = [];
  const fold = await foldStore(learning, (event) => {
    if (event.kind === "observations") {
      progress.push({ records: event.records, pages: event.pages, heartbeat: event.heartbeat });
    }
  });

  expect(fold.observationCount).toBe(201);
  expect([...fold.projects.values()].map((project) => `${project.provider}/${project.project}`)).toEqual([
    "test/progress",
  ]);
  expect(progress).toEqual([
    { records: 200, pages: 1, heartbeat: false },
    { records: 201, pages: 2, heartbeat: false },
  ]);
});

test("report announces its resolved state and remains read-only when state is absent", async () => {
  const outer = makeTempDir("ti-read-only-");
  const stateDir = join(outer, "missing-state");
  try {
    const result = await cli(["report", "--state", stateDir]);
    expect(result.code).toBe(0);
    expect(result.lines[0]).toBe(`report: start state=${stateDir} operation=read-only`);
    expect(result.text).toContain("report: listing observations records=0 pages=1");
    expect(existsSync(stateDir)).toBe(false);
  } finally {
    removeDir(outer);
  }
});

test("strict consumer can construct and parse host-neutral semantic records from the public root", async () => {
  const configuration = { detector: "strict-consumer-evidence-coverage", version: 1 };
  const falsePositivePolicy = { policy: "no-behavioral-denominator" };
  const validationCriterion = { criterion: "all selected pages available" };
  const digest = (value: unknown): string => sha256HexOfCanonicalJson(toJsonValue(value));
  const base: Omit<DetectorRegistration, "schemaVersion" | "registrationDigest"> = {
    id: "host:transcript-evidence-coverage",
    version: "1.0.0",
    maturity: "experimental",
    implementationDigest: "1".repeat(64),
    configuration,
    configurationDigest: digest(configuration),
    thresholds: null,
    thresholdDigest: null,
    observationVocabularyDigest: "2".repeat(64),
    requiredCapabilities: ["source.health"],
    acceptedObservationKinds: ["source.health"],
    minimumTrust: "untrusted",
    minimumCompleteness: "unknown",
    episodeClasses: { mode: "any" },
    scopePolicyDigest: "3".repeat(64),
    scopeConstraint: { mode: "invocation" },
    lensConstraint: { mode: "independent" },
    normalizationPolicyDigest: "4".repeat(64),
    comparabilityPolicyDigest: null,
    outputKind: "evidence_health",
    positiveFixtureDigests: ["5".repeat(64)],
    negativeFixtureDigests: ["6".repeat(64)],
    falsePositivePolicy,
    falsePositivePolicyDigest: digest(falsePositivePolicy),
    calibrationPopulation: null,
    calibrationPopulationDigest: null,
    calibrationEvidenceDigest: null,
    privacy: {
      signatureTreatment: "none",
      transientContent: "forbidden",
      policyDigest: "7".repeat(64),
    },
    proposedValidationCriterion: validationCriterion,
    proposedValidationCriterionDigest: digest(validationCriterion),
    supersedes: null,
  };
  const registration = parseDetectorRegistration({
    schemaVersion: 1,
    ...base,
    registrationDigest: detectorRegistrationDigest(base),
  });
  expect(registration).toMatchObject({
    id: "host:transcript-evidence-coverage",
    outputKind: "evidence_health",
    lensConstraint: { mode: "independent" },
  });

  const profileBase: Omit<SourceSemanticProfile, "schemaVersion" | "profileDigest"> = {
    sourceId: "strict-consumer-source",
    sourceRegistrationRevision: "8".repeat(64),
    observationVocabularyDigest: registration.observationVocabularyDigest,
    capabilities: ["source.health"],
    observationKinds: ["source.health"],
  };
  const profile = parseSourceSemanticProfile({
    schemaVersion: 1,
    ...profileBase,
    profileDigest: sourceSemanticProfileDigest(profileBase),
  });
  const detectorRef = {
    id: registration.id,
    version: registration.version,
    registrationDigest: registration.registrationDigest,
  };
  const packBase: Omit<DetectorPackManifest, "schemaVersion" | "manifestDigest"> = {
    id: "strict-consumer-pack",
    version: "1.0.0",
    kind: "host",
    detectors: [detectorRef],
    lenses: [],
    changelogDigest: "9".repeat(64),
    supersedes: null,
  };
  const pack = parseDetectorPackManifest({
    schemaVersion: 1,
    ...packBase,
    manifestDigest: detectorPackManifestDigest(packBase),
  });
  const packRef = { id: pack.id, version: pack.version, manifestDigest: pack.manifestDigest };
  const registryBase: Omit<SemanticRegistryConfig, "schemaVersion" | "registryDigest"> = {
    scopePolicyDigest: registration.scopePolicyDigest,
    detectors: [registration],
    packs: [pack],
    lenses: [],
    sourceProfiles: [profile],
    selectedDetectorRefs: [detectorRef],
    selectedPackRefs: [packRef],
    selectedLensRefs: [],
  };
  const registry = parseSemanticRegistryConfig({
    schemaVersion: 1,
    ...registryBase,
    registryDigest: semanticRegistryDigest(registryBase),
  });
  expect(registry.selectedDetectorRefs).toEqual([detectorRef]);

  const executionScope = [{ type: "project", id: "strict-consumer" }];
  const episodes: DetectorExecutionRecord["window"]["population"]["episodes"] = [];
  const normalizationPolicyDigest = registration.normalizationPolicyDigest;
  const comparabilityPolicyDigest = registration.comparabilityPolicyDigest;
  const population = {
    episodes,
    normalizationPolicyDigest,
    comparabilityPolicyDigest,
    populationDigest: digest({ episodes, normalizationPolicyDigest, comparabilityPolicyDigest }),
  };
  const windowBase = {
    sourceProfiles: [profile],
    population,
    evidenceRefs: [],
    evidenceHealthFindings: [],
    availableCapabilities: ["source.health"],
  };
  const window = { ...windowBase, windowDigest: digest(windowBase) };
  const executionBase = {
    loopRegistryRevision: "a".repeat(64),
    detector: {
      ...detectorRef,
      configurationDigest: registration.configurationDigest,
      implementationDigest: registration.implementationDigest,
    },
    pack: packRef,
    lens: null,
    scope: executionScope,
    scopeDigest: scopeDigest(executionScope),
    scopePolicyDigest: registration.scopePolicyDigest,
    outputKind: registration.outputKind,
    window,
  };
  const result: DetectorExecutionRecord["result"] = {
    status: "applied",
    conditionDetected: false,
    derivationRefs: [],
    evidenceHealthFindings: [],
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
  expect(execution).toMatchObject({
    outputKind: "evidence_health",
    result: { status: "applied", conditionDetected: false },
  });

  const semanticLearning = createLearningLoop({
    store: createInMemoryStore(),
    policy: conservativePolicy(),
    identity: createTestIdentityPort(),
    scopePolicy: createExactScopePolicy(),
    contentPolicies: [],
    sources: [],
    queryCursorScope: "strict-semantic-consumer",
  });
  const derivationQuery: InsightDerivationQuery = {
    scope: executionScope,
    detectorIds: [registration.id],
    registryStatuses: ["configured", "historical_unconfigured"],
    commitStatuses: ["committed", "orphaned", "invalid"],
    limit: 10,
  };
  const derivationViews: InsightDerivationView[] = [];
  for await (const page of semanticLearning.queryInsightDerivations(derivationQuery)) {
    derivationViews.push(...page.items);
  }
  expect(derivationViews).toEqual([]);
  await expect(
    semanticLearning.getInsightDerivation({ derivationId: `insight-${"0".repeat(64)}`, scope: executionScope }),
  ).resolves.toBeUndefined();

  const executionQuery: DetectorExecutionQuery = {
    scope: executionScope,
    statuses: ["applied", "not_applicable", "incomplete"],
    conditionDetected: false,
    registryStatuses: ["configured", "historical_unconfigured"],
    commitStatuses: ["committed", "invalid"],
    limit: 10,
  };
  const executionViews: DetectorExecutionView[] = [];
  for await (const page of semanticLearning.queryDetectorExecutions(executionQuery)) {
    executionViews.push(...page.items);
  }
  expect(executionViews).toEqual([]);
  await expect(
    semanticLearning.getDetectorExecution({
      executionId: `detector-execution-${"0".repeat(64)}`,
      scope: executionScope,
    }),
  ).resolves.toBeUndefined();

  const proposalIdentity = createTestIdentityPort();
  const proposalPrincipal = await proposalIdentity.verify({
    principalId: "strict-derived-proposer",
    kind: "agent",
    independenceDomain: "strict-derived-domain",
  });
  const manualCandidateInput: CandidateInput = {
    id: "strict-manual-candidate",
    scope: executionScope,
    problem: "A manual problem.",
    hypothesis: "A manual hypothesis.",
    evidenceIds: ["strict-consumer-source/observation"],
    intervention: {
      destinationId: "strict/report",
      kind: "report-note",
      content: { text: "manual" },
      rollbackIntent: "Remove the note.",
    },
    proposedRisk: "T1",
    proposedBy: proposalPrincipal,
  };
  const derivedCandidateInput: CandidateInput = {
    id: "strict-derived-candidate",
    scope: executionScope,
    derivationId: `insight-${"0".repeat(64)}`,
    proposedRisk: "T1",
    proposedBy: proposalPrincipal,
  };
  type ManualCandidateInput = Extract<CandidateInput, { readonly problem: string }>;
  type DerivedCandidateInput = Extract<CandidateInput, { readonly derivationId: string }>;
  const branchesAreDisjoint: [
    DerivedCandidateInput extends { readonly problem: string } ? false : true,
    ManualCandidateInput extends { readonly derivationId: string } ? false : true,
  ] = [true, true];
  expect([manualCandidateInput.id, derivedCandidateInput.id, ...branchesAreDisjoint]).toEqual([
    "strict-manual-candidate",
    "strict-derived-candidate",
    true,
    true,
  ]);

  const strictDraft: DetectorResultDraft = { conditionDetected: false, insights: [], findings: [] };
  const strictRecurrenceLocator: DetectorRecurrenceLocator = {
    treatment: "public_structural",
    structuralLabel: "status_poll",
  };
  const strictOrchestrationPolicyBase: Omit<DetectorOrchestrationPolicy, "schemaVersion" | "policyDigest"> = {
    id: "strict-orchestration-policy",
    version: "1.0.0",
    caps: {
      maximumInvocationsPerRun: 10,
      maximumInsightGroupsPerRun: 5,
      maximumEvidenceHealthGroupsPerRun: 5,
    },
    rejectionSuppression: { mode: "disabled" },
  };
  const strictOrchestrationPolicy = parseDetectorOrchestrationPolicy({
    schemaVersion: 1,
    ...strictOrchestrationPolicyBase,
    policyDigest: detectorOrchestrationPolicyDigest(strictOrchestrationPolicyBase),
  });
  const strictImplementation: RegisteredDetectorImplementation = defineDetectorImplementation({
    registration,
    evaluate: (window: DetectorWindow) => {
      expect(window.outputKind).toBe("evidence_health");
      return strictDraft;
    },
  });
  const strictRunInput: DetectorRunInput = {
    mode: "dry_run",
    detector: strictImplementation.detector,
    pack: packRef,
    lens: null,
    scope: executionScope,
    episodeRecordIds: [],
  };
  const acceptsRunResult = (result: DetectorRunResult): string =>
    `${result.mode}/${result.status}/${result.persistence}`;
  const strictPackRunInput: DetectorPackRunInput = {
    mode: "dry_run",
    pack: packRef,
    scope: executionScope,
    episodeRecordIds: [],
  };
  const acceptsPackRunResult = (result: DetectorPackRunResult): readonly DetectorOrchestrationDisposition[] =>
    result.items.map((item) => item.disposition);
  expect(strictImplementation).toMatchObject({
    detector: detectorRef,
    implementationDigest: registration.implementationDigest,
    registrationDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
  });
  expect(strictRunInput.mode).toBe("dry_run");
  expect(strictRecurrenceLocator).toEqual({ treatment: "public_structural", structuralLabel: "status_poll" });
  expect(strictOrchestrationPolicy).toMatchObject({
    id: "strict-orchestration-policy",
    caps: { maximumInvocationsPerRun: 10 },
  });
  expect(typeof acceptsRunResult).toBe("function");
  expect(typeof acceptsPackRunResult).toBe("function");
  expect(typeof semanticLearning.runDetectorPack).toBe("function");
  await expect(semanticLearning.runDetectorPack(strictPackRunInput)).rejects.toMatchObject({
    code: "detector.input_invalid",
  });
});
