// Collision-safe, receipt-bound evidence lineage for Candidate schema v2.
// References contain only durable, privacy-treated identities and digests;
// they never grant trust or turn evidence into a candidate by themselves.
import { sha256HexOfCanonicalJson } from "../canonical/canonical-json.js";
import { toJsonValue } from "../canonical/to-json-value.js";
import { invalid, parseNonEmptyText, parseOneOf, readFields } from "../parse/toolkit.js";
import type { Parse } from "../parse/toolkit.js";
import type { Completeness, TrustClass } from "./provenance.js";
import { COMPLETENESS_VALUES, TRUST_CLASSES } from "./provenance.js";

const EVIDENCE_KINDS = ["observation", "measurement"] as const;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const PAGE_RECEIPT_ID_PATTERN = /^source-page-[0-9a-f]{64}$/;
const MAX_REFERENCE_LENGTH = 1_000;
const MAX_DURABLE_ID_LENGTH = 4_096;

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

export interface EvidenceRef {
  readonly schemaVersion: 1;
  readonly kind: (typeof EVIDENCE_KINDS)[number];
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
  readonly episode: {
    readonly sourceId: string;
    readonly episodeId: string;
    readonly episodeRecordId: string;
    readonly episodeRecordDigest: string;
    readonly episodeIdentityDigest: string;
    readonly scopeDigest: string;
    readonly pageReceiptId: string;
    readonly pageReceiptDigest: string;
  };
  readonly referenceDigest: string;
}

/** Binds every lineage field except the schema marker and digest itself. */
export function evidenceRefDigest(input: Omit<EvidenceRef, "schemaVersion" | "referenceDigest">): string {
  return sha256HexOfCanonicalJson(
    toJsonValue({
      kind: input.kind,
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
    }),
  );
}

const parseEpisodeAt: Parse<EvidenceRef["episode"]> = (input, path) => {
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

export const parseEvidenceRefAt: Parse<EvidenceRef> = (input, path) => {
  const fields = readFields(input, path);
  const reference: EvidenceRef = {
    schemaVersion: fields.schemaVersion1(),
    kind: fields.req("kind", parseOneOf(EVIDENCE_KINDS)),
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
    referenceDigest: fields.req("referenceDigest", parseDigestAt),
  };

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
  const recomputed = evidenceRefDigest(reference);
  if (reference.referenceDigest !== recomputed) {
    throw invalid("schema.corrupt", "evidence reference digest does not match its bound fields", [
      ...path,
      "referenceDigest",
    ]);
  }
  return reference;
};

export function parseEvidenceRef(input: unknown): EvidenceRef {
  return parseEvidenceRefAt(input, []);
}
