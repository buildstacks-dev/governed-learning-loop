// Exact-scope audit reads for durable detector-pack run receipts.
import { Buffer } from "node:buffer";
import { canonicalJsonText, sha256HexOfCanonicalJson } from "../canonical/canonical-json.js";
import type { JsonValue } from "../canonical/json.js";
import { toJsonValue } from "../canonical/to-json-value.js";
import { LearningLoopError } from "../diagnostics.js";
import type { Diagnostic } from "../diagnostics.js";
import { invalid, parseFiniteNumber, parseNonEmptyText, parseOneOf, readFields } from "../parse/toolkit.js";
import type { Parse } from "../parse/toolkit.js";
import type { DetectorPackRunReceipt } from "../records/detector-pack-run-receipt.js";
import { parseEpisodeRecord } from "../records/episode.js";
import type { Scope } from "../records/scope.js";
import {
  detectorRefKey,
  canonicalKey,
  lensRefKey,
  packRefKey,
  parseDigestAt,
  parseDurableId,
  parseId,
  parseSemVer,
  scopeDigest,
} from "../records/semantic-shared.js";
import type { EngineContext } from "./context.js";
import { loadStoredRecord, recordDigest } from "./context.js";
import {
  detectorPackRunScopeIndexRevision,
  loadDetectorPackRunReceipt,
  loadDetectorPackRunScopeIndex,
  loadDetectorPackRunScopeIndexPage,
} from "./detector-pack-receipt.js";
import type { EvidenceHealthView } from "./evidence-binding.js";
import {
  loadExecutionRecurrenceBinding,
  recurrenceForExecution,
  recurrenceReceiptLineage,
} from "./detector-recurrence.js";
import { loadEpisodeIdentityState } from "./episode-identity.js";
import { loadLatestEpisodeOutcomeClaim } from "./episode-outcome.js";
import type { QueryPage } from "./query.js";
import { loadDetectorExecutionRecord, loadRegistrySnapshot } from "./semantic-graph.js";
import { loadDetectorExecutionView } from "./semantic-views.js";
import {
  assessRecurrenceGroupGovernance,
  createRecurrenceGovernanceReadCache,
  embeddedAssessedGovernanceIsExact,
} from "./recurrence-governance.js";
import type { RecurrenceGovernanceReadCache } from "./recurrence-governance.js";

const MAX_QUERY_LIMIT = 500;
const MAX_FILTER_VALUES = 1_000;
const MAX_CURSOR_LENGTH = 16_384;
const MAX_STABLE_ATTEMPTS = 3;
const MAX_QUERY_PAGE_BYTES = 64 * 1_048_576;
const EXECUTION_DISPOSITIONS = ["executed", "not_applicable", "incomplete", "capped", "refused"] as const;
const GROUP_DISPOSITIONS = ["unassessed", "available", "deduplicated", "suppressed", "capped"] as const;
const RECURRENCE_STATUSES = ["absent", "grouped"] as const;
const GOVERNANCE_STATUSES = ["not_assessed", "assessed"] as const;
const RECEIPT_STATUSES = ["completed", "partial"] as const;
const REGISTRY_STATUSES = ["configured", "historical_unconfigured"] as const;
const COMMIT_STATUSES = ["committed", "invalid"] as const;
const REFUSED_REASON_CODES = new Set([
  "detector.callback_failed",
  "detector.implementation_invalid",
  "detector.result_invalid",
  "detector.limit_exceeded",
  "detector.snapshot_changed",
  "detector.pack_commit_failed",
  "store.conflict",
  "store.unavailable",
  "semantic.execution_conflict",
]);
const PREFLIGHT_REASON_CODES = new Set([
  "detector.scope.not_applicable",
  "detector.lens.not_applicable",
  "detector.lens.generator_not_applicable",
  "detector.population.empty",
  "detector.population.missing",
  "detector.population.unresolved",
  "detector.source.profile_missing",
  "detector.episode_class.not_applicable",
  "detector.episode.evidence_floor",
  "detector.episode.detector_floor",
  "detector.capability.missing",
  "detector.vocabulary.mismatch",
  "detector.evidence.unresolved",
  "detector.evidence.invalid",
  "detector.evidence.incomplete",
  "detector.evidence.detector_floor",
  "detector.evidence.lens_floor",
  "detector.evidence_blocked",
  "detector.evidence_limited",
]);

type RegistryStatus = (typeof REGISTRY_STATUSES)[number];
type CommitStatus = (typeof COMMIT_STATUSES)[number];
type GroupedReceiptRecurrence = Extract<
  DetectorPackRunReceipt["items"][number]["recurrence"],
  { readonly status: "grouped" }
>;
type GroupGovernance = GroupedReceiptRecurrence["governance"];
type RecurrenceLineage = Awaited<ReturnType<typeof recurrenceReceiptLineage>>;

interface GovernanceReadState {
  readonly workBudget: { claimRefs: number };
  readonly cache: RecurrenceGovernanceReadCache;
  readonly assessments: Map<string, Promise<GroupGovernance>>;
}

function createGovernanceReadState(): GovernanceReadState {
  return {
    workBudget: { claimRefs: 0 },
    cache: createRecurrenceGovernanceReadCache(),
    assessments: new Map(),
  };
}

export interface DetectorPackRunQuery {
  readonly scope: Scope;
  readonly receiptIds?: readonly string[];
  readonly packIds?: readonly string[];
  readonly packVersions?: readonly string[];
  readonly packManifestDigests?: readonly string[];
  readonly policyDigests?: readonly string[];
  readonly detectorIds?: readonly string[];
  readonly detectorRegistrationDigests?: readonly string[];
  readonly lensRegistrationDigests?: readonly string[];
  readonly executionDispositions?: readonly (typeof EXECUTION_DISPOSITIONS)[number][];
  readonly groupDispositions?: readonly (typeof GROUP_DISPOSITIONS)[number][];
  readonly recurrenceStatuses?: readonly ("absent" | "grouped")[];
  readonly governanceStatuses?: readonly ("not_assessed" | "assessed")[];
  readonly statuses?: readonly (typeof RECEIPT_STATUSES)[number][];
  readonly registryStatuses?: readonly RegistryStatus[];
  readonly commitStatuses?: readonly CommitStatus[];
  readonly cursor?: string;
  readonly limit: number;
}

export interface DetectorPackRunView {
  readonly receipt: DetectorPackRunReceipt;
  readonly registryBinding:
    | { readonly status: "configured" }
    | { readonly status: "historical_unconfigured"; readonly diagnostics: readonly Diagnostic[] };
  readonly policyBinding:
    | { readonly status: "configured" }
    | { readonly status: "historical_unconfigured"; readonly diagnostics: readonly Diagnostic[] };
  readonly commitBinding:
    | { readonly status: "committed" }
    | { readonly status: "invalid"; readonly diagnostics: readonly Diagnostic[] };
  readonly childBindings: readonly {
    readonly executionId: string;
    readonly status: "committed" | "invalid";
    readonly diagnostics: readonly Diagnostic[];
  }[];
  readonly governanceBinding:
    | { readonly status: "not_assessed" }
    | { readonly status: "current" }
    | { readonly status: "historical"; readonly diagnostics: readonly Diagnostic[] }
    | { readonly status: "invalid"; readonly diagnostics: readonly Diagnostic[] };
  readonly evidenceHealth: EvidenceHealthView;
}

interface ParsedQuery extends DetectorPackRunQuery {
  readonly scope: Scope;
  readonly limit: number;
}

interface CursorPayload {
  readonly version: 1;
  readonly kind: "detector-pack-run";
  readonly storeCursor: string;
  readonly filterDigest: string;
  readonly registryRevision: string;
  readonly cursorScopeDigest: string;
}

function diagnostic(code: string, severity: Diagnostic["severity"], message: string): Diagnostic {
  return { code, severity, message };
}

function isPlainRecord(input: unknown): input is Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return false;
  const prototype = Object.getPrototypeOf(input);
  return prototype === Object.prototype || prototype === null;
}

function assertAllowedFields(input: unknown, allowed: readonly string[]): void {
  if (!isPlainRecord(input)) return;
  const exact = new Set(allowed);
  for (const key of Object.keys(input)) {
    if (!exact.has(key)) throw invalid("query.invalid", "pack-run query contains an unknown field", ["query"]);
  }
}

const parseLimit: Parse<number> = (input, path) => {
  const value = parseFiniteNumber(input, path);
  if (!Number.isInteger(value) || value < 1 || value > MAX_QUERY_LIMIT) {
    throw invalid("query.invalid", "pack-run query limit must be from 1 through 500", path);
  }
  return value;
};

function optionalSorted<T extends string>(
  fields: ReturnType<typeof readFields>,
  key: string,
  parse: Parse<T>,
): readonly T[] | undefined {
  const values = fields.opt(key, (input, path) => {
    if (!Array.isArray(input)) throw invalid("query.invalid", "pack-run query filter must be an array", path);
    if (input.length > MAX_FILTER_VALUES) throw invalid("query.invalid", "pack-run query filter is too large", path);
    return input.map((value: unknown, index: number) => parse(value, [...path, index]));
  });
  return values === undefined ? undefined : [...new Set(values)].sort((left, right) => (left < right ? -1 : 1));
}

function parseQuery(context: EngineContext, input: unknown): ParsedQuery {
  assertAllowedFields(input, [
    "scope",
    "receiptIds",
    "packIds",
    "packVersions",
    "packManifestDigests",
    "policyDigests",
    "detectorIds",
    "detectorRegistrationDigests",
    "lensRegistrationDigests",
    "executionDispositions",
    "groupDispositions",
    "recurrenceStatuses",
    "governanceStatuses",
    "statuses",
    "registryStatuses",
    "commitStatuses",
    "cursor",
    "limit",
  ]);
  const fields = readFields(input, ["query"]);
  const cursor = fields.opt("cursor", (value, path) => {
    const parsed = parseNonEmptyText(value, path);
    if (parsed.length > MAX_CURSOR_LENGTH) throw invalid("query.invalid", "pack-run cursor is too long", path);
    return parsed;
  });
  const validatedScope = context.scopePolicy.validate(fields.req("scope", (value) => value));
  const scope = Object.freeze(validatedScope.map((segment) => Object.freeze({ type: segment.type, id: segment.id })));
  const receiptIds = optionalSorted(fields, "receiptIds", parseDurableId);
  const packIds = optionalSorted(fields, "packIds", parseId);
  const packVersions = optionalSorted(fields, "packVersions", parseSemVer);
  const packManifestDigests = optionalSorted(fields, "packManifestDigests", parseDigestAt);
  const policyDigests = optionalSorted(fields, "policyDigests", parseDigestAt);
  const detectorIds = optionalSorted(fields, "detectorIds", parseId);
  const detectorRegistrationDigests = optionalSorted(fields, "detectorRegistrationDigests", parseDigestAt);
  const lensRegistrationDigests = optionalSorted(fields, "lensRegistrationDigests", parseDigestAt);
  const executionDispositions = optionalSorted(fields, "executionDispositions", parseOneOf(EXECUTION_DISPOSITIONS));
  const groupDispositions = optionalSorted(fields, "groupDispositions", parseOneOf(GROUP_DISPOSITIONS));
  const recurrenceStatuses = optionalSorted(fields, "recurrenceStatuses", parseOneOf(RECURRENCE_STATUSES));
  const governanceStatuses = optionalSorted(fields, "governanceStatuses", parseOneOf(GOVERNANCE_STATUSES));
  const statuses = optionalSorted(fields, "statuses", parseOneOf(RECEIPT_STATUSES));
  const registryStatuses = optionalSorted(fields, "registryStatuses", parseOneOf(REGISTRY_STATUSES));
  const commitStatuses = optionalSorted(fields, "commitStatuses", parseOneOf(COMMIT_STATUSES));
  return {
    scope,
    ...(receiptIds === undefined ? {} : { receiptIds }),
    ...(packIds === undefined ? {} : { packIds }),
    ...(packVersions === undefined ? {} : { packVersions }),
    ...(packManifestDigests === undefined ? {} : { packManifestDigests }),
    ...(policyDigests === undefined ? {} : { policyDigests }),
    ...(detectorIds === undefined ? {} : { detectorIds }),
    ...(detectorRegistrationDigests === undefined ? {} : { detectorRegistrationDigests }),
    ...(lensRegistrationDigests === undefined ? {} : { lensRegistrationDigests }),
    ...(executionDispositions === undefined ? {} : { executionDispositions }),
    ...(groupDispositions === undefined ? {} : { groupDispositions }),
    ...(recurrenceStatuses === undefined ? {} : { recurrenceStatuses }),
    ...(governanceStatuses === undefined ? {} : { governanceStatuses }),
    ...(statuses === undefined ? {} : { statuses }),
    ...(registryStatuses === undefined ? {} : { registryStatuses }),
    ...(commitStatuses === undefined ? {} : { commitStatuses }),
    ...(cursor === undefined ? {} : { cursor }),
    limit: fields.req("limit", parseLimit),
  };
}

function isJsonRecord(value: JsonValue): value is { readonly [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function filterDigest(query: ParsedQuery): string {
  const value = toJsonValue(query);
  if (!isJsonRecord(value)) return sha256HexOfCanonicalJson(value);
  const filtered: { [key: string]: JsonValue } = {};
  for (const [key, field] of Object.entries(value)) {
    if (key !== "cursor" && key !== "limit") filtered[key] = field;
  }
  return sha256HexOfCanonicalJson(filtered);
}

function parseCursor(input: unknown): CursorPayload {
  const fields = readFields(input, ["cursor"]);
  const parseVersion: Parse<1> = (value, path) => {
    if (value !== 1) throw invalid("query.cursor_invalid", "unsupported pack-run cursor version", path);
    return 1;
  };
  return {
    version: fields.req("version", parseVersion),
    kind: fields.req("kind", parseOneOf(["detector-pack-run"])),
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
  exactFilterDigest: string,
  registryRevision: string,
  cursorScopeDigest: string,
): string | undefined {
  if (cursor === undefined) return undefined;
  const bytes = Buffer.from(cursor, "base64url");
  if (bytes.length === 0 || bytes.toString("base64url") !== cursor) {
    throw invalid("query.cursor_invalid", "pack-run cursor is not canonical base64url", ["cursor"]);
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw invalid("query.cursor_invalid", "pack-run cursor does not contain JSON", ["cursor"]);
  }
  const payload = parseCursor(decoded);
  if (
    payload.filterDigest !== exactFilterDigest ||
    payload.registryRevision !== registryRevision ||
    payload.cursorScopeDigest !== cursorScopeDigest
  ) {
    throw invalid("query.cursor_mismatch", "pack-run cursor belongs to another query", ["cursor"]);
  }
  return payload.storeCursor;
}

function includes<T extends string>(values: readonly T[] | undefined, value: T): boolean {
  return values === undefined || values.includes(value);
}

function receiptMatches(receipt: DetectorPackRunReceipt, query: ParsedQuery): boolean {
  return (
    includes(query.receiptIds, receipt.id) &&
    includes(query.packIds, receipt.pack.id) &&
    includes(query.packVersions, receipt.pack.version) &&
    includes(query.packManifestDigests, receipt.pack.manifestDigest) &&
    includes(query.policyDigests, receipt.policy.policyDigest) &&
    includes(query.statuses, receipt.status) &&
    (query.detectorIds === undefined || receipt.items.some((item) => query.detectorIds?.includes(item.detector.id))) &&
    (query.detectorRegistrationDigests === undefined ||
      receipt.items.some((item) => query.detectorRegistrationDigests?.includes(item.detector.registrationDigest))) &&
    (query.lensRegistrationDigests === undefined ||
      receipt.items.some(
        (item) => item.lens !== null && query.lensRegistrationDigests?.includes(item.lens.registrationDigest),
      )) &&
    (query.executionDispositions === undefined ||
      receipt.items.some((item) => query.executionDispositions?.includes(item.executionDisposition))) &&
    (query.groupDispositions === undefined ||
      receipt.items.some(
        (item) =>
          item.recurrence.status === "grouped" &&
          query.groupDispositions?.includes(item.recurrence.governance.groupDisposition),
      )) &&
    (query.recurrenceStatuses === undefined ||
      receipt.items.some((item) => query.recurrenceStatuses?.includes(item.recurrence.status))) &&
    (query.governanceStatuses === undefined ||
      receipt.items.some(
        (item) =>
          item.recurrence.status === "grouped" && query.governanceStatuses?.includes(item.recurrence.governance.status),
      ))
  );
}

function mergeHealth(left: EvidenceHealthView, right: EvidenceHealthView): EvidenceHealthView {
  const rank = { ready: 0, legacy_unbound: 1, incomplete: 2, invalid: 3 };
  return {
    status: rank[left.status] >= rank[right.status] ? left.status : right.status,
    diagnostics: [...left.diagnostics, ...right.diagnostics],
  };
}

function chargeEmbeddedGovernanceWork(receipt: DetectorPackRunReceipt, state: GovernanceReadState): void {
  for (const item of receipt.items) {
    if (item.recurrence.status !== "grouped" || item.recurrence.governance.status !== "assessed") continue;
    state.workBudget.claimRefs += item.recurrence.governance.candidateBindings.length;
    if (state.workBudget.claimRefs > 50_000) {
      throw invalid("query.incomplete", "pack-run governance view exceeds its exact work ceiling", []);
    }
  }
}

async function currentGovernanceBinding(
  context: EngineContext,
  receipt: DetectorPackRunReceipt,
  groupCache: Map<string, RecurrenceLineage>,
  state: GovernanceReadState,
  registryConfigured: boolean,
  policyConfigured: boolean,
): Promise<DetectorPackRunView["governanceBinding"]> {
  chargeEmbeddedGovernanceWork(receipt, state);
  let assessableGroups = 0;
  let hasUnassessedGroup = false;
  let hasHistoricalGroup = false;
  const invalidDiagnostics: Diagnostic[] = [];
  for (const item of receipt.items) {
    if (item.outputKind !== "insight_derivation" || item.recurrence.status !== "grouped") continue;
    const embedded = item.recurrence.governance;
    const legacyAssessedCap = embedded.status === "assessed" && embedded.groupDisposition === "capped";
    if (embedded.groupDisposition === "capped" && !legacyAssessedCap) continue;
    if (legacyAssessedCap) {
      hasHistoricalGroup = true;
      continue;
    }
    if (!legacyAssessedCap) assessableGroups += 1;
    if (embedded.status !== "assessed") {
      hasUnassessedGroup = true;
      continue;
    }
    const lineage = groupCache.get(item.recurrence.groupKeyDigest);
    if (lineage === undefined) {
      invalidDiagnostics.push(
        diagnostic("detector.pack_governance_invalid", "error", "assessed governance has no exact recurrence lineage"),
      );
      continue;
    }
    let embeddedExact: boolean;
    try {
      embeddedExact = await embeddedAssessedGovernanceIsExact(context, {
        groupKeyDigest: item.recurrence.groupKeyDigest,
        governance: embedded,
        workBudget: state.workBudget,
        groupLineage: lineage,
        cache: state.cache,
      });
    } catch (error) {
      if (error instanceof LearningLoopError && error.code === "detector.limit_exceeded") {
        throw invalid("query.incomplete", "pack-run governance view exceeds its exact work ceiling", []);
      }
      throw error;
    }
    if (!embeddedExact) {
      invalidDiagnostics.push(
        diagnostic(
          "detector.pack_governance_invalid",
          "error",
          "assessed governance contains a missing or mismatched exact binding",
        ),
      );
      continue;
    }
    if (
      lineage.executionCount !== item.recurrence.executionCount ||
      recordDigest(toJsonValue(lineage.episodeIdentityDigests)) !==
        recordDigest(toJsonValue(item.recurrence.episodeIdentityDigests))
    ) {
      hasHistoricalGroup = true;
      continue;
    }
    if (!registryConfigured || !policyConfigured) {
      hasHistoricalGroup = true;
      continue;
    }
    const cacheKey = `${item.recurrence.groupKeyDigest}\u0000${receipt.policy.policyDigest}`;
    let pending = state.assessments.get(cacheKey);
    if (pending === undefined) {
      pending = assessRecurrenceGroupGovernance(context, {
        groupKeyDigest: item.recurrence.groupKeyDigest,
        currentDistinctEpisodeCount: lineage.episodeIdentityDigests.length,
        capped: false,
        policy: receipt.policy,
        workBudget: state.workBudget,
        groupLineage: lineage,
        cache: state.cache,
      });
      state.assessments.set(cacheKey, pending);
    }
    let current: GroupGovernance;
    try {
      current = await pending;
    } catch (error) {
      if (error instanceof LearningLoopError && error.code === "detector.limit_exceeded") {
        throw invalid("query.incomplete", "pack-run governance view exceeds its exact work ceiling", []);
      }
      throw error;
    }
    if (recordDigest(toJsonValue(current)) !== recordDigest(toJsonValue(embedded))) {
      hasHistoricalGroup = true;
    }
  }
  if (invalidDiagnostics.length > 0) return { status: "invalid", diagnostics: invalidDiagnostics };
  if (hasUnassessedGroup) return { status: "not_assessed" };
  if (hasHistoricalGroup) {
    return {
      status: "historical",
      diagnostics: [
        diagnostic(
          "detector.pack_governance_historical",
          "warning",
          "assessed governance differs from the exact current frontier",
        ),
      ],
    };
  }
  if (assessableGroups === 0) return { status: "not_assessed" };
  return { status: "current" };
}

export async function loadDetectorPackRunView(
  context: EngineContext,
  receipt: DetectorPackRunReceipt,
  groupCache: Map<string, RecurrenceLineage> = new Map(),
  governanceState: GovernanceReadState = createGovernanceReadState(),
): Promise<DetectorPackRunView> {
  const invalidDiagnostics: Diagnostic[] = [];
  for (const bound of receipt.population.resolvedEpisodes) {
    const stored = await loadStoredRecord(context, "episode", bound.episodeRecordId);
    const identity = await loadEpisodeIdentityState(context, bound.episodeRecordId);
    if (stored === undefined || identity.status !== "resolved") {
      invalidDiagnostics.push(
        diagnostic("detector.pack_population_invalid", "error", "pack receipt population is missing or mismatched"),
      );
      continue;
    }
    const episode = parseEpisodeRecord(stored.value);
    if (episode.id !== bound.episodeRecordId || scopeDigest(episode.scope) !== receipt.scopeDigest) {
      throw invalid("store.corrupt", "pack receipt population resolves a foreign scope", []);
    }
    const outcome = await loadLatestEpisodeOutcomeClaim(context, bound.episodeRecordId);
    if (
      stored.digest !== bound.episodeRecordDigest ||
      recordDigest(toJsonValue(identity.identity)) !== bound.episodeIdentityDigest ||
      (bound.outcomeClaimDigest !== null && !outcome.historyDigests.includes(bound.outcomeClaimDigest))
    ) {
      invalidDiagnostics.push(
        diagnostic("detector.pack_population_invalid", "error", "pack receipt population lineage is mismatched"),
      );
    }
  }
  const registrySnapshot = await loadRegistrySnapshot(context, receipt.loopRegistryRevision);
  if (
    registrySnapshot === undefined ||
    registrySnapshot.semanticRegistry.registryDigest !== receipt.semanticRegistryDigest
  ) {
    invalidDiagnostics.push(
      diagnostic("detector.pack_registry_invalid", "error", "pack receipt has no exact semantic registry snapshot"),
    );
  } else {
    const semanticRegistry = registrySnapshot.semanticRegistry;
    const pack = semanticRegistry.packs.find(
      (candidate) =>
        packRefKey(candidate) === packRefKey(receipt.pack) &&
        semanticRegistry.selectedPackRefs.some((reference) => packRefKey(reference) === packRefKey(receipt.pack)),
    );
    if (pack === undefined || semanticRegistry.scopePolicyDigest !== receipt.scopePolicyDigest) {
      invalidDiagnostics.push(
        diagnostic("detector.pack_registry_invalid", "error", "pack receipt pack is absent from its registry snapshot"),
      );
    } else {
      const selectedDetectorKeys = new Set(semanticRegistry.selectedDetectorRefs.map(detectorRefKey));
      const selectedLensKeys = new Set(semanticRegistry.selectedLensRefs.map(lensRefKey));
      const expectedPairs: Array<{ readonly key: string; readonly runnable: boolean }> = [];
      for (const detectorReference of pack.detectors) {
        if (!selectedDetectorKeys.has(detectorRefKey(detectorReference))) continue;
        const detector = semanticRegistry.detectors.find(
          (candidate) => detectorRefKey(candidate) === detectorRefKey(detectorReference),
        );
        if (detector === undefined) continue;
        if (detector.outputKind === "evidence_health") {
          expectedPairs.push({ key: canonicalKey([detectorRefKey(detectorReference), ""]), runnable: true });
          continue;
        }
        const allowed =
          detector.lensConstraint.mode !== "required" || detector.lensConstraint.selection === "any_registered"
            ? undefined
            : new Set(detector.lensConstraint.registrations.map(lensRefKey));
        const lenses = pack.lenses.filter(
          (reference) =>
            selectedLensKeys.has(lensRefKey(reference)) &&
            (allowed === undefined || allowed.has(lensRefKey(reference))),
        );
        if (lenses.length === 0) {
          expectedPairs.push({ key: canonicalKey([detectorRefKey(detectorReference), ""]), runnable: false });
        } else {
          for (const lens of lenses) {
            expectedPairs.push({
              key: canonicalKey([detectorRefKey(detectorReference), lensRefKey(lens)]),
              runnable: true,
            });
          }
        }
      }
      expectedPairs.sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
      const actualPairs = receipt.items.map((item) =>
        canonicalKey([detectorRefKey(item.detector), item.lens === null ? "" : lensRefKey(item.lens)]),
      );
      if (
        recordDigest(toJsonValue(expectedPairs.map((entry) => entry.key))) !== recordDigest(toJsonValue(actualPairs))
      ) {
        invalidDiagnostics.push(
          diagnostic("detector.pack_registry_invalid", "error", "pack receipt fan-out differs from its registry"),
        );
      }
      let admitted = 0;
      let aggregateCapped = false;
      for (const [index, item] of receipt.items.entries()) {
        const expected = expectedPairs[index];
        if (expected === undefined) break;
        if (!expected.runnable) {
          if (
            item.executionDisposition !== "not_applicable" ||
            item.reasonCodes.length !== 1 ||
            item.reasonCodes[0] !== "detector.pack_lens_unavailable"
          ) {
            invalidDiagnostics.push(
              diagnostic("detector.pack_registry_invalid", "error", "pack receipt unavailable lens item is invalid"),
            );
          }
          continue;
        }
        const invocationCapped = item.reasonCodes.includes("detector.pack_invocation_capped");
        const itemAggregateCapped = item.reasonCodes.includes("detector.pack_aggregate_capped");
        const mustBeInvocationCapped = admitted >= receipt.policy.caps.maximumInvocationsPerRun;
        if (
          (aggregateCapped && !itemAggregateCapped) ||
          (!aggregateCapped && mustBeInvocationCapped && !invocationCapped) ||
          (!mustBeInvocationCapped && invocationCapped)
        ) {
          invalidDiagnostics.push(
            diagnostic("detector.pack_registry_invalid", "error", "pack receipt invocation-cap order is invalid"),
          );
        }
        if (!aggregateCapped && !mustBeInvocationCapped) {
          admitted += 1;
          if (itemAggregateCapped) aggregateCapped = true;
        }
      }
      for (const item of receipt.items) {
        const itemLens = item.lens;
        const detector = semanticRegistry.detectors.find(
          (candidate) => detectorRefKey(candidate) === detectorRefKey(item.detector),
        );
        const lens =
          itemLens === null
            ? undefined
            : semanticRegistry.lenses.find((candidate) => lensRefKey(candidate) === lensRefKey(itemLens));
        if (
          detector === undefined ||
          detector.configurationDigest !== item.detector.configurationDigest ||
          detector.implementationDigest !== item.detector.implementationDigest ||
          detector.outputKind !== item.outputKind ||
          detector.scopePolicyDigest !== receipt.scopePolicyDigest ||
          !pack.detectors.some((reference) => detectorRefKey(reference) === detectorRefKey(item.detector)) ||
          !semanticRegistry.selectedDetectorRefs.some(
            (reference) => detectorRefKey(reference) === detectorRefKey(item.detector),
          ) ||
          (itemLens !== null &&
            (lens === undefined ||
              lens.scopePolicyDigest !== receipt.scopePolicyDigest ||
              !pack.lenses.some((reference) => lensRefKey(reference) === lensRefKey(itemLens)) ||
              !semanticRegistry.selectedLensRefs.some((reference) => lensRefKey(reference) === lensRefKey(itemLens))))
        ) {
          invalidDiagnostics.push(
            diagnostic(
              "detector.pack_registry_invalid",
              "error",
              "pack receipt item is foreign to its registry snapshot",
            ),
          );
        }
      }
    }
  }
  const registryBinding =
    receipt.loopRegistryRevision === context.registryRevision &&
    context.semanticRegistry?.registryDigest === receipt.semanticRegistryDigest
      ? { status: "configured" as const }
      : {
          status: "historical_unconfigured" as const,
          diagnostics: [
            diagnostic("detector.pack_registry_historical", "warning", "pack receipt belongs to another registry"),
          ],
        };
  const policyBinding =
    context.detectorOrchestrationPolicy?.policyDigest === receipt.policy.policyDigest
      ? { status: "configured" as const }
      : {
          status: "historical_unconfigured" as const,
          diagnostics: [
            diagnostic("detector.pack_policy_historical", "warning", "pack receipt uses another orchestration policy"),
          ],
        };
  const childBindings: DetectorPackRunView["childBindings"][number][] = [];
  const receiptEpisodes = new Map(
    receipt.population.resolvedEpisodes.map((episode) => [episode.episodeRecordId, episode]),
  );
  let evidenceHealth: EvidenceHealthView = { status: "ready", diagnostics: [] };
  for (const item of receipt.items) {
    const reference = item.executionRef;
    if (reference === null) {
      const validReasons =
        (item.executionDisposition === "capped" &&
          item.reasonCodes.length === 1 &&
          (item.reasonCodes[0] === "detector.pack_invocation_capped" ||
            item.reasonCodes[0] === "detector.pack_aggregate_capped")) ||
        (item.executionDisposition === "not_applicable" &&
          item.reasonCodes.length === 1 &&
          item.reasonCodes[0] === "detector.pack_lens_unavailable") ||
        ((item.executionDisposition === "not_applicable" || item.executionDisposition === "incomplete") &&
          item.reasonCodes.length > 0 &&
          item.reasonCodes.every((code) => PREFLIGHT_REASON_CODES.has(code))) ||
        (item.executionDisposition === "refused" &&
          item.reasonCodes.length > 0 &&
          item.reasonCodes.every((code) => REFUSED_REASON_CODES.has(code)));
      if (!validReasons) {
        invalidDiagnostics.push(
          diagnostic("detector.pack_reason_invalid", "error", "pack receipt no-result reason codes are invalid"),
        );
      }
      continue;
    }
    const execution = await loadDetectorExecutionRecord(context, reference.id);
    const childDiagnostics: Diagnostic[] = [];
    if (
      execution === undefined ||
      execution.executionKeyDigest !== reference.executionKeyDigest ||
      execution.executionDigest !== reference.executionDigest
    ) {
      childDiagnostics.push(
        diagnostic("detector.pack_child_invalid", "error", "pack receipt child execution is missing or mismatched"),
      );
    } else {
      const actualDisposition = execution.result.status === "applied" ? "executed" : execution.result.status;
      const exactReasonCodes =
        execution.result.status === "not_applicable" || execution.result.status === "incomplete"
          ? execution.result.reasonCodes
          : item.recurrence.status === "grouped" && item.recurrence.governance.groupDisposition === "capped"
            ? ["detector.pack_group_capped"]
            : [];
      if (
        recordDigest(toJsonValue(execution.detector)) !== recordDigest(toJsonValue(item.detector)) ||
        recordDigest(toJsonValue(execution.pack)) !== recordDigest(toJsonValue(receipt.pack)) ||
        recordDigest(toJsonValue(execution.lens)) !== recordDigest(toJsonValue(item.lens)) ||
        execution.outputKind !== item.outputKind ||
        execution.loopRegistryRevision !== receipt.loopRegistryRevision ||
        execution.scopeDigest !== receipt.scopeDigest ||
        execution.scopePolicyDigest !== receipt.scopePolicyDigest ||
        recordDigest(toJsonValue(execution.scope)) !== recordDigest(toJsonValue(receipt.scope)) ||
        item.executionDisposition !== actualDisposition ||
        recordDigest(toJsonValue(item.reasonCodes)) !== recordDigest(toJsonValue(exactReasonCodes))
      ) {
        childDiagnostics.push(
          diagnostic("detector.pack_child_invalid", "error", "pack receipt child provenance is mismatched"),
        );
      }
      if (
        execution.window.population.episodes.length !== receiptEpisodes.size ||
        execution.window.population.episodes.some((episode) => {
          const expected = receiptEpisodes.get(episode.episodeRecordId);
          const projected = {
            episodeRecordId: episode.episodeRecordId,
            episodeRecordDigest: episode.episodeRecordDigest,
            episodeIdentityDigest: episode.episodeIdentityDigest,
            outcomeClaimDigest: episode.outcomeClaimDigest,
            episodeViewDigest: episode.episodeViewDigest,
            scopeDigest: episode.scopeDigest,
          };
          return expected === undefined || recordDigest(toJsonValue(expected)) !== recordDigest(toJsonValue(projected));
        })
      ) {
        childDiagnostics.push(
          diagnostic("detector.pack_population_invalid", "error", "pack receipt child population is mismatched"),
        );
      }
      const childView = await loadDetectorExecutionView(context, execution.id, receipt.scope);
      if (childView === undefined || childView.commitBinding.status !== "committed") {
        childDiagnostics.push(
          diagnostic("detector.pack_child_invalid", "error", "pack receipt child execution is not committed"),
        );
      } else {
        evidenceHealth = mergeHealth(evidenceHealth, childView.evidenceHealth);
      }
      const binding = await loadExecutionRecurrenceBinding(context, execution.id);
      if (item.recurrence.status === "grouped") {
        try {
          let group = groupCache.get(item.recurrence.groupKeyDigest);
          if (group === undefined) {
            group = await recurrenceReceiptLineage(context, execution);
            groupCache.set(item.recurrence.groupKeyDigest, group);
          }
          if (
            binding === undefined ||
            binding.bindingDigest !== item.recurrence.decisionBindingDigest ||
            binding.groupKeyDigest !== item.recurrence.groupKeyDigest ||
            recordDigest(toJsonValue(binding.locator)) !== recordDigest(toJsonValue(item.recurrence.locator)) ||
            !group.executionIds.includes(execution.id) ||
            group.executionIds.length < item.recurrence.executionCount ||
            item.recurrence.episodeIdentityDigests.some((digest) => !group.episodeIdentityDigests.includes(digest))
          ) {
            childDiagnostics.push(
              diagnostic("detector.pack_recurrence_invalid", "error", "pack receipt recurrence lineage is mismatched"),
            );
          }
        } catch (error) {
          if (error instanceof LearningLoopError && error.code === "store.corrupt") throw error;
          childDiagnostics.push(
            diagnostic("detector.pack_recurrence_invalid", "error", "pack receipt recurrence lineage is unreadable"),
          );
        }
      } else {
        try {
          const current = await recurrenceForExecution(context, execution, undefined);
          const statusMatches =
            (item.recurrence.reason === "execution_not_applied" && current.status === "execution_not_applied") ||
            (item.recurrence.reason === "condition_not_detected" && current.status === "condition_not_detected") ||
            (item.recurrence.reason === "locator_unavailable" && current.status === "locator_unavailable");
          if (
            !statusMatches ||
            (item.recurrence.decisionBindingDigest !== null &&
              binding?.bindingDigest !== item.recurrence.decisionBindingDigest) ||
            (item.recurrence.decisionBindingDigest === null && binding !== undefined)
          ) {
            childDiagnostics.push(
              diagnostic("detector.pack_recurrence_invalid", "error", "pack receipt recurrence decision is mismatched"),
            );
          }
        } catch (error) {
          if (error instanceof LearningLoopError && error.code === "store.corrupt") throw error;
          childDiagnostics.push(
            diagnostic("detector.pack_recurrence_invalid", "error", "pack receipt recurrence decision is unreadable"),
          );
        }
      }
    }
    if (childDiagnostics.length > 0) invalidDiagnostics.push(...childDiagnostics);
    childBindings.push({
      executionId: reference.id,
      status: childDiagnostics.length === 0 ? "committed" : "invalid",
      diagnostics: childDiagnostics,
    });
  }
  let governanceBinding = await currentGovernanceBinding(
    context,
    receipt,
    groupCache,
    governanceState,
    registryBinding.status === "configured",
    policyBinding.status === "configured",
  );
  if (invalidDiagnostics.length > 0 && governanceBinding.status !== "invalid") {
    governanceBinding = {
      status: "invalid",
      diagnostics: [
        diagnostic("detector.pack_governance_invalid", "error", "governance depends on an invalid pack receipt graph"),
      ],
    };
  }
  return {
    receipt,
    registryBinding,
    policyBinding,
    commitBinding:
      invalidDiagnostics.length === 0
        ? { status: "committed" }
        : { status: "invalid", diagnostics: invalidDiagnostics },
    childBindings,
    governanceBinding,
    evidenceHealth:
      invalidDiagnostics.length === 0
        ? evidenceHealth
        : mergeHealth(evidenceHealth, { status: "invalid", diagnostics: invalidDiagnostics }),
  };
}

function viewMatches(view: DetectorPackRunView, query: ParsedQuery): boolean {
  return (
    receiptMatches(view.receipt, query) &&
    includes(query.registryStatuses, view.registryBinding.status) &&
    includes(query.commitStatuses, view.commitBinding.status)
  );
}

async function snapshotRevision(context: EngineContext, exactScopeDigest: string): Promise<string> {
  const indexRevision = await detectorPackRunScopeIndexRevision(context.store, exactScopeDigest);
  return sha256HexOfCanonicalJson(toJsonValue({ indexRevision }));
}

function publicPageRevision(indexRevision: string, items: readonly DetectorPackRunView[]): string {
  return sha256HexOfCanonicalJson(toJsonValue({ kind: "detector-pack-run", indexRevision, items }));
}

async function loadStablePage(
  context: EngineContext,
  query: ParsedQuery,
  cursor: string | undefined,
): Promise<{
  readonly items: readonly DetectorPackRunView[];
  readonly nextCursor?: string;
  readonly revision: string;
}> {
  const exactScopeDigest = scopeDigest(query.scope);
  for (let attempt = 0; attempt < MAX_STABLE_ATTEMPTS; attempt += 1) {
    const before = await snapshotRevision(context, exactScopeDigest);
    const page = await loadDetectorPackRunScopeIndexPage(context, exactScopeDigest, {
      ...(cursor === undefined ? {} : { cursor }),
      limit: query.limit,
    });
    const firstViews: DetectorPackRunView[] = [];
    const firstGroupCache = new Map<string, RecurrenceLineage>();
    const firstGovernanceState = createGovernanceReadState();
    let receiptBytes = 0;
    let receiptItems = 0;
    let childReferences = 0;
    let populationEpisodes = 0;
    const groupedKeys = new Set<string>();
    for (const entry of page.entries) {
      const receipt = await loadDetectorPackRunReceipt(context, entry.receiptId);
      if (receipt === undefined) continue;
      receiptBytes += Buffer.byteLength(canonicalJsonText(toJsonValue(receipt)), "utf8");
      receiptItems += receipt.items.length;
      childReferences += receipt.items.filter((item) => item.executionRef !== null).length;
      populationEpisodes += receipt.population.resolvedEpisodes.length;
      for (const item of receipt.items) {
        if (item.recurrence.status === "grouped") groupedKeys.add(item.recurrence.groupKeyDigest);
      }
      if (
        receiptBytes > MAX_QUERY_PAGE_BYTES ||
        receiptItems > 5_000 ||
        childReferences > 5_000 ||
        populationEpisodes > 5_000 ||
        groupedKeys.size > 100
      ) {
        throw invalid("query.incomplete", "detector pack-run query page exceeds its resource ceiling", []);
      }
      if (receipt.receiptDigest !== entry.receiptDigest || receipt.scopeDigest !== exactScopeDigest) {
        throw invalid("store.corrupt", "indexed detector pack-run receipt is mismatched", []);
      }
      const view = await loadDetectorPackRunView(context, receipt, firstGroupCache, firstGovernanceState);
      firstViews.push(view);
    }
    const after = await snapshotRevision(context, exactScopeDigest);
    if (before === after) {
      const items: DetectorPackRunView[] = [];
      const secondGroupCache = new Map<string, RecurrenceLineage>();
      const secondGovernanceState = createGovernanceReadState();
      let unstable = false;
      for (const firstView of firstViews) {
        const currentReceipt = await loadDetectorPackRunReceipt(context, firstView.receipt.id);
        if (currentReceipt === undefined || currentReceipt.receiptDigest !== firstView.receipt.receiptDigest) {
          unstable = true;
          break;
        }
        const currentView = await loadDetectorPackRunView(
          context,
          currentReceipt,
          secondGroupCache,
          secondGovernanceState,
        );
        if (recordDigest(toJsonValue(currentView)) !== recordDigest(toJsonValue(firstView))) {
          unstable = true;
          break;
        }
        if (viewMatches(currentView, query)) items.push(currentView);
      }
      if (unstable) continue;
      return {
        items,
        ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
        revision: publicPageRevision(page.snapshotRevision, items),
      };
    }
  }
  throw invalid("query.snapshot_changed", "pack-run graph changed while assembling a query page", []);
}

export async function* runDetectorPackRunQuery(
  context: EngineContext,
  input: DetectorPackRunQuery,
): AsyncIterable<QueryPage<DetectorPackRunView>> {
  const query = parseQuery(context, input);
  const exactFilterDigest = filterDigest(query);
  let cursor = decodeCursor(query.cursor, exactFilterDigest, context.registryRevision, context.queryCursorScopeDigest);
  const seen = new Set<string>();
  if (cursor !== undefined) seen.add(cursor);
  for (;;) {
    const loaded = await loadStablePage(context, query, cursor);
    if (loaded.nextCursor !== undefined && seen.has(loaded.nextCursor)) {
      throw invalid("store.corrupt", "pack-run index listing cycled its cursor", []);
    }
    const nextCursor =
      loaded.nextCursor === undefined
        ? undefined
        : encodeCursor({
            version: 1,
            kind: "detector-pack-run",
            storeCursor: loaded.nextCursor,
            filterDigest: exactFilterDigest,
            registryRevision: context.registryRevision,
            cursorScopeDigest: context.queryCursorScopeDigest,
          });
    yield {
      items: loaded.items,
      ...(nextCursor === undefined ? {} : { nextCursor }),
      snapshotRevision: loaded.revision,
    };
    if (loaded.nextCursor === undefined) return;
    seen.add(loaded.nextCursor);
    cursor = loaded.nextCursor;
  }
}

export async function runGetDetectorPackRun(
  context: EngineContext,
  input: { readonly packRunReceiptId: string; readonly scope: Scope },
): Promise<DetectorPackRunView | undefined> {
  assertAllowedFields(input, ["packRunReceiptId", "scope"]);
  const fields = readFields(input, ["packRunReceiptId"]);
  const receiptId = fields.req("packRunReceiptId", parseDurableId);
  const validatedScope = context.scopePolicy.validate(fields.req("scope", (value) => value));
  const scope = Object.freeze(validatedScope.map((segment) => Object.freeze({ type: segment.type, id: segment.id })));
  const exactScopeDigest = scopeDigest(scope);
  for (let attempt = 0; attempt < MAX_STABLE_ATTEMPTS; attempt += 1) {
    const before = await snapshotRevision(context, exactScopeDigest);
    const index = await loadDetectorPackRunScopeIndex(context, receiptId, exactScopeDigest);
    if (index === undefined) {
      const after = await snapshotRevision(context, exactScopeDigest);
      if (before === after) return undefined;
      continue;
    }
    const receipt = await loadDetectorPackRunReceipt(context, receiptId);
    if (receipt === undefined) {
      const after = await snapshotRevision(context, exactScopeDigest);
      if (before === after) return undefined;
      continue;
    }
    if (receipt.receiptDigest !== index.receiptDigest || receipt.scopeDigest !== exactScopeDigest) {
      throw invalid("store.corrupt", "indexed detector pack-run receipt target is mismatched", []);
    }
    const view = await loadDetectorPackRunView(context, receipt);
    const after = await snapshotRevision(context, exactScopeDigest);
    if (before !== after) continue;
    const currentReceipt = await loadDetectorPackRunReceipt(context, receiptId);
    if (currentReceipt === undefined || currentReceipt.receiptDigest !== receipt.receiptDigest) continue;
    const currentView = await loadDetectorPackRunView(context, currentReceipt);
    if (recordDigest(toJsonValue(currentView)) === recordDigest(toJsonValue(view))) return currentView;
  }
  throw invalid("query.snapshot_changed", "pack-run graph changed while assembling a view", []);
}
