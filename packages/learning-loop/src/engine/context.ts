// Shared engine context and storage helpers. Internal to src/engine/.
import { sha256HexOfCanonicalJson } from "../canonical/canonical-json.js";
import type { JsonValue } from "../canonical/json.js";
import { toJsonValue } from "../canonical/to-json-value.js";
import type { Diagnostic } from "../diagnostics.js";
import { LearningLoopError } from "../diagnostics.js";
import type { Clock, IdGenerator } from "../ports/clock.js";
import type { RegisteredSource } from "../ports/evidence.js";
import type { LearningStore, RecordKey, StoredRecord, WriteResult } from "../ports/store.js";
import { invalid, parseArrayOf, parseNonEmptyText, parseOneOf, readFields } from "../parse/toolkit.js";
import type { Parse } from "../parse/toolkit.js";
import type { Candidate, RiskTier } from "../records/candidate.js";
import { parseCandidate } from "../records/candidate.js";
import type { IdentityPort } from "../records/principal.js";
import type { ContentPolicy } from "../records/provenance.js";
import type { ScopePolicy } from "../records/scope.js";
import type { LearningPolicy, PolicyRules } from "./policy.js";

/** Every engine-owned record lives in this namespace. */
export const RECORD_NAMESPACE = "learning";

export type RecordKind =
  | "observation"
  | "measurement"
  | "episode"
  | "episode-identity"
  | "episode-outcome"
  | "source-revision"
  | "source-page-receipt"
  | "import-receipt"
  | "evidence-health"
  | "derivative-owner"
  | "candidate"
  | "review"
  | "candidate-by-digest";

export interface EngineContext {
  readonly store: LearningStore;
  readonly policy: LearningPolicy;
  readonly policyRules: PolicyRules;
  readonly scopePolicy: ScopePolicy;
  readonly contentPoliciesById: ReadonlyMap<string, ContentPolicy>;
  readonly sources: ReadonlySet<RegisteredSource<unknown>>;
  readonly identity: IdentityPort;
  readonly registryRevision: string;
  readonly queryCursorScopeDigest: string;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

export function recordKey(kind: RecordKind, id: string): RecordKey {
  return { namespace: RECORD_NAMESPACE, kind, id };
}

/**
 * Deterministic durable record id for an ingested projection:
 * `<sourceId>/<sourceRecordId>`. The same source record always maps to the
 * same durable id, which is what makes re-ingest idempotent.
 */
export function derivedRecordId(sourceId: string, sourceRecordId: string): string {
  return `${sourceId}/${sourceRecordId}`;
}

/** Canonical content digest of a record's serialized bytes. */
export function recordDigest(value: JsonValue): string {
  return sha256HexOfCanonicalJson(value);
}

/**
 * M1 effective risk: the monotonic maximum of the proposal and host policy.
 * No destinations are registered in the Observe+Govern milestone, so no
 * destination floor participates yet; the proposal's tier stands.
 */
export function effectiveRisk(candidate: Candidate): RiskTier {
  return candidate.proposedRisk;
}

/** LearningLoopError → its diagnostics; anything else propagates unchanged. */
export function errorDiagnostics(error: unknown): readonly Diagnostic[] {
  if (error instanceof LearningLoopError) return error.diagnostics;
  throw error;
}

export interface StoredPage {
  readonly records: readonly StoredRecord[];
  readonly nextCursor?: string;
  readonly snapshotRevision: string;
}

const parseUnknown: Parse<unknown> = (input) => input;

const parseStoredRecordAt: Parse<StoredRecord> = (input, path) => {
  const fields = readFields(input, path);
  const keyFields = readFields(fields.req("key", parseUnknown), [...path, "key"]);
  return {
    key: {
      namespace: keyFields.req("namespace", parseNonEmptyText),
      kind: keyFields.req("kind", parseNonEmptyText),
      id: keyFields.req("id", parseNonEmptyText),
    },
    value: fields.req("value", parseUnknown),
    revision: fields.req("revision", parseNonEmptyText),
    digest: fields.req("digest", parseNonEmptyText),
  };
};

function parseStoredPageAt(input: unknown, path: readonly (string | number)[], limit: number): StoredPage {
  const fields = readFields(input, path);
  const rawRecords = fields.req("records", parseUnknown);
  if (!Array.isArray(rawRecords)) {
    throw invalid("store.corrupt", "store list records must be an array", [...path, "records"]);
  }
  if (rawRecords.length > limit) {
    throw invalid("store.corrupt", "store listing exceeded the requested page limit", [...path, "records"]);
  }
  const nextCursor = fields.opt("nextCursor", parseNonEmptyText);
  return {
    records: rawRecords.map((record: unknown, index: number) =>
      parseStoredRecordAt(record, [...path, "records", index]),
    ),
    ...(nextCursor !== undefined ? { nextCursor } : {}),
    snapshotRevision: fields.req("snapshotRevision", parseNonEmptyText),
  };
}

const WRITE_STATUSES = ["created", "updated", "exists_same", "conflict"] as const;

export function parseWriteResult(input: unknown): WriteResult {
  const fields = readFields(input, ["store", "write"]);
  const status = fields.req("status", parseOneOf(WRITE_STATUSES));
  const revision = fields.opt("revision", parseNonEmptyText);
  if (status === "conflict") return revision === undefined ? { status } : { status, revision };
  if (revision === undefined) {
    throw invalid("store.corrupt", `store returned ${status} without a revision`, ["store", "write", "revision"]);
  }
  return { status, revision };
}

const parseStreamEntryIdAt: Parse<string> = (input, path) => {
  const fields = readFields(input, path);
  return fields.req("id", parseNonEmptyText);
};

function expectedStoredDigest(kind: RecordKind, value: unknown): string {
  if (kind === "episode-identity" || kind === "episode-outcome" || kind === "source-revision") {
    const entryIds = parseArrayOf(parseStreamEntryIdAt)(value, ["value"]);
    return sha256HexOfCanonicalJson(entryIds);
  }
  return recordDigest(toJsonValue(value));
}

function assertRecordLocation(record: StoredRecord, kind: RecordKind, id?: string): void {
  if (
    record.key.namespace !== RECORD_NAMESPACE ||
    record.key.kind !== kind ||
    (id !== undefined && record.key.id !== id)
  ) {
    throw invalid("store.corrupt", `store returned a foreign ${kind} record`, ["key"]);
  }
  const expectedDigest = expectedStoredDigest(kind, record.value);
  if (record.digest !== expectedDigest) {
    throw invalid("store.corrupt", `stored ${kind} digest does not match its content`, ["digest"]);
  }
}

/** Validated, bounded page stream over one private engine record kind. */
export async function* iterateRecordPages(
  store: LearningStore,
  kind: RecordKind,
  options: { readonly cursor?: string; readonly limit: number },
): AsyncIterable<StoredPage> {
  let cursor = options.cursor;
  const seenCursors = new Set<string>();
  if (cursor !== undefined) seenCursors.add(cursor);
  for (;;) {
    const rawPage: unknown = await store.list({
      namespace: RECORD_NAMESPACE,
      kind,
      ...(cursor !== undefined ? { cursor } : {}),
      limit: options.limit,
    });
    const page = parseStoredPageAt(rawPage, ["store", "list", kind], options.limit);
    for (const record of page.records) assertRecordLocation(record, kind);
    yield page;
    if (page.nextCursor === undefined) return;
    if (seenCursors.has(page.nextCursor)) {
      throw invalid("store.corrupt", `store listing for ${kind} cycled its cursor`, ["nextCursor"]);
    }
    cursor = page.nextCursor;
    seenCursors.add(cursor);
  }
}

export async function readRecordKindRevision(store: LearningStore, kind: RecordKind): Promise<string> {
  const rawPage: unknown = await store.list({ namespace: RECORD_NAMESPACE, kind, limit: 1 });
  const page = parseStoredPageAt(rawPage, ["store", "list", kind, "revision"], 1);
  for (const record of page.records) assertRecordLocation(record, kind);
  return page.snapshotRevision;
}

export async function loadStoredRecord(
  context: EngineContext,
  kind: RecordKind,
  id: string,
): Promise<StoredRecord | undefined> {
  const rawStored: unknown = await context.store.get(recordKey(kind, id));
  if (rawStored === undefined) return undefined;
  const stored = parseStoredRecordAt(rawStored, ["store", "get", kind]);
  assertRecordLocation(stored, kind, id);
  return stored;
}

export async function loadRecordValue(
  context: EngineContext,
  kind: RecordKind,
  id: string,
): Promise<unknown | undefined> {
  return (await loadStoredRecord(context, kind, id))?.value;
}

export async function loadCandidate(context: EngineContext, candidateId: string): Promise<Candidate | undefined> {
  const value = await loadRecordValue(context, "candidate", candidateId);
  if (value === undefined) return undefined;
  const candidate = parseCandidate(value);
  if (candidate.id !== candidateId) {
    throw invalid("store.corrupt", "stored candidate id does not match its record key", ["id"]);
  }
  return candidate;
}

/**
 * Persists a record create-only and reports what happened. `exists_same`
 * means not net-new (idempotent re-ingest); a conflicting existing record is
 * surfaced through a `store.conflict` diagnostic and NEVER overwritten.
 */
export async function createOnly(
  context: EngineContext,
  kind: RecordKind,
  id: string,
  record: unknown,
  operationId: string,
): Promise<"created" | "exists_same" | "conflict"> {
  const value = toJsonValue(record);
  const rawResult: unknown = await context.store.create(recordKey(kind, id), value, recordDigest(value), operationId);
  const result = parseWriteResult(rawResult);
  if (result.status === "updated") {
    throw new LearningLoopError("store.corrupt", [
      {
        code: "store.corrupt",
        severity: "error",
        message: `store returned "updated" for a create of ${kind} "${id}"; create must never update`,
      },
    ]);
  }
  return result.status;
}

export function conflictDiagnostic(kind: RecordKind, id: string): Diagnostic {
  return {
    code: "store.conflict",
    severity: "error",
    message: `an existing ${kind} record "${id}" holds different content; refusing to overwrite`,
    details: { kind, id },
  };
}
