// Exposure set (contract §Intervention, exposure, and efficacy; decision
// 0027). One resolution yields at most one exposure set, with exactly one
// entry per exact intervention the host applied: the set id is derived from
// the resolution receipt digest (`exposure-<receiptDigest>`), so a second
// acknowledgement of the same resolution with different content is a visible
// refusal, never a second set. Every entry binds the exact intervention and
// the exact content digest the receipt froze. The set carries the host's
// assignment and fingerprint identifiers and the durable, host-observed
// evidence ids that prove the application; a free caller assertion is not
// efficacy evidence. The optional experiment arm binds a declared
// ExperimentDefinition (decision 0028): a treatment exposure applies the
// experiment's intervention and a control exposure does not.
import { sha256HexOfCanonicalJson } from "../canonical/canonical-json.js";
import type { JsonValue } from "../canonical/json.js";
import { invalid, parseOneOf, readFields } from "../parse/toolkit.js";
import type { Parse, ParsePath } from "../parse/toolkit.js";
import { receiptDigestOfResolutionId } from "./resolution.js";
import {
  parseBoundedArray,
  parseCanonicalTimestampAt,
  parseDigestAt,
  parseDurableId,
  parseId,
} from "./semantic-shared.js";

export interface ExposureEntry {
  readonly interventionId: string;
  readonly resolvedContentDigest: string;
}

export interface ExposureSetRecord {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly episodeId: string;
  readonly resolutionReceiptId: string;
  readonly entries: readonly ExposureEntry[];
  readonly assignmentId: string;
  readonly experiment?: {
    readonly experimentId: string;
    readonly arm: "control" | "treatment";
  };
  readonly fingerprintId: string;
  readonly evidenceIds: readonly string[];
  readonly exposedAt: string;
  readonly exposureDigest: string;
}

/** Entries and evidence ids per set are bounded by the resolution entry ceiling. */
export const MAX_EXPOSURE_REFERENCES = 1_000;

const EXPOSURE_DIGEST_DOMAIN = "exposure-set:v1";
const EXPOSURE_ID_PREFIX = "exposure-";
const EXPERIMENT_ARMS = ["control", "treatment"] as const;

/** One resolution receipt owns exactly one exposure set id. */
export function exposureSetIdFor(receiptDigest: string): string {
  return `${EXPOSURE_ID_PREFIX}${receiptDigest}`;
}

const parseExposureEntryAt: Parse<ExposureEntry> = (input, path) => {
  const fields = readFields(input, path);
  return {
    interventionId: fields.req("interventionId", parseDurableId),
    resolvedContentDigest: fields.req("resolvedContentDigest", parseDigestAt),
  };
};

export const parseExposureExperimentAt: Parse<NonNullable<ExposureSetRecord["experiment"]>> = (input, path) => {
  const fields = readFields(input, path);
  return {
    experimentId: fields.req("experimentId", parseDurableId),
    arm: fields.req("arm", parseOneOf(EXPERIMENT_ARMS)),
  };
};

function assertUniqueIds(values: readonly string[], label: string, path: ParsePath): void {
  const seen = new Set<string>();
  for (const [index, value] of values.entries()) {
    if (seen.has(value)) throw invalid("schema.invalid", `${label} must be unique`, [...path, index]);
    seen.add(value);
  }
}

type ExposureContent = Omit<ExposureSetRecord, "schemaVersion" | "id" | "exposureDigest">;

function exposureContent(input: ExposureContent): JsonValue {
  return {
    domain: EXPOSURE_DIGEST_DOMAIN,
    episodeId: input.episodeId,
    resolutionReceiptId: input.resolutionReceiptId,
    entries: input.entries.map((entry) => ({
      interventionId: entry.interventionId,
      resolvedContentDigest: entry.resolvedContentDigest,
    })),
    assignmentId: input.assignmentId,
    ...(input.experiment !== undefined
      ? { experiment: { experimentId: input.experiment.experimentId, arm: input.experiment.arm } }
      : {}),
    fingerprintId: input.fingerprintId,
    evidenceIds: [...input.evidenceIds],
    exposedAt: input.exposedAt,
  };
}

/**
 * Exposure digest: every field except schemaVersion, id, and the digest
 * itself, under a domain-separation tag. It includes `exposedAt`; the engine
 * treats two acknowledgements that differ only there as the same exposure.
 */
export function exposureSetDigest(input: ExposureContent): string {
  return sha256HexOfCanonicalJson(exposureContent(input));
}

/**
 * Unknown-first parser. Requires the set id to derive from the resolution
 * receipt it cites, unique entries per intervention, at least one evidence
 * id, and a digest that matches the content.
 */
export function parseExposureSetRecord(input: unknown): ExposureSetRecord {
  const fields = readFields(input, []);
  const schemaVersion = fields.schemaVersion1();
  const resolutionReceiptId = fields.req("resolutionReceiptId", parseDurableId);
  const receiptDigest = receiptDigestOfResolutionId(resolutionReceiptId);
  if (receiptDigest === undefined) {
    throw invalid("schema.invalid", "exposure set must cite a resolution-<digest> receipt", ["resolutionReceiptId"]);
  }
  const entries = fields.req(
    "entries",
    parseBoundedArray(parseExposureEntryAt, MAX_EXPOSURE_REFERENCES, "exposure entries"),
  );
  assertUniqueIds(
    entries.map((entry) => entry.interventionId),
    "exposure entries per intervention",
    ["entries"],
  );
  const evidenceIds = fields.req(
    "evidenceIds",
    parseBoundedArray(parseDurableId, MAX_EXPOSURE_REFERENCES, "exposure evidence ids"),
  );
  if (evidenceIds.length === 0) {
    throw invalid("schema.invalid", "an exposure set requires host-observed evidence", ["evidenceIds"]);
  }
  assertUniqueIds(evidenceIds, "exposure evidence ids", ["evidenceIds"]);
  const experiment = fields.opt("experiment", parseExposureExperimentAt);
  const content: ExposureContent = {
    episodeId: fields.req("episodeId", parseDurableId),
    resolutionReceiptId,
    entries,
    assignmentId: fields.req("assignmentId", parseId),
    ...(experiment !== undefined ? { experiment } : {}),
    fingerprintId: fields.req("fingerprintId", parseId),
    evidenceIds,
    exposedAt: fields.req("exposedAt", parseCanonicalTimestampAt),
  };
  const exposureDigest = fields.req("exposureDigest", parseDigestAt);
  if (exposureDigest !== exposureSetDigest(content)) {
    throw invalid("schema.corrupt", "exposure set digest does not match its content", ["exposureDigest"]);
  }
  const id = fields.req("id", parseDurableId);
  if (id !== exposureSetIdFor(receiptDigest)) {
    throw invalid("schema.corrupt", "exposure set id does not derive from its resolution receipt", ["id"]);
  }
  return { schemaVersion, id, ...content, exposureDigest };
}

/** Equality of two sets ignoring only the timestamp and digest: the idempotent-retry test. */
export function sameExposureContent(left: ExposureSetRecord, right: ExposureSetRecord): boolean {
  const normalized = (record: ExposureSetRecord): string =>
    sha256HexOfCanonicalJson(
      exposureContent({
        episodeId: record.episodeId,
        resolutionReceiptId: record.resolutionReceiptId,
        entries: record.entries,
        assignmentId: record.assignmentId,
        ...(record.experiment !== undefined ? { experiment: record.experiment } : {}),
        fingerprintId: record.fingerprintId,
        evidenceIds: record.evidenceIds,
        exposedAt: "",
      }),
    );
  return normalized(left) === normalized(right);
}
