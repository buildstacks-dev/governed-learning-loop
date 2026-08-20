// #30c2b2 receipt-last pack audit persistence: policy/mode eligibility,
// retry normalization, crash recovery, partial attempts, and key conflicts.
import { describe, expect, it } from "vitest";
import type { DetectorPackRunReceipt, LearningStore } from "../src/index.js";
import { parseDetectorPackRunReceipt, scopeDigest } from "../src/index.js";
import { persistDetectorPackRunReceipt } from "../src/engine/detector-pack-receipt.js";
import {
  detectorPackRunGovernanceSnapshotDigest,
  detectorPackRunItemDigest,
  detectorPackRunKeyDigest,
  detectorPackRunPopulationDigest,
  detectorPackRunReceiptDigest,
} from "../src/records/detector-pack-run-receipt.js";
import { createInMemoryStore } from "../src/testing/index.js";
import {
  PRIVATE_LOCATOR,
  createDetectorOrchestrationPolicy,
  createRecurrenceRunnerHarness,
  detectedInsightDraft,
  packRef,
} from "./detector-recurrence-harness.js";
import { SEMANTIC_SCOPE_B } from "./semantic-engine-harness.js";

const ACKNOWLEDGEMENT_POINTS: readonly ("before" | "after")[] = ["before", "after"];

async function countKind(store: LearningStore, kind: string): Promise<number> {
  return (await store.list({ namespace: "learning", kind, limit: 100 })).records.length;
}

async function scopeIndexes(store: LearningStore, exactScopeDigest: string) {
  return (
    await store.list({
      namespace: `learning-pack-run-scope-${exactScopeDigest}`,
      kind: "detector-pack-run-index",
      limit: 100,
    })
  ).records;
}

function receiptFailureStore(base: LearningStore, acknowledgement: "before" | "after"): LearningStore {
  let failed = false;
  return {
    get: (key) => base.get(key),
    create: async (key, value, digest, operationId) => {
      if (!failed && key.kind === "detector-pack-run-receipt" && acknowledgement === "before") {
        failed = true;
        throw new Error("failed before pack receipt create");
      }
      const result = await base.create(key, value, digest, operationId);
      if (!failed && key.kind === "detector-pack-run-receipt" && acknowledgement === "after") {
        failed = true;
        throw new Error("lost pack receipt acknowledgement");
      }
      return result;
    },
    compareAndSet: (key, expectedRevision, value, digest, operationId) =>
      base.compareAndSet(key, expectedRevision, value, digest, operationId),
    append: (stream, expectedRevision, entries, operationId) =>
      base.append(stream, expectedRevision, entries, operationId),
    tombstone: (input) => base.tombstone(input),
    list: (query) => base.list(query),
  };
}

function indexFailureStore(base: LearningStore, acknowledgement: "before" | "after"): LearningStore {
  let failed = false;
  return {
    get: (key) => base.get(key),
    create: async (key, value, digest, operationId) => {
      if (!failed && key.kind === "detector-pack-run-index" && acknowledgement === "before") {
        failed = true;
        throw new Error("failed before pack index create");
      }
      const result = await base.create(key, value, digest, operationId);
      if (!failed && key.kind === "detector-pack-run-index" && acknowledgement === "after") {
        failed = true;
        throw new Error("lost pack index acknowledgement");
      }
      return result;
    },
    compareAndSet: (key, expectedRevision, value, digest, operationId) =>
      base.compareAndSet(key, expectedRevision, value, digest, operationId),
    append: (stream, expectedRevision, entries, operationId) =>
      base.append(stream, expectedRevision, entries, operationId),
    tombstone: (input) => base.tombstone(input),
    list: (query) => base.list(query),
  };
}

function rebuildReceipt(input: DetectorPackRunReceipt): DetectorPackRunReceipt {
  const populationBase = {
    requestedEpisodeRecordIds: input.population.requestedEpisodeRecordIds,
    resolvedEpisodes: input.population.resolvedEpisodes,
  };
  const population = { ...populationBase, populationDigest: detectorPackRunPopulationDigest(populationBase) };
  const items = input.items.map((item) => {
    const { itemDigest: _itemDigest, ...base } = item;
    return { ...base, itemDigest: detectorPackRunItemDigest(base) };
  });
  const base = {
    loopRegistryRevision: input.loopRegistryRevision,
    semanticRegistryDigest: input.semanticRegistryDigest,
    policy: input.policy,
    pack: input.pack,
    scope: input.scope,
    scopeDigest: input.scopeDigest,
    scopePolicyDigest: input.scopePolicyDigest,
    population,
    governanceSnapshotDigest: detectorPackRunGovernanceSnapshotDigest(items),
    items,
    status: input.status,
  };
  const packRunKeyDigest = detectorPackRunKeyDigest(base);
  const receiptBase = { ...base, packRunKeyDigest };
  return parseDetectorPackRunReceipt({
    schemaVersion: 1,
    id: `detector-pack-run-${packRunKeyDigest}`,
    ...receiptBase,
    receiptDigest: detectorPackRunReceiptDigest(receiptBase),
  });
}

describe("detector pack-run receipt eligibility", () => {
  it("writes no receipt for legacy, dry, missing, or wrong-scope runs while allowing an exact empty population", async () => {
    const legacy = await createRecurrenceRunnerHarness({
      label: "receipt-legacy",
      evaluate: (window) => detectedInsightDraft(window, PRIVATE_LOCATOR),
    });
    const legacyResult = await legacy.learning.runDetectorPack({
      mode: "commit",
      pack: packRef(legacy.pack),
      scope: legacy.scope,
      episodeRecordIds: legacy.episodeRecordIds,
    });
    expect(legacyResult.receipt).toBeUndefined();
    expect(await countKind(legacy.store, "detector-pack-run-receipt")).toBe(0);

    const configured = await createRecurrenceRunnerHarness({
      label: "receipt-eligibility",
      detectorOrchestrationPolicy: createDetectorOrchestrationPolicy(),
      evaluate: (window) => detectedInsightDraft(window, PRIVATE_LOCATOR),
    });
    const dry = await configured.learning.runDetectorPack({
      mode: "dry_run",
      pack: packRef(configured.pack),
      scope: configured.scope,
      episodeRecordIds: configured.episodeRecordIds,
    });
    expect(dry.receipt).toBeUndefined();

    const missing = await configured.learning.runDetectorPack({
      mode: "commit",
      pack: packRef(configured.pack),
      scope: configured.scope,
      episodeRecordIds: ["missing-source/missing-episode"],
    });
    expect(missing.receipt).toBeUndefined();
    const wrongScope = await configured.learning.runDetectorPack({
      mode: "commit",
      pack: packRef(configured.pack),
      scope: SEMANTIC_SCOPE_B,
      episodeRecordIds: configured.episodeRecordIds,
    });
    expect(wrongScope.receipt).toBeUndefined();
    expect(await countKind(configured.store, "detector-pack-run-receipt")).toBe(0);
    expect(await scopeIndexes(configured.store, scopeDigest(configured.scope))).toEqual([]);

    const empty = await configured.learning.runDetectorPack({
      mode: "commit",
      pack: packRef(configured.pack),
      scope: configured.scope,
      episodeRecordIds: [],
    });
    expect(empty.receipt).toMatchObject({
      population: { requestedEpisodeRecordIds: [], resolvedEpisodes: [] },
    });
  });
});

describe("detector pack-run receipt retry and conflicts", () => {
  it("normalizes first-commit and retry-existing children to the same exact receipt", async () => {
    const harness = await createRecurrenceRunnerHarness({
      label: "receipt-retry-normalization",
      detectorOrchestrationPolicy: createDetectorOrchestrationPolicy(),
      evaluate: (window) => detectedInsightDraft(window, PRIVATE_LOCATOR),
    });
    const input = {
      pack: packRef(harness.pack),
      scope: harness.scope,
      episodeRecordIds: harness.episodeRecordIds,
    };
    const first = await harness.learning.runDetectorPack({ mode: "commit", ...input });
    const retry = await harness.learning.runDetectorPack({ mode: "commit", ...input });
    expect(first.items[0]).toMatchObject({ disposition: "executed", callbackInvoked: true });
    expect(retry.items[0]).toMatchObject({ disposition: "existing", callbackInvoked: false });
    expect(retry.receipt).toEqual(first.receipt);
    expect(retry.receipt?.items[0]).toMatchObject({ executionDisposition: "executed" });
    expect(JSON.stringify(retry.receipt)).not.toContain("callbackInvoked");
    expect(JSON.stringify(retry.receipt)).not.toContain('"existing"');
    expect(await countKind(harness.store, "detector-pack-run-receipt")).toBe(1);
  });

  for (const acknowledgement of ACKNOWLEDGEMENT_POINTS) {
    it(`recovers deterministically when receipt creation fails ${acknowledgement} acknowledgement`, async () => {
      const base = createInMemoryStore();
      const harness = await createRecurrenceRunnerHarness({
        store: receiptFailureStore(base, acknowledgement),
        label: `receipt-crash-${acknowledgement}`,
        detectorOrchestrationPolicy: createDetectorOrchestrationPolicy(),
        evaluate: (window) => detectedInsightDraft(window, PRIVATE_LOCATOR),
      });
      const mode: "commit" = "commit";
      const input = {
        mode,
        pack: packRef(harness.pack),
        scope: harness.scope,
        episodeRecordIds: harness.episodeRecordIds,
      };
      await expect(harness.learning.runDetectorPack(input)).rejects.toThrowError(
        acknowledgement === "before" ? "failed before pack receipt create" : "lost pack receipt acknowledgement",
      );
      const indexes = await scopeIndexes(base, scopeDigest(harness.scope));
      expect(indexes).toHaveLength(1);
      expect(await countKind(base, "detector-pack-run-receipt")).toBe(acknowledgement === "before" ? 0 : 1);
      const retried = await harness.learning.runDetectorPack(input);
      expect(retried.receipt).toMatchObject({ receiptDigest: expect.any(String) });
      expect(await countKind(base, "detector-pack-run-receipt")).toBe(1);
      expect(await scopeIndexes(base, scopeDigest(harness.scope))).toHaveLength(1);
      expect(harness.callbacks()).toBe(1);
    });
  }

  for (const acknowledgement of ACKNOWLEDGEMENT_POINTS) {
    it(`recovers deterministically when scope-index creation fails ${acknowledgement} acknowledgement`, async () => {
      const base = createInMemoryStore();
      const harness = await createRecurrenceRunnerHarness({
        store: indexFailureStore(base, acknowledgement),
        label: `receipt-index-crash-${acknowledgement}`,
        detectorOrchestrationPolicy: createDetectorOrchestrationPolicy(),
        evaluate: (window) => detectedInsightDraft(window, PRIVATE_LOCATOR),
      });
      const mode: "commit" = "commit";
      const input = {
        mode,
        pack: packRef(harness.pack),
        scope: harness.scope,
        episodeRecordIds: harness.episodeRecordIds,
      };
      await expect(harness.learning.runDetectorPack(input)).rejects.toThrowError(
        acknowledgement === "before" ? "failed before pack index create" : "lost pack index acknowledgement",
      );
      expect(await countKind(base, "detector-pack-run-receipt")).toBe(0);
      expect(await scopeIndexes(base, scopeDigest(harness.scope))).toHaveLength(acknowledgement === "before" ? 0 : 1);
      const retried = await harness.learning.runDetectorPack(input);
      expect(retried.receipt).toBeDefined();
      expect(await countKind(base, "detector-pack-run-receipt")).toBe(1);
      expect(await scopeIndexes(base, scopeDigest(harness.scope))).toHaveLength(1);
      expect(harness.callbacks()).toBe(1);
    });
  }

  it("converges concurrent identical configured commits to one exact receipt", async () => {
    const harness = await createRecurrenceRunnerHarness({
      label: "receipt-concurrent",
      detectorOrchestrationPolicy: createDetectorOrchestrationPolicy(),
      evaluate: (window) => detectedInsightDraft(window, PRIVATE_LOCATOR),
    });
    const mode: "commit" = "commit";
    const input = {
      mode,
      pack: packRef(harness.pack),
      scope: harness.scope,
      episodeRecordIds: harness.episodeRecordIds,
    };
    const [left, right] = await Promise.all([
      harness.learning.runDetectorPack(input),
      harness.learning.runDetectorPack(input),
    ]);
    expect(left.receipt).toEqual(right.receipt);
    expect(await countKind(harness.store, "detector-pack-run-receipt")).toBe(1);
    expect(await scopeIndexes(harness.store, scopeDigest(harness.scope))).toHaveLength(1);
  });

  it("persists a refused partial attempt using only static reason codes", async () => {
    const harness = await createRecurrenceRunnerHarness({
      label: "receipt-refused",
      detectorOrchestrationPolicy: createDetectorOrchestrationPolicy(),
      evaluate: () => {
        throw new Error("PRIVATE-CALLBACK-CANARY");
      },
    });
    const result = await harness.learning.runDetectorPack({
      mode: "commit",
      pack: packRef(harness.pack),
      scope: harness.scope,
      episodeRecordIds: harness.episodeRecordIds,
    });
    expect(result).toMatchObject({
      status: "partial",
      receipt: {
        status: "partial",
        items: [
          {
            executionDisposition: "refused",
            executionRef: null,
            recurrence: { status: "absent", reason: "result_not_retained" },
            reasonCodes: ["detector.callback_failed"],
          },
        ],
      },
    });
    expect(JSON.stringify(result.receipt)).not.toContain("PRIVATE-CALLBACK-CANARY");
  });

  it("rejects a second full receipt for the same exact pack-run key", async () => {
    const harness = await createRecurrenceRunnerHarness({
      label: "receipt-conflict",
      detectorOrchestrationPolicy: createDetectorOrchestrationPolicy(),
      evaluate: (window) => detectedInsightDraft(window, PRIVATE_LOCATOR),
    });
    const result = await harness.learning.runDetectorPack({
      mode: "commit",
      pack: packRef(harness.pack),
      scope: harness.scope,
      episodeRecordIds: harness.episodeRecordIds,
    });
    const receipt = result.receipt;
    const item = receipt?.items[0];
    if (receipt === undefined || item === undefined || item.recurrence.status !== "grouped") {
      throw new Error("expected conflict receipt");
    }
    const alternate = rebuildReceipt({
      ...receipt,
      items: [
        {
          ...item,
          recurrence: {
            ...item.recurrence,
            locator: { ...PRIVATE_LOCATOR, keyedDigest: "e".repeat(64) },
          },
        },
      ],
    });
    expect(alternate.packRunKeyDigest).toBe(receipt.packRunKeyDigest);
    expect(alternate.receiptDigest).not.toBe(receipt.receiptDigest);
    await expect(persistDetectorPackRunReceipt(harness.context, alternate)).rejects.toMatchObject({
      code: "semantic.pack_run_conflict",
    });
  });
});
