import type { DetectorRegistration, EvidenceSource } from "@cormidia/learning-loop";
import {
  conservativePolicy,
  createExactScopePolicy,
  createLearningLoop,
  detectorRegistrationDigest,
  defineSourceRegistration,
  parseDetectorRegistration,
  sha256HexOfCanonicalJson,
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

test("strict consumer can construct and parse a host-neutral detector registration from the public root", () => {
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
});
