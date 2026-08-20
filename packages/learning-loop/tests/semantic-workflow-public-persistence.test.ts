// Public L2 crash and retry controls. Consumer operations enter only through
// @cormidia/learning-loop/workflows; the harness supplies adversarial stores.
import { describe, expect, it } from "vitest";
import type { SemanticWorkflowBundle } from "@cormidia/learning-loop/workflows";
import { createSemanticWorkflowBundle } from "@cormidia/learning-loop/workflows";
import { conservativePolicy, createLearningLoop, sha256HexOfCanonicalJson, toJsonValue } from "@cormidia/learning-loop";
import type { LearningStore } from "@cormidia/learning-loop";
import { createInMemoryStore, createSequentialIds } from "@cormidia/learning-loop/testing";
import {
  createGenerationHarness,
  failBeforeCreate,
  fakeCreateSuccess,
  loseCreateAcknowledgement,
  positiveProviderResult,
  recordingStore,
  refusedProviderResult,
  ingestWorkflowEpisode,
} from "./semantic-workflow-generation-harness.js";
import type { StoreMutationTrace } from "./semantic-workflow-generation-harness.js";

async function prepare(
  bundle: SemanticWorkflowBundle,
  input: Parameters<SemanticWorkflowBundle["prepareGeneration"]>[0],
) {
  const result = await bundle.prepareGeneration(input);
  if (result.status !== "prepared") throw new Error(`expected prepared workflow, got ${result.status}`);
  return result;
}

async function records(harness: Awaited<ReturnType<typeof createGenerationHarness>>, kind: string) {
  return (await harness.store.list({ namespace: "learning", kind, limit: 100 })).records;
}

async function seedUnrelatedHealth(harness: Awaited<ReturnType<typeof createGenerationHarness>>): Promise<void> {
  const code: "source.partial" = "source.partial";
  const effect: "limits_claims" = "limits_claims";
  const completeness: "partial" = "partial";
  const base = {
    code,
    effect,
    sourceId: harness.source.id,
    sourceRegistrationRevision: harness.source.registryRevision,
    sourceRef: "recovery-health-drift-source",
    pageRef: "recovery-health-drift-page",
    completeness,
    affectedRecords: 1,
  };
  const findingDigest = sha256HexOfCanonicalJson(toJsonValue(base));
  const finding = {
    schemaVersion: 1,
    id: `evidence-health-${findingDigest}`,
    ...base,
    findingDigest,
  };
  const value = toJsonValue(finding);
  await harness.store.create(
    { namespace: "learning", kind: "evidence-health", id: finding.id },
    value,
    sha256HexOfCanonicalJson(value),
    `recovery-health-drift/${finding.id}`,
  );
}

const PRE_DISPATCH_KINDS = [
  "semantic-workflow-reservation",
  "semantic-workflow-execution-plan",
  "semantic-workflow-attempt",
  "semantic-workflow-dispatch",
];

const POST_INTENT_KINDS = [
  "semantic-workflow-result",
  "semantic-workflow-execution",
  "semantic-registry-snapshot",
  "derivation-execution",
  "insight-derivation",
  "insight-derivation-index",
  "detector-execution-index",
  "detector-recurrence-binding",
  "detector-execution",
  "semantic-workflow-turn-index",
  "semantic-workflow-turn",
];

describe("public semantic workflow receipt-last recovery", () => {
  it("writes a successful local generation in the exact receipt-last order", async () => {
    const base = createInMemoryStore();
    const trace: StoreMutationTrace = { writes: [] };
    const harness = await createGenerationHarness({ store: recordingStore(base, trace) });
    const prepared = await prepare(harness.bundle, harness.prepareInput);
    trace.writes.length = 0;
    harness.providerState.script = (input) => {
      expect(trace.writes.map((key) => key.kind)).toEqual([
        "semantic-workflow-reservation",
        "semantic-workflow-execution-plan",
        "semantic-workflow-attempt",
        "semantic-workflow-dispatch",
      ]);
      return Promise.resolve(positiveProviderResult(input));
    };
    const result = await harness.bundle.runGeneration({ plan: prepared.plan, authorization: null });
    expect(result).toMatchObject({ status: "completed", persistence: "committed", callbackInvoked: true });
    expect(trace.writes.map((key) => key.kind)).toEqual([
      "semantic-workflow-reservation",
      "semantic-workflow-execution-plan",
      "semantic-workflow-attempt",
      "semantic-workflow-dispatch",
      "semantic-workflow-completion",
      "semantic-workflow-result",
      "semantic-workflow-execution",
      "semantic-registry-snapshot",
      "derivation-execution",
      "insight-derivation",
      "insight-derivation-index",
      "detector-execution-index",
      "detector-recurrence-binding",
      "detector-execution",
      "semantic-workflow-turn-index",
      "semantic-workflow-turn",
    ]);
  });

  it("retries failures before the dispatch acknowledgement and calls the provider exactly once", async () => {
    for (const kind of PRE_DISPATCH_KINDS) {
      const base = createInMemoryStore();
      const harness = await createGenerationHarness({ store: failBeforeCreate(base, kind) });
      const prepared = await prepare(harness.bundle, harness.prepareInput);
      await expect(harness.bundle.runGeneration({ plan: prepared.plan, authorization: null })).rejects.toThrow();
      expect(harness.providerState.calls).toEqual([]);
      const retried = await harness.bundle.runGeneration({ plan: prepared.plan, authorization: null });
      expect(retried).toMatchObject({ status: "completed", callbackInvoked: true });
      expect(harness.providerState.calls).toHaveLength(1);
    }
  });

  it("serializes concurrent same-window plans with different canonical request bytes before dispatch", async () => {
    const harness = await createGenerationHarness();
    let renderCount = 0;
    harness.rendererState.render = () => {
      renderCount += 1;
      return { requestVariant: renderCount };
    };
    const first = await prepare(harness.bundle, harness.prepareInput);
    const second = await prepare(harness.bundle, harness.prepareInput);
    expect(first.executionKeyDigest).toBe(second.executionKeyDigest);
    expect(first.preview.bytes).not.toEqual(second.preview.bytes);
    const settled = await Promise.allSettled([
      harness.bundle.runGeneration({ plan: first.plan, authorization: null }),
      harness.bundle.runGeneration({ plan: second.plan, authorization: null }),
    ]);
    expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(settled.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(harness.providerState.calls).toHaveLength(1);
    expect(await records(harness, "semantic-workflow-dispatch")).toHaveLength(1);
  });

  it("rejects a later same-key plan with different bytes after plan A fully commits", async () => {
    const harness = await createGenerationHarness();
    let renderCount = 0;
    harness.rendererState.render = () => {
      renderCount += 1;
      return { sequentialRequestVariant: renderCount };
    };
    const planA = await prepare(harness.bundle, harness.prepareInput);
    const planB = await prepare(harness.bundle, harness.prepareInput);
    expect(planA.executionKeyDigest).toBe(planB.executionKeyDigest);
    expect(planA.attemptId).toBe(planB.attemptId);
    expect(planA.preview.bytes).not.toEqual(planB.preview.bytes);
    const committed = await harness.bundle.runGeneration({ plan: planA.plan, authorization: null });
    expect(committed).toMatchObject({ status: "completed", callbackInvoked: true });
    expect(harness.providerState.calls).toHaveLength(1);
    await expect(harness.bundle.runGeneration({ plan: planB.plan, authorization: null })).rejects.toMatchObject({
      code: "store.conflict",
    });
    expect(harness.providerState.calls).toHaveLength(1);
    if (committed.turnId === null) throw new Error("sequential plan fixture omitted its winning turn");
    await expect(harness.bundle.getTurn({ turnId: committed.turnId, scope: harness.scope })).resolves.toMatchObject({
      status: "completed",
      request: {
        minimizedBytesDigest: planA.preview.minimizedBytesDigest,
        byteLength: planA.preview.byteLength,
      },
    });
  });

  it("treats a lost dispatch acknowledgement as outcome_unknown and never redispatches", async () => {
    const base = createInMemoryStore();
    const harness = await createGenerationHarness({
      store: loseCreateAcknowledgement(base, "semantic-workflow-dispatch"),
    });
    const prepared = await prepare(harness.bundle, harness.prepareInput);
    await expect(harness.bundle.runGeneration({ plan: prepared.plan, authorization: null })).rejects.toThrow();
    expect(harness.providerState.calls).toEqual([]);
    const retried = await harness.bundle.runGeneration({ plan: prepared.plan, authorization: null });
    expect(retried).toMatchObject({
      status: "outcome_unknown",
      persistence: "dispatch_only",
      callbackInvoked: false,
      turnId: null,
      derivations: [],
    });
    expect(harness.providerState.calls).toEqual([]);
    expect(await records(harness, "semantic-workflow-result")).toEqual([]);
    expect(await records(harness, "semantic-workflow-completion")).toEqual([]);
  });

  it("detects false store acknowledgements and only retries when no dispatch marker exists", async () => {
    const dispatchBase = createInMemoryStore();
    const dispatchHarness = await createGenerationHarness({
      store: fakeCreateSuccess(dispatchBase, "semantic-workflow-dispatch"),
    });
    const dispatchPlan = await prepare(dispatchHarness.bundle, dispatchHarness.prepareInput);
    await expect(
      dispatchHarness.bundle.runGeneration({ plan: dispatchPlan.plan, authorization: null }),
    ).rejects.toMatchObject({ code: "store.corrupt" });
    expect(dispatchHarness.providerState.calls).toEqual([]);
    await expect(
      dispatchHarness.bundle.runGeneration({ plan: dispatchPlan.plan, authorization: null }),
    ).resolves.toMatchObject({ status: "completed", callbackInvoked: true });
    expect(dispatchHarness.providerState.calls).toHaveLength(1);

    const completionBase = createInMemoryStore();
    const completionHarness = await createGenerationHarness({
      store: fakeCreateSuccess(completionBase, "semantic-workflow-completion"),
    });
    const completionPlan = await prepare(completionHarness.bundle, completionHarness.prepareInput);
    await expect(
      completionHarness.bundle.runGeneration({ plan: completionPlan.plan, authorization: null }),
    ).rejects.toMatchObject({ code: "store.corrupt" });
    expect(completionHarness.providerState.calls).toHaveLength(1);
    await expect(
      completionHarness.bundle.runGeneration({ plan: completionPlan.plan, authorization: null }),
    ).resolves.toMatchObject({
      status: "outcome_unknown",
      persistence: "dispatch_only",
      callbackInvoked: false,
      turnId: null,
    });
    expect(completionHarness.providerState.calls).toHaveLength(1);
  });

  it("does not redispatch when the first post-callback completion write is absent", async () => {
    const base = createInMemoryStore();
    const harness = await createGenerationHarness({
      store: failBeforeCreate(base, "semantic-workflow-completion"),
    });
    const prepared = await prepare(harness.bundle, harness.prepareInput);
    await expect(harness.bundle.runGeneration({ plan: prepared.plan, authorization: null })).rejects.toThrow();
    expect(harness.providerState.calls).toHaveLength(1);
    expect(await records(harness, "semantic-workflow-completion")).toEqual([]);
    const retried = await harness.bundle.runGeneration({ plan: prepared.plan, authorization: null });
    expect(retried).toMatchObject({
      status: "outcome_unknown",
      persistence: "dispatch_only",
      callbackInvoked: false,
      turnId: null,
    });
    expect(harness.providerState.calls).toHaveLength(1);
  });

  it("does not redispatch a refused response when its first result write is absent", async () => {
    const base = createInMemoryStore();
    const harness = await createGenerationHarness({
      store: failBeforeCreate(base, "semantic-workflow-result"),
    });
    harness.providerState.script = (input) => Promise.resolve(refusedProviderResult(input));
    const prepared = await prepare(harness.bundle, harness.prepareInput);
    await expect(harness.bundle.runGeneration({ plan: prepared.plan, authorization: null })).rejects.toThrow();
    expect(harness.providerState.calls).toHaveLength(1);
    const retried = await harness.bundle.runGeneration({ plan: prepared.plan, authorization: null });
    expect(retried).toMatchObject({
      status: "outcome_unknown",
      persistence: "dispatch_only",
      callbackInvoked: false,
      turnId: null,
    });
    expect(harness.providerState.calls).toHaveLength(1);
  });

  it("forward-completes refused-result and terminal acknowledgements without another provider call", async () => {
    for (const kind of ["semantic-workflow-result", "semantic-workflow-turn-index", "semantic-workflow-turn"]) {
      for (const wrap of [
        ...(kind === "semantic-workflow-result" ? [] : [failBeforeCreate]),
        loseCreateAcknowledgement,
      ]) {
        const base = createInMemoryStore();
        const harness = await createGenerationHarness({ store: wrap(base, kind) });
        harness.providerState.script = (input) => Promise.resolve(refusedProviderResult(input));
        const prepared = await prepare(harness.bundle, harness.prepareInput);
        await expect(harness.bundle.runGeneration({ plan: prepared.plan, authorization: null })).rejects.toThrow();
        expect(harness.providerState.calls).toHaveLength(1);
        const retried = await harness.bundle.runGeneration({ plan: prepared.plan, authorization: null });
        expect(retried).toMatchObject({
          status: "provider_refused",
          persistence: "existing",
          callbackInvoked: false,
        });
        expect(retried.turnId).not.toBeNull();
        expect(harness.providerState.calls).toHaveLength(1);
      }
    }
  });

  it("forward-completes a lost completion acknowledgement without another provider call", async () => {
    const base = createInMemoryStore();
    const harness = await createGenerationHarness({
      store: loseCreateAcknowledgement(base, "semantic-workflow-completion"),
    });
    const prepared = await prepare(harness.bundle, harness.prepareInput);
    await expect(harness.bundle.runGeneration({ plan: prepared.plan, authorization: null })).rejects.toThrow();
    expect(harness.providerState.calls).toHaveLength(1);
    expect(await records(harness, "semantic-workflow-completion")).toHaveLength(1);
    const retried = await harness.bundle.runGeneration({ plan: prepared.plan, authorization: null });
    expect(retried).toMatchObject({
      status: "completed",
      persistence: "existing",
      callbackInvoked: false,
    });
    expect(retried.turnId).not.toBeNull();
    expect(harness.providerState.calls).toHaveLength(1);
  });

  it("forward-completes every later pre-write and lost-acknowledgement fault from the exact intent", async () => {
    for (const kind of POST_INTENT_KINDS) {
      for (const wrap of [failBeforeCreate, loseCreateAcknowledgement]) {
        const base = createInMemoryStore();
        const harness = await createGenerationHarness({ store: wrap(base, kind) });
        const prepared = await prepare(harness.bundle, harness.prepareInput);
        await expect(harness.bundle.runGeneration({ plan: prepared.plan, authorization: null })).rejects.toThrow();
        expect(harness.providerState.calls).toHaveLength(1);
        expect(await records(harness, "semantic-workflow-completion")).toHaveLength(1);
        const retried = await harness.bundle.runGeneration({ plan: prepared.plan, authorization: null });
        expect(retried).toMatchObject({
          status: "completed",
          persistence: "existing",
          callbackInvoked: false,
        });
        expect(retried.turnId).not.toBeNull();
        expect(harness.providerState.calls).toHaveLength(1);
      }
    }
  });

  it("recovers a saved pre-dispatch attempt in a new bundle without invoking any callback", async () => {
    const base = createInMemoryStore();
    const harness = await createGenerationHarness({
      store: failBeforeCreate(base, "semantic-workflow-dispatch"),
    });
    const prepared = await prepare(harness.bundle, harness.prepareInput);
    await expect(harness.bundle.runGeneration({ plan: prepared.plan, authorization: null })).rejects.toThrow();
    const recovered = await createSemanticWorkflowBundle(harness.factoryInput).recoverGeneration({
      attemptId: prepared.attemptId,
      scope: harness.scope,
    });
    expect(recovered).toEqual({
      status: "not_dispatched",
      persistence: "not_dispatched",
      callbackInvoked: false,
      turnId: null,
      derivations: [],
    });
    expect(harness.providerState.calls).toEqual([]);
    expect(harness.authorityState.calls).toEqual([]);
  });

  it("recovers a lost dispatch acknowledgement as dispatch_only outcome_unknown without redispatch", async () => {
    const base = createInMemoryStore();
    const harness = await createGenerationHarness({
      store: loseCreateAcknowledgement(base, "semantic-workflow-dispatch"),
    });
    const prepared = await prepare(harness.bundle, harness.prepareInput);
    await expect(harness.bundle.runGeneration({ plan: prepared.plan, authorization: null })).rejects.toThrow();
    const recovered = await createSemanticWorkflowBundle(harness.factoryInput).recoverGeneration({
      attemptId: prepared.attemptId,
      scope: harness.scope,
    });
    expect(recovered).toEqual({
      status: "outcome_unknown",
      persistence: "dispatch_only",
      callbackInvoked: false,
      turnId: null,
      derivations: [],
    });
    expect(harness.providerState.calls).toEqual([]);
  });

  it("forward-completes a saved intent in a new bundle and converges concurrent recovery", async () => {
    const base = createInMemoryStore();
    const harness = await createGenerationHarness({
      store: failBeforeCreate(base, "semantic-workflow-result"),
    });
    const prepared = await prepare(harness.bundle, harness.prepareInput);
    await expect(harness.bundle.runGeneration({ plan: prepared.plan, authorization: null })).rejects.toThrow();
    expect(harness.providerState.calls).toHaveLength(1);
    const firstBundle = createSemanticWorkflowBundle(harness.factoryInput);
    const secondBundle = createSemanticWorkflowBundle(harness.factoryInput);
    const recovered = await Promise.all([
      firstBundle.recoverGeneration({ attemptId: prepared.attemptId, scope: harness.scope }),
      secondBundle.recoverGeneration({ attemptId: prepared.attemptId, scope: harness.scope }),
    ]);
    expect(recovered.every((result) => result.status === "completed" && !result.callbackInvoked)).toBe(true);
    expect(new Set(recovered.map((result) => result.turnId)).size).toBe(1);
    expect(recovered.every((result) => result.persistence === "committed" || result.persistence === "existing")).toBe(
      true,
    );
    expect(harness.providerState.calls).toHaveLength(1);
  });

  it("recovers from frozen intent after expiry plus registry, window, and health drift", async () => {
    let now = "2026-08-20T00:02:00.000Z";
    const clock = { now: () => now };
    const base = createInMemoryStore();
    const harness = await createGenerationHarness({
      clock,
      store: failBeforeCreate(base, "semantic-workflow-result"),
    });
    const prepared = await prepare(harness.bundle, harness.prepareInput);
    await expect(harness.bundle.runGeneration({ plan: prepared.plan, authorization: null })).rejects.toThrow();
    expect(harness.providerState.calls).toHaveLength(1);
    await ingestWorkflowEpisode(harness, "recovery-window-drift");
    await seedUnrelatedHealth(harness);
    now = "2026-08-20T00:06:00.000Z";
    const rendererCalls = harness.rendererState.calls.length;
    const estimatorCalls = harness.tokenEstimatorState.calls.length;
    harness.rendererState.render = () => {
      throw new Error("PRIVATE-RECOVERY-RENDERER-CANARY");
    };
    harness.tokenEstimatorState.estimate = () => {
      throw new Error("PRIVATE-RECOVERY-ESTIMATOR-CANARY");
    };
    harness.providerState.script = () => Promise.reject(new Error("PRIVATE-RECOVERY-PROVIDER-CANARY"));
    const driftedLoop = createLearningLoop({
      store: harness.store,
      policy: conservativePolicy(),
      identity: harness.identity,
      scopePolicy: harness.scopePolicy,
      contentPolicies: [harness.contentPolicy],
      sources: [harness.source],
      queryCursorScope: "semantic-workflow-generation-tests",
      clock,
      ids: createSequentialIds("semantic-workflow-recovery"),
    });
    const recovered = await createSemanticWorkflowBundle({
      ...harness.factoryInput,
      loop: driftedLoop,
    }).recoverGeneration({ attemptId: prepared.attemptId, scope: harness.scope });
    expect(recovered).toMatchObject({
      status: "completed",
      callbackInvoked: false,
      turnId: expect.stringMatching(/^semantic-workflow-turn-/),
    });
    expect(harness.providerState.calls).toHaveLength(1);
    expect(harness.rendererState.calls).toHaveLength(rendererCalls);
    expect(harness.tokenEstimatorState.calls).toHaveLength(estimatorCalls);
  });

  it("wrong-scope recovery reads only its definition-local attempt namespace and no global facts", async () => {
    const base = createInMemoryStore();
    const trace: StoreMutationTrace = { writes: [], reads: [], lists: [] };
    const harness = await createGenerationHarness({
      store: recordingStore(failBeforeCreate(base, "semantic-workflow-dispatch"), trace),
    });
    const prepared = await prepare(harness.bundle, harness.prepareInput);
    await expect(harness.bundle.runGeneration({ plan: prepared.plan, authorization: null })).rejects.toThrow();
    if (trace.reads === undefined || trace.lists === undefined) throw new Error("recovery fixture omitted traces");
    trace.reads.length = 0;
    trace.lists.length = 0;
    const recovered = await createSemanticWorkflowBundle(harness.factoryInput).recoverGeneration({
      attemptId: prepared.attemptId,
      scope: [{ type: "project", id: "foreign-project" }],
    });
    expect(recovered).toMatchObject({
      status: "not_dispatched",
      persistence: "not_dispatched",
      callbackInvoked: false,
      turnId: null,
    });
    expect(trace.reads.length).toBeGreaterThan(0);
    expect(trace.reads.every((key) => key.namespace !== "learning")).toBe(true);
    expect(trace.lists).toEqual([]);
    expect(harness.providerState.calls).toEqual([]);
  });

  it("refuses a differently rendered plan after the exact execution key has a winning attempt", async () => {
    const harness = await createGenerationHarness();
    harness.rendererState.render = () => ({ variant: "winner" });
    const winner = await prepare(harness.bundle, harness.prepareInput);
    harness.rendererState.render = () => ({ variant: "loser" });
    const loser = await prepare(harness.bundle, harness.prepareInput);
    expect(loser.attemptId).toBe(winner.attemptId);
    expect(loser.preview.minimizedBytesDigest).not.toBe(winner.preview.minimizedBytesDigest);
    await expect(harness.bundle.runGeneration({ plan: winner.plan, authorization: null })).resolves.toMatchObject({
      status: "completed",
    });
    await expect(harness.bundle.runGeneration({ plan: loser.plan, authorization: null })).rejects.toMatchObject({
      code: "store.conflict",
    });
    expect(harness.providerState.calls).toHaveLength(1);
  });

  it("rechecks the winning attempt when another plan wins during public recovery", async () => {
    const base = createInMemoryStore();
    let targetAttemptId: string | undefined;
    let attemptReads = 0;
    let runningWinner = false;
    let winner: (() => Promise<void>) | undefined;
    const racingStore: LearningStore = {
      get: async (key) => {
        if (
          !runningWinner &&
          winner !== undefined &&
          key.kind === "semantic-workflow-attempt" &&
          key.id === targetAttemptId
        ) {
          attemptReads += 1;
          if (attemptReads === 2) {
            runningWinner = true;
            try {
              await winner();
            } finally {
              runningWinner = false;
            }
          }
        }
        return base.get(key);
      },
      create: (key, value, digest, operationId) => base.create(key, value, digest, operationId),
      compareAndSet: (key, revision, value, digest, operationId) =>
        base.compareAndSet(key, revision, value, digest, operationId),
      append: (stream, revision, entries, operationId) => base.append(stream, revision, entries, operationId),
      tombstone: (input) => base.tombstone(input),
      list: (query) => base.list(query),
    };
    const harness = await createGenerationHarness({ store: racingStore });
    harness.rendererState.render = () => ({ variant: "race-winner" });
    const planA = await prepare(harness.bundle, harness.prepareInput);
    harness.rendererState.render = () => ({ variant: "race-loser" });
    const planB = await prepare(harness.bundle, harness.prepareInput);
    targetAttemptId = planA.attemptId;
    winner = async () => {
      await harness.bundle.runGeneration({ plan: planA.plan, authorization: null });
    };
    await expect(harness.bundle.runGeneration({ plan: planB.plan, authorization: null })).rejects.toMatchObject({
      code: "store.conflict",
    });
    expect(attemptReads).toBeGreaterThanOrEqual(2);
    expect(harness.providerState.calls).toHaveLength(1);
  });
});
