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
import type { SourcePageState } from "../records/source-health.js";
import { parseSourcePageStateAt } from "../records/source-health.js";

const OUTCOME_STATUSES = ["succeeded", "failed", "cancelled", "unknown"] as const;
const DIAGNOSTIC_SEVERITIES = ["info", "warning", "error"] as const;
const MAX_PROJECTION_IDENTIFIER_LENGTH = 1_000;

const parseProjectionIdentifier: Parse<string> = (input, path) => {
  const value = parseNonEmptyText(input, path);
  if (value.length > MAX_PROJECTION_IDENTIFIER_LENGTH) {
    throw new LearningLoopError("schema.invalid", [
      {
        code: "schema.invalid",
        severity: "error",
        message: `projection identifier exceeds ${MAX_PROJECTION_IDENTIFIER_LENGTH} characters`,
        path,
      },
    ]);
  }
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) {
      throw new LearningLoopError("schema.invalid", [
        {
          code: "schema.invalid",
          severity: "error",
          message: "projection identifier contains a control character",
          path,
        },
      ]);
    }
  }
  return value;
};

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

export const parseDiagnosticAt: Parse<Diagnostic> = (input, path) => {
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
  readonly sourceRef: string;
  readonly pageRef: string;
  readonly state: SourcePageState;
  readonly nextCursor?: string;
  readonly observations: readonly unknown[];
  readonly measurements: readonly unknown[];
  readonly episodes: readonly unknown[];
  readonly diagnostics: readonly Diagnostic[];
}

export const parseEvidencePageEnvelope: Parse<EvidencePageEnvelope> = (input, path) => {
  const fields = readFields(input, path);
  const nextCursor = fields.opt("nextCursor", parseText);
  const sourceRef = fields.req("sourceRef", parseProjectionIdentifier);
  const pageRef = fields.req("pageRef", parseProjectionIdentifier);
  const state = fields.req("state", parseSourcePageStateAt);
  const observations = fields.req("observations", parseArrayOf(parseUnknown));
  const measurements = fields.req("measurements", parseArrayOf(parseUnknown));
  const episodes = fields.req("episodes", parseArrayOf(parseUnknown));
  if (
    state.status !== "available" &&
    (observations.length !== 0 || measurements.length !== 0 || episodes.length !== 0)
  ) {
    throw new LearningLoopError("schema.invalid", [
      {
        code: "schema.invalid",
        severity: "error",
        message: "an unavailable source page must not contain projections",
        path,
      },
    ]);
  }
  return {
    sourceRef,
    pageRef,
    state,
    ...(nextCursor !== undefined ? { nextCursor } : {}),
    observations,
    measurements,
    episodes,
    diagnostics: fields.req("diagnostics", parseArrayOf(parseDiagnosticAt)),
  };
};

export const parseProjectedObservationAt: Parse<ProjectedObservation> = (input, path) => {
  const fields = readFields(input, path);
  const occurredAt = fields.opt("occurredAt", parseText);
  return {
    sourceRecordId: fields.req("sourceRecordId", parseProjectionIdentifier),
    episodeId: fields.req("episodeId", parseProjectionIdentifier),
    ...(occurredAt !== undefined ? { occurredAt } : {}),
    kind: fields.req("kind", parseProjectionIdentifier),
    data: fields.req("data", parseJson),
    completeness: fields.req("completeness", parseOneOf(COMPLETENESS_VALUES)),
  };
};

export const parseProjectedMeasurementAt: Parse<ProjectedMeasurement> = (input, path) => {
  const fields = readFields(input, path);
  const measuredAt = fields.opt("measuredAt", parseText);
  return {
    sourceRecordId: fields.req("sourceRecordId", parseProjectionIdentifier),
    episodeId: fields.req("episodeId", parseProjectionIdentifier),
    metric: fields.req("metric", atPath(parseMetricDefinition)),
    value: fields.req("value", parseScalar),
    evidenceSourceRecordIds: fields.req("evidenceSourceRecordIds", parseArrayOf(parseProjectionIdentifier)),
    ...(measuredAt !== undefined ? { measuredAt } : {}),
  };
};

export const parseProjectedEpisodeAt: Parse<ProjectedEpisode> = (input, path) => {
  const fields = readFields(input, path);
  const closedAt = fields.opt("closedAt", parseText);
  const status = fields.opt("status", parseOneOf(OUTCOME_STATUSES));
  const completeness = fields.opt("completeness", parseOneOf(COMPLETENESS_VALUES));
  const parentEpisodeId = fields.opt("parentEpisodeId", parseProjectionIdentifier);
  const episodeClass = fields.opt("episodeClass", parseProjectionIdentifier);
  return {
    sourceRecordId: fields.req("sourceRecordId", parseProjectionIdentifier),
    episodeId: fields.req("episodeId", parseProjectionIdentifier),
    ...(parentEpisodeId !== undefined ? { parentEpisodeId } : {}),
    ...(episodeClass !== undefined ? { episodeClass } : {}),
    ...(completeness !== undefined ? { completeness } : {}),
    scope: fields.req("scope", parseScopeShapeAt),
    openedAt: fields.req("openedAt", parseNonEmptyText),
    ...(closedAt !== undefined ? { closedAt } : {}),
    ...(status !== undefined ? { status } : {}),
    measurementSourceRecordIds: fields.req("measurementSourceRecordIds", parseArrayOf(parseNonEmptyText)),
  };
};
