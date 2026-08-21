// Validate records (decision 0028): the content-bound reference rules and
// their pinned digests, the frozen ExperimentDefinition (recomputed
// eligibility-set and definition digests, every structural refusal), the
// EvaluationResult (deterministic id, recomputed digest, classification/
// verdict consistency), system fingerprints, and the replay attempt result
// the executor boundary parses.
import { describe, expect, it } from "vitest";
import type { EvaluationResult, ExperimentDefinition, ExperimentDefinitionInput } from "../src/index.js";
import {
  eligibilitySetDigest,
  experimentDefinitionDigest,
  parseEvaluationResult,
  parseExperimentDefinition,
  parseReplayAttemptResult,
  parseSystemFingerprint,
  referenceExperimentRules,
  sha256HexOfCanonicalJson,
  systemFingerprintDigest,
  toJsonValue,
} from "../src/index.js";
import {
  MAX_EXPERIMENT_ATTEMPTS,
  evaluationIdFor,
  evaluationResultDigest,
  experimentAttemptIdFor,
  experimentRuleDigest,
} from "../src/records/experiment.js";
import { replayAttestationMismatchReasons } from "../src/records/replay.js";
import {
  ACCEPTANCE_METRIC,
  CONTROL_FINGERPRINT,
  COST_METRIC,
  LATENCY_METRIC,
  PRIMARY_METRIC,
  TREATMENT_FINGERPRINT,
  hostDigest,
} from "./experiment-harness.js";

const NOW = "2026-08-16T10:00:00.000Z";
const INTERVENTION_ID = `intervention-${"a".repeat(64)}`;
const EPISODES = ["manual-evidence/exp-ep-1", "manual-evidence/exp-ep-2"];
const RULES = referenceExperimentRules();

// Golden vectors: pinned from the first implementation run; a change here is a
// protocol change that must be made deliberately.
const GOLDEN = {
  decisionRule: "f48d6a599a9852780f2aaed0a252d2228de819e94e15059c1e78a1e16fe138ae",
  missingnessRule: "27d56075f08372836fd728392de66e45cb0a9397ccca1a1a9b5aaa8558dd12aa",
  stoppingRule: "f5c8c5d642a68d57f42adead8b44dc2a090c7f811f3cd3a4757939b096a488cd",
  eligibilitySet: "292ceb0b0806e7a000b69a50d2c3071e6cb017c03d8170038a077929efa0df0a",
  definition: "ad78803ab4d1499a8a4282f08500907a89846a5b4afc927ae2cdde7b824191c8",
  evaluation: "ca95ca19d2da90436f7f58ee26d585c17e4a211d032e3beaf752d9dcfc9b031c",
  fingerprint: "268e313611f6444c86870ae7e2bd14c280d3439b9253eabdc90cef31cada8fd2",
};

function definitionInput(overrides: Record<string, unknown> = {}): ExperimentDefinitionInput & Record<string, unknown> {
  return {
    id: "exp-1",
    hypothesis: "The preflight reduces type-check failures at completion.",
    interventionId: INTERVENTION_ID,
    eligibilityPolicyDigest: hostDigest("eligibility-policy"),
    eligibilitySetDigest: eligibilitySetDigest(EPISODES),
    eligibleEpisodeIds: EPISODES,
    baselineSnapshotDigest: hostDigest("baseline"),
    controlFingerprintDigest: CONTROL_FINGERPRINT,
    treatmentFingerprintDigest: TREATMENT_FINGERPRINT,
    primaryMetric: {
      definition: PRIMARY_METRIC,
      direction: "higher",
      minimumUsefulEffect: 0.15,
      perEpisodeAggregation: "majority-of-nested-repetitions-v1",
      missingnessRuleDigest: RULES.missingnessRule.digest,
    },
    guardrails: [
      { metric: ACCEPTANCE_METRIC, rule: "must_not_regress" },
      { metric: COST_METRIC, rule: "maximum", threshold: 8 },
    ],
    fixtureSetDigest: hostDigest("fixtures"),
    graderDigest: hostDigest("grader"),
    decisionRuleDigest: RULES.decisionRule.digest,
    pairCount: 2,
    repetitionsPerPair: 1,
    costCeiling: { amount: 160, currency: "USD" },
    stoppingRuleDigest: RULES.stoppingRule.digest,
    replayExecutorDigest: hostDigest("executor"),
    sideEffectPolicyDigest: hostDigest("side-effects"),
    assignmentAndBlindingDigest: hostDigest("assignment"),
    ...overrides,
  };
}

function definitionRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const { id, ...withUndefined } = definitionInput(overrides);
  const content = Object.fromEntries(Object.entries(withUndefined).filter(([, value]) => value !== undefined));
  const parsedContent = toJsonValue(content);
  const digestInput: unknown = parsedContent;
  return {
    schemaVersion: 1,
    id,
    ...content,
    declaredAt: NOW,
    definitionDigest: experimentDefinitionDigest(toDefinitionContent(digestInput)),
  };
}

/** Test-only narrowing of a fixture we built ourselves. */
function toDefinitionContent(input: unknown): Parameters<typeof experimentDefinitionDigest>[0] {
  return input as Parameters<typeof experimentDefinitionDigest>[0];
}

function parsedDefinition(overrides: Record<string, unknown> = {}): ExperimentDefinition {
  return parseExperimentDefinition(definitionRecord(overrides));
}

function expectInvalid(run: () => unknown, code = "schema.invalid"): void {
  expect(run).toThrow(expect.objectContaining({ name: "LearningLoopError", code }));
}

describe("referenceExperimentRules", () => {
  it("ships three content-bound rule documents whose digests are pinned goldens", () => {
    expect(Object.isFrozen(RULES)).toBe(true);
    for (const rule of [RULES.decisionRule, RULES.missingnessRule, RULES.stoppingRule]) {
      expect(rule.digest).toBe(experimentRuleDigest(rule.rule));
      expect(rule.digest).toBe(sha256HexOfCanonicalJson({ domain: "experiment-rule:v1", rule: rule.rule }));
      expect(Object.isFrozen(rule)).toBe(true);
    }
    expect([RULES.decisionRule.id, RULES.missingnessRule.id, RULES.stoppingRule.id]).toEqual([
      "paired-mean-difference",
      "missing-is-invalid",
      "complete-design-or-ceiling",
    ]);
    expect({
      decisionRule: RULES.decisionRule.digest,
      missingnessRule: RULES.missingnessRule.digest,
      stoppingRule: RULES.stoppingRule.digest,
    }).toEqual({
      decisionRule: GOLDEN.decisionRule,
      missingnessRule: GOLDEN.missingnessRule,
      stoppingRule: GOLDEN.stoppingRule,
    });
    expect(RULES.perEpisodeAggregations).toEqual([
      "mean-of-nested-repetitions-v1",
      "median-of-nested-repetitions-v1",
      "sum-of-nested-repetitions-v1",
      "all-of-nested-repetitions-v1",
      "any-of-nested-repetitions-v1",
      "majority-of-nested-repetitions-v1",
    ]);
  });
});

describe("ExperimentDefinition", () => {
  it("round-trips, drops unknown fields, and pins the eligibility-set and definition digest goldens", () => {
    const definition = parsedDefinition();
    expect(
      parseExperimentDefinition({ ...definition, unknown: 1, primaryMetric: { ...definition.primaryMetric, x: 2 } }),
    ).toEqual(definition);
    expect({ eligibilitySet: definition.eligibilitySetDigest, definition: definition.definitionDigest }).toEqual({
      eligibilitySet: GOLDEN.eligibilitySet,
      definition: GOLDEN.definition,
    });
    expect(eligibilitySetDigest(EPISODES)).toBe(
      sha256HexOfCanonicalJson({ domain: "experiment-eligibility-set:v1", episodeIds: EPISODES }),
    );
  });

  it("binds every frozen field into the digest and excludes id and declaredAt", () => {
    const base = parsedDefinition();
    const moved: Record<string, unknown>[] = [
      { hypothesis: "Another hypothesis." },
      { interventionId: `intervention-${"b".repeat(64)}` },
      { eligibilityPolicyDigest: hostDigest("other-policy") },
      {
        eligibleEpisodeIds: [...EPISODES].reverse(),
        eligibilitySetDigest: eligibilitySetDigest([...EPISODES].reverse()),
      },
      { baselineSnapshotDigest: hostDigest("other-baseline") },
      { controlFingerprintDigest: hostDigest("other-control") },
      { treatmentFingerprintDigest: hostDigest("other-treatment") },
      { primaryMetric: { ...base.primaryMetric, direction: "lower" } },
      { primaryMetric: { ...base.primaryMetric, minimumUsefulEffect: 0.2 } },
      { primaryMetric: { ...base.primaryMetric, perEpisodeAggregation: "all-of-nested-repetitions-v1" } },
      { guardrails: [base.guardrails[0]] },
      { guardrails: [base.guardrails[0], { metric: COST_METRIC, rule: "maximum", threshold: 9 }] },
      { fixtureSetDigest: hostDigest("other-fixtures") },
      { graderDigest: hostDigest("other-grader") },
      { repetitionsPerPair: 2 },
      { costCeiling: { amount: 161, currency: "USD" } },
      { costCeiling: undefined },
      { replayExecutorDigest: hostDigest("other-executor") },
      { sideEffectPolicyDigest: hostDigest("other-side-effects") },
      { assignmentAndBlindingDigest: hostDigest("other-assignment") },
    ];
    const digests = new Set([base.definitionDigest]);
    for (const overrides of moved) {
      const digest = parsedDefinition(overrides).definitionDigest;
      expect(digests.has(digest)).toBe(false);
      digests.add(digest);
    }
    expect(parsedDefinition({ id: "exp-other" }).definitionDigest).toBe(base.definitionDigest);
    expect(
      parseExperimentDefinition({ ...definitionRecord(), declaredAt: "2026-08-17T00:00:00.000Z" }).definitionDigest,
    ).toBe(base.definitionDigest);
  });

  it("refuses identical control and treatment fingerprints: identical arms cannot be compared", () => {
    expectInvalid(() => parsedDefinition({ treatmentFingerprintDigest: CONTROL_FINGERPRINT }));
  });

  it("recomputes the eligibility set and requires pairCount to equal it", () => {
    expectInvalid(() => parsedDefinition({ eligibilitySetDigest: hostDigest("forged-set") }));
    expectInvalid(() => parsedDefinition({ pairCount: 3 }));
    expectInvalid(() =>
      parsedDefinition({ eligibleEpisodeIds: [], eligibilitySetDigest: eligibilitySetDigest([]), pairCount: 0 }),
    );
    const duplicated = ["manual-evidence/exp-ep-1", "manual-evidence/exp-ep-1"];
    expectInvalid(() =>
      parsedDefinition({ eligibleEpisodeIds: duplicated, eligibilitySetDigest: eligibilitySetDigest(duplicated) }),
    );
  });

  it("refuses metrics the reference rule cannot compare and aggregations that do not fit", () => {
    const primary = definitionInput().primaryMetric;
    expectInvalid(() =>
      parsedDefinition({
        primaryMetric: { ...primary, definition: { ...PRIMARY_METRIC, valueType: "string" } },
      }),
    );
    expectInvalid(() => parsedDefinition({ primaryMetric: { ...primary, perEpisodeAggregation: "mode-v9" } }));
    expectInvalid(() =>
      parsedDefinition({ primaryMetric: { ...primary, perEpisodeAggregation: "mean-of-nested-repetitions-v1" } }),
    );
    expectInvalid(() => parsedDefinition({ primaryMetric: { ...primary, minimumUsefulEffect: 0 } }));
    expectInvalid(() => parsedDefinition({ primaryMetric: { ...primary, minimumUsefulEffect: -1 } }));
    expectInvalid(() => parsedDefinition({ primaryMetric: { ...primary, direction: "sideways" } }));
  });

  it("refuses guardrail rules that do not fit their metric and duplicate metric names", () => {
    expectInvalid(() => parsedDefinition({ guardrails: [{ metric: COST_METRIC, rule: "maximum" }] }));
    expectInvalid(() =>
      parsedDefinition({ guardrails: [{ metric: ACCEPTANCE_METRIC, rule: "maximum", threshold: 1 }] }),
    );
    expectInvalid(() => parsedDefinition({ guardrails: [{ metric: COST_METRIC, rule: "must_pass" }] }));
    expectInvalid(() =>
      parsedDefinition({ guardrails: [{ metric: ACCEPTANCE_METRIC, rule: "must_pass", threshold: 1 }] }),
    );
    expectInvalid(() => parsedDefinition({ guardrails: [{ metric: COST_METRIC, rule: "must_not_regress" }] }));
    expectInvalid(() =>
      parsedDefinition({
        guardrails: [{ metric: { ...ACCEPTANCE_METRIC, aggregation: "mean" }, rule: "must_pass" }],
      }),
    );
    expectInvalid(() =>
      parsedDefinition({
        guardrails: [{ metric: { ...COST_METRIC, aggregation: "all" }, rule: "maximum", threshold: 8 }],
      }),
    );
    expectInvalid(() => parsedDefinition({ guardrails: [{ metric: PRIMARY_METRIC, rule: "must_pass" }] }));
    expectInvalid(() =>
      parsedDefinition({
        guardrails: [
          { metric: ACCEPTANCE_METRIC, rule: "must_pass" },
          { metric: ACCEPTANCE_METRIC, rule: "must_not_regress" },
        ],
      }),
    );
    expect(
      parsedDefinition({ guardrails: [{ metric: LATENCY_METRIC, rule: "maximum", threshold: 500 }] }).guardrails,
    ).toEqual([{ metric: LATENCY_METRIC, rule: "maximum", threshold: 500 }]);
  });

  it("bounds the design and refuses a non-positive cost ceiling, a malformed intervention id, or a bad version", () => {
    expectInvalid(() => parsedDefinition({ repetitionsPerPair: 0 }));
    expectInvalid(() => parsedDefinition({ repetitionsPerPair: 101 }));
    const wide = Array.from({ length: 51 }, (_, index) => `manual-evidence/ep-${index}`);
    expectInvalid(() =>
      parsedDefinition({
        eligibleEpisodeIds: wide,
        eligibilitySetDigest: eligibilitySetDigest(wide),
        pairCount: 51,
        repetitionsPerPair: 100,
      }),
    );
    const exact = wide.slice(0, 50);
    expect(
      parsedDefinition({
        eligibleEpisodeIds: exact,
        eligibilitySetDigest: eligibilitySetDigest(exact),
        pairCount: 50,
        repetitionsPerPair: 100,
      }).pairCount *
        100 *
        2,
    ).toBe(MAX_EXPERIMENT_ATTEMPTS);
    expectInvalid(() => parsedDefinition({ costCeiling: { amount: 0, currency: "USD" } }));
    expectInvalid(() => parsedDefinition({ costCeiling: { amount: 1, currency: "" } }));
    expectInvalid(() => parsedDefinition({ interventionId: "cand-1" }));
    expectInvalid(() => parsedDefinition({ hypothesis: "" }));
    expectInvalid(
      () => parseExperimentDefinition({ ...definitionRecord(), schemaVersion: 2 }),
      "schema.unsupported_version",
    );
    expectInvalid(
      () => parseExperimentDefinition({ ...definitionRecord(), definitionDigest: "f".repeat(64) }),
      "schema.corrupt",
    );
    expectInvalid(() => parseExperimentDefinition({ ...definitionRecord(), declaredAt: "2026-08-16T10:00:00Z" }));
  });

  it("derives attempt and evaluation ids deterministically from the experiment and its frozen definition", () => {
    const definition = parsedDefinition();
    const attemptId = experimentAttemptIdFor({
      experimentId: definition.id,
      definitionDigest: definition.definitionDigest,
      episodeId: EPISODES[0] ?? "",
      arm: "control",
      repetition: 1,
    });
    expect(attemptId).toBe(
      `attempt-${sha256HexOfCanonicalJson({
        domain: "experiment-attempt-key:v1",
        experimentId: definition.id,
        definitionDigest: definition.definitionDigest,
        episodeId: EPISODES[0] ?? "",
        arm: "control",
        repetition: 1,
      })}`,
    );
    expect(evaluationIdFor(definition.id, definition.definitionDigest)).toBe(
      `evaluation-${sha256HexOfCanonicalJson({
        domain: "experiment-evaluation-key:v1",
        experimentId: definition.id,
        definitionDigest: definition.definitionDigest,
      })}`,
    );
  });
});

describe("EvaluationResult", () => {
  function slots(definition: ExperimentDefinition) {
    return definition.eligibleEpisodeIds.flatMap((episodeId) =>
      (["control", "treatment"] as const).map((arm) => ({
        episodeId,
        arm,
        repetition: 1,
        attemptId: experimentAttemptIdFor({
          experimentId: definition.id,
          definitionDigest: definition.definitionDigest,
          episodeId,
          arm,
          repetition: 1,
        }),
        status: "valid" as const,
      })),
    );
  }

  function evaluationRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    const definition = parsedDefinition();
    const classifications = slots(definition);
    const content = {
      experimentId: definition.id,
      definitionDigest: definition.definitionDigest,
      interventionId: INTERVENTION_ID,
      registryRevision: "1".repeat(64),
      attemptIds: classifications.map((classification) => classification.attemptId),
      classifications,
      analysis: {
        direction: "higher",
        minimumUsefulEffect: 0.15,
        pairs: EPISODES.map((episodeId) => ({ episodeId, control: 0, treatment: 1, favorableDelta: 1 })),
        meanFavorableDelta: 1,
        favorablePairs: 2,
        unfavorablePairs: 0,
        guardrails: [
          { metric: ACCEPTANCE_METRIC.name, rule: "must_not_regress", status: "held", regressedEpisodeIds: [] },
          { metric: COST_METRIC.name, rule: "maximum", status: "held", regressedEpisodeIds: [] },
        ],
      },
      verdict: "improved",
      diagnostics: [{ code: "experiment.verdict", severity: "info", message: "paired-mean-difference" }],
      ...overrides,
    };
    const digestInput: unknown = toJsonValue(content);
    return {
      schemaVersion: 1,
      id: evaluationIdFor(definition.id, definition.definitionDigest),
      ...content,
      evaluatedAt: NOW,
      evaluationDigest: evaluationResultDigest(digestInput as Parameters<typeof evaluationResultDigest>[0]),
    };
  }

  it("round-trips, drops unknown fields, and pins the digest golden", () => {
    const evaluation: EvaluationResult = parseEvaluationResult(evaluationRecord());
    expect(parseEvaluationResult({ ...evaluation, extra: true })).toEqual(evaluation);
    expect(evaluation.evaluationDigest).toBe(GOLDEN.evaluation);
    expect(evaluation.attemptIds).toHaveLength(4);
  });

  it("requires the id to derive from the experiment, the digest to match, and attemptIds to mirror the classified attempts", () => {
    expectInvalid(() => parseEvaluationResult({ ...evaluationRecord(), id: "evaluation-1" }), "schema.corrupt");
    expectInvalid(
      () => parseEvaluationResult({ ...evaluationRecord(), evaluationDigest: "0".repeat(64) }),
      "schema.corrupt",
    );
    expectInvalid(() => parseEvaluationResult(evaluationRecord({ attemptIds: [] })));
    const record = evaluationRecord();
    const attemptIds = record.attemptIds;
    if (!Array.isArray(attemptIds)) throw new Error("fixture");
    expectInvalid(() => parseEvaluationResult(evaluationRecord({ attemptIds: [...attemptIds].reverse() })));
  });

  it("keeps classifications and the verdict consistent: no analysis without a fully valid design, never neutral", () => {
    const definition = parsedDefinition();
    const valid = slots(definition);
    const first = valid[0];
    if (first === undefined) throw new Error("fixture");
    const failing = [
      { ...first, status: "failed" as const },
      ...valid.slice(1).map((slot) => ({ ...slot, attemptId: null, status: "not_run" as const })),
    ];
    const failingIds = [first.attemptId];
    expect(
      parseEvaluationResult(
        evaluationRecord({ classifications: failing, attemptIds: failingIds, analysis: null, verdict: "invalid" }),
      ).verdict,
    ).toBe("invalid");
    // A non-valid slot cannot carry an analysis or an improvement.
    expectInvalid(() =>
      parseEvaluationResult(evaluationRecord({ classifications: failing, attemptIds: failingIds, verdict: "invalid" })),
    );
    expectInvalid(() =>
      parseEvaluationResult(
        evaluationRecord({ classifications: failing, attemptIds: failingIds, analysis: null, verdict: "improved" }),
      ),
    );
    expectInvalid(() =>
      parseEvaluationResult(
        evaluationRecord({ classifications: failing, attemptIds: failingIds, analysis: null, verdict: "inconclusive" }),
      ),
    );
    // Only not_run slots after a ceiling stop may be inconclusive without analysis.
    const stopped = [
      first,
      ...valid.slice(1).map((slot) => ({ ...slot, attemptId: null, status: "not_run" as const })),
    ];
    expect(
      parseEvaluationResult(
        evaluationRecord({ classifications: stopped, attemptIds: failingIds, analysis: null, verdict: "inconclusive" }),
      ).verdict,
    ).toBe("inconclusive");
    expectInvalid(() =>
      parseEvaluationResult(
        evaluationRecord({ classifications: stopped, attemptIds: failingIds, analysis: null, verdict: "improved" }),
      ),
    );
    // A fully valid design is never "invalid" and always carries its analysis.
    expectInvalid(() => parseEvaluationResult(evaluationRecord({ verdict: "invalid" })));
    expectInvalid(() => parseEvaluationResult(evaluationRecord({ analysis: null })));
    // The verdict must follow from the analysis under the reference rule, and the
    // analysis summary from its pairs: the record reproduces its own verdict.
    const consistent = evaluationRecord();
    const analysis = consistent.analysis;
    if (typeof analysis !== "object" || analysis === null) throw new Error("fixture");
    const regressedGuardrail = [
      { metric: ACCEPTANCE_METRIC.name, rule: "must_not_regress", status: "regressed", regressedEpisodeIds: EPISODES },
    ];
    expectInvalid(() => parseEvaluationResult(evaluationRecord({ verdict: "inconclusive" })));
    expectInvalid(() => parseEvaluationResult(evaluationRecord({ verdict: "regressed" })));
    expectInvalid(() =>
      parseEvaluationResult(evaluationRecord({ analysis: { ...analysis, guardrails: regressedGuardrail } })),
    );
    expect(
      parseEvaluationResult(
        evaluationRecord({ verdict: "regressed", analysis: { ...analysis, guardrails: regressedGuardrail } }),
      ).verdict,
    ).toBe("regressed");
    expectInvalid(() => parseEvaluationResult(evaluationRecord({ analysis: { ...analysis, favorablePairs: 1 } })));
    expectInvalid(() =>
      parseEvaluationResult(evaluationRecord({ analysis: { ...analysis, meanFavorableDelta: 0.5 } })),
    );
    expectInvalid(() => parseEvaluationResult(evaluationRecord({ analysis: { ...analysis, direction: "lower" } })));
    expectInvalid(() => parseEvaluationResult(evaluationRecord({ analysis: { ...analysis, minimumUsefulEffect: 0 } })));
    // not_run is exactly the classification without an attempt id; slots are unique.
    expectInvalid(() =>
      parseEvaluationResult(evaluationRecord({ classifications: [{ ...first, attemptId: null }, ...valid.slice(1)] })),
    );
    expectInvalid(() =>
      parseEvaluationResult(
        evaluationRecord({
          classifications: [first, first, ...valid.slice(2)],
          attemptIds: [first.attemptId, first.attemptId, ...valid.slice(2).map((slot) => slot.attemptId)],
        }),
      ),
    );
  });
});

describe("SystemFingerprint", () => {
  const components = [
    { name: "model", version: "2026-08", digest: hostDigest("model") },
    { name: "package", version: "0.0.0", digest: hostDigest("package") },
    { name: "prompts", digest: hostDigest("prompts") },
  ];

  it("digests named components order-independently and pins the golden", () => {
    const digest = systemFingerprintDigest(components);
    expect(digest).toBe(systemFingerprintDigest([...components].reverse()));
    expect(digest).toBe(GOLDEN.fingerprint);
    const parsed = parseSystemFingerprint({ schemaVersion: 1, id: "fp-1", components, digest, extra: 1 });
    expect(parsed).toEqual({ schemaVersion: 1, id: "fp-1", components, digest });
    expect(systemFingerprintDigest([{ name: "model", digest: hostDigest("model") }])).not.toBe(digest);
  });

  it("refuses duplicate names, an empty set, and a digest that does not match", () => {
    expectInvalid(() => systemFingerprintDigest([...components, { name: "model", digest: hostDigest("x") }]));
    expectInvalid(() =>
      parseSystemFingerprint({ schemaVersion: 1, id: "fp-1", components: [], digest: "0".repeat(64) }),
    );
    expectInvalid(
      () => parseSystemFingerprint({ schemaVersion: 1, id: "fp-1", components, digest: "0".repeat(64) }),
      "schema.corrupt",
    );
  });
});

describe("ReplayAttemptResult", () => {
  const attestation = {
    executor: { id: "exec", version: "1.0.0", registrationDigest: hostDigest("executor") },
    experimentId: "exp-1",
    definitionDigest: hostDigest("definition"),
    episodeId: EPISODES[0],
    arm: "treatment",
    repetition: 1,
    fingerprintDigest: TREATMENT_FINGERPRINT,
    fixtureDigest: hostDigest("fixtures"),
    baselineSnapshotDigest: hostDigest("baseline"),
    graderDigest: hostDigest("grader"),
    sideEffectPolicyDigest: hostDigest("side-effects"),
    attestationNonce: "nonce-1",
  };

  it("parses completed and failed results, dropping unknown fields", () => {
    const completed = parseReplayAttemptResult({
      status: "completed",
      attestation: { ...attestation, extra: 1 },
      measurements: [{ metric: PRIMARY_METRIC, value: true, extra: 2 }],
      cost: { amount: 1.5, currency: "USD" },
      durationMs: 1200,
      extra: 3,
    });
    expect(completed).toEqual({
      status: "completed",
      attestation,
      measurements: [{ metric: PRIMARY_METRIC, value: true }],
      cost: { amount: 1.5, currency: "USD" },
      durationMs: 1200,
    });
    const failed = parseReplayAttemptResult({
      status: "failed",
      diagnostics: [{ code: "host.timeout", severity: "error", message: "the agent timed out" }],
    });
    expect(failed).toEqual({
      status: "failed",
      diagnostics: [{ code: "host.timeout", severity: "error", message: "the agent timed out" }],
    });
  });

  it("refuses unknown statuses, mistyped values, duplicate metric names, and unbounded output", () => {
    expectInvalid(() => parseReplayAttemptResult({ status: "done", attestation, measurements: [] }));
    expectInvalid(() =>
      parseReplayAttemptResult({
        status: "completed",
        attestation,
        measurements: [{ metric: PRIMARY_METRIC, value: 1 }],
      }),
    );
    expectInvalid(() =>
      parseReplayAttemptResult({
        status: "completed",
        attestation,
        measurements: [
          { metric: PRIMARY_METRIC, value: true },
          { metric: { ...PRIMARY_METRIC, unit: "x" }, value: false },
        ],
      }),
    );
    expectInvalid(() =>
      parseReplayAttemptResult({
        status: "completed",
        attestation,
        measurements: Array.from({ length: 101 }, (_, index) => ({
          metric: { ...COST_METRIC, name: `m-${index}` },
          value: index,
        })),
      }),
    );
    expectInvalid(() => parseReplayAttemptResult({ status: "failed", diagnostics: "nope" }));
    expectInvalid(() =>
      parseReplayAttemptResult({
        status: "completed",
        attestation: { ...attestation, arm: "placebo" },
        measurements: [],
      }),
    );
    expectInvalid(() => parseReplayAttemptResult(null));
  });

  it("enumerates every attestation field that disagrees with the request and the executor", () => {
    const request = {
      experimentId: "exp-1",
      definitionDigest: hostDigest("definition"),
      episodeId: EPISODES[0] ?? "",
      episodeIdentity: { sourceId: "manual-evidence", sourceRecordId: "exp-ep-1", episodeId: "exp-ep-1" },
      arm: "treatment" as const,
      repetition: 1,
      fingerprintDigest: TREATMENT_FINGERPRINT,
      fixtureDigest: hostDigest("fixtures"),
      baselineSnapshotDigest: hostDigest("baseline"),
      graderDigest: hostDigest("grader"),
      sideEffectCapability: {
        policyDigest: hostDigest("side-effects"),
        denyByDefault: true as const,
        attestationNonce: "nonce-1",
      },
      budget: {},
    };
    const executor = { id: "exec", version: "1.0.0", registrationDigest: hostDigest("executor") };
    const parsed = parseReplayAttemptResult({ status: "completed", attestation, measurements: [] });
    if (parsed.status !== "completed") throw new Error("fixture");
    expect(replayAttestationMismatchReasons(parsed.attestation, { request, executor })).toEqual([]);
    const drifted = {
      ...parsed.attestation,
      executor: { ...executor, version: "2.0.0" },
      definitionDigest: hostDigest("other"),
      episodeId: EPISODES[1] ?? "",
      arm: "control" as const,
      repetition: 2,
      fixtureDigest: hostDigest("other-fixtures"),
      baselineSnapshotDigest: hostDigest("other-baseline"),
      graderDigest: hostDigest("other-grader"),
      sideEffectPolicyDigest: hostDigest("other-side-effects"),
      attestationNonce: "nonce-2",
    };
    const reasons = replayAttestationMismatchReasons(drifted, { request, executor });
    expect(reasons.map((reason) => reason.path?.[1])).toEqual([
      "executor.version",
      "definitionDigest",
      "episodeId",
      "arm",
      "repetition",
      "fixtureDigest",
      "baselineSnapshotDigest",
      "graderDigest",
      "sideEffectPolicyDigest",
      "attestationNonce",
    ]);
    expect(new Set(reasons.map((reason) => reason.code))).toEqual(new Set(["experiment.attestation_mismatch"]));
  });
});
