// Serialized recurrence admission persistence: exact write order, retry,
// result-lock validation, slot races, and pending-winner recovery.
import { describe, expect, it } from "vitest";
import type { LearningStore } from "../src/index.js";
import { createInMemoryStore } from "../src/testing/index.js";
import { runPropose } from "../src/engine/propose.js";
import {
  assertCandidateAdmissionHistoryByteLimit,
  candidateAdmissionRawBundleBytes,
  loadCandidateAdmissionStream,
  parseCandidateAdmissionReservation,
  parseCandidateAdmissionSnapshot,
} from "../src/engine/recurrence-admission.js";
import {
  admissionCandidateInput,
  createAdmissionHarness,
  createAdmissionSuccessorFacts,
  proposeAdmissionCandidate,
} from "./candidate-admission-harness.js";
import { SEMANTIC_SCOPE_B } from "./semantic-engine-harness.js";

type Ack = "before" | "after";
type Target =
  | "candidate-admission-snapshot"
  | "candidate-admission-reservation"
  | "candidate-recurrence-admission"
  | "candidate-admission-binding"
  | "candidate";

function forwardStore(base: LearningStore, overrides: Partial<LearningStore>): LearningStore {
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

function failureStore(base: LearningStore, target: Target, acknowledgement: Ack): LearningStore {
  let failed = false;
  return forwardStore(base, {
    create: async (key, value, digest, operationId) => {
      if (!failed && key.kind === target && acknowledgement === "before") {
        failed = true;
        throw new Error(`failed before ${target}`);
      }
      const result = await base.create(key, value, digest, operationId);
      if (!failed && key.kind === target && acknowledgement === "after") {
        failed = true;
        throw new Error(`lost ${target} acknowledgement`);
      }
      return result;
    },
    append: async (stream, revision, entries, operationId) => {
      if (!failed && stream.kind === target && acknowledgement === "before") {
        failed = true;
        throw new Error(`failed before ${target}`);
      }
      const result = await base.append(stream, revision, entries, operationId);
      if (!failed && stream.kind === target && acknowledgement === "after") {
        failed = true;
        throw new Error(`lost ${target} acknowledgement`);
      }
      return result;
    },
  });
}

function unpreservedSuccessStore(base: LearningStore, target: "candidate-recurrence-admission" | "candidate") {
  return forwardStore(base, {
    create: (key, value, digest, operationId) =>
      key.kind === target
        ? Promise.resolve({ status: "created", revision: `fake-${target}-revision` })
        : base.create(key, value, digest, operationId),
    append: (stream, revision, entries, operationId) =>
      stream.kind === target
        ? Promise.resolve({ status: "updated", revision: `fake-${target}-revision` })
        : base.append(stream, revision, entries, operationId),
  });
}

function recordingStore(base: LearningStore, writes: string[]): LearningStore {
  return forwardStore(base, {
    create: (key, value, digest, operationId) => {
      writes.push(key.kind);
      return base.create(key, value, digest, operationId);
    },
    append: (stream, revision, entries, operationId) => {
      writes.push(stream.kind);
      return base.append(stream, revision, entries, operationId);
    },
  });
}

function racingSlotStore(base: LearningStore) {
  let arrivals = 0;
  let armed = false;
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const store = forwardStore(base, {
    append: async (stream, revision, entries, operationId) => {
      if (!armed || stream.kind !== "candidate-recurrence-admission") {
        return base.append(stream, revision, entries, operationId);
      }
      arrivals += 1;
      if (arrivals === 2) release?.();
      await gate;
      return base.append(stream, revision, entries, operationId);
    },
  });
  return {
    store,
    arm: () => {
      armed = true;
    },
  };
}

function hidingStore(base: LearningStore, kind: string, id: string): LearningStore {
  return forwardStore(base, {
    get: (key) => (key.kind === kind && key.id === id ? Promise.resolve(undefined) : base.get(key)),
  });
}

function conflictingSlotStore(base: LearningStore): LearningStore {
  return forwardStore(base, {
    append: (stream, revision, entries, operationId) =>
      stream.kind === "candidate-recurrence-admission"
        ? Promise.resolve({ status: "conflict", ...(revision === undefined ? {} : { revision }) })
        : base.append(stream, revision, entries, operationId),
  });
}

async function countKind(store: LearningStore, kind: string): Promise<number> {
  return (await store.list({ namespace: "learning", kind, limit: 10_000 })).records.length;
}

async function markCandidateRevise(
  fixture: Awaited<ReturnType<typeof createAdmissionHarness>>,
  candidateId: string,
  reviewId: string,
): Promise<void> {
  const reviewer = await fixture.context.identity.verify({
    principalId: `${reviewId}-principal`,
    kind: "agent",
    independenceDomain: `${reviewId}-domain`,
  });
  await fixture.harness.learning.reviewCandidate({
    id: reviewId,
    candidateId,
    reviewer: {
      id: `${reviewId}-implementation`,
      version: "1.0.0",
      principal: reviewer,
      review: (request) =>
        Promise.resolve({
          candidateId: request.candidate.id,
          candidateDigest: request.candidate.contentDigest,
          disposition: "revise",
          findings: [],
        }),
    },
  });
}

async function successorBundle(label: string) {
  const fixture = await createAdmissionHarness({ label });
  const predecessor = await proposeAdmissionCandidate(fixture, `${label}-predecessor`);
  await markCandidateRevise(fixture, predecessor.candidate.id, `${label}-review`);
  const successorFacts = await createAdmissionSuccessorFacts(fixture);
  let snapshotValue: unknown;
  let reservationValue: unknown;
  const captureStore = forwardStore(fixture.harness.store, {
    create: async (key, value, exactDigest, operationId) => {
      if (key.kind === "candidate-admission-snapshot") snapshotValue = value;
      if (key.kind === "candidate-admission-reservation") {
        reservationValue = value;
        throw new Error("captured prospective admission bundle");
      }
      return fixture.harness.store.create(key, value, exactDigest, operationId);
    },
  });
  await expect(
    runPropose(
      { ...fixture.context, store: captureStore },
      admissionCandidateInput(fixture, `${label}-successor`, {
        derivationId: successorFacts.derivation.id,
        supersedes: predecessor.candidate.id,
        proposedRisk: "T2",
      }),
    ),
  ).rejects.toThrow("captured prospective admission bundle");
  if (snapshotValue === undefined || reservationValue === undefined) {
    throw new Error("prospective admission byte fixture omitted its bundle");
  }
  const snapshot = parseCandidateAdmissionSnapshot(snapshotValue);
  const reservation = parseCandidateAdmissionReservation(reservationValue);
  return {
    snapshot,
    reservation,
    bytes: candidateAdmissionRawBundleBytes(reservationValue, snapshotValue),
  };
}

function expectOrdered(writes: readonly string[], kinds: readonly string[]): void {
  let previous = -1;
  for (const kind of kinds) {
    const index = writes.indexOf(kind, previous + 1);
    expect(index, `missing ordered write ${kind}`).toBeGreaterThan(previous);
    previous = index;
  }
}

describe("Candidate admission receipt-last persistence", () => {
  it("writes decision, neutral lock, marker, snapshot, reservation, slot, binding, group, and Candidate in order", async () => {
    const base = createInMemoryStore();
    const writes: string[] = [];
    const fixture = await createAdmissionHarness({
      label: "admission-write-order",
      store: recordingStore(base, writes),
    });
    writes.length = 0;
    await proposeAdmissionCandidate(fixture, "admission-write-order");
    expectOrdered(writes, [
      "candidate-recurrence-claim",
      "candidate-by-digest",
      "candidate-review",
      "candidate-admission-snapshot",
      "candidate-admission-reservation",
      "candidate-recurrence-admission",
      "candidate-admission-binding",
      "detector-recurrence-group-candidate",
      "candidate",
    ]);
  });

  for (const target of [
    "candidate-admission-snapshot",
    "candidate-admission-reservation",
    "candidate-recurrence-admission",
    "candidate-admission-binding",
    "candidate",
  ] as const) {
    for (const acknowledgement of ["before", "after"] as const) {
      it(`recovers ${target} failure ${acknowledgement} acknowledgement`, async () => {
        const base = createInMemoryStore();
        const fixture = await createAdmissionHarness({
          label: `admission-retry-${target}-${acknowledgement}`,
          store: failureStore(base, target, acknowledgement),
        });
        await expect(
          proposeAdmissionCandidate(fixture, `admission-retry-${target}-${acknowledgement}`),
        ).rejects.toThrowError(
          acknowledgement === "before" ? `failed before ${target}` : `lost ${target} acknowledgement`,
        );
        const retried = await proposeAdmissionCandidate(fixture, `admission-retry-${target}-${acknowledgement}`);
        expect(retried.candidate.id).toBe(`admission-retry-${target}-${acknowledgement}`);
        expect(await countKind(base, "candidate")).toBe(1);
        expect(await countKind(base, "candidate-admission-binding")).toBe(1);
        expect(await countKind(base, "detector-recurrence-group-candidate")).toBe(1);
      });
    }
  }

  it.each(["candidate-recurrence-admission", "candidate"] as const)(
    "rejects an acknowledged %s write that was not preserved",
    async (target) => {
      const base = createInMemoryStore();
      const fixture = await createAdmissionHarness({
        label: `admission-unpreserved-${target}`,
        store: unpreservedSuccessStore(base, target),
      });
      await expect(proposeAdmissionCandidate(fixture, `admission-unpreserved-${target}`)).rejects.toMatchObject({
        code: "store.corrupt",
      });
      expect(await countKind(base, "candidate")).toBe(0);
    },
  );

  it("preflights the aggregate 64 MiB history boundary and forward-completes an exact post-slot retry", async () => {
    const label = "admission-history-boundary";
    const bundle = await successorBundle(label);
    const exactRetainedBytes = 64 * 1_048_576 - bundle.bytes;
    expect(() =>
      assertCandidateAdmissionHistoryByteLimit(exactRetainedBytes, bundle.snapshot, bundle.reservation),
    ).not.toThrow();
    expect(() =>
      assertCandidateAdmissionHistoryByteLimit(exactRetainedBytes + 1, bundle.snapshot, bundle.reservation),
    ).toThrowError(expect.objectContaining({ code: "candidate.admission_limit" }));
    const emptyPaddedBytes = candidateAdmissionRawBundleBytes({ ...bundle.reservation, padding: "" }, bundle.snapshot);
    const paddedBytes = candidateAdmissionRawBundleBytes(
      { ...bundle.reservation, padding: "x".repeat(1_024) },
      bundle.snapshot,
    );
    expect(paddedBytes - emptyPaddedBytes).toBe(1_024);

    const base = createInMemoryStore();
    const fixture = await createAdmissionHarness({
      label: "admission-history-boundary-retry",
      store: failureStore(base, "candidate-admission-binding", "before"),
    });
    const candidateId = "admission-history-boundary-retry-candidate";
    await expect(proposeAdmissionCandidate(fixture, candidateId)).rejects.toThrow(
      "failed before candidate-admission-binding",
    );
    const recovered = await proposeAdmissionCandidate(fixture, candidateId);
    expect(recovered.candidate.id).toBe(candidateId);
  });

  it("serializes two fresh Candidates on one snapshot and forward-completes the winner", async () => {
    const base = createInMemoryStore();
    const controlled = racingSlotStore(base);
    const fixture = await createAdmissionHarness({ label: "admission-slot-race", store: controlled.store });
    controlled.arm();
    const outcomes = await Promise.allSettled([
      proposeAdmissionCandidate(fixture, "admission-slot-race-a", { proposedRisk: "T1" }),
      proposeAdmissionCandidate(fixture, "admission-slot-race-b", { proposedRisk: "T2" }),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === "rejected");
    if (rejected?.status !== "rejected") throw new Error("expected one rejected slot race");
    expect(rejected.reason).toMatchObject({ code: "candidate.admission_refused" });
    expect(await countKind(base, "candidate-recurrence-admission")).toBe(1);
    expect(await countKind(base, "candidate-admission-binding")).toBe(1);
    expect(await countKind(base, "detector-recurrence-group-candidate")).toBe(1);
    expect(await countKind(base, "candidate")).toBe(1);
    expect(await countKind(base, "candidate-recurrence-claim")).toBe(2);
    expect(await countKind(base, "candidate-by-digest")).toBe(2);
    expect(await countKind(base, "candidate-review")).toBe(2);
  });

  it("serializes concurrent exact successors to one required predecessor", async () => {
    const base = createInMemoryStore();
    const controlled = racingSlotStore(base);
    const fixture = await createAdmissionHarness({ label: "admission-successor-race", store: controlled.store });
    const predecessor = await proposeAdmissionCandidate(fixture, "admission-successor-race-predecessor");
    const reviewer = await fixture.context.identity.verify({
      principalId: "admission-successor-race-reviewer",
      kind: "agent",
      independenceDomain: "admission-successor-race-review-domain",
    });
    await fixture.harness.learning.reviewCandidate({
      id: "admission-successor-race-review",
      candidateId: predecessor.candidate.id,
      reviewer: {
        id: "admission-successor-race-reviewer",
        version: "1.0.0",
        principal: reviewer,
        review: (input) =>
          Promise.resolve({
            candidateId: input.candidate.id,
            candidateDigest: input.candidate.contentDigest,
            disposition: "revise",
            findings: [],
          }),
      },
    });
    const successor = await createAdmissionSuccessorFacts(fixture);
    controlled.arm();
    const outcomes = await Promise.allSettled([
      proposeAdmissionCandidate(fixture, "admission-successor-race-a", {
        derivationId: successor.derivation.id,
        supersedes: predecessor.candidate.id,
        proposedRisk: "T2",
      }),
      proposeAdmissionCandidate(fixture, "admission-successor-race-b", {
        derivationId: successor.derivation.id,
        supersedes: predecessor.candidate.id,
        proposedRisk: "T3",
      }),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === "rejected");
    if (rejected?.status !== "rejected") throw new Error("successor race omitted its loser");
    expect(rejected.reason).toMatchObject({ code: "candidate.admission_refused" });
    expect(await countKind(base, "candidate")).toBe(2);
    expect(await countKind(base, "candidate-admission-binding")).toBe(2);
    expect(await countKind(base, "detector-recurrence-group-candidate")).toBe(1);
    expect((await loadCandidateAdmissionStream(fixture.context, fixture.groupKeyDigest)).slots).toHaveLength(2);
  });

  it("reloads a stale group-member set after a concurrent pending-slot completer", async () => {
    const base = createInMemoryStore();
    const fixture = await createAdmissionHarness({
      label: "admission-stale-member-reload",
      store: failureStore(base, "candidate-admission-binding", "before"),
    });
    const candidateId = "admission-stale-member-reload-candidate";
    await expect(proposeAdmissionCandidate(fixture, candidateId)).rejects.toThrow(
      "failed before candidate-admission-binding",
    );

    let reachedFirstMemberRead: (() => void) | undefined;
    const atFirstMemberRead = new Promise<void>((resolve) => {
      reachedFirstMemberRead = resolve;
    });
    let releaseFirstMemberRead: (() => void) | undefined;
    const firstMemberReadReleased = new Promise<void>((resolve) => {
      releaseFirstMemberRead = resolve;
    });
    let memberReads = 0;
    const controlled = forwardStore(base, {
      get: async (key) => {
        const stored = await base.get(key);
        if (key.kind === "detector-recurrence-group-candidate") {
          memberReads += 1;
          if (memberReads === 1) {
            reachedFirstMemberRead?.();
            await firstMemberReadReleased;
          }
        }
        return stored;
      },
    });
    const context = { ...fixture.context, store: controlled };
    const first = runPropose(context, admissionCandidateInput(fixture, candidateId));
    await atFirstMemberRead;
    const second = await runPropose(context, admissionCandidateInput(fixture, candidateId));
    releaseFirstMemberRead?.();
    const resumed = await first;

    expect(second.candidate.id).toBe(candidateId);
    expect(resumed.candidate).toEqual(second.candidate);
    expect(await countKind(base, "candidate")).toBe(1);
    expect(await countKind(base, "detector-recurrence-group-candidate")).toBe(1);
  });

  it("same-content foreign ids converge on one neutral content owner and one admission", async () => {
    const base = createInMemoryStore();
    const fixture = await createAdmissionHarness({ label: "admission-content-race", store: base });
    const outcomes = await Promise.allSettled([
      proposeAdmissionCandidate(fixture, "admission-content-race-a"),
      proposeAdmissionCandidate(fixture, "admission-content-race-b"),
    ]);
    const winner = outcomes.find((outcome) => outcome.status === "fulfilled");
    const loser = outcomes.find((outcome) => outcome.status === "rejected");
    if (winner?.status !== "fulfilled" || loser?.status !== "rejected") {
      throw new Error("same-content race did not produce one winner and one loser");
    }
    expect(loser.reason).toMatchObject({ code: "store.conflict" });
    const losingId =
      winner.value.candidate.id === "admission-content-race-a"
        ? "admission-content-race-b"
        : "admission-content-race-a";
    await expect(proposeAdmissionCandidate(fixture, losingId)).rejects.toMatchObject({ code: "store.conflict" });
    expect(await countKind(base, "candidate-by-digest")).toBe(1);
    expect(await countKind(base, "candidate-recurrence-admission")).toBe(1);
    expect(await countKind(base, "candidate-admission-binding")).toBe(1);
    expect(await countKind(base, "candidate")).toBe(1);
  });

  it("fails repeated slot CAS conflicts as admission_in_progress without a binding, group member, or Candidate", async () => {
    const base = createInMemoryStore();
    const fixture = await createAdmissionHarness({
      label: "admission-slot-conflicts",
      store: conflictingSlotStore(base),
    });
    let error: unknown;
    try {
      await proposeAdmissionCandidate(fixture, "admission-slot-conflicts");
    } catch (caught: unknown) {
      error = caught;
    }
    expect(error).toMatchObject({ code: "candidate.admission_in_progress" });
    expect(JSON.stringify(error)).not.toContain(fixture.groupKeyDigest);
    expect(await countKind(base, "candidate-admission-binding")).toBe(0);
    expect(await countKind(base, "detector-recurrence-group-candidate")).toBe(0);
    expect(await countKind(base, "candidate")).toBe(0);
  });

  it.each([
    "candidate-recurrence-claim",
    "candidate-by-digest",
    "candidate-review",
    "candidate-admission-snapshot",
    "candidate-admission-reservation",
  ] as const)("never backfills missing pre-slot %s after a winning slot", async (kind) => {
    const base = createInMemoryStore();
    const candidateId = `admission-pre-slot-${kind}`;
    const fixture = await createAdmissionHarness({
      label: candidateId,
      store: failureStore(base, "candidate-admission-binding", "before"),
    });
    const input = admissionCandidateInput(fixture, candidateId);
    await expect(runPropose(fixture.context, input)).rejects.toThrowError("failed before candidate-admission-binding");

    let targetId = candidateId;
    if (kind === "candidate-by-digest") {
      const record = (await base.list({ namespace: "learning", kind, limit: 10 })).records[0];
      if (record === undefined) throw new Error("missing content-lock fixture");
      targetId = record.key.id;
    } else if (kind === "candidate-admission-snapshot" || kind === "candidate-admission-reservation") {
      const record = (await base.list({ namespace: "learning", kind, limit: 10 })).records[0];
      if (record === undefined) throw new Error(`missing ${kind} fixture`);
      targetId = record.key.id;
    }
    const hiddenContext = { ...fixture.context, store: hidingStore(base, kind, targetId) };
    await expect(runPropose(hiddenContext, input)).rejects.toMatchObject({ code: "store.corrupt" });
    expect(await countKind(base, "candidate-admission-binding")).toBe(0);
    expect(await countKind(base, "candidate")).toBe(0);
  });

  it("never backfills a tombstoned pre-slot review marker after slot linearization", async () => {
    const base = createInMemoryStore();
    const candidateId = "admission-tombstoned-marker";
    const fixture = await createAdmissionHarness({
      label: candidateId,
      store: failureStore(base, "candidate-admission-binding", "before"),
    });
    await expect(proposeAdmissionCandidate(fixture, candidateId)).rejects.toThrowError(
      "failed before candidate-admission-binding",
    );
    const marker = await base.get({ namespace: "learning", kind: "candidate-review", id: candidateId });
    if (marker === undefined) throw new Error("pending admission omitted its review marker");
    await base.tombstone({
      key: marker.key,
      expectedRevision: marker.revision,
      reasonCode: "test.marker_missing_after_slot",
      operationId: "test/tombstone-admission-marker",
    });
    await expect(proposeAdmissionCandidate(fixture, candidateId)).rejects.toMatchObject({ code: "store.corrupt" });
    expect(await base.get(marker.key)).toBeUndefined();
    expect(await countKind(base, "candidate-admission-binding")).toBe(0);
    expect(await countKind(base, "candidate")).toBe(0);
  });

  it("locks proposer attribution and proposal time across admission crash recovery", async () => {
    const base = createInMemoryStore();
    const candidateId = "admission-attribution-retry";
    const fixture = await createAdmissionHarness({
      label: candidateId,
      store: failureStore(base, "candidate-admission-snapshot", "before"),
    });
    let now = "2026-08-20T03:00:00.000Z";
    const context = { ...fixture.context, clock: { now: () => now } };
    const input = admissionCandidateInput(fixture, candidateId);
    await expect(runPropose(context, input)).rejects.toThrowError("failed before candidate-admission-snapshot");
    const claimRecord = await base.get({ namespace: "learning", kind: "candidate-recurrence-claim", id: candidateId });
    if (claimRecord === undefined) throw new Error("attribution retry omitted recurrence decision");
    if (typeof claimRecord.value !== "object" || claimRecord.value === null || !("candidate" in claimRecord.value)) {
      throw new Error("attribution retry recurrence decision is malformed");
    }
    const embedded: unknown = claimRecord.value.candidate;
    if (typeof embedded !== "object" || embedded === null || !("proposedAt" in embedded)) {
      throw new Error("attribution retry Candidate is malformed");
    }
    const originalProposedAt: unknown = embedded.proposedAt;
    expect(originalProposedAt).toBe(now);

    now = "2026-08-20T04:00:00.000Z";
    const foreign = await fixture.context.identity.verify({
      principalId: "admission-attribution-foreign",
      kind: "agent",
      independenceDomain: "admission-attribution-foreign-domain",
    });
    await expect(runPropose(context, { ...input, proposedBy: foreign })).rejects.toMatchObject({
      code: "store.conflict",
    });
    const retried = await runPropose(context, input);
    expect(retried.candidate.proposedAt).toBe(originalProposedAt);
    expect(retried.candidate.proposedBy).toEqual(fixture.proposer.ref);
  });

  it("admits foreign scopes independently without shared slots or an existence oracle", async () => {
    const base = createInMemoryStore();
    const local = await createAdmissionHarness({ label: "admission-scope-local", store: base });
    const foreign = await createAdmissionHarness({
      label: "admission-scope-foreign",
      store: base,
      scope: SEMANTIC_SCOPE_B,
    });
    const outcomes = await Promise.all([
      proposeAdmissionCandidate(local, "admission-scope-local"),
      proposeAdmissionCandidate(foreign, "admission-scope-foreign"),
    ]);
    expect(outcomes.map((outcome) => outcome.candidate.id).sort()).toEqual([
      "admission-scope-foreign",
      "admission-scope-local",
    ]);
    expect(local.groupKeyDigest).not.toBe(foreign.groupKeyDigest);
    expect(await countKind(base, "candidate-recurrence-admission")).toBe(2);
    expect(await countKind(base, "candidate-admission-binding")).toBe(2);
  });
});
