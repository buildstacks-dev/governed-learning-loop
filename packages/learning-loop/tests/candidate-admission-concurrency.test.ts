// Stable admission snapshots under concurrent exact review changes.
import { describe, expect, it } from "vitest";
import type { CandidateReview, CandidateV2, LearningStore, VerifiedPrincipal } from "../src/index.js";
import { parseCandidateReview, sha256HexOfCanonicalJson, toJsonValue } from "../src/index.js";
import type { EngineContext } from "../src/engine/context.js";
import { appendCandidateReviewReference } from "../src/engine/candidate-review-index.js";
import { runPropose } from "../src/engine/propose.js";
import { loadCandidateRecurrenceClaim } from "../src/engine/recurrence-claims.js";
import {
  buildStableCandidateAdmissionSnapshot,
  loadCandidateAdmissionStream,
} from "../src/engine/recurrence-admission.js";
import {
  admissionCandidateInput,
  createAdmissionHarness,
  proposeAdmissionCandidate,
} from "./candidate-admission-harness.js";

function forwardingStore(base: LearningStore, get: LearningStore["get"]): LearningStore {
  return {
    get,
    create: (key, value, digest, operationId) => base.create(key, value, digest, operationId),
    compareAndSet: (key, revision, value, digest, operationId) =>
      base.compareAndSet(key, revision, value, digest, operationId),
    append: (stream, revision, entries, operationId) => base.append(stream, revision, entries, operationId),
    tombstone: (input) => base.tombstone(input),
    list: (query) => base.list(query),
  };
}

function controlledStore(base: LearningStore, overrides: Partial<LearningStore>): LearningStore {
  return {
    get: overrides.get ?? ((key) => base.get(key)),
    create: overrides.create ?? ((key, value, digest, operationId) => base.create(key, value, digest, operationId)),
    compareAndSet:
      overrides.compareAndSet ??
      ((key, revision, value, digest, operationId) => base.compareAndSet(key, revision, value, digest, operationId)),
    append:
      overrides.append ??
      ((stream, revision, entries, operationId) => base.append(stream, revision, entries, operationId)),
    tombstone: overrides.tombstone ?? ((input) => base.tombstone(input)),
    list: overrides.list ?? ((query) => base.list(query)),
  };
}

async function storeReview(input: {
  readonly context: EngineContext;
  readonly candidate: CandidateV2;
  readonly reviewer: VerifiedPrincipal;
  readonly index: number;
}): Promise<CandidateReview> {
  const review = parseCandidateReview({
    schemaVersion: 1,
    id: `admission-snapshot-review-${String(input.index).padStart(2, "0")}`,
    candidateId: input.candidate.id,
    candidateDigest: input.candidate.contentDigest,
    reviewer: input.reviewer.ref,
    reviewerAttestationDigest: input.reviewer.attestationDigest,
    reviewerImplementation: { id: "admission-snapshot-reviewer", version: "1.0.0" },
    disposition: input.index % 2 === 0 ? "accept" : "revise",
    findings: [],
    reviewedAt: `2026-08-20T01:${String(input.index).padStart(2, "0")}:00.000Z`,
  });
  await appendCandidateReviewReference(input.context, input.candidate, review);
  const value = toJsonValue(review);
  const result = await input.context.store.create(
    { namespace: "learning", kind: "review", id: review.id },
    value,
    sha256HexOfCanonicalJson(value),
    `seed/admission-snapshot-review/${input.index}`,
  );
  if (result.status !== "created") throw new Error("snapshot review fixture did not create its receipt");
  return review;
}

async function snapshotFixture(label: string) {
  const fixture = await createAdmissionHarness({ label });
  const outcome = await proposeAdmissionCandidate(fixture, `${label}-candidate`);
  const claim = await loadCandidateRecurrenceClaim(fixture.context, outcome.candidate.id);
  if (claim?.status !== "grouped") throw new Error("snapshot fixture omitted grouped claim");
  const stream = await loadCandidateAdmissionStream(fixture.context, claim.groupKeyDigest);
  const reviewer = await fixture.context.identity.verify({
    principalId: `${label}-reviewer`,
    kind: "agent",
    independenceDomain: `${label}-review-domain`,
  });
  return { fixture, candidate: outcome.candidate, claim, stream, reviewer };
}

describe("Candidate admission stable snapshots", () => {
  it("observes a review committed before the first snapshot read", async () => {
    const facts = await snapshotFixture("admission-snapshot-before");
    const review = await storeReview({
      context: facts.fixture.context,
      candidate: facts.candidate,
      reviewer: facts.reviewer,
      index: 1,
    });
    const snapshot = await buildStableCandidateAdmissionSnapshot(facts.fixture.context, facts.claim, facts.stream);
    expect(snapshot.assessment).toMatchObject({
      status: "assessed",
      governance: {
        groupDisposition: "available",
        candidateBindings: [{ latestReview: { id: review.id, disposition: "revise" } }],
      },
    });
  });

  it("retries one review change between double reads and returns the stable current snapshot", async () => {
    const facts = await snapshotFixture("admission-snapshot-once");
    let changes = 0;
    const store = forwardingStore(facts.fixture.harness.store, async (key) => {
      const stored = await facts.fixture.harness.store.get(key);
      if (key.kind === "candidate-review" && key.id === facts.candidate.id && changes === 0) {
        changes += 1;
        await storeReview({
          context: facts.fixture.context,
          candidate: facts.candidate,
          reviewer: facts.reviewer,
          index: 1,
        });
      }
      return stored;
    });
    const snapshot = await buildStableCandidateAdmissionSnapshot(
      { ...facts.fixture.context, store },
      facts.claim,
      facts.stream,
    );
    expect(changes).toBe(1);
    expect(snapshot.assessment).toMatchObject({
      status: "assessed",
      governance: { candidateBindings: [{ latestReview: { disposition: "revise" } }] },
    });
  });

  it("fails after repeated review changes instead of returning a stale snapshot", async () => {
    const facts = await snapshotFixture("admission-snapshot-always");
    let changes = 0;
    const store = forwardingStore(facts.fixture.harness.store, async (key) => {
      const stored = await facts.fixture.harness.store.get(key);
      if (key.kind === "candidate-review" && key.id === facts.candidate.id) {
        changes += 1;
        await storeReview({
          context: facts.fixture.context,
          candidate: facts.candidate,
          reviewer: facts.reviewer,
          index: changes,
        });
      }
      return stored;
    });
    await expect(
      buildStableCandidateAdmissionSnapshot({ ...facts.fixture.context, store }, facts.claim, facts.stream),
    ).rejects.toMatchObject({ code: "candidate.snapshot_changed" });
    expect(changes).toBeGreaterThanOrEqual(6);
  });
});

describe("Candidate admission upgrade concurrency", () => {
  it("refuses a grouped legacy orphan racing a fresh fixed-slot winner", async () => {
    const fixture = await createAdmissionHarness({ label: "admission-upgrade-race" });
    const base = fixture.harness.store;
    let failedLegacyReceipt = false;
    const failingLegacyStore = controlledStore(base, {
      create: (key, value, exactDigest, operationId) => {
        if (!failedLegacyReceipt && key.kind === "candidate") {
          failedLegacyReceipt = true;
          throw new Error("legacy candidate receipt failed");
        }
        return base.create(key, value, exactDigest, operationId);
      },
    });
    const { detectorOrchestrationPolicy: _policy, ...legacyContext } = fixture.context;
    const legacyInput = admissionCandidateInput(fixture, "admission-upgrade-race-legacy", {
      proposedRisk: "T1",
    });
    await expect(runPropose({ ...legacyContext, store: failingLegacyStore }, legacyInput)).rejects.toThrow(
      "legacy candidate receipt failed",
    );

    let reachedSlot: (() => void) | undefined;
    const atSlot = new Promise<void>((resolve) => {
      reachedSlot = resolve;
    });
    let releaseSlot: (() => void) | undefined;
    const slotReleased = new Promise<void>((resolve) => {
      releaseSlot = resolve;
    });
    const gatedStore = controlledStore(base, {
      append: async (stream, revision, entries, operationId) => {
        if (stream.kind === "candidate-recurrence-admission") {
          reachedSlot?.();
          await slotReleased;
        }
        return base.append(stream, revision, entries, operationId);
      },
    });
    const fresh = runPropose(
      { ...fixture.context, store: gatedStore },
      admissionCandidateInput(fixture, "admission-upgrade-race-fresh", { proposedRisk: "T2" }),
    );
    await atSlot;
    await expect(runPropose(fixture.context, legacyInput)).rejects.toMatchObject({
      code: "candidate.admission_refused",
    });
    releaseSlot?.();
    const admitted = await fresh;

    expect(admitted.candidate.id).toBe("admission-upgrade-race-fresh");
    const candidates = await base.list({ namespace: "learning", kind: "candidate", limit: 10 });
    expect(candidates.records).toHaveLength(1);
  });

  it("does not build behind a newly appended pending slot after validating an older stream head", async () => {
    const fixture = await createAdmissionHarness({ label: "admission-forward-head-race" });
    const base = fixture.harness.store;
    let groupReads = 0;
    let releaseFirstGroupRead: (() => void) | undefined;
    const firstGroupReadReleased = new Promise<void>((resolve) => {
      releaseFirstGroupRead = resolve;
    });
    let reachedFirstGroupRead: (() => void) | undefined;
    const atFirstGroupRead = new Promise<void>((resolve) => {
      reachedFirstGroupRead = resolve;
    });
    let releaseFirstBinding: (() => void) | undefined;
    const firstBindingReleased = new Promise<void>((resolve) => {
      releaseFirstBinding = resolve;
    });
    let reachedFirstBinding: (() => void) | undefined;
    const atFirstBinding = new Promise<void>((resolve) => {
      reachedFirstBinding = resolve;
    });
    let bindingPaused = false;
    const controlled = controlledStore(base, {
      get: async (key) => {
        const stored = await base.get(key);
        if (key.kind === "detector-recurrence-group-candidate") {
          groupReads += 1;
          if (groupReads === 1) {
            reachedFirstGroupRead?.();
            await firstGroupReadReleased;
          }
        }
        return stored;
      },
      create: async (key, value, exactDigest, operationId) => {
        if (key.kind === "candidate-admission-binding" && !bindingPaused) {
          bindingPaused = true;
          reachedFirstBinding?.();
          await firstBindingReleased;
        }
        return base.create(key, value, exactDigest, operationId);
      },
    });
    const context = { ...fixture.context, store: controlled };
    const first = runPropose(
      context,
      admissionCandidateInput(fixture, "admission-forward-head-race-a", { proposedRisk: "T1" }),
    );
    await atFirstGroupRead;
    const second = runPropose(
      context,
      admissionCandidateInput(fixture, "admission-forward-head-race-b", { proposedRisk: "T2" }),
    );
    await atFirstBinding;
    releaseFirstGroupRead?.();
    const firstResult = await Promise.allSettled([first]);
    releaseFirstBinding?.();
    const secondResult = await second;

    expect(firstResult[0]).toMatchObject({
      status: "rejected",
      reason: { code: "candidate.admission_refused" },
    });
    expect(secondResult.candidate.id).toBe("admission-forward-head-race-b");
    const candidates = await base.list({ namespace: "learning", kind: "candidate", limit: 10 });
    expect(candidates.records).toHaveLength(1);
  });
});
