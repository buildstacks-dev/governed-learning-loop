// Read-only validation for Candidate v2 supersession lineage. A stored
// predecessor id/digest pair is never trusted merely because it participates
// in the candidate content digest.
import type { Diagnostic } from "../diagnostics.js";
import type { Candidate } from "../records/candidate.js";
import { candidateScopeDigest } from "../records/candidate.js";
import type { EngineContext } from "./context.js";
import { loadCandidate } from "./context.js";

export async function candidateLineageDiagnostics(
  context: EngineContext,
  candidate: Candidate,
): Promise<readonly Diagnostic[]> {
  if (candidate.schemaVersion === 1 || candidate.supersedes === undefined) return [];
  const predecessor = await loadCandidate(context, candidate.supersedes);
  if (predecessor === undefined) {
    return [
      {
        code: "candidate.supersedes_not_found",
        severity: "error",
        message: "the candidate predecessor is missing",
      },
    ];
  }
  if (predecessor.id === candidate.id) {
    return [
      {
        code: "candidate.supersedes_invalid",
        severity: "error",
        message: "a candidate cannot supersede itself",
      },
    ];
  }
  if (predecessor.contentDigest !== candidate.originalDigest) {
    return [
      {
        code: "candidate.original_digest_mismatch",
        severity: "error",
        message: "the candidate original digest does not match its predecessor",
      },
    ];
  }
  if (candidateScopeDigest(predecessor.scope) !== candidateScopeDigest(candidate.scope)) {
    return [
      {
        code: "candidate.supersedes_scope_mismatch",
        severity: "error",
        message: "the candidate predecessor belongs to another exact scope",
      },
    ];
  }
  return [];
}
