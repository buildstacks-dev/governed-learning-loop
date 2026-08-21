// learning.declareExperiment and learning.runExperiment (contract §The
// façade, §Fingerprint and experiment, §Replay and outcomes; decision 0028).
//
// Declaration freezes the design before any result exists: the kernel parses
// every field, recomputes the eligibility-set and definition digests, requires
// the decision/missingness/stopping rule digests to name the reference rules
// it ships, the replay executor digest to name a kernel-minted executor
// configured on this loop, the intervention to be a journaled `publish`
// intervention, and every eligible episode to be a durable episode with a
// resolved identity. The definition is create-only: the same design declared
// again under the same id is the stored declaration, a different design is
// `experiment.already_declared`.
//
// A run walks the declared design slots in order — eligible episode, then
// repetition, then control before treatment — and journals each attempt
// before invoking the executor (decision-0022 dispatch posture: a dispatched
// slot without a terminal result is `outcome_unknown`, never re-executed).
// The executor result is parsed from `unknown`; its attestation must echo the
// exact request (experiment, definition, episode, arm, repetition,
// fingerprint, fixture, baseline, grader, side-effect policy, nonce) and the
// exact executor registration, and it must grade every declared metric. The
// stopping rule halts at the first invalid slot or when attested cumulative
// cost reaches the ceiling; slots not run are recorded. Any non-valid slot
// makes the verdict `invalid` (kernel invariant 5); only a ceiling stop over
// an otherwise valid prefix is `inconclusive`; a guardrail regression is
// `regressed` whatever the primary metric did; otherwise the reference
// paired-mean-difference rule decides. One experiment yields one evaluation,
// indexed on its intervention and bound into the intervention's validation
// state through the `validate` edge — authorized ≠ validated, permanently.
import type { JsonValue } from "../canonical/json.js";
import { toJsonValue } from "../canonical/to-json-value.js";
import type { Diagnostic } from "../diagnostics.js";
import { LearningLoopError } from "../diagnostics.js";
import { readFields } from "../parse/toolkit.js";
import type { ParsePath } from "../parse/toolkit.js";
import { parseEpisodeRecord } from "../records/episode.js";
import type { MetricDefinition } from "../records/episode.js";
import type {
  AttemptClassification,
  AttemptStatus,
  EvaluationAnalysis,
  EvaluationGuardrail,
  EvaluationResult,
  ExperimentArm,
  ExperimentDefinition,
  ExperimentDefinitionInput,
  ExperimentVerdict,
} from "../records/experiment.js";
import {
  RULE_TOLERANCE,
  analysisSummary,
  declareExperimentDefinition,
  evaluationIdFor,
  evaluationResultDigest,
  experimentAttemptIdFor,
  experimentDesignSlots,
  moneyContent,
  parseEvaluationResult,
  parseExperimentDefinition,
  referenceExperimentRules,
  referenceVerdict,
} from "../records/experiment.js";
import type {
  ReplayAttemptRequest,
  ReplayAttemptResult,
  ReplayExecutor,
  ReplayMeasurement,
} from "../records/replay.js";
import {
  findReplayMeasurement,
  parseReplayAttemptResult,
  replayAttestationMismatchReasons,
} from "../records/replay.js";
import { parseId } from "../records/semantic-shared.js";
import type { EngineContext } from "./context.js";
import { createOnly, loadStoredRecord } from "./context.js";
import type { EpisodeIdentityRecord } from "./episode-identity.js";
import { loadEpisodeIdentityState } from "./episode-identity.js";
import type { ExperimentAttempt, StoredAttempt } from "./experiment-attempt.js";
import {
  buildExperimentAttempt,
  completeExperimentAttempt,
  dispatchExperimentAttempt,
  loadExperimentAttempt,
} from "./experiment-attempt.js";
import type { BoundIntervention } from "./publication.js";
import { loadBoundIntervention } from "./publication.js";
import {
  appendInterventionTransition,
  ensureInterventionEvaluationIndexed,
  loadInterventionFold,
} from "./publication-journal.js";

export type DeclareExperimentInput = ExperimentDefinitionInput;

export interface RunExperimentInput {
  readonly experimentId: string;
}

const DEFINITION_KIND = "experiment-definition";
const EVALUATION_KIND = "experiment-evaluation";
const NONCE_NAMESPACE = "attestation-nonce";

function refusal(code: string, message: string, details?: JsonValue): LearningLoopError {
  return new LearningLoopError(code, [
    { code, severity: "error", message, ...(details !== undefined ? { details } : {}) },
  ]);
}

function corrupt(message: string): LearningLoopError {
  return new LearningLoopError("store.corrupt", [{ code: "store.corrupt", severity: "error", message }]);
}

function freezeDeep<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) freezeDeep(nested);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Loaders

export async function loadExperimentDefinition(
  context: EngineContext,
  experimentId: string,
): Promise<ExperimentDefinition | undefined> {
  const stored = await loadStoredRecord(context, DEFINITION_KIND, experimentId);
  if (stored === undefined) return undefined;
  const definition = parseExperimentDefinition(stored.value);
  if (definition.id !== experimentId) throw corrupt("stored experiment definition id does not match its record key");
  return definition;
}

export async function loadEvaluationResult(
  context: EngineContext,
  evaluationId: string,
): Promise<EvaluationResult | undefined> {
  const stored = await loadStoredRecord(context, EVALUATION_KIND, evaluationId);
  if (stored === undefined) return undefined;
  const evaluation = parseEvaluationResult(stored.value);
  if (evaluation.id !== evaluationId) throw corrupt("stored evaluation id does not match its record key");
  return evaluation;
}

// ---------------------------------------------------------------------------
// Declaration checks

function assertReferenceRules(definition: ExperimentDefinition): void {
  const rules = referenceExperimentRules();
  const expectations: readonly [string, string, string][] = [
    ["decisionRuleDigest", definition.decisionRuleDigest, rules.decisionRule.digest],
    [
      "primaryMetric.missingnessRuleDigest",
      definition.primaryMetric.missingnessRuleDigest,
      rules.missingnessRule.digest,
    ],
    ["stoppingRuleDigest", definition.stoppingRuleDigest, rules.stoppingRule.digest],
  ];
  for (const [field, declared, reference] of expectations) {
    if (declared !== reference) {
      throw refusal(
        "experiment.rule_unknown",
        `${field} does not name a rule this kernel can apply; declare the reference rule digest from referenceExperimentRules()`,
        { field, declared, reference },
      );
    }
  }
}

function resolveExecutor(context: EngineContext, definition: ExperimentDefinition): ReplayExecutor {
  const executor = context.replayExecutorsByDigest?.get(definition.replayExecutorDigest);
  if (executor === undefined) {
    throw refusal(
      "experiment.executor_unavailable",
      "replayExecutorDigest does not name a replay executor configured on this loop; identifiers alone never freeze an executor",
      { replayExecutorDigest: definition.replayExecutorDigest },
    );
  }
  return executor;
}

async function resolveSubjectIntervention(context: EngineContext, interventionId: string): Promise<BoundIntervention> {
  const bound = await loadBoundIntervention(context, interventionId);
  if (bound === undefined) {
    throw refusal(
      "experiment.intervention_not_found",
      `intervention "${interventionId}" is not a journaled intervention on this loop`,
      { interventionId },
    );
  }
  if (bound.fold.header.action !== "publish") {
    throw refusal(
      "experiment.intervention_mismatch",
      `intervention "${interventionId}" is a ${bound.fold.header.action} reversal, not an experiment subject`,
      { interventionId, action: bound.fold.header.action },
    );
  }
  return bound;
}

async function resolveEligibleEpisodes(
  context: EngineContext,
  episodeIds: readonly string[],
): Promise<ReadonlyMap<string, EpisodeIdentityRecord>> {
  const identities = new Map<string, EpisodeIdentityRecord>();
  for (const episodeId of episodeIds) {
    const stored = await loadStoredRecord(context, "episode", episodeId);
    if (stored === undefined) {
      throw refusal(
        "experiment.episode_unknown",
        `eligible episode "${episodeId}" is not a durable episode on this loop`,
        { episodeId },
      );
    }
    const episode = parseEpisodeRecord(stored.value);
    if (episode.id !== episodeId) throw corrupt("stored episode id does not match its record key");
    const identity = await loadEpisodeIdentityState(context, episodeId);
    if (identity.status !== "resolved") {
      throw refusal(
        "experiment.episode_unknown",
        `eligible episode "${episodeId}" has ${identity.status === "conflict" ? "a conflicting" : "no resolved"} identity and cannot anchor a replay`,
        { episodeId, identity: identity.status },
      );
    }
    identities.set(episodeId, identity.identity);
  }
  return identities;
}

// ---------------------------------------------------------------------------
// declareExperiment

export async function runDeclareExperiment(
  context: EngineContext,
  input: DeclareExperimentInput,
): Promise<ExperimentDefinition> {
  const path: ParsePath = ["declareExperiment"];
  const definition = declareExperimentDefinition(input, context.clock.now(), path);
  assertReferenceRules(definition);
  resolveExecutor(context, definition);
  await resolveSubjectIntervention(context, definition.interventionId);
  await resolveEligibleEpisodes(context, definition.eligibleEpisodeIds);

  const status = await createOnly(
    context,
    DEFINITION_KIND,
    definition.id,
    definition,
    `experiment-definition/${definition.id}`,
  );
  if (status === "created" || status === "exists_same") return freezeDeep(definition);
  const stored = await loadExperimentDefinition(context, definition.id);
  if (stored === undefined) throw corrupt("experiment definition conflicted but cannot be reloaded");
  if (stored.definitionDigest === definition.definitionDigest) return freezeDeep(stored);
  throw refusal(
    "experiment.already_declared",
    `experiment "${definition.id}" was declared with a different frozen design; a changed design is a new experiment`,
    {
      experimentId: definition.id,
      declaredDigest: stored.definitionDigest,
      requestedDigest: definition.definitionDigest,
    },
  );
}

// ---------------------------------------------------------------------------
// Attempt dispatch and classification

interface DesignSlot {
  readonly episodeId: string;
  readonly repetition: number;
  readonly arm: ExperimentArm;
}

function declaredMetrics(definition: ExperimentDefinition): readonly MetricDefinition[] {
  return [definition.primaryMetric.definition, ...definition.guardrails.map((guardrail) => guardrail.metric)];
}

function remainingBudget(definition: ExperimentDefinition, spent: number): ReplayAttemptRequest["budget"] {
  const ceiling = definition.costCeiling;
  if (ceiling === undefined) return {};
  return { maximumCost: { ...ceiling, amount: Math.max(0, ceiling.amount - spent) } };
}

async function dispatchSlot(
  context: EngineContext,
  definition: ExperimentDefinition,
  executor: ReplayExecutor,
  slot: DesignSlot,
  identity: EpisodeIdentityRecord,
  spent: number,
): Promise<StoredAttempt> {
  const request: ReplayAttemptRequest = {
    experimentId: definition.id,
    definitionDigest: definition.definitionDigest,
    episodeId: slot.episodeId,
    episodeIdentity: {
      sourceId: identity.sourceId,
      sourceRecordId: identity.sourceRecordId,
      episodeId: identity.episodeId,
    },
    arm: slot.arm,
    repetition: slot.repetition,
    fingerprintDigest:
      slot.arm === "control" ? definition.controlFingerprintDigest : definition.treatmentFingerprintDigest,
    fixtureDigest: definition.fixtureSetDigest,
    baselineSnapshotDigest: definition.baselineSnapshotDigest,
    graderDigest: definition.graderDigest,
    sideEffectCapability: {
      policyDigest: definition.sideEffectPolicyDigest,
      denyByDefault: true,
      attestationNonce: parseId(context.ids.next(NONCE_NAMESPACE), ["ids", NONCE_NAMESPACE]),
    },
    budget: remainingBudget(definition, spent),
  };
  const slotContent = {
    experimentId: definition.id,
    definitionDigest: definition.definitionDigest,
    episodeId: slot.episodeId,
    arm: slot.arm,
    repetition: slot.repetition,
    request,
    dispatchedAt: context.clock.now(),
  };
  const dispatched = buildExperimentAttempt({ ...slotContent, status: "dispatched" });
  const created = await dispatchExperimentAttempt(context, dispatched);
  if (created.status !== "created") {
    // Another dispatch (a concurrent runner, or an identical replayed dispatch)
    // owns this slot: the executor may have run under it, so this runner never
    // invokes it again and reports whatever the journal holds.
    const stored = await loadExperimentAttempt(context, dispatched.id);
    if (stored === undefined) throw corrupt("experiment attempt conflicted but cannot be reloaded");
    return stored;
  }

  const outcome = await executorOutcome(executor, request);
  const completedAt = context.clock.now();
  let terminal: ExperimentAttempt;
  switch (outcome.kind) {
    case "threw":
      terminal = buildExperimentAttempt({
        ...slotContent,
        status: "failed",
        failed: {
          diagnostics: [
            {
              code: "experiment.executor_error",
              severity: "error",
              message: "replay executor threw while attempting this slot; its error is not retained",
            },
          ],
        },
        completedAt,
      });
      break;
    case "rejected":
      terminal = buildExperimentAttempt({
        ...slotContent,
        status: "rejected",
        rejected: outcome.diagnostics,
        completedAt,
      });
      break;
    case "failed":
      terminal = buildExperimentAttempt({
        ...slotContent,
        status: "failed",
        failed: {
          ...(outcome.result.attestation !== undefined ? { attestation: outcome.result.attestation } : {}),
          diagnostics: outcome.result.diagnostics,
          ...(outcome.result.cost !== undefined ? { cost: outcome.result.cost } : {}),
          ...(outcome.result.durationMs !== undefined ? { durationMs: outcome.result.durationMs } : {}),
        },
        completedAt,
      });
      break;
    case "completed": {
      const retained: ReplayMeasurement[] = [];
      for (const metric of declaredMetrics(definition)) {
        const measurement = findReplayMeasurement(outcome.result.measurements, metric);
        if (measurement !== undefined) retained.push(measurement);
      }
      terminal = buildExperimentAttempt({
        ...slotContent,
        status: "completed",
        completed: {
          attestation: outcome.result.attestation,
          measurements: retained,
          ignoredMeasurementCount: outcome.result.measurements.length - retained.length,
          ...(outcome.result.cost !== undefined ? { cost: outcome.result.cost } : {}),
          ...(outcome.result.durationMs !== undefined ? { durationMs: outcome.result.durationMs } : {}),
        },
        completedAt,
      });
      break;
    }
  }
  const attempt = await completeExperimentAttempt(context, created.revision, terminal);
  return { attempt, revision: created.revision };
}

type ExecutorOutcome =
  | { readonly kind: "threw" }
  | { readonly kind: "rejected"; readonly diagnostics: readonly Diagnostic[] }
  | { readonly kind: "failed"; readonly result: Extract<ReplayAttemptResult, { readonly status: "failed" }> }
  | { readonly kind: "completed"; readonly result: Extract<ReplayAttemptResult, { readonly status: "completed" }> };

/**
 * Invokes the executor once and classifies what came back without letting
 * anything escape: a thrown executor, a value the kernel cannot parse (for
 * any reason — a kernel refusal or a hostile value whose own accessors
 * throw), or a parsed failed/completed result. Nothing of the raw value or
 * of a non-kernel error is retained.
 */
async function executorOutcome(executor: ReplayExecutor, request: ReplayAttemptRequest): Promise<ExecutorOutcome> {
  let raw: unknown;
  try {
    raw = await executor.attempt(request);
  } catch {
    return { kind: "threw" };
  }
  let result: ReplayAttemptResult;
  try {
    result = parseReplayAttemptResult(raw);
  } catch (error) {
    const diagnostics: readonly Diagnostic[] =
      error instanceof LearningLoopError
        ? error.diagnostics
        : [
            {
              code: "experiment.result_unparseable",
              severity: "error",
              message: "replay executor result could not be read; the value is not retained",
            },
          ];
    return { kind: "rejected", diagnostics };
  }
  return result.status === "failed" ? { kind: "failed", result } : { kind: "completed", result };
}

interface Classified {
  readonly status: AttemptStatus;
  readonly diagnostics: readonly Diagnostic[];
}

type DetailsObject = { readonly [key: string]: JsonValue };

function isDetailsObject(value: JsonValue | undefined): value is DetailsObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function detailsObject(value: JsonValue | undefined): DetailsObject {
  return isDetailsObject(value) ? value : {};
}

function slotDetails(attempt: ExperimentAttempt): DetailsObject {
  return { attemptId: attempt.id, episodeId: attempt.episodeId, arm: attempt.arm, repetition: attempt.repetition };
}

function classifyAttempt(
  definition: ExperimentDefinition,
  executor: ReplayExecutor,
  attempt: ExperimentAttempt,
): Classified {
  const details = slotDetails(attempt);
  const missingArm = (status: AttemptStatus, message: string): Classified => ({
    status,
    diagnostics: [{ code: "experiment.missing_arm", severity: "error", message, details }],
  });
  if (attempt.status === "dispatched") {
    return missingArm(
      "outcome_unknown",
      "attempt was dispatched but never completed; the executor may have run, so the slot is unknown and is not retried",
    );
  }
  if (attempt.status === "failed") return missingArm("failed", "replay executor reported a failed attempt");
  if (attempt.status === "rejected") {
    return missingArm("rejected", "replay executor returned a result the kernel could not parse");
  }
  const completed = attempt.completed;
  if (completed === undefined) throw corrupt("completed attempt carries no result");
  const attestation = completed.attestation;
  const request = attempt.request;
  if (attestation.fingerprintDigest !== request.fingerprintDigest) {
    const other =
      attempt.arm === "control" ? definition.treatmentFingerprintDigest : definition.controlFingerprintDigest;
    if (attestation.fingerprintDigest === other) {
      return {
        status: "contaminated",
        diagnostics: [
          {
            code: "experiment.contaminated",
            severity: "error",
            message: `the ${attempt.arm} arm ran under the other arm's fingerprint`,
            details: { ...details, attested: attestation.fingerprintDigest },
          },
        ],
      };
    }
    return {
      status: "fingerprint_drift",
      diagnostics: [
        {
          code: "experiment.fingerprint_drift",
          severity: "error",
          message: "the attested fingerprint is neither the requested arm nor the other arm",
          details: { ...details, requested: request.fingerprintDigest, attested: attestation.fingerprintDigest },
        },
      ],
    };
  }
  const mismatches: Diagnostic[] = [
    ...replayAttestationMismatchReasons(attestation, {
      request,
      executor: { id: executor.id, version: executor.version, registrationDigest: executor.registrationDigest },
    }),
  ];
  const ceiling = definition.costCeiling;
  if (ceiling !== undefined) {
    // Under a ceiling, cost is attestation content: missing is never zero spend.
    const budget = request.budget.maximumCost;
    if (completed.cost === undefined) {
      mismatches.push({
        code: "experiment.attestation_mismatch",
        severity: "error",
        message: "the attempt attested no cost although the experiment declares a cost ceiling",
        path: ["cost"],
      });
    } else if (completed.cost.currency !== ceiling.currency) {
      mismatches.push({
        code: "experiment.attestation_mismatch",
        severity: "error",
        message: "attested cost is not in the cost ceiling's currency",
        path: ["cost", "currency"],
        details: { expected: ceiling.currency, actual: completed.cost.currency },
      });
    } else if (budget !== undefined && completed.cost.amount > budget.amount + RULE_TOLERANCE) {
      mismatches.push({
        code: "experiment.attestation_mismatch",
        severity: "error",
        message: "attested cost exceeds the budget the attempt was dispatched with",
        path: ["cost", "amount"],
        details: { budget: budget.amount, attested: completed.cost.amount },
      });
    }
  }
  if (mismatches.length > 0) {
    return {
      status: "attestation_mismatch",
      diagnostics: mismatches.map((diagnostic) => ({
        ...diagnostic,
        details: { ...details, ...detailsObject(diagnostic.details) },
      })),
    };
  }
  const missing = declaredMetrics(definition).filter(
    (metric) => findReplayMeasurement(completed.measurements, metric) === undefined,
  );
  if (missing.length > 0) {
    return {
      status: "metric_missing",
      diagnostics: missing.map((metric) => ({
        code: "experiment.missing_metric",
        severity: "error",
        message: `the attempt graded no value for declared metric "${metric.name}"; a missing measurement is never zero and never a pass`,
        details: { ...details, metric: metric.name },
      })),
    };
  }
  return { status: "valid", diagnostics: [] };
}

// ---------------------------------------------------------------------------
// Reference-rule analysis

type Scalar = number | boolean;

function numberAggregate(values: readonly number[], aggregation: "mean" | "median" | "sum"): number {
  if (values.length === 0) throw corrupt("cannot aggregate an empty repetition set");
  const sum = values.reduce((total, value) => total + value, 0);
  if (aggregation === "sum") return sum;
  if (aggregation === "mean") return sum / values.length;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle];
  const lower = sorted[middle - 1];
  if (upper === undefined) throw corrupt("median of an empty set");
  return sorted.length % 2 === 1 || lower === undefined ? upper : (lower + upper) / 2;
}

function booleanAggregate(values: readonly boolean[], aggregation: "all" | "any" | "majority"): boolean {
  if (values.length === 0) throw corrupt("cannot aggregate an empty repetition set");
  const truthy = values.filter((value) => value).length;
  if (aggregation === "all") return truthy === values.length;
  if (aggregation === "any") return truthy > 0;
  return truthy * 2 > values.length;
}

function primaryAggregate(definition: ExperimentDefinition, values: readonly Scalar[]): number {
  const name = definition.primaryMetric.perEpisodeAggregation;
  const numbers = values.filter((value): value is number => typeof value === "number");
  const booleans = values.filter((value): value is boolean => typeof value === "boolean");
  if (numbers.length !== values.length && booleans.length !== values.length) {
    throw corrupt("primary metric repetitions mix value types");
  }
  switch (name) {
    case "mean-of-nested-repetitions-v1":
      return numberAggregate(numbers, "mean");
    case "median-of-nested-repetitions-v1":
      return numberAggregate(numbers, "median");
    case "sum-of-nested-repetitions-v1":
      return numberAggregate(numbers, "sum");
    case "all-of-nested-repetitions-v1":
      return booleanAggregate(booleans, "all") ? 1 : 0;
    case "any-of-nested-repetitions-v1":
      return booleanAggregate(booleans, "any") ? 1 : 0;
    case "majority-of-nested-repetitions-v1":
      return booleanAggregate(booleans, "majority") ? 1 : 0;
    default:
      throw corrupt(`unknown per-episode aggregation "${name}"`);
  }
}

function guardrailAggregate(metric: MetricDefinition, values: readonly Scalar[]): Scalar {
  if (metric.valueType === "boolean") {
    const booleans = values.filter((value): value is boolean => typeof value === "boolean");
    if (booleans.length !== values.length) throw corrupt("boolean guardrail repetitions carry non-boolean values");
    if (metric.aggregation !== "all" && metric.aggregation !== "any") {
      throw corrupt("boolean guardrail metric carries a number aggregation");
    }
    return booleanAggregate(booleans, metric.aggregation);
  }
  const numbers = values.filter((value): value is number => typeof value === "number");
  if (numbers.length !== values.length) throw corrupt("number guardrail repetitions carry non-number values");
  if (metric.aggregation === "all" || metric.aggregation === "any") {
    throw corrupt("number guardrail metric carries a boolean aggregation");
  }
  return numberAggregate(numbers, metric.aggregation);
}

function measuredValue(attempt: ExperimentAttempt, metric: MetricDefinition): Scalar {
  const measurement =
    attempt.completed === undefined ? undefined : findReplayMeasurement(attempt.completed.measurements, metric);
  if (measurement === undefined || typeof measurement.value === "string") {
    throw corrupt(`valid attempt "${attempt.id}" lacks declared metric "${metric.name}"`);
  }
  return measurement.value;
}

interface Analyzed {
  readonly verdict: ExperimentVerdict;
  readonly analysis: EvaluationAnalysis;
  readonly diagnostics: readonly Diagnostic[];
}

function analyze(definition: ExperimentDefinition, attempts: readonly ExperimentAttempt[]): Analyzed {
  const byEpisodeArm = new Map<string, ExperimentAttempt[]>();
  for (const attempt of attempts) {
    const key = `${attempt.episodeId}|${attempt.arm}`;
    const group = byEpisodeArm.get(key) ?? [];
    group.push(attempt);
    byEpisodeArm.set(key, group);
  }
  const armAttempts = (episodeId: string, arm: ExperimentArm): readonly ExperimentAttempt[] => {
    const group = byEpisodeArm.get(`${episodeId}|${arm}`);
    if (group === undefined || group.length !== definition.repetitionsPerPair) {
      throw corrupt(`episode "${episodeId}" ${arm} arm does not hold every declared repetition`);
    }
    return [...group].sort((left, right) => left.repetition - right.repetition);
  };
  const primary = definition.primaryMetric;
  const pairs = definition.eligibleEpisodeIds.map((episodeId) => {
    const control = primaryAggregate(
      definition,
      armAttempts(episodeId, "control").map((attempt) => measuredValue(attempt, primary.definition)),
    );
    const treatment = primaryAggregate(
      definition,
      armAttempts(episodeId, "treatment").map((attempt) => measuredValue(attempt, primary.definition)),
    );
    const favorableDelta = primary.direction === "higher" ? treatment - control : control - treatment;
    return { episodeId, control, treatment, favorableDelta };
  });
  const { meanFavorableDelta, favorablePairs, unfavorablePairs } = analysisSummary(pairs);

  const guardrails: EvaluationGuardrail[] = definition.guardrails.map((guardrail) => {
    const regressedEpisodeIds: string[] = [];
    for (const episodeId of definition.eligibleEpisodeIds) {
      const treatment = guardrailAggregate(
        guardrail.metric,
        armAttempts(episodeId, "treatment").map((attempt) => measuredValue(attempt, guardrail.metric)),
      );
      let regressed: boolean;
      if (guardrail.rule === "must_pass") {
        regressed = treatment !== true;
      } else if (guardrail.rule === "maximum") {
        regressed = typeof treatment !== "number" || treatment > guardrail.threshold + RULE_TOLERANCE;
      } else {
        const control = guardrailAggregate(
          guardrail.metric,
          armAttempts(episodeId, "control").map((attempt) => measuredValue(attempt, guardrail.metric)),
        );
        regressed = control === true && treatment !== true;
      }
      if (regressed) regressedEpisodeIds.push(episodeId);
    }
    return {
      metric: guardrail.metric.name,
      rule: guardrail.rule,
      status: regressedEpisodeIds.length > 0 ? "regressed" : "held",
      regressedEpisodeIds,
    };
  });

  const analysis: EvaluationAnalysis = {
    direction: primary.direction,
    minimumUsefulEffect: primary.minimumUsefulEffect,
    pairs,
    meanFavorableDelta,
    favorablePairs,
    unfavorablePairs,
    guardrails,
  };
  const verdict = referenceVerdict(analysis);
  const diagnostics: Diagnostic[] = [];
  for (const guardrail of guardrails) {
    if (guardrail.status !== "regressed") continue;
    diagnostics.push({
      code: "experiment.guardrail_regression",
      severity: "error",
      message: `guardrail "${guardrail.metric}" (${guardrail.rule}) regressed on ${guardrail.regressedEpisodeIds.length} episode(s); a guardrail regression defeats any improvement`,
      details: { metric: guardrail.metric, rule: guardrail.rule, episodeIds: [...guardrail.regressedEpisodeIds] },
    });
  }
  diagnostics.push({
    code: "experiment.verdict",
    severity: "info",
    message: `reference rule paired-mean-difference: mean favorable delta ${meanFavorableDelta} over ${pairs.length} pair(s), ${favorablePairs} favorable and ${unfavorablePairs} unfavorable, minimum useful effect ${primary.minimumUsefulEffect}`,
    details: {
      meanFavorableDelta,
      favorablePairs,
      unfavorablePairs,
      pairCount: pairs.length,
      minimumUsefulEffect: primary.minimumUsefulEffect,
    },
  });
  return { verdict, analysis, diagnostics };
}

// ---------------------------------------------------------------------------
// Evaluation persistence: index first, create-only record, validate edge last

async function finalizeEvaluation(
  context: EngineContext,
  definition: ExperimentDefinition,
  evaluation: EvaluationResult,
): Promise<EvaluationResult> {
  await ensureInterventionEvaluationIndexed(context, {
    evaluationId: evaluation.id,
    experimentId: definition.id,
    interventionId: definition.interventionId,
  });
  let stored = evaluation;
  const status = await createOnly(
    context,
    EVALUATION_KIND,
    evaluation.id,
    evaluation,
    `experiment-evaluation/${evaluation.id}`,
  );
  if (status === "conflict") {
    // One experiment yields one evaluation: the first persisted record is
    // canonical; a concurrent runner's attempts remain retained in the journal.
    const existing = await loadEvaluationResult(context, evaluation.id);
    if (existing === undefined) throw corrupt("evaluation conflicted but cannot be reloaded");
    stored = existing;
  }
  const fold = await loadInterventionFold(context, definition.interventionId);
  if (fold === undefined || fold.record === undefined) {
    throw corrupt(`intervention "${definition.interventionId}" vanished while binding its evaluation`);
  }
  // Only the latest indexed evaluation may move validation: an older
  // evaluation read back later is lineage, never a reason to rewrite the
  // state a newer experiment established.
  const latest = fold.record.evaluationIds[fold.record.evaluationIds.length - 1];
  const alreadyBound = fold.transitions.some((transition) => transition.evidenceIds.includes(stored.id));
  if (latest === stored.id && !alreadyBound) {
    const verdict = stored.verdict;
    await appendInterventionTransition(
      context,
      definition.interventionId,
      (current) => (current.validation === verdict ? undefined : { ...current, validation: verdict }),
      [stored.id],
    );
  }
  return freezeDeep(stored);
}

// ---------------------------------------------------------------------------
// runExperiment

export async function runRunExperiment(context: EngineContext, input: RunExperimentInput): Promise<EvaluationResult> {
  const fields = readFields(input, ["runExperiment"]);
  const experimentId = fields.req("experimentId", parseId);
  const definition = await loadExperimentDefinition(context, experimentId);
  if (definition === undefined) {
    throw refusal(
      "experiment.not_predeclared",
      `experiment "${experimentId}" was not declared on this loop; a design must be declared before any result exists`,
      { experimentId },
    );
  }
  const evaluationId = evaluationIdFor(definition.id, definition.definitionDigest);
  const concluded = await loadEvaluationResult(context, evaluationId);
  if (concluded !== undefined) return finalizeEvaluation(context, definition, concluded);

  assertReferenceRules(definition);
  const executor = resolveExecutor(context, definition);
  await resolveSubjectIntervention(context, definition.interventionId);
  const identities = await resolveEligibleEpisodes(context, definition.eligibleEpisodeIds);

  const slots = experimentDesignSlots(definition);
  const classifications: AttemptClassification[] = [];
  const attempts: ExperimentAttempt[] = [];
  const diagnostics: Diagnostic[] = [];
  let spent = 0;
  let stop: "invalid" | "ceiling" | undefined;
  for (const slot of slots) {
    if (stop !== undefined) {
      if (stop === "ceiling" && !classifications.some((classification) => classification.status === "not_run")) {
        const ceiling = definition.costCeiling;
        if (ceiling === undefined) throw corrupt("ceiling stop without a declared ceiling");
        diagnostics.push({
          code: "experiment.stopped",
          severity: "warning",
          message: `attested cumulative cost ${spent} ${ceiling.currency} reached the declared ceiling ${ceiling.amount} ${ceiling.currency}; the remaining slots were not run`,
          details: { spent, ceiling: moneyContent(ceiling), completedAttempts: attempts.length },
        });
      }
      classifications.push({ ...slot, attemptId: null, status: "not_run" });
      continue;
    }
    const attemptId = experimentAttemptIdFor({
      experimentId: definition.id,
      definitionDigest: definition.definitionDigest,
      episodeId: slot.episodeId,
      arm: slot.arm,
      repetition: slot.repetition,
    });
    let stored = await loadExperimentAttempt(context, attemptId);
    if (stored === undefined) {
      const raced = await loadEvaluationResult(context, evaluationId);
      if (raced !== undefined) return finalizeEvaluation(context, definition, raced);
      const identity = identities.get(slot.episodeId);
      if (identity === undefined) throw corrupt(`eligible episode "${slot.episodeId}" lost its identity mid-run`);
      stored = await dispatchSlot(context, definition, executor, slot, identity, spent);
    }
    const attempt = stored.attempt;
    if (attempt.id !== attemptId) throw corrupt("attempt journal returned another slot's record");
    const classified = classifyAttempt(definition, executor, attempt);
    attempts.push(attempt);
    classifications.push({ ...slot, attemptId: attempt.id, status: classified.status });
    diagnostics.push(...classified.diagnostics);
    if (classified.status !== "valid") {
      stop = "invalid";
      continue;
    }
    const ceiling = definition.costCeiling;
    const cost = attempt.completed?.cost;
    if (ceiling !== undefined && cost !== undefined) {
      spent += cost.amount;
      if (spent + RULE_TOLERANCE >= ceiling.amount) stop = "ceiling";
    }
  }

  let verdict: ExperimentVerdict;
  let analysis: EvaluationAnalysis | null = null;
  if (
    classifications.some((classification) => classification.status !== "valid" && classification.status !== "not_run")
  ) {
    verdict = "invalid";
  } else if (classifications.some((classification) => classification.status === "not_run")) {
    verdict = "inconclusive";
  } else {
    const analyzed = analyze(definition, attempts);
    verdict = analyzed.verdict;
    analysis = analyzed.analysis;
    diagnostics.push(...analyzed.diagnostics);
  }
  const content = {
    experimentId: definition.id,
    definitionDigest: definition.definitionDigest,
    interventionId: definition.interventionId,
    registryRevision: context.registryRevision,
    attemptIds: attempts.map((attempt) => attempt.id),
    classifications,
    analysis,
    verdict,
    diagnostics,
  };
  const evaluation = parseEvaluationResult(
    toJsonValue({
      schemaVersion: 1,
      id: evaluationId,
      ...content,
      evaluatedAt: context.clock.now(),
      evaluationDigest: evaluationResultDigest(content),
    }),
  );
  return finalizeEvaluation(context, definition, evaluation);
}
