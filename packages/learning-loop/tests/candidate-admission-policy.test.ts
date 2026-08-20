// Serialized recurrence admission policy: exact allow/refuse matrix,
// historical migration, compatibility, and zero-write privacy guarantees.
import { describe, expect, it } from "vitest";
import type { CandidateReview, LearningStore, ReviewDisposition } from "../src/index.js";
import { sha256HexOfCanonicalJson, toJsonValue } from "../src/index.js";
import { createInMemoryStore } from "../src/testing/index.js";
import { runGetCandidateView } from "../src/engine/query.js";
import { runPropose } from "../src/engine/propose.js";
import {
  loadCandidateAdmissionBinding,
  loadCandidateAdmissionReservation,
} from "../src/engine/recurrence-admission.js";
import {
  admissionCandidateInput,
  createAdmissionHarness,
  createAdmissionSuccessorFacts,
  proposeAdmissionCandidate,
  proposePreAdmissionCandidate,
} from "./candidate-admission-harness.js";
import { createDetectorOrchestrationPolicy } from "./detector-recurrence-harness.js";

const ADMISSION_WRITE_KINDS = [
  "candidate-recurrence-claim",
  "candidate-by-digest",
  "candidate-review",
  "candidate-admission-snapshot",
  "candidate-admission-reservation",
  "candidate-recurrence-admission",
  "candidate-admission-binding",
  "detector-recurrence-group-candidate",
  "candidate",
  "review",
] as const;

async function counts(store: LearningStore) {
  const result: Record<string, number> = {};
  for (const kind of ADMISSION_WRITE_KINDS) {
    result[kind] = (await store.list({ namespace: "learning", kind, limit: 10_000 })).records.length;
  }
  return result;
}

async function reviewCandidate(
  fixture: Awaited<ReturnType<typeof createAdmissionHarness>>,
  candidateId: string,
  disposition: ReviewDisposition,
  id: string,
): Promise<CandidateReview> {
  const principal = await fixture.context.identity.verify({
    principalId: `${id}-principal`,
    kind: "agent",
    independenceDomain: `${id}-domain`,
  });
  return fixture.harness.learning.reviewCandidate({
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

async function admissionBasis(fixture: Awaited<ReturnType<typeof createAdmissionHarness>>, candidateId: string) {
  const binding = await loadCandidateAdmissionBinding(fixture.context, candidateId);
  if (binding === undefined) throw new Error("expected Candidate admission binding");
  const reservation = await loadCandidateAdmissionReservation(fixture.context, binding.reservationDigest);
  if (reservation === undefined) throw new Error("expected Candidate admission reservation");
  return reservation.basis;
}

async function tombstoneReviewMarker(store: LearningStore, candidateId: string): Promise<void> {
  const marker = await store.get({ namespace: "learning", kind: "candidate-review", id: candidateId });
  if (marker === undefined) throw new Error("pre-marker fixture omitted its marker");
  const result = await store.tombstone({
    key: marker.key,
    expectedRevision: marker.revision,
    reasonCode: "test.pre_marker_history",
    operationId: `test/pre-marker/${candidateId}`,
  });
  if (result.status !== "updated") throw new Error("pre-marker fixture did not tombstone its marker");
}

async function capturedError(operation: () => Promise<unknown>): Promise<unknown> {
  try {
    await operation();
  } catch (error: unknown) {
    return error;
  }
  throw new Error("expected admission operation to fail");
}

function fullCandidateGroupStore(base: LearningStore) {
  let groupKeyDigest: string | undefined;
  const entries = Array.from({ length: 5_000 }, (_, index) => {
    const candidateId = `admission-cap-candidate-${String(index).padStart(4, "0")}`;
    const claimDigest = (index + 1).toString(16).padStart(64, "0");
    const value = toJsonValue({ candidateId, claimDigest });
    return toJsonValue({
      id: `candidate:${candidateId}:${claimDigest}`,
      digest: sha256HexOfCanonicalJson(value),
      value,
    });
  });
  const ids = entries.map((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry) || !("id" in entry)) {
      throw new Error("candidate group cap entry has no id");
    }
    const id: unknown = entry.id;
    if (typeof id !== "string") throw new Error("candidate group cap entry id is invalid");
    return id;
  });
  const store: LearningStore = {
    get: (key) =>
      groupKeyDigest !== undefined && key.kind === "detector-recurrence-group-candidate" && key.id === groupKeyDigest
        ? Promise.resolve({
            key: { namespace: "learning", kind: "detector-recurrence-group-candidate", id: groupKeyDigest },
            value: entries,
            revision: "admission-full-group-revision",
            digest: sha256HexOfCanonicalJson(ids),
          })
        : base.get(key),
    create: (key, value, digest, operationId) => base.create(key, value, digest, operationId),
    compareAndSet: (key, revision, value, digest, operationId) =>
      base.compareAndSet(key, revision, value, digest, operationId),
    append: (stream, revision, streamEntries, operationId) => base.append(stream, revision, streamEntries, operationId),
    tombstone: (input) => base.tombstone(input),
    list: (query) => base.list(query),
  };
  return {
    store,
    arm: (value: string) => {
      groupKeyDigest = value;
    },
  };
}

describe("Candidate recurrence admission policy", () => {
  it("admits the empty-group Candidate and exposes only inert resolved lineage", async () => {
    const fixture = await createAdmissionHarness({ label: "admission-available" });
    const outcome = await proposeAdmissionCandidate(fixture, "admission-available");
    expect(await admissionBasis(fixture, outcome.candidate.id)).toBe("group_available");
    const view = await fixture.harness.learning.getCandidateView({ candidateId: outcome.candidate.id });
    expect(view).toMatchObject({
      admissionLineage: { status: "resolved", basis: "group_available" },
      governance: { publication: "blocked", validation: "untested" },
    });
    const serialized = JSON.stringify(view?.admissionLineage);
    for (const forbidden of ["authorized", "efficacy", "improved", "published", "utility", "validated"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("refuses a deduplicated fresh Candidate with no Candidate, group, marker, or admission writes", async () => {
    const fixture = await createAdmissionHarness({ label: "admission-deduplicated" });
    await proposeAdmissionCandidate(fixture, "admission-deduplicated-owner");
    const before = await counts(fixture.harness.store);
    const error = await capturedError(() =>
      proposeAdmissionCandidate(fixture, "admission-deduplicated-refused", { proposedRisk: "T2" }),
    );
    expect(error).toMatchObject({ code: "candidate.admission_refused" });
    expect(await counts(fixture.harness.store)).toEqual(before);
    const text = JSON.stringify(error);
    expect(text).not.toContain(fixture.groupKeyDigest);
    expect(text).not.toContain("admission-deduplicated-owner");
  });

  it("admits an exact revise successor and refuses suppressed succession below threshold", async () => {
    const revise = await createAdmissionHarness({ label: "admission-revise" });
    const predecessor = await proposeAdmissionCandidate(revise, "admission-revise-predecessor");
    await reviewCandidate(revise, predecessor.candidate.id, "revise", "admission-revise-review");
    const successorFacts = await createAdmissionSuccessorFacts(revise);
    const successor = await proposeAdmissionCandidate(revise, "admission-revise-successor", {
      derivationId: successorFacts.derivation.id,
      supersedes: predecessor.candidate.id,
      proposedRisk: "T2",
    });
    expect(await admissionBasis(revise, successor.candidate.id)).toBe("required_supersession");

    const suppressionPolicy = createDetectorOrchestrationPolicy({
      rejectionSuppression: { mode: "evidence_multiplier", minimumDistinctEpisodeMultiplier: 3 },
    });
    const suppressed = await createAdmissionHarness({ label: "admission-suppressed", policy: suppressionPolicy });
    const rejected = await proposeAdmissionCandidate(suppressed, "admission-suppressed-predecessor");
    await reviewCandidate(suppressed, rejected.candidate.id, "reject", "admission-suppressed-review");
    const suppressedSuccessor = await createAdmissionSuccessorFacts(suppressed);
    const before = await counts(suppressed.harness.store);
    await expect(
      proposeAdmissionCandidate(suppressed, "admission-suppressed-successor", {
        derivationId: suppressedSuccessor.derivation.id,
        supersedes: rejected.candidate.id,
        proposedRisk: "T2",
      }),
    ).rejects.toMatchObject({ code: "candidate.admission_refused" });
    expect(await counts(suppressed.harness.store)).toEqual(before);
  });

  it("admits an exact rejection override at the multiplier equality boundary", async () => {
    const policy = createDetectorOrchestrationPolicy({
      rejectionSuppression: { mode: "evidence_multiplier", minimumDistinctEpisodeMultiplier: 2 },
    });
    const fixture = await createAdmissionHarness({ label: "admission-override", policy });
    const predecessor = await proposeAdmissionCandidate(fixture, "admission-override-predecessor");
    await reviewCandidate(fixture, predecessor.candidate.id, "reject", "admission-override-review");
    const successorFacts = await createAdmissionSuccessorFacts(fixture);
    const successor = await proposeAdmissionCandidate(fixture, "admission-override-successor", {
      derivationId: successorFacts.derivation.id,
      supersedes: predecessor.candidate.id,
      proposedRisk: "T2",
    });
    expect(await admissionBasis(fixture, successor.candidate.id)).toBe("rejection_override");
  });

  it("refuses succession through an active Candidate whose frozen admission lineage is invalid", async () => {
    const fixture = await createAdmissionHarness({ label: "admission-invalid-predecessor", episodeCount: 3 });
    const predecessor = await proposeAdmissionCandidate(fixture, "admission-invalid-predecessor-a");
    const predecessorReview = await reviewCandidate(
      fixture,
      predecessor.candidate.id,
      "revise",
      "admission-invalid-predecessor-a-review",
    );
    const successorFacts = await createAdmissionSuccessorFacts(fixture, fixture.harness.episodeRecordIds.slice(0, 2));
    const successor = await proposeAdmissionCandidate(fixture, "admission-invalid-predecessor-b", {
      derivationId: successorFacts.derivation.id,
      supersedes: predecessor.candidate.id,
      proposedRisk: "T2",
    });
    await reviewCandidate(fixture, successor.candidate.id, "revise", "admission-invalid-predecessor-b-review");
    const storedReview = await fixture.harness.store.get({
      namespace: "learning",
      kind: "review",
      id: predecessorReview.id,
    });
    if (storedReview === undefined) throw new Error("invalid-predecessor fixture omitted its review receipt");
    const removed = await fixture.harness.store.tombstone({
      key: storedReview.key,
      expectedRevision: storedReview.revision,
      reasonCode: "test.admission_invalid_predecessor",
      operationId: "test/admission-invalid-predecessor/review",
    });
    if (removed.status !== "updated") throw new Error("invalid-predecessor fixture did not remove its review");

    const nextFacts = await createAdmissionSuccessorFacts(
      {
        ...fixture,
        derivation: successorFacts.derivation,
        execution: successorFacts.execution,
      },
      fixture.harness.episodeRecordIds,
    );
    await expect(
      proposeAdmissionCandidate(fixture, "admission-invalid-predecessor-c", {
        derivationId: nextFacts.derivation.id,
        supersedes: successor.candidate.id,
        proposedRisk: "T3",
      }),
    ).rejects.toMatchObject({ code: "candidate.admission_refused" });
  });

  it("migrates only one exact active pre-marker predecessor through mirrored supersession", async () => {
    const fixture = await createAdmissionHarness({ label: "admission-historical" });
    const predecessor = await proposePreAdmissionCandidate(fixture, "admission-historical-predecessor");
    await tombstoneReviewMarker(fixture.harness.store, predecessor.candidate.id);
    const beforeFresh = await counts(fixture.harness.store);
    await expect(
      proposeAdmissionCandidate(fixture, "admission-historical-fresh", { proposedRisk: "T2" }),
    ).rejects.toMatchObject({ code: "candidate.admission_refused" });
    expect(await counts(fixture.harness.store)).toEqual(beforeFresh);
    const successorFacts = await createAdmissionSuccessorFacts(fixture);
    const successor = await proposeAdmissionCandidate(fixture, "admission-historical-successor", {
      derivationId: successorFacts.derivation.id,
      supersedes: predecessor.candidate.id,
      proposedRisk: "T2",
    });
    expect(await admissionBasis(fixture, successor.candidate.id)).toBe("historical_supersession");

    const multiple = await createAdmissionHarness({ label: "admission-historical-multiple" });
    const first = await proposePreAdmissionCandidate(multiple, "admission-historical-multiple-a", {
      proposedRisk: "T1",
    });
    const second = await proposePreAdmissionCandidate(multiple, "admission-historical-multiple-b", {
      proposedRisk: "T2",
    });
    await tombstoneReviewMarker(multiple.harness.store, first.candidate.id);
    await tombstoneReviewMarker(multiple.harness.store, second.candidate.id);
    const multipleSuccessor = await createAdmissionSuccessorFacts(multiple);
    const before = await counts(multiple.harness.store);
    await expect(
      proposeAdmissionCandidate(multiple, "admission-historical-multiple-successor", {
        derivationId: multipleSuccessor.derivation.id,
        supersedes: first.candidate.id,
        proposedRisk: "T3",
      }),
    ).rejects.toMatchObject({ code: "candidate.admission_refused" });
    expect(await counts(multiple.harness.store)).toEqual(before);
  });

  it("preserves manual, unconfigured, and pre-admission terminal compatibility without backfill", async () => {
    const fixture = await createAdmissionHarness({ label: "admission-compatibility" });
    const manual = await fixture.harness.learning.propose({
      id: "admission-manual",
      scope: fixture.harness.scope,
      problem: "Manual Candidate remains outside recurrence admission.",
      hypothesis: "Compatibility remains explicit.",
      evidenceIds: ["manual-evidence/admission-compatibility-observation-0"],
      intervention: {
        destinationId: "host/manual",
        kind: "report-note",
        content: { note: "manual" },
        rollbackIntent: "Remove the note.",
      },
      proposedRisk: "T1",
      proposedBy: fixture.proposer,
    });
    await expect(
      fixture.harness.learning.getCandidateView({ candidateId: manual.candidate.id }),
    ).resolves.toMatchObject({ admissionLineage: { status: "not_subject", reason: "manual" } });

    const historical = await proposePreAdmissionCandidate(fixture, "admission-pre-admission");
    await expect(
      fixture.harness.learning.getCandidateView({ candidateId: historical.candidate.id }),
    ).resolves.toMatchObject({
      admissionLineage: { status: "not_subject", reason: "historical_pre_admission" },
    });
    const before = await counts(fixture.harness.store);
    const same = await runPropose(fixture.context, admissionCandidateInput(fixture, historical.candidate.id));
    expect(same.candidate).toEqual(historical.candidate);
    expect(await counts(fixture.harness.store)).toEqual(before);

    const { detectorOrchestrationPolicy: _policy, ...unconfiguredContext } = fixture.context;
    const unconfigured = await runPropose(
      unconfiguredContext,
      admissionCandidateInput(fixture, "admission-policy-unconfigured", { proposedRisk: "T2" }),
    );
    await expect(
      runGetCandidateView(unconfiguredContext, { candidateId: unconfigured.candidate.id }),
    ).resolves.toMatchObject({ admissionLineage: { status: "not_subject", reason: "policy_unconfigured" } });
  });

  it("maps a full 5,000-member admission group to candidate.admission_limit before Candidate writes", async () => {
    const base = createInMemoryStore();
    const controlled = fullCandidateGroupStore(base);
    const fixture = await createAdmissionHarness({ label: "admission-group-limit", store: controlled.store });
    controlled.arm(fixture.groupKeyDigest);
    const before = await counts(base);
    await expect(proposeAdmissionCandidate(fixture, "admission-group-limit")).rejects.toMatchObject({
      code: "candidate.admission_limit",
    });
    expect(await counts(base)).toEqual(before);
  });
});
