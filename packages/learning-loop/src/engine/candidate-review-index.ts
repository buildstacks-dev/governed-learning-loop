// Private exact Candidate review marker/index for bounded recurrence governance.
import { LearningLoopError } from "../diagnostics.js";
import type { StreamEntry } from "../ports/store.js";
import type { Candidate } from "../records/candidate.js";
import { candidateScopeDigest } from "../records/candidate.js";
import type { CandidateReview } from "../records/review.js";
import { parseCandidateReview } from "../records/review.js";
import { invalid, parseNonEmptyText, parseOneOf, readFields } from "../parse/toolkit.js";
import type { Parse } from "../parse/toolkit.js";
import { parseDigestAt, parseDurableId } from "../records/semantic-shared.js";
import type { EngineContext } from "./context.js";
import { loadStoredRecord, parseWriteResult, recordDigest, recordKey } from "./context.js";
import { toJsonValue } from "../canonical/to-json-value.js";
import { loadCandidateRecurrenceClaim } from "./recurrence-claims.js";

const MAX_APPEND_ATTEMPTS = 8;
const MAX_REVIEW_REFS = 5_000;
const MAX_INDEX_ENTRY_ID_LENGTH = 4_096 + "review:".length;

type CandidateReviewIndexValue =
  | {
      readonly kind: "marker";
      readonly candidateId: string;
      readonly candidateDigest: string;
      readonly scopeDigest: string;
      readonly recurrenceClaimDigest: string;
    }
  | {
      readonly kind: "review";
      readonly reviewId: string;
      readonly recordDigest: string;
      readonly candidateId: string;
      readonly candidateDigest: string;
      readonly scopeDigest: string;
    };

interface StoredIndexEntry {
  readonly id: string;
  readonly digest: string;
  readonly value: CandidateReviewIndexValue;
}

export type CandidateReviewIndexState =
  | { readonly status: "unmarked" }
  | { readonly status: "ready"; readonly reviews: readonly CandidateReview[]; readonly refCount: number };

const parseValueAt: Parse<CandidateReviewIndexValue> = (input, path) => {
  const fields = readFields(input, path);
  const kind = fields.req("kind", parseOneOf(["marker", "review"]));
  if (kind === "marker") {
    return {
      kind: "marker",
      candidateId: fields.req("candidateId", parseDurableId),
      candidateDigest: fields.req("candidateDigest", parseDigestAt),
      scopeDigest: fields.req("scopeDigest", parseDigestAt),
      recurrenceClaimDigest: fields.req("recurrenceClaimDigest", parseDigestAt),
    };
  }
  return {
    kind: "review",
    reviewId: fields.req("reviewId", parseDurableId),
    recordDigest: fields.req("recordDigest", parseDigestAt),
    candidateId: fields.req("candidateId", parseDurableId),
    candidateDigest: fields.req("candidateDigest", parseDigestAt),
    scopeDigest: fields.req("scopeDigest", parseDigestAt),
  };
};

const parseEntryAt: Parse<StoredIndexEntry> = (input, path) => {
  const fields = readFields(input, path);
  const value = fields.req("value", parseValueAt);
  const id = fields.req("id", (entryId, entryPath) => {
    const parsed = parseNonEmptyText(entryId, entryPath);
    if (parsed.length > MAX_INDEX_ENTRY_ID_LENGTH) {
      throw invalid("store.corrupt", "Candidate review index entry id exceeds its framed bound", entryPath);
    }
    return parsed;
  });
  const exactDigest = fields.req("digest", parseDigestAt);
  const expectedId =
    value.kind === "marker"
      ? `marker:${value.candidateDigest}:${value.recurrenceClaimDigest}`
      : `review:${value.reviewId}`;
  if (id !== expectedId || exactDigest !== recordDigest(toJsonValue(value))) {
    throw invalid("store.corrupt", "Candidate review index entry is mismatched", path);
  }
  return { id, digest: exactDigest, value };
};

function parseEntries(input: unknown): readonly StoredIndexEntry[] {
  if (!Array.isArray(input)) throw invalid("store.corrupt", "Candidate review index must be an array", []);
  if (input.length > MAX_REVIEW_REFS + 1) {
    throw new LearningLoopError("detector.limit_exceeded", [
      { code: "detector.limit_exceeded", severity: "error", message: "Candidate review index exceeds its ceiling" },
    ]);
  }
  const entries = input.map((entry: unknown, index: number) => parseEntryAt(entry, ["candidate-review", index]));
  const ids = new Set<string>();
  for (const entry of entries) {
    if (ids.has(entry.id)) throw invalid("store.corrupt", "Candidate review index contains a duplicate", []);
    ids.add(entry.id);
  }
  const markerIndexes = entries.flatMap((entry, index) => (entry.value.kind === "marker" ? [index] : []));
  if (markerIndexes.length !== 1 || markerIndexes[0] !== 0) {
    throw invalid("store.corrupt", "Candidate review index marker is missing, duplicated, or out of order", []);
  }
  return entries;
}

function entry(value: CandidateReviewIndexValue): StreamEntry {
  const json = toJsonValue(value);
  return {
    id:
      value.kind === "marker"
        ? `marker:${value.candidateDigest}:${value.recurrenceClaimDigest}`
        : `review:${value.reviewId}`,
    digest: recordDigest(json),
    value: json,
  };
}

async function appendEntry(context: EngineContext, candidateId: string, exactEntry: StreamEntry): Promise<void> {
  for (let attempt = 0; attempt < MAX_APPEND_ATTEMPTS; attempt += 1) {
    const stored = await loadStoredRecord(context, "candidate-review", candidateId);
    const entries = stored === undefined ? [] : parseEntries(stored.value);
    const existing = entries.find((candidate) => candidate.id === exactEntry.id);
    if (existing !== undefined) {
      if (existing.digest !== exactEntry.digest) {
        if (exactEntry.id.startsWith("review:")) {
          throw new LearningLoopError("store.conflict", [
            { code: "store.conflict", severity: "error", message: "review id already binds another exact result" },
          ]);
        }
        throw invalid("store.corrupt", "Candidate review index changed", []);
      }
      return;
    }
    if (entries.length >= MAX_REVIEW_REFS + 1) {
      throw new LearningLoopError("detector.limit_exceeded", [
        { code: "detector.limit_exceeded", severity: "error", message: "Candidate review index is at capacity" },
      ]);
    }
    const raw: unknown = await context.store.append(
      recordKey("candidate-review", candidateId),
      stored?.revision,
      [exactEntry],
      `candidate-review/${candidateId}/${exactEntry.id}`,
    );
    const result = parseWriteResult(raw);
    if (result.status === "created" || result.status === "updated" || result.status === "exists_same") {
      const committed = await loadStoredRecord(context, "candidate-review", candidateId);
      const committedEntries = committed === undefined ? [] : parseEntries(committed.value);
      if (
        !committedEntries.some((candidate) => candidate.id === exactEntry.id && candidate.digest === exactEntry.digest)
      ) {
        throw invalid("store.corrupt", "Candidate review index entry was not preserved", []);
      }
      return;
    }
  }
  throw new LearningLoopError("store.conflict", [
    { code: "store.conflict", severity: "error", message: "Candidate review index changed too many times" },
  ]);
}

export async function ensureCandidateReviewMarker(context: EngineContext, candidate: Candidate): Promise<void> {
  const recurrenceClaim = await loadCandidateRecurrenceClaim(context, candidate.id);
  if (
    recurrenceClaim === undefined ||
    recurrenceClaim.candidateDigest !== candidate.contentDigest ||
    recurrenceClaim.scopeDigest !== candidateScopeDigest(candidate.scope)
  ) {
    throw invalid("store.corrupt", "claim-aware Candidate has no exact recurrence decision for review marker", []);
  }
  const value: CandidateReviewIndexValue = {
    kind: "marker",
    candidateId: candidate.id,
    candidateDigest: candidate.contentDigest,
    scopeDigest: candidateScopeDigest(candidate.scope),
    recurrenceClaimDigest: recurrenceClaim.claimDigest,
  };
  await appendEntry(context, candidate.id, entry(value));
  const stored = await loadStoredRecord(context, "candidate-review", candidate.id);
  const entries = stored === undefined ? [] : parseEntries(stored.value);
  const marker = entries.find((candidateEntry) => candidateEntry.value.kind === "marker");
  if (
    marker?.value.kind !== "marker" ||
    marker.value.candidateId !== candidate.id ||
    marker.value.candidateDigest !== candidate.contentDigest ||
    marker.value.scopeDigest !== candidateScopeDigest(candidate.scope) ||
    marker.value.recurrenceClaimDigest !== recurrenceClaim.claimDigest
  ) {
    throw invalid("store.corrupt", "Candidate review marker is mismatched", []);
  }
}

export async function appendCandidateReviewReference(
  context: EngineContext,
  candidate: Candidate,
  review: CandidateReview,
): Promise<boolean> {
  const current = await loadIndexedCandidateReviews(context, candidate);
  if (current.status === "unmarked") return false;
  if (review.candidateId !== candidate.id || review.candidateDigest !== candidate.contentDigest) {
    throw invalid("store.corrupt", "Candidate review reference is mismatched", []);
  }
  const value: CandidateReviewIndexValue = {
    kind: "review",
    reviewId: review.id,
    recordDigest: recordDigest(toJsonValue(review)),
    candidateId: candidate.id,
    candidateDigest: candidate.contentDigest,
    scopeDigest: candidateScopeDigest(candidate.scope),
  };
  await appendEntry(context, candidate.id, entry(value));
  return true;
}

export async function loadIndexedCandidateReviews(
  context: EngineContext,
  candidate: Candidate,
  workBudget?: { claimRefs: number },
): Promise<CandidateReviewIndexState> {
  const stored = await loadStoredRecord(context, "candidate-review", candidate.id);
  if (stored === undefined) return { status: "unmarked" };
  const entries = parseEntries(stored.value);
  const rawReviewRefCount = entries.filter((indexed) => indexed.value.kind === "review").length;
  if (workBudget !== undefined) {
    workBudget.claimRefs += rawReviewRefCount;
    if (workBudget.claimRefs > 50_000) {
      throw new LearningLoopError("detector.limit_exceeded", [
        {
          code: "detector.limit_exceeded",
          severity: "error",
          message: "recurrence governance review work exceeds its ceiling",
        },
      ]);
    }
  }
  const marker = entries.find((candidateEntry) => candidateEntry.value.kind === "marker");
  if (marker === undefined) return { status: "unmarked" };
  const recurrenceClaim = await loadCandidateRecurrenceClaim(context, candidate.id);
  if (
    marker.value.kind !== "marker" ||
    marker.value.candidateId !== candidate.id ||
    marker.value.candidateDigest !== candidate.contentDigest ||
    marker.value.scopeDigest !== candidateScopeDigest(candidate.scope) ||
    recurrenceClaim === undefined ||
    marker.value.recurrenceClaimDigest !== recurrenceClaim.claimDigest
  ) {
    throw invalid("store.corrupt", "Candidate review marker does not match its Candidate", []);
  }
  const reviews: CandidateReview[] = [];
  for (const indexed of entries) {
    if (indexed.value.kind !== "review") continue;
    if (
      indexed.value.candidateId !== candidate.id ||
      indexed.value.candidateDigest !== candidate.contentDigest ||
      indexed.value.scopeDigest !== candidateScopeDigest(candidate.scope)
    ) {
      throw invalid("store.corrupt", "Candidate review index contains foreign content", []);
    }
    const reviewStored = await loadStoredRecord(context, "review", indexed.value.reviewId);
    if (reviewStored === undefined) continue;
    const review = parseCandidateReview(reviewStored.value);
    if (
      review.id !== indexed.value.reviewId ||
      review.candidateId !== candidate.id ||
      review.candidateDigest !== candidate.contentDigest
    ) {
      throw invalid("store.corrupt", "Candidate review index resolves a mismatched review", []);
    }
    if (recordDigest(toJsonValue(review)) !== indexed.value.recordDigest) {
      throw invalid("store.corrupt", "terminal Candidate review differs from its indexed result lock", []);
    }
    reviews.push(review);
  }
  return {
    status: "ready",
    reviews,
    refCount: rawReviewRefCount,
  };
}

export async function verifyExistingCandidateReviewReference(
  context: EngineContext,
  candidate: Candidate,
  review: CandidateReview,
): Promise<void> {
  const state = await loadIndexedCandidateReviews(context, candidate);
  if (state.status === "unmarked") {
    return;
  }
  const exactDigest = recordDigest(toJsonValue(review));
  if (
    !state.reviews.some(
      (candidateReview) =>
        candidateReview.id === review.id && recordDigest(toJsonValue(candidateReview)) === exactDigest,
    )
  ) {
    throw invalid("store.corrupt", "existing Candidate review is missing its exact indexed reference", []);
  }
}
