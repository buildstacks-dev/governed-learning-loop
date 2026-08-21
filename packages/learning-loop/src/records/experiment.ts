// Experiment definition and evaluation result (contract §Fingerprint and
// experiment, §The façade; decision 0028). An ExperimentDefinition is declared
// before any result exists: it freezes the eligibility rule and the exact
// eligible episode set, the baseline snapshot, the control and treatment
// fingerprints, the primary metric and its per-episode aggregation, every
// guardrail, the fixture set, the grader, the decision rule, the stopping
// rule, the replay executor, the side-effect policy, and the assignment/
// blinding scheme — each as a content digest the kernel recomputes or compares
// but never interprets beyond the closed rule catalog below. Identifiers alone
// never freeze anything: the eligibility set digest is recomputed from the
// exact episode ids, the executor digest must name a kernel-defined executor,
// and the rule digests must name the reference rules this package ships.
//
// The EvaluationResult records every design slot — each (episode, repetition,
// arm) — with a closed classification and the analysis the reference decision
// rule computed, so the verdict is reproducible from the record's own bytes.
// Missing, failed, unknown, drifted, contaminated, or under-measured attempts
// make the verdict `invalid`, never neutral (kernel invariant 5); a guardrail
// regression makes it `regressed` whatever the primary metric did.
import { sha256HexOfCanonicalJson } from "../canonical/canonical-json.js";
import type { JsonValue } from "../canonical/json.js";
import { toJsonValue } from "../canonical/to-json-value.js";
import type { Diagnostic } from "../diagnostics.js";
import {
  invalid,
  parseArrayOf,
  parseFiniteNumber,
  parseNonEmptyText,
  parseOneOf,
  readFields,
} from "../parse/toolkit.js";
import type { FieldReader, Parse, ParsePath } from "../parse/toolkit.js";
import type { MetricDefinition } from "./episode.js";
import { parseMetricDefinitionAt } from "./episode.js";
import {
  parseBoundedArray,
  parseCanonicalTimestampAt,
  parseDigestAt,
  parseDurableId,
  parseId,
} from "./semantic-shared.js";

// ---------------------------------------------------------------------------
// Money

export interface Money {
  readonly amount: number;
  readonly currency: string;
  readonly normalizationPolicyDigest?: string;
}

const MAX_CURRENCY_LENGTH = 32;

const parseCurrencyAt: Parse<string> = (input, path) => {
  const value = parseNonEmptyText(input, path);
  if (value.length > MAX_CURRENCY_LENGTH) {
    throw invalid("schema.invalid", `currency exceeds ${MAX_CURRENCY_LENGTH} characters`, path);
  }
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) throw invalid("schema.invalid", "currency contains a control character", path);
  }
  return value;
};

export const parseMoneyAt: Parse<Money> = (input, path) => {
  const fields = readFields(input, path);
  const amount = fields.req("amount", parseFiniteNumber);
  if (amount < 0) throw invalid("schema.invalid", "money amount must not be negative", [...path, "amount"]);
  const normalizationPolicyDigest = fields.opt("normalizationPolicyDigest", parseDigestAt);
  return {
    amount,
    currency: fields.req("currency", parseCurrencyAt),
    ...(normalizationPolicyDigest !== undefined ? { normalizationPolicyDigest } : {}),
  };
};

export function moneyContent(money: Money): JsonValue {
  return {
    amount: money.amount,
    currency: money.currency,
    ...(money.normalizationPolicyDigest !== undefined
      ? { normalizationPolicyDigest: money.normalizationPolicyDigest }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Reference rules: content-bound rule documents the kernel applies

export interface ExperimentRule {
  readonly id: string;
  readonly version: string;
  readonly digest: string;
  readonly rule: JsonValue;
}

const RULE_DIGEST_DOMAIN = "experiment-rule:v1";

/** Content digest of a rule document; the definition names rules only by this digest. */
export function experimentRuleDigest(rule: JsonValue): string {
  return sha256HexOfCanonicalJson({ domain: RULE_DIGEST_DOMAIN, rule });
}

/**
 * Per-episode aggregations over nested repetitions, keyed by name with the
 * metric value type they apply to. Repetitions are nested within the episode,
 * which is the independent unit; these names are the closed vocabulary of
 * `primaryMetric.perEpisodeAggregation`.
 */
export const PER_EPISODE_AGGREGATIONS: Readonly<Record<string, "number" | "boolean">> = Object.freeze({
  "mean-of-nested-repetitions-v1": "number",
  "median-of-nested-repetitions-v1": "number",
  "sum-of-nested-repetitions-v1": "number",
  "all-of-nested-repetitions-v1": "boolean",
  "any-of-nested-repetitions-v1": "boolean",
  "majority-of-nested-repetitions-v1": "boolean",
});

/** Float tolerance the reference rules apply at every declared boundary (effect size and cost ceiling). */
export const RULE_TOLERANCE = 1e-9;

const DECISION_RULE = {
  id: "paired-mean-difference",
  version: "1.0.0",
  tolerance: RULE_TOLERANCE,
  toleranceNote:
    "Every boundary comparison applies the tolerance: a quantity reaches a bound when it is within the tolerance of it.",
  unit: "The episode is the independent unit; repetitions are nested within it and reduced by the declared per-episode aggregation before any comparison.",
  favorableDelta:
    "For each eligible episode, favorableDelta = treatment − control when direction is `higher` and control − treatment when direction is `lower`; boolean aggregates count as 1 (true) and 0 (false).",
  improved:
    "meanFavorableDelta + tolerance >= minimumUsefulEffect and favorablePairs (favorableDelta > tolerance) > unfavorablePairs (favorableDelta < −tolerance), with no guardrail regression.",
  regressed:
    "Any guardrail regression, or meanFavorableDelta − tolerance <= −minimumUsefulEffect and unfavorablePairs > favorablePairs.",
  inconclusive: "Every other complete, valid design.",
  guardrails: {
    must_pass: "The treatment aggregate of a boolean metric is true for every eligible episode.",
    must_not_regress:
      "No eligible episode has a true control aggregate and a false treatment aggregate for a boolean metric.",
    maximum: "The treatment aggregate of a number metric is at most the threshold for every eligible episode.",
    aggregation:
      "Guardrail repetitions are reduced by the guardrail metric's declared aggregation (all/any for boolean, mean/median/sum for number).",
  },
} as const;

const MISSINGNESS_RULE = {
  id: "missing-is-invalid",
  version: "1.0.0",
  statement:
    "Every declared (episode, repetition, arm) slot must complete with a matching attestation and every declared metric. A slot that is not run, failed, unknown after dispatch, unparseable, fingerprint-drifted, contaminated, attestation-mismatched, or short of a declared metric or grader makes the evaluation invalid. No attempt is imputed, excluded, or scored neutrally.",
} as const;

const STOPPING_RULE = {
  id: "complete-design-or-ceiling",
  version: "1.0.0",
  order: "Attempts run in declared order: eligible episode, then repetition, then control before treatment.",
  stops: [
    "the design is complete",
    "the first attempt is classified invalid (the evaluation is then invalid)",
    "the attested cumulative cost has reached the declared cost ceiling within the tolerance (the evaluation is then inconclusive)",
  ],
  cost: "Under a declared ceiling every completed attempt must attest a cost in the ceiling's currency that does not exceed the budget it was dispatched with; a missing or over-budget cost is an attestation mismatch, never zero spend.",
  retention: "Every dispatched attempt is retained; slots that were not run are recorded with status not_run.",
} as const;

function rule(content: JsonValue, id: string, version: string): ExperimentRule {
  return Object.freeze({ id, version, digest: experimentRuleDigest(content), rule: content });
}

export interface ReferenceExperimentRules {
  readonly decisionRule: ExperimentRule;
  readonly missingnessRule: ExperimentRule;
  readonly stoppingRule: ExperimentRule;
  readonly perEpisodeAggregations: readonly string[];
}

/**
 * The content-bound rules this package applies (decision 0028). A definition
 * must name these exact digests; the kernel refuses any other decision,
 * missingness, or stopping rule because it cannot apply a rule it does not
 * know. The rule documents are data so a host can read, cite, and pin them.
 */
export function referenceExperimentRules(): ReferenceExperimentRules {
  return Object.freeze({
    decisionRule: rule(toJsonValue(DECISION_RULE), DECISION_RULE.id, DECISION_RULE.version),
    missingnessRule: rule(toJsonValue(MISSINGNESS_RULE), MISSINGNESS_RULE.id, MISSINGNESS_RULE.version),
    stoppingRule: rule(toJsonValue(STOPPING_RULE), STOPPING_RULE.id, STOPPING_RULE.version),
    perEpisodeAggregations: Object.freeze(Object.keys(PER_EPISODE_AGGREGATIONS)),
  });
}

// ---------------------------------------------------------------------------
// Experiment definition

export type ExperimentArm = "control" | "treatment";
export const EXPERIMENT_ARMS = ["control", "treatment"] as const;

export interface ExperimentPrimaryMetric {
  readonly definition: MetricDefinition;
  readonly direction: "higher" | "lower";
  readonly minimumUsefulEffect: number;
  readonly perEpisodeAggregation: string;
  readonly missingnessRuleDigest: string;
}

export type ExperimentGuardrail =
  | { readonly metric: MetricDefinition; readonly rule: "maximum"; readonly threshold: number }
  | { readonly metric: MetricDefinition; readonly rule: "must_not_regress" | "must_pass"; readonly threshold?: never };

export interface ExperimentDefinition {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly hypothesis: string;
  readonly interventionId: string;
  readonly eligibilityPolicyDigest: string;
  readonly eligibilitySetDigest: string;
  /** Additive (decision 0028): the exact durable episode record ids the eligibility set digest binds. */
  readonly eligibleEpisodeIds: readonly string[];
  readonly baselineSnapshotDigest: string;
  readonly controlFingerprintDigest: string;
  readonly treatmentFingerprintDigest: string;
  readonly primaryMetric: ExperimentPrimaryMetric;
  readonly guardrails: readonly ExperimentGuardrail[];
  readonly fixtureSetDigest: string;
  readonly graderDigest: string;
  readonly decisionRuleDigest: string;
  readonly pairCount: number;
  readonly repetitionsPerPair: number;
  readonly costCeiling?: Money;
  readonly stoppingRuleDigest: string;
  readonly replayExecutorDigest: string;
  readonly sideEffectPolicyDigest: string;
  readonly assignmentAndBlindingDigest: string;
  readonly declaredAt: string;
  readonly definitionDigest: string;
}

export type ExperimentDefinitionInput = Omit<ExperimentDefinition, "schemaVersion" | "declaredAt" | "definitionDigest">;

/** Eligible episodes per experiment; the pair count equals the set size. */
export const MAX_ELIGIBLE_EPISODES = 1_000;
/** Nested repetitions per pair. */
export const MAX_REPETITIONS_PER_PAIR = 100;
/** Guardrails per experiment. */
export const MAX_GUARDRAILS = 100;
/** Design slots (pairs × repetitions × 2 arms) per experiment; a larger design fails closed. */
export const MAX_EXPERIMENT_ATTEMPTS = 10_000;
const MAX_HYPOTHESIS_LENGTH = 10_000;

const DEFINITION_DIGEST_DOMAIN = "experiment-definition:v1";
const ELIGIBILITY_SET_DIGEST_DOMAIN = "experiment-eligibility-set:v1";
const ATTEMPT_KEY_DOMAIN = "experiment-attempt-key:v1";
const EVALUATION_KEY_DOMAIN = "experiment-evaluation-key:v1";
const EVALUATION_DIGEST_DOMAIN = "experiment-evaluation:v1";
const ATTEMPT_ID_PREFIX = "attempt-";
const EVALUATION_ID_PREFIX = "evaluation-";
const INTERVENTION_ID_PATTERN = /^intervention-[0-9a-f]{64}$/;
const METRIC_DIRECTIONS = ["higher", "lower"] as const;
const GUARDRAIL_RULES = ["must_not_regress", "must_pass", "maximum"] as const;

const parseHypothesisAt: Parse<string> = (input, path) => {
  const value = parseNonEmptyText(input, path);
  if (value.length > MAX_HYPOTHESIS_LENGTH) {
    throw invalid("schema.invalid", `hypothesis exceeds ${MAX_HYPOTHESIS_LENGTH} characters`, path);
  }
  return value;
};

const parseInterventionIdAt: Parse<string> = (input, path) => {
  const value = parseDurableId(input, path);
  if (!INTERVENTION_ID_PATTERN.test(value)) {
    throw invalid("schema.invalid", "intervention id must be intervention-<sha-256 hex>", path);
  }
  return value;
};

export function parseBoundedInteger(minimum: number, maximum: number, label: string): Parse<number> {
  return (input, path) => {
    if (typeof input !== "number" || !Number.isSafeInteger(input) || input < minimum || input > maximum) {
      throw invalid("schema.invalid", `${label} must be an integer between ${minimum} and ${maximum}`, path);
    }
    return input;
  };
}

function metricContent(metric: MetricDefinition): JsonValue {
  return {
    name: metric.name,
    valueType: metric.valueType,
    unit: metric.unit,
    aggregation: metric.aggregation,
    ...(metric.comparabilityPolicyDigest !== undefined
      ? { comparabilityPolicyDigest: metric.comparabilityPolicyDigest }
      : {}),
  };
}

/** Exact metric-definition equality: the bytes the definition froze. */
export function sameMetricDefinition(left: MetricDefinition, right: MetricDefinition): boolean {
  return sha256HexOfCanonicalJson(metricContent(left)) === sha256HexOfCanonicalJson(metricContent(right));
}

function assertComparableMetric(metric: MetricDefinition, path: ParsePath): void {
  if (metric.valueType === "string") {
    throw invalid("schema.invalid", "experiment metrics must be number or boolean valued", [...path, "valueType"]);
  }
}

function assertRepetitionAggregation(metric: MetricDefinition, path: ParsePath): void {
  const booleanAggregation = metric.aggregation === "all" || metric.aggregation === "any";
  if (metric.valueType === "boolean" && !booleanAggregation) {
    throw invalid("schema.invalid", "a boolean guardrail metric aggregates nested repetitions with all or any", [
      ...path,
      "aggregation",
    ]);
  }
  if (metric.valueType === "number" && booleanAggregation) {
    throw invalid(
      "schema.invalid",
      "a number guardrail metric aggregates nested repetitions with mean, median, or sum",
      [...path, "aggregation"],
    );
  }
}

const parsePrimaryMetricAt: Parse<ExperimentPrimaryMetric> = (input, path) => {
  const fields = readFields(input, path);
  const definition = fields.req("definition", parseMetricDefinitionAt);
  assertComparableMetric(definition, [...path, "definition"]);
  const minimumUsefulEffect = fields.req("minimumUsefulEffect", parseFiniteNumber);
  if (minimumUsefulEffect <= 0) {
    throw invalid("schema.invalid", "minimumUsefulEffect must be a positive finite number", [
      ...path,
      "minimumUsefulEffect",
    ]);
  }
  const perEpisodeAggregation = fields.req("perEpisodeAggregation", parseId);
  const aggregationType = PER_EPISODE_AGGREGATIONS[perEpisodeAggregation];
  if (aggregationType === undefined) {
    throw invalid("schema.invalid", "perEpisodeAggregation is not a known nested-repetition aggregation", [
      ...path,
      "perEpisodeAggregation",
    ]);
  }
  if (aggregationType !== definition.valueType) {
    throw invalid("schema.invalid", `perEpisodeAggregation applies to ${aggregationType} metrics`, [
      ...path,
      "perEpisodeAggregation",
    ]);
  }
  return {
    definition,
    direction: fields.req("direction", parseOneOf(METRIC_DIRECTIONS)),
    minimumUsefulEffect,
    perEpisodeAggregation,
    missingnessRuleDigest: fields.req("missingnessRuleDigest", parseDigestAt),
  };
};

const parseGuardrailAt: Parse<ExperimentGuardrail> = (input, path) => {
  const fields = readFields(input, path);
  const metric = fields.req("metric", parseMetricDefinitionAt);
  assertComparableMetric(metric, [...path, "metric"]);
  assertRepetitionAggregation(metric, [...path, "metric"]);
  const guardrailRule = fields.req("rule", parseOneOf(GUARDRAIL_RULES));
  const threshold = fields.opt("threshold", parseFiniteNumber);
  if (guardrailRule === "maximum") {
    if (metric.valueType !== "number") {
      throw invalid("schema.invalid", "a maximum guardrail needs a number metric", [...path, "metric", "valueType"]);
    }
    if (threshold === undefined) {
      throw invalid("schema.invalid", "a maximum guardrail needs a threshold", [...path, "threshold"]);
    }
    return { metric, rule: guardrailRule, threshold };
  }
  if (metric.valueType !== "boolean") {
    throw invalid("schema.invalid", `a ${guardrailRule} guardrail needs a boolean (pass/fail) metric`, [
      ...path,
      "metric",
      "valueType",
    ]);
  }
  if (threshold !== undefined) {
    throw invalid("schema.invalid", `a ${guardrailRule} guardrail takes no threshold`, [...path, "threshold"]);
  }
  return { metric, rule: guardrailRule };
};

function assertUniqueIds(values: readonly string[], label: string, path: ParsePath): void {
  const seen = new Set<string>();
  for (const [index, value] of values.entries()) {
    if (seen.has(value)) throw invalid("schema.invalid", `${label} must be unique`, [...path, index]);
    seen.add(value);
  }
}

/** The eligibility set digest binds the exact ordered eligible episode record ids. */
export function eligibilitySetDigest(episodeIds: readonly string[]): string {
  return sha256HexOfCanonicalJson({ domain: ELIGIBILITY_SET_DIGEST_DOMAIN, episodeIds: [...episodeIds] });
}

type DefinitionContent = Omit<ExperimentDefinition, "schemaVersion" | "id" | "declaredAt" | "definitionDigest">;

function definitionContent(input: DefinitionContent): JsonValue {
  return {
    domain: DEFINITION_DIGEST_DOMAIN,
    hypothesis: input.hypothesis,
    interventionId: input.interventionId,
    eligibilityPolicyDigest: input.eligibilityPolicyDigest,
    eligibilitySetDigest: input.eligibilitySetDigest,
    eligibleEpisodeIds: [...input.eligibleEpisodeIds],
    baselineSnapshotDigest: input.baselineSnapshotDigest,
    controlFingerprintDigest: input.controlFingerprintDigest,
    treatmentFingerprintDigest: input.treatmentFingerprintDigest,
    primaryMetric: {
      definition: metricContent(input.primaryMetric.definition),
      direction: input.primaryMetric.direction,
      minimumUsefulEffect: input.primaryMetric.minimumUsefulEffect,
      perEpisodeAggregation: input.primaryMetric.perEpisodeAggregation,
      missingnessRuleDigest: input.primaryMetric.missingnessRuleDigest,
    },
    guardrails: input.guardrails.map((guardrail) => ({
      metric: metricContent(guardrail.metric),
      rule: guardrail.rule,
      ...(guardrail.rule === "maximum" ? { threshold: guardrail.threshold } : {}),
    })),
    fixtureSetDigest: input.fixtureSetDigest,
    graderDigest: input.graderDigest,
    decisionRuleDigest: input.decisionRuleDigest,
    pairCount: input.pairCount,
    repetitionsPerPair: input.repetitionsPerPair,
    ...(input.costCeiling !== undefined ? { costCeiling: moneyContent(input.costCeiling) } : {}),
    stoppingRuleDigest: input.stoppingRuleDigest,
    replayExecutorDigest: input.replayExecutorDigest,
    sideEffectPolicyDigest: input.sideEffectPolicyDigest,
    assignmentAndBlindingDigest: input.assignmentAndBlindingDigest,
  };
}

/**
 * Definition digest: every frozen field under a domain-separation tag.
 * Excludes `schemaVersion`, the caller-chosen `id`, `declaredAt`, and the
 * digest itself, so the same design declared twice under one id is one
 * declaration and a changed design is a visible refusal.
 */
export function experimentDefinitionDigest(input: DefinitionContent): string {
  return sha256HexOfCanonicalJson(definitionContent(input));
}

/**
 * Unknown-first parser. Recomputes the eligibility set digest from the exact
 * episode ids and the definition digest from every frozen field; refuses
 * identical control and treatment fingerprints, a pair count that differs
 * from the eligible set, string-valued or duplicated metrics, a guardrail
 * rule that does not fit its metric, and a design above the attempt ceiling.
 */
export function parseExperimentDefinition(input: unknown): ExperimentDefinition {
  const fields = readFields(input, []);
  const schemaVersion = fields.schemaVersion1();
  const { id, content } = parseDefinitionContent(fields, []);
  const definitionDigest = fields.req("definitionDigest", parseDigestAt);
  if (definitionDigest !== experimentDefinitionDigest(content)) {
    throw invalid("schema.corrupt", "experiment definition digest does not match its frozen content", [
      "definitionDigest",
    ]);
  }
  return {
    schemaVersion,
    id,
    ...content,
    declaredAt: fields.req("declaredAt", parseCanonicalTimestampAt),
    definitionDigest,
  };
}

/**
 * Builds the durable definition from caller input (`ExperimentDefinitionInput`
 * as `unknown`): every frozen field is parsed, the declaration time is the
 * kernel clock's, and the digest is computed by the kernel. The result is
 * re-parsed so a declaration can never hold bytes the parser would refuse.
 */
export function declareExperimentDefinition(input: unknown, declaredAt: string, path: ParsePath): ExperimentDefinition {
  const fields = readFields(input, path);
  const { id, content } = parseDefinitionContent(fields, path);
  return parseExperimentDefinition({
    schemaVersion: 1,
    id,
    ...content,
    declaredAt,
    definitionDigest: experimentDefinitionDigest(content),
  });
}

function parseDefinitionContent(
  fields: FieldReader,
  path: ParsePath,
): { readonly id: string; readonly content: DefinitionContent } {
  const eligibleEpisodeIds = fields.req(
    "eligibleEpisodeIds",
    parseBoundedArray(parseDurableId, MAX_ELIGIBLE_EPISODES, "eligible episode ids"),
  );
  if (eligibleEpisodeIds.length === 0) {
    throw invalid("schema.invalid", "an experiment requires at least one eligible episode", [
      ...path,
      "eligibleEpisodeIds",
    ]);
  }
  assertUniqueIds(eligibleEpisodeIds, "eligible episode ids", [...path, "eligibleEpisodeIds"]);
  const boundSetDigest = fields.req("eligibilitySetDigest", parseDigestAt);
  if (boundSetDigest !== eligibilitySetDigest(eligibleEpisodeIds)) {
    throw invalid("schema.invalid", "eligibilitySetDigest does not bind the exact eligible episode ids", [
      "eligibilitySetDigest",
    ]);
  }
  const pairCount = fields.req("pairCount", parseBoundedInteger(1, MAX_ELIGIBLE_EPISODES, "pairCount"));
  if (pairCount !== eligibleEpisodeIds.length) {
    throw invalid("schema.invalid", "pairCount must equal the number of eligible episodes", [...path, "pairCount"]);
  }
  const repetitionsPerPair = fields.req(
    "repetitionsPerPair",
    parseBoundedInteger(1, MAX_REPETITIONS_PER_PAIR, "repetitionsPerPair"),
  );
  if (pairCount * repetitionsPerPair * 2 > MAX_EXPERIMENT_ATTEMPTS) {
    throw invalid("schema.invalid", `the design exceeds ${MAX_EXPERIMENT_ATTEMPTS} attempts`, [
      ...path,
      "repetitionsPerPair",
    ]);
  }
  const controlFingerprintDigest = fields.req("controlFingerprintDigest", parseDigestAt);
  const treatmentFingerprintDigest = fields.req("treatmentFingerprintDigest", parseDigestAt);
  if (controlFingerprintDigest === treatmentFingerprintDigest) {
    throw invalid(
      "schema.invalid",
      "control and treatment fingerprints must differ; identical arms cannot be compared",
      ["treatmentFingerprintDigest"],
    );
  }
  const primaryMetric = fields.req("primaryMetric", parsePrimaryMetricAt);
  const guardrails = fields.req("guardrails", parseBoundedArray(parseGuardrailAt, MAX_GUARDRAILS, "guardrails"));
  const metricNames = new Set<string>([primaryMetric.definition.name]);
  for (const [index, guardrail] of guardrails.entries()) {
    if (metricNames.has(guardrail.metric.name)) {
      throw invalid("schema.invalid", "guardrail metric names must be unique and distinct from the primary metric", [
        ...path,
        "guardrails",
        index,
        "metric",
        "name",
      ]);
    }
    metricNames.add(guardrail.metric.name);
  }
  const costCeiling = fields.opt("costCeiling", parseMoneyAt);
  if (costCeiling !== undefined && costCeiling.amount <= 0) {
    throw invalid("schema.invalid", "a cost ceiling must be positive", [...path, "costCeiling", "amount"]);
  }
  const content: DefinitionContent = {
    hypothesis: fields.req("hypothesis", parseHypothesisAt),
    interventionId: fields.req("interventionId", parseInterventionIdAt),
    eligibilityPolicyDigest: fields.req("eligibilityPolicyDigest", parseDigestAt),
    eligibilitySetDigest: boundSetDigest,
    eligibleEpisodeIds,
    baselineSnapshotDigest: fields.req("baselineSnapshotDigest", parseDigestAt),
    controlFingerprintDigest,
    treatmentFingerprintDigest,
    primaryMetric,
    guardrails,
    fixtureSetDigest: fields.req("fixtureSetDigest", parseDigestAt),
    graderDigest: fields.req("graderDigest", parseDigestAt),
    decisionRuleDigest: fields.req("decisionRuleDigest", parseDigestAt),
    pairCount,
    repetitionsPerPair,
    ...(costCeiling !== undefined ? { costCeiling } : {}),
    stoppingRuleDigest: fields.req("stoppingRuleDigest", parseDigestAt),
    replayExecutorDigest: fields.req("replayExecutorDigest", parseDigestAt),
    sideEffectPolicyDigest: fields.req("sideEffectPolicyDigest", parseDigestAt),
    assignmentAndBlindingDigest: fields.req("assignmentAndBlindingDigest", parseDigestAt),
  };
  return { id: fields.req("id", parseId), content };
}

/** Every declared design slot in run order: episode, then repetition, then control before treatment. */
export function experimentDesignSlots(
  definition: ExperimentDefinition,
): readonly { readonly episodeId: string; readonly repetition: number; readonly arm: ExperimentArm }[] {
  const slots: { readonly episodeId: string; readonly repetition: number; readonly arm: ExperimentArm }[] = [];
  for (const episodeId of definition.eligibleEpisodeIds) {
    for (let repetition = 1; repetition <= definition.repetitionsPerPair; repetition += 1) {
      for (const arm of EXPERIMENT_ARMS) slots.push({ episodeId, repetition, arm });
    }
  }
  return slots;
}

/** Content-addressed attempt id: one per (experiment, definition, episode, arm, repetition). */
export function experimentAttemptIdFor(input: {
  readonly experimentId: string;
  readonly definitionDigest: string;
  readonly episodeId: string;
  readonly arm: ExperimentArm;
  readonly repetition: number;
}): string {
  return `${ATTEMPT_ID_PREFIX}${sha256HexOfCanonicalJson({
    domain: ATTEMPT_KEY_DOMAIN,
    experimentId: input.experimentId,
    definitionDigest: input.definitionDigest,
    episodeId: input.episodeId,
    arm: input.arm,
    repetition: input.repetition,
  })}`;
}

/** One experiment yields exactly one evaluation; its id derives from the experiment and its frozen definition. */
export function evaluationIdFor(experimentId: string, definitionDigest: string): string {
  return `${EVALUATION_ID_PREFIX}${sha256HexOfCanonicalJson({
    domain: EVALUATION_KEY_DOMAIN,
    experimentId,
    definitionDigest,
  })}`;
}

// ---------------------------------------------------------------------------
// Evaluation result

export type AttemptStatus =
  | "valid"
  | "not_run"
  | "outcome_unknown"
  | "failed"
  | "rejected"
  | "fingerprint_drift"
  | "contaminated"
  | "attestation_mismatch"
  | "metric_missing";

export const ATTEMPT_STATUSES = [
  "valid",
  "not_run",
  "outcome_unknown",
  "failed",
  "rejected",
  "fingerprint_drift",
  "contaminated",
  "attestation_mismatch",
  "metric_missing",
] as const;

export interface AttemptClassification {
  readonly episodeId: string;
  readonly arm: ExperimentArm;
  readonly repetition: number;
  readonly attemptId: string | null;
  readonly status: AttemptStatus;
}

export interface EvaluationPair {
  readonly episodeId: string;
  readonly control: number;
  readonly treatment: number;
  readonly favorableDelta: number;
}

export interface EvaluationGuardrail {
  readonly metric: string;
  readonly rule: ExperimentGuardrail["rule"];
  readonly status: "held" | "regressed";
  readonly regressedEpisodeIds: readonly string[];
}

export interface EvaluationAnalysis {
  readonly direction: ExperimentPrimaryMetric["direction"];
  readonly minimumUsefulEffect: number;
  readonly pairs: readonly EvaluationPair[];
  readonly meanFavorableDelta: number;
  readonly favorablePairs: number;
  readonly unfavorablePairs: number;
  readonly guardrails: readonly EvaluationGuardrail[];
}

export type ExperimentVerdict = "improved" | "inconclusive" | "regressed" | "invalid";
export const EXPERIMENT_VERDICTS = ["improved", "inconclusive", "regressed", "invalid"] as const;

/**
 * The reference decision rule as one pure function of a complete analysis,
 * shared by the engine that mints an evaluation and the parser that reads
 * one: a guardrail regression is `regressed`; otherwise the paired mean
 * favorable delta reaching the minimum useful effect (within the tolerance)
 * with more favorable than unfavorable pairs is `improved`, the mirror is
 * `regressed`, and everything else is `inconclusive`.
 */
export function referenceVerdict(analysis: EvaluationAnalysis): Exclude<ExperimentVerdict, "invalid"> {
  if (analysis.guardrails.some((guardrail) => guardrail.status === "regressed")) return "regressed";
  if (
    analysis.meanFavorableDelta + RULE_TOLERANCE >= analysis.minimumUsefulEffect &&
    analysis.favorablePairs > analysis.unfavorablePairs
  ) {
    return "improved";
  }
  if (
    analysis.meanFavorableDelta - RULE_TOLERANCE <= -analysis.minimumUsefulEffect &&
    analysis.unfavorablePairs > analysis.favorablePairs
  ) {
    return "regressed";
  }
  return "inconclusive";
}

/** The pair counts and mean the reference rule derives from the pairs; the parser requires the record to agree. */
export function analysisSummary(pairs: readonly EvaluationPair[]): {
  readonly meanFavorableDelta: number;
  readonly favorablePairs: number;
  readonly unfavorablePairs: number;
} {
  return {
    meanFavorableDelta: pairs.reduce((total, pair) => total + pair.favorableDelta, 0) / pairs.length,
    favorablePairs: pairs.filter((pair) => pair.favorableDelta > RULE_TOLERANCE).length,
    unfavorablePairs: pairs.filter((pair) => pair.favorableDelta < -RULE_TOLERANCE).length,
  };
}

export interface EvaluationResult {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly experimentId: string;
  readonly definitionDigest: string;
  /** Additive (decision 0028): the intervention the definition bound. */
  readonly interventionId: string;
  /** Additive (decision 0028): the loop registry revision the run executed under. */
  readonly registryRevision: string;
  readonly attemptIds: readonly string[];
  /** Additive (decision 0028): one closed classification per declared design slot, in run order. */
  readonly classifications: readonly AttemptClassification[];
  /** Additive (decision 0028): the reference-rule analysis; null unless every slot was valid. */
  readonly analysis: EvaluationAnalysis | null;
  readonly verdict: ExperimentVerdict;
  readonly diagnostics: readonly Diagnostic[];
  readonly evaluatedAt: string;
  readonly evaluationDigest: string;
}

const MAX_EVALUATION_DIAGNOSTICS = 10_000;
const MAX_DIAGNOSTIC_TEXT_LENGTH = 10_000;
const DIAGNOSTIC_SEVERITIES = ["info", "warning", "error"] as const;

const parseDiagnosticText: Parse<string> = (input, path) => {
  const value = parseNonEmptyText(input, path);
  if (value.length > MAX_DIAGNOSTIC_TEXT_LENGTH) {
    throw invalid("schema.invalid", `diagnostic text exceeds ${MAX_DIAGNOSTIC_TEXT_LENGTH} characters`, path);
  }
  return value;
};

const parsePathSegmentAt: Parse<string | number> = (input, path) => {
  if (typeof input === "string") return input;
  if (typeof input === "number" && Number.isSafeInteger(input) && input >= 0) return input;
  throw invalid("schema.invalid", "diagnostic path segments must be strings or non-negative integers", path);
};

/** Bounded diagnostic parser shared by the evaluation record and the replay attempt result. */
export const parseBoundedDiagnosticAt: Parse<Diagnostic> = (input, path) => {
  const fields = readFields(input, path);
  const code = fields.req("code", parseId);
  const severity = fields.req("severity", parseOneOf(DIAGNOSTIC_SEVERITIES));
  const message = fields.req("message", parseDiagnosticText);
  const diagnosticPath = fields.opt("path", parseArrayOf(parsePathSegmentAt));
  const rawDetails = fields.opt("details", (value) => value);
  const details = rawDetails === undefined ? undefined : toJsonValue(rawDetails);
  return {
    code,
    severity,
    message,
    ...(diagnosticPath !== undefined ? { path: diagnosticPath } : {}),
    ...(details !== undefined ? { details } : {}),
  };
};

export function diagnosticContent(diagnostic: Diagnostic): JsonValue {
  return {
    code: diagnostic.code,
    severity: diagnostic.severity,
    message: diagnostic.message,
    ...(diagnostic.path !== undefined ? { path: [...diagnostic.path] } : {}),
    ...(diagnostic.details !== undefined ? { details: diagnostic.details } : {}),
  };
}

const parseClassificationAt: Parse<AttemptClassification> = (input, path) => {
  const fields = readFields(input, path);
  const rawAttemptId = fields.req("attemptId", (value) => value);
  const attemptId = rawAttemptId === null ? null : parseDurableId(rawAttemptId, [...path, "attemptId"]);
  const status = fields.req("status", parseOneOf(ATTEMPT_STATUSES));
  if ((status === "not_run") !== (attemptId === null)) {
    throw invalid("schema.invalid", "exactly the not_run classification carries no attempt id", [...path, "attemptId"]);
  }
  return {
    episodeId: fields.req("episodeId", parseDurableId),
    arm: fields.req("arm", parseOneOf(EXPERIMENT_ARMS)),
    repetition: fields.req("repetition", parseBoundedInteger(1, MAX_REPETITIONS_PER_PAIR, "repetition")),
    attemptId,
    status,
  };
};

const parsePairAt: Parse<EvaluationPair> = (input, path) => {
  const fields = readFields(input, path);
  return {
    episodeId: fields.req("episodeId", parseDurableId),
    control: fields.req("control", parseFiniteNumber),
    treatment: fields.req("treatment", parseFiniteNumber),
    favorableDelta: fields.req("favorableDelta", parseFiniteNumber),
  };
};

const parseEvaluationGuardrailAt: Parse<EvaluationGuardrail> = (input, path) => {
  const fields = readFields(input, path);
  const regressedEpisodeIds = fields.req(
    "regressedEpisodeIds",
    parseBoundedArray(parseDurableId, MAX_ELIGIBLE_EPISODES, "regressed episode ids"),
  );
  const status = fields.req("status", parseOneOf(["held", "regressed"] as const));
  if ((status === "regressed") !== regressedEpisodeIds.length > 0) {
    throw invalid("schema.invalid", "a regressed guardrail names the regressed episodes and a held one names none", [
      ...path,
      "regressedEpisodeIds",
    ]);
  }
  return {
    metric: fields.req("metric", parseNonEmptyText),
    rule: fields.req("rule", parseOneOf(GUARDRAIL_RULES)),
    status,
    regressedEpisodeIds,
  };
};

const parseAnalysisAt: Parse<EvaluationAnalysis> = (input, path) => {
  const fields = readFields(input, path);
  const pairs = fields.req("pairs", parseBoundedArray(parsePairAt, MAX_ELIGIBLE_EPISODES, "evaluation pairs"));
  if (pairs.length === 0) throw invalid("schema.invalid", "an analysis requires at least one pair", [...path, "pairs"]);
  const direction = fields.req("direction", parseOneOf(METRIC_DIRECTIONS));
  for (const [index, pair] of pairs.entries()) {
    const expected = direction === "higher" ? pair.treatment - pair.control : pair.control - pair.treatment;
    if (Math.abs(expected - pair.favorableDelta) > RULE_TOLERANCE) {
      throw invalid("schema.invalid", "favorableDelta does not follow from the pair under the declared direction", [
        ...path,
        "pairs",
        index,
        "favorableDelta",
      ]);
    }
  }
  const minimumUsefulEffect = fields.req("minimumUsefulEffect", parseFiniteNumber);
  if (minimumUsefulEffect <= 0) {
    throw invalid("schema.invalid", "minimumUsefulEffect must be positive", [...path, "minimumUsefulEffect"]);
  }
  const summary = analysisSummary(pairs);
  const analysis: EvaluationAnalysis = {
    direction,
    minimumUsefulEffect,
    pairs,
    meanFavorableDelta: fields.req("meanFavorableDelta", parseFiniteNumber),
    favorablePairs: fields.req("favorablePairs", parseBoundedInteger(0, MAX_ELIGIBLE_EPISODES, "favorablePairs")),
    unfavorablePairs: fields.req("unfavorablePairs", parseBoundedInteger(0, MAX_ELIGIBLE_EPISODES, "unfavorablePairs")),
    guardrails: fields.req(
      "guardrails",
      parseBoundedArray(parseEvaluationGuardrailAt, MAX_GUARDRAILS, "evaluation guardrails"),
    ),
  };
  if (
    Math.abs(analysis.meanFavorableDelta - summary.meanFavorableDelta) > RULE_TOLERANCE ||
    analysis.favorablePairs !== summary.favorablePairs ||
    analysis.unfavorablePairs !== summary.unfavorablePairs
  ) {
    throw invalid("schema.invalid", "analysis summary does not follow from its pairs", [...path, "meanFavorableDelta"]);
  }
  return analysis;
};

type EvaluationContent = Omit<EvaluationResult, "schemaVersion" | "id" | "evaluatedAt" | "evaluationDigest">;

function analysisContent(analysis: EvaluationAnalysis): JsonValue {
  return {
    direction: analysis.direction,
    minimumUsefulEffect: analysis.minimumUsefulEffect,
    pairs: analysis.pairs.map((pair) => ({
      episodeId: pair.episodeId,
      control: pair.control,
      treatment: pair.treatment,
      favorableDelta: pair.favorableDelta,
    })),
    meanFavorableDelta: analysis.meanFavorableDelta,
    favorablePairs: analysis.favorablePairs,
    unfavorablePairs: analysis.unfavorablePairs,
    guardrails: analysis.guardrails.map((guardrail) => ({
      metric: guardrail.metric,
      rule: guardrail.rule,
      status: guardrail.status,
      regressedEpisodeIds: [...guardrail.regressedEpisodeIds],
    })),
  };
}

function evaluationContent(input: EvaluationContent): JsonValue {
  return {
    domain: EVALUATION_DIGEST_DOMAIN,
    experimentId: input.experimentId,
    definitionDigest: input.definitionDigest,
    interventionId: input.interventionId,
    registryRevision: input.registryRevision,
    attemptIds: [...input.attemptIds],
    classifications: input.classifications.map((classification) => ({
      episodeId: classification.episodeId,
      arm: classification.arm,
      repetition: classification.repetition,
      attemptId: classification.attemptId,
      status: classification.status,
    })),
    analysis: input.analysis === null ? null : analysisContent(input.analysis),
    verdict: input.verdict,
    diagnostics: input.diagnostics.map(diagnosticContent),
  };
}

/** Evaluation digest: every field but schemaVersion, id, evaluatedAt, and the digest itself. */
export function evaluationResultDigest(input: EvaluationContent): string {
  return sha256HexOfCanonicalJson(evaluationContent(input));
}

/**
 * Unknown-first parser. Recomputes the deterministic id and the digest,
 * requires one classification per declared attempt id in order, an analysis
 * exactly when every slot is valid, and a verdict consistent with the
 * classifications: any non-valid slot forbids `improved`/`regressed`-by-rule
 * claims by making the verdict `invalid` (or `inconclusive` when only not_run
 * slots remain after a ceiling stop).
 */
export function parseEvaluationResult(input: unknown): EvaluationResult {
  const fields = readFields(input, []);
  const schemaVersion = fields.schemaVersion1();
  const experimentId = fields.req("experimentId", parseId);
  const definitionDigest = fields.req("definitionDigest", parseDigestAt);
  const attemptIds = fields.req(
    "attemptIds",
    parseBoundedArray(parseDurableId, MAX_EXPERIMENT_ATTEMPTS, "attempt ids"),
  );
  assertUniqueIds(attemptIds, "attempt ids", ["attemptIds"]);
  const classifications = fields.req(
    "classifications",
    parseBoundedArray(parseClassificationAt, MAX_EXPERIMENT_ATTEMPTS, "attempt classifications"),
  );
  if (classifications.length === 0) {
    throw invalid("schema.invalid", "an evaluation classifies at least one design slot", ["classifications"]);
  }
  const classifiedAttemptIds = classifications
    .map((classification) => classification.attemptId)
    .filter((id): id is string => id !== null);
  if (
    classifiedAttemptIds.length !== attemptIds.length ||
    classifiedAttemptIds.some((id, index) => id !== attemptIds[index])
  ) {
    throw invalid("schema.invalid", "attemptIds must list exactly the classified attempts in order", ["attemptIds"]);
  }
  const slotKeys = new Set<string>();
  for (const [index, classification] of classifications.entries()) {
    const key = `${classification.episodeId}|${classification.repetition}|${classification.arm}`;
    if (slotKeys.has(key)) {
      throw invalid("schema.invalid", "each design slot is classified once", ["classifications", index]);
    }
    slotKeys.add(key);
  }
  const rawAnalysis = fields.req("analysis", (value) => value);
  const analysis = rawAnalysis === null ? null : parseAnalysisAt(rawAnalysis, ["analysis"]);
  const verdict = fields.req("verdict", parseOneOf(EXPERIMENT_VERDICTS));
  const allValid = classifications.every((classification) => classification.status === "valid");
  const onlyNotRun = classifications.every(
    (classification) => classification.status === "valid" || classification.status === "not_run",
  );
  if (allValid !== (analysis !== null)) {
    throw invalid("schema.invalid", "an analysis exists exactly when every design slot is valid", ["analysis"]);
  }
  if (!allValid && verdict !== "invalid" && !(onlyNotRun && verdict === "inconclusive")) {
    throw invalid("schema.invalid", "a design with a non-valid slot cannot claim improvement or regression", [
      "verdict",
    ]);
  }
  if (allValid && verdict === "invalid") {
    throw invalid("schema.invalid", "a fully valid design yields a rule verdict, not invalid", ["verdict"]);
  }
  if (analysis !== null && verdict !== referenceVerdict(analysis)) {
    throw invalid("schema.invalid", "verdict does not follow from the analysis under the reference decision rule", [
      "verdict",
    ]);
  }
  const content: EvaluationContent = {
    experimentId,
    definitionDigest,
    interventionId: fields.req("interventionId", parseInterventionIdAt),
    registryRevision: fields.req("registryRevision", parseDigestAt),
    attemptIds,
    classifications,
    analysis,
    verdict,
    diagnostics: fields.req(
      "diagnostics",
      parseBoundedArray(parseBoundedDiagnosticAt, MAX_EVALUATION_DIAGNOSTICS, "evaluation diagnostics"),
    ),
  };
  const evaluationDigest = fields.req("evaluationDigest", parseDigestAt);
  if (evaluationDigest !== evaluationResultDigest(content)) {
    throw invalid("schema.corrupt", "evaluation digest does not match its content", ["evaluationDigest"]);
  }
  const id = fields.req("id", parseDurableId);
  if (id !== evaluationIdFor(experimentId, definitionDigest)) {
    throw invalid("schema.corrupt", "evaluation id does not derive from its experiment and definition", ["id"]);
  }
  return {
    schemaVersion,
    id,
    ...content,
    evaluatedAt: fields.req("evaluatedAt", parseCanonicalTimestampAt),
    evaluationDigest,
  };
}
