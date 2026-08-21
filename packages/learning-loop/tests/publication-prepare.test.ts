// learning.preparePublication (decision 0024): exact, content-addressed,
// idempotent plans; side-effect-free against the destination; every refusal
// leaves the store and the destination untouched.
import { describe, expect, it } from "vitest";
import type { Candidate, ContentPolicy, PreparedEffect } from "../src/index.js";
import {
  candidateContentDigest,
  conservativePolicy,
  scopeDigest,
  sha256HexOfCanonicalJson,
  toJsonValue,
} from "../src/index.js";
import { destinationRegistrationDigest } from "../src/engine/destination-registration.js";
import { authorizationBindingForPlan } from "../src/records/publication.js";
import { createExactScopePolicy } from "../src/testing/index.js";
import {
  CONTENT_POLICY_ID,
  DESTINATION_ID,
  NOW,
  SCOPE,
  candidateInput,
  createPublicationHarness,
  effectFor,
  inertDestination,
} from "./publication-harness.js";

const BASE = "instructions-v7";

async function expectRefusal(run: () => Promise<unknown>, code: string): Promise<void> {
  await expect(run()).rejects.toMatchObject({ name: "LearningLoopError", code });
}

function contentPolicy(id: string, transform: (input: unknown) => Promise<unknown>): ContentPolicy {
  return {
    id,
    digest: sha256HexOfCanonicalJson({ kind: "test-policy", id }),
    maximumInputBytes: 1_000_000,
    outboundUse: "forbidden",
    // Policies answer from `unknown`; the engine re-validates. The cast lives in test code only.
    transform: transform as ContentPolicy["transform"],
  };
}

describe("learning.preparePublication", () => {
  it("prepares an exact content-addressed plan bound to candidate, destination, policy, registry, and scope lineage", async () => {
    const harness = await createPublicationHarness();
    const candidate = await harness.acceptedCandidate();
    const registryRevision = (await harness.learning.ingest(harness.manual, { observations: [] })).registryRevision;
    const before = await harness.storeSnapshot();

    const prepared = await harness.learning.preparePublication({
      candidateId: candidate.id,
      destinationId: DESTINATION_ID,
      expectedBase: BASE,
    });

    const { plan } = prepared;
    expect(plan).toMatchObject({
      schemaVersion: 1,
      id: `plan-${plan.planDigest}`,
      candidateId: candidate.id,
      candidateDigest: candidate.contentDigest,
      destinationId: DESTINATION_ID,
      action: "publish",
      effectClass: "context",
      effectiveRisk: "T1",
      effects: [effectFor(candidate, { expectedBase: BASE })],
      lineage: {
        scopeDigest: scopeDigest(SCOPE),
        scopePolicyDigest: createExactScopePolicy().digest,
        registryRevision,
        destinationRegistrationDigest: destinationRegistrationDigest({
          destinationId: DESTINATION_ID,
          effectClass: "context",
          riskFloor: "T1",
          permittedTargetPatterns: [`${DESTINATION_ID}/*`],
          authorizationRuleId: "host-approval-v1",
          contentPolicyId: CONTENT_POLICY_ID,
        }),
        derivation: null,
      },
      policyDigest: conservativePolicy().digest,
      createdAt: NOW,
    });
    expect(prepared.authorizationBinding).toEqual(authorizationBindingForPlan(plan));
    expect(prepared.authorizationBinding.expectedBases).toEqual([BASE]);
    expect(prepared.governance.review).toBe("accepted");
    expect(prepared.governance.publication).toBe("blocked");

    expect(harness.destination.calls).toEqual({ prepare: 1, applyEffect: 0 });
    expect(harness.destination.prepareInputs[0]).toEqual({ candidate, expectedBase: BASE });

    const after = await harness.storeSnapshot();
    const added = JSON.parse(after).filter((entry: unknown) => !before.includes(JSON.stringify(entry)));
    expect(added).toEqual([["publication-plan", plan.id, expect.stringMatching(/^[0-9a-f]{64}$/)]]);
  });

  it("is idempotent: repeated requests return the first persisted plan and write nothing new", async () => {
    const harness = await createPublicationHarness();
    const candidate = await harness.acceptedCandidate();
    const request = { candidateId: candidate.id, destinationId: DESTINATION_ID, expectedBase: BASE };
    const first = await harness.learning.preparePublication(request);
    const snapshot = await harness.storeSnapshot();
    const second = await harness.learning.preparePublication(request);
    expect(second).toEqual(first);
    harness.clock.tick(60_000);
    const later = await harness.learning.preparePublication(request);
    expect(later.plan).toEqual(first.plan);
    expect(later.plan.createdAt).toBe(NOW);
    expect(await harness.storeSnapshot()).toBe(snapshot);
    expect(harness.destination.calls.applyEffect).toBe(0);
  });

  it("binds the requested base into effects and binding; a different base is a different plan", async () => {
    const harness = await createPublicationHarness();
    const candidate = await harness.acceptedCandidate();
    const v7 = await harness.learning.preparePublication({
      candidateId: candidate.id,
      destinationId: DESTINATION_ID,
      expectedBase: "v7",
    });
    const v8 = await harness.learning.preparePublication({
      candidateId: candidate.id,
      destinationId: DESTINATION_ID,
      expectedBase: "v8",
    });
    const unbased = await harness.learning.preparePublication({
      candidateId: candidate.id,
      destinationId: DESTINATION_ID,
    });
    expect(new Set([v7.plan.id, v8.plan.id, unbased.plan.id]).size).toBe(3);
    expect(v7.authorizationBinding.expectedBases).toEqual(["v7"]);
    expect(v8.authorizationBinding.expectedBases).toEqual(["v8"]);
    expect(unbased.authorizationBinding.expectedBases).toEqual([]);
    expect(unbased.plan.effects[0]).not.toHaveProperty("expectedBase");
  });

  it("does not require an accepted review to prepare, and reports governance as-is", async () => {
    const harness = await createPublicationHarness();
    const { candidate } = await harness.learning.propose(candidateInput(harness.proposer));
    const prepared = await harness.learning.preparePublication({
      candidateId: candidate.id,
      destinationId: DESTINATION_ID,
    });
    expect(prepared.governance.review).toBe("required");
    expect(prepared.plan.candidateDigest).toBe(candidate.contentDigest);
  });

  it("records the destination floor as effective risk and permits irreversible effects outside context destinations", async () => {
    const destination = inertDestination({
      prepare: (input) => [
        effectFor(input.candidate, {
          target: `${DESTINATION_ID}/ticket-1`,
          afterEffect: { kind: "irreversible", rationale: "an outbound ticket cannot be unsent" },
        }),
      ],
    });
    const harness = await createPublicationHarness({
      destination,
      registration: { effectClass: "proposal", riskFloor: "T2" },
    });
    const candidate = await harness.acceptedCandidate({ proposedRisk: "T0" });
    const prepared = await harness.learning.preparePublication({
      candidateId: candidate.id,
      destinationId: DESTINATION_ID,
    });
    expect(prepared.plan.effectClass).toBe("proposal");
    expect(prepared.plan.effectiveRisk).toBe("T2");
    expect(prepared.plan.effects[0]?.afterEffect.kind).toBe("irreversible");
  });

  describe("refusals write nothing and never reach applyEffect", () => {
    async function refused(
      code: string,
      options: Parameters<typeof createPublicationHarness>[0] & {
        readonly request?: (
          candidate: Candidate,
        ) => Parameters<(typeof harnessType)["learning"]["preparePublication"]>[0];
        readonly seed?: (
          harness: Awaited<ReturnType<typeof createPublicationHarness>>,
          candidate: Candidate,
        ) => Promise<void>;
        readonly prepareCalled?: boolean;
      } = {},
    ): Promise<void> {
      const harness = await createPublicationHarness(options);
      const candidate = await harness.acceptedCandidate();
      await options.seed?.(harness, candidate);
      const snapshot = await harness.storeSnapshot();
      const request = options.request?.(candidate) ?? {
        candidateId: candidate.id,
        destinationId: DESTINATION_ID,
        expectedBase: BASE,
      };
      await expectRefusal(() => harness.learning.preparePublication(request), code);
      expect(await harness.storeSnapshot()).toBe(snapshot);
      expect(harness.destination.calls.applyEffect).toBe(0);
      expect(harness.destination.calls.prepare).toBe(options.prepareCalled === false ? 0 : 1);
    }
    const harnessType = undefined as unknown as Awaited<ReturnType<typeof createPublicationHarness>>;

    it("unknown destination", () =>
      refused("publication.destination_unknown", {
        request: (candidate) => ({ candidateId: candidate.id, destinationId: "nowhere" }),
        prepareCalled: false,
      }));

    it("unknown candidate", () =>
      refused("publication.candidate_not_found", {
        request: () => ({ candidateId: "cand-missing", destinationId: DESTINATION_ID }),
        prepareCalled: false,
      }));

    it("candidate proposing another destination", async () => {
      const harness = await createPublicationHarness();
      const { candidate } = await harness.learning.propose(
        candidateInput(harness.proposer, {
          id: "cand-elsewhere",
          intervention: {
            destinationId: "other-destination",
            kind: "procedure",
            content: { text: "x" },
            rollbackIntent: "disable",
          },
        }),
      );
      await expectRefusal(
        () => harness.learning.preparePublication({ candidateId: candidate.id, destinationId: DESTINATION_ID }),
        "publication.destination_mismatch",
      );
      expect(harness.destination.calls.prepare).toBe(0);
    });

    it("schema-version-1 legacy candidate", async () => {
      const harness = await createPublicationHarness();
      const bound = {
        scope: SCOPE,
        problem: "legacy problem",
        hypothesis: "legacy hypothesis",
        evidenceIds: ["obs-legacy"],
        intervention: {
          destinationId: DESTINATION_ID,
          kind: "procedure",
          content: { text: "legacy" },
          rollbackIntent: "disable",
        },
        proposedRisk: "T1" as const,
      };
      const legacy = {
        ...bound,
        schemaVersion: 1,
        id: "cand-legacy",
        proposedBy: { id: "distiller-a", kind: "agent", independenceDomain: "provider-a" },
        proposerAttestationDigest: "attest-legacy",
        proposedAt: "2026-08-01T00:00:00.000Z",
        contentDigest: candidateContentDigest(bound),
      };
      const legacyValue = toJsonValue(legacy);
      const created = await harness.store.create(
        { namespace: "learning", kind: "candidate", id: legacy.id },
        legacyValue,
        sha256HexOfCanonicalJson(legacyValue),
        "seed-legacy",
      );
      expect(created.status).toBe("created");
      await expectRefusal(
        () => harness.learning.preparePublication({ candidateId: legacy.id, destinationId: DESTINATION_ID }),
        "publication.candidate_legacy_unbound",
      );
      expect(harness.destination.calls.prepare).toBe(0);
    });

    it("non-publish actions until the journaled publisher exists", () =>
      refused("publication.action_unavailable", {
        request: (candidate) => ({ candidateId: candidate.id, destinationId: DESTINATION_ID, action: "disable" }),
        prepareCalled: false,
      }));

    it("malformed input", () =>
      refused("schema.invalid", {
        request: () => ({ destinationId: DESTINATION_ID }) as unknown as { candidateId: string; destinationId: string },
        prepareCalled: false,
      }));

    const malformedEffects: readonly { readonly name: string; readonly effects: (candidate: Candidate) => unknown }[] =
      [
        { name: "a non-array", effects: () => ({ effects: [] }) },
        { name: "no effects", effects: () => [] },
        {
          name: "a payload digest mismatch",
          effects: (candidate) => [effectFor(candidate, { payloadDigest: "0".repeat(64) })],
        },
        { name: "duplicate effect ids", effects: (candidate) => [effectFor(candidate), effectFor(candidate)] },
        {
          name: "a missing after-effect",
          effects: (candidate) => [{ ...effectFor(candidate), afterEffect: undefined }],
        },
        {
          name: "more than 100 effects",
          effects: (candidate) =>
            Array.from({ length: 101 }, (_, index) => effectFor(candidate, { id: `effect-${index}` })),
        },
      ];
    for (const example of malformedEffects) {
      it(`destination preparing ${example.name}`, () =>
        refused("publication.effect_invalid", {
          destination: inertDestination({ prepare: (input) => example.effects(input.candidate) }),
        }));
    }

    it("a target outside the permitted patterns", () =>
      refused("publication.target_not_permitted", {
        destination: inertDestination({ prepare: (input) => [effectFor(input.candidate, { target: "etc/passwd" })] }),
      }));

    it("a nested target the single-segment pattern does not permit", () =>
      refused("publication.target_not_permitted", {
        destination: inertDestination({
          prepare: (input) => [effectFor(input.candidate, { target: `${DESTINATION_ID}/nested/CLAUDE.md` })],
        }),
      }));

    it("an effect base that differs from the requested base", () =>
      refused("publication.base_mismatch", {
        destination: inertDestination({
          prepare: (input) => [effectFor(input.candidate, { expectedBase: "instructions-v6" })],
        }),
      }));

    for (const kind of ["irreversible", "compensate"] as const) {
      it(`a ${kind} after-effect on a context destination`, () =>
        refused("publication.after_effect_invalid", {
          destination: inertDestination({
            prepare: (input) => [
              effectFor(input.candidate, {
                afterEffect:
                  kind === "irreversible" ? { kind, rationale: "cannot undo" } : { kind, payload: { close: true } },
              }),
            ],
          }),
        }));
    }

    it("a payload the destination content policy refuses", () =>
      refused("publication.content_policy_refused", {
        destination: inertDestination({
          prepare: (input) => [effectFor(input.candidate, { payload: { text: "x".repeat(300_000) } })],
        }),
      }));

    it("a payload the destination content policy would alter", () =>
      // The bytes the host approves must be the bytes applied: a policy whose
      // transform rewrites content cannot admit a prepared payload.
      refused("publication.content_policy_refused", {
        registration: { contentPolicyId: "rewriting-v1" },
        extraContentPolicies: [
          contentPolicy("rewriting-v1", () =>
            Promise.resolve({ accepted: { rewritten: true }, classification: "rewritten", diagnostics: [] }),
          ),
        ],
      }));

    it("a payload the destination content policy flags with an error diagnostic", () =>
      refused("publication.content_policy_refused", {
        registration: { contentPolicyId: "flagging-v1" },
        extraContentPolicies: [
          contentPolicy("flagging-v1", (input) =>
            Promise.resolve({
              accepted: toJsonValue(input),
              classification: "flagged",
              diagnostics: [{ code: "content.secret_like", severity: "error", message: "looks like a secret" }],
            }),
          ),
        ],
      }));

    it("a content policy whose result does not parse", () =>
      refused("schema.invalid", {
        registration: { contentPolicyId: "broken-v1" },
        extraContentPolicies: [contentPolicy("broken-v1", () => Promise.resolve({ accepted: {} }))],
      }));
  });
});

// Effects helper sanity: the default harness effect is a well-formed context effect.
describe("harness effect fixture", () => {
  it("recomputes its payload digest", () => {
    const payload = { text: "fixture" };
    const effect: PreparedEffect = effectFor({ intervention: { content: payload } } as unknown as Candidate, {});
    expect(effect.payloadDigest).toBe(sha256HexOfCanonicalJson(payload));
  });
});
