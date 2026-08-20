// Governance lookup for an existing inert candidate through the kernel's
// read-only façade. The consumer neither knows the candidate store key nor
// re-proposes content to recover the current folded governance state.
import type { CandidateView } from "@cormidia/learning-loop";
import type { DemoLoop } from "./compose.js";

export function governanceViewFor(loop: DemoLoop, candidateId: string): Promise<CandidateView | undefined> {
  return loop.learning.getCandidateView({ candidateId });
}
