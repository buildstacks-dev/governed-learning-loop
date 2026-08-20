// Measurement and episode-outcome integrity (#31c): runtime scalar typing,
// qualified measurement support, exact outcome ownership, and append-only
// latest/history semantics. Engine-level ingestion/candidate cases follow as
// the integrated resolver lands in this slice.
import { describe, expect, it } from "vitest";
import type {
  EvidencePage,
  EvidenceRefV1,
  LearningStore,
  MeasurementEvidenceRefV2,
  ObservationEvidenceRef,
  QueryPage,
  RegisteredSource,
  Scope,
  WriteResult,
} from "../src/index.js";
import {
  candidateContentDigest,
  conservativePolicy,
  defineSourceRegistration,
  evidenceRefDigest,
  parseCandidate,
  parseEvidenceRef,
  parseMeasurementRecord,
  sha256HexOfCanonicalJson,
  toJsonValue,
} from "../src/index.js";
import type { EngineContext } from "../src/engine/context.js";
import {
  buildEpisodeOutcomeClaim,
  loadLatestEpisodeOutcomeClaim,
  parseEpisodeOutcomeClaim,
  persistEpisodeOutcomeClaim,
} from "../src/engine/episode-outcome.js";
import type { EpisodeOutcomeClaimInput } from "../src/engine/episode-outcome.js";
import { extractPolicyRules } from "../src/engine/policy.js";
import {
  createExactScopePolicy,
  createFixedClock,
  createInMemoryStore,
  createSequentialIds,
  createTestIdentityPort,
} from "../src/testing/index.js";
import { CONTENT_POLICY_ID, candidateInput, createHarness, scriptedSource } from "./engine-harness.js";

const PROVENANCE = {
  sourceId: "measurement-source",
  adapterVersion: "1.0.0",
  sourceRef: "artifact-ref",
  sourceRevision: "revision-1",
  recordRef: "measurement-1",
  contentDigest: "a".repeat(64),
  completeness: "complete" as const,
  trust: "observed" as const,
};

const MEASUREMENT_SCOPE: Scope = [{ type: "project", id: "measurement-project" }];

async function itemsOf<T>(iterable: AsyncIterable<QueryPage<T>>): Promise<readonly T[]> {
  const items: T[] = [];
  for await (const page of iterable) items.push(...page.items);
  return items;
}

function measurementRecord(valueType: "number" | "string" | "boolean", value: unknown): unknown {
  return {
    schemaVersion: 1,
    id: "measurement-source/measurement-1",
    episodeId: "logical-episode",
    metric: { name: "quality", valueType, unit: "score", aggregation: "all" },
    value,
    evidenceIds: ["measurement-source/observation-1"],
    measuredAt: "2026-08-19T00:01:00.000Z",
    provenance: PROVENANCE,
  };
}

const EPISODE = {
  sourceId: "measurement-source",
  episodeId: "logical-episode",
  episodeRecordId: "measurement-source/episode-record",
  episodeRecordDigest: "b".repeat(64),
  episodeIdentityDigest: "c".repeat(64),
  scopeDigest: "d".repeat(64),
  pageReceiptId: `source-page-${"e".repeat(64)}`,
  pageReceiptDigest: "e".repeat(64),
};

function observationRef(input: {
  readonly sourceRecordId: string;
  readonly recordDigest: string;
  readonly pageDigest: string;
  readonly completeness?: "complete" | "partial" | "unknown";
}): ObservationEvidenceRef {
  const bound: Omit<EvidenceRefV1, "schemaVersion" | "referenceDigest"> = {
    kind: "observation",
    recordId: `measurement-source/${input.sourceRecordId}`,
    recordDigest: input.recordDigest,
    sourceId: "measurement-source",
    sourceRegistrationRevision: "f".repeat(64),
    sourceRef: "artifact-ref",
    sourceRevision: "revision-1",
    sourceRecordId: input.sourceRecordId,
    pageRef: `page-${input.sourceRecordId}`,
    pageReceiptId: `source-page-${input.pageDigest}`,
    pageReceiptDigest: input.pageDigest,
    loopRegistryRevision: "0".repeat(64),
    trust: "observed",
    completeness: input.completeness ?? "complete",
    episode: EPISODE,
  };
  return {
    schemaVersion: 1,
    ...bound,
    kind: "observation",
    referenceDigest: evidenceRefDigest(bound),
  };
}

const SUPPORT_A = observationRef({
  sourceRecordId: "observation-a",
  recordDigest: "1".repeat(64),
  pageDigest: "2".repeat(64),
});
const SUPPORT_B = observationRef({
  sourceRecordId: "observation-b",
  recordDigest: "3".repeat(64),
  pageDigest: "4".repeat(64),
});

function measurementRef(
  supportingEvidenceRefs: readonly ObservationEvidenceRef[] = [SUPPORT_A, SUPPORT_B],
): MeasurementEvidenceRefV2 {
  const bound: Omit<MeasurementEvidenceRefV2, "referenceDigest"> = {
    schemaVersion: 2,
    kind: "measurement",
    recordId: "measurement-source/measurement-1",
    recordDigest: "5".repeat(64),
    sourceId: "measurement-source",
    sourceRegistrationRevision: "f".repeat(64),
    sourceRef: "artifact-ref",
    sourceRevision: "revision-1",
    sourceRecordId: "measurement-1",
    pageRef: "page-measurement",
    pageReceiptId: `source-page-${"6".repeat(64)}`,
    pageReceiptDigest: "6".repeat(64),
    loopRegistryRevision: "0".repeat(64),
    trust: "observed",
    completeness: "complete",
    episode: EPISODE,
    supportingEvidenceRefs,
  };
  return { ...bound, referenceDigest: evidenceRefDigest(bound) };
}

const MEASUREMENT_REF = measurementRef();

function legacyMeasurementRef(): EvidenceRefV1 {
  const bound: Omit<EvidenceRefV1, "schemaVersion" | "referenceDigest"> = {
    kind: "measurement",
    recordId: MEASUREMENT_REF.recordId,
    recordDigest: MEASUREMENT_REF.recordDigest,
    sourceId: MEASUREMENT_REF.sourceId,
    sourceRegistrationRevision: MEASUREMENT_REF.sourceRegistrationRevision,
    sourceRef: MEASUREMENT_REF.sourceRef,
    sourceRevision: MEASUREMENT_REF.sourceRevision,
    sourceRecordId: MEASUREMENT_REF.sourceRecordId,
    pageRef: MEASUREMENT_REF.pageRef,
    pageReceiptId: MEASUREMENT_REF.pageReceiptId,
    pageReceiptDigest: MEASUREMENT_REF.pageReceiptDigest,
    loopRegistryRevision: MEASUREMENT_REF.loopRegistryRevision,
    trust: MEASUREMENT_REF.trust,
    completeness: MEASUREMENT_REF.completeness,
    episode: MEASUREMENT_REF.episode,
  };
  return { schemaVersion: 1, ...bound, referenceDigest: evidenceRefDigest(bound) };
}

function contextFor(store: LearningStore): EngineContext {
  const policy = conservativePolicy();
  return {
    store,
    policy,
    policyRules: extractPolicyRules(policy),
    scopePolicy: createExactScopePolicy(),
    contentPoliciesById: new Map(),
    sources: new Set(),
    identity: createTestIdentityPort(),
    registryRevision: "7".repeat(64),
    queryCursorScopeDigest: "8".repeat(64),
    clock: createFixedClock("2026-08-19T00:00:00.000Z"),
    ids: createSequentialIds("outcome"),
  };
}

function claimInput(
  input: {
    readonly status?: "succeeded" | "failed" | "cancelled" | "unknown";
    readonly measurementRefs?: readonly MeasurementEvidenceRefV2[];
    readonly sourceId?: string;
    readonly sourceRevision?: string;
    readonly episodeId?: string;
  } = {},
): EpisodeOutcomeClaimInput {
  return {
    episodeRecordId: "measurement-source/episode-record",
    sourceId: input.sourceId ?? "measurement-source",
    sourceRegistrationRevision: "f".repeat(64),
    sourceRef: "artifact-ref",
    sourceRevision: input.sourceRevision ?? "revision-1",
    episodeId: input.episodeId ?? "logical-episode",
    status: input.status ?? "succeeded",
    measurementRefs: input.measurementRefs ?? [MEASUREMENT_REF],
  };
}

function loseFirstOutcomeAppendAcknowledgement(base: LearningStore): LearningStore {
  let failed = false;
  return {
    get: (key) => base.get(key),
    create: (key, value, digest, operationId) => base.create(key, value, digest, operationId),
    compareAndSet: (key, expectedRevision, value, digest, operationId) =>
      base.compareAndSet(key, expectedRevision, value, digest, operationId),
    append: async (stream, expectedRevision, entries, operationId) => {
      const result = await base.append(stream, expectedRevision, entries, operationId);
      if (!failed && stream.kind === "episode-outcome") {
        failed = true;
        throw new Error("simulated lost outcome append acknowledgement");
      }
      return result;
    },
    tombstone: (input) => base.tombstone(input),
    list: (query) => base.list(query),
  };
}

function conflictingFirstAppend(
  base: LearningStore,
  competing: ReturnType<typeof buildEpisodeOutcomeClaim>,
): LearningStore {
  let injected = false;
  return {
    get: (key) => base.get(key),
    create: (key, value, digest, operationId) => base.create(key, value, digest, operationId),
    compareAndSet: (key, expectedRevision, value, digest, operationId) =>
      base.compareAndSet(key, expectedRevision, value, digest, operationId),
    append: async (stream, expectedRevision, entries, operationId): Promise<WriteResult> => {
      if (!injected && stream.kind === "episode-outcome") {
        injected = true;
        const value = toJsonValue(competing);
        const digest = sha256HexOfCanonicalJson(value);
        await base.append(
          stream,
          expectedRevision,
          [{ id: `outcome:${competing.claimDigest}`, digest, value }],
          "competing-outcome",
        );
      }
      return base.append(stream, expectedRevision, entries, operationId);
    },
    tombstone: (input) => base.tombstone(input),
    list: (query) => base.list(query),
  };
}

function stagedSource(id: string, pages: () => readonly EvidencePage[]): RegisteredSource<null> {
  return defineSourceRegistration({
    source: scriptedSource(id, pages),
    trustCeiling: "observed",
    contentPolicyId: CONTENT_POLICY_ID,
  });
}

function stagedPage(input: {
  readonly pageRef: string;
  readonly sourceRef?: string;
  readonly revision?: string;
  readonly pageCompleteness?: "complete" | "partial" | "unknown";
  readonly observations?: EvidencePage["observations"];
  readonly measurements?: EvidencePage["measurements"];
  readonly episodes?: EvidencePage["episodes"];
}): EvidencePage {
  return {
    sourceRef: input.sourceRef ?? "measurement-artifact",
    pageRef: input.pageRef,
    state: {
      status: "available",
      sourceRevision: input.revision ?? "measurement-revision",
      completeness: input.pageCompleteness ?? "complete",
    },
    observations: input.observations ?? [],
    measurements: input.measurements ?? [],
    episodes: input.episodes ?? [],
    diagnostics: [],
  };
}

function projectedEpisode(
  input: {
    readonly sourceRecordId?: string;
    readonly episodeId?: string;
    readonly status?: "succeeded" | "failed" | "cancelled" | "unknown";
    readonly measurementIds?: readonly string[];
    readonly completeness?: "complete" | "partial" | "unknown";
    readonly scope?: Scope;
  } = {},
): EvidencePage["episodes"][number] {
  return {
    sourceRecordId: input.sourceRecordId ?? "episode-record",
    episodeId: input.episodeId ?? "logical-episode",
    episodeClass: "interactive",
    completeness: input.completeness ?? "complete",
    scope: input.scope ?? MEASUREMENT_SCOPE,
    openedAt: "2026-08-19T00:00:00.000Z",
    closedAt: "2026-08-19T00:05:00.000Z",
    ...(input.status === undefined ? {} : { status: input.status }),
    measurementSourceRecordIds: input.measurementIds ?? [],
  };
}

function projectedObservation(input: {
  readonly id: string;
  readonly episodeId?: string;
  readonly completeness?: "complete" | "partial" | "unknown";
  readonly privateCanary?: string;
}): EvidencePage["observations"][number] {
  return {
    sourceRecordId: input.id,
    episodeId: input.episodeId ?? "logical-episode",
    kind: "verifier.completed",
    data: input.privateCanary === undefined ? { verifier: "synthetic" } : { privateContent: input.privateCanary },
    completeness: input.completeness ?? "complete",
  };
}

function projectedMeasurement(
  input: {
    readonly id?: string;
    readonly episodeId?: string;
    readonly evidenceIds?: readonly string[];
    readonly valueType?: "number" | "string" | "boolean";
    readonly value?: number | string | boolean;
  } = {},
): EvidencePage["measurements"][number] {
  const valueType = input.valueType ?? "boolean";
  return {
    sourceRecordId: input.id ?? "measurement-record",
    episodeId: input.episodeId ?? "logical-episode",
    metric: { name: "quality", valueType, unit: "score", aggregation: "all" },
    value: input.value ?? (valueType === "boolean" ? true : valueType === "number" ? 1 : "pass"),
    evidenceSourceRecordIds: input.evidenceIds ?? ["observation-a"],
    measuredAt: "2026-08-19T00:04:00.000Z",
  };
}

function foundationPage(
  input: {
    readonly observations?: EvidencePage["observations"];
    readonly measurements?: EvidencePage["measurements"];
    readonly episodes?: EvidencePage["episodes"];
    readonly pageRef?: string;
    readonly sourceRef?: string;
    readonly revision?: string;
  } = {},
): EvidencePage {
  return stagedPage({
    pageRef: input.pageRef ?? "foundation-page",
    ...(input.sourceRef === undefined ? {} : { sourceRef: input.sourceRef }),
    ...(input.revision === undefined ? {} : { revision: input.revision }),
    observations: input.observations ?? [projectedObservation({ id: "observation-a" })],
    measurements: input.measurements ?? [projectedMeasurement()],
    episodes: input.episodes ?? [projectedEpisode()],
  });
}

function outcomePage(
  input: {
    readonly pageRef?: string;
    readonly status?: "succeeded" | "failed" | "cancelled" | "unknown";
    readonly measurementIds?: readonly string[];
    readonly sourceRef?: string;
    readonly revision?: string;
    readonly episodeId?: string;
    readonly sourceRecordId?: string;
    readonly scope?: Scope;
  } = {},
): EvidencePage {
  return stagedPage({
    pageRef: input.pageRef ?? "outcome-page",
    ...(input.sourceRef === undefined ? {} : { sourceRef: input.sourceRef }),
    ...(input.revision === undefined ? {} : { revision: input.revision }),
    episodes: [
      projectedEpisode({
        ...(input.sourceRecordId === undefined ? {} : { sourceRecordId: input.sourceRecordId }),
        ...(input.episodeId === undefined ? {} : { episodeId: input.episodeId }),
        status: input.status ?? "succeeded",
        measurementIds: input.measurementIds ?? ["measurement-record"],
        ...(input.scope === undefined ? {} : { scope: input.scope }),
      }),
    ],
  });
}

describe("MeasurementRecord runtime value typing", () => {
  const scalarCases = [
    { type: "number" as const, value: 42 },
    { type: "string" as const, value: "42" },
    { type: "boolean" as const, value: true },
  ];

  for (const metric of scalarCases) {
    for (const actual of scalarCases) {
      it(`${metric.type} metric ${metric.type === actual.type ? "accepts" : "rejects"} ${actual.type} value`, () => {
        if (metric.type === actual.type) {
          expect(parseMeasurementRecord(measurementRecord(metric.type, actual.value))).toMatchObject({
            metric: { valueType: metric.type },
            value: actual.value,
          });
        } else {
          expect(() => parseMeasurementRecord(measurementRecord(metric.type, actual.value))).toThrowError(
            expect.objectContaining({ code: "schema.invalid" }),
          );
        }
      });
    }
  }

  it("rejects missing, non-scalar, and non-finite values instead of treating them as zero", () => {
    const complete = measurementRecord("number", 1);
    if (typeof complete !== "object" || complete === null || Array.isArray(complete)) {
      throw new Error("invalid measurement fixture");
    }
    const missing = Object.fromEntries(Object.entries(complete).filter(([key]) => key !== "value"));
    for (const value of [
      missing,
      measurementRecord("number", null),
      measurementRecord("number", {}),
      measurementRecord("number", []),
      measurementRecord("number", Number.NaN),
      measurementRecord("number", Number.POSITIVE_INFINITY),
    ]) {
      expect(() => parseMeasurementRecord(value)).toThrowError(expect.objectContaining({ code: "schema.invalid" }));
    }
  });
});

describe("qualified measurement EvidenceRef", () => {
  it("keeps schema-v1 measurement lineage parseable but structurally unqualified", () => {
    const legacy = legacyMeasurementRef();
    const parsed = parseEvidenceRef(legacy);
    expect(parsed).toEqual(legacy);
    expect(parsed).toMatchObject({ schemaVersion: 1, kind: "measurement" });
    expect("supportingEvidenceRefs" in parsed).toBe(false);
  });

  it("binds nonempty ordered exact supporting observations in schema v2", () => {
    const parsed = parseEvidenceRef(MEASUREMENT_REF);
    expect(parsed).toEqual(MEASUREMENT_REF);
    expect(parsed).toMatchObject({ schemaVersion: 2, kind: "measurement" });
    if (parsed.schemaVersion !== 2) throw new Error("expected measurement EvidenceRef v2");
    expect(parsed.supportingEvidenceRefs.map((reference) => reference.recordId)).toEqual([
      SUPPORT_A.recordId,
      SUPPORT_B.recordId,
    ]);
    expect(parsed.referenceDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(parsed.referenceDigest).toBe("fabaf3f0acaecf7229c20921563472781ab09306a6d02098cf19a4971c571b1b");
    expect(measurementRef([SUPPORT_B, SUPPORT_A]).referenceDigest).not.toBe(parsed.referenceDigest);
  });

  it("rejects stale support tampering, empty supports, and duplicate supports", () => {
    expect(() =>
      parseEvidenceRef({
        ...MEASUREMENT_REF,
        supportingEvidenceRefs: [SUPPORT_B, SUPPORT_A],
      }),
    ).toThrowError(expect.objectContaining({ code: "schema.corrupt" }));
    expect(() => parseEvidenceRef(measurementRef([]))).toThrowError(
      expect.objectContaining({ code: "schema.invalid" }),
    );
    expect(() => parseEvidenceRef(measurementRef([SUPPORT_A, SUPPORT_A]))).toThrowError(
      expect.objectContaining({ code: "schema.invalid" }),
    );
  });

  it("rejects self-consistent supporting observations from another source or episode", () => {
    const foreignSourceBound = {
      ...SUPPORT_A,
      sourceId: "other-source",
      recordId: "other-source/observation-a",
      episode: { ...SUPPORT_A.episode, sourceId: "other-source", episodeRecordId: "other-source/episode-record" },
    };
    const foreignSource = {
      ...foreignSourceBound,
      referenceDigest: evidenceRefDigest(foreignSourceBound),
    };
    expect(() => parseEvidenceRef(measurementRef([foreignSource]))).toThrowError(
      expect.objectContaining({ code: "schema.corrupt" }),
    );

    const foreignEpisodeBound = {
      ...SUPPORT_A,
      episode: { ...SUPPORT_A.episode, episodeId: "other-episode" },
    };
    const foreignEpisode = {
      ...foreignEpisodeBound,
      referenceDigest: evidenceRefDigest(foreignEpisodeBound),
    };
    expect(() => parseEvidenceRef(measurementRef([foreignEpisode]))).toThrowError(
      expect.objectContaining({ code: "schema.corrupt" }),
    );

    const mismatchedCommonFields = [
      { ...SUPPORT_A, sourceRegistrationRevision: "9".repeat(64) },
      { ...SUPPORT_A, sourceRef: "other-artifact" },
      { ...SUPPORT_A, sourceRevision: "other-revision" },
      { ...SUPPORT_A, loopRegistryRevision: "8".repeat(64) },
    ];
    for (const bound of mismatchedCommonFields) {
      const support = { ...bound, referenceDigest: evidenceRefDigest(bound) };
      expect(() => parseEvidenceRef(measurementRef([support]))).toThrowError(
        expect.objectContaining({ code: "schema.corrupt" }),
      );
    }
  });

  it("drops unknown content fields and never carries supporting observation payloads", () => {
    const canary = "PRIVATE-MEASUREMENT-SUPPORT-CANARY";
    const parsed = parseEvidenceRef({ ...MEASUREMENT_REF, privatePayload: canary });
    expect(parsed).toEqual(MEASUREMENT_REF);
    expect(JSON.stringify(parsed)).not.toContain(canary);
  });
});

describe("append-only episode outcome claims", () => {
  it("requires status and refs fields, verifies exact ownership, and binds tamper-evident bytes", () => {
    const claim = buildEpisodeOutcomeClaim(claimInput());
    expect(parseEpisodeOutcomeClaim(claim)).toEqual(claim);
    expect(claim.claimDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(claim.claimDigest).toBe("179dd53223144b7016add1e7316ac09dbb5f5ce5ec319a030ac3ed81d49803c5");
    expect(() => parseEpisodeOutcomeClaim({ ...claim, status: undefined })).toThrowError(
      expect.objectContaining({ code: "schema.invalid" }),
    );
    expect(() => parseEpisodeOutcomeClaim({ ...claim, measurementRefs: undefined })).toThrowError(
      expect.objectContaining({ code: "schema.invalid" }),
    );
    expect(() => parseEpisodeOutcomeClaim({ ...claim, status: "failed" })).toThrowError(
      expect.objectContaining({ code: "schema.corrupt" }),
    );
    for (const mismatch of [
      claimInput({ sourceId: "other-source" }),
      claimInput({ sourceRevision: "other-revision" }),
      claimInput({ episodeId: "other-episode" }),
    ]) {
      expect(() => buildEpisodeOutcomeClaim(mismatch)).toThrowError(
        expect.objectContaining({ code: "schema.corrupt" }),
      );
    }
    expect(() =>
      buildEpisodeOutcomeClaim(claimInput({ measurementRefs: [MEASUREMENT_REF, MEASUREMENT_REF] })),
    ).toThrowError(expect.objectContaining({ code: "schema.corrupt" }));
  });

  it("allows a terminal status with zero measurement refs but does not manufacture efficacy", async () => {
    const store = createInMemoryStore();
    const context = contextFor(store);
    const claim = buildEpisodeOutcomeClaim(claimInput({ status: "succeeded", measurementRefs: [] }));
    await expect(persistEpisodeOutcomeClaim(context, claim)).resolves.toBe("created");
    const state = await loadLatestEpisodeOutcomeClaim(context, claim.episodeRecordId);
    expect(state).toMatchObject({
      status: "resolved",
      latest: { status: "succeeded", measurementRefs: [] },
      attemptCount: 1,
    });
    expect("validated" in state).toBe(false);
    expect("improved" in state).toBe(false);
  });

  it("appends late attempts, keeps ordered history, folds latest, and retries idempotently", async () => {
    const context = contextFor(createInMemoryStore());
    const first = buildEpisodeOutcomeClaim(claimInput({ status: "unknown", measurementRefs: [] }));
    const second = buildEpisodeOutcomeClaim(claimInput({ status: "failed" }));

    await expect(persistEpisodeOutcomeClaim(context, first)).resolves.toBe("created");
    await expect(persistEpisodeOutcomeClaim(context, first)).resolves.toBe("exists_same");
    await expect(persistEpisodeOutcomeClaim(context, second)).resolves.toBe("appended");
    await expect(persistEpisodeOutcomeClaim(context, second)).resolves.toBe("exists_same");

    const state = await loadLatestEpisodeOutcomeClaim(context, first.episodeRecordId);
    expect(state).toEqual({
      status: "resolved",
      latest: second,
      attemptCount: 2,
      historyDigests: [first.claimDigest, second.claimDigest],
    });
  });

  it("converges after a concurrent append conflict without losing either attempt", async () => {
    const base = createInMemoryStore();
    const first = buildEpisodeOutcomeClaim(claimInput({ status: "unknown", measurementRefs: [] }));
    const second = buildEpisodeOutcomeClaim(claimInput({ status: "failed" }));
    const context = contextFor(conflictingFirstAppend(base, first));

    await expect(persistEpisodeOutcomeClaim(context, second)).resolves.toBe("appended");
    const state = await loadLatestEpisodeOutcomeClaim(context, second.episodeRecordId);
    expect(state).toEqual({
      status: "resolved",
      latest: second,
      attemptCount: 2,
      historyDigests: [first.claimDigest, second.claimDigest],
    });
  });

  it("recovers a committed outcome after its append acknowledgement is lost", async () => {
    const base = createInMemoryStore();
    const context = contextFor(loseFirstOutcomeAppendAcknowledgement(base));
    const claim = buildEpisodeOutcomeClaim(claimInput());

    await expect(persistEpisodeOutcomeClaim(context, claim)).rejects.toThrow("lost outcome append acknowledgement");
    await expect(persistEpisodeOutcomeClaim(context, claim)).resolves.toBe("exists_same");
    await expect(loadLatestEpisodeOutcomeClaim(context, claim.episodeRecordId)).resolves.toEqual({
      status: "resolved",
      latest: claim,
      attemptCount: 1,
      historyDigests: [claim.claimDigest],
    });
  });
});

describe("measurement citation ownership during ingest", () => {
  for (const fixture of [
    {
      name: "missing cited observation",
      observations: [] as EvidencePage["observations"],
      measurement: projectedMeasurement({ evidenceIds: ["missing-observation"] }),
    },
    {
      name: "wrong cited episode",
      observations: [projectedObservation({ id: "observation-a", episodeId: "other-episode" })],
      measurement: projectedMeasurement(),
    },
    {
      name: "empty citation list",
      observations: [projectedObservation({ id: "observation-a" })],
      measurement: projectedMeasurement({ evidenceIds: [] }),
    },
    {
      name: "duplicate citation",
      observations: [projectedObservation({ id: "observation-a" })],
      measurement: projectedMeasurement({ evidenceIds: ["observation-a", "observation-a"] }),
    },
  ]) {
    it(`refuses ${fixture.name} and records closed ownership health`, async () => {
      const source = stagedSource(`citation-${fixture.name.replaceAll(" ", "-")}`, () => [
        foundationPage({ observations: fixture.observations, measurements: [fixture.measurement] }),
      ]);
      const { learning } = await createHarness([source]);
      const receipt = await learning.ingest(source, null);

      expect(receipt.measurementIds).toEqual([]);
      expect(receipt.diagnostics).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: "evidence.ownership_mismatch" })]),
      );
      const health = await itemsOf(
        learning.queryEvidenceHealthFindings({
          sourceIds: [source.id],
          codes: ["source.ownership_mismatch"],
          limit: 10,
        }),
      );
      expect(health).toEqual([expect.objectContaining({ effect: "blocks_use", affectedRecords: 1 })]);
    });
  }

  for (const mismatch of [
    { name: "sourceRef", sourceRef: "other-artifact", revision: "measurement-revision" },
    { name: "sourceRevision", sourceRef: "measurement-artifact", revision: "other-revision" },
  ]) {
    it(`refuses a measurement whose cited records have another ${mismatch.name}`, async () => {
      let pages: readonly EvidencePage[] = [foundationPage({ measurements: [], pageRef: "owned-foundation" })];
      const source = stagedSource(`citation-wrong-${mismatch.name}`, () => pages);
      const { learning } = await createHarness([source]);
      await learning.ingest(source, null);
      pages = [
        stagedPage({
          pageRef: `wrong-${mismatch.name}-measurement`,
          sourceRef: mismatch.sourceRef,
          revision: mismatch.revision,
          measurements: [projectedMeasurement()],
        }),
      ];
      const receipt = await learning.ingest(source, null);

      expect(receipt.measurementIds).toEqual([]);
      expect(receipt.diagnostics).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: "evidence.ownership_mismatch" })]),
      );
    });
  }

  it("refuses a citation whose exact observation/episode commit marker is unavailable", async () => {
    let pages: readonly EvidencePage[] = [foundationPage({ measurements: [], pageRef: "commit-foundation" })];
    const source = stagedSource("citation-uncommitted", () => pages);
    const { learning, store } = await createHarness([source]);
    const foundation = await learning.ingest(source, null);
    const receiptId = foundation.pageReceiptIds[0];
    if (receiptId === undefined) throw new Error("missing foundation receipt");
    const stored = await store.get({ namespace: "learning", kind: "source-page-receipt", id: receiptId });
    if (stored === undefined) throw new Error("missing stored foundation receipt");
    await store.tombstone({
      key: stored.key,
      expectedRevision: stored.revision,
      reasonCode: "test.uncommitted",
      operationId: "remove-foundation-receipt",
    });
    pages = [stagedPage({ pageRef: "uncommitted-measurement", measurements: [projectedMeasurement()] })];

    const receipt = await learning.ingest(source, null);
    expect(receipt.measurementIds).toEqual([]);
    expect(receipt.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "evidence.ownership_mismatch" })]),
    );
  });

  for (const completeness of ["partial", "unknown"] as const) {
    it(`folds exact cited-observation completeness to ${completeness}`, async () => {
      const source = stagedSource(`citation-${completeness}`, () => [
        foundationPage({
          observations: [
            projectedObservation({ id: "observation-a", completeness: "complete" }),
            projectedObservation({ id: "observation-b", completeness }),
          ],
          measurements: [projectedMeasurement({ evidenceIds: ["observation-a", "observation-b"] })],
        }),
      ]);
      const { learning } = await createHarness([source]);
      await learning.ingest(source, null);
      const measurements = await itemsOf(
        learning.queryMeasurements({ measurementIds: [`${source.id}/measurement-record`], limit: 10 }),
      );

      expect(measurements).toHaveLength(1);
      expect(measurements[0]?.evidenceIds).toEqual([`${source.id}/observation-a`, `${source.id}/observation-b`]);
      expect(measurements[0]?.provenance.completeness).toBe(completeness);
    });
  }

  it("rejects a projected measurement whose runtime value disagrees with valueType", async () => {
    const source = stagedSource("measurement-value-mismatch", () => [
      foundationPage({
        measurements: [projectedMeasurement({ valueType: "boolean", value: "not-a-boolean" })],
      }),
    ]);
    const { learning } = await createHarness([source]);
    const receipt = await learning.ingest(source, null);
    expect(receipt.measurementIds).toEqual([]);
    expect(receipt.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: "schema.invalid" })]));
  });
});

describe("ingested episode outcome lineage and candidate measurement eligibility", () => {
  it("keeps outcome absent until a qualified late claim, then retains latest history without recommitting episode", async () => {
    const privateCanary = "PRIVATE-OUTCOME-SUPPORT-CANARY";
    let pages: readonly EvidencePage[] = [
      foundationPage({
        observations: [projectedObservation({ id: "observation-a", privateCanary })],
      }),
    ];
    const source = stagedSource("qualified-outcome", () => pages);
    const { learning, proposer } = await createHarness([source]);
    await learning.ingest(source, null);

    const absent = await itemsOf(learning.queryEpisodes({ sourceIds: [source.id], limit: 10 }));
    expect(absent[0]).toMatchObject({ outcomeLineage: { status: "absent" } });
    expect(absent[0]?.episode.outcome).toBeUndefined();
    await expect(
      learning.propose(
        candidateInput(proposer, {
          id: "measurement-before-outcome",
          scope: MEASUREMENT_SCOPE,
          evidenceIds: [`${source.id}/measurement-record`],
        }),
      ),
    ).rejects.toMatchObject({ code: "candidate.evidence_invalid" });

    pages = [outcomePage({ pageRef: "outcome-attempt-1", status: "succeeded" })];
    await learning.ingest(source, null);
    const resolved = await itemsOf(
      learning.queryEpisodes({ sourceIds: [source.id], statuses: ["succeeded"], limit: 10 }),
    );
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({
      episode: {
        outcome: { status: "succeeded", measurementIds: [`${source.id}/measurement-record`] },
      },
      outcomeLineage: {
        status: "resolved",
        evidenceHealth: { status: "ready" },
      },
    });
    if (resolved[0]?.outcomeLineage.status !== "resolved") throw new Error("expected resolved outcome");
    expect(resolved[0].outcomeLineage.measurementRefs[0]).toMatchObject({
      schemaVersion: 2,
      kind: "measurement",
      supportingEvidenceRefs: [expect.objectContaining({ recordId: `${source.id}/observation-a` })],
    });

    const candidate = await learning.propose(
      candidateInput(proposer, {
        id: "measurement-after-outcome",
        scope: MEASUREMENT_SCOPE,
        evidenceIds: [`${source.id}/measurement-record`],
      }),
    );
    expect(candidate.evidenceHealth.status).toBe("ready");
    expect(candidate.candidate.evidenceRefs[0]).toMatchObject({ schemaVersion: 2, kind: "measurement" });
    expect(JSON.stringify(candidate.candidate)).not.toContain(privateCanary);

    pages = [outcomePage({ pageRef: "outcome-attempt-2", status: "failed" })];
    await learning.ingest(source, null);
    await learning.ingest(source, null);
    const latest = await itemsOf(learning.queryEpisodes({ sourceIds: [source.id], statuses: ["failed"], limit: 10 }));
    expect(latest).toHaveLength(1);
    if (latest[0]?.outcomeLineage.status !== "resolved") throw new Error("expected latest resolved outcome");
    expect(latest[0].outcomeLineage.historyDigests).toHaveLength(2);
    expect(latest[0].outcomeLineage.claimDigest).toBe(latest[0].outcomeLineage.historyDigests[1]);

    const receipts = await itemsOf(learning.querySourcePageReceipts({ sourceIds: [source.id], limit: 20 }));
    const episodeDerivativeReceipts = receipts.filter((receipt) =>
      receipt.derivatives.some((derivative) => derivative.kind === "episode"),
    );
    expect(episodeDerivativeReceipts).toHaveLength(1);
    expect(
      receipts
        .filter((receipt) => receipt.pageRef.startsWith("outcome-attempt"))
        .map((receipt) => receipt.projectionCounts.reused),
    ).toEqual([1, 1]);
  });

  it("allows a zero-measurement terminal status but exposes incomplete—not efficacy—lineage", async () => {
    let pages: readonly EvidencePage[] = [foundationPage({ observations: [], measurements: [] })];
    const source = stagedSource("zero-measurement-outcome", () => pages);
    const { learning } = await createHarness([source]);
    await learning.ingest(source, null);
    pages = [outcomePage({ measurementIds: [], status: "succeeded" })];
    await learning.ingest(source, null);

    const views = await itemsOf(learning.queryEpisodes({ sourceIds: [source.id], statuses: ["succeeded"], limit: 10 }));
    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({
      episode: { outcome: { status: "succeeded", measurementIds: [] } },
      outcomeLineage: {
        status: "resolved",
        measurementRefs: [],
        evidenceHealth: { status: "incomplete" },
      },
    });
  });

  it("rejects outcome references without status and keeps the outcome absent", async () => {
    let pages: readonly EvidencePage[] = [foundationPage()];
    const source = stagedSource("outcome-status-missing", () => pages);
    const { learning } = await createHarness([source]);
    await learning.ingest(source, null);
    const invalidEpisode = projectedEpisode({ measurementIds: ["measurement-record"] });
    pages = [stagedPage({ pageRef: "status-missing", episodes: [invalidEpisode] })];
    const receipt = await learning.ingest(source, null);

    expect(receipt.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: "schema.invalid" })]));
    const views = await itemsOf(learning.queryEpisodes({ sourceIds: [source.id], limit: 10 }));
    expect(views[0]).toMatchObject({ outcomeLineage: { status: "absent" } });
  });

  for (const mismatch of [
    { name: "missing measurement", foundation: foundationPage({ measurements: [] }), outcome: outcomePage() },
    {
      name: "foreign sourceRef",
      foundation: foundationPage(),
      outcome: outcomePage({ sourceRef: "other-artifact" }),
    },
    {
      name: "foreign sourceRevision",
      foundation: foundationPage(),
      outcome: outcomePage({ revision: "other-revision" }),
    },
  ]) {
    it(`refuses ${mismatch.name} from becoming an episode outcome claim`, async () => {
      let pages: readonly EvidencePage[] = [mismatch.foundation];
      const source = stagedSource(`outcome-${mismatch.name.replaceAll(" ", "-")}`, () => pages);
      const { learning } = await createHarness([source]);
      await learning.ingest(source, null);
      pages = [mismatch.outcome];
      const receipt = await learning.ingest(source, null);

      expect(receipt.diagnostics).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: "evidence.ownership_mismatch" })]),
      );
      const health = await itemsOf(
        learning.queryEvidenceHealthFindings({
          sourceIds: [source.id],
          codes: ["source.ownership_mismatch"],
          limit: 10,
        }),
      );
      expect(health).toEqual([expect.objectContaining({ effect: "blocks_use" })]);
      const views = await itemsOf(learning.queryEpisodes({ sourceIds: [source.id], limit: 10 }));
      expect(views[0]).toMatchObject({ outcomeLineage: { status: "absent" } });
    });
  }

  it("refuses an outcome measurement from another logical episode", async () => {
    let pages: readonly EvidencePage[] = [
      foundationPage({
        observations: [projectedObservation({ id: "other-observation", episodeId: "other-episode" })],
        measurements: [
          projectedMeasurement({
            id: "other-measurement",
            episodeId: "other-episode",
            evidenceIds: ["other-observation"],
          }),
        ],
        episodes: [
          projectedEpisode(),
          projectedEpisode({ sourceRecordId: "other-episode-record", episodeId: "other-episode" }),
        ],
      }),
    ];
    const source = stagedSource("outcome-wrong-episode", () => pages);
    const { learning } = await createHarness([source]);
    await learning.ingest(source, null);
    pages = [outcomePage({ measurementIds: ["other-measurement"] })];
    const receipt = await learning.ingest(source, null);

    expect(receipt.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "evidence.ownership_mismatch" })]),
    );
    const target = await itemsOf(
      learning.queryEpisodes({ sourceIds: [source.id], episodeIds: ["logical-episode"], limit: 10 }),
    );
    expect(target[0]).toMatchObject({ outcomeLineage: { status: "absent" } });
  });

  it("refuses an outcome when the exact measurement receipt is no longer committed", async () => {
    let pages: readonly EvidencePage[] = [foundationPage()];
    const source = stagedSource("outcome-uncommitted-measurement", () => pages);
    const { learning, store } = await createHarness([source]);
    const foundation = await learning.ingest(source, null);
    const receiptId = foundation.pageReceiptIds[0];
    if (receiptId === undefined) throw new Error("missing foundation receipt");
    const stored = await store.get({ namespace: "learning", kind: "source-page-receipt", id: receiptId });
    if (stored === undefined) throw new Error("missing stored foundation receipt");
    await store.tombstone({
      key: stored.key,
      expectedRevision: stored.revision,
      reasonCode: "test.uncommitted_measurement",
      operationId: "remove-measurement-receipt",
    });
    pages = [outcomePage()];
    const receipt = await learning.ingest(source, null);

    expect(receipt.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "evidence.ownership_mismatch" })]),
    );
  });

  it("marks raw inline EpisodeRecord outcomes legacy_unbound and strips their bare assertion", async () => {
    const { learning, store } = await createHarness();
    const legacy = {
      schemaVersion: 1,
      id: "legacy-inline-outcome",
      scope: MEASUREMENT_SCOPE,
      openedAt: "2026-08-19T00:00:00.000Z",
      sourceRefs: ["legacy-source"],
      outcome: { status: "succeeded", measurementIds: ["legacy-measurement"] },
      exposureIds: [],
    };
    const value = toJsonValue(legacy);
    await store.create(
      { namespace: "learning", kind: "episode", id: legacy.id },
      value,
      sha256HexOfCanonicalJson(value),
      "legacy-inline-outcome",
    );

    const views = await itemsOf(learning.queryEpisodes({ recordIds: [legacy.id], limit: 10 }));
    expect(views).toHaveLength(1);
    expect(views[0]?.episode.outcome).toBeUndefined();
    expect(views[0]).toMatchObject({ outcomeLineage: { status: "legacy_unbound" } });
  });

  it("treats a schema-v1 measurement reference as unqualified candidate history", async () => {
    let pages: readonly EvidencePage[] = [foundationPage()];
    const source = stagedSource("legacy-measurement-candidate", () => pages);
    const { learning, store, proposer } = await createHarness([source]);
    await learning.ingest(source, null);
    pages = [outcomePage()];
    await learning.ingest(source, null);
    const qualified = await learning.propose(
      candidateInput(proposer, {
        id: "qualified-measurement-template",
        scope: MEASUREMENT_SCOPE,
        evidenceIds: [`${source.id}/measurement-record`],
      }),
    );
    const reference = qualified.candidate.evidenceRefs[0];
    if (reference?.schemaVersion !== 2) throw new Error("expected qualified measurement reference");
    const legacyBound: Omit<EvidenceRefV1, "schemaVersion" | "referenceDigest"> = {
      kind: "measurement",
      recordId: reference.recordId,
      recordDigest: reference.recordDigest,
      sourceId: reference.sourceId,
      sourceRegistrationRevision: reference.sourceRegistrationRevision,
      sourceRef: reference.sourceRef,
      sourceRevision: reference.sourceRevision,
      sourceRecordId: reference.sourceRecordId,
      pageRef: reference.pageRef,
      pageReceiptId: reference.pageReceiptId,
      pageReceiptDigest: reference.pageReceiptDigest,
      loopRegistryRevision: reference.loopRegistryRevision,
      trust: reference.trust,
      completeness: reference.completeness,
      episode: reference.episode,
    };
    const legacyReference: EvidenceRefV1 = {
      schemaVersion: 1,
      ...legacyBound,
      referenceDigest: evidenceRefDigest(legacyBound),
    };
    const fabricatedBase = {
      ...qualified.candidate,
      id: "legacy-measurement-reference-candidate",
      hypothesis: "A v1 measurement reference must remain audit-only.",
      evidenceRefs: [legacyReference],
    };
    const fabricated = parseCandidate({
      ...fabricatedBase,
      contentDigest: candidateContentDigest(fabricatedBase),
    });
    const fabricatedValue = toJsonValue(fabricated);
    await store.create(
      { namespace: "learning", kind: "candidate", id: fabricated.id },
      fabricatedValue,
      sha256HexOfCanonicalJson(fabricatedValue),
      "legacy-measurement-reference-candidate",
    );

    await expect(learning.getCandidateView({ candidateId: fabricated.id })).resolves.toMatchObject({
      evidenceHealth: { status: "invalid" },
      governance: { review: "blocked", publication: "blocked" },
    });
  });

  it("invalidates a measurement candidate when the latest outcome no longer includes it", async () => {
    let pages: readonly EvidencePage[] = [foundationPage()];
    const source = stagedSource("latest-outcome-candidate", () => pages);
    const { learning, proposer } = await createHarness([source]);
    await learning.ingest(source, null);
    pages = [outcomePage({ pageRef: "latest-with-measurement" })];
    await learning.ingest(source, null);
    const candidate = await learning.propose(
      candidateInput(proposer, {
        id: "latest-outcome-bound-candidate",
        scope: MEASUREMENT_SCOPE,
        evidenceIds: [`${source.id}/measurement-record`],
      }),
    );
    expect(candidate.evidenceHealth.status).toBe("ready");

    pages = [outcomePage({ pageRef: "latest-without-measurement", status: "unknown", measurementIds: [] })];
    await learning.ingest(source, null);
    await expect(learning.getCandidateView({ candidateId: candidate.candidate.id })).resolves.toMatchObject({
      evidenceHealth: { status: "invalid" },
      governance: { review: "blocked", publication: "blocked" },
    });
  });

  it("retains partial cited evidence as incomplete outcome and inert candidate lineage", async () => {
    let pages: readonly EvidencePage[] = [
      foundationPage({
        observations: [
          projectedObservation({ id: "observation-a", completeness: "complete" }),
          projectedObservation({ id: "observation-b", completeness: "partial" }),
        ],
        measurements: [projectedMeasurement({ evidenceIds: ["observation-a", "observation-b"] })],
      }),
    ];
    const source = stagedSource("partial-outcome-candidate", () => pages);
    const { learning, proposer } = await createHarness([source]);
    await learning.ingest(source, null);
    pages = [outcomePage()];
    await learning.ingest(source, null);

    const views = await itemsOf(learning.queryEpisodes({ sourceIds: [source.id], limit: 10 }));
    expect(views[0]).toMatchObject({
      outcomeLineage: { status: "resolved", evidenceHealth: { status: "incomplete" } },
    });
    const candidate = await learning.propose(
      candidateInput(proposer, {
        id: "partial-measurement-candidate",
        scope: MEASUREMENT_SCOPE,
        evidenceIds: [`${source.id}/measurement-record`],
      }),
    );
    expect(candidate.evidenceHealth.status).toBe("incomplete");
    expect(candidate.governance).toMatchObject({ review: "blocked", publication: "blocked" });
  });

  it("never resolves same-native-id measurements or outcomes across project sources", async () => {
    const projectB: Scope = [{ type: "project", id: "other-measurement-project" }];
    const privateCanary = "PRIVATE-CROSS-PROJECT-MEASUREMENT-CANARY";
    let pagesA: readonly EvidencePage[] = [
      foundationPage({ observations: [], measurements: [], episodes: [projectedEpisode()] }),
    ];
    let pagesB: readonly EvidencePage[] = [
      foundationPage({
        observations: [projectedObservation({ id: "observation-a", privateCanary })],
        episodes: [projectedEpisode({ scope: projectB })],
      }),
    ];
    const sourceA = stagedSource("measurement-project-a", () => pagesA);
    const sourceB = stagedSource("measurement-project-b", () => pagesB);
    const { learning, proposer } = await createHarness([sourceA, sourceB]);
    await learning.ingest(sourceA, null);
    await learning.ingest(sourceB, null);

    pagesB = [outcomePage({ scope: projectB })];
    await learning.ingest(sourceB, null);
    pagesA = [outcomePage()];
    const refusedA = await learning.ingest(sourceA, null);
    expect(refusedA.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "evidence.ownership_mismatch" })]),
    );
    const viewsA = await itemsOf(learning.queryEpisodes({ sourceIds: [sourceA.id], limit: 10 }));
    expect(viewsA[0]).toMatchObject({ outcomeLineage: { status: "absent" } });

    await expect(
      learning.propose(
        candidateInput(proposer, {
          id: "cross-project-measurement-candidate",
          scope: MEASUREMENT_SCOPE,
          evidenceIds: [`${sourceB.id}/measurement-record`],
        }),
      ),
    ).rejects.toMatchObject({ code: "candidate.evidence_invalid" });
    const correct = await learning.propose(
      candidateInput(proposer, {
        id: "project-b-measurement-candidate",
        scope: projectB,
        evidenceIds: [`${sourceB.id}/measurement-record`],
      }),
    );
    expect(correct.evidenceHealth.status).toBe("ready");
    expect(JSON.stringify(correct.candidate)).not.toContain(privateCanary);
  });
});
