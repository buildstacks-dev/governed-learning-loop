// Public L2 consumer journey: prepare exact bytes, authenticate any outbound
// disclosure, invoke one provider operation, and retain only inert generation.
import { describe, expect, it } from "vitest";
import type { SemanticWorkflowBundle } from "@cormidia/learning-loop/workflows";
import { createInMemoryStore } from "@cormidia/learning-loop/testing";
import {
  createGenerationHarness,
  positiveProviderResult,
  providerOperation,
  providerRequestBytes,
  recordingStore,
  workflowKeyedDigest,
} from "./semantic-workflow-generation-harness.js";

async function prepare(
  bundle: SemanticWorkflowBundle,
  input: Parameters<SemanticWorkflowBundle["prepareGeneration"]>[0],
) {
  const result = await bundle.prepareGeneration(input);
  if (result.status !== "prepared") throw new Error(`expected prepared workflow, got ${result.status}`);
  return result;
}

function nestedValue(levels: number): unknown {
  let value: unknown = null;
  for (let level = 0; level < levels; level += 1) value = { value };
  return value;
}

describe("public semantic generation prepare/run journey", () => {
  it("prepares exact canonical caller-owned bytes with zero workflow/provider/authority writes or calls", async () => {
    const base = createInMemoryStore();
    const trace = { writes: [] };
    const harness = await createGenerationHarness({ store: recordingStore(base, trace) });
    trace.writes.length = 0;
    const result = await prepare(harness.bundle, harness.prepareInput);
    expect(trace.writes).toEqual([]);
    expect(harness.providerState.calls).toEqual([]);
    expect(harness.authorityState.calls).toEqual([]);
    expect(result.preview).toMatchObject({
      mediaType: "application/json",
      encoding: "utf-8",
      byteLength: result.preview.bytes.byteLength,
      minimizedBytesDigest: workflowKeyedDigest(result.preview.bytes),
      keyPolicyDigest: harness.definition.disclosurePolicy.keyPolicyDigest,
      estimatedInputTokens: Math.ceil(result.preview.bytes.byteLength / 4),
    });
    expect(harness.tokenEstimatorState.calls).toEqual([result.preview.bytes]);
    const text = new TextDecoder().decode(result.preview.bytes);
    expect(JSON.stringify(JSON.parse(text))).toBe(text);
    expect(Object.isFrozen(result.plan)).toBe(true);
    expect(result.windowDigest).not.toBe("");
    expect(result.executionKeyDigest).not.toBe("");
  });

  it("captures one exact token estimate, refuses the next token before writes, and never re-estimates at run", async () => {
    const exact = await createGenerationHarness({ maximumInputTokens: 10_000 });
    let estimates = 0;
    exact.tokenEstimatorState.estimate = () => {
      estimates += 1;
      return estimates;
    };
    const prepared = await prepare(exact.bundle, exact.prepareInput);
    expect(prepared.preview.estimatedInputTokens).toBe(1);
    expect(estimates).toBe(1);
    await exact.bundle.runGeneration({ plan: prepared.plan, authorization: null });
    expect(estimates).toBe(1);

    for (const estimate of [2, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      const harness = await createGenerationHarness({ maximumInputTokens: 1 });
      harness.tokenEstimatorState.estimate = () => estimate;
      await expect(harness.bundle.prepareGeneration(harness.prepareInput)).rejects.toMatchObject({
        code: expect.stringMatching(/^semantic\.|^schema\./),
      });
      expect(harness.providerState.calls).toEqual([]);
      expect(harness.authorityState.calls).toEqual([]);
      expect(
        (await harness.store.list({ namespace: "learning", kind: "semantic-workflow-reservation", limit: 10 })).records,
      ).toEqual([]);
    }
  });

  it("accepts an exact 16 MiB canonical request and rejects the next byte with zero writes", async () => {
    const maximumBytes = 16 * 1_048_576;
    const base = createInMemoryStore();
    const trace = { writes: [] };
    const harness = await createGenerationHarness({
      store: recordingStore(base, trace),
      maximumRequestBytes: maximumBytes,
      maximumInputTokens: maximumBytes,
    });
    trace.writes.length = 0;
    harness.rendererState.render = () => ({ padding: "" });
    const baseline = await prepare(harness.bundle, harness.prepareInput);
    const paddingBytes = maximumBytes - baseline.preview.byteLength;
    expect(paddingBytes).toBeGreaterThan(0);
    harness.rendererState.render = () => ({ padding: "x".repeat(paddingBytes) });
    const exact = await prepare(harness.bundle, harness.prepareInput);
    expect(exact.preview.byteLength).toBe(maximumBytes);
    harness.rendererState.render = () => ({ padding: "x".repeat(paddingBytes + 1) });
    await expect(harness.bundle.prepareGeneration(harness.prepareInput)).rejects.toMatchObject({
      code: "semantic.workflow_limit",
    });
    expect(trace.writes).toEqual([]);
    expect(harness.providerState.calls).toEqual([]);
    expect(harness.authorityState.calls).toEqual([]);
  }, 120_000);

  it("accepts exactly 500 episodes and 5,000 evidence references and refuses each next entry", async () => {
    const exactEpisodes = await createGenerationHarness({
      episodeCount: 500,
      maximumRequestBytes: 16 * 1_048_576,
      maximumInputTokens: 16 * 1_048_576,
    });
    exactEpisodes.rendererState.render = () => ({ minimized: true });
    await expect(exactEpisodes.bundle.prepareGeneration(exactEpisodes.prepareInput)).resolves.toMatchObject({
      status: "prepared",
    });

    const exactEvidence = await createGenerationHarness({
      observationsPerEpisode: 5_000,
      maximumRequestBytes: 16 * 1_048_576,
      maximumInputTokens: 16 * 1_048_576,
    });
    exactEvidence.rendererState.render = () => ({ minimized: true });
    await expect(exactEvidence.bundle.prepareGeneration(exactEvidence.prepareInput)).resolves.toMatchObject({
      status: "prepared",
    });

    const excessiveEvidence = await createGenerationHarness({
      observationsPerEpisode: 5_001,
      maximumRequestBytes: 16 * 1_048_576,
      maximumInputTokens: 16 * 1_048_576,
    });
    excessiveEvidence.rendererState.render = () => ({ minimized: true });
    await expect(excessiveEvidence.bundle.prepareGeneration(excessiveEvidence.prepareInput)).rejects.toMatchObject({
      code: "detector.limit_exceeded",
    });
    expect(exactEpisodes.providerState.calls).toEqual([]);
    expect(exactEvidence.providerState.calls).toEqual([]);
    expect(excessiveEvidence.providerState.calls).toEqual([]);
  }, 120_000);

  it("returns no-plan for empty or foreign evidence and rejects malformed populations before calls", async () => {
    const harness = await createGenerationHarness();
    const episode = harness.episodeRecordIds[0];
    if (episode === undefined) throw new Error("prepare fixture requires an episode");
    for (const value of [
      { ...harness.prepareInput, episodeRecordIds: [] },
      { ...harness.prepareInput, scope: [{ type: "project", id: "foreign-project" }] },
    ]) {
      await expect(harness.bundle.prepareGeneration(value)).resolves.toMatchObject({
        status: expect.stringMatching(/^not_applicable$|^incomplete$/),
        preview: null,
      });
      expect(harness.providerState.calls).toEqual([]);
      expect(harness.authorityState.calls).toEqual([]);
    }
    const malformed: Array<Parameters<SemanticWorkflowBundle["prepareGeneration"]>[0]> = [
      { ...harness.prepareInput, episodeRecordIds: [episode, episode] },
      { ...harness.prepareInput, episodeRecordIds: ["z/episode", "a/episode"] },
      {
        ...harness.prepareInput,
        episodeRecordIds: Array.from({ length: 501 }, (_, index) => `source/episode-${String(index).padStart(3, "0")}`),
      },
      {
        ...harness.prepareInput,
        detector: { ...harness.prepareInput.detector, registrationDigest: "0".repeat(64) },
      },
    ];
    for (const value of malformed) {
      await expect(harness.bundle.prepareGeneration(value)).rejects.toMatchObject({
        code: expect.stringMatching(/^schema\.|^detector\.|^semantic\./),
      });
      expect(harness.providerState.calls).toEqual([]);
      expect(harness.authorityState.calls).toEqual([]);
    }
  });

  it("accepts an exact 24-hour plan expiry and rejects the adjacent millisecond", async () => {
    const harness = await createGenerationHarness();
    await expect(
      harness.bundle.prepareGeneration({
        ...harness.prepareInput,
        expiresAt: "2026-08-21T00:02:00.000Z",
      }),
    ).resolves.toMatchObject({ status: "prepared" });
    await expect(
      harness.bundle.prepareGeneration({
        ...harness.prepareInput,
        expiresAt: "2026-08-21T00:02:00.001Z",
      }),
    ).rejects.toMatchObject({ code: "schema.invalid" });
    await expect(
      harness.bundle.prepareGeneration({
        ...harness.prepareInput,
        expiresAt: "2026-08-20T00:02:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "schema.invalid" });
    expect(harness.providerState.calls).toEqual([]);
    expect(harness.authorityState.calls).toEqual([]);
  });

  it("keeps the prepared plan nonforgeable and caller preview mutation cannot redirect provider bytes", async () => {
    const harness = await createGenerationHarness();
    const prepared = await prepare(harness.bundle, harness.prepareInput);
    const exactBytes = new Uint8Array(prepared.preview.bytes);
    prepared.preview.bytes.fill(0x78);
    const forgedPlan = Object.freeze({ ...prepared.plan });
    await expect(harness.bundle.runGeneration({ plan: forgedPlan, authorization: null })).rejects.toMatchObject({
      code: expect.stringMatching(/^semantic\.|^schema\./),
    });
    expect(harness.providerState.calls).toEqual([]);

    const result = await harness.bundle.runGeneration({ plan: prepared.plan, authorization: null });
    expect(result).toMatchObject({ status: "completed", persistence: "committed", callbackInvoked: true });
    expect(harness.providerState.calls).toHaveLength(1);
    expect(providerRequestBytes(harness.providerState.calls[0])).toEqual(exactBytes);
    expect(harness.providerState.calls[0]).toMatchObject({
      operation: {
        id: expect.stringMatching(/^semantic-workflow-provider-operation-/),
        idempotencyKey: expect.stringMatching(/^semantic-workflow-idempotency-/),
      },
      request: {
        mediaType: "application/json",
        encoding: "utf-8",
        byteLength: exactBytes.byteLength,
        estimatedInputTokens: prepared.preview.estimatedInputTokens,
        minimizedBytesDigest: prepared.preview.minimizedBytesDigest,
        keyPolicyDigest: prepared.preview.keyPolicyDigest,
      },
      model: harness.definition.providerModel.model,
      toolPolicy: harness.definition.toolPolicy,
      budgetPolicy: {
        maximumInputTokens: harness.definition.budgetPolicy.maximumInputTokens,
        maximumOutputTokens: harness.definition.budgetPolicy.maximumOutputTokens,
        maximumDurationMs: harness.definition.budgetPolicy.maximumDurationMs,
        maximumCost: harness.definition.budgetPolicy.maximumCost,
      },
      signal: expect.any(AbortSignal),
    });
    const operation = providerOperation(harness.providerState.calls[0]);
    expect(operation.id.slice("semantic-workflow-provider-operation-".length)).toBe(
      operation.idempotencyKey.slice("semantic-workflow-idempotency-".length),
    );
  });

  it("discloses exact preview bytes to the provider but persists only their approved digest and length", async () => {
    const canary = "PRIVATE-MINIMIZED-REQUEST-CANARY";
    const harness = await createGenerationHarness();
    harness.rendererState.render = () => ({ canary });
    const prepared = await prepare(harness.bundle, harness.prepareInput);
    expect(new TextDecoder().decode(prepared.preview.bytes)).toContain(canary);
    const result = await harness.bundle.runGeneration({ plan: prepared.plan, authorization: null });
    expect(result.status).toBe("completed");
    expect(new TextDecoder().decode(providerRequestBytes(harness.providerState.calls[0]))).toContain(canary);
    expect(JSON.stringify(await harness.store.list({ namespace: "learning", limit: 1_000 }))).not.toContain(canary);
    if (result.turnId === null) throw new Error("preview privacy fixture omitted its turn");
    const view = await harness.bundle.getTurn({ turnId: result.turnId, scope: harness.scope });
    expect(JSON.stringify(view)).not.toContain(canary);
    expect(view?.request).toMatchObject({
      byteLength: prepared.preview.byteLength,
      estimatedInputTokens: prepared.preview.estimatedInputTokens,
      minimizedBytesDigest: prepared.preview.minimizedBytesDigest,
      keyPolicyDigest: prepared.preview.keyPolicyDigest,
    });
  });

  it("runs one local positive generation into attributed inert derivation lineage and no Candidate/Review/effect", async () => {
    const harness = await createGenerationHarness({ transport: "local" });
    const prepared = await prepare(harness.bundle, harness.prepareInput);
    const result = await harness.bundle.runGeneration({ plan: prepared.plan, authorization: null });
    expect(result.status).toBe("completed");
    expect(result.callbackInvoked).toBe(true);
    expect(result.turnId).not.toBeNull();
    expect(result.execution).toMatchObject({ result: { status: "applied", conditionDetected: true } });
    expect(result.derivations).toHaveLength(1);
    expect(result.derivations[0]?.producer).toMatchObject({
      kind: "semantic_judgment",
      principal: harness.producer.ref,
      attestation: { id: harness.producer.attestationId, digest: harness.producer.attestationDigest },
      modelFingerprintDigest: harness.definition.providerModel.model.modelFingerprintDigest,
      promptDigest: harness.definition.prompt.promptDigest,
      toolPolicyDigest: harness.definition.toolPolicy.policyDigest,
      budgetPolicyDigest: harness.definition.budgetPolicy.policyDigest,
      disclosure: null,
    });
    await expect(harness.learning.report({ scope: harness.scope })).resolves.toMatchObject({
      candidateIds: [],
      interventionIds: [],
      evaluationIds: [],
    });
    for (const kind of [
      "candidate",
      "review",
      "candidate-review",
      "candidate-admission-snapshot",
      "candidate-admission-reservation",
      "candidate-admission-binding",
      "candidate-recurrence-admission",
    ]) {
      expect((await harness.store.list({ namespace: "learning", kind, limit: 10 })).records).toEqual([]);
    }
  });

  it("requires exact outbound authorization, calls authority before provider, and rejects cloned authorization", async () => {
    const harness = await createGenerationHarness({ transport: "outbound" });
    const prepared = await prepare(harness.bundle, harness.prepareInput);
    await expect(harness.bundle.runGeneration({ plan: prepared.plan, authorization: null })).rejects.toMatchObject({
      code: expect.stringMatching(/^semantic\.|^schema\./),
    });
    expect(harness.providerState.calls).toEqual([]);
    const authorized = await harness.bundle.authorizeGeneration({
      plan: prepared.plan,
      evidence: { humanApproval: true, canary: "TRANSIENT-AUTHORITY-CANARY" },
    });
    expect(harness.authorityState.calls).toHaveLength(1);
    expect(harness.authorityState.calls[0]).toMatchObject({
      preview: {
        mediaType: "application/json",
        encoding: "utf-8",
        bytes: prepared.preview.bytes,
        byteLength: prepared.preview.byteLength,
        minimizedBytesDigest: prepared.preview.minimizedBytesDigest,
        keyPolicyDigest: prepared.preview.keyPolicyDigest,
      },
      definitionDigest: harness.definition.definitionDigest,
      evidence: { humanApproval: true, canary: "TRANSIENT-AUTHORITY-CANARY" },
    });
    expect(harness.providerState.calls).toEqual([]);
    const clonedAuthorization = Object.freeze({ ...authorized.authorization });
    await expect(
      harness.bundle.runGeneration({ plan: prepared.plan, authorization: clonedAuthorization }),
    ).rejects.toMatchObject({ code: expect.stringMatching(/^semantic\.|^schema\.|^identity\./) });
    expect(harness.providerState.calls).toEqual([]);
    harness.providerState.script = async (input) => {
      expect(harness.authorityState.calls).toHaveLength(1);
      expect(
        (await harness.store.list({ namespace: "learning", kind: "semantic-workflow-authorization", limit: 10 }))
          .records,
      ).toHaveLength(1);
      expect(
        (await harness.store.list({ namespace: "learning", kind: "semantic-workflow-dispatch", limit: 10 })).records,
      ).toHaveLength(1);
      return positiveProviderResult(input);
    };
    const result = await harness.bundle.runGeneration({
      plan: prepared.plan,
      authorization: authorized.authorization,
    });
    expect(result).toMatchObject({ status: "completed", callbackInvoked: true });
    expect(harness.providerState.calls).toHaveLength(1);
    const durable = await harness.store.list({ namespace: "learning", limit: 1_000 });
    expect(JSON.stringify(durable.records)).not.toContain("TRANSIENT-AUTHORITY-CANARY");
    if (result.turnId === null) throw new Error("authorized generation omitted its terminal turn");
    await expect(harness.bundle.getTurn({ turnId: result.turnId, scope: harness.scope })).resolves.toMatchObject({
      authorization: {
        status: "authorized",
        authorizedAt: authorized.authorizedAt,
        expiresAt: authorized.expiresAt,
      },
      disclosure: { status: "result_attested" },
    });
  });

  it("refuses malformed, over-age, and exceptional authorization results before dispatch", async () => {
    const malformedResults: readonly unknown[] = [
      {},
      {
        principal: null,
        authorizedAt: "2026-08-20T00:01:30.000Z",
        expiresAt: "2026-08-20T00:02:30.000Z",
      },
    ];
    for (const raw of malformedResults) {
      const harness = await createGenerationHarness({ transport: "outbound" });
      const prepared = await prepare(harness.bundle, harness.prepareInput);
      harness.authorityState.script = () => Promise.resolve(raw);
      await expect(
        harness.bundle.authorizeGeneration({ plan: prepared.plan, evidence: { approved: true } }),
      ).rejects.toMatchObject({ code: expect.stringMatching(/^identity\.|^schema\.|^semantic\./) });
      expect(harness.providerState.calls).toEqual([]);
      expect(
        (await harness.store.list({ namespace: "learning", kind: "semantic-workflow-authorization", limit: 10 }))
          .records,
      ).toEqual([]);
    }

    const overAge = await createGenerationHarness({ transport: "outbound" });
    const overAgePlan = await prepare(overAge.bundle, overAge.prepareInput);
    overAge.authorityState.script = () =>
      Promise.resolve({
        principal: overAge.authorizer,
        authorizedAt: "2026-08-20T00:00:00.000Z",
        expiresAt: "2026-08-20T00:01:00.001Z",
      });
    await expect(
      overAge.bundle.authorizeGeneration({ plan: overAgePlan.plan, evidence: { approved: true } }),
    ).rejects.toMatchObject({ code: expect.stringMatching(/^schema\.|^semantic\./) });
    expect(overAge.providerState.calls).toEqual([]);

    const canary = "PRIVATE-AUTHORITY-ERROR-CANARY";
    const exceptional = await createGenerationHarness({ transport: "outbound" });
    const exceptionalPlan = await prepare(exceptional.bundle, exceptional.prepareInput);
    exceptional.authorityState.script = () => Promise.reject(new Error(canary));
    let rejected: unknown;
    try {
      await exceptional.bundle.authorizeGeneration({
        plan: exceptionalPlan.plan,
        evidence: { approved: true },
      });
    } catch (error) {
      rejected = error;
    }
    expect(rejected).toMatchObject({ code: "semantic.workflow_callback_failed" });
    expect(String(rejected)).not.toContain(canary);
    expect(exceptional.providerState.calls).toEqual([]);
  });

  it("exact completed retry and prepare converge on existing execution without another provider call", async () => {
    const harness = await createGenerationHarness();
    const prepared = await prepare(harness.bundle, harness.prepareInput);
    const first = await harness.bundle.runGeneration({ plan: prepared.plan, authorization: null });
    expect(first.status).toBe("completed");
    expect(harness.providerState.calls).toHaveLength(1);
    const retried = await harness.bundle.runGeneration({ plan: prepared.plan, authorization: null });
    expect(retried).toMatchObject({
      status: "completed",
      persistence: "existing",
      callbackInvoked: false,
    });
    expect(harness.providerState.calls).toHaveLength(1);
    const rendererCalls = harness.rendererState.calls.length;
    const estimatorCalls = harness.tokenEstimatorState.calls.length;
    const preparedAgain = await harness.bundle.prepareGeneration(harness.prepareInput);
    expect(preparedAgain.status).toBe("execution_existing");
    expect(harness.providerState.calls).toHaveLength(1);
    expect(harness.rendererState.calls).toHaveLength(rendererCalls);
    expect(harness.tokenEstimatorState.calls).toHaveLength(estimatorCalls);
  });

  it("local authorization is unavailable and input accessors cannot change prepared semantics", async () => {
    const harness = await createGenerationHarness({ transport: "local" });
    const prepared = await prepare(harness.bundle, harness.prepareInput);
    await expect(
      harness.bundle.authorizeGeneration({ plan: prepared.plan, evidence: { shouldNotMatter: true } }),
    ).rejects.toMatchObject({ code: expect.stringMatching(/^semantic\.|^schema\./) });
    expect(harness.authorityState.calls).toEqual([]);

    let reads = 0;
    const input = { ...harness.prepareInput };
    Object.defineProperty(input, "episodeRecordIds", {
      enumerable: true,
      get: () => {
        reads += 1;
        return reads === 1 ? harness.episodeRecordIds : [];
      },
    });
    await expect(harness.bundle.prepareGeneration(input)).rejects.toMatchObject({
      code: expect.stringMatching(/^schema\.|^semantic\./),
    });
    expect(reads).toBeLessThanOrEqual(1);
    expect(harness.providerState.calls).toEqual([]);
  });

  it("rejects synchronous callback thenables and sanitizes callback exceptions before any durable effect", async () => {
    const thenableRenderer = await createGenerationHarness();
    thenableRenderer.rendererState.render = () => Promise.resolve({ forbiddenThenable: true });
    await expect(thenableRenderer.bundle.prepareGeneration(thenableRenderer.prepareInput)).rejects.toMatchObject({
      code: expect.stringMatching(/^schema\.|^semantic\./),
    });
    expect(thenableRenderer.providerState.calls).toEqual([]);

    const thenableEstimator = await createGenerationHarness();
    thenableEstimator.tokenEstimatorState.estimate = () => Promise.resolve(1);
    await expect(thenableEstimator.bundle.prepareGeneration(thenableEstimator.prepareInput)).rejects.toMatchObject({
      code: expect.stringMatching(/^schema\.|^semantic\./),
    });
    expect(thenableEstimator.providerState.calls).toEqual([]);

    const canary = "PRIVATE-PREPARE-CALLBACK-ERROR-CANARY";
    const exceptional = await createGenerationHarness();
    exceptional.rendererState.render = () => {
      throw new Error(canary);
    };
    let rejected: unknown;
    try {
      await exceptional.bundle.prepareGeneration(exceptional.prepareInput);
    } catch (error) {
      rejected = error;
    }
    expect(rejected).toMatchObject({ code: expect.stringMatching(/^schema\.|^semantic\./) });
    expect(String(rejected)).not.toContain(canary);
    expect(exceptional.providerState.calls).toEqual([]);
    expect(JSON.stringify(await exceptional.store.list({ namespace: "learning", limit: 1_000 }))).not.toContain(canary);
  });

  it("accepts renderer structures at depth 100 and 100,000 nodes and rejects each next unit before writes", async () => {
    const exactDepth = await createGenerationHarness({ maximumRequestBytes: 16 * 1_048_576 });
    exactDepth.rendererState.render = () => nestedValue(100);
    await expect(exactDepth.bundle.prepareGeneration(exactDepth.prepareInput)).resolves.toMatchObject({
      status: "prepared",
    });
    const excessiveDepth = await createGenerationHarness({ maximumRequestBytes: 16 * 1_048_576 });
    excessiveDepth.rendererState.render = () => nestedValue(101);
    await expect(excessiveDepth.bundle.prepareGeneration(excessiveDepth.prepareInput)).rejects.toMatchObject({
      code: "semantic.workflow_limit",
    });

    const exactNodes = await createGenerationHarness({
      maximumRequestBytes: 16 * 1_048_576,
      maximumInputTokens: 16 * 1_048_576,
    });
    exactNodes.rendererState.render = () => Array.from({ length: 99_999 }, () => null);
    await expect(exactNodes.bundle.prepareGeneration(exactNodes.prepareInput)).resolves.toMatchObject({
      status: "prepared",
    });
    const excessiveNodes = await createGenerationHarness({
      maximumRequestBytes: 16 * 1_048_576,
      maximumInputTokens: 16 * 1_048_576,
    });
    excessiveNodes.rendererState.render = () => Array.from({ length: 100_000 }, () => null);
    await expect(excessiveNodes.bundle.prepareGeneration(excessiveNodes.prepareInput)).rejects.toMatchObject({
      code: "semantic.workflow_limit",
    });
    expect(exactDepth.providerState.calls).toEqual([]);
    expect(excessiveDepth.providerState.calls).toEqual([]);
    expect(exactNodes.providerState.calls).toEqual([]);
    expect(excessiveNodes.providerState.calls).toEqual([]);
  });
});
