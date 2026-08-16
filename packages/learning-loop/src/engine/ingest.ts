// learning.ingest — streams a registered source's pages, validates every
// projection from `unknown`, enforces the registered content policy, stamps
// full provenance at the host-granted trust ceiling (adapters can never raise
// it), and writes create-only with deterministic record ids. Re-ingesting the
// same input is idempotent: existing identical records are `exists_same` and
// not net-new; a same-id/different-digest record is a diagnostic, never an
// overwrite.
import type { Diagnostic } from "../diagnostics.js";
import { LearningLoopError } from "../diagnostics.js";
import type { EvidenceSource, ProjectedEpisode, ProjectedObservation, RegisteredSource } from "../ports/evidence.js";
import type { EpisodeRecord, MeasurementRecord } from "../records/episode.js";
import { parseEpisodeRecord, parseMeasurementRecord } from "../records/episode.js";
import type { Observation } from "../records/observation.js";
import { parseObservation } from "../records/observation.js";
import type { Completeness, ContentPolicy, Provenance } from "../records/provenance.js";
import type { EngineContext } from "./context.js";
import { conflictDiagnostic, createOnly, derivedRecordId, errorDiagnostics, recordDigest } from "./context.js";
import {
  parseEvidencePageEnvelope,
  parseProjectedEpisodeAt,
  parseProjectedMeasurementAt,
  parseProjectedObservationAt,
} from "./pages.js";
import { adapterFor } from "./source-registration.js";

export interface IngestReceipt {
  readonly id: string;
  readonly sourceId: string;
  readonly sourceRevision: string;
  readonly registryRevision: string;
  readonly observationIds: readonly string[];
  readonly measurementIds: readonly string[];
  readonly episodeIds: readonly string[];
  readonly completeness: Completeness;
  readonly diagnostics: readonly Diagnostic[];
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

interface IngestTally {
  readonly diagnostics: Diagnostic[];
  readonly observationIds: string[];
  readonly measurementIds: string[];
  readonly episodeIds: string[];
  readonly observationCompleteness: Completeness[];
  duplicates: number;
}

function provenanceFor(
  registration: RegisteredSource<unknown>,
  adapter: EvidenceSource<unknown>,
  sourceRevision: string,
  sourceRecordId: string,
  contentDigest: string,
  completeness: Completeness,
): Provenance {
  return {
    sourceId: registration.id,
    adapterVersion: adapter.descriptor.adapterVersion,
    // The registered source itself is the reference; per-record linkage lives
    // in recordRef. Richer refs arrive with the transcript adapters (M2).
    sourceRef: registration.id,
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
  sourceRevision: string,
  operationId: string,
  tally: IngestTally,
): Promise<void> {
  const transformed = await contentPolicy.transform(projected.data);
  tally.diagnostics.push(...transformed.diagnostics);
  if (transformed.diagnostics.some((diagnostic) => diagnostic.severity === "error")) return;
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
      sourceRevision,
      projected.sourceRecordId,
      recordDigest(transformed.accepted),
      projected.completeness,
    ),
    data: transformed.accepted,
  };
  const status = await createOnly(context, "observation", id, parseObservation(record), operationId);
  if (status === "created") tally.observationIds.push(id);
  else if (status === "exists_same") tally.duplicates += 1;
  else tally.diagnostics.push(conflictDiagnostic("observation", id));
  tally.observationCompleteness.push(projected.completeness);
}

async function ingestEpisode(
  context: EngineContext,
  registration: RegisteredSource<unknown>,
  projected: ProjectedEpisode,
  operationId: string,
  tally: IngestTally,
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
  const status = await createOnly(context, "episode", id, parseEpisodeRecord(record), operationId);
  if (status === "created") tally.episodeIds.push(id);
  else if (status === "exists_same") tally.duplicates += 1;
  else tally.diagnostics.push(conflictDiagnostic("episode", id));
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

  const receiptId = context.ids.next("ingest");
  const tally: IngestTally = {
    diagnostics: [],
    observationIds: [],
    measurementIds: [],
    episodeIds: [],
    observationCompleteness: [],
    duplicates: 0,
  };
  let sourceRevision: string | undefined;
  let pageIndex = 0;

  for await (const rawPage of adapter.read(sourceInput, options?.cursor)) {
    const pagePath = ["pages", pageIndex] as const;
    const page = parseEvidencePageEnvelope(rawPage, pagePath);
    sourceRevision = page.sourceRevision;
    tally.diagnostics.push(...page.diagnostics);
    for (const [index, raw] of page.observations.entries()) {
      try {
        const projected = parseProjectedObservationAt(raw, [...pagePath, "observations", index]);
        const operationId = `${receiptId}/observations/${projected.sourceRecordId}`;
        await ingestObservation(
          context,
          registration,
          adapter,
          contentPolicy,
          projected,
          page.sourceRevision,
          operationId,
          tally,
        );
      } catch (error) {
        tally.diagnostics.push(...errorDiagnostics(error));
      }
    }
    // Measurements stamp the fold of the observations that arrived in the
    // same ingest call so far; projections carry no per-measurement
    // completeness of their own ("unknown" when no observations came along).
    const pageFold = foldCompleteness(tally.observationCompleteness, "unknown");
    for (const [index, raw] of page.measurements.entries()) {
      try {
        const projected = parseProjectedMeasurementAt(raw, [...pagePath, "measurements", index]);
        const id = derivedRecordId(registration.id, projected.sourceRecordId);
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
            page.sourceRevision,
            projected.sourceRecordId,
            recordDigest({ metric: { ...projected.metric }, value: projected.value }),
            pageFold,
          ),
        };
        const operationId = `${receiptId}/measurements/${projected.sourceRecordId}`;
        const status = await createOnly(context, "measurement", id, parseMeasurementRecord(record), operationId);
        if (status === "created") tally.measurementIds.push(id);
        else if (status === "exists_same") tally.duplicates += 1;
        else tally.diagnostics.push(conflictDiagnostic("measurement", id));
      } catch (error) {
        tally.diagnostics.push(...errorDiagnostics(error));
      }
    }
    for (const [index, raw] of page.episodes.entries()) {
      try {
        const projected = parseProjectedEpisodeAt(raw, [...pagePath, "episodes", index]);
        const operationId = `${receiptId}/episodes/${projected.sourceRecordId}`;
        await ingestEpisode(context, registration, projected, operationId, tally);
      } catch (error) {
        tally.diagnostics.push(...errorDiagnostics(error));
      }
    }
    pageIndex += 1;
  }

  if (tally.duplicates > 0) {
    tally.diagnostics.push({
      code: "ingest.duplicate",
      severity: "info",
      message: `${tally.duplicates} record(s) were already stored with identical content (idempotent re-ingest); they are not net-new`,
      details: { count: tally.duplicates },
    });
  }
  return {
    id: receiptId,
    sourceId: registration.id,
    sourceRevision: sourceRevision ?? "unknown",
    registryRevision: context.registryRevision,
    observationIds: tally.observationIds,
    measurementIds: tally.measurementIds,
    episodeIds: tally.episodeIds,
    completeness: foldCompleteness(tally.observationCompleteness, "unknown"),
    diagnostics: tally.diagnostics,
  };
}
