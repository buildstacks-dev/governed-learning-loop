// Private create-only Candidate content ownership/result lock.
import { toJsonValue } from "../canonical/to-json-value.js";
import { LearningLoopError } from "../diagnostics.js";
import type { CandidateV2 } from "../records/candidate.js";
import { parseCandidate } from "../records/candidate.js";
import { readFields } from "../parse/toolkit.js";
import type { Parse } from "../parse/toolkit.js";
import type { CandidateRecurrenceClaim } from "./recurrence-claims.js";
import { parseCandidateRecurrenceClaim } from "./recurrence-claims.js";
import type { EngineContext } from "./context.js";
import { loadStoredRecord, recordDigest } from "./context.js";
import { parseDigestAt, parseDurableId } from "../records/semantic-shared.js";

export interface CandidateContentLock {
  readonly candidateId: string;
  readonly contentDigest: string;
  readonly recurrenceClaimDigest?: string;
  readonly recurrenceClaim?: CandidateRecurrenceClaim;
  readonly candidate?: CandidateV2;
  readonly admissionExpected?: true;
}

const parseTrue: Parse<true> = (value, path) => {
  if (value !== true) {
    throw new LearningLoopError("store.corrupt", [
      { code: "store.corrupt", severity: "error", message: "candidate admission marker is invalid", path },
    ]);
  }
  return true;
};

function recurrenceClaimMatchesCandidate(candidate: CandidateV2, claim: CandidateRecurrenceClaim): boolean {
  return (
    claim.candidateId === candidate.id &&
    claim.candidateDigest === candidate.contentDigest &&
    recordDigest(toJsonValue(claim.candidate)) === recordDigest(toJsonValue(candidate))
  );
}

export function parseCandidateContentLock(input: unknown): CandidateContentLock {
  const fields = readFields(input, ["candidate-by-digest"]);
  const recurrenceClaimDigest = fields.opt("recurrenceClaimDigest", parseDigestAt);
  const recurrenceClaim = fields.opt("recurrenceClaim", parseCandidateRecurrenceClaim);
  const candidate = fields.opt("candidate", (value) => {
    const parsed = parseCandidate(value);
    if (parsed.schemaVersion !== 2) {
      throw new LearningLoopError("store.corrupt", [
        { code: "store.corrupt", severity: "error", message: "candidate content lock embeds a legacy Candidate" },
      ]);
    }
    return parsed;
  });
  const admissionExpected = fields.opt("admissionExpected", parseTrue);
  if (
    (recurrenceClaimDigest === undefined) !== (recurrenceClaim === undefined) ||
    (recurrenceClaimDigest === undefined) !== (candidate === undefined) ||
    (recurrenceClaim !== undefined && recurrenceClaim.claimDigest !== recurrenceClaimDigest)
  ) {
    throw new LearningLoopError("store.corrupt", [
      { code: "store.corrupt", severity: "error", message: "candidate content lock recurrence bytes are mismatched" },
    ]);
  }
  const candidateId = fields.req("candidateId", parseDurableId);
  const contentDigest = fields.req("contentDigest", parseDigestAt);
  if (
    candidate !== undefined &&
    (candidate.id !== candidateId ||
      candidate.contentDigest !== contentDigest ||
      recurrenceClaim === undefined ||
      !recurrenceClaimMatchesCandidate(candidate, recurrenceClaim))
  ) {
    throw new LearningLoopError("store.corrupt", [
      { code: "store.corrupt", severity: "error", message: "candidate content lock embedded bytes are mismatched" },
    ]);
  }
  if (admissionExpected === true && recurrenceClaim?.status !== "grouped") {
    throw new LearningLoopError("store.corrupt", [
      { code: "store.corrupt", severity: "error", message: "Candidate admission marker requires grouped recurrence" },
    ]);
  }
  return {
    candidateId,
    contentDigest,
    ...(recurrenceClaimDigest === undefined ? {} : { recurrenceClaimDigest }),
    ...(recurrenceClaim === undefined ? {} : { recurrenceClaim }),
    ...(candidate === undefined ? {} : { candidate }),
    ...(admissionExpected === undefined ? {} : { admissionExpected }),
  };
}

export function candidateContentLockDigest(lock: CandidateContentLock): string {
  return recordDigest(toJsonValue(lock));
}

export async function loadCandidateContentLock(
  context: EngineContext,
  contentDigest: string,
): Promise<CandidateContentLock | undefined> {
  const stored = await loadStoredRecord(context, "candidate-by-digest", contentDigest);
  if (stored === undefined) return undefined;
  const lock = parseCandidateContentLock(stored.value);
  if (lock.contentDigest !== contentDigest) {
    throw new LearningLoopError("store.corrupt", [
      { code: "store.corrupt", severity: "error", message: "candidate content lock key is mismatched" },
    ]);
  }
  return lock;
}
