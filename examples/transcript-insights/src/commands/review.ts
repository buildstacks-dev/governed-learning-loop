// `review` — the human reviews from the CLI as principal "local-human", a
// different principal (and independence domain) from the proposing
// demo-distiller, so the conservative policy's independence rule is
// satisfied. This demonstrates Govern: the engine refuses self-review and
// binding mismatches, the candidate stays inert either way, and publication
// remains blocked — nothing this app does can activate anything.
import { randomUUID } from "node:crypto";
import type { CandidateReviewer } from "@cormidia/learning-loop";
import type { DemoLoop } from "../compose.js";
import { governanceViewFor } from "../governance.js";
import type { CliOutput } from "../output.js";

export async function runReviewCommand(
  loop: DemoLoop,
  candidateId: string,
  disposition: "accept" | "reject",
  note: string | undefined,
  out: CliOutput,
): Promise<number> {
  const before = await governanceViewFor(loop, candidateId);
  if (before === undefined) {
    out.write(`error: candidate "${candidateId}" does not exist in this state directory`);
    return 1;
  }
  const reviewer: CandidateReviewer = {
    id: "transcript-insights-cli",
    version: "0.1.0",
    principal: loop.human,
    review: (input) =>
      Promise.resolve({
        candidateId: input.candidate.id,
        candidateDigest: input.candidate.contentDigest,
        disposition,
        findings: note === undefined ? [] : [{ code: "human.note", severity: "info", message: note }],
      }),
  };
  const review = await loop.learning.reviewCandidate({
    id: `review-${candidateId}-${randomUUID().slice(0, 8)}`,
    candidateId,
    reviewer,
  });
  out.write(`review recorded: ${review.id}`);
  out.write(`  candidate: ${review.candidateId}`);
  out.write(`  disposition: ${review.disposition}`);
  out.write(`  reviewer: ${review.reviewer.id} (domain ${review.reviewer.independenceDomain})`);
  if (note !== undefined) out.write("  note recorded (info-severity finding)");
  const after = await governanceViewFor(loop, candidateId);
  if (after === undefined) {
    out.write("error: candidate vanished after review; the store may be corrupt");
    return 1;
  }
  out.write("governance view:");
  out.write(`  review: ${after.governance.review}`);
  out.write(
    `  publication: ${after.governance.publication} — candidates stay inert; ` +
      "nothing this app does can activate anything",
  );
  out.write(`  validation: ${after.governance.validation}`);
  return 0;
}
