// Public, read-only query surface. Queries stream bounded typed pages without
// exposing private store namespaces or record kinds. Their cursors bind the
// normalized filters and immutable loop registry, while snapshotRevision keeps
// the store's page-level (append-visible) semantics explicit.
import { Buffer } from "node:buffer";
import { canonicalJsonText, sha256HexOfCanonicalJson } from "../canonical/canonical-json.js";
import type { JsonValue } from "../canonical/json.js";
import { toJsonValue } from "../canonical/to-json-value.js";
import type { Diagnostic } from "../diagnostics.js";
import { invalid, parseFiniteNumber, parseNonEmptyText, parseOneOf, readFields } from "../parse/toolkit.js";
import type { Parse } from "../parse/toolkit.js";
import type { Candidate } from "../records/candidate.js";
import type { MeasurementEvidenceRefV2 } from "../records/evidence-ref.js";
import type { EpisodeOutcome, EpisodeRecord, MeasurementRecord } from "../records/episode.js";
import { parseEpisodeRecord, parseMeasurementRecord } from "../records/episode.js";
import type { Observation } from "../records/observation.js";
import { parseObservation } from "../records/observation.js";
import type { Completeness, TrustClass } from "../records/provenance.js";
import { COMPLETENESS_VALUES, TRUST_CLASSES } from "../records/provenance.js";
import type { Scope } from "../records/scope.js";
import type { EvidenceHealthFinding, ImportReceipt, SourcePageReceipt } from "../records/source-health.js";
import { parseEvidenceHealthFinding, parseImportReceipt, parseSourcePageReceipt } from "../records/source-health.js";
import type { EngineContext } from "./context.js";
import type { EvidenceHealthView } from "./evidence-binding.js";
import { resolveOutcomeMeasurementEvidence } from "./evidence-binding.js";
import {
  effectiveRisk,
  iterateRecordPages,
  loadCandidate,
  loadRecordValue,
  readRecordKindRevision,
} from "./context.js";
import { loadEpisodeIdentityState } from "./episode-identity.js";
import { loadLatestEpisodeOutcomeClaim } from "./episode-outcome.js";
import type { GovernanceView } from "./governance.js";
import type { LearningReportQuery } from "./report.js";
import { candidateGovernanceStateOf } from "./views.js";
import type { InsightDerivationView } from "./semantic-views.js";
import type { CandidateRecurrenceLineage } from "./recurrence-claims.js";

const MAX_QUERY_LIMIT = 500;
const MAX_FILTER_VALUES = 1_000;
// Durable evidence ids frame two independently bounded 1,000-character
// components plus a separator, so public exact-id filters need a wider bound.
const MAX_FILTER_TEXT_LENGTH = 4_096;
const MAX_CURSOR_LENGTH = 16_384;
const OUTCOME_STATUSES = ["succeeded", "failed", "cancelled", "unknown"] as const;
const SOURCE_PAGE_STATES = ["available", "missing", "unreadable", "unsupported", "corrupt"] as const;
const EVIDENCE_HEALTH_CODES = [
  "source.missing",
  "source.unreadable",
  "source.unsupported",
  "source.corrupt",
  "source.partial",
  "source.revision_changed",
  "source.record_rejected",
  "source.content_policy_refused",
  "source.adapter_diagnostic",
  "source.ownership_mismatch",
] as const;
const EVIDENCE_HEALTH_EFFECTS = ["limits_claims", "blocks_audit", "blocks_use"] as const;

export interface QueryPage<T> {
  readonly items: readonly T[];
  readonly nextCursor?: string;
  readonly snapshotRevision: string;
}

export interface ObservationQuery {
  readonly observationIds?: readonly string[];
  readonly sourceIds?: readonly string[];
  readonly episodeIds?: readonly string[];
  readonly kinds?: readonly string[];
  readonly trust?: readonly TrustClass[];
  readonly completeness?: readonly Completeness[];
  readonly since?: string;
  readonly until?: string;
  readonly cursor?: string;
  readonly limit: number;
}

export interface MeasurementQuery {
  readonly measurementIds?: readonly string[];
  readonly sourceIds?: readonly string[];
  readonly episodeIds?: readonly string[];
  readonly metricNames?: readonly string[];
  readonly trust?: readonly TrustClass[];
  readonly completeness?: readonly Completeness[];
  readonly since?: string;
  readonly until?: string;
  readonly cursor?: string;
  readonly limit: number;
}

export interface EpisodeQuery {
  readonly recordIds?: readonly string[];
  readonly sourceIds?: readonly string[];
  readonly episodeIds?: readonly string[];
  readonly parentEpisodeIds?: readonly string[];
  readonly episodeClasses?: readonly string[];
  readonly scope?: Scope;
  readonly statuses?: readonly EpisodeOutcome["status"][];
  readonly since?: string;
  readonly until?: string;
  readonly cursor?: string;
  readonly limit: number;
}

export interface SourcePageReceiptQuery {
  readonly receiptIds?: readonly string[];
  readonly sourceIds?: readonly string[];
  readonly sourceRefs?: readonly string[];
  readonly pageRefs?: readonly string[];
  readonly sourceRevisions?: readonly string[];
  readonly states?: readonly SourcePageReceipt["state"]["status"][];
  readonly cursor?: string;
  readonly limit: number;
}

export interface EvidenceHealthQuery {
  readonly findingIds?: readonly string[];
  readonly sourceIds?: readonly string[];
  readonly sourceRefs?: readonly string[];
  readonly pageRefs?: readonly string[];
  readonly codes?: readonly EvidenceHealthFinding["code"][];
  readonly effects?: readonly EvidenceHealthFinding["effect"][];
  readonly cursor?: string;
  readonly limit: number;
}

export interface EpisodeView {
  readonly episode: EpisodeRecord;
  readonly identity:
    | {
        readonly status: "resolved";
        readonly sourceId: string;
        readonly sourceRecordId: string;
        readonly episodeId: string;
        readonly parentEpisodeId?: string;
        readonly episodeClass?: string;
        readonly registryRevision: string;
        readonly trustCeiling: TrustClass;
        readonly completeness: Completeness;
      }
    | {
        readonly status: "unresolved";
        readonly diagnostics: readonly Diagnostic[];
      };
  readonly outcomeLineage:
    | { readonly status: "absent" }
    | { readonly status: "legacy_unbound"; readonly diagnostics: readonly Diagnostic[] }
    | {
        readonly status: "resolved";
        readonly claimDigest: string;
        readonly historyDigests: readonly string[];
        readonly measurementRefs: readonly MeasurementEvidenceRefV2[];
        readonly evidenceHealth: EvidenceHealthView;
      };
}

export interface CandidateView {
  readonly candidate: Candidate;
  readonly governance: GovernanceView;
  readonly evidenceHealth: EvidenceHealthView;
  readonly derivationLineage:
    | { readonly status: "not_bound" }
    | { readonly status: "resolved"; readonly derivation: InsightDerivationView }
    | {
        readonly status: "invalid";
        readonly diagnostics: readonly Diagnostic[];
        readonly derivation?: InsightDerivationView;
      };
  readonly recurrenceLineage: CandidateRecurrenceLineage;
  readonly admissionLineage:
    | {
        readonly status: "not_subject";
        readonly reason: "manual" | "recurrence_unbound" | "policy_unconfigured" | "historical_pre_admission";
      }
    | {
        readonly status: "resolved";
        readonly bindingDigest: string;
        readonly reservationKeyDigest: string;
        readonly reservationDigest: string;
        readonly snapshotDigest: string;
        readonly policyDigest: string;
        readonly basis: "group_available" | "required_supersession" | "rejection_override" | "historical_supersession";
      }
    | {
        readonly status: "historical";
        readonly bindingDigest: string;
        readonly reservationKeyDigest: string;
        readonly reservationDigest: string;
        readonly snapshotDigest: string;
        readonly policyDigest: string;
        readonly basis: "group_available" | "required_supersession" | "rejection_override" | "historical_supersession";
        readonly diagnostics: readonly Diagnostic[];
      }
    | { readonly status: "invalid"; readonly diagnostics: readonly Diagnostic[] };
}

interface ParsedPageQuery {
  readonly cursor?: string;
  readonly limit: number;
  readonly since?: string;
  readonly until?: string;
}

interface ParsedObservationQuery extends ParsedPageQuery {
  readonly observationIds?: readonly string[];
  readonly sourceIds?: readonly string[];
  readonly episodeIds?: readonly string[];
  readonly kinds?: readonly string[];
  readonly trust?: readonly TrustClass[];
  readonly completeness?: readonly Completeness[];
}

interface ParsedMeasurementQuery extends ParsedPageQuery {
  readonly measurementIds?: readonly string[];
  readonly sourceIds?: readonly string[];
  readonly episodeIds?: readonly string[];
  readonly metricNames?: readonly string[];
  readonly trust?: readonly TrustClass[];
  readonly completeness?: readonly Completeness[];
}

interface ParsedEpisodeQuery extends ParsedPageQuery {
  readonly recordIds?: readonly string[];
  readonly sourceIds?: readonly string[];
  readonly episodeIds?: readonly string[];
  readonly parentEpisodeIds?: readonly string[];
  readonly episodeClasses?: readonly string[];
  readonly scope?: Scope;
  readonly statuses?: readonly EpisodeOutcome["status"][];
}

interface ParsedSourcePageReceiptQuery {
  readonly receiptIds?: readonly string[];
  readonly sourceIds?: readonly string[];
  readonly sourceRefs?: readonly string[];
  readonly pageRefs?: readonly string[];
  readonly sourceRevisions?: readonly string[];
  readonly states?: readonly SourcePageReceipt["state"]["status"][];
  readonly cursor?: string;
  readonly limit: number;
}

interface ParsedEvidenceHealthQuery {
  readonly findingIds?: readonly string[];
  readonly sourceIds?: readonly string[];
  readonly sourceRefs?: readonly string[];
  readonly pageRefs?: readonly string[];
  readonly codes?: readonly EvidenceHealthFinding["code"][];
  readonly effects?: readonly EvidenceHealthFinding["effect"][];
  readonly cursor?: string;
  readonly limit: number;
}

type QueryKind = "observation" | "measurement" | "episode" | "source-page-receipt" | "evidence-health";

function sortedUnique<T extends string>(values: readonly T[]): readonly T[] {
  return [...new Set(values)].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

const parseLimit: Parse<number> = (input, path) => {
  const value = parseFiniteNumber(input, path);
  if (!Number.isInteger(value) || value < 1 || value > MAX_QUERY_LIMIT) {
    throw invalid("query.invalid", `limit must be an integer from 1 through ${MAX_QUERY_LIMIT}`, path);
  }
  return value;
};

const parseTimestamp: Parse<string> = (input, path) => {
  const value = parseNonEmptyText(input, path);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw invalid("query.invalid", "timestamp must be canonical RFC 3339 UTC with milliseconds", path);
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

const parseFilterText: Parse<string> = (input, path) => {
  const value = parseNonEmptyText(input, path);
  if (value.length > MAX_FILTER_TEXT_LENGTH) {
    throw invalid("query.invalid", `filter value exceeds ${MAX_FILTER_TEXT_LENGTH} characters`, path);
  }
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) {
      throw invalid("query.invalid", "filter value contains a control character", path);
    }
  }
  return value;
};

function parseBoundedArrayOf<T>(element: Parse<T>): Parse<readonly T[]> {
  return (input, path) => {
    if (!Array.isArray(input)) throw invalid("query.invalid", "query filter must be an array", path);
    if (input.length > MAX_FILTER_VALUES) {
      throw invalid("query.invalid", `query filter exceeds ${MAX_FILTER_VALUES} values`, path);
    }
    return input.map((value: unknown, index: number) => element(value, [...path, index]));
  };
}

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

function commonQueryFields(input: unknown): {
  readonly fields: ReturnType<typeof readFields>;
  readonly parsed: ParsedPageQuery;
} {
  const fields = readFields(input, ["query"]);
  const cursor = fields.opt("cursor", parseCursorText);
  const since = fields.opt("since", parseTimestamp);
  const until = fields.opt("until", parseTimestamp);
  if (since !== undefined && until !== undefined && Date.parse(since) > Date.parse(until)) {
    throw invalid("query.invalid", "since must not be later than until", ["query"]);
  }
  return {
    fields,
    parsed: {
      ...(cursor !== undefined ? { cursor } : {}),
      limit: fields.req("limit", parseLimit),
      ...(since !== undefined ? { since } : {}),
      ...(until !== undefined ? { until } : {}),
    },
  };
}

function optionalStrings(fields: ReturnType<typeof readFields>, key: string): readonly string[] | undefined {
  const values = fields.opt(key, parseBoundedArrayOf(parseFilterText));
  return values === undefined ? undefined : sortedUnique(values);
}

function parseObservationQuery(input: unknown): ParsedObservationQuery {
  assertAllowedFields(
    input,
    [
      "observationIds",
      "sourceIds",
      "episodeIds",
      "kinds",
      "trust",
      "completeness",
      "since",
      "until",
      "cursor",
      "limit",
    ],
    ["query"],
  );
  const { fields, parsed } = commonQueryFields(input);
  const trust = fields.opt("trust", parseBoundedArrayOf(parseOneOf(TRUST_CLASSES)));
  const completeness = fields.opt("completeness", parseBoundedArrayOf(parseOneOf(COMPLETENESS_VALUES)));
  const observationIds = optionalStrings(fields, "observationIds");
  const sourceIds = optionalStrings(fields, "sourceIds");
  const episodeIds = optionalStrings(fields, "episodeIds");
  const kinds = optionalStrings(fields, "kinds");
  return {
    ...parsed,
    ...(observationIds !== undefined ? { observationIds } : {}),
    ...(sourceIds !== undefined ? { sourceIds } : {}),
    ...(episodeIds !== undefined ? { episodeIds } : {}),
    ...(kinds !== undefined ? { kinds } : {}),
    ...(trust !== undefined ? { trust: sortedUnique(trust) } : {}),
    ...(completeness !== undefined ? { completeness: sortedUnique(completeness) } : {}),
  };
}

function parseMeasurementQuery(input: unknown): ParsedMeasurementQuery {
  assertAllowedFields(
    input,
    [
      "measurementIds",
      "sourceIds",
      "episodeIds",
      "metricNames",
      "trust",
      "completeness",
      "since",
      "until",
      "cursor",
      "limit",
    ],
    ["query"],
  );
  const { fields, parsed } = commonQueryFields(input);
  const trust = fields.opt("trust", parseBoundedArrayOf(parseOneOf(TRUST_CLASSES)));
  const completeness = fields.opt("completeness", parseBoundedArrayOf(parseOneOf(COMPLETENESS_VALUES)));
  const measurementIds = optionalStrings(fields, "measurementIds");
  const sourceIds = optionalStrings(fields, "sourceIds");
  const episodeIds = optionalStrings(fields, "episodeIds");
  const metricNames = optionalStrings(fields, "metricNames");
  return {
    ...parsed,
    ...(measurementIds !== undefined ? { measurementIds } : {}),
    ...(sourceIds !== undefined ? { sourceIds } : {}),
    ...(episodeIds !== undefined ? { episodeIds } : {}),
    ...(metricNames !== undefined ? { metricNames } : {}),
    ...(trust !== undefined ? { trust: sortedUnique(trust) } : {}),
    ...(completeness !== undefined ? { completeness: sortedUnique(completeness) } : {}),
  };
}

function parseEpisodeQuery(context: EngineContext, input: unknown): ParsedEpisodeQuery {
  assertAllowedFields(
    input,
    [
      "recordIds",
      "sourceIds",
      "episodeIds",
      "parentEpisodeIds",
      "episodeClasses",
      "scope",
      "statuses",
      "since",
      "until",
      "cursor",
      "limit",
    ],
    ["query"],
  );
  const { fields, parsed } = commonQueryFields(input);
  const recordIds = optionalStrings(fields, "recordIds");
  const sourceIds = optionalStrings(fields, "sourceIds");
  const episodeIds = optionalStrings(fields, "episodeIds");
  const parentEpisodeIds = optionalStrings(fields, "parentEpisodeIds");
  const episodeClasses = optionalStrings(fields, "episodeClasses");
  const scope = fields.opt("scope", (value, path) => {
    if (Array.isArray(value) && value.length > MAX_FILTER_VALUES) {
      throw invalid("query.invalid", `scope exceeds ${MAX_FILTER_VALUES} segments`, path);
    }
    return context.scopePolicy.validate(value);
  });
  const statuses = fields.opt("statuses", parseBoundedArrayOf(parseOneOf(OUTCOME_STATUSES)));
  return {
    ...parsed,
    ...(recordIds !== undefined ? { recordIds } : {}),
    ...(sourceIds !== undefined ? { sourceIds } : {}),
    ...(episodeIds !== undefined ? { episodeIds } : {}),
    ...(parentEpisodeIds !== undefined ? { parentEpisodeIds } : {}),
    ...(episodeClasses !== undefined ? { episodeClasses } : {}),
    ...(scope !== undefined ? { scope } : {}),
    ...(statuses !== undefined ? { statuses: sortedUnique(statuses) } : {}),
  };
}

function parseSourcePageReceiptQuery(input: unknown): ParsedSourcePageReceiptQuery {
  assertAllowedFields(
    input,
    ["receiptIds", "sourceIds", "sourceRefs", "pageRefs", "sourceRevisions", "states", "cursor", "limit"],
    ["query"],
  );
  const { fields, parsed } = commonQueryFields(input);
  const receiptIds = optionalStrings(fields, "receiptIds");
  const sourceIds = optionalStrings(fields, "sourceIds");
  const sourceRefs = optionalStrings(fields, "sourceRefs");
  const pageRefs = optionalStrings(fields, "pageRefs");
  const sourceRevisions = optionalStrings(fields, "sourceRevisions");
  const states = fields.opt("states", parseBoundedArrayOf(parseOneOf(SOURCE_PAGE_STATES)));
  return {
    ...parsed,
    ...(receiptIds !== undefined ? { receiptIds } : {}),
    ...(sourceIds !== undefined ? { sourceIds } : {}),
    ...(sourceRefs !== undefined ? { sourceRefs } : {}),
    ...(pageRefs !== undefined ? { pageRefs } : {}),
    ...(sourceRevisions !== undefined ? { sourceRevisions } : {}),
    ...(states !== undefined ? { states: sortedUnique(states) } : {}),
  };
}

function parseEvidenceHealthQuery(input: unknown): ParsedEvidenceHealthQuery {
  assertAllowedFields(
    input,
    ["findingIds", "sourceIds", "sourceRefs", "pageRefs", "codes", "effects", "cursor", "limit"],
    ["query"],
  );
  const { fields, parsed } = commonQueryFields(input);
  const findingIds = optionalStrings(fields, "findingIds");
  const sourceIds = optionalStrings(fields, "sourceIds");
  const sourceRefs = optionalStrings(fields, "sourceRefs");
  const pageRefs = optionalStrings(fields, "pageRefs");
  const codes = fields.opt("codes", parseBoundedArrayOf(parseOneOf(EVIDENCE_HEALTH_CODES)));
  const effects = fields.opt("effects", parseBoundedArrayOf(parseOneOf(EVIDENCE_HEALTH_EFFECTS)));
  return {
    ...parsed,
    ...(findingIds !== undefined ? { findingIds } : {}),
    ...(sourceIds !== undefined ? { sourceIds } : {}),
    ...(sourceRefs !== undefined ? { sourceRefs } : {}),
    ...(pageRefs !== undefined ? { pageRefs } : {}),
    ...(codes !== undefined ? { codes: sortedUnique(codes) } : {}),
    ...(effects !== undefined ? { effects: sortedUnique(effects) } : {}),
  };
}

export function parseLearningReportQuery(context: EngineContext, input: unknown): LearningReportQuery {
  assertAllowedFields(input, ["scope", "sourceIds", "episodeIds", "since", "until"], ["reportQuery"]);
  const fields = readFields(input, ["reportQuery"]);
  const sourceIds = optionalStrings(fields, "sourceIds");
  const episodeIds = optionalStrings(fields, "episodeIds");
  const since = fields.opt("since", parseTimestamp);
  const until = fields.opt("until", parseTimestamp);
  if (episodeIds !== undefined && sourceIds === undefined) {
    throw invalid("query.invalid", "sourceIds are required when filtering a report by logical episodeIds", [
      "reportQuery",
      "sourceIds",
    ]);
  }
  if (since !== undefined && until !== undefined && Date.parse(since) > Date.parse(until)) {
    throw invalid("query.invalid", "since must not be later than until", ["reportQuery"]);
  }
  const scope = fields.opt("scope", (value, path) => {
    if (Array.isArray(value) && value.length > MAX_FILTER_VALUES) {
      throw invalid("query.invalid", `scope exceeds ${MAX_FILTER_VALUES} segments`, path);
    }
    return context.scopePolicy.validate(value);
  });
  return {
    ...(scope !== undefined ? { scope } : {}),
    ...(sourceIds !== undefined ? { sourceIds } : {}),
    ...(episodeIds !== undefined ? { episodeIds } : {}),
    ...(since !== undefined ? { since } : {}),
    ...(until !== undefined ? { until } : {}),
  };
}

function isJsonRecord(value: JsonValue): value is { readonly [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function withoutPageState(query: ParsedPageQuery): JsonValue {
  const value = toJsonValue(query);
  if (!isJsonRecord(value)) return value;
  const filters: { [key: string]: JsonValue } = {};
  for (const [key, field] of Object.entries(value)) {
    if (key !== "cursor" && key !== "limit") filters[key] = field;
  }
  return filters;
}

function queryFilterDigest(query: ParsedPageQuery): string {
  return sha256HexOfCanonicalJson(toJsonValue(withoutPageState(query)));
}

interface CursorPayload {
  readonly version: 1;
  readonly kind: QueryKind;
  readonly storeCursor: string;
  readonly filterDigest: string;
  readonly registryRevision: string;
  readonly cursorScopeDigest: string;
}

const parseCursorVersion: Parse<1> = (input, path) => {
  if (input !== 1) throw invalid("query.cursor_invalid", "unsupported query cursor version", path);
  return 1;
};

function parseCursorPayload(input: unknown): CursorPayload {
  const fields = readFields(input, ["cursor"]);
  return {
    version: fields.req("version", parseCursorVersion),
    kind: fields.req(
      "kind",
      parseOneOf(["observation", "measurement", "episode", "source-page-receipt", "evidence-health"]),
    ),
    storeCursor: fields.req("storeCursor", parseNonEmptyText),
    filterDigest: fields.req("filterDigest", parseNonEmptyText),
    registryRevision: fields.req("registryRevision", parseNonEmptyText),
    cursorScopeDigest: fields.req("cursorScopeDigest", parseNonEmptyText),
  };
}

function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(canonicalJsonText(toJsonValue(payload)), "utf8").toString("base64url");
}

function decodeCursor(
  cursor: string | undefined,
  kind: QueryKind,
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
  kind: QueryKind,
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

function insideWindow(value: string | undefined, query: ParsedPageQuery): boolean {
  if (query.since === undefined && query.until === undefined) return true;
  if (value === undefined) return false;
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) {
    throw invalid("query.incomplete", "stored record has a noncanonical timestamp", ["timestamp"]);
  }
  if (query.since !== undefined && time < Date.parse(query.since)) return false;
  if (query.until !== undefined && time > Date.parse(query.until)) return false;
  return true;
}

function observationMatches(observation: Observation, query: ParsedObservationQuery): boolean {
  return (
    includesValue(query.observationIds, observation.id) &&
    includesValue(query.sourceIds, observation.provenance.sourceId) &&
    includesValue(query.episodeIds, observation.episodeId) &&
    includesValue(query.kinds, observation.kind) &&
    includesValue(query.trust, observation.provenance.trust) &&
    includesValue(query.completeness, observation.provenance.completeness) &&
    insideWindow(observation.occurredAt, query)
  );
}

function measurementMatches(measurement: MeasurementRecord, query: ParsedMeasurementQuery): boolean {
  return (
    includesValue(query.measurementIds, measurement.id) &&
    includesValue(query.sourceIds, measurement.provenance.sourceId) &&
    includesValue(query.episodeIds, measurement.episodeId) &&
    includesValue(query.metricNames, measurement.metric.name) &&
    includesValue(query.trust, measurement.provenance.trust) &&
    includesValue(query.completeness, measurement.provenance.completeness) &&
    insideWindow(measurement.measuredAt, query)
  );
}

export async function* runObservationQuery(
  context: EngineContext,
  input: ObservationQuery,
): AsyncIterable<QueryPage<Observation>> {
  const query = parseObservationQuery(input);
  const filterDigest = queryFilterDigest(query);
  const cursor = decodeCursor(
    query.cursor,
    "observation",
    filterDigest,
    context.registryRevision,
    context.queryCursorScopeDigest,
  );
  for await (const page of iterateRecordPages(context.store, "observation", {
    limit: query.limit,
    ...(cursor !== undefined ? { cursor } : {}),
  })) {
    const items = page.records
      .map((record) => {
        const observation = parseObservation(record.value);
        if (observation.id !== record.key.id) {
          throw invalid("store.corrupt", "stored observation id does not match its record key", ["id"]);
        }
        return observation;
      })
      .filter((item) => observationMatches(item, query));
    const nextCursor = nextQueryCursor(
      page.nextCursor,
      "observation",
      filterDigest,
      context.registryRevision,
      context.queryCursorScopeDigest,
    );
    yield {
      items,
      ...(nextCursor !== undefined ? { nextCursor } : {}),
      snapshotRevision: page.snapshotRevision,
    };
  }
}

export async function* runMeasurementQuery(
  context: EngineContext,
  input: MeasurementQuery,
): AsyncIterable<QueryPage<MeasurementRecord>> {
  const query = parseMeasurementQuery(input);
  const filterDigest = queryFilterDigest(query);
  const cursor = decodeCursor(
    query.cursor,
    "measurement",
    filterDigest,
    context.registryRevision,
    context.queryCursorScopeDigest,
  );
  for await (const page of iterateRecordPages(context.store, "measurement", {
    limit: query.limit,
    ...(cursor !== undefined ? { cursor } : {}),
  })) {
    const items = page.records
      .map((record) => {
        const measurement = parseMeasurementRecord(record.value);
        if (measurement.id !== record.key.id) {
          throw invalid("store.corrupt", "stored measurement id does not match its record key", ["id"]);
        }
        return measurement;
      })
      .filter((item) => measurementMatches(item, query));
    const nextCursor = nextQueryCursor(
      page.nextCursor,
      "measurement",
      filterDigest,
      context.registryRevision,
      context.queryCursorScopeDigest,
    );
    yield {
      items,
      ...(nextCursor !== undefined ? { nextCursor } : {}),
      snapshotRevision: page.snapshotRevision,
    };
  }
}

function scopesEqual(left: Scope, right: Scope): boolean {
  if (left.length !== right.length) return false;
  return left.every((segment, index) => {
    const other = right[index];
    return other !== undefined && segment.type === other.type && segment.id === other.id;
  });
}

function episodeRecordMatches(episode: EpisodeRecord, query: ParsedEpisodeQuery): boolean {
  return (
    includesValue(query.recordIds, episode.id) &&
    (query.scope === undefined || scopesEqual(query.scope, episode.scope)) &&
    insideWindow(episode.openedAt, query)
  );
}

function withoutEpisodeOutcome(episode: EpisodeRecord): EpisodeRecord {
  return {
    schemaVersion: 1,
    id: episode.id,
    scope: episode.scope,
    openedAt: episode.openedAt,
    ...(episode.closedAt !== undefined ? { closedAt: episode.closedAt } : {}),
    sourceRefs: episode.sourceRefs,
    ...(episode.fingerprintId !== undefined ? { fingerprintId: episode.fingerprintId } : {}),
    exposureIds: episode.exposureIds,
  };
}

interface OutcomeViewResult extends Pick<EpisodeView, "episode" | "outcomeLineage"> {
  readonly claimIdentity?: {
    readonly sourceId: string;
    readonly sourceRegistrationRevision: string;
    readonly episodeId: string;
  };
}

async function outcomeView(context: EngineContext, storedEpisode: EpisodeRecord): Promise<OutcomeViewResult> {
  const base = withoutEpisodeOutcome(storedEpisode);
  const state = await loadLatestEpisodeOutcomeClaim(context, storedEpisode.id);
  if (state.status === "missing") {
    if (storedEpisode.outcome === undefined) return { episode: base, outcomeLineage: { status: "absent" } };
    return {
      episode: base,
      outcomeLineage: {
        status: "legacy_unbound",
        diagnostics: [
          {
            code: "episode.outcome_legacy_unbound",
            severity: "error",
            message: "inline legacy episode outcome has no receipt-bound measurement lineage",
          },
        ],
      },
    };
  }

  let evidenceHealth: EvidenceHealthView;
  if (state.latest.measurementRefs.length === 0) {
    evidenceHealth = {
      status: "incomplete",
      diagnostics: [
        {
          code: "episode.outcome_measurement_missing",
          severity: "warning",
          message: "episode outcome has no measurement evidence and cannot support efficacy claims",
        },
      ],
    };
  } else {
    const resolved = await resolveOutcomeMeasurementEvidence(
      context,
      state.latest.measurementRefs.map((reference) => reference.recordId),
      base.scope,
    );
    const exact =
      resolved.refs.length === state.latest.measurementRefs.length &&
      resolved.refs.every(
        (reference, index) =>
          canonicalJsonText(toJsonValue(reference)) ===
          canonicalJsonText(toJsonValue(state.latest.measurementRefs[index])),
      );
    evidenceHealth = exact
      ? resolved.health
      : {
          status: "invalid",
          diagnostics: [
            ...resolved.health.diagnostics,
            {
              code: "episode.outcome_reference_mismatch",
              severity: "error",
              message: "latest episode outcome measurement lineage no longer matches durable evidence",
            },
          ],
        };
  }
  return {
    episode: {
      ...base,
      outcome: {
        status: state.latest.status,
        measurementIds: state.latest.measurementRefs.map((reference) => reference.recordId),
      },
    },
    outcomeLineage: {
      status: "resolved",
      claimDigest: state.latest.claimDigest,
      historyDigests: state.historyDigests,
      measurementRefs: state.latest.measurementRefs,
      evidenceHealth,
    },
    claimIdentity: {
      sourceId: state.latest.sourceId,
      sourceRegistrationRevision: state.latest.sourceRegistrationRevision,
      episodeId: state.latest.episodeId,
    },
  };
}

export async function* runEpisodeQuery(
  context: EngineContext,
  input: EpisodeQuery,
): AsyncIterable<QueryPage<EpisodeView>> {
  const query = parseEpisodeQuery(context, input);
  const filterDigest = queryFilterDigest(query);
  const cursor = decodeCursor(
    query.cursor,
    "episode",
    filterDigest,
    context.registryRevision,
    context.queryCursorScopeDigest,
  );
  for await (const page of iterateRecordPages(context.store, "episode", {
    limit: query.limit,
    ...(cursor !== undefined ? { cursor } : {}),
  })) {
    const items: EpisodeView[] = [];
    for (const record of page.records) {
      const storedEpisode = parseEpisodeRecord(record.value);
      if (storedEpisode.id !== record.key.id) {
        throw invalid("store.corrupt", "stored episode id does not match its record key", ["id"]);
      }
      if (!episodeRecordMatches(storedEpisode, query)) continue;
      const viewedOutcome = await outcomeView(context, storedEpisode);
      if (
        query.statuses !== undefined &&
        (viewedOutcome.episode.outcome === undefined || !query.statuses.includes(viewedOutcome.episode.outcome.status))
      ) {
        continue;
      }
      const identityState = await loadEpisodeIdentityState(context, storedEpisode.id);
      if (identityState.status !== "resolved") {
        if (
          query.sourceIds !== undefined ||
          query.episodeIds !== undefined ||
          query.parentEpisodeIds !== undefined ||
          query.episodeClasses !== undefined
        ) {
          throw invalid(
            "query.incomplete",
            "episode identity is missing, so identity-filtered results cannot be complete",
            ["episode", storedEpisode.id],
          );
        }
        const unresolvedOutcomeLineage: EpisodeView["outcomeLineage"] =
          viewedOutcome.outcomeLineage.status === "resolved"
            ? {
                ...viewedOutcome.outcomeLineage,
                evidenceHealth: {
                  status: "invalid",
                  diagnostics: [
                    ...viewedOutcome.outcomeLineage.evidenceHealth.diagnostics,
                    {
                      code: "episode.outcome_identity_unresolved",
                      severity: "error",
                      message: "episode outcome cannot be qualified without a resolved episode identity",
                    },
                  ],
                },
              }
            : viewedOutcome.outcomeLineage;
        items.push({
          episode: viewedOutcome.episode,
          identity: {
            status: "unresolved",
            diagnostics: [
              {
                code: identityState.status === "conflict" ? "episode.identity_conflict" : "episode.identity_unresolved",
                severity: "error",
                message:
                  identityState.status === "conflict"
                    ? "episode identity conflicts with a later projection and cannot be resolved"
                    : "episode identity is unavailable; explicitly re-ingest its source to repair the sidecar",
                details: { episodeRecordId: storedEpisode.id },
              },
            ],
          },
          outcomeLineage: unresolvedOutcomeLineage,
        });
        continue;
      }
      const identity = identityState.identity;
      if (!storedEpisode.sourceRefs.includes(identity.sourceId)) {
        throw invalid("schema.corrupt", "episode identity source is absent from EpisodeRecord.sourceRefs", [
          "episode",
          storedEpisode.id,
          "sourceRefs",
        ]);
      }
      if (
        !includesValue(query.sourceIds, identity.sourceId) ||
        !includesValue(query.episodeIds, identity.episodeId) ||
        (query.parentEpisodeIds !== undefined &&
          (identity.parentEpisodeId === undefined || !query.parentEpisodeIds.includes(identity.parentEpisodeId))) ||
        (query.episodeClasses !== undefined &&
          (identity.episodeClass === undefined || !query.episodeClasses.includes(identity.episodeClass)))
      ) {
        continue;
      }
      if (
        viewedOutcome.claimIdentity !== undefined &&
        (viewedOutcome.claimIdentity.sourceId !== identity.sourceId ||
          viewedOutcome.claimIdentity.sourceRegistrationRevision !== identity.registryRevision ||
          viewedOutcome.claimIdentity.episodeId !== identity.episodeId)
      ) {
        throw invalid("store.corrupt", "episode outcome claim does not match resolved episode identity", [
          "outcomeLineage",
        ]);
      }
      items.push({
        episode: viewedOutcome.episode,
        identity: {
          status: "resolved",
          sourceId: identity.sourceId,
          sourceRecordId: identity.sourceRecordId,
          episodeId: identity.episodeId,
          ...(identity.parentEpisodeId !== undefined ? { parentEpisodeId: identity.parentEpisodeId } : {}),
          ...(identity.episodeClass !== undefined ? { episodeClass: identity.episodeClass } : {}),
          registryRevision: identity.registryRevision,
          trustCeiling: identity.trustCeiling,
          completeness: identity.completeness,
        },
        outcomeLineage: viewedOutcome.outcomeLineage,
      });
    }
    const compositeRevision = await readRecordKindRevision(context.store, "episode");
    if (compositeRevision !== page.snapshotRevision) {
      throw invalid(
        "query.snapshot_changed",
        "store revision changed while assembling episode identity views; retry the page",
        ["snapshotRevision"],
      );
    }
    const nextCursor = nextQueryCursor(
      page.nextCursor,
      "episode",
      filterDigest,
      context.registryRevision,
      context.queryCursorScopeDigest,
    );
    yield {
      items,
      ...(nextCursor !== undefined ? { nextCursor } : {}),
      snapshotRevision: page.snapshotRevision,
    };
  }
}

function sourcePageReceiptMatches(receipt: SourcePageReceipt, query: ParsedSourcePageReceiptQuery): boolean {
  const revision = receipt.state.status === "available" ? receipt.state.sourceRevision : receipt.state.observedRevision;
  return (
    includesValue(query.receiptIds, receipt.id) &&
    includesValue(query.sourceIds, receipt.sourceId) &&
    includesValue(query.sourceRefs, receipt.sourceRef) &&
    includesValue(query.pageRefs, receipt.pageRef) &&
    (query.sourceRevisions === undefined || (revision !== undefined && query.sourceRevisions.includes(revision))) &&
    includesValue(query.states, receipt.state.status)
  );
}

export async function* runSourcePageReceiptQuery(
  context: EngineContext,
  input: SourcePageReceiptQuery,
): AsyncIterable<QueryPage<SourcePageReceipt>> {
  const query = parseSourcePageReceiptQuery(input);
  const filterDigest = queryFilterDigest(query);
  const cursor = decodeCursor(
    query.cursor,
    "source-page-receipt",
    filterDigest,
    context.registryRevision,
    context.queryCursorScopeDigest,
  );
  for await (const page of iterateRecordPages(context.store, "source-page-receipt", {
    limit: query.limit,
    ...(cursor !== undefined ? { cursor } : {}),
  })) {
    const items = page.records
      .map((record) => {
        const receipt = parseSourcePageReceipt(record.value);
        if (receipt.id !== record.key.id) {
          throw invalid("store.corrupt", "stored source page receipt id does not match its record key", ["id"]);
        }
        return receipt;
      })
      .filter((receipt) => sourcePageReceiptMatches(receipt, query));
    const nextCursor = nextQueryCursor(
      page.nextCursor,
      "source-page-receipt",
      filterDigest,
      context.registryRevision,
      context.queryCursorScopeDigest,
    );
    yield {
      items,
      ...(nextCursor !== undefined ? { nextCursor } : {}),
      snapshotRevision: page.snapshotRevision,
    };
  }
}

function evidenceHealthMatches(finding: EvidenceHealthFinding, query: ParsedEvidenceHealthQuery): boolean {
  return (
    includesValue(query.findingIds, finding.id) &&
    includesValue(query.sourceIds, finding.sourceId) &&
    includesValue(query.sourceRefs, finding.sourceRef) &&
    includesValue(query.pageRefs, finding.pageRef) &&
    includesValue(query.codes, finding.code) &&
    includesValue(query.effects, finding.effect)
  );
}

export async function* runEvidenceHealthQuery(
  context: EngineContext,
  input: EvidenceHealthQuery,
): AsyncIterable<QueryPage<EvidenceHealthFinding>> {
  const query = parseEvidenceHealthQuery(input);
  const filterDigest = queryFilterDigest(query);
  const cursor = decodeCursor(
    query.cursor,
    "evidence-health",
    filterDigest,
    context.registryRevision,
    context.queryCursorScopeDigest,
  );
  for await (const page of iterateRecordPages(context.store, "evidence-health", {
    limit: query.limit,
    ...(cursor !== undefined ? { cursor } : {}),
  })) {
    const items = page.records
      .map((record) => {
        const finding = parseEvidenceHealthFinding(record.value);
        if (finding.id !== record.key.id) {
          throw invalid("store.corrupt", "stored evidence health id does not match its record key", ["id"]);
        }
        return finding;
      })
      .filter((finding) => evidenceHealthMatches(finding, query));
    const nextCursor = nextQueryCursor(
      page.nextCursor,
      "evidence-health",
      filterDigest,
      context.registryRevision,
      context.queryCursorScopeDigest,
    );
    yield {
      items,
      ...(nextCursor !== undefined ? { nextCursor } : {}),
      snapshotRevision: page.snapshotRevision,
    };
  }
}

export async function runGetImportReceipt(
  context: EngineContext,
  input: { readonly importReceiptId: string },
): Promise<ImportReceipt | undefined> {
  assertAllowedFields(input, ["importReceiptId"], ["importReceipt"]);
  const fields = readFields(input, ["importReceipt"]);
  const id = fields.req("importReceiptId", parseFilterText);
  const value = await loadRecordValue(context, "import-receipt", id);
  if (value === undefined) return undefined;
  const receipt = parseImportReceipt(value);
  if (receipt.id !== id)
    throw invalid("store.corrupt", "stored import receipt id does not match its record key", ["id"]);
  return receipt;
}

export async function runGetCandidateView(
  context: EngineContext,
  input: { readonly candidateId: string },
): Promise<CandidateView | undefined> {
  assertAllowedFields(input, ["candidateId"], ["candidateView"]);
  const fields = readFields(input, ["candidateView"]);
  const candidateId = fields.req("candidateId", parseNonEmptyText);
  const candidate = await loadCandidate(context, candidateId);
  if (candidate === undefined) return undefined;
  const riskRule = context.policyRules.risks[effectiveRisk(candidate)];
  const state = await candidateGovernanceStateOf(context, candidate, riskRule.independentReview);
  return {
    candidate,
    governance: state.governance,
    evidenceHealth: state.evidenceHealth,
    derivationLineage: state.derivationLineage,
    recurrenceLineage: state.recurrenceLineage,
    admissionLineage: state.admissionLineage,
  };
}
