// learning.resolveContext (contract §The façade, §Intervention, exposure, and
// efficacy; decision 0027): only published, authorized, active, context-class
// interventions of the exact scope and its policy ancestors resolve; a
// candidate never resolves (kernel invariant 1); disabled, rolled-back,
// failed, inactive, and non-context interventions are excluded; a superseded
// version that is still active and a drifted destination registration refuse
// visibly; the budget is a precedence-ordered prefix with visible omissions;
// and the receipt is content-addressed, idempotent, and frozen.
import { describe, expect, it } from "vitest";
import type { Candidate, InterventionRecord, PublicationPlan, Scope, ScopePolicy } from "../src/index.js";
import {
  canonicalJsonText,
  conservativePolicy,
  parseResolvedContext,
  scopeDigest,
  sha256HexOfCanonicalJson,
  toJsonValue,
} from "../src/index.js";
import { createExactScopePolicy, createInMemoryStore, createStructuredContentPolicy } from "../src/testing/index.js";
import { SCOPE, type candidateInput } from "./engine-harness.js";
import {
  DESTINATION_ID,
  NOW,
  completed,
  createPublicationHarness,
  effectFor,
  inertDestination,
  type PublicationHarness,
  type PublicationHarnessOptions,
} from "./publication-harness.js";

const BASE = "instructions-v7";
const EPISODE_ID = "change-57";
const QUERY = { taskClass: "typescript-code-change", text: "Add an optional retry policy to the client." };
const BUDGET = { maximumEntries: 8, maximumCharacters: 4_000 };
const SECOND_CONTENT = { text: "Prefer small, reviewable commits." };

type CandidateOverrides = Parameters<typeof candidateInput>[1];

function resolveInput(overrides: Record<string, unknown> = {}) {
  return { episodeId: EPISODE_ID, scope: SCOPE, query: QUERY, budget: BUDGET, ...overrides };
}

function secondCandidate(extra: CandidateOverrides = {}): CandidateOverrides {
  return {
    id: "cand-2",
    intervention: {
      destinationId: DESTINATION_ID,
      kind: "procedure",
      content: SECOND_CONTENT,
      rollbackIntent: "Disable this instruction version.",
    },
    ...extra,
  };
}

interface Published {
  readonly candidate: Candidate;
  readonly plan: PublicationPlan;
  readonly intervention: InterventionRecord;
}

async function publishCandidate(harness: PublicationHarness, candidate: Candidate): Promise<Published> {
  const prepared = await harness.learning.preparePublication({
    candidateId: candidate.id,
    destinationId: DESTINATION_ID,
    expectedBase: BASE,
  });
  const done = completed(
    await harness.learning.publish({ planId: prepared.plan.id, authorizationEvidence: { decision: "authorized" } }),
  );
  return { candidate, plan: prepared.plan, intervention: done.intervention };
}

async function acceptAndPublish(harness: PublicationHarness, overrides: CandidateOverrides = {}): Promise<Published> {
  return publishCandidate(harness, await harness.acceptedCandidate(overrides));
}

async function reverse(
  harness: PublicationHarness,
  candidate: Candidate,
  action: "disable" | "rollback",
): Promise<InterventionRecord> {
  const prepared = await harness.learning.preparePublication({
    candidateId: candidate.id,
    destinationId: DESTINATION_ID,
    action,
  });
  return completed(
    await harness.learning.publish({ planId: prepared.plan.id, authorizationEvidence: { decision: "authorized" } }),
  ).intervention;
}

function addedKinds(before: string, after: string): readonly string[] {
  const previous = new Set(JSON.parse(before).map((entry: unknown) => JSON.stringify(entry)));
  return JSON.parse(after)
    .filter((entry: unknown) => !previous.has(JSON.stringify(entry)))
    .map((entry: readonly [string, string, string]) => entry[0])
    .sort();
}

async function expectRefusal(run: () => Promise<unknown>, code: string): Promise<void> {
  await expect(run()).rejects.toMatchObject({ name: "LearningLoopError", code });
}

describe("learning.resolveContext: the resolution receipt", () => {
  it("resolves exactly the active context intervention into a content-addressed, frozen, idempotent receipt", async () => {
    const harness = await createPublicationHarness();
    const { candidate, plan, intervention } = await acceptAndPublish(harness);
    const before = await harness.storeSnapshot();
    const resolved = await harness.learning.resolveContext(resolveInput());
    const contentDigest = sha256HexOfCanonicalJson(candidate.intervention.content);
    expect(resolved).toEqual({
      schemaVersion: 1,
      id: expect.stringMatching(/^resolution-[0-9a-f]{64}$/),
      episodeId: EPISODE_ID,
      scope: SCOPE,
      scopeDigest: scopeDigest(SCOPE),
      scopePolicyDigest: createExactScopePolicy().digest,
      registryRevision: plan.lineage.registryRevision,
      policyDigest: conservativePolicy().digest,
      queryDigest: sha256HexOfCanonicalJson({ domain: "context-resolution-query:v1", query: QUERY }),
      budget: BUDGET,
      entries: [
        {
          id: `entry-${sha256HexOfCanonicalJson({
            domain: "context-resolution-entry:v1",
            interventionId: intervention.id,
            transitionId: intervention.latestTransitionId,
            contentDigest,
          })}`,
          interventionId: intervention.id,
          candidateId: candidate.id,
          candidateDigest: candidate.contentDigest,
          planDigest: plan.planDigest,
          destinationId: DESTINATION_ID,
          scopeDigest: scopeDigest(SCOPE),
          transitionId: intervention.latestTransitionId,
          content: candidate.intervention.content,
          contentDigest,
        },
      ],
      omittedInterventionIds: [],
      resolvedAt: NOW,
      receiptDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(resolved.id).toBe(`resolution-${resolved.receiptDigest}`);
    expect(parseResolvedContext(resolved)).toEqual(resolved);
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(Object.isFrozen(resolved.entries)).toBe(true);
    expect(Object.isFrozen(resolved.entries[0]?.content)).toBe(true);
    expect(addedKinds(before, await harness.storeSnapshot())).toEqual(["context-resolution"]);
    const stored = await harness.store.get({ namespace: "learning", kind: "context-resolution", id: resolved.id });
    expect(parseResolvedContext(stored?.value)).toEqual(resolved);

    // Resolving the same episode against the same active set is one receipt,
    // even under a ticking clock: the first persisted receipt is canonical.
    const after = await harness.storeSnapshot();
    harness.clock.tick();
    expect(await harness.learning.resolveContext(resolveInput())).toEqual(resolved);
    expect(await harness.storeSnapshot()).toBe(after);
    expect(harness.destination.calls.applyEffect).toBe(1);
  });

  it("a candidate never resolves: proposed, accepted, planned, or pending authority (kernel invariant 1)", async () => {
    const harness = await createPublicationHarness();
    const candidate = await harness.acceptedCandidate();
    const empty = await harness.learning.resolveContext(resolveInput());
    expect(empty.entries).toEqual([]);
    expect(empty.omittedInterventionIds).toEqual([]);
    const prepared = await harness.learning.preparePublication({
      candidateId: candidate.id,
      destinationId: DESTINATION_ID,
      expectedBase: BASE,
    });
    expect((await harness.learning.resolveContext(resolveInput())).entries).toEqual([]);
    const pending = await harness.learning.publish({
      planId: prepared.plan.id,
      authorizationEvidence: { decision: "pending" },
    });
    expect(pending.status).toBe("pending");
    const stillEmpty = await harness.learning.resolveContext(resolveInput());
    expect(stillEmpty.entries).toEqual([]);
    expect(stillEmpty.id).toBe(empty.id);
    expect(harness.destination.calls.applyEffect).toBe(0);

    // The resolver never reads the candidate namespace. A candidate-shaped
    // record planted in the intervention scope index is visible corruption,
    // never context.
    const storedCandidate = await harness.store.get({ namespace: "learning", kind: "candidate", id: candidate.id });
    const planted = toJsonValue(storedCandidate?.value);
    await harness.store.create(
      {
        namespace: `learning-intervention-scope-${scopeDigest(SCOPE)}`,
        kind: "intervention-scope-index",
        id: candidate.id,
      },
      planted,
      sha256HexOfCanonicalJson(planted),
      "hostile-plant",
    );
    await expect(harness.learning.resolveContext(resolveInput())).rejects.toMatchObject({
      name: "LearningLoopError",
      code: expect.stringMatching(/^(schema|store)\./),
    });
  });

  it("a proposal-class publication is inactive and never resolves", async () => {
    const harness = await createPublicationHarness({ registration: { effectClass: "proposal" } });
    const { intervention } = await acceptAndPublish(harness);
    expect(intervention.state).toMatchObject({ publication: "published", activation: "inactive" });
    expect((await harness.learning.resolveContext(resolveInput())).entries).toEqual([]);
  });

  it("an active intervention at a non-context destination is not context", async () => {
    const harness = await createPublicationHarness({ registration: { effectClass: "external" } });
    const { intervention } = await acceptAndPublish(harness);
    expect(intervention.state.activation).toBe("active");
    expect((await harness.learning.resolveContext(resolveInput())).entries).toEqual([]);
  });

  /** A destination whose writes declare a rollback after-effect the in-memory destination can execute. */
  function rollbackDestination() {
    return inertDestination({
      prepare: (input) => [
        effectFor(input.candidate, {
          ...(input.expectedBase !== undefined ? { expectedBase: input.expectedBase } : {}),
          afterEffect: { kind: "rollback", payload: { restore: null } },
        }),
      ],
    });
  }

  for (const action of ["disable", "rollback"] as const) {
    it(`a ${action === "disable" ? "disabled" : "rolled-back"} version never resolves, and the earlier receipt stays frozen`, async () => {
      const harness = await createPublicationHarness(
        action === "rollback" ? { destination: rollbackDestination() } : {},
      );
      const { candidate, intervention } = await acceptAndPublish(harness);
      const first = await harness.learning.resolveContext(resolveInput());
      expect(first.entries).toHaveLength(1);
      await reverse(harness, candidate, action);
      const reversed = await harness.learning.getIntervention({ interventionId: intervention.id });
      expect(reversed?.state.activation).toBe("disabled");
      const second = await harness.learning.resolveContext(resolveInput());
      expect(second.entries).toEqual([]);
      expect(second.omittedInterventionIds).toEqual([]);
      expect(second.id).not.toBe(first.id);
      const stored = await harness.store.get({ namespace: "learning", kind: "context-resolution", id: first.id });
      expect(parseResolvedContext(stored?.value)).toEqual(first);
    });
  }

  it("a failed publication never resolves", async () => {
    const destination = inertDestination({
      applyEffect: () => {
        throw new Error("destination offline");
      },
    });
    const harness = await createPublicationHarness({ destination });
    const candidate = await harness.acceptedCandidate();
    const prepared = await harness.learning.preparePublication({
      candidateId: candidate.id,
      destinationId: DESTINATION_ID,
      expectedBase: BASE,
    });
    const outcome = await harness.learning.publish({
      planId: prepared.plan.id,
      authorizationEvidence: { decision: "authorized" },
    });
    expect(outcome.status).toBe("failed");
    expect((await harness.learning.resolveContext(resolveInput())).entries).toEqual([]);
  });

  it("a superseded version that is still active is refused visibly, never served and never dropped", async () => {
    const harness = await createPublicationHarness();
    const stale = await acceptAndPublish(harness);
    const successor = await acceptAndPublish(
      harness,
      secondCandidate({ supersedes: stale.candidate.id, hypothesis: "A revised hypothesis supersedes the first." }),
    );
    const before = await harness.storeSnapshot();
    await expect(harness.learning.resolveContext(resolveInput())).rejects.toMatchObject({
      name: "LearningLoopError",
      code: "resolution.intervention_stale",
      diagnostics: [
        expect.objectContaining({
          details: { staleInterventionId: stale.intervention.id, successorInterventionId: successor.intervention.id },
        }),
      ],
    });
    expect(await harness.storeSnapshot()).toBe(before);

    await reverse(harness, stale.candidate, "disable");
    const resolved = await harness.learning.resolveContext(resolveInput());
    expect(resolved.entries.map((entry) => entry.interventionId)).toEqual([successor.intervention.id]);
    expect(resolved.entries[0]?.content).toEqual(SECOND_CONTENT);
  });

  it("destination registration drift refuses visibly instead of reinterpreting published content", async () => {
    const store = createInMemoryStore();
    const harness = await createPublicationHarness({ store });
    await acceptAndPublish(harness);
    const drifted = await createPublicationHarness({
      store,
      destination: harness.destination,
      registration: { riskFloor: "T2" },
    });
    const unregistered = await createPublicationHarness({
      store,
      destination: harness.destination,
      omitDestinations: true,
    });
    const before = await harness.storeSnapshot();
    await expectRefusal(() => drifted.learning.resolveContext(resolveInput()), "resolution.destination_drift");
    await expectRefusal(() => unregistered.learning.resolveContext(resolveInput()), "resolution.destination_drift");
    expect(await harness.storeSnapshot()).toBe(before);
    // The original registration resolves again.
    const restored = await createPublicationHarness({ store, destination: harness.destination });
    expect((await restored.learning.resolveContext(resolveInput())).entries).toHaveLength(1);
  });

  it("registry drift that leaves the destination registration intact resolves and is bound into the receipt", async () => {
    const store = createInMemoryStore();
    const harness = await createPublicationHarness({ store });
    const { plan } = await acceptAndPublish(harness);
    const drifted = await createPublicationHarness({
      store,
      destination: harness.destination,
      extraContentPolicies: [createStructuredContentPolicy({ id: "structured-v2" })],
    });
    const resolved = await drifted.learning.resolveContext(resolveInput());
    expect(resolved.entries).toHaveLength(1);
    expect(resolved.registryRevision).not.toBe(plan.lineage.registryRevision);
    expect(resolved.entries[0]?.planDigest).toBe(plan.planDigest);
  });

  it("only the exact scope matches under the exact scope policy", async () => {
    const harness = await createPublicationHarness();
    await acceptAndPublish(harness);
    const other: Scope = [{ type: "project", id: "other-api" }];
    const resolved = await harness.learning.resolveContext(resolveInput({ scope: other }));
    expect(resolved.entries).toEqual([]);
    expect(resolved.scopeDigest).toBe(scopeDigest(other));
  });

  it("a mid-run publication cannot change a receipt", async () => {
    const harness = await createPublicationHarness();
    await acceptAndPublish(harness);
    const first = await harness.learning.resolveContext(resolveInput());
    await acceptAndPublish(harness, secondCandidate());
    const stored = await harness.store.get({ namespace: "learning", kind: "context-resolution", id: first.id });
    expect(parseResolvedContext(stored?.value)).toEqual(first);
    const second = await harness.learning.resolveContext(resolveInput());
    expect(second.id).not.toBe(first.id);
    expect(second.entries).toHaveLength(2);
  });

  it("the budget is a precedence-ordered prefix and every omission is visible", async () => {
    const harness = await createPublicationHarness();
    const first = await acceptAndPublish(harness);
    harness.clock.tick();
    const second = await acceptAndPublish(harness, secondCandidate());
    const firstCharacters = canonicalJsonText(toJsonValue(first.candidate.intervention.content)).length;
    const ids = (resolved: { readonly entries: readonly { readonly interventionId: string }[] }) =>
      resolved.entries.map((entry) => entry.interventionId);

    const full = await harness.learning.resolveContext(resolveInput());
    expect(ids(full)).toEqual([first.intervention.id, second.intervention.id]);
    expect(full.omittedInterventionIds).toEqual([]);

    const one = await harness.learning.resolveContext(
      resolveInput({ budget: { maximumEntries: 1, maximumCharacters: 4_000 } }),
    );
    expect(ids(one)).toEqual([first.intervention.id]);
    expect(one.omittedInterventionIds).toEqual([second.intervention.id]);

    const none = await harness.learning.resolveContext(
      resolveInput({ budget: { maximumEntries: 8, maximumCharacters: firstCharacters - 1 } }),
    );
    expect(ids(none)).toEqual([]);
    expect(none.omittedInterventionIds).toEqual([first.intervention.id, second.intervention.id]);

    const exact = await harness.learning.resolveContext(
      resolveInput({ budget: { maximumEntries: 8, maximumCharacters: firstCharacters } }),
    );
    expect(ids(exact)).toEqual([first.intervention.id]);
    expect(exact.omittedInterventionIds).toEqual([second.intervention.id]);
    expect(new Set([full.id, one.id, none.id, exact.id]).size).toBe(4);
  });

  it("refuses malformed input with zero writes", async () => {
    const harness = await createPublicationHarness();
    await acceptAndPublish(harness);
    const before = await harness.storeSnapshot();
    const cases: readonly Record<string, unknown>[] = [
      { budget: { maximumEntries: 0, maximumCharacters: 4_000 } },
      { budget: { maximumEntries: 8, maximumCharacters: 10_000_001 } },
      { budget: { maximumEntries: 8 } },
      { query: "x".repeat(100_001) },
      { scope: [] },
      { scope: [{ type: "project", id: "" }] },
      { episodeId: "" },
    ];
    for (const overrides of cases) {
      await expectRefusal(() => harness.learning.resolveContext(resolveInput(overrides)), "schema.invalid");
    }
    expect(await harness.storeSnapshot()).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Scope policy ancestors

const CHILD: Scope = [...SCOPE, { type: "task", id: "retry-policy" }];

function ancestorPolicy(
  overrides: Partial<Pick<ScopePolicy, "ancestors" | "isolationSegmentTypes">> = {},
): ScopePolicy {
  const isolationSegmentTypes = overrides.isolationSegmentTypes ?? ["project"];
  const exact = createExactScopePolicy({ id: "scope-ancestors-test", isolationSegmentTypes });
  return {
    ...exact,
    digest: sha256HexOfCanonicalJson({ kind: "ancestors-test", isolationSegmentTypes }),
    ancestors: overrides.ancestors ?? ((scope) => (scope.length > 1 ? [scope.slice(0, -1)] : [])),
  };
}

async function childHarness(options: PublicationHarnessOptions = {}): Promise<PublicationHarness> {
  const harness = await createPublicationHarness({ scopePolicy: ancestorPolicy(), ...options });
  await harness.learning.ingest(harness.manual, {
    observations: [
      {
        id: "obs-child",
        episodeId: "change-child",
        occurredAt: "2026-08-12T17:00:00.000Z",
        kind: "tool.process.completed",
        data: { commandClass: "test", exitCode: 1 },
      },
    ],
    episodes: [{ id: "change-child", scope: CHILD, openedAt: "2026-08-12T16:50:00.000Z" }],
  });
  return harness;
}

describe("learning.resolveContext: scope policy ancestors", () => {
  it("resolves ancestor-scope interventions after exact-scope ones, each bound to its matched scope", async () => {
    const harness = await childHarness();
    const parent = await acceptAndPublish(harness);
    harness.clock.tick();
    const child = await acceptAndPublish(
      harness,
      secondCandidate({ id: "cand-child", scope: CHILD, evidenceIds: ["manual-evidence/obs-child"] }),
    );
    const resolved = await harness.learning.resolveContext(resolveInput({ scope: CHILD }));
    expect(resolved.entries.map((entry) => [entry.interventionId, entry.scopeDigest])).toEqual([
      [child.intervention.id, scopeDigest(CHILD)],
      [parent.intervention.id, scopeDigest(SCOPE)],
    ]);
    expect(resolved.scopeDigest).toBe(scopeDigest(CHILD));
    expect(resolved.scopePolicyDigest).toBe(ancestorPolicy().digest);
    // The parent scope does not inherit downward.
    const parentOnly = await harness.learning.resolveContext(resolveInput());
    expect(parentOnly.entries.map((entry) => entry.interventionId)).toEqual([parent.intervention.id]);
  });

  it("refuses a policy that crosses an isolation boundary, repeats a scope, or misbehaves", async () => {
    const foreign: Scope = [
      { type: "project", id: "other-api" },
      { type: "agent", id: "coding-agent" },
    ];
    const crossing = await createPublicationHarness({ scopePolicy: ancestorPolicy({ ancestors: () => [foreign] }) });
    await acceptAndPublish(crossing);
    await expectRefusal(() => crossing.learning.resolveContext(resolveInput({ scope: CHILD })), "config.invalid");

    const repeating = await createPublicationHarness({
      scopePolicy: ancestorPolicy({ ancestors: (scope) => [scope] }),
    });
    await expectRefusal(() => repeating.learning.resolveContext(resolveInput()), "config.invalid");

    // A policy that returns a non-array or an invalid scope is host misconfiguration.
    const broken = await createPublicationHarness({
      scopePolicy: ancestorPolicy({ ancestors: () => "parent" as unknown as readonly Scope[] }),
    });
    await expectRefusal(() => broken.learning.resolveContext(resolveInput()), "config.invalid");
    const invalidScope = await createPublicationHarness({
      scopePolicy: ancestorPolicy({ ancestors: () => [[]] }),
    });
    await expectRefusal(() => invalidScope.learning.resolveContext(resolveInput()), "schema.invalid");

    const flood = await createPublicationHarness({
      scopePolicy: ancestorPolicy({
        ancestors: () => Array.from({ length: 101 }, (_, index) => [{ type: "project", id: `p-${index}` }]),
        isolationSegmentTypes: [],
      }),
    });
    await expectRefusal(() => flood.learning.resolveContext(resolveInput()), "resolution.limit_exceeded");
  });
});
