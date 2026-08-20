// Public typed-query and episode-view contracts (#25): bounded sparse pages,
// opaque filter-bound cursors, provenance-preserving observation/measurement
// reads, source-isolated episode identities, and read-only candidate views.
import { describe, expect, it } from "vitest";
import type { EvidencePage, EvidenceSource, LearningStore, QueryPage } from "../src/index.js";
import { defineSourceRegistration, parseObservation, sha256HexOfCanonicalJson, toJsonValue } from "../src/index.js";
import { createInMemoryStore } from "../src/testing/index.js";
import {
  CONTENT_POLICY_ID,
  SCOPE,
  candidateInput,
  createHarness,
  journeyEvidence,
  reviewerFor,
} from "./engine-harness.js";

async function collectPages<T>(iterable: AsyncIterable<QueryPage<T>>): Promise<readonly QueryPage<T>[]> {
  const pages: QueryPage<T>[] = [];
  for await (const page of iterable) pages.push(page);
  return pages;
}

function itemsOf<T>(pages: readonly QueryPage<T>[]): readonly T[] {
  return pages.flatMap((page) => page.items);
}

async function firstPage<T>(iterable: AsyncIterable<QueryPage<T>>): Promise<QueryPage<T>> {
  for await (const page of iterable) return page;
  throw new Error("query returned no page");
}

function fixtureSource(id: string, pages: readonly EvidencePage[]): EvidenceSource<null> {
  return {
    descriptor: { id, adapterVersion: "1.0.0" },
    probe: () => Promise.resolve({ supported: true, diagnostics: [] }),
    read: async function* (): AsyncIterable<EvidencePage> {
      for (const page of pages) yield page;
    },
  };
}

function throwAfterSecondIdentityAppend(base: LearningStore): LearningStore {
  let identityAppends = 0;
  return {
    get: (key) => base.get(key),
    create: (key, value, digest, operationId) => base.create(key, value, digest, operationId),
    compareAndSet: (key, expectedRevision, value, digest, operationId) =>
      base.compareAndSet(key, expectedRevision, value, digest, operationId),
    append: async (stream, expectedRevision, entries, operationId) => {
      const result = await base.append(stream, expectedRevision, entries, operationId);
      if (stream.kind === "episode-identity") {
        identityAppends += 1;
        if (identityAppends === 2) throw new Error("simulated lost acknowledgement after identity append");
      }
      return result;
    },
    tombstone: (input) => base.tombstone(input),
    list: (query) => base.list(query),
  };
}

function episodePage(input: {
  readonly revision: string;
  readonly sourceRecordId: string;
  readonly episodeId: string;
  readonly parentEpisodeId?: string;
  readonly episodeClass?: string;
  readonly observationId: string;
  readonly completeness: "complete" | "partial" | "unknown";
  readonly status: "succeeded" | "failed" | "cancelled" | "unknown";
}): EvidencePage {
  return {
    sourceRef: "episode-fixture-input",
    pageRef: input.revision,
    state: { status: "available", sourceRevision: input.revision, completeness: input.completeness },
    observations: [
      {
        sourceRecordId: input.observationId,
        episodeId: input.episodeId,
        occurredAt: "2026-08-17T10:01:00.000Z",
        kind: "agent.turn.completed",
        data: { terminal: true },
        completeness: input.completeness,
      },
    ],
    measurements: [],
    episodes: [
      {
        sourceRecordId: input.sourceRecordId,
        episodeId: input.episodeId,
        ...(input.parentEpisodeId !== undefined ? { parentEpisodeId: input.parentEpisodeId } : {}),
        ...(input.episodeClass !== undefined ? { episodeClass: input.episodeClass } : {}),
        completeness: input.completeness,
        scope: SCOPE,
        openedAt: "2026-08-17T10:00:00.000Z",
        closedAt: "2026-08-17T10:02:00.000Z",
        status: input.status,
        measurementSourceRecordIds: [],
      },
    ],
    diagnostics: [],
  };
}

describe("typed learning queries", () => {
  it("requires an integer page limit from 1 through 500 for every query family", async () => {
    const { learning } = await createHarness();

    await expect(collectPages(learning.queryObservations({ limit: 0 }))).rejects.toMatchObject({
      name: "LearningLoopError",
      code: "query.invalid",
    });
    await expect(collectPages(learning.queryMeasurements({ limit: 501 }))).rejects.toMatchObject({
      name: "LearningLoopError",
      code: "query.invalid",
    });
    await expect(collectPages(learning.queryEpisodes({ limit: 1.5 }))).rejects.toMatchObject({
      name: "LearningLoopError",
      code: "query.invalid",
    });
  });

  it("rejects unknown fields, noncanonical timestamps, and oversized query inputs", async () => {
    const { learning } = await createHarness();
    const misspelled = { sourceId: "manual-evidence", limit: 10 };

    await expect(collectPages(learning.queryObservations(misspelled))).rejects.toMatchObject({
      code: "query.invalid",
    });
    await expect(
      collectPages(learning.queryMeasurements({ since: "2026-08-17T10:00:00Z", limit: 10 })),
    ).rejects.toMatchObject({ code: "query.invalid" });
    await expect(
      collectPages(
        learning.queryEpisodes({
          sourceIds: Array.from({ length: 1_001 }, (_, index) => `s-${index}`),
          limit: 10,
        }),
      ),
    ).rejects.toMatchObject({ code: "query.invalid" });
    await expect(
      collectPages(learning.queryObservations({ cursor: "x".repeat(16_385), limit: 10 })),
    ).rejects.toMatchObject({ code: "query.invalid" });
  });

  it("refuses projections whose queryable identifiers exceed the ingestion bound", async () => {
    const page: EvidencePage = {
      sourceRef: "oversized-fixture-input",
      pageRef: "page-0",
      state: { status: "available", sourceRevision: "oversized-projection", completeness: "complete" },
      observations: [
        {
          sourceRecordId: "r".repeat(1_001),
          episodeId: "episode",
          kind: "test",
          data: {},
          completeness: "complete",
        },
      ],
      measurements: [],
      episodes: [],
      diagnostics: [],
    };
    const source = defineSourceRegistration({
      source: fixtureSource("bounded-source", [page]),
      trustCeiling: "observed",
      contentPolicyId: CONTENT_POLICY_ID,
    });
    const { learning } = await createHarness([source]);
    const receipt = await learning.ingest(source, null);

    expect(receipt.observationIds).toEqual([]);
    expect(receipt.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: "schema.invalid" })]));
  });

  it("fails a time-bounded query when a stored record timestamp is noncanonical", async () => {
    const { learning, manual } = await createHarness();
    await learning.ingest(manual, {
      observations: [
        {
          id: "bad-time",
          episodeId: "bad-time-episode",
          occurredAt: "not-a-timestamp",
          kind: "test",
          data: {},
        },
      ],
    });

    await expect(
      collectPages(learning.queryObservations({ since: "2026-08-17T00:00:00.000Z", limit: 10 })),
    ).rejects.toMatchObject({ code: "query.incomplete" });
  });

  it("returns bounded sparse pages and applies normalized observation filters", async () => {
    const { learning, manual } = await createHarness();
    await learning.ingest(manual, {
      observations: [
        {
          id: "obs-a",
          episodeId: "ep-a",
          occurredAt: "2026-08-17T10:00:00.000Z",
          kind: "keep",
          data: { order: 1 },
        },
        {
          id: "obs-b",
          episodeId: "ep-b",
          occurredAt: "2026-08-17T10:01:00.000Z",
          kind: "drop",
          data: { order: 2 },
        },
        {
          id: "obs-c",
          episodeId: "ep-a",
          occurredAt: "2026-08-17T10:02:00.000Z",
          kind: "keep",
          data: { order: 3 },
        },
      ],
    });

    const pages = await collectPages(
      learning.queryObservations({
        observationIds: ["manual-evidence/obs-c", "manual-evidence/obs-a"],
        sourceIds: ["manual-evidence"],
        episodeIds: ["ep-a"],
        kinds: ["keep"],
        trust: ["observed"],
        completeness: ["complete"],
        since: "2026-08-17T10:00:00.000Z",
        until: "2026-08-17T10:02:00.000Z",
        limit: 1,
      }),
    );

    expect(itemsOf(pages).map((observation) => observation.id)).toEqual([
      "manual-evidence/obs-a",
      "manual-evidence/obs-c",
    ]);
    expect(pages.some((page) => page.items.length === 0 && page.nextCursor !== undefined)).toBe(true);
    expect(pages.every((page) => page.items.length <= 1 && page.snapshotRevision !== "")).toBe(true);
  });

  it("allows a changed limit on a cursor and observes records appended after the earlier page", async () => {
    const { learning, manual } = await createHarness();
    await learning.ingest(manual, {
      observations: [
        { id: "append-a", episodeId: "ep-append", kind: "append", data: { order: 1 } },
        { id: "append-b", episodeId: "ep-append", kind: "append", data: { order: 2 } },
      ],
    });

    const first = await firstPage(
      learning.queryObservations({ sourceIds: ["manual-evidence"], kinds: ["append"], limit: 1 }),
    );
    expect(first.items.map((observation) => observation.id)).toEqual(["manual-evidence/append-a"]);
    if (first.nextCursor === undefined) throw new Error("expected a continuation cursor");

    await learning.ingest(manual, {
      observations: [{ id: "append-c", episodeId: "ep-append", kind: "append", data: { order: 3 } }],
    });
    const resumed = await collectPages(
      learning.queryObservations({
        sourceIds: ["manual-evidence", "manual-evidence"],
        kinds: ["append", "append"],
        cursor: first.nextCursor,
        limit: 2,
      }),
    );

    expect(itemsOf(resumed).map((observation) => observation.id)).toEqual([
      "manual-evidence/append-b",
      "manual-evidence/append-c",
    ]);
    expect(resumed.some((page) => page.snapshotRevision !== first.snapshotRevision)).toBe(true);
  });

  it("resumes across loop instances only with the same explicit store cursor scope", async () => {
    const store = createInMemoryStore();
    const firstHarness = await createHarness([], { store, queryCursorScope: "tenant-a/store-a" });
    await firstHarness.learning.ingest(firstHarness.manual, {
      observations: [
        { id: "stable-a", episodeId: "stable-episode", kind: "stable", data: { order: 1 } },
        { id: "stable-b", episodeId: "stable-episode", kind: "stable", data: { order: 2 } },
      ],
    });
    const first = await firstPage(firstHarness.learning.queryObservations({ kinds: ["stable"], limit: 1 }));
    if (first.nextCursor === undefined) throw new Error("expected a continuation cursor");

    const resumedHarness = await createHarness([], { store, queryCursorScope: "tenant-a/store-a" });
    const resumed = itemsOf(
      await collectPages(
        resumedHarness.learning.queryObservations({ kinds: ["stable"], cursor: first.nextCursor, limit: 10 }),
      ),
    );
    expect(resumed.map((observation) => observation.id)).toEqual(["manual-evidence/stable-b"]);
  });

  it("preserves registered trust and folded completeness on observation and measurement queries", async () => {
    const page: EvidencePage = {
      sourceRef: "partial-fixture-input",
      pageRef: "page-0",
      state: { status: "available", sourceRevision: "partial-rev-1", completeness: "partial" },
      observations: [
        {
          sourceRecordId: "obs-partial",
          episodeId: "native-session-7",
          occurredAt: "2026-08-17T11:01:00.000Z",
          kind: "tool.process.completed",
          data: { exitCode: 1 },
          completeness: "partial",
        },
      ],
      measurements: [
        {
          sourceRecordId: "measure-partial",
          episodeId: "native-session-7",
          metric: { name: "typecheck", valueType: "boolean", unit: "pass", aggregation: "all" },
          value: false,
          evidenceSourceRecordIds: ["obs-partial"],
          measuredAt: "2026-08-17T11:02:00.000Z",
        },
      ],
      episodes: [],
      diagnostics: [],
    };
    const advisory = defineSourceRegistration({
      source: fixtureSource("partial-source", [page]),
      trustCeiling: "advisory",
      contentPolicyId: CONTENT_POLICY_ID,
    });
    const { learning } = await createHarness([advisory]);
    await learning.ingest(advisory, null);

    const observations = itemsOf(
      await collectPages(
        learning.queryObservations({
          observationIds: ["partial-source/obs-partial"],
          sourceIds: ["partial-source"],
          episodeIds: ["native-session-7"],
          kinds: ["tool.process.completed"],
          trust: ["advisory"],
          completeness: ["partial"],
          since: "2026-08-17T11:00:00.000Z",
          until: "2026-08-17T11:03:00.000Z",
          limit: 10,
        }),
      ),
    );
    expect(observations).toHaveLength(1);
    expect(observations[0]?.provenance).toMatchObject({
      sourceId: "partial-source",
      recordRef: "obs-partial",
      trust: "advisory",
      completeness: "partial",
    });

    const measurements = itemsOf(
      await collectPages(
        learning.queryMeasurements({
          measurementIds: ["partial-source/measure-partial"],
          sourceIds: ["partial-source"],
          episodeIds: ["native-session-7"],
          metricNames: ["typecheck"],
          trust: ["advisory"],
          completeness: ["partial"],
          since: "2026-08-17T11:00:00.000Z",
          until: "2026-08-17T11:03:00.000Z",
          limit: 10,
        }),
      ),
    );
    expect(measurements).toHaveLength(1);
    expect(measurements[0]?.provenance).toMatchObject({
      sourceId: "partial-source",
      recordRef: "measure-partial",
      trust: "advisory",
      completeness: "partial",
    });
  });

  it("rejects a shape-valid record whose store digest no longer matches its content", async () => {
    const base = createInMemoryStore();
    const writer = await createHarness([], { store: base });
    await writer.learning.ingest(writer.manual, {
      observations: [{ id: "tamper-target", episodeId: "tamper-episode", kind: "test", data: { original: true } }],
    });
    const tamperingStore: LearningStore = {
      get: (key) => base.get(key),
      create: (key, value, digest, operationId) => base.create(key, value, digest, operationId),
      compareAndSet: (key, expectedRevision, value, digest, operationId) =>
        base.compareAndSet(key, expectedRevision, value, digest, operationId),
      append: (stream, expectedRevision, entries, operationId) =>
        base.append(stream, expectedRevision, entries, operationId),
      tombstone: (input) => base.tombstone(input),
      list: async (query) => {
        const page = await base.list(query);
        return {
          ...page,
          records: page.records.map((record) => {
            if (record.key.kind !== "observation") return record;
            const observation = parseObservation(record.value);
            return { ...record, value: toJsonValue({ ...observation, data: { tampered: true } }) };
          }),
        };
      },
    };
    const reader = await createHarness([], { store: tamperingStore });

    await expect(collectPages(reader.learning.queryObservations({ limit: 10 }))).rejects.toMatchObject({
      code: "store.corrupt",
    });
  });

  it("rejects malformed, cross-kind, filter-mismatched, and registry-mismatched cursors", async () => {
    const firstHarness = await createHarness();
    await firstHarness.learning.ingest(firstHarness.manual, {
      observations: [
        { id: "cursor-a", episodeId: "cursor-episode", kind: "cursor", data: { order: 1 } },
        { id: "cursor-b", episodeId: "cursor-episode", kind: "cursor", data: { order: 2 } },
      ],
    });
    const first = await firstPage(
      firstHarness.learning.queryObservations({ sourceIds: ["manual-evidence"], kinds: ["cursor"], limit: 1 }),
    );
    if (first.nextCursor === undefined) throw new Error("expected a continuation cursor");
    expect(first.nextCursor).not.toMatch(/^\d+$/);

    await expect(
      collectPages(firstHarness.learning.queryMeasurements({ cursor: first.nextCursor, limit: 1 })),
    ).rejects.toMatchObject({ name: "LearningLoopError", code: "query.cursor_mismatch" });
    await expect(
      collectPages(
        firstHarness.learning.queryObservations({ sourceIds: ["another-source"], cursor: first.nextCursor, limit: 1 }),
      ),
    ).rejects.toMatchObject({ name: "LearningLoopError", code: "query.cursor_mismatch" });
    await expect(
      collectPages(firstHarness.learning.queryObservations({ cursor: "not-an-opaque-query-cursor", limit: 1 })),
    ).rejects.toMatchObject({ name: "LearningLoopError", code: "query.cursor_invalid" });

    const sameRegistryHarness = await createHarness();
    await expect(
      collectPages(
        sameRegistryHarness.learning.queryObservations({
          sourceIds: ["manual-evidence"],
          kinds: ["cursor"],
          cursor: first.nextCursor,
          limit: 1,
        }),
      ),
    ).rejects.toMatchObject({ name: "LearningLoopError", code: "query.cursor_mismatch" });

    const extra = defineSourceRegistration({
      source: fixtureSource("registry-change", []),
      trustCeiling: "advisory",
      contentPolicyId: CONTENT_POLICY_ID,
    });
    const secondHarness = await createHarness([extra]);
    await expect(
      collectPages(
        secondHarness.learning.queryObservations({
          sourceIds: ["manual-evidence"],
          kinds: ["cursor"],
          cursor: first.nextCursor,
          limit: 1,
        }),
      ),
    ).rejects.toMatchObject({ name: "LearningLoopError", code: "query.cursor_mismatch" });
  });

  it("rejects a non-adjacent raw store cursor cycle", async () => {
    const base = createInMemoryStore();
    const cyclingStore: LearningStore = {
      get: (key) => base.get(key),
      create: (key, value, digest, operationId) => base.create(key, value, digest, operationId),
      compareAndSet: (key, expectedRevision, value, digest, operationId) =>
        base.compareAndSet(key, expectedRevision, value, digest, operationId),
      append: (stream, expectedRevision, entries, operationId) =>
        base.append(stream, expectedRevision, entries, operationId),
      tombstone: (input) => base.tombstone(input),
      list: (query) => {
        if (query.kind !== "observation") return base.list(query);
        const nextCursor = query.cursor === undefined ? "A" : query.cursor === "A" ? "B" : "A";
        return Promise.resolve({ records: [], nextCursor, snapshotRevision: "0" });
      },
    };
    const { learning } = await createHarness([], { store: cyclingStore });

    await expect(collectPages(learning.queryObservations({ limit: 1 }))).rejects.toMatchObject({
      code: "store.corrupt",
    });
  });

  it("rejects an oversized raw store page before exposing its records", async () => {
    const base = createInMemoryStore();
    const oversizedStore: LearningStore = {
      get: (key) => base.get(key),
      create: (key, value, digest, operationId) => base.create(key, value, digest, operationId),
      compareAndSet: (key, expectedRevision, value, digest, operationId) =>
        base.compareAndSet(key, expectedRevision, value, digest, operationId),
      append: (stream, expectedRevision, entries, operationId) =>
        base.append(stream, expectedRevision, entries, operationId),
      tombstone: (input) => base.tombstone(input),
      list: (query) => {
        if (query.kind !== "observation") return base.list(query);
        const malformed = {
          key: { namespace: "learning", kind: "observation", id: "malformed" },
          value: {},
          revision: "1",
          digest: "not-a-content-digest",
        };
        return Promise.resolve({ records: [malformed, malformed], snapshotRevision: "0" });
      },
    };
    const { learning } = await createHarness([], { store: oversizedStore });

    await expect(collectPages(learning.queryObservations({ limit: 1 }))).rejects.toMatchObject({
      code: "store.corrupt",
    });
  });
});

describe("episode identity views", () => {
  it("isolates colliding native episode ids by source and preserves transcript-style source record ids", async () => {
    const sourceA = defineSourceRegistration({
      source: fixtureSource("source-a", [
        episodePage({
          revision: "a-rev-1",
          sourceRecordId: "transcript-row-a",
          episodeId: "shared-native-session",
          observationId: "shared-raw",
          completeness: "complete",
          status: "failed",
        }),
      ]),
      trustCeiling: "observed",
      contentPolicyId: CONTENT_POLICY_ID,
    });
    const sourceB = defineSourceRegistration({
      source: fixtureSource("source-b", [
        episodePage({
          revision: "b-rev-1",
          sourceRecordId: "transcript-row-b",
          episodeId: "shared-native-session",
          observationId: "shared-raw",
          completeness: "partial",
          status: "succeeded",
        }),
      ]),
      trustCeiling: "advisory",
      contentPolicyId: CONTENT_POLICY_ID,
    });
    const { learning, proposer, reviewerB, store } = await createHarness([sourceA, sourceB]);
    await learning.ingest(sourceA, null);
    await learning.ingest(sourceB, null);

    const identityRecord = await store.get({
      namespace: "learning",
      kind: "episode-identity",
      id: "source-a/transcript-row-a",
    });
    expect(identityRecord?.digest).toBe("f46e719a7466e84d214d0c9b52cb93e678ae96a75206dbc856b0f6424e451ae6");

    const views = itemsOf(
      await collectPages(learning.queryEpisodes({ episodeIds: ["shared-native-session"], limit: 10 })),
    );
    expect(views.map((view) => view.episode.id)).toEqual(["source-a/transcript-row-a", "source-b/transcript-row-b"]);
    const identities = views.flatMap((view) => (view.identity.status === "resolved" ? [view.identity] : []));
    expect(identities).toHaveLength(2);
    expect(identities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceId: "source-a",
          sourceRecordId: "transcript-row-a",
          episodeId: "shared-native-session",
          registryRevision: sourceA.registryRevision,
          trustCeiling: "observed",
          completeness: "complete",
        }),
        expect.objectContaining({
          sourceId: "source-b",
          sourceRecordId: "transcript-row-b",
          episodeId: "shared-native-session",
          registryRevision: sourceB.registryRevision,
          trustCeiling: "advisory",
          completeness: "partial",
        }),
      ]),
    );

    const sourceAOnly = itemsOf(
      await collectPages(
        learning.queryEpisodes({
          sourceIds: ["source-a"],
          episodeIds: ["shared-native-session"],
          scope: SCOPE,
          statuses: ["failed"],
          limit: 10,
        }),
      ),
    );
    expect(sourceAOnly.map((view) => view.episode.id)).toEqual(["source-a/transcript-row-a"]);

    const observationsA = itemsOf(
      await collectPages(
        learning.queryObservations({
          sourceIds: ["source-a"],
          episodeIds: ["shared-native-session"],
          limit: 10,
        }),
      ),
    );
    expect(observationsA.map((observation) => observation.id)).toEqual(["source-a/shared-raw"]);

    await learning.propose(
      candidateInput(proposer, {
        id: "candidate-source-a",
        evidenceIds: ["source-a/shared-raw"],
        problem: "Source A observed a scoped problem.",
      }),
    );
    await learning.propose(
      candidateInput(proposer, {
        id: "candidate-source-b",
        evidenceIds: ["source-b/shared-raw"],
        problem: "Source B observed a different scoped problem.",
      }),
    );
    const ambiguous = await learning.propose(
      candidateInput(proposer, {
        id: "candidate-ambiguous-raw",
        evidenceIds: ["shared-raw"],
        problem: "An unqualified evidence id cannot identify its source.",
      }),
    );
    const reportA = await learning.report({
      sourceIds: ["source-a"],
      episodeIds: ["shared-native-session"],
    });
    expect(reportA.candidateIds).toEqual(["candidate-source-a"]);
    const allSourceA = await learning.report({ sourceIds: ["source-a"] });
    expect(allSourceA.candidateIds).toEqual(["candidate-source-a"]);
    await expect(
      learning.reviewCandidate({
        id: "review-ambiguous-raw",
        candidateId: ambiguous.candidate.id,
        reviewer: reviewerFor(reviewerB),
      }),
    ).rejects.toMatchObject({ code: "review.evidence_ambiguous" });
  });

  it("returns a diagnostic unresolved identity for a legacy episode without a sidecar", async () => {
    const { learning, store } = await createHarness();
    const legacy = toJsonValue({
      schemaVersion: 1,
      id: "legacy-source/legacy-row",
      scope: SCOPE,
      openedAt: "2026-08-10T08:00:00.000Z",
      sourceRefs: ["legacy-source"],
      outcome: { status: "unknown", measurementIds: [] },
      exposureIds: [],
    });
    await store.create(
      { namespace: "learning", kind: "episode", id: "legacy-source/legacy-row" },
      legacy,
      sha256HexOfCanonicalJson(legacy),
      "seed-legacy-episode",
    );

    const views = itemsOf(
      await collectPages(learning.queryEpisodes({ recordIds: ["legacy-source/legacy-row"], limit: 10 })),
    );
    expect(views).toHaveLength(1);
    expect(views[0]?.episode.id).toBe("legacy-source/legacy-row");
    expect(views[0]?.identity.status).toBe("unresolved");
    const identity = views[0]?.identity;
    if (identity?.status !== "unresolved") throw new Error("expected unresolved legacy identity");
    expect(identity.diagnostics.some((diagnostic) => diagnostic.code === "episode.identity_unresolved")).toBe(true);
    await expect(
      collectPages(learning.queryEpisodes({ sourceIds: ["legacy-source"], limit: 10 })),
    ).rejects.toMatchObject({ name: "LearningLoopError", code: "query.incomplete" });
  });

  it("exposes and filters provider-neutral parent and episode-class lineage", async () => {
    const lineageSource = defineSourceRegistration({
      source: fixtureSource("lineage-source", [
        episodePage({
          revision: "lineage-rev-1",
          sourceRecordId: "child-row",
          episodeId: "child-episode",
          parentEpisodeId: "root-episode",
          episodeClass: "delegated",
          observationId: "child-observation",
          completeness: "complete",
          status: "succeeded",
        }),
      ]),
      trustCeiling: "observed",
      contentPolicyId: CONTENT_POLICY_ID,
    });
    const { learning } = await createHarness([lineageSource]);
    await learning.ingest(lineageSource, null);

    const views = itemsOf(
      await collectPages(
        learning.queryEpisodes({
          parentEpisodeIds: ["root-episode"],
          episodeClasses: ["delegated"],
          limit: 10,
        }),
      ),
    );
    expect(views).toHaveLength(1);
    const identity = views[0]?.identity;
    if (identity?.status !== "resolved") throw new Error("expected resolved descendant identity");
    expect(identity).toMatchObject({
      episodeId: "child-episode",
      parentEpisodeId: "root-episode",
      episodeClass: "delegated",
    });

    const excluded = itemsOf(
      await collectPages(learning.queryEpisodes({ parentEpisodeIds: ["another-root"], limit: 10 })),
    );
    expect(excluded).toEqual([]);
  });

  it("backfills a missing sidecar on idempotent re-ingest without mutating the episode", async () => {
    const { learning, manual, store } = await createHarness();
    const episode = toJsonValue({
      schemaVersion: 1,
      id: "manual-evidence/change-42",
      scope: SCOPE,
      openedAt: "2026-08-12T16:00:00.000Z",
      closedAt: "2026-08-12T16:12:00.000Z",
      sourceRefs: ["manual-evidence"],
      outcome: { status: "failed", measurementIds: ["manual-evidence/measure-42-typecheck"] },
      exposureIds: [],
    });
    const key = { namespace: "learning", kind: "episode", id: "manual-evidence/change-42" };
    await store.create(key, episode, sha256HexOfCanonicalJson(episode), "seed-pre-sidecar-episode");
    const before = await store.get(key);

    const receipt = await learning.ingest(manual, journeyEvidence());
    expect(receipt.episodeIds).toEqual([]);
    const after = await store.get(key);
    expect(after?.revision).toBe(before?.revision);
    expect(after?.digest).toBe(before?.digest);

    const views = itemsOf(
      await collectPages(learning.queryEpisodes({ recordIds: ["manual-evidence/change-42"], limit: 10 })),
    );
    expect(views).toHaveLength(1);
    const identity = views[0]?.identity;
    if (identity?.status !== "resolved") throw new Error("expected re-ingest to repair episode identity");
    expect(identity).toMatchObject({
      sourceId: "manual-evidence",
      sourceRecordId: "change-42",
      episodeId: "change-42",
      registryRevision: manual.registryRevision,
      trustCeiling: "observed",
      completeness: "complete",
    });
  });

  it("marks conflicting source identity unresolved and refuses an identity-filtered result", async () => {
    const conflicting = defineSourceRegistration({
      source: fixtureSource("conflicting-source", [
        episodePage({
          revision: "conflict-rev-1",
          sourceRecordId: "same-row",
          episodeId: "logical-a",
          observationId: "obs-logical-a",
          completeness: "complete",
          status: "unknown",
        }),
        episodePage({
          revision: "conflict-rev-2",
          sourceRecordId: "same-row",
          episodeId: "logical-b",
          observationId: "obs-logical-b",
          completeness: "complete",
          status: "unknown",
        }),
      ]),
      trustCeiling: "observed",
      contentPolicyId: CONTENT_POLICY_ID,
    });
    const { learning } = await createHarness([conflicting]);
    const receipt = await learning.ingest(conflicting, null);
    expect(receipt.diagnostics).toEqual(
      expect.arrayContaining([
        {
          code: "episode.identity_conflict",
          severity: "error",
          message: "episode identity claims conflicted",
        },
      ]),
    );
    expect(JSON.stringify(receipt.diagnostics)).not.toContain("conflicting-source/same-row");

    const views = itemsOf(
      await collectPages(learning.queryEpisodes({ recordIds: ["conflicting-source/same-row"], limit: 10 })),
    );
    expect(views).toHaveLength(1);
    const identity = views[0]?.identity;
    if (identity?.status !== "unresolved") throw new Error("expected a conflicting identity to be unresolved");
    expect(identity.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "episode.identity_conflict" })]),
    );

    await expect(collectPages(learning.queryEpisodes({ episodeIds: ["logical-a"], limit: 10 }))).rejects.toMatchObject({
      code: "query.incomplete",
    });
  });

  it("folds a committed identity claim after a lost append acknowledgement", async () => {
    const conflicting = defineSourceRegistration({
      source: fixtureSource("crash-source", [
        episodePage({
          revision: "crash-rev-1",
          sourceRecordId: "same-row",
          episodeId: "logical-a",
          observationId: "obs-a",
          completeness: "complete",
          status: "unknown",
        }),
        episodePage({
          revision: "crash-rev-2",
          sourceRecordId: "same-row",
          episodeId: "logical-b",
          observationId: "obs-b",
          completeness: "complete",
          status: "unknown",
        }),
      ]),
      trustCeiling: "observed",
      contentPolicyId: CONTENT_POLICY_ID,
    });
    const store = throwAfterSecondIdentityAppend(createInMemoryStore());
    const { learning } = await createHarness([conflicting], { store });

    await expect(learning.ingest(conflicting, null)).rejects.toThrow("simulated lost acknowledgement");
    const views = itemsOf(
      await collectPages(learning.queryEpisodes({ recordIds: ["crash-source/same-row"], limit: 10 })),
    );
    expect(views).toHaveLength(1);
    expect(views[0]?.identity.status).toBe("unresolved");
    const identity = views[0]?.identity;
    if (identity?.status !== "unresolved") throw new Error("expected durable conflict after lost acknowledgement");
    expect(identity.diagnostics.some((diagnostic) => diagnostic.code === "episode.identity_conflict")).toBe(true);
  });

  it("rejects an episode page assembled across a concurrent namespace revision", async () => {
    const base = createInMemoryStore();
    const writer = await createHarness([], { store: base });
    await writer.learning.ingest(writer.manual, journeyEvidence());
    let bumped = false;
    const changingStore: LearningStore = {
      get: async (key) => {
        const stored = await base.get(key);
        if (key.kind === "episode-identity" && !bumped) {
          bumped = true;
          const marker = toJsonValue({ marker: "concurrent-write" });
          await base.create(
            { namespace: "learning", kind: "candidate-by-digest", id: "concurrent-marker" },
            marker,
            sha256HexOfCanonicalJson(marker),
            "concurrent-marker-write",
          );
        }
        return stored;
      },
      create: (key, value, digest, operationId) => base.create(key, value, digest, operationId),
      compareAndSet: (key, expectedRevision, value, digest, operationId) =>
        base.compareAndSet(key, expectedRevision, value, digest, operationId),
      append: (stream, expectedRevision, entries, operationId) =>
        base.append(stream, expectedRevision, entries, operationId),
      tombstone: (input) => base.tombstone(input),
      list: (query) => base.list(query),
    };
    const reader = await createHarness([], { store: changingStore });

    await expect(collectPages(reader.learning.queryEpisodes({ limit: 10 }))).rejects.toMatchObject({
      code: "query.snapshot_changed",
    });
  });
});

describe("candidate views", () => {
  it("folds current governance without creating or mutating durable records", async () => {
    const { learning, store, proposer, reviewerB } = await createHarness();
    const proposed = await learning.propose(candidateInput(proposer));

    const initial = await learning.getCandidateView({ candidateId: proposed.candidate.id });
    if (initial === undefined) throw new Error("expected candidate view");
    expect(initial.candidate).toEqual(proposed.candidate);
    expect(initial.governance).toMatchObject({
      review: "required",
      publication: "blocked",
      validation: "untested",
    });

    await learning.reviewCandidate({
      id: "rev-candidate-view",
      candidateId: proposed.candidate.id,
      reviewer: reviewerFor(reviewerB),
    });
    const before = await store.list({ namespace: "learning", limit: 500 });
    const accepted = await learning.getCandidateView({ candidateId: proposed.candidate.id });
    if (accepted === undefined) throw new Error("expected reviewed candidate view");
    const after = await store.list({ namespace: "learning", limit: 500 });

    expect(accepted.candidate).toEqual(proposed.candidate);
    expect(accepted.governance.review).toBe("accepted");
    expect(accepted.governance.publication).toBe("blocked");
    expect(accepted.governance.validation).toBe("untested");
    expect(after.snapshotRevision).toBe(before.snapshotRevision);
    expect(after.records).toEqual(before.records);
  });
});
