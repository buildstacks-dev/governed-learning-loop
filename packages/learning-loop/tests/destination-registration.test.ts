// Destination registrations (decision 0025): host-owned effect class, risk
// floor, permitted targets, authorization rule, and content policy are parsed
// and snapshotted at construction, digested into the loop registry, and the
// floor raises effective risk by monotonic maximum.
import { describe, expect, it } from "vitest";
import type { DestinationRegistration, LearningLoopConfig } from "../src/index.js";
import { conservativePolicy, createLearningLoop, defineSourceRegistration } from "../src/index.js";
import { destinationRegistrationDigest, targetMatchesPattern } from "../src/engine/destination-registration.js";
import {
  createExactScopePolicy,
  createInMemoryStore,
  createManualEvidenceSource,
  createStructuredContentPolicy,
  createTestIdentityPort,
} from "../src/testing/index.js";
import { candidateInput, reviewerFor } from "./engine-harness.js";
import {
  CONTENT_POLICY_ID,
  DESTINATION_ID,
  createPublicationHarness,
  inertDestination,
  registrationFor,
} from "./publication-harness.js";

function baseConfig(destinations: unknown): LearningLoopConfig {
  const source = defineSourceRegistration({
    source: createManualEvidenceSource(),
    trustCeiling: "observed",
    contentPolicyId: CONTENT_POLICY_ID,
  });
  const config: unknown = {
    store: createInMemoryStore(),
    policy: conservativePolicy(),
    identity: createTestIdentityPort(),
    scopePolicy: createExactScopePolicy(),
    contentPolicies: [createStructuredContentPolicy({ id: CONTENT_POLICY_ID })],
    sources: [source],
    ...(destinations === undefined ? {} : { destinations }),
  };
  return config as LearningLoopConfig;
}

async function registryRevisionOf(config: LearningLoopConfig): Promise<string> {
  const learning = createLearningLoop(config);
  const source = config.sources[0];
  if (source === undefined) throw new Error("harness source missing");
  return (await learning.ingest(source, { observations: [] })).registryRevision;
}

function expectConfigInvalid(destinations: unknown, pattern: RegExp): void {
  expect(() => createLearningLoop(baseConfig(destinations))).toThrow(
    expect.objectContaining({
      name: "LearningLoopError",
      code: "config.invalid",
      message: expect.stringMatching(pattern),
    }),
  );
}

describe("destination registration at loop construction", () => {
  it("accepts a well-formed registration and pins the registration digest golden", () => {
    const registration = registrationFor(inertDestination());
    expect(() => createLearningLoop(baseConfig([registration]))).not.toThrow();
    expect(
      destinationRegistrationDigest({
        destinationId: DESTINATION_ID,
        effectClass: "context",
        riskFloor: "T1",
        permittedTargetPatterns: [`${DESTINATION_ID}/*`],
        authorizationRuleId: "host-approval-v1",
        contentPolicyId: CONTENT_POLICY_ID,
      }),
    ).toBe("32a00205d75df7fa72bbadc5863846c092212635764fd7c60e0c14f24cf0179b");
  });

  it("rejects malformed, duplicate, unpermitted, and policy-orphaned registrations", () => {
    const registration = registrationFor(inertDestination());
    expectConfigInvalid("not-an-array", /array of registrations/);
    expectConfigInvalid([null], /must be an object/);
    expectConfigInvalid([{ ...registration, adapter: null }], /adapter object/);
    expectConfigInvalid([{ ...registration, adapter: { id: DESTINATION_ID } }], /prepare and applyEffect/);
    expectConfigInvalid([{ ...registration, adapter: { ...registration.adapter, id: "" } }], /non-empty/);
    expectConfigInvalid([{ ...registration, effectClass: "prompt" }], /expected one of/);
    expectConfigInvalid([{ ...registration, riskFloor: "T4" }], /expected one of/);
    expectConfigInvalid([{ ...registration, effectClass: "authority", riskFloor: "T2" }], /authority destination/);
    expectConfigInvalid([{ ...registration, permittedTargetPatterns: [] }], /at least one target pattern/);
    expectConfigInvalid([{ ...registration, permittedTargetPatterns: ["a/*", "a/*"] }], /unique/);
    expectConfigInvalid([{ ...registration, permittedTargetPatterns: ["bad\npattern"] }], /control character/);
    expectConfigInvalid([{ ...registration, permittedTargetPatterns: ["p".repeat(201)] }], /exceeds 200/);
    expectConfigInvalid(
      [{ ...registration, permittedTargetPatterns: Array.from({ length: 101 }, (_, index) => `p-${index}`) }],
      /exceeds 100/,
    );
    expectConfigInvalid([{ ...registration, authorizationRuleId: "" }], /non-empty/);
    expectConfigInvalid([{ ...registration, contentPolicyId: "missing-policy" }], /not configured/);
    expectConfigInvalid([registration, registration], /duplicate destination id/);
  });

  it("accepts the authority effect class only at the T3 floor", () => {
    const registration = registrationFor(inertDestination(), { effectClass: "authority", riskFloor: "T3" });
    expect(() => createLearningLoop(baseConfig([registration]))).not.toThrow();
  });

  it("binds every host-owned registration field into the registry revision, but not adapter behavior", async () => {
    const revisionFor = (overrides: Partial<Omit<DestinationRegistration, "adapter">> = {}, id?: string) =>
      registryRevisionOf(baseConfig([registrationFor(inertDestination(id === undefined ? {} : { id }), overrides)]));
    const omitted = await registryRevisionOf(baseConfig(undefined));
    const omittedAgain = await registryRevisionOf(baseConfig(undefined));
    const empty = await registryRevisionOf(baseConfig([]));
    const baseline = await revisionFor();
    const sameBytesDifferentBehavior = await registryRevisionOf(
      baseConfig([registrationFor(inertDestination({ prepare: () => [] }))]),
    );
    const changed = await Promise.all([
      revisionFor({ effectClass: "proposal" }),
      revisionFor({ riskFloor: "T2" }),
      revisionFor({ permittedTargetPatterns: [`${DESTINATION_ID}/*`, "other/*"] }),
      revisionFor({ authorizationRuleId: "host-approval-v2" }),
      revisionFor({}, "other-destination"),
    ]);
    expect(omitted).toBe(omittedAgain);
    expect(baseline).toBe(sameBytesDifferentBehavior);
    expect(new Set([omitted, empty, baseline, ...changed]).size).toBe(3 + changed.length);
  });

  it("snapshots the registration: later caller mutation cannot change the loop", async () => {
    const destination = inertDestination();
    const registration: { -readonly [K in keyof DestinationRegistration]: DestinationRegistration[K] } =
      registrationFor(destination, { riskFloor: "T2" });
    const harness = await createPublicationHarness({
      destination,
      extraRegistrations: [],
      registration: { riskFloor: "T2" },
    });
    registration.riskFloor = "T0";
    const candidate = await harness.acceptedCandidate();
    const prepared = await harness.learning.preparePublication({
      candidateId: candidate.id,
      destinationId: DESTINATION_ID,
    });
    expect(prepared.plan.effectiveRisk).toBe("T2");
  });
});

describe("target patterns", () => {
  it("treats * as a run of non-separator characters and everything else literally", () => {
    expect(targetMatchesPattern("agent-instructions/CLAUDE.md", "agent-instructions/*")).toBe(true);
    expect(targetMatchesPattern("agent-instructions/", "agent-instructions/*")).toBe(true);
    expect(targetMatchesPattern("agent-instructions/a/b", "agent-instructions/*")).toBe(false);
    expect(targetMatchesPattern("other/CLAUDE.md", "agent-instructions/*")).toBe(false);
    expect(targetMatchesPattern("agent-instructions/CLAUDE.md", "agent-instructions/CLAUDE.md")).toBe(true);
    expect(targetMatchesPattern("agent-instructions/CLAUDE.md", "agent-instructions/CLAUDE.m")).toBe(false);
    expect(targetMatchesPattern("abc", "*")).toBe(true);
    expect(targetMatchesPattern("a/b", "*")).toBe(false);
    expect(targetMatchesPattern("a/b", "*/*")).toBe(true);
    expect(targetMatchesPattern("abbc", "a*c")).toBe(true);
    expect(targetMatchesPattern("ac", "a*c")).toBe(true);
    expect(targetMatchesPattern("abd", "a*c")).toBe(false);
    expect(targetMatchesPattern("a.b", "a?b")).toBe(false);
    expect(targetMatchesPattern("", "*")).toBe(true);
    expect(targetMatchesPattern("", "")).toBe(true);
    expect(targetMatchesPattern("x", "")).toBe(false);
  });

  it("evaluates a star-heavy hostile pattern without backtracking blow-up", () => {
    const pattern = `${"*a".repeat(100)}b`;
    const target = "a".repeat(4_096);
    const started = Date.now();
    expect(targetMatchesPattern(target, pattern)).toBe(false);
    expect(targetMatchesPattern(`${target}b`, pattern)).toBe(true);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe("effective risk with a registered destination floor", () => {
  it("raises a T1 proposal to the destination's T2 floor, so same-domain review is refused", async () => {
    const harness = await createPublicationHarness({ registration: { riskFloor: "T2" } });
    const { candidate } = await harness.learning.propose(candidateInput(harness.proposer, { proposedRisk: "T1" }));
    await expect(
      harness.learning.reviewCandidate({
        id: "rev-same",
        candidateId: candidate.id,
        reviewer: reviewerFor(harness.reviewerSameDomain),
      }),
    ).rejects.toMatchObject({ name: "LearningLoopError", code: "review.not_independent" });
    const review = await harness.learning.reviewCandidate({
      id: "rev-b",
      candidateId: candidate.id,
      reviewer: reviewerFor(harness.reviewerB),
    });
    expect(review.disposition).toBe("accept");
  });

  it("leaves a candidate that names an unregistered destination at its proposed tier", async () => {
    const harness = await createPublicationHarness({ registration: { riskFloor: "T2" } });
    const { candidate } = await harness.learning.propose(
      candidateInput(harness.proposer, {
        proposedRisk: "T1",
        intervention: {
          destinationId: "unregistered-destination",
          kind: "procedure",
          content: { text: "elsewhere" },
          rollbackIntent: "disable",
        },
      }),
    );
    const review = await harness.learning.reviewCandidate({
      id: "rev-same",
      candidateId: candidate.id,
      reviewer: reviewerFor(harness.reviewerSameDomain),
    });
    expect(review.disposition).toBe("accept");
  });

  it("never lowers a proposal below its own tier", async () => {
    const harness = await createPublicationHarness({ registration: { riskFloor: "T0" } });
    const { candidate } = await harness.learning.propose(candidateInput(harness.proposer, { proposedRisk: "T2" }));
    await expect(
      harness.learning.reviewCandidate({
        id: "rev-same",
        candidateId: candidate.id,
        reviewer: reviewerFor(harness.reviewerSameDomain),
      }),
    ).rejects.toMatchObject({ name: "LearningLoopError", code: "review.not_independent" });
  });
});
