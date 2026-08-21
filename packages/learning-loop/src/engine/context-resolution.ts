// learning.resolveContext and learning.acknowledgeExposure (contract §The
// façade, §Intervention, exposure, and efficacy; decision 0027).
//
// Resolution reads only the Activate journal of decision 0026: the scope
// membership index of the exact scope and of every ancestor the configured
// scope policy permits, then the intervention fold, plan, candidate, and
// journaled receipts of each member. An entry resolves only when its
// intervention is a `publish` action at a `context` destination whose
// current state is published, authorized (or not required), and active —
// a candidate, a prepared plan, a pending or denied authorization, a
// proposal-class publication, a failed, disabled, or rolled-back
// intervention never resolves (kernel invariant 1). Two conditions refuse
// the whole resolution visibly instead of dropping an entry: the host
// destination registration no longer matches the one the plan bound
// (`resolution.destination_drift`), and an active intervention whose
// candidate has been superseded by the candidate of another active
// intervention in the same scope (`resolution.intervention_stale`). The
// budget is a precedence-ordered prefix: exact scope first, then ancestors
// by policy precedence, within a scope by journal birth; the first entry that
// does not fit closes the budget and every later intervention is listed as
// omitted. The receipt is content-addressed and create-only, so the same
// episode resolved against the same active set is one receipt.
//
// Exposure acknowledgement binds one exposure set to one receipt
// (`exposure-<receiptDigest>`): every applied entry must come from that
// receipt, every evidence id must be a durable observation of the same
// episode carrying `observed` or `verified` trust, and a second
// acknowledgement of the same receipt with different content is refused.
// The set is written after its per-episode index entry so a crash leaves at
// most an orphan index entry that readers ignore; a retry forward-completes.
// Experiment arms are refused until the Validate tier declares experiments.
import { canonicalJsonText, sha256HexOfCanonicalJson } from "../canonical/canonical-json.js";
import type { JsonValue } from "../canonical/json.js";
import { toJsonValue } from "../canonical/to-json-value.js";
import type { Diagnostic } from "../diagnostics.js";
import { LearningLoopError } from "../diagnostics.js";
import { invalid, parseJson, parseNonEmptyText, readFields } from "../parse/toolkit.js";
import type { Parse, ParsePath } from "../parse/toolkit.js";
import type { CandidateV2 } from "../records/candidate.js";
import type { ExposureSetRecord } from "../records/exposure.js";
import {
  MAX_EXPOSURE_REFERENCES,
  exposureSetDigest,
  exposureSetIdFor,
  parseExposureSetRecord,
  sameExposureContent,
} from "../records/exposure.js";
import type { InterventionState } from "../records/intervention.js";
import { parseObservation } from "../records/observation.js";
import type { ResolvedContext, ResolvedEntry } from "../records/resolution.js";
import {
  MAX_RESOLUTION_ENTRIES,
  MAX_RESOLUTION_QUERY_CHARACTERS,
  parseResolutionBudgetAt,
  parseResolvedContext,
  resolutionQueryDigest,
  resolvedContextDigest,
  resolvedContextIdFor,
  resolvedEntryIdFor,
} from "../records/resolution.js";
import type { Scope } from "../records/scope.js";
import { parseBoundedArray, parseDurableId, parseId, scopeDigest } from "../records/semantic-shared.js";
import type { EngineContext } from "./context.js";
import {
  createOnly,
  loadCandidate,
  loadRecordValue,
  loadStoredRecord,
  parseWriteResult,
  recordDigest,
  recordKey,
} from "./context.js";
import { listInterventionScopeMemberships, loadFoldReceipts } from "./publication-journal.js";
import type { BoundIntervention } from "./publication.js";
import { loadBoundIntervention } from "./publication.js";

export interface ResolveContextInput {
  readonly episodeId: string;
  readonly scope: Scope;
  readonly query: JsonValue;
  readonly budget: {
    readonly maximumEntries: number;
    readonly maximumCharacters: number;
  };
}

export interface ExposureInput {
  readonly resolutionReceiptId: string;
  readonly appliedEntryIds: readonly string[];
  readonly assignmentId: string;
  readonly experiment?: ExposureSetRecord["experiment"];
  readonly fingerprintId: string;
  readonly evidenceIds: readonly string[];
}

const RESOLUTION_KIND = "context-resolution";
const EXPOSURE_KIND = "exposure-set";
const EPISODE_EXPOSURE_KIND = "episode-exposure";
/** A scope policy returning more ancestors than this fails closed. */
const MAX_ANCESTORS = 100;
/** Exposure index entries per episode; the stream digest check enforces the same ceiling. */
export const MAX_EXPOSURES_PER_EPISODE = 1_000;
const MAX_APPEND_ATTEMPTS = 8;

function refusal(code: string, message: string, details?: JsonValue): LearningLoopError {
  return new LearningLoopError(code, [
    { code, severity: "error", message, ...(details !== undefined ? { details } : {}) },
  ]);
}

function corrupt(message: string, extra: readonly Diagnostic[] = []): LearningLoopError {
  return new LearningLoopError("store.corrupt", [{ code: "store.corrupt", severity: "error", message }, ...extra]);
}

function freezeDeep<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) freezeDeep(nested);
  }
  return value;
}

function assertUniqueIds(values: readonly string[], label: string, path: ParsePath): void {
  const seen = new Set<string>();
  for (const [index, value] of values.entries()) {
    if (seen.has(value)) throw invalid("schema.invalid", `${label} must be unique`, [...path, index]);
    seen.add(value);
  }
}

const parseUnknown: Parse<unknown> = (input) => input;

// ---------------------------------------------------------------------------
// Scope matching: exact scope first, then policy ancestors by precedence

interface MatchedScope {
  readonly scope: Scope;
  readonly digest: string;
}

function isolationText(scope: Scope, isolationSegmentTypes: readonly string[]): string {
  return canonicalJsonText(
    toJsonValue(
      scope
        .filter((segment) => isolationSegmentTypes.includes(segment.type))
        .map((segment) => [segment.type, segment.id]),
    ),
  );
}

function parsePrecedence(value: unknown, path: ParsePath): -1 | 0 | 1 {
  if (value === -1) return -1;
  if (value === 0) return 0;
  if (value === 1) return 1;
  throw invalid("config.invalid", "scope policy comparePrecedence must return -1, 0, or 1", path);
}

function matchedScopes(context: EngineContext, scope: Scope): readonly MatchedScope[] {
  const policy = context.scopePolicy;
  const exact: MatchedScope = { scope, digest: scopeDigest(scope) };
  const rawAncestors: unknown = policy.ancestors(scope);
  const path: ParsePath = ["scopePolicy", "ancestors"];
  if (!Array.isArray(rawAncestors)) throw invalid("config.invalid", "scope policy ancestors must be an array", path);
  if (rawAncestors.length > MAX_ANCESTORS) {
    throw refusal("resolution.limit_exceeded", `scope policy returned more than ${MAX_ANCESTORS} ancestors`);
  }
  const isolation = isolationText(scope, policy.isolationSegmentTypes);
  const seen = new Set<string>([exact.digest]);
  const ancestors: { readonly scope: Scope; readonly digest: string; readonly index: number }[] = [];
  for (const [index, raw] of rawAncestors.entries()) {
    const ancestor = policy.validate(raw);
    const digest = scopeDigest(ancestor);
    if (seen.has(digest)) {
      throw invalid("config.invalid", "scope policy returned the scope itself or a duplicate ancestor", [
        ...path,
        index,
      ]);
    }
    if (isolationText(ancestor, policy.isolationSegmentTypes) !== isolation) {
      throw invalid("config.invalid", "scope policy inferred an ancestor across an isolation boundary", [
        ...path,
        index,
      ]);
    }
    seen.add(digest);
    ancestors.push({ scope: ancestor, digest, index });
  }
  ancestors.sort((left, right) => {
    const precedence = parsePrecedence(policy.comparePrecedence(left.scope, right.scope), [
      "scopePolicy",
      "comparePrecedence",
    ]);
    return precedence === 0 ? left.index - right.index : -precedence;
  });
  return [exact, ...ancestors.map((ancestor) => ({ scope: ancestor.scope, digest: ancestor.digest }))];
}

// ---------------------------------------------------------------------------
// Active interventions

interface ActiveIntervention {
  readonly matched: MatchedScope;
  readonly bound: BoundIntervention;
  readonly candidate: CandidateV2;
  readonly content: JsonValue;
  readonly contentDigest: string;
  readonly characters: number;
}

/** Published, authorized (or not required), and active: the only state that resolves. */
function resolvesFrom(state: InterventionState): boolean {
  return (
    state.publication === "published" &&
    (state.authorization === "authorized" || state.authorization === "not_required") &&
    state.activation === "active"
  );
}

function assertDestinationCurrent(context: EngineContext, bound: BoundIntervention): void {
  const destinationId = bound.fold.header.destinationId;
  const destination = context.destinationsById?.get(destinationId);
  if (destination === undefined) {
    throw refusal(
      "resolution.destination_drift",
      `active intervention "${bound.record.id}" was published to destination "${destinationId}", which is not registered on this loop; restore the registration or reverse the intervention before resolving`,
      { interventionId: bound.record.id, destinationId },
    );
  }
  if (
    destination.registrationDigest !== bound.plan.lineage.destinationRegistrationDigest ||
    destination.effectClass !== bound.plan.effectClass
  ) {
    throw refusal(
      "resolution.destination_drift",
      `active intervention "${bound.record.id}" was published under a different registration of destination "${destinationId}"; restore that registration or reverse the intervention before resolving`,
      { interventionId: bound.record.id, destinationId },
    );
  }
}

async function collectActive(
  context: EngineContext,
  matched: readonly MatchedScope[],
): Promise<readonly ActiveIntervention[]> {
  const active: ActiveIntervention[] = [];
  const seen = new Set<string>();
  for (const scope of matched) {
    const group: ActiveIntervention[] = [];
    for (const membership of await listInterventionScopeMemberships(context, scope.digest)) {
      if (membership.action !== "publish" || seen.has(membership.interventionId)) continue;
      const bound = await loadBoundIntervention(context, membership.interventionId);
      if (bound === undefined) continue; // unborn header: an orphan remnant, not an intervention
      seen.add(membership.interventionId);
      const header = bound.fold.header;
      if (header.action !== "publish" || header.scopeDigest !== scope.digest) {
        throw corrupt(`intervention "${bound.record.id}" scope membership does not match its header`);
      }
      if (!resolvesFrom(bound.record.state)) continue;
      if (header.effectClass !== "context") continue;
      assertDestinationCurrent(context, bound);
      const candidate = await loadCandidate(context, header.candidateId);
      if (candidate === undefined || candidate.contentDigest !== header.candidateDigest) {
        throw corrupt(`intervention "${bound.record.id}" binds a missing or altered candidate`);
      }
      if (candidate.schemaVersion !== 2 || candidate.intervention.destinationId !== header.destinationId) {
        throw corrupt(`intervention "${bound.record.id}" binds a candidate that could not have been planned`);
      }
      await loadFoldReceipts(context, bound.record, bound.plan);
      const content = candidate.intervention.content;
      group.push({
        matched: scope,
        bound,
        candidate,
        content,
        contentDigest: sha256HexOfCanonicalJson(content),
        characters: canonicalJsonText(content).length,
      });
    }
    group.sort((left, right) => {
      const leftBirth = left.bound.fold.header.createdAt;
      const rightBirth = right.bound.fold.header.createdAt;
      if (leftBirth !== rightBirth) return leftBirth < rightBirth ? -1 : 1;
      return left.bound.record.id < right.bound.record.id ? -1 : left.bound.record.id > right.bound.record.id ? 1 : 0;
    });
    active.push(...group);
  }
  return active;
}

/**
 * A still-active intervention whose candidate was superseded by the candidate
 * of another active intervention in the same scope is a stale version. It is
 * never served and never silently dropped: the resolution refuses until the
 * host disables or rolls back the stale version through the journaled path.
 */
function assertNoStaleVersion(active: readonly ActiveIntervention[]): void {
  const byCandidate = new Map(active.map((entry) => [entry.candidate.id, entry]));
  for (const successor of active) {
    const supersedes = successor.candidate.supersedes;
    if (supersedes === undefined) continue;
    const predecessor = byCandidate.get(supersedes);
    if (
      predecessor === undefined ||
      predecessor.candidate.contentDigest !== successor.candidate.originalDigest ||
      predecessor.matched.digest !== successor.matched.digest
    ) {
      continue;
    }
    throw refusal(
      "resolution.intervention_stale",
      `intervention "${predecessor.bound.record.id}" is still active although its candidate "${predecessor.candidate.id}" was superseded by "${successor.candidate.id}", whose intervention "${successor.bound.record.id}" is active in the same scope; disable or roll back the stale version before resolving`,
      {
        staleInterventionId: predecessor.bound.record.id,
        successorInterventionId: successor.bound.record.id,
      },
    );
  }
}

// ---------------------------------------------------------------------------
// Receipt persistence

async function loadResolution(context: EngineContext, receiptId: string): Promise<ResolvedContext | undefined> {
  const stored = await loadStoredRecord(context, RESOLUTION_KIND, receiptId);
  if (stored === undefined) return undefined;
  const receipt = parseResolvedContext(stored.value);
  if (receipt.id !== receiptId) throw corrupt("stored resolution receipt id does not match its record key");
  return receipt;
}

async function persistResolution(context: EngineContext, receipt: ResolvedContext): Promise<ResolvedContext> {
  const status = await createOnly(context, RESOLUTION_KIND, receipt.id, receipt, `context-resolution/${receipt.id}`);
  if (status === "created" || status === "exists_same") return receipt;
  // A content-addressed id can only conflict on the unbound resolvedAt field;
  // the first persisted receipt is the canonical one.
  const stored = await loadResolution(context, receipt.id);
  if (stored === undefined) throw corrupt("resolution receipt conflicted but cannot be reloaded");
  if (stored.receiptDigest !== receipt.receiptDigest) {
    throw corrupt("stored resolution receipt does not match its content-addressed id");
  }
  return stored;
}

// ---------------------------------------------------------------------------
// resolveContext

export async function runResolveContext(context: EngineContext, input: ResolveContextInput): Promise<ResolvedContext> {
  const fields = readFields(input, ["resolveContext"]);
  const episodeId = fields.req("episodeId", parseDurableId);
  const scope = context.scopePolicy.validate(fields.req("scope", parseUnknown));
  const query = fields.req("query", parseJson);
  if (canonicalJsonText(query).length > MAX_RESOLUTION_QUERY_CHARACTERS) {
    throw invalid(
      "schema.invalid",
      `resolution query exceeds ${MAX_RESOLUTION_QUERY_CHARACTERS} canonical characters`,
      ["resolveContext", "query"],
    );
  }
  const budget = fields.req("budget", parseResolutionBudgetAt);

  const matched = matchedScopes(context, scope);
  const active = await collectActive(context, matched);
  assertNoStaleVersion(active);

  const entries: ResolvedEntry[] = [];
  const omittedInterventionIds: string[] = [];
  let characters = 0;
  let closed = false;
  for (const item of active) {
    if (closed || entries.length >= budget.maximumEntries || characters + item.characters > budget.maximumCharacters) {
      closed = true;
      omittedInterventionIds.push(item.bound.record.id);
      continue;
    }
    characters += item.characters;
    const transitionId = item.bound.record.latestTransitionId;
    entries.push({
      id: resolvedEntryIdFor({
        interventionId: item.bound.record.id,
        transitionId,
        contentDigest: item.contentDigest,
      }),
      interventionId: item.bound.record.id,
      candidateId: item.candidate.id,
      candidateDigest: item.candidate.contentDigest,
      planDigest: item.bound.plan.planDigest,
      destinationId: item.bound.fold.header.destinationId,
      scopeDigest: item.matched.digest,
      transitionId,
      content: item.content,
      contentDigest: item.contentDigest,
    });
  }
  const content = {
    episodeId,
    scope,
    scopeDigest: scopeDigest(scope),
    scopePolicyDigest: context.scopePolicy.digest,
    registryRevision: context.registryRevision,
    policyDigest: context.policy.digest,
    queryDigest: resolutionQueryDigest(query),
    budget,
    entries,
    omittedInterventionIds,
  };
  const receiptDigest = resolvedContextDigest(content);
  const receipt = parseResolvedContext(
    toJsonValue({
      schemaVersion: 1,
      id: resolvedContextIdFor(receiptDigest),
      ...content,
      resolvedAt: context.clock.now(),
      receiptDigest,
    }),
  );
  return freezeDeep(await persistResolution(context, receipt));
}

// ---------------------------------------------------------------------------
// Exposure sets and the per-episode exposure index

async function loadExposureSet(context: EngineContext, exposureSetId: string): Promise<ExposureSetRecord | undefined> {
  const stored = await loadStoredRecord(context, EXPOSURE_KIND, exposureSetId);
  if (stored === undefined) return undefined;
  const record = parseExposureSetRecord(stored.value);
  if (record.id !== exposureSetId) throw corrupt("stored exposure set id does not match its record key");
  return record;
}

interface EpisodeExposureEntry {
  readonly exposureSetId: string;
  readonly resolutionReceiptId: string;
  readonly episodeId: string;
}

const parseEpisodeExposureEntryAt: Parse<EpisodeExposureEntry> = (input, path) => {
  const fields = readFields(input, path);
  return {
    exposureSetId: fields.req("exposureSetId", parseDurableId),
    resolutionReceiptId: fields.req("resolutionReceiptId", parseDurableId),
    episodeId: fields.req("episodeId", parseDurableId),
  };
};

const parseIndexStreamEntryAt: Parse<{ readonly id: string; readonly digest: string; readonly value: unknown }> = (
  input,
  path,
) => {
  const fields = readFields(input, path);
  return {
    id: fields.req("id", parseNonEmptyText),
    digest: fields.req("digest", parseNonEmptyText),
    value: fields.req("value", parseUnknown),
  };
};

interface EpisodeExposureIndex {
  readonly entries: readonly EpisodeExposureEntry[];
  readonly revision: string;
}

async function loadEpisodeExposureIndex(
  context: EngineContext,
  episodeId: string,
): Promise<EpisodeExposureIndex | undefined> {
  const stored = await loadStoredRecord(context, EPISODE_EXPOSURE_KIND, episodeId);
  if (stored === undefined) return undefined;
  const raw = parseBoundedArray(
    parseIndexStreamEntryAt,
    MAX_EXPOSURES_PER_EPISODE,
    "episode exposure entries",
  )(stored.value, ["store", EPISODE_EXPOSURE_KIND]);
  const entries = raw.map((entry, index) => {
    const value = parseEpisodeExposureEntryAt(entry.value, ["store", EPISODE_EXPOSURE_KIND, index]);
    if (
      entry.id !== value.exposureSetId ||
      entry.digest !== recordDigest(toJsonValue(value)) ||
      value.episodeId !== episodeId
    ) {
      throw corrupt(`episode exposure index entry ${index} does not bind its exposure set`);
    }
    return value;
  });
  return { entries, revision: stored.revision };
}

/** Reload-first append of the set's index entry; a present entry is "another attempt got here first". */
async function ensureEpisodeExposureIndexed(context: EngineContext, record: ExposureSetRecord): Promise<void> {
  for (let attempt = 0; attempt < MAX_APPEND_ATTEMPTS; attempt += 1) {
    const index = await loadEpisodeExposureIndex(context, record.episodeId);
    const present = index?.entries.find((entry) => entry.exposureSetId === record.id);
    if (present !== undefined) {
      if (present.resolutionReceiptId !== record.resolutionReceiptId) {
        throw corrupt(`episode exposure index binds "${record.id}" to another resolution`);
      }
      return;
    }
    if (index !== undefined && index.entries.length >= MAX_EXPOSURES_PER_EPISODE) {
      throw refusal(
        "exposure.limit_exceeded",
        `episode "${record.episodeId}" already holds ${MAX_EXPOSURES_PER_EPISODE} exposure sets`,
      );
    }
    const value = toJsonValue({
      exposureSetId: record.id,
      resolutionReceiptId: record.resolutionReceiptId,
      episodeId: record.episodeId,
    });
    const raw: unknown = await context.store.append(
      recordKey(EPISODE_EXPOSURE_KIND, record.episodeId),
      index?.revision,
      [{ id: record.id, digest: recordDigest(value), value }],
      `episode-exposure/${record.episodeId}/${record.id}`,
    );
    const result = parseWriteResult(raw);
    if (result.status === "conflict") continue;
    return;
  }
  throw new LearningLoopError("store.conflict", [
    {
      code: "store.conflict",
      severity: "error",
      message: `episode "${record.episodeId}" exposure index changed ${MAX_APPEND_ATTEMPTS} times while appending`,
    },
  ]);
}

/**
 * Exposure set ids of one host episode, in acknowledgement order, each
 * verified against its durable set. An index entry whose set does not exist
 * is a crash remnant and does not count.
 */
export async function loadEpisodeExposureIds(context: EngineContext, episodeId: string): Promise<readonly string[]> {
  const index = await loadEpisodeExposureIndex(context, episodeId);
  if (index === undefined) return [];
  const ids: string[] = [];
  for (const entry of index.entries) {
    const record = await loadExposureSet(context, entry.exposureSetId);
    if (record === undefined) continue;
    if (record.episodeId !== episodeId || record.resolutionReceiptId !== entry.resolutionReceiptId) {
      throw corrupt(`exposure set "${entry.exposureSetId}" does not match its episode index entry`);
    }
    ids.push(record.id);
  }
  return ids;
}

async function assertHostObservedEvidence(
  context: EngineContext,
  episodeId: string,
  evidenceIds: readonly string[],
): Promise<void> {
  for (const evidenceId of evidenceIds) {
    const value = await loadRecordValue(context, "observation", evidenceId);
    if (value === undefined) {
      throw refusal(
        "exposure.evidence_not_found",
        `exposure evidence "${evidenceId}" is not a durable observation on this loop`,
        { evidenceId },
      );
    }
    const observation = parseObservation(value);
    if (observation.id !== evidenceId) throw corrupt("stored observation id does not match its record key");
    if (observation.provenance.trust !== "observed" && observation.provenance.trust !== "verified") {
      throw refusal(
        "exposure.evidence_untrusted",
        `exposure evidence "${evidenceId}" carries "${observation.provenance.trust}" trust; exposure requires host-observed evidence (observed or verified)`,
        { evidenceId, trust: observation.provenance.trust },
      );
    }
    if (observation.episodeId !== episodeId) {
      throw refusal(
        "exposure.evidence_mismatch",
        `exposure evidence "${evidenceId}" belongs to episode "${observation.episodeId}", not the resolved episode "${episodeId}"`,
        { evidenceId, episodeId: observation.episodeId },
      );
    }
  }
}

function alreadyAcknowledged(existing: ExposureSetRecord): LearningLoopError {
  return refusal(
    "exposure.already_acknowledged",
    `resolution "${existing.resolutionReceiptId}" already has exposure set "${existing.id}" with different content; one resolution yields one exposure set`,
    { exposureSetId: existing.id },
  );
}

// ---------------------------------------------------------------------------
// acknowledgeExposure

export async function runAcknowledgeExposure(context: EngineContext, input: ExposureInput): Promise<ExposureSetRecord> {
  const path: ParsePath = ["acknowledgeExposure"];
  const fields = readFields(input, path);
  const resolutionReceiptId = fields.req("resolutionReceiptId", parseDurableId);
  const appliedEntryIds = fields.req(
    "appliedEntryIds",
    parseBoundedArray(parseDurableId, MAX_RESOLUTION_ENTRIES, "applied entry ids"),
  );
  assertUniqueIds(appliedEntryIds, "applied entry ids", [...path, "appliedEntryIds"]);
  const assignmentId = fields.req("assignmentId", parseId);
  const fingerprintId = fields.req("fingerprintId", parseId);
  const evidenceIds = fields.req(
    "evidenceIds",
    parseBoundedArray(parseDurableId, MAX_EXPOSURE_REFERENCES, "exposure evidence ids"),
  );
  assertUniqueIds(evidenceIds, "exposure evidence ids", [...path, "evidenceIds"]);
  if (fields.opt("experiment", parseUnknown) !== undefined) {
    throw refusal(
      "exposure.experiment_unavailable",
      "experiment arms are declared by the Validate tier; no ExperimentDefinition record exists on this loop, so an arm claim cannot be bound",
    );
  }
  if (evidenceIds.length === 0) {
    throw refusal(
      "exposure.evidence_required",
      "exposure acknowledgement requires at least one host-observed evidence id; a caller assertion is not evidence",
    );
  }

  const receipt = await loadResolution(context, resolutionReceiptId);
  if (receipt === undefined) {
    throw refusal("exposure.resolution_not_found", `resolution receipt "${resolutionReceiptId}" does not exist`);
  }
  const entriesById = new Map(receipt.entries.map((entry) => [entry.id, entry]));
  for (const entryId of appliedEntryIds) {
    if (!entriesById.has(entryId)) {
      throw refusal(
        "exposure.entry_unknown",
        `entry "${entryId}" is not part of resolution "${receipt.id}"; exposure binds only entries that receipt froze`,
        { entryId },
      );
    }
  }
  const applied = new Set(appliedEntryIds);
  await assertHostObservedEvidence(context, receipt.episodeId, evidenceIds);

  const content = {
    episodeId: receipt.episodeId,
    resolutionReceiptId: receipt.id,
    entries: receipt.entries
      .filter((entry) => applied.has(entry.id))
      .map((entry) => ({ interventionId: entry.interventionId, resolvedContentDigest: entry.contentDigest })),
    assignmentId,
    fingerprintId,
    evidenceIds,
    exposedAt: context.clock.now(),
  };
  const record = parseExposureSetRecord(
    toJsonValue({
      schemaVersion: 1,
      id: exposureSetIdFor(receipt.receiptDigest),
      ...content,
      exposureDigest: exposureSetDigest(content),
    }),
  );

  const existing = await loadExposureSet(context, record.id);
  if (existing !== undefined) {
    if (!sameExposureContent(existing, record)) throw alreadyAcknowledged(existing);
    await ensureEpisodeExposureIndexed(context, existing);
    return freezeDeep(existing);
  }
  await ensureEpisodeExposureIndexed(context, record);
  const status = await createOnly(context, EXPOSURE_KIND, record.id, record, `exposure-set/${record.id}`);
  if (status === "created" || status === "exists_same") return freezeDeep(record);
  const stored = await loadExposureSet(context, record.id);
  if (stored === undefined) throw corrupt("exposure set conflicted but cannot be reloaded");
  if (!sameExposureContent(stored, record)) throw alreadyAcknowledged(stored);
  return freezeDeep(stored);
}
