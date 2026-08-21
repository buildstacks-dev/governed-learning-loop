// Shared fixtures for the Validate tests (decision 0028). Not a test file.
// Builds the Activate harness with one in-memory replay executor, publishes
// the harness candidate so a `publish` intervention exists, ingests a small
// eligible episode population, and offers a complete ExperimentDefinition
// input bound to the reference rules, the executor, and that population.
import type {
  Candidate,
  EvaluationResult,
  ExperimentDefinition,
  ExperimentDefinitionInput,
  InterventionRecord,
  MetricDefinition,
  ReplayAttemptRequest,
} from "../src/index.js";
import { eligibilitySetDigest, referenceExperimentRules, sha256HexOfCanonicalJson } from "../src/index.js";
import type { InMemoryReplayExecutor, InMemoryReplayGrade } from "../src/testing/in-memory-replay-executor.js";
import { createInMemoryReplayExecutor } from "../src/testing/in-memory-replay-executor.js";
import { SCOPE } from "./engine-harness.js";
import {
  DESTINATION_ID,
  completed,
  createPublicationHarness,
  type PublicationHarness,
  type PublicationHarnessOptions,
} from "./publication-harness.js";

export const BASE = "instructions-v7";
export const EXPERIMENT_ID = "exp-typecheck-preflight-v1";

export const PRIMARY_METRIC: MetricDefinition = {
  name: "completion_typecheck_pass",
  valueType: "boolean",
  unit: "pass",
  aggregation: "all",
};
export const ACCEPTANCE_METRIC: MetricDefinition = {
  name: "acceptance_tests",
  valueType: "boolean",
  unit: "pass",
  aggregation: "all",
};
export const COST_METRIC: MetricDefinition = { name: "cost", valueType: "number", unit: "USD", aggregation: "sum" };
export const LATENCY_METRIC: MetricDefinition = {
  name: "latency_ms",
  valueType: "number",
  unit: "ms",
  aggregation: "mean",
};

/** Host-owned frozen artifacts are opaque to the kernel; these are stable stand-ins. */
export function hostDigest(label: string): string {
  return sha256HexOfCanonicalJson({ hostArtifact: label });
}

export const CONTROL_FINGERPRINT = hostDigest("control-fingerprint");
export const TREATMENT_FINGERPRINT = hostDigest("treatment-fingerprint");

/** Metric values keyed by metric name; the grade emits one measurement per declared name it finds. */
export type MetricValues = Readonly<Record<string, number | boolean>>;

const KNOWN_METRICS = [PRIMARY_METRIC, ACCEPTANCE_METRIC, COST_METRIC, LATENCY_METRIC];

/** Builds a completed grade from metric values; unknown names are ignored. */
export function gradeValues(
  values: MetricValues,
  extra: { readonly cost?: { amount: number; currency: string }; readonly durationMs?: number } = {},
): InMemoryReplayGrade {
  const measurements = KNOWN_METRICS.filter((metric) => metric.name in values).map((metric) => ({
    metric,
    value: values[metric.name] ?? false,
  }));
  return { status: "completed", measurements, ...extra };
}

/** A grade script keyed by arm: every request of that arm grades the same values. */
export function gradeByArm(
  control: MetricValues,
  treatment: MetricValues,
): (request: ReplayAttemptRequest) => InMemoryReplayGrade {
  return (request) => gradeValues(request.arm === "control" ? control : treatment);
}

export interface ExperimentHarness extends PublicationHarness {
  readonly replay: InMemoryReplayExecutor;
  readonly candidate: Candidate;
  readonly intervention: InterventionRecord;
  /** Durable episode record ids of the eligible population, in declaration order. */
  readonly episodeIds: readonly string[];
  definitionInput(overrides?: Partial<ExperimentDefinitionInput>): ExperimentDefinitionInput;
  declare(overrides?: Partial<ExperimentDefinitionInput>): Promise<ExperimentDefinition>;
  run(experimentId?: string): Promise<EvaluationResult>;
}

export interface ExperimentHarnessOptions extends PublicationHarnessOptions {
  readonly grade?: (request: ReplayAttemptRequest, attempt: number) => InMemoryReplayGrade;
  readonly replay?: InMemoryReplayExecutor;
  readonly episodeCount?: number;
  /** Reconstructs a host over an existing store: reuses the published intervention and ingested population. */
  readonly rebuild?: { readonly candidate: Candidate; readonly intervention: InterventionRecord };
}

export async function createExperimentHarness(options: ExperimentHarnessOptions = {}): Promise<ExperimentHarness> {
  const replay =
    options.replay ?? createInMemoryReplayExecutor(options.grade === undefined ? {} : { grade: options.grade });
  const { grade: _grade, replay: _replay, episodeCount, rebuild, ...publicationOptions } = options;
  const harness = await createPublicationHarness({ ...publicationOptions, replayExecutors: [replay.executor] });
  let candidate: Candidate;
  let intervention: InterventionRecord;
  if (rebuild !== undefined) {
    candidate = rebuild.candidate;
    intervention = rebuild.intervention;
  } else {
    candidate = await harness.acceptedCandidate();
    const prepared = await harness.learning.preparePublication({
      candidateId: candidate.id,
      destinationId: DESTINATION_ID,
      expectedBase: BASE,
    });
    intervention = completed(
      await harness.learning.publish({ planId: prepared.plan.id, authorizationEvidence: { decision: "authorized" } }),
    ).intervention;
  }
  const count = episodeCount ?? 3;
  const hostEpisodeIds = Array.from({ length: count }, (_, index) => `exp-ep-${index + 1}`);
  if (rebuild === undefined)
    await harness.learning.ingest(harness.manual, {
      observations: hostEpisodeIds.map((episodeId) => ({
        id: `obs-${episodeId}`,
        episodeId,
        occurredAt: "2026-08-13T09:00:00.000Z",
        kind: "tool.process.completed",
        data: { commandClass: "typecheck", exitCode: 0 },
      })),
      episodes: hostEpisodeIds.map((episodeId) => ({
        id: episodeId,
        scope: SCOPE,
        openedAt: "2026-08-13T08:00:00.000Z",
        closedAt: "2026-08-13T09:00:00.000Z",
      })),
    });
  const episodeIds = hostEpisodeIds.map((episodeId) => `manual-evidence/${episodeId}`);
  const rules = referenceExperimentRules();
  const definitionInput = (overrides: Partial<ExperimentDefinitionInput> = {}): ExperimentDefinitionInput => {
    const eligibleEpisodeIds = overrides.eligibleEpisodeIds ?? episodeIds;
    return {
      id: EXPERIMENT_ID,
      hypothesis: "The preflight reduces type-check failures at completion.",
      interventionId: intervention.id,
      eligibilityPolicyDigest: hostDigest("eligibility-policy"),
      eligibilitySetDigest: eligibilitySetDigest(eligibleEpisodeIds),
      eligibleEpisodeIds,
      baselineSnapshotDigest: hostDigest("baseline-snapshots"),
      controlFingerprintDigest: CONTROL_FINGERPRINT,
      treatmentFingerprintDigest: TREATMENT_FINGERPRINT,
      primaryMetric: {
        definition: PRIMARY_METRIC,
        direction: "higher",
        minimumUsefulEffect: 0.15,
        perEpisodeAggregation: "majority-of-nested-repetitions-v1",
        missingnessRuleDigest: rules.missingnessRule.digest,
      },
      guardrails: [
        { metric: ACCEPTANCE_METRIC, rule: "must_not_regress" },
        { metric: COST_METRIC, rule: "maximum", threshold: 8 },
      ],
      fixtureSetDigest: hostDigest("hidden-fixtures-v3"),
      graderDigest: hostDigest("deterministic-repo-gates-v3"),
      decisionRuleDigest: rules.decisionRule.digest,
      pairCount: eligibleEpisodeIds.length,
      repetitionsPerPair: 1,
      stoppingRuleDigest: rules.stoppingRule.digest,
      replayExecutorDigest: replay.executor.registrationDigest,
      sideEffectPolicyDigest: hostDigest("deny-by-default-effects-v2"),
      assignmentAndBlindingDigest: hostDigest("counterbalanced-blinded-v1"),
      ...overrides,
    };
  };
  return {
    ...harness,
    replay,
    candidate,
    intervention,
    episodeIds,
    definitionInput,
    declare: (overrides = {}) => harness.learning.declareExperiment(definitionInput(overrides)),
    run: (experimentId = EXPERIMENT_ID) => harness.learning.runExperiment({ experimentId }),
  };
}

export async function expectRefusal(run: () => Promise<unknown>, code: string): Promise<void> {
  let thrown: unknown;
  try {
    await run();
  } catch (error) {
    thrown = error;
  }
  if (typeof thrown !== "object" || thrown === null) {
    throw new Error(`expected a LearningLoopError with code ${code}, got ${String(thrown)}`);
  }
  const actual = Reflect.get(thrown, "code");
  if (actual !== code) {
    throw new Error(`expected refusal ${code}, got ${String(actual)}: ${String(Reflect.get(thrown, "message"))}`);
  }
}

/** Kinds added between two store snapshots, sorted. */
export function addedKinds(before: string, after: string): readonly string[] {
  const previous = new Set(JSON.parse(before).map((entry: unknown) => JSON.stringify(entry)));
  return JSON.parse(after)
    .filter((entry: unknown) => !previous.has(JSON.stringify(entry)))
    .map((entry: readonly [string, string, string]) => entry[0])
    .sort();
}
