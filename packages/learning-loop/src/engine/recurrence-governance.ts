// Observational recurrence governance for durable pack-run receipts.
import { toJsonValue } from "../canonical/to-json-value.js";
import { LearningLoopError } from "../diagnostics.js";
import type { DetectorPackRunReceipt } from "../records/detector-pack-run-receipt.js";
import { classifyAssessedRecurrenceGovernance } from "../records/detector-pack-run-receipt.js";
import type { DetectorOrchestrationPolicy } from "../records/detector-orchestration-policy.js";
import type { CandidateReview } from "../records/review.js";
import type { Candidate } from "../records/candidate.js";
import { candidateLineageDiagnostics } from "./candidate-lineage.js";
import type { CandidateReviewIndexState } from "./candidate-review-index.js";
import { loadIndexedCandidateReviews } from "./candidate-review-index.js";
import { loadCandidate, recordDigest } from "./context.js";
import type { EngineContext } from "./context.js";
import { revalidateCandidateDerivation } from "./derivation-binding.js";
import { revalidateCandidateEvidence } from "./evidence-binding.js";
import type { recurrenceReceiptLineage } from "./detector-recurrence.js";
import {
  createCandidateRecurrenceResolutionCache,
  loadCandidateRecurrenceClaim,
  loadCandidateRecurrenceLineage,
  loadCurrentGroupCandidateClaims,
} from "./recurrence-claims.js";
import type { CandidateRecurrenceResolutionCache, CurrentGroupCandidateClaim } from "./recurrence-claims.js";
import { assertStoredReviewValid } from "./views.js";

type GroupedRecurrence = Extract<DetectorPackRunReceipt["items"][number]["recurrence"], { status: "grouped" }>;
type GroupGovernance = GroupedRecurrence["governance"];
type AssessedGovernance = Extract<GroupGovernance, { status: "assessed" }>;
type CandidateBinding = AssessedGovernance["candidateBindings"][number];

interface AssessedCandidate {
  readonly binding: CandidateBinding;
  readonly latestReview: CandidateReview | null;
}

export interface RecurrenceGovernanceReadCache {
  readonly recurrence: CandidateRecurrenceResolutionCache;
  readonly groupClaims: Map<string, Promise<readonly CurrentGroupCandidateClaim[]>>;
  readonly reviews: Map<string, Promise<CandidateReviewIndexState>>;
}

export function createRecurrenceGovernanceReadCache(): RecurrenceGovernanceReadCache {
  return {
    recurrence: createCandidateRecurrenceResolutionCache(),
    groupClaims: new Map(),
    reviews: new Map(),
  };
}

function seedGroupLineage(
  cache: RecurrenceGovernanceReadCache,
  groupKeyDigest: string,
  lineage: Awaited<ReturnType<typeof recurrenceReceiptLineage>>,
): void {
  cache.recurrence.groupLineages.set(groupKeyDigest, lineage);
  cache.recurrence.claimGroupExecutions.set(groupKeyDigest, { executionIds: lineage.executionIds });
}

async function groupClaims(
  context: EngineContext,
  groupKeyDigest: string,
  lineage: Awaited<ReturnType<typeof recurrenceReceiptLineage>>,
  workBudget: { claimRefs: number },
  cache: RecurrenceGovernanceReadCache,
): Promise<readonly CurrentGroupCandidateClaim[]> {
  seedGroupLineage(cache, groupKeyDigest, lineage);
  let pending = cache.groupClaims.get(groupKeyDigest);
  if (pending === undefined) {
    pending = loadCurrentGroupCandidateClaims(context, groupKeyDigest, cache.recurrence, workBudget);
    cache.groupClaims.set(groupKeyDigest, pending);
  }
  return pending;
}

async function indexedReviews(
  context: EngineContext,
  current: CurrentGroupCandidateClaim,
  workBudget: { claimRefs: number },
  cache: RecurrenceGovernanceReadCache,
): Promise<CandidateReviewIndexState> {
  let pending = cache.reviews.get(current.candidate.id);
  if (pending === undefined) {
    pending = loadIndexedCandidateReviews(context, current.candidate, workBudget);
    cache.reviews.set(current.candidate.id, pending);
  }
  return pending;
}

function latestBindingReview(reviews: readonly CandidateReview[], candidateDigest: string): CandidateReview | null {
  let latest: CandidateReview | null = null;
  for (const review of reviews) if (review.candidateDigest === candidateDigest) latest = review;
  return latest;
}

function notAssessed(
  capped: boolean,
  reason: "candidate_review_history_unavailable" | "candidate_governance_incomplete",
): GroupGovernance {
  return { status: "not_assessed", reason, groupDisposition: capped ? "capped" : "unassessed" };
}

function assertCanonicalReviewTime(review: CandidateReview): void {
  const milliseconds = Date.parse(review.reviewedAt);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== review.reviewedAt) {
    throw new LearningLoopError("store.corrupt", [
      { code: "store.corrupt", severity: "error", message: "indexed Candidate review time is noncanonical" },
    ]);
  }
}

export async function assessRecurrenceGroupGovernance(
  context: EngineContext,
  input: {
    readonly groupKeyDigest: string;
    readonly currentDistinctEpisodeCount: number;
    readonly capped: boolean;
    readonly policy: DetectorOrchestrationPolicy;
    readonly workBudget: { claimRefs: number };
    readonly groupLineage: Awaited<ReturnType<typeof recurrenceReceiptLineage>>;
    readonly cache?: RecurrenceGovernanceReadCache;
    readonly candidateAdmissionStatus?: (candidate: Candidate) => Promise<"not_subject" | "valid" | "invalid">;
  },
): Promise<GroupGovernance> {
  if (input.capped) {
    return { status: "not_assessed", reason: "candidate_governance_capped", groupDisposition: "capped" };
  }
  const cache = input.cache ?? createRecurrenceGovernanceReadCache();
  const allClaims = await groupClaims(context, input.groupKeyDigest, input.groupLineage, input.workBudget, cache);
  const byClaimDigest = new Map(allClaims.map((current) => [current.claim.claimDigest, current]));
  const superseded = new Set<string>();
  for (const current of allClaims) {
    const predecessor = current.claim.supersedes;
    if (predecessor === null) continue;
    const exact = byClaimDigest.get(predecessor.claimDigest);
    if (
      exact === undefined ||
      exact.candidate.id !== predecessor.candidateId ||
      exact.candidate.contentDigest !== predecessor.candidateDigest
    ) {
      throw new LearningLoopError("store.corrupt", [
        { code: "store.corrupt", severity: "error", message: "recurrence Candidate supersession edge is mismatched" },
      ]);
    }
    superseded.add(predecessor.claimDigest);
  }
  for (const current of allClaims) {
    const seen = new Set<string>();
    let cursor: typeof current | undefined = current;
    while (cursor !== undefined && cursor.claim.supersedes !== null) {
      if (seen.has(cursor.claim.claimDigest)) {
        throw new LearningLoopError("store.corrupt", [
          { code: "store.corrupt", severity: "error", message: "recurrence Candidate supersession contains a cycle" },
        ]);
      }
      seen.add(cursor.claim.claimDigest);
      cursor = byClaimDigest.get(cursor.claim.supersedes.claimDigest);
    }
  }

  const frontier = allClaims.filter((current) => !superseded.has(current.claim.claimDigest));
  const assessed: AssessedCandidate[] = [];
  for (const current of frontier) {
    const admissionStatus =
      input.candidateAdmissionStatus === undefined
        ? "not_subject"
        : await input.candidateAdmissionStatus(current.candidate);
    const recurrence = await loadCandidateRecurrenceLineage(context, current.candidate, cache.recurrence);
    const derivation = await revalidateCandidateDerivation(context, current.candidate);
    const evidence = await revalidateCandidateEvidence(context, current.candidate);
    const lineageReasons = await candidateLineageDiagnostics(context, current.candidate);
    if (
      admissionStatus === "invalid" ||
      recurrence.status !== "resolved" ||
      recurrence.claimDigest !== current.claim.claimDigest ||
      recurrence.groupKeyDigest !== input.groupKeyDigest ||
      derivation.status !== "resolved" ||
      evidence.health.status !== "ready" ||
      lineageReasons.length > 0
    ) {
      return notAssessed(input.capped, "candidate_governance_incomplete");
    }
    const reviewState = await indexedReviews(context, current, input.workBudget, cache);
    if (reviewState.status === "unmarked") return notAssessed(input.capped, "candidate_review_history_unavailable");
    for (const review of reviewState.reviews) {
      assertCanonicalReviewTime(review);
      assertStoredReviewValid(context, current.candidate, derivation, review);
    }
    const latestReview = latestBindingReview(reviewState.reviews, current.candidate.contentDigest);
    const claim = current.claim;
    assessed.push({
      binding: {
        candidateId: current.candidate.id,
        candidateDigest: current.candidate.contentDigest,
        claimDigest: claim.claimDigest,
        derivationId: claim.derivationId,
        derivationDigest: claim.derivationDigest,
        episodeIdentitySetDigest: claim.episodeIdentitySetDigest,
        distinctEpisodeCount: claim.distinctEpisodeCount,
        supersedes: claim.supersedes,
        latestReview:
          latestReview === null
            ? null
            : {
                id: latestReview.id,
                recordDigest: recordDigest(toJsonValue(latestReview)),
                disposition: latestReview.disposition,
                reviewedAt: latestReview.reviewedAt,
              },
      },
      latestReview,
    });
  }

  const candidateBindings = assessed
    .map((candidate) => candidate.binding)
    .sort((left, right) => (left.candidateId < right.candidateId ? -1 : left.candidateId > right.candidateId ? 1 : 0));
  return classifyAssessedRecurrenceGovernance({
    policy: input.policy,
    currentDistinctEpisodeCount: input.currentDistinctEpisodeCount,
    candidateBindings,
  });
}

export async function embeddedAssessedGovernanceIsExact(
  context: EngineContext,
  input: {
    readonly groupKeyDigest: string;
    readonly governance: AssessedGovernance;
    readonly workBudget: { claimRefs: number };
    readonly groupLineage: Awaited<ReturnType<typeof recurrenceReceiptLineage>>;
    readonly cache: RecurrenceGovernanceReadCache;
    readonly candidateAdmissionStatus?: (candidate: Candidate) => Promise<"not_subject" | "valid" | "invalid">;
  },
): Promise<boolean> {
  seedGroupLineage(input.cache, input.groupKeyDigest, input.groupLineage);
  for (const binding of input.governance.candidateBindings) {
    const candidate = await loadCandidate(context, binding.candidateId);
    const claim = await loadCandidateRecurrenceClaim(context, binding.candidateId);
    if (candidate === undefined || claim?.status !== "grouped" || claim.claimDigest !== binding.claimDigest) {
      return false;
    }
    if (
      input.candidateAdmissionStatus !== undefined &&
      (await input.candidateAdmissionStatus(candidate)) === "invalid"
    ) {
      return false;
    }
    input.workBudget.claimRefs += 1 + claim.proposalMembers.length + claim.derivationClaimDigests.length;
    if (input.workBudget.claimRefs > 50_000) {
      throw new LearningLoopError("detector.limit_exceeded", [
        {
          code: "detector.limit_exceeded",
          severity: "error",
          message: "embedded recurrence governance work exceeds its ceiling",
        },
      ]);
    }
    const current: CurrentGroupCandidateClaim = { candidate, claim };
    if (
      candidate.contentDigest !== binding.candidateDigest ||
      claim.groupKeyDigest !== input.groupKeyDigest ||
      claim.derivationId !== binding.derivationId ||
      claim.derivationDigest !== binding.derivationDigest ||
      claim.episodeIdentitySetDigest !== binding.episodeIdentitySetDigest ||
      claim.distinctEpisodeCount !== binding.distinctEpisodeCount ||
      recordDigest(toJsonValue(claim.supersedes)) !== recordDigest(toJsonValue(binding.supersedes))
    ) {
      return false;
    }
    const lineage = await loadCandidateRecurrenceLineage(context, candidate, input.cache.recurrence);
    if (
      lineage.status !== "resolved" ||
      lineage.claimDigest !== binding.claimDigest ||
      lineage.groupKeyDigest !== input.groupKeyDigest
    ) {
      return false;
    }
    const reviewState = await indexedReviews(context, current, input.workBudget, input.cache);
    if (reviewState.status !== "ready") return false;
    if (binding.latestReview === null) continue;
    const exactReview = reviewState.reviews.find(
      (review) =>
        review.id === binding.latestReview?.id &&
        recordDigest(toJsonValue(review)) === binding.latestReview.recordDigest &&
        review.disposition === binding.latestReview.disposition &&
        review.reviewedAt === binding.latestReview.reviewedAt,
    );
    if (exactReview === undefined) return false;
    assertCanonicalReviewTime(exactReview);
    const derivation = await revalidateCandidateDerivation(context, candidate);
    assertStoredReviewValid(context, candidate, derivation, exactReview);
  }
  return true;
}
