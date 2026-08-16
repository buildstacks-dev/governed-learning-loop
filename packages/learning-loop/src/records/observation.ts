// Observation (contract §Observation). Unknown kinds are retained and
// surfaced; they never silently become trusted or metric-bearing.
import type { JsonValue } from "../canonical/json.js";
import { parseJson, parseNonEmptyText, parseText, readFields } from "../parse/toolkit.js";
import type { Provenance } from "./provenance.js";
import { parseProvenanceAt } from "./provenance.js";

export interface Observation {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly episodeId: string;
  readonly occurredAt?: string;
  readonly kind: string;
  readonly provenance: Provenance;
  readonly data: JsonValue;
}

export function parseObservation(input: unknown): Observation {
  const fields = readFields(input, []);
  const schemaVersion = fields.schemaVersion1();
  const occurredAt = fields.opt("occurredAt", parseText);
  return {
    schemaVersion,
    id: fields.req("id", parseNonEmptyText),
    episodeId: fields.req("episodeId", parseNonEmptyText),
    ...(occurredAt !== undefined ? { occurredAt } : {}),
    kind: fields.req("kind", parseNonEmptyText),
    provenance: fields.req("provenance", parseProvenanceAt),
    data: fields.req("data", parseJson),
  };
}
