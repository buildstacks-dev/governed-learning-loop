// learning.publish as the journaled idempotent publisher (decision 0026):
// exact receipts under kernel idempotency keys, a durable authorization
// consumption, append-only intervention history, no-op retries, journaled
// adapter failure that stays resumable, receipt verification, superseded
// refusal, convergence under concurrency, and kernel invariant 3 —
// authorized and validated are permanently distinct records.
import { describe, expect, it } from "vitest";
import type { InterventionTransition, PublicationReceipt } from "../src/index.js";
import {
  authorizationBindingDigest,
  parseInterventionRecord,
  parseInterventionTransition,
  sha256HexOfCanonicalJson,
} from "../src/index.js";
import { authorizationBindingForPlan, publicationEffectIdempotencyKey } from "../src/records/publication.js";
import { createInMemoryStore } from "../src/testing/index.js";
import { candidateInput } from "./engine-harness.js";
import {
  DESTINATION_ID,
  NOW,
  completed,
  createPublicationHarness,
  effectFor,
  faultStore,
  inertDestination,
  refused,
  scriptedAuthority,
  type PublicationHarnessOptions,
} from "./publication-harness.js";

const BASE = "instructions-v7";
const TARGET = `${DESTINATION_ID}/CLAUDE.md`;

async function publishedHarness(options: PublicationHarnessOptions = {}) {
  const harness = await createPublicationHarness(options);
  const candidate = await harness.acceptedCandidate();
  const prepared = await harness.learning.preparePublication({
    candidateId: candidate.id,
    destinationId: DESTINATION_ID,
    expectedBase: BASE,
  });
  const before = await harness.storeSnapshot();
  const outcome = await harness.learning.publish({
    planId: prepared.plan.id,
    authorizationEvidence: { decision: "authorized" },
  });
  return { harness, candidate, plan: prepared.plan, binding: prepared.authorizationBinding, outcome, before };
}

async function transitionsOf(
  store: Awaited<ReturnType<typeof createPublicationHarness>>["store"],
  interventionId: string,
): Promise<readonly InterventionTransition[]> {
  const stored = await store.get({ namespace: "learning", kind: "intervention-transition", id: interventionId });
  if (stored === undefined) return [];
  const entries: unknown = stored.value;
  if (!Array.isArray(entries)) throw new Error("transition stream must be an array");
  return entries.map((entry: unknown) => {
    if (typeof entry !== "object" || entry === null || !("value" in entry)) throw new Error("malformed entry");
    return parseInterventionTransition(entry.value);
  });
}

function addedKinds(before: string, after: string): readonly string[] {
  const previous = new Set(JSON.parse(before).map((entry: unknown) => JSON.stringify(entry)));
  return JSON.parse(after)
    .filter((entry: unknown) => !previous.has(JSON.stringify(entry)))
    .map((entry: readonly [string, string, string]) => entry[0])
    .sort();
}

describe("learning.publish: the journaled publisher", () => {
  it("publishes exactly once and returns the folded intervention with verified receipts", async () => {
    const { harness, candidate, plan, outcome, before } = await publishedHarness();
    const key = publicationEffectIdempotencyKey(plan.planDigest, "effect-1");
    expect(key).toBe(
      sha256HexOfCanonicalJson({
        domain: "publication-effect-idempotency:v1",
        planDigest: plan.planDigest,
        effectId: "effect-1",
      }),
    );
    const done = completed(outcome);
    expect(done.status).toBe("published");
    expect(Object.isFrozen(done)).toBe(true);
    expect(done.intervention).toEqual({
      schemaVersion: 1,
      id: `intervention-${plan.planDigest}`,
      candidateId: candidate.id,
      planId: plan.id,
      state: { publication: "published", authorization: "authorized", activation: "active", validation: "untested" },
      publicationReceiptIds: [`receipt-${key}`],
      authorizationIds: [`authorization-${plan.planDigest}`],
      evaluationIds: [],
      latestTransitionId: expect.stringMatching(/^transition-[0-9a-f]{64}$/),
    });
    expect(parseInterventionRecord(done.intervention)).toEqual(done.intervention);
    const receipt: PublicationReceipt = {
      destinationId: DESTINATION_ID,
      effectId: "effect-1",
      target: TARGET,
      expectedBase: BASE,
      finalVersion: "v1",
      payloadDigest: plan.effects[0]?.payloadDigest ?? "",
      idempotencyKey: key,
      appliedAt: NOW,
    };
    expect(done.receipts).toEqual([receipt]);

    expect(harness.destination.calls).toEqual({ prepare: 1, applyEffect: 1 });
    expect(harness.destination.applyInputs[0]).toEqual({ effect: plan.effects[0], idempotencyKey: key });
    expect(Object.isFrozen(harness.destination.applyInputs[0]?.effect)).toBe(true);
    expect(harness.destination.memory.read(TARGET).content).toEqual(candidate.intervention.content);
    expect(harness.destination.memory.calls.applied).toBe(1);
    expect(harness.authority?.calls).toHaveLength(1);

    expect(addedKinds(before, await harness.storeSnapshot())).toEqual([
      "intervention",
      "intervention-scope-index",
      "intervention-transition",
      "publication-authorization",
      "publication-receipt",
    ]);
    expect(await harness.learning.getIntervention({ interventionId: done.intervention.id })).toEqual(done.intervention);
  });

  it("journals the authorize edge before the publish edge, each with exact evidence, after a durable consumption", async () => {
    const { harness, plan, binding, outcome } = await publishedHarness();
    const done = completed(outcome);
    const transitions = await transitionsOf(harness.store, done.intervention.id);
    expect(transitions.map((transition) => [transition.from, transition.to])).toEqual([
      [
        { publication: "unpublished", authorization: "pending", activation: "inactive", validation: "untested" },
        { publication: "unpublished", authorization: "authorized", activation: "inactive", validation: "untested" },
      ],
      [
        { publication: "unpublished", authorization: "authorized", activation: "inactive", validation: "untested" },
        { publication: "published", authorization: "authorized", activation: "active", validation: "untested" },
      ],
    ]);
    expect(transitions[0]?.evidenceIds).toEqual([`authorization-${plan.planDigest}`]);
    expect(transitions[1]?.evidenceIds).toEqual(done.intervention.publicationReceiptIds);
    expect(transitions[1]?.id).toBe(done.intervention.latestTransitionId);
    expect(transitions.every((transition) => transition.occurredAt === NOW)).toBe(true);

    const consumption = await harness.store.get({
      namespace: "learning",
      kind: "publication-authorization",
      id: `authorization-${plan.planDigest}`,
    });
    expect(consumption?.value).toMatchObject({
      schemaVersion: 1,
      planId: plan.id,
      planDigest: plan.planDigest,
      bindingDigest: authorizationBindingDigest(binding),
      authorization: {
        id: "approval-1",
        principal: { id: "approver-h", kind: "human", independenceDomain: "ops" },
        bindingDigest: authorizationBindingDigest(authorizationBindingForPlan(plan)),
      },
      registryRevision: plan.lineage.registryRevision,
      policyDigest: plan.policyDigest,
      consumedAt: NOW,
    });
  });

  it("a retry of a completed plan is a no-op that consults neither authority nor destination", async () => {
    const { harness, plan, outcome } = await publishedHarness();
    const first = completed(outcome);
    const snapshot = await harness.storeSnapshot();
    for (const input of [
      { planId: plan.id, authorizationEvidence: { decision: "authorized" } },
      { planId: plan.id },
      { planId: plan.id, authorizationEvidence: { decision: "denied" } },
    ]) {
      const again = completed(await harness.learning.publish(input));
      expect(again.status).toBe("no_op");
      expect(again.intervention).toEqual(first.intervention);
      expect(again.receipts).toEqual(first.receipts);
    }
    expect(harness.destination.calls.applyEffect).toBe(1);
    expect(harness.authority?.calls).toHaveLength(1);
    expect(await harness.storeSnapshot()).toBe(snapshot);

    // A reconstructed host whose authority would now deny still no-ops: the
    // consumption is the durable fact, not the host's current mood.
    const denying = scriptedAuthority(() => ({ status: "denied", diagnostics: [] }));
    const rebuilt = await createPublicationHarness({
      store: harness.store,
      destination: harness.destination,
      authority: denying,
    });
    const later = completed(await rebuilt.learning.publish({ planId: plan.id, authorizationEvidence: {} }));
    expect(later.status).toBe("no_op");
    expect(denying.calls).toHaveLength(0);
  });

  it("keeps governance eligibility, authorization, and validation permanently distinct (kernel invariant 3)", async () => {
    const { harness, candidate, outcome } = await publishedHarness();
    const done = completed(outcome);
    const view = await harness.learning.getCandidateView({ candidateId: candidate.id });
    expect(view?.governance).toMatchObject({ review: "accepted", publication: "eligible", validation: "untested" });
    expect(done.intervention.state.authorization).toBe("authorized");
    expect(done.intervention.state.validation).toBe("untested");
    expect(done.intervention.evaluationIds).toEqual([]);
    expect(() =>
      parseInterventionRecord({ ...done.intervention, state: { ...done.intervention.state, validation: "improved" } }),
    ).toThrow(expect.objectContaining({ code: "schema.invalid" }));
    for (const forbidden of ["validate", "markValidated", "activate", "applyEffect", "disable", "rollback"]) {
      expect(forbidden in harness.learning).toBe(false);
    }
  });

  it("applies a multi-effect plan in order under distinct keys and records every receipt", async () => {
    const targets = ["CLAUDE.md", "AGENTS.md", "README.md"].map((name) => `${DESTINATION_ID}/${name}`);
    const destination = inertDestination({
      prepare: (input) =>
        targets.map((target, index) =>
          effectFor(input.candidate, { id: `effect-${index + 1}`, target, expectedBase: BASE }),
        ),
    });
    const { harness, plan, outcome } = await publishedHarness({ destination });
    const done = completed(outcome);
    expect(done.receipts.map((receipt) => [receipt.effectId, receipt.target, receipt.finalVersion])).toEqual(
      targets.map((target, index) => [`effect-${index + 1}`, target, "v1"]),
    );
    const keys = done.receipts.map((receipt) => receipt.idempotencyKey);
    expect(new Set(keys).size).toBe(3);
    expect(keys).toEqual(plan.effects.map((effect) => publicationEffectIdempotencyKey(plan.planDigest, effect.id)));
    expect(harness.destination.applyInputs.map((input) => input.effect.id)).toEqual([
      "effect-1",
      "effect-2",
      "effect-3",
    ]);
    expect(done.intervention.publicationReceiptIds).toEqual(keys.map((key) => `receipt-${key}`));
    expect(harness.destination.memory.calls.applied).toBe(3);
  });

  it("a proposal-class destination publishes an inert, inactive intervention", async () => {
    const destination = inertDestination({
      prepare: (input) => [
        effectFor(input.candidate, {
          target: `${DESTINATION_ID}/ticket-1`,
          expectedBase: BASE,
          afterEffect: {
            kind: "compensate",
            payload: { compensates: { target: `${DESTINATION_ID}/ticket-1`, effectId: "effect-1" } },
          },
        }),
      ],
    });
    const { outcome } = await publishedHarness({ destination, registration: { effectClass: "proposal" } });
    expect(completed(outcome).intervention.state).toEqual({
      publication: "published",
      authorization: "authorized",
      activation: "inactive",
      validation: "untested",
    });
  });

  it("journals an adapter failure as failed, keeps the applied receipts, and resumes the same plan later", async () => {
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
    const { harness, plan, outcome } = await publishedHarness({ destination });
    const failed = refused(outcome);
    expect(failed.status).toBe("failed");
    expect(failed.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "publication.destination_failed",
      "publication.destination_failed",
    ]);
    expect(failed.diagnostics[1]?.message).toBe("destination offline");
    const interventionId = `intervention-${plan.planDigest}`;
    const afterFailure = await harness.learning.getIntervention({ interventionId });
    expect(afterFailure?.state).toEqual({
      publication: "failed",
      authorization: "authorized",
      activation: "inactive",
      validation: "untested",
    });
    expect(afterFailure?.publicationReceiptIds).toEqual([
      `receipt-${publicationEffectIdempotencyKey(plan.planDigest, "effect-1")}`,
    ]);
    expect((await transitionsOf(harness.store, interventionId)).length).toBe(2);
    expect(harness.destination.memory.calls.applied).toBe(1);

    const stillFailed = refused(
      await harness.learning.publish({ planId: plan.id, authorizationEvidence: { decision: "authorized" } }),
    );
    expect(stillFailed.status).toBe("failed");
    expect((await transitionsOf(harness.store, interventionId)).length).toBe(2);
    expect(harness.destination.applyInputs.map((input) => input.effect.id)).toEqual([
      "effect-1",
      "effect-2",
      "effect-2",
    ]);

    offline = false;
    const resumed = completed(
      await harness.learning.publish({ planId: plan.id, authorizationEvidence: { decision: "authorized" } }),
    );
    expect(resumed.status).toBe("resumed");
    expect(resumed.intervention.state.publication).toBe("published");
    expect(resumed.intervention.state.activation).toBe("active");
    expect(resumed.receipts.map((receipt) => receipt.effectId)).toEqual(["effect-1", "effect-2"]);
    expect((await transitionsOf(harness.store, interventionId)).map((transition) => transition.to.publication)).toEqual(
      ["unpublished", "failed", "published"],
    );
    expect(harness.destination.memory.calls.applied).toBe(2);
    expect(harness.destination.applyInputs.map((input) => input.effect.id)).toEqual([
      "effect-1",
      "effect-2",
      "effect-2",
      "effect-2",
    ]);
    expect(harness.authority?.calls).toHaveLength(1);
  });

  it("fails a plan whose destination returns a receipt that does not prove the exact effect", async () => {
    const cases: readonly {
      readonly name: string;
      readonly code: string;
      readonly receipt: (input: {
        readonly effect: { readonly payloadDigest: string; readonly target: string };
        readonly idempotencyKey: string;
      }) => unknown;
    }[] = [
      {
        name: "another payload",
        code: "publication.receipt_mismatch",
        receipt: (input) => ({
          destinationId: DESTINATION_ID,
          effectId: "effect-1",
          target: input.effect.target,
          expectedBase: BASE,
          payloadDigest: "0".repeat(64),
          idempotencyKey: input.idempotencyKey,
          appliedAt: NOW,
        }),
      },
      {
        name: "another key",
        code: "publication.receipt_mismatch",
        receipt: (input) => ({
          destinationId: DESTINATION_ID,
          effectId: "effect-1",
          target: input.effect.target,
          expectedBase: BASE,
          payloadDigest: input.effect.payloadDigest,
          idempotencyKey: "k".repeat(64),
          appliedAt: NOW,
        }),
      },
      {
        name: "no base",
        code: "publication.receipt_mismatch",
        receipt: (input) => ({
          destinationId: DESTINATION_ID,
          effectId: "effect-1",
          target: input.effect.target,
          payloadDigest: input.effect.payloadDigest,
          idempotencyKey: input.idempotencyKey,
          appliedAt: NOW,
        }),
      },
      { name: "an unparseable value", code: "publication.receipt_invalid", receipt: () => ({ ok: true }) },
    ];
    for (const example of cases) {
      const destination = inertDestination({ applyEffect: (input) => example.receipt(input) });
      const { harness, plan, outcome } = await publishedHarness({ destination });
      const failed = refused(outcome);
      expect(failed.status, example.name).toBe("failed");
      expect(failed.diagnostics[0]?.code, example.name).toBe(example.code);
      const intervention = await harness.learning.getIntervention({
        interventionId: `intervention-${plan.planDigest}`,
      });
      expect(intervention?.state.publication, example.name).toBe("failed");
      expect(intervention?.publicationReceiptIds, example.name).toEqual([]);
      const receipts = await harness.store.list({ namespace: "learning", kind: "publication-receipt", limit: 10 });
      expect(receipts.records, example.name).toEqual([]);
    }
  });

  it("refuses to publish a superseded candidate before any write and without consulting authority", async () => {
    const harness = await createPublicationHarness();
    const candidate = await harness.acceptedCandidate();
    const prepared = await harness.learning.preparePublication({
      candidateId: candidate.id,
      destinationId: DESTINATION_ID,
      expectedBase: BASE,
    });
    await harness.learning.propose(
      candidateInput(harness.proposer, {
        id: "cand-2",
        hypothesis: "A revised hypothesis supersedes the first.",
        supersedes: candidate.id,
      }),
    );
    const snapshot = await harness.storeSnapshot();
    const outcome = refused(
      await harness.learning.publish({ planId: prepared.plan.id, authorizationEvidence: { decision: "authorized" } }),
    );
    expect(outcome.status).toBe("blocked");
    expect(outcome.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["publication.candidate_superseded"]);
    expect(outcome.diagnostics[0]?.message).toContain("cand-2");
    expect(harness.authority?.calls).toHaveLength(0);
    expect(harness.destination.calls.applyEffect).toBe(0);
    expect(await harness.storeSnapshot()).toBe(snapshot);
  });

  it("two concurrent publishes of one plan converge on one journal and one destination effect", async () => {
    const harness = await createPublicationHarness();
    const candidate = await harness.acceptedCandidate();
    const prepared = await harness.learning.preparePublication({
      candidateId: candidate.id,
      destinationId: DESTINATION_ID,
      expectedBase: BASE,
    });
    const input = { planId: prepared.plan.id, authorizationEvidence: { decision: "authorized" } };
    const outcomes = await Promise.all([harness.learning.publish(input), harness.learning.publish(input)]);
    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(["published", "resumed"]);
    const [first, second] = outcomes.map(completed);
    expect(second?.intervention).toEqual(first?.intervention);
    expect(harness.destination.memory.calls.applied).toBe(1);
    for (const kind of ["publication-authorization", "intervention", "publication-receipt"]) {
      expect((await harness.store.list({ namespace: "learning", kind, limit: 10 })).records).toHaveLength(1);
    }
    expect((await transitionsOf(harness.store, `intervention-${prepared.plan.planDigest}`)).length).toBe(2);
  });

  it("getIntervention is a pure exact read: unknown ids and unborn headers read as absent", async () => {
    expect(
      await (await createPublicationHarness()).learning.getIntervention({ interventionId: "intervention-x" }),
    ).toBe(undefined);
    const base = createInMemoryStore();
    const faulted = faultStore(base, { operation: "append", kind: "intervention-transition", when: "before" });
    const destination = inertDestination();
    const harness = await createPublicationHarness({ store: faulted.store, destination });
    const candidate = await harness.acceptedCandidate();
    const prepared = await harness.learning.preparePublication({
      candidateId: candidate.id,
      destinationId: DESTINATION_ID,
    });
    await expect(
      harness.learning.publish({ planId: prepared.plan.id, authorizationEvidence: { decision: "authorized" } }),
    ).rejects.toThrow(/injected crash/);
    const interventionId = `intervention-${prepared.plan.planDigest}`;
    const rebuilt = await createPublicationHarness({ store: base, destination });
    expect(await rebuilt.store.get({ namespace: "learning", kind: "intervention", id: interventionId })).toBeDefined();
    expect(await rebuilt.learning.getIntervention({ interventionId })).toBeUndefined();
    const snapshot = await rebuilt.storeSnapshot();
    expect(await rebuilt.storeSnapshot()).toBe(snapshot);
    const resumed = completed(
      await rebuilt.learning.publish({ planId: prepared.plan.id, authorizationEvidence: { decision: "authorized" } }),
    );
    expect(resumed.status).toBe("resumed");
    expect(await rebuilt.learning.getIntervention({ interventionId })).toEqual(resumed.intervention);
    const malformed: unknown = {};
    await expect(rebuilt.learning.getIntervention(malformed as { interventionId: string })).rejects.toMatchObject({
      code: "schema.invalid",
    });
  });
});
