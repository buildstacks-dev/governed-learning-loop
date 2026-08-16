// Source provenance and trust (contract §Source provenance and trust).
// Trust is an upper-bound model granted by host registration, never claimed
// by adapters; transcript-derived evidence is capped at "advisory".
import type { JsonValue } from "../canonical/json.js";
import type { Diagnostic } from "../diagnostics.js";
import { parseNonEmptyText, parseOneOf, parseText, readFields } from "../parse/toolkit.js";
import type { Parse } from "../parse/toolkit.js";

export type TrustClass = "untrusted" | "advisory" | "observed" | "verified";

export const TRUST_CLASSES = ["untrusted", "advisory", "observed", "verified"] as const;

export interface SourceDescriptor {
  readonly id: string;
  readonly adapterVersion: string;
}

export interface ContentPolicy {
  readonly id: string;
  readonly digest: string;
  readonly maximumInputBytes: number;
  readonly outboundUse: "forbidden" | "explicit_receipt_required";

  transform(input: unknown): Promise<{
    readonly accepted: JsonValue;
    readonly classification: string;
    readonly diagnostics: readonly Diagnostic[];
  }>;
}

export type Completeness = "complete" | "partial" | "unknown";

export const COMPLETENESS_VALUES = ["complete", "partial", "unknown"] as const;

export interface Provenance {
  readonly sourceId: string;
  readonly adapterVersion: string;
  readonly sourceRef: string;
  readonly sourceRevision: string;
  readonly recordRef?: string;
  readonly contentDigest: string;
  readonly completeness: Completeness;
  readonly trust: TrustClass;
}

export const parseProvenanceAt: Parse<Provenance> = (input, path) => {
  const fields = readFields(input, path);
  const recordRef = fields.opt("recordRef", parseText);
  return {
    sourceId: fields.req("sourceId", parseNonEmptyText),
    adapterVersion: fields.req("adapterVersion", parseNonEmptyText),
    sourceRef: fields.req("sourceRef", parseText),
    sourceRevision: fields.req("sourceRevision", parseText),
    ...(recordRef !== undefined ? { recordRef } : {}),
    contentDigest: fields.req("contentDigest", parseNonEmptyText),
    completeness: fields.req("completeness", parseOneOf(COMPLETENESS_VALUES)),
    trust: fields.req("trust", parseOneOf(TRUST_CLASSES)),
  };
};

export function parseProvenance(input: unknown): Provenance {
  return parseProvenanceAt(input, []);
}
