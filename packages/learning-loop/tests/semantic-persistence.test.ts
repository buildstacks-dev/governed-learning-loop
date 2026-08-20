// #30b2a engine-private semantic persistence: current-registry validation,
// receipt-last provenance, crash/concurrency convergence, and fail-closed
// reciprocal graph reads. None of these helpers is a public minting API.
import { describe, expect, it } from "vitest";
import type {
  DetectorExecutionRecord,
  EvidenceHealthFinding,
  InsightDerivation,
  LearningStore,
  QueryPage,
  StoredRecord,
} from "../src/index.js";
import {
  detectorExecutionDigest,
  detectorExecutionKeyDigest,
  evidenceRefDigest,
  insightDerivationDigest,
  parseDetectorExecutionRecord,
  parseInsightDerivation,
  parseMeasurementRecord,
  parseObservation,
  sha256HexOfCanonicalJson,
  toJsonValue,
} from "../src/index.js";
import type { EngineContext } from "../src/engine/context.js";
import { buildDerivationLink } from "../src/engine/semantic-graph.js";
import {
  loadDetectorExecutionView,
  loadInsightDerivationView,
  persistDetectorExecution,
} from "../src/engine/semantic-persistence.js";
import { evidenceHealthFindingDigest } from "../src/records/source-health.js";
import { createInMemoryStore } from "../src/testing/index.js";
import { SEMANTIC_SCOPE_B, createSemanticEngineHarness, createSemanticFacts } from "./semantic-engine-harness.js";

const SEMANTIC_KINDS = [
  "semantic-registry-snapshot",
  "derivation-execution",
  "insight-derivation",
  "detector-execution",
] as const;
const SEMANTIC_WRITE_KINDS = [
  "semantic-registry-snapshot",
  "derivation-execution",
  "insight-derivation",
  "insight-derivation-index",
  "detector-execution-index",
  "detector-execution",
] as const;

async function recordsOf(store: LearningStore, kind: string): Promise<readonly StoredRecord[]> {
  return (await store.list({ namespace: "learning", kind, limit: 1_000 })).records;
}

async function queryItems<T>(iterable: AsyncIterable<QueryPage<T>>): Promise<readonly T[]> {
  const items: T[] = [];
  for await (const page of iterable) items.push(...page.items);
  return items;
}

async function semanticCounts(store: LearningStore): Promise<Readonly<Record<string, number>>> {
  const entries: Array<readonly [string, number]> = [];
  for (const kind of SEMANTIC_KINDS) entries.push([kind, (await recordsOf(store, kind)).length]);
  return Object.fromEntries(entries);
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

function loseFirstAcknowledgement(base: LearningStore, targetKind: string): LearningStore {
  let failed = false;
  return {
    get: (key) => base.get(key),
    create: async (key, value, digest, operationId) => {
      const result = await base.create(key, value, digest, operationId);
      if (!failed && key.kind === targetKind) {
        failed = true;
        throw new Error(`lost ${targetKind} acknowledgement`);
      }
      return result;
    },
    compareAndSet: (key, expectedRevision, value, digest, operationId) =>
      base.compareAndSet(key, expectedRevision, value, digest, operationId),
    append: async (stream, expectedRevision, entries, operationId) => {
      const result = await base.append(stream, expectedRevision, entries, operationId);
      if (!failed && stream.kind === targetKind) {
        failed = true;
        throw new Error(`lost ${targetKind} acknowledgement`);
      }
      return result;
    },
    tombstone: (input) => base.tombstone(input),
    list: (query) => base.list(query),
  };
}

function failBeforeFirstCreate(base: LearningStore, targetKind: string): LearningStore {
  let failed = false;
  return {
    get: (key) => base.get(key),
    create: (key, value, digest, operationId) => {
      if (!failed && key.kind === targetKind) {
        failed = true;
        throw new Error(`failed before ${targetKind} create`);
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

function replaceContextStore(context: EngineContext, store: LearningStore): EngineContext {
  return { ...context, store };
}

function redigestExecution(input: DetectorExecutionRecord): DetectorExecutionRecord {
  const executionKeyDigest = detectorExecutionKeyDigest(input);
  const executionDigest = detectorExecutionDigest({ ...input, executionKeyDigest });
  return parseDetectorExecutionRecord({
    ...input,
    id: `detector-execution-${executionKeyDigest}`,
    executionKeyDigest,
    executionDigest,
  });
}

function redigestDerivation(input: InsightDerivation): InsightDerivation {
  const { schemaVersion: _schemaVersion, id: _id, derivationDigest: _derivationDigest, ...base } = input;
  const derivationDigest = insightDerivationDigest(base);
  return parseInsightDerivation({
    schemaVersion: 1,
    id: `insight-${derivationDigest}`,
    ...base,
    derivationDigest,
  });
}

function bindExecutionDerivation(
  execution: DetectorExecutionRecord,
  derivation: InsightDerivation,
): DetectorExecutionRecord {
  return redigestExecution({
    ...execution,
    result: {
      status: "applied",
      conditionDetected: true,
      derivationRefs: [
        { id: derivation.id, derivationDigest: derivation.derivationDigest, scopeDigest: derivation.scopeDigest },
      ],
      evidenceHealthFindings: [],
    },
  });
}

function healthFinding(input: {
  readonly sourceId: string;
  readonly sourceRegistrationRevision: string;
  readonly sourceRef: string;
  readonly pageRef: string;
  readonly effect?: EvidenceHealthFinding["effect"];
}): EvidenceHealthFinding {
  const base = {
    code: "source.partial" as const,
    effect: input.effect ?? "limits_claims",
    sourceId: input.sourceId,
    sourceRegistrationRevision: input.sourceRegistrationRevision,
    sourceRef: input.sourceRef,
    pageRef: input.pageRef,
    completeness: "partial" as const,
    affectedRecords: 1,
  };
  const findingDigest = evidenceHealthFindingDigest(base);
  return {
    schemaVersion: 1,
    id: `evidence-health-${findingDigest}`,
    ...base,
    findingDigest,
  };
}

async function seedHealth(store: LearningStore, finding: EvidenceHealthFinding): Promise<void> {
  const value = toJsonValue(finding);
  await store.create(
    { namespace: "learning", kind: "evidence-health", id: finding.id },
    value,
    sha256HexOfCanonicalJson(value),
    `seed-${finding.id}`,
  );
}

function bindInputHealth(
  facts: { readonly execution: DetectorExecutionRecord; readonly derivation: InsightDerivation },
  finding: EvidenceHealthFinding,
): { readonly execution: DetectorExecutionRecord; readonly derivation: InsightDerivation } {
  const windowBase = { ...facts.execution.window, evidenceHealthFindings: [finding] };
  const window = {
    ...windowBase,
    windowDigest: sha256HexOfCanonicalJson(
      toJsonValue({
        sourceProfiles: windowBase.sourceProfiles,
        population: windowBase.population,
        evidenceRefs: windowBase.evidenceRefs,
        evidenceHealthFindings: windowBase.evidenceHealthFindings,
        availableCapabilities: windowBase.availableCapabilities,
      }),
    ),
  };
  const derivation = redigestDerivation({ ...facts.derivation, evidenceHealthFindings: [finding] });
  return {
    derivation,
    execution: bindExecutionDerivation(redigestExecution({ ...facts.execution, window }), derivation),
  };
}

function snapshotChangingStore(base: LearningStore, mode: "once" | "always") {
  let enabled = false;
  let changes = 0;
  const store: LearningStore = {
    get: async (key) => {
      const stored = await base.get(key);
      if (enabled && key.kind === "observation" && (mode === "always" || changes === 0)) {
        changes += 1;
        if (stored === undefined) throw new Error("snapshot mutation fixture requires a stored observation");
        const value = toJsonValue(stored.value);
        await base.create(
          { namespace: "learning", kind: "observation", id: `semantic-snapshot-${changes}` },
          value,
          sha256HexOfCanonicalJson(value),
          `semantic-snapshot-${changes}`,
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

function replacingGetStore(
  base: LearningStore,
  input: { readonly kind: string; readonly id: string; readonly value: unknown; readonly digest: string },
): LearningStore {
  return {
    get: async (key) => {
      const stored = await base.get(key);
      return stored !== undefined && key.kind === input.kind && key.id === input.id
        ? { ...stored, value: input.value, digest: input.digest }
        : stored;
    },
    create: (key, value, digest, operationId) => base.create(key, value, digest, operationId),
    compareAndSet: (key, expectedRevision, value, digest, operationId) =>
      base.compareAndSet(key, expectedRevision, value, digest, operationId),
    append: (stream, expectedRevision, entries, operationId) =>
      base.append(stream, expectedRevision, entries, operationId),
    tombstone: (value) => base.tombstone(value),
    list: (query) => base.list(query),
  };
}

function hidingGetStore(base: LearningStore, kind: string, id: string): LearningStore {
  return {
    get: (key) => (key.kind === kind && key.id === id ? Promise.resolve(undefined) : base.get(key)),
    create: (key, value, digest, operationId) => base.create(key, value, digest, operationId),
    compareAndSet: (key, expectedRevision, value, digest, operationId) =>
      base.compareAndSet(key, expectedRevision, value, digest, operationId),
    append: (stream, expectedRevision, entries, operationId) =>
      base.append(stream, expectedRevision, entries, operationId),
    tombstone: (input) => base.tombstone(input),
    list: (query) => base.list(query),
  };
}

describe("private semantic persistence ordering and recovery", () => {
  it("parses execution and derivation inputs before any semantic write", async () => {
    const harness = await createSemanticEngineHarness();
    const facts = createSemanticFacts(harness);
    await expect(
      persistDetectorExecution(harness.context, { malformed: true }, [facts.derivation]),
    ).rejects.toMatchObject({ code: expect.stringMatching(/^schema\./) });
    await expect(persistDetectorExecution(harness.context, facts.execution, { malformed: true })).rejects.toMatchObject(
      { code: "schema.invalid" },
    );
    expect(await semanticCounts(harness.store)).toEqual({
      "semantic-registry-snapshot": 0,
      "derivation-execution": 0,
      "insight-derivation": 0,
      "detector-execution": 0,
    });
  });

  it("writes snapshot, provenance link, derivation, and execution receipt in exact order and remains inert", async () => {
    const writes: string[] = [];
    const base = createInMemoryStore();
    const harness = await createSemanticEngineHarness({ store: recordingStore(base, writes) });
    const facts = createSemanticFacts(harness);
    writes.length = 0;

    await persistDetectorExecution(harness.context, facts.execution, [facts.derivation]);

    expect(writes.filter((kind) => SEMANTIC_WRITE_KINDS.some((semanticKind) => semanticKind === kind))).toEqual([
      "semantic-registry-snapshot",
      "derivation-execution",
      "insight-derivation",
      "insight-derivation-index",
      "detector-execution-index",
      "detector-execution",
    ]);
    expect(await semanticCounts(base)).toEqual({
      "semantic-registry-snapshot": 1,
      "derivation-execution": 1,
      "insight-derivation": 1,
      "detector-execution": 1,
    });
    expect(await recordsOf(base, "candidate")).toEqual([]);
    expect(await recordsOf(base, "review")).toEqual([]);

    const derivationView = await loadInsightDerivationView(harness.context, facts.derivation.id, harness.scope);
    const executionView = await loadDetectorExecutionView(harness.context, facts.execution.id, harness.scope);
    expect(derivationView).toMatchObject({
      registryBinding: { status: "configured" },
      commitBinding: { status: "committed", executionRefs: [{ id: facts.execution.id }] },
      evidenceHealth: { status: "ready" },
    });
    expect(executionView).toMatchObject({
      registryBinding: { status: "configured" },
      commitBinding: { status: "committed" },
      evidenceHealth: { status: "ready" },
    });
  });

  it("retries identical bytes without duplicating snapshots, links, derivations, or receipts", async () => {
    const harness = await createSemanticEngineHarness();
    const facts = createSemanticFacts(harness);
    await persistDetectorExecution(harness.context, facts.execution, [facts.derivation]);
    await persistDetectorExecution(harness.context, structuredClone(facts.execution), [
      structuredClone(facts.derivation),
    ]);
    expect(await semanticCounts(harness.store)).toEqual({
      "semantic-registry-snapshot": 1,
      "derivation-execution": 1,
      "insight-derivation": 1,
      "detector-execution": 1,
    });
    const links = await recordsOf(harness.store, "derivation-execution");
    expect(Array.isArray(links[0]?.value) ? links[0]?.value : []).toHaveLength(1);
  });

  it("leaves no derivation view after a committed link acknowledgement is lost, then repairs on retry", async () => {
    const base = createInMemoryStore();
    const store = loseFirstAcknowledgement(base, "derivation-execution");
    const harness = await createSemanticEngineHarness({ store });
    const facts = createSemanticFacts(harness);
    await expect(persistDetectorExecution(harness.context, facts.execution, [facts.derivation])).rejects.toThrow(
      "lost derivation-execution acknowledgement",
    );
    expect(await recordsOf(base, "derivation-execution")).toHaveLength(1);
    expect(await recordsOf(base, "insight-derivation")).toEqual([]);
    await expect(
      loadInsightDerivationView(harness.context, facts.derivation.id, harness.scope),
    ).resolves.toBeUndefined();

    await persistDetectorExecution(harness.context, facts.execution, [facts.derivation]);
    await expect(loadInsightDerivationView(harness.context, facts.derivation.id, harness.scope)).resolves.toMatchObject(
      {
        commitBinding: { status: "committed" },
      },
    );
  });

  it("classifies a durable derivation without its receipt as orphaned and retry commits it", async () => {
    const base = createInMemoryStore();
    const store = failBeforeFirstCreate(base, "detector-execution");
    const harness = await createSemanticEngineHarness({ store });
    const facts = createSemanticFacts(harness);
    await expect(persistDetectorExecution(harness.context, facts.execution, [facts.derivation])).rejects.toThrow(
      "failed before detector-execution create",
    );
    const orphan = await loadInsightDerivationView(harness.context, facts.derivation.id, harness.scope);
    expect(orphan).toMatchObject({ commitBinding: { status: "orphaned" } });
    expect(await recordsOf(base, "detector-execution")).toEqual([]);
    await expect(
      queryItems(
        harness.learning.queryInsightDerivations({
          scope: harness.scope,
          commitStatuses: ["orphaned"],
          limit: 10,
        }),
      ),
    ).resolves.toEqual([expect.objectContaining({ derivation: expect.objectContaining({ id: facts.derivation.id }) })]);
    await expect(
      queryItems(harness.learning.queryDetectorExecutions({ scope: harness.scope, limit: 10 })),
    ).resolves.toEqual([]);
    await expect(
      harness.learning.getDetectorExecution({ executionId: facts.execution.id, scope: harness.scope }),
    ).resolves.toBeUndefined();
    await expect(
      queryItems(harness.learning.queryDetectorExecutions({ scope: SEMANTIC_SCOPE_B, limit: 10 })),
    ).resolves.toEqual([]);

    await persistDetectorExecution(harness.context, facts.execution, [facts.derivation]);
    await expect(loadInsightDerivationView(harness.context, facts.derivation.id, harness.scope)).resolves.toMatchObject(
      {
        commitBinding: { status: "committed" },
      },
    );
  });

  for (const kind of ["semantic-registry-snapshot", "insight-derivation", "detector-execution"] as const) {
    it(`recovers deterministically when the ${kind} create acknowledgement is lost`, async () => {
      const base = createInMemoryStore();
      const harness = await createSemanticEngineHarness({ store: loseFirstAcknowledgement(base, kind) });
      const facts = createSemanticFacts(harness);
      await expect(persistDetectorExecution(harness.context, facts.execution, [facts.derivation])).rejects.toThrow(
        `lost ${kind} acknowledgement`,
      );
      await persistDetectorExecution(harness.context, facts.execution, [facts.derivation]);
      expect(await semanticCounts(base)).toEqual({
        "semantic-registry-snapshot": 1,
        "derivation-execution": 1,
        "insight-derivation": 1,
        "detector-execution": 1,
      });
    });
  }

  it("converges two identical concurrent commits to one exact graph", async () => {
    const harness = await createSemanticEngineHarness();
    const facts = createSemanticFacts(harness);
    await Promise.all([
      persistDetectorExecution(harness.context, facts.execution, [facts.derivation]),
      persistDetectorExecution(harness.context, structuredClone(facts.execution), [structuredClone(facts.derivation)]),
    ]);
    expect(await semanticCounts(harness.store)).toEqual({
      "semantic-registry-snapshot": 1,
      "derivation-execution": 1,
      "insight-derivation": 1,
      "detector-execution": 1,
    });
    const links = await recordsOf(harness.store, "derivation-execution");
    expect(Array.isArray(links[0]?.value) ? links[0]?.value : []).toHaveLength(1);
  });

  it("atomically chooses one same-key result under concurrency and leaves the losing result orphaned", async () => {
    const harness = await createSemanticEngineHarness();
    const left = createSemanticFacts(harness, { observationLabel: "concurrent-left" });
    const right = createSemanticFacts(harness, { observationLabel: "concurrent-right" });
    expect(left.execution.executionKeyDigest).toBe(right.execution.executionKeyDigest);
    const results = await Promise.allSettled([
      persistDetectorExecution(harness.context, left.execution, [left.derivation]),
      persistDetectorExecution(harness.context, right.execution, [right.derivation]),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const storedExecution = (await recordsOf(harness.store, "detector-execution"))[0];
    if (storedExecution === undefined) throw new Error("missing concurrent execution winner");
    const winner =
      storedExecution.key.id === left.execution.id &&
      storedExecution.digest === sha256HexOfCanonicalJson(toJsonValue(left.execution))
        ? left
        : right;
    const loser = winner.derivation.id === left.derivation.id ? right : left;
    await expect(
      loadInsightDerivationView(harness.context, winner.derivation.id, harness.scope),
    ).resolves.toMatchObject({
      commitBinding: { status: "committed" },
    });
    await expect(loadInsightDerivationView(harness.context, loser.derivation.id, harness.scope)).resolves.toMatchObject(
      {
        commitBinding: { status: "orphaned" },
      },
    );
    expect(await recordsOf(harness.store, "derivation-execution")).toHaveLength(2);
  });

  it("retries one composite evidence change and fails closed after three unstable snapshots", async () => {
    const once = snapshotChangingStore(createInMemoryStore(), "once");
    const stableHarness = await createSemanticEngineHarness({ store: once.store, label: "stable-snapshot" });
    const stableFacts = createSemanticFacts(stableHarness);
    once.enable();
    await persistDetectorExecution(stableHarness.context, stableFacts.execution, [stableFacts.derivation]);
    expect(once.changes()).toBe(1);
    expect(await recordsOf(stableHarness.store, "detector-execution")).toHaveLength(1);

    const always = snapshotChangingStore(createInMemoryStore(), "always");
    const unstableHarness = await createSemanticEngineHarness({ store: always.store, label: "unstable-snapshot" });
    const unstableFacts = createSemanticFacts(unstableHarness);
    always.enable();
    await expect(
      persistDetectorExecution(unstableHarness.context, unstableFacts.execution, [unstableFacts.derivation]),
    ).rejects.toMatchObject({ code: "semantic.snapshot_changed" });
    expect(always.changes()).toBeGreaterThanOrEqual(3);
    expect(await semanticCounts(unstableHarness.store)).toEqual({
      "semantic-registry-snapshot": 0,
      "derivation-execution": 0,
      "insight-derivation": 0,
      "detector-execution": 0,
    });
  });

  it("keeps a competing same-key result as an append-only orphan without contaminating the winner", async () => {
    const harness = await createSemanticEngineHarness();
    const winner = createSemanticFacts(harness, { observationLabel: "winner" });
    const competitor = createSemanticFacts(harness, { observationLabel: "competitor" });
    expect(competitor.execution.executionKeyDigest).toBe(winner.execution.executionKeyDigest);
    expect(competitor.execution.executionDigest).not.toBe(winner.execution.executionDigest);

    await persistDetectorExecution(harness.context, winner.execution, [winner.derivation]);
    await expect(
      persistDetectorExecution(harness.context, competitor.execution, [competitor.derivation]),
    ).rejects.toMatchObject({ code: "semantic.execution_conflict" });

    await expect(
      loadInsightDerivationView(harness.context, winner.derivation.id, harness.scope),
    ).resolves.toMatchObject({ commitBinding: { status: "committed" } });
    await expect(
      loadInsightDerivationView(harness.context, competitor.derivation.id, harness.scope),
    ).resolves.toMatchObject({ commitBinding: { status: "orphaned" } });
    expect(await recordsOf(harness.store, "insight-derivation")).toHaveLength(2);
    expect(await recordsOf(harness.store, "derivation-execution")).toHaveLength(2);
    expect(await recordsOf(harness.store, "detector-execution")).toHaveLength(1);
  });

  it("refuses a same-entry-id link with different self-valid content before derivation indexes or receipt", async () => {
    const harness = await createSemanticEngineHarness();
    const facts = createSemanticFacts(harness);
    const reference =
      facts.execution.result.status === "applied" ? facts.execution.result.derivationRefs[0] : undefined;
    if (reference === undefined) throw new Error("missing link-conflict derivation reference");
    const expected = buildDerivationLink(facts.execution, harness.registry.registryDigest, reference);
    const { schemaVersion: _schemaVersion, linkDigest: _linkDigest, ...expectedBase } = expected;
    const conflictingBase = { ...expectedBase, semanticRegistryDigest: "0".repeat(64) };
    const conflicting = {
      schemaVersion: 1,
      ...conflictingBase,
      linkDigest: sha256HexOfCanonicalJson(toJsonValue(conflictingBase)),
    };
    const value = toJsonValue(conflicting);
    await harness.store.append(
      { namespace: "learning", kind: "derivation-execution", id: facts.derivation.id },
      undefined,
      [
        {
          id: `execution:${facts.execution.id}:${facts.execution.executionDigest}`,
          digest: sha256HexOfCanonicalJson(value),
          value,
        },
      ],
      "seed-conflicting-link-entry",
    );

    await expect(persistDetectorExecution(harness.context, facts.execution, [facts.derivation])).rejects.toMatchObject({
      code: "store.corrupt",
    });
    expect(await recordsOf(harness.store, "insight-derivation")).toEqual([]);
    expect(await recordsOf(harness.store, "detector-execution")).toEqual([]);
    const namespace = `learning-semantic-scope-${facts.derivation.scopeDigest}`;
    expect(await harness.store.list({ namespace, kind: "insight-derivation-index", limit: 10 })).toMatchObject({
      records: [],
    });
    expect(await harness.store.list({ namespace, kind: "detector-execution-index", limit: 10 })).toMatchObject({
      records: [],
    });
  });
});

describe("semantic cross-record validation and evidence health", () => {
  it("rejects current registry, population, producer, and destination mismatches before provenance writes", async () => {
    const cases: Array<{
      readonly name: string;
      readonly build: (facts: ReturnType<typeof createSemanticFacts>) => {
        readonly execution: DetectorExecutionRecord;
        readonly derivation: InsightDerivation;
      };
      readonly code: string;
    }> = [
      {
        name: "loop registry",
        build: (facts) => ({
          derivation: facts.derivation,
          execution: redigestExecution({ ...facts.execution, loopRegistryRevision: "0".repeat(64) }),
        }),
        code: "semantic.registry_mismatch",
      },
      {
        name: "population episode",
        build: (facts) => {
          const episode = facts.execution.window.population.episodes[0];
          if (episode === undefined) throw new Error("missing population fixture");
          const episodeBase = {
            episodeRecordId: episode.episodeRecordId,
            episodeRecordDigest: "0".repeat(64),
            episodeIdentityDigest: episode.episodeIdentityDigest,
            outcomeClaimDigest: episode.outcomeClaimDigest,
            scopeDigest: episode.scopeDigest,
          };
          const episodes = [
            {
              ...episodeBase,
              episodeViewDigest: sha256HexOfCanonicalJson(toJsonValue(episodeBase)),
            },
          ];
          const population = {
            ...facts.execution.window.population,
            episodes,
            populationDigest: sha256HexOfCanonicalJson(
              toJsonValue({
                episodes,
                normalizationPolicyDigest: facts.execution.window.population.normalizationPolicyDigest,
                comparabilityPolicyDigest: facts.execution.window.population.comparabilityPolicyDigest,
              }),
            ),
          };
          const windowBase = { ...facts.execution.window, population };
          const window = {
            ...windowBase,
            windowDigest: sha256HexOfCanonicalJson(
              toJsonValue({
                sourceProfiles: windowBase.sourceProfiles,
                population: windowBase.population,
                evidenceRefs: windowBase.evidenceRefs,
                evidenceHealthFindings: windowBase.evidenceHealthFindings,
                availableCapabilities: windowBase.availableCapabilities,
              }),
            ),
          };
          return { derivation: facts.derivation, execution: redigestExecution({ ...facts.execution, window }) };
        },
        code: "semantic.derivation_mismatch",
      },
      {
        name: "producer implementation",
        build: (facts) => {
          const derivation = redigestDerivation({
            ...facts.derivation,
            producer: { ...facts.derivation.producer, implementationDigest: "0".repeat(64) },
          });
          return { derivation, execution: bindExecutionDerivation(facts.execution, derivation) };
        },
        code: "semantic.derivation_policy_invalid",
      },
      {
        name: "destination",
        build: (facts) => {
          const candidateIntervention = facts.derivation.candidateIntervention;
          if (candidateIntervention === null) throw new Error("missing intervention fixture");
          const derivation = redigestDerivation({
            ...facts.derivation,
            candidateIntervention: { ...candidateIntervention, proposedDestinationKind: "active-prompt" },
          });
          return { derivation, execution: bindExecutionDerivation(facts.execution, derivation) };
        },
        code: "semantic.derivation_policy_invalid",
      },
    ];
    for (const fixture of cases) {
      const harness = await createSemanticEngineHarness({ label: fixture.name.replaceAll(" ", "-") });
      const facts = fixture.build(createSemanticFacts(harness, { withEvidence: false }));
      await expect(
        persistDetectorExecution(harness.context, facts.execution, [facts.derivation]),
      ).rejects.toMatchObject({ code: fixture.code });
      expect(await semanticCounts(harness.store)).toEqual({
        "semantic-registry-snapshot": 0,
        "derivation-execution": 0,
        "insight-derivation": 0,
        "detector-execution": 0,
      });
    }
  });

  it("refuses a self-consistent EvidenceRef whose durable observation digest no longer matches", async () => {
    const harness = await createSemanticEngineHarness();
    const facts = createSemanticFacts(harness);
    const { schemaVersion: _schemaVersion, referenceDigest: _referenceDigest, ...referenceBase } = harness.evidence;
    const wrongReferenceBase = { ...referenceBase, recordDigest: "0".repeat(64) };
    const wrongReference = {
      schemaVersion: 1 as const,
      ...wrongReferenceBase,
      kind: "observation" as const,
      referenceDigest: evidenceRefDigest(wrongReferenceBase),
    };
    const derivation = redigestDerivation({
      ...facts.derivation,
      directObservation: { ...facts.derivation.directObservation, evidenceRefs: [wrongReference] },
    });
    const windowBase = { ...facts.execution.window, evidenceRefs: [wrongReference] };
    const window = {
      ...windowBase,
      windowDigest: sha256HexOfCanonicalJson(
        toJsonValue({
          sourceProfiles: windowBase.sourceProfiles,
          population: windowBase.population,
          evidenceRefs: windowBase.evidenceRefs,
          evidenceHealthFindings: windowBase.evidenceHealthFindings,
          availableCapabilities: windowBase.availableCapabilities,
        }),
      ),
    };
    const execution = bindExecutionDerivation(redigestExecution({ ...facts.execution, window }), derivation);
    await expect(persistDetectorExecution(harness.context, execution, [derivation])).rejects.toMatchObject({
      code: "semantic.evidence_invalid",
    });
    expect(await semanticCounts(harness.store)).toEqual({
      "semantic-registry-snapshot": 0,
      "derivation-execution": 0,
      "insight-derivation": 0,
      "detector-execution": 0,
    });
  });

  it("requires full evidence-health findings to resolve exactly and preserves their blocking effect", async () => {
    const harness = await createSemanticEngineHarness();
    const original = createSemanticFacts(harness);
    const finding = healthFinding({
      sourceId: harness.source.id,
      sourceRegistrationRevision: harness.source.registryRevision,
      sourceRef: harness.evidence.sourceRef,
      pageRef: harness.evidence.pageRef,
      effect: "limits_claims",
    });
    const { derivation, execution } = bindInputHealth(original, finding);

    await expect(persistDetectorExecution(harness.context, execution, [derivation])).rejects.toMatchObject({
      code: "semantic.health_missing",
    });
    await seedHealth(harness.store, finding);
    await persistDetectorExecution(harness.context, execution, [derivation]);
    await expect(loadDetectorExecutionView(harness.context, execution.id, harness.scope)).resolves.toMatchObject({
      evidenceHealth: { status: "incomplete" },
    });
    await expect(loadInsightDerivationView(harness.context, derivation.id, harness.scope)).resolves.toMatchObject({
      evidenceHealth: { status: "incomplete" },
    });
  });

  it("refuses an applied execution whose exact durable input health blocks use", async () => {
    const harness = await createSemanticEngineHarness();
    const finding = healthFinding({
      sourceId: harness.source.id,
      sourceRegistrationRevision: harness.source.registryRevision,
      sourceRef: harness.evidence.sourceRef,
      pageRef: harness.evidence.pageRef,
      effect: "blocks_use",
    });
    await seedHealth(harness.store, finding);
    const facts = bindInputHealth(createSemanticFacts(harness), finding);
    await expect(persistDetectorExecution(harness.context, facts.execution, [facts.derivation])).rejects.toMatchObject({
      code: "semantic.evidence_invalid",
    });
    expect(await semanticCounts(harness.store)).toEqual({
      "semantic-registry-snapshot": 0,
      "derivation-execution": 0,
      "insight-derivation": 0,
      "detector-execution": 0,
    });
  });

  it("persists related evidence-health outputs and refuses an unrelated output before any write", async () => {
    const harness = await createSemanticEngineHarness({ detectorOutputKind: "evidence_health" });
    const related = healthFinding({
      sourceId: harness.source.id,
      sourceRegistrationRevision: harness.source.registryRevision,
      sourceRef: harness.evidence.sourceRef,
      pageRef: harness.evidence.pageRef,
      effect: "limits_claims",
    });
    const relatedFacts = createSemanticFacts(harness, {
      executionResult: {
        status: "applied",
        conditionDetected: true,
        derivationRefs: [],
        evidenceHealthFindings: [related],
      },
    });
    await persistDetectorExecution(harness.context, relatedFacts.execution, []);
    expect(await recordsOf(harness.store, "evidence-health")).toHaveLength(1);
    await expect(
      loadDetectorExecutionView(harness.context, relatedFacts.execution.id, harness.scope),
    ).resolves.toMatchObject({
      commitBinding: { status: "committed" },
      evidenceHealth: { status: "incomplete" },
    });

    const unrelatedHarness = await createSemanticEngineHarness({
      label: "unrelated-health",
      detectorOutputKind: "evidence_health",
    });
    const unrelated = healthFinding({
      sourceId: unrelatedHarness.source.id,
      sourceRegistrationRevision: unrelatedHarness.source.registryRevision,
      sourceRef: "foreign-private-source-ref",
      pageRef: unrelatedHarness.evidence.pageRef,
      effect: "limits_claims",
    });
    const unrelatedFacts = createSemanticFacts(unrelatedHarness, {
      executionResult: {
        status: "applied",
        conditionDetected: true,
        derivationRefs: [],
        evidenceHealthFindings: [unrelated],
      },
    });
    await expect(
      persistDetectorExecution(unrelatedHarness.context, unrelatedFacts.execution, []),
    ).rejects.toMatchObject({ code: "semantic.health_unrelated" });
    expect(await recordsOf(unrelatedHarness.store, "evidence-health")).toEqual([]);
    expect(await semanticCounts(unrelatedHarness.store)).toEqual({
      "semantic-registry-snapshot": 0,
      "derivation-execution": 0,
      "insight-derivation": 0,
      "detector-execution": 0,
    });
  });

  it("revalidates every historical MeasurementEvidenceRefV2 support, receipt, health, and evidenceIds binding", async () => {
    const harness = await createSemanticEngineHarness({
      label: "historical-measurement",
      lensEvidenceKind: "measurement",
      withMeasurement: true,
    });
    const measurementReference = harness.measurementEvidence;
    if (measurementReference === undefined) throw new Error("missing historical measurement fixture");
    const facts = createSemanticFacts(harness, { evidenceRef: measurementReference });
    await persistDetectorExecution(harness.context, facts.execution, [facts.derivation]);
    const historicalContext: EngineContext = { ...harness.context, registryRevision: "f".repeat(64) };
    await expect(
      loadInsightDerivationView(historicalContext, facts.derivation.id, harness.scope),
    ).resolves.toMatchObject({
      registryBinding: { status: "historical_unconfigured" },
      commitBinding: { status: "committed" },
      evidenceHealth: { status: "ready" },
    });

    const support = measurementReference.supportingEvidenceRefs[0];
    if (support === undefined) throw new Error("missing historical measurement support fixture");
    const missingSupportContext = replaceContextStore(
      historicalContext,
      hidingGetStore(harness.store, "observation", support.recordId),
    );
    await expect(
      loadInsightDerivationView(missingSupportContext, facts.derivation.id, harness.scope),
    ).resolves.toMatchObject({ evidenceHealth: { status: "invalid" } });

    const missingReceiptContext = replaceContextStore(
      historicalContext,
      hidingGetStore(harness.store, "source-page-receipt", support.pageReceiptId),
    );
    await expect(
      loadInsightDerivationView(missingReceiptContext, facts.derivation.id, harness.scope),
    ).resolves.toMatchObject({ evidenceHealth: { status: "invalid" } });

    const storedSupport = await harness.store.get({
      namespace: "learning",
      kind: "observation",
      id: support.recordId,
    });
    if (storedSupport === undefined) throw new Error("missing stored support fixture");
    const supportObservation = parseObservation(storedSupport.value);
    const changedSupport = {
      ...supportObservation,
      provenance: { ...supportObservation.provenance, trust: "advisory" as const, completeness: "partial" as const },
    };
    const changedSupportValue = toJsonValue(changedSupport);
    const changedSupportContext = replaceContextStore(
      historicalContext,
      replacingGetStore(harness.store, {
        kind: "observation",
        id: support.recordId,
        value: changedSupportValue,
        digest: sha256HexOfCanonicalJson(changedSupportValue),
      }),
    );
    await expect(
      loadInsightDerivationView(changedSupportContext, facts.derivation.id, harness.scope),
    ).resolves.toMatchObject({ evidenceHealth: { status: "invalid" } });

    const storedMeasurement = await harness.store.get({
      namespace: "learning",
      kind: "measurement",
      id: measurementReference.recordId,
    });
    if (storedMeasurement === undefined) throw new Error("missing stored measurement fixture");
    const measurement = parseMeasurementRecord(storedMeasurement.value);
    const changedMeasurement = {
      ...measurement,
      evidenceIds: [`${harness.source.id}/foreign-support-observation`],
    };
    const changedValue = toJsonValue(changedMeasurement);
    const changedMeasurementContext = replaceContextStore(
      historicalContext,
      replacingGetStore(harness.store, {
        kind: "measurement",
        id: measurement.id,
        value: changedValue,
        digest: sha256HexOfCanonicalJson(changedValue),
      }),
    );
    await expect(
      loadInsightDerivationView(changedMeasurementContext, facts.derivation.id, harness.scope),
    ).resolves.toMatchObject({ evidenceHealth: { status: "invalid" } });

    const blockingHealth = healthFinding({
      sourceId: support.sourceId,
      sourceRegistrationRevision: support.sourceRegistrationRevision,
      sourceRef: support.sourceRef,
      pageRef: support.pageRef,
      effect: "blocks_use",
    });
    await seedHealth(harness.store, blockingHealth);
    await expect(
      loadInsightDerivationView(historicalContext, facts.derivation.id, harness.scope),
    ).resolves.toMatchObject({
      commitBinding: { status: "committed" },
      evidenceHealth: { status: "invalid" },
    });
  });

  it("retains exact links to the same derivation across registry revisions without invalidating provenance", async () => {
    const harness = await createSemanticEngineHarness({ lensEvidenceKind: "episode" });
    const facts = createSemanticFacts(harness, { withEvidence: false });
    await persistDetectorExecution(harness.context, facts.execution, [facts.derivation]);
    const historicalRevision = "c".repeat(64);
    const historicalContext: EngineContext = { ...harness.context, registryRevision: historicalRevision };
    const historicalExecution = redigestExecution({
      ...facts.execution,
      loopRegistryRevision: historicalRevision,
    });
    await persistDetectorExecution(historicalContext, historicalExecution, [facts.derivation]);

    const mixed = await loadInsightDerivationView(harness.context, facts.derivation.id, harness.scope);
    expect(mixed).toMatchObject({
      registryBinding: { status: "configured" },
      commitBinding: { status: "committed" },
    });
    if (mixed?.commitBinding.status !== "committed") throw new Error("expected committed mixed provenance");
    expect(mixed.commitBinding.executionRefs).toHaveLength(2);
    expect(mixed.commitBinding.executionRefs.map((reference) => reference.loopRegistryRevision)).toEqual(
      expect.arrayContaining([harness.context.registryRevision, historicalRevision]),
    );

    const noCurrentLink: EngineContext = { ...harness.context, registryRevision: "d".repeat(64) };
    await expect(loadInsightDerivationView(noCurrentLink, facts.derivation.id, harness.scope)).resolves.toMatchObject({
      registryBinding: { status: "historical_unconfigured" },
      commitBinding: { status: "committed" },
    });
  });

  it("qualifies population-only derivations through episode requirements and refuses a trust floor they do not meet", async () => {
    const qualified = await createSemanticEngineHarness({ lensEvidenceKind: "episode" });
    const qualifiedFacts = createSemanticFacts(qualified, { withEvidence: false });
    await expect(
      persistDetectorExecution(qualified.context, qualifiedFacts.execution, [qualifiedFacts.derivation]),
    ).resolves.toBeUndefined();

    const belowFloor = await createSemanticEngineHarness({
      label: "below-episode-floor",
      lensEvidenceKind: "episode",
      lensMinimumTrust: "verified",
    });
    const belowFacts = createSemanticFacts(belowFloor, { withEvidence: false });
    await expect(
      persistDetectorExecution(belowFloor.context, belowFacts.execution, [belowFacts.derivation]),
    ).rejects.toMatchObject({ code: "semantic.population_invalid" });
    expect(await semanticCounts(belowFloor.store)).toEqual({
      "semantic-registry-snapshot": 0,
      "derivation-execution": 0,
      "insight-derivation": 0,
      "detector-execution": 0,
    });
  });

  it("parses and refuses a population-only bundle with no population before any provenance write", async () => {
    const harness = await createSemanticEngineHarness({ lensEvidenceKind: "episode" });
    const facts = createSemanticFacts(harness, { withEvidence: false });
    const normalizationPolicyDigest = facts.derivation.population.normalizationPolicyDigest;
    const comparabilityPolicyDigest = facts.derivation.population.comparabilityPolicyDigest;
    const population = {
      episodes: [],
      normalizationPolicyDigest,
      comparabilityPolicyDigest,
      populationDigest: sha256HexOfCanonicalJson(
        toJsonValue({ episodes: [], normalizationPolicyDigest, comparabilityPolicyDigest }),
      ),
    };
    const {
      schemaVersion: _schemaVersion,
      id: _id,
      derivationDigest: _derivationDigest,
      ...validBase
    } = facts.derivation;
    const invalidBase = { ...validBase, population };
    const rawDigest: unknown = Reflect.apply(insightDerivationDigest, undefined, [invalidBase]);
    if (typeof rawDigest !== "string") throw new Error("empty population fixture digest was not text");
    const invalidDerivation = {
      schemaVersion: 1,
      id: `insight-${rawDigest}`,
      ...invalidBase,
      derivationDigest: rawDigest,
    };
    await expect(persistDetectorExecution(harness.context, facts.execution, [invalidDerivation])).rejects.toMatchObject(
      { code: "schema.invalid" },
    );
    expect(await semanticCounts(harness.store)).toEqual({
      "semantic-registry-snapshot": 0,
      "derivation-execution": 0,
      "insight-derivation": 0,
      "detector-execution": 0,
    });
  });

  it("refuses missing, orphaned, and linked-but-uncommitted derivation predecessors before successor writes", async () => {
    const missingHarness = await createSemanticEngineHarness({ label: "supersedes-missing" });
    const missingBase = createSemanticFacts(missingHarness);
    const missingDigest = "0".repeat(64);
    const missingSuccessor = redigestDerivation({
      ...missingBase.derivation,
      supersedes: {
        id: `insight-${missingDigest}`,
        derivationDigest: missingDigest,
        scopeDigest: missingBase.derivation.scopeDigest,
      },
    });
    const missingExecution = bindExecutionDerivation(missingBase.execution, missingSuccessor);
    await expect(
      persistDetectorExecution(missingHarness.context, missingExecution, [missingSuccessor]),
    ).rejects.toMatchObject({ code: "semantic.supersedes_invalid" });
    expect(await recordsOf(missingHarness.store, "insight-derivation")).toEqual([]);

    const orphanHarness = await createSemanticEngineHarness({ label: "supersedes-orphan" });
    const orphanBase = createSemanticFacts(orphanHarness);
    const orphanValue = toJsonValue(orphanBase.derivation);
    await orphanHarness.store.create(
      { namespace: "learning", kind: "insight-derivation", id: orphanBase.derivation.id },
      orphanValue,
      sha256HexOfCanonicalJson(orphanValue),
      "seed-orphan-predecessor",
    );
    const orphanSuccessor = redigestDerivation({
      ...orphanBase.derivation,
      directObservation: {
        ...orphanBase.derivation.directObservation,
        data: { condition: "orphan-successor" },
      },
      supersedes: {
        id: orphanBase.derivation.id,
        derivationDigest: orphanBase.derivation.derivationDigest,
        scopeDigest: orphanBase.derivation.scopeDigest,
      },
    });
    const orphanExecution = bindExecutionDerivation(orphanBase.execution, orphanSuccessor);
    await expect(
      persistDetectorExecution(orphanHarness.context, orphanExecution, [orphanSuccessor]),
    ).rejects.toMatchObject({ code: "semantic.supersedes_invalid" });
    expect(await recordsOf(orphanHarness.store, "insight-derivation")).toHaveLength(1);

    const linkedBase = createInMemoryStore();
    const linkedHarness = await createSemanticEngineHarness({
      store: failBeforeFirstCreate(linkedBase, "detector-execution"),
      label: "supersedes-linked",
    });
    const linkedPredecessor = createSemanticFacts(linkedHarness);
    await expect(
      persistDetectorExecution(linkedHarness.context, linkedPredecessor.execution, [linkedPredecessor.derivation]),
    ).rejects.toThrow("failed before detector-execution create");
    const linkedSuccessor = redigestDerivation({
      ...linkedPredecessor.derivation,
      directObservation: {
        ...linkedPredecessor.derivation.directObservation,
        data: { condition: "linked-successor" },
      },
      supersedes: {
        id: linkedPredecessor.derivation.id,
        derivationDigest: linkedPredecessor.derivation.derivationDigest,
        scopeDigest: linkedPredecessor.derivation.scopeDigest,
      },
    });
    const linkedExecution = bindExecutionDerivation(linkedPredecessor.execution, linkedSuccessor);
    await expect(
      persistDetectorExecution(linkedHarness.context, linkedExecution, [linkedSuccessor]),
    ).rejects.toMatchObject({ code: "semantic.supersedes_invalid" });
    expect(await recordsOf(linkedBase, "detector-execution")).toEqual([]);
    expect(await recordsOf(linkedBase, "insight-derivation")).toHaveLength(1);
  });

  it("allows an exact committed historical predecessor without reusing current registry authority", async () => {
    const harness = await createSemanticEngineHarness({
      label: "supersedes-historical",
      lensEvidenceKind: "episode",
    });
    const predecessor = createSemanticFacts(harness, { withEvidence: false });
    await persistDetectorExecution(harness.context, predecessor.execution, [predecessor.derivation]);
    const historicalContext: EngineContext = { ...harness.context, registryRevision: "e".repeat(64) };
    const successor = redigestDerivation({
      ...predecessor.derivation,
      directObservation: {
        ...predecessor.derivation.directObservation,
        data: { condition: "historical-successor" },
      },
      supersedes: {
        id: predecessor.derivation.id,
        derivationDigest: predecessor.derivation.derivationDigest,
        scopeDigest: predecessor.derivation.scopeDigest,
      },
    });
    const successorExecution = redigestExecution({
      ...bindExecutionDerivation(predecessor.execution, successor),
      loopRegistryRevision: historicalContext.registryRevision,
    });
    await expect(persistDetectorExecution(historicalContext, successorExecution, [successor])).resolves.toBeUndefined();
    await expect(
      loadInsightDerivationView(historicalContext, predecessor.derivation.id, harness.scope),
    ).resolves.toMatchObject({
      registryBinding: { status: "historical_unconfigured" },
      commitBinding: { status: "committed" },
    });
    await expect(loadInsightDerivationView(historicalContext, successor.id, harness.scope)).resolves.toMatchObject({
      registryBinding: { status: "configured" },
      commitBinding: { status: "committed" },
    });
  });

  it("marks a receipt invalid when its exact registry snapshot is missing, never configured by current memory alone", async () => {
    const harness = await createSemanticEngineHarness();
    const facts = createSemanticFacts(harness);
    await persistDetectorExecution(harness.context, facts.execution, [facts.derivation]);
    const hidingStore: LearningStore = {
      get: (key) => (key.kind === "semantic-registry-snapshot" ? Promise.resolve(undefined) : harness.store.get(key)),
      create: (key, value, digest, operationId) => harness.store.create(key, value, digest, operationId),
      compareAndSet: (key, expectedRevision, value, digest, operationId) =>
        harness.store.compareAndSet(key, expectedRevision, value, digest, operationId),
      append: (stream, expectedRevision, entries, operationId) =>
        harness.store.append(stream, expectedRevision, entries, operationId),
      tombstone: (input) => harness.store.tombstone(input),
      list: (query) => harness.store.list(query),
    };
    const context = replaceContextStore(harness.context, hidingStore);
    await expect(loadDetectorExecutionView(context, facts.execution.id, harness.scope)).resolves.toMatchObject({
      commitBinding: { status: "invalid" },
    });
    await expect(loadInsightDerivationView(context, facts.derivation.id, harness.scope)).resolves.toMatchObject({
      commitBinding: { status: "invalid" },
    });
  });

  it("rejects malformed stream entry digests and foreign registry-snapshot key bindings", async () => {
    const harness = await createSemanticEngineHarness();
    const facts = createSemanticFacts(harness);
    await persistDetectorExecution(harness.context, facts.execution, [facts.derivation]);

    const stream = await harness.store.get({
      namespace: "learning",
      kind: "derivation-execution",
      id: facts.derivation.id,
    });
    if (stream === undefined || !Array.isArray(stream.value) || stream.value[0] === undefined) {
      throw new Error("missing stream corruption fixture");
    }
    const firstEntry = stream.value[0];
    if (typeof firstEntry !== "object" || firstEntry === null || Array.isArray(firstEntry)) {
      throw new Error("malformed stream corruption fixture");
    }
    const malformedStream = [{ ...firstEntry, digest: "0".repeat(64) }, ...stream.value.slice(1)];
    const streamContext = replaceContextStore(
      harness.context,
      replacingGetStore(harness.store, {
        kind: "derivation-execution",
        id: facts.derivation.id,
        value: malformedStream,
        digest: stream.digest,
      }),
    );
    await expect(loadInsightDerivationView(streamContext, facts.derivation.id, harness.scope)).rejects.toMatchObject({
      code: "store.corrupt",
    });

    const foreignRevision = "0".repeat(64);
    const snapshotBase = { loopRegistryRevision: foreignRevision, semanticRegistry: harness.registry };
    const foreignSnapshot = {
      schemaVersion: 1,
      ...snapshotBase,
      snapshotDigest: sha256HexOfCanonicalJson(toJsonValue(snapshotBase)),
    };
    const snapshotValue = toJsonValue(foreignSnapshot);
    const snapshotContext = replaceContextStore(
      harness.context,
      replacingGetStore(harness.store, {
        kind: "semantic-registry-snapshot",
        id: harness.context.registryRevision,
        value: snapshotValue,
        digest: sha256HexOfCanonicalJson(snapshotValue),
      }),
    );
    await expect(loadDetectorExecutionView(snapshotContext, facts.execution.id, harness.scope)).rejects.toMatchObject({
      code: "store.corrupt",
    });
  });

  it("marks self-consistent non-reciprocal link scope as invalid from both graph directions", async () => {
    const harness = await createSemanticEngineHarness();
    const facts = createSemanticFacts(harness);
    await persistDetectorExecution(harness.context, facts.execution, [facts.derivation]);
    const stream = await harness.store.get({
      namespace: "learning",
      kind: "derivation-execution",
      id: facts.derivation.id,
    });
    if (stream === undefined || !Array.isArray(stream.value) || stream.value[0] === undefined) {
      throw new Error("missing reciprocal link fixture");
    }
    const firstEntry = stream.value[0];
    if (typeof firstEntry !== "object" || firstEntry === null || Array.isArray(firstEntry)) {
      throw new Error("malformed reciprocal link entry");
    }
    const rawLink = firstEntry.value;
    if (typeof rawLink !== "object" || rawLink === null || Array.isArray(rawLink)) {
      throw new Error("malformed reciprocal link value");
    }
    const { schemaVersion: _schemaVersion, linkDigest: _linkDigest, ...linkBaseFields } = rawLink;
    const wrongLinkBase = { ...linkBaseFields, scopeDigest: "0".repeat(64) };
    const wrongLink = {
      schemaVersion: 1,
      ...wrongLinkBase,
      linkDigest: sha256HexOfCanonicalJson(toJsonValue(wrongLinkBase)),
    };
    const wrongLinkValue = toJsonValue(wrongLink);
    const wrongEntry = {
      ...firstEntry,
      digest: sha256HexOfCanonicalJson(wrongLinkValue),
      value: wrongLinkValue,
    };
    const wrongStream = [wrongEntry, ...stream.value.slice(1)];
    const context = replaceContextStore(
      harness.context,
      replacingGetStore(harness.store, {
        kind: "derivation-execution",
        id: facts.derivation.id,
        value: wrongStream,
        digest: stream.digest,
      }),
    );
    await expect(loadInsightDerivationView(context, facts.derivation.id, harness.scope)).resolves.toMatchObject({
      commitBinding: { status: "invalid" },
    });
    await expect(loadDetectorExecutionView(context, facts.execution.id, harness.scope)).resolves.toMatchObject({
      commitBinding: { status: "invalid" },
    });
  });
});
