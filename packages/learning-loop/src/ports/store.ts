// Storage port (contract §Storage). Concurrency-explicit primitives; the
// engine validates every returned value from `unknown`. Non-negotiable
// semantics: create-only conflict detection, expected-revision updates,
// ordered append, idempotent same-content retry, namespace isolation,
// consistent bounded listing, tombstones, explicit corruption. A
// last-writer-wins implementation does not pass the conformance suite.
import type { JsonValue } from "../canonical/json.js";

export interface RecordKey {
  readonly namespace: string;
  readonly kind: string;
  readonly id: string;
}

export interface StoredRecord {
  readonly key: RecordKey;
  readonly value: unknown;
  readonly revision: string;
  readonly digest: string;
}

export interface StreamEntry {
  readonly id: string;
  readonly digest: string;
  readonly value: JsonValue;
}

export type WriteResult =
  | { readonly status: "created" | "updated"; readonly revision: string }
  | { readonly status: "exists_same"; readonly revision: string }
  | { readonly status: "conflict"; readonly revision?: string };

export interface LearningStore {
  get(key: RecordKey): Promise<StoredRecord | undefined>;

  create(key: RecordKey, value: JsonValue, digest: string, operationId: string): Promise<WriteResult>;

  compareAndSet(
    key: RecordKey,
    expectedRevision: string,
    value: JsonValue,
    digest: string,
    operationId: string,
  ): Promise<WriteResult>;

  append(
    stream: RecordKey,
    expectedRevision: string | undefined,
    entries: readonly StreamEntry[],
    operationId: string,
  ): Promise<WriteResult>;

  tombstone(input: {
    readonly key: RecordKey;
    readonly expectedRevision: string;
    readonly reasonCode: string;
    readonly operationId: string;
  }): Promise<WriteResult>;

  list(query: {
    readonly namespace: string;
    readonly kind?: string;
    readonly cursor?: string;
    readonly limit: number;
  }): Promise<{
    readonly records: readonly StoredRecord[];
    readonly nextCursor?: string;
    readonly snapshotRevision: string;
  }>;
}
