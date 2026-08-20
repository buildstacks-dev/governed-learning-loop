// LearningStore conformance suite (contract §Storage; AGENTS.md: conformance
// suites are part of the API). Registers caller-supplied describe/it blocks
// for a store factory; every store adapter must pass unchanged. A fresh store
// is created per test.
import type { JsonValue } from "../canonical/json.js";
import type { LearningStore, RecordKey, StreamEntry } from "../ports/store.js";

export type LearningStoreFactory = () => LearningStore | Promise<LearningStore>;

function key(namespace: string, kind: string, id: string): RecordKey {
  return { namespace, kind, id };
}

function entry(id: string, value: JsonValue): StreamEntry {
  return { id, digest: `digest-${id}`, value };
}

export function runLearningStoreConformance(
  makeStore: LearningStoreFactory,
  testApi: {
    readonly describe: (name: string, suite: () => void) => void;
    readonly it: (name: string, test: () => void | Promise<void>) => void;
    readonly expect: (actual: unknown) => {
      readonly not: {
        readonly toBe: (expected: unknown) => void;
      };
      readonly toBe: (expected: unknown) => void;
      readonly toBeDefined: () => void;
      readonly toBeLessThanOrEqual: (expected: number) => void;
      readonly toBeUndefined: () => void;
      readonly toEqual: (expected: unknown) => void;
    };
  },
): void {
  const { describe, expect, it } = testApi;
  describe("LearningStore conformance", () => {
    it("create-only: same key + same digest is an idempotent exists_same", async () => {
      const store = await makeStore();
      const k = key("ns-a", "candidate", "c-1");
      const first = await store.create(k, { problem: "p" }, "digest-1", "op-1");
      expect(first).toEqual({ status: "created", revision: "1" });
      const retry = await store.create(k, { problem: "p" }, "digest-1", "op-2");
      expect(retry.status).toBe("exists_same");
      if (retry.status === "exists_same") expect(retry.revision).toBe("1");
    });

    it("create-only: same key + different digest is a conflict and does not overwrite", async () => {
      const store = await makeStore();
      const k = key("ns-a", "candidate", "c-1");
      await store.create(k, { problem: "original" }, "digest-1", "op-1");
      const conflicting = await store.create(k, { problem: "tampered" }, "digest-2", "op-2");
      expect(conflicting.status).toBe("conflict");
      const stored = await store.get(k);
      expect(stored?.digest).toBe("digest-1");
      expect(stored?.value).toEqual({ problem: "original" });
    });

    it("compareAndSet succeeds on the current revision and returns a new one", async () => {
      const store = await makeStore();
      const k = key("ns-a", "candidate", "c-1");
      const created = await store.create(k, { state: "draft" }, "digest-1", "op-1");
      expect(created.status).toBe("created");
      if (created.status !== "created") return;
      const updated = await store.compareAndSet(k, created.revision, { state: "reviewed" }, "digest-2", "op-2");
      expect(updated.status).toBe("updated");
      if (updated.status !== "updated") return;
      expect(updated.revision).not.toBe(created.revision);
      const stored = await store.get(k);
      expect(stored?.value).toEqual({ state: "reviewed" });
      expect(stored?.revision).toBe(updated.revision);
    });

    it("compareAndSet loses cleanly on a stale revision", async () => {
      const store = await makeStore();
      const k = key("ns-a", "candidate", "c-1");
      const created = await store.create(k, { state: "draft" }, "digest-1", "op-1");
      if (created.status !== "created") throw new Error("expected created");
      await store.compareAndSet(k, created.revision, { state: "reviewed" }, "digest-2", "op-2");
      const stale = await store.compareAndSet(k, created.revision, { state: "clobbered" }, "digest-3", "op-3");
      expect(stale.status).toBe("conflict");
      const stored = await store.get(k);
      expect(stored?.value).toEqual({ state: "reviewed" });
    });

    it("append preserves order and honors expectedRevision", async () => {
      const store = await makeStore();
      const s = key("ns-a", "transitions", "stream-1");
      const first = await store.append(s, undefined, [entry("e-1", { n: 1 }), entry("e-2", { n: 2 })], "op-1");
      expect(first.status).toBe("created");
      if (first.status !== "created") return;
      const second = await store.append(s, first.revision, [entry("e-3", { n: 3 })], "op-2");
      expect(second.status).toBe("updated");
      const stale = await store.append(s, first.revision, [entry("e-4", { n: 4 })], "op-3");
      expect(stale.status).toBe("conflict");
      const stored = await store.get(s);
      expect(stored).toBeDefined();
      expect(stored?.value).toEqual([
        { id: "e-1", digest: "digest-e-1", value: { n: 1 } },
        { id: "e-2", digest: "digest-e-2", value: { n: 2 } },
        { id: "e-3", digest: "digest-e-3", value: { n: 3 } },
      ]);
    });

    it("append with expectedRevision on a missing stream conflicts", async () => {
      const store = await makeStore();
      const missing = await store.append(key("ns-a", "transitions", "absent"), "1", [entry("e-1", 1)], "op-1");
      expect(missing.status).toBe("conflict");
    });

    it("list paginates in insertion order without skips or duplicates", async () => {
      const store = await makeStore();
      const ids: string[] = [];
      for (let index = 0; index < 7; index += 1) {
        const id = `record-${index}`;
        ids.push(id);
        await store.create(key("ns-a", "observation", id), { index }, `digest-${index}`, `op-${index}`);
      }
      const seen: string[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 10; page += 1) {
        const result = await store.list({
          namespace: "ns-a",
          kind: "observation",
          ...(cursor !== undefined ? { cursor } : {}),
          limit: 3,
        });
        expect(result.records.length).toBeLessThanOrEqual(3);
        for (const record of result.records) seen.push(record.key.id);
        if (result.nextCursor === undefined) break;
        cursor = result.nextCursor;
      }
      expect(seen).toEqual(ids);
    });

    it("namespaces are isolated for records and listings", async () => {
      const store = await makeStore();
      const kA = key("ns-a", "candidate", "shared-id");
      const kB = key("ns-b", "candidate", "shared-id");
      await store.create(kA, { owner: "a" }, "digest-a", "op-1");
      const other = await store.create(kB, { owner: "b" }, "digest-b", "op-2");
      expect(other.status).toBe("created");
      expect((await store.get(kA))?.value).toEqual({ owner: "a" });
      expect((await store.get(kB))?.value).toEqual({ owner: "b" });
      const listed = await store.list({ namespace: "ns-a", limit: 10 });
      expect(listed.records.map((record) => record.key.namespace)).toEqual(["ns-a"]);
    });

    it("tombstone hides the record, blocks recreation, and requires the current revision", async () => {
      const store = await makeStore();
      const k = key("ns-a", "candidate", "c-1");
      const created = await store.create(k, { state: "draft" }, "digest-1", "op-1");
      if (created.status !== "created") throw new Error("expected created");
      const stale = await store.tombstone({ key: k, expectedRevision: "999", reasonCode: "test", operationId: "op-2" });
      expect(stale.status).toBe("conflict");
      const dead = await store.tombstone({
        key: k,
        expectedRevision: created.revision,
        reasonCode: "source_deleted",
        operationId: "op-3",
      });
      expect(dead.status).toBe("updated");
      expect(await store.get(k)).toBeUndefined();
      const listed = await store.list({ namespace: "ns-a", limit: 10 });
      expect(listed.records).toEqual([]);
      const recreate = await store.create(k, { state: "returned" }, "digest-9", "op-4");
      expect(recreate.status).toBe("conflict");
    });

    it("values round-trip through the unknown channel, including nested structures", async () => {
      const store = await makeStore();
      const k = key("ns-a", "observation", "deep");
      const value: JsonValue = {
        text: "naïve ☃",
        numbers: [0.1, -2, 1e21],
        nested: { flags: [true, false, null], empty: {}, list: [] },
      };
      await store.create(k, value, "digest-deep", "op-1");
      const stored = await store.get(k);
      expect(stored?.value).toEqual(value);
    });
  });
}
