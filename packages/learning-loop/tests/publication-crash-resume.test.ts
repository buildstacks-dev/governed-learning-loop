// Crash-resume conformance (contract §Conformance suites; decision 0026): a
// crash before or after EVERY journal write — consumption, header, scope
// membership, authorize edge, receipt, parent reversal edge, publish edge —
// leaves a state a reconstructed host forward-completes to the exact bytes
// of a clean run, applying each effect at the destination exactly once. A
// consumed authorization is never re-consulted, resume waits on the exact
// destination registration, and registry drift that leaves the registration
// intact does not strand a half-applied plan.
import { describe, expect, it } from "vitest";
import type { LearningStore } from "../src/index.js";
import { createInMemoryStore, createStructuredContentPolicy } from "../src/testing/index.js";
import {
  DESTINATION_ID,
  completed,
  createPublicationHarness,
  effectFor,
  faultStore,
  inertDestination,
  journalSnapshot,
  refused,
  scriptedAuthority,
  type DestinationSpy,
  type StoreFault,
} from "./publication-harness.js";

const BASE = "instructions-v7";

interface CleanRun {
  readonly journal: string;
  readonly planId: string;
  readonly interventionId: string;
}

async function cleanPublish(): Promise<CleanRun> {
  const harness = await createPublicationHarness();
  const candidate = await harness.acceptedCandidate();
  const prepared = await harness.learning.preparePublication({
    candidateId: candidate.id,
    destinationId: DESTINATION_ID,
    expectedBase: BASE,
  });
  completed(
    await harness.learning.publish({ planId: prepared.plan.id, authorizationEvidence: { decision: "authorized" } }),
  );
  return {
    journal: await journalSnapshot(harness.store),
    planId: prepared.plan.id,
    interventionId: `intervention-${prepared.plan.planDigest}`,
  };
}

const PUBLISH_FAULTS: readonly (StoreFault & {
  readonly expect: "published" | "resumed" | "no_op";
  readonly calls: number;
})[] = [
  { operation: "create", kind: "publication-authorization", when: "before", expect: "published", calls: 1 },
  { operation: "create", kind: "publication-authorization", when: "after", expect: "resumed", calls: 1 },
  { operation: "create", kind: "intervention", when: "before", expect: "resumed", calls: 1 },
  { operation: "create", kind: "intervention", when: "after", expect: "resumed", calls: 1 },
  { operation: "create", kind: "intervention-scope-index", when: "before", expect: "resumed", calls: 1 },
  { operation: "create", kind: "intervention-scope-index", when: "after", expect: "resumed", calls: 1 },
  { operation: "append", kind: "intervention-transition", occurrence: 1, when: "before", expect: "resumed", calls: 1 },
  { operation: "append", kind: "intervention-transition", occurrence: 1, when: "after", expect: "resumed", calls: 1 },
  // The destination acknowledged the effect but the receipt never landed:
  // the retry re-sends the same key and the conforming destination no-ops.
  { operation: "create", kind: "publication-receipt", when: "before", expect: "resumed", calls: 2 },
  { operation: "create", kind: "publication-receipt", when: "after", expect: "resumed", calls: 1 },
  { operation: "append", kind: "intervention-transition", occurrence: 2, when: "before", expect: "resumed", calls: 1 },
  { operation: "append", kind: "intervention-transition", occurrence: 2, when: "after", expect: "no_op", calls: 1 },
];

function label(fault: StoreFault): string {
  return `${fault.when} ${fault.operation} ${fault.kind}${fault.occurrence === undefined ? "" : ` #${fault.occurrence}`}`;
}

describe("crash-resume: publish plans", () => {
  for (const fault of PUBLISH_FAULTS) {
    it(`recovers from a crash ${label(fault)}`, async () => {
      const clean = await cleanPublish();
      const base = createInMemoryStore();
      const faulted = faultStore(base, fault);
      const destination = inertDestination();
      const crashed = await createPublicationHarness({ store: faulted.store, destination });
      const candidate = await crashed.acceptedCandidate();
      const prepared = await crashed.learning.preparePublication({
        candidateId: candidate.id,
        destinationId: DESTINATION_ID,
        expectedBase: BASE,
      });
      expect(prepared.plan.id).toBe(clean.planId);
      await expect(
        crashed.learning.publish({ planId: prepared.plan.id, authorizationEvidence: { decision: "authorized" } }),
      ).rejects.toThrow(/injected crash/);
      expect(faulted.fired()).toBe(true);
      expect(crashed.authority?.calls).toHaveLength(1);

      const rebuilt = await createPublicationHarness({ store: base, destination });
      const outcome = completed(
        await rebuilt.learning.publish({ planId: prepared.plan.id, authorizationEvidence: { decision: "authorized" } }),
      );
      expect(outcome.status).toBe(fault.expect);
      expect(outcome.intervention.state).toEqual({
        publication: "published",
        authorization: "authorized",
        activation: "active",
        validation: "untested",
      });
      expect(destination.memory.calls.applied).toBe(1);
      expect(destination.calls.applyEffect).toBe(fault.calls);
      expect(rebuilt.authority?.calls).toHaveLength(fault.expect === "published" ? 1 : 0);
      expect(await journalSnapshot(base)).toBe(clean.journal);

      const again = completed(
        await rebuilt.learning.publish({ planId: prepared.plan.id, authorizationEvidence: { decision: "authorized" } }),
      );
      expect(again.status).toBe("no_op");
      expect(destination.memory.calls.applied).toBe(1);
      expect(await rebuilt.learning.getIntervention({ interventionId: clean.interventionId })).toEqual(
        outcome.intervention,
      );
    });
  }

  it("a consumed authorization is never re-consulted, even when the host would now deny", async () => {
    const base = createInMemoryStore();
    const faulted = faultStore(base, { operation: "create", kind: "intervention", when: "before" });
    const destination = inertDestination();
    const crashed = await createPublicationHarness({ store: faulted.store, destination });
    const candidate = await crashed.acceptedCandidate();
    const prepared = await crashed.learning.preparePublication({
      candidateId: candidate.id,
      destinationId: DESTINATION_ID,
    });
    await expect(
      crashed.learning.publish({ planId: prepared.plan.id, authorizationEvidence: { decision: "authorized" } }),
    ).rejects.toThrow(/injected crash/);
    const denying = scriptedAuthority(() => ({ status: "denied", diagnostics: [] }));
    const rebuilt = await createPublicationHarness({ store: base, destination, authority: denying });
    const outcome = completed(await rebuilt.learning.publish({ planId: prepared.plan.id }));
    expect(outcome.status).toBe("resumed");
    expect(denying.calls).toHaveLength(0);
    expect(destination.memory.calls.applied).toBe(1);
  });

  it("resume waits, blocked, on the exact destination registration and completes once it is restored", async () => {
    const base = createInMemoryStore();
    const faulted = faultStore(base, { operation: "create", kind: "publication-receipt", when: "before" });
    const destination = inertDestination();
    const crashed = await createPublicationHarness({ store: faulted.store, destination });
    const candidate = await crashed.acceptedCandidate();
    const prepared = await crashed.learning.preparePublication({
      candidateId: candidate.id,
      destinationId: DESTINATION_ID,
    });
    await expect(
      crashed.learning.publish({ planId: prepared.plan.id, authorizationEvidence: { decision: "authorized" } }),
    ).rejects.toThrow(/injected crash/);
    expect(destination.calls.applyEffect).toBe(1);

    const changed = await createPublicationHarness({ store: base, destination, registration: { riskFloor: "T2" } });
    const snapshot = await journalSnapshot(base);
    const blocked = refused(await changed.learning.publish({ planId: prepared.plan.id }));
    expect(blocked.status).toBe("blocked");
    expect(blocked.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["publication.binding_mismatch"]);
    expect(blocked.diagnostics[0]?.message).toMatch(/registration changed/);
    expect(destination.calls.applyEffect).toBe(1);
    expect(await journalSnapshot(base)).toBe(snapshot);

    const unregistered = await createPublicationHarness({ store: base, destination, omitDestinations: true });
    const stillBlocked = refused(await unregistered.learning.publish({ planId: prepared.plan.id }));
    expect(stillBlocked.diagnostics[0]?.message).toMatch(/not registered/);

    const restored = await createPublicationHarness({ store: base, destination });
    const outcome = completed(await restored.learning.publish({ planId: prepared.plan.id }));
    expect(outcome.status).toBe("resumed");
    expect(destination.memory.calls.applied).toBe(1);
    expect(destination.calls.applyEffect).toBe(2);
  });

  it("resume forward-completes across a registry revision change that leaves the registration intact", async () => {
    const base = createInMemoryStore();
    const faulted = faultStore(base, {
      operation: "append",
      kind: "intervention-transition",
      occurrence: 2,
      when: "before",
    });
    const destination = inertDestination();
    const crashed = await createPublicationHarness({ store: faulted.store, destination });
    const candidate = await crashed.acceptedCandidate();
    const prepared = await crashed.learning.preparePublication({
      candidateId: candidate.id,
      destinationId: DESTINATION_ID,
    });
    await expect(
      crashed.learning.publish({ planId: prepared.plan.id, authorizationEvidence: { decision: "authorized" } }),
    ).rejects.toThrow(/injected crash/);

    const drifted = await createPublicationHarness({
      store: base,
      destination,
      extraContentPolicies: [createStructuredContentPolicy({ id: "another-policy" })],
    });
    const revision = (await drifted.learning.ingest(drifted.manual, { observations: [] })).registryRevision;
    expect(revision).not.toBe(prepared.plan.lineage.registryRevision);
    const outcome = completed(await drifted.learning.publish({ planId: prepared.plan.id }));
    expect(outcome.status).toBe("resumed");
    expect(destination.memory.calls.applied).toBe(1);
    expect(destination.calls.applyEffect).toBe(1);

    // A fresh plan under the drifted registry is a different plan; the old
    // one is complete and the new one is refused by binding drift as before.
    const fresh = await drifted.learning.preparePublication({
      candidateId: candidate.id,
      destinationId: DESTINATION_ID,
    });
    expect(fresh.plan.id).not.toBe(prepared.plan.id);
    const stale = await createPublicationHarness({ store: base, destination });
    const blocked = refused(await stale.learning.publish({ planId: fresh.plan.id, authorizationEvidence: {} }));
    expect(blocked.diagnostics.map((diagnostic) => diagnostic.code)).toContain("publication.binding_mismatch");
  });
});

// ---------------------------------------------------------------------------
// Reversal plans travel the same journal: consumption, header, membership,
// authorize edge, receipt, the PARENT's reversal edge, then the child's
// publish edge last.

interface ReversalRun {
  readonly journal: string;
  readonly publishPlanId: string;
  readonly disablePlanId: string;
  readonly parentId: string;
  readonly childId: string;
}

function twoEffectDestination(): DestinationSpy {
  return inertDestination({
    prepare: (input) => [
      effectFor(input.candidate, { expectedBase: BASE }),
      effectFor(input.candidate, { id: "effect-2", target: `${DESTINATION_ID}/AGENTS.md`, expectedBase: BASE }),
    ],
  });
}

async function publishThenPrepareDisable(store: LearningStore, destination: DestinationSpy) {
  const harness = await createPublicationHarness({ store, destination });
  const candidate = await harness.acceptedCandidate();
  const prepared = await harness.learning.preparePublication({
    candidateId: candidate.id,
    destinationId: DESTINATION_ID,
    expectedBase: BASE,
  });
  completed(
    await harness.learning.publish({ planId: prepared.plan.id, authorizationEvidence: { decision: "authorized" } }),
  );
  const disable = await harness.learning.preparePublication({
    candidateId: candidate.id,
    destinationId: DESTINATION_ID,
    action: "disable",
  });
  return { harness, candidate, publishPlan: prepared.plan, disablePlan: disable.plan };
}

async function cleanReversal(): Promise<ReversalRun> {
  const destination = twoEffectDestination();
  const { harness, publishPlan, disablePlan } = await publishThenPrepareDisable(createInMemoryStore(), destination);
  completed(
    await harness.learning.publish({ planId: disablePlan.id, authorizationEvidence: { decision: "authorized" } }),
  );
  return {
    journal: await journalSnapshot(harness.store),
    publishPlanId: publishPlan.id,
    disablePlanId: disablePlan.id,
    parentId: `intervention-${publishPlan.planDigest}`,
    childId: `intervention-${disablePlan.planDigest}`,
  };
}

const REVERSAL_FAULTS: readonly (StoreFault & {
  readonly expect: "published" | "resumed" | "no_op";
  readonly calls: number;
})[] = [
  { operation: "create", kind: "publication-authorization", when: "before", expect: "published", calls: 4 },
  { operation: "create", kind: "intervention", when: "after", expect: "resumed", calls: 4 },
  { operation: "create", kind: "intervention-scope-index", when: "before", expect: "resumed", calls: 4 },
  { operation: "append", kind: "intervention-transition", occurrence: 1, when: "after", expect: "resumed", calls: 4 },
  { operation: "create", kind: "publication-receipt", occurrence: 1, when: "before", expect: "resumed", calls: 5 },
  { operation: "create", kind: "publication-receipt", occurrence: 2, when: "after", expect: "resumed", calls: 4 },
  // The parent's reversal edge.
  { operation: "append", kind: "intervention-transition", occurrence: 2, when: "before", expect: "resumed", calls: 4 },
  { operation: "append", kind: "intervention-transition", occurrence: 2, when: "after", expect: "resumed", calls: 4 },
  // The child's publish edge, last.
  { operation: "append", kind: "intervention-transition", occurrence: 3, when: "before", expect: "resumed", calls: 4 },
  { operation: "append", kind: "intervention-transition", occurrence: 3, when: "after", expect: "no_op", calls: 4 },
];

describe("crash-resume: disable plans through the same journal", () => {
  for (const fault of REVERSAL_FAULTS) {
    it(`recovers from a crash ${label(fault)} while publishing the disable plan`, async () => {
      const clean = await cleanReversal();
      const base = createInMemoryStore();
      const faulted = faultStore(base, fault, { armed: false });
      const destination = twoEffectDestination();
      const { harness, publishPlan, disablePlan } = await publishThenPrepareDisable(faulted.store, destination);
      expect(publishPlan.id).toBe(clean.publishPlanId);
      expect(disablePlan.id).toBe(clean.disablePlanId);
      expect(destination.memory.calls.applied).toBe(2);
      faulted.arm();
      await expect(
        harness.learning.publish({ planId: disablePlan.id, authorizationEvidence: { decision: "authorized" } }),
      ).rejects.toThrow(/injected crash/);
      expect(faulted.fired()).toBe(true);

      const rebuilt = await createPublicationHarness({ store: base, destination });
      const outcome = completed(
        await rebuilt.learning.publish({ planId: disablePlan.id, authorizationEvidence: { decision: "authorized" } }),
      );
      expect(outcome.status).toBe(fault.expect);
      expect(outcome.intervention.id).toBe(clean.childId);
      expect(outcome.intervention.parentInterventionId).toBe(clean.parentId);
      expect(outcome.intervention.state.publication).toBe("published");
      expect(outcome.intervention.state.activation).toBe("inactive");
      const parent = await rebuilt.learning.getIntervention({ interventionId: clean.parentId });
      expect(parent?.state).toEqual({
        publication: "published",
        authorization: "authorized",
        activation: "disabled",
        validation: "untested",
      });
      // Two writes, two disables: every effect applied at the destination exactly once.
      expect(destination.memory.calls.applied).toBe(4);
      expect(destination.calls.applyEffect).toBe(fault.calls);
      expect(destination.memory.read(`${DESTINATION_ID}/CLAUDE.md`).content).toBeNull();
      expect(destination.memory.read(`${DESTINATION_ID}/AGENTS.md`).content).toBeNull();
      expect(await journalSnapshot(base)).toBe(clean.journal);

      const again = completed(await rebuilt.learning.publish({ planId: disablePlan.id }));
      expect(again.status).toBe("no_op");
      expect(destination.memory.calls.applied).toBe(4);
    });
  }
});
