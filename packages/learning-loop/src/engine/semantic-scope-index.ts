// Scope-partitioned private indexes for semantic public reads. The namespace
// is derived only from the exact scope digest, so pagination and direct gets
// never touch another scope's semantic target records.
import { sha256HexOfCanonicalJson } from "../canonical/canonical-json.js";
import { toJsonValue } from "../canonical/to-json-value.js";
import { invalid, parseNonEmptyText, readFields } from "../parse/toolkit.js";
import type { Parse } from "../parse/toolkit.js";
import type { DetectorExecutionRecord } from "../records/detector-execution.js";
import type { InsightDerivation } from "../records/insight-derivation.js";
import { parseDigestAt, parseDurableId } from "../records/semantic-shared.js";
import type { StoredRecord } from "../ports/store.js";
import type { EngineContext } from "./context.js";
import { parseWriteResult, recordDigest } from "./context.js";

const INSIGHT_INDEX_KIND = "insight-derivation-index";
const EXECUTION_INDEX_KIND = "detector-execution-index";
const INSIGHT_ID_PATTERN = /^insight-[0-9a-f]{64}$/;
const EXECUTION_ID_PATTERN = /^detector-execution-[0-9a-f]{64}$/;

export type SemanticScopeIndexKind = typeof INSIGHT_INDEX_KIND | typeof EXECUTION_INDEX_KIND;

export interface SemanticScopeIndexEntry {
  readonly schemaVersion: 1;
  readonly targetId: string;
  readonly targetDigest: string;
  readonly scopeDigest: string;
  readonly indexDigest: string;
}

export interface SemanticScopeIndexPage {
  readonly entries: readonly SemanticScopeIndexEntry[];
  readonly nextCursor?: string;
  readonly snapshotRevision: string;
}

const parseUnknown: Parse<unknown> = (input) => input;

function semanticScopeNamespace(exactScopeDigest: string): string {
  return `learning-semantic-scope-${exactScopeDigest}`;
}

function indexDigest(
  kind: SemanticScopeIndexKind,
  input: Omit<SemanticScopeIndexEntry, "schemaVersion" | "indexDigest">,
): string {
  return sha256HexOfCanonicalJson(toJsonValue({ kind, ...input }));
}

function parseIndexEntry(
  input: unknown,
  kind: SemanticScopeIndexKind,
  expectedScopeDigest: string,
): SemanticScopeIndexEntry {
  const fields = readFields(input, []);
  const schemaVersion = fields.schemaVersion1();
  const targetId = fields.req("targetId", parseDurableId);
  const targetDigest = fields.req("targetDigest", parseDigestAt);
  const exactScopeDigest = fields.req("scopeDigest", parseDigestAt);
  if (exactScopeDigest !== expectedScopeDigest) {
    throw invalid("store.corrupt", "semantic scope index entry belongs to another scope", ["scopeDigest"]);
  }
  if (
    (kind === INSIGHT_INDEX_KIND && (!INSIGHT_ID_PATTERN.test(targetId) || targetId !== `insight-${targetDigest}`)) ||
    (kind === EXECUTION_INDEX_KIND && !EXECUTION_ID_PATTERN.test(targetId))
  ) {
    throw invalid("store.corrupt", "semantic scope index target identity is invalid", ["targetId"]);
  }
  const base = { targetId, targetDigest, scopeDigest: exactScopeDigest };
  const exactIndexDigest = fields.req("indexDigest", parseDigestAt);
  if (exactIndexDigest !== indexDigest(kind, base)) {
    throw invalid("store.corrupt", "semantic scope index digest does not match its content", ["indexDigest"]);
  }
  return { schemaVersion, ...base, indexDigest: exactIndexDigest };
}

function parseStoredRecordAt(input: unknown, path: readonly (string | number)[]): StoredRecord {
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
}

function parseStoredIndex(
  input: unknown,
  kind: SemanticScopeIndexKind,
  expectedScopeDigest: string,
  path: readonly (string | number)[],
): SemanticScopeIndexEntry {
  const stored = parseStoredRecordAt(input, path);
  const namespace = semanticScopeNamespace(expectedScopeDigest);
  if (stored.key.namespace !== namespace || stored.key.kind !== kind) {
    throw invalid("store.corrupt", "store returned a foreign semantic scope index record", [...path, "key"]);
  }
  const value = toJsonValue(stored.value);
  if (stored.digest !== recordDigest(value)) {
    throw invalid("store.corrupt", "stored semantic scope index digest does not match its value", [...path, "digest"]);
  }
  const entry = parseIndexEntry(value, kind, expectedScopeDigest);
  if (entry.targetId !== stored.key.id) {
    throw invalid("store.corrupt", "semantic scope index target does not match its key", [...path, "key", "id"]);
  }
  return entry;
}

function buildIndex(
  kind: SemanticScopeIndexKind,
  targetId: string,
  targetDigest: string,
  exactScopeDigest: string,
): SemanticScopeIndexEntry {
  const base = { targetId, targetDigest, scopeDigest: exactScopeDigest };
  return parseIndexEntry({ schemaVersion: 1, ...base, indexDigest: indexDigest(kind, base) }, kind, exactScopeDigest);
}

async function loadIndex(
  context: EngineContext,
  kind: SemanticScopeIndexKind,
  targetId: string,
  exactScopeDigest: string,
): Promise<SemanticScopeIndexEntry | undefined> {
  const raw: unknown = await context.store.get({
    namespace: semanticScopeNamespace(exactScopeDigest),
    kind,
    id: targetId,
  });
  return raw === undefined ? undefined : parseStoredIndex(raw, kind, exactScopeDigest, ["store", "get", kind]);
}

async function persistIndex(
  context: EngineContext,
  kind: SemanticScopeIndexKind,
  entry: SemanticScopeIndexEntry,
): Promise<void> {
  const value = toJsonValue(entry);
  const rawResult: unknown = await context.store.create(
    {
      namespace: semanticScopeNamespace(entry.scopeDigest),
      kind,
      id: entry.targetId,
    },
    value,
    recordDigest(value),
    `semantic-scope-index/${kind}/${entry.scopeDigest}/${entry.targetId}`,
  );
  const result = parseWriteResult(rawResult);
  if (result.status === "updated") {
    throw invalid("store.corrupt", "store updated a create-only semantic scope index", ["store", "create"]);
  }
  if (result.status === "conflict") {
    throw invalid(
      kind === EXECUTION_INDEX_KIND ? "semantic.execution_conflict" : "store.corrupt",
      "semantic scope index target already binds different content",
      ["store", "create"],
    );
  }
  const stored = await loadIndex(context, kind, entry.targetId, entry.scopeDigest);
  if (stored === undefined || stored.indexDigest !== entry.indexDigest) {
    throw invalid("store.corrupt", "store acknowledged a semantic scope index without preserving it", []);
  }
}

export function persistInsightDerivationScopeIndex(
  context: EngineContext,
  derivation: InsightDerivation,
): Promise<void> {
  return persistIndex(
    context,
    INSIGHT_INDEX_KIND,
    buildIndex(INSIGHT_INDEX_KIND, derivation.id, derivation.derivationDigest, derivation.scopeDigest),
  );
}

export function persistDetectorExecutionScopeIndex(
  context: EngineContext,
  execution: DetectorExecutionRecord,
): Promise<void> {
  return persistIndex(
    context,
    EXECUTION_INDEX_KIND,
    buildIndex(EXECUTION_INDEX_KIND, execution.id, execution.executionDigest, execution.scopeDigest),
  );
}

export function loadInsightDerivationScopeIndex(
  context: EngineContext,
  derivationId: string,
  exactScopeDigest: string,
): Promise<SemanticScopeIndexEntry | undefined> {
  return loadIndex(context, INSIGHT_INDEX_KIND, derivationId, exactScopeDigest);
}

export function loadDetectorExecutionScopeIndex(
  context: EngineContext,
  executionId: string,
  exactScopeDigest: string,
): Promise<SemanticScopeIndexEntry | undefined> {
  return loadIndex(context, EXECUTION_INDEX_KIND, executionId, exactScopeDigest);
}

export async function loadSemanticScopeIndexPage(
  context: EngineContext,
  kind: SemanticScopeIndexKind,
  exactScopeDigest: string,
  options: { readonly cursor?: string; readonly limit: number },
): Promise<SemanticScopeIndexPage> {
  const rawPage: unknown = await context.store.list({
    namespace: semanticScopeNamespace(exactScopeDigest),
    kind,
    ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
    limit: options.limit,
  });
  const fields = readFields(rawPage, ["store", "list", kind]);
  const rawRecords = fields.req("records", parseUnknown);
  if (!Array.isArray(rawRecords)) {
    throw invalid("store.corrupt", "semantic scope index page records must be an array", ["records"]);
  }
  if (rawRecords.length > options.limit) {
    throw invalid("store.corrupt", "semantic scope index page exceeded its requested limit", ["records"]);
  }
  const entries = rawRecords.map((record: unknown, index: number) =>
    parseStoredIndex(record, kind, exactScopeDigest, ["store", "list", kind, "records", index]),
  );
  const nextCursor = fields.opt("nextCursor", parseNonEmptyText);
  return {
    entries,
    ...(nextCursor === undefined ? {} : { nextCursor }),
    snapshotRevision: fields.req("snapshotRevision", parseNonEmptyText),
  };
}

async function indexKindRevision(
  context: EngineContext,
  exactScopeDigest: string,
  kind: SemanticScopeIndexKind,
): Promise<string> {
  const page = await loadSemanticScopeIndexPage(context, kind, exactScopeDigest, { limit: 1 });
  return page.snapshotRevision;
}

export async function semanticScopeIndexSnapshotRevision(
  context: EngineContext,
  exactScopeDigest: string,
): Promise<string> {
  const insight = await indexKindRevision(context, exactScopeDigest, INSIGHT_INDEX_KIND);
  const execution = await indexKindRevision(context, exactScopeDigest, EXECUTION_INDEX_KIND);
  return sha256HexOfCanonicalJson(toJsonValue({ insight, execution }));
}

export const SEMANTIC_INSIGHT_SCOPE_INDEX_KIND = INSIGHT_INDEX_KIND;
export const SEMANTIC_EXECUTION_SCOPE_INDEX_KIND = EXECUTION_INDEX_KIND;
