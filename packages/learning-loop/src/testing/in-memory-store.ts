// Deterministic in-memory LearningStore for tests and examples.
// Semantics (documented choices where the contract leaves room):
// - create: existing key with the same digest → "exists_same" (idempotent
//   retry); different digest → "conflict". Tombstoned keys stay dead: a
//   create on one is a conflict.
// - compareAndSet: matching expectedRevision → "updated"; otherwise a replay
//   of the exact applied operation (same operationId + digest) → "exists_same";
//   anything else → "conflict" carrying the current revision.
// - append: `expectedRevision === undefined` means "the stream must not exist
//   yet" (first append creates it); later appends pass the current revision.
//   Re-sending the applied operationId → "exists_same". A stream's stored
//   value is its ordered entry array; its digest is the SHA-256 of the
//   canonical JSON of the entry-id sequence.
// - tombstone: after it, get() returns undefined and list() skips the key.
// - list: insertion-ordered, cursor-stable pagination; the cursor encodes the
//   last-returned insertion index, so later writes never skip or duplicate
//   earlier records. snapshotRevision is the namespace's write counter.
import { sha256HexOfCanonicalJson } from "../canonical/canonical-json.js";
import type { JsonValue } from "../canonical/json.js";
import { LearningLoopError } from "../diagnostics.js";
import type { LearningStore, RecordKey, StoredRecord, StreamEntry, WriteResult } from "../ports/store.js";

interface RecordCell {
  readonly form: "record";
  readonly key: RecordKey;
  value: JsonValue;
  digest: string;
  revision: number;
  lastOperationId: string;
  readonly insertionIndex: number;
}

interface StreamCell {
  readonly form: "stream";
  readonly key: RecordKey;
  readonly entries: StreamEntry[];
  revision: number;
  lastOperationId: string;
  readonly insertionIndex: number;
}

interface TombstoneCell {
  readonly form: "tombstone";
  readonly key: RecordKey;
  readonly revision: number;
  readonly reasonCode: string;
  readonly lastOperationId: string;
  readonly insertionIndex: number;
}

type Cell = RecordCell | StreamCell | TombstoneCell;

function cellId(key: RecordKey): string {
  return JSON.stringify([key.namespace, key.kind, key.id]);
}

function copyJson<T extends JsonValue>(value: T): T {
  return structuredClone(value);
}

function copyKey(key: RecordKey): RecordKey {
  return { namespace: key.namespace, kind: key.kind, id: key.id };
}

function streamDigest(entries: readonly StreamEntry[]): string {
  return sha256HexOfCanonicalJson(entries.map((entry) => entry.id));
}

function invalidQuery(message: string): LearningLoopError {
  return new LearningLoopError("schema.invalid", [{ code: "schema.invalid", severity: "error", message }]);
}

export function createInMemoryStore(): LearningStore {
  const cells = new Map<string, Cell>();
  const namespaceWriteCounts = new Map<string, number>();
  let nextInsertionIndex = 0;

  function bumpNamespace(namespace: string): void {
    namespaceWriteCounts.set(namespace, (namespaceWriteCounts.get(namespace) ?? 0) + 1);
  }

  function toStoredRecord(cell: RecordCell | StreamCell): StoredRecord {
    if (cell.form === "record") {
      return {
        key: copyKey(cell.key),
        value: copyJson(cell.value),
        revision: String(cell.revision),
        digest: cell.digest,
      };
    }
    const entries: JsonValue = cell.entries.map((entry) => ({
      id: entry.id,
      digest: entry.digest,
      value: copyJson(entry.value),
    }));
    return {
      key: copyKey(cell.key),
      value: entries,
      revision: String(cell.revision),
      digest: streamDigest(cell.entries),
    };
  }

  return {
    get: (key) => {
      const cell = cells.get(cellId(key));
      if (cell === undefined || cell.form === "tombstone") return Promise.resolve(undefined);
      return Promise.resolve(toStoredRecord(cell));
    },

    create: (key, value, digest, operationId) => {
      const id = cellId(key);
      const existing = cells.get(id);
      if (existing !== undefined) {
        if (existing.form === "record" && existing.digest === digest) {
          return Promise.resolve<WriteResult>({ status: "exists_same", revision: String(existing.revision) });
        }
        return Promise.resolve<WriteResult>({ status: "conflict", revision: String(existing.revision) });
      }
      cells.set(id, {
        form: "record",
        key: copyKey(key),
        value: copyJson(value),
        digest,
        revision: 1,
        lastOperationId: operationId,
        insertionIndex: nextInsertionIndex,
      });
      nextInsertionIndex += 1;
      bumpNamespace(key.namespace);
      return Promise.resolve<WriteResult>({ status: "created", revision: "1" });
    },

    compareAndSet: (key, expectedRevision, value, digest, operationId) => {
      const cell = cells.get(cellId(key));
      if (cell === undefined) return Promise.resolve<WriteResult>({ status: "conflict" });
      if (cell.form !== "record") {
        return Promise.resolve<WriteResult>({ status: "conflict", revision: String(cell.revision) });
      }
      if (String(cell.revision) === expectedRevision) {
        cell.value = copyJson(value);
        cell.digest = digest;
        cell.revision += 1;
        cell.lastOperationId = operationId;
        bumpNamespace(key.namespace);
        return Promise.resolve<WriteResult>({ status: "updated", revision: String(cell.revision) });
      }
      if (cell.lastOperationId === operationId && cell.digest === digest) {
        return Promise.resolve<WriteResult>({ status: "exists_same", revision: String(cell.revision) });
      }
      return Promise.resolve<WriteResult>({ status: "conflict", revision: String(cell.revision) });
    },

    append: (stream, expectedRevision, entries, operationId) => {
      const id = cellId(stream);
      const cell = cells.get(id);
      if (cell === undefined) {
        if (expectedRevision !== undefined) return Promise.resolve<WriteResult>({ status: "conflict" });
        cells.set(id, {
          form: "stream",
          key: copyKey(stream),
          entries: entries.map((entry) => ({ id: entry.id, digest: entry.digest, value: copyJson(entry.value) })),
          revision: 1,
          lastOperationId: operationId,
          insertionIndex: nextInsertionIndex,
        });
        nextInsertionIndex += 1;
        bumpNamespace(stream.namespace);
        return Promise.resolve<WriteResult>({ status: "created", revision: "1" });
      }
      if (cell.form !== "stream") {
        return Promise.resolve<WriteResult>({ status: "conflict", revision: String(cell.revision) });
      }
      if (cell.lastOperationId === operationId) {
        return Promise.resolve<WriteResult>({ status: "exists_same", revision: String(cell.revision) });
      }
      if (expectedRevision !== String(cell.revision)) {
        return Promise.resolve<WriteResult>({ status: "conflict", revision: String(cell.revision) });
      }
      const knownIds = new Set(cell.entries.map((entry) => entry.id));
      if (entries.some((entry) => knownIds.has(entry.id))) {
        return Promise.resolve<WriteResult>({ status: "conflict", revision: String(cell.revision) });
      }
      for (const entry of entries) {
        cell.entries.push({ id: entry.id, digest: entry.digest, value: copyJson(entry.value) });
      }
      cell.revision += 1;
      cell.lastOperationId = operationId;
      bumpNamespace(stream.namespace);
      return Promise.resolve<WriteResult>({ status: "updated", revision: String(cell.revision) });
    },

    tombstone: ({ key, expectedRevision, reasonCode, operationId }) => {
      const id = cellId(key);
      const cell = cells.get(id);
      if (cell === undefined) return Promise.resolve<WriteResult>({ status: "conflict" });
      if (cell.form === "tombstone") {
        if (cell.lastOperationId === operationId) {
          return Promise.resolve<WriteResult>({ status: "exists_same", revision: String(cell.revision) });
        }
        return Promise.resolve<WriteResult>({ status: "conflict", revision: String(cell.revision) });
      }
      if (String(cell.revision) !== expectedRevision) {
        return Promise.resolve<WriteResult>({ status: "conflict", revision: String(cell.revision) });
      }
      cells.set(id, {
        form: "tombstone",
        key: copyKey(key),
        revision: cell.revision + 1,
        reasonCode,
        lastOperationId: operationId,
        insertionIndex: cell.insertionIndex,
      });
      bumpNamespace(key.namespace);
      return Promise.resolve<WriteResult>({ status: "updated", revision: String(cell.revision + 1) });
    },

    list: (query) => {
      if (!Number.isInteger(query.limit) || query.limit < 1) {
        return Promise.reject(invalidQuery(`list limit must be a positive integer, got ${String(query.limit)}`));
      }
      let afterIndex = -1;
      if (query.cursor !== undefined) {
        const parsed = Number(query.cursor);
        if (!Number.isInteger(parsed) || parsed < 0) {
          return Promise.reject(invalidQuery(`unrecognized list cursor ${JSON.stringify(query.cursor)}`));
        }
        afterIndex = parsed;
      }
      const live = [...cells.values()]
        .filter(
          (cell): cell is RecordCell | StreamCell =>
            cell.form !== "tombstone" &&
            cell.key.namespace === query.namespace &&
            (query.kind === undefined || cell.key.kind === query.kind) &&
            cell.insertionIndex > afterIndex,
        )
        .sort((left, right) => left.insertionIndex - right.insertionIndex);
      const page = live.slice(0, query.limit);
      const lastCell = page[page.length - 1];
      const snapshotRevision = String(namespaceWriteCounts.get(query.namespace) ?? 0);
      return Promise.resolve({
        records: page.map((cell) => toStoredRecord(cell)),
        ...(live.length > page.length && lastCell !== undefined ? { nextCursor: String(lastCell.insertionIndex) } : {}),
        snapshotRevision,
      });
    },
  };
}
