// Serialized recurrence admission records: unknown-first parsing, exact
// content addressing, bounded slots, and canonical byte ceilings.
import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import type { LearningStore } from "../src/index.js";
import { canonicalJsonText, sha256HexOfCanonicalJson, toJsonValue } from "../src/index.js";
import type { EngineContext } from "../src/engine/context.js";
import {
  candidateAdmissionBindingDigest,
  candidateAdmissionReservationDigest,
  candidateAdmissionReservationKeyDigest,
  candidateAdmissionSnapshotDigest,
  loadCandidateAdmissionBinding,
  loadCandidateAdmissionReservation,
  loadCandidateAdmissionSnapshot,
  loadCandidateAdmissionStream,
  parseCandidateAdmissionBinding,
  parseCandidateAdmissionReservation,
  parseCandidateAdmissionSnapshot,
} from "../src/engine/recurrence-admission.js";
import { loadCandidateContentLock, parseCandidateContentLock } from "../src/engine/candidate-content-lock.js";
import { createInMemoryStore } from "../src/testing/index.js";
import { createAdmissionHarness, proposeAdmissionCandidate } from "./candidate-admission-harness.js";

const MAX_ADMISSION_BYTES = 64 * 1_048_576;

async function admittedRecords() {
  const fixture = await createAdmissionHarness({ label: "admission-records" });
  const outcome = await proposeAdmissionCandidate(fixture, "admission-records-candidate");
  const binding = await loadCandidateAdmissionBinding(fixture.context, outcome.candidate.id);
  if (binding === undefined) throw new Error("admission record fixture omitted its binding");
  const reservation = await loadCandidateAdmissionReservation(fixture.context, binding.reservationDigest);
  const snapshot = await loadCandidateAdmissionSnapshot(fixture.context, binding.snapshotDigest);
  const lock = await loadCandidateContentLock(fixture.context, outcome.candidate.contentDigest);
  if (reservation === undefined || snapshot === undefined || lock === undefined) {
    throw new Error("admission record fixture omitted exact lineage");
  }
  return { fixture, outcome, binding, reservation, snapshot, lock };
}

function paddedUnknown(input: object, extraBytes: number): unknown {
  const empty = toJsonValue({ ...input, padding: "" });
  const emptyBytes = Buffer.byteLength(canonicalJsonText(empty), "utf8");
  const paddingLength = MAX_ADMISSION_BYTES - emptyBytes + extraBytes;
  if (paddingLength < 0) throw new Error("admission fixture already exceeds its byte ceiling");
  return { ...input, padding: "x".repeat(paddingLength) };
}

function numberedDigest(value: number): string {
  return value.toString(16).padStart(64, "0");
}

function slotEntries(count: number) {
  return Array.from({ length: count }, (_, index) => {
    const base = {
      reservationKeyDigest: numberedDigest(index + 1),
      reservationDigest: numberedDigest(10_000 + index),
      snapshotDigest: numberedDigest(20_000 + index),
    };
    const value = toJsonValue({ schemaVersion: 1, ...base, slotDigest: sha256HexOfCanonicalJson(base) });
    return toJsonValue({
      id: `slot:${base.reservationKeyDigest}`,
      digest: sha256HexOfCanonicalJson(value),
      value,
    });
  });
}

function streamStore(base: LearningStore, groupKeyDigest: string, entries: readonly unknown[]): LearningStore {
  return {
    get: (key) => {
      if (key.kind !== "candidate-recurrence-admission" || key.id !== groupKeyDigest) return base.get(key);
      const value = toJsonValue(entries);
      const ids = entries.map((entry) => {
        if (typeof entry !== "object" || entry === null || !("id" in entry)) throw new Error("slot fixture has no id");
        const id: unknown = entry.id;
        if (typeof id !== "string") throw new Error("slot fixture id is invalid");
        return id;
      });
      return Promise.resolve({
        key: { namespace: "learning", kind: "candidate-recurrence-admission", id: groupKeyDigest },
        value,
        revision: "slot-fixture-revision",
        digest: sha256HexOfCanonicalJson(ids),
      });
    },
    create: (key, value, digest, operationId) => base.create(key, value, digest, operationId),
    compareAndSet: (key, revision, value, digest, operationId) =>
      base.compareAndSet(key, revision, value, digest, operationId),
    append: (stream, revision, streamEntries, operationId) => base.append(stream, revision, streamEntries, operationId),
    tombstone: (input) => base.tombstone(input),
    list: (query) => base.list(query),
  };
}

function replaceStore(context: EngineContext, store: LearningStore): EngineContext {
  return { ...context, store };
}

describe("Candidate admission canonical records", () => {
  it("round-trips unknown input and pins snapshot, reservation, binding, and slot goldens", async () => {
    const { fixture, binding, reservation, snapshot, lock } = await admittedRecords();
    expect(parseCandidateAdmissionSnapshot({ ...snapshot, unknown: true })).toEqual(snapshot);
    expect(parseCandidateAdmissionReservation({ ...reservation, unknown: true })).toEqual(reservation);
    expect(parseCandidateAdmissionBinding({ ...binding, unknown: true })).toEqual(binding);
    expect(parseCandidateContentLock({ ...lock, unknown: true })).toEqual(lock);
    expect(snapshot.snapshotDigest).toBe("db5c695a79e5ffe9f6a94e756202d0f8d0ba95d6084624ee1330f6343a176273");
    expect(reservation.reservationKeyDigest).toBe("d33b92861cdab80d630d0aa1b9058a1b4639a4ee4c3e047211845ff9434a1931");
    expect(reservation.reservationDigest).toBe("f8e4e4d9b1549fe0b97c00e029d7b39ef5234fa998135c3bfdba60d3862f3f64");
    expect(binding.bindingDigest).toBe("a718e3cb1d14f9fef87d8740df8cecca5f53772a477af045802cd820e320c135");
    const stream = await loadCandidateAdmissionStream(fixture.context, fixture.groupKeyDigest);
    expect(stream.snapshotDigest).toBe("2111ec6e2e170cffe522295ed2b3f307219e60568ce20d533f2d51f6a16cb071");
  });

  it("recomputes every digest and refuses self-consistent cross-record lineage tamper", async () => {
    const { binding, lock, reservation, snapshot } = await admittedRecords();
    const { schemaVersion: _snapshotSchemaVersion, snapshotDigest: _snapshotDigest, ...snapshotBase } = snapshot;
    expect(candidateAdmissionSnapshotDigest(snapshotBase)).toBe(snapshot.snapshotDigest);
    expect(candidateAdmissionReservationKeyDigest(snapshot)).toBe(reservation.reservationKeyDigest);
    const {
      schemaVersion: _reservationSchemaVersion,
      reservationDigest: _reservationDigest,
      ...reservationBase
    } = reservation;
    expect(candidateAdmissionReservationDigest(reservationBase)).toBe(reservation.reservationDigest);
    const { schemaVersion: _bindingSchemaVersion, bindingDigest: _bindingDigest, ...bindingBase } = binding;
    expect(candidateAdmissionBindingDigest(bindingBase)).toBe(binding.bindingDigest);

    expect(() => parseCandidateAdmissionSnapshot({ ...snapshot, snapshotDigest: "0".repeat(64) })).toThrowError(
      expect.objectContaining({ code: "schema.corrupt" }),
    );
    expect(() =>
      parseCandidateAdmissionReservation({ ...reservation, reservationDigest: "0".repeat(64) }),
    ).toThrowError(expect.objectContaining({ code: "schema.corrupt" }));
    expect(() => parseCandidateAdmissionBinding({ ...binding, bindingDigest: "0".repeat(64) })).toThrowError(
      expect.objectContaining({ code: "schema.corrupt" }),
    );
    expect(() => parseCandidateContentLock({ ...lock, admissionExpected: false })).toThrowError(
      expect.objectContaining({ code: "store.corrupt" }),
    );
    expect(() =>
      parseCandidateAdmissionReservation({
        ...reservation,
        basis: "required_supersession",
        requiredSupersedes: null,
        reservationDigest: candidateAdmissionReservationDigest({
          ...reservationBase,
          basis: "required_supersession",
          requiredSupersedes: null,
        }),
      }),
    ).toThrowError(expect.objectContaining({ code: "schema.corrupt" }));
    for (const malformed of [
      () => parseCandidateAdmissionSnapshot({ schemaVersion: 1 }),
      () => parseCandidateAdmissionReservation({ schemaVersion: 1 }),
      () => parseCandidateAdmissionBinding({ schemaVersion: 1 }),
    ]) {
      expect(malformed).toThrowError(expect.objectContaining({ code: expect.stringMatching(/^schema\./) }));
    }
  });

  it("accepts the exact 64 MiB envelope and refuses one byte beyond for snapshots and reservations", async () => {
    const { reservation, snapshot } = await admittedRecords();
    expect(parseCandidateAdmissionSnapshot(paddedUnknown(snapshot, 0))).toEqual(snapshot);
    expect(() => parseCandidateAdmissionSnapshot(paddedUnknown(snapshot, 1))).toThrowError(
      expect.objectContaining({ code: "schema.invalid" }),
    );
    expect(parseCandidateAdmissionReservation(paddedUnknown(reservation, 0))).toEqual(reservation);
    expect(() => parseCandidateAdmissionReservation(paddedUnknown(reservation, 1))).toThrowError(
      expect.objectContaining({ code: "schema.invalid" }),
    );
  }, 30_000);

  it("accepts exactly 5,000 permanent slots and fails closed at 5,001", async () => {
    const { fixture } = await admittedRecords();
    const base = createInMemoryStore();
    const exact = replaceStore(fixture.context, streamStore(base, fixture.groupKeyDigest, slotEntries(5_000)));
    await expect(loadCandidateAdmissionStream(exact, fixture.groupKeyDigest)).resolves.toMatchObject({
      slots: expect.any(Array),
      revision: "slot-fixture-revision",
    });
    expect((await loadCandidateAdmissionStream(exact, fixture.groupKeyDigest)).slots).toHaveLength(5_000);

    const excess = replaceStore(fixture.context, streamStore(base, fixture.groupKeyDigest, slotEntries(5_001)));
    await expect(loadCandidateAdmissionStream(excess, fixture.groupKeyDigest)).rejects.toMatchObject({
      code: "store.corrupt",
    });
    const duplicateEntries = slotEntries(1);
    const duplicate = replaceStore(
      fixture.context,
      streamStore(base, fixture.groupKeyDigest, [...duplicateEntries, ...duplicateEntries]),
    );
    await expect(loadCandidateAdmissionStream(duplicate, fixture.groupKeyDigest)).rejects.toMatchObject({
      code: "store.corrupt",
    });
  });
});
