// Public, read-only semantic query surface. Exact scope is mandatory so a
// caller cannot enumerate another project through ids, cursors, or partial
// commit state. Detector execution persistence remains engine-private.
import { Buffer } from "node:buffer";
import { canonicalJsonText, sha256HexOfCanonicalJson } from "../canonical/canonical-json.js";
import type { JsonValue } from "../canonical/json.js";
import { toJsonValue } from "../canonical/to-json-value.js";
import { invalid, parseBool, parseFiniteNumber, parseNonEmptyText, parseOneOf, readFields } from "../parse/toolkit.js";
import type { Parse } from "../parse/toolkit.js";
import type { DetectorExecutionRecord, DetectorExecutionStatus } from "../records/detector-execution.js";
import type { InsightDerivation } from "../records/insight-derivation.js";
import type { Scope } from "../records/scope.js";
import type { LearningClass } from "../records/semantic-shared.js";
import {
  parseDigestAt,
  parseDurableId,
  parseId,
  parseLearningClassAt,
  scopeDigest,
} from "../records/semantic-shared.js";
import type { EngineContext } from "./context.js";
import type { QueryPage } from "./query.js";
import { loadDetectorExecutionRecord, semanticGraphSnapshotRevision } from "./semantic-graph.js";
import type { DetectorExecutionView, InsightDerivationView } from "./semantic-persistence.js";
import { loadDetectorExecutionView, loadInsightDerivationView } from "./semantic-persistence.js";
import type { SemanticScopeIndexPage } from "./semantic-scope-index.js";
import {
  loadDetectorExecutionScopeIndex,
  loadInsightDerivationScopeIndex,
  loadSemanticScopeIndexPage,
  SEMANTIC_EXECUTION_SCOPE_INDEX_KIND,
  SEMANTIC_INSIGHT_SCOPE_INDEX_KIND,
  semanticScopeIndexSnapshotRevision,
} from "./semantic-scope-index.js";

export type { DetectorExecutionView, InsightDerivationView } from "./semantic-persistence.js";

const MAX_QUERY_LIMIT = 500;
const MAX_FILTER_VALUES = 1_000;
const MAX_CURSOR_LENGTH = 16_384;
const MAX_SCOPE_SEGMENTS = 1_000;
const MAX_STABLE_READ_ATTEMPTS = 3;
const PRODUCER_KINDS = ["deterministic", "human", "semantic_judgment"] as const;
const REGISTRY_STATUSES = ["configured", "historical_unconfigured"] as const;
const INSIGHT_COMMIT_STATUSES = ["committed", "orphaned", "invalid"] as const;
const EXECUTION_COMMIT_STATUSES = ["committed", "invalid"] as const;
const EXECUTION_STATUSES: readonly DetectorExecutionStatus[] = ["applied", "not_applicable", "incomplete"];

type ProducerKind = (typeof PRODUCER_KINDS)[number];
type RegistryStatus = (typeof REGISTRY_STATUSES)[number];
type InsightCommitStatus = (typeof INSIGHT_COMMIT_STATUSES)[number];
type ExecutionCommitStatus = (typeof EXECUTION_COMMIT_STATUSES)[number];
type SemanticQueryKind = "insight-derivation" | "detector-execution";

export interface InsightDerivationQuery {
  readonly scope: Scope;
  readonly derivationIds?: readonly string[];
  readonly detectorIds?: readonly string[];
  readonly detectorRegistrationDigests?: readonly string[];
  readonly packManifestDigests?: readonly string[];
  readonly lensRegistrationDigests?: readonly string[];
  readonly learningClasses?: readonly LearningClass[];
  readonly producerKinds?: readonly ProducerKind[];
  readonly registryStatuses?: readonly RegistryStatus[];
  readonly commitStatuses?: readonly InsightCommitStatus[];
  readonly cursor?: string;
  readonly limit: number;
}

export interface DetectorExecutionQuery {
  readonly scope: Scope;
  readonly executionIds?: readonly string[];
  readonly detectorIds?: readonly string[];
  readonly detectorRegistrationDigests?: readonly string[];
  readonly packManifestDigests?: readonly string[];
  readonly lensRegistrationDigests?: readonly string[];
  readonly statuses?: readonly DetectorExecutionStatus[];
  readonly conditionDetected?: boolean;
  readonly registryStatuses?: readonly RegistryStatus[];
  readonly commitStatuses?: readonly ExecutionCommitStatus[];
  readonly cursor?: string;
  readonly limit: number;
}

interface ParsedPageQuery {
  readonly scope: Scope;
  readonly cursor?: string;
  readonly limit: number;
}

interface ParsedInsightDerivationQuery extends ParsedPageQuery {
  readonly derivationIds?: readonly string[];
  readonly detectorIds?: readonly string[];
  readonly detectorRegistrationDigests?: readonly string[];
  readonly packManifestDigests?: readonly string[];
  readonly lensRegistrationDigests?: readonly string[];
  readonly learningClasses?: readonly LearningClass[];
  readonly producerKinds?: readonly ProducerKind[];
  readonly registryStatuses?: readonly RegistryStatus[];
  readonly commitStatuses?: readonly InsightCommitStatus[];
}

interface ParsedDetectorExecutionQuery extends ParsedPageQuery {
  readonly executionIds?: readonly string[];
  readonly detectorIds?: readonly string[];
  readonly detectorRegistrationDigests?: readonly string[];
  readonly packManifestDigests?: readonly string[];
  readonly lensRegistrationDigests?: readonly string[];
  readonly statuses?: readonly DetectorExecutionStatus[];
  readonly conditionDetected?: boolean;
  readonly registryStatuses?: readonly RegistryStatus[];
  readonly commitStatuses?: readonly ExecutionCommitStatus[];
}

interface CursorPayload {
  readonly version: 1;
  readonly kind: SemanticQueryKind;
  readonly storeCursor: string;
  readonly filterDigest: string;
  readonly registryRevision: string;
  readonly cursorScopeDigest: string;
}

const parseLimit: Parse<number> = (input, path) => {
  const value = parseFiniteNumber(input, path);
  if (!Number.isInteger(value) || value < 1 || value > MAX_QUERY_LIMIT) {
    throw invalid("query.invalid", `limit must be an integer from 1 through ${MAX_QUERY_LIMIT}`, path);
  }
  return value;
};

const parseCursorText: Parse<string> = (input, path) => {
  const value = parseNonEmptyText(input, path);
  if (value.length > MAX_CURSOR_LENGTH) {
    throw invalid("query.invalid", `cursor exceeds ${MAX_CURSOR_LENGTH} characters`, path);
  }
  return value;
};

const parseCursorVersion: Parse<1> = (input, path) => {
  if (input !== 1) throw invalid("query.cursor_invalid", "unsupported query cursor version", path);
  return 1;
};

function isPlainRecord(input: unknown): input is Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return false;
  const prototype = Object.getPrototypeOf(input);
  return prototype === Object.prototype || prototype === null;
}

function assertAllowedFields(input: unknown, allowed: readonly string[], path: readonly string[]): void {
  if (!isPlainRecord(input)) return;
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(input)) {
    if (!allowedSet.has(key)) throw invalid("query.invalid", "query contains an unknown field", path);
  }
}

function parseBoundedArrayOf<T>(parse: Parse<T>): Parse<readonly T[]> {
  return (input, path) => {
    if (!Array.isArray(input)) throw invalid("query.invalid", "query filter must be an array", path);
    if (input.length > MAX_FILTER_VALUES) {
      throw invalid("query.invalid", `query filter exceeds ${MAX_FILTER_VALUES} values`, path);
    }
    return input.map((value: unknown, index: number) => parse(value, [...path, index]));
  };
}

function sortedUnique<T extends string>(values: readonly T[]): readonly T[] {
  return [...new Set(values)].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

function parseScope(context: EngineContext, input: unknown, path: readonly (string | number)[]): Scope {
  if (Array.isArray(input) && input.length > MAX_SCOPE_SEGMENTS) {
    throw invalid("query.invalid", `scope exceeds ${MAX_SCOPE_SEGMENTS} segments`, path);
  }
  return context.scopePolicy.validate(input);
}

function optionalSorted<T extends string>(
  fields: ReturnType<typeof readFields>,
  key: string,
  parse: Parse<T>,
): readonly T[] | undefined {
  const values = fields.opt(key, parseBoundedArrayOf(parse));
  return values === undefined ? undefined : sortedUnique(values);
}

function commonQueryFields(
  context: EngineContext,
  input: unknown,
): { readonly fields: ReturnType<typeof readFields>; readonly parsed: ParsedPageQuery } {
  const fields = readFields(input, ["query"]);
  const cursor = fields.opt("cursor", parseCursorText);
  return {
    fields,
    parsed: {
      scope: fields.req("scope", (value, path) => parseScope(context, value, path)),
      ...(cursor === undefined ? {} : { cursor }),
      limit: fields.req("limit", parseLimit),
    },
  };
}

function parseInsightDerivationQuery(context: EngineContext, input: unknown): ParsedInsightDerivationQuery {
  assertAllowedFields(
    input,
    [
      "scope",
      "derivationIds",
      "detectorIds",
      "detectorRegistrationDigests",
      "packManifestDigests",
      "lensRegistrationDigests",
      "learningClasses",
      "producerKinds",
      "registryStatuses",
      "commitStatuses",
      "cursor",
      "limit",
    ],
    ["query"],
  );
  const { fields, parsed } = commonQueryFields(context, input);
  const derivationIds = optionalSorted(fields, "derivationIds", parseDurableId);
  const detectorIds = optionalSorted(fields, "detectorIds", parseId);
  const detectorRegistrationDigests = optionalSorted(fields, "detectorRegistrationDigests", parseDigestAt);
  const packManifestDigests = optionalSorted(fields, "packManifestDigests", parseDigestAt);
  const lensRegistrationDigests = optionalSorted(fields, "lensRegistrationDigests", parseDigestAt);
  const learningClasses = optionalSorted(fields, "learningClasses", parseLearningClassAt);
  const producerKinds = optionalSorted(fields, "producerKinds", parseOneOf(PRODUCER_KINDS));
  const registryStatuses = optionalSorted(fields, "registryStatuses", parseOneOf(REGISTRY_STATUSES));
  const commitStatuses = optionalSorted(fields, "commitStatuses", parseOneOf(INSIGHT_COMMIT_STATUSES));
  return {
    ...parsed,
    ...(derivationIds === undefined ? {} : { derivationIds }),
    ...(detectorIds === undefined ? {} : { detectorIds }),
    ...(detectorRegistrationDigests === undefined ? {} : { detectorRegistrationDigests }),
    ...(packManifestDigests === undefined ? {} : { packManifestDigests }),
    ...(lensRegistrationDigests === undefined ? {} : { lensRegistrationDigests }),
    ...(learningClasses === undefined ? {} : { learningClasses }),
    ...(producerKinds === undefined ? {} : { producerKinds }),
    ...(registryStatuses === undefined ? {} : { registryStatuses }),
    ...(commitStatuses === undefined ? {} : { commitStatuses }),
  };
}

function parseDetectorExecutionQuery(context: EngineContext, input: unknown): ParsedDetectorExecutionQuery {
  assertAllowedFields(
    input,
    [
      "scope",
      "executionIds",
      "detectorIds",
      "detectorRegistrationDigests",
      "packManifestDigests",
      "lensRegistrationDigests",
      "statuses",
      "conditionDetected",
      "registryStatuses",
      "commitStatuses",
      "cursor",
      "limit",
    ],
    ["query"],
  );
  const { fields, parsed } = commonQueryFields(context, input);
  const executionIds = optionalSorted(fields, "executionIds", parseDurableId);
  const detectorIds = optionalSorted(fields, "detectorIds", parseId);
  const detectorRegistrationDigests = optionalSorted(fields, "detectorRegistrationDigests", parseDigestAt);
  const packManifestDigests = optionalSorted(fields, "packManifestDigests", parseDigestAt);
  const lensRegistrationDigests = optionalSorted(fields, "lensRegistrationDigests", parseDigestAt);
  const statuses = optionalSorted(fields, "statuses", parseOneOf(EXECUTION_STATUSES));
  const registryStatuses = optionalSorted(fields, "registryStatuses", parseOneOf(REGISTRY_STATUSES));
  const commitStatuses = optionalSorted(fields, "commitStatuses", parseOneOf(EXECUTION_COMMIT_STATUSES));
  const conditionDetected = fields.opt("conditionDetected", parseBool);
  return {
    ...parsed,
    ...(executionIds === undefined ? {} : { executionIds }),
    ...(detectorIds === undefined ? {} : { detectorIds }),
    ...(detectorRegistrationDigests === undefined ? {} : { detectorRegistrationDigests }),
    ...(packManifestDigests === undefined ? {} : { packManifestDigests }),
    ...(lensRegistrationDigests === undefined ? {} : { lensRegistrationDigests }),
    ...(statuses === undefined ? {} : { statuses }),
    ...(conditionDetected === undefined ? {} : { conditionDetected }),
    ...(registryStatuses === undefined ? {} : { registryStatuses }),
    ...(commitStatuses === undefined ? {} : { commitStatuses }),
  };
}

function isJsonRecord(value: JsonValue): value is { readonly [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function queryFilterDigest(query: ParsedInsightDerivationQuery | ParsedDetectorExecutionQuery): string {
  const value = toJsonValue(query);
  if (!isJsonRecord(value)) return sha256HexOfCanonicalJson(value);
  const filters: { [key: string]: JsonValue } = {};
  for (const [key, field] of Object.entries(value)) {
    if (key !== "cursor" && key !== "limit") filters[key] = field;
  }
  return sha256HexOfCanonicalJson(filters);
}

function parseCursorPayload(input: unknown): CursorPayload {
  const fields = readFields(input, ["cursor"]);
  return {
    version: fields.req("version", parseCursorVersion),
    kind: fields.req("kind", parseOneOf(["insight-derivation", "detector-execution"])),
    storeCursor: fields.req("storeCursor", parseNonEmptyText),
    filterDigest: fields.req("filterDigest", parseDigestAt),
    registryRevision: fields.req("registryRevision", parseDigestAt),
    cursorScopeDigest: fields.req("cursorScopeDigest", parseDigestAt),
  };
}

function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(canonicalJsonText(toJsonValue(payload)), "utf8").toString("base64url");
}

function decodeCursor(
  cursor: string | undefined,
  kind: SemanticQueryKind,
  filterDigest: string,
  registryRevision: string,
  cursorScopeDigest: string,
): string | undefined {
  if (cursor === undefined) return undefined;
  let bytes: Buffer;
  try {
    bytes = Buffer.from(cursor, "base64url");
  } catch {
    throw invalid("query.cursor_invalid", "query cursor is not valid base64url", ["query", "cursor"]);
  }
  if (bytes.length === 0 || bytes.toString("base64url") !== cursor) {
    throw invalid("query.cursor_invalid", "query cursor is not canonical base64url", ["query", "cursor"]);
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw invalid("query.cursor_invalid", "query cursor does not contain valid JSON", ["query", "cursor"]);
  }
  const payload = parseCursorPayload(decoded);
  if (payload.kind !== kind) {
    throw invalid("query.cursor_mismatch", "query cursor belongs to another record kind", ["query", "cursor"]);
  }
  if (payload.filterDigest !== filterDigest) {
    throw invalid("query.cursor_mismatch", "query cursor filters do not match this query", ["query", "cursor"]);
  }
  if (payload.registryRevision !== registryRevision) {
    throw invalid("query.cursor_mismatch", "query cursor belongs to another loop registry", ["query", "cursor"]);
  }
  if (payload.cursorScopeDigest !== cursorScopeDigest) {
    throw invalid("query.cursor_mismatch", "query cursor belongs to another store scope", ["query", "cursor"]);
  }
  return payload.storeCursor;
}

function nextQueryCursor(
  storeCursor: string | undefined,
  kind: SemanticQueryKind,
  filterDigest: string,
  registryRevision: string,
  cursorScopeDigest: string,
): string | undefined {
  if (storeCursor === undefined) return undefined;
  return encodeCursor({ version: 1, kind, storeCursor, filterDigest, registryRevision, cursorScopeDigest });
}

function includesValue<T extends string>(values: readonly T[] | undefined, value: T): boolean {
  return values === undefined || values.includes(value);
}

function scopesEqual(left: Scope, right: Scope): boolean {
  if (left.length !== right.length) return false;
  return left.every((segment, index) => {
    const other = right[index];
    return other !== undefined && segment.type === other.type && segment.id === other.id;
  });
}

function insightRecordMatches(derivation: InsightDerivation, query: ParsedInsightDerivationQuery): boolean {
  return (
    scopesEqual(derivation.scope, query.scope) &&
    includesValue(query.derivationIds, derivation.id) &&
    includesValue(query.detectorIds, derivation.detector.id) &&
    includesValue(query.detectorRegistrationDigests, derivation.detector.registrationDigest) &&
    (query.packManifestDigests === undefined ||
      (derivation.pack !== null && query.packManifestDigests.includes(derivation.pack.manifestDigest))) &&
    includesValue(query.lensRegistrationDigests, derivation.lens.registrationDigest) &&
    includesValue(query.learningClasses, derivation.learningClass) &&
    includesValue(query.producerKinds, derivation.producer.kind)
  );
}

function insightViewMatches(view: InsightDerivationView, query: ParsedInsightDerivationQuery): boolean {
  return (
    includesValue(query.registryStatuses, view.registryBinding.status) &&
    includesValue(query.commitStatuses, view.commitBinding.status)
  );
}

function executionRecordMatches(execution: DetectorExecutionRecord, query: ParsedDetectorExecutionQuery): boolean {
  return (
    scopesEqual(execution.scope, query.scope) &&
    includesValue(query.executionIds, execution.id) &&
    includesValue(query.detectorIds, execution.detector.id) &&
    includesValue(query.detectorRegistrationDigests, execution.detector.registrationDigest) &&
    includesValue(query.packManifestDigests, execution.pack.manifestDigest) &&
    (query.lensRegistrationDigests === undefined ||
      (execution.lens !== null && query.lensRegistrationDigests.includes(execution.lens.registrationDigest))) &&
    includesValue(query.statuses, execution.result.status) &&
    (query.conditionDetected === undefined ||
      (execution.result.status === "applied" && execution.result.conditionDetected === query.conditionDetected))
  );
}

function executionViewMatches(view: DetectorExecutionView, query: ParsedDetectorExecutionQuery): boolean {
  return (
    includesValue(query.registryStatuses, view.registryBinding.status) &&
    includesValue(query.commitStatuses, view.commitBinding.status)
  );
}

async function semanticQuerySnapshotRevision(context: EngineContext, exactScopeDigest: string): Promise<string> {
  const graphRevision = await semanticGraphSnapshotRevision(context);
  const scopeIndexRevision = await semanticScopeIndexSnapshotRevision(context, exactScopeDigest);
  return sha256HexOfCanonicalJson(toJsonValue({ graphRevision, scopeIndexRevision }));
}

function publicSemanticPageRevision(
  kind: SemanticQueryKind,
  scopeIndexSnapshotRevision: string,
  items: readonly InsightDerivationView[] | readonly DetectorExecutionView[],
): string {
  return sha256HexOfCanonicalJson(toJsonValue({ kind, scopeIndexSnapshotRevision, items }));
}

async function loadStableInsightPage(
  context: EngineContext,
  query: ParsedInsightDerivationQuery,
  cursor: string | undefined,
): Promise<{
  readonly page: SemanticScopeIndexPage;
  readonly items: readonly InsightDerivationView[];
  readonly revision: string;
}> {
  const exactScopeDigest = scopeDigest(query.scope);
  for (let attempt = 0; attempt < MAX_STABLE_READ_ATTEMPTS; attempt += 1) {
    const before = await semanticQuerySnapshotRevision(context, exactScopeDigest);
    const page = await loadSemanticScopeIndexPage(context, SEMANTIC_INSIGHT_SCOPE_INDEX_KIND, exactScopeDigest, {
      ...(cursor === undefined ? {} : { cursor }),
      limit: query.limit,
    });
    const items: InsightDerivationView[] = [];
    for (const entry of page.entries) {
      const view = await loadInsightDerivationView(context, entry.targetId, query.scope);
      if (view === undefined) {
        throw invalid("store.corrupt", "indexed insight derivation is missing or belongs to another scope", [
          "derivationId",
        ]);
      }
      if (view.derivation.derivationDigest !== entry.targetDigest) {
        throw invalid("store.corrupt", "indexed insight derivation digest does not match its target", ["derivationId"]);
      }
      if (!insightRecordMatches(view.derivation, query)) continue;
      if (insightViewMatches(view, query)) items.push(view);
    }
    const after = await semanticQuerySnapshotRevision(context, exactScopeDigest);
    if (before === after) {
      return {
        page,
        items,
        revision: publicSemanticPageRevision("insight-derivation", page.snapshotRevision, items),
      };
    }
  }
  throw invalid("query.snapshot_changed", "semantic graph changed while assembling the query page; retry", [
    "snapshotRevision",
  ]);
}

async function loadStableExecutionPage(
  context: EngineContext,
  query: ParsedDetectorExecutionQuery,
  cursor: string | undefined,
): Promise<{
  readonly page: SemanticScopeIndexPage;
  readonly items: readonly DetectorExecutionView[];
  readonly revision: string;
}> {
  const exactScopeDigest = scopeDigest(query.scope);
  for (let attempt = 0; attempt < MAX_STABLE_READ_ATTEMPTS; attempt += 1) {
    const before = await semanticQuerySnapshotRevision(context, exactScopeDigest);
    const page = await loadSemanticScopeIndexPage(context, SEMANTIC_EXECUTION_SCOPE_INDEX_KIND, exactScopeDigest, {
      ...(cursor === undefined ? {} : { cursor }),
      limit: query.limit,
    });
    const items: DetectorExecutionView[] = [];
    for (const entry of page.entries) {
      const view = await loadDetectorExecutionView(context, entry.targetId, query.scope);
      if (view === undefined) {
        const target = await loadDetectorExecutionRecord(context, entry.targetId);
        if (target !== undefined) {
          throw invalid("store.corrupt", "indexed detector execution belongs to another scope", ["executionId"]);
        }
        continue;
      }
      if (view.execution.executionDigest !== entry.targetDigest) {
        throw invalid("store.corrupt", "indexed detector execution digest does not match its target", ["executionId"]);
      }
      if (!executionRecordMatches(view.execution, query)) continue;
      if (executionViewMatches(view, query)) items.push(view);
    }
    const after = await semanticQuerySnapshotRevision(context, exactScopeDigest);
    if (before === after) {
      return {
        page,
        items,
        revision: publicSemanticPageRevision("detector-execution", page.snapshotRevision, items),
      };
    }
  }
  throw invalid("query.snapshot_changed", "semantic graph changed while assembling the query page; retry", [
    "snapshotRevision",
  ]);
}

export async function* runInsightDerivationQuery(
  context: EngineContext,
  input: InsightDerivationQuery,
): AsyncIterable<QueryPage<InsightDerivationView>> {
  const query = parseInsightDerivationQuery(context, input);
  const filterDigest = queryFilterDigest(query);
  let cursor = decodeCursor(
    query.cursor,
    "insight-derivation",
    filterDigest,
    context.registryRevision,
    context.queryCursorScopeDigest,
  );
  const seenCursors = new Set<string>();
  if (cursor !== undefined) seenCursors.add(cursor);
  for (;;) {
    const loaded = await loadStableInsightPage(context, query, cursor);
    const nextStoreCursor = loaded.page.nextCursor;
    if (nextStoreCursor !== undefined && seenCursors.has(nextStoreCursor)) {
      throw invalid("store.corrupt", "store listing for insight derivations cycled its cursor", ["nextCursor"]);
    }
    const nextCursor = nextQueryCursor(
      nextStoreCursor,
      "insight-derivation",
      filterDigest,
      context.registryRevision,
      context.queryCursorScopeDigest,
    );
    yield {
      items: loaded.items,
      ...(nextCursor === undefined ? {} : { nextCursor }),
      snapshotRevision: loaded.revision,
    };
    if (nextStoreCursor === undefined) return;
    seenCursors.add(nextStoreCursor);
    cursor = nextStoreCursor;
  }
}

export async function* runDetectorExecutionQuery(
  context: EngineContext,
  input: DetectorExecutionQuery,
): AsyncIterable<QueryPage<DetectorExecutionView>> {
  const query = parseDetectorExecutionQuery(context, input);
  const filterDigest = queryFilterDigest(query);
  let cursor = decodeCursor(
    query.cursor,
    "detector-execution",
    filterDigest,
    context.registryRevision,
    context.queryCursorScopeDigest,
  );
  const seenCursors = new Set<string>();
  if (cursor !== undefined) seenCursors.add(cursor);
  for (;;) {
    const loaded = await loadStableExecutionPage(context, query, cursor);
    const nextStoreCursor = loaded.page.nextCursor;
    if (nextStoreCursor !== undefined && seenCursors.has(nextStoreCursor)) {
      throw invalid("store.corrupt", "store listing for detector executions cycled its cursor", ["nextCursor"]);
    }
    const nextCursor = nextQueryCursor(
      nextStoreCursor,
      "detector-execution",
      filterDigest,
      context.registryRevision,
      context.queryCursorScopeDigest,
    );
    yield {
      items: loaded.items,
      ...(nextCursor === undefined ? {} : { nextCursor }),
      snapshotRevision: loaded.revision,
    };
    if (nextStoreCursor === undefined) return;
    seenCursors.add(nextStoreCursor);
    cursor = nextStoreCursor;
  }
}

function parseGetInput(
  context: EngineContext,
  input: unknown,
  idField: "derivationId" | "executionId",
): { readonly id: string; readonly scope: Scope } {
  assertAllowedFields(input, [idField, "scope"], [idField]);
  const fields = readFields(input, [idField]);
  return {
    id: fields.req(idField, parseDurableId),
    scope: fields.req("scope", (value, path) => parseScope(context, value, path)),
  };
}

async function loadStableView<T>(context: EngineContext, exactScopeDigest: string, load: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < MAX_STABLE_READ_ATTEMPTS; attempt += 1) {
    const before = await semanticQuerySnapshotRevision(context, exactScopeDigest);
    const view = await load();
    const after = await semanticQuerySnapshotRevision(context, exactScopeDigest);
    if (before === after) return view;
  }
  throw invalid("query.snapshot_changed", "semantic graph changed while assembling the requested view; retry", [
    "snapshotRevision",
  ]);
}

export async function runGetInsightDerivation(
  context: EngineContext,
  input: { readonly derivationId: string; readonly scope: Scope },
): Promise<InsightDerivationView | undefined> {
  const parsed = parseGetInput(context, input, "derivationId");
  const exactScopeDigest = scopeDigest(parsed.scope);
  return loadStableView(context, exactScopeDigest, async () => {
    const index = await loadInsightDerivationScopeIndex(context, parsed.id, exactScopeDigest);
    if (index === undefined) return undefined;
    const view = await loadInsightDerivationView(context, parsed.id, parsed.scope);
    if (view === undefined || view.derivation.derivationDigest !== index.targetDigest) {
      throw invalid("store.corrupt", "indexed insight derivation target is missing or mismatched", ["derivationId"]);
    }
    return view;
  });
}

export async function runGetDetectorExecution(
  context: EngineContext,
  input: { readonly executionId: string; readonly scope: Scope },
): Promise<DetectorExecutionView | undefined> {
  const parsed = parseGetInput(context, input, "executionId");
  const exactScopeDigest = scopeDigest(parsed.scope);
  return loadStableView(context, exactScopeDigest, async () => {
    const index = await loadDetectorExecutionScopeIndex(context, parsed.id, exactScopeDigest);
    if (index === undefined) return undefined;
    const view = await loadDetectorExecutionView(context, parsed.id, parsed.scope);
    if (view === undefined) {
      const target = await loadDetectorExecutionRecord(context, parsed.id);
      if (target !== undefined) {
        throw invalid("store.corrupt", "indexed detector execution belongs to another scope", ["executionId"]);
      }
      return undefined;
    }
    if (view.execution.executionDigest !== index.targetDigest) {
      throw invalid("store.corrupt", "indexed detector execution target digest is mismatched", ["executionId"]);
    }
    return view;
  });
}
