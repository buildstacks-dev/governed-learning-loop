// #30c2b2 durable pack-run receipt record: canonical population, normalized
// child facts, bounded recurrence governance, and content-addressed identity.
import { describe, expect, it } from "vitest";
import type { DetectorPackRunReceipt } from "../src/index.js";
import { parseDetectorPackRunReceipt, sha256HexOfCanonicalJson, toJsonValue } from "../src/index.js";
import {
  classifyAssessedRecurrenceGovernance,
  detectorPackRunGovernanceSnapshotDigest,
  detectorPackRunItemDigest,
  detectorPackRunKeyDigest,
  detectorPackRunPopulationDigest,
  detectorPackRunReceiptDigest,
} from "../src/records/detector-pack-run-receipt.js";
import {
  PRIVATE_LOCATOR,
  createDetectorOrchestrationPolicy,
  createRecurrenceRunnerHarness,
  detectedInsightDraft,
  packRef,
} from "./detector-recurrence-harness.js";

type ReceiptItem = DetectorPackRunReceipt["items"][number];
type GroupedRecurrence = Extract<ReceiptItem["recurrence"], { readonly status: "grouped" }>;
type AssessedGovernance = Extract<GroupedRecurrence["governance"], { readonly status: "assessed" }>;
type CandidateBinding = AssessedGovernance["candidateBindings"][number];

async function receiptFixture(): Promise<DetectorPackRunReceipt> {
  const harness = await createRecurrenceRunnerHarness({
    label: "pack-receipt-record",
    detectorOrchestrationPolicy: createDetectorOrchestrationPolicy(),
    evaluate: (window) => detectedInsightDraft(window, PRIVATE_LOCATOR),
  });
  const result = await harness.learning.runDetectorPack({
    mode: "commit",
    pack: packRef(harness.pack),
    scope: harness.scope,
    episodeRecordIds: harness.episodeRecordIds,
  });
  if (result.receipt === undefined) throw new Error("expected configured commit receipt");
  return result.receipt;
}

function rawReceipt(input: DetectorPackRunReceipt): unknown {
  const populationBase = {
    requestedEpisodeRecordIds: input.population.requestedEpisodeRecordIds,
    resolvedEpisodes: input.population.resolvedEpisodes,
  };
  const population = { ...populationBase, populationDigest: detectorPackRunPopulationDigest(populationBase) };
  const items = input.items.map((item) => {
    const { itemDigest: _itemDigest, ...base } = item;
    return { ...base, itemDigest: detectorPackRunItemDigest(base) };
  });
  const base = {
    loopRegistryRevision: input.loopRegistryRevision,
    semanticRegistryDigest: input.semanticRegistryDigest,
    policy: input.policy,
    pack: input.pack,
    scope: input.scope,
    scopeDigest: input.scopeDigest,
    scopePolicyDigest: input.scopePolicyDigest,
    population,
    governanceSnapshotDigest: detectorPackRunGovernanceSnapshotDigest(items),
    items,
    status: input.status,
  };
  const packRunKeyDigest = detectorPackRunKeyDigest(base);
  const receiptBase = { ...base, packRunKeyDigest };
  return {
    schemaVersion: 1,
    id: `detector-pack-run-${packRunKeyDigest}`,
    ...receiptBase,
    receiptDigest: detectorPackRunReceiptDigest(receiptBase),
  };
}

function rebuildReceipt(input: DetectorPackRunReceipt): DetectorPackRunReceipt {
  return parseDetectorPackRunReceipt(rawReceipt(input));
}

function changedDigest(value: string): string {
  return `${value.startsWith("0") ? "1" : "0"}${value.slice(1)}`;
}

function numberedDigest(value: number): string {
  return value.toString(16).padStart(64, "0");
}

function receiptWithCandidateGroups(
  receipt: DetectorPackRunReceipt,
  candidateCounts: readonly number[],
): DetectorPackRunReceipt {
  const template = receipt.items[0];
  if (template === undefined || template.lens === null || template.recurrence.status !== "grouped") {
    throw new Error("expected grouped candidate receipt template");
  }
  const groupedTemplate = template.recurrence;
  let candidateIndex = 1;
  const items = candidateCounts.map((candidateCount, groupIndex): ReceiptItem => {
    const episodeIdentityDigests = [numberedDigest(700_000 + groupIndex)];
    const candidateBindings: CandidateBinding[] = Array.from({ length: candidateCount }, () => {
      const index = candidateIndex;
      candidateIndex += 1;
      const derivationDigest = numberedDigest(200_000 + index);
      return {
        candidateId: `candidate-${String(index).padStart(5, "0")}`,
        candidateDigest: numberedDigest(index),
        claimDigest: numberedDigest(100_000 + index),
        derivationId: `insight-${derivationDigest}`,
        derivationDigest,
        episodeIdentitySetDigest: sha256HexOfCanonicalJson(toJsonValue(episodeIdentityDigests)),
        distinctEpisodeCount: 1,
        supersedes: null,
        latestReview: null,
      };
    });
    const executionKeyDigest = numberedDigest(400_000 + groupIndex);
    const recurrence: GroupedRecurrence = {
      ...groupedTemplate,
      groupKeyDigest: numberedDigest(500_000 + groupIndex),
      decisionBindingDigest: numberedDigest(600_000 + groupIndex),
      episodeIdentityDigests,
      episodeIdentitySetDigest: sha256HexOfCanonicalJson(toJsonValue(episodeIdentityDigests)),
      distinctEpisodeCount: 1,
      governance: {
        status: "assessed",
        candidateBindings,
        groupDisposition: candidateBindings.length === 0 ? "available" : "deduplicated",
        requiredSupersedes: null,
        requiredOverrideCount: null,
        governingRejection: null,
        reasonCodes: [candidateBindings.length === 0 ? "candidate.group_available" : "candidate.group_deduplicated"],
      },
    };
    const base = {
      ...template,
      detector: { ...template.detector, id: `detector-${String(groupIndex).padStart(3, "0")}` },
      executionRef: {
        id: `detector-execution-${executionKeyDigest}`,
        executionKeyDigest,
        executionDigest: numberedDigest(300_000 + groupIndex),
      },
      recurrence,
    };
    const { itemDigest: _itemDigest, ...itemBase } = base;
    return { ...itemBase, itemDigest: detectorPackRunItemDigest(itemBase) };
  });
  return rebuildReceipt({ ...receipt, items, status: "completed" });
}

function receiptWithEpisodeGroups(
  receipt: DetectorPackRunReceipt,
  episodeCounts: readonly number[],
): DetectorPackRunReceipt {
  const template = receipt.items[0];
  if (template === undefined || template.lens === null || template.recurrence.status !== "grouped") {
    throw new Error("expected grouped episode receipt template");
  }
  const groupedTemplate = template.recurrence;
  let episodeIndex = 1;
  const items = episodeCounts.map((episodeCount, groupIndex): ReceiptItem => {
    const episodeIdentityDigests = Array.from({ length: episodeCount }, () => {
      const digest = numberedDigest(800_000 + episodeIndex);
      episodeIndex += 1;
      return digest;
    });
    const executionKeyDigest = numberedDigest(900_000 + groupIndex);
    const recurrence: GroupedRecurrence = {
      ...groupedTemplate,
      groupKeyDigest: numberedDigest(1_000_000 + groupIndex),
      decisionBindingDigest: numberedDigest(1_100_000 + groupIndex),
      episodeIdentityDigests,
      episodeIdentitySetDigest: sha256HexOfCanonicalJson(toJsonValue(episodeIdentityDigests)),
      distinctEpisodeCount: episodeIdentityDigests.length,
      governance: {
        status: "not_assessed",
        reason: "candidate_claims_deferred",
        groupDisposition: "unassessed",
      },
    };
    const base = {
      ...template,
      detector: { ...template.detector, id: `detector-episodes-${String(groupIndex).padStart(3, "0")}` },
      executionRef: {
        id: `detector-execution-${executionKeyDigest}`,
        executionKeyDigest,
        executionDigest: numberedDigest(1_200_000 + groupIndex),
      },
      recurrence,
    };
    const { itemDigest: _itemDigest, ...itemBase } = base;
    return { ...itemBase, itemDigest: detectorPackRunItemDigest(itemBase) };
  });
  return rebuildReceipt({ ...receipt, items, status: "completed" });
}

function replaceItem(
  receipt: DetectorPackRunReceipt,
  item: Omit<ReceiptItem, "itemDigest">,
  status: DetectorPackRunReceipt["status"] = receipt.status,
): DetectorPackRunReceipt {
  return rebuildReceipt({ ...receipt, items: [{ ...item, itemDigest: detectorPackRunItemDigest(item) }], status });
}

describe("DetectorPackRunReceipt canonical record", () => {
  it("round-trips unknown input, drops unknown fields, and pins all digest goldens", async () => {
    const receipt = await receiptFixture();
    const parsed = parseDetectorPackRunReceipt({
      ...receipt,
      unknownTopLevel: "drop-me",
      population: { ...receipt.population, unknownPopulation: true },
      items: receipt.items.map((item) => ({ ...item, unknownItem: true })),
    });
    expect(parsed).toEqual(receipt);
    expect(JSON.stringify(parsed)).not.toContain("unknown");
    expect(receipt.population.populationDigest).toBe(
      "9e02cdb3c66805fa0561ba2f810debb0f0584a2f6bdb13bdef3af6fec758a030",
    );
    expect(receipt.items[0]?.itemDigest).toBe("dc4576f53512ae86d9335f43c32f41e0163fd701290bef6e925b2f9ed7a80419");
    expect(receipt.governanceSnapshotDigest).toBe("0e2adc01a9799b52210db99dada2786c53acc5062af8a2bb8fee3fc1ea45ece1");
    expect(receipt.packRunKeyDigest).toBe("682ad70378bb2243e01b8d1dd8ba0e374c40735b7c023fa58ee07ff24c5f1975");
    expect(receipt.receiptDigest).toBe("ccf202e7412e678b8694c18629e78b91d40d4702ae9277d20a3da3e26377c53f");
  });

  it("binds every top-level field family into key or full receipt identity", async () => {
    const receipt = await receiptFixture();
    const baseKey = receipt.packRunKeyDigest;
    const baseFull = receipt.receiptDigest;
    const changed: readonly (readonly [string, DetectorPackRunReceipt])[] = [
      ["loop registry", { ...receipt, loopRegistryRevision: changedDigest(receipt.loopRegistryRevision) }],
      ["semantic registry", { ...receipt, semanticRegistryDigest: changedDigest(receipt.semanticRegistryDigest) }],
      ["pack", { ...receipt, pack: { ...receipt.pack, manifestDigest: changedDigest(receipt.pack.manifestDigest) } }],
      ["scope policy", { ...receipt, scopePolicyDigest: changedDigest(receipt.scopePolicyDigest) }],
      [
        "policy",
        {
          ...receipt,
          policy: createDetectorOrchestrationPolicy({ maximumInvocationsPerRun: 99 }),
        },
      ],
    ];
    for (const [label, value] of changed) {
      const rebuilt = rebuildReceipt(value);
      expect(rebuilt.packRunKeyDigest, label).not.toBe(baseKey);
      expect(rebuilt.receiptDigest, label).not.toBe(baseFull);
    }

    const item = receipt.items[0];
    if (item === undefined || item.executionRef === null) throw new Error("expected receipt item execution");
    const fullOnly = rebuildReceipt({
      ...receipt,
      items: [
        {
          ...item,
          executionRef: { ...item.executionRef, executionDigest: "5".repeat(64) },
        },
      ],
    });
    expect(fullOnly.packRunKeyDigest).toBe(baseKey);
    expect(fullOnly.receiptDigest).not.toBe(baseFull);
    const reasonsOnly = rebuildReceipt({
      ...receipt,
      items: receipt.items.map((value) => ({ ...value, reasonCodes: ["fixture.changed"] })),
    });
    expect(reasonsOnly.packRunKeyDigest).toBe(baseKey);
    expect(reasonsOnly.receiptDigest).not.toBe(baseFull);
  });

  it("requires requested and resolved populations to match one-to-one in exact scope", async () => {
    const receipt = await receiptFixture();
    const episode = receipt.population.resolvedEpisodes[0];
    if (episode === undefined) throw new Error("expected resolved episode");
    const variants: DetectorPackRunReceipt["population"][] = [
      { ...receipt.population, requestedEpisodeRecordIds: [] },
      { ...receipt.population, resolvedEpisodes: [] },
      { ...receipt.population, requestedEpisodeRecordIds: [...receipt.population.requestedEpisodeRecordIds, "extra"] },
      { ...receipt.population, resolvedEpisodes: [{ ...episode, episodeRecordId: "foreign" }] },
      { ...receipt.population, resolvedEpisodes: [{ ...episode, scopeDigest: "6".repeat(64) }] },
      {
        ...receipt.population,
        requestedEpisodeRecordIds: [episode.episodeRecordId, episode.episodeRecordId],
        resolvedEpisodes: [episode, { ...episode, episodeRecordDigest: "7".repeat(64) }],
      },
    ];
    for (const population of variants) {
      expect(() => rebuildReceipt({ ...receipt, population })).toThrowError(
        expect.objectContaining({ code: expect.stringMatching(/^schema\./) }),
      );
    }
    const empty = rebuildReceipt({
      ...receipt,
      population: { requestedEpisodeRecordIds: [], resolvedEpisodes: [], populationDigest: "0".repeat(64) },
    });
    expect(empty.population).toMatchObject({ requestedEpisodeRecordIds: [], resolvedEpisodes: [] });
  });

  it("enforces execution, lens, recurrence, ordering, and normalized status invariants", async () => {
    const receipt = await receiptFixture();
    const item = receipt.items[0];
    if (item === undefined || item.executionRef === null || item.recurrence.status !== "grouped") {
      throw new Error("expected grouped receipt item");
    }
    const invalid: Omit<ReceiptItem, "itemDigest">[] = [
      { ...item, executionDisposition: "executed", executionRef: null },
      { ...item, executionDisposition: "capped" },
      { ...item, outputKind: "evidence_health" },
      { ...item, lens: null },
      {
        ...item,
        recurrence: { ...item.recurrence, executionCount: 0 },
      },
      {
        ...item,
        recurrence: { ...item.recurrence, distinctEpisodeCount: item.recurrence.distinctEpisodeCount + 1 },
      },
    ];
    for (const value of invalid) {
      expect(() => replaceItem(receipt, value)).toThrowError(expect.objectContaining({ code: "schema.corrupt" }));
    }
    const negative = replaceItem(receipt, {
      ...item,
      recurrence: { status: "absent", reason: "condition_not_detected", decisionBindingDigest: null },
    });
    expect(negative.items[0]?.recurrence).toEqual({
      status: "absent",
      reason: "condition_not_detected",
      decisionBindingDigest: null,
    });

    const duplicate = { ...item, itemDigest: item.itemDigest };
    expect(() => rebuildReceipt({ ...receipt, items: [item, duplicate] })).toThrowError(
      expect.objectContaining({ code: "schema.invalid" }),
    );
    expect(() => rebuildReceipt({ ...receipt, status: "partial" })).toThrowError(
      expect.objectContaining({ code: "schema.corrupt" }),
    );
    expect(JSON.stringify(receipt.items[0])).not.toContain("callbackInvoked");
    expect(JSON.stringify(receipt.items[0])).not.toContain('"existing"');
  });

  it("accepts the future assessed branch and enforces suppression/candidate bindings", async () => {
    const initial = await receiptFixture();
    const receipt = rebuildReceipt({
      ...initial,
      policy: createDetectorOrchestrationPolicy({
        rejectionSuppression: { mode: "evidence_multiplier", minimumDistinctEpisodeMultiplier: 2 },
      }),
    });
    const item = receipt.items[0];
    if (item === undefined || item.recurrence.status !== "grouped") throw new Error("expected grouped item");
    const groupedRecurrence = item.recurrence;
    const latestReview: NonNullable<CandidateBinding["latestReview"]> = {
      id: "review-one",
      recordDigest: "4".repeat(64),
      disposition: "reject",
      reviewedAt: "2026-08-20T00:00:00.000Z",
    };
    const candidate: CandidateBinding = {
      candidateId: "candidate-one",
      candidateDigest: "1".repeat(64),
      claimDigest: "2".repeat(64),
      derivationId: `insight-${"3".repeat(64)}`,
      derivationDigest: "3".repeat(64),
      episodeIdentitySetDigest: groupedRecurrence.episodeIdentitySetDigest,
      distinctEpisodeCount: 1,
      supersedes: null,
      latestReview,
    };
    const candidateRef = {
      candidateId: candidate.candidateId,
      candidateDigest: candidate.candidateDigest,
      claimDigest: candidate.claimDigest,
    };
    const governingRejection: NonNullable<AssessedGovernance["governingRejection"]> = {
      ...candidateRef,
      reviewId: latestReview.id,
      reviewRecordDigest: latestReview.recordDigest,
    };
    const governance: AssessedGovernance = {
      status: "assessed",
      candidateBindings: [candidate],
      groupDisposition: "suppressed",
      requiredSupersedes: candidateRef,
      requiredOverrideCount: 2,
      governingRejection,
      reasonCodes: ["candidate.rejection_suppressed"],
    };
    const assessed = replaceItem(receipt, {
      ...item,
      recurrence: { ...groupedRecurrence, governance },
    });
    expect(assessed.items[0]?.recurrence).toMatchObject({ governance: { status: "assessed" } });
    expect(() =>
      classifyAssessedRecurrenceGovernance({
        policy: createDetectorOrchestrationPolicy({
          rejectionSuppression: { mode: "evidence_multiplier", minimumDistinctEpisodeMultiplier: 100 },
        }),
        currentDistinctEpisodeCount: 1,
        candidateBindings: [{ ...candidate, distinctEpisodeCount: Number.MAX_SAFE_INTEGER }],
      }),
    ).toThrowError(expect.objectContaining({ code: "schema.invalid" }));

    const invalidGovernance: readonly AssessedGovernance[] = [
      { ...governance, requiredOverrideCount: null },
      { ...governance, governingRejection: null },
      {
        ...governance,
        governingRejection: { ...governingRejection, reviewId: "foreign-review" },
      },
      {
        ...governance,
        candidateBindings: [{ ...candidate, distinctEpisodeCount: 0 }],
      },
    ];
    for (const changed of invalidGovernance) {
      expect(() =>
        replaceItem(receipt, {
          ...item,
          recurrence: { ...groupedRecurrence, governance: changed },
        }),
      ).toThrowError(expect.objectContaining({ code: "schema.corrupt" }));
    }
    for (const reasonCodes of [
      ["candidate.recurrence_available"],
      ["candidate.recurrence_deduplicated"],
      ["candidate.rejection_evidence_threshold_met"],
      ["candidate.rejection_suppressed", "candidate.group_available"],
    ]) {
      expect(() =>
        replaceItem(receipt, {
          ...item,
          recurrence: { ...groupedRecurrence, governance: { ...governance, reasonCodes } },
        }),
      ).toThrowError(expect.objectContaining({ code: expect.stringMatching(/^schema\./) }));
    }
  });

  it("requires policy-derived group caps and partial status for assessed capped governance", async () => {
    const receipt = await receiptFixture();
    const item = receipt.items[0];
    if (item === undefined || item.recurrence.status !== "grouped") throw new Error("expected grouped item");
    const cappedPolicy = createDetectorOrchestrationPolicy({ maximumInsightGroupsPerRun: 0 });
    const capped = rebuildReceipt({
      ...receipt,
      policy: cappedPolicy,
      items: [
        {
          ...item,
          recurrence: {
            ...item.recurrence,
            governance: {
              status: "assessed",
              candidateBindings: [],
              groupDisposition: "capped",
              requiredSupersedes: null,
              requiredOverrideCount: null,
              governingRejection: null,
              reasonCodes: ["detector.pack_group_capped"],
            },
          },
        },
      ],
      status: "partial",
    });
    expect(capped).toMatchObject({
      status: "partial",
      items: [{ recurrence: { governance: { groupDisposition: "capped" } } }],
    });

    expect(() => rebuildReceipt({ ...capped, status: "completed" })).toThrowError(
      expect.objectContaining({ code: "schema.corrupt" }),
    );
    expect(() => rebuildReceipt({ ...receipt, policy: cappedPolicy })).toThrowError(
      expect.objectContaining({ code: "schema.corrupt" }),
    );
  });

  it("accepts 50,000 total candidate bindings, rejects 50,001, and enforces the 64 MiB byte ceiling", async () => {
    const receipt = await receiptFixture();
    const exact = receiptWithCandidateGroups(
      receipt,
      Array.from({ length: 10 }, () => 5_000),
    );
    expect(
      exact.items.reduce(
        (total, item) =>
          total +
          (item.recurrence.status === "grouped" && item.recurrence.governance.status === "assessed"
            ? item.recurrence.governance.candidateBindings.length
            : 0),
        0,
      ),
    ).toBe(50_000);
    expect(() => receiptWithCandidateGroups(receipt, [...Array.from({ length: 10 }, () => 5_000), 1])).toThrowError(
      expect.objectContaining({ code: "schema.invalid" }),
    );
    expect(() =>
      parseDetectorPackRunReceipt({
        ...receipt,
        privatePaddingCanary: "x".repeat(65 * 1_048_576),
      }),
    ).toThrowError(expect.objectContaining({ code: "schema.invalid" }));
  }, 30_000);

  it("accepts 50,000 total group identities and rejects 50,001 without truncation", async () => {
    const receipt = await receiptFixture();
    const exact = receiptWithEpisodeGroups(
      receipt,
      Array.from({ length: 10 }, () => 5_000),
    );
    expect(
      exact.items.reduce(
        (total, item) =>
          total + (item.recurrence.status === "grouped" ? item.recurrence.episodeIdentityDigests.length : 0),
        0,
      ),
    ).toBe(50_000);
    expect(() => receiptWithEpisodeGroups(receipt, [...Array.from({ length: 10 }, () => 5_000), 1])).toThrowError(
      expect.objectContaining({ code: "schema.invalid" }),
    );
  });
});
