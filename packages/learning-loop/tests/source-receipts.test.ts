// Durable source-receipt conformance (#31a): exact page/import lineage,
// evidence-health separation, privacy-minimized diagnostics, bounded public
// reads, source/page-scoped revision refusal, and receipt-last crash recovery.
import { describe, expect, it } from "vitest";
import type {
  ContentPolicy,
  EvidencePage,
  EvidenceSource,
  LearningStore,
  QueryPage,
  SourcePageReceipt,
} from "../src/index.js";
import {
  conservativePolicy,
  createLearningLoop,
  defineSourceRegistration,
  parseEvidenceHealthFinding,
  parseImportReceipt,
  parseSourcePageReceipt,
  sha256HexOfCanonicalJson,
  toJsonValue,
} from "../src/index.js";
import {
  createExactScopePolicy,
  createFixedClock,
  createInMemoryStore,
  createSequentialIds,
  createTestIdentityPort,
} from "../src/testing/index.js";
import { buildHealthFinding, buildImportReceipt, buildSourcePageReceipt } from "../src/engine/source-receipts.js";
import {
  evidenceHealthFindingDigest,
  importReceiptDigest,
  sourcePageReceiptDigest,
} from "../src/records/source-health.js";
import { CONTENT_POLICY_ID, createHarness, scriptedSource } from "./engine-harness.js";

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

function evidencePage(input: {
  readonly sourceRef: string;
  readonly pageRef: string;
  readonly state: EvidencePage["state"];
  readonly observations?: EvidencePage["observations"];
  readonly measurements?: EvidencePage["measurements"];
  readonly episodes?: EvidencePage["episodes"];
  readonly diagnostics?: EvidencePage["diagnostics"];
}): EvidencePage {
  return {
    sourceRef: input.sourceRef,
    pageRef: input.pageRef,
    state: input.state,
    observations: input.observations ?? [],
    measurements: input.measurements ?? [],
    episodes: input.episodes ?? [],
    diagnostics: input.diagnostics ?? [],
  };
}

function observation(id: string, completeness: "complete" | "partial" | "unknown" = "complete") {
  return {
    sourceRecordId: id,
    episodeId: `episode-${id}`,
    kind: "agent.turn.completed",
    data: { id },
    completeness,
  };
}

// An overload models a dishonest port without weakening production types or
// casting in the test. The public signature satisfies ContentPolicy while the
// hidden implementation deliberately returns unknown bytes for the engine to
// parse and refuse.
function malformedContentPolicyTransform(input: unknown): ReturnType<ContentPolicy["transform"]>;
function malformedContentPolicyTransform(input: unknown): Promise<unknown> {
  void input;
  return Promise.resolve({ accepted: {}, classification: "structured", diagnostics: "not-an-array" });
}

async function storedValues(store: LearningStore, kind: string): Promise<readonly unknown[]> {
  const values: unknown[] = [];
  let cursor: string | undefined;
  do {
    const page = await store.list({
      namespace: "learning",
      kind,
      limit: 500,
      ...(cursor !== undefined ? { cursor } : {}),
    });
    values.push(...page.records.map((record) => record.value));
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return values;
}

function recordingStore(base: LearningStore, writes: string[]): LearningStore {
  return {
    get: (key) => base.get(key),
    create: (key, value, digest, operationId) => {
      writes.push(key.kind);
      return base.create(key, value, digest, operationId);
    },
    compareAndSet: (key, expectedRevision, value, digest, operationId) => {
      writes.push(key.kind);
      return base.compareAndSet(key, expectedRevision, value, digest, operationId);
    },
    append: (stream, expectedRevision, entries, operationId) => {
      writes.push(stream.kind);
      return base.append(stream, expectedRevision, entries, operationId);
    },
    tombstone: (input) => base.tombstone(input),
    list: (query) => base.list(query),
  };
}

function loseFirstPageReceiptAcknowledgement(base: LearningStore): LearningStore {
  let failed = false;
  return {
    get: (key) => base.get(key),
    create: async (key, value, digest, operationId) => {
      const result = await base.create(key, value, digest, operationId);
      if (!failed && key.kind === "source-page-receipt") {
        failed = true;
        throw new Error("simulated lost acknowledgement after page receipt commit");
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

function failBeforeFirstPageReceiptCreate(base: LearningStore): LearningStore {
  let failed = false;
  return {
    get: (key) => base.get(key),
    create: (key, value, digest, operationId) => {
      if (!failed && key.kind === "source-page-receipt") {
        failed = true;
        return Promise.reject(new Error("simulated failure before page receipt commit"));
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
}

function loseFirstDerivativeOwnerAcknowledgement(base: LearningStore): LearningStore {
  let failed = false;
  return {
    get: (key) => base.get(key),
    create: async (key, value, digest, operationId) => {
      const result = await base.create(key, value, digest, operationId);
      if (!failed && key.kind === "derivative-owner") {
        failed = true;
        throw new Error("simulated lost derivative owner acknowledgement");
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

function concurrentObservationSource(): EvidenceSource<string> {
  return {
    descriptor: { id: "concurrent-owner-source", adapterVersion: "1.0.0" },
    probe: () => Promise.resolve({ supported: true, sourceRevision: "concurrent-revision", diagnostics: [] }),
    read: async function* (pageRef): AsyncIterable<EvidencePage> {
      yield evidencePage({
        sourceRef: "concurrent-artifact",
        pageRef,
        state: { status: "available", sourceRevision: "concurrent-revision", completeness: "complete" },
        observations: [observation("shared-observation")],
      });
    },
  };
}

describe("durable source and import receipts", () => {
  it("pins canonical digest golden vectors for page, import, and evidence-health records", () => {
    const health = buildHealthFinding({
      code: "source.partial",
      effect: "limits_claims",
      sourceId: "golden-source",
      sourceRegistrationRevision: "a".repeat(64),
      sourceRef: "golden-artifact",
      pageRef: "golden-page",
      completeness: "partial",
      affectedRecords: 2,
    });
    const page = buildSourcePageReceipt({
      sourceId: "golden-source",
      sourceRegistrationRevision: "a".repeat(64),
      adapterVersion: "1.2.3",
      contentPolicyId: "golden-policy",
      contentPolicyDigest: "b".repeat(64),
      loopRegistryRevision: "c".repeat(64),
      sourceRef: "golden-artifact",
      pageRef: "golden-page",
      state: { status: "available", sourceRevision: "golden-revision", completeness: "partial" },
      derivatives: [
        {
          kind: "observation",
          id: "golden-source/observation-1",
          digest: "d".repeat(64),
        },
      ],
      projectionCounts: { observations: 2, measurements: 0, episodes: 0, rejected: 1 },
      diagnostics: [
        { code: "private.provider.code", severity: "warning", message: "CANARY" },
        { code: "source.incomplete", severity: "warning", message: "safe" },
      ],
      healthFindingIds: [health.id],
    });
    const importReceipt = buildImportReceipt({
      sourceId: "golden-source",
      sourceRegistrationRevision: "a".repeat(64),
      loopRegistryRevision: "c".repeat(64),
      pageReceiptIds: [page.id],
      sourceRevisions: ["golden-revision"],
      completeness: "partial",
      healthFindingIds: [health.id],
    });

    expect(health.findingDigest).toBe("96f7b71986dc873acaace5d965c7240258e311bee57b2361455a3ddb0256e189");
    expect(page.receiptDigest).toBe("31d3f3dbceb0390bb3c2e4cb11270de63b887be2cd379a17cfc180337eaaca88");
    expect(importReceipt.receiptDigest).toBe("2ccd6e9418db49d8f13581b083fabe5b712c1ea5436a3ebd74d0b190be696e39");
  });

  it("preserves historical omitted reused counts while binding explicit reused accounting", () => {
    const common = {
      sourceId: "reused-source",
      sourceRegistrationRevision: "a".repeat(64),
      adapterVersion: "1.0.0",
      contentPolicyId: "reused-policy",
      contentPolicyDigest: "b".repeat(64),
      loopRegistryRevision: "c".repeat(64),
      sourceRef: "reused-artifact",
      pageRef: "reused-page",
      state: { status: "available" as const, sourceRevision: "reused-revision", completeness: "complete" as const },
      derivatives: [
        {
          kind: "observation" as const,
          id: "reused-source/observation-1",
          digest: "d".repeat(64),
        },
      ],
      diagnostics: [],
      healthFindingIds: [],
    };
    const historical = buildSourcePageReceipt({
      ...common,
      projectionCounts: { observations: 1, measurements: 0, episodes: 0, rejected: 0 },
    });
    expect("reused" in historical.projectionCounts).toBe(false);
    expect(parseSourcePageReceipt(historical)).toEqual(historical);

    const explicitZero = buildSourcePageReceipt({
      ...common,
      projectionCounts: { observations: 1, measurements: 0, episodes: 0, rejected: 0, reused: 0 },
    });
    expect(explicitZero.projectionCounts.reused).toBe(0);
    expect(explicitZero.receiptDigest).not.toBe(historical.receiptDigest);
    expect(explicitZero.receiptDigest).toBe("f27e2894d35101d67cdb7c9693dc7f06dc63127bc18c04e2d34e9435f083a791");

    const reused = buildSourcePageReceipt({
      ...common,
      projectionCounts: { observations: 2, measurements: 0, episodes: 0, rejected: 0, reused: 1 },
    });
    expect(reused.projectionCounts.reused).toBe(1);

    expect(() =>
      buildSourcePageReceipt({
        ...common,
        projectionCounts: { observations: 2, measurements: 0, episodes: 0, rejected: 0, reused: 0 },
      }),
    ).toThrowError(expect.objectContaining({ code: "schema.corrupt" }));
    expect(() =>
      buildSourcePageReceipt({
        ...common,
        projectionCounts: {
          observations: 1,
          measurements: 0,
          episodes: 0,
          rejected: 0,
          reused: Number.MAX_SAFE_INTEGER + 1,
        },
      }),
    ).toThrowError(expect.objectContaining({ code: "schema.invalid" }));
    expect(() =>
      buildSourcePageReceipt({
        ...common,
        state: { status: "missing" },
        derivatives: [],
        projectionCounts: { observations: 1, measurements: 0, episodes: 0, rejected: 0, reused: 1 },
      }),
    ).toThrowError(expect.objectContaining({ code: "schema.corrupt" }));
  });

  it("re-ingests identical pages to the exact same receipt bytes with no net-new derivatives", async () => {
    const source = defineSourceRegistration({
      source: scriptedSource("receipt-repeat", () => [
        evidencePage({
          sourceRef: "artifact-a",
          pageRef: "page-a",
          state: { status: "available", sourceRevision: "revision-a", completeness: "complete" },
          observations: [observation("repeat-a")],
        }),
      ]),
      trustCeiling: "observed",
      contentPolicyId: CONTENT_POLICY_ID,
    });
    const { learning } = await createHarness([source]);

    const first = await learning.ingest(source, null);
    const second = await learning.ingest(source, null);

    expect(first.observationIds).toEqual(["receipt-repeat/repeat-a"]);
    expect(second.observationIds).toEqual([]);
    expect(second.pageReceiptIds).toEqual(first.pageReceiptIds);
    expect(second.importReceipt).toEqual(first.importReceipt);
    expect(second.id).toBe(first.id);

    const receipts = itemsOf(
      await collectPages(learning.querySourcePageReceipts({ receiptIds: first.pageReceiptIds, limit: 10 })),
    );
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.derivatives).toEqual([
      expect.objectContaining({ kind: "observation", id: "receipt-repeat/repeat-a" }),
    ]);
    await expect(learning.getImportReceipt({ importReceiptId: first.id })).resolves.toEqual(first.importReceipt);
  });

  it("snapshots and freezes source registration and content-policy configuration before ingest", async () => {
    const descriptor = { id: "receipt-immutable-registration", adapterVersion: "1.2.3" };
    const adapter: EvidenceSource<null> = {
      descriptor,
      probe: () => Promise.resolve({ supported: true, diagnostics: [] }),
      read: async function* (): AsyncIterable<EvidencePage> {
        yield evidencePage({
          sourceRef: "immutable-artifact",
          pageRef: "immutable-page",
          state: { status: "available", sourceRevision: "immutable-revision", completeness: "complete" },
          observations: [observation("immutable-observation")],
        });
      },
    };
    const source = defineSourceRegistration({
      source: adapter,
      trustCeiling: "observed",
      contentPolicyId: "mutable-policy",
    });
    descriptor.adapterVersion = "9.9.9";

    let originalTransformCalls = 0;
    let replacementTransformCalls = 0;
    const originalPolicyDigest = "a".repeat(64);
    const mutablePolicy: {
      id: string;
      digest: string;
      maximumInputBytes: number;
      outboundUse: "forbidden";
      transform: ContentPolicy["transform"];
    } = {
      id: "mutable-policy",
      digest: originalPolicyDigest,
      maximumInputBytes: 1_024,
      outboundUse: "forbidden",
      transform: () => {
        originalTransformCalls += 1;
        return Promise.resolve({
          accepted: { transformedBy: "original" },
          classification: "structured",
          diagnostics: [],
        });
      },
    };
    const learning = createLearningLoop({
      store: createInMemoryStore(),
      policy: conservativePolicy(),
      identity: createTestIdentityPort(),
      scopePolicy: createExactScopePolicy(),
      contentPolicies: [mutablePolicy],
      sources: [source],
      queryCursorScope: "receipt-immutable-registration-tests",
      clock: createFixedClock("2026-08-19T00:00:00.000Z"),
      ids: createSequentialIds("immutable"),
    });
    mutablePolicy.digest = "b".repeat(64);
    mutablePolicy.transform = () => {
      replacementTransformCalls += 1;
      return Promise.resolve({
        accepted: { transformedBy: "replacement" },
        classification: "structured",
        diagnostics: [],
      });
    };

    expect(Object.isFrozen(source)).toBe(true);
    expect(Reflect.set(source, "id", "mutated-source")).toBe(false);
    expect(source.id).toBe("receipt-immutable-registration");

    const ingest = await learning.ingest(source, null);
    const page = itemsOf(
      await collectPages(learning.querySourcePageReceipts({ receiptIds: ingest.pageReceiptIds, limit: 10 })),
    )[0];
    const observations = itemsOf(await collectPages(learning.queryObservations({ sourceIds: [source.id], limit: 10 })));

    expect(page).toMatchObject({ adapterVersion: "1.2.3", contentPolicyDigest: originalPolicyDigest });
    expect(observations).toEqual([expect.objectContaining({ data: { transformedBy: "original" } })]);
    expect(originalTransformCalls).toBe(1);
    expect(replacementTransformCalls).toBe(0);
  });

  it("preserves source page order, folds worst completeness, and sorts unique exact revisions", async () => {
    const source = defineSourceRegistration({
      source: scriptedSource("receipt-pages", () => [
        evidencePage({
          sourceRef: "artifact-shared",
          pageRef: "page-first",
          state: { status: "available", sourceRevision: "revision-z", completeness: "complete" },
          observations: [observation("ordered-first")],
        }),
        evidencePage({
          sourceRef: "artifact-shared",
          pageRef: "page-second",
          state: { status: "available", sourceRevision: "revision-a", completeness: "partial" },
          observations: [observation("ordered-second", "partial")],
        }),
        evidencePage({
          sourceRef: "artifact-shared",
          pageRef: "page-third",
          state: { status: "missing", observedRevision: "revision-m" },
        }),
      ]),
      trustCeiling: "observed",
      contentPolicyId: CONTENT_POLICY_ID,
    });
    const { learning } = await createHarness([source]);

    const receipt = await learning.ingest(source, null);
    const pages = itemsOf(await collectPages(learning.querySourcePageReceipts({ sourceIds: [source.id], limit: 10 })));

    expect(receipt.observationIds).toEqual(["receipt-pages/ordered-first", "receipt-pages/ordered-second"]);
    expect(pages.map((page) => page.pageRef)).toEqual(["page-first", "page-second", "page-third"]);
    expect(receipt.pageReceiptIds).toEqual(pages.map((page) => page.id));
    expect(receipt.sourceRevisions).toEqual(["revision-a", "revision-m", "revision-z"]);
    expect(receipt.completeness).toBe("unknown");
    expect(receipt.importReceipt.pageReceiptIds).toEqual(receipt.pageReceiptIds);
    expect(receipt.importReceipt.sourceRevisions).toEqual(receipt.sourceRevisions);

    const health = itemsOf(
      await collectPages(learning.queryEvidenceHealthFindings({ sourceIds: [source.id], limit: 10 })),
    );
    expect(health.map((finding) => finding.code)).toEqual(["source.partial", "source.missing"]);
  });

  it("records every unavailable state as evidence health, never as an empty successful page", async () => {
    const statuses = ["missing", "unreadable", "unsupported", "corrupt"] as const;
    const source = defineSourceRegistration({
      source: scriptedSource("receipt-unavailable", () =>
        statuses.map((status, index) =>
          evidencePage({
            sourceRef: `artifact-${status}`,
            pageRef: `page-${status}`,
            state: {
              status,
              ...(index % 2 === 0 ? { observedRevision: `revision-${status}` } : {}),
            },
          }),
        ),
      ),
      trustCeiling: "advisory",
      contentPolicyId: CONTENT_POLICY_ID,
    });
    const { learning } = await createHarness([source]);

    const receipt = await learning.ingest(source, null);
    const pages = itemsOf(await collectPages(learning.querySourcePageReceipts({ sourceIds: [source.id], limit: 10 })));
    const findings = itemsOf(
      await collectPages(learning.queryEvidenceHealthFindings({ sourceIds: [source.id], limit: 10 })),
    );

    expect(receipt.observationIds).toEqual([]);
    expect(receipt.measurementIds).toEqual([]);
    expect(receipt.episodeIds).toEqual([]);
    expect(receipt.completeness).toBe("unknown");
    expect(pages).toHaveLength(4);
    expect(pages.every((page) => page.derivatives.length === 0 && page.projectionCounts.rejected === 0)).toBe(true);
    expect(findings.map((finding) => finding.code)).toEqual([
      "source.missing",
      "source.unreadable",
      "source.unsupported",
      "source.corrupt",
    ]);
    expect(findings.every((finding) => finding.effect === "blocks_use" && finding.completeness === "unknown")).toBe(
      true,
    );
  });

  it("refuses an unavailable page carrying projections before any derivative or receipt write", async () => {
    const source = defineSourceRegistration({
      source: scriptedSource("receipt-invalid-unavailable", () => [
        evidencePage({
          sourceRef: "invalid-unavailable-artifact",
          pageRef: "invalid-unavailable-page",
          state: { status: "unreadable" },
          observations: [observation("must-not-persist")],
        }),
      ]),
      trustCeiling: "advisory",
      contentPolicyId: CONTENT_POLICY_ID,
    });
    const { learning } = await createHarness([source]);

    await expect(learning.ingest(source, null)).rejects.toMatchObject({ code: "schema.invalid" });
    expect(
      itemsOf(await collectPages(learning.querySourcePageReceipts({ sourceIds: [source.id], limit: 10 }))),
    ).toEqual([]);
    expect(itemsOf(await collectPages(learning.queryObservations({ sourceIds: [source.id], limit: 10 })))).toEqual([]);
  });

  it("keeps partial available evidence usable while durably limiting downstream claims", async () => {
    const source = defineSourceRegistration({
      source: scriptedSource("receipt-partial", () => [
        evidencePage({
          sourceRef: "partial-artifact",
          pageRef: "partial-page",
          state: { status: "available", sourceRevision: "partial-revision", completeness: "partial" },
          observations: [observation("partial-observation", "partial")],
        }),
      ]),
      trustCeiling: "observed",
      contentPolicyId: CONTENT_POLICY_ID,
    });
    const { learning } = await createHarness([source]);

    const receipt = await learning.ingest(source, null);
    const page = itemsOf(
      await collectPages(learning.querySourcePageReceipts({ receiptIds: receipt.pageReceiptIds, limit: 10 })),
    )[0];
    const finding = itemsOf(
      await collectPages(learning.queryEvidenceHealthFindings({ sourceIds: [source.id], limit: 10 })),
    )[0];

    expect(receipt.observationIds).toEqual(["receipt-partial/partial-observation"]);
    expect(receipt.completeness).toBe("partial");
    expect(page?.derivatives).toEqual([
      expect.objectContaining({ kind: "observation", id: "receipt-partial/partial-observation" }),
    ]);
    expect(finding).toMatchObject({
      code: "source.partial",
      effect: "limits_claims",
      completeness: "partial",
      affectedRecords: 1,
    });
  });

  it("scopes revision refusal to the exact sourceRef and pageRef", async () => {
    let pages: readonly EvidencePage[] = [
      evidencePage({
        sourceRef: "one-artifact",
        pageRef: "page-a",
        state: { status: "available", sourceRevision: "revision-a1", completeness: "complete" },
        observations: [observation("revision-a1")],
      }),
      evidencePage({
        sourceRef: "one-artifact",
        pageRef: "page-b",
        state: { status: "available", sourceRevision: "revision-b1", completeness: "complete" },
        observations: [observation("revision-b1")],
      }),
    ];
    const source = defineSourceRegistration({
      source: scriptedSource("receipt-revisions", () => pages),
      trustCeiling: "observed",
      contentPolicyId: CONTENT_POLICY_ID,
    });
    const { learning } = await createHarness([source]);

    const first = await learning.ingest(source, null);
    expect(first.observationIds).toEqual(["receipt-revisions/revision-a1", "receipt-revisions/revision-b1"]);

    pages = [
      evidencePage({
        sourceRef: "one-artifact",
        pageRef: "page-a",
        state: { status: "available", sourceRevision: "revision-a2", completeness: "complete" },
        observations: [observation("revision-a2")],
      }),
      evidencePage({
        sourceRef: "one-artifact",
        pageRef: "page-b",
        state: { status: "available", sourceRevision: "revision-b1", completeness: "complete" },
        observations: [observation("revision-b1")],
      }),
    ];
    const second = await learning.ingest(source, null);
    const secondPages = itemsOf(
      await collectPages(learning.querySourcePageReceipts({ receiptIds: second.pageReceiptIds, limit: 10 })),
    );
    const revisionFindings = itemsOf(
      await collectPages(
        learning.queryEvidenceHealthFindings({
          sourceIds: [source.id],
          codes: ["source.revision_changed"],
          limit: 10,
        }),
      ),
    );

    expect(second.observationIds).toEqual([]);
    expect(second.pageReceiptIds[1]).toBe(first.pageReceiptIds[1]);
    expect(secondPages.find((page) => page.pageRef === "page-a")).toMatchObject({
      state: { sourceRevision: "revision-a2" },
      derivatives: [],
      projectionCounts: { rejected: 1 },
    });
    expect(secondPages.find((page) => page.pageRef === "page-b")?.derivatives).toEqual([
      expect.objectContaining({ id: "receipt-revisions/revision-b1" }),
    ]);
    expect(revisionFindings).toEqual([
      expect.objectContaining({ sourceRef: "one-artifact", pageRef: "page-a", affectedRecords: 1 }),
    ]);
  });

  it("treats observed revisions on unavailable pages as exact claims that later distinct revisions cannot replace", async () => {
    let pages: readonly EvidencePage[] = [
      evidencePage({
        sourceRef: "observed-artifact",
        pageRef: "becomes-available",
        state: { status: "missing", observedRevision: "observed-r1" },
      }),
      evidencePage({
        sourceRef: "observed-artifact",
        pageRef: "stays-unavailable",
        state: { status: "unreadable", observedRevision: "unavailable-r1" },
      }),
    ];
    const source = defineSourceRegistration({
      source: scriptedSource("receipt-observed-revisions", () => pages),
      trustCeiling: "advisory",
      contentPolicyId: CONTENT_POLICY_ID,
    });
    const { learning } = await createHarness([source]);

    const first = await learning.ingest(source, null);
    expect(first.sourceRevisions).toEqual(["observed-r1", "unavailable-r1"]);

    pages = [
      evidencePage({
        sourceRef: "observed-artifact",
        pageRef: "becomes-available",
        state: { status: "available", sourceRevision: "observed-r2", completeness: "complete" },
        observations: [observation("must-block-after-observed-revision")],
      }),
      evidencePage({
        sourceRef: "observed-artifact",
        pageRef: "stays-unavailable",
        state: { status: "unreadable", observedRevision: "unavailable-r2" },
      }),
    ];
    const second = await learning.ingest(source, null);
    const secondPages = itemsOf(
      await collectPages(learning.querySourcePageReceipts({ receiptIds: second.pageReceiptIds, limit: 10 })),
    );
    const revisionFindings = itemsOf(
      await collectPages(
        learning.queryEvidenceHealthFindings({
          sourceIds: [source.id],
          codes: ["source.revision_changed"],
          limit: 10,
        }),
      ),
    );

    expect(second.observationIds).toEqual([]);
    expect(secondPages.find((page) => page.pageRef === "becomes-available")).toMatchObject({
      state: { status: "available", sourceRevision: "observed-r2" },
      derivatives: [],
      projectionCounts: { observations: 1, measurements: 0, episodes: 0, rejected: 1 },
    });
    expect(secondPages.find((page) => page.pageRef === "stays-unavailable")).toMatchObject({
      state: { status: "unreadable", observedRevision: "unavailable-r2" },
      derivatives: [],
    });
    expect(revisionFindings).toEqual([
      expect.objectContaining({ pageRef: "becomes-available", effect: "blocks_use", affectedRecords: 1 }),
      expect.objectContaining({ pageRef: "stays-unavailable", effect: "blocks_use", affectedRecords: 0 }),
    ]);
  });

  it("normalizes diagnostic codes and never persists or returns adapter messages, paths, details, or content", async () => {
    const canary = "PRIVATE-DIAGNOSTIC-CANARY-7d97";
    const source = defineSourceRegistration({
      source: scriptedSource("receipt-diagnostics", () => [
        evidencePage({
          sourceRef: "privacy-safe-artifact",
          pageRef: "privacy-safe-page",
          state: { status: "available", sourceRevision: "privacy-revision", completeness: "complete" },
          diagnostics: [
            {
              code: `native.${canary}`,
              severity: "warning",
              message: canary,
              path: ["native", canary],
              details: { secret: canary },
            },
            { code: "another.native.code", severity: "warning", message: canary },
            { code: "source.incomplete", severity: "error", message: canary },
          ],
        }),
      ]),
      trustCeiling: "advisory",
      contentPolicyId: CONTENT_POLICY_ID,
    });
    const { learning, store } = await createHarness([source]);

    const ingest = await learning.ingest(source, null);
    const page = itemsOf(
      await collectPages(learning.querySourcePageReceipts({ receiptIds: ingest.pageReceiptIds, limit: 10 })),
    )[0];
    const health = itemsOf(
      await collectPages(learning.queryEvidenceHealthFindings({ sourceIds: [source.id], limit: 10 })),
    );

    expect(page?.diagnosticCounts).toEqual([
      { code: "source.adapter_diagnostic", severity: "warning", count: 2 },
      { code: "source.incomplete", severity: "error", count: 1 },
    ]);
    expect(health).toEqual([expect.objectContaining({ code: "source.adapter_diagnostic", affectedRecords: 3 })]);
    expect(JSON.stringify(ingest)).not.toContain(canary);
    expect(JSON.stringify(await storedValues(store, "source-page-receipt"))).not.toContain(canary);
    expect(JSON.stringify(await storedValues(store, "evidence-health"))).not.toContain(canary);
  });

  it("fails closed when a content policy returns malformed unknown output", async () => {
    const source = defineSourceRegistration({
      source: scriptedSource("receipt-bad-policy", () => [
        evidencePage({
          sourceRef: "bad-policy-artifact",
          pageRef: "bad-policy-page",
          state: { status: "available", sourceRevision: "bad-policy-revision", completeness: "complete" },
          observations: [observation("bad-policy-observation")],
        }),
      ]),
      trustCeiling: "observed",
      contentPolicyId: "malformed-policy",
    });
    const malformedPolicy: ContentPolicy = {
      id: "malformed-policy",
      digest: "f".repeat(64),
      maximumInputBytes: 1_024,
      outboundUse: "forbidden",
      transform: malformedContentPolicyTransform,
    };
    const learning = createLearningLoop({
      store: createInMemoryStore(),
      policy: conservativePolicy(),
      identity: createTestIdentityPort(),
      scopePolicy: createExactScopePolicy(),
      contentPolicies: [malformedPolicy],
      sources: [source],
      queryCursorScope: "receipt-bad-policy-tests",
      clock: createFixedClock("2026-08-19T00:00:00.000Z"),
      ids: createSequentialIds("receipt"),
    });

    const receipt = await learning.ingest(source, null);
    const page = itemsOf(
      await collectPages(learning.querySourcePageReceipts({ receiptIds: receipt.pageReceiptIds, limit: 10 })),
    )[0];
    const health = itemsOf(
      await collectPages(learning.queryEvidenceHealthFindings({ sourceIds: [source.id], limit: 10 })),
    );

    expect(receipt.observationIds).toEqual([]);
    expect(receipt.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: "schema.invalid" })]));
    expect(page).toMatchObject({
      derivatives: [],
      projectionCounts: { observations: 1, measurements: 0, episodes: 0, rejected: 1 },
      diagnosticCounts: [{ code: "schema.invalid", severity: "error", count: 1 }],
    });
    expect(health).toEqual([
      expect.objectContaining({ code: "source.record_rejected", effect: "blocks_audit", affectedRecords: 1 }),
    ]);
  });

  it("provides bounded filter-bound receipt and health queries plus exact import lookup", async () => {
    const source = defineSourceRegistration({
      source: scriptedSource("receipt-query", () => [
        evidencePage({
          sourceRef: "query-artifact-a",
          pageRef: "query-page-a",
          state: { status: "available", sourceRevision: "query-revision-a", completeness: "complete" },
        }),
        evidencePage({
          sourceRef: "query-artifact-b",
          pageRef: "query-page-b",
          state: { status: "available", sourceRevision: "query-revision-b", completeness: "partial" },
        }),
        evidencePage({
          sourceRef: "query-artifact-c",
          pageRef: "query-page-c",
          state: { status: "unreadable" },
        }),
      ]),
      trustCeiling: "advisory",
      contentPolicyId: CONTENT_POLICY_ID,
    });
    const { learning } = await createHarness([source], { queryCursorScope: "receipt-query-tests" });
    const ingest = await learning.ingest(source, null);

    const firstReceiptPage = await firstPage(learning.querySourcePageReceipts({ sourceIds: [source.id], limit: 1 }));
    expect(firstReceiptPage.items).toHaveLength(1);
    expect(firstReceiptPage.nextCursor).toBeDefined();
    if (firstReceiptPage.nextCursor === undefined) throw new Error("expected a receipt continuation cursor");
    const resumedReceipts = itemsOf(
      await collectPages(
        learning.querySourcePageReceipts({
          sourceIds: [source.id, source.id],
          cursor: firstReceiptPage.nextCursor,
          limit: 10,
        }),
      ),
    );
    expect(resumedReceipts.map((receipt) => receipt.pageRef)).toEqual(["query-page-b", "query-page-c"]);
    await expect(
      collectPages(
        learning.querySourcePageReceipts({
          sourceIds: [source.id],
          states: ["available"],
          cursor: firstReceiptPage.nextCursor,
          limit: 10,
        }),
      ),
    ).rejects.toMatchObject({ code: "query.cursor_mismatch" });

    const filteredReceipts = itemsOf(
      await collectPages(
        learning.querySourcePageReceipts({
          sourceRefs: ["query-artifact-b"],
          pageRefs: ["query-page-b"],
          sourceRevisions: ["query-revision-b"],
          states: ["available"],
          limit: 10,
        }),
      ),
    );
    expect(filteredReceipts).toEqual([expect.objectContaining({ pageRef: "query-page-b" })]);

    const firstHealthPage = await firstPage(learning.queryEvidenceHealthFindings({ sourceIds: [source.id], limit: 1 }));
    expect(firstHealthPage.items).toHaveLength(1);
    expect(firstHealthPage.nextCursor).toBeDefined();
    if (firstHealthPage.nextCursor === undefined) throw new Error("expected a health continuation cursor");
    const resumedHealth = itemsOf(
      await collectPages(
        learning.queryEvidenceHealthFindings({
          sourceIds: [source.id],
          cursor: firstHealthPage.nextCursor,
          limit: 10,
        }),
      ),
    );
    expect(resumedHealth).toEqual([
      expect.objectContaining({ code: "source.unreadable", effect: "blocks_use", pageRef: "query-page-c" }),
    ]);
    expect(
      itemsOf(
        await collectPages(
          learning.queryEvidenceHealthFindings({
            codes: ["source.partial"],
            effects: ["limits_claims"],
            pageRefs: ["query-page-b"],
            limit: 10,
          }),
        ),
      ),
    ).toEqual([expect.objectContaining({ sourceId: source.id })]);

    await expect(learning.getImportReceipt({ importReceiptId: ingest.id })).resolves.toEqual(ingest.importReceipt);
    await expect(learning.getImportReceipt({ importReceiptId: "import-does-not-exist" })).resolves.toBeUndefined();
    await expect(collectPages(learning.querySourcePageReceipts({ limit: 0 }))).rejects.toMatchObject({
      code: "query.invalid",
    });
  });

  it("writes accepted derivatives before findings, then the page commit marker, then the import receipt", async () => {
    const writes: string[] = [];
    const store = recordingStore(createInMemoryStore(), writes);
    const source = defineSourceRegistration({
      source: scriptedSource("receipt-order", () => [
        evidencePage({
          sourceRef: "order-artifact",
          pageRef: "order-page",
          state: { status: "available", sourceRevision: "order-revision", completeness: "partial" },
          observations: [observation("order-observation", "partial")],
        }),
      ]),
      trustCeiling: "observed",
      contentPolicyId: CONTENT_POLICY_ID,
    });
    const { learning } = await createHarness([source], { store });

    await learning.ingest(source, null);

    const derivativeIndex = writes.indexOf("observation");
    const healthIndex = writes.indexOf("evidence-health");
    const pageReceiptIndex = writes.indexOf("source-page-receipt");
    const importReceiptIndex = writes.indexOf("import-receipt");
    expect(derivativeIndex).toBeGreaterThan(-1);
    expect(healthIndex).toBeGreaterThan(derivativeIndex);
    expect(pageReceiptIndex).toBeGreaterThan(healthIndex);
    expect(importReceiptIndex).toBeGreaterThan(pageReceiptIndex);
  });

  it("recovers deterministically when the page receipt committed but its acknowledgement was lost", async () => {
    const base = createInMemoryStore();
    const store = loseFirstPageReceiptAcknowledgement(base);
    const source = defineSourceRegistration({
      source: scriptedSource("receipt-crash", () => [
        evidencePage({
          sourceRef: "crash-artifact",
          pageRef: "crash-page",
          state: { status: "available", sourceRevision: "crash-revision", completeness: "complete" },
          observations: [observation("crash-observation")],
        }),
      ]),
      trustCeiling: "observed",
      contentPolicyId: CONTENT_POLICY_ID,
    });
    const { learning } = await createHarness([source], { store });

    await expect(learning.ingest(source, null)).rejects.toThrow("simulated lost acknowledgement");
    const committedBeforeRetry = (await storedValues(base, "source-page-receipt")).map((value) =>
      parseSourcePageReceipt(value),
    );
    expect(committedBeforeRetry).toHaveLength(1);
    expect(await storedValues(base, "import-receipt")).toEqual([]);

    const retry = await learning.ingest(source, null);
    expect(retry.observationIds).toEqual([]);
    expect(retry.pageReceiptIds).toEqual(committedBeforeRetry.map((receipt) => receipt.id));
    expect(retry.importReceipt.pageReceiptIds).toEqual(retry.pageReceiptIds);
    expect(await storedValues(base, "source-page-receipt")).toHaveLength(1);
    expect(await storedValues(base, "import-receipt")).toHaveLength(1);
  });

  it("repairs derivatives and findings left without a page commit marker after a pre-create failure", async () => {
    const base = createInMemoryStore();
    const store = failBeforeFirstPageReceiptCreate(base);
    const source = defineSourceRegistration({
      source: scriptedSource("receipt-pre-marker-crash", () => [
        evidencePage({
          sourceRef: "pre-marker-artifact",
          pageRef: "pre-marker-page",
          state: { status: "available", sourceRevision: "pre-marker-revision", completeness: "partial" },
          observations: [observation("pre-marker-observation", "partial")],
        }),
      ]),
      trustCeiling: "observed",
      contentPolicyId: CONTENT_POLICY_ID,
    });
    const { learning } = await createHarness([source], { store });

    await expect(learning.ingest(source, null)).rejects.toThrow("simulated failure before page receipt commit");
    expect(await storedValues(base, "observation")).toHaveLength(1);
    expect(await storedValues(base, "evidence-health")).toHaveLength(1);
    expect(await storedValues(base, "source-page-receipt")).toEqual([]);
    expect(await storedValues(base, "import-receipt")).toEqual([]);

    const retry = await learning.ingest(source, null);
    expect(retry.observationIds).toEqual([]);
    expect(retry.pageReceiptIds).toHaveLength(1);
    expect(retry.importReceipt.pageReceiptIds).toEqual(retry.pageReceiptIds);
    expect(await storedValues(base, "observation")).toHaveLength(1);
    expect(await storedValues(base, "evidence-health")).toHaveLength(1);
    expect(await storedValues(base, "source-page-receipt")).toHaveLength(1);
    expect(await storedValues(base, "import-receipt")).toHaveLength(1);
  });

  it("atomically assigns one owner when different pages concurrently ingest the same unreceipted derivative", async () => {
    const source = defineSourceRegistration({
      source: concurrentObservationSource(),
      trustCeiling: "observed",
      contentPolicyId: CONTENT_POLICY_ID,
    });
    const { learning } = await createHarness([source]);

    await Promise.all([learning.ingest(source, "page-a"), learning.ingest(source, "page-b")]);
    const receipts = [
      ...itemsOf(await collectPages(learning.querySourcePageReceipts({ sourceIds: [source.id], limit: 10 }))),
    ].sort((left, right) => (left.pageRef < right.pageRef ? -1 : left.pageRef > right.pageRef ? 1 : 0));

    expect(receipts.map((receipt) => receipt.pageRef)).toEqual(["page-a", "page-b"]);
    expect(receipts.flatMap((receipt) => receipt.derivatives)).toEqual([
      expect.objectContaining({ kind: "observation", id: `${source.id}/shared-observation` }),
    ]);
    expect(receipts.filter((receipt) => receipt.derivatives.length === 1)).toHaveLength(1);
    expect(receipts.filter((receipt) => receipt.projectionCounts.reused === 1)).toHaveLength(1);
    expect(receipts.every((receipt) => receipt.projectionCounts.rejected === 0)).toBe(true);

    await learning.ingest(source, "page-a");
    await learning.ingest(source, "page-b");
    const retried = itemsOf(
      await collectPages(learning.querySourcePageReceipts({ sourceIds: [source.id], limit: 10 })),
    );
    expect(retried).toHaveLength(2);
    expect(retried.flatMap((receipt) => receipt.derivatives)).toHaveLength(1);
    expect(retried.filter((receipt) => receipt.projectionCounts.reused === 1)).toHaveLength(1);
  });

  it("recovers idempotently when the derivative owner committed but its acknowledgement was lost", async () => {
    const base = createInMemoryStore();
    const store = loseFirstDerivativeOwnerAcknowledgement(base);
    const source = defineSourceRegistration({
      source: concurrentObservationSource(),
      trustCeiling: "observed",
      contentPolicyId: CONTENT_POLICY_ID,
    });
    const { learning } = await createHarness([source], { store });

    await expect(learning.ingest(source, "owner-page")).rejects.toThrow("lost derivative owner acknowledgement");
    expect(await storedValues(base, "derivative-owner")).toHaveLength(1);
    expect(await storedValues(base, "observation")).toEqual([]);
    expect(await storedValues(base, "source-page-receipt")).toEqual([]);

    const retry = await learning.ingest(source, "owner-page");
    expect(retry.observationIds).toEqual([`${source.id}/shared-observation`]);
    expect(await storedValues(base, "derivative-owner")).toHaveLength(1);
    expect(await storedValues(base, "observation")).toHaveLength(1);
    expect(await storedValues(base, "source-page-receipt")).toHaveLength(1);
    const replay = await learning.ingest(source, "owner-page");
    expect(replay.pageReceiptIds).toEqual(retry.pageReceiptIds);
  });

  it("rejects a self-consistent derivative owner claim that disagrees with its committed page receipt", async () => {
    const base = createInMemoryStore();
    const source = defineSourceRegistration({
      source: concurrentObservationSource(),
      trustCeiling: "observed",
      contentPolicyId: CONTENT_POLICY_ID,
    });
    const { learning } = await createHarness([source], { store: base });
    await learning.ingest(source, "committed-page");
    const receipts = itemsOf(
      await collectPages(learning.querySourcePageReceipts({ sourceIds: [source.id], limit: 10 })),
    );
    const receipt = receipts[0];
    const derivative = receipt?.derivatives[0];
    if (receipt === undefined || derivative === undefined) throw new Error("missing derivative owner fixtures");
    const owners = await base.list({ namespace: "learning", kind: "derivative-owner", limit: 10 });
    const storedOwner = owners.records[0];
    if (storedOwner === undefined) throw new Error("missing stored derivative owner");
    const foreignOwner = {
      sourceId: source.id,
      sourceRegistrationRevision: source.registryRevision,
      contentPolicyId: receipt.contentPolicyId,
      contentPolicyDigest: receipt.contentPolicyDigest,
      loopRegistryRevision: receipt.loopRegistryRevision,
      sourceRef: receipt.sourceRef,
      pageRef: "foreign-owner-page",
      state: receipt.state,
    };
    const ownerDigest = sha256HexOfCanonicalJson(toJsonValue(foreignOwner));
    const bound = { derivative, owner: foreignOwner, ownerDigest };
    const forged = {
      schemaVersion: 1,
      ...bound,
      claimDigest: sha256HexOfCanonicalJson(toJsonValue(bound)),
    };
    const value = toJsonValue(forged);
    await expect(
      base.compareAndSet(
        storedOwner.key,
        storedOwner.revision,
        value,
        sha256HexOfCanonicalJson(value),
        "forge-derivative-owner",
      ),
    ).resolves.toMatchObject({ status: "updated" });

    const refused = await learning.ingest(source, "committed-page");
    expect(refused.observationIds).toEqual([]);
    expect(refused.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: "store.corrupt" })]));
    const refusedReceipt = itemsOf(
      await collectPages(learning.querySourcePageReceipts({ receiptIds: refused.pageReceiptIds, limit: 10 })),
    )[0];
    expect(refusedReceipt).toMatchObject({
      derivatives: [],
      projectionCounts: { observations: 1, rejected: 1 },
    });
  });

  it("rejects tampering in every durable receipt parser", async () => {
    const source = defineSourceRegistration({
      source: scriptedSource("receipt-parser", () => [
        evidencePage({
          sourceRef: "parser-artifact",
          pageRef: "parser-page",
          state: { status: "available", sourceRevision: "parser-revision", completeness: "partial" },
          observations: [observation("parser-observation", "partial")],
        }),
      ]),
      trustCeiling: "advisory",
      contentPolicyId: CONTENT_POLICY_ID,
    });
    const { learning } = await createHarness([source]);
    const receipt = await learning.ingest(source, null);
    const page = itemsOf(
      await collectPages(learning.querySourcePageReceipts({ receiptIds: receipt.pageReceiptIds, limit: 10 })),
    )[0];
    const finding = itemsOf(
      await collectPages(learning.queryEvidenceHealthFindings({ sourceIds: [source.id], limit: 10 })),
    )[0];
    if (page === undefined || finding === undefined) throw new Error("expected receipt fixtures");

    expect(() => parseSourcePageReceipt({ ...page, pageRef: "tampered-page" })).toThrowError(
      expect.objectContaining({ code: "schema.corrupt" }),
    );
    expect(() => parseEvidenceHealthFinding({ ...finding, affectedRecords: finding.affectedRecords + 1 })).toThrowError(
      expect.objectContaining({ code: "schema.corrupt" }),
    );
    expect(() =>
      parseImportReceipt({ ...receipt.importReceipt, pageReceiptIds: [...receipt.importReceipt.pageReceiptIds, "x"] }),
    ).toThrowError(expect.objectContaining({ code: "schema.corrupt" }));

    const unsortedDiagnosticCounts: SourcePageReceipt["diagnosticCounts"] = [
      { code: "source.incomplete", severity: "warning", count: 1 },
      { code: "source.adapter_diagnostic", severity: "warning", count: 1 },
    ];
    const unsortedPageContent = {
      ...page,
      diagnosticCounts: unsortedDiagnosticCounts,
    };
    const unsortedPageDigest = sourcePageReceiptDigest(unsortedPageContent);
    expect(() =>
      parseSourcePageReceipt({
        ...unsortedPageContent,
        id: `source-page-${unsortedPageDigest}`,
        receiptDigest: unsortedPageDigest,
      }),
    ).toThrowError(expect.objectContaining({ code: "schema.corrupt" }));

    const unsortedImportContent = {
      ...receipt.importReceipt,
      sourceRevisions: ["revision-z", "revision-a"],
    };
    const unsortedImportDigest = importReceiptDigest(unsortedImportContent);
    expect(() =>
      parseImportReceipt({
        ...unsortedImportContent,
        id: `import-${unsortedImportDigest}`,
        receiptDigest: unsortedImportDigest,
      }),
    ).toThrowError(expect.objectContaining({ code: "schema.corrupt" }));

    const unsafeHealthContent = { ...finding, affectedRecords: Number.MAX_SAFE_INTEGER + 1 };
    const unsafeHealthDigest = evidenceHealthFindingDigest(unsafeHealthContent);
    expect(() =>
      parseEvidenceHealthFinding({
        ...unsafeHealthContent,
        id: `evidence-health-${unsafeHealthDigest}`,
        findingDigest: unsafeHealthDigest,
      }),
    ).toThrowError(expect.objectContaining({ code: "schema.invalid" }));

    const derivative = page.derivatives[0];
    if (derivative === undefined) throw new Error("expected a derivative fixture");
    const foreignDerivativeContent = {
      ...page,
      derivatives: [{ ...derivative, id: "foreign-source/foreign-observation" }],
    };
    const foreignDerivativeDigest = sourcePageReceiptDigest(foreignDerivativeContent);
    expect(() =>
      parseSourcePageReceipt({
        ...foreignDerivativeContent,
        id: `source-page-${foreignDerivativeDigest}`,
        receiptDigest: foreignDerivativeDigest,
      }),
    ).toThrowError(expect.objectContaining({ code: "schema.corrupt" }));

    const duplicateDerivativeContent = {
      ...page,
      derivatives: [derivative, derivative],
      projectionCounts: { observations: 2, measurements: 0, episodes: 0, rejected: 0 },
    };
    const duplicateDerivativeDigest = sourcePageReceiptDigest(duplicateDerivativeContent);
    expect(() =>
      parseSourcePageReceipt({
        ...duplicateDerivativeContent,
        id: `source-page-${duplicateDerivativeDigest}`,
        receiptDigest: duplicateDerivativeDigest,
      }),
    ).toThrowError(expect.objectContaining({ code: "schema.corrupt" }));
  });
});
