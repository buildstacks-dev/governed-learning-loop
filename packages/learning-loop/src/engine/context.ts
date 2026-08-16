// Shared engine context and storage helpers. Internal to src/engine/.
import { sha256HexOfCanonicalJson } from "../canonical/canonical-json.js";
import type { JsonValue } from "../canonical/json.js";
import { toJsonValue } from "../canonical/to-json-value.js";
import type { Diagnostic } from "../diagnostics.js";
import { LearningLoopError } from "../diagnostics.js";
import type { Clock, IdGenerator } from "../ports/clock.js";
import type { RegisteredSource } from "../ports/evidence.js";
import type { LearningStore, RecordKey, StoredRecord } from "../ports/store.js";
import type { Candidate, RiskTier } from "../records/candidate.js";
import { parseCandidate } from "../records/candidate.js";
import type { ContentPolicy } from "../records/provenance.js";
import type { ScopePolicy } from "../records/scope.js";
import type { LearningPolicy, PolicyRules } from "./policy.js";

/** Every engine-owned record lives in this namespace. */
export const RECORD_NAMESPACE = "learning";

export type RecordKind = "observation" | "measurement" | "episode" | "candidate" | "review" | "candidate-by-digest";

export interface EngineContext {
  readonly store: LearningStore;
  readonly policy: LearningPolicy;
  readonly policyRules: PolicyRules;
  readonly scopePolicy: ScopePolicy;
  readonly contentPoliciesById: ReadonlyMap<string, ContentPolicy>;
  readonly sources: ReadonlySet<RegisteredSource<unknown>>;
  readonly registryRevision: string;
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

/** Exhaustively pages through the store for one record kind. */
export async function listAllRecords(store: LearningStore, kind: RecordKind): Promise<readonly StoredRecord[]> {
  const records: StoredRecord[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await store.list({
      namespace: RECORD_NAMESPACE,
      kind,
      ...(cursor !== undefined ? { cursor } : {}),
      limit: 100,
    });
    records.push(...page.records);
    if (page.nextCursor === undefined) return records;
    cursor = page.nextCursor;
  }
}

export async function loadCandidate(context: EngineContext, candidateId: string): Promise<Candidate | undefined> {
  const stored = await context.store.get(recordKey("candidate", candidateId));
  if (stored === undefined) return undefined;
  return parseCandidate(stored.value);
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
  const result = await context.store.create(recordKey(kind, id), value, recordDigest(value), operationId);
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
