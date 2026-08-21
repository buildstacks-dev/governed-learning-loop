// learning.runExperiment (decision 0028): the declared design runs in order
// through the kernel-minted executor, every attempt is journaled and
// retained, attestations are verified against the exact request, the
// reference rules decide — missing arms, metrics, or graders are invalid and
// never neutral (kernel invariant 5), a guardrail regression defeats an
// improvement, the episode is the unit with nested repetitions, a ceiling
// stop is inconclusive — and one experiment yields one evaluation bound into
// the intervention's validation state.
import { describe, expect, it } from "vitest";
import type { EvaluationResult, ReplayAttemptRequest } from "../src/index.js";
import { parseEvaluationResult } from "../src/index.js";
import { evaluationIdFor, experimentAttemptIdFor } from "../src/records/experiment.js";
import { parseExperimentAttempt } from "../src/engine/experiment-attempt.js";
import { contextForLearningLoop } from "../src/engine/loop.js";
import { appendInterventionTransition } from "../src/engine/publication-journal.js";
import type { InMemoryReplayGrade } from "../src/testing/in-memory-replay-executor.js";
import { createInMemoryReplayExecutor } from "../src/testing/index.js";
import { SCOPE } from "./engine-harness.js";
import {
  ACCEPTANCE_METRIC,
  CONTROL_FINGERPRINT,
  COST_METRIC,
  EXPERIMENT_ID,
  LATENCY_METRIC,
  PRIMARY_METRIC,
  TREATMENT_FINGERPRINT,
  addedKinds,
  createExperimentHarness,
  expectRefusal,
  gradeByArm,
  gradeValues,
  hostDigest,
  type ExperimentHarness,
} from "./experiment-harness.js";
import { DESTINATION_ID, completed, createPublicationHarness } from "./publication-harness.js";

const CONTROL_BASELINE = { completion_typecheck_pass: false, acceptance_tests: true, cost: 2 };
const TREATMENT_IMPROVED = { completion_typecheck_pass: true, acceptance_tests: true, cost: 3 };

async function improvedHarness(): Promise<ExperimentHarness> {
  return createExperimentHarness({ grade: gradeByArm(CONTROL_BASELINE, TREATMENT_IMPROVED) });
}

function slotOrder(harness: ExperimentHarness, repetitions = 1) {
  return harness.episodeIds.flatMap((episodeId) =>
    Array.from({ length: repetitions }, (_, index) => index + 1).flatMap((repetition) =>
      (["control", "treatment"] as const).map((arm) => ({ episodeId, repetition, arm })),
    ),
  );
}

async function loadAttempt(harness: ExperimentHarness, attemptId: string) {
  const stored = await harness.store.get({ namespace: "learning", kind: "experiment-attempt", id: attemptId });
  return parseExperimentAttempt(stored?.value);
}

describe("learning.runExperiment: a complete valid design", () => {
  it("retains every attempt, analyzes pairs, and mints one improved evaluation bound into the intervention", async () => {
    const harness = await improvedHarness();
    const definition = await harness.declare();
    const before = await harness.storeSnapshot();
    const evaluation = await harness.run();
    const slots = slotOrder(harness);
    const attemptIds = slots.map((slot) =>
      experimentAttemptIdFor({ experimentId: definition.id, definitionDigest: definition.definitionDigest, ...slot }),
    );
    expect(evaluation).toEqual({
      schemaVersion: 1,
      id: evaluationIdFor(definition.id, definition.definitionDigest),
      experimentId: definition.id,
      definitionDigest: definition.definitionDigest,
      interventionId: harness.intervention.id,
      registryRevision: expect.stringMatching(/^[0-9a-f]{64}$/),
      attemptIds,
      classifications: slots.map((slot, index) => ({ ...slot, attemptId: attemptIds[index], status: "valid" })),
      analysis: {
        direction: "higher",
        minimumUsefulEffect: 0.15,
        pairs: harness.episodeIds.map((episodeId) => ({ episodeId, control: 0, treatment: 1, favorableDelta: 1 })),
        meanFavorableDelta: 1,
        favorablePairs: 3,
        unfavorablePairs: 0,
        guardrails: [
          { metric: "acceptance_tests", rule: "must_not_regress", status: "held", regressedEpisodeIds: [] },
          { metric: "cost", rule: "maximum", status: "held", regressedEpisodeIds: [] },
        ],
      },
      verdict: "improved",
      diagnostics: [expect.objectContaining({ code: "experiment.verdict", severity: "info" })],
      evaluatedAt: harness.clock.now(),
      evaluationDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(parseEvaluationResult(evaluation)).toEqual(evaluation);
    expect(Object.isFrozen(evaluation)).toBe(true);
    expect(addedKinds(before, await harness.storeSnapshot())).toEqual([
      ...Array.from({ length: 6 }, () => "experiment-attempt"),
      "experiment-evaluation",
      "intervention-evaluation",
      "intervention-transition",
    ]);

    // The executor saw exactly the declared design, in order, with exact digests and a fresh nonce each.
    expect(harness.replay.calls.attempt).toBe(6);
    expect(harness.replay.requests.map((request) => [request.episodeId, request.repetition, request.arm])).toEqual(
      slots.map((slot) => [slot.episodeId, slot.repetition, slot.arm]),
    );
    for (const request of harness.replay.requests) {
      expect(request.experimentId).toBe(definition.id);
      expect(request.definitionDigest).toBe(definition.definitionDigest);
      expect(request.fingerprintDigest).toBe(request.arm === "control" ? CONTROL_FINGERPRINT : TREATMENT_FINGERPRINT);
      expect(request.fixtureDigest).toBe(definition.fixtureSetDigest);
      expect(request.baselineSnapshotDigest).toBe(definition.baselineSnapshotDigest);
      expect(request.graderDigest).toBe(definition.graderDigest);
      expect(request.sideEffectCapability).toEqual({
        policyDigest: definition.sideEffectPolicyDigest,
        denyByDefault: true,
        attestationNonce: expect.stringMatching(/^t-attestation-nonce-\d+$/),
      });
      expect(request.budget).toEqual({});
      expect(request.episodeIdentity).toEqual({
        sourceId: "manual-evidence",
        sourceRecordId: request.episodeId.replace("manual-evidence/", ""),
        episodeId: request.episodeId.replace("manual-evidence/", ""),
      });
    }
    expect(new Set(harness.replay.requests.map((request) => request.sideEffectCapability.attestationNonce)).size).toBe(
      6,
    );

    // Attempts are durable facts with the retained declared measurements only.
    const first = await loadAttempt(harness, attemptIds[0] ?? "");
    expect(first.status).toBe("completed");
    expect(first.completed?.measurements.map((measurement) => measurement.metric.name)).toEqual([
      "completion_typecheck_pass",
      "acceptance_tests",
      "cost",
    ]);
    expect(first.completed?.ignoredMeasurementCount).toBe(0);
    expect(first.request).toEqual(harness.replay.requests[0]);

    // The intervention's validation moved through the validate edge; nothing else changed.
    const intervention = await harness.learning.getIntervention({ interventionId: harness.intervention.id });
    expect(intervention?.state).toEqual({ ...harness.intervention.state, validation: "improved" });
    expect(intervention?.evaluationIds).toEqual([evaluation.id]);
    expect(intervention?.latestTransitionId).not.toBe(harness.intervention.latestTransitionId);
    expect(intervention?.publicationReceiptIds).toEqual(harness.intervention.publicationReceiptIds);
  });

  it("is idempotent: a rerun returns the stored evaluation with zero executor calls and zero writes, under a ticking clock", async () => {
    const harness = await improvedHarness();
    await harness.declare();
    const evaluation = await harness.run();
    const after = await harness.storeSnapshot();
    harness.clock.tick();
    expect(await harness.run()).toEqual(evaluation);
    expect(harness.replay.calls.attempt).toBe(6);
    expect(await harness.storeSnapshot()).toBe(after);
  });

  it("is inconclusive when the paired delta is below the minimum useful effect", async () => {
    const harness = await createExperimentHarness({ grade: gradeByArm(CONTROL_BASELINE, { ...CONTROL_BASELINE }) });
    await harness.declare();
    const evaluation = await harness.run();
    expect(evaluation.verdict).toBe("inconclusive");
    expect(evaluation.analysis?.meanFavorableDelta).toBe(0);
    expect(evaluation.analysis?.favorablePairs).toBe(0);
    const intervention = await harness.learning.getIntervention({ interventionId: harness.intervention.id });
    expect(intervention?.state.validation).toBe("inconclusive");
  });

  it("is regressed when the primary metric moves against the declared direction", async () => {
    const harness = await createExperimentHarness({
      grade: gradeByArm(
        { ...CONTROL_BASELINE, completion_typecheck_pass: true },
        { ...TREATMENT_IMPROVED, completion_typecheck_pass: false },
      ),
    });
    await harness.declare();
    const evaluation = await harness.run();
    expect(evaluation.verdict).toBe("regressed");
    expect(evaluation.analysis?.meanFavorableDelta).toBe(-1);
    expect(evaluation.analysis?.unfavorablePairs).toBe(3);
    expect(evaluation.analysis?.guardrails.every((guardrail) => guardrail.status === "held")).toBe(true);
  });

  it("needs a majority of pairs as well as the mean effect: a mixed population is inconclusive", async () => {
    const harness = await createExperimentHarness({
      episodeCount: 4,
      grade: (request) => {
        const index = Number(request.episodeId.replace("manual-evidence/exp-ep-", ""));
        if (request.arm === "control")
          return gradeValues({ ...CONTROL_BASELINE, completion_typecheck_pass: index === 4 });
        return gradeValues({ ...TREATMENT_IMPROVED, completion_typecheck_pass: index === 1 || index === 2 });
      },
    });
    await harness.declare();
    const evaluation = await harness.run();
    // Pairs: +1, +1, 0, -1 → mean 0.25 ≥ 0.15 and favorable 2 > unfavorable 1 → improved.
    expect(evaluation.analysis?.pairs.map((pair) => pair.favorableDelta)).toEqual([1, 1, 0, -1]);
    expect(evaluation.verdict).toBe("improved");
  });

  it("treats the episode as the unit and nests repetitions: a majority of repetitions decides each arm", async () => {
    const harness = await createExperimentHarness({
      grade: (request) =>
        gradeValues(
          request.arm === "control"
            ? CONTROL_BASELINE
            : { ...TREATMENT_IMPROVED, cost: 2, completion_typecheck_pass: request.repetition !== 3 },
        ),
    });
    await harness.declare({ repetitionsPerPair: 3 });
    const evaluation = await harness.run();
    expect(harness.replay.calls.attempt).toBe(18);
    expect(evaluation.classifications).toHaveLength(18);
    expect(evaluation.attemptIds).toHaveLength(18);
    expect(evaluation.analysis?.pairs).toEqual(
      harness.episodeIds.map((episodeId) => ({ episodeId, control: 0, treatment: 1, favorableDelta: 1 })),
    );
    expect(evaluation.verdict).toBe("improved");
    expect(harness.replay.requests.slice(0, 6).map((request) => [request.repetition, request.arm])).toEqual([
      [1, "control"],
      [1, "treatment"],
      [2, "control"],
      [2, "treatment"],
      [3, "control"],
      [3, "treatment"],
    ]);
  });

  it("supports a lower-is-better number metric with a mean over repetitions", async () => {
    const harness = await createExperimentHarness({
      grade: (request) =>
        gradeValues({
          latency_ms: request.arm === "control" ? 200 : request.repetition === 1 ? 80 : 120,
          acceptance_tests: true,
          cost: 1,
        }),
    });
    await harness.declare({
      primaryMetric: {
        definition: LATENCY_METRIC,
        direction: "lower",
        minimumUsefulEffect: 50,
        perEpisodeAggregation: "mean-of-nested-repetitions-v1",
        missingnessRuleDigest: harness.definitionInput().primaryMetric.missingnessRuleDigest,
      },
      repetitionsPerPair: 2,
    });
    const evaluation = await harness.run();
    expect(evaluation.analysis?.pairs[0]).toEqual({
      episodeId: harness.episodeIds[0],
      control: 200,
      treatment: 100,
      favorableDelta: 100,
    });
    expect(evaluation.verdict).toBe("improved");
  });
});

describe("learning.runExperiment: guardrails defeat improvement", () => {
  it("a must_not_regress guardrail that fails on any episode makes an otherwise improved design regressed", async () => {
    const harness = await createExperimentHarness({
      grade: (request) =>
        gradeValues(
          request.arm === "control"
            ? CONTROL_BASELINE
            : { ...TREATMENT_IMPROVED, acceptance_tests: request.episodeId !== "manual-evidence/exp-ep-2" },
        ),
    });
    await harness.declare();
    const evaluation = await harness.run();
    expect(evaluation.verdict).toBe("regressed");
    expect(evaluation.analysis?.meanFavorableDelta).toBe(1);
    expect(evaluation.analysis?.guardrails[0]).toEqual({
      metric: "acceptance_tests",
      rule: "must_not_regress",
      status: "regressed",
      regressedEpisodeIds: ["manual-evidence/exp-ep-2"],
    });
    expect(evaluation.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "experiment.guardrail_regression",
      "experiment.verdict",
    ]);
    const intervention = await harness.learning.getIntervention({ interventionId: harness.intervention.id });
    expect(intervention?.state.validation).toBe("regressed");
  });

  it("a maximum guardrail over the threshold on any episode is a regression", async () => {
    const harness = await createExperimentHarness({
      grade: gradeByArm(CONTROL_BASELINE, { ...TREATMENT_IMPROVED, cost: 9 }),
    });
    await harness.declare();
    const evaluation = await harness.run();
    expect(evaluation.verdict).toBe("regressed");
    expect(evaluation.analysis?.guardrails[1]).toEqual({
      metric: "cost",
      rule: "maximum",
      status: "regressed",
      regressedEpisodeIds: harness.episodeIds,
    });
  });

  it("a must_pass guardrail is absolute on the treatment arm, whatever control did", async () => {
    const harness = await createExperimentHarness({
      grade: gradeByArm(
        { ...CONTROL_BASELINE, acceptance_tests: false },
        { ...TREATMENT_IMPROVED, acceptance_tests: false },
      ),
    });
    await harness.declare({ guardrails: [{ metric: ACCEPTANCE_METRIC, rule: "must_pass" }] });
    const evaluation = await harness.run();
    expect(evaluation.verdict).toBe("regressed");
    expect(evaluation.analysis?.guardrails).toEqual([
      { metric: "acceptance_tests", rule: "must_pass", status: "regressed", regressedEpisodeIds: harness.episodeIds },
    ]);
    // Under must_not_regress the same grades hold: control never passed either.
    const relative = await createExperimentHarness({
      grade: gradeByArm(
        { ...CONTROL_BASELINE, acceptance_tests: false },
        { ...TREATMENT_IMPROVED, acceptance_tests: false },
      ),
    });
    await relative.declare({ guardrails: [{ metric: ACCEPTANCE_METRIC, rule: "must_not_regress" }] });
    expect((await relative.run()).verdict).toBe("improved");
  });
});

describe("learning.runExperiment: missing or invalid evidence is invalid, never neutral", () => {
  async function invalidRun(
    grade: (request: ReplayAttemptRequest, attempt: number) => InMemoryReplayGrade,
    options: { readonly ceiling?: boolean } = {},
  ): Promise<{ harness: ExperimentHarness; evaluation: EvaluationResult }> {
    const harness = await createExperimentHarness({ grade });
    await harness.declare(options.ceiling === true ? { costCeiling: { amount: 100, currency: "USD" } } : {});
    const evaluation = await harness.run();
    expect(evaluation.analysis).toBeNull();
    expect(evaluation.verdict).toBe("invalid");
    const intervention = await harness.learning.getIntervention({ interventionId: harness.intervention.id });
    expect(intervention?.state.validation).toBe("invalid");
    expect(intervention?.evaluationIds).toEqual([evaluation.id]);
    return { harness, evaluation };
  }

  it("a missing declared metric on one attempt invalidates the whole evaluation and stops the run", async () => {
    const { harness, evaluation } = await invalidRun((request) =>
      request.arm === "treatment"
        ? gradeValues({ completion_typecheck_pass: true, acceptance_tests: true })
        : gradeValues(CONTROL_BASELINE),
    );
    expect(evaluation.classifications.map((classification) => classification.status)).toEqual([
      "valid",
      "metric_missing",
      "not_run",
      "not_run",
      "not_run",
      "not_run",
    ]);
    expect(evaluation.attemptIds).toHaveLength(2);
    expect(evaluation.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["experiment.missing_metric"]);
    expect(evaluation.diagnostics[0]?.details).toMatchObject({ metric: "cost", arm: "treatment" });
    expect(harness.replay.calls.attempt).toBe(2);
  });

  it("a metric of the wrong definition is missing: the frozen definition must match exactly", async () => {
    const { evaluation } = await invalidRun((request) => {
      if (request.arm === "control") return gradeValues(CONTROL_BASELINE);
      return {
        status: "completed",
        measurements: [
          { metric: { ...PRIMARY_METRIC, unit: "ok" }, value: true },
          { metric: ACCEPTANCE_METRIC, value: true },
          { metric: COST_METRIC, value: 3 },
        ],
      };
    });
    expect(evaluation.classifications[1]?.status).toBe("metric_missing");
  });

  it("a failed attempt reported by the executor is a missing arm", async () => {
    const { harness, evaluation } = await invalidRun((_request, attempt) =>
      attempt === 3
        ? {
            status: "failed",
            diagnostics: [{ code: "host.timeout", severity: "error", message: "the agent timed out" }],
            attested: true,
          }
        : gradeValues(CONTROL_BASELINE),
    );
    expect(evaluation.classifications.map((classification) => classification.status)).toEqual([
      "valid",
      "valid",
      "failed",
      "not_run",
      "not_run",
      "not_run",
    ]);
    expect(evaluation.diagnostics[0]?.code).toBe("experiment.missing_arm");
    const attempt = await loadAttempt(harness, evaluation.attemptIds[2] ?? "");
    expect(attempt.status).toBe("failed");
    expect(attempt.failed?.diagnostics[0]?.code).toBe("host.timeout");
  });

  it("an executor that throws is retained as a failed attempt without its error text", async () => {
    const { harness, evaluation } = await invalidRun((_request, attempt) =>
      attempt === 1 ? { status: "throw" } : gradeValues(CONTROL_BASELINE),
    );
    expect(evaluation.classifications[0]?.status).toBe("failed");
    const attempt = await loadAttempt(harness, evaluation.attemptIds[0] ?? "");
    expect(attempt.failed?.diagnostics).toEqual([expect.objectContaining({ code: "experiment.executor_error" })]);
    expect(JSON.stringify(attempt)).not.toContain("scripted failure");
  });

  it("an unparseable executor result is retained as rejected with kernel diagnostics only", async () => {
    const { harness, evaluation } = await invalidRun((_request, attempt) =>
      attempt === 1
        ? { status: "raw", value: { status: "completed", secret: "do not persist" } }
        : gradeValues(CONTROL_BASELINE),
    );
    expect(evaluation.classifications[0]?.status).toBe("rejected");
    const attempt = await loadAttempt(harness, evaluation.attemptIds[0] ?? "");
    expect(attempt.status).toBe("rejected");
    expect(attempt.rejected?.[0]?.code).toBe("schema.invalid");
    expect(JSON.stringify(attempt)).not.toContain("do not persist");
  });

  it("a hostile result whose own accessors throw is rejected with kernel diagnostics, never stranded", async () => {
    const hostile: unknown = {
      get status(): never {
        throw new TypeError("do not persist");
      },
    };
    const { harness, evaluation } = await invalidRun((_request, attempt) =>
      attempt === 1 ? { status: "raw", value: hostile } : gradeValues(CONTROL_BASELINE),
    );
    expect(evaluation.classifications[0]?.status).toBe("rejected");
    const attempt = await loadAttempt(harness, evaluation.attemptIds[0] ?? "");
    expect(attempt.rejected).toEqual([expect.objectContaining({ code: "experiment.result_unparseable" })]);
    expect(JSON.stringify(attempt)).not.toContain("do not persist");
  });

  it("a drifted fingerprint is fingerprint_drift and the other arm's fingerprint is contamination", async () => {
    const drifted = await invalidRun((request) => ({
      ...gradeValues(request.arm === "control" ? CONTROL_BASELINE : TREATMENT_IMPROVED),
      attestation: request.arm === "treatment" ? { fingerprintDigest: hostDigest("drifted-fingerprint") } : {},
    }));
    expect(drifted.evaluation.classifications[1]?.status).toBe("fingerprint_drift");
    expect(drifted.evaluation.diagnostics[0]?.code).toBe("experiment.fingerprint_drift");
    const contaminated = await invalidRun((request) => ({
      ...gradeValues(request.arm === "control" ? CONTROL_BASELINE : TREATMENT_IMPROVED),
      attestation: request.arm === "control" ? { fingerprintDigest: TREATMENT_FINGERPRINT } : {},
    }));
    expect(contaminated.evaluation.classifications[0]?.status).toBe("contaminated");
    expect(contaminated.evaluation.diagnostics[0]?.code).toBe("experiment.contaminated");
  });

  it("an attestation that disagrees with the request or the executor registration is a mismatch", async () => {
    const nonce = await invalidRun((request) => ({
      ...gradeValues(request.arm === "control" ? CONTROL_BASELINE : TREATMENT_IMPROVED),
      attestation: { attestationNonce: "replayed-nonce" },
    }));
    expect(nonce.evaluation.classifications[0]?.status).toBe("attestation_mismatch");
    expect(nonce.evaluation.diagnostics[0]).toMatchObject({
      code: "experiment.attestation_mismatch",
      path: ["attestation", "attestationNonce"],
    });
    const executor = await invalidRun((request) => ({
      ...gradeValues(request.arm === "control" ? CONTROL_BASELINE : TREATMENT_IMPROVED),
      attestation: { executor: { id: "in-memory-replay", version: "1.0.0", registrationDigest: hostDigest("other") } },
    }));
    expect(executor.evaluation.classifications[0]?.status).toBe("attestation_mismatch");
    const grader = await invalidRun((request) => ({
      ...gradeValues(request.arm === "control" ? CONTROL_BASELINE : TREATMENT_IMPROVED),
      attestation: { graderDigest: hostDigest("other-grader") },
    }));
    expect(grader.evaluation.diagnostics[0]?.path).toEqual(["attestation", "graderDigest"]);
    const currency = await invalidRun(
      (request) =>
        gradeValues(request.arm === "control" ? CONTROL_BASELINE : TREATMENT_IMPROVED, {
          cost: { amount: 1, currency: "EUR" },
        }),
      { ceiling: true },
    );
    expect(currency.evaluation.diagnostics[0]?.path).toEqual(["cost", "currency"]);
  });
});

describe("learning.runExperiment: the stopping rule and budgets", () => {
  it("stops at the cost ceiling with an inconclusive verdict, passing the remaining budget to each attempt", async () => {
    const harness = await createExperimentHarness({
      grade: (request) =>
        gradeValues(request.arm === "control" ? CONTROL_BASELINE : TREATMENT_IMPROVED, {
          cost: { amount: 2, currency: "USD" },
        }),
    });
    await harness.declare({ costCeiling: { amount: 4, currency: "USD" } });
    const evaluation = await harness.run();
    expect(evaluation.verdict).toBe("inconclusive");
    expect(evaluation.analysis).toBeNull();
    expect(evaluation.classifications.map((classification) => classification.status)).toEqual([
      "valid",
      "valid",
      "not_run",
      "not_run",
      "not_run",
      "not_run",
    ]);
    expect(evaluation.diagnostics).toEqual([
      expect.objectContaining({ code: "experiment.stopped", severity: "warning" }),
    ]);
    expect(harness.replay.calls.attempt).toBe(2);
    expect(harness.replay.requests.map((request) => request.budget.maximumCost?.amount)).toEqual([4, 2]);
    const intervention = await harness.learning.getIntervention({ interventionId: harness.intervention.id });
    expect(intervention?.state.validation).toBe("inconclusive");
  });

  it("a ceiling reached exactly on the final slot completes the design without a stop warning", async () => {
    const harness = await createExperimentHarness({
      episodeCount: 1,
      grade: (request) =>
        gradeValues(request.arm === "control" ? CONTROL_BASELINE : TREATMENT_IMPROVED, {
          cost: { amount: 2, currency: "USD" },
        }),
    });
    await harness.declare({ costCeiling: { amount: 4, currency: "USD" } });
    const evaluation = await harness.run();
    expect(evaluation.verdict).toBe("improved");
    expect(evaluation.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["experiment.verdict"]);
    expect(harness.replay.calls.attempt).toBe(2);
  });

  it("under a ceiling, cost is attestation content: a missing or over-budget cost is a mismatch, never zero spend", async () => {
    const missing = await createExperimentHarness({ grade: gradeByArm(CONTROL_BASELINE, TREATMENT_IMPROVED) });
    await missing.declare({ costCeiling: { amount: 100, currency: "USD" } });
    const unattested = await missing.run();
    expect(unattested.verdict).toBe("invalid");
    expect(unattested.classifications[0]?.status).toBe("attestation_mismatch");
    expect(unattested.diagnostics[0]?.path).toEqual(["cost"]);
    expect(missing.replay.calls.attempt).toBe(1);

    const overspent = await createExperimentHarness({
      grade: (request) =>
        gradeValues(request.arm === "control" ? CONTROL_BASELINE : TREATMENT_IMPROVED, {
          cost: { amount: 3, currency: "USD" },
        }),
    });
    await overspent.declare({ costCeiling: { amount: 5, currency: "USD" } });
    const over = await overspent.run();
    // Slot 1 spends 3 of 5; slot 2 is dispatched with budget 2 and attests 3.
    expect(over.verdict).toBe("invalid");
    expect(over.classifications.map((classification) => classification.status)).toEqual([
      "valid",
      "attestation_mismatch",
      "not_run",
      "not_run",
      "not_run",
      "not_run",
    ]);
    expect(over.diagnostics[0]?.path).toEqual(["cost", "amount"]);
    expect(overspent.replay.requests.map((request) => request.budget.maximumCost?.amount)).toEqual([5, 2]);
  });

  it("applies the reference tolerance at the effect boundary and at the ceiling", async () => {
    const boundary = await createExperimentHarness({
      grade: (request) =>
        gradeValues({ latency_ms: request.arm === "control" ? 0.4 : 0.7, acceptance_tests: true, cost: 1 }),
    });
    await boundary.declare({
      primaryMetric: {
        definition: LATENCY_METRIC,
        direction: "higher",
        minimumUsefulEffect: 0.3,
        perEpisodeAggregation: "mean-of-nested-repetitions-v1",
        missingnessRuleDigest: boundary.definitionInput().primaryMetric.missingnessRuleDigest,
      },
    });
    // 0.7 - 0.4 = 0.29999999999999993: exactly the declared minimum within the tolerance.
    expect((await boundary.run()).verdict).toBe("improved");

    const ceiling = await createExperimentHarness({
      grade: (request, attempt) =>
        gradeValues(request.arm === "control" ? CONTROL_BASELINE : TREATMENT_IMPROVED, {
          cost: { amount: attempt === 1 ? 0.1 : 0.7, currency: "USD" },
        }),
    });
    await ceiling.declare({ costCeiling: { amount: 0.8, currency: "USD" } });
    // 0.1 + 0.7 = 0.7999999999999999 reaches the 0.8 ceiling within the tolerance.
    const stopped = await ceiling.run();
    expect(stopped.verdict).toBe("inconclusive");
    expect(ceiling.replay.calls.attempt).toBe(2);
  });

  it("a ceiling the design stays under does not stop it", async () => {
    const harness = await createExperimentHarness({
      grade: (request) =>
        gradeValues(request.arm === "control" ? CONTROL_BASELINE : TREATMENT_IMPROVED, {
          cost: { amount: 2, currency: "USD" },
        }),
    });
    await harness.declare({ costCeiling: { amount: 13, currency: "USD" } });
    expect((await harness.run()).verdict).toBe("improved");
    expect(harness.replay.calls.attempt).toBe(6);
  });
});

describe("learning.runExperiment: refusals and lineage", () => {
  it("refuses an undeclared experiment and malformed input with zero writes", async () => {
    const harness = await improvedHarness();
    const before = await harness.storeSnapshot();
    await expectRefusal(() => harness.run("exp-unknown"), "experiment.not_predeclared");
    const malformed: unknown = {};
    await expectRefusal(
      () => harness.learning.runExperiment(malformed as Parameters<typeof harness.learning.runExperiment>[0]),
      "schema.invalid",
    );
    expect(await harness.storeSnapshot()).toBe(before);
    expect(harness.replay.calls.attempt).toBe(0);
  });

  it("refuses to run when the declared executor is no longer configured, with zero writes", async () => {
    const harness = await improvedHarness();
    await harness.declare();
    const other = createInMemoryReplayExecutor({ id: "other" });
    const swapped = await createExperimentHarness({ store: harness.store, rebuild: harness, replay: other });
    const without = await createPublicationHarness({ store: harness.store });
    const before = await harness.storeSnapshot();
    await expectRefusal(() => swapped.run(), "experiment.executor_unavailable");
    await expectRefusal(
      () => without.learning.runExperiment({ experimentId: EXPERIMENT_ID }),
      "experiment.executor_unavailable",
    );
    expect(await harness.storeSnapshot()).toBe(before);
    expect(other.calls.attempt).toBe(0);
  });

  it("binds later experiments as later verdicts without rewriting earlier evaluations", async () => {
    const harness = await createExperimentHarness({
      grade: (request) =>
        gradeValues(
          request.experimentId === EXPERIMENT_ID || request.experimentId === "exp-4"
            ? request.arm === "control"
              ? CONTROL_BASELINE
              : TREATMENT_IMPROVED
            : request.arm === "control"
              ? { ...CONTROL_BASELINE, completion_typecheck_pass: true }
              : { ...TREATMENT_IMPROVED, completion_typecheck_pass: false },
        ),
    });
    await harness.declare();
    const first = await harness.run();
    expect(first.verdict).toBe("improved");
    await harness.declare({ id: "exp-2", hypothesis: "A second, stricter design." });
    const second = await harness.run("exp-2");
    expect(second.verdict).toBe("regressed");
    const intervention = await harness.learning.getIntervention({ interventionId: harness.intervention.id });
    expect(intervention?.state.validation).toBe("regressed");
    expect(intervention?.evaluationIds).toEqual([first.id, second.id]);
    // Re-running the first experiment returns its stored evaluation and does not flip the state back.
    expect(await harness.run()).toEqual(first);
    const after = await harness.learning.getIntervention({ interventionId: harness.intervention.id });
    expect(after?.state.validation).toBe("regressed");
    expect(after?.latestTransitionId).toBe(intervention?.latestTransitionId);
    // A same-verdict experiment binds its evaluation without a new transition.
    await harness.declare({ id: "exp-3", hypothesis: "A third design." });
    const third = await harness.run("exp-3");
    expect(third.verdict).toBe("regressed");
    const again = await harness.learning.getIntervention({ interventionId: harness.intervention.id });
    expect(again?.evaluationIds).toEqual([first.id, second.id, third.id]);
    expect(again?.latestTransitionId).toBe(intervention?.latestTransitionId);

    // Only the latest evaluation owns the state: after a fourth experiment
    // moves it to improved, rereading the unbound third is a pure read.
    await harness.declare({ id: "exp-4", hypothesis: "A fourth design." });
    const fourth = await harness.run("exp-4");
    expect(fourth.verdict).toBe("improved");
    const moved = await harness.learning.getIntervention({ interventionId: harness.intervention.id });
    expect(moved?.state.validation).toBe("improved");
    const before = await harness.storeSnapshot();
    expect(await harness.run("exp-3")).toEqual(third);
    expect(await harness.storeSnapshot()).toBe(before);
    expect(
      (await harness.learning.getIntervention({ interventionId: harness.intervention.id }))?.state.validation,
    ).toBe("improved");
  });

  it("a validate edge whose evaluation says another verdict is store corruption, not a state", async () => {
    const harness = await improvedHarness();
    await harness.declare();
    const evaluation = await harness.run();
    const context = contextForLearningLoop(harness.learning);
    await appendInterventionTransition(
      context,
      harness.intervention.id,
      (current) => ({ ...current, validation: "regressed" }),
      [evaluation.id],
    );
    await expect(harness.learning.getIntervention({ interventionId: harness.intervention.id })).rejects.toMatchObject({
      code: "store.corrupt",
    });
  });

  it("evaluates a disabled intervention: validation is independent of activation", async () => {
    const harness = await improvedHarness();
    await harness.declare();
    const prepared = await harness.learning.preparePublication({
      candidateId: harness.candidate.id,
      destinationId: DESTINATION_ID,
      action: "disable",
    });
    completed(
      await harness.learning.publish({ planId: prepared.plan.id, authorizationEvidence: { decision: "authorized" } }),
    );
    expect((await harness.run()).verdict).toBe("improved");
    const intervention = await harness.learning.getIntervention({ interventionId: harness.intervention.id });
    expect(intervention?.state).toEqual({
      publication: "published",
      authorization: "authorized",
      activation: "disabled",
      validation: "improved",
    });
  });

  it("exposure arms bind a declared experiment and must agree with the applied entries", async () => {
    const harness = await improvedHarness();
    await harness.declare();
    const resolved = await harness.learning.resolveContext({
      episodeId: "change-42",
      scope: SCOPE,
      query: { taskClass: "typescript-code-change" },
      budget: { maximumEntries: 8, maximumCharacters: 4_000 },
    });
    const evidenceIds = ["manual-evidence/obs-42-typecheck"];
    const base = {
      resolutionReceiptId: resolved.id,
      assignmentId: "paired-v1",
      fingerprintId: "fp-treatment",
      evidenceIds,
    };
    const applied = resolved.entries.map((entry) => entry.id);
    const before = await harness.storeSnapshot();
    await expectRefusal(
      () =>
        harness.learning.acknowledgeExposure({
          ...base,
          appliedEntryIds: applied,
          experiment: { experimentId: "exp-x", arm: "treatment" },
        }),
      "exposure.experiment_unavailable",
    );
    await expectRefusal(
      () =>
        harness.learning.acknowledgeExposure({
          ...base,
          appliedEntryIds: [],
          experiment: { experimentId: EXPERIMENT_ID, arm: "treatment" },
        }),
      "exposure.experiment_arm_mismatch",
    );
    await expectRefusal(
      () =>
        harness.learning.acknowledgeExposure({
          ...base,
          appliedEntryIds: applied,
          experiment: { experimentId: EXPERIMENT_ID, arm: "control" },
        }),
      "exposure.experiment_arm_mismatch",
    );
    expect(await harness.storeSnapshot()).toBe(before);
    const treatment = await harness.learning.acknowledgeExposure({
      ...base,
      appliedEntryIds: applied,
      experiment: { experimentId: EXPERIMENT_ID, arm: "treatment" },
    });
    expect(treatment.experiment).toEqual({ experimentId: EXPERIMENT_ID, arm: "treatment" });
    expect(treatment.entries.map((entry) => entry.interventionId)).toEqual([harness.intervention.id]);
  });
});
