// learning.ingest — streams a registered source's pages, validates every
// projection from `unknown`, enforces the registered content policy, stamps
// full provenance at the host-granted trust ceiling (adapters can never raise
// it), and writes create-only with deterministic record ids. Re-ingesting the
// same input is idempotent: existing identical records are `exists_same` and
// not net-new; a same-id/different-digest record is a diagnostic, never an
// overwrite.
import { canonicalJsonText } from "../canonical/canonical-json.js";
import { toJsonValue } from "../canonical/to-json-value.js";
import type { JsonValue } from "../canonical/json.js";
import type { Diagnostic } from "../diagnostics.js";
import { LearningLoopError } from "../diagnostics.js";
import { invalid, parseArrayOf, parseJson, parseNonEmptyText, parseScalar, readFields } from "../parse/toolkit.js";
import type {
  EvidenceSource,
  ProjectedEpisode,
  ProjectedMeasurement,
  ProjectedObservation,
  RegisteredSource,
} from "../ports/evidence.js";
import type { EpisodeRecord, MeasurementRecord, MetricDefinition } from "../records/episode.js";
import { parseEpisodeRecord, parseMeasurementRecord, parseMetricDefinition } from "../records/episode.js";
import type { MeasurementEvidenceRefV2 } from "../records/evidence-ref.js";
import type { Observation } from "../records/observation.js";
import { parseObservation } from "../records/observation.js";
import type { Completeness, ContentPolicy, Provenance } from "../records/provenance.js";
import type {
  EvidenceHealthFinding,
  ImportReceipt,
  SourcePageReceipt,
  SourcePageState,
} from "../records/source-health.js";
import { parseSourcePageReceipt } from "../records/source-health.js";
import type { EngineContext } from "./context.js";
import {
  conflictDiagnostic,
  createOnly,
  derivedRecordId,
  errorDiagnostics,
  iterateRecordPages,
  loadStoredRecord,
  recordDigest,
} from "./context.js";
import type { DerivativePageOwner } from "./derivative-owner.js";
import { claimDerivativePage } from "./derivative-owner.js";
import {
  episodeIdentityRecord,
  loadEpisodeIdentityState,
  parseEpisodeIdentityRecord,
  persistEpisodeIdentity,
} from "./episode-identity.js";
import { buildEpisodeOutcomeClaim, persistEpisodeOutcomeClaim } from "./episode-outcome.js";
import { resolveOutcomeMeasurementEvidence } from "./evidence-binding.js";
import {
  parseEvidencePageEnvelope,
  parseDiagnosticAt,
  parseProjectedEpisodeAt,
  parseProjectedMeasurementAt,
  parseProjectedObservationAt,
} from "./pages.js";
import { adapterFor } from "./source-registration.js";
import {
  buildHealthFinding,
  buildImportReceipt,
  buildSourcePageReceipt,
  completenessOfState,
  persistHealthFinding,
  persistImportReceipt,
  persistSourcePageReceipt,
  sanitizeTransientDiagnostics,
} from "./source-receipts.js";
import { persistSourceRevision } from "./source-revision.js";

export interface IngestReceipt {
  readonly id: string;
  readonly sourceId: string;
  readonly sourceRevisions: readonly string[];
  readonly pageReceiptIds: readonly string[];
  readonly registryRevision: string;
  readonly observationIds: readonly string[];
  readonly measurementIds: readonly string[];
  readonly episodeIds: readonly string[];
  readonly completeness: Completeness;
  readonly diagnostics: readonly Diagnostic[];
  readonly importReceipt: ImportReceipt;
}

export interface IngestOptions {
  readonly cursor?: string;
  readonly episodeBoundaryPolicyDigest?: string;
}

// Worst-wins completeness fold: complete < partial < unknown.
const COMPLETENESS_RANK = { complete: 0, partial: 1, unknown: 2 } as const;

function foldCompleteness(values: readonly Completeness[], empty: Completeness): Completeness {
  let worst: Completeness | undefined;
  for (const value of values) {
    if (worst === undefined || COMPLETENESS_RANK[value] > COMPLETENESS_RANK[worst]) worst = value;
  }
  return worst ?? empty;
}

interface ParsedContentPolicyResult {
  readonly accepted: JsonValue;
  readonly classification: string;
  readonly diagnostics: readonly Diagnostic[];
}

function parseContentPolicyResult(input: unknown): ParsedContentPolicyResult {
  const fields = readFields(input, ["contentPolicyResult"]);
  const classification = fields.req("classification", parseNonEmptyText);
  if (classification.length > 200) {
    throw new LearningLoopError("schema.invalid", [
      {
        code: "schema.invalid",
        severity: "error",
        message: "content-policy classification exceeds 200 characters",
        path: ["contentPolicyResult", "classification"],
      },
    ]);
  }
  return {
    accepted: fields.req("accepted", parseJson),
    classification,
    diagnostics: fields.req("diagnostics", parseArrayOf(parseDiagnosticAt)),
  };
}

interface IngestTally {
  readonly diagnostics: Diagnostic[];
  readonly observationIds: string[];
  readonly measurementIds: string[];
  readonly episodeIds: string[];
  readonly pageReceiptIds: string[];
  readonly sourceRevisions: string[];
  readonly healthFindingIds: string[];
  readonly pageCompleteness: Completeness[];
  duplicates: number;
}

interface PageTally {
  readonly diagnostics: Diagnostic[];
  readonly derivatives: Array<SourcePageReceipt["derivatives"][number]>;
  readonly derivativeKeys: Set<string>;
  readonly healthFindings: EvidenceHealthFinding[];
  readonly committedReceiptsByDerivative: ReadonlyMap<string, readonly SourcePageReceipt[]>;
  readonly pageOwner: DerivativePageOwner;
  rejected: number;
  reused: number;
  contentPolicyRefused: number;
  ownershipMismatch: number;
}

interface PendingOutcome {
  readonly episodeRecordId: string;
  readonly sourceId: string;
  readonly sourceRegistrationRevision: string;
  readonly sourceRef: string;
  readonly sourceRevision: string;
  readonly episodeId: string;
  readonly scope: EpisodeRecord["scope"];
  readonly status: NonNullable<EpisodeRecord["outcome"]>["status"];
  readonly measurementIds: readonly string[];
}

interface IngestedEpisode {
  readonly episodeRecordId: string;
  readonly episodeRecordDigest: string;
  readonly episodeId: string;
  readonly scope: EpisodeRecord["scope"];
  readonly pendingOutcome?: PendingOutcome;
}

function derivativeKey(derivative: SourcePageReceipt["derivatives"][number]): string {
  return canonicalJsonText([derivative.kind, derivative.id, derivative.digest]);
}

async function loadCommittedDerivativeIndex(
  context: EngineContext,
): Promise<ReadonlyMap<string, readonly SourcePageReceipt[]>> {
  const receiptsByDerivative = new Map<string, SourcePageReceipt[]>();
  for await (const page of iterateRecordPages(context.store, "source-page-receipt", { limit: 100 })) {
    for (const stored of page.records) {
      const receipt = parseSourcePageReceipt(stored.value);
      if (receipt.id !== stored.key.id) {
        throw invalid("store.corrupt", "stored source page receipt id does not match its key", ["id"]);
      }
      for (const derivative of receipt.derivatives) {
        const key = derivativeKey(derivative);
        const receipts = receiptsByDerivative.get(key) ?? [];
        if (!receipts.some((candidate) => candidate.id === receipt.id)) receipts.push(receipt);
        receiptsByDerivative.set(key, receipts);
      }
    }
  }
  return receiptsByDerivative;
}

async function claimPageForDerivative(
  context: EngineContext,
  pageTally: PageTally,
  derivative: SourcePageReceipt["derivatives"][number],
): Promise<"owned" | "reused"> {
  const key = derivativeKey(derivative);
  const receipts = pageTally.committedReceiptsByDerivative.get(key) ?? [];
  if (receipts.length > 1) {
    throw invalid("store.corrupt", "a durable derivative belongs to more than one committed source page", [
      "derivatives",
    ]);
  }
  return claimDerivativePage(context, derivative, pageTally.pageOwner, receipts[0]);
}

function recordAcceptedDerivative(
  pageTally: PageTally,
  derivative: SourcePageReceipt["derivatives"][number],
  disposition: "owned" | "reused",
): void {
  if (disposition === "owned") {
    pageTally.derivatives.push(derivative);
  } else {
    pageTally.reused += 1;
  }
}

function hasOwnedCommittedOrPendingDerivative(
  pageTally: PageTally,
  derivative: SourcePageReceipt["derivatives"][number],
  registration: RegisteredSource<unknown>,
  sourceRef: string,
  sourceRevision: string,
): boolean {
  const key = derivativeKey(derivative);
  if (pageTally.derivatives.some((candidate) => derivativeKey(candidate) === key)) return true;
  const receipts = pageTally.committedReceiptsByDerivative.get(key) ?? [];
  if (receipts.length !== 1) return false;
  const receipt = receipts[0];
  return (
    receipt !== undefined &&
    receipt.sourceId === registration.id &&
    receipt.sourceRegistrationRevision === registration.registryRevision &&
    receipt.sourceRef === sourceRef &&
    receipt.state.status === "available" &&
    receipt.state.sourceRevision === sourceRevision
  );
}

async function findOwnedEpisode(
  context: EngineContext,
  registration: RegisteredSource<unknown>,
  episodeId: string,
): Promise<IngestedEpisode | undefined> {
  const matches = new Map<string, IngestedEpisode>();
  for await (const page of iterateRecordPages(context.store, "episode", { limit: 100 })) {
    for (const stored of page.records) {
      const episode = parseEpisodeRecord(stored.value);
      if (episode.id !== stored.key.id) {
        throw invalid("store.corrupt", "stored episode id does not match its key", ["id"]);
      }
      const identity = await loadEpisodeIdentityState(context, episode.id);
      if (
        identity.status !== "resolved" ||
        identity.identity.sourceId !== registration.id ||
        identity.identity.registryRevision !== registration.registryRevision ||
        identity.identity.episodeId !== episodeId ||
        !episode.sourceRefs.includes(registration.id)
      ) {
        continue;
      }
      matches.set(episode.id, {
        episodeRecordId: episode.id,
        episodeRecordDigest: stored.digest,
        episodeId,
        scope: episode.scope,
      });
    }
  }
  if (matches.size > 1) {
    throw invalid("evidence.ownership_mismatch", "logical episode resolves to more than one durable episode", [
      "episodeId",
    ]);
  }
  return matches.values().next().value;
}

function reserveDerivative(
  pageTally: PageTally,
  kind: SourcePageReceipt["derivatives"][number]["kind"],
  id: string,
  path: readonly (string | number)[],
): boolean {
  const key = `${kind}\u0000${id}`;
  if (pageTally.derivativeKeys.has(key)) {
    pageTally.diagnostics.push({
      code: "schema.invalid",
      severity: "error",
      message: "a source page repeated the same derivative identity",
      path,
    });
    pageTally.rejected += 1;
    return false;
  }
  pageTally.derivativeKeys.add(key);
  return true;
}

function provenanceFor(
  registration: RegisteredSource<unknown>,
  adapter: EvidenceSource<unknown>,
  sourceRef: string,
  sourceRevision: string,
  sourceRecordId: string,
  contentDigest: string,
  completeness: Completeness,
): Provenance {
  return {
    sourceId: registration.id,
    adapterVersion: adapter.descriptor.adapterVersion,
    sourceRef,
    sourceRevision,
    recordRef: sourceRecordId,
    contentDigest,
    completeness,
    trust: registration.trustCeiling,
  };
}

async function ingestObservation(
  context: EngineContext,
  registration: RegisteredSource<unknown>,
  adapter: EvidenceSource<unknown>,
  contentPolicy: ContentPolicy,
  projected: ProjectedObservation,
  sourceRef: string,
  sourceRevision: string,
  operationId: string,
  tally: IngestTally,
  pageTally: PageTally,
): Promise<void> {
  const rawTransformed: unknown = await contentPolicy.transform(projected.data);
  const transformed = parseContentPolicyResult(rawTransformed);
  pageTally.diagnostics.push(...transformed.diagnostics);
  if (transformed.diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    pageTally.rejected += 1;
    pageTally.contentPolicyRefused += 1;
    return;
  }
  const id = derivedRecordId(registration.id, projected.sourceRecordId);
  const record: Observation = {
    schemaVersion: 1,
    id,
    episodeId: projected.episodeId,
    ...(projected.occurredAt !== undefined ? { occurredAt: projected.occurredAt } : {}),
    kind: projected.kind,
    provenance: provenanceFor(
      registration,
      adapter,
      sourceRef,
      sourceRevision,
      projected.sourceRecordId,
      recordDigest(transformed.accepted),
      projected.completeness,
    ),
    data: transformed.accepted,
  };
  const parsed = parseObservation(record);
  const digest = recordDigest(toJsonValue(parsed));
  const derivative = { kind: "observation" as const, id, digest };
  const disposition = await claimPageForDerivative(context, pageTally, derivative);
  const status = await createOnly(context, "observation", id, parsed, operationId);
  if (status === "created") tally.observationIds.push(id);
  else if (status === "exists_same") tally.duplicates += 1;
  else {
    pageTally.diagnostics.push(conflictDiagnostic("observation", id));
    pageTally.rejected += 1;
    return;
  }
  recordAcceptedDerivative(pageTally, derivative, disposition);
}

function parseAcceptedMeasurementContent(input: unknown): {
  readonly metric: MetricDefinition;
  readonly value: MeasurementRecord["value"];
} {
  const fields = readFields(input, ["contentPolicyResult", "accepted"]);
  return {
    metric: fields.req("metric", (value) => parseMetricDefinition(value)),
    value: fields.req("value", parseScalar),
  };
}

async function ingestMeasurement(
  context: EngineContext,
  registration: RegisteredSource<unknown>,
  adapter: EvidenceSource<unknown>,
  contentPolicy: ContentPolicy,
  projected: ProjectedMeasurement,
  sourceRef: string,
  sourceRevision: string,
  operationId: string,
  tally: IngestTally,
  pageTally: PageTally,
): Promise<void> {
  if (projected.evidenceSourceRecordIds.length === 0) {
    throw invalid("evidence.ownership_mismatch", "measurement requires at least one cited observation", [
      "evidenceSourceRecordIds",
    ]);
  }
  const episode = await findOwnedEpisode(context, registration, projected.episodeId);
  if (
    episode === undefined ||
    !hasOwnedCommittedOrPendingDerivative(
      pageTally,
      { kind: "episode", id: episode.episodeRecordId, digest: episode.episodeRecordDigest },
      registration,
      sourceRef,
      sourceRevision,
    )
  ) {
    throw invalid("evidence.ownership_mismatch", "measurement does not belong to one committed source episode", [
      "episodeId",
    ]);
  }

  const evidenceIds: string[] = [];
  const completeness: Completeness[] = [];
  const seen = new Set<string>();
  for (const [index, sourceRecordId] of projected.evidenceSourceRecordIds.entries()) {
    const id = derivedRecordId(registration.id, sourceRecordId);
    if (seen.has(id)) {
      throw invalid("evidence.ownership_mismatch", "measurement cited the same observation more than once", [
        "evidenceSourceRecordIds",
        index,
      ]);
    }
    seen.add(id);
    const stored = await loadStoredRecord(context, "observation", id);
    if (stored === undefined) {
      throw invalid("evidence.ownership_mismatch", "measurement cited observation is missing", [
        "evidenceSourceRecordIds",
        index,
      ]);
    }
    const observation = parseObservation(stored.value);
    const derivative = { kind: "observation" as const, id, digest: stored.digest };
    if (
      observation.id !== id ||
      observation.episodeId !== projected.episodeId ||
      observation.provenance.sourceId !== registration.id ||
      observation.provenance.adapterVersion !== adapter.descriptor.adapterVersion ||
      observation.provenance.sourceRef !== sourceRef ||
      observation.provenance.sourceRevision !== sourceRevision ||
      observation.provenance.recordRef !== sourceRecordId ||
      observation.provenance.trust !== registration.trustCeiling ||
      !hasOwnedCommittedOrPendingDerivative(pageTally, derivative, registration, sourceRef, sourceRevision)
    ) {
      throw invalid("evidence.ownership_mismatch", "measurement cited observation has foreign ownership", [
        "evidenceSourceRecordIds",
        index,
      ]);
    }
    evidenceIds.push(id);
    completeness.push(observation.provenance.completeness);
  }

  const rawTransformed: unknown = await contentPolicy.transform({ metric: projected.metric, value: projected.value });
  const transformed = parseContentPolicyResult(rawTransformed);
  pageTally.diagnostics.push(...transformed.diagnostics);
  if (transformed.diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    pageTally.contentPolicyRefused += 1;
    throw invalid("policy.blocked", "content policy refused measurement content", ["measurement"]);
  }
  const accepted = parseAcceptedMeasurementContent(transformed.accepted);
  const id = derivedRecordId(registration.id, projected.sourceRecordId);
  const record: MeasurementRecord = {
    schemaVersion: 1,
    id,
    episodeId: projected.episodeId,
    metric: accepted.metric,
    value: accepted.value,
    evidenceIds,
    ...(projected.measuredAt !== undefined ? { measuredAt: projected.measuredAt } : {}),
    provenance: provenanceFor(
      registration,
      adapter,
      sourceRef,
      sourceRevision,
      projected.sourceRecordId,
      recordDigest({ metric: { ...accepted.metric }, value: accepted.value }),
      foldCompleteness(completeness, "unknown"),
    ),
  };
  const parsed = parseMeasurementRecord(record);
  const digest = recordDigest(toJsonValue(parsed));
  const derivative = { kind: "measurement" as const, id, digest };
  const disposition = await claimPageForDerivative(context, pageTally, derivative);
  const status = await createOnly(context, "measurement", id, parsed, operationId);
  if (status === "created") tally.measurementIds.push(id);
  else if (status === "exists_same") tally.duplicates += 1;
  else {
    pageTally.diagnostics.push(conflictDiagnostic("measurement", id));
    pageTally.rejected += 1;
    return;
  }
  recordAcceptedDerivative(pageTally, derivative, disposition);
}

async function validatePendingOutcomeMeasurements(
  context: EngineContext,
  registration: RegisteredSource<unknown>,
  pending: PendingOutcome,
  pageTally: PageTally,
): Promise<void> {
  const seen = new Set<string>();
  for (const [index, id] of pending.measurementIds.entries()) {
    if (seen.has(id)) {
      throw invalid("evidence.ownership_mismatch", "episode outcome repeated one measurement", [
        "measurementIds",
        index,
      ]);
    }
    seen.add(id);
    const stored = await loadStoredRecord(context, "measurement", id);
    if (stored === undefined) {
      throw invalid("evidence.ownership_mismatch", "episode outcome measurement is missing", ["measurementIds", index]);
    }
    const measurement = parseMeasurementRecord(stored.value);
    if (
      measurement.id !== id ||
      measurement.episodeId !== pending.episodeId ||
      measurement.provenance.sourceId !== registration.id ||
      measurement.provenance.sourceRef !== pending.sourceRef ||
      measurement.provenance.sourceRevision !== pending.sourceRevision ||
      measurement.provenance.trust !== registration.trustCeiling ||
      !hasOwnedCommittedOrPendingDerivative(
        pageTally,
        { kind: "measurement", id, digest: stored.digest },
        registration,
        pending.sourceRef,
        pending.sourceRevision,
      )
    ) {
      throw invalid("evidence.ownership_mismatch", "episode outcome measurement has foreign ownership", [
        "measurementIds",
        index,
      ]);
    }
  }
}

async function ingestEpisode(
  context: EngineContext,
  registration: RegisteredSource<unknown>,
  projected: ProjectedEpisode,
  sourceRef: string,
  sourceRevision: string,
  operationId: string,
  tally: IngestTally,
  pageTally: PageTally,
): Promise<IngestedEpisode | undefined> {
  const scope = context.scopePolicy.validate(projected.scope);
  const id = derivedRecordId(registration.id, projected.sourceRecordId);
  const record: EpisodeRecord = {
    schemaVersion: 1,
    id,
    scope,
    openedAt: projected.openedAt,
    ...(projected.closedAt !== undefined ? { closedAt: projected.closedAt } : {}),
    sourceRefs: [registration.id],
    exposureIds: [],
  };
  const parsedBase = parseEpisodeRecord(record);
  let digest = recordDigest(toJsonValue(parsedBase));
  let status: "created" | "exists_same" | "conflict";
  const stored = await loadStoredRecord(context, "episode", id);
  if (stored === undefined) {
    status = "created";
  } else {
    const existing = parseEpisodeRecord(stored.value);
    if (existing.id !== id) throw invalid("store.corrupt", "stored episode id does not match its key", ["id"]);
    const withoutOutcome = (episode: EpisodeRecord): JsonValue =>
      toJsonValue({
        schemaVersion: episode.schemaVersion,
        id: episode.id,
        scope: episode.scope,
        openedAt: episode.openedAt,
        ...(episode.closedAt !== undefined ? { closedAt: episode.closedAt } : {}),
        sourceRefs: episode.sourceRefs,
        ...(episode.fingerprintId !== undefined ? { fingerprintId: episode.fingerprintId } : {}),
        exposureIds: episode.exposureIds,
      });
    status =
      canonicalJsonText(withoutOutcome(existing)) === canonicalJsonText(withoutOutcome(parsedBase))
        ? "exists_same"
        : "conflict";
    digest = stored.digest;
  }
  if (status === "conflict") {
    pageTally.diagnostics.push(conflictDiagnostic("episode", id));
    pageTally.rejected += 1;
    return undefined;
  }
  const derivative = { kind: "episode" as const, id, digest };
  const disposition = await claimPageForDerivative(context, pageTally, derivative);
  if (stored === undefined) status = await createOnly(context, "episode", id, parsedBase, operationId);
  if (status === "created") tally.episodeIds.push(id);
  else if (status === "exists_same") tally.duplicates += 1;
  else {
    pageTally.diagnostics.push(conflictDiagnostic("episode", id));
    pageTally.rejected += 1;
    return undefined;
  }

  // The projection's logical episodeId is a join key for observations, while
  // the durable EpisodeRecord id is derived from sourceRecordId. Persist their
  // relationship independently so existing episode bytes stay unchanged and
  // an explicit re-ingest can repair a missing sidecar after a crash or upgrade.
  const identity = parseEpisodeIdentityRecord(episodeIdentityRecord(registration, projected, id));
  const identityStatus = await persistEpisodeIdentity(context, identity, `${operationId}/identity`);
  if (identityStatus === "conflict") {
    pageTally.diagnostics.push({
      code: "episode.identity_conflict",
      severity: "error",
      message: "the durable episode has more than one source identity claim",
      details: { episodeRecordId: id },
    });
    pageTally.rejected += 1;
    return undefined;
  }
  recordAcceptedDerivative(pageTally, derivative, disposition);
  const pendingOutcome: PendingOutcome | undefined =
    projected.status === undefined
      ? undefined
      : {
          episodeRecordId: id,
          sourceId: registration.id,
          sourceRegistrationRevision: registration.registryRevision,
          sourceRef,
          sourceRevision,
          episodeId: projected.episodeId,
          scope,
          status: projected.status,
          measurementIds: projected.measurementSourceRecordIds.map((ref) => derivedRecordId(registration.id, ref)),
        };
  return {
    episodeRecordId: id,
    episodeRecordDigest: digest,
    episodeId: projected.episodeId,
    scope,
    ...(pendingOutcome !== undefined ? { pendingOutcome } : {}),
  };
}

function queuePageHealthFinding(
  registration: RegisteredSource<unknown>,
  pageTally: PageTally,
  input: {
    readonly code: EvidenceHealthFinding["code"];
    readonly effect: EvidenceHealthFinding["effect"];
    readonly sourceRef: string;
    readonly pageRef: string;
    readonly completeness: Completeness;
    readonly affectedRecords: number;
  },
): void {
  const finding = buildHealthFinding({
    ...input,
    sourceId: registration.id,
    sourceRegistrationRevision: registration.registryRevision,
  });
  pageTally.healthFindings.push(finding);
}

function unavailableHealthCode(status: Exclude<SourcePageState["status"], "available">): EvidenceHealthFinding["code"] {
  if (status === "missing") return "source.missing";
  if (status === "unreadable") return "source.unreadable";
  if (status === "unsupported") return "source.unsupported";
  return "source.corrupt";
}

export async function runIngest(
  context: EngineContext,
  registration: RegisteredSource<unknown>,
  sourceInput: unknown,
  options?: IngestOptions,
): Promise<IngestReceipt> {
  if (!context.sources.has(registration)) {
    throw new LearningLoopError("source.not_registered", [
      {
        code: "source.not_registered",
        severity: "error",
        message: `source "${registration.id}" is not part of this loop's immutable registry; only sources configured at construction may ingest`,
        details: { sourceId: registration.id, registryRevision: context.registryRevision },
      },
    ]);
  }
  const adapter = adapterFor(registration);
  const contentPolicy = context.contentPoliciesById.get(registration.contentPolicyId);
  const sourceSemanticProfile = context.sourceSemanticProfilesBySourceId?.get(registration.id);
  if (adapter === undefined || contentPolicy === undefined) {
    // Both are verified at construction; reaching this means the context was
    // assembled outside createLearningLoop.
    throw new LearningLoopError("config.invalid", [
      {
        code: "config.invalid",
        severity: "error",
        message: `source "${registration.id}" has no paired adapter or content policy in this loop`,
      },
    ]);
  }

  const attemptId = context.ids.next("ingest-attempt");
  const tally: IngestTally = {
    diagnostics: [],
    observationIds: [],
    measurementIds: [],
    episodeIds: [],
    pageReceiptIds: [],
    sourceRevisions: [],
    healthFindingIds: [],
    pageCompleteness: [],
    duplicates: 0,
  };
  let pageIndex = 0;

  for await (const rawPage of adapter.read(sourceInput, options?.cursor)) {
    const pagePath = ["pages", pageIndex] as const;
    const page = parseEvidencePageEnvelope(rawPage, pagePath);
    const committed = await loadCommittedDerivativeIndex(context);
    const pageTally: PageTally = {
      diagnostics: [...page.diagnostics],
      derivatives: [],
      derivativeKeys: new Set(),
      healthFindings: [],
      committedReceiptsByDerivative: committed,
      pageOwner: {
        sourceId: registration.id,
        sourceRegistrationRevision: registration.registryRevision,
        contentPolicyId: contentPolicy.id,
        contentPolicyDigest: contentPolicy.digest,
        loopRegistryRevision: context.registryRevision,
        sourceRef: page.sourceRef,
        pageRef: page.pageRef,
        state: page.state,
      },
      rejected: 0,
      reused: 0,
      contentPolicyRefused: 0,
      ownershipMismatch: 0,
    };
    const pageCompleteness = completenessOfState(page.state);
    tally.pageCompleteness.push(pageCompleteness);
    const projectedCount = page.observations.length + page.measurements.length + page.episodes.length;
    const knownRevision = page.state.status === "available" ? page.state.sourceRevision : page.state.observedRevision;
    if (knownRevision !== undefined) tally.sourceRevisions.push(knownRevision);

    let revisionConflict = false;
    if (knownRevision !== undefined) {
      const revisionStatus = await persistSourceRevision(
        context,
        {
          sourceId: registration.id,
          sourceRegistrationRevision: registration.registryRevision,
          sourceRef: page.sourceRef,
          pageRef: page.pageRef,
          sourceRevision: knownRevision,
        },
        `${attemptId}/pages/${pageIndex}/revision`,
      );
      if (revisionStatus === "conflict") {
        revisionConflict = true;
        queuePageHealthFinding(registration, pageTally, {
          code: "source.revision_changed",
          effect: "blocks_use",
          sourceRef: page.sourceRef,
          pageRef: page.pageRef,
          completeness: pageCompleteness,
          affectedRecords: projectedCount,
        });
      }
    }

    const acceptDerivatives = page.state.status === "available" && !revisionConflict;
    if (page.state.status === "available") {
      if (page.state.completeness !== "complete") {
        queuePageHealthFinding(registration, pageTally, {
          code: "source.partial",
          effect: "limits_claims",
          sourceRef: page.sourceRef,
          pageRef: page.pageRef,
          completeness: page.state.completeness,
          affectedRecords: projectedCount,
        });
      }
    } else {
      queuePageHealthFinding(registration, pageTally, {
        code: unavailableHealthCode(page.state.status),
        effect: "blocks_use",
        sourceRef: page.sourceRef,
        pageRef: page.pageRef,
        completeness: "unknown",
        affectedRecords: projectedCount,
      });
    }

    if (page.diagnostics.length > 0) {
      queuePageHealthFinding(registration, pageTally, {
        code: "source.adapter_diagnostic",
        effect: page.diagnostics.some((diagnostic) => diagnostic.severity === "error")
          ? "blocks_audit"
          : "limits_claims",
        sourceRef: page.sourceRef,
        pageRef: page.pageRef,
        completeness: pageCompleteness,
        affectedRecords: page.diagnostics.length,
      });
    }

    const pendingOutcomes: PendingOutcome[] = [];
    const validatedOutcomes: PendingOutcome[] = [];
    if (acceptDerivatives && page.state.status === "available") {
      for (const [index, raw] of page.episodes.entries()) {
        try {
          const projected = parseProjectedEpisodeAt(raw, [...pagePath, "episodes", index]);
          const id = derivedRecordId(registration.id, projected.sourceRecordId);
          if (!reserveDerivative(pageTally, "episode", id, [...pagePath, "episodes", index])) continue;
          const operationId = `${attemptId}/pages/${pageIndex}/episodes/${projected.sourceRecordId}`;
          const ingestedEpisode = await ingestEpisode(
            context,
            registration,
            projected,
            page.sourceRef,
            page.state.sourceRevision,
            operationId,
            tally,
            pageTally,
          );
          if (ingestedEpisode !== undefined) {
            if (ingestedEpisode.pendingOutcome !== undefined) pendingOutcomes.push(ingestedEpisode.pendingOutcome);
          }
        } catch (error) {
          pageTally.diagnostics.push(...errorDiagnostics(error));
          pageTally.rejected += 1;
        }
      }
      for (const [index, raw] of page.observations.entries()) {
        try {
          const projected = parseProjectedObservationAt(raw, [...pagePath, "observations", index]);
          if (sourceSemanticProfile !== undefined && !sourceSemanticProfile.observationKinds.includes(projected.kind)) {
            throw invalid("schema.invalid", "projected observation kind is absent from its source semantic profile", [
              ...pagePath,
              "observations",
              index,
              "kind",
            ]);
          }
          const id = derivedRecordId(registration.id, projected.sourceRecordId);
          if (!reserveDerivative(pageTally, "observation", id, [...pagePath, "observations", index])) continue;
          const operationId = `${attemptId}/pages/${pageIndex}/observations/${projected.sourceRecordId}`;
          await ingestObservation(
            context,
            registration,
            adapter,
            contentPolicy,
            projected,
            page.sourceRef,
            page.state.sourceRevision,
            operationId,
            tally,
            pageTally,
          );
        } catch (error) {
          pageTally.diagnostics.push(...errorDiagnostics(error));
          pageTally.rejected += 1;
        }
      }

      for (const [index, raw] of page.measurements.entries()) {
        try {
          const projected = parseProjectedMeasurementAt(raw, [...pagePath, "measurements", index]);
          const id = derivedRecordId(registration.id, projected.sourceRecordId);
          if (!reserveDerivative(pageTally, "measurement", id, [...pagePath, "measurements", index])) continue;
          const operationId = `${attemptId}/pages/${pageIndex}/measurements/${projected.sourceRecordId}`;
          await ingestMeasurement(
            context,
            registration,
            adapter,
            contentPolicy,
            projected,
            page.sourceRef,
            page.state.sourceRevision,
            operationId,
            tally,
            pageTally,
          );
        } catch (error) {
          if (error instanceof LearningLoopError && error.code === "evidence.ownership_mismatch") {
            pageTally.ownershipMismatch += 1;
          }
          pageTally.diagnostics.push(...errorDiagnostics(error));
          pageTally.rejected += 1;
        }
      }
      for (const pending of pendingOutcomes) {
        try {
          await validatePendingOutcomeMeasurements(context, registration, pending, pageTally);
          validatedOutcomes.push(pending);
        } catch (error) {
          if (error instanceof LearningLoopError && error.code === "evidence.ownership_mismatch") {
            pageTally.ownershipMismatch += 1;
          }
          pageTally.diagnostics.push(...errorDiagnostics(error));
        }
      }
    } else {
      pageTally.rejected += projectedCount;
    }

    if (pageTally.contentPolicyRefused > 0) {
      queuePageHealthFinding(registration, pageTally, {
        code: "source.content_policy_refused",
        effect: "blocks_use",
        sourceRef: page.sourceRef,
        pageRef: page.pageRef,
        completeness: pageCompleteness,
        affectedRecords: pageTally.contentPolicyRefused,
      });
    }
    if (pageTally.ownershipMismatch > 0) {
      queuePageHealthFinding(registration, pageTally, {
        code: "source.ownership_mismatch",
        effect: "blocks_use",
        sourceRef: page.sourceRef,
        pageRef: page.pageRef,
        completeness: pageCompleteness,
        affectedRecords: pageTally.ownershipMismatch,
      });
    }
    if (pageTally.rejected > 0) {
      queuePageHealthFinding(registration, pageTally, {
        code: "source.record_rejected",
        effect: "blocks_audit",
        sourceRef: page.sourceRef,
        pageRef: page.pageRef,
        completeness: pageCompleteness,
        affectedRecords: pageTally.rejected,
      });
    }

    for (const finding of pageTally.healthFindings) await persistHealthFinding(context, finding);
    const healthFindingIds = pageTally.healthFindings.map((finding) => finding.id);
    tally.diagnostics.push(...pageTally.diagnostics);
    const pageReceipt = buildSourcePageReceipt({
      sourceId: registration.id,
      sourceRegistrationRevision: registration.registryRevision,
      adapterVersion: adapter.descriptor.adapterVersion,
      contentPolicyId: contentPolicy.id,
      contentPolicyDigest: contentPolicy.digest,
      loopRegistryRevision: context.registryRevision,
      sourceRef: page.sourceRef,
      pageRef: page.pageRef,
      state: page.state,
      derivatives: pageTally.derivatives,
      projectionCounts: {
        observations: page.observations.length,
        measurements: page.measurements.length,
        episodes: page.episodes.length,
        rejected: pageTally.rejected,
        ...(pageTally.reused > 0 ? { reused: pageTally.reused } : {}),
      },
      diagnostics: pageTally.diagnostics,
      healthFindingIds,
    });
    await persistSourcePageReceipt(context, pageReceipt);
    for (const pending of validatedOutcomes) {
      const measurementRefs: MeasurementEvidenceRefV2[] = [];
      if (pending.measurementIds.length > 0) {
        const resolved = await resolveOutcomeMeasurementEvidence(context, pending.measurementIds, pending.scope);
        if (resolved.health.status === "invalid" || resolved.refs.length !== pending.measurementIds.length) {
          throw invalid("evidence.ownership_mismatch", "validated outcome measurements did not resolve exactly", [
            "measurementIds",
          ]);
        }
        for (const reference of resolved.refs) {
          if (reference.schemaVersion !== 2 || reference.kind !== "measurement") {
            throw invalid("schema.corrupt", "outcome measurement resolver returned an unqualified reference", [
              "measurementRefs",
            ]);
          }
          measurementRefs.push(reference);
        }
      }
      const claim = buildEpisodeOutcomeClaim({
        episodeRecordId: pending.episodeRecordId,
        sourceId: pending.sourceId,
        sourceRegistrationRevision: pending.sourceRegistrationRevision,
        sourceRef: pending.sourceRef,
        sourceRevision: pending.sourceRevision,
        episodeId: pending.episodeId,
        status: pending.status,
        measurementRefs,
      });
      await persistEpisodeOutcomeClaim(context, claim);
    }
    tally.pageReceiptIds.push(pageReceipt.id);
    tally.healthFindingIds.push(...healthFindingIds);
    pageIndex += 1;
  }

  const diagnostics: Diagnostic[] = [...sanitizeTransientDiagnostics(tally.diagnostics)];
  if (tally.duplicates > 0) {
    diagnostics.push({
      code: "ingest.duplicate",
      severity: "info",
      message: "one or more records were already stored with identical content",
      details: { count: tally.duplicates },
    });
  }
  const sourceRevisions = [...new Set(tally.sourceRevisions)].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  const importReceipt = buildImportReceipt({
    sourceId: registration.id,
    sourceRegistrationRevision: registration.registryRevision,
    loopRegistryRevision: context.registryRevision,
    pageReceiptIds: tally.pageReceiptIds,
    sourceRevisions,
    completeness: foldCompleteness(tally.pageCompleteness, "unknown"),
    healthFindingIds: tally.healthFindingIds,
  });
  await persistImportReceipt(context, importReceipt);
  return {
    id: importReceipt.id,
    sourceId: registration.id,
    sourceRevisions,
    pageReceiptIds: tally.pageReceiptIds,
    registryRevision: context.registryRevision,
    observationIds: tally.observationIds,
    measurementIds: tally.measurementIds,
    episodeIds: tally.episodeIds,
    completeness: importReceipt.completeness,
    diagnostics,
    importReceipt,
  };
}
