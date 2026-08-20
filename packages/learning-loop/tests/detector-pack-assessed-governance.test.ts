// #30c2b2 assessed recurrence governance: bounded exact-group Candidate and
// review folds remain observational while producing retry-stable pack facts.
import { describe, expect, it } from "vitest";
import type {
  CandidateReview,
  DetectorExecutionRecord,
  DetectorOrchestrationPolicy,
  DetectorPackRunInput,
  DetectorPackRunReceipt,
  InsightDerivation,
  LearningLoop,
  LearningStore,
  ReviewDisposition,
} from "../src/index.js";
import {
  createLearningLoop,
  detectorExecutionDigest,
  insightDerivationDigest,
  parseDetectorExecutionRecord,
  parseCandidateReview,
  parseInsightDerivation,
  scopeDigest,
  sha256HexOfCanonicalJson,
  toJsonValue,
} from "../src/index.js";
import type { EngineContext } from "../src/engine/context.js";
import { loadIndexedCandidateReviews } from "../src/engine/candidate-review-index.js";
import { recurrenceReceiptLineage } from "../src/engine/detector-recurrence.js";
import { runDetectorPackRunQuery } from "../src/engine/detector-pack-query.js";
import { runPropose } from "../src/engine/propose.js";
import { assessRecurrenceGroupGovernance } from "../src/engine/recurrence-governance.js";
import { persistDetectorExecution } from "../src/engine/semantic-persistence.js";
import { createInMemoryStore } from "../src/testing/index.js";
import type { RecurrenceRunnerHarness } from "./detector-recurrence-harness.js";
import {
  PRIVATE_LOCATOR,
  createDetectorOrchestrationPolicy,
  createRecurrenceRunnerHarness,
  detectorRef,
  detectedInsightDraft,
  packRef,
} from "./detector-recurrence-harness.js";
import { SEMANTIC_SCOPE_B } from "./semantic-engine-harness.js";

type GroupedGovernanceInput = Parameters<typeof assessRecurrenceGroupGovernance>[1];

interface AssessmentFixture {
  readonly harness: RecurrenceRunnerHarness;
  readonly input: DetectorPackRunInput;
  readonly groupKeyDigest: string;
  readonly currentDistinctEpisodeCount: number;
  readonly derivationId: string;
  readonly derivation: InsightDerivation;
  readonly execution: DetectorExecutionRecord;
  readonly initialReceipt: DetectorPackRunReceipt;
  readonly groupLineage: Awaited<ReturnType<typeof recurrenceReceiptLineage>>;
  readonly proposer: Awaited<ReturnType<RecurrenceRunnerHarness["context"]["identity"]["verify"]>>;
}

function forwardingStore(base: LearningStore, overrides: Partial<LearningStore>): LearningStore {
  return {
    get: overrides.get ?? ((key) => base.get(key)),
    create: overrides.create ?? ((key, value, digest, operationId) => base.create(key, value, digest, operationId)),
    compareAndSet:
      overrides.compareAndSet ??
      ((key, expectedRevision, value, digest, operationId) =>
        base.compareAndSet(key, expectedRevision, value, digest, operationId)),
    append:
      overrides.append ??
      ((stream, expectedRevision, entries, operationId) => base.append(stream, expectedRevision, entries, operationId)),
    tombstone: overrides.tombstone ?? ((input) => base.tombstone(input)),
    list: overrides.list ?? ((query) => base.list(query)),
  };
}

function recordingStore(base: LearningStore, writes: string[]): LearningStore {
  return forwardingStore(base, {
    create: (key, value, digest, operationId) => {
      writes.push(key.kind);
      return base.create(key, value, digest, operationId);
    },
    append: (stream, expectedRevision, entries, operationId) => {
      writes.push(stream.kind);
      return base.append(stream, expectedRevision, entries, operationId);
    },
  });
}

function reviewReceiptFailureStore(base: LearningStore) {
  let enabled = false;
  const store = forwardingStore(base, {
    create: (key, value, digest, operationId) => {
      if (enabled && key.kind === "review") throw new Error("failed before Review receipt");
      return base.create(key, value, digest, operationId);
    },
  });
  return {
    store,
    enable: () => {
      enabled = true;
    },
  };
}

function lostAcknowledgementStore(base: LearningStore, target: "candidate-review" | "review"): LearningStore {
  let failed = false;
  return forwardingStore(base, {
    create: async (key, value, digest, operationId) => {
      const result = await base.create(key, value, digest, operationId);
      if (!failed && target === "review" && key.kind === "review") {
        failed = true;
        throw new Error("lost Review receipt acknowledgement");
      }
      return result;
    },
    append: async (stream, expectedRevision, entries, operationId) => {
      const result = await base.append(stream, expectedRevision, entries, operationId);
      if (!failed && target === "candidate-review" && stream.kind === "candidate-review") {
        failed = true;
        throw new Error("lost Candidate review marker acknowledgement");
      }
      return result;
    },
  });
}

function unpreservedReviewSuccessStore(base: LearningStore) {
  let enabled = false;
  const store = forwardingStore(base, {
    create: (key, value, digest, operationId) => {
      if (enabled && key.kind === "review") {
        return Promise.resolve({ status: "created", revision: "unpreserved-review-revision" });
      }
      return base.create(key, value, digest, operationId);
    },
  });
  return {
    store,
    enable: () => {
      enabled = true;
    },
  };
}

function replaceContextStore(context: EngineContext, store: LearningStore): EngineContext {
  return { ...context, store };
}

function changedReviewStreamStore(
  base: LearningStore,
  candidateId: string,
  change: (current: readonly unknown[]) => unknown,
): LearningStore {
  return forwardingStore(base, {
    get: async (key) => {
      const stored = await base.get(key);
      if (stored === undefined || key.kind !== "candidate-review" || key.id !== candidateId) return stored;
      if (!Array.isArray(stored.value)) throw new Error("review stream fixture expected an array");
      const value = toJsonValue(change(stored.value));
      if (!Array.isArray(value)) throw new Error("changed review stream fixture must remain an array");
      const ids = value.map((entry) => {
        if (typeof entry !== "object" || entry === null || Array.isArray(entry) || !("id" in entry)) {
          throw new Error("changed review stream fixture entry has no id");
        }
        const id: unknown = entry.id;
        if (typeof id !== "string") throw new Error("changed review stream fixture id is not text");
        return id;
      });
      return { ...stored, value, digest: sha256HexOfCanonicalJson(ids) };
    },
  });
}

function hidingRecordStore(base: LearningStore, kind: string, id: string): LearningStore {
  return forwardingStore(base, {
    get: (key) => (key.kind === kind && key.id === id ? Promise.resolve(undefined) : base.get(key)),
  });
}

function reviewIndexEntry(candidateId: string, candidateDigest: string, exactScopeDigest: string, index: number) {
  const recordDigest = index.toString(16).padStart(64, "0");
  const value = toJsonValue({
    kind: "review",
    reviewId: `bounded-review-${String(index).padStart(5, "0")}`,
    recordDigest,
    candidateId,
    candidateDigest,
    scopeDigest: exactScopeDigest,
  });
  return toJsonValue({
    id: `review:bounded-review-${String(index).padStart(5, "0")}`,
    digest: sha256HexOfCanonicalJson(value),
    value,
  });
}

async function countKind(store: LearningStore, kind: string): Promise<number> {
  return (await store.list({ namespace: "learning", kind, limit: 10_000 })).records.length;
}

async function fixture(input: {
  readonly label: string;
  readonly policy?: DetectorOrchestrationPolicy;
  readonly store?: LearningStore;
  readonly episodeCount?: number;
  readonly initialEpisodeCount?: number;
  readonly scope?: RecurrenceRunnerHarness["scope"];
}): Promise<AssessmentFixture> {
  const policy = input.policy ?? createDetectorOrchestrationPolicy();
  const harness = await createRecurrenceRunnerHarness({
    label: input.label,
    ...(input.store === undefined ? {} : { store: input.store }),
    ...(input.episodeCount === undefined ? {} : { episodeCount: input.episodeCount }),
    ...(input.scope === undefined ? {} : { scope: input.scope }),
    detectorOrchestrationPolicy: policy,
    evaluate: (window) => detectedInsightDraft(window, PRIVATE_LOCATOR),
  });
  const runInput: DetectorPackRunInput = {
    mode: "commit",
    pack: packRef(harness.pack),
    scope: harness.scope,
    episodeRecordIds:
      input.initialEpisodeCount === undefined
        ? harness.episodeRecordIds
        : harness.episodeRecordIds.slice(0, input.initialEpisodeCount),
  };
  const run = await harness.learning.runDetectorPack(runInput);
  const result = run.items[0]?.result;
  const execution = result?.execution;
  const recurrence = result?.recurrence;
  const derivation = result?.derivations[0];
  if (
    recurrence?.status !== "grouped" ||
    derivation === undefined ||
    execution === undefined ||
    run.receipt === undefined
  ) {
    throw new Error("assessment fixture did not create one grouped derivation");
  }
  const groupLineage = await recurrenceReceiptLineage(harness.context, execution);
  const proposer = await harness.context.identity.verify({
    principalId: `${input.label}-proposer`,
    kind: "agent",
    independenceDomain: `${input.label}-proposer-domain`,
  });
  return {
    harness,
    input: runInput,
    groupKeyDigest: recurrence.groupKeyDigest,
    currentDistinctEpisodeCount: recurrence.distinctEpisodeCount,
    derivationId: derivation.id,
    derivation,
    execution,
    initialReceipt: run.receipt,
    groupLineage,
    proposer,
  };
}

function supersedingDerivation(current: InsightDerivation, predecessor: InsightDerivation): InsightDerivation {
  const { schemaVersion: _schemaVersion, id: _id, derivationDigest: _derivationDigest, ...base } = current;
  const changed = {
    ...base,
    directObservation: {
      ...base.directObservation,
      data: { successor: predecessor.derivationDigest },
    },
    supersedes: {
      id: predecessor.id,
      derivationDigest: predecessor.derivationDigest,
      scopeDigest: predecessor.scopeDigest,
    },
  };
  const derivationDigest = insightDerivationDigest(changed);
  return parseInsightDerivation({
    schemaVersion: 1,
    id: `insight-${derivationDigest}`,
    ...changed,
    derivationDigest,
  });
}

function executionForDerivation(execution: DetectorExecutionRecord, derivation: InsightDerivation) {
  const result = {
    status: "applied" as const,
    conditionDetected: true,
    derivationRefs: [
      { id: derivation.id, derivationDigest: derivation.derivationDigest, scopeDigest: derivation.scopeDigest },
    ],
    evidenceHealthFindings: [],
  };
  const executionDigest = detectorExecutionDigest({
    ...execution,
    result,
    executionKeyDigest: execution.executionKeyDigest,
  });
  return parseDetectorExecutionRecord({ ...execution, result, executionDigest });
}

async function proposeCandidate(
  facts: AssessmentFixture,
  id: string,
  input: {
    readonly supersedes?: string;
    readonly proposedRisk?: "T0" | "T1" | "T2" | "T3";
    readonly derivationId?: string;
  } = {},
) {
  return facts.harness.learning.propose({
    id,
    scope: facts.harness.scope,
    derivationId: input.derivationId ?? facts.derivationId,
    proposedRisk: input.proposedRisk ?? "T1",
    proposedBy: facts.proposer,
    ...(input.supersedes === undefined ? {} : { supersedes: input.supersedes }),
  });
}

async function proposePreAdmissionCandidate(
  facts: AssessmentFixture,
  id: string,
  input: {
    readonly supersedes?: string;
    readonly proposedRisk?: "T0" | "T1" | "T2" | "T3";
    readonly derivationId?: string;
  } = {},
) {
  const { detectorOrchestrationPolicy: _policy, ...legacyContext } = facts.harness.context;
  return runPropose(legacyContext, {
    id,
    scope: facts.harness.scope,
    derivationId: input.derivationId ?? facts.derivationId,
    proposedRisk: input.proposedRisk ?? "T1",
    proposedBy: facts.proposer,
    ...(input.supersedes === undefined ? {} : { supersedes: input.supersedes }),
  });
}

async function reviewCandidate(
  facts: AssessmentFixture,
  candidateId: string,
  disposition: ReviewDisposition,
  id: string,
  learning: LearningLoop = facts.harness.learning,
): Promise<CandidateReview> {
  const principal = await facts.harness.context.identity.verify({
    principalId: `${id}-principal`,
    kind: "agent",
    independenceDomain: `${id}-domain`,
  });
  return learning.reviewCandidate({
    id,
    candidateId,
    reviewer: {
      id: `${id}-implementation`,
      version: "1.0.0",
      principal,
      review: (request) =>
        Promise.resolve({
          candidateId: request.candidate.id,
          candidateDigest: request.candidate.contentDigest,
          disposition,
          findings: [],
        }),
    },
  });
}

function learningWithStore(harness: RecurrenceRunnerHarness, store: LearningStore): LearningLoop {
  return createLearningLoop({
    store,
    policy: harness.context.policy,
    identity: harness.context.identity,
    scopePolicy: harness.context.scopePolicy,
    contentPolicies: [...harness.context.contentPoliciesById.values()],
    sources: [...harness.context.sources],
    semanticRegistry: harness.registry,
    detectorImplementations: [...(harness.context.detectorImplementationsByRef?.values() ?? [])],
    ...(harness.context.detectorOrchestrationPolicy === undefined
      ? {}
      : { detectorOrchestrationPolicy: harness.context.detectorOrchestrationPolicy }),
    queryCursorScope: "assessed-governance-store-reader",
    clock: harness.context.clock,
    ids: harness.context.ids,
  });
}

function assessmentInput(
  facts: AssessmentFixture,
  overrides: Partial<Omit<GroupedGovernanceInput, "groupKeyDigest" | "policy">> = {},
): GroupedGovernanceInput {
  const policy = facts.harness.context.detectorOrchestrationPolicy;
  if (policy === undefined) throw new Error("assessment fixture omitted its orchestration policy");
  return {
    groupKeyDigest: facts.groupKeyDigest,
    currentDistinctEpisodeCount: facts.currentDistinctEpisodeCount,
    capped: false,
    policy,
    workBudget: { claimRefs: 0 },
    groupLineage: facts.groupLineage,
    ...overrides,
  };
}

async function rerunReceipt(facts: AssessmentFixture): Promise<DetectorPackRunReceipt> {
  const result = await facts.harness.learning.runDetectorPack(facts.input);
  if (result.receipt === undefined) throw new Error("assessed pack retry omitted its receipt");
  return result.receipt;
}

async function packPages(harness: RecurrenceRunnerHarness) {
  const pages = [];
  for await (const page of harness.learning.queryDetectorPackRuns({ scope: harness.scope, limit: 100 })) {
    pages.push(page);
  }
  return pages;
}

describe("assessed recurrence governance frontier", () => {
  it("reports an available assessed group when no Candidate claims exist", async () => {
    const facts = await fixture({ label: "assessed-no-claim" });
    expect(facts.initialReceipt.items[0]?.recurrence).toMatchObject({
      status: "grouped",
      governance: {
        status: "assessed",
        candidateBindings: [],
        groupDisposition: "available",
        reasonCodes: ["candidate.group_available"],
      },
    });
    await expect(assessRecurrenceGroupGovernance(facts.harness.context, assessmentInput(facts))).resolves.toEqual({
      status: "assessed",
      candidateBindings: [],
      groupDisposition: "available",
      requiredSupersedes: null,
      requiredOverrideCount: null,
      governingRejection: null,
      reasonCodes: ["candidate.group_available"],
    });
  });

  it.each([undefined, "accept", "escalate"] as const)(
    "deduplicates a current Candidate whose latest disposition is %s",
    async (disposition) => {
      const facts = await fixture({ label: `assessed-dedup-${disposition ?? "pending"}` });
      const proposed = await proposeCandidate(facts, `assessed-dedup-${disposition ?? "pending"}`);
      if (disposition !== undefined) {
        await reviewCandidate(facts, proposed.candidate.id, disposition, `assessed-${disposition}-review`);
      }
      const governance = await assessRecurrenceGroupGovernance(facts.harness.context, assessmentInput(facts));
      expect(governance).toMatchObject({
        status: "assessed",
        groupDisposition: "deduplicated",
        reasonCodes: ["candidate.group_deduplicated"],
        candidateBindings: [
          {
            candidateId: proposed.candidate.id,
            candidateDigest: proposed.candidate.contentDigest,
            latestReview:
              disposition === undefined
                ? null
                : { disposition, id: `assessed-${disposition}-review`, recordDigest: expect.any(String) },
          },
        ],
      });
    },
  );

  it("makes revise and disabled rejection available only through the exact predecessor", async () => {
    for (const disposition of ["revise", "reject"] as const) {
      const facts = await fixture({ label: `assessed-available-${disposition}` });
      const proposed = await proposeCandidate(facts, `assessed-available-${disposition}`);
      await reviewCandidate(facts, proposed.candidate.id, disposition, `assessed-${disposition}-available-review`);
      const governance = await assessRecurrenceGroupGovernance(facts.harness.context, assessmentInput(facts));
      expect(governance).toMatchObject({
        status: "assessed",
        groupDisposition: "available",
        requiredSupersedes: {
          candidateId: proposed.candidate.id,
          candidateDigest: proposed.candidate.contentDigest,
          claimDigest: expect.any(String),
        },
        requiredOverrideCount: null,
        governingRejection: null,
        reasonCodes: [
          disposition === "revise" ? "candidate.revision_required" : "candidate.rejection_suppression_disabled",
        ],
      });
    }
  });

  it("suppresses below the evidence-multiplier boundary and becomes available exactly at it", async () => {
    const policy = createDetectorOrchestrationPolicy({
      rejectionSuppression: { mode: "evidence_multiplier", minimumDistinctEpisodeMultiplier: 2 },
    });
    const facts = await fixture({ label: "assessed-rejection-boundary", policy });
    const proposed = await proposeCandidate(facts, "assessed-rejection-boundary");
    const review = await reviewCandidate(facts, proposed.candidate.id, "reject", "assessed-rejection-boundary-review");
    const below = await assessRecurrenceGroupGovernance(facts.harness.context, assessmentInput(facts));
    expect(below).toMatchObject({
      status: "assessed",
      groupDisposition: "suppressed",
      requiredOverrideCount: 2,
      governingRejection: {
        candidateId: proposed.candidate.id,
        candidateDigest: proposed.candidate.contentDigest,
        reviewId: review.id,
      },
      reasonCodes: ["candidate.rejection_suppressed"],
    });
    await expect(
      assessRecurrenceGroupGovernance(
        facts.harness.context,
        assessmentInput(facts, { currentDistinctEpisodeCount: 2 }),
      ),
    ).resolves.toMatchObject({
      status: "assessed",
      groupDisposition: "available",
      requiredOverrideCount: 2,
      governingRejection: { reviewId: review.id },
      reasonCodes: ["candidate.rejection_override_available"],
    });
  });

  it("uses append order for the latest exact stored review across pre-admission facts", async () => {
    const facts = await fixture({ label: "assessed-latest-review" });
    const proposed = await proposeCandidate(facts, "assessed-latest-review");
    await reviewCandidate(facts, proposed.candidate.id, "reject", "assessed-review-first");
    await reviewCandidate(facts, proposed.candidate.id, "accept", "assessed-review-second");
    const governance = await assessRecurrenceGroupGovernance(facts.harness.context, assessmentInput(facts));
    expect(governance).toMatchObject({
      status: "assessed",
      groupDisposition: "deduplicated",
      candidateBindings: [{ latestReview: { id: "assessed-review-second", disposition: "accept" } }],
    });

    const concurrent = await Promise.all([
      proposePreAdmissionCandidate(facts, "assessed-concurrent-candidate-a", { proposedRisk: "T2" }),
      proposePreAdmissionCandidate(facts, "assessed-concurrent-candidate-b", { proposedRisk: "T3" }),
    ]);
    expect(concurrent.map((outcome) => outcome.candidate.id).sort()).toEqual([
      "assessed-concurrent-candidate-a",
      "assessed-concurrent-candidate-b",
    ]);
  });

  it("uses cap, suppression, deduplication, and ambiguous-frontier precedence with a canonical rejection tie", async () => {
    const suppressionPolicy = createDetectorOrchestrationPolicy({
      rejectionSuppression: { mode: "evidence_multiplier", minimumDistinctEpisodeMultiplier: 2 },
    });
    const suppressedFacts = await fixture({ label: "assessed-strictest-rejection", policy: suppressionPolicy });
    const first = await proposePreAdmissionCandidate(suppressedFacts, "candidate-a", { proposedRisk: "T1" });
    const second = await proposePreAdmissionCandidate(suppressedFacts, "candidate-z", { proposedRisk: "T2" });
    await reviewCandidate(suppressedFacts, first.candidate.id, "reject", "review-a");
    await reviewCandidate(suppressedFacts, second.candidate.id, "reject", "review-z");
    await expect(
      assessRecurrenceGroupGovernance(suppressedFacts.harness.context, assessmentInput(suppressedFacts)),
    ).resolves.toMatchObject({
      status: "assessed",
      groupDisposition: "suppressed",
      governingRejection: { candidateId: "candidate-a", reviewId: "review-a" },
      candidateBindings: [{ candidateId: "candidate-a" }, { candidateId: "candidate-z" }],
    });

    const ambiguousFacts = await fixture({ label: "assessed-ambiguous-frontier" });
    const left = await proposePreAdmissionCandidate(ambiguousFacts, "ambiguous-a", { proposedRisk: "T1" });
    const right = await proposePreAdmissionCandidate(ambiguousFacts, "ambiguous-z", { proposedRisk: "T2" });
    await reviewCandidate(ambiguousFacts, left.candidate.id, "revise", "ambiguous-review-a");
    await reviewCandidate(ambiguousFacts, right.candidate.id, "revise", "ambiguous-review-z");
    await expect(
      assessRecurrenceGroupGovernance(ambiguousFacts.harness.context, assessmentInput(ambiguousFacts)),
    ).resolves.toMatchObject({
      status: "assessed",
      groupDisposition: "deduplicated",
      requiredSupersedes: null,
      reasonCodes: ["candidate.frontier_ambiguous", "candidate.group_deduplicated"],
    });
  });

  it("accepts exactly 50,000 aggregate claim references and fails at 50,001 without truncation", async () => {
    const facts = await fixture({ label: "assessed-aggregate-work" });
    await proposeCandidate(facts, "assessed-aggregate-work");
    const exactBudget = { claimRefs: 49_997 };
    await expect(
      assessRecurrenceGroupGovernance(facts.harness.context, assessmentInput(facts, { workBudget: exactBudget })),
    ).resolves.toMatchObject({ status: "assessed", candidateBindings: [{ candidateId: "assessed-aggregate-work" }] });
    expect(exactBudget.claimRefs).toBe(50_000);

    await expect(
      assessRecurrenceGroupGovernance(
        facts.harness.context,
        assessmentInput(facts, { workBudget: { claimRefs: 49_998 } }),
      ),
    ).rejects.toMatchObject({ code: "detector.limit_exceeded" });
  });

  it("applies the pack cap before Candidate or review assessment", async () => {
    const policy = createDetectorOrchestrationPolicy({
      rejectionSuppression: { mode: "evidence_multiplier", minimumDistinctEpisodeMultiplier: 3 },
    });
    const facts = await fixture({ label: "assessed-cap-precedence", policy });
    const proposed = await proposeCandidate(facts, "assessed-cap-precedence");
    await reviewCandidate(facts, proposed.candidate.id, "reject", "assessed-cap-precedence-review");
    let candidateOrReviewReads = 0;
    const observed = forwardingStore(facts.harness.store, {
      get: (key) => {
        if (
          key.kind === "detector-recurrence-group-candidate" ||
          key.kind === "candidate-recurrence-claim" ||
          key.kind === "candidate-review" ||
          key.kind === "review"
        ) {
          candidateOrReviewReads += 1;
        }
        return facts.harness.store.get(key);
      },
    });
    await expect(
      assessRecurrenceGroupGovernance(
        replaceContextStore(facts.harness.context, observed),
        assessmentInput(facts, { capped: true }),
      ),
    ).resolves.toEqual({
      status: "not_assessed",
      reason: "candidate_governance_capped",
      groupDisposition: "capped",
    });
    expect(candidateOrReviewReads).toBe(0);
  });

  it("marks a typed-invalid active frontier incomplete", async () => {
    const facts = await fixture({ label: "assessed-incomplete" });
    const proposed = await proposeCandidate(facts, "assessed-incomplete");
    const evidence = proposed.candidate.evidenceRefs[0];
    if (evidence === undefined) throw new Error("expected assessed Candidate evidence");
    const hidden = hidingRecordStore(facts.harness.store, "observation", evidence.recordId);
    await expect(
      assessRecurrenceGroupGovernance(replaceContextStore(facts.harness.context, hidden), assessmentInput(facts)),
    ).resolves.toEqual({
      status: "not_assessed",
      reason: "candidate_governance_incomplete",
      groupDisposition: "unassessed",
    });
  });

  it("changes the durable governance snapshot/key and makes older assessed receipts historical", async () => {
    const facts = await fixture({ label: "assessed-receipt-history" });
    const available = facts.initialReceipt;
    const proposed = await proposeCandidate(facts, "assessed-receipt-history");
    const deduplicated = await rerunReceipt(facts);
    expect(deduplicated.governanceSnapshotDigest).not.toBe(available.governanceSnapshotDigest);
    expect(deduplicated.packRunKeyDigest).not.toBe(available.packRunKeyDigest);
    expect(deduplicated.receiptDigest).not.toBe(available.receiptDigest);
    expect(deduplicated.items[0]?.recurrence).toMatchObject({
      status: "grouped",
      governance: {
        status: "assessed",
        groupDisposition: "deduplicated",
        candidateBindings: [{ candidateId: proposed.candidate.id, latestReview: null }],
      },
    });

    await reviewCandidate(facts, proposed.candidate.id, "revise", "assessed-receipt-history-review");
    const revised = await rerunReceipt(facts);
    expect(revised.governanceSnapshotDigest).not.toBe(deduplicated.governanceSnapshotDigest);
    expect(revised.packRunKeyDigest).not.toBe(deduplicated.packRunKeyDigest);
    expect(revised.items[0]?.recurrence).toMatchObject({
      status: "grouped",
      governance: {
        status: "assessed",
        groupDisposition: "available",
        requiredSupersedes: { candidateId: proposed.candidate.id },
        reasonCodes: ["candidate.revision_required"],
      },
    });

    await expect(
      facts.harness.learning.getDetectorPackRun({ packRunReceiptId: available.id, scope: facts.harness.scope }),
    ).resolves.toMatchObject({ governanceBinding: { status: "historical" } });
    await expect(
      facts.harness.learning.getDetectorPackRun({ packRunReceiptId: deduplicated.id, scope: facts.harness.scope }),
    ).resolves.toMatchObject({ governanceBinding: { status: "historical" } });
    await expect(
      facts.harness.learning.getDetectorPackRun({ packRunReceiptId: revised.id, scope: facts.harness.scope }),
    ).resolves.toMatchObject({ governanceBinding: { status: "current" } });
  });

  it("treats append-only recurrence group growth as governance history, not receipt corruption", async () => {
    const facts = await fixture({
      label: "assessed-group-growth-history",
      episodeCount: 2,
      initialEpisodeCount: 1,
    });
    const grown = await facts.harness.learning.runDetectorPack({
      ...facts.input,
      episodeRecordIds: facts.harness.episodeRecordIds,
    });
    if (grown.receipt === undefined) throw new Error("group growth omitted its receipt");
    expect(grown.receipt.governanceSnapshotDigest).not.toBe(facts.initialReceipt.governanceSnapshotDigest);
    await expect(
      facts.harness.learning.getDetectorPackRun({
        packRunReceiptId: facts.initialReceipt.id,
        scope: facts.harness.scope,
      }),
    ).resolves.toMatchObject({
      commitBinding: { status: "committed" },
      governanceBinding: { status: "historical" },
      evidenceHealth: { status: "ready" },
    });
    await expect(
      facts.harness.learning.getDetectorPackRun({ packRunReceiptId: grown.receipt.id, scope: facts.harness.scope }),
    ).resolves.toMatchObject({
      commitBinding: { status: "committed" },
      governanceBinding: { status: "current" },
    });
  });

  it("marks missing embedded Candidate, claim, or Review lineage invalid", async () => {
    const facts = await fixture({ label: "assessed-embedded-invalid" });
    const proposed = await proposeCandidate(facts, "assessed-embedded-invalid");
    const review = await reviewCandidate(facts, proposed.candidate.id, "revise", "assessed-embedded-invalid-review");
    const receipt = await rerunReceipt(facts);
    const targets = [
      { kind: "candidate", id: proposed.candidate.id },
      { kind: "candidate-recurrence-claim", id: proposed.candidate.id },
      { kind: "review", id: review.id },
    ];
    for (const target of targets) {
      const hidden = hidingRecordStore(facts.harness.store, target.kind, target.id);
      const reader = learningWithStore(facts.harness, hidden);
      await expect(
        reader.getDetectorPackRun({ packRunReceiptId: receipt.id, scope: facts.harness.scope }),
      ).resolves.toMatchObject({
        commitBinding: { status: "committed" },
        governanceBinding: { status: "invalid" },
      });
    }
  });

  it("keeps only the exact successor in the active frontier without reading superseded review history", async () => {
    const facts = await fixture({
      label: "assessed-successor-frontier",
      episodeCount: 2,
      initialEpisodeCount: 1,
    });
    const predecessor = await proposePreAdmissionCandidate(facts, "assessed-frontier-predecessor");
    const lens = facts.harness.registry.selectedLensRefs[0];
    if (lens === undefined) throw new Error("successor fixture omitted its selected lens");
    const dry = await facts.harness.learning.runDetector({
      mode: "dry_run",
      detector: detectorRef(facts.harness.detector),
      pack: packRef(facts.harness.pack),
      lens,
      scope: facts.harness.scope,
      episodeRecordIds: facts.harness.episodeRecordIds,
    });
    const draftExecution = dry.execution;
    const draftDerivation = dry.derivations[0];
    if (draftExecution === undefined || draftDerivation === undefined) {
      throw new Error("successor dry run omitted its execution or derivation");
    }
    const successorDerivation = supersedingDerivation(draftDerivation, facts.derivation);
    const successorExecution = executionForDerivation(draftExecution, successorDerivation);
    await persistDetectorExecution(facts.harness.context, successorExecution, [successorDerivation], PRIVATE_LOCATOR);
    const successor = await proposePreAdmissionCandidate(facts, "assessed-frontier-successor", {
      derivationId: successorDerivation.id,
      supersedes: predecessor.candidate.id,
      proposedRisk: "T2",
    });
    const currentLineage = await recurrenceReceiptLineage(facts.harness.context, successorExecution);
    const noPredecessorReviewRead = forwardingStore(facts.harness.store, {
      get: (key) => {
        if (key.kind === "candidate-review" && key.id === predecessor.candidate.id) {
          throw new Error("superseded Candidate review history was read");
        }
        return facts.harness.store.get(key);
      },
    });
    await expect(
      assessRecurrenceGroupGovernance(
        replaceContextStore(facts.harness.context, noPredecessorReviewRead),
        assessmentInput(facts, {
          currentDistinctEpisodeCount: currentLineage.episodeIdentityDigests.length,
          groupLineage: currentLineage,
        }),
      ),
    ).resolves.toMatchObject({
      status: "assessed",
      groupDisposition: "deduplicated",
      candidateBindings: [
        {
          candidateId: successor.candidate.id,
          supersedes: {
            candidateId: predecessor.candidate.id,
            candidateDigest: predecessor.candidate.contentDigest,
          },
        },
      ],
    });

    const tamperedPredecessors = [
      {
        ...predecessor.candidate,
        proposedBy: { ...predecessor.candidate.proposedBy, id: "tampered-predecessor-principal" },
      },
      { ...predecessor.candidate, proposerAttestationDigest: "f".repeat(64) },
      { ...predecessor.candidate, proposedAt: "2026-08-20T01:00:00.000Z" },
    ];
    for (const tampered of tamperedPredecessors) {
      const store = forwardingStore(facts.harness.store, {
        get: async (key) => {
          const stored = await facts.harness.store.get(key);
          if (stored === undefined || key.kind !== "candidate" || key.id !== predecessor.candidate.id) return stored;
          const value = toJsonValue(tampered);
          return { ...stored, value, digest: sha256HexOfCanonicalJson(value) };
        },
      });
      await expect(
        assessRecurrenceGroupGovernance(
          replaceContextStore(facts.harness.context, store),
          assessmentInput(facts, {
            currentDistinctEpisodeCount: currentLineage.episodeIdentityDigests.length,
            groupLineage: currentLineage,
          }),
        ),
      ).rejects.toMatchObject({ code: "store.corrupt" });
    }
  });

  it("does not reveal foreign-scope claims, reviews, receipts, or churn through exact-scope pages", async () => {
    const store = createInMemoryStore();
    const local = await fixture({ label: "assessed-local-snapshot", store });
    const before = await packPages(local.harness);
    expect(before).toHaveLength(1);

    const foreign = await fixture({
      label: "assessed-foreign-snapshot",
      store,
      policy: createDetectorOrchestrationPolicy(),
      scope: SEMANTIC_SCOPE_B,
    });
    const foreignCandidate = await proposeCandidate(foreign, "assessed-foreign-snapshot", { proposedRisk: "T2" });
    await reviewCandidate(foreign, foreignCandidate.candidate.id, "reject", "assessed-foreign-snapshot-review");
    await rerunReceipt(foreign);

    const after = await packPages(local.harness);
    expect(after).toEqual(before);
  });

  it("memoizes one exact group governance fold across same-page receipts", async () => {
    const facts = await fixture({ label: "assessed-query-memo", episodeCount: 2 });
    const second = await facts.harness.learning.runDetectorPack({
      ...facts.input,
      episodeRecordIds: [facts.harness.episodeRecordIds[0] ?? "missing"],
    });
    if (second.receipt === undefined) throw new Error("memoization fixture omitted its second receipt");
    let candidateGroupReads = 0;
    const observed = forwardingStore(facts.harness.store, {
      get: (key) => {
        if (key.kind === "detector-recurrence-group-candidate") candidateGroupReads += 1;
        return facts.harness.store.get(key);
      },
    });
    const pages = [];
    for await (const page of runDetectorPackRunQuery(replaceContextStore(facts.harness.context, observed), {
      scope: facts.harness.scope,
      limit: 100,
    })) {
      pages.push(page);
    }
    expect(pages.flatMap((page) => page.items)).toHaveLength(2);
    expect(candidateGroupReads).toBeGreaterThan(0);
    expect(candidateGroupReads).toBeLessThanOrEqual(2);
  });
});

describe("Candidate review marker and receipt-last index", () => {
  it("persists a marker before Candidate receipt and a review ref before Review receipt", async () => {
    const writes: string[] = [];
    const base = createInMemoryStore();
    const facts = await fixture({
      label: "assessed-write-order",
      store: recordingStore(base, writes),
    });
    writes.length = 0;
    const proposed = await proposeCandidate(facts, "assessed-write-order");
    expect(writes.indexOf("candidate-review")).toBeGreaterThanOrEqual(0);
    expect(writes.indexOf("candidate-review")).toBeLessThan(writes.indexOf("candidate"));

    writes.length = 0;
    await reviewCandidate(facts, proposed.candidate.id, "accept", "assessed-write-order-review");
    expect(writes.indexOf("candidate-review")).toBeGreaterThanOrEqual(0);
    expect(writes.indexOf("candidate-review")).toBeLessThan(writes.indexOf("review"));
  });

  it("treats an indexed review without its terminal receipt as an orphan", async () => {
    const base = createInMemoryStore();
    const controlled = reviewReceiptFailureStore(base);
    const facts = await fixture({ label: "assessed-review-orphan", store: controlled.store });
    const proposed = await proposeCandidate(facts, "assessed-review-orphan");
    controlled.enable();
    await expect(
      reviewCandidate(facts, proposed.candidate.id, "accept", "assessed-review-orphan-review"),
    ).rejects.toThrowError("failed before Review receipt");
    const state = await loadIndexedCandidateReviews(facts.harness.context, proposed.candidate);
    expect(state).toMatchObject({ status: "ready", reviews: [], refCount: 1 });
    const exactBudget = { claimRefs: 49_996 };
    await expect(
      assessRecurrenceGroupGovernance(facts.harness.context, assessmentInput(facts, { workBudget: exactBudget })),
    ).resolves.toMatchObject({
      status: "assessed",
      groupDisposition: "deduplicated",
      candidateBindings: [{ latestReview: null }],
    });
    expect(exactBudget.claimRefs).toBe(50_000);
    await expect(
      assessRecurrenceGroupGovernance(
        facts.harness.context,
        assessmentInput(facts, { workBudget: { claimRefs: 49_997 } }),
      ),
    ).rejects.toMatchObject({ code: "detector.limit_exceeded" });
  });

  it("recovers deterministically from lost marker and Review receipt acknowledgements", async () => {
    const candidateBase = createInMemoryStore();
    const candidateFacts = await fixture({
      label: "assessed-marker-lost-ack",
      store: lostAcknowledgementStore(candidateBase, "candidate-review"),
    });
    await expect(proposeCandidate(candidateFacts, "assessed-marker-lost-ack")).rejects.toThrowError(
      "lost Candidate review marker acknowledgement",
    );
    const candidate = await proposeCandidate(candidateFacts, "assessed-marker-lost-ack");
    const marker = await candidateBase.get({
      namespace: "learning",
      kind: "candidate-review",
      id: candidate.candidate.id,
    });
    expect(Array.isArray(marker?.value) ? marker.value : []).toHaveLength(1);

    const reviewBase = createInMemoryStore();
    const reviewFacts = await fixture({
      label: "assessed-review-lost-ack",
      store: lostAcknowledgementStore(reviewBase, "review"),
    });
    const proposed = await proposeCandidate(reviewFacts, "assessed-review-lost-ack");
    await expect(
      reviewCandidate(reviewFacts, proposed.candidate.id, "accept", "assessed-review-lost-ack-review"),
    ).rejects.toThrowError("lost Review receipt acknowledgement");
    const retried = await reviewCandidate(
      reviewFacts,
      proposed.candidate.id,
      "accept",
      "assessed-review-lost-ack-review",
    );
    expect(retried.id).toBe("assessed-review-lost-ack-review");
    const reviewIndex = await loadIndexedCandidateReviews(reviewFacts.harness.context, proposed.candidate);
    expect(reviewIndex).toMatchObject({ status: "ready", reviews: [{ id: retried.id }], refCount: 1 });
  });

  it("refuses a Review create acknowledgement that did not preserve the terminal receipt", async () => {
    const base = createInMemoryStore();
    const controlled = unpreservedReviewSuccessStore(base);
    const facts = await fixture({ label: "assessed-review-unpreserved", store: controlled.store });
    const proposed = await proposeCandidate(facts, "assessed-review-unpreserved");
    controlled.enable();
    await expect(
      reviewCandidate(facts, proposed.candidate.id, "accept", "assessed-review-unpreserved-review"),
    ).rejects.toMatchObject({ code: "store.corrupt" });
    expect(await countKind(base, "review")).toBe(0);
    expect(await loadIndexedCandidateReviews(facts.harness.context, proposed.candidate)).toMatchObject({
      status: "ready",
      reviews: [],
      refCount: 1,
    });
  });

  it("accepts 4,096-character review ids and rejects 4,097 before callback or writes", async () => {
    const facts = await fixture({ label: "assessed-review-id-bound" });
    const proposed = await proposeCandidate(facts, "assessed-review-id-bound");
    const reviewer = await facts.harness.context.identity.verify({
      principalId: "assessed-review-id-bound-principal",
      kind: "agent",
      independenceDomain: "assessed-review-id-bound-domain",
    });
    let callbacks = 0;
    const reviewWithId = (id: string) =>
      facts.harness.learning.reviewCandidate({
        id,
        candidateId: proposed.candidate.id,
        reviewer: {
          id: "assessed-review-id-bound-implementation",
          version: "1.0.0",
          principal: reviewer,
          review: (request) => {
            callbacks += 1;
            return Promise.resolve({
              candidateId: request.candidate.id,
              candidateDigest: request.candidate.contentDigest,
              disposition: "accept",
              findings: [],
            });
          },
        },
      });
    const maximumId = "r".repeat(4_096);
    const accepted = await reviewWithId(maximumId);
    expect(accepted.id).toBe(maximumId);
    expect(callbacks).toBe(1);
    expect(await loadIndexedCandidateReviews(facts.harness.context, proposed.candidate)).toMatchObject({
      status: "ready",
      reviews: [{ id: maximumId }],
    });

    const beforeIndex = await facts.harness.store.get({
      namespace: "learning",
      kind: "candidate-review",
      id: proposed.candidate.id,
    });
    const beforeReviewCount = await countKind(facts.harness.store, "review");
    await expect(reviewWithId("x".repeat(4_097))).rejects.toMatchObject({ code: "schema.invalid" });
    expect(callbacks).toBe(1);
    expect(
      await facts.harness.store.get({
        namespace: "learning",
        kind: "candidate-review",
        id: proposed.candidate.id,
      }),
    ).toEqual(beforeIndex);
    expect(await countKind(facts.harness.store, "review")).toBe(beforeReviewCount);
    expect(() => parseCandidateReview({ ...accepted, id: "x".repeat(4_097) })).toThrowError(
      expect.objectContaining({ code: "schema.invalid" }),
    );
    expect(() => parseCandidateReview({ ...accepted, candidateId: "x".repeat(4_097) })).toThrowError(
      expect.objectContaining({ code: "schema.invalid" }),
    );
  });

  it("keeps pre-marker Candidate review compatibility without backfilling history", async () => {
    const facts = await fixture({ label: "assessed-pre-marker" });
    const proposed = await proposePreAdmissionCandidate(facts, "assessed-pre-marker");
    const hidden = forwardingStore(facts.harness.store, {
      get: (key) =>
        key.kind === "candidate-review" && key.id === proposed.candidate.id
          ? Promise.resolve(undefined)
          : facts.harness.store.get(key),
    });
    const historicalLearning = learningWithStore(facts.harness, hidden);
    const first = await reviewCandidate(
      facts,
      proposed.candidate.id,
      "accept",
      "assessed-pre-marker-review",
      historicalLearning,
    );
    await expect(
      reviewCandidate(facts, proposed.candidate.id, "accept", "assessed-pre-marker-review", historicalLearning),
    ).resolves.toEqual(first);
    await expect(
      assessRecurrenceGroupGovernance(replaceContextStore(facts.harness.context, hidden), assessmentInput(facts)),
    ).resolves.toEqual({
      status: "not_assessed",
      reason: "candidate_review_history_unavailable",
      groupDisposition: "unassessed",
    });
    const historicalRun = await historicalLearning.runDetectorPack(facts.input);
    expect(historicalRun.receipt?.items[0]?.recurrence).toMatchObject({
      status: "grouped",
      governance: {
        status: "not_assessed",
        reason: "candidate_review_history_unavailable",
        groupDisposition: "unassessed",
      },
    });
    if (historicalRun.receipt === undefined) throw new Error("pre-marker retry omitted its receipt");
    await expect(
      historicalLearning.getDetectorPackRun({
        packRunReceiptId: historicalRun.receipt.id,
        scope: facts.harness.scope,
      }),
    ).resolves.toMatchObject({ governanceBinding: { status: "not_assessed" } });
    const markerOnly = await facts.harness.store.get({
      namespace: "learning",
      kind: "candidate-review",
      id: proposed.candidate.id,
    });
    expect(Array.isArray(markerOnly?.value) ? markerOnly.value : []).toHaveLength(1);
  });

  it("does not expose authority, utility, or efficacy through an assessed fold", async () => {
    const facts = await fixture({ label: "assessed-inert" });
    await proposeCandidate(facts, "assessed-inert");
    const governance = await assessRecurrenceGroupGovernance(facts.harness.context, assessmentInput(facts));
    const serialized = JSON.stringify(toJsonValue(governance));
    for (const forbidden of ["authorized", "efficacy", "improved", "published", "utility", "validated"]) {
      expect(serialized).not.toContain(`"${forbidden}"`);
    }
  });

  it("fails closed on a duplicated marker and an over-cap exact Candidate review stream", async () => {
    const facts = await fixture({ label: "assessed-review-corruption" });
    const proposed = await proposeCandidate(facts, "assessed-review-corruption");
    const duplicated = changedReviewStreamStore(facts.harness.store, proposed.candidate.id, (current) => {
      const marker = current[0];
      if (marker === undefined) throw new Error("expected Candidate review marker");
      return [marker, marker];
    });
    await expect(
      loadIndexedCandidateReviews(replaceContextStore(facts.harness.context, duplicated), proposed.candidate),
    ).rejects.toMatchObject({ code: "store.corrupt" });

    const atCap = changedReviewStreamStore(facts.harness.store, proposed.candidate.id, (current) => {
      const marker = current[0];
      if (marker === undefined) throw new Error("expected Candidate review marker");
      return [
        marker,
        ...Array.from({ length: 5_000 }, (_, index) =>
          reviewIndexEntry(
            proposed.candidate.id,
            proposed.candidate.contentDigest,
            scopeDigest(proposed.candidate.scope),
            index + 1,
          ),
        ),
      ];
    });
    await expect(
      loadIndexedCandidateReviews(replaceContextStore(facts.harness.context, atCap), proposed.candidate),
    ).resolves.toMatchObject({ status: "ready", reviews: [], refCount: 5_000 });

    const overCap = changedReviewStreamStore(facts.harness.store, proposed.candidate.id, (current) => {
      const marker = current[0];
      if (marker === undefined) throw new Error("expected Candidate review marker");
      return [
        marker,
        ...Array.from({ length: 5_001 }, (_, index) =>
          reviewIndexEntry(
            proposed.candidate.id,
            proposed.candidate.contentDigest,
            scopeDigest(proposed.candidate.scope),
            index + 1,
          ),
        ),
      ];
    });
    await expect(
      loadIndexedCandidateReviews(replaceContextStore(facts.harness.context, overCap), proposed.candidate),
    ).rejects.toMatchObject({ code: "store.corrupt" });
  });

  it("fails closed on self-consistent foreign review refs and terminal review tampering", async () => {
    const facts = await fixture({ label: "assessed-review-binding-corruption" });
    const proposed = await proposeCandidate(facts, "assessed-review-binding-corruption");
    const review = await reviewCandidate(
      facts,
      proposed.candidate.id,
      "accept",
      "assessed-review-binding-corruption-review",
    );
    const foreignRef = changedReviewStreamStore(facts.harness.store, proposed.candidate.id, (current) => {
      const marker = current[0];
      if (marker === undefined) throw new Error("expected Candidate review marker");
      const value = toJsonValue({
        kind: "review",
        reviewId: review.id,
        recordDigest: sha256HexOfCanonicalJson(toJsonValue(review)),
        candidateId: proposed.candidate.id,
        candidateDigest: proposed.candidate.contentDigest,
        scopeDigest: "f".repeat(64),
      });
      return [marker, toJsonValue({ id: `review:${review.id}`, digest: sha256HexOfCanonicalJson(value), value })];
    });
    await expect(
      loadIndexedCandidateReviews(replaceContextStore(facts.harness.context, foreignRef), proposed.candidate),
    ).rejects.toMatchObject({ code: "store.corrupt" });

    const tamperedReview = forwardingStore(facts.harness.store, {
      get: async (key) => {
        const stored = await facts.harness.store.get(key);
        if (stored === undefined || key.kind !== "review" || key.id !== review.id) return stored;
        const value = toJsonValue({ ...review, disposition: "reject" });
        return { ...stored, value, digest: sha256HexOfCanonicalJson(value) };
      },
    });
    await expect(
      loadIndexedCandidateReviews(replaceContextStore(facts.harness.context, tamperedReview), proposed.candidate),
    ).rejects.toMatchObject({ code: "store.corrupt" });
  });

  it("loads only exact indexed reviews and ignores foreign review volume", async () => {
    const facts = await fixture({ label: "assessed-review-isolation" });
    const proposed = await proposeCandidate(facts, "assessed-review-isolation");
    await reviewCandidate(facts, proposed.candidate.id, "accept", "assessed-review-isolation-exact");
    const before = await assessRecurrenceGroupGovernance(facts.harness.context, assessmentInput(facts));
    for (let index = 0; index < 250; index += 1) {
      const value = toJsonValue({ foreignReview: index });
      await facts.harness.store.create(
        { namespace: "learning", kind: "review", id: `foreign-review-${String(index).padStart(3, "0")}` },
        value,
        sha256HexOfCanonicalJson(value),
        `seed/foreign-review/${index}`,
      );
    }
    let reviewLists = 0;
    const observed = forwardingStore(facts.harness.store, {
      list: (query) => {
        if (query.kind === "review") reviewLists += 1;
        return facts.harness.store.list(query);
      },
    });
    const after = await assessRecurrenceGroupGovernance(
      replaceContextStore(facts.harness.context, observed),
      assessmentInput(facts),
    );
    expect(after).toEqual(before);
    expect(reviewLists).toBe(0);
  });
});
