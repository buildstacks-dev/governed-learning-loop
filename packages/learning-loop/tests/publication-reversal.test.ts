// Disable, rollback, and compensate are new bound plans through the same
// policy, authority, and journal path (decision 0026). They are prepared from
// the parent's journaled receipts and declared after-effects — never from a
// second adapter call — bind the exact parent intervention into the lineage
// closure, need authority but not a fresh decisive review, transition the
// parent without rewriting its history, and have no side door.
import { describe, expect, it } from "vitest";
import type { Candidate, PublicationPlan } from "../src/index.js";
import { sha256HexOfCanonicalJson } from "../src/index.js";
import { authorizationBindingForPlan, publicationEffectIdempotencyKey } from "../src/records/publication.js";
import { candidateInput, reviewerFor } from "./engine-harness.js";
import {
  DESTINATION_ID,
  completed,
  createPublicationHarness,
  effectFor,
  inertDestination,
  refused,
  type PublicationHarness,
  type PublicationHarnessOptions,
} from "./publication-harness.js";

const BASE = "instructions-v7";
const TARGET = `${DESTINATION_ID}/CLAUDE.md`;

async function expectRefusal(run: () => Promise<unknown>, code: string): Promise<void> {
  await expect(run()).rejects.toMatchObject({ name: "LearningLoopError", code });
}

async function publishCandidate(
  harness: PublicationHarness,
  candidate: Candidate,
  expectedBase: string | undefined = BASE,
): Promise<PublicationPlan> {
  const prepared = await harness.learning.preparePublication({
    candidateId: candidate.id,
    destinationId: DESTINATION_ID,
    ...(expectedBase !== undefined ? { expectedBase } : {}),
  });
  completed(
    await harness.learning.publish({ planId: prepared.plan.id, authorizationEvidence: { decision: "authorized" } }),
  );
  return prepared.plan;
}

async function publishedHarness(options: PublicationHarnessOptions = {}) {
  const harness = await createPublicationHarness(options);
  const candidate = await harness.acceptedCandidate();
  const plan = await publishCandidate(harness, candidate);
  return { harness, candidate, plan, parentId: `intervention-${plan.planDigest}` };
}

describe("reversal plans: disable, rollback, compensate", () => {
  it("prepares a disable plan from the parent's journaled receipts and declared after-effects, calling no adapter", async () => {
    const { harness, candidate, plan, parentId } = await publishedHarness();
    const callsBefore = { ...harness.destination.calls };
    const snapshot = await harness.storeSnapshot();
    const prepared = await harness.learning.preparePublication({
      candidateId: candidate.id,
      destinationId: DESTINATION_ID,
      action: "disable",
    });
    const disablePayload = { disables: { target: TARGET, effectId: "effect-1" } };
    expect(prepared.plan).toMatchObject({
      candidateId: candidate.id,
      candidateDigest: candidate.contentDigest,
      destinationId: DESTINATION_ID,
      action: "disable",
      effectClass: "context",
      effectiveRisk: "T1",
      effects: [
        {
          id: "effect-1",
          kind: "disable",
          target: TARGET,
          expectedBase: "v1",
          payload: disablePayload,
          payloadDigest: sha256HexOfCanonicalJson(disablePayload),
          afterEffect: { kind: "irreversible", rationale: expect.stringContaining("new publish plan") },
        },
      ],
      lineage: { ...plan.lineage, parentInterventionId: parentId },
      policyDigest: plan.policyDigest,
    });
    expect(prepared.plan.id).not.toBe(plan.id);
    expect(prepared.authorizationBinding.action).toBe("disable");
    expect(prepared.authorizationBinding.expectedBases).toEqual(["v1"]);
    // The parent enters the lineage closure the host approves.
    expect(prepared.authorizationBinding.lineageClosureDigest).not.toBe(
      authorizationBindingForPlan(plan).lineageClosureDigest,
    );
    expect(prepared.governance.review).toBe("accepted");
    expect(harness.destination.calls).toEqual(callsBefore);
    const added = JSON.parse(await harness.storeSnapshot()).length - JSON.parse(snapshot).length;
    expect(added).toBe(1); // exactly the new plan record

    // Idempotent: the same preparation returns the same plan and writes nothing.
    const again = await harness.learning.preparePublication({
      candidateId: candidate.id,
      destinationId: DESTINATION_ID,
      action: "disable",
    });
    expect(again.plan).toEqual(prepared.plan);
  });

  it("publishes the disable plan through authority and the journal, transitioning the parent without rewriting it", async () => {
    const { harness, candidate, plan, parentId } = await publishedHarness();
    const parentBefore = await harness.learning.getIntervention({ interventionId: parentId });
    const prepared = await harness.learning.preparePublication({
      candidateId: candidate.id,
      destinationId: DESTINATION_ID,
      action: "disable",
    });
    const outcome = completed(
      await harness.learning.publish({ planId: prepared.plan.id, authorizationEvidence: { decision: "authorized" } }),
    );
    expect(outcome.status).toBe("published");
    expect(harness.authority?.calls).toHaveLength(2);
    expect(harness.authority?.calls[1]?.binding.action).toBe("disable");
    expect(outcome.intervention).toMatchObject({
      id: `intervention-${prepared.plan.planDigest}`,
      candidateId: candidate.id,
      planId: prepared.plan.id,
      parentInterventionId: parentId,
      state: { publication: "published", authorization: "authorized", activation: "inactive", validation: "untested" },
      authorizationIds: [`authorization-${prepared.plan.planDigest}`],
    });
    const key = publicationEffectIdempotencyKey(prepared.plan.planDigest, "effect-1");
    expect(outcome.receipts).toEqual([
      expect.objectContaining({
        effectId: "effect-1",
        target: TARGET,
        expectedBase: "v1",
        finalVersion: "v2",
        idempotencyKey: key,
      }),
    ]);
    expect(harness.destination.applyInputs[1]?.effect.kind).toBe("disable");
    expect(harness.destination.memory.read(TARGET)).toMatchObject({ currentVersion: "v2", content: null });

    const parent = await harness.learning.getIntervention({ interventionId: parentId });
    expect(parent).toEqual({
      ...parentBefore,
      state: { publication: "published", authorization: "authorized", activation: "disabled", validation: "untested" },
      latestTransitionId: expect.stringMatching(/^transition-[0-9a-f]{64}$/),
    });
    expect(parent?.latestTransitionId).not.toBe(parentBefore?.latestTransitionId);
    expect(parent?.publicationReceiptIds).toEqual(parentBefore?.publicationReceiptIds);
    const stream = await harness.store.get({ namespace: "learning", kind: "intervention-transition", id: parentId });
    const entries: unknown = stream?.value;
    expect(Array.isArray(entries) ? entries.length : 0).toBe(3);
    expect(candidate.id).toBe(plan.candidateId);

    // Re-publishing the reversal is a no-op; the parent does not move again.
    const again = completed(await harness.learning.publish({ planId: prepared.plan.id }));
    expect(again.status).toBe("no_op");
    expect(harness.destination.memory.calls.applied).toBe(2);
  });

  it("rollback restores the declared content and rolls the parent back; the view reports the closed state", async () => {
    const destination = inertDestination({
      prepare: (input) => [
        effectFor(input.candidate, {
          expectedBase: BASE,
          afterEffect: { kind: "rollback", payload: { restore: null } },
        }),
      ],
    });
    const { harness, candidate, parentId } = await publishedHarness({ destination });
    expect(harness.destination.memory.read(TARGET).content).toEqual(candidate.intervention.content);
    await expectRefusal(
      () =>
        harness.learning.preparePublication({
          candidateId: candidate.id,
          destinationId: DESTINATION_ID,
          action: "disable",
        }),
      "publication.after_effect_unavailable",
    );
    const prepared = await harness.learning.preparePublication({
      candidateId: candidate.id,
      destinationId: DESTINATION_ID,
      action: "rollback",
    });
    expect(prepared.plan.effects[0]).toMatchObject({
      kind: "rollback",
      payload: { restore: null },
      expectedBase: "v1",
    });
    const outcome = completed(
      await harness.learning.publish({ planId: prepared.plan.id, authorizationEvidence: { decision: "authorized" } }),
    );
    expect(outcome.status).toBe("published");
    expect(harness.destination.memory.read(TARGET)).toMatchObject({ currentVersion: "v2", content: null });
    const parent = await harness.learning.getIntervention({ interventionId: parentId });
    expect(parent?.state).toEqual({
      publication: "rolled_back",
      authorization: "authorized",
      activation: "disabled",
      validation: "untested",
    });
    // Nothing permits a further reversal of a rolled-back parent.
    for (const action of ["disable", "rollback"] as const) {
      await expectRefusal(
        () => harness.learning.preparePublication({ candidateId: candidate.id, destinationId: DESTINATION_ID, action }),
        "publication.intervention_not_found",
      );
      await expectRefusal(
        () =>
          harness.learning.preparePublication({
            candidateId: candidate.id,
            destinationId: DESTINATION_ID,
            action,
            interventionId: parentId,
          }),
        "publication.parent_state_invalid",
      );
    }
  });

  it("compensate on a proposal destination deactivates the inert parent", async () => {
    const ticket = `${DESTINATION_ID}/ticket-1`;
    const destination = inertDestination({
      prepare: (input) => [
        effectFor(input.candidate, {
          target: ticket,
          expectedBase: BASE,
          afterEffect: { kind: "compensate", payload: { compensates: { target: ticket, effectId: "effect-1" } } },
        }),
      ],
    });
    const { harness, candidate, parentId } = await publishedHarness({
      destination,
      registration: { effectClass: "proposal" },
    });
    expect((await harness.learning.getIntervention({ interventionId: parentId }))?.state.activation).toBe("inactive");
    const prepared = await harness.learning.preparePublication({
      candidateId: candidate.id,
      destinationId: DESTINATION_ID,
      action: "compensate",
    });
    expect(prepared.plan.effects[0]?.kind).toBe("compensate");
    completed(
      await harness.learning.publish({ planId: prepared.plan.id, authorizationEvidence: { decision: "authorized" } }),
    );
    const parent = await harness.learning.getIntervention({ interventionId: parentId });
    expect(parent?.state).toEqual({
      publication: "published",
      authorization: "authorized",
      activation: "disabled",
      validation: "untested",
    });
    expect(harness.destination.memory.read(ticket).versions.map((version) => version.kind)).toEqual([
      "write",
      "compensate",
    ]);
  });

  it("refuses reversal preparation without a qualifying parent, an ambiguous parent, a mismatched named parent, a caller base, or a misplaced interventionId", async () => {
    const harness = await createPublicationHarness();
    const candidate = await harness.acceptedCandidate();
    for (const action of ["disable", "rollback", "compensate"] as const) {
      await expectRefusal(
        () => harness.learning.preparePublication({ candidateId: candidate.id, destinationId: DESTINATION_ID, action }),
        "publication.intervention_not_found",
      );
    }
    await expectRefusal(
      () =>
        harness.learning.preparePublication({
          candidateId: candidate.id,
          destinationId: DESTINATION_ID,
          action: "disable",
          interventionId: "intervention-missing",
        }),
      "publication.intervention_not_found",
    );
    await expectRefusal(
      () =>
        harness.learning.preparePublication({
          candidateId: candidate.id,
          destinationId: DESTINATION_ID,
          action: "disable",
          expectedBase: "v1",
        }),
      "schema.invalid",
    );
    await expectRefusal(
      () =>
        harness.learning.preparePublication({
          candidateId: candidate.id,
          destinationId: DESTINATION_ID,
          interventionId: "intervention-x",
        }),
      "schema.invalid",
    );
    expect(harness.destination.calls).toEqual({ prepare: 0, applyEffect: 0 });

    const first = await publishCandidate(harness, candidate, BASE);
    const second = await publishCandidate(harness, candidate, "instructions-v8");
    expect(second.id).not.toBe(first.id);
    await expectRefusal(
      () =>
        harness.learning.preparePublication({
          candidateId: candidate.id,
          destinationId: DESTINATION_ID,
          action: "disable",
        }),
      "publication.intervention_ambiguous",
    );
    const named = await harness.learning.preparePublication({
      candidateId: candidate.id,
      destinationId: DESTINATION_ID,
      action: "disable",
      interventionId: `intervention-${first.planDigest}`,
    });
    expect(named.plan.lineage.parentInterventionId).toBe(`intervention-${first.planDigest}`);
    expect(named.plan.effects[0]?.expectedBase).toBe("v1");
    const other = await harness.learning.propose(
      candidateInput(harness.proposer, { id: "cand-other", hypothesis: "Another hypothesis entirely." }),
    );
    await expectRefusal(
      () =>
        harness.learning.preparePublication({
          candidateId: other.candidate.id,
          destinationId: DESTINATION_ID,
          action: "disable",
          interventionId: `intervention-${first.planDigest}`,
        }),
      "publication.intervention_mismatch",
    );
    // A reversal of a reversal is not a thing: a child cannot be a parent.
    completed(
      await harness.learning.publish({ planId: named.plan.id, authorizationEvidence: { decision: "authorized" } }),
    );
    await expectRefusal(
      () =>
        harness.learning.preparePublication({
          candidateId: candidate.id,
          destinationId: DESTINATION_ID,
          action: "disable",
          interventionId: `intervention-${named.plan.planDigest}`,
        }),
      "publication.intervention_mismatch",
    );
  });

  it("blocks a reversal plan at publish time once the parent state has moved past it, writing nothing", async () => {
    const destination = inertDestination({
      prepare: (input) => [
        effectFor(input.candidate, { expectedBase: BASE }),
        effectFor(input.candidate, {
          id: "effect-2",
          target: `${DESTINATION_ID}/AGENTS.md`,
          expectedBase: BASE,
          afterEffect: { kind: "rollback", payload: { restore: null } },
        }),
      ],
    });
    const { harness, candidate, parentId } = await publishedHarness({ destination });
    const disable = await harness.learning.preparePublication({
      candidateId: candidate.id,
      destinationId: DESTINATION_ID,
      action: "disable",
    });
    expect(disable.plan.effects.map((effect) => effect.id)).toEqual(["effect-1"]);
    const rollback = await harness.learning.preparePublication({
      candidateId: candidate.id,
      destinationId: DESTINATION_ID,
      action: "rollback",
    });
    expect(rollback.plan.effects.map((effect) => effect.id)).toEqual(["effect-2"]);
    completed(
      await harness.learning.publish({ planId: rollback.plan.id, authorizationEvidence: { decision: "authorized" } }),
    );
    expect((await harness.learning.getIntervention({ interventionId: parentId }))?.state.publication).toBe(
      "rolled_back",
    );
    const snapshot = await harness.storeSnapshot();
    const calls = harness.destination.calls.applyEffect;
    const blocked = refused(
      await harness.learning.publish({ planId: disable.plan.id, authorizationEvidence: { decision: "authorized" } }),
    );
    expect(blocked.status).toBe("blocked");
    expect(blocked.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["publication.parent_state_invalid"]);
    expect(harness.destination.calls.applyEffect).toBe(calls);
    expect(await harness.storeSnapshot()).toBe(snapshot);
    expect(harness.authority?.calls).toHaveLength(2);
  });

  it("a reversal needs authority, not a fresh decisive review: a later rejection is a reason to reverse, not a bar", async () => {
    const { harness, candidate } = await publishedHarness();
    await harness.learning.reviewCandidate({
      id: "review-later-reject",
      candidateId: candidate.id,
      reviewer: reviewerFor(harness.reviewerB, (input) => ({
        candidateId: input.candidate.id,
        candidateDigest: input.candidate.contentDigest,
        disposition: "reject",
        findings: [{ code: "regressed.in.production", severity: "blocking", message: "roll this back" }],
      })),
    });
    const view = await harness.learning.getCandidateView({ candidateId: candidate.id });
    expect(view?.governance.review).toBe("blocked");
    expect(view?.governance.publication).toBe("blocked");
    const prepared = await harness.learning.preparePublication({
      candidateId: candidate.id,
      destinationId: DESTINATION_ID,
      action: "disable",
    });
    expect(prepared.governance.review).toBe("blocked");
    const denied = refused(
      await harness.learning.publish({ planId: prepared.plan.id, authorizationEvidence: { decision: "denied" } }),
    );
    expect(denied.status).toBe("denied");
    expect(harness.destination.calls.applyEffect).toBe(1);
    const outcome = completed(
      await harness.learning.publish({ planId: prepared.plan.id, authorizationEvidence: { decision: "authorized" } }),
    );
    expect(outcome.status).toBe("published");
    expect(harness.destination.memory.read(TARGET).content).toBeNull();
  });

  it("reverses only the applied effects of a failed parent", async () => {
    let offline = true;
    const destination = inertDestination({
      prepare: (input) => [
        effectFor(input.candidate, { expectedBase: BASE }),
        effectFor(input.candidate, { id: "effect-2", target: `${DESTINATION_ID}/AGENTS.md`, expectedBase: BASE }),
      ],
      applyEffect: async (input) => {
        if (input.effect.id === "effect-2" && offline) throw new Error("destination offline");
        const { expectedBase, ...unbased } = input.effect;
        const receipt = await destination.memory.applyEffect({ effect: unbased, idempotencyKey: input.idempotencyKey });
        return expectedBase === undefined ? receipt : { ...receipt, expectedBase };
      },
    });
    const harness = await createPublicationHarness({ destination });
    const candidate = await harness.acceptedCandidate();
    const prepared = await harness.learning.preparePublication({
      candidateId: candidate.id,
      destinationId: DESTINATION_ID,
      expectedBase: BASE,
    });
    expect(
      refused(
        await harness.learning.publish({ planId: prepared.plan.id, authorizationEvidence: { decision: "authorized" } }),
      ).status,
    ).toBe("failed");
    const parentId = `intervention-${prepared.plan.planDigest}`;
    const disable = await harness.learning.preparePublication({
      candidateId: candidate.id,
      destinationId: DESTINATION_ID,
      action: "disable",
    });
    expect(disable.plan.effects.map((effect) => effect.id)).toEqual(["effect-1"]);
    offline = false;
    completed(
      await harness.learning.publish({ planId: disable.plan.id, authorizationEvidence: { decision: "authorized" } }),
    );
    const parent = await harness.learning.getIntervention({ interventionId: parentId });
    expect(parent?.state).toEqual({
      publication: "failed",
      authorization: "authorized",
      activation: "disabled",
      validation: "untested",
    });
    expect(harness.destination.memory.read(TARGET).content).toBeNull();
    expect(harness.destination.memory.read(`${DESTINATION_ID}/AGENTS.md`).versions).toEqual([]);
  });

  it("has no side door: reversal preparation performs no adapter call and the façade exposes no direct reversal", async () => {
    const { harness, candidate } = await publishedHarness();
    const before = { ...harness.destination.calls };
    for (const action of ["disable"] as const) {
      await harness.learning.preparePublication({ candidateId: candidate.id, destinationId: DESTINATION_ID, action });
    }
    expect(harness.destination.calls).toEqual(before);
    expect(harness.destination.memory.calls.applied).toBe(1);
    expect(Object.keys(harness.learning).filter((name) => /disable|rollback|compensate|apply/i.test(name))).toEqual([]);
  });
});
