// The filesystem store must pass the public LearningStore conformance suite —
// the suite, not this file, is the contract. Plus the reference-store extras
// (operation replay, duplicate entry ids, query validation, aliasing safety)
// and cursor stability exercised through the real filesystem.
import { mkdtempSync, rmSync, truncateSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { LearningLoopError } from "../src/diagnostics.js";
import { createFileStore } from "../src/node/index.js";
import { recordFile } from "../src/node/paths.js";
import type { RecordKey } from "../src/ports/store.js";
import { runLearningStoreConformance } from "../src/testing/store-conformance.js";

const roots: string[] = [];

function freshRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "gll-node-store-"));
  roots.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

runLearningStoreConformance(() => createFileStore({ rootDir: freshRoot() }));

describe("createFileStore extras (mirror of the in-memory reference)", () => {
  const k: RecordKey = { namespace: "ns", kind: "candidate", id: "c-1" };

  it("treats a compareAndSet replay (same operationId and digest) as exists_same", async () => {
    const store = createFileStore({ rootDir: freshRoot() });
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

  it("a compareAndSet replay with the same operationId but different content conflicts", async () => {
    const store = createFileStore({ rootDir: freshRoot() });
    const created = await store.create(k, { v: 1 }, "d-1", "op-1");
    if (created.status !== "created") throw new Error("expected created");
    const applied = await store.compareAndSet(k, created.revision, { v: 2 }, "d-2", "op-2");
    expect(applied.status).toBe("updated");
    const tampered = await store.compareAndSet(k, created.revision, { v: 3 }, "d-3", "op-2");
    expect(tampered.status).toBe("conflict");
    expect((await store.get(k))?.value).toEqual({ v: 2 });
  });

  it("treats an append replay (same operationId) as exists_same without duplicating entries", async () => {
    const store = createFileStore({ rootDir: freshRoot() });
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
    const store = createFileStore({ rootDir: freshRoot() });
    const stream: RecordKey = { namespace: "ns", kind: "transitions", id: "s-1" };
    const first = await store.append(stream, undefined, [{ id: "e-1", digest: "d", value: 1 }], "op-1");
    if (first.status !== "created") throw new Error("expected created");
    const duplicate = await store.append(stream, first.revision, [{ id: "e-1", digest: "d", value: 9 }], "op-2");
    expect(duplicate.status).toBe("conflict");
  });

  it("does not alias caller values: later caller mutation cannot change stored state", async () => {
    const store = createFileStore({ rootDir: freshRoot() });
    const value: { readonly list: number[] } = { list: [1] };
    await store.create(k, value, "d-1", "op-1");
    value.list.push(2);
    expect((await store.get(k))?.value).toEqual({ list: [1] });
  });

  it("rejects a non-positive or non-integer list limit", async () => {
    const store = createFileStore({ rootDir: freshRoot() });
    await expect(store.list({ namespace: "ns", limit: 0 })).rejects.toBeInstanceOf(LearningLoopError);
    await expect(store.list({ namespace: "ns", limit: 2.5 })).rejects.toBeInstanceOf(LearningLoopError);
  });

  it("rejects an unrecognized cursor", async () => {
    const store = createFileStore({ rootDir: freshRoot() });
    await expect(store.list({ namespace: "ns", cursor: "bogus", limit: 5 })).rejects.toBeInstanceOf(LearningLoopError);
  });
});

describe("createFileStore cursor stability through the filesystem", () => {
  it("advancing a cursor does not reopen records from earlier pages", async () => {
    const root = freshRoot();
    const store = createFileStore({ rootDir: root });
    const key = (id: string): RecordKey => ({ namespace: "ns-a", kind: "observation", id });
    for (let index = 0; index < 5; index += 1) {
      await store.create(key(`r-${index}`), { index }, `digest-${index}`, `op-${index}`);
    }

    const first = await store.list({ namespace: "ns-a", kind: "observation", limit: 2 });
    expect(first.records.map((record) => record.key.id)).toEqual(["r-0", "r-1"]);
    expect(first.nextCursor).toBeDefined();
    if (first.nextCursor === undefined) return;

    // A seekable page must not touch an entry that is already behind its
    // cursor. `get` still exposes the corruption explicitly.
    truncateSync(recordFile(root, key("r-0")), 0);
    const second = await store.list({
      namespace: "ns-a",
      kind: "observation",
      cursor: first.nextCursor,
      limit: 2,
    });
    expect(second.records.map((record) => record.key.id)).toEqual(["r-2", "r-3"]);
    await expect(store.get(key("r-0"))).rejects.toMatchObject({ code: "store.corrupt" });
  });

  it("never skips or duplicates while records are created between pages", async () => {
    const store = createFileStore({ rootDir: freshRoot() });
    const key = (id: string): RecordKey => ({ namespace: "ns-a", kind: "observation", id });
    for (let index = 0; index < 5; index += 1) {
      await store.create(key(`r-${index}`), { index }, `digest-${index}`, `op-${index}`);
    }
    const seen: string[] = [];
    let cursor: string | undefined;
    let interleaved = 5;
    for (let page = 0; page < 20; page += 1) {
      const result = await store.list({
        namespace: "ns-a",
        kind: "observation",
        ...(cursor !== undefined ? { cursor } : {}),
        limit: 2,
      });
      for (const record of result.records) seen.push(record.key.id);
      if (interleaved < 7) {
        await store.create(
          key(`r-${interleaved}`),
          { index: interleaved },
          `digest-${interleaved}`,
          `op-${interleaved}`,
        );
        interleaved += 1;
      }
      if (result.nextCursor === undefined) break;
      cursor = result.nextCursor;
    }
    expect(seen).toEqual(["r-0", "r-1", "r-2", "r-3", "r-4", "r-5", "r-6"]);
  });

  it("keeps a stream at its original insertion position while appends land between pages", async () => {
    const store = createFileStore({ rootDir: freshRoot() });
    const record = (id: string): RecordKey => ({ namespace: "ns-a", kind: "candidate", id });
    const stream: RecordKey = { namespace: "ns-a", kind: "candidate", id: "s-1" };
    await store.create(record("a"), { n: 0 }, "d-a", "op-a");
    const first = await store.append(stream, undefined, [{ id: "e-1", digest: "d", value: 1 }], "op-s1");
    if (first.status !== "created") throw new Error("expected created");
    await store.create(record("b"), { n: 1 }, "d-b", "op-b");
    await store.create(record("c"), { n: 2 }, "d-c", "op-c");

    const seen: string[] = [];
    let revision = first.revision;
    let cursor: string | undefined;
    let appendCount = 0;
    for (let page = 0; page < 10; page += 1) {
      const result = await store.list({
        namespace: "ns-a",
        ...(cursor !== undefined ? { cursor } : {}),
        limit: 2,
      });
      for (const record of result.records) seen.push(record.key.id);
      appendCount += 1;
      const appended = await store.append(
        stream,
        revision,
        [{ id: `e-more-${appendCount}`, digest: "d", value: appendCount }],
        `op-more-${appendCount}`,
      );
      if (appended.status === "updated") revision = appended.revision;
      if (result.nextCursor === undefined) break;
      cursor = result.nextCursor;
    }
    expect(seen).toEqual(["a", "s-1", "b", "c"]);
  });
});
