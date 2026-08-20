// #30b2a public semantic reads: bounded, exact-scope queries over an
// append-visible committed/orphaned graph. Persistence fixtures are supplied
// by the private conformance harness; no public method can mint these facts.
import { describe, expect, it } from "vitest";
import type { LearningStore, QueryPage } from "../src/index.js";
import {
  conservativePolicy,
  createLearningLoop,
  parseObservation,
  scopeDigest,
  sha256HexOfCanonicalJson,
  toJsonValue,
} from "../src/index.js";
import { persistDetectorExecution } from "../src/engine/semantic-persistence.js";
import {
  createExactScopePolicy,
  createInMemoryStore,
  createStructuredContentPolicy,
  createTestIdentityPort,
} from "../src/testing/index.js";
import {
  SEMANTIC_CONTENT_POLICY_ID,
  SEMANTIC_SCOPE_A,
  SEMANTIC_SCOPE_B,
  createSemanticEngineHarness,
  createSemanticFacts,
} from "./semantic-engine-harness.js";

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
  throw new Error("semantic query returned no page");
}

function emptyLearning(store: LearningStore = createInMemoryStore()) {
  return createLearningLoop({
    store,
    policy: conservativePolicy(),
    identity: createTestIdentityPort(),
    scopePolicy: createExactScopePolicy(),
    contentPolicies: [],
    sources: [],
    queryCursorScope: "semantic-query-tests",
  });
}

function snapshotChangingStore(base: LearningStore, mode: "once" | "always") {
  let enabled = false;
  let changes = 0;
  const store: LearningStore = {
    get: async (key) => {
      const stored = await base.get(key);
      if (enabled && key.kind === "insight-derivation" && (mode === "always" || changes === 0)) {
        changes += 1;
        if (stored === undefined) throw new Error("query mutation fixture requires a stored derivation");
        const observations = await base.list({ namespace: "learning", kind: "observation", limit: 1 });
        const source = observations.records[0];
        if (source === undefined) throw new Error("query mutation fixture requires a stored observation");
        const observation = parseObservation(source.value);
        const markerId = `manual-evidence/semantic-query-marker-${changes}`;
        const value = toJsonValue({
          ...observation,
          id: markerId,
          provenance: { ...observation.provenance, recordRef: `semantic-query-marker-${changes}` },
        });
        await base.create(
          { namespace: "learning", kind: "observation", id: markerId },
          value,
          sha256HexOfCanonicalJson(value),
          `semantic-query-marker-${changes}`,
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
  return { store, enable: () => (enabled = true), changes: () => changes };
}

function keyBoundaryStore(base: LearningStore) {
  let replacement:
    | {
        readonly kind: string;
        readonly targetId: string;
        readonly value: unknown;
        readonly digest: string;
      }
    | undefined;
  const store: LearningStore = {
    get: async (key) => {
      const stored = await base.get(key);
      if (
        stored !== undefined &&
        replacement !== undefined &&
        key.kind === replacement.kind &&
        key.id === replacement.targetId
      ) {
        return { ...stored, value: replacement.value, digest: replacement.digest };
      }
      return stored;
    },
    create: (key, value, digest, operationId) => base.create(key, value, digest, operationId),
    compareAndSet: (key, expectedRevision, value, digest, operationId) =>
      base.compareAndSet(key, expectedRevision, value, digest, operationId),
    append: (stream, expectedRevision, entries, operationId) =>
      base.append(stream, expectedRevision, entries, operationId),
    tombstone: (input) => base.tombstone(input),
    list: async (query) => {
      const page = await base.list(query);
      if (replacement === undefined || query.kind !== replacement.kind) return page;
      return {
        ...page,
        records: page.records.map((record) =>
          record.key.id === replacement?.targetId
            ? { ...record, value: replacement.value, digest: replacement.digest }
            : record,
        ),
      };
    },
  };
  return { store, replace: (value: NonNullable<typeof replacement>) => (replacement = value) };
}

function snapshotHidingStore(base: LearningStore) {
  let enabled = false;
  const store: LearningStore = {
    get: (key) => (enabled && key.kind === "semantic-registry-snapshot" ? Promise.resolve(undefined) : base.get(key)),
    create: (key, value, digest, operationId) => base.create(key, value, digest, operationId),
    compareAndSet: (key, expectedRevision, value, digest, operationId) =>
      base.compareAndSet(key, expectedRevision, value, digest, operationId),
    append: (stream, expectedRevision, entries, operationId) =>
      base.append(stream, expectedRevision, entries, operationId),
    tombstone: (input) => base.tombstone(input),
    list: (query) => base.list(query),
  };
  return { store, enable: () => (enabled = true) };
}

function observingStore(base: LearningStore) {
  let enabled = false;
  const gets: Array<{ readonly namespace: string; readonly kind: string; readonly id: string }> = [];
  const lists: Array<{ readonly namespace: string; readonly kind?: string; readonly cursor?: string }> = [];
  const store: LearningStore = {
    get: (key) => {
      if (enabled) gets.push(key);
      return base.get(key);
    },
    create: (key, value, digest, operationId) => base.create(key, value, digest, operationId),
    compareAndSet: (key, expectedRevision, value, digest, operationId) =>
      base.compareAndSet(key, expectedRevision, value, digest, operationId),
    append: (stream, expectedRevision, entries, operationId) =>
      base.append(stream, expectedRevision, entries, operationId),
    tombstone: (input) => base.tombstone(input),
    list: (query) => {
      if (enabled) {
        lists.push({
          namespace: query.namespace,
          ...(query.kind === undefined ? {} : { kind: query.kind }),
          ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
        });
      }
      return base.list(query);
    },
  };
  return {
    store,
    enable: () => (enabled = true),
    clear: () => {
      gets.length = 0;
      lists.length = 0;
    },
    gets,
    lists,
  };
}

function indexSnapshotChangingStore(base: LearningStore, mode: "once" | "always") {
  let enabled = false;
  let changes = 0;
  let indexKey: { readonly namespace: string; readonly kind: string; readonly id: string } | undefined;
  const store: LearningStore = {
    get: async (key) => {
      const stored = await base.get(key);
      if (
        enabled &&
        key.kind === "insight-derivation" &&
        indexKey !== undefined &&
        (mode === "always" || changes === 0)
      ) {
        const index = await base.get(indexKey);
        if (index === undefined) throw new Error("index snapshot fixture requires a durable scope index");
        changes += 1;
        const value = toJsonValue(index.value);
        const result = await base.compareAndSet(
          indexKey,
          index.revision,
          value,
          index.digest,
          `scope-index-snapshot-${changes}`,
        );
        if (result.status !== "updated") throw new Error("scope index snapshot mutation did not commit");
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
  return {
    store,
    configure: (key: { readonly namespace: string; readonly kind: string; readonly id: string }) => {
      indexKey = key;
      enabled = true;
    },
    changes: () => changes,
  };
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
  if (typeof input !== "object" || input === null || !("items" in input) || !("snapshotRevision" in input)) {
    return false;
  }
  return Array.isArray(input.items) && typeof input.snapshotRevision === "string";
}

async function* invokeUnknownQuery(
  method: (input: never) => unknown,
  input: unknown,
): AsyncIterable<QueryPage<unknown>> {
  const output: unknown = Reflect.apply(method, undefined, [input]);
  if (!isAsyncIterable(output)) throw new Error("semantic query trust-boundary fixture returned another type");
  for await (const page of output) {
    if (!isQueryPage(page)) throw new Error("semantic query trust-boundary fixture returned a malformed page");
    yield page;
  }
}

describe("semantic query trust boundary", () => {
  it("requires an exact scope and a page limit from 1 through 500", async () => {
    const learning = emptyLearning();
    await expect(
      collectPages(invokeUnknownQuery(learning.queryInsightDerivations, { limit: 10 })),
    ).rejects.toMatchObject({ code: "schema.invalid" });
    await expect(
      collectPages(learning.queryDetectorExecutions({ scope: SEMANTIC_SCOPE_A, limit: 0 })),
    ).rejects.toMatchObject({ code: "query.invalid" });
    await expect(
      collectPages(learning.queryInsightDerivations({ scope: SEMANTIC_SCOPE_A, limit: 501 })),
    ).rejects.toMatchObject({ code: "query.invalid" });
  });

  it("rejects unknown fields, oversized filters, invalid enums, ids, digests, and cursors", async () => {
    const learning = emptyLearning();
    await expect(
      collectPages(
        invokeUnknownQuery(learning.queryInsightDerivations, {
          scope: SEMANTIC_SCOPE_A,
          misspelled: [],
          limit: 10,
        }),
      ),
    ).rejects.toMatchObject({ code: "query.invalid" });
    await expect(
      collectPages(
        learning.queryDetectorExecutions({
          scope: SEMANTIC_SCOPE_A,
          detectorIds: Array.from({ length: 1_001 }, (_, index) => `detector-${index}`),
          limit: 10,
        }),
      ),
    ).rejects.toMatchObject({ code: "query.invalid" });
    await expect(
      collectPages(
        learning.queryInsightDerivations({
          scope: SEMANTIC_SCOPE_A,
          detectorRegistrationDigests: ["not-a-digest"],
          limit: 10,
        }),
      ),
    ).rejects.toMatchObject({ code: "schema.invalid" });
    await expect(
      collectPages(
        invokeUnknownQuery(learning.queryDetectorExecutions, {
          scope: SEMANTIC_SCOPE_A,
          statuses: ["pass"],
          limit: 10,
        }),
      ),
    ).rejects.toMatchObject({ code: "schema.invalid" });
    await expect(
      collectPages(
        learning.queryInsightDerivations({
          scope: SEMANTIC_SCOPE_A,
          cursor: "x".repeat(16_385),
          limit: 10,
        }),
      ),
    ).rejects.toMatchObject({ code: "query.invalid" });
  });

  it("returns one bounded empty page and exact getters expose no cross-scope existence oracle", async () => {
    const learning = emptyLearning();
    const derivationPages = await collectPages(learning.queryInsightDerivations({ scope: SEMANTIC_SCOPE_A, limit: 1 }));
    const executionPages = await collectPages(learning.queryDetectorExecutions({ scope: SEMANTIC_SCOPE_A, limit: 1 }));
    expect(derivationPages).toEqual([expect.objectContaining({ items: [], snapshotRevision: expect.any(String) })]);
    expect(executionPages).toEqual([expect.objectContaining({ items: [], snapshotRevision: expect.any(String) })]);
    await expect(
      learning.getInsightDerivation({ derivationId: `insight-${"0".repeat(64)}`, scope: SEMANTIC_SCOPE_B }),
    ).resolves.toBeUndefined();
    await expect(
      learning.getDetectorExecution({
        executionId: `detector-execution-${"0".repeat(64)}`,
        scope: SEMANTIC_SCOPE_B,
      }),
    ).resolves.toBeUndefined();
  });
});

describe("populated semantic queries and exact scope isolation", () => {
  it("applies every derivation/execution filter and conditionDetected only to applied results", async () => {
    const harness = await createSemanticEngineHarness();
    const detected = createSemanticFacts(harness);
    const negative = createSemanticFacts(harness, {
      withEvidence: false,
      executionResult: {
        status: "applied",
        conditionDetected: false,
        derivationRefs: [],
        evidenceHealthFindings: [],
      },
    });
    await persistDetectorExecution(harness.context, detected.execution, [detected.derivation]);
    await persistDetectorExecution(harness.context, negative.execution, []);

    const derivations = itemsOf(
      await collectPages(
        harness.learning.queryInsightDerivations({
          scope: harness.scope,
          derivationIds: [detected.derivation.id],
          detectorIds: [harness.detector.id],
          detectorRegistrationDigests: [harness.detector.registrationDigest],
          packManifestDigests: [harness.pack.manifestDigest],
          lensRegistrationDigests: [harness.lens.registrationDigest],
          learningClasses: [detected.derivation.learningClass],
          producerKinds: [detected.derivation.producer.kind],
          registryStatuses: ["configured"],
          commitStatuses: ["committed"],
          limit: 10,
        }),
      ),
    );
    expect(derivations.map((view) => view.derivation.id)).toEqual([detected.derivation.id]);

    const detectedExecutions = itemsOf(
      await collectPages(
        harness.learning.queryDetectorExecutions({
          scope: harness.scope,
          executionIds: [detected.execution.id],
          detectorIds: [harness.detector.id],
          detectorRegistrationDigests: [harness.detector.registrationDigest],
          packManifestDigests: [harness.pack.manifestDigest],
          lensRegistrationDigests: [harness.lens.registrationDigest],
          statuses: ["applied"],
          conditionDetected: true,
          registryStatuses: ["configured"],
          commitStatuses: ["committed"],
          limit: 10,
        }),
      ),
    );
    expect(detectedExecutions.map((view) => view.execution.id)).toEqual([detected.execution.id]);

    const negativeExecutions = itemsOf(
      await collectPages(
        harness.learning.queryDetectorExecutions({
          scope: harness.scope,
          statuses: ["applied"],
          conditionDetected: false,
          limit: 10,
        }),
      ),
    );
    expect(negativeExecutions.map((view) => view.execution.id)).toEqual([negative.execution.id]);
    expect(
      itemsOf(
        await collectPages(
          harness.learning.queryDetectorExecutions({
            scope: harness.scope,
            statuses: ["not_applicable", "incomplete"],
            conditionDetected: false,
            limit: 10,
          }),
        ),
      ),
    ).toEqual([]);
  });

  it("never enumerates or directly reveals another exact project scope", async () => {
    const store = createInMemoryStore();
    const projectA = await createSemanticEngineHarness({ store, scope: SEMANTIC_SCOPE_A, label: "project-a" });
    const projectB = await createSemanticEngineHarness({ store, scope: SEMANTIC_SCOPE_B, label: "project-b" });
    const factsA = createSemanticFacts(projectA);
    const factsB = createSemanticFacts(projectB);
    await persistDetectorExecution(projectA.context, factsA.execution, [factsA.derivation]);
    await persistDetectorExecution(projectB.context, factsB.execution, [factsB.derivation]);

    const onlyA = itemsOf(
      await collectPages(projectA.learning.queryInsightDerivations({ scope: SEMANTIC_SCOPE_A, limit: 10 })),
    );
    expect(onlyA.map((view) => view.derivation.id)).toEqual([factsA.derivation.id]);
    await expect(
      projectA.learning.getInsightDerivation({ derivationId: factsB.derivation.id, scope: SEMANTIC_SCOPE_A }),
    ).resolves.toBeUndefined();
    await expect(
      projectA.learning.getDetectorExecution({ executionId: factsB.execution.id, scope: SEMANTIC_SCOPE_A }),
    ).resolves.toBeUndefined();
    await expect(
      projectA.learning.getInsightDerivation({ derivationId: factsB.derivation.id, scope: SEMANTIC_SCOPE_B }),
    ).resolves.toMatchObject({ derivation: { id: factsB.derivation.id } });

    const exactPolicy = createExactScopePolicy();
    const misleadingPrecedencePolicy: typeof exactPolicy = {
      ...exactPolicy,
      comparePrecedence: () => 0,
    };
    const misleadingReader = createLearningLoop({
      store,
      policy: conservativePolicy(),
      identity: createTestIdentityPort(),
      scopePolicy: misleadingPrecedencePolicy,
      contentPolicies: [createStructuredContentPolicy({ id: SEMANTIC_CONTENT_POLICY_ID })],
      sources: [projectA.source],
      semanticRegistry: projectA.registry,
      queryCursorScope: "misleading-semantic-precedence",
    });
    const stillOnlyA = itemsOf(
      await collectPages(misleadingReader.queryInsightDerivations({ scope: SEMANTIC_SCOPE_A, limit: 10 })),
    );
    expect(stillOnlyA.map((view) => view.derivation.id)).toEqual([factsA.derivation.id]);
  });

  it("filters not_applicable and incomplete executions without manufacturing conditionDetected", async () => {
    for (const result of [
      { status: "not_applicable" as const, reasonCodes: ["episode.class"], missingCapabilities: [] },
      { status: "incomplete" as const, reasonCodes: ["evidence.partial"], missingCapabilities: [] },
    ]) {
      const harness = await createSemanticEngineHarness({ label: `status-${result.status}` });
      const facts = createSemanticFacts(harness, { withEvidence: false, executionResult: result });
      await persistDetectorExecution(harness.context, facts.execution, []);
      const selected = itemsOf(
        await collectPages(
          harness.learning.queryDetectorExecutions({
            scope: harness.scope,
            statuses: [result.status],
            limit: 10,
          }),
        ),
      );
      expect(selected.map((view) => view.execution.id)).toEqual([facts.execution.id]);
      expect(
        itemsOf(
          await collectPages(
            harness.learning.queryDetectorExecutions({
              scope: harness.scope,
              statuses: [result.status],
              conditionDetected: false,
              limit: 10,
            }),
          ),
        ),
      ).toEqual([]);
    }
  });
});

describe("semantic cursors, lifecycle bindings, and stable composite reads", () => {
  it("uses opaque kind/filter/scope/registry-bound cursors while allowing a changed page limit", async () => {
    const harness = await createSemanticEngineHarness();
    const firstFacts = createSemanticFacts(harness, { observationLabel: "first" });
    const negative = createSemanticFacts(harness, {
      withEvidence: false,
      executionResult: {
        status: "applied",
        conditionDetected: false,
        derivationRefs: [],
        evidenceHealthFindings: [],
      },
    });
    await persistDetectorExecution(harness.context, firstFacts.execution, [firstFacts.derivation]);
    await persistDetectorExecution(harness.context, negative.execution, []);

    const first = await firstPage(
      harness.learning.queryDetectorExecutions({
        scope: harness.scope,
        detectorIds: [harness.detector.id],
        limit: 1,
      }),
    );
    expect(first.items).toHaveLength(1);
    if (first.nextCursor === undefined) throw new Error("expected semantic continuation cursor");
    expect(first.nextCursor).not.toMatch(/^\d+$/);

    const resumed = itemsOf(
      await collectPages(
        harness.learning.queryDetectorExecutions({
          scope: harness.scope,
          detectorIds: [harness.detector.id, harness.detector.id],
          cursor: first.nextCursor,
          limit: 10,
        }),
      ),
    );
    expect(resumed).toHaveLength(1);
    await expect(
      collectPages(
        harness.learning.queryInsightDerivations({
          scope: harness.scope,
          cursor: first.nextCursor,
          limit: 10,
        }),
      ),
    ).rejects.toMatchObject({ code: "query.cursor_mismatch" });
    await expect(
      collectPages(
        harness.learning.queryDetectorExecutions({
          scope: SEMANTIC_SCOPE_B,
          detectorIds: [harness.detector.id],
          cursor: first.nextCursor,
          limit: 10,
        }),
      ),
    ).rejects.toMatchObject({ code: "query.cursor_mismatch" });
    await expect(
      collectPages(
        emptyLearning(harness.store).queryDetectorExecutions({
          scope: harness.scope,
          detectorIds: [harness.detector.id],
          cursor: first.nextCursor,
          limit: 10,
        }),
      ),
    ).rejects.toMatchObject({ code: "query.cursor_mismatch" });
  });

  it("filters committed/orphaned and configured/historical views without conflating evidence health", async () => {
    const harness = await createSemanticEngineHarness();
    const committed = createSemanticFacts(harness, { observationLabel: "committed" });
    const orphaned = createSemanticFacts(harness, { observationLabel: "orphaned" });
    await persistDetectorExecution(harness.context, committed.execution, [committed.derivation]);
    await expect(
      persistDetectorExecution(harness.context, orphaned.execution, [orphaned.derivation]),
    ).rejects.toMatchObject({ code: "semantic.execution_conflict" });

    const committedOnly = itemsOf(
      await collectPages(
        harness.learning.queryInsightDerivations({
          scope: harness.scope,
          commitStatuses: ["committed"],
          registryStatuses: ["configured"],
          limit: 10,
        }),
      ),
    );
    const orphanedOnly = itemsOf(
      await collectPages(
        harness.learning.queryInsightDerivations({
          scope: harness.scope,
          commitStatuses: ["orphaned"],
          limit: 10,
        }),
      ),
    );
    expect(committedOnly.map((view) => view.derivation.id)).toEqual([committed.derivation.id]);
    expect(orphanedOnly.map((view) => view.derivation.id)).toEqual([orphaned.derivation.id]);
    expect(orphanedOnly[0]?.evidenceHealth.status).toBe("ready");

    const directHistorical = itemsOf(
      await collectPages(
        emptyLearning(harness.store).queryInsightDerivations({
          scope: harness.scope,
          derivationIds: [committed.derivation.id],
          registryStatuses: ["historical_unconfigured"],
          commitStatuses: ["committed"],
          limit: 10,
        }),
      ),
    );
    expect(directHistorical).toHaveLength(1);
    expect(directHistorical[0]).toMatchObject({
      registryBinding: { status: "historical_unconfigured" },
      commitBinding: { status: "committed" },
      evidenceHealth: { status: "ready" },
    });

    const historicalStore = createInMemoryStore();
    const historicalWriter = await createSemanticEngineHarness({
      store: historicalStore,
      label: "historical-population",
      lensEvidenceKind: "episode",
    });
    const historicalFacts = createSemanticFacts(historicalWriter, { withEvidence: false });
    await persistDetectorExecution(historicalWriter.context, historicalFacts.execution, [historicalFacts.derivation]);
    const historicalOnly = itemsOf(
      await collectPages(
        emptyLearning(historicalStore).queryInsightDerivations({
          scope: historicalWriter.scope,
          registryStatuses: ["historical_unconfigured"],
          commitStatuses: ["committed"],
          limit: 10,
        }),
      ),
    );
    expect(historicalOnly.map((view) => view.derivation.id)).toEqual([historicalFacts.derivation.id]);
    expect(historicalOnly[0]?.evidenceHealth.status).toBe("ready");
  });

  it("retries one composite graph change and fails without yielding a page after three changes", async () => {
    const once = snapshotChangingStore(createInMemoryStore(), "once");
    const stable = await createSemanticEngineHarness({ store: once.store, label: "query-stable" });
    const stableFacts = createSemanticFacts(stable);
    await persistDetectorExecution(stable.context, stableFacts.execution, [stableFacts.derivation]);
    once.enable();
    expect(
      itemsOf(await collectPages(stable.learning.queryInsightDerivations({ scope: stable.scope, limit: 10 }))),
    ).toHaveLength(1);
    expect(once.changes()).toBe(1);

    const always = snapshotChangingStore(createInMemoryStore(), "always");
    const unstable = await createSemanticEngineHarness({ store: always.store, label: "query-unstable" });
    const unstableFacts = createSemanticFacts(unstable);
    await persistDetectorExecution(unstable.context, unstableFacts.execution, [unstableFacts.derivation]);
    always.enable();
    await expect(
      collectPages(unstable.learning.queryInsightDerivations({ scope: unstable.scope, limit: 10 })),
    ).rejects.toMatchObject({ code: "query.snapshot_changed" });
    expect(always.changes()).toBeGreaterThanOrEqual(3);
  });

  it("surfaces and filters invalid reciprocal commits when the durable registry snapshot is missing", async () => {
    const hidden = snapshotHidingStore(createInMemoryStore());
    const harness = await createSemanticEngineHarness({ store: hidden.store, label: "invalid-commit" });
    const facts = createSemanticFacts(harness);
    await persistDetectorExecution(harness.context, facts.execution, [facts.derivation]);
    hidden.enable();

    const derivations = itemsOf(
      await collectPages(
        harness.learning.queryInsightDerivations({
          scope: harness.scope,
          commitStatuses: ["invalid"],
          limit: 10,
        }),
      ),
    );
    const executions = itemsOf(
      await collectPages(
        harness.learning.queryDetectorExecutions({
          scope: harness.scope,
          commitStatuses: ["invalid"],
          limit: 10,
        }),
      ),
    );
    expect(derivations.map((view) => view.derivation.id)).toEqual([facts.derivation.id]);
    expect(executions.map((view) => view.execution.id)).toEqual([facts.execution.id]);
    expect(derivations[0]?.registryBinding.status).toBe("historical_unconfigured");
    expect(executions[0]?.registryBinding.status).toBe("historical_unconfigured");
  });

  it("rejects self-consistent derivation/execution bytes returned behind another list or get key", async () => {
    const base = createInMemoryStore();
    const writer = await createSemanticEngineHarness({ store: base, label: "key-writer" });
    const committed = createSemanticFacts(writer, { observationLabel: "key-committed" });
    const competitor = createSemanticFacts(writer, { observationLabel: "key-competitor" });
    const negative = createSemanticFacts(writer, {
      withEvidence: false,
      executionResult: {
        status: "applied",
        conditionDetected: false,
        derivationRefs: [],
        evidenceHealthFindings: [],
      },
    });
    await persistDetectorExecution(writer.context, committed.execution, [committed.derivation]);
    await expect(
      persistDetectorExecution(writer.context, competitor.execution, [competitor.derivation]),
    ).rejects.toMatchObject({ code: "semantic.execution_conflict" });
    await persistDetectorExecution(writer.context, negative.execution, []);

    const boundary = keyBoundaryStore(base);
    const reader = await createSemanticEngineHarness({ store: boundary.store, label: "key-reader" });
    const derivations = await base.list({ namespace: "learning", kind: "insight-derivation", limit: 10 });
    const derivationTarget = derivations.records[0];
    const derivationOther = derivations.records.find((record) => record.key.id !== derivationTarget?.key.id);
    if (derivationTarget === undefined || derivationOther === undefined) {
      throw new Error("missing derivation key-boundary fixtures");
    }
    boundary.replace({
      kind: "insight-derivation",
      targetId: derivationTarget.key.id,
      value: derivationOther.value,
      digest: derivationOther.digest,
    });
    await expect(
      reader.learning.getInsightDerivation({ derivationId: derivationTarget.key.id, scope: writer.scope }),
    ).rejects.toMatchObject({ code: "store.corrupt" });
    await expect(
      collectPages(reader.learning.queryInsightDerivations({ scope: writer.scope, limit: 10 })),
    ).rejects.toMatchObject({ code: "store.corrupt" });

    const executions = await base.list({ namespace: "learning", kind: "detector-execution", limit: 10 });
    const executionTarget = executions.records[0];
    const executionOther = executions.records.find((record) => record.key.id !== executionTarget?.key.id);
    if (executionTarget === undefined || executionOther === undefined) {
      throw new Error("missing execution key-boundary fixtures");
    }
    boundary.replace({
      kind: "detector-execution",
      targetId: executionTarget.key.id,
      value: executionOther.value,
      digest: executionOther.digest,
    });
    await expect(
      reader.learning.getDetectorExecution({ executionId: executionTarget.key.id, scope: writer.scope }),
    ).rejects.toMatchObject({ code: "store.corrupt" });
    await expect(
      collectPages(reader.learning.queryDetectorExecutions({ scope: writer.scope, limit: 10 })),
    ).rejects.toMatchObject({ code: "store.corrupt" });
  });
});

describe("scope-partitioned semantic indexes", () => {
  it("foreign-only records do not create extra pages or cursors for an exact scope", async () => {
    const base = createInMemoryStore();
    const observed = observingStore(base);
    const projectA = await createSemanticEngineHarness({
      store: observed.store,
      scope: SEMANTIC_SCOPE_A,
      label: "scope-index-a",
    });
    const factsA = createSemanticFacts(projectA);
    await persistDetectorExecution(projectA.context, factsA.execution, [factsA.derivation]);
    const emptyScope = [{ type: "project", id: "semantic-project-empty" }] as const;
    const beforeForeignWrites = await collectPages(
      projectA.learning.queryInsightDerivations({ scope: SEMANTIC_SCOPE_A, limit: 1 }),
    );
    const emptyBeforeForeignWrites = await collectPages(
      projectA.learning.queryInsightDerivations({ scope: emptyScope, limit: 1 }),
    );
    for (let index = 0; index < 3; index += 1) {
      const projectB = await createSemanticEngineHarness({
        store: observed.store,
        scope: SEMANTIC_SCOPE_B,
        label: `scope-index-b-${index}`,
      });
      const factsB = createSemanticFacts(projectB);
      await persistDetectorExecution(projectB.context, factsB.execution, [factsB.derivation]);
    }
    observed.enable();
    observed.clear();

    const pages = await collectPages(projectA.learning.queryInsightDerivations({ scope: SEMANTIC_SCOPE_A, limit: 1 }));
    expect(pages).toEqual(beforeForeignWrites);
    expect(await collectPages(projectA.learning.queryInsightDerivations({ scope: emptyScope, limit: 1 }))).toEqual(
      emptyBeforeForeignWrites,
    );
    expect(pages).toHaveLength(1);
    expect(pages[0]?.items.map((view) => view.derivation.id)).toEqual([factsA.derivation.id]);
    expect(pages[0]?.nextCursor).toBeUndefined();

    const scopeANamespace = `learning-semantic-scope-${scopeDigest(SEMANTIC_SCOPE_A)}`;
    const scopeBNamespace = `learning-semantic-scope-${scopeDigest(SEMANTIC_SCOPE_B)}`;
    const rawA = await base.list({
      namespace: scopeANamespace,
      kind: "insight-derivation-index",
      limit: 1,
    });
    const rawB = await base.list({
      namespace: scopeBNamespace,
      kind: "insight-derivation-index",
      limit: 1,
    });
    expect(rawA.records).toHaveLength(1);
    expect(rawA.nextCursor).toBeUndefined();
    expect(rawB.records).toHaveLength(1);
    expect(rawB.nextCursor).toBeDefined();
    expect(observed.lists.some((query) => query.namespace === scopeBNamespace)).toBe(false);
  });

  it("wrong-scope exact gets never touch the global derivation or execution target key", async () => {
    const base = createInMemoryStore();
    const observed = observingStore(base);
    const projectA = await createSemanticEngineHarness({
      store: observed.store,
      scope: SEMANTIC_SCOPE_A,
      label: "get-index-a",
    });
    const projectB = await createSemanticEngineHarness({
      store: observed.store,
      scope: SEMANTIC_SCOPE_B,
      label: "get-index-b",
    });
    const factsB = createSemanticFacts(projectB);
    await persistDetectorExecution(projectB.context, factsB.execution, [factsB.derivation]);
    observed.enable();
    observed.clear();

    await expect(
      projectA.learning.getInsightDerivation({ derivationId: factsB.derivation.id, scope: SEMANTIC_SCOPE_A }),
    ).resolves.toBeUndefined();
    await expect(
      projectA.learning.getDetectorExecution({ executionId: factsB.execution.id, scope: SEMANTIC_SCOPE_A }),
    ).resolves.toBeUndefined();
    expect(observed.gets).not.toContainEqual({
      namespace: "learning",
      kind: "insight-derivation",
      id: factsB.derivation.id,
    });
    expect(observed.gets).not.toContainEqual({
      namespace: "learning",
      kind: "detector-execution",
      id: factsB.execution.id,
    });
  });

  it("rejects foreign-scope, target-key, and stored-digest corruption at the index boundary", async () => {
    const base = createInMemoryStore();
    const boundary = keyBoundaryStore(base);
    const projectA1 = await createSemanticEngineHarness({
      store: boundary.store,
      scope: SEMANTIC_SCOPE_A,
      label: "index-corrupt-a1",
    });
    const projectA2 = await createSemanticEngineHarness({
      store: boundary.store,
      scope: SEMANTIC_SCOPE_A,
      label: "index-corrupt-a2",
    });
    const projectB = await createSemanticEngineHarness({
      store: boundary.store,
      scope: SEMANTIC_SCOPE_B,
      label: "index-corrupt-b",
    });
    const factsA1 = createSemanticFacts(projectA1);
    const factsA2 = createSemanticFacts(projectA2);
    const factsB = createSemanticFacts(projectB);
    await persistDetectorExecution(projectA1.context, factsA1.execution, [factsA1.derivation]);
    await persistDetectorExecution(projectA2.context, factsA2.execution, [factsA2.derivation]);
    await persistDetectorExecution(projectB.context, factsB.execution, [factsB.derivation]);

    const namespaceA = `learning-semantic-scope-${scopeDigest(SEMANTIC_SCOPE_A)}`;
    const namespaceB = `learning-semantic-scope-${scopeDigest(SEMANTIC_SCOPE_B)}`;
    const derivationA = await base.get({
      namespace: namespaceA,
      kind: "insight-derivation-index",
      id: factsA1.derivation.id,
    });
    const derivationB = await base.get({
      namespace: namespaceB,
      kind: "insight-derivation-index",
      id: factsB.derivation.id,
    });
    if (derivationA === undefined || derivationB === undefined) throw new Error("missing derivation index fixtures");
    boundary.replace({
      kind: "insight-derivation-index",
      targetId: factsA1.derivation.id,
      value: derivationB.value,
      digest: derivationB.digest,
    });
    await expect(
      collectPages(projectA1.learning.queryInsightDerivations({ scope: SEMANTIC_SCOPE_A, limit: 10 })),
    ).rejects.toMatchObject({ code: "store.corrupt" });

    const executionA2 = await base.get({
      namespace: namespaceA,
      kind: "detector-execution-index",
      id: factsA2.execution.id,
    });
    if (executionA2 === undefined) throw new Error("missing execution index fixture");
    boundary.replace({
      kind: "detector-execution-index",
      targetId: factsA1.execution.id,
      value: executionA2.value,
      digest: executionA2.digest,
    });
    await expect(
      projectA1.learning.getDetectorExecution({ executionId: factsA1.execution.id, scope: SEMANTIC_SCOPE_A }),
    ).rejects.toMatchObject({ code: "store.corrupt" });

    boundary.replace({
      kind: "insight-derivation-index",
      targetId: factsA1.derivation.id,
      value: derivationA.value,
      digest: "0".repeat(64),
    });
    await expect(
      projectA1.learning.getInsightDerivation({ derivationId: factsA1.derivation.id, scope: SEMANTIC_SCOPE_A }),
    ).rejects.toMatchObject({ code: "store.corrupt" });
  });

  it("rejects a self-consistent scope-A index that targets an existing scope-B execution", async () => {
    const store = createInMemoryStore();
    const projectA = await createSemanticEngineHarness({
      store,
      scope: SEMANTIC_SCOPE_A,
      label: "foreign-target-a",
    });
    const projectB = await createSemanticEngineHarness({
      store,
      scope: SEMANTIC_SCOPE_B,
      label: "foreign-target-b",
    });
    const factsB = createSemanticFacts(projectB);
    await persistDetectorExecution(projectB.context, factsB.execution, [factsB.derivation]);
    const exactScopeDigest = scopeDigest(SEMANTIC_SCOPE_A);
    const indexBase = {
      targetId: factsB.execution.id,
      targetDigest: factsB.execution.executionDigest,
      scopeDigest: exactScopeDigest,
    };
    const index = {
      schemaVersion: 1,
      ...indexBase,
      indexDigest: sha256HexOfCanonicalJson(toJsonValue({ kind: "detector-execution-index", ...indexBase })),
    };
    const value = toJsonValue(index);
    await store.create(
      {
        namespace: `learning-semantic-scope-${exactScopeDigest}`,
        kind: "detector-execution-index",
        id: factsB.execution.id,
      },
      value,
      sha256HexOfCanonicalJson(value),
      "forge-cross-scope-execution-index",
    );
    await expect(
      projectA.learning.getDetectorExecution({ executionId: factsB.execution.id, scope: SEMANTIC_SCOPE_A }),
    ).rejects.toMatchObject({ code: "store.corrupt" });
  });

  it("includes exact-scope index revisions in composite retry and fail-closed reads", async () => {
    const once = indexSnapshotChangingStore(createInMemoryStore(), "once");
    const stable = await createSemanticEngineHarness({ store: once.store, label: "index-snapshot-once" });
    const stableFacts = createSemanticFacts(stable);
    await persistDetectorExecution(stable.context, stableFacts.execution, [stableFacts.derivation]);
    once.configure({
      namespace: `learning-semantic-scope-${stableFacts.derivation.scopeDigest}`,
      kind: "insight-derivation-index",
      id: stableFacts.derivation.id,
    });
    expect(
      itemsOf(await collectPages(stable.learning.queryInsightDerivations({ scope: stable.scope, limit: 10 }))),
    ).toHaveLength(1);
    expect(once.changes()).toBe(1);

    const always = indexSnapshotChangingStore(createInMemoryStore(), "always");
    const unstable = await createSemanticEngineHarness({ store: always.store, label: "index-snapshot-always" });
    const unstableFacts = createSemanticFacts(unstable);
    await persistDetectorExecution(unstable.context, unstableFacts.execution, [unstableFacts.derivation]);
    always.configure({
      namespace: `learning-semantic-scope-${unstableFacts.derivation.scopeDigest}`,
      kind: "insight-derivation-index",
      id: unstableFacts.derivation.id,
    });
    await expect(
      collectPages(unstable.learning.queryInsightDerivations({ scope: unstable.scope, limit: 10 })),
    ).rejects.toMatchObject({ code: "query.snapshot_changed" });
    expect(always.changes()).toBeGreaterThanOrEqual(3);
  });
});
