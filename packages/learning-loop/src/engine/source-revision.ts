// Append-only revision claims for one registered logical source artifact.
// One distinct revision is usable by the v1 derivative-id scheme; a second is
// retained as evidence health and blocks derivative ingestion until revision-
// aware storage lands in the later #31 migration slice.
import { sha256HexOfCanonicalJson } from "../canonical/canonical-json.js";
import { toJsonValue } from "../canonical/to-json-value.js";
import { LearningLoopError } from "../diagnostics.js";
import type { StreamEntry } from "../ports/store.js";
import { invalid, parseArrayOf, parseNonEmptyText, readFields } from "../parse/toolkit.js";
import type { Parse } from "../parse/toolkit.js";
import type { EngineContext } from "./context.js";
import { loadStoredRecord, parseWriteResult, recordDigest, recordKey } from "./context.js";

const MAX_APPEND_ATTEMPTS = 8;

interface SourceRevisionClaim {
  readonly schemaVersion: 1;
  readonly sourceId: string;
  readonly sourceRegistrationRevision: string;
  readonly sourceRef: string;
  readonly pageRef: string;
  readonly sourceRevision: string;
  readonly claimDigest: string;
}

interface StoredClaim {
  readonly id: string;
  readonly digest: string;
  readonly value: SourceRevisionClaim;
}

function claimDigest(input: Omit<SourceRevisionClaim, "schemaVersion" | "claimDigest">): string {
  return sha256HexOfCanonicalJson(
    toJsonValue({
      sourceId: input.sourceId,
      sourceRegistrationRevision: input.sourceRegistrationRevision,
      sourceRef: input.sourceRef,
      pageRef: input.pageRef,
      sourceRevision: input.sourceRevision,
    }),
  );
}

function claimFor(input: {
  readonly sourceId: string;
  readonly sourceRegistrationRevision: string;
  readonly sourceRef: string;
  readonly pageRef: string;
  readonly sourceRevision: string;
}): SourceRevisionClaim {
  const digest = claimDigest(input);
  return { schemaVersion: 1, ...input, claimDigest: digest };
}

function parseClaim(input: unknown): SourceRevisionClaim {
  const fields = readFields(input, []);
  const claim: SourceRevisionClaim = {
    schemaVersion: fields.schemaVersion1(),
    sourceId: fields.req("sourceId", parseNonEmptyText),
    sourceRegistrationRevision: fields.req("sourceRegistrationRevision", parseNonEmptyText),
    sourceRef: fields.req("sourceRef", parseNonEmptyText),
    pageRef: fields.req("pageRef", parseNonEmptyText),
    sourceRevision: fields.req("sourceRevision", parseNonEmptyText),
    claimDigest: fields.req("claimDigest", parseNonEmptyText),
  };
  if (claim.claimDigest !== claimDigest(claim)) {
    throw invalid("schema.corrupt", "source revision claim digest does not match its content", ["claimDigest"]);
  }
  return claim;
}

const parseStoredClaimAt: Parse<StoredClaim> = (input, path) => {
  const fields = readFields(input, path);
  const id = fields.req("id", parseNonEmptyText);
  const digest = fields.req("digest", parseNonEmptyText);
  const value = fields.req("value", (raw) => parseClaim(raw));
  const expected = recordDigest(toJsonValue(value));
  if (id !== `revision:${value.claimDigest}` || digest !== expected) {
    throw invalid("schema.corrupt", "stored source revision claim does not match its entry binding", path);
  }
  return { id, digest, value };
};

function parseClaims(input: unknown): readonly StoredClaim[] {
  return parseArrayOf(parseStoredClaimAt)(input, ["sourceRevisionClaims"]);
}

function claimsForIdentity(
  input: unknown,
  identity: {
    readonly sourceId: string;
    readonly sourceRegistrationRevision: string;
    readonly sourceRef: string;
    readonly pageRef: string;
  },
): readonly StoredClaim[] {
  const claims = parseClaims(input);
  for (const claim of claims) {
    if (
      claim.value.sourceId !== identity.sourceId ||
      claim.value.sourceRegistrationRevision !== identity.sourceRegistrationRevision ||
      claim.value.sourceRef !== identity.sourceRef ||
      claim.value.pageRef !== identity.pageRef
    ) {
      throw invalid("store.corrupt", "source revision stream contains a foreign identity claim", [
        "sourceRevisionClaims",
      ]);
    }
  }
  return claims;
}

function streamId(input: {
  readonly sourceId: string;
  readonly sourceRegistrationRevision: string;
  readonly sourceRef: string;
  readonly pageRef: string;
}): string {
  return sha256HexOfCanonicalJson(toJsonValue(input));
}

export async function persistSourceRevision(
  context: EngineContext,
  input: {
    readonly sourceId: string;
    readonly sourceRegistrationRevision: string;
    readonly sourceRef: string;
    readonly pageRef: string;
    readonly sourceRevision: string;
  },
  operationId: string,
): Promise<"first" | "same" | "conflict"> {
  const claim = claimFor(input);
  const value = toJsonValue(claim);
  const entry: StreamEntry = {
    id: `revision:${claim.claimDigest}`,
    digest: recordDigest(value),
    value,
  };
  const id = streamId({
    sourceId: input.sourceId,
    sourceRegistrationRevision: input.sourceRegistrationRevision,
    sourceRef: input.sourceRef,
    pageRef: input.pageRef,
  });
  for (let attempt = 0; attempt < MAX_APPEND_ATTEMPTS; attempt += 1) {
    const stored = await loadStoredRecord(context, "source-revision", id);
    const claims = stored === undefined ? [] : claimsForIdentity(stored.value, input);
    const revisions = new Set(claims.map((item) => item.value.sourceRevision));
    if (revisions.has(input.sourceRevision)) return revisions.size > 1 ? "conflict" : "same";
    const rawResult: unknown = await context.store.append(
      recordKey("source-revision", id),
      stored?.revision,
      [entry],
      `${operationId}/${entry.id}`,
    );
    const result = parseWriteResult(rawResult);
    if (result.status === "created" || result.status === "updated" || result.status === "exists_same") {
      const committed = await loadStoredRecord(context, "source-revision", id);
      if (committed === undefined) {
        throw invalid("store.corrupt", "store acknowledged a missing source revision stream", ["sourceRevision"]);
      }
      const committedRevisions = new Set(
        claimsForIdentity(committed.value, input).map((item) => item.value.sourceRevision),
      );
      if (!committedRevisions.has(input.sourceRevision)) {
        throw invalid("store.corrupt", "store did not preserve the source revision claim", ["sourceRevision"]);
      }
      return committedRevisions.size > 1 ? "conflict" : claims.length === 0 ? "first" : "same";
    }
  }
  throw new LearningLoopError("store.conflict", [
    {
      code: "store.conflict",
      severity: "error",
      message: "source revision stream changed concurrently too many times",
    },
  ]);
}
