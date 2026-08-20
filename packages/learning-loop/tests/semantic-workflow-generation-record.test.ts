// Private #13b execution-sidecar conformance. Public consumer behavior is
// exercised separately through @cormidia/learning-loop/workflows.
import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import {
  canonicalJsonText,
  detectorExecutionDigest,
  insightDerivationDigest,
  parseDetectorExecutionRecord,
  parseInsightDerivation,
  sha256HexOfCanonicalJson,
  toJsonValue,
} from "../src/index.js";
import {
  buildSemanticWorkflowCompletionIntent,
  buildSemanticWorkflowAttemptIndex,
  buildSemanticWorkflowExecutionBinding,
  buildSemanticWorkflowExecutionPlanLock,
  parseSemanticWorkflowCompletionIntent,
  parseSemanticWorkflowAttemptIndex,
  parseSemanticWorkflowExecutionBinding,
  parseSemanticWorkflowExecutionPlanLock,
} from "../src/workflows/semantic-generation-record.js";
import { buildSemanticResultBinding, semanticNormalizedResultDigest } from "../src/workflows/semantic-turn-outcome.js";
import {
  appendDerivationLink,
  buildDerivationLink,
  buildRegistrySnapshot,
  persistRegistrySnapshot,
} from "../src/engine/semantic-graph.js";
import { buildUnavailableExecutionRecurrenceBinding } from "../src/engine/detector-recurrence.js";
import { persistDetectorExecution } from "../src/engine/semantic-persistence.js";
import {
  persistDetectorExecutionScopeIndex,
  persistInsightDerivationScopeIndex,
} from "../src/engine/semantic-scope-index.js";
import { loadDetectorExecutionView } from "../src/engine/semantic-views.js";
import { createSemanticEngineHarness, createSemanticFacts } from "./semantic-engine-harness.js";

function digest(label: string): string {
  return sha256HexOfCanonicalJson(toJsonValue({ label }));
}

function expectDeepFrozen(input: unknown): void {
  if (typeof input !== "object" || input === null) return;
  expect(Object.isFrozen(input)).toBe(true);
  for (const value of Object.values(input)) expectDeepFrozen(value);
}

async function fixture() {
  const harness = await createSemanticEngineHarness({ label: "workflow-generation-record" });
  const facts = createSemanticFacts(harness);
  const binding = buildSemanticWorkflowExecutionBinding({
    turnKeyDigest: digest("workflow-turn"),
    reservationDigest: digest("workflow-reservation"),
    resultBindingDigest: digest("workflow-result"),
    definitionDigest: digest("workflow-definition"),
    execution: facts.execution,
    derivations: [facts.derivation],
  });
  return { harness, facts, binding };
}

async function completionFixture(input: { readonly conditionDetected?: boolean } = {}) {
  const harness = await createSemanticEngineHarness({ label: "workflow-completion-record" });
  const conditionDetected = input.conditionDetected ?? true;
  const positive = createSemanticFacts(harness);
  const facts = conditionDetected
    ? positive
    : createSemanticFacts(harness, {
        executionResult: {
          status: "applied",
          conditionDetected: false,
          derivationRefs: [],
          evidenceHealthFindings: [],
        },
      });
  const turnKeyDigest = digest("completion-turn");
  const reservationDigest = digest("completion-reservation");
  const definitionDigest = digest("completion-definition");
  const normalizedResult = toJsonValue({ conditionDetected });
  const result = buildSemanticResultBinding({
    turnKeyDigest,
    reservationDigest,
    dispatchDigest: digest("completion-dispatch"),
    status: "completed",
    response: {
      providerReceiptId: "completion-provider-receipt",
      providerReceiptDigest: digest("completion-provider-receipt"),
      requestAttestationDigest: digest("completion-request"),
      responseByteLength: 128,
      responseKeyedDigest: digest("completion-response"),
      keyPolicyDigest: digest("completion-key-policy"),
    },
    usage: {
      status: "reported",
      inputTokens: 10,
      outputTokens: 2,
      durationMs: 5,
      costMinorUnits: 0,
      currency: "USD",
    },
    normalizedResult,
    normalizedResultDigest: semanticNormalizedResultDigest(normalizedResult),
    reasonCodes: [],
  });
  const derivations = conditionDetected ? [positive.derivation] : [];
  const workflowExecution = buildSemanticWorkflowExecutionBinding({
    turnKeyDigest,
    reservationDigest,
    resultBindingDigest: result.bindingDigest,
    definitionDigest,
    execution: facts.execution,
    derivations,
  });
  const planLock = buildSemanticWorkflowExecutionPlanLock({
    detectorExecutionKeyDigest: facts.execution.executionKeyDigest,
    turnKeyDigest,
    reservationId: `semantic-workflow-reservation-${turnKeyDigest}`,
    reservationDigest,
    definitionDigest,
    scopeDigest: facts.execution.scopeDigest,
    request: {
      byteLength: 128,
      estimatedInputTokens: 32,
      minimizedBytesDigest: digest("completion-request"),
      keyPolicyDigest: digest("completion-key-policy"),
    },
  });
  const templateStatus: "applied" = "applied";
  const templateResult = {
    status: templateStatus,
    conditionDetected: false,
    derivationRefs: [],
    evidenceHealthFindings: [],
  };
  const {
    schemaVersion: _executionSchemaVersion,
    id: _executionId,
    executionDigest: _executionDigest,
    result: _executionResult,
    ...executionContent
  } = facts.execution;
  const executionTemplate = parseDetectorExecutionRecord({
    ...facts.execution,
    result: templateResult,
    executionDigest: detectorExecutionDigest({ ...executionContent, result: templateResult }),
  });
  const complete: "complete" = "complete";
  const episodeCompleteness = executionTemplate.window.population.episodes.map((episode) => ({
    episodeRecordId: episode.episodeRecordId,
    episodeViewDigest: episode.episodeViewDigest,
    completeness: complete,
  }));
  const completion = buildSemanticWorkflowCompletionIntent({
    detectorExecutionKeyDigest: facts.execution.executionKeyDigest,
    turnKeyDigest,
    reservationDigest,
    planLockDigest: planLock.lockDigest,
    registrySnapshot: buildRegistrySnapshot(harness.context),
    executionTemplate,
    episodeCompleteness,
    detectorOrchestrationPolicy: null,
    recurrenceBinding: conditionDetected ? buildUnavailableExecutionRecurrenceBinding(facts.execution) : null,
    result,
    workflowExecution,
    execution: facts.execution,
    derivations,
  });
  return {
    harness,
    positive,
    facts,
    result,
    workflowExecution,
    planLock,
    executionTemplate,
    episodeCompleteness,
    completion,
  };
}

function completionWithPadding(source: Awaited<ReturnType<typeof completionFixture>>, padding: string) {
  const {
    schemaVersion: _derivationSchemaVersion,
    id: _derivationId,
    derivationDigest: _derivationDigest,
    ...derivationContent
  } = source.positive.derivation;
  const paddedDerivationContent = {
    ...derivationContent,
    directObservation: {
      ...derivationContent.directObservation,
      data: { padding },
    },
  };
  const derivationDigest = insightDerivationDigest(paddedDerivationContent);
  const derivation = parseInsightDerivation({
    schemaVersion: 1,
    id: `insight-${derivationDigest}`,
    ...paddedDerivationContent,
    derivationDigest,
  });
  const originalResult = source.facts.execution.result;
  if (originalResult.status !== "applied") throw new Error("completion fixture requires an applied execution");
  const result = {
    ...originalResult,
    derivationRefs: [
      {
        id: derivation.id,
        derivationDigest: derivation.derivationDigest,
        scopeDigest: derivation.scopeDigest,
      },
    ],
  };
  const {
    schemaVersion: _executionSchemaVersion,
    id: _executionId,
    executionDigest: _executionDigest,
    result: _originalResult,
    ...executionContent
  } = source.facts.execution;
  const execution = parseDetectorExecutionRecord({
    ...source.facts.execution,
    result,
    executionDigest: detectorExecutionDigest({ ...executionContent, result }),
  });
  const workflowExecution = buildSemanticWorkflowExecutionBinding({
    turnKeyDigest: source.completion.turnKeyDigest,
    reservationDigest: source.completion.reservationDigest,
    resultBindingDigest: source.result.bindingDigest,
    definitionDigest: source.workflowExecution.definitionDigest,
    execution,
    derivations: [derivation],
  });
  return buildSemanticWorkflowCompletionIntent({
    detectorExecutionKeyDigest: execution.executionKeyDigest,
    turnKeyDigest: source.completion.turnKeyDigest,
    reservationDigest: source.completion.reservationDigest,
    planLockDigest: source.completion.planLockDigest,
    registrySnapshot: source.completion.registrySnapshot,
    executionTemplate: source.executionTemplate,
    episodeCompleteness: source.episodeCompleteness,
    detectorOrchestrationPolicy: null,
    recurrenceBinding: buildUnavailableExecutionRecurrenceBinding(execution),
    result: source.result,
    workflowExecution,
    execution,
    derivations: [derivation],
  });
}

describe("semantic workflow execution binding", () => {
  it("drops unknown fields, recursively freezes, and pins key/full identity", async () => {
    const { binding } = await fixture();
    const parsed = parseSemanticWorkflowExecutionBinding({ ...binding, unknown: "drop-me" });
    expect(parsed).toEqual(binding);
    expect(JSON.stringify(parsed)).not.toContain("drop-me");
    expectDeepFrozen(parsed);
    expect(binding.workflowExecutionKeyDigest).toBe("929de71028d644392c5683795468b52ea609fded3cc368d9d88b7fe98517c696");
    expect(binding.workflowExecutionDigest).toBe("1ac556d4d81ae0debaa94ffbdc8fb003c412d2c51be73d33d50361f12f487f6f");
  });

  it("rejects malformed schema, ids, keys, full digests, execution refs, and derivation refs", async () => {
    const { binding } = await fixture();
    const derivation = binding.derivationRefs[0];
    if (derivation === undefined) throw new Error("execution-binding fixture requires a derivation");
    for (const value of [
      null,
      [],
      { ...binding, schemaVersion: 2 },
      { ...binding, id: "foreign-binding" },
      { ...binding, workflowExecutionKeyDigest: digest("foreign-key") },
      { ...binding, workflowExecutionDigest: digest("foreign-full") },
      { ...binding, detectorExecution: { ...binding.detectorExecution, id: "foreign-execution" } },
      { ...binding, derivationRefs: [{ ...derivation, id: "foreign-derivation" }] },
      { ...binding, derivationRefs: [derivation, derivation] },
    ]) {
      expect(() => parseSemanticWorkflowExecutionBinding(value)).toThrowError(
        expect.objectContaining({ code: expect.stringMatching(/^schema\./) }),
      );
    }
  });

  it("requires a sorted own-data derivation population", async () => {
    const { harness, facts, binding } = await fixture();
    const second = createSemanticFacts(harness, { observationLabel: "second-workflow-output" }).derivation;
    const sorted = buildSemanticWorkflowExecutionBinding({
      turnKeyDigest: binding.turnKeyDigest,
      reservationDigest: binding.reservationDigest,
      resultBindingDigest: binding.resultBindingDigest,
      definitionDigest: binding.definitionDigest,
      execution: facts.execution,
      derivations: [facts.derivation, second],
    });
    expect(sorted.derivationRefs.map((reference) => reference.id)).toEqual(
      sorted.derivationRefs.map((reference) => reference.id).sort(),
    );
    expect(() =>
      parseSemanticWorkflowExecutionBinding({ ...sorted, derivationRefs: [...sorted.derivationRefs].reverse() }),
    ).toThrowError(expect.objectContaining({ code: "schema.invalid" }));
    let reads = 0;
    const refs = [...sorted.derivationRefs];
    const first = refs[0];
    if (first === undefined) throw new Error("accessor fixture requires a derivation");
    Object.defineProperty(refs, "0", {
      enumerable: true,
      get: () => {
        reads += 1;
        return first;
      },
    });
    expect(() => parseSemanticWorkflowExecutionBinding({ ...sorted, derivationRefs: refs })).toThrowError(
      expect.objectContaining({ code: "schema.invalid" }),
    );
    expect(reads).toBeLessThanOrEqual(1);
  });

  it("pins plan-lock and completion-intent identity and drops unknown fields", async () => {
    const { planLock, completion } = await completionFixture();
    expect(parseSemanticWorkflowExecutionPlanLock({ ...planLock, unknown: true })).toEqual(planLock);
    expect(parseSemanticWorkflowCompletionIntent({ ...completion, unknown: true })).toEqual(completion);
    expectDeepFrozen(planLock);
    expectDeepFrozen(completion);
    expect(planLock.lockDigest).toBe("05761755f5c15f0fb4db77052abd53ac0f5dce3f6df135a0c2f0834288c96717");
    expect(completion.intentDigest).toBe("99a776dd71e9798f476f1ff46fb01f2bacc7bb31fce1019d1d51980c17d12e4c");
    for (const value of [
      { ...planLock, id: "foreign-plan" },
      { ...planLock, lockDigest: digest("foreign-plan-lock") },
      { ...planLock, request: { ...planLock.request, byteLength: 0 } },
      { ...planLock, request: { ...planLock.request, estimatedInputTokens: -1 } },
      { ...planLock, request: { ...planLock.request, estimatedInputTokens: Number.MAX_SAFE_INTEGER + 1 } },
    ]) {
      expect(() => parseSemanticWorkflowExecutionPlanLock(value)).toThrowError(
        expect.objectContaining({ code: expect.stringMatching(/^schema\./) }),
      );
    }
    for (const value of [
      { ...completion, id: "foreign-completion" },
      { ...completion, intentDigest: digest("foreign-intent") },
      { ...completion, detectorExecutionKeyDigest: digest("foreign-execution-key") },
      { ...completion, result: { ...completion.result, turnKeyDigest: digest("foreign-turn") } },
      { ...completion, derivations: [] },
      { ...completion, recurrenceBinding: null },
      {
        ...completion,
        episodeCompleteness: completion.episodeCompleteness.map((episode) => ({
          ...episode,
          episodeViewDigest: digest("foreign-episode-view"),
        })),
      },
    ]) {
      expect(() => parseSemanticWorkflowCompletionIntent(value)).toThrowError(
        expect.objectContaining({ code: expect.stringMatching(/^schema\./) }),
      );
    }
  });

  it("pins the definition-and-scope-local recovery attempt identity and rejects every adjacent binding", async () => {
    const { planLock } = await completionFixture();
    const attempt = buildSemanticWorkflowAttemptIndex({
      attemptId: `semantic-workflow-attempt-${planLock.detectorExecutionKeyDigest}`,
      scopeDigest: planLock.scopeDigest,
      definitionDigest: planLock.definitionDigest,
      reservationId: planLock.reservationId,
      reservationDigest: planLock.reservationDigest,
      planLockId: planLock.id,
      planLockDigest: planLock.lockDigest,
      detectorExecutionKeyDigest: planLock.detectorExecutionKeyDigest,
    });
    expect(parseSemanticWorkflowAttemptIndex({ ...attempt, unknown: "drop" })).toEqual(attempt);
    expectDeepFrozen(attempt);
    expect(attempt.attemptDigest).toBe("0f4dcfe35112bd4885737eda64e9fbf2b508bd3ecfc61429c037470d84be2874");
    for (const value of [
      { ...attempt, id: "foreign-attempt" },
      { ...attempt, attemptId: "foreign-attempt" },
      { ...attempt, scopeDigest: digest("foreign-scope") },
      { ...attempt, definitionDigest: digest("foreign-definition") },
      { ...attempt, reservationId: "foreign-reservation" },
      { ...attempt, reservationDigest: digest("foreign-reservation") },
      { ...attempt, planLockId: "foreign-plan" },
      { ...attempt, planLockDigest: digest("foreign-plan") },
      { ...attempt, detectorExecutionKeyDigest: digest("foreign-execution") },
      { ...attempt, attemptDigest: digest("foreign-attempt") },
    ]) {
      expect(() => parseSemanticWorkflowAttemptIndex(value)).toThrowError(
        expect.objectContaining({ code: expect.stringMatching(/^schema\./) }),
      );
    }
  });

  it("requires nonempty reciprocal derivations only for a detected condition and permits an exact negative", async () => {
    const positive = await completionFixture();
    expect(positive.completion.recurrenceBinding).toMatchObject({
      executionDigest: positive.facts.execution.executionDigest,
      locator: null,
      groupKeyDigest: null,
    });
    const emptyBinding = buildSemanticWorkflowExecutionBinding({
      turnKeyDigest: positive.workflowExecution.turnKeyDigest,
      reservationDigest: positive.workflowExecution.reservationDigest,
      resultBindingDigest: positive.workflowExecution.resultBindingDigest,
      definitionDigest: positive.workflowExecution.definitionDigest,
      execution: positive.facts.execution,
      derivations: [],
    });
    expect(() =>
      buildSemanticWorkflowCompletionIntent({
        detectorExecutionKeyDigest: positive.facts.execution.executionKeyDigest,
        turnKeyDigest: positive.completion.turnKeyDigest,
        reservationDigest: positive.completion.reservationDigest,
        planLockDigest: positive.completion.planLockDigest,
        registrySnapshot: positive.completion.registrySnapshot,
        executionTemplate: positive.executionTemplate,
        episodeCompleteness: positive.episodeCompleteness,
        detectorOrchestrationPolicy: null,
        recurrenceBinding: positive.completion.recurrenceBinding,
        result: positive.result,
        workflowExecution: emptyBinding,
        execution: positive.facts.execution,
        derivations: [],
      }),
    ).toThrowError(expect.objectContaining({ code: "schema.corrupt" }));

    const negative = await completionFixture({ conditionDetected: false });
    expect(negative.completion.derivations).toEqual([]);
    expect(negative.completion.workflowExecution.derivationRefs).toEqual([]);
    expect(negative.completion.recurrenceBinding).toBeNull();
    expect(parseSemanticWorkflowCompletionIntent(negative.completion)).toEqual(negative.completion);
    expect(() =>
      parseSemanticWorkflowCompletionIntent({
        ...negative.completion,
        recurrenceBinding: positive.completion.recurrenceBinding,
      }),
    ).toThrowError(expect.objectContaining({ code: "schema.corrupt" }));
  });

  it("accepts an exact 64 MiB completion intent and rejects the next byte", async () => {
    const maximumBytes = 64 * 1_048_576;
    const source = await completionFixture();
    const baseline = completionWithPadding(source, "");
    const baselineBytes = Buffer.byteLength(canonicalJsonText(toJsonValue(baseline)), "utf8");
    const paddingBytes = maximumBytes - baselineBytes;
    expect(paddingBytes).toBeGreaterThan(0);
    const exact = completionWithPadding(source, "x".repeat(paddingBytes));
    expect(Buffer.byteLength(canonicalJsonText(toJsonValue(exact)), "utf8")).toBe(maximumBytes);
    expect(() => completionWithPadding(source, "x".repeat(paddingBytes + 1))).toThrowError(
      expect.objectContaining({ code: "semantic.workflow_limit" }),
    );
  }, 120_000);

  it("refuses a workflow-bound negative execution through generic persistence and views when sidecars are absent", async () => {
    const harness = await createSemanticEngineHarness({
      label: "workflow-negative-sidecar",
      workflowDefinitionDigest: digest("workflow-negative-definition"),
      lensGeneratorKinds: ["semantic_judgment"],
    });
    const facts = createSemanticFacts(harness, {
      executionResult: {
        status: "applied",
        conditionDetected: false,
        derivationRefs: [],
        evidenceHealthFindings: [],
      },
    });
    await expect(persistDetectorExecution(harness.context, facts.execution, [])).rejects.toMatchObject({
      code: "semantic.workflow_incomplete",
    });
    expect(
      (await harness.store.list({ namespace: "learning", kind: "detector-execution", limit: 10 })).records,
    ).toEqual([]);

    await persistDetectorExecutionScopeIndex(harness.context, facts.execution);
    const value = toJsonValue(facts.execution);
    await harness.store.create(
      { namespace: "learning", kind: "detector-execution", id: facts.execution.id },
      value,
      sha256HexOfCanonicalJson(value),
      `seed-workflow-negative/${facts.execution.id}`,
    );
    await expect(loadDetectorExecutionView(harness.context, facts.execution.id, harness.scope)).rejects.toMatchObject({
      code: "store.corrupt",
    });
  });

  it("refuses a positive semantic judgment without sidecars under a mixed lens and config-absent detector", async () => {
    const harness = await createSemanticEngineHarness({
      label: "mixed-semantic-sidecar",
      lensGeneratorKinds: ["deterministic", "semantic_judgment"],
      detectorTransientContent: "memory_only",
    });
    const baseFacts = createSemanticFacts(harness);
    const producer = await harness.context.identity.verify({
      principalId: "mixed-semantic-producer",
      kind: "service",
      independenceDomain: "mixed-semantic-domain",
    });
    const {
      schemaVersion: _derivationSchemaVersion,
      id: _derivationId,
      derivationDigest: _derivationDigest,
      ...derivationContent
    } = baseFacts.derivation;
    const semanticKind: "semantic_judgment" = "semantic_judgment";
    const semanticContent = {
      ...derivationContent,
      producer: {
        kind: semanticKind,
        implementationId: harness.detector.id,
        implementationVersion: harness.detector.version,
        implementationDigest: harness.detector.implementationDigest,
        principal: producer.ref,
        attestation: { id: producer.attestationId, digest: producer.attestationDigest },
        modelFingerprintDigest: digest("mixed-semantic-model"),
        promptDigest: digest("mixed-semantic-prompt"),
        toolPolicyDigest: digest("mixed-semantic-tool"),
        budgetPolicyDigest: digest("mixed-semantic-budget"),
        disclosure: null,
      },
    };
    const derivationDigest = insightDerivationDigest(semanticContent);
    const derivation = parseInsightDerivation({
      schemaVersion: 1,
      id: `insight-${derivationDigest}`,
      ...semanticContent,
      derivationDigest,
    });
    const appliedStatus: "applied" = "applied";
    const result = {
      status: appliedStatus,
      conditionDetected: true,
      derivationRefs: [
        { id: derivation.id, derivationDigest: derivation.derivationDigest, scopeDigest: derivation.scopeDigest },
      ],
      evidenceHealthFindings: [],
    };
    const {
      schemaVersion: _executionSchemaVersion,
      id: _executionId,
      executionDigest: _executionDigest,
      result: _executionResult,
      ...executionContent
    } = baseFacts.execution;
    const execution = parseDetectorExecutionRecord({
      ...baseFacts.execution,
      result,
      executionDigest: detectorExecutionDigest({ ...executionContent, result }),
    });
    await expect(persistDetectorExecution(harness.context, execution, [derivation])).rejects.toMatchObject({
      code: "semantic.workflow_incomplete",
    });
    expect(
      (await harness.store.list({ namespace: "learning", kind: "semantic-registry-snapshot", limit: 10 })).records,
    ).toEqual([]);

    const snapshot = buildRegistrySnapshot(harness.context);
    await persistRegistrySnapshot(harness.context, snapshot);
    const reference = result.derivationRefs[0];
    if (reference === undefined) throw new Error("mixed semantic fixture omitted its derivation reference");
    await appendDerivationLink(
      harness.context,
      buildDerivationLink(execution, snapshot.semanticRegistry.registryDigest, reference),
    );
    const derivationValue = toJsonValue(derivation);
    await harness.store.create(
      { namespace: "learning", kind: "insight-derivation", id: derivation.id },
      derivationValue,
      sha256HexOfCanonicalJson(derivationValue),
      "seed-mixed-semantic-derivation",
    );
    await persistInsightDerivationScopeIndex(harness.context, derivation);
    await persistDetectorExecutionScopeIndex(harness.context, execution);
    const executionValue = toJsonValue(execution);
    await harness.store.create(
      { namespace: "learning", kind: "detector-execution", id: execution.id },
      executionValue,
      sha256HexOfCanonicalJson(executionValue),
      "seed-mixed-semantic-execution",
    );
    await expect(loadDetectorExecutionView(harness.context, execution.id, harness.scope)).rejects.toMatchObject({
      code: "store.corrupt",
    });
  });
});
