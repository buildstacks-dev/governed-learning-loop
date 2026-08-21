// GovernanceView (contract §The façade), folded as a pure function so the
// invariants are testable without a store. `review` folds the stored reviews
// of the CURRENT candidate digest; `publication` says whether policy permits
// a plan for this content to be published — decisive review, a registered
// destination, and a configured authority — and never that anything was
// authorized or published; `validation` is always "untested" here because
// no evaluation record exists before the Validate tier: authorized ≠
// validated, and missing measurement is never a pass.
import type { Diagnostic } from "../diagnostics.js";
import type { CandidateReview } from "../records/review.js";

export interface GovernanceView {
  readonly review: "not_required" | "required" | "accepted" | "blocked";
  readonly publication: "eligible" | "blocked";
  readonly validation: "untested" | "invalid" | "inconclusive" | "improved" | "regressed";
  readonly reasons: readonly Diagnostic[];
}

export interface GovernanceViewInput {
  /** The CURRENT candidate content digest; only reviews of it are binding. */
  readonly candidateDigest: string;
  /** Whether policy requires an independent review at the candidate's effective risk. */
  readonly requiresIndependentReview: boolean;
  /** Stored reviews of the candidate, oldest first. */
  readonly reviews: readonly CandidateReview[];
  /** Whether the loop registers the destination the candidate's intervention names. */
  readonly destinationRegistered: boolean;
  /** Whether the loop configures an authority port that could authorize a plan. */
  readonly authorityConfigured: boolean;
}

function findingDiagnostics(review: CandidateReview): readonly Diagnostic[] {
  return review.findings.map((finding, index) => ({
    code: finding.code,
    severity: finding.severity === "blocking" ? ("error" as const) : finding.severity,
    message: finding.message,
    path: ["reviews", review.id, "findings", index],
  }));
}

/**
 * Folds stored reviews into the governance view. Only reviews binding the
 * current digest count; the LATEST binding review is decisive. An accepting
 * review of the current digest yields "accepted"; reject/escalate blocks with
 * reasons; "revise" returns the candidate to "required". Publication is
 * eligible only with decisive review, a registered destination, and a
 * configured authority; each missing condition is a stated reason.
 */
export function computeGovernanceView(input: GovernanceViewInput): GovernanceView {
  const binding = input.reviews.filter((review) => review.candidateDigest === input.candidateDigest);
  const decisive = binding[binding.length - 1];
  const reasons: Diagnostic[] = [];
  let review: GovernanceView["review"];
  if (!input.requiresIndependentReview) {
    review = "not_required";
  } else if (decisive === undefined) {
    review = "required";
    reasons.push({
      code: "review.required",
      severity: "info",
      message: "policy requires an independent review and no decisive review of the current content exists",
    });
  } else if (decisive.disposition === "accept") {
    review = "accepted";
  } else if (decisive.disposition === "revise") {
    review = "required";
    reasons.push({
      code: "review.required",
      severity: "info",
      message: `review "${decisive.id}" asked for revision; a new decisive review of the current content is required`,
    });
    reasons.push(...findingDiagnostics(decisive));
  } else {
    review = "blocked";
    reasons.push({
      code: "review.blocked",
      severity: "error",
      message: `latest binding review "${decisive.id}" disposition is "${decisive.disposition}"`,
    });
    reasons.push(...findingDiagnostics(decisive));
  }

  let publication: GovernanceView["publication"] = "eligible";
  if (review !== "accepted" && review !== "not_required") {
    publication = "blocked";
    reasons.push({
      code: "policy.blocked",
      severity: "error",
      message: `publication requires decisive review; governance review state is "${review}"`,
    });
  }
  if (!input.destinationRegistered) {
    publication = "blocked";
    reasons.push({
      code: "publication.destination_unknown",
      severity: "error",
      message: "the destination named by the candidate intervention is not registered on this loop",
    });
  }
  if (!input.authorityConfigured) {
    publication = "blocked";
    reasons.push({
      code: "policy.authority_insufficient",
      severity: "error",
      message: "no authority port is configured on this loop; publication cannot be authorized",
    });
  }
  return { review, publication, validation: "untested", reasons };
}
