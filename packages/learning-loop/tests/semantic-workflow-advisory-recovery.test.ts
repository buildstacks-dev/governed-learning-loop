// #13c advisory crash edges: every durable write boundary, lost
// acknowledgements, fake success, same-key concurrency and interleaving,
// process reconstruction, attempt-index-first recovery, and wrong-scope /
// wrong-definition no-oracle reads. Dispatch-only ambiguity never retries.
import { describe, expect, it } from "vitest";
import { createFixedClock, createInMemoryStore } from "../src/testing/index.js";
import { createSemanticWorkflowBundle } from "@cormidia/learning-loop/workflows";
import {
  failBeforeCreate,
  fakeCreateSuccess,
  loseCreateAcknowledgement,
  WORKFLOW_SCOPE,
} from "./semantic-workflow-generation-harness.js";
import type { AdvisoryHarness } from "./semantic-workflow-advisory-harness.js";
import {
  advisoryDefinitionFor,
  createAdvisoryHarness,
  positiveAdvisoryResult,
  proposeSubjectCandidate,
  refusedAdvisoryResult,
} from "./semantic-workflow-advisory-harness.js";

function preparedOrThrow<T extends { readonly status: string }>(outcome: T): Extract<T, { status: "prepared" }> {
  if (outcome.status !== "prepared") {
    throw new Error(`advisory prepare returned ${outcome.status}: ${JSON.stringify(outcome)}`);
  }
  return outcome as Extract<T, { status: "prepared" }>;
}

/** A second in-process bundle over the same store, standing in for a restarted host. */
function reconstructedBundle(harness: AdvisoryHarness) {
  return createSemanticWorkflowBundle(harness.advisoryFactoryInput);
}

async function runToCrash(harness: AdvisoryHarness): Promise<{ readonly attemptId: string; readonly error: unknown }> {
  const prepared = preparedOrThrow(await harness.advisoryBundle.prepareAdvisoryReview(harness.advisoryPrepareInput));
  try {
    await harness.advisoryBundle.runAdvisoryReview({ plan: prepared.plan, authorization: null });
    throw new Error("advisory run did not crash at the injected boundary");
  } catch (error) {
    return { attemptId: prepared.attemptId, error };
  }
}

describe("advisory review crash recovery", () => {
  it("returns not_dispatched for every pre-dispatch crash and converges on retry", async () => {
    for (const targetKind of [
      "semantic-workflow-reservation",
      "semantic-workflow-advisory-plan",
      "semantic-workflow-advisory-attempt",
      "semantic-workflow-dispatch",
    ]) {
      const base = createInMemoryStore();
      const harness = await createAdvisoryHarness({ store: failBeforeCreate(base, targetKind) });
      const crashed = await runToCrash(harness);
      expect(harness.advisoryProviderState.calls.length).toBe(0);
      const recovered = await reconstructedBundle(harness).recoverAdvisoryReview({
        attemptId: crashed.attemptId,
        scope: WORKFLOW_SCOPE,
      });
      expect({ kind: targetKind, ...recovered }).toEqual({
        kind: targetKind,
        status: "not_dispatched",
        persistence: "not_dispatched",
        callbackInvoked: false,
        turnId: null,
      });
      const retryPrepared = preparedOrThrow(
        await harness.advisoryBundle.prepareAdvisoryReview(harness.advisoryPrepareInput),
      );
      const retried = await harness.advisoryBundle.runAdvisoryReview({ plan: retryPrepared.plan, authorization: null });
      expect(retried.status).toBe("completed");
      expect(retried.persistence).toBe("committed");
      expect(harness.advisoryProviderState.calls.length).toBe(1);
    }
  });

  it("keeps a crash before the completion intent permanently outcome_unknown with no automatic second call", async () => {
    const base = createInMemoryStore();
    const harness = await createAdvisoryHarness({
      store: failBeforeCreate(base, "semantic-workflow-advisory-completion"),
    });
    const crashed = await runToCrash(harness);
    expect(harness.advisoryProviderState.calls.length).toBe(1);
    const rebuilt = reconstructedBundle(harness);
    const recovered = await rebuilt.recoverAdvisoryReview({ attemptId: crashed.attemptId, scope: WORKFLOW_SCOPE });
    expect(recovered).toMatchObject({ status: "outcome_unknown", persistence: "dispatch_only", turnId: null });
    const retryPrepared = preparedOrThrow(await rebuilt.prepareAdvisoryReview(harness.advisoryPrepareInput));
    const retried = await rebuilt.runAdvisoryReview({ plan: retryPrepared.plan, authorization: null });
    expect(retried).toMatchObject({
      status: "outcome_unknown",
      persistence: "dispatch_only",
      callbackInvoked: false,
    });
    expect(harness.advisoryProviderState.calls.length).toBe(1);
  });

  it("forward-completes known facts after a crash at each post-intent boundary without any callback", async () => {
    for (const targetKind of [
      "semantic-workflow-result",
      "semantic-workflow-advisory-assessment",
      "semantic-workflow-turn-index",
      "semantic-workflow-turn",
    ]) {
      const base = createInMemoryStore();
      const harness = await createAdvisoryHarness({ store: failBeforeCreate(base, targetKind) });
      const crashed = await runToCrash(harness);
      expect(harness.advisoryProviderState.calls.length).toBe(1);
      const rebuilt = reconstructedBundle(harness);
      const recovered = await rebuilt.recoverAdvisoryReview({ attemptId: crashed.attemptId, scope: WORKFLOW_SCOPE });
      expect({ kind: targetKind, status: recovered.status, persistence: recovered.persistence }).toEqual({
        kind: targetKind,
        status: "completed",
        persistence: "committed",
      });
      expect(recovered.callbackInvoked).toBe(false);
      expect(recovered.assessment?.qualification).toBe("advisory_uncalibrated");
      expect(harness.advisoryProviderState.calls.length).toBe(1);
      if (recovered.turnId === null) throw new Error("recovered advisory turn id is missing");
      const turn = await rebuilt.getTurn({ turnId: recovered.turnId, scope: WORKFLOW_SCOPE });
      expect(turn?.status).toBe("completed");
    }
  });

  it("forward-completes a noncompleted result whose terminal receipt was lost", async () => {
    const base = createInMemoryStore();
    const harness = await createAdvisoryHarness({ store: failBeforeCreate(base, "semantic-workflow-turn") });
    harness.advisoryProviderState.script = (input) => Promise.resolve(refusedAdvisoryResult(input));
    const crashed = await runToCrash(harness);
    const rebuilt = reconstructedBundle(harness);
    const recovered = await rebuilt.recoverAdvisoryReview({ attemptId: crashed.attemptId, scope: WORKFLOW_SCOPE });
    expect(recovered).toMatchObject({ status: "provider_refused", persistence: "committed", callbackInvoked: false });
    expect(recovered.assessment).toBeUndefined();
  });

  it("converges a lost completion-intent acknowledgement by exact create-only retry", async () => {
    const base = createInMemoryStore();
    const harness = await createAdvisoryHarness({
      store: loseCreateAcknowledgement(base, "semantic-workflow-advisory-completion"),
    });
    const crashed = await runToCrash(harness);
    expect(harness.advisoryProviderState.calls.length).toBe(1);
    const recovered = await reconstructedBundle(harness).recoverAdvisoryReview({
      attemptId: crashed.attemptId,
      scope: WORKFLOW_SCOPE,
    });
    expect(recovered).toMatchObject({ status: "completed", persistence: "committed", callbackInvoked: false });
    expect(harness.advisoryProviderState.calls.length).toBe(1);
  });

  it("classifies a faked assessment write as store corruption instead of fake success", async () => {
    const base = createInMemoryStore();
    const harness = await createAdvisoryHarness({
      store: fakeCreateSuccess(base, "semantic-workflow-advisory-assessment"),
    });
    const prepared = preparedOrThrow(await harness.advisoryBundle.prepareAdvisoryReview(harness.advisoryPrepareInput));
    await expect(
      harness.advisoryBundle.runAdvisoryReview({ plan: prepared.plan, authorization: null }),
    ).rejects.toMatchObject({ code: "store.corrupt" });
  });

  it("recovers a committed terminal across process reconstruction without invoking any capability", async () => {
    const store = createInMemoryStore();
    const harness = await createAdvisoryHarness({ store });
    const prepared = preparedOrThrow(await harness.advisoryBundle.prepareAdvisoryReview(harness.advisoryPrepareInput));
    const committed = await harness.advisoryBundle.runAdvisoryReview({ plan: prepared.plan, authorization: null });
    expect(committed.persistence).toBe("committed");
    const callsBefore = harness.advisoryProviderState.calls.length;
    const rebuilt = reconstructedBundle(harness);
    const recovered = await rebuilt.recoverAdvisoryReview({ attemptId: prepared.attemptId, scope: WORKFLOW_SCOPE });
    expect(recovered).toMatchObject({ status: "completed", persistence: "existing", callbackInvoked: false });
    expect(recovered.turnId).toBe(committed.turnId);
    expect(recovered.assessment?.assessmentDigest).toBe(committed.assessment?.assessmentDigest);
    expect(harness.advisoryProviderState.calls.length).toBe(callsBefore);
  });

  it("answers wrong-scope and wrong-definition recovery as not_dispatched without a foreign oracle", async () => {
    const harness = await createAdvisoryHarness();
    const prepared = preparedOrThrow(await harness.advisoryBundle.prepareAdvisoryReview(harness.advisoryPrepareInput));
    await harness.advisoryBundle.runAdvisoryReview({ plan: prepared.plan, authorization: null });
    const wrongScope = await harness.advisoryBundle.recoverAdvisoryReview({
      attemptId: prepared.attemptId,
      scope: [{ type: "project", id: "another-project" }],
    });
    expect(wrongScope).toMatchObject({ status: "not_dispatched", persistence: "not_dispatched" });
    const otherReviewer = await harness.identity.verify({
      principalId: "advisory-second-reviewer",
      kind: "service",
      independenceDomain: "advisory-second-domain",
    });
    const otherDefinition = advisoryDefinitionFor({
      transport: "local",
      reviewer: otherReviewer,
      budgets: {
        maximumRequestBytes: 1_048_576,
        maximumResponseBytes: 1_048_576,
        maximumInputTokens: 10_000,
        maximumOutputTokens: 2_000,
        maximumDurationMs: 1_000,
      },
    });
    const otherBundle = createSemanticWorkflowBundle({
      ...harness.advisoryFactoryInput,
      definition: otherDefinition,
      reviewer: otherReviewer,
      renderer: {
        rendererDigest: otherDefinition.renderer.rendererDigest,
        render: harness.advisoryFactoryInput.renderer.render,
      },
      tokenEstimator: {
        tokenEstimatorDigest: otherDefinition.budgetPolicy.tokenEstimatorDigest,
        estimateInputTokens: harness.advisoryFactoryInput.tokenEstimator.estimateInputTokens,
      },
      provider: {
        registrationDigest: otherDefinition.providerModel.provider.registrationDigest,
        invoke: harness.advisoryFactoryInput.provider.invoke,
      },
    });
    const wrongDefinition = await otherBundle.recoverAdvisoryReview({
      attemptId: prepared.attemptId,
      scope: WORKFLOW_SCOPE,
    });
    expect(wrongDefinition).toMatchObject({ status: "not_dispatched", persistence: "not_dispatched" });
  });
});

describe("advisory review same-key ownership and interleaving", () => {
  it("invokes the provider exactly once for concurrently run identical plans", async () => {
    const harness = await createAdvisoryHarness();
    const first = preparedOrThrow(await harness.advisoryBundle.prepareAdvisoryReview(harness.advisoryPrepareInput));
    const second = preparedOrThrow(await harness.advisoryBundle.prepareAdvisoryReview(harness.advisoryPrepareInput));
    const [left, right] = await Promise.all([
      harness.advisoryBundle.runAdvisoryReview({ plan: first.plan, authorization: null }),
      harness.advisoryBundle.runAdvisoryReview({ plan: second.plan, authorization: null }),
    ]);
    expect(harness.advisoryProviderState.calls.length).toBe(1);
    expect([left.callbackInvoked, right.callbackInvoked].filter(Boolean).length).toBe(1);
    for (const outcome of [left, right]) {
      expect(["completed", "outcome_unknown"]).toContain(outcome.status);
    }
    expect([left.status, right.status]).toContain("completed");
  });

  it("refuses a different render for one already-owned advisory review key before a second callback", async () => {
    const harness = await createAdvisoryHarness();
    const prepared = preparedOrThrow(await harness.advisoryBundle.prepareAdvisoryReview(harness.advisoryPrepareInput));
    const committed = await harness.advisoryBundle.runAdvisoryReview({ plan: prepared.plan, authorization: null });
    expect(committed.status).toBe("completed");
    const divergentBundle = createSemanticWorkflowBundle({
      ...harness.advisoryFactoryInput,
      renderer: {
        rendererDigest: harness.advisoryDefinition.renderer.rendererDigest,
        render: (input: unknown) => ({
          schemaVersion: 1,
          divergence: "different-host-instructions",
          original: harness.advisoryFactoryInput.renderer.render(input),
        }),
      },
    });
    const divergentPrepared = preparedOrThrow(
      await divergentBundle.prepareAdvisoryReview(harness.advisoryPrepareInput),
    );
    expect(divergentPrepared.preview.minimizedBytesDigest).not.toBe(prepared.preview.minimizedBytesDigest);
    await expect(
      divergentBundle.runAdvisoryReview({ plan: divergentPrepared.plan, authorization: null }),
    ).rejects.toMatchObject({ code: "store.conflict" });
    expect(harness.advisoryProviderState.calls.length).toBe(1);
  });

  it("pages definition-local advisory turns with an isolated bound cursor", async () => {
    const store = createInMemoryStore();
    const harness = await createAdvisoryHarness({ store });
    const secondCandidate = await proposeSubjectCandidate(harness, harness.proposer, {
      id: "advisory-subject-candidate-2",
      problem: "A second recurring observation lacks a standing note.",
    });
    expect(secondCandidate.id).toBe("advisory-subject-candidate-2");
    for (const candidateId of [harness.candidate.id, secondCandidate.id]) {
      const prepared = preparedOrThrow(
        await harness.advisoryBundle.prepareAdvisoryReview({
          candidateId,
          scope: WORKFLOW_SCOPE,
          expiresAt: harness.advisoryPrepareInput.expiresAt,
        }),
      );
      const run = await harness.advisoryBundle.runAdvisoryReview({ plan: prepared.plan, authorization: null });
      expect(run.status).toBe("completed");
    }
    const seen: string[] = [];
    let cursor: string | undefined;
    let pageCount = 0;
    for (;;) {
      let nextCursor: string | undefined;
      for await (const page of harness.advisoryBundle.queryTurns({
        scope: WORKFLOW_SCOPE,
        limit: 1,
        ...(cursor === undefined ? {} : { cursor }),
      })) {
        pageCount += 1;
        seen.push(...page.items.map((item) => item.id));
        nextCursor = page.nextCursor;
        break;
      }
      if (nextCursor === undefined) break;
      cursor = nextCursor;
    }
    expect(pageCount).toBeGreaterThanOrEqual(2);
    expect(new Set(seen).size).toBe(2);
    if (cursor === undefined) throw new Error("advisory paging never yielded a bound cursor");
    // A cursor minted for the advisory definition is rejected by the
    // generation bundle sharing the same loop and scope.
    const boundCursor = cursor;
    expect(() => harness.bundle.queryTurns({ scope: WORKFLOW_SCOPE, limit: 1, cursor: boundCursor })).toThrowError(
      expect.objectContaining({ code: "query.cursor_invalid" }),
    );
  });

  it("keeps run idempotent across an interleaved committed terminal from another in-process bundle", async () => {
    const harness = await createAdvisoryHarness();
    const prepared = preparedOrThrow(await harness.advisoryBundle.prepareAdvisoryReview(harness.advisoryPrepareInput));
    const rebuilt = reconstructedBundle(harness);
    const rebuiltPrepared = preparedOrThrow(await rebuilt.prepareAdvisoryReview(harness.advisoryPrepareInput));
    const committed = await rebuilt.runAdvisoryReview({ plan: rebuiltPrepared.plan, authorization: null });
    expect(committed.persistence).toBe("committed");
    const replay = await harness.advisoryBundle.runAdvisoryReview({ plan: prepared.plan, authorization: null });
    expect(replay).toMatchObject({ status: "completed", persistence: "existing", callbackInvoked: false });
    expect(replay.turnId).toBe(committed.turnId);
    expect(harness.advisoryProviderState.calls.length).toBe(1);
  });
});

describe("advisory review expiry and callback boundaries", () => {
  it("refuses an expired plan at authorize and run time with zero provider calls", async () => {
    const outboundClock = createFixedClock("2026-08-20T00:02:00.000Z");
    const outbound = await createAdvisoryHarness({ transport: "outbound", clock: outboundClock });
    const outboundPrepared = preparedOrThrow(
      await outbound.advisoryBundle.prepareAdvisoryReview(outbound.advisoryPrepareInput),
    );
    outboundClock.tick(10 * 60_000);
    await expect(
      outbound.advisoryBundle.authorizeAdvisoryReview({ plan: outboundPrepared.plan, evidence: null }),
    ).rejects.toMatchObject({ code: "semantic.workflow_expired" });
    expect(outbound.advisoryProviderState.calls.length).toBe(0);

    const localClock = createFixedClock("2026-08-20T00:02:00.000Z");
    const local = await createAdvisoryHarness({ clock: localClock });
    const localPrepared = preparedOrThrow(await local.advisoryBundle.prepareAdvisoryReview(local.advisoryPrepareInput));
    localClock.tick(10 * 60_000);
    await expect(
      local.advisoryBundle.runAdvisoryReview({ plan: localPrepared.plan, authorization: null }),
    ).rejects.toMatchObject({ code: "semantic.workflow_expired" });
    expect(local.advisoryProviderState.calls.length).toBe(0);
  });

  it("classifies a throwing keyed digester over finding statements as result_invalid, not a crash", async () => {
    const harness = await createAdvisoryHarness();
    let digests = 0;
    const digesterBase = harness.advisoryFactoryInput.keyedDigester.digest;
    const failingBundle = createSemanticWorkflowBundle({
      ...harness.advisoryFactoryInput,
      keyedDigester: {
        keyPolicyDigest: harness.advisoryFactoryInput.keyedDigester.keyPolicyDigest,
        digest: (bytes: Uint8Array) => {
          digests += 1;
          // Request and response digests succeed; the statement digest throws.
          if (digests >= 3) throw new Error("KEYED-DIGESTER-CANARY");
          return digesterBase(bytes);
        },
      },
    });
    const prepared = preparedOrThrow(await failingBundle.prepareAdvisoryReview(harness.advisoryPrepareInput));
    const run = await failingBundle.runAdvisoryReview({ plan: prepared.plan, authorization: null });
    expect(run).toMatchObject({ status: "result_invalid", persistence: "committed", callbackInvoked: true });
  });
});

describe("advisory review provider-call fixtures", () => {
  it("passes the deny-all tool policy, exact budgets, and idempotent operation identity to the callback", async () => {
    const harness = await createAdvisoryHarness();
    harness.advisoryProviderState.script = (input) => Promise.resolve(positiveAdvisoryResult(input));
    const prepared = preparedOrThrow(await harness.advisoryBundle.prepareAdvisoryReview(harness.advisoryPrepareInput));
    const run = await harness.advisoryBundle.runAdvisoryReview({ plan: prepared.plan, authorization: null });
    expect(run.status).toBe("completed");
    const call = harness.advisoryProviderState.calls[0];
    expect(call).toMatchObject({
      model: harness.advisoryDefinition.providerModel.model,
      toolPolicy: { mode: "none" },
      budgetPolicy: {
        maximumInputTokens: harness.advisoryDefinition.budgetPolicy.maximumInputTokens,
        maximumOutputTokens: harness.advisoryDefinition.budgetPolicy.maximumOutputTokens,
        maximumDurationMs: harness.advisoryDefinition.budgetPolicy.maximumDurationMs,
        maximumCost: harness.advisoryDefinition.budgetPolicy.maximumCost,
      },
      operation: {
        id: expect.stringMatching(/^semantic-workflow-provider-operation-[0-9a-f]{64}$/),
        idempotencyKey: expect.stringMatching(/^semantic-workflow-idempotency-[0-9a-f]{64}$/),
      },
    });
  });

  it("aborts and stays dispatch-only when the provider outlives its registered duration ceiling", async () => {
    const harness = await createAdvisoryHarness({ maximumDurationMs: 20 });
    let observedSignal: AbortSignal | undefined;
    harness.advisoryProviderState.script = (input) =>
      new Promise((resolve) => {
        const record = input as { readonly signal?: AbortSignal };
        observedSignal = record.signal;
        setTimeout(() => resolve(positiveAdvisoryResult(input)), 200);
      });
    const prepared = preparedOrThrow(await harness.advisoryBundle.prepareAdvisoryReview(harness.advisoryPrepareInput));
    const run = await harness.advisoryBundle.runAdvisoryReview({ plan: prepared.plan, authorization: null });
    expect(run).toMatchObject({ status: "outcome_unknown", persistence: "dispatch_only", callbackInvoked: true });
    expect(observedSignal?.aborted).toBe(true);
  });
});
