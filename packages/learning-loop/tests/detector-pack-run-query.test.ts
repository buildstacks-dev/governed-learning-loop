// #30c2b2 exact-scope pack-run audit reads: bounded filters/cursors, current
// and historical views, child validation, and project-isolated page identity.
import { describe, expect, it } from "vitest";
import type { DetectorPackRunReceipt, LearningStore, QueryPage } from "../src/index.js";
import { conservativePolicy, createLearningLoop, parseDetectorPackRunReceipt, scopeDigest } from "../src/index.js";
import type { EngineContext } from "../src/engine/context.js";
import { loadDetectorPackRunView, runGetDetectorPackRun } from "../src/engine/detector-pack-query.js";
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

async function pagesOf<T>(iterable: AsyncIterable<QueryPage<T>>): Promise<readonly QueryPage<T>[]> {
  const pages: QueryPage<T>[] = [];
  for await (const page of iterable) pages.push(page);
  return pages;
}

async function itemsOf<T>(iterable: AsyncIterable<QueryPage<T>>): Promise<readonly T[]> {
  return (await pagesOf(iterable)).flatMap((page) => page.items);
}

function isAsyncIterable(input: unknown): input is AsyncIterable<unknown> {
  return (
    typeof input === "object" &&
    input !== null &&
    Symbol.asyncIterator in input &&
    typeof input[Symbol.asyncIterator] === "function"
  );
}

function isQueryPage(input: unknown): input is QueryPage<unknown> {
  return (
    typeof input === "object" &&
    input !== null &&
    "items" in input &&
    Array.isArray(input.items) &&
    "snapshotRevision" in input &&
    typeof input.snapshotRevision === "string"
  );
}

async function* invokeUnknownQuery(
  method: (input: never) => unknown,
  input: unknown,
): AsyncIterable<QueryPage<unknown>> {
  const output: unknown = Reflect.apply(method, undefined, [input]);
  if (!isAsyncIterable(output)) throw new Error("pack-run query fixture returned another type");
  for await (const page of output) {
    if (!isQueryPage(page)) throw new Error("pack-run query fixture returned a malformed page");
    yield page;
  }
}

function replaceContextStore(context: EngineContext, store: LearningStore): EngineContext {
  return { ...context, store };
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

function numberedDigest(value: number): string {
  return value.toString(16).padStart(64, "0");
}

function receiptWithCandidateBindings(
  receipt: DetectorPackRunReceipt,
  counts: readonly number[],
  prefix: string,
): DetectorPackRunReceipt {
  const item = receipt.items[0];
  if (item === undefined || item.recurrence.status !== "grouped") {
    throw new Error("candidate-binding query fixture requires a grouped receipt");
  }
  const recurrence = item.recurrence;
  let candidateIndex = 1;
  const items = counts.map((count, groupIndex) => {
    const candidateBindings = Array.from({ length: count }, () => {
      const number = candidateIndex;
      candidateIndex += 1;
      const derivationDigest = numberedDigest(200_000 + number);
      return {
        candidateId: `${prefix}-${String(number).padStart(5, "0")}`,
        candidateDigest: numberedDigest(number),
        claimDigest: numberedDigest(100_000 + number),
        derivationId: `insight-${derivationDigest}`,
        derivationDigest,
        episodeIdentitySetDigest: recurrence.episodeIdentitySetDigest,
        distinctEpisodeCount: 1,
        supersedes: null,
        latestReview: null,
      };
    });
    const executionKeyDigest = numberedDigest(400_000 + groupIndex);
    return {
      ...item,
      detector: { ...item.detector, id: `${prefix}-detector-${String(groupIndex).padStart(3, "0")}` },
      executionRef: {
        id: `detector-execution-${executionKeyDigest}`,
        executionKeyDigest,
        executionDigest: numberedDigest(300_000 + groupIndex),
      },
      recurrence: {
        ...recurrence,
        groupKeyDigest: numberedDigest(500_000 + groupIndex),
        decisionBindingDigest: numberedDigest(600_000 + groupIndex),
        governance: {
          status: "assessed" as const,
          candidateBindings,
          groupDisposition: count === 0 ? ("available" as const) : ("deduplicated" as const),
          requiredSupersedes: null,
          requiredOverrideCount: null,
          governingRejection: null,
          reasonCodes: [count === 0 ? "candidate.group_available" : "candidate.group_deduplicated"],
        },
      },
    };
  });
  return rebuildReceipt({
    ...receipt,
    items,
  });
}

async function queryFixture() {
  const store = createInMemoryStore();
  const policy = createDetectorOrchestrationPolicy();
  const harness = await createRecurrenceRunnerHarness({
    store,
    label: "pack-query",
    episodeCount: 2,
    detectorOrchestrationPolicy: policy,
    evaluate: (window) => detectedInsightDraft(window, PRIVATE_LOCATOR),
  });
  const receipts: DetectorPackRunReceipt[] = [];
  for (const episodeRecordId of harness.episodeRecordIds) {
    const result = await harness.learning.runDetectorPack({
      mode: "commit",
      pack: packRef(harness.pack),
      scope: harness.scope,
      episodeRecordIds: [episodeRecordId],
    });
    if (result.receipt === undefined) throw new Error("expected query receipt");
    receipts.push(result.receipt);
  }
  return { harness, policy, receipts, store };
}

describe("DetectorPackRunQuery public boundary and filters", () => {
  it("requires exact scope/limits, rejects private search fields, and binds opaque cursors", async () => {
    const { harness } = await queryFixture();
    await expect(
      pagesOf(invokeUnknownQuery(harness.learning.queryDetectorPackRuns, { limit: 10 })),
    ).rejects.toMatchObject({ code: expect.stringMatching(/^schema\.|^query\./) });
    for (const limit of [0, 501, 1.5]) {
      await expect(
        pagesOf(invokeUnknownQuery(harness.learning.queryDetectorPackRuns, { scope: harness.scope, limit })),
      ).rejects.toMatchObject({ code: "query.invalid" });
    }
    for (const forbidden of ["groupKeyDigests", "locators", "keyedDigests", "structuralLabels"]) {
      await expect(
        pagesOf(
          invokeUnknownQuery(harness.learning.queryDetectorPackRuns, {
            scope: harness.scope,
            limit: 10,
            [forbidden]: ["PRIVATE-CANARY"],
          }),
        ),
      ).rejects.toMatchObject({ code: "query.invalid" });
    }

    const first = (await pagesOf(harness.learning.queryDetectorPackRuns({ scope: harness.scope, limit: 1 })))[0];
    if (first?.nextCursor === undefined) throw new Error("expected pack-run cursor");
    const second = await pagesOf(
      harness.learning.queryDetectorPackRuns({ scope: harness.scope, cursor: first.nextCursor, limit: 1 }),
    );
    expect([...first.items, ...(second[0]?.items ?? [])]).toHaveLength(2);
    await expect(
      pagesOf(
        harness.learning.queryDetectorPackRuns({
          scope: harness.scope,
          receiptIds: [first.items[0]?.receipt.id ?? "missing"],
          cursor: first.nextCursor,
          limit: 1,
        }),
      ),
    ).rejects.toMatchObject({ code: "query.cursor_mismatch" });
    await expect(
      pagesOf(harness.learning.queryDetectorPackRuns({ scope: SEMANTIC_SCOPE_B, cursor: first.nextCursor, limit: 1 })),
    ).rejects.toMatchObject({ code: "query.cursor_mismatch" });
  });

  it("supports every exact public filter and combines them without a locator oracle", async () => {
    const { harness, policy, receipts } = await queryFixture();
    const receipt = receipts[0];
    const item = receipt?.items[0];
    if (receipt === undefined || item === undefined || item.lens === null) throw new Error("expected filter fixture");
    const matching = {
      receiptIds: [receipt.id],
      packIds: [receipt.pack.id],
      packVersions: [receipt.pack.version],
      packManifestDigests: [receipt.pack.manifestDigest],
      policyDigests: [policy.policyDigest],
      detectorIds: [item.detector.id],
      detectorRegistrationDigests: [item.detector.registrationDigest],
      lensRegistrationDigests: [item.lens.registrationDigest],
      executionDispositions: [item.executionDisposition],
      groupDispositions: [
        item.recurrence.status === "grouped" ? item.recurrence.governance.groupDisposition : "unassessed",
      ],
      recurrenceStatuses: [item.recurrence.status],
      governanceStatuses: [item.recurrence.status === "grouped" ? item.recurrence.governance.status : "not_assessed"],
      statuses: [receipt.status],
      registryStatuses: ["configured"],
      commitStatuses: ["committed"],
    } satisfies Omit<Parameters<typeof harness.learning.queryDetectorPackRuns>[0], "scope" | "limit">;
    expect(
      await itemsOf(harness.learning.queryDetectorPackRuns({ scope: harness.scope, ...matching, limit: 10 })),
    ).toHaveLength(1);

    const mismatches = [
      { receiptIds: ["detector-pack-run-missing"] },
      { packIds: ["missing-pack"] },
      { packVersions: ["9.0.0"] },
      { packManifestDigests: ["0".repeat(64)] },
      { policyDigests: ["0".repeat(64)] },
      { detectorIds: ["missing-detector"] },
      { detectorRegistrationDigests: ["0".repeat(64)] },
      { lensRegistrationDigests: ["0".repeat(64)] },
      { executionDispositions: ["refused"] },
      { groupDispositions: ["suppressed"] },
      { recurrenceStatuses: ["absent"] },
      { governanceStatuses: ["not_assessed"] },
      { statuses: ["partial"] },
      { registryStatuses: ["historical_unconfigured"] },
      { commitStatuses: ["invalid"] },
    ] satisfies readonly Omit<Parameters<typeof harness.learning.queryDetectorPackRuns>[0], "scope" | "limit">[];
    for (const mismatch of mismatches) {
      expect(
        await itemsOf(harness.learning.queryDetectorPackRuns({ scope: harness.scope, ...mismatch, limit: 10 })),
      ).toEqual([]);
    }
  });

  it("accepts exactly 50,000 embedded Candidate bindings per page and fails closed at 50,001", async () => {
    const { harness, receipts } = await queryFixture();
    const first = receipts[0];
    const second = receipts[1];
    if (first === undefined || second === undefined) throw new Error("expected two aggregate query receipts");
    const exact = receiptWithCandidateBindings(
      first,
      Array.from({ length: 10 }, () => 5_000),
      "aggregate-exact",
    );
    const excess = receiptWithCandidateBindings(second, [1], "aggregate-excess");
    await persistDetectorPackRunReceipt(harness.context, exact);

    const exactItems = await itemsOf(
      harness.learning.queryDetectorPackRuns({
        scope: harness.scope,
        receiptIds: [exact.id],
        limit: 10,
      }),
    );
    expect(exactItems).toHaveLength(1);
    expect(exactItems[0]).toMatchObject({ governanceBinding: { status: "invalid" } });
    await expect(
      harness.learning.getDetectorPackRun({ packRunReceiptId: exact.id, scope: harness.scope }),
    ).resolves.toMatchObject({ governanceBinding: { status: "invalid" } });

    await persistDetectorPackRunReceipt(harness.context, excess);
    const receiptIds = [exact.id, excess.id].sort();
    await expect(
      itemsOf(
        harness.learning.queryDetectorPackRuns({
          scope: harness.scope,
          receiptIds,
          limit: 10,
        }),
      ),
    ).rejects.toMatchObject({ code: "query.incomplete" });
  }, 30_000);
});

describe("DetectorPackRunView history, isolation, and child integrity", () => {
  it("returns configured committed current assessed views and exact-scope getters", async () => {
    const { harness, receipts } = await queryFixture();
    const receipt = receipts[receipts.length - 1];
    if (receipt === undefined) throw new Error("expected view receipt");
    const view = await harness.learning.getDetectorPackRun({ packRunReceiptId: receipt.id, scope: harness.scope });
    expect(view).toMatchObject({
      receipt: { id: receipt.id },
      registryBinding: { status: "configured" },
      policyBinding: { status: "configured" },
      commitBinding: { status: "committed" },
      governanceBinding: { status: "current" },
      evidenceHealth: { status: "ready" },
      childBindings: [{ status: "committed" }],
    });
    const serialized = JSON.stringify(view);
    for (const forbidden of [
      "authorized",
      "efficacy",
      "exposure",
      "improved",
      "preference",
      "provider",
      "published",
      "utility",
      "validated",
    ]) {
      expect(serialized).not.toContain(`"${forbidden}"`);
    }
    await expect(
      harness.learning.getDetectorPackRun({ packRunReceiptId: receipt.id, scope: SEMANTIC_SCOPE_B }),
    ).resolves.toBeUndefined();
    await expect(
      harness.learning.getDetectorPackRun({ packRunReceiptId: "detector-pack-run-missing", scope: harness.scope }),
    ).resolves.toBeUndefined();
  });

  it("keeps legacy-deferred and incomplete admitted insight governance explicitly not assessed", async () => {
    const { harness, receipts } = await queryFixture();
    const receipt = receipts[0];
    const item = receipt?.items[0];
    if (receipt === undefined || item === undefined || item.recurrence.status !== "grouped") {
      throw new Error("expected grouped not-assessed fixture");
    }
    for (const reason of [
      "candidate_claims_deferred",
      "candidate_review_history_unavailable",
      "candidate_governance_incomplete",
    ] as const) {
      const historical = rebuildReceipt({
        ...receipt,
        items: [
          {
            ...item,
            recurrence: {
              ...item.recurrence,
              governance: { status: "not_assessed", reason, groupDisposition: "unassessed" },
            },
          },
        ],
      });
      await persistDetectorPackRunReceipt(harness.context, historical);
      await expect(
        harness.learning.getDetectorPackRun({
          packRunReceiptId: historical.id,
          scope: harness.scope,
        }),
      ).resolves.toMatchObject({
        commitBinding: { status: "committed" },
        governanceBinding: { status: "not_assessed" },
      });
    }
  });

  it("keeps legacy assessed-capped governance historical without reading Candidate state", async () => {
    const { harness, receipts } = await queryFixture();
    const receipt = receipts[0];
    const item = receipt?.items[0];
    if (receipt === undefined || item === undefined || item.recurrence.status !== "grouped") {
      throw new Error("expected grouped legacy cap fixture");
    }
    const cappedPolicy = createDetectorOrchestrationPolicy({ maximumInsightGroupsPerRun: 0 });
    const legacy = rebuildReceipt({
      ...receipt,
      policy: cappedPolicy,
      status: "partial",
      items: [
        {
          ...item,
          reasonCodes: ["detector.pack_group_capped"],
          recurrence: {
            ...item.recurrence,
            governance: {
              status: "assessed",
              candidateBindings: [],
              groupDisposition: "capped",
              requiredSupersedes: null,
              requiredOverrideCount: null,
              governingRejection: null,
              reasonCodes: ["detector.pack_group_capped"],
            },
          },
        },
      ],
    });
    await persistDetectorPackRunReceipt(harness.context, legacy);
    let candidateReads = 0;
    const observed: LearningStore = {
      get: (key) => {
        if (
          key.kind === "candidate" ||
          key.kind === "candidate-recurrence-claim" ||
          key.kind === "detector-recurrence-group-candidate" ||
          key.kind === "candidate-review" ||
          key.kind === "review"
        ) {
          candidateReads += 1;
        }
        return harness.store.get(key);
      },
      create: (key, value, digest, operationId) => harness.store.create(key, value, digest, operationId),
      compareAndSet: (key, revision, value, digest, operationId) =>
        harness.store.compareAndSet(key, revision, value, digest, operationId),
      append: (stream, revision, entries, operationId) => harness.store.append(stream, revision, entries, operationId),
      tombstone: (input) => harness.store.tombstone(input),
      list: (query) => harness.store.list(query),
    };
    await expect(
      loadDetectorPackRunView(replaceContextStore(harness.context, observed), legacy),
    ).resolves.toMatchObject({
      governanceBinding: { status: "historical" },
    });
    expect(candidateReads).toBe(0);
  });

  it("resolves valid receipts as historical under another registry/policy configuration", async () => {
    const { harness, receipts, store } = await queryFixture();
    const receipt = receipts[0];
    if (receipt === undefined) throw new Error("expected historical receipt");
    const changedPolicy = createDetectorOrchestrationPolicy({ maximumInsightGroupsPerRun: 1 });
    const reader = createLearningLoop({
      store,
      policy: conservativePolicy(),
      identity: harness.context.identity,
      scopePolicy: harness.context.scopePolicy,
      contentPolicies: [...harness.context.contentPoliciesById.values()],
      sources: [...harness.context.sources],
      semanticRegistry: harness.registry,
      detectorImplementations: [...(harness.context.detectorImplementationsByRef?.values() ?? [])],
      detectorOrchestrationPolicy: changedPolicy,
      queryCursorScope: "pack-query-historical-reader",
      clock: harness.context.clock,
      ids: harness.context.ids,
    });
    const view = await reader.getDetectorPackRun({ packRunReceiptId: receipt.id, scope: harness.scope });
    expect(view).toMatchObject({
      registryBinding: { status: "historical_unconfigured" },
      policyBinding: { status: "historical_unconfigured" },
      commitBinding: { status: "committed" },
    });
    expect(
      await itemsOf(
        reader.queryDetectorPackRuns({
          scope: harness.scope,
          registryStatuses: ["historical_unconfigured"],
          commitStatuses: ["committed"],
          limit: 10,
        }),
      ),
    ).toHaveLength(2);
  });

  it("marks a missing exact child invalid and fails evidence health closed", async () => {
    const { harness, receipts, store } = await queryFixture();
    const receipt = receipts[0];
    const executionId = receipt?.items[0]?.executionRef?.id;
    if (receipt === undefined || executionId === undefined) throw new Error("expected child receipt");
    const hidingStore: LearningStore = {
      get: (key) =>
        key.kind === "detector-execution" && key.id === executionId ? Promise.resolve(undefined) : store.get(key),
      create: (key, value, digest, operationId) => store.create(key, value, digest, operationId),
      compareAndSet: (key, expectedRevision, value, digest, operationId) =>
        store.compareAndSet(key, expectedRevision, value, digest, operationId),
      append: (stream, expectedRevision, entries, operationId) =>
        store.append(stream, expectedRevision, entries, operationId),
      tombstone: (input) => store.tombstone(input),
      list: (query) => store.list(query),
    };
    const view = await loadDetectorPackRunView(replaceContextStore(harness.context, hidingStore), receipt);
    expect(view).toMatchObject({
      commitBinding: { status: "invalid" },
      childBindings: [{ executionId, status: "invalid" }],
      governanceBinding: { status: "invalid" },
      evidenceHealth: { status: "invalid" },
    });
  });

  it("keeps foreign-scope receipt/index activity out of same-scope pages and revisions", async () => {
    const { harness, receipts } = await queryFixture();
    const before = (await pagesOf(harness.learning.queryDetectorPackRuns({ scope: harness.scope, limit: 10 })))[0];
    const receipt = receipts[0];
    if (before === undefined || receipt === undefined) throw new Error("expected isolation page");
    const foreignScopeDigest = scopeDigest(SEMANTIC_SCOPE_B);
    const foreign = rebuildReceipt({
      ...receipt,
      scope: SEMANTIC_SCOPE_B,
      scopeDigest: foreignScopeDigest,
      population: {
        requestedEpisodeRecordIds: [],
        resolvedEpisodes: [],
        populationDigest: "0".repeat(64),
      },
      items: [],
      governanceSnapshotDigest: "0".repeat(64),
      status: "completed",
    });
    await persistDetectorPackRunReceipt(harness.context, foreign);
    const after = (await pagesOf(harness.learning.queryDetectorPackRuns({ scope: harness.scope, limit: 10 })))[0];
    expect(after?.items).toEqual(before.items);
    expect(after?.snapshotRevision).toBe(before.snapshotRevision);
    expect(await itemsOf(harness.learning.queryDetectorPackRuns({ scope: SEMANTIC_SCOPE_B, limit: 10 }))).toHaveLength(
      1,
    );
  });

  it("validates index/receipt keys and checks wrong scope before touching the global receipt", async () => {
    const { harness, receipts, store } = await queryFixture();
    const receipt = receipts[0];
    if (receipt === undefined) throw new Error("expected store-boundary receipt");
    const indexKey = {
      namespace: `learning-pack-run-scope-${receipt.scopeDigest}`,
      kind: "detector-pack-run-index",
      id: receipt.id,
    };
    const storedIndex = await store.get(indexKey);
    const receiptKey = { namespace: "learning", kind: "detector-pack-run-receipt", id: receipt.id };
    const storedReceipt = await store.get(receiptKey);
    if (storedIndex === undefined || storedReceipt === undefined) throw new Error("expected pack-run store graph");

    const targets: readonly ("index" | "receipt")[] = ["index", "receipt"];
    for (const target of targets) {
      const corrupting: LearningStore = {
        get: async (key) => {
          if (target === "index" && key.kind === indexKey.kind && key.id === indexKey.id) {
            return { ...storedIndex, key: { ...storedIndex.key, id: "foreign-index-id" } };
          }
          if (target === "receipt" && key.kind === receiptKey.kind && key.id === receiptKey.id) {
            return { ...storedReceipt, key: { ...storedReceipt.key, id: "foreign-receipt-id" } };
          }
          return store.get(key);
        },
        create: (key, value, digest, operationId) => store.create(key, value, digest, operationId),
        compareAndSet: (key, expectedRevision, value, digest, operationId) =>
          store.compareAndSet(key, expectedRevision, value, digest, operationId),
        append: (stream, expectedRevision, entries, operationId) =>
          store.append(stream, expectedRevision, entries, operationId),
        tombstone: (input) => store.tombstone(input),
        list: (query) => store.list(query),
      };
      await expect(
        runGetDetectorPackRun(replaceContextStore(harness.context, corrupting), {
          packRunReceiptId: receipt.id,
          scope: harness.scope,
        }),
      ).rejects.toMatchObject({ code: "store.corrupt" });
    }

    let receiptGets = 0;
    const observing: LearningStore = {
      get: (key) => {
        if (key.kind === "detector-pack-run-receipt") receiptGets += 1;
        return store.get(key);
      },
      create: (key, value, digest, operationId) => store.create(key, value, digest, operationId),
      compareAndSet: (key, expectedRevision, value, digest, operationId) =>
        store.compareAndSet(key, expectedRevision, value, digest, operationId),
      append: (stream, expectedRevision, entries, operationId) =>
        store.append(stream, expectedRevision, entries, operationId),
      tombstone: (input) => store.tombstone(input),
      list: (query) => store.list(query),
    };
    await expect(
      runGetDetectorPackRun(replaceContextStore(harness.context, observing), {
        packRunReceiptId: receipt.id,
        scope: SEMANTIC_SCOPE_B,
      }),
    ).resolves.toBeUndefined();
    expect(receiptGets).toBe(0);
  });
});
