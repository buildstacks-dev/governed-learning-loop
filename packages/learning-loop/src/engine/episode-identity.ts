// Append-only bridge between a durable EpisodeRecord id and every
// adapter-projected logical identity ever claimed for it. One claim resolves;
// two distinct claims are an atomic, durable conflict. Existing EpisodeRecord
// bytes stay unchanged and explicit re-ingest repairs a missing claim.
import { toJsonValue } from "../canonical/to-json-value.js";
import { LearningLoopError } from "../diagnostics.js";
import type { ProjectedEpisode, RegisteredSource } from "../ports/evidence.js";
import type { StreamEntry } from "../ports/store.js";
import { invalid, parseArrayOf, parseNonEmptyText, parseOneOf, readFields } from "../parse/toolkit.js";
import type { Parse } from "../parse/toolkit.js";
import type { Completeness, TrustClass } from "../records/provenance.js";
import { COMPLETENESS_VALUES, TRUST_CLASSES } from "../records/provenance.js";
import type { EngineContext } from "./context.js";
import { derivedRecordId, loadStoredRecord, parseWriteResult, recordDigest, recordKey } from "./context.js";

const MAX_APPEND_ATTEMPTS = 8;

export interface EpisodeIdentityRecord {
  readonly schemaVersion: 1;
  readonly episodeRecordId: string;
  readonly sourceId: string;
  readonly sourceRecordId: string;
  readonly episodeId: string;
  readonly parentEpisodeId?: string;
  readonly episodeClass?: string;
  readonly registryRevision: string;
  readonly trustCeiling: TrustClass;
  readonly completeness: Completeness;
}

interface IdentityClaim {
  readonly id: string;
  readonly digest: string;
  readonly value: EpisodeIdentityRecord;
}

export type EpisodeIdentityState =
  | { readonly status: "missing" }
  | { readonly status: "resolved"; readonly identity: EpisodeIdentityRecord }
  | { readonly status: "conflict" };

export function episodeIdentityRecord(
  registration: RegisteredSource<unknown>,
  episode: ProjectedEpisode,
  episodeRecordId: string,
): EpisodeIdentityRecord {
  return {
    schemaVersion: 1,
    episodeRecordId,
    sourceId: registration.id,
    sourceRecordId: episode.sourceRecordId,
    episodeId: episode.episodeId,
    ...(episode.parentEpisodeId !== undefined ? { parentEpisodeId: episode.parentEpisodeId } : {}),
    ...(episode.episodeClass !== undefined ? { episodeClass: episode.episodeClass } : {}),
    registryRevision: registration.registryRevision,
    trustCeiling: registration.trustCeiling,
    completeness: episode.completeness ?? "unknown",
  };
}

export function parseEpisodeIdentityRecord(input: unknown): EpisodeIdentityRecord {
  const fields = readFields(input, []);
  const parentEpisodeId = fields.opt("parentEpisodeId", parseNonEmptyText);
  const episodeClass = fields.opt("episodeClass", parseNonEmptyText);
  const identity: EpisodeIdentityRecord = {
    schemaVersion: fields.schemaVersion1(),
    episodeRecordId: fields.req("episodeRecordId", parseNonEmptyText),
    sourceId: fields.req("sourceId", parseNonEmptyText),
    sourceRecordId: fields.req("sourceRecordId", parseNonEmptyText),
    episodeId: fields.req("episodeId", parseNonEmptyText),
    ...(parentEpisodeId !== undefined ? { parentEpisodeId } : {}),
    ...(episodeClass !== undefined ? { episodeClass } : {}),
    registryRevision: fields.req("registryRevision", parseNonEmptyText),
    trustCeiling: fields.req("trustCeiling", parseOneOf(TRUST_CLASSES)),
    completeness: fields.req("completeness", parseOneOf(COMPLETENESS_VALUES)),
  };
  if (derivedRecordId(identity.sourceId, identity.sourceRecordId) !== identity.episodeRecordId) {
    throw invalid("schema.corrupt", "episode identity source fields do not derive its durable id", ["sourceId"]);
  }
  return identity;
}

function identityClaim(identity: EpisodeIdentityRecord): StreamEntry {
  const value = toJsonValue(identity);
  const digest = recordDigest(value);
  return { id: `identity:${digest}`, digest, value };
}

const parseIdentityClaimAt: Parse<IdentityClaim> = (input, path) => {
  const fields = readFields(input, path);
  const id = fields.req("id", parseNonEmptyText);
  const digest = fields.req("digest", parseNonEmptyText);
  const value = fields.req("value", (raw) => parseEpisodeIdentityRecord(raw));
  const expectedDigest = recordDigest(toJsonValue(value));
  if (digest !== expectedDigest || id !== `identity:${expectedDigest}`) {
    throw invalid("schema.corrupt", "episode identity claim digest does not match its content", path);
  }
  return { id, digest, value };
};

function parseClaims(input: unknown): readonly IdentityClaim[] {
  return parseArrayOf(parseIdentityClaimAt)(input, ["episodeIdentityClaims"]);
}

function stateOf(claims: readonly IdentityClaim[], episodeRecordId: string): EpisodeIdentityState {
  if (claims.length === 0) return { status: "missing" };
  const distinct = new Map<string, EpisodeIdentityRecord>();
  for (const claim of claims) {
    if (claim.value.episodeRecordId !== episodeRecordId) {
      throw invalid("schema.corrupt", "episode identity claim belongs to another durable episode", ["episodeRecordId"]);
    }
    distinct.set(claim.digest, claim.value);
  }
  if (distinct.size > 1) return { status: "conflict" };
  const identity = distinct.values().next().value;
  if (identity === undefined) return { status: "missing" };
  return { status: "resolved", identity };
}

export async function loadEpisodeIdentityState(
  context: EngineContext,
  episodeRecordId: string,
): Promise<EpisodeIdentityState> {
  const stored = await loadStoredRecord(context, "episode-identity", episodeRecordId);
  return stored === undefined ? { status: "missing" } : stateOf(parseClaims(stored.value), episodeRecordId);
}

export async function persistEpisodeIdentity(
  context: EngineContext,
  identity: EpisodeIdentityRecord,
  operationId: string,
): Promise<"created" | "exists_same" | "conflict"> {
  const entry = identityClaim(parseEpisodeIdentityRecord(identity));
  for (let attempt = 0; attempt < MAX_APPEND_ATTEMPTS; attempt += 1) {
    const stored = await loadStoredRecord(context, "episode-identity", identity.episodeRecordId);
    const claims = stored === undefined ? [] : parseClaims(stored.value);
    const current = stateOf(claims, identity.episodeRecordId);
    if (claims.some((claim) => claim.id === entry.id)) {
      return current.status === "conflict" ? "conflict" : "exists_same";
    }

    const rawResult: unknown = await context.store.append(
      recordKey("episode-identity", identity.episodeRecordId),
      stored?.revision,
      [entry],
      `${operationId}/${entry.id}`,
    );
    const result = parseWriteResult(rawResult);
    if (result.status === "created" || result.status === "updated" || result.status === "exists_same") {
      const committed = await loadEpisodeIdentityState(context, identity.episodeRecordId);
      if (committed.status === "conflict") return "conflict";
      if (committed.status !== "resolved" || recordDigest(toJsonValue(committed.identity)) !== entry.digest) {
        throw new LearningLoopError("store.corrupt", [
          {
            code: "store.corrupt",
            severity: "error",
            message: "store acknowledged an episode identity append without preserving the claim",
          },
        ]);
      }
      return claims.length === 0 ? "created" : "exists_same";
    }
  }
  throw new LearningLoopError("store.conflict", [
    {
      code: "store.conflict",
      severity: "error",
      message: "episode identity stream changed concurrently too many times",
      details: { episodeRecordId: identity.episodeRecordId },
    },
  ]);
}
