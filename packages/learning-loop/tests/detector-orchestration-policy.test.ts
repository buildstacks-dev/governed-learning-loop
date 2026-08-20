// #30c2b2 policy-only slice: immutable host caps, canonical policy identity,
// and additive loop-registry configuration without Candidate authority.
import { describe, expect, it } from "vitest";
import type { DetectorOrchestrationPolicy } from "../src/index.js";
import { detectorOrchestrationPolicyDigest, parseDetectorOrchestrationPolicy } from "../src/index.js";
import { createRecurrenceRunnerHarness } from "./detector-recurrence-harness.js";

function policy(
  input: {
    readonly id?: string;
    readonly version?: string;
    readonly maximumInvocationsPerRun?: number;
    readonly maximumInsightGroupsPerRun?: number;
    readonly maximumEvidenceHealthGroupsPerRun?: number;
    readonly rejectionSuppression?: DetectorOrchestrationPolicy["rejectionSuppression"];
  } = {},
): DetectorOrchestrationPolicy {
  const base = {
    id: input.id ?? "host.detector-orchestration",
    version: input.version ?? "1.0.0",
    caps: {
      maximumInvocationsPerRun: input.maximumInvocationsPerRun ?? 4,
      maximumInsightGroupsPerRun: input.maximumInsightGroupsPerRun ?? 3,
      maximumEvidenceHealthGroupsPerRun: input.maximumEvidenceHealthGroupsPerRun ?? 2,
    },
    rejectionSuppression:
      input.rejectionSuppression ??
      ({
        mode: "evidence_multiplier",
        minimumDistinctEpisodeMultiplier: 2,
      } satisfies DetectorOrchestrationPolicy["rejectionSuppression"]),
  };
  return parseDetectorOrchestrationPolicy({
    schemaVersion: 1,
    ...base,
    policyDigest: detectorOrchestrationPolicyDigest(base),
  });
}

describe("DetectorOrchestrationPolicy record", () => {
  it("round-trips unknown input, drops unknown fields, and pins its digest golden", () => {
    const value = policy();
    const parsed = parseDetectorOrchestrationPolicy({
      ...value,
      unknownTopLevel: "drop-me",
      caps: { ...value.caps, unknownCap: 99 },
      rejectionSuppression: { ...value.rejectionSuppression, unknownSuppression: true },
    });
    expect(parsed).toEqual(value);
    expect(JSON.stringify(parsed)).not.toContain("unknown");
    expect(value.policyDigest).toBe("72f07c85c6ec45addae7c12494f015fc16ceb98f9e4b8466814998559c28cf93");
  });

  it("binds every policy field and suppression branch into identity", () => {
    const baseline = policy();
    const changed = [
      policy({ id: "host.detector-orchestration.changed" }),
      policy({ version: "1.0.1" }),
      policy({ maximumInvocationsPerRun: 5 }),
      policy({ maximumInsightGroupsPerRun: 4 }),
      policy({ maximumEvidenceHealthGroupsPerRun: 3 }),
      policy({ rejectionSuppression: { mode: "disabled" } }),
      policy({
        rejectionSuppression: { mode: "evidence_multiplier", minimumDistinctEpisodeMultiplier: 3 },
      }),
    ];
    expect(new Set([baseline.policyDigest, ...changed.map((value) => value.policyDigest)]).size).toBe(
      changed.length + 1,
    );
  });

  it("accepts exact numerical boundaries and rejects unsafe, fractional, and out-of-range values", () => {
    for (const value of [
      policy({ maximumInvocationsPerRun: 1 }),
      policy({ maximumInvocationsPerRun: 100 }),
      policy({ maximumInsightGroupsPerRun: 0 }),
      policy({ maximumInsightGroupsPerRun: 100 }),
      policy({ maximumEvidenceHealthGroupsPerRun: 0 }),
      policy({ maximumEvidenceHealthGroupsPerRun: 100 }),
      policy({
        rejectionSuppression: { mode: "evidence_multiplier", minimumDistinctEpisodeMultiplier: 2 },
      }),
      policy({
        rejectionSuppression: { mode: "evidence_multiplier", minimumDistinctEpisodeMultiplier: 100 },
      }),
    ]) {
      expect(parseDetectorOrchestrationPolicy(value)).toEqual(value);
    }

    const baseline = policy();
    const invalidCaps = [
      { ...baseline.caps, maximumInvocationsPerRun: 0 },
      { ...baseline.caps, maximumInvocationsPerRun: 101 },
      { ...baseline.caps, maximumInvocationsPerRun: 1.5 },
      { ...baseline.caps, maximumInvocationsPerRun: Number.NaN },
      { ...baseline.caps, maximumInsightGroupsPerRun: -1 },
      { ...baseline.caps, maximumInsightGroupsPerRun: 101 },
      { ...baseline.caps, maximumEvidenceHealthGroupsPerRun: -1 },
      { ...baseline.caps, maximumEvidenceHealthGroupsPerRun: 101 },
    ];
    for (const caps of invalidCaps) {
      expect(() => parseDetectorOrchestrationPolicy({ ...baseline, caps })).toThrowError(
        expect.objectContaining({ code: "schema.invalid" }),
      );
    }
    for (const minimumDistinctEpisodeMultiplier of [1, 101, 2.5, Number.POSITIVE_INFINITY]) {
      expect(() =>
        parseDetectorOrchestrationPolicy({
          ...baseline,
          rejectionSuppression: { mode: "evidence_multiplier", minimumDistinctEpisodeMultiplier },
        }),
      ).toThrowError(expect.objectContaining({ code: "schema.invalid" }));
    }
  });

  it("requires canonical SemVer, known schema/mode, complete fields, and an exact digest", () => {
    const baseline = policy();
    for (const version of ["1", "01.0.0", "v1.0.0", "1.0.0+", "1.0.0-"]) {
      expect(() => parseDetectorOrchestrationPolicy({ ...baseline, version })).toThrowError(
        expect.objectContaining({ code: "schema.invalid" }),
      );
    }
    for (const malformed of [
      { ...baseline, schemaVersion: 2 },
      { ...baseline, caps: null },
      { ...baseline, rejectionSuppression: { mode: "unknown" } },
      { ...baseline, policyDigest: "0".repeat(64) },
    ]) {
      expect(() => parseDetectorOrchestrationPolicy(malformed)).toThrowError(
        expect.objectContaining({ code: expect.stringMatching(/^schema\./) }),
      );
    }
  });
});

describe("orchestration policy loop configuration identity", () => {
  it("keeps omission byte-compatible and binds every configured policy change into loop registry identity", async () => {
    const omittedA = await createRecurrenceRunnerHarness({ label: "policy-omitted-a" });
    const omittedB = await createRecurrenceRunnerHarness({ label: "policy-omitted-b" });
    expect(omittedB.context.registryRevision).toBe(omittedA.context.registryRevision);

    const configured = policy();
    const equivalent = policy();
    const configuredA = await createRecurrenceRunnerHarness({
      label: "policy-configured-a",
      detectorOrchestrationPolicy: configured,
    });
    const configuredB = await createRecurrenceRunnerHarness({
      label: "policy-configured-b",
      detectorOrchestrationPolicy: equivalent,
    });
    expect(configuredB.context.registryRevision).toBe(configuredA.context.registryRevision);
    expect(configuredA.context.registryRevision).not.toBe(omittedA.context.registryRevision);

    const changed = [
      policy({ id: "host.detector-orchestration.changed" }),
      policy({ version: "1.0.1" }),
      policy({ maximumInvocationsPerRun: 5 }),
      policy({ maximumInsightGroupsPerRun: 4 }),
      policy({ maximumEvidenceHealthGroupsPerRun: 3 }),
      policy({ rejectionSuppression: { mode: "disabled" } }),
      policy({
        rejectionSuppression: { mode: "evidence_multiplier", minimumDistinctEpisodeMultiplier: 3 },
      }),
    ];
    const revisions: string[] = [];
    for (const detectorOrchestrationPolicy of changed) {
      const harness = await createRecurrenceRunnerHarness({
        label: `policy-change-${revisions.length}`,
        detectorOrchestrationPolicy,
      });
      revisions.push(harness.context.registryRevision);
    }
    expect(new Set([configuredA.context.registryRevision, ...revisions]).size).toBe(changed.length + 1);
  });
});
