// Store-backed folds shared by propose and review: load a candidate's stored
// reviews (oldest first) and compute its governance view.
import { LearningLoopError } from "../diagnostics.js";
import type { Candidate } from "../records/candidate.js";
import type { CandidateReview } from "../records/review.js";
import { parseCandidateReview, reviewInvalidReasons } from "../records/review.js";
import type { EngineContext } from "./context.js";
import { effectiveRisk, iterateRecordPages } from "./context.js";
import { candidateLineageDiagnostics } from "./candidate-lineage.js";
import type { EvidenceHealthView } from "./evidence-binding.js";
import { revalidateCandidateEvidence } from "./evidence-binding.js";
import type { GovernanceView } from "./governance.js";
import { computeGovernanceView } from "./governance.js";

export interface CandidateGovernanceState {
  readonly governance: GovernanceView;
  readonly evidenceHealth: EvidenceHealthView;
}

/**
 * Stored reviews of one candidate. `list` returns records in stable insertion
 * order, which within one engine process is persistence order; the last
 * element is therefore the latest decisive review.
 */
export async function loadReviews(context: EngineContext, candidate: Candidate): Promise<readonly CandidateReview[]> {
  const reviews: CandidateReview[] = [];
  const riskRule = context.policyRules.risks[effectiveRisk(candidate)];
  for await (const page of iterateRecordPages(context.store, "review", { limit: 100 })) {
    for (const record of page.records) {
      const review = parseCandidateReview(record.value);
      if (review.id !== record.key.id) {
        throw new LearningLoopError("store.corrupt", [
          {
            code: "store.corrupt",
            severity: "error",
            message: "stored review id does not match its record key",
          },
        ]);
      }
      if (review.candidateId !== candidate.id) continue;
      const invalidReasons = reviewInvalidReasons(review);
      if (
        invalidReasons.length > 0 ||
        review.reviewer.id === candidate.proposedBy.id ||
        (riskRule.independentDomain && review.reviewer.independenceDomain === candidate.proposedBy.independenceDomain)
      ) {
        throw new LearningLoopError("store.corrupt", [
          {
            code: "store.corrupt",
            severity: "error",
            message: "stored candidate review violates review invariants",
          },
          ...invalidReasons,
        ]);
      }
      reviews.push(review);
    }
  }
  return reviews;
}

export async function candidateGovernanceStateOf(
  context: EngineContext,
  candidate: Candidate,
  requiresIndependentReview: boolean,
): Promise<CandidateGovernanceState> {
  const reviews = await loadReviews(context, candidate);
  const governance = computeGovernanceView({
    candidateDigest: candidate.contentDigest,
    requiresIndependentReview,
    reviews,
  });
  const evidence = await revalidateCandidateEvidence(context, candidate);
  const lineageDiagnostics = await candidateLineageDiagnostics(context, candidate);
  if (evidence.health.status === "ready" && lineageDiagnostics.length === 0) {
    return { governance, evidenceHealth: evidence.health };
  }
  const code =
    lineageDiagnostics.length > 0
      ? "candidate.lineage_invalid"
      : evidence.health.status === "legacy_unbound"
        ? "candidate.legacy_unbound"
        : evidence.health.status === "incomplete"
          ? "candidate.evidence_incomplete"
          : "candidate.evidence_invalid";
  return {
    governance: {
      ...governance,
      review: "blocked",
      publication: "blocked",
      reasons: [
        {
          code,
          severity: "error",
          message: "candidate evidence is not eligible for decisive governance",
        },
        ...lineageDiagnostics,
        ...evidence.health.diagnostics,
        ...governance.reasons.filter((reason) => reason.code !== "review.required"),
      ],
    },
    evidenceHealth: evidence.health,
  };
}
