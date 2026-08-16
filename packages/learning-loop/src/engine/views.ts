// Store-backed folds shared by propose and review: load a candidate's stored
// reviews (oldest first) and compute its governance view.
import type { Candidate } from "../records/candidate.js";
import type { CandidateReview } from "../records/review.js";
import { parseCandidateReview } from "../records/review.js";
import type { EngineContext } from "./context.js";
import { listAllRecords } from "./context.js";
import type { GovernanceView } from "./governance.js";
import { computeGovernanceView } from "./governance.js";

/**
 * Stored reviews of one candidate. `list` returns records in stable insertion
 * order, which within one engine process is persistence order; the last
 * element is therefore the latest decisive review.
 */
export async function loadReviews(context: EngineContext, candidateId: string): Promise<readonly CandidateReview[]> {
  const stored = await listAllRecords(context.store, "review");
  return stored
    .map((record) => parseCandidateReview(record.value))
    .filter((review) => review.candidateId === candidateId);
}

export async function governanceViewOf(
  context: EngineContext,
  candidate: Candidate,
  requiresIndependentReview: boolean,
): Promise<GovernanceView> {
  const reviews = await loadReviews(context, candidate.id);
  return computeGovernanceView({
    candidateDigest: candidate.contentDigest,
    requiresIndependentReview,
    reviews,
  });
}
