// learning.declareExperiment (decision 0028): a design is frozen before any
// result exists. The kernel recomputes the eligibility-set and definition
// digests, requires the reference rules, a configured kernel-minted
// executor, a journaled `publish` intervention, and durable eligible
// episodes with resolved identity; the declaration is create-only and
// idempotent; every refusal writes nothing; and a declaration grants no
// validation.
import { describe, expect, it } from "vitest";
import { experimentDefinitionDigest, parseExperimentDefinition, referenceExperimentRules } from "../src/index.js";
import { createInMemoryReplayExecutor } from "../src/testing/index.js";
import {
  EXPERIMENT_ID,
  CONTROL_FINGERPRINT,
  addedKinds,
  createExperimentHarness,
  expectRefusal,
  hostDigest,
} from "./experiment-harness.js";
import { DESTINATION_ID, completed, createPublicationHarness } from "./publication-harness.js";

describe("learning.declareExperiment", () => {
  it("persists one frozen, content-digested definition bound to the reference rules, executor, intervention, and population", async () => {
    const harness = await createExperimentHarness();
    const before = await harness.storeSnapshot();
    const input = harness.definitionInput();
    const definition = await harness.declare();
    const { id: _id, ...content } = input;
    expect(definition).toEqual({
      schemaVersion: 1,
      ...input,
      declaredAt: harness.clock.now(),
      definitionDigest: experimentDefinitionDigest(content),
    });
    expect(Object.isFrozen(definition)).toBe(true);
    expect(Object.isFrozen(definition.guardrails)).toBe(true);
    expect(parseExperimentDefinition(definition)).toEqual(definition);
    expect(addedKinds(before, await harness.storeSnapshot())).toEqual(["experiment-definition"]);
    expect(definition.eligibleEpisodeIds).toEqual(harness.episodeIds);
    expect(definition.pairCount).toBe(3);
    expect(harness.replay.calls.attempt).toBe(0);
  });

  it("is idempotent for the same design under a ticking clock and refuses a changed design under the same id", async () => {
    const harness = await createExperimentHarness();
    const definition = await harness.declare();
    const after = await harness.storeSnapshot();
    harness.clock.tick();
    expect(await harness.declare()).toEqual(definition);
    expect(await harness.storeSnapshot()).toBe(after);
    await expectRefusal(() => harness.declare({ hypothesis: "A different design." }), "experiment.already_declared");
    await expectRefusal(() => harness.declare({ repetitionsPerPair: 2 }), "experiment.already_declared");
    expect(await harness.storeSnapshot()).toBe(after);
    // A different id with the same design is its own experiment.
    const second = await harness.declare({ id: "exp-2" });
    expect(second.definitionDigest).toBe(definition.definitionDigest);
    expect(second.id).toBe("exp-2");
  });

  it("refuses, with zero writes, rules the kernel cannot apply", async () => {
    const harness = await createExperimentHarness();
    const before = await harness.storeSnapshot();
    const rules = referenceExperimentRules();
    await expectRefusal(
      () => harness.declare({ decisionRuleDigest: hostDigest("my-rule") }),
      "experiment.rule_unknown",
    );
    await expectRefusal(
      () => harness.declare({ stoppingRuleDigest: hostDigest("my-rule") }),
      "experiment.rule_unknown",
    );
    await expectRefusal(
      () =>
        harness.declare({
          primaryMetric: {
            ...harness.definitionInput().primaryMetric,
            missingnessRuleDigest: rules.decisionRule.digest,
          },
        }),
      "experiment.rule_unknown",
    );
    expect(await harness.storeSnapshot()).toBe(before);
  });

  it("refuses, with zero writes, an executor that is not configured on this loop", async () => {
    const harness = await createExperimentHarness();
    const before = await harness.storeSnapshot();
    const other = createInMemoryReplayExecutor({ id: "other" });
    await expectRefusal(
      () => harness.declare({ replayExecutorDigest: other.executor.registrationDigest }),
      "experiment.executor_unavailable",
    );
    await expectRefusal(
      () => harness.declare({ replayExecutorDigest: hostDigest("nope") }),
      "experiment.executor_unavailable",
    );
    expect(await harness.storeSnapshot()).toBe(before);
    // A loop composed without replay executors can declare nothing, whatever the store holds.
    const without = await createPublicationHarness({ store: harness.store });
    const beforeWithout = await harness.storeSnapshot();
    await expectRefusal(
      () => without.learning.declareExperiment(harness.definitionInput()),
      "experiment.executor_unavailable",
    );
    expect(await harness.storeSnapshot()).toBe(beforeWithout);
  });

  it("refuses, with zero writes, an unknown intervention or a reversal intervention as subject", async () => {
    const harness = await createExperimentHarness();
    const before = await harness.storeSnapshot();
    await expectRefusal(
      () => harness.declare({ interventionId: `intervention-${"9".repeat(64)}` }),
      "experiment.intervention_not_found",
    );
    expect(await harness.storeSnapshot()).toBe(before);
    const prepared = await harness.learning.preparePublication({
      candidateId: harness.candidate.id,
      destinationId: DESTINATION_ID,
      action: "disable",
    });
    const reversal = completed(
      await harness.learning.publish({ planId: prepared.plan.id, authorizationEvidence: { decision: "authorized" } }),
    ).intervention;
    const afterReversal = await harness.storeSnapshot();
    await expectRefusal(() => harness.declare({ interventionId: reversal.id }), "experiment.intervention_mismatch");
    expect(await harness.storeSnapshot()).toBe(afterReversal);
    // The disabled parent remains a subject: validation is independent of activation.
    const definition = await harness.declare();
    expect(definition.interventionId).toBe(harness.intervention.id);
  });

  it("refuses, with zero writes, eligible episodes that are not durable episodes with resolved identity", async () => {
    const harness = await createExperimentHarness();
    const before = await harness.storeSnapshot();
    const ids = [...harness.episodeIds, "manual-evidence/never-ingested"];
    await expectRefusal(
      () => harness.declare({ eligibleEpisodeIds: ids, pairCount: ids.length }),
      "experiment.episode_unknown",
    );
    // A host episode id is not a durable record id: identifiers alone never freeze a population.
    const hostIds = ["exp-ep-1", "exp-ep-2"];
    await expectRefusal(
      () => harness.declare({ eligibleEpisodeIds: hostIds, pairCount: 2 }),
      "experiment.episode_unknown",
    );
    expect(await harness.storeSnapshot()).toBe(before);
  });

  it("refuses malformed designs before any store read: identical arms, forged set digests, bad input", async () => {
    const harness = await createExperimentHarness();
    const before = await harness.storeSnapshot();
    await expectRefusal(() => harness.declare({ treatmentFingerprintDigest: CONTROL_FINGERPRINT }), "schema.invalid");
    await expectRefusal(() => harness.declare({ eligibilitySetDigest: hostDigest("forged") }), "schema.invalid");
    await expectRefusal(() => harness.declare({ pairCount: 2 }), "schema.invalid");
    const malformed: unknown = { id: EXPERIMENT_ID };
    await expectRefusal(
      () => harness.learning.declareExperiment(malformed as Parameters<typeof harness.learning.declareExperiment>[0]),
      "schema.invalid",
    );
    expect(await harness.storeSnapshot()).toBe(before);
  });

  it("grants nothing: the intervention stays untested with no bound evaluation after a declaration", async () => {
    const harness = await createExperimentHarness();
    await harness.declare();
    const intervention = await harness.learning.getIntervention({ interventionId: harness.intervention.id });
    expect(intervention?.state.validation).toBe("untested");
    expect(intervention?.evaluationIds).toEqual([]);
    expect(intervention?.latestTransitionId).toBe(harness.intervention.latestTransitionId);
  });
});
