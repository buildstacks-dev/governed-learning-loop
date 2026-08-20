// learning.ingest — streams a registered source's pages, validates every
// projection from `unknown`, enforces the registered content policy, stamps
// full provenance at the host-granted trust ceiling (adapters can never raise
// it), and writes create-only with deterministic record ids. Re-ingesting the
// same input is idempotent: existing identical records are `exists_same` and
// not net-new; a same-id/different-digest record is a diagnostic, never an
// overwrite.
import { toJsonValue } from "../canonical/to-json-value.js";
import type { JsonValue } from "../canonical/json.js";
import type { Diagnostic } from "../diagnostics.js";
import { LearningLoopError } from "../diagnostics.js";
import { parseArrayOf, parseJson, parseNonEmptyText, readFields } from "../parse/toolkit.js";
import type { EvidenceSource, ProjectedEpisode, ProjectedObservation, RegisteredSource } from "../ports/evidence.js";
import type { EpisodeRecord, MeasurementRecord } from "../records/episode.js";
import { parseEpisodeRecord, parseMeasurementRecord } from "../records/episode.js";
import type { Observation } from "../records/observation.js";
import { parseObservation } from "../records/observation.js";
import type { Completeness, ContentPolicy, Provenance } from "../records/provenance.js";
import type {
  EvidenceHealthFinding,
  ImportReceipt,
  SourcePageReceipt,
  SourcePageState,
} from "../records/source-health.js";
import type { EngineContext } from "./context.js";
import { conflictDiagnostic, createOnly, derivedRecordId, errorDiagnostics, recordDigest } from "./context.js";
import { episodeIdentityRecord, parseEpisodeIdentityRecord, persistEpisodeIdentity } from "./episode-identity.js";
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
  rejected: number;
  contentPolicyRefused: number;
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
  const status = await createOnly(context, "observation", id, parsed, operationId);
  if (status === "created") tally.observationIds.push(id);
  else if (status === "exists_same") tally.duplicates += 1;
  else {
    pageTally.diagnostics.push(conflictDiagnostic("observation", id));
    pageTally.rejected += 1;
    return;
  }
  pageTally.derivatives.push({ kind: "observation", id, digest });
}

async function ingestEpisode(
  context: EngineContext,
  registration: RegisteredSource<unknown>,
  projected: ProjectedEpisode,
  operationId: string,
  tally: IngestTally,
  pageTally: PageTally,
): Promise<void> {
  const scope = context.scopePolicy.validate(projected.scope);
  const id = derivedRecordId(registration.id, projected.sourceRecordId);
  const record: EpisodeRecord = {
    schemaVersion: 1,
    id,
    scope,
    openedAt: projected.openedAt,
    ...(projected.closedAt !== undefined ? { closedAt: projected.closedAt } : {}),
    sourceRefs: [registration.id],
    ...(projected.status !== undefined
      ? {
          outcome: {
            status: projected.status,
            measurementIds: projected.measurementSourceRecordIds.map((ref) => derivedRecordId(registration.id, ref)),
          },
        }
      : {}),
    exposureIds: [],
  };
  const parsed = parseEpisodeRecord(record);
  const digest = recordDigest(toJsonValue(parsed));
  const status = await createOnly(context, "episode", id, parsed, operationId);
  if (status === "created") tally.episodeIds.push(id);
  else if (status === "exists_same") tally.duplicates += 1;
  else {
    pageTally.diagnostics.push(conflictDiagnostic("episode", id));
    pageTally.rejected += 1;
    return;
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
    return;
  }
  pageTally.derivatives.push({ kind: "episode", id, digest });
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
    const pageTally: PageTally = {
      diagnostics: [...page.diagnostics],
      derivatives: [],
      derivativeKeys: new Set(),
      healthFindings: [],
      rejected: 0,
      contentPolicyRefused: 0,
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

    if (acceptDerivatives && page.state.status === "available") {
      for (const [index, raw] of page.observations.entries()) {
        try {
          const projected = parseProjectedObservationAt(raw, [...pagePath, "observations", index]);
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

      // Full cited-evidence completeness lands in #31c. This interim value is
      // page-local, so unrelated pages can no longer change it.
      const pageFold = page.state.completeness;
      for (const [index, raw] of page.measurements.entries()) {
        try {
          const projected = parseProjectedMeasurementAt(raw, [...pagePath, "measurements", index]);
          const id = derivedRecordId(registration.id, projected.sourceRecordId);
          if (!reserveDerivative(pageTally, "measurement", id, [...pagePath, "measurements", index])) continue;
          const record: MeasurementRecord = {
            schemaVersion: 1,
            id,
            episodeId: projected.episodeId,
            metric: projected.metric,
            value: projected.value,
            evidenceIds: projected.evidenceSourceRecordIds.map((ref) => derivedRecordId(registration.id, ref)),
            ...(projected.measuredAt !== undefined ? { measuredAt: projected.measuredAt } : {}),
            provenance: provenanceFor(
              registration,
              adapter,
              page.sourceRef,
              page.state.sourceRevision,
              projected.sourceRecordId,
              recordDigest({ metric: { ...projected.metric }, value: projected.value }),
              pageFold,
            ),
          };
          const parsed = parseMeasurementRecord(record);
          const digest = recordDigest(toJsonValue(parsed));
          const operationId = `${attemptId}/pages/${pageIndex}/measurements/${projected.sourceRecordId}`;
          const status = await createOnly(context, "measurement", id, parsed, operationId);
          if (status === "created") tally.measurementIds.push(id);
          else if (status === "exists_same") tally.duplicates += 1;
          else {
            pageTally.diagnostics.push(conflictDiagnostic("measurement", id));
            pageTally.rejected += 1;
            continue;
          }
          pageTally.derivatives.push({ kind: "measurement", id, digest });
        } catch (error) {
          pageTally.diagnostics.push(...errorDiagnostics(error));
          pageTally.rejected += 1;
        }
      }
      for (const [index, raw] of page.episodes.entries()) {
        try {
          const projected = parseProjectedEpisodeAt(raw, [...pagePath, "episodes", index]);
          const id = derivedRecordId(registration.id, projected.sourceRecordId);
          if (!reserveDerivative(pageTally, "episode", id, [...pagePath, "episodes", index])) continue;
          const operationId = `${attemptId}/pages/${pageIndex}/episodes/${projected.sourceRecordId}`;
          await ingestEpisode(context, registration, projected, operationId, tally, pageTally);
        } catch (error) {
          pageTally.diagnostics.push(...errorDiagnostics(error));
          pageTally.rejected += 1;
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
      },
      diagnostics: pageTally.diagnostics,
      healthFindingIds,
    });
    await persistSourcePageReceipt(context, pageReceipt);
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
