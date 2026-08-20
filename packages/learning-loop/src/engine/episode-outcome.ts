// Append-only episode outcome claims. Each deterministic claim binds an exact
// episode/source identity and ordered, ownership-qualified measurement refs.
// Later claims append history; they never rewrite or erase earlier attempts.
import { sha256HexOfCanonicalJson } from "../canonical/canonical-json.js";
import { toJsonValue } from "../canonical/to-json-value.js";
import { LearningLoopError } from "../diagnostics.js";
import type { StreamEntry } from "../ports/store.js";
import { invalid, parseArrayOf, parseNonEmptyText, parseOneOf, readFields } from "../parse/toolkit.js";
import type { Parse } from "../parse/toolkit.js";
import type { MeasurementEvidenceRefV2 } from "../records/evidence-ref.js";
import { parseMeasurementEvidenceRefV2At } from "../records/evidence-ref.js";
import type { EpisodeOutcome } from "../records/episode.js";
import type { EngineContext } from "./context.js";
import { loadStoredRecord, parseWriteResult, recordDigest, recordKey } from "./context.js";

const MAX_APPEND_ATTEMPTS = 8;
const MAX_MEASUREMENT_REFS = 1_000;
const MAX_REFERENCE_LENGTH = 1_000;
const MAX_DURABLE_ID_LENGTH = 4_096;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const OUTCOME_STATUSES = ["succeeded", "failed", "cancelled", "unknown"] as const;

export interface EpisodeOutcomeClaim {
  readonly schemaVersion: 1;
  readonly episodeRecordId: string;
  readonly sourceId: string;
  readonly sourceRegistrationRevision: string;
  readonly sourceRef: string;
  readonly sourceRevision: string;
  readonly episodeId: string;
  readonly status: EpisodeOutcome["status"];
  readonly measurementRefs: readonly MeasurementEvidenceRefV2[];
  readonly claimDigest: string;
}

export type EpisodeOutcomeClaimInput = Omit<EpisodeOutcomeClaim, "schemaVersion" | "claimDigest">;

export type EpisodeOutcomeClaimState =
  | {
      readonly status: "missing";
      readonly attemptCount: 0;
      readonly historyDigests: readonly string[];
    }
  | {
      readonly status: "resolved";
      readonly latest: EpisodeOutcomeClaim;
      readonly attemptCount: number;
      readonly historyDigests: readonly string[];
    };

interface StoredOutcomeClaim {
  readonly id: string;
  readonly digest: string;
  readonly value: EpisodeOutcomeClaim;
}

function parseBoundedControlFreeText(maximumLength: number, label: string): Parse<string> {
  return (input, path) => {
    const value = parseNonEmptyText(input, path);
    if (value.length > maximumLength)
      throw invalid("schema.invalid", `${label} exceeds ${maximumLength} characters`, path);
    for (const character of value) {
      const code = character.codePointAt(0) ?? 0;
      if (code < 0x20 || code === 0x7f) throw invalid("schema.invalid", `${label} contains a control character`, path);
    }
    return value;
  };
}

const parseReference = parseBoundedControlFreeText(MAX_REFERENCE_LENGTH, "reference");
const parseDurableId = parseBoundedControlFreeText(MAX_DURABLE_ID_LENGTH, "durable id");

const parseSourceIdAt: Parse<string> = (input, path) => {
  const sourceId = parseReference(input, path);
  if (sourceId.includes("/"))
    throw invalid("schema.invalid", "source id contains the reserved durable-id separator", path);
  return sourceId;
};

const parseDigestAt: Parse<string> = (input, path) => {
  const digest = parseNonEmptyText(input, path);
  if (!DIGEST_PATTERN.test(digest)) throw invalid("schema.invalid", "expected a lowercase SHA-256 digest", path);
  return digest;
};

const parseMeasurementEvidenceRefAt: Parse<MeasurementEvidenceRefV2> = (input, path) => {
  return parseMeasurementEvidenceRefV2At(input, path);
};

function episodeOutcomeClaimDigest(input: EpisodeOutcomeClaimInput): string {
  return sha256HexOfCanonicalJson(
    toJsonValue({
      episodeRecordId: input.episodeRecordId,
      sourceId: input.sourceId,
      sourceRegistrationRevision: input.sourceRegistrationRevision,
      sourceRef: input.sourceRef,
      sourceRevision: input.sourceRevision,
      episodeId: input.episodeId,
      status: input.status,
      measurementRefs: input.measurementRefs.map((reference) => toJsonValue(reference)),
    }),
  );
}

function validateMeasurementOwnership(claim: EpisodeOutcomeClaim, path: readonly (string | number)[]): void {
  const referenceDigests = new Set<string>();
  const recordIds = new Set<string>();
  for (const [index, reference] of claim.measurementRefs.entries()) {
    const referencePath = [...path, "measurementRefs", index];
    if (
      reference.schemaVersion !== 2 ||
      reference.kind !== "measurement" ||
      reference.sourceId !== claim.sourceId ||
      reference.sourceRegistrationRevision !== claim.sourceRegistrationRevision ||
      reference.sourceRef !== claim.sourceRef ||
      reference.sourceRevision !== claim.sourceRevision ||
      reference.episode.sourceId !== claim.sourceId ||
      reference.episode.episodeId !== claim.episodeId ||
      reference.episode.episodeRecordId !== claim.episodeRecordId
    ) {
      throw invalid(
        "schema.corrupt",
        "measurement evidence does not belong to the exact episode outcome source",
        referencePath,
      );
    }
    if (referenceDigests.has(reference.referenceDigest) || recordIds.has(reference.recordId)) {
      throw invalid("schema.corrupt", "episode outcome measurement references must be unique", referencePath);
    }
    referenceDigests.add(reference.referenceDigest);
    recordIds.add(reference.recordId);
  }
}

const parseEpisodeOutcomeClaimAt: Parse<EpisodeOutcomeClaim> = (input, path) => {
  const fields = readFields(input, path);
  const schemaVersion = fields.schemaVersion1();
  const measurementRefs = fields.req("measurementRefs", parseArrayOf(parseMeasurementEvidenceRefAt));
  if (measurementRefs.length > MAX_MEASUREMENT_REFS) {
    throw invalid("schema.invalid", `measurementRefs exceeds ${MAX_MEASUREMENT_REFS} entries`, [
      ...path,
      "measurementRefs",
    ]);
  }
  const claim: EpisodeOutcomeClaim = {
    schemaVersion,
    episodeRecordId: fields.req("episodeRecordId", parseDurableId),
    sourceId: fields.req("sourceId", parseSourceIdAt),
    sourceRegistrationRevision: fields.req("sourceRegistrationRevision", parseDigestAt),
    sourceRef: fields.req("sourceRef", parseReference),
    sourceRevision: fields.req("sourceRevision", parseDurableId),
    episodeId: fields.req("episodeId", parseReference),
    status: fields.req("status", parseOneOf(OUTCOME_STATUSES)),
    measurementRefs,
    claimDigest: fields.req("claimDigest", parseDigestAt),
  };
  const sourcePrefix = `${claim.sourceId}/`;
  if (!claim.episodeRecordId.startsWith(sourcePrefix) || claim.episodeRecordId.length === sourcePrefix.length) {
    throw invalid("schema.corrupt", "episode outcome record belongs to another source", [...path, "episodeRecordId"]);
  }
  validateMeasurementOwnership(claim, path);
  const recomputed = episodeOutcomeClaimDigest(claim);
  if (claim.claimDigest !== recomputed) {
    throw invalid("schema.corrupt", "episode outcome claim digest does not match its bound fields", [
      ...path,
      "claimDigest",
    ]);
  }
  return claim;
};

export function parseEpisodeOutcomeClaim(input: unknown): EpisodeOutcomeClaim {
  return parseEpisodeOutcomeClaimAt(input, []);
}

export function buildEpisodeOutcomeClaim(input: EpisodeOutcomeClaimInput): EpisodeOutcomeClaim {
  const claimDigest = episodeOutcomeClaimDigest(input);
  return parseEpisodeOutcomeClaim({ schemaVersion: 1, ...input, claimDigest });
}

function outcomeEntry(claim: EpisodeOutcomeClaim): StreamEntry {
  const value = toJsonValue(claim);
  return { id: `outcome:${claim.claimDigest}`, digest: recordDigest(value), value };
}

const parseStoredOutcomeClaimAt: Parse<StoredOutcomeClaim> = (input, path) => {
  const fields = readFields(input, path);
  const id = fields.req("id", parseNonEmptyText);
  const digest = fields.req("digest", parseDigestAt);
  const value = fields.req("value", parseEpisodeOutcomeClaimAt);
  const expectedDigest = recordDigest(toJsonValue(value));
  if (id !== `outcome:${value.claimDigest}` || digest !== expectedDigest) {
    throw invalid("schema.corrupt", "stored episode outcome entry does not match its claim binding", path);
  }
  return { id, digest, value };
};

function parseStoredClaims(input: unknown): readonly StoredOutcomeClaim[] {
  return parseArrayOf(parseStoredOutcomeClaimAt)(input, ["episodeOutcomeClaims"]);
}

function foldClaims(claims: readonly StoredOutcomeClaim[], episodeRecordId: string): EpisodeOutcomeClaimState {
  if (claims.length === 0) return { status: "missing", attemptCount: 0, historyDigests: [] };
  const historyDigests: string[] = [];
  const entryIds = new Set<string>();
  const claimDigests = new Set<string>();
  let latest: EpisodeOutcomeClaim | undefined;
  for (const [index, entry] of claims.entries()) {
    if (entry.value.episodeRecordId !== episodeRecordId) {
      throw invalid("store.corrupt", "episode outcome stream contains a claim for another episode record", [
        "episodeOutcomeClaims",
        index,
        "value",
        "episodeRecordId",
      ]);
    }
    if (entryIds.has(entry.id) || claimDigests.has(entry.value.claimDigest)) {
      throw invalid("store.corrupt", "episode outcome stream contains a duplicate claim", [
        "episodeOutcomeClaims",
        index,
      ]);
    }
    entryIds.add(entry.id);
    claimDigests.add(entry.value.claimDigest);
    historyDigests.push(entry.value.claimDigest);
    latest = entry.value;
  }
  if (latest === undefined) return { status: "missing", attemptCount: 0, historyDigests: [] };
  return { status: "resolved", latest, attemptCount: claims.length, historyDigests };
}

export async function loadLatestEpisodeOutcomeClaim(
  context: EngineContext,
  episodeRecordId: string,
): Promise<EpisodeOutcomeClaimState> {
  const stored = await loadStoredRecord(context, "episode-outcome", episodeRecordId);
  return stored === undefined
    ? { status: "missing", attemptCount: 0, historyDigests: [] }
    : foldClaims(parseStoredClaims(stored.value), episodeRecordId);
}

export async function persistEpisodeOutcomeClaim(
  context: EngineContext,
  input: EpisodeOutcomeClaim,
): Promise<"created" | "appended" | "exists_same"> {
  const claim = parseEpisodeOutcomeClaim(input);
  const entry = outcomeEntry(claim);
  for (let attempt = 0; attempt < MAX_APPEND_ATTEMPTS; attempt += 1) {
    const stored = await loadStoredRecord(context, "episode-outcome", claim.episodeRecordId);
    const claims = stored === undefined ? [] : parseStoredClaims(stored.value);
    const current = foldClaims(claims, claim.episodeRecordId);
    if (current.historyDigests.includes(claim.claimDigest)) return "exists_same";

    const rawResult: unknown = await context.store.append(
      recordKey("episode-outcome", claim.episodeRecordId),
      stored?.revision,
      [entry],
      `episode-outcome/${claim.episodeRecordId}/${entry.id}`,
    );
    const write = parseWriteResult(rawResult);
    if (write.status === "created" || write.status === "updated" || write.status === "exists_same") {
      const committed = await loadLatestEpisodeOutcomeClaim(context, claim.episodeRecordId);
      if (!committed.historyDigests.includes(claim.claimDigest)) {
        throw invalid("store.corrupt", "store acknowledged an episode outcome append without preserving its claim", [
          "episodeRecordId",
        ]);
      }
      return current.status === "missing" ? "created" : "appended";
    }
  }
  throw new LearningLoopError("store.conflict", [
    {
      code: "store.conflict",
      severity: "error",
      message: "episode outcome stream changed concurrently too many times",
    },
  ]);
}
