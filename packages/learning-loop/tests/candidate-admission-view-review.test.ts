// Candidate admission read/review enforcement: resolved versus historical
// policy, required bindings, and post-persistence tamper blocking.
import { describe, expect, it } from "vitest";
import type { CandidateReviewer, LearningStore } from "../src/index.js";
import { sha256HexOfCanonicalJson, toJsonValue } from "../src/index.js";
import type { EngineContext } from "../src/engine/context.js";
import { runGetCandidateView } from "../src/engine/query.js";
import { runReviewCandidate } from "../src/engine/review.js";
import { parseCandidateContentLock } from "../src/engine/candidate-content-lock.js";
import { candidateAdmissionBindingDigest, loadCandidateAdmissionBinding } from "../src/engine/recurrence-admission.js";
import {
  createAdmissionHarness,
  proposeAdmissionCandidate,
  proposePreAdmissionCandidate,
} from "./candidate-admission-harness.js";
import { createDetectorOrchestrationPolicy } from "./detector-recurrence-harness.js";

function forwardStore(base: LearningStore, get: LearningStore["get"]): LearningStore {
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

function replaceStore(context: EngineContext, store: LearningStore): EngineContext {
  return { ...context, store };
}

function hidingStore(base: LearningStore, kind: string, id: string): LearningStore {
  return forwardStore(base, (key) => (key.kind === kind && key.id === id ? Promise.resolve(undefined) : base.get(key)));
}

async function reviewer(
  context: EngineContext,
  id: string,
  onReview: () => void | Promise<void>,
): Promise<CandidateReviewer> {
  const principal = await context.identity.verify({
    principalId: `${id}-principal`,
    kind: "agent",
    independenceDomain: `${id}-domain`,
  });
  return {
    id: `${id}-implementation`,
    version: "1.0.0",
    principal,
    review: async (input) => {
      await onReview();
      return {
        candidateId: input.candidate.id,
        candidateDigest: input.candidate.contentDigest,
        disposition: "accept",
        findings: [],
      };
    },
  };
}

describe("Candidate admission lineage in views and reviews", () => {
  it("keeps an exact policy-changed admission historical and reviewable", async () => {
    const fixture = await createAdmissionHarness({ label: "admission-policy-history" });
    const outcome = await proposeAdmissionCandidate(fixture, "admission-policy-history");
    const historicalContext: EngineContext = {
      ...fixture.context,
      detectorOrchestrationPolicy: createDetectorOrchestrationPolicy({ maximumInsightGroupsPerRun: 1 }),
    };
    await expect(runGetCandidateView(historicalContext, { candidateId: outcome.candidate.id })).resolves.toMatchObject({
      admissionLineage: { status: "historical", basis: "group_available" },
      governance: { review: "required", publication: "blocked" },
    });
    let calls = 0;
    await expect(
      runReviewCandidate(historicalContext, {
        id: "admission-policy-history-review",
        candidateId: outcome.candidate.id,
        reviewer: await reviewer(historicalContext, "admission-policy-history-reviewer", () => {
          calls += 1;
        }),
      }),
    ).resolves.toMatchObject({ disposition: "accept" });
    expect(calls).toBe(1);
  });

  it.each([
    "candidate-admission-binding",
    "candidate-admission-reservation",
    "candidate-admission-snapshot",
    "candidate-recurrence-admission",
  ] as const)("blocks CandidateView and review when exact %s is missing", async (kind) => {
    const fixture = await createAdmissionHarness({ label: `admission-missing-${kind}` });
    const outcome = await proposeAdmissionCandidate(fixture, `admission-missing-${kind}`);
    const binding = await loadCandidateAdmissionBinding(fixture.context, outcome.candidate.id);
    if (binding === undefined) throw new Error("missing-lineage fixture omitted binding");
    const id =
      kind === "candidate-admission-binding"
        ? outcome.candidate.id
        : kind === "candidate-admission-reservation"
          ? binding.reservationDigest
          : kind === "candidate-admission-snapshot"
            ? binding.snapshotDigest
            : fixture.groupKeyDigest;
    const context = replaceStore(fixture.context, hidingStore(fixture.harness.store, kind, id));
    let calls = 0;
    const reviewInput = {
      id: `admission-missing-${kind}-review`,
      candidateId: outcome.candidate.id,
      reviewer: await reviewer(context, `admission-missing-${kind}-reviewer`, () => {
        calls += 1;
      }),
    };
    await expect(runGetCandidateView(context, { candidateId: outcome.candidate.id })).resolves.toMatchObject({
      admissionLineage: { status: "invalid" },
      governance: { review: "blocked", publication: "blocked" },
    });
    await expect(runReviewCandidate(context, reviewInput)).rejects.toMatchObject({
      code: "review.admission_invalid",
    });
    expect(calls).toBe(0);
  });

  it("does not let removal of admissionExpected disguise a subject Candidate as historical", async () => {
    const fixture = await createAdmissionHarness({ label: "admission-marker-removal" });
    const outcome = await proposeAdmissionCandidate(fixture, "admission-marker-removal");
    const store = forwardStore(fixture.harness.store, async (key) => {
      const stored = await fixture.harness.store.get(key);
      if (stored === undefined || key.kind !== "candidate-by-digest" || key.id !== outcome.candidate.contentDigest) {
        return stored;
      }
      const lock = parseCandidateContentLock(stored.value);
      const value = toJsonValue({
        candidateId: lock.candidateId,
        contentDigest: lock.contentDigest,
        ...(lock.recurrenceClaimDigest === undefined ? {} : { recurrenceClaimDigest: lock.recurrenceClaimDigest }),
        ...(lock.recurrenceClaim === undefined ? {} : { recurrenceClaim: lock.recurrenceClaim }),
        ...(lock.candidate === undefined ? {} : { candidate: lock.candidate }),
      });
      return { ...stored, value, digest: sha256HexOfCanonicalJson(value) };
    });
    const context = replaceStore(fixture.context, store);
    await expect(runGetCandidateView(context, { candidateId: outcome.candidate.id })).resolves.toMatchObject({
      admissionLineage: { status: "invalid" },
      governance: { review: "blocked", publication: "blocked" },
    });
  });

  it("detects a self-consistently redigested binding that points at another policy", async () => {
    const fixture = await createAdmissionHarness({ label: "admission-binding-tamper" });
    const outcome = await proposeAdmissionCandidate(fixture, "admission-binding-tamper");
    const binding = await loadCandidateAdmissionBinding(fixture.context, outcome.candidate.id);
    if (binding === undefined) throw new Error("binding tamper fixture omitted binding");
    const { schemaVersion: _schemaVersion, bindingDigest: _bindingDigest, ...base } = binding;
    const changedBase = { ...base, policyDigest: "f".repeat(64) };
    const changed = toJsonValue({
      schemaVersion: 1,
      ...changedBase,
      bindingDigest: candidateAdmissionBindingDigest(changedBase),
    });
    const store = forwardStore(fixture.harness.store, async (key) => {
      const stored = await fixture.harness.store.get(key);
      return stored === undefined || key.kind !== "candidate-admission-binding" || key.id !== outcome.candidate.id
        ? stored
        : { ...stored, value: changed, digest: sha256HexOfCanonicalJson(changed) };
    });
    await expect(
      runGetCandidateView(replaceStore(fixture.context, store), { candidateId: outcome.candidate.id }),
    ).resolves.toMatchObject({ admissionLineage: { status: "invalid" } });
  });

  it("keeps pre-admission grouped Candidates reviewable and never backfills a binding", async () => {
    const fixture = await createAdmissionHarness({ label: "admission-preexisting-review" });
    const outcome = await proposePreAdmissionCandidate(fixture, "admission-preexisting-review");
    let calls = 0;
    await expect(
      runReviewCandidate(fixture.context, {
        id: "admission-preexisting-review-record",
        candidateId: outcome.candidate.id,
        reviewer: await reviewer(fixture.context, "admission-preexisting-reviewer", () => {
          calls += 1;
        }),
      }),
    ).resolves.toMatchObject({ disposition: "accept" });
    expect(calls).toBe(1);
    expect(await loadCandidateAdmissionBinding(fixture.context, outcome.candidate.id)).toBeUndefined();
  });

  for (const target of ["binding", "reservation", "slot", "marker"] as const) {
    it(`revalidates ${target} after reviewer callback and writes no Review`, async () => {
      const fixture = await createAdmissionHarness({ label: `admission-review-callback-${target}` });
      const outcome = await proposeAdmissionCandidate(fixture, `admission-review-callback-${target}`);
      const binding = await loadCandidateAdmissionBinding(fixture.context, outcome.candidate.id);
      if (binding === undefined) throw new Error("callback mutation fixture omitted binding");
      const key =
        target === "binding"
          ? { namespace: "learning", kind: "candidate-admission-binding", id: outcome.candidate.id }
          : target === "reservation"
            ? {
                namespace: "learning",
                kind: "candidate-admission-reservation",
                id: binding.reservationDigest,
              }
            : target === "slot"
              ? { namespace: "learning", kind: "candidate-recurrence-admission", id: fixture.groupKeyDigest }
              : { namespace: "learning", kind: "candidate-review", id: outcome.candidate.id };
      let calls = 0;
      const candidateReviewer = await reviewer(fixture.context, `admission-review-callback-${target}`, async () => {
        calls += 1;
        const stored = await fixture.harness.store.get(key);
        if (stored === undefined) throw new Error(`callback ${target} fixture is missing`);
        await fixture.harness.store.tombstone({
          key: stored.key,
          expectedRevision: stored.revision,
          reasonCode: `test.callback_${target}_missing`,
          operationId: `test/callback/${target}`,
        });
      });
      await expect(
        fixture.harness.learning.reviewCandidate({
          id: `admission-review-callback-${target}-record`,
          candidateId: outcome.candidate.id,
          reviewer: candidateReviewer,
        }),
      ).rejects.toMatchObject({ code: "review.admission_invalid" });
      expect(calls).toBe(1);
      expect(
        await fixture.harness.store.get({
          namespace: "learning",
          kind: "review",
          id: `admission-review-callback-${target}-record`,
        }),
      ).toBeUndefined();
    });
  }

  it("does not let an occupied review id bypass newly invalid admission lineage", async () => {
    const fixture = await createAdmissionHarness({ label: "admission-occupied-review" });
    const outcome = await proposeAdmissionCandidate(fixture, "admission-occupied-review");
    let calls = 0;
    const candidateReviewer = await reviewer(fixture.context, "admission-occupied-reviewer", () => {
      calls += 1;
    });
    await fixture.harness.learning.reviewCandidate({
      id: "admission-occupied-review-record",
      candidateId: outcome.candidate.id,
      reviewer: candidateReviewer,
    });
    const binding = await fixture.harness.store.get({
      namespace: "learning",
      kind: "candidate-admission-binding",
      id: outcome.candidate.id,
    });
    if (binding === undefined) throw new Error("occupied review fixture omitted admission binding");
    await fixture.harness.store.tombstone({
      key: binding.key,
      expectedRevision: binding.revision,
      reasonCode: "test.occupied_review_admission_invalid",
      operationId: "test/occupied-review-admission-invalid",
    });
    await expect(
      fixture.harness.learning.reviewCandidate({
        id: "admission-occupied-review-record",
        candidateId: outcome.candidate.id,
        reviewer: candidateReviewer,
      }),
    ).rejects.toMatchObject({ code: "review.admission_invalid" });
    expect(calls).toBe(1);
  });
});
