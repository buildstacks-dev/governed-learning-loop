// #30c2b2 observational recurrence claims: exact derivation/Candidate lineage,
// receipt-last proposal recovery, append-only groups, and inert public views.
import { describe, expect, it } from "vitest";
import type { Candidate, CandidateInput, InsightDerivation, LearningStore, VerifiedPrincipal } from "../src/index.js";
import {
  candidateContentDigest,
  createLearningLoop,
  detectorExecutionDigest,
  detectorExecutionKeyDigest,
  parseCandidate,
  parseDetectorExecutionRecord,
  parseEvidenceHealthFinding,
  sha256HexOfCanonicalJson,
  toJsonValue,
} from "../src/index.js";
import type { EngineContext } from "../src/engine/context.js";
import {
  loadExecutionRecurrenceBinding,
  prepareExecutionRecurrence,
  persistPreparedExecutionRecurrence,
  recurrenceReceiptLineage,
} from "../src/engine/detector-recurrence.js";
import { runGetCandidateView } from "../src/engine/query.js";
import {
  buildDerivationRecurrenceClaims,
  loadCandidateRecurrenceClaim,
  loadCandidateRecurrenceLineage,
  loadCommittedDerivationRecurrenceClaims,
  prepareCandidateRecurrenceClaim,
} from "../src/engine/recurrence-claims.js";
import { persistDetectorExecution } from "../src/engine/semantic-persistence.js";
import { persistHealthFinding } from "../src/engine/source-receipts.js";
import { loadDetectorExecutionRecord } from "../src/engine/semantic-graph.js";
import { evidenceHealthFindingDigest } from "../src/records/source-health.js";
import { createInMemoryStore } from "../src/testing/index.js";
import { PRIVATE_LOCATOR } from "./detector-recurrence-harness.js";
import type { SemanticEngineHarness } from "./semantic-engine-harness.js";
import { createSemanticEngineHarness, createSemanticFacts } from "./semantic-engine-harness.js";

type DerivedCandidateInput = Extract<CandidateInput, { readonly derivationId: string }>;
type ManualCandidateInput = Extract<CandidateInput, { readonly problem: string }>;
const CLAIM_ACK_TARGETS: readonly ("candidate-recurrence-claim" | "detector-recurrence-group-candidate")[] = [
  "candidate-recurrence-claim",
  "detector-recurrence-group-candidate",
];

function derivedInput(
  proposedBy: VerifiedPrincipal,
  derivation: InsightDerivation,
  input: { readonly id: string; readonly proposedRisk?: "T0" | "T1" | "T2" | "T3" },
): DerivedCandidateInput {
  return {
    id: input.id,
    scope: derivation.scope,
    derivationId: derivation.id,
    proposedRisk: input.proposedRisk ?? "T1",
    proposedBy,
  };
}

function manualInput(
  proposedBy: VerifiedPrincipal,
  scope: InsightDerivation["scope"],
  evidenceId: string,
  id = "manual-recurrence-candidate",
): ManualCandidateInput {
  return {
    id,
    scope,
    problem: "A manually reported problem.",
    hypothesis: "A manual hypothesis.",
    evidenceIds: [evidenceId],
    intervention: {
      destinationId: "host/manual-report",
      kind: "report-note",
      content: { note: "manual" },
      rollbackIntent: "Remove the inert report note.",
    },
    proposedRisk: "T1",
    proposedBy,
  };
}

async function countKind(store: LearningStore, kind: string): Promise<number> {
  return (await store.list({ namespace: "learning", kind, limit: 10_000 })).records.length;
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

function failBeforeCandidateReceipt(base: LearningStore): LearningStore {
  let failed = false;
  return {
    get: (key) => base.get(key),
    create: (key, value, digest, operationId) => {
      if (!failed && key.kind === "candidate") {
        failed = true;
        throw new Error("failed before Candidate receipt");
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

function failAfterCandidateIndex(base: LearningStore): LearningStore {
  let failed = false;
  return {
    get: (key) => base.get(key),
    create: async (key, value, digest, operationId) => {
      const result = await base.create(key, value, digest, operationId);
      if (!failed && key.kind === "candidate-by-digest") {
        failed = true;
        throw new Error("failed after Candidate content lock");
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

function failAfterCandidateDecision(base: LearningStore): LearningStore {
  let failed = false;
  return {
    get: (key) => base.get(key),
    create: async (key, value, digest, operationId) => {
      const result = await base.create(key, value, digest, operationId);
      if (!failed && key.kind === "candidate-recurrence-claim") {
        failed = true;
        throw new Error("failed after Candidate recurrence decision");
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

function loseClaimAcknowledgement(
  base: LearningStore,
  target: "candidate-recurrence-claim" | "detector-recurrence-group-candidate",
): LearningStore {
  let failed = false;
  return {
    get: (key) => base.get(key),
    create: async (key, value, digest, operationId) => {
      const result = await base.create(key, value, digest, operationId);
      if (!failed && target === "candidate-recurrence-claim" && key.kind === target) {
        failed = true;
        throw new Error("lost Candidate claim acknowledgement");
      }
      return result;
    },
    compareAndSet: (key, expectedRevision, value, digest, operationId) =>
      base.compareAndSet(key, expectedRevision, value, digest, operationId),
    append: async (stream, expectedRevision, entries, operationId) => {
      const result = await base.append(stream, expectedRevision, entries, operationId);
      if (!failed && target === "detector-recurrence-group-candidate" && stream.kind === target) {
        failed = true;
        throw new Error("lost Candidate group acknowledgement");
      }
      return result;
    },
    tombstone: (input) => base.tombstone(input),
    list: (query) => base.list(query),
  };
}

function pausingCandidateIndexStore(base: LearningStore) {
  let releaseIndex: (() => void) | undefined;
  let signalIndexed: (() => void) | undefined;
  const pause = new Promise<void>((resolve) => {
    releaseIndex = resolve;
  });
  const indexed = new Promise<void>((resolve) => {
    signalIndexed = resolve;
  });
  let paused = false;
  const store: LearningStore = {
    get: (key) => base.get(key),
    create: async (key, value, digest, operationId) => {
      const result = await base.create(key, value, digest, operationId);
      if (!paused && key.kind === "candidate-by-digest" && result.status === "created") {
        paused = true;
        signalIndexed?.();
        await pause;
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
  return {
    store,
    indexed,
    release: () => {
      if (releaseIndex === undefined) throw new Error("candidate index pause was not initialized");
      releaseIndex();
    },
  };
}

function hidingStore(base: LearningStore, kind: string, id?: string): LearningStore {
  return {
    get: (key) =>
      key.kind === kind && (id === undefined || key.id === id) ? Promise.resolve(undefined) : base.get(key),
    create: (key, value, digest, operationId) => base.create(key, value, digest, operationId),
    compareAndSet: (key, expectedRevision, value, digest, operationId) =>
      base.compareAndSet(key, expectedRevision, value, digest, operationId),
    append: (stream, expectedRevision, entries, operationId) =>
      base.append(stream, expectedRevision, entries, operationId),
    tombstone: (input) => base.tombstone(input),
    list: (query) => base.list(query),
  };
}

function historicalClaimStore(base: LearningStore, candidate: Candidate): LearningStore {
  return {
    get: async (key) => {
      if (key.kind === "candidate-recurrence-claim" && key.id === candidate.id) return undefined;
      const stored = await base.get(key);
      if (stored === undefined || key.kind !== "candidate-by-digest" || key.id !== candidate.contentDigest) {
        return stored;
      }
      const value = toJsonValue({ candidateId: candidate.id, contentDigest: candidate.contentDigest });
      return { ...stored, value, digest: sha256HexOfCanonicalJson(value) };
    },
    create: (key, value, digest, operationId) => base.create(key, value, digest, operationId),
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

function proposalLoop(harness: SemanticEngineHarness, store: LearningStore, now: () => string) {
  return createLearningLoop({
    store,
    policy: harness.context.policy,
    identity: harness.context.identity,
    scopePolicy: harness.context.scopePolicy,
    contentPolicies: [...harness.context.contentPoliciesById.values()],
    sources: [...harness.context.sources],
    semanticRegistry: harness.registry,
    queryCursorScope: "candidate-claim-anchor-clock",
    clock: { now },
    ids: harness.context.ids,
  });
}

async function groupedFixture(store?: LearningStore) {
  const harness = await createSemanticEngineHarness(store === undefined ? {} : { store });
  const facts = createSemanticFacts(harness);
  await persistDetectorExecution(harness.context, facts.execution, [facts.derivation], PRIVATE_LOCATOR);
  const proposer = await harness.context.identity.verify({
    principalId: "recurrence-claim-proposer",
    kind: "agent",
    independenceDomain: "recurrence-claim-domain",
  });
  return { harness, facts, proposer };
}

async function persistSyntheticGroupGrowth(
  harness: SemanticEngineHarness,
  facts: ReturnType<typeof createSemanticFacts>,
  label: string,
) {
  const executionInput = {
    ...facts.execution,
    pack: {
      id: `synthetic-growth-pack-${label}`,
      version: "1.0.0",
      manifestDigest: sha256HexOfCanonicalJson(toJsonValue({ syntheticGrowthPack: label })),
    },
  };
  const executionKeyDigest = detectorExecutionKeyDigest(executionInput);
  const executionDigest = detectorExecutionDigest({
    ...executionInput,
    result: executionInput.result,
    executionKeyDigest,
  });
  const execution = parseDetectorExecutionRecord({
    ...executionInput,
    id: `detector-execution-${executionKeyDigest}`,
    executionKeyDigest,
    executionDigest,
  });
  const binding = await prepareExecutionRecurrence(harness.context, execution, PRIVATE_LOCATOR);
  if (binding === undefined) throw new Error("expected synthetic group-growth binding");
  await persistPreparedExecutionRecurrence(harness.context, binding);
  const value = toJsonValue(execution);
  await harness.store.create(
    { namespace: "learning", kind: "detector-execution", id: execution.id },
    value,
    sha256HexOfCanonicalJson(value),
    `synthetic-growth-execution/${execution.id}`,
  );
  return execution;
}

describe("derivation recurrence claims", () => {
  it("binds exact execution/group/population lineage and pins a digest golden", async () => {
    const writes: string[] = [];
    const base = createInMemoryStore();
    const harness = await createSemanticEngineHarness({ store: recordingStore(base, writes) });
    const facts = createSemanticFacts(harness);
    writes.length = 0;
    await persistDetectorExecution(harness.context, facts.execution, [facts.derivation], PRIVATE_LOCATOR);
    const claims = await loadCommittedDerivationRecurrenceClaims(
      harness.context,
      facts.derivation.id,
      facts.derivation.derivationDigest,
    );
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({
      derivationId: facts.derivation.id,
      derivationDigest: facts.derivation.derivationDigest,
      executionId: facts.execution.id,
      executionKeyDigest: facts.execution.executionKeyDigest,
      executionDigest: facts.execution.executionDigest,
      scopeDigest: facts.derivation.scopeDigest,
      populationDigest: facts.derivation.population.populationDigest,
      episodeIdentityDigests: [harness.episodeView.episodeIdentityDigest],
      distinctEpisodeCount: 1,
    });
    expect(claims[0]?.claimDigest).toBe("56f5688b62a99ad74bac84c32461f7536cabcf65c526859984a46416ef9b2254");
    expect(await countKind(base, "derivation-recurrence-claim")).toBe(1);
    expect(await countKind(base, "derivation-recurrence")).toBe(1);
    expect(writes.indexOf("derivation-recurrence-claim")).toBeLessThan(writes.indexOf("detector-execution"));
    expect(writes.indexOf("derivation-recurrence")).toBeLessThan(writes.indexOf("detector-execution"));
  });

  it("keeps a pre-execution claim orphaned until exact retry commits its witness", async () => {
    const base = createInMemoryStore();
    let failed = false;
    const failing: LearningStore = {
      get: (key) => base.get(key),
      create: (key, value, digest, operationId) => {
        if (!failed && key.kind === "detector-execution") {
          failed = true;
          throw new Error("failed before derivation witness receipt");
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
    const harness = await createSemanticEngineHarness({ store: failing });
    const facts = createSemanticFacts(harness);
    await expect(
      persistDetectorExecution(harness.context, facts.execution, [facts.derivation], PRIVATE_LOCATOR),
    ).rejects.toThrowError("failed before derivation witness receipt");
    expect(await countKind(base, "derivation-recurrence-claim")).toBe(1);
    expect(
      await loadCommittedDerivationRecurrenceClaims(
        harness.context,
        facts.derivation.id,
        facts.derivation.derivationDigest,
      ),
    ).toEqual([]);
    await persistDetectorExecution(harness.context, facts.execution, [facts.derivation], PRIVATE_LOCATOR);
    expect(
      await loadCommittedDerivationRecurrenceClaims(
        harness.context,
        facts.derivation.id,
        facts.derivation.derivationDigest,
      ),
    ).toHaveLength(1);
    expect(await countKind(base, "derivation-recurrence-claim")).toBe(1);
  });

  it("refuses derivation claims whose execution/group/population relationship is not exact", async () => {
    const harness = await createSemanticEngineHarness();
    const facts = createSemanticFacts(harness);
    const binding = await prepareExecutionRecurrence(harness.context, facts.execution, PRIVATE_LOCATOR);
    if (binding === undefined) throw new Error("expected derivation claim binding");
    const foreignDerivation = { ...facts.derivation, scopeDigest: "0".repeat(64) };
    expect(() => buildDerivationRecurrenceClaims(facts.execution, binding, [foreignDerivation])).toThrowError(
      expect.objectContaining({ code: "store.corrupt" }),
    );
    const missingPopulation = { ...facts.derivation, population: { ...facts.derivation.population, episodes: [] } };
    expect(() => buildDerivationRecurrenceClaims(facts.execution, binding, [missingPopulation])).toThrowError(
      expect.objectContaining({ code: "store.corrupt" }),
    );
  });

  it("retains multiple exact content-addressed claims for one derivation", async () => {
    const { harness, facts } = await groupedFixture();
    const code: "source.partial" = "source.partial";
    const effect: "limits_claims" = "limits_claims";
    const completeness: "partial" = "partial";
    const findingBase = {
      code,
      effect,
      sourceId: harness.evidence.sourceId,
      sourceRegistrationRevision: harness.evidence.sourceRegistrationRevision,
      sourceRef: harness.evidence.sourceRef,
      pageRef: harness.evidence.pageRef,
      completeness,
      affectedRecords: 1,
    };
    const findingDigest = evidenceHealthFindingDigest(findingBase);
    const finding = parseEvidenceHealthFinding({
      schemaVersion: 1,
      id: `evidence-health-${findingDigest}`,
      ...findingBase,
      findingDigest,
    });
    const windowBase = {
      sourceProfiles: facts.execution.window.sourceProfiles,
      population: facts.execution.window.population,
      evidenceRefs: facts.execution.window.evidenceRefs,
      evidenceHealthFindings: [finding],
      availableCapabilities: facts.execution.window.availableCapabilities,
    };
    const executionInput = {
      ...facts.execution,
      window: { ...windowBase, windowDigest: sha256HexOfCanonicalJson(toJsonValue(windowBase)) },
    };
    const executionKeyDigest = detectorExecutionKeyDigest(executionInput);
    const executionDigest = detectorExecutionDigest({
      ...executionInput,
      result: executionInput.result,
      executionKeyDigest,
    });
    const execution = parseDetectorExecutionRecord({
      ...executionInput,
      id: `detector-execution-${executionKeyDigest}`,
      executionKeyDigest,
      executionDigest,
    });
    await persistHealthFinding(harness.context, finding);
    await persistDetectorExecution(harness.context, execution, [facts.derivation], PRIVATE_LOCATOR);
    const claims = await loadCommittedDerivationRecurrenceClaims(
      harness.context,
      facts.derivation.id,
      facts.derivation.derivationDigest,
    );
    expect(claims).toHaveLength(2);
    expect(new Set(claims.map((claim) => claim.executionDigest))).toEqual(
      new Set([facts.execution.executionDigest, execution.executionDigest]),
    );
    expect(await countKind(harness.store, "derivation-recurrence")).toBe(1);
  });

  it("requires an exact committed recurrence group member for a derivation claim", async () => {
    const { harness, facts } = await groupedFixture();
    const invalidContext = replaceContextStore(
      harness.context,
      hidingStore(harness.store, "detector-recurrence-group"),
    );
    await expect(
      loadCommittedDerivationRecurrenceClaims(invalidContext, facts.derivation.id, facts.derivation.derivationDigest),
    ).rejects.toMatchObject({ code: "store.corrupt" });
  });

  it("folds many same-group claim witnesses once instead of rescanning the group per claim", async () => {
    const { harness, facts } = await groupedFixture();
    const code: "source.partial" = "source.partial";
    const effect: "limits_claims" = "limits_claims";
    const completeness: "partial" = "partial";
    for (let index = 0; index < 12; index += 1) {
      const findingBase = {
        code,
        effect,
        sourceId: harness.evidence.sourceId,
        sourceRegistrationRevision: harness.evidence.sourceRegistrationRevision,
        sourceRef: harness.evidence.sourceRef,
        pageRef: harness.evidence.pageRef,
        completeness,
        affectedRecords: index + 1,
      };
      const findingDigest = evidenceHealthFindingDigest(findingBase);
      const finding = parseEvidenceHealthFinding({
        schemaVersion: 1,
        id: `evidence-health-${findingDigest}`,
        ...findingBase,
        findingDigest,
      });
      await persistHealthFinding(harness.context, finding);
      const windowBase = {
        sourceProfiles: facts.execution.window.sourceProfiles,
        population: facts.execution.window.population,
        evidenceRefs: facts.execution.window.evidenceRefs,
        evidenceHealthFindings: [finding],
        availableCapabilities: facts.execution.window.availableCapabilities,
      };
      const executionInput = {
        ...facts.execution,
        window: { ...windowBase, windowDigest: sha256HexOfCanonicalJson(toJsonValue(windowBase)) },
      };
      const executionKeyDigest = detectorExecutionKeyDigest(executionInput);
      const executionDigest = detectorExecutionDigest({
        ...executionInput,
        result: executionInput.result,
        executionKeyDigest,
      });
      const execution = parseDetectorExecutionRecord({
        ...executionInput,
        id: `detector-execution-${executionKeyDigest}`,
        executionKeyDigest,
        executionDigest,
      });
      await persistDetectorExecution(harness.context, execution, [facts.derivation], PRIVATE_LOCATOR);
    }
    let groupReads = 0;
    const observing: LearningStore = {
      get: (key) => {
        if (key.kind === "detector-recurrence-group") groupReads += 1;
        return harness.store.get(key);
      },
      create: (key, value, digest, operationId) => harness.store.create(key, value, digest, operationId),
      compareAndSet: (key, expectedRevision, value, digest, operationId) =>
        harness.store.compareAndSet(key, expectedRevision, value, digest, operationId),
      append: (stream, expectedRevision, entries, operationId) =>
        harness.store.append(stream, expectedRevision, entries, operationId),
      tombstone: (input) => harness.store.tombstone(input),
      list: (query) => harness.store.list(query),
    };
    const claims = await loadCommittedDerivationRecurrenceClaims(
      replaceContextStore(harness.context, observing),
      facts.derivation.id,
      facts.derivation.derivationDigest,
    );
    expect(claims).toHaveLength(13);
    expect(groupReads).toBeLessThanOrEqual(2);
  });

  it("rejects a second recurrence group before folding that foreign group", async () => {
    const { harness, facts } = await groupedFixture();
    const code: "source.partial" = "source.partial";
    const effect: "limits_claims" = "limits_claims";
    const completeness: "partial" = "partial";
    const findingBase = {
      code,
      effect,
      sourceId: harness.evidence.sourceId,
      sourceRegistrationRevision: harness.evidence.sourceRegistrationRevision,
      sourceRef: harness.evidence.sourceRef,
      pageRef: harness.evidence.pageRef,
      completeness,
      affectedRecords: 99,
    };
    const findingDigest = evidenceHealthFindingDigest(findingBase);
    const finding = parseEvidenceHealthFinding({
      schemaVersion: 1,
      id: `evidence-health-${findingDigest}`,
      ...findingBase,
      findingDigest,
    });
    await persistHealthFinding(harness.context, finding);
    const windowBase = {
      sourceProfiles: facts.execution.window.sourceProfiles,
      population: facts.execution.window.population,
      evidenceRefs: facts.execution.window.evidenceRefs,
      evidenceHealthFindings: [finding],
      availableCapabilities: facts.execution.window.availableCapabilities,
    };
    const executionInput = {
      ...facts.execution,
      window: { ...windowBase, windowDigest: sha256HexOfCanonicalJson(toJsonValue(windowBase)) },
    };
    const executionKeyDigest = detectorExecutionKeyDigest(executionInput);
    const executionDigest = detectorExecutionDigest({
      ...executionInput,
      result: executionInput.result,
      executionKeyDigest,
    });
    const execution = parseDetectorExecutionRecord({
      ...executionInput,
      id: `detector-execution-${executionKeyDigest}`,
      executionKeyDigest,
      executionDigest,
    });
    const otherLocator = { ...PRIVATE_LOCATOR, keyedDigest: "e".repeat(64) };
    await expect(
      persistDetectorExecution(harness.context, execution, [facts.derivation], otherLocator),
    ).rejects.toMatchObject({ code: "store.corrupt" });

    const otherBinding = await loadExecutionRecurrenceBinding(harness.context, execution.id);
    if (otherBinding?.groupKeyDigest === null || otherBinding?.groupKeyDigest === undefined) {
      throw new Error("expected foreign recurrence group binding");
    }
    const groupReads: string[] = [];
    const observing: LearningStore = {
      get: (key) => {
        if (key.kind === "detector-recurrence-group") groupReads.push(key.id);
        return harness.store.get(key);
      },
      create: (key, value, digest, operationId) => harness.store.create(key, value, digest, operationId),
      compareAndSet: (key, expectedRevision, value, digest, operationId) =>
        harness.store.compareAndSet(key, expectedRevision, value, digest, operationId),
      append: (stream, expectedRevision, entries, operationId) =>
        harness.store.append(stream, expectedRevision, entries, operationId),
      tombstone: (input) => harness.store.tombstone(input),
      list: (query) => harness.store.list(query),
    };
    await expect(
      loadCommittedDerivationRecurrenceClaims(
        replaceContextStore(harness.context, observing),
        facts.derivation.id,
        facts.derivation.derivationDigest,
      ),
    ).rejects.toMatchObject({ code: "store.corrupt" });
    expect(new Set(groupReads).size).toBe(1);
    expect(groupReads).not.toContain(otherBinding.groupKeyDigest);
  });

  it("accepts exactly 5,000 claim refs and fails closed at 5,001 without truncation", async () => {
    const harness = await createSemanticEngineHarness();
    const facts = createSemanticFacts(harness);
    const binding = await prepareExecutionRecurrence(harness.context, facts.execution, PRIVATE_LOCATOR);
    if (binding === undefined) throw new Error("expected claim-ceiling binding");
    const template = buildDerivationRecurrenceClaims(facts.execution, binding, [facts.derivation])[0];
    if (template === undefined) throw new Error("expected claim-ceiling template");
    const claims = Array.from({ length: 5_001 }, (_, index) => {
      const executionKeyDigest = sha256HexOfCanonicalJson(toJsonValue({ claimExecutionKey: index }));
      const base = {
        derivationId: template.derivationId,
        derivationDigest: template.derivationDigest,
        executionId: `detector-execution-${executionKeyDigest}`,
        executionKeyDigest,
        executionDigest: sha256HexOfCanonicalJson(toJsonValue({ claimExecution: index })),
        scopeDigest: template.scopeDigest,
        groupKeyDigest: template.groupKeyDigest,
        decisionBindingDigest: template.decisionBindingDigest,
        populationDigest: template.populationDigest,
        episodeIdentityDigests: template.episodeIdentityDigests,
        episodeIdentitySetDigest: template.episodeIdentitySetDigest,
        distinctEpisodeCount: template.distinctEpisodeCount,
      };
      return { schemaVersion: 1, ...base, claimDigest: sha256HexOfCanonicalJson(toJsonValue(base)) };
    });
    await Promise.all(
      claims.slice(0, 5_000).map(async (claim) => {
        const value = toJsonValue(claim);
        await harness.store.create(
          { namespace: "learning", kind: "derivation-recurrence-claim", id: claim.claimDigest },
          value,
          sha256HexOfCanonicalJson(value),
          `seed-claim/${claim.claimDigest}`,
        );
      }),
    );
    const entries = claims.slice(0, 5_000).map((claim) => {
      const value = toJsonValue({ claimDigest: claim.claimDigest });
      return { id: `claim:${claim.claimDigest}`, digest: sha256HexOfCanonicalJson(value), value };
    });
    await harness.store.append(
      { namespace: "learning", kind: "derivation-recurrence", id: facts.derivation.id },
      undefined,
      entries,
      "seed-claim-stream/exact-5000",
    );
    expect(
      await loadCommittedDerivationRecurrenceClaims(
        harness.context,
        facts.derivation.id,
        facts.derivation.derivationDigest,
      ),
    ).toEqual([]);

    const extra = claims[5_000];
    if (extra === undefined) throw new Error("expected claim 5001");
    const extraValue = toJsonValue(extra);
    await harness.store.create(
      { namespace: "learning", kind: "derivation-recurrence-claim", id: extra.claimDigest },
      extraValue,
      sha256HexOfCanonicalJson(extraValue),
      `seed-claim/${extra.claimDigest}`,
    );
    const stored = await harness.store.get({
      namespace: "learning",
      kind: "derivation-recurrence",
      id: facts.derivation.id,
    });
    if (stored === undefined) throw new Error("expected exact claim stream");
    const refValue = toJsonValue({ claimDigest: extra.claimDigest });
    await harness.store.append(
      { namespace: "learning", kind: "derivation-recurrence", id: facts.derivation.id },
      stored.revision,
      [{ id: `claim:${extra.claimDigest}`, digest: sha256HexOfCanonicalJson(refValue), value: refValue }],
      "seed-claim-stream/5001",
    );
    await expect(
      loadCommittedDerivationRecurrenceClaims(harness.context, facts.derivation.id, facts.derivation.derivationDigest),
    ).rejects.toMatchObject({ code: "store.corrupt" });
  }, 30_000);
});

describe("Candidate recurrence decisions and views", () => {
  it("creates one exact grouped claim and resolves CandidateView recurrence lineage", async () => {
    const { harness, facts, proposer } = await groupedFixture();
    const outcome = await harness.learning.propose(
      derivedInput(proposer, facts.derivation, { id: "grouped-recurrence-candidate" }),
    );
    const claim = await loadCandidateRecurrenceClaim(harness.context, outcome.candidate.id);
    expect(claim).toMatchObject({
      status: "grouped",
      candidateId: outcome.candidate.id,
      candidateDigest: outcome.candidate.contentDigest,
      candidate: outcome.candidate,
      derivationId: facts.derivation.id,
      derivationDigest: facts.derivation.derivationDigest,
      distinctEpisodeCount: 1,
      episodeIdentityDigestsAtProposal: [harness.episodeView.episodeIdentityDigest],
      proposalMembers: [
        {
          executionId: facts.execution.id,
          executionKeyDigest: facts.execution.executionKeyDigest,
          executionDigest: facts.execution.executionDigest,
        },
      ],
      supersedes: null,
    });
    if (claim?.status === "grouped") {
      expect(claim.proposalMemberSnapshotDigest).toBe(sha256HexOfCanonicalJson(toJsonValue(claim.proposalMembers)));
    }
    expect(claim?.claimDigest).toBe("0b037ef0db2dd8abe46488e4008b5779818cd3cc3847fe41012b17ea7ff7794d");
    const view = await harness.learning.getCandidateView({ candidateId: outcome.candidate.id });
    expect(view).toMatchObject({
      recurrenceLineage: {
        status: "resolved",
        claimDigest: claim?.claimDigest,
        groupKeyDigest: claim?.status === "grouped" ? claim.groupKeyDigest : undefined,
        distinctEpisodeCountAtProposal: 1,
        currentExecutionCount: 1,
        currentDistinctEpisodeCount: 1,
      },
    });
    expect(await countKind(harness.store, "candidate-recurrence-claim")).toBe(1);
    expect(await countKind(harness.store, "detector-recurrence-group-candidate")).toBe(1);
  });

  it("keeps the proposal member baseline frozen while later group growth remains resolved", async () => {
    const { harness, facts, proposer } = await groupedFixture();
    const outcome = await harness.learning.propose(
      derivedInput(proposer, facts.derivation, { id: "frozen-member-baseline" }),
    );
    const before = await loadCandidateRecurrenceClaim(harness.context, outcome.candidate.id);
    if (before?.status !== "grouped") throw new Error("expected frozen grouped claim");
    expect(before.proposalMembers).toHaveLength(1);
    await persistSyntheticGroupGrowth(harness, facts, "later-baseline");
    expect(await loadCandidateRecurrenceClaim(harness.context, outcome.candidate.id)).toEqual(before);
    expect(await harness.learning.getCandidateView({ candidateId: outcome.candidate.id })).toMatchObject({
      recurrenceLineage: {
        status: "resolved",
        claimDigest: before.claimDigest,
        distinctEpisodeCountAtProposal: before.distinctEpisodeCount,
        currentExecutionCount: 2,
      },
    });
  });

  it("records current manual and derivation-unbound decisions without migrating historical Candidates", async () => {
    const manualHarness = await createSemanticEngineHarness();
    const manualProposer = await manualHarness.context.identity.verify({
      principalId: "manual-claim-proposer",
      kind: "agent",
      independenceDomain: "manual-claim-domain",
    });
    const manual = await manualHarness.learning.propose(
      manualInput(manualProposer, manualHarness.scope, `${manualHarness.source.id}/semantic-observation`),
    );
    expect(await loadCandidateRecurrenceClaim(manualHarness.context, manual.candidate.id)).toMatchObject({
      status: "not_bound",
      reason: "manual",
    });
    expect(await manualHarness.learning.getCandidateView({ candidateId: manual.candidate.id })).toMatchObject({
      recurrenceLineage: { status: "not_bound", reason: "manual" },
    });

    const unboundHarness = await createSemanticEngineHarness();
    const facts = createSemanticFacts(unboundHarness);
    await persistDetectorExecution(unboundHarness.context, facts.execution, [facts.derivation]);
    const proposer = await unboundHarness.context.identity.verify({
      principalId: "unbound-claim-proposer",
      kind: "agent",
      independenceDomain: "unbound-claim-domain",
    });
    const unbound = await unboundHarness.learning.propose(
      derivedInput(proposer, facts.derivation, { id: "derivation-unbound-candidate" }),
    );
    expect(await loadCandidateRecurrenceClaim(unboundHarness.context, unbound.candidate.id)).toMatchObject({
      status: "not_bound",
      reason: "derivation_unbound",
    });
    expect(await unboundHarness.learning.getCandidateView({ candidateId: unbound.candidate.id })).toMatchObject({
      recurrenceLineage: { status: "not_bound", reason: "derivation_unbound" },
    });

    const anchoredMissingContext = replaceContextStore(
      manualHarness.context,
      hidingStore(manualHarness.store, "candidate-recurrence-claim", manual.candidate.id),
    );
    expect(await loadCandidateRecurrenceLineage(anchoredMissingContext, manual.candidate)).toMatchObject({
      status: "invalid",
    });
    const historicalContext = replaceContextStore(
      manualHarness.context,
      historicalClaimStore(manualHarness.store, manual.candidate),
    );
    expect(await loadCandidateRecurrenceLineage(historicalContext, manual.candidate)).toEqual({
      status: "not_bound",
      reason: "historical_unbound",
    });
    const historicalDerivedContext = replaceContextStore(
      unboundHarness.context,
      historicalClaimStore(unboundHarness.store, unbound.candidate),
    );
    expect(await loadCandidateRecurrenceLineage(historicalDerivedContext, unbound.candidate)).toEqual({
      status: "not_bound",
      reason: "historical_unbound",
    });
    expect(await countKind(manualHarness.store, "candidate-recurrence-claim")).toBe(1);
  });

  it("never poisons a terminal pre-0016 Candidate with a new recurrence decision", async () => {
    const label = "legacy-terminal";
    const candidateId = "legacy-terminal-candidate";
    const template = await createSemanticEngineHarness({ label });
    const templateProposer = await template.context.identity.verify({
      principalId: "legacy-terminal-proposer",
      kind: "agent",
      independenceDomain: "legacy-terminal-domain",
    });
    const templateOutcome = await template.learning.propose(
      manualInput(templateProposer, template.scope, `${template.source.id}/${label}-observation`, candidateId),
    );

    const harness = await createSemanticEngineHarness({ label });
    const proposer = await harness.context.identity.verify({
      principalId: "legacy-terminal-proposer",
      kind: "agent",
      independenceDomain: "legacy-terminal-domain",
    });
    const candidateValue = toJsonValue(templateOutcome.candidate);
    await harness.store.create(
      { namespace: "learning", kind: "candidate", id: candidateId },
      candidateValue,
      sha256HexOfCanonicalJson(candidateValue),
      "seed/legacy-terminal-candidate",
    );
    const legacyIndexValue = toJsonValue({
      candidateId,
      contentDigest: templateOutcome.candidate.contentDigest,
    });
    await harness.store.create(
      {
        namespace: "learning",
        kind: "candidate-by-digest",
        id: templateOutcome.candidate.contentDigest,
      },
      legacyIndexValue,
      sha256HexOfCanonicalJson(legacyIndexValue),
      "seed/legacy-terminal-index",
    );

    const exactInput = manualInput(proposer, harness.scope, `${harness.source.id}/${label}-observation`, candidateId);
    const existing = await harness.learning.propose(exactInput);
    expect(existing.candidate).toEqual(templateOutcome.candidate);
    expect(existing.governance.reasons).toContainEqual(
      expect.objectContaining({ code: "candidate.duplicate_content" }),
    );
    expect(await countKind(harness.store, "candidate-recurrence-claim")).toBe(0);
    expect(await countKind(harness.store, "detector-recurrence-group-candidate")).toBe(0);
    expect(await countKind(harness.store, "candidate-by-digest")).toBe(1);
    expect(await harness.learning.getCandidateView({ candidateId })).toMatchObject({
      recurrenceLineage: { status: "not_bound", reason: "historical_unbound" },
    });

    await expect(
      harness.learning.propose({ ...exactInput, problem: "Different content must not acquire a recurrence decision." }),
    ).rejects.toMatchObject({ code: "store.conflict" });
    expect(await countKind(harness.store, "candidate-recurrence-claim")).toBe(0);
    expect(await countKind(harness.store, "detector-recurrence-group-candidate")).toBe(0);
    expect(await countKind(harness.store, "candidate-by-digest")).toBe(1);
  });

  it("writes claim and group member before Candidate receipt and forward-completes exact retry", async () => {
    const base = createInMemoryStore();
    const writes: string[] = [];
    const store = recordingStore(failBeforeCandidateReceipt(base), writes);
    const { harness, facts, proposer } = await groupedFixture(store);
    writes.length = 0;
    const input = derivedInput(proposer, facts.derivation, { id: "candidate-claim-crash" });
    await expect(harness.learning.propose(input)).rejects.toThrowError("failed before Candidate receipt");
    expect(await countKind(base, "candidate-recurrence-claim")).toBe(1);
    expect(await countKind(base, "detector-recurrence-group-candidate")).toBe(1);
    expect(await countKind(base, "candidate")).toBe(0);
    expect(writes.indexOf("candidate-recurrence-claim")).toBeLessThan(writes.indexOf("candidate"));
    expect(writes.indexOf("detector-recurrence-group-candidate")).toBeLessThan(writes.indexOf("candidate"));

    const originalClaim = await loadCandidateRecurrenceClaim(harness.context, "candidate-claim-crash");
    if (originalClaim?.status !== "grouped") throw new Error("expected anchored in-progress claim");
    await persistSyntheticGroupGrowth(harness, facts, "crash-retry");

    const retried = await harness.learning.propose(input);
    expect(retried.candidate.id).toBe("candidate-claim-crash");
    expect(await countKind(base, "candidate-recurrence-claim")).toBe(1);
    expect(await countKind(base, "detector-recurrence-group-candidate")).toBe(1);
    expect(await countKind(base, "candidate")).toBe(1);
    expect(await loadCandidateRecurrenceClaim(harness.context, retried.candidate.id)).toEqual(originalClaim);
    expect(await harness.learning.getCandidateView({ candidateId: retried.candidate.id })).toMatchObject({
      recurrenceLineage: {
        status: "resolved",
        claimDigest: originalClaim.claimDigest,
        distinctEpisodeCountAtProposal: originalClaim.distinctEpisodeCount,
        currentExecutionCount: 2,
      },
    });
  });

  it("replays the exact index-anchored Candidate after group growth, clock advance, and a foreign proposer attempt", async () => {
    const base = createInMemoryStore();
    const store = failAfterCandidateIndex(base);
    const { harness, facts, proposer } = await groupedFixture(store);
    let now = "2026-08-20T01:00:00.000Z";
    const learning = proposalLoop(harness, store, () => now);
    const input = derivedInput(proposer, facts.derivation, { id: "index-only-anchor" });
    await expect(learning.propose(input)).rejects.toThrowError("failed after Candidate content lock");
    expect(await countKind(base, "candidate-by-digest")).toBe(1);
    expect(await countKind(base, "candidate-recurrence-claim")).toBe(1);
    expect(await countKind(base, "detector-recurrence-group-candidate")).toBe(0);
    expect(await countKind(base, "candidate")).toBe(0);
    const indexRecord = (await base.list({ namespace: "learning", kind: "candidate-by-digest", limit: 10 })).records[0];
    expect(indexRecord?.value).toMatchObject({
      candidateId: "index-only-anchor",
      recurrenceClaimDigest: expect.any(String),
      recurrenceClaim: { status: "grouped", proposalMembers: [{}] },
      candidate: {
        id: "index-only-anchor",
        proposedBy: proposer.ref,
        proposedAt: "2026-08-20T01:00:00.000Z",
      },
    });

    await persistSyntheticGroupGrowth(harness, facts, "index-only-anchor");
    now = "2026-08-20T02:00:00.000Z";
    const otherProposer = await harness.context.identity.verify({
      principalId: "foreign-anchor-proposer",
      kind: "agent",
      independenceDomain: "foreign-anchor-domain",
    });
    await expect(
      learning.propose(derivedInput(otherProposer, facts.derivation, { id: "index-only-anchor" })),
    ).rejects.toMatchObject({ code: "store.conflict" });

    const retried = await learning.propose(input);
    expect(retried.candidate).toMatchObject({
      id: "index-only-anchor",
      proposedBy: proposer.ref,
      proposedAt: "2026-08-20T01:00:00.000Z",
    });
    const claim = await loadCandidateRecurrenceClaim(harness.context, retried.candidate.id);
    expect(claim).toMatchObject({
      claimDigest: expect.any(String),
      proposalMembers: [{}],
    });
    expect(claim?.claimDigest).toBe(
      typeof indexRecord?.value === "object" &&
        indexRecord.value !== null &&
        "recurrenceClaimDigest" in indexRecord.value
        ? indexRecord.value.recurrenceClaimDigest
        : undefined,
    );
    expect(await countKind(base, "candidate")).toBe(1);
    expect(await countKind(base, "candidate-recurrence-claim")).toBe(1);
  });

  it("locks grouped Candidate attribution at the earliest recurrence-decision crash", async () => {
    const base = createInMemoryStore();
    const store = failAfterCandidateDecision(base);
    const { harness, facts, proposer } = await groupedFixture(store);
    let now = "2026-08-20T03:00:00.000Z";
    const learning = proposalLoop(harness, store, () => now);
    const input = derivedInput(proposer, facts.derivation, { id: "decision-anchor-grouped" });
    await expect(learning.propose(input)).rejects.toThrowError("failed after Candidate recurrence decision");
    expect(await countKind(base, "candidate-recurrence-claim")).toBe(1);
    expect(await countKind(base, "candidate-by-digest")).toBe(0);
    expect(await countKind(base, "candidate")).toBe(0);
    now = "2026-08-20T04:00:00.000Z";
    const otherProposer = await harness.context.identity.verify({
      principalId: "decision-anchor-foreign",
      kind: "agent",
      independenceDomain: "decision-anchor-foreign-domain",
    });
    await expect(
      learning.propose(derivedInput(otherProposer, facts.derivation, { id: "decision-anchor-grouped" })),
    ).rejects.toMatchObject({ code: "store.conflict" });
    const retried = await learning.propose(input);
    expect(retried.candidate).toMatchObject({
      id: "decision-anchor-grouped",
      proposedBy: proposer.ref,
      proposedAt: "2026-08-20T03:00:00.000Z",
    });
  });

  it("locks manual and derivation-unbound Candidate bytes before their content index", async () => {
    const branches: readonly ("manual" | "derivation_unbound")[] = ["manual", "derivation_unbound"];
    for (const branch of branches) {
      const base = createInMemoryStore();
      const store = failAfterCandidateDecision(base);
      const harness = await createSemanticEngineHarness({ store });
      const facts = createSemanticFacts(harness);
      if (branch === "derivation_unbound") {
        await persistDetectorExecution(harness.context, facts.execution, [facts.derivation]);
      }
      const proposer = await harness.context.identity.verify({
        principalId: `${branch}-decision-proposer`,
        kind: "agent",
        independenceDomain: `${branch}-decision-domain`,
      });
      let now = "2026-08-20T05:00:00.000Z";
      const learning = proposalLoop(harness, store, () => now);
      const input =
        branch === "manual"
          ? manualInput(proposer, harness.scope, `${harness.source.id}/semantic-observation`, `${branch}-decision`)
          : derivedInput(proposer, facts.derivation, { id: `${branch}-decision` });
      await expect(learning.propose(input)).rejects.toThrowError("failed after Candidate recurrence decision");
      expect(await countKind(base, "candidate-recurrence-claim")).toBe(1);
      expect(await countKind(base, "candidate-by-digest")).toBe(0);
      now = "2026-08-20T06:00:00.000Z";
      const otherProposer = await harness.context.identity.verify({
        principalId: `${branch}-foreign-proposer`,
        kind: "agent",
        independenceDomain: `${branch}-foreign-domain`,
      });
      const foreignInput =
        branch === "manual"
          ? manualInput(otherProposer, harness.scope, `${harness.source.id}/semantic-observation`, `${branch}-decision`)
          : derivedInput(otherProposer, facts.derivation, { id: `${branch}-decision` });
      await expect(learning.propose(foreignInput)).rejects.toMatchObject({ code: "store.conflict" });
      if (branch === "manual") {
        const changed: CandidateInput = {
          id: `${branch}-decision`,
          scope: harness.scope,
          problem: "Changed manual problem.",
          hypothesis: "A manual hypothesis.",
          evidenceIds: [`${harness.source.id}/semantic-observation`],
          intervention: {
            destinationId: "host/manual-report",
            kind: "report-note",
            content: { note: "manual" },
            rollbackIntent: "Remove the inert report note.",
          },
          proposedRisk: "T1",
          proposedBy: proposer,
        };
        await expect(learning.propose(changed)).rejects.toMatchObject({ code: expect.stringMatching(/^store\./) });
      }
      const retried = await learning.propose(input);
      expect(retried.candidate).toMatchObject({
        id: `${branch}-decision`,
        proposedBy: proposer.ref,
        proposedAt: "2026-08-20T05:00:00.000Z",
      });
    }
  });

  for (const target of CLAIM_ACK_TARGETS) {
    it(`reloads exact ${target} bytes after a lost acknowledgement before Candidate receipt`, async () => {
      const base = createInMemoryStore();
      const store = loseClaimAcknowledgement(base, target);
      const { harness, facts, proposer } = await groupedFixture(store);
      const input = derivedInput(proposer, facts.derivation, { id: `lost-ack-${target}` });
      await expect(harness.learning.propose(input)).rejects.toThrowError(
        target === "candidate-recurrence-claim"
          ? "lost Candidate claim acknowledgement"
          : "lost Candidate group acknowledgement",
      );
      expect(await countKind(base, "candidate")).toBe(0);
      const retried = await harness.learning.propose(input);
      expect(retried.candidate.id).toBe(`lost-ack-${target}`);
      expect(await countKind(base, "candidate-recurrence-claim")).toBe(1);
      expect(await countKind(base, "detector-recurrence-group-candidate")).toBe(1);
      expect(await countKind(base, "candidate")).toBe(1);
    });
  }

  it("allows concurrent fresh claims for one group without enforcing deduplication", async () => {
    const { harness, facts, proposer } = await groupedFixture();
    const [left, right] = await Promise.all([
      harness.learning.propose(
        derivedInput(proposer, facts.derivation, { id: "concurrent-group-candidate-a", proposedRisk: "T1" }),
      ),
      harness.learning.propose(
        derivedInput(proposer, facts.derivation, { id: "concurrent-group-candidate-b", proposedRisk: "T2" }),
      ),
    ]);
    expect(left.candidate.id).not.toBe(right.candidate.id);
    expect(await countKind(harness.store, "candidate")).toBe(2);
    expect(await countKind(harness.store, "candidate-recurrence-claim")).toBe(2);
    const groupRecords = await harness.store.list({
      namespace: "learning",
      kind: "detector-recurrence-group-candidate",
      limit: 10,
    });
    expect(groupRecords.records).toHaveLength(1);
    expect(groupRecords.records[0]?.value).toHaveLength(2);
    expect(await harness.learning.getCandidateView({ candidateId: left.candidate.id })).toMatchObject({
      recurrenceLineage: { status: "resolved" },
    });
    expect(await harness.learning.getCandidateView({ candidateId: right.candidate.id })).toMatchObject({
      recurrenceLineage: { status: "resolved" },
    });
  });

  it("does not let a same-content contender steal an anchored in-progress Candidate owner", async () => {
    const base = createInMemoryStore();
    const paused = pausingCandidateIndexStore(base);
    const { harness, facts, proposer } = await groupedFixture(paused.store);
    const leftInput = derivedInput(proposer, facts.derivation, { id: "anchored-owner-a", proposedRisk: "T1" });
    const rightInput = derivedInput(proposer, facts.derivation, { id: "anchored-owner-b", proposedRisk: "T1" });
    const leftPromise = harness.learning.propose(leftInput);
    await paused.indexed;
    const [right] = await Promise.allSettled([harness.learning.propose(rightInput)]);
    paused.release();
    const left = await leftPromise;
    expect(right).toMatchObject({ status: "rejected", reason: { code: "store.conflict" } });
    expect(left.candidate.id).toBe("anchored-owner-a");
    expect(await countKind(base, "candidate")).toBe(1);
    expect(await countKind(base, "candidate-recurrence-claim")).toBe(2);
    expect(await countKind(base, "candidate-by-digest")).toBe(1);
    const groupStreams = await base.list({
      namespace: "learning",
      kind: "detector-recurrence-group-candidate",
      limit: 10,
    });
    expect(groupStreams.records).toHaveLength(1);
    expect(groupStreams.records[0]?.value).toHaveLength(1);
    const index = await base.get({
      namespace: "learning",
      kind: "candidate-by-digest",
      id: left.candidate.contentDigest,
    });
    const claim = await loadCandidateRecurrenceClaim(harness.context, left.candidate.id);
    expect(index?.value).toMatchObject({
      candidateId: left.candidate.id,
      contentDigest: left.candidate.contentDigest,
      recurrenceClaimDigest: claim?.claimDigest,
    });
    expect(await loadCandidateRecurrenceClaim(harness.context, "anchored-owner-b")).toMatchObject({
      candidateId: "anchored-owner-b",
    });
    await expect(harness.learning.getCandidateView({ candidateId: "anchored-owner-b" })).resolves.toBeUndefined();
  });

  it("binds exact same-group predecessor claims without enforcing an override", async () => {
    const { harness, facts, proposer } = await groupedFixture();
    const predecessor = await harness.learning.propose(
      derivedInput(proposer, facts.derivation, { id: "claim-predecessor", proposedRisk: "T1" }),
    );
    if (predecessor.candidate.schemaVersion !== 2 || predecessor.candidate.derivationRef === undefined) {
      throw new Error("expected derivation-backed v2 predecessor");
    }
    const schemaVersion: 2 = 2;
    const proposedRisk: "T2" = "T2";
    const digestInput = {
      schemaVersion,
      scope: predecessor.candidate.scope,
      problem: predecessor.candidate.problem,
      hypothesis: predecessor.candidate.hypothesis,
      evidenceRefs: predecessor.candidate.evidenceRefs,
      intervention: predecessor.candidate.intervention,
      proposedRisk,
      derivationRef: predecessor.candidate.derivationRef,
      supersedes: predecessor.candidate.id,
      originalDigest: predecessor.candidate.contentDigest,
    };
    const contentDigest = candidateContentDigest(digestInput);
    const successor: Candidate = parseCandidate({
      ...predecessor.candidate,
      id: "claim-successor",
      proposedRisk: "T2",
      supersedes: predecessor.candidate.id,
      originalDigest: predecessor.candidate.contentDigest,
      contentDigest,
    });
    const claim = await prepareCandidateRecurrenceClaim(harness.context, successor);
    const predecessorClaim = await loadCandidateRecurrenceClaim(harness.context, predecessor.candidate.id);
    if (predecessorClaim?.status !== "grouped") throw new Error("expected grouped predecessor claim");
    expect(claim).toMatchObject({
      status: "grouped",
      scopeDigest: predecessorClaim.scopeDigest,
      groupKeyDigest: predecessorClaim.groupKeyDigest,
      derivationClaimDigests: predecessorClaim.derivationClaimDigests,
      supersedes: {
        candidateId: predecessor.candidate.id,
        candidateDigest: predecessor.candidate.contentDigest,
        claimDigest: predecessorClaim?.claimDigest,
      },
    });
  });

  it("marks missing group membership invalid without treating observational lineage as a governance veto", async () => {
    const { harness, facts, proposer } = await groupedFixture();
    const outcome = await harness.learning.propose(
      derivedInput(proposer, facts.derivation, { id: "invalid-group-candidate" }),
    );
    const claim = await loadCandidateRecurrenceClaim(harness.context, outcome.candidate.id);
    if (claim?.status !== "grouped") throw new Error("expected grouped invalid fixture");
    const invalidContext = replaceContextStore(
      harness.context,
      hidingStore(harness.store, "detector-recurrence-group-candidate", claim.groupKeyDigest),
    );
    const view = await runGetCandidateView(invalidContext, { candidateId: outcome.candidate.id });
    expect(view).toMatchObject({
      recurrenceLineage: { status: "invalid", claim: { claimDigest: claim.claimDigest } },
      governance: { review: "required", publication: "blocked" },
    });
  });

  it("treats proposal-baseline or derivation-claim replacement as exact marker corruption", async () => {
    const { harness, facts, proposer } = await groupedFixture();
    const outcome = await harness.learning.propose(
      derivedInput(proposer, facts.derivation, { id: "tampered-baseline-candidate" }),
    );
    const claim = await loadCandidateRecurrenceClaim(harness.context, outcome.candidate.id);
    if (claim?.status !== "grouped") throw new Error("expected grouped tamper claim");
    await persistSyntheticGroupGrowth(harness, facts, "tamper-baseline");
    const witnessExecution = await loadDetectorExecutionRecord(
      harness.context,
      claim.proposalMembers[0]?.executionId ?? "missing",
    );
    if (witnessExecution === undefined) throw new Error("expected proposal witness execution");
    const current = await recurrenceReceiptLineage(harness.context, witnessExecution);
    const laterMember = current.members.find(
      (member) => !claim.proposalMembers.some((proposalMember) => proposalMember.executionId === member.executionId),
    );
    if (laterMember === undefined) throw new Error("expected later recurrence member");
    const stored = await harness.store.get({
      namespace: "learning",
      kind: "candidate-recurrence-claim",
      id: outcome.candidate.id,
    });
    const groupStored = await harness.store.get({
      namespace: "learning",
      kind: "detector-recurrence-group-candidate",
      id: claim.groupKeyDigest,
    });
    if (stored === undefined || groupStored === undefined) throw new Error("expected Candidate recurrence claim bytes");
    const variants = [
      {
        ...claim,
        episodeIdentityDigestsAtProposal: ["f".repeat(64)],
        episodeIdentitySetDigest: sha256HexOfCanonicalJson(toJsonValue(["f".repeat(64)])),
        distinctEpisodeCount: 1,
      },
      { ...claim, derivationClaimDigests: ["e".repeat(64)] },
      {
        ...claim,
        proposalMembers: [laterMember],
        proposalMemberSnapshotDigest: sha256HexOfCanonicalJson(toJsonValue([laterMember])),
      },
      {
        ...claim,
        proposalMembers: current.members,
        proposalMemberSnapshotDigest: sha256HexOfCanonicalJson(toJsonValue(current.members)),
      },
      {
        ...claim,
        proposalMembers: [{ ...claim.proposalMembers[0], memberDigest: "d".repeat(64) }],
        proposalMemberSnapshotDigest: sha256HexOfCanonicalJson(
          toJsonValue([{ ...claim.proposalMembers[0], memberDigest: "d".repeat(64) }]),
        ),
      },
    ];
    for (const variant of variants) {
      const { schemaVersion: _schemaVersion, claimDigest: _claimDigest, ...base } = variant;
      const changed = { schemaVersion: 1, ...base, claimDigest: sha256HexOfCanonicalJson(toJsonValue(base)) };
      const value = toJsonValue(changed);
      const groupMemberValue = toJsonValue({ candidateId: changed.candidateId, claimDigest: changed.claimDigest });
      const groupEntry = {
        id: `candidate:${changed.candidateId}:${changed.claimDigest}`,
        digest: sha256HexOfCanonicalJson(groupMemberValue),
        value: groupMemberValue,
      };
      const changedStore: LearningStore = {
        get: (key) => {
          if (key.kind === "candidate-recurrence-claim" && key.id === outcome.candidate.id) {
            return Promise.resolve({ ...stored, value, digest: sha256HexOfCanonicalJson(value) });
          }
          if (key.kind === "detector-recurrence-group-candidate" && key.id === claim.groupKeyDigest) {
            return Promise.resolve({
              ...groupStored,
              value: [groupEntry],
              digest: sha256HexOfCanonicalJson(toJsonValue([groupEntry.id])),
            });
          }
          return harness.store.get(key);
        },
        create: (key, exactValue, digest, operationId) => harness.store.create(key, exactValue, digest, operationId),
        compareAndSet: (key, expectedRevision, exactValue, digest, operationId) =>
          harness.store.compareAndSet(key, expectedRevision, exactValue, digest, operationId),
        append: (stream, expectedRevision, entries, operationId) =>
          harness.store.append(stream, expectedRevision, entries, operationId),
        tombstone: (input) => harness.store.tombstone(input),
        list: (query) => harness.store.list(query),
      };
      await expect(
        runGetCandidateView(replaceContextStore(harness.context, changedStore), {
          candidateId: outcome.candidate.id,
        }),
      ).rejects.toMatchObject({ code: "store.corrupt" });
    }
  });

  it("treats self-consistent terminal Candidate attribution tamper as store corruption", async () => {
    const { harness, facts, proposer } = await groupedFixture();
    const outcome = await harness.learning.propose(
      derivedInput(proposer, facts.derivation, { id: "tampered-attribution-candidate" }),
    );
    const stored = await harness.store.get({
      namespace: "learning",
      kind: "candidate",
      id: outcome.candidate.id,
    });
    if (stored === undefined) throw new Error("expected terminal Candidate bytes");
    const variants: Candidate[] = [
      {
        ...outcome.candidate,
        proposedBy: { ...outcome.candidate.proposedBy, id: "foreign-proposer" },
      },
      { ...outcome.candidate, proposerAttestationDigest: "f".repeat(64) },
      { ...outcome.candidate, proposedAt: "2026-08-20T09:00:00.000Z" },
    ];
    for (const candidate of variants) {
      const value = toJsonValue(candidate);
      const changedStore: LearningStore = {
        get: (key) =>
          key.kind === "candidate" && key.id === candidate.id
            ? Promise.resolve({ ...stored, value, digest: sha256HexOfCanonicalJson(value) })
            : harness.store.get(key),
        create: (key, exactValue, digest, operationId) => harness.store.create(key, exactValue, digest, operationId),
        compareAndSet: (key, expectedRevision, exactValue, digest, operationId) =>
          harness.store.compareAndSet(key, expectedRevision, exactValue, digest, operationId),
        append: (stream, expectedRevision, entries, operationId) =>
          harness.store.append(stream, expectedRevision, entries, operationId),
        tombstone: (input) => harness.store.tombstone(input),
        list: (query) => harness.store.list(query),
      };
      await expect(
        runGetCandidateView(replaceContextStore(harness.context, changedStore), { candidateId: candidate.id }),
      ).rejects.toMatchObject({ code: "store.corrupt" });
    }
  });
});
