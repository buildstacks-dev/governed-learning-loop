// Episode, metric, and measurement records (contract §Episode).
// Missing or invalid measurement is never zero and never a pass.
import {
  invalid,
  parseArrayOf,
  parseNonEmptyText,
  parseOneOf,
  parseScalar,
  parseText,
  readFields,
} from "../parse/toolkit.js";
import type { Parse } from "../parse/toolkit.js";
import type { Provenance } from "./provenance.js";
import { parseProvenanceAt } from "./provenance.js";
import type { Scope, ScopeSegment } from "./scope.js";

export interface MetricDefinition {
  readonly name: string;
  readonly valueType: "number" | "string" | "boolean";
  readonly unit: string;
  readonly aggregation: "all" | "any" | "mean" | "median" | "sum";
  readonly comparabilityPolicyDigest?: string;
}

export interface MeasurementRecord {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly episodeId: string;
  readonly metric: MetricDefinition;
  readonly value: number | string | boolean;
  readonly evidenceIds: readonly string[];
  readonly measuredAt?: string;
  readonly provenance: Provenance;
}

export interface EpisodeOutcome {
  readonly status: "succeeded" | "failed" | "cancelled" | "unknown";
  readonly measurementIds: readonly string[];
}

export interface EpisodeRecord {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly scope: Scope;
  readonly openedAt: string;
  readonly closedAt?: string;
  readonly sourceRefs: readonly string[];
  readonly outcome?: EpisodeOutcome;
  readonly fingerprintId?: string;
  readonly exposureIds: readonly string[];
}

const METRIC_VALUE_TYPES = ["number", "string", "boolean"] as const;
const METRIC_AGGREGATIONS = ["all", "any", "mean", "median", "sum"] as const;
const OUTCOME_STATUSES = ["succeeded", "failed", "cancelled", "unknown"] as const;
const MAX_METRIC_NAME_LENGTH = 1_000;

const parseMetricName: Parse<string> = (input, path) => {
  const value = parseNonEmptyText(input, path);
  if (value.length > MAX_METRIC_NAME_LENGTH) {
    throw invalid("schema.invalid", `metric name exceeds ${MAX_METRIC_NAME_LENGTH} characters`, path);
  }
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) {
      throw invalid("schema.invalid", "metric name contains a control character", path);
    }
  }
  return value;
};

const parseMetricDefinitionAt: Parse<MetricDefinition> = (input, path) => {
  const fields = readFields(input, path);
  const comparabilityPolicyDigest = fields.opt("comparabilityPolicyDigest", parseText);
  return {
    name: fields.req("name", parseMetricName),
    valueType: fields.req("valueType", parseOneOf(METRIC_VALUE_TYPES)),
    unit: fields.req("unit", parseText),
    aggregation: fields.req("aggregation", parseOneOf(METRIC_AGGREGATIONS)),
    ...(comparabilityPolicyDigest !== undefined ? { comparabilityPolicyDigest } : {}),
  };
};

export function parseMetricDefinition(input: unknown): MetricDefinition {
  return parseMetricDefinitionAt(input, []);
}

export function parseMeasurementRecord(input: unknown): MeasurementRecord {
  const fields = readFields(input, []);
  const schemaVersion = fields.schemaVersion1();
  const measuredAt = fields.opt("measuredAt", parseText);
  const metric = fields.req("metric", parseMetricDefinitionAt);
  const value = fields.req("value", parseScalar);
  if (typeof value !== metric.valueType) {
    throw invalid("schema.invalid", `measurement value must have runtime type ${metric.valueType}`, ["value"]);
  }
  return {
    schemaVersion,
    id: fields.req("id", parseNonEmptyText),
    episodeId: fields.req("episodeId", parseNonEmptyText),
    metric,
    value,
    evidenceIds: fields.req("evidenceIds", parseArrayOf(parseNonEmptyText)),
    ...(measuredAt !== undefined ? { measuredAt } : {}),
    provenance: fields.req("provenance", parseProvenanceAt),
  };
}

const parseEpisodeOutcomeAt: Parse<EpisodeOutcome> = (input, path) => {
  const fields = readFields(input, path);
  return {
    status: fields.req("status", parseOneOf(OUTCOME_STATUSES)),
    measurementIds: fields.req("measurementIds", parseArrayOf(parseNonEmptyText)),
  };
};

// Record parsers validate scope *shape* (segments of non-empty type/id).
// Policy-level constraints (length ceilings, control characters, isolation)
// are the configured ScopePolicy's job at intake time.
export const parseScopeShapeAt: Parse<Scope> = (input, path) => {
  const parseSegment: Parse<ScopeSegment> = (segment, segmentPath) => {
    const fields = readFields(segment, segmentPath);
    return {
      type: fields.req("type", parseNonEmptyText),
      id: fields.req("id", parseNonEmptyText),
    };
  };
  return parseArrayOf(parseSegment)(input, path);
};

export function parseEpisodeRecord(input: unknown): EpisodeRecord {
  const fields = readFields(input, []);
  const schemaVersion = fields.schemaVersion1();
  const closedAt = fields.opt("closedAt", parseText);
  const outcome = fields.opt("outcome", parseEpisodeOutcomeAt);
  const fingerprintId = fields.opt("fingerprintId", parseText);
  return {
    schemaVersion,
    id: fields.req("id", parseNonEmptyText),
    scope: fields.req("scope", parseScopeShapeAt),
    openedAt: fields.req("openedAt", parseNonEmptyText),
    ...(closedAt !== undefined ? { closedAt } : {}),
    sourceRefs: fields.req("sourceRefs", parseArrayOf(parseNonEmptyText)),
    ...(outcome !== undefined ? { outcome } : {}),
    ...(fingerprintId !== undefined ? { fingerprintId } : {}),
    exposureIds: fields.req("exposureIds", parseArrayOf(parseNonEmptyText)),
  };
}
