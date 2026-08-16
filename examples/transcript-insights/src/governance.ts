// Governance lookup for an existing candidate.
//
// The façade computes a GovernanceView only as part of propose(), so this
// consumer reaches it by re-proposing the candidate's exact stored content:
// the content digest is already claimed, the engine deduplicates instead of
// creating a twin, and the returned view folds the currently stored reviews.
// Zero writes, but a governance READ should not need a propose round-trip —
// recorded as consumer feedback in the PR.
import type { Candidate, CandidateInput, GovernanceView } from "@cormidia/learning-loop";
import { parseCandidate } from "@cormidia/learning-loop";
import type { DemoLoop } from "./compose.js";
import { LEARNING_NAMESPACE } from "./fold.js";

export interface CandidateGovernance {
  readonly candidate: Candidate;
  readonly governance: GovernanceView;
}

export async function governanceViewFor(loop: DemoLoop, candidateId: string): Promise<CandidateGovernance | undefined> {
  const stored = await loop.store.get({ namespace: LEARNING_NAMESPACE, kind: "candidate", id: candidateId });
  if (stored === undefined) return undefined;
  const candidate = parseCandidate(stored.value);
  const input: CandidateInput = {
    id: candidate.id,
    scope: candidate.scope,
    problem: candidate.problem,
    hypothesis: candidate.hypothesis,
    evidenceIds: candidate.evidenceIds,
    intervention: candidate.intervention,
    proposedRisk: candidate.proposedRisk,
    proposedBy: loop.distiller,
    ...(candidate.supersedes !== undefined ? { supersedes: candidate.supersedes } : {}),
  };
  const outcome = await loop.learning.propose(input);
  return { candidate: outcome.candidate, governance: outcome.governance };
}
