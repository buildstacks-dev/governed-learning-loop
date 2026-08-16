// Behaviors of the in-memory seed beyond the public conformance suite:
// operation-id replay after an unacknowledged success, aliasing safety, and
// query validation.
import { describe, expect, it } from "vitest";
import { LearningLoopError } from "../src/diagnostics.js";
import type { RecordKey } from "../src/ports/store.js";
import { createInMemoryStore } from "../src/testing/in-memory-store.js";

const k: RecordKey = { namespace: "ns", kind: "candidate", id: "c-1" };

describe("createInMemoryStore extras", () => {
  it("treats a compareAndSet replay (same operationId and digest) as exists_same", async () => {
    const store = createInMemoryStore();
    const created = await store.create(k, { v: 1 }, "d-1", "op-1");
    if (created.status !== "created") throw new Error("expected created");
    const applied = await store.compareAndSet(k, created.revision, { v: 2 }, "d-2", "op-2");
    expect(applied.status).toBe("updated");
    const replay = await store.compareAndSet(k, created.revision, { v: 2 }, "d-2", "op-2");
    expect(replay.status).toBe("exists_same");
    if (replay.status === "exists_same" && applied.status === "updated") {
      expect(replay.revision).toBe(applied.revision);
    }
  });

  it("treats an append replay (same operationId) as exists_same without duplicating entries", async () => {
    const store = createInMemoryStore();
    const stream: RecordKey = { namespace: "ns", kind: "transitions", id: "s-1" };
    const first = await store.append(stream, undefined, [{ id: "e-1", digest: "d", value: 1 }], "op-1");
    if (first.status !== "created") throw new Error("expected created");
    const applied = await store.append(stream, first.revision, [{ id: "e-2", digest: "d", value: 2 }], "op-2");
    expect(applied.status).toBe("updated");
    const replay = await store.append(stream, first.revision, [{ id: "e-2", digest: "d", value: 2 }], "op-2");
    expect(replay.status).toBe("exists_same");
    const stored = await store.get(stream);
    expect(Array.isArray(stored?.value) && stored.value.length).toBe(2);
  });

  it("rejects duplicate entry ids within a stream", async () => {
    const store = createInMemoryStore();
    const stream: RecordKey = { namespace: "ns", kind: "transitions", id: "s-1" };
    const first = await store.append(stream, undefined, [{ id: "e-1", digest: "d", value: 1 }], "op-1");
    if (first.status !== "created") throw new Error("expected created");
    const duplicate = await store.append(stream, first.revision, [{ id: "e-1", digest: "d", value: 9 }], "op-2");
    expect(duplicate.status).toBe("conflict");
  });

  it("does not alias caller values: later caller mutation cannot change stored state", async () => {
    const store = createInMemoryStore();
    const value: { readonly list: number[] } = { list: [1] };
    await store.create(k, value, "d-1", "op-1");
    value.list.push(2);
    expect((await store.get(k))?.value).toEqual({ list: [1] });
  });

  it("rejects a non-positive or non-integer list limit", async () => {
    const store = createInMemoryStore();
    await expect(store.list({ namespace: "ns", limit: 0 })).rejects.toBeInstanceOf(LearningLoopError);
    await expect(store.list({ namespace: "ns", limit: 2.5 })).rejects.toBeInstanceOf(LearningLoopError);
  });

  it("rejects an unrecognized cursor", async () => {
    const store = createInMemoryStore();
    await expect(store.list({ namespace: "ns", cursor: "bogus", limit: 5 })).rejects.toBeInstanceOf(LearningLoopError);
  });
});
