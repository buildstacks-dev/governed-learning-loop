// Refusal conformance (contract §Conformance suites; decisions 0025 and
// 0026): a pending, denied, invalid, expired, or wrong-base authorization
// produces no destination write and no store write at all. Only the fully
// authorized branch reaches the journaled publisher.
import { describe, expect, it } from "vitest";
import type { PublicationOutcome } from "../src/index.js";
import { authorizationBindingDigest } from "../src/index.js";
import { candidateInput, reviewerFor } from "./engine-harness.js";
import {
  DESTINATION_ID,
  createPublicationHarness,
  inertDestination,
  type PublicationHarnessOptions,
} from "./publication-harness.js";

const BASE = "instructions-v7";

async function preparedHarness(options: PublicationHarnessOptions = {}) {
  const harness = await createPublicationHarness(options);
  const candidate = await harness.acceptedCandidate();
  const prepared = await harness.learning.preparePublication({
    candidateId: candidate.id,
    destinationId: DESTINATION_ID,
    expectedBase: BASE,
  });
  const snapshot = await harness.storeSnapshot();
  return { harness, candidate, plan: prepared.plan, binding: prepared.authorizationBinding, snapshot };
}

type Prepared = Awaited<ReturnType<typeof preparedHarness>>;

async function expectNoWrite(context: Prepared): Promise<void> {
  expect(context.harness.destination.calls.applyEffect).toBe(0);
  expect(await context.harness.storeSnapshot()).toBe(context.snapshot);
}

function codes(outcome: PublicationOutcome): readonly string[] {
  return messagesAndCodes(outcome).map((diagnostic) => diagnostic.code);
}

function messagesAndCodes(outcome: PublicationOutcome): readonly { readonly code: string; readonly message: string }[] {
  return "diagnostics" in outcome ? outcome.diagnostics : [];
}

describe("publish refusal conformance: no destination write", () => {
  for (const decision of ["pending", "denied", "invalid", "expired"] as const) {
    it(`a host "${decision}" authorization produces no destination write`, async () => {
      const context = await preparedHarness();
      const evidence = { decision };
      const outcome = await context.harness.learning.publish({
        planId: context.plan.id,
        authorizationEvidence: evidence,
      });
      expect(outcome.status).toBe(decision === "pending" ? "pending" : "denied");
      expect(codes(outcome)).toEqual([`authority.${decision}`, `host.${decision}`]);
      expect(Object.isFrozen(outcome)).toBe(true);
      await expectNoWrite(context);
      expect(context.harness.authority?.calls).toHaveLength(1);
      expect(context.harness.authority?.calls[0]?.evidence).toBe(evidence);
      expect(context.harness.authority?.calls[0]?.binding).toEqual(context.binding);
    });
  }

  it("an authorization the kernel clock says has expired is denied", async () => {
    const context = await preparedHarness();
    const outcome = await context.harness.learning.publish({
      planId: context.plan.id,
      authorizationEvidence: { decision: "authorized", expiresAt: "2026-08-16T09:59:30.000Z" },
    });
    expect(outcome.status).toBe("denied");
    expect(codes(outcome)).toEqual(["authority.expired"]);
    await expectNoWrite(context);
  });

  it("an authorization that never expires is accepted by the clock check and publishes", async () => {
    const context = await preparedHarness();
    const outcome = await context.harness.learning.publish({
      planId: context.plan.id,
      authorizationEvidence: { decision: "authorized", expiresAt: null },
    });
    expect(outcome.status).toBe("published");
    expect(context.harness.destination.calls.applyEffect).toBe(1);
  });

  it("a wrong-base authorization (approval of a binding with another base) produces no destination write", async () => {
    const context = await preparedHarness();
    const wrongBase = authorizationBindingDigest({ ...context.binding, expectedBases: ["instructions-v6"] });
    const outcome = await context.harness.learning.publish({
      planId: context.plan.id,
      authorizationEvidence: { decision: "authorized", bindingDigest: wrongBase },
    });
    expect(outcome.status).toBe("denied");
    expect(codes(outcome)).toEqual(["authority.invalid", "publication.binding_mismatch"]);
    await expectNoWrite(context);
  });

  it("an approval minted for an earlier plan of the same candidate at another base is refused for the new plan", async () => {
    const context = await preparedHarness();
    const staleDigest = authorizationBindingDigest(context.binding);
    const rebased = await context.harness.learning.preparePublication({
      candidateId: context.candidate.id,
      destinationId: DESTINATION_ID,
      expectedBase: "instructions-v8",
    });
    expect(rebased.plan.id).not.toBe(context.plan.id);
    const snapshot = await context.harness.storeSnapshot();
    const outcome = await context.harness.learning.publish({
      planId: rebased.plan.id,
      authorizationEvidence: { decision: "authorized", bindingDigest: staleDigest },
    });
    expect(outcome.status).toBe("denied");
    expect(codes(outcome)).toContain("publication.binding_mismatch");
    expect(context.harness.destination.calls.applyEffect).toBe(0);
    expect(await context.harness.storeSnapshot()).toBe(snapshot);
  });

  it("only a fully authorized plan reaches the destination, exactly once, after one authority call", async () => {
    const context = await preparedHarness();
    const outcome = await context.harness.learning.publish({
      planId: context.plan.id,
      authorizationEvidence: { decision: "authorized" },
    });
    expect(outcome.status).toBe("published");
    expect(context.harness.destination.calls.applyEffect).toBe(1);
    expect(context.harness.authority?.calls).toHaveLength(1);
    expect(await context.harness.storeSnapshot()).not.toBe(context.snapshot);
  });

  it("publish without a configured authority port is blocked before any destination call", async () => {
    const context = await preparedHarness({ authority: null });
    const outcome = await context.harness.learning.publish({ planId: context.plan.id, authorizationEvidence: {} });
    expect(outcome.status).toBe("blocked");
    expect(codes(outcome)).toEqual(["policy.authority_insufficient"]);
    await expectNoWrite(context);
  });

  it("a plan whose candidate lacks a decisive review is blocked without consulting authority", async () => {
    const harness = await createPublicationHarness();
    const { candidate } = await harness.learning.propose(candidateInput(harness.proposer));
    const prepared = await harness.learning.preparePublication({
      candidateId: candidate.id,
      destinationId: DESTINATION_ID,
    });
    const snapshot = await harness.storeSnapshot();
    const outcome = await harness.learning.publish({
      planId: prepared.plan.id,
      authorizationEvidence: { decision: "authorized" },
    });
    expect(outcome.status).toBe("blocked");
    expect(codes(outcome)).toEqual(["policy.blocked", "review.required"]);
    expect(harness.authority?.calls).toHaveLength(0);
    expect(harness.destination.calls.applyEffect).toBe(0);
    expect(await harness.storeSnapshot()).toBe(snapshot);
  });

  it("a rejected candidate is blocked with the review reasons", async () => {
    const harness = await createPublicationHarness();
    const { candidate } = await harness.learning.propose(candidateInput(harness.proposer));
    await harness.learning.reviewCandidate({
      id: "review-reject",
      candidateId: candidate.id,
      reviewer: reviewerFor(harness.reviewerB, (input) => ({
        candidateId: input.candidate.id,
        candidateDigest: input.candidate.contentDigest,
        disposition: "reject",
        findings: [{ code: "scope.too_broad", severity: "blocking", message: "narrow the scope" }],
      })),
    });
    const prepared = await harness.learning.preparePublication({
      candidateId: candidate.id,
      destinationId: DESTINATION_ID,
    });
    const outcome = await harness.learning.publish({
      planId: prepared.plan.id,
      authorizationEvidence: { decision: "authorized" },
    });
    expect(outcome.status).toBe("blocked");
    expect(codes(outcome)).toEqual(["policy.blocked", "review.blocked", "scope.too_broad"]);
    expect(harness.authority?.calls).toHaveLength(0);
    expect(harness.destination.calls.applyEffect).toBe(0);
  });

  it("a plan prepared under another registry revision or destination registration is blocked", async () => {
    const context = await preparedHarness();
    const rebuilt = inertDestination();
    const changed = await createPublicationHarness({
      store: context.harness.store,
      destination: rebuilt,
      registration: { riskFloor: "T2" },
    });
    const snapshot = await changed.storeSnapshot();
    const outcome = await changed.learning.publish({
      planId: context.plan.id,
      authorizationEvidence: { decision: "authorized" },
    });
    expect(outcome.status).toBe("blocked");
    expect(codes(outcome)).toEqual(["publication.binding_mismatch", "publication.binding_mismatch"]);
    expect(messagesAndCodes(outcome).map((diagnostic) => diagnostic.message)).toEqual([
      expect.stringMatching(/registry revision/),
      expect.stringMatching(/registration changed/),
    ]);
    expect(changed.authority?.calls).toHaveLength(0);
    expect(rebuilt.calls.applyEffect).toBe(0);
    expect(await changed.storeSnapshot()).toBe(snapshot);
  });

  it("a plan whose destination is no longer registered is blocked", async () => {
    const context = await preparedHarness();
    const without = await createPublicationHarness({ store: context.harness.store, omitDestinations: true });
    const outcome = await without.learning.publish({
      planId: context.plan.id,
      authorizationEvidence: { decision: "authorized" },
    });
    expect(outcome.status).toBe("blocked");
    expect(codes(outcome)).toContain("publication.binding_mismatch");
    expect(messagesAndCodes(outcome).some((diagnostic) => /not registered/.test(diagnostic.message))).toBe(true);
    expect(without.authority?.calls).toHaveLength(0);
  });

  it("an unknown plan id throws and touches nothing", async () => {
    const context = await preparedHarness();
    await expect(
      context.harness.learning.publish({ planId: "plan-missing", authorizationEvidence: { decision: "authorized" } }),
    ).rejects.toMatchObject({ name: "LearningLoopError", code: "publication.plan_not_found" });
    await expectNoWrite(context);
    expect(context.harness.authority?.calls).toHaveLength(0);
  });

  it("malformed publish input is refused at the unknown boundary", async () => {
    const context = await preparedHarness();
    const malformed: unknown = { authorizationEvidence: {} };
    await expect(context.harness.learning.publish(malformed as { planId: string })).rejects.toMatchObject({
      name: "LearningLoopError",
      code: "schema.invalid",
    });
    await expectNoWrite(context);
  });

  it("governance eligibility, authorization, and validation remain distinct after a refused publish", async () => {
    const context = await preparedHarness();
    const outcome = await context.harness.learning.publish({
      planId: context.plan.id,
      authorizationEvidence: { decision: "denied" },
    });
    expect(outcome.status).toBe("denied");
    const view = await context.harness.learning.getCandidateView({ candidateId: context.candidate.id });
    expect(view?.governance.review).toBe("accepted");
    // Eligible means policy permits a plan; it is not an authorization and not a publication.
    expect(view?.governance.publication).toBe("eligible");
    expect(view?.governance.validation).toBe("untested");
    await expectNoWrite(context);
  });
});
