// Private compatibility controls for the generic #13a direct-get seam. Public
// consumers are covered separately through @cormidia/learning-loop/workflows.
import { describe, expect, it } from "vitest";
import { scopeDigest, sha256HexOfCanonicalJson, toJsonValue } from "@cormidia/learning-loop";
import { createInMemoryStore } from "@cormidia/learning-loop/testing";
import type { EngineContext } from "../src/engine/context.js";
import { contextForLearningLoop } from "../src/engine/loop.js";
import { buildSemanticTurnScopeIndex } from "../src/workflows/semantic-turn-outcome.js";
import { loadSemanticTurnByScope, turnScopeNamespace } from "../src/workflows/semantic-turn-persistence.js";
import { createGenerationHarness, refusedProviderResult } from "./semantic-workflow-generation-harness.js";

describe("semantic workflow generic direct-get compatibility", () => {
  it("loads a new definition-local noncompleted turn through the legacy generic scope index", async () => {
    const harness = await createGenerationHarness();
    harness.providerState.script = (input) => Promise.resolve(refusedProviderResult(input));
    const prepared = await harness.bundle.prepareGeneration(harness.prepareInput);
    if (prepared.status !== "prepared") throw new Error(`expected prepared workflow, got ${prepared.status}`);
    const result = await harness.bundle.runGeneration({ plan: prepared.plan, authorization: null });
    expect(result.status).toBe("provider_refused");
    if (result.turnId === null) throw new Error("generic direct-get fixture omitted its turn");
    await expect(
      loadSemanticTurnByScope(contextForLearningLoop(harness.learning), result.turnId, scopeDigest(harness.scope)),
    ).resolves.toMatchObject({
      reservation: { definition: { definitionDigest: harness.definition.definitionDigest } },
      result: { status: "provider_refused" },
      turn: { id: result.turnId },
    });
  });

  it("loads an exact legacy index and turn from the pre-definition namespace", async () => {
    const harness = await createGenerationHarness();
    harness.providerState.script = (input) => Promise.resolve(refusedProviderResult(input));
    const prepared = await harness.bundle.prepareGeneration(harness.prepareInput);
    if (prepared.status !== "prepared") throw new Error(`expected prepared workflow, got ${prepared.status}`);
    const result = await harness.bundle.runGeneration({ plan: prepared.plan, authorization: null });
    if (result.turnId === null) throw new Error("legacy direct-get fixture omitted its turn");
    const exactScopeDigest = scopeDigest(harness.scope);
    const sourceContext = contextForLearningLoop(harness.learning);
    const graph = await loadSemanticTurnByScope(sourceContext, result.turnId, exactScopeDigest);
    if (graph === undefined) throw new Error("legacy direct-get fixture omitted its graph");
    const legacyStore = createInMemoryStore();
    for (const key of [
      { namespace: "learning", kind: "semantic-workflow-reservation", id: graph.reservation.id },
      { namespace: "learning", kind: "semantic-workflow-dispatch", id: graph.dispatch.id },
      { namespace: "learning", kind: "semantic-workflow-result", id: graph.result.id },
    ]) {
      const stored = await harness.store.get(key);
      if (stored === undefined) throw new Error(`legacy fixture omitted ${key.kind}`);
      const value = toJsonValue(stored.value);
      await legacyStore.create(key, value, sha256HexOfCanonicalJson(value), `legacy-copy/${key.kind}`);
    }
    const legacyIndex = buildSemanticTurnScopeIndex({
      scopeDigest: graph.scopeIndex.scopeDigest,
      turnId: graph.scopeIndex.turnId,
      turnKeyDigest: graph.scopeIndex.turnKeyDigest,
      turnDigest: graph.scopeIndex.turnDigest,
    });
    const scopedRecords = [
      { kind: "semantic-workflow-turn-index", value: toJsonValue(legacyIndex) },
      { kind: "semantic-workflow-turn", value: toJsonValue(graph.turn) },
    ];
    for (const entry of scopedRecords) {
      await legacyStore.create(
        { namespace: turnScopeNamespace(exactScopeDigest), kind: entry.kind, id: result.turnId },
        entry.value,
        sha256HexOfCanonicalJson(entry.value),
        `legacy-copy/${entry.kind}`,
      );
    }
    const legacyContext: EngineContext = { ...sourceContext, store: legacyStore };
    const loaded = await loadSemanticTurnByScope(legacyContext, result.turnId, exactScopeDigest);
    expect(loaded).toMatchObject({
      turn: { id: result.turnId },
      result: { status: "provider_refused" },
    });
    expect(loaded?.scopeIndex.definitionDigest).toBeUndefined();
  });
});
