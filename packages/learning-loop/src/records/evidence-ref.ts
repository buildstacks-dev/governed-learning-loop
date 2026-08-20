// Collision-safe, receipt-bound evidence lineage for Candidate schema v2.
// Schema-v1 references remain byte-stable audit records. Schema-v2 measurement
// references additionally bind the exact supporting observation references.
import { sha256HexOfCanonicalJson } from "../canonical/canonical-json.js";
import { toJsonValue } from "../canonical/to-json-value.js";
import { invalid, parseArrayOf, parseNonEmptyText, parseOneOf, readFields } from "../parse/toolkit.js";
import type { Parse } from "../parse/toolkit.js";
import type { Completeness, TrustClass } from "./provenance.js";
import { COMPLETENESS_VALUES, TRUST_CLASSES } from "./provenance.js";

const V1_EVIDENCE_KINDS = ["observation", "measurement"] as const;
const MEASUREMENT_KIND = ["measurement"] as const;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const PAGE_RECEIPT_ID_PATTERN = /^source-page-[0-9a-f]{64}$/;
const MAX_REFERENCE_LENGTH = 1_000;
const MAX_DURABLE_ID_LENGTH = 4_096;
const MAX_SUPPORTING_EVIDENCE_REFS = 1_000;

function parseBoundedControlFreeText(maximumLength: number, label: string): Parse<string> {
  return (input, path) => {
    const value = parseNonEmptyText(input, path);
    if (value.length > maximumLength) {
      throw invalid("schema.invalid", `${label} exceeds ${maximumLength} characters`, path);
    }
    for (const character of value) {
      const code = character.codePointAt(0) ?? 0;
      if (code < 0x20 || code === 0x7f) {
        throw invalid("schema.invalid", `${label} contains a control character`, path);
      }
    }
    return value;
  };
}

const parseReference = parseBoundedControlFreeText(MAX_REFERENCE_LENGTH, "reference");
const parseDurableId = parseBoundedControlFreeText(MAX_DURABLE_ID_LENGTH, "durable id");

const parseSourceIdAt: Parse<string> = (input, path) => {
  const sourceId = parseReference(input, path);
  if (sourceId.includes("/")) {
    throw invalid("schema.invalid", "source id contains the reserved durable-id separator", path);
  }
  return sourceId;
};

const parseDigestAt: Parse<string> = (input, path) => {
  const digest = parseNonEmptyText(input, path);
  if (!DIGEST_PATTERN.test(digest)) {
    throw invalid("schema.invalid", "expected a lowercase SHA-256 digest", path);
  }
  return digest;
};

const parsePageReceiptIdAt: Parse<string> = (input, path) => {
  const id = parseDurableId(input, path);
  if (!PAGE_RECEIPT_ID_PATTERN.test(id)) {
    throw invalid("schema.invalid", "page receipt id is not content-addressed", path);
  }
  return id;
};

interface EvidenceEpisodeRef {
  readonly sourceId: string;
  readonly episodeId: string;
  readonly episodeRecordId: string;
  readonly episodeRecordDigest: string;
  readonly episodeIdentityDigest: string;
  readonly scopeDigest: string;
  readonly pageReceiptId: string;
  readonly pageReceiptDigest: string;
}

interface EvidenceRefCommon {
  readonly recordId: string;
  readonly recordDigest: string;
  readonly sourceId: string;
  readonly sourceRegistrationRevision: string;
  readonly sourceRef: string;
  readonly sourceRevision: string;
  readonly sourceRecordId: string;
  readonly pageRef: string;
  readonly pageReceiptId: string;
  readonly pageReceiptDigest: string;
  readonly loopRegistryRevision: string;
  readonly trust: TrustClass;
  readonly completeness: Completeness;
  readonly episode: EvidenceEpisodeRef;
}

/** Historical reference shape. A v1 measurement reference is audit-only and unqualified. */
export interface EvidenceRefV1 extends EvidenceRefCommon {
  readonly schemaVersion: 1;
  readonly kind: (typeof V1_EVIDENCE_KINDS)[number];
  readonly referenceDigest: string;
}

export type ObservationEvidenceRef = EvidenceRefV1 & { readonly kind: "observation" };

/** Qualified measurement lineage binds the exact observations that support it. */
export interface MeasurementEvidenceRefV2 extends EvidenceRefCommon {
  readonly schemaVersion: 2;
  readonly kind: "measurement";
  readonly supportingEvidenceRefs: readonly ObservationEvidenceRef[];
  readonly referenceDigest: string;
}

export type EvidenceRef = EvidenceRefV1 | MeasurementEvidenceRefV2;

type EvidenceRefDigestInput =
  | Omit<EvidenceRefV1, "schemaVersion" | "referenceDigest">
  | Omit<MeasurementEvidenceRefV2, "referenceDigest">;

function commonDigestFields(input: EvidenceRefCommon): {
  readonly kindless: {
    readonly recordId: string;
    readonly recordDigest: string;
    readonly sourceId: string;
    readonly sourceRegistrationRevision: string;
    readonly sourceRef: string;
    readonly sourceRevision: string;
    readonly sourceRecordId: string;
    readonly pageRef: string;
    readonly pageReceiptId: string;
    readonly pageReceiptDigest: string;
    readonly loopRegistryRevision: string;
    readonly trust: TrustClass;
    readonly completeness: Completeness;
    readonly episode: EvidenceEpisodeRef;
  };
} {
  return {
    kindless: {
      recordId: input.recordId,
      recordDigest: input.recordDigest,
      sourceId: input.sourceId,
      sourceRegistrationRevision: input.sourceRegistrationRevision,
      sourceRef: input.sourceRef,
      sourceRevision: input.sourceRevision,
      sourceRecordId: input.sourceRecordId,
      pageRef: input.pageRef,
      pageReceiptId: input.pageReceiptId,
      pageReceiptDigest: input.pageReceiptDigest,
      loopRegistryRevision: input.loopRegistryRevision,
      trust: input.trust,
      completeness: input.completeness,
      episode: {
        sourceId: input.episode.sourceId,
        episodeId: input.episode.episodeId,
        episodeRecordId: input.episode.episodeRecordId,
        episodeRecordDigest: input.episode.episodeRecordDigest,
        episodeIdentityDigest: input.episode.episodeIdentityDigest,
        scopeDigest: input.episode.scopeDigest,
        pageReceiptId: input.episode.pageReceiptId,
        pageReceiptDigest: input.episode.pageReceiptDigest,
      },
    },
  };
}

function isMeasurementV2DigestInput(
  input: EvidenceRefDigestInput,
): input is Omit<MeasurementEvidenceRefV2, "referenceDigest"> {
  return "schemaVersion" in input && input.schemaVersion === 2;
}

/** V1 bytes are unchanged; V2 includes schemaVersion and full ordered supports. */
export function evidenceRefDigest(input: EvidenceRefDigestInput): string {
  const common = commonDigestFields(input).kindless;
  if (!isMeasurementV2DigestInput(input)) {
    return sha256HexOfCanonicalJson(toJsonValue({ kind: input.kind, ...common }));
  }
  return sha256HexOfCanonicalJson(
    toJsonValue({
      schemaVersion: 2,
      kind: "measurement",
      ...common,
      supportingEvidenceRefs: input.supportingEvidenceRefs.map((reference, index) =>
        toJsonValue(parseObservationEvidenceRefAt(reference, ["supportingEvidenceRefs", index])),
      ),
    }),
  );
}

const parseEpisodeAt: Parse<EvidenceEpisodeRef> = (input, path) => {
  const fields = readFields(input, path);
  return {
    sourceId: fields.req("sourceId", parseSourceIdAt),
    episodeId: fields.req("episodeId", parseReference),
    episodeRecordId: fields.req("episodeRecordId", parseDurableId),
    episodeRecordDigest: fields.req("episodeRecordDigest", parseDigestAt),
    episodeIdentityDigest: fields.req("episodeIdentityDigest", parseDigestAt),
    scopeDigest: fields.req("scopeDigest", parseDigestAt),
    pageReceiptId: fields.req("pageReceiptId", parsePageReceiptIdAt),
    pageReceiptDigest: fields.req("pageReceiptDigest", parseDigestAt),
  };
};

function parseCommonFields(fields: ReturnType<typeof readFields>): EvidenceRefCommon {
  return {
    recordId: fields.req("recordId", parseDurableId),
    recordDigest: fields.req("recordDigest", parseDigestAt),
    sourceId: fields.req("sourceId", parseSourceIdAt),
    sourceRegistrationRevision: fields.req("sourceRegistrationRevision", parseDigestAt),
    sourceRef: fields.req("sourceRef", parseReference),
    sourceRevision: fields.req("sourceRevision", parseDurableId),
    sourceRecordId: fields.req("sourceRecordId", parseReference),
    pageRef: fields.req("pageRef", parseReference),
    pageReceiptId: fields.req("pageReceiptId", parsePageReceiptIdAt),
    pageReceiptDigest: fields.req("pageReceiptDigest", parseDigestAt),
    loopRegistryRevision: fields.req("loopRegistryRevision", parseDigestAt),
    trust: fields.req("trust", parseOneOf(TRUST_CLASSES)),
    completeness: fields.req("completeness", parseOneOf(COMPLETENESS_VALUES)),
    episode: fields.req("episode", parseEpisodeAt),
  };
}

function assertCommonBindings(reference: EvidenceRefCommon, path: readonly (string | number)[]): void {
  if (reference.recordId !== `${reference.sourceId}/${reference.sourceRecordId}`) {
    throw invalid("schema.corrupt", "evidence record id does not match its source ownership", [...path, "recordId"]);
  }
  const sourcePrefix = `${reference.sourceId}/`;
  if (
    reference.episode.sourceId !== reference.sourceId ||
    !reference.episode.episodeRecordId.startsWith(sourcePrefix) ||
    reference.episode.episodeRecordId.length === sourcePrefix.length
  ) {
    throw invalid("schema.corrupt", "episode lineage belongs to another source", [...path, "episode"]);
  }
  if (reference.pageReceiptId !== `source-page-${reference.pageReceiptDigest}`) {
    throw invalid("schema.corrupt", "evidence page receipt id does not match its digest", [...path, "pageReceiptId"]);
  }
  if (reference.episode.pageReceiptId !== `source-page-${reference.episode.pageReceiptDigest}`) {
    throw invalid("schema.corrupt", "episode page receipt id does not match its digest", [
      ...path,
      "episode",
      "pageReceiptId",
    ]);
  }
}

function sameEpisode(left: EvidenceEpisodeRef, right: EvidenceEpisodeRef): boolean {
  return (
    left.sourceId === right.sourceId &&
    left.episodeId === right.episodeId &&
    left.episodeRecordId === right.episodeRecordId &&
    left.episodeRecordDigest === right.episodeRecordDigest &&
    left.episodeIdentityDigest === right.episodeIdentityDigest &&
    left.scopeDigest === right.scopeDigest &&
    left.pageReceiptId === right.pageReceiptId &&
    left.pageReceiptDigest === right.pageReceiptDigest
  );
}

function parseEvidenceRefV1Fields(
  fields: ReturnType<typeof readFields>,
  path: readonly (string | number)[],
): EvidenceRefV1 {
  const reference: EvidenceRefV1 = {
    schemaVersion: 1,
    kind: fields.req("kind", parseOneOf(V1_EVIDENCE_KINDS)),
    ...parseCommonFields(fields),
    referenceDigest: fields.req("referenceDigest", parseDigestAt),
  };
  assertCommonBindings(reference, path);
  const recomputed = evidenceRefDigest(reference);
  if (reference.referenceDigest !== recomputed) {
    throw invalid("schema.corrupt", "evidence reference digest does not match its bound fields", [
      ...path,
      "referenceDigest",
    ]);
  }
  return reference;
}

export const parseObservationEvidenceRefAt: Parse<ObservationEvidenceRef> = (input, path) => {
  const fields = readFields(input, path);
  const schemaVersion = fields.opt("schemaVersion", parseEvidenceRefSchemaVersionAt);
  if (schemaVersion !== 1) {
    throw invalid("schema.invalid", "supporting evidence must be a schema-v1 observation reference", [
      ...path,
      "schemaVersion",
    ]);
  }
  const reference = parseEvidenceRefV1Fields(fields, path);
  if (reference.kind !== "observation") {
    throw invalid("schema.invalid", "supporting evidence must reference an observation", [...path, "kind"]);
  }
  return { ...reference, kind: "observation" };
};

function parseMeasurementEvidenceRefV2Fields(
  fields: ReturnType<typeof readFields>,
  path: readonly (string | number)[],
): MeasurementEvidenceRefV2 {
  const supportingEvidenceRefs = fields.req("supportingEvidenceRefs", parseArrayOf(parseObservationEvidenceRefAt));
  if (supportingEvidenceRefs.length === 0) {
    throw invalid("schema.invalid", "measurement evidence requires at least one supporting observation", [
      ...path,
      "supportingEvidenceRefs",
    ]);
  }
  if (supportingEvidenceRefs.length > MAX_SUPPORTING_EVIDENCE_REFS) {
    throw invalid("schema.invalid", `supportingEvidenceRefs exceeds ${MAX_SUPPORTING_EVIDENCE_REFS} entries`, [
      ...path,
      "supportingEvidenceRefs",
    ]);
  }
  const reference: MeasurementEvidenceRefV2 = {
    schemaVersion: 2,
    kind: fields.req("kind", parseOneOf(MEASUREMENT_KIND)),
    ...parseCommonFields(fields),
    supportingEvidenceRefs,
    referenceDigest: fields.req("referenceDigest", parseDigestAt),
  };
  assertCommonBindings(reference, path);
  const supportDigests = new Set<string>();
  const supportRecordIds = new Set<string>();
  for (const [index, support] of supportingEvidenceRefs.entries()) {
    if (
      support.sourceId !== reference.sourceId ||
      support.sourceRegistrationRevision !== reference.sourceRegistrationRevision ||
      support.sourceRef !== reference.sourceRef ||
      support.sourceRevision !== reference.sourceRevision ||
      support.loopRegistryRevision !== reference.loopRegistryRevision ||
      !sameEpisode(support.episode, reference.episode)
    ) {
      throw invalid("schema.corrupt", "supporting observation belongs to another source revision or episode", [
        ...path,
        "supportingEvidenceRefs",
        index,
      ]);
    }
    if (supportDigests.has(support.referenceDigest) || supportRecordIds.has(support.recordId)) {
      throw invalid("schema.invalid", "supporting observation references must be unique", [
        ...path,
        "supportingEvidenceRefs",
        index,
      ]);
    }
    supportDigests.add(support.referenceDigest);
    supportRecordIds.add(support.recordId);
  }
  const recomputed = evidenceRefDigest(reference);
  if (reference.referenceDigest !== recomputed) {
    throw invalid("schema.corrupt", "measurement evidence reference digest does not match its bound fields", [
      ...path,
      "referenceDigest",
    ]);
  }
  return reference;
}

const parseEvidenceRefSchemaVersionAt: Parse<1 | 2> = (input, path) => {
  if (input !== 1 && input !== 2) {
    throw invalid("schema.unsupported_version", "EvidenceRef schemaVersion must be 1 or 2", path);
  }
  return input;
};

export const parseMeasurementEvidenceRefV2At: Parse<MeasurementEvidenceRefV2> = (input, path) => {
  const fields = readFields(input, path);
  const schemaVersion = fields.opt("schemaVersion", parseEvidenceRefSchemaVersionAt);
  if (schemaVersion !== 2) {
    throw invalid("schema.invalid", "qualified measurement evidence requires schemaVersion 2", [
      ...path,
      "schemaVersion",
    ]);
  }
  return parseMeasurementEvidenceRefV2Fields(fields, path);
};

export const parseEvidenceRefAt: Parse<EvidenceRef> = (input, path) => {
  const fields = readFields(input, path);
  const schemaVersion = fields.opt("schemaVersion", parseEvidenceRefSchemaVersionAt);
  if (schemaVersion === undefined) {
    throw invalid("schema.unsupported_version", "EvidenceRef schemaVersion is required", [...path, "schemaVersion"]);
  }
  return schemaVersion === 1
    ? parseEvidenceRefV1Fields(fields, path)
    : parseMeasurementEvidenceRefV2Fields(fields, path);
};

export function parseEvidenceRef(input: unknown): EvidenceRef {
  return parseEvidenceRefAt(input, []);
}
