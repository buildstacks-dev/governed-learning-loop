// #30c2b1 private recurrence graph: exact grouping domain, receipt-last
// ordering, orphan recovery, concurrency, and fail-closed durable boundaries.
import { describe, expect, it } from "vitest";
import type { DetectorExecutionRecord, DetectorRecurrenceLocator, LearningStore } from "../src/index.js";
import {
  detectorExecutionDigest,
  detectorExecutionKeyDigest,
  parseDetectorExecutionRecord,
  scopeDigest,
  sha256HexOfCanonicalJson,
  toJsonValue,
} from "../src/index.js";
import type { EngineContext } from "../src/engine/context.js";
import {
  detectorRecurrenceGroupKeyDigest,
  type ExecutionRecurrenceBinding,
  loadExecutionRecurrenceBinding,
  prepareExecutionRecurrence,
  type RecurrenceGroupMember,
  recurrenceForExecution,
} from "../src/engine/detector-recurrence.js";
import { persistDetectorExecution } from "../src/engine/semantic-persistence.js";
import { createInMemoryStore } from "../src/testing/index.js";
import {
  PRIVATE_LOCATOR,
  createRecurrenceRunnerHarness,
  detectedInsightDraft,
  recurrenceRunInput,
} from "./detector-recurrence-harness.js";
import { SEMANTIC_SCOPE_B, createSemanticEngineHarness, createSemanticFacts } from "./semantic-engine-harness.js";

async function recordsOf(store: LearningStore, kind: string) {
  return (await store.list({ namespace: "learning", kind, limit: 10_000 })).records;
}

function recordingStore(base: LearningStore, writes: string[]): LearningStore {
  return {
    get: (key) => base.get(key),
    create: (key, value, digest, operationId) => {
      writes.push(key.kind);
      return base.create(key, value, digest, operationId);
    },
    compareAndSet: (key, expectedRevision, value, digest, operationId) =>
      base.compareAndSet(key, expectedRevision, value, digest, operationId),
    append: (stream, expectedRevision, entries, operationId) => {
      writes.push(stream.kind);
      return base.append(stream, expectedRevision, entries, operationId);
    },
    tombstone: (input) => base.tombstone(input),
    list: (query) => base.list(query),
  };
}

function toggledFailureStore(base: LearningStore, target: "detector-execution" | "detector-recurrence-binding") {
  let enabled = false;
  let failed = false;
  const store: LearningStore = {
    get: (key) => base.get(key),
    create: (key, value, digest, operationId) => {
      if (enabled && !failed && key.kind === target) {
        failed = true;
        throw new Error(`failed before ${target}`);
      }
      return base.create(key, value, digest, operationId);
    },
    compareAndSet: (key, expectedRevision, value, digest, operationId) =>
      base.compareAndSet(key, expectedRevision, value, digest, operationId),
    append: (stream, expectedRevision, entries, operationId) =>
      base.append(stream, expectedRevision, entries, operationId),
    tombstone: (input) => base.tombstone(input),
    list: (query) => base.list(query),
  };
  return { store, enable: () => (enabled = true) };
}

function loseFirstGroupAcknowledgement(base: LearningStore): LearningStore {
  let failed = false;
  return {
    get: (key) => base.get(key),
    create: (key, value, digest, operationId) => base.create(key, value, digest, operationId),
    compareAndSet: (key, expectedRevision, value, digest, operationId) =>
      base.compareAndSet(key, expectedRevision, value, digest, operationId),
    append: async (stream, expectedRevision, entries, operationId) => {
      const result = await base.append(stream, expectedRevision, entries, operationId);
      if (!failed && stream.kind === "detector-recurrence-group") {
        failed = true;
        throw new Error("lost recurrence group acknowledgement");
      }
      return result;
    },
    tombstone: (input) => base.tombstone(input),
    list: (query) => base.list(query),
  };
}

function loseFirstBindingAcknowledgement(base: LearningStore): LearningStore {
  let failed = false;
  return {
    get: (key) => base.get(key),
    create: async (key, value, exactDigest, operationId) => {
      const result = await base.create(key, value, exactDigest, operationId);
      if (!failed && key.kind === "detector-recurrence-binding") {
        failed = true;
        throw new Error("lost recurrence binding acknowledgement");
      }
      return result;
    },
    compareAndSet: (key, expectedRevision, value, exactDigest, operationId) =>
      base.compareAndSet(key, expectedRevision, value, exactDigest, operationId),
    append: (stream, expectedRevision, entries, operationId) =>
      base.append(stream, expectedRevision, entries, operationId),
    tombstone: (input) => base.tombstone(input),
    list: (query) => base.list(query),
  };
}

function replaceContextStore(context: EngineContext, store: LearningStore): EngineContext {
  return { ...context, store };
}

function digest(value: unknown): string {
  return sha256HexOfCanonicalJson(toJsonValue(value));
}

type GroupedBinding = ExecutionRecurrenceBinding & {
  readonly locator: DetectorRecurrenceLocator;
  readonly groupKeyDigest: string;
};

function requireGroupedBinding(binding: ExecutionRecurrenceBinding): GroupedBinding {
  if (binding.locator === null || binding.groupKeyDigest === null) {
    throw new Error("test fixture requires a grouped recurrence binding");
  }
  return { ...binding, locator: binding.locator, groupKeyDigest: binding.groupKeyDigest };
}

function bindingForExecution(execution: DetectorExecutionRecord, locator: DetectorRecurrenceLocator): GroupedBinding {
  const base = {
    executionId: execution.id,
    executionKeyDigest: execution.executionKeyDigest,
    executionDigest: execution.executionDigest,
    detector: execution.detector,
    pack: execution.pack,
    lens: execution.lens,
    scope: execution.scope,
    scopeDigest: execution.scopeDigest,
    scopePolicyDigest: execution.scopePolicyDigest,
    locator,
    groupKeyDigest: detectorRecurrenceGroupKeyDigest(execution, locator),
    memberEpisodes: execution.window.population.episodes.map((episode) => ({
      episodeRecordId: episode.episodeRecordId,
      episodeIdentityDigest: episode.episodeIdentityDigest,
      episodeViewDigest: episode.episodeViewDigest,
    })),
  };
  return { schemaVersion: 1, ...base, bindingDigest: digest(base) };
}

function memberForBinding(binding: ExecutionRecurrenceBinding): RecurrenceGroupMember {
  const grouped = requireGroupedBinding(binding);
  const base = {
    groupKeyDigest: grouped.groupKeyDigest,
    executionId: grouped.executionId,
    executionKeyDigest: grouped.executionKeyDigest,
    executionDigest: grouped.executionDigest,
    bindingDigest: grouped.bindingDigest,
    pack: grouped.pack,
  };
  return { schemaVersion: 1, ...base, memberDigest: digest(base) };
}

function entryForMember(member: RecurrenceGroupMember) {
  const value = toJsonValue(member);
  return {
    id: `execution:${member.executionId}:${member.executionDigest}`,
    digest: digest(value),
    value,
  };
}

async function seedBinding(store: LearningStore, binding: ExecutionRecurrenceBinding): Promise<void> {
  const value = toJsonValue(binding);
  await store.create(
    { namespace: "learning", kind: "detector-recurrence-binding", id: binding.executionId },
    value,
    digest(value),
    `seed-binding/${binding.executionId}`,
  );
}

async function seedGroup(
  store: LearningStore,
  groupKeyDigest: string,
  members: readonly RecurrenceGroupMember[],
): Promise<void> {
  await store.append(
    { namespace: "learning", kind: "detector-recurrence-group", id: groupKeyDigest },
    undefined,
    members.map(entryForMember),
    `seed-group/${groupKeyDigest}`,
  );
}

function orphanBinding(
  template: GroupedBinding,
  index: number,
  memberEpisodes: ExecutionRecurrenceBinding["memberEpisodes"] = template.memberEpisodes.slice(0, 1),
): GroupedBinding {
  const executionKeyDigest = digest({ orphan: index, kind: "key" });
  const executionDigest = digest({ orphan: index, kind: "execution" });
  const base = {
    ...template,
    executionId: `detector-execution-${executionKeyDigest}`,
    executionKeyDigest,
    executionDigest,
    memberEpisodes,
  };
  const { schemaVersion: _schemaVersion, bindingDigest: _bindingDigest, ...content } = base;
  return requireGroupedBinding({ schemaVersion: 1, ...content, bindingDigest: digest(content) });
}

function executionWithEpisodeIdentities(
  template: DetectorExecutionRecord,
  identities: readonly string[],
  label: string,
): DetectorExecutionRecord {
  const episodeTemplate = template.window.population.episodes[0];
  if (episodeTemplate === undefined) throw new Error("recurrence ceiling fixture requires an episode");
  const episodes = identities
    .map((episodeIdentityDigest, index) => ({
      ...episodeTemplate,
      episodeRecordId: `manual-evidence/${label}-${String(index).padStart(3, "0")}`,
      episodeRecordDigest: digest({ label, index, kind: "record" }),
      episodeIdentityDigest,
      episodeViewDigest: "",
    }))
    .map((episode) => ({
      ...episode,
      episodeViewDigest: digest({
        episodeRecordId: episode.episodeRecordId,
        episodeRecordDigest: episode.episodeRecordDigest,
        episodeIdentityDigest: episode.episodeIdentityDigest,
        outcomeClaimDigest: episode.outcomeClaimDigest,
        scopeDigest: episode.scopeDigest,
      }),
    }));
  const populationBase = {
    episodes,
    normalizationPolicyDigest: template.window.population.normalizationPolicyDigest,
    comparabilityPolicyDigest: template.window.population.comparabilityPolicyDigest,
  };
  const population = { ...populationBase, populationDigest: digest(populationBase) };
  const windowBase = {
    sourceProfiles: template.window.sourceProfiles,
    population,
    evidenceRefs: template.window.evidenceRefs,
    evidenceHealthFindings: template.window.evidenceHealthFindings,
    availableCapabilities: template.window.availableCapabilities,
  };
  const window = { ...windowBase, windowDigest: digest(windowBase) };
  const executionBase = {
    loopRegistryRevision: template.loopRegistryRevision,
    detector: template.detector,
    pack: template.pack,
    lens: template.lens,
    scope: template.scope,
    scopeDigest: template.scopeDigest,
    scopePolicyDigest: template.scopePolicyDigest,
    outputKind: template.outputKind,
    window,
  };
  const executionKeyDigest = detectorExecutionKeyDigest(executionBase);
  const executionDigest = detectorExecutionDigest({ ...executionBase, result: template.result, executionKeyDigest });
  return parseDetectorExecutionRecord({
    schemaVersion: 1,
    id: `detector-execution-${executionKeyDigest}`,
    ...executionBase,
    result: template.result,
    executionKeyDigest,
    executionDigest,
  });
}

describe("recurrence grouping domain and exact private records", () => {
  it("includes detector/lens/scope/locator semantics while excluding pack, registry, population, and result", async () => {
    const harness = await createSemanticEngineHarness();
    const facts = createSemanticFacts(harness);
    const baseline = detectorRecurrenceGroupKeyDigest(facts.execution, PRIVATE_LOCATOR);
    const excluded: DetectorExecutionRecord[] = [
      {
        ...facts.execution,
        pack: { id: "another-pack", version: "2.0.0", manifestDigest: "b".repeat(64) },
      },
      { ...facts.execution, loopRegistryRevision: "c".repeat(64) },
      {
        ...facts.execution,
        window: {
          ...facts.execution.window,
          population: { ...facts.execution.window.population, populationDigest: "d".repeat(64) },
        },
      },
      {
        ...facts.execution,
        result: { status: "applied", conditionDetected: false, derivationRefs: [], evidenceHealthFindings: [] },
      },
    ];
    expect(excluded.map((execution) => detectorRecurrenceGroupKeyDigest(execution, PRIVATE_LOCATOR))).toEqual(
      excluded.map(() => baseline),
    );

    const changedScope = { ...facts.execution, scope: SEMANTIC_SCOPE_B, scopeDigest: scopeDigest(SEMANTIC_SCOPE_B) };
    const included: DetectorExecutionRecord[] = [
      {
        ...facts.execution,
        detector: { ...facts.execution.detector, version: "2.0.0" },
      },
      {
        ...facts.execution,
        detector: { ...facts.execution.detector, registrationDigest: "e".repeat(64) },
      },
      {
        ...facts.execution,
        detector: { ...facts.execution.detector, configurationDigest: "f".repeat(64) },
      },
      {
        ...facts.execution,
        detector: { ...facts.execution.detector, implementationDigest: "1".repeat(64) },
      },
      {
        ...facts.execution,
        lens: facts.execution.lens === null ? null : { ...facts.execution.lens, registrationDigest: "2".repeat(64) },
      },
      changedScope,
      { ...facts.execution, scopePolicyDigest: "3".repeat(64) },
    ];
    for (const execution of included) {
      expect(detectorRecurrenceGroupKeyDigest(execution, PRIVATE_LOCATOR)).not.toBe(baseline);
    }
    expect(
      detectorRecurrenceGroupKeyDigest(facts.execution, {
        ...PRIVATE_LOCATOR,
        keyedDigest: "4".repeat(64),
      }),
    ).not.toBe(baseline);

    const binding = await prepareExecutionRecurrence(harness.context, facts.execution, PRIVATE_LOCATOR);
    expect(binding).toMatchObject({
      groupKeyDigest: baseline,
      pack: facts.execution.pack,
      detector: facts.execution.detector,
      lens: facts.execution.lens,
      scope: facts.execution.scope,
      locator: PRIVATE_LOCATOR,
    });
  });

  it("writes exact binding and group member before the execution receipt", async () => {
    const writes: string[] = [];
    const base = createInMemoryStore();
    const harness = await createSemanticEngineHarness({ store: recordingStore(base, writes) });
    const facts = createSemanticFacts(harness);
    writes.length = 0;
    await persistDetectorExecution(harness.context, facts.execution, [facts.derivation], PRIVATE_LOCATOR);
    const resultLockIndex = writes.indexOf("detector-execution-index");
    const bindingIndex = writes.indexOf("detector-recurrence-binding");
    const memberIndex = writes.indexOf("detector-recurrence-group");
    const receiptIndex = writes.indexOf("detector-execution");
    expect(resultLockIndex).toBeGreaterThanOrEqual(0);
    expect(bindingIndex).toBeGreaterThan(resultLockIndex);
    expect(memberIndex).toBeGreaterThan(bindingIndex);
    expect(receiptIndex).toBeGreaterThan(memberIndex);
    const binding = await loadExecutionRecurrenceBinding(harness.context, facts.execution.id);
    expect(binding).toMatchObject({
      executionId: facts.execution.id,
      executionKeyDigest: facts.execution.executionKeyDigest,
      executionDigest: facts.execution.executionDigest,
      pack: facts.execution.pack,
      memberEpisodes: facts.execution.window.population.episodes.map((episode) => ({
        episodeRecordId: episode.episodeRecordId,
        episodeIdentityDigest: episode.episodeIdentityDigest,
        episodeViewDigest: episode.episodeViewDigest,
      })),
    });
    await expect(recurrenceForExecution(harness.context, facts.execution, undefined)).resolves.toMatchObject({
      status: "grouped",
      executionCount: 1,
      distinctEpisodeCount: 1,
    });
  });
});

describe("recurrence receipt-last recovery and concurrency", () => {
  it("keeps a pre-receipt member orphaned, then exact retry commits it once", async () => {
    const base = createInMemoryStore();
    const failing = toggledFailureStore(base, "detector-execution");
    const harness = await createRecurrenceRunnerHarness({
      store: failing.store,
      label: "orphan-retry",
      episodeCount: 2,
      evaluate: (window) => detectedInsightDraft(window, PRIVATE_LOCATOR),
    });
    await harness.learning.runDetector(
      recurrenceRunInput(harness, "commit", [harness.episodeRecordIds[0] ?? "missing"]),
    );
    failing.enable();
    await expect(
      harness.learning.runDetector(recurrenceRunInput(harness, "commit", [harness.episodeRecordIds[1] ?? "missing"])),
    ).rejects.toThrowError("failed before detector-execution");
    expect(await recordsOf(base, "detector-recurrence-binding")).toHaveLength(2);
    expect(await recordsOf(base, "detector-execution")).toHaveLength(1);
    const beforeRetry = await harness.learning.runDetector(
      recurrenceRunInput(harness, "commit", [harness.episodeRecordIds[0] ?? "missing"]),
    );
    expect(beforeRetry.recurrence).toMatchObject({ status: "grouped", executionCount: 1, distinctEpisodeCount: 1 });

    const retried = await harness.learning.runDetector(
      recurrenceRunInput(harness, "commit", [harness.episodeRecordIds[1] ?? "missing"]),
    );
    expect(retried.recurrence).toMatchObject({ status: "grouped", executionCount: 2, distinctEpisodeCount: 2 });
    expect(await recordsOf(base, "detector-recurrence-binding")).toHaveLength(2);
    const groups = await recordsOf(base, "detector-recurrence-group");
    expect(groups).toHaveLength(1);
    expect(groups[0]?.value).toHaveLength(2);
  });

  it("recovers a lost group acknowledgement without duplicating a member", async () => {
    const base = createInMemoryStore();
    const harness = await createSemanticEngineHarness({ store: loseFirstGroupAcknowledgement(base) });
    const facts = createSemanticFacts(harness);
    await expect(
      persistDetectorExecution(harness.context, facts.execution, [facts.derivation], PRIVATE_LOCATOR),
    ).rejects.toThrowError("lost recurrence group acknowledgement");
    expect(await recordsOf(base, "detector-recurrence-binding")).toHaveLength(1);
    expect(await recordsOf(base, "detector-execution")).toHaveLength(0);
    await persistDetectorExecution(harness.context, facts.execution, [facts.derivation], PRIVATE_LOCATOR);
    expect(await recordsOf(base, "detector-execution")).toHaveLength(1);
    const groups = await recordsOf(base, "detector-recurrence-group");
    expect(groups).toHaveLength(1);
    expect(groups[0]?.value).toHaveLength(1);
  });

  it("recovers a lost binding acknowledgement before appending one member", async () => {
    const base = createInMemoryStore();
    const harness = await createSemanticEngineHarness({ store: loseFirstBindingAcknowledgement(base) });
    const facts = createSemanticFacts(harness);
    await expect(
      persistDetectorExecution(harness.context, facts.execution, [facts.derivation], PRIVATE_LOCATOR),
    ).rejects.toThrowError("lost recurrence binding acknowledgement");
    expect(await recordsOf(base, "detector-recurrence-binding")).toHaveLength(1);
    expect(await recordsOf(base, "detector-recurrence-group")).toHaveLength(0);
    expect(await recordsOf(base, "detector-execution")).toHaveLength(0);
    await persistDetectorExecution(harness.context, facts.execution, [facts.derivation], PRIVATE_LOCATOR);
    expect(await recordsOf(base, "detector-recurrence-binding")).toHaveLength(1);
    const groups = await recordsOf(base, "detector-recurrence-group");
    expect(groups).toHaveLength(1);
    expect(groups[0]?.value).toHaveLength(1);
    expect(await recordsOf(base, "detector-execution")).toHaveLength(1);
  });

  it("fails closed when recurrence group append contention exhausts its retry budget", async () => {
    const base = createInMemoryStore();
    const conflicting: LearningStore = {
      get: (key) => base.get(key),
      create: (key, value, exactDigest, operationId) => base.create(key, value, exactDigest, operationId),
      compareAndSet: (key, expectedRevision, value, exactDigest, operationId) =>
        base.compareAndSet(key, expectedRevision, value, exactDigest, operationId),
      append: (stream, expectedRevision, entries, operationId) =>
        stream.kind === "detector-recurrence-group"
          ? Promise.resolve({ status: "conflict", revision: "contention" })
          : base.append(stream, expectedRevision, entries, operationId),
      tombstone: (input) => base.tombstone(input),
      list: (query) => base.list(query),
    };
    const harness = await createSemanticEngineHarness({ store: conflicting });
    const facts = createSemanticFacts(harness);
    await expect(
      persistDetectorExecution(harness.context, facts.execution, [facts.derivation], PRIVATE_LOCATOR),
    ).rejects.toMatchObject({ code: "store.conflict" });
    expect(await recordsOf(base, "detector-recurrence-binding")).toHaveLength(1);
    expect(await recordsOf(base, "detector-recurrence-group")).toHaveLength(0);
    expect(await recordsOf(base, "detector-execution")).toHaveLength(0);
  });

  it("converges concurrent same-execution persistence and rejects another locator for that execution", async () => {
    const harness = await createSemanticEngineHarness();
    const facts = createSemanticFacts(harness);
    await Promise.all([
      persistDetectorExecution(harness.context, facts.execution, [facts.derivation], PRIVATE_LOCATOR),
      persistDetectorExecution(harness.context, facts.execution, [facts.derivation], PRIVATE_LOCATOR),
    ]);
    expect(await recordsOf(harness.store, "detector-recurrence-binding")).toHaveLength(1);
    expect(await recordsOf(harness.store, "detector-recurrence-group")).toHaveLength(1);
    await expect(
      persistDetectorExecution(harness.context, facts.execution, [facts.derivation], {
        ...PRIVATE_LOCATOR,
        keyedDigest: "9".repeat(64),
      }),
    ).rejects.toMatchObject({ code: "store.corrupt" });
    expect(await recordsOf(harness.store, "detector-recurrence-binding")).toHaveLength(1);
    expect(await recordsOf(harness.store, "detector-recurrence-group")).toHaveLength(1);
  });

  it("refuses null or changed locator bytes after an orphan binding, then resumes only with the exact locator", async () => {
    const base = createInMemoryStore();
    const failing = toggledFailureStore(base, "detector-execution");
    let locator: unknown = PRIVATE_LOCATOR;
    const harness = await createRecurrenceRunnerHarness({
      store: failing.store,
      label: "orphan-locator-conflict",
      evaluate: (window) => detectedInsightDraft(window, locator),
    });
    failing.enable();
    await expect(harness.learning.runDetector(recurrenceRunInput(harness, "commit"))).rejects.toThrowError(
      "failed before detector-execution",
    );
    locator = null;
    await expect(harness.learning.runDetector(recurrenceRunInput(harness, "commit"))).rejects.toMatchObject({
      code: "store.corrupt",
    });
    locator = { ...PRIVATE_LOCATOR, keyedDigest: "7".repeat(64) };
    await expect(harness.learning.runDetector(recurrenceRunInput(harness, "commit"))).rejects.toMatchObject({
      code: "store.corrupt",
    });
    expect(await recordsOf(base, "detector-execution")).toHaveLength(0);
    locator = PRIVATE_LOCATOR;
    await expect(harness.learning.runDetector(recurrenceRunInput(harness, "commit"))).resolves.toMatchObject({
      recurrence: { status: "grouped", executionCount: 1 },
    });
  });

  it("lets one execution-result lock win a same-key race before the loser can write recurrence lineage", async () => {
    const harness = await createSemanticEngineHarness();
    const left = createSemanticFacts(harness, { observationLabel: "race-left" });
    const right = createSemanticFacts(harness, { observationLabel: "race-right" });
    expect(left.execution.executionKeyDigest).toBe(right.execution.executionKeyDigest);
    expect(left.execution.executionDigest).not.toBe(right.execution.executionDigest);
    const rightLocator = { ...PRIVATE_LOCATOR, keyedDigest: "6".repeat(64) };
    const settled = await Promise.allSettled([
      persistDetectorExecution(harness.context, left.execution, [left.derivation], PRIVATE_LOCATOR),
      persistDetectorExecution(harness.context, right.execution, [right.derivation], rightLocator),
    ]);
    expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(settled.filter((result) => result.status === "rejected")).toHaveLength(1);
    const view = await harness.learning.getDetectorExecution({
      executionId: left.execution.id,
      scope: harness.scope,
    });
    expect(view).toMatchObject({ commitBinding: { status: "committed" } });
    const winner = view?.execution;
    if (winner === undefined) throw new Error("expected one readable execution winner");
    const winnerLocator = winner.executionDigest === left.execution.executionDigest ? PRIVATE_LOCATOR : rightLocator;
    const binding = await loadExecutionRecurrenceBinding(harness.context, winner.id);
    expect(binding).toMatchObject({ executionDigest: winner.executionDigest, locator: winnerLocator });
    expect(await recordsOf(harness.store, "detector-recurrence-binding")).toHaveLength(1);
    const groups = await recordsOf(harness.store, "detector-recurrence-group");
    expect(groups).toHaveLength(1);
    expect(groups[0]?.value).toHaveLength(1);
    await expect(recurrenceForExecution(harness.context, winner, undefined)).resolves.toMatchObject({
      status: "grouped",
      executionCount: 1,
      distinctEpisodeCount: 1,
    });
  });

  it("locks one nullable recurrence decision for concurrent identical execution bytes and never backfills it", async () => {
    const harness = await createSemanticEngineHarness();
    const facts = createSemanticFacts(harness);
    const settled = await Promise.allSettled([
      persistDetectorExecution(harness.context, facts.execution, [facts.derivation], null),
      persistDetectorExecution(harness.context, facts.execution, [facts.derivation], PRIVATE_LOCATOR),
    ]);
    expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(settled.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(await recordsOf(harness.store, "detector-execution")).toHaveLength(1);
    expect(await recordsOf(harness.store, "detector-recurrence-binding")).toHaveLength(1);
    const binding = await loadExecutionRecurrenceBinding(harness.context, facts.execution.id);
    if (binding === undefined) throw new Error("expected nullable recurrence decision");
    if (binding.locator === null) {
      expect(binding.groupKeyDigest).toBeNull();
      expect(await recordsOf(harness.store, "detector-recurrence-group")).toHaveLength(0);
      await expect(recurrenceForExecution(harness.context, facts.execution, undefined)).resolves.toEqual({
        status: "locator_unavailable",
      });
      await expect(
        persistDetectorExecution(harness.context, facts.execution, [facts.derivation], PRIVATE_LOCATOR),
      ).rejects.toMatchObject({ code: "store.corrupt" });
    } else {
      expect(binding.groupKeyDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(await recordsOf(harness.store, "detector-recurrence-group")).toHaveLength(1);
      await expect(recurrenceForExecution(harness.context, facts.execution, undefined)).resolves.toMatchObject({
        status: "grouped",
        executionCount: 1,
      });
      await expect(
        persistDetectorExecution(harness.context, facts.execution, [facts.derivation], null),
      ).rejects.toMatchObject({ code: "store.corrupt" });
    }
    expect(await recordsOf(harness.store, "detector-execution")).toHaveLength(1);
    expect(await recordsOf(harness.store, "detector-recurrence-binding")).toHaveLength(1);
  });

  it("counts a receipt that appears during an orphan read exactly once", async () => {
    const base = createInMemoryStore();
    const failing = toggledFailureStore(base, "detector-execution");
    const harness = await createSemanticEngineHarness({ store: failing.store });
    const facts = createSemanticFacts(harness);
    failing.enable();
    await expect(
      persistDetectorExecution(harness.context, facts.execution, [facts.derivation], PRIVATE_LOCATOR),
    ).rejects.toThrowError("failed before detector-execution");
    let appeared = false;
    const appearingStore: LearningStore = {
      get: async (key) => {
        const stored = await base.get(key);
        if (!appeared && key.kind === "detector-execution" && key.id === facts.execution.id) {
          appeared = true;
          const value = toJsonValue(facts.execution);
          await base.create(key, value, digest(value), `appearing-receipt/${facts.execution.id}`);
        }
        return stored;
      },
      create: (key, value, exactDigest, operationId) => base.create(key, value, exactDigest, operationId),
      compareAndSet: (key, expectedRevision, value, exactDigest, operationId) =>
        base.compareAndSet(key, expectedRevision, value, exactDigest, operationId),
      append: (stream, expectedRevision, entries, operationId) =>
        base.append(stream, expectedRevision, entries, operationId),
      tombstone: (input) => base.tombstone(input),
      list: (query) => base.list(query),
    };
    const context = replaceContextStore(harness.context, appearingStore);
    await expect(recurrenceForExecution(context, facts.execution, undefined)).resolves.toMatchObject({
      status: "grouped",
      executionCount: 1,
      distinctEpisodeCount: 1,
    });
    expect(appeared).toBe(true);
    await expect(
      harness.learning.getDetectorExecution({ executionId: facts.execution.id, scope: harness.scope }),
    ).resolves.toMatchObject({ commitBinding: { status: "committed" } });
  });
});

describe("recurrence durable store boundary", () => {
  it("treats any binding on a nonapplied or negative execution as corruption", async () => {
    const cases: readonly DetectorExecutionRecord["result"][] = [
      { status: "applied", conditionDetected: false, derivationRefs: [], evidenceHealthFindings: [] },
      { status: "incomplete", reasonCodes: ["fixture.incomplete"], missingCapabilities: [] },
    ];
    for (const result of cases) {
      const harness = await createSemanticEngineHarness();
      const facts = createSemanticFacts(harness, { executionResult: result });
      await seedBinding(harness.store, bindingForExecution(facts.execution, PRIVATE_LOCATOR));
      await expect(recurrenceForExecution(harness.context, facts.execution, undefined)).rejects.toMatchObject({
        code: "store.corrupt",
      });
    }
  });

  it("revalidates a stored orphan locator against the exact detector privacy registration", async () => {
    const harness = await createSemanticEngineHarness();
    const facts = createSemanticFacts(harness);
    await seedBinding(harness.store, bindingForExecution(facts.execution, PRIVATE_LOCATOR));
    const changedDetector = {
      ...harness.detector,
      privacy: { ...harness.detector.privacy, policyDigest: "b".repeat(64) },
    };
    const changedContext: EngineContext = {
      ...harness.context,
      semanticDetectorsByRef: new Map([
        [
          JSON.stringify([
            facts.execution.detector.id,
            facts.execution.detector.version,
            facts.execution.detector.registrationDigest,
          ]),
          changedDetector,
        ],
      ]),
    };
    await expect(recurrenceForExecution(changedContext, facts.execution, null)).rejects.toMatchObject({
      code: "store.corrupt",
    });
  });

  it("compares every member identity field to its exact binding", async () => {
    const base = createInMemoryStore();
    const harness = await createSemanticEngineHarness({ store: base });
    const facts = createSemanticFacts(harness);
    await persistDetectorExecution(harness.context, facts.execution, [facts.derivation], PRIVATE_LOCATOR);
    const binding = await loadExecutionRecurrenceBinding(harness.context, facts.execution.id);
    if (binding === undefined) throw new Error("expected recurrence binding");
    const groupedBinding = requireGroupedBinding(binding);
    const exactMemberBase = {
      groupKeyDigest: groupedBinding.groupKeyDigest,
      executionId: groupedBinding.executionId,
      executionKeyDigest: groupedBinding.executionKeyDigest,
      executionDigest: groupedBinding.executionDigest,
      bindingDigest: groupedBinding.bindingDigest,
      pack: groupedBinding.pack,
    };
    const groupKey = {
      namespace: "learning",
      kind: "detector-recurrence-group",
      id: groupedBinding.groupKeyDigest,
    };
    const original = await base.get(groupKey);
    if (original === undefined) throw new Error("expected recurrence group");
    const foreignKeyDigest = "7".repeat(64);
    const mutations = [
      { ...exactMemberBase, groupKeyDigest: "6".repeat(64) },
      {
        ...exactMemberBase,
        executionId: `detector-execution-${foreignKeyDigest}`,
        executionKeyDigest: foreignKeyDigest,
      },
      { ...exactMemberBase, executionDigest: "5".repeat(64) },
      { ...exactMemberBase, bindingDigest: "4".repeat(64) },
      { ...exactMemberBase, pack: { ...groupedBinding.pack, manifestDigest: "8".repeat(64) } },
    ];
    for (const memberBase of mutations) {
      const member = { schemaVersion: 1, ...memberBase, memberDigest: digest(memberBase) };
      const memberValue = toJsonValue(member);
      const entry = {
        id: `execution:${member.executionId}:${member.executionDigest}`,
        digest: digest(memberValue),
        value: memberValue,
      };
      const corruptedStore: LearningStore = {
        get: (key) =>
          key.kind === groupKey.kind && key.id === groupKey.id
            ? Promise.resolve({
                ...original,
                value: [entry],
                digest: digest([entry.id]),
              })
            : base.get(key),
        create: (key, value, exactDigest, operationId) => base.create(key, value, exactDigest, operationId),
        compareAndSet: (key, expectedRevision, value, exactDigest, operationId) =>
          base.compareAndSet(key, expectedRevision, value, exactDigest, operationId),
        append: (stream, expectedRevision, entries, operationId) =>
          base.append(stream, expectedRevision, entries, operationId),
        tombstone: (input) => base.tombstone(input),
        list: (query) => base.list(query),
      };
      await expect(
        recurrenceForExecution(replaceContextStore(harness.context, corruptedStore), facts.execution, undefined),
      ).rejects.toMatchObject({ code: "store.corrupt" });
    }
  });

  it("rejects self-consistent binding/member episode lineage that differs from the exact execution", async () => {
    const base = createInMemoryStore();
    const harness = await createSemanticEngineHarness({ store: base });
    const facts = createSemanticFacts(harness);
    await persistDetectorExecution(harness.context, facts.execution, [facts.derivation], PRIVATE_LOCATOR);
    const binding = await loadExecutionRecurrenceBinding(harness.context, facts.execution.id);
    if (binding === undefined) throw new Error("expected exact recurrence binding");
    const groupedBinding = requireGroupedBinding(binding);
    const bindingContent = {
      executionId: groupedBinding.executionId,
      executionKeyDigest: groupedBinding.executionKeyDigest,
      executionDigest: groupedBinding.executionDigest,
      detector: groupedBinding.detector,
      pack: groupedBinding.pack,
      lens: groupedBinding.lens,
      scope: groupedBinding.scope,
      scopeDigest: groupedBinding.scopeDigest,
      scopePolicyDigest: groupedBinding.scopePolicyDigest,
      locator: groupedBinding.locator,
      groupKeyDigest: groupedBinding.groupKeyDigest,
      memberEpisodes: groupedBinding.memberEpisodes.map((episode, index) =>
        index === 0 ? { ...episode, episodeIdentityDigest: "3".repeat(64) } : episode,
      ),
    };
    const changedBinding: GroupedBinding = {
      schemaVersion: 1,
      ...bindingContent,
      bindingDigest: digest(bindingContent),
    };
    const changedMember = memberForBinding(changedBinding);
    const changedEntry = entryForMember(changedMember);
    const bindingValue = toJsonValue(changedBinding);
    const originalBinding = await base.get({
      namespace: "learning",
      kind: "detector-recurrence-binding",
      id: groupedBinding.executionId,
    });
    const originalGroup = await base.get({
      namespace: "learning",
      kind: "detector-recurrence-group",
      id: groupedBinding.groupKeyDigest,
    });
    if (originalBinding === undefined || originalGroup === undefined) throw new Error("expected recurrence graph");
    const changedStore: LearningStore = {
      get: (key) => {
        if (key.kind === "detector-recurrence-binding" && key.id === groupedBinding.executionId) {
          return Promise.resolve({ ...originalBinding, value: bindingValue, digest: digest(bindingValue) });
        }
        if (key.kind === "detector-recurrence-group" && key.id === groupedBinding.groupKeyDigest) {
          return Promise.resolve({ ...originalGroup, value: [changedEntry], digest: digest([changedEntry.id]) });
        }
        return base.get(key);
      },
      create: (key, value, exactDigest, operationId) => base.create(key, value, exactDigest, operationId),
      compareAndSet: (key, expectedRevision, value, exactDigest, operationId) =>
        base.compareAndSet(key, expectedRevision, value, exactDigest, operationId),
      append: (stream, expectedRevision, entries, operationId) =>
        base.append(stream, expectedRevision, entries, operationId),
      tombstone: (input) => base.tombstone(input),
      list: (query) => base.list(query),
    };
    await expect(
      recurrenceForExecution(replaceContextStore(harness.context, changedStore), facts.execution, undefined),
    ).rejects.toMatchObject({ code: "store.corrupt" });
  });

  it("rejects empty, unsorted, duplicate-identity, and duplicate-view binding episode lineage as store corruption", async () => {
    const base = createInMemoryStore();
    const harness = await createSemanticEngineHarness({ store: base });
    const facts = createSemanticFacts(harness);
    await persistDetectorExecution(harness.context, facts.execution, [facts.derivation], PRIVATE_LOCATOR);
    const binding = await loadExecutionRecurrenceBinding(harness.context, facts.execution.id);
    if (binding === undefined) throw new Error("expected stored recurrence binding");
    const first = {
      episodeRecordId: "manual-evidence/a-episode",
      episodeIdentityDigest: "1".repeat(64),
      episodeViewDigest: "3".repeat(64),
    };
    const second = {
      episodeRecordId: "manual-evidence/b-episode",
      episodeIdentityDigest: "2".repeat(64),
      episodeViewDigest: "4".repeat(64),
    };
    const variants = [
      [],
      [second, first],
      [first, { ...second, episodeIdentityDigest: first.episodeIdentityDigest }],
      [first, { ...second, episodeViewDigest: first.episodeViewDigest }],
    ];
    const original = await base.get({
      namespace: "learning",
      kind: "detector-recurrence-binding",
      id: binding.executionId,
    });
    if (original === undefined) throw new Error("expected stored binding bytes");
    for (const memberEpisodes of variants) {
      const content = {
        executionId: binding.executionId,
        executionKeyDigest: binding.executionKeyDigest,
        executionDigest: binding.executionDigest,
        detector: binding.detector,
        pack: binding.pack,
        lens: binding.lens,
        scope: binding.scope,
        scopeDigest: binding.scopeDigest,
        scopePolicyDigest: binding.scopePolicyDigest,
        locator: binding.locator,
        groupKeyDigest: binding.groupKeyDigest,
        memberEpisodes,
      };
      const changed = { schemaVersion: 1, ...content, bindingDigest: digest(content) };
      const value = toJsonValue(changed);
      const changedStore: LearningStore = {
        get: (key) =>
          key.kind === "detector-recurrence-binding" && key.id === binding.executionId
            ? Promise.resolve({ ...original, value, digest: digest(value) })
            : base.get(key),
        create: (key, exactValue, exactDigest, operationId) => base.create(key, exactValue, exactDigest, operationId),
        compareAndSet: (key, expectedRevision, exactValue, exactDigest, operationId) =>
          base.compareAndSet(key, expectedRevision, exactValue, exactDigest, operationId),
        append: (stream, expectedRevision, entries, operationId) =>
          base.append(stream, expectedRevision, entries, operationId),
        tombstone: (input) => base.tombstone(input),
        list: (query) => base.list(query),
      };
      await expect(
        recurrenceForExecution(replaceContextStore(harness.context, changedStore), facts.execution, undefined),
      ).rejects.toMatchObject({ code: "store.corrupt" });
    }
  });

  it("orders episode members by raw record id and rejects duplicate record ids with changed lineage", async () => {
    const base = createInMemoryStore();
    const harness = await createSemanticEngineHarness({ store: base });
    const facts = createSemanticFacts(harness);
    await persistDetectorExecution(harness.context, facts.execution, [facts.derivation], PRIVATE_LOCATOR);
    const binding = await loadExecutionRecurrenceBinding(harness.context, facts.execution.id);
    if (binding === undefined) throw new Error("expected recurrence ordering binding");
    const quoted = {
      episodeRecordId: 'manual-evidence/episode"quoted',
      episodeIdentityDigest: "1".repeat(64),
      episodeViewDigest: "3".repeat(64),
    };
    const hashed = {
      episodeRecordId: "manual-evidence/episode#hashed",
      episodeIdentityDigest: "2".repeat(64),
      episodeViewDigest: "4".repeat(64),
    };
    expect(quoted.episodeRecordId < hashed.episodeRecordId).toBe(true);
    const original = await base.get({
      namespace: "learning",
      kind: "detector-recurrence-binding",
      id: binding.executionId,
    });
    if (original === undefined) throw new Error("expected recurrence ordering bytes");
    const storeFor = (memberEpisodes: readonly (typeof quoted)[]): LearningStore => {
      const content = {
        executionId: binding.executionId,
        executionKeyDigest: binding.executionKeyDigest,
        executionDigest: binding.executionDigest,
        detector: binding.detector,
        pack: binding.pack,
        lens: binding.lens,
        scope: binding.scope,
        scopeDigest: binding.scopeDigest,
        scopePolicyDigest: binding.scopePolicyDigest,
        locator: binding.locator,
        groupKeyDigest: binding.groupKeyDigest,
        memberEpisodes,
      };
      const changed = { schemaVersion: 1, ...content, bindingDigest: digest(content) };
      const value = toJsonValue(changed);
      return {
        get: (key) =>
          key.kind === "detector-recurrence-binding" && key.id === binding.executionId
            ? Promise.resolve({ ...original, value, digest: digest(value) })
            : base.get(key),
        create: (key, exactValue, exactDigest, operationId) => base.create(key, exactValue, exactDigest, operationId),
        compareAndSet: (key, expectedRevision, exactValue, exactDigest, operationId) =>
          base.compareAndSet(key, expectedRevision, exactValue, exactDigest, operationId),
        append: (stream, expectedRevision, entries, operationId) =>
          base.append(stream, expectedRevision, entries, operationId),
        tombstone: (input) => base.tombstone(input),
        list: (query) => base.list(query),
      };
    };
    await expect(
      loadExecutionRecurrenceBinding(
        replaceContextStore(harness.context, storeFor([quoted, hashed])),
        binding.executionId,
      ),
    ).resolves.toMatchObject({ memberEpisodes: [quoted, hashed] });

    const duplicateRecordId = { ...hashed, episodeRecordId: quoted.episodeRecordId };
    await expect(
      loadExecutionRecurrenceBinding(
        replaceContextStore(harness.context, storeFor([quoted, duplicateRecordId])),
        binding.executionId,
      ),
    ).rejects.toMatchObject({ code: "store.corrupt" });
  });
});

describe("bounded recurrence folds", () => {
  it("counts exact committed executions separately while deduplicating episode identity digests", async () => {
    const harness = await createSemanticEngineHarness();
    const facts = createSemanticFacts(harness);
    const sharedIdentity = digest({ sharedEpisodeIdentity: true });
    const executions = [
      executionWithEpisodeIdentities(facts.execution, [sharedIdentity], "shared-a"),
      executionWithEpisodeIdentities(facts.execution, [sharedIdentity], "shared-b"),
    ];
    const bindings = executions.map((execution) => bindingForExecution(execution, PRIVATE_LOCATOR));
    await Promise.all(bindings.map((binding) => seedBinding(harness.store, binding)));
    await Promise.all(
      executions.map(async (execution) => {
        const value = toJsonValue(execution);
        await harness.store.create(
          { namespace: "learning", kind: "detector-execution", id: execution.id },
          value,
          digest(value),
          `seed-shared-execution/${execution.id}`,
        );
      }),
    );
    await seedGroup(harness.store, bindings[0]?.groupKeyDigest ?? "missing", bindings.map(memberForBinding));
    await expect(recurrenceForExecution(harness.context, executions[0], undefined)).resolves.toMatchObject({
      status: "grouped",
      executionCount: 2,
      distinctEpisodeCount: 1,
    });
  });

  it("accepts exactly 5,000 member entries and fails closed at 5,001 without truncating", async () => {
    const harness = await createSemanticEngineHarness();
    const facts = createSemanticFacts(harness);
    const template = bindingForExecution(facts.execution, PRIVATE_LOCATOR);
    const bindings = [template, ...Array.from({ length: 4_999 }, (_, index) => orphanBinding(template, index))];
    await Promise.all(bindings.map((binding) => seedBinding(harness.store, binding)));
    await seedGroup(harness.store, template.groupKeyDigest, bindings.map(memberForBinding));

    await expect(prepareExecutionRecurrence(harness.context, facts.execution, PRIVATE_LOCATOR)).resolves.toMatchObject({
      groupKeyDigest: template.groupKeyDigest,
    });

    const extra = orphanBinding(template, 5_000);
    await seedBinding(harness.store, extra);
    const stored = await harness.store.get({
      namespace: "learning",
      kind: "detector-recurrence-group",
      id: template.groupKeyDigest,
    });
    if (stored === undefined) throw new Error("expected seeded recurrence group");
    await harness.store.append(
      { namespace: "learning", kind: "detector-recurrence-group", id: template.groupKeyDigest },
      stored.revision,
      [entryForMember(memberForBinding(extra))],
      "seed-group/member-5001",
    );
    await expect(prepareExecutionRecurrence(harness.context, facts.execution, PRIVATE_LOCATOR)).rejects.toMatchObject({
      code: "detector.limit_exceeded",
    });
  }, 30_000);

  it("accepts 5,000 distinct committed episode identities and refuses a 5,001st", async () => {
    const harness = await createSemanticEngineHarness();
    const facts = createSemanticFacts(harness);
    const currentIdentity = facts.execution.window.population.episodes[0]?.episodeIdentityDigest;
    if (currentIdentity === undefined) throw new Error("expected current episode identity");
    const identities = [
      currentIdentity,
      ...Array.from({ length: 4_999 }, (_, index) => digest({ episodeIdentity: index })),
    ];
    const executions = Array.from({ length: 10 }, (_, index) =>
      executionWithEpisodeIdentities(
        facts.execution,
        identities.slice(index * 500, (index + 1) * 500),
        `fold-${index}`,
      ),
    );
    const bindings = executions.map((execution) => bindingForExecution(execution, PRIVATE_LOCATOR));
    expect(new Set(bindings.map((binding) => binding.groupKeyDigest))).toEqual(
      new Set([detectorRecurrenceGroupKeyDigest(facts.execution, PRIVATE_LOCATOR)]),
    );
    await Promise.all(bindings.map((binding) => seedBinding(harness.store, binding)));
    await Promise.all(
      executions.map(async (execution) => {
        const value = toJsonValue(execution);
        await harness.store.create(
          { namespace: "learning", kind: "detector-execution", id: execution.id },
          value,
          digest(value),
          `seed-execution/${execution.id}`,
        );
      }),
    );
    await seedGroup(harness.store, bindings[0]?.groupKeyDigest ?? "missing", bindings.map(memberForBinding));

    await expect(prepareExecutionRecurrence(harness.context, facts.execution, PRIVATE_LOCATOR)).resolves.toBeDefined();
    const newIdentityExecution = executionWithEpisodeIdentities(
      facts.execution,
      [digest({ episodeIdentity: "new" })],
      "fold-new",
    );
    await expect(
      prepareExecutionRecurrence(harness.context, newIdentityExecution, PRIVATE_LOCATOR),
    ).rejects.toMatchObject({ code: "detector.limit_exceeded" });
  }, 30_000);

  it("accepts 50,000 total episode references and fails closed at 50,001", async () => {
    const harness = await createSemanticEngineHarness();
    const facts = createSemanticFacts(harness);
    const identities = Array.from({ length: 500 }, (_, index) => digest({ repeatedEpisodeIdentity: index }));
    const execution = executionWithEpisodeIdentities(facts.execution, identities, "reference-fold");
    const template = bindingForExecution(execution, PRIVATE_LOCATOR);
    const bindings = [
      template,
      ...Array.from({ length: 99 }, (_, index) => orphanBinding(template, index, template.memberEpisodes)),
    ];
    await Promise.all(bindings.map((binding) => seedBinding(harness.store, binding)));
    await seedGroup(harness.store, template.groupKeyDigest, bindings.map(memberForBinding));
    await expect(prepareExecutionRecurrence(harness.context, execution, PRIVATE_LOCATOR)).resolves.toBeDefined();

    const extra = orphanBinding(template, 100, [
      template.memberEpisodes[0] ?? {
        episodeRecordId: "manual-evidence/reference-extra",
        episodeIdentityDigest: identities[0] ?? "0".repeat(64),
        episodeViewDigest: "1".repeat(64),
      },
    ]);
    await seedBinding(harness.store, extra);
    const stored = await harness.store.get({
      namespace: "learning",
      kind: "detector-recurrence-group",
      id: template.groupKeyDigest,
    });
    if (stored === undefined) throw new Error("expected recurrence reference group");
    await harness.store.append(
      { namespace: "learning", kind: "detector-recurrence-group", id: template.groupKeyDigest },
      stored.revision,
      [entryForMember(memberForBinding(extra))],
      "seed-group/reference-50001",
    );
    await expect(prepareExecutionRecurrence(harness.context, execution, PRIVATE_LOCATOR)).rejects.toMatchObject({
      code: "detector.limit_exceeded",
    });
  });

  it("applies member and reference ceilings to a binding-only orphan dry preview", async () => {
    const memberHarness = await createSemanticEngineHarness();
    const memberFacts = createSemanticFacts(memberHarness);
    const targetBinding = bindingForExecution(memberFacts.execution, PRIVATE_LOCATOR);
    await seedBinding(memberHarness.store, targetBinding);
    const otherBindings = Array.from({ length: 5_000 }, (_, index) => orphanBinding(targetBinding, index));
    await Promise.all(otherBindings.map((binding) => seedBinding(memberHarness.store, binding)));
    await seedGroup(memberHarness.store, targetBinding.groupKeyDigest, otherBindings.map(memberForBinding));
    await expect(
      recurrenceForExecution(memberHarness.context, memberFacts.execution, PRIVATE_LOCATOR),
    ).rejects.toMatchObject({ code: "detector.limit_exceeded" });

    const referenceHarness = await createSemanticEngineHarness();
    const referenceFacts = createSemanticFacts(referenceHarness);
    const identities = Array.from({ length: 500 }, (_, index) => digest({ orphanReferenceIdentity: index }));
    const referenceExecution = executionWithEpisodeIdentities(
      referenceFacts.execution,
      identities,
      "orphan-reference-fold",
    );
    const referenceTarget = bindingForExecution(referenceExecution, PRIVATE_LOCATOR);
    await seedBinding(referenceHarness.store, referenceTarget);
    const referenceBindings = Array.from({ length: 100 }, (_, index) =>
      orphanBinding(referenceTarget, index, referenceTarget.memberEpisodes),
    );
    await Promise.all(referenceBindings.map((binding) => seedBinding(referenceHarness.store, binding)));
    await seedGroup(referenceHarness.store, referenceTarget.groupKeyDigest, referenceBindings.map(memberForBinding));
    await expect(
      recurrenceForExecution(referenceHarness.context, referenceExecution, PRIVATE_LOCATOR),
    ).rejects.toMatchObject({ code: "detector.limit_exceeded" });
  }, 30_000);
});
