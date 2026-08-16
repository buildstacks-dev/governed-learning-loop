// Evidence-page boundary parsers. Pages and projections arrive from adapter
// code, which is a trust boundary: everything is re-validated from `unknown`
// here regardless of the adapter's TypeScript types. The page envelope keeps
// its record arrays as raw `unknown` elements so ingest can convert a single
// malformed projection into a diagnostic without discarding its siblings.
import type { Diagnostic } from "../diagnostics.js";
import { LearningLoopError } from "../diagnostics.js";
import {
  parseArrayOf,
  parseJson,
  parseNonEmptyText,
  parseOneOf,
  parseScalar,
  parseText,
  readFields,
} from "../parse/toolkit.js";
import type { Parse } from "../parse/toolkit.js";
import type { ProjectedEpisode, ProjectedMeasurement, ProjectedObservation } from "../ports/evidence.js";
import { parseMetricDefinition, parseScopeShapeAt } from "../records/episode.js";
import { COMPLETENESS_VALUES } from "../records/provenance.js";

const OUTCOME_STATUSES = ["succeeded", "failed", "cancelled", "unknown"] as const;
const DIAGNOSTIC_SEVERITIES = ["info", "warning", "error"] as const;

/** Re-prefixes the diagnostics of a root-anchored parser with the local path. */
function atPath<T>(parse: (input: unknown) => T): Parse<T> {
  return (input, path) => {
    try {
      return parse(input);
    } catch (error) {
      if (error instanceof LearningLoopError) {
        const prefixed = error.diagnostics.map((diagnostic) => ({
          ...diagnostic,
          path: [...path, ...(diagnostic.path ?? [])],
        }));
        throw new LearningLoopError(error.code, prefixed);
      }
      throw error;
    }
  };
}

const parseUnknown: Parse<unknown> = (input) => input;

const parseScalarPathSegment: Parse<string | number> = (input, path) => {
  const value = parseScalar(input, path);
  if (typeof value === "boolean") {
    throw new LearningLoopError("schema.invalid", [
      { code: "schema.invalid", severity: "error", message: "diagnostic path segments are strings or numbers", path },
    ]);
  }
  return value;
};

const parseDiagnosticAt: Parse<Diagnostic> = (input, path) => {
  const fields = readFields(input, path);
  const diagnosticPath = fields.opt("path", parseArrayOf(parseScalarPathSegment));
  const details = fields.opt("details", parseJson);
  return {
    code: fields.req("code", parseNonEmptyText),
    severity: fields.req("severity", parseOneOf(DIAGNOSTIC_SEVERITIES)),
    message: fields.req("message", parseText),
    ...(diagnosticPath !== undefined ? { path: diagnosticPath } : {}),
    ...(details !== undefined ? { details } : {}),
  };
};

export interface EvidencePageEnvelope {
  readonly sourceRevision: string;
  readonly nextCursor?: string;
  readonly observations: readonly unknown[];
  readonly measurements: readonly unknown[];
  readonly episodes: readonly unknown[];
  readonly diagnostics: readonly Diagnostic[];
}

export const parseEvidencePageEnvelope: Parse<EvidencePageEnvelope> = (input, path) => {
  const fields = readFields(input, path);
  const nextCursor = fields.opt("nextCursor", parseText);
  return {
    sourceRevision: fields.req("sourceRevision", parseNonEmptyText),
    ...(nextCursor !== undefined ? { nextCursor } : {}),
    observations: fields.req("observations", parseArrayOf(parseUnknown)),
    measurements: fields.req("measurements", parseArrayOf(parseUnknown)),
    episodes: fields.req("episodes", parseArrayOf(parseUnknown)),
    diagnostics: fields.req("diagnostics", parseArrayOf(parseDiagnosticAt)),
  };
};

export const parseProjectedObservationAt: Parse<ProjectedObservation> = (input, path) => {
  const fields = readFields(input, path);
  const occurredAt = fields.opt("occurredAt", parseText);
  return {
    sourceRecordId: fields.req("sourceRecordId", parseNonEmptyText),
    episodeId: fields.req("episodeId", parseNonEmptyText),
    ...(occurredAt !== undefined ? { occurredAt } : {}),
    kind: fields.req("kind", parseNonEmptyText),
    data: fields.req("data", parseJson),
    completeness: fields.req("completeness", parseOneOf(COMPLETENESS_VALUES)),
  };
};

export const parseProjectedMeasurementAt: Parse<ProjectedMeasurement> = (input, path) => {
  const fields = readFields(input, path);
  const measuredAt = fields.opt("measuredAt", parseText);
  return {
    sourceRecordId: fields.req("sourceRecordId", parseNonEmptyText),
    episodeId: fields.req("episodeId", parseNonEmptyText),
    metric: fields.req("metric", atPath(parseMetricDefinition)),
    value: fields.req("value", parseScalar),
    evidenceSourceRecordIds: fields.req("evidenceSourceRecordIds", parseArrayOf(parseNonEmptyText)),
    ...(measuredAt !== undefined ? { measuredAt } : {}),
  };
};

export const parseProjectedEpisodeAt: Parse<ProjectedEpisode> = (input, path) => {
  const fields = readFields(input, path);
  const closedAt = fields.opt("closedAt", parseText);
  const status = fields.opt("status", parseOneOf(OUTCOME_STATUSES));
  return {
    sourceRecordId: fields.req("sourceRecordId", parseNonEmptyText),
    episodeId: fields.req("episodeId", parseNonEmptyText),
    scope: fields.req("scope", parseScopeShapeAt),
    openedAt: fields.req("openedAt", parseNonEmptyText),
    ...(closedAt !== undefined ? { closedAt } : {}),
    ...(status !== undefined ? { status } : {}),
    measurementSourceRecordIds: fields.req("measurementSourceRecordIds", parseArrayOf(parseNonEmptyText)),
  };
};
