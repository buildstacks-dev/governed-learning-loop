import { describe, expect, it } from "vitest";
import type { LearningStore, MeasurementRecord, Observation, QueryPage } from "../src/index.js";
import type { DetectorEvidenceInput } from "../src/engine/evidence-binding.js";
import { resolveDetectorEvidence } from "../src/engine/evidence-binding.js";
import { runMeasurementQuery, runObservationQuery } from "../src/engine/query.js";
import { createInMemoryStore } from "../src/testing/index.js";
import { createSemanticEngineHarness } from "./semantic-engine-harness.js";

interface StoreCalls {
  gets: number;
  lists: number;
  readonly listsByKind: Map<string, number>;
}

function countingStore(base: LearningStore): {
  readonly store: LearningStore;
  readonly calls: StoreCalls;
  readonly reset: () => void;
} {
  const calls: StoreCalls = { gets: 0, lists: 0, listsByKind: new Map() };
  return {
    calls,
    reset: () => {
      calls.gets = 0;
      calls.lists = 0;
      calls.listsByKind.clear();
    },
    store: {
      get: (key) => {
        calls.gets += 1;
        return base.get(key);
      },
      create: (key, value, digest, operationId) => base.create(key, value, digest, operationId),
      compareAndSet: (key, expectedRevision, value, digest, operationId) =>
        base.compareAndSet(key, expectedRevision, value, digest, operationId),
      append: (stream, expectedRevision, entries, operationId) =>
        base.append(stream, expectedRevision, entries, operationId),
      tombstone: (input) => base.tombstone(input),
      list: (query) => {
        calls.lists += 1;
        const kind = query.kind ?? "*";
        calls.listsByKind.set(kind, (calls.listsByKind.get(kind) ?? 0) + 1);
        return base.list(query);
      },
    },
  };
}

async function collect<T>(pages: AsyncIterable<QueryPage<T>>): Promise<readonly T[]> {
  const values: T[] = [];
  for await (const page of pages) values.push(...page.items);
  return values;
}

async function evidenceRecords(input: {
  readonly context: Parameters<typeof runObservationQuery>[0];
  readonly sourceId: string;
  readonly episodeId: string;
}): Promise<{ readonly observations: readonly Observation[]; readonly measurements: readonly MeasurementRecord[] }> {
  const observations = await collect(
    runObservationQuery(input.context, {
      sourceIds: [input.sourceId],
      episodeIds: [input.episodeId],
      limit: 500,
    }),
  );
  const measurements = await collect(
    runMeasurementQuery(input.context, {
      sourceIds: [input.sourceId],
      episodeIds: [input.episodeId],
      limit: 500,
    }),
  );
  return { observations, measurements };
}

describe("batched detector evidence resolution", () => {
  it("binds the exact 5,000-record detector ceiling in one shared fold", async () => {
    const counted = countingStore(createInMemoryStore());
    const harness = await createSemanticEngineHarness({
      store: counted.store,
      label: "batch-5000",
      observationCount: 5_000,
    });
    const records = await evidenceRecords({
      context: harness.context,
      sourceId: harness.source.id,
      episodeId: "batch-5000-episode",
    });
    expect(records.observations).toHaveLength(5_000);
    counted.reset();

    const inputs: DetectorEvidenceInput[] = records.observations.map((record) => ({
      kind: "observation",
      record,
    }));
    const resolved = await resolveDetectorEvidence(harness.context, inputs, harness.scope);

    expect(resolved.health).toEqual({ status: "ready", diagnostics: [] });
    expect(resolved.refs).toHaveLength(5_000);
    expect(resolved.records.map((record) => record.id)).toEqual(records.observations.map((record) => record.id));
    expect(counted.calls.gets).toBe(5_001);
    expect(counted.calls.listsByKind.get("episode")).toBe(3);
    expect(counted.calls.listsByKind.get("source-page-receipt")).toBe(3);
    expect(counted.calls.listsByKind.get("evidence-health")).toBe(3);
  }, 30_000);

  it("refuses 5,001 exact inputs statically without store work or truncation", async () => {
    const counted = countingStore(createInMemoryStore());
    const harness = await createSemanticEngineHarness({ store: counted.store, label: "batch-plus-one" });
    counted.reset();
    const inputs: DetectorEvidenceInput[] = Array.from({ length: 5_001 }, (_, index) => ({
      kind: "observation",
      recordId: `${harness.source.id}/outside-${index}`,
    }));

    const resolved = await resolveDetectorEvidence(harness.context, inputs, harness.scope);

    expect(resolved.refs).toEqual([]);
    expect(resolved.health).toMatchObject({
      status: "invalid",
      diagnostics: [{ code: "evidence.ids_invalid" }],
    });
    expect(counted.calls).toMatchObject({ gets: 0, lists: 0 });
  });

  it("builds observations first, preserves support order, and shares work across measurements", async () => {
    const counted = countingStore(createInMemoryStore());
    const harness = await createSemanticEngineHarness({
      store: counted.store,
      label: "shared-support",
      observationCount: 2,
      measurementCount: 100,
      measurementEvidenceIds: ["shared-support-observation-1", "shared-support-observation"],
    });
    const records = await evidenceRecords({
      context: harness.context,
      sourceId: harness.source.id,
      episodeId: "shared-support-episode",
    });
    counted.reset();
    const measurementInputs: DetectorEvidenceInput[] = records.measurements.map((record) => ({
      kind: "measurement",
      record,
    }));
    const observationInputs: DetectorEvidenceInput[] = records.observations.map((record) => ({
      kind: "observation",
      record,
    }));
    const inputs: DetectorEvidenceInput[] = [...measurementInputs, ...observationInputs];

    const resolved = await resolveDetectorEvidence(harness.context, inputs, harness.scope);

    expect(resolved.health).toEqual({ status: "ready", diagnostics: [] });
    expect(resolved.refs).toHaveLength(102);
    expect(resolved.refs.slice(0, 100).every((reference) => reference.kind === "measurement")).toBe(true);
    const first = resolved.refs[0];
    expect(first).toMatchObject({
      schemaVersion: 2,
      kind: "measurement",
      supportingEvidenceRefs: [
        { recordId: `${harness.source.id}/shared-support-observation-1` },
        { recordId: `${harness.source.id}/shared-support-observation` },
      ],
    });
    expect(counted.calls.gets).toBe(104);
    expect(counted.calls.lists).toBe(19);
  }, 30_000);

  it("refuses hidden and aggregate-over-ceiling supports without disclosing their ids", async () => {
    const counted = countingStore(createInMemoryStore());
    const harness = await createSemanticEngineHarness({
      store: counted.store,
      label: "support-bounds",
      withMeasurement: true,
    });
    const records = await evidenceRecords({
      context: harness.context,
      sourceId: harness.source.id,
      episodeId: "support-bounds-episode",
    });
    const measurement = records.measurements[0];
    if (measurement === undefined) throw new Error("missing measurement fixture");
    counted.reset();

    const hidden = await resolveDetectorEvidence(
      harness.context,
      [{ kind: "measurement", record: measurement }],
      harness.scope,
    );
    expect(hidden.refs).toEqual([]);
    expect(hidden.health.diagnostics).toContainEqual(
      expect.objectContaining({ code: "evidence.support_outside_window" }),
    );
    expect(JSON.stringify(hidden.health.diagnostics)).not.toContain(measurement.evidenceIds[0]);

    const overCeiling: MeasurementRecord = {
      ...measurement,
      evidenceIds: Array.from({ length: 5_000 }, (_, index) => `${harness.source.id}/support-${index}`),
    };
    counted.reset();
    const excessive = await resolveDetectorEvidence(
      harness.context,
      [{ kind: "measurement", record: overCeiling }],
      harness.scope,
    );
    expect(excessive.refs).toEqual([]);
    expect(excessive.health.diagnostics).toContainEqual(expect.objectContaining({ code: "evidence.ids_invalid" }));
    expect(counted.calls).toMatchObject({ gets: 0, lists: 0 });
  });
});
