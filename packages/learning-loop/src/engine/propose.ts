// learning.propose — records an INERT candidate (contract §Candidate; a
// candidate can never resolve into active context). Scope is validated by the
// configured scope policy, the content digest binds the governance-relevant
// fields, and proposals deduplicate atomically on that digest through a
// create-only index record: identical content never creates a twin candidate.
import { toJsonValue } from "../canonical/to-json-value.js";
import type { Diagnostic } from "../diagnostics.js";
import { LearningLoopError } from "../diagnostics.js";
import { parseNonEmptyText, readFields } from "../parse/toolkit.js";
import type { Candidate } from "../records/candidate.js";
import { candidateContentDigest, parseCandidate } from "../records/candidate.js";
import type { VerifiedPrincipal } from "../records/principal.js";
import type { EngineContext } from "./context.js";
import {
  createOnly,
  effectiveRisk,
  loadCandidate,
  loadStoredRecord,
  parseWriteResult,
  recordDigest,
  recordKey,
} from "./context.js";
import { assertVerifiedPrincipal } from "./identity.js";
import type { CandidateView } from "./query.js";
import { governanceViewOf } from "./views.js";

export type CandidateInput = Omit<
  Candidate,
  "schemaVersion" | "proposedBy" | "proposerAttestationDigest" | "proposedAt" | "contentDigest"
> & {
  readonly proposedBy: VerifiedPrincipal;
};

export interface ProposeOutcome extends CandidateView {}

interface DigestIndexEntry {
  readonly candidateId: string;
  readonly contentDigest: string;
}

function parseDigestIndexEntry(input: unknown): DigestIndexEntry {
  const fields = readFields(input, ["candidate-by-digest"]);
  return {
    candidateId: fields.req("candidateId", parseNonEmptyText),
    contentDigest: fields.req("contentDigest", parseNonEmptyText),
  };
}

async function outcomeFor(
  context: EngineContext,
  candidate: Candidate,
  extraReasons: readonly Diagnostic[],
): Promise<ProposeOutcome> {
  const requiresIndependentReview = context.policyRules.risks[effectiveRisk(candidate)].independentReview;
  const view = await governanceViewOf(context, candidate, requiresIndependentReview);
  const governance = extraReasons.length === 0 ? view : { ...view, reasons: [...extraReasons, ...view.reasons] };
  return { candidate, governance };
}

export async function runPropose(context: EngineContext, input: CandidateInput): Promise<ProposeOutcome> {
  assertVerifiedPrincipal(context.identity, input.proposedBy, "proposedBy");
  const scope = context.scopePolicy.validate(input.scope);
  const contentDigest = candidateContentDigest({
    scope,
    problem: input.problem,
    hypothesis: input.hypothesis,
    evidenceIds: input.evidenceIds,
    intervention: input.intervention,
    proposedRisk: input.proposedRisk,
    ...(input.supersedes !== undefined ? { supersedes: input.supersedes } : {}),
  });
  const assembled: Candidate = {
    schemaVersion: 1,
    id: input.id,
    scope,
    problem: input.problem,
    hypothesis: input.hypothesis,
    evidenceIds: input.evidenceIds,
    intervention: input.intervention,
    proposedRisk: input.proposedRisk,
    proposedBy: input.proposedBy.ref,
    proposerAttestationDigest: input.proposedBy.attestationDigest,
    proposedAt: context.clock.now(),
    contentDigest,
    ...(input.supersedes !== undefined ? { supersedes: input.supersedes } : {}),
  };
  const candidate = parseCandidate(assembled);
  const operationId = `propose/${candidate.id}/${contentDigest}`;

  // Atomic content claim: the digest-index record is create-only, so exactly
  // one candidate id can own a content digest. If a previous propose crashed
  // (or was refused) between claiming the digest and persisting its
  // candidate, the stale claim is repaired below via compareAndSet — the
  // index is engine bookkeeping, never a governance record.
  const indexEntry: DigestIndexEntry = { candidateId: candidate.id, contentDigest };
  const indexStatus = await createOnly(context, "candidate-by-digest", contentDigest, indexEntry, operationId);
  if (indexStatus === "created") {
    return createClaimedCandidate(context, candidate, operationId);
  }

  // exists_same or conflict: this content digest is already claimed.
  const storedIndex = await loadStoredRecord(context, "candidate-by-digest", contentDigest);
  if (storedIndex === undefined) {
    throw new LearningLoopError("store.corrupt", [
      {
        code: "store.corrupt",
        severity: "error",
        message: `digest index for ${contentDigest} vanished between create and read`,
      },
    ]);
  }
  const existingEntry = parseDigestIndexEntry(storedIndex.value);
  const existing = await loadCandidate(context, existingEntry.candidateId);
  if (existing !== undefined && existing.contentDigest === contentDigest) {
    return outcomeFor(context, existing, [
      {
        code: "candidate.duplicate_content",
        severity: "info",
        message: `content digest ${contentDigest} already belongs to candidate "${existing.id}"; returning the existing candidate instead of creating a twin`,
        details: { candidateId: existing.id, contentDigest },
      },
    ]);
  }
  if (existing === undefined && existingEntry.candidateId === candidate.id) {
    // Our own earlier identical propose crashed after claiming the digest but
    // before persisting the candidate; resume forward.
    return createClaimedCandidate(context, candidate, operationId);
  }
  // Stale claim: the named candidate either never materialized or holds
  // different content (its propose was refused after the claim). Take the
  // claim over, then persist.
  const indexValue = toJsonValue(indexEntry);
  const rawRepaired: unknown = await context.store.compareAndSet(
    recordKey("candidate-by-digest", contentDigest),
    storedIndex.revision,
    indexValue,
    recordDigest(indexValue),
    operationId,
  );
  const repaired = parseWriteResult(rawRepaired);
  if (repaired.status === "conflict") {
    throw new LearningLoopError("store.conflict", [
      {
        code: "store.conflict",
        severity: "error",
        message: `content digest ${contentDigest} was claimed concurrently; retry the proposal`,
        details: { contentDigest },
      },
    ]);
  }
  if (repaired.status === "created") {
    throw new LearningLoopError("store.corrupt", [
      {
        code: "store.corrupt",
        severity: "error",
        message: "store created a missing digest index during compare-and-set",
      },
    ]);
  }
  return createClaimedCandidate(context, candidate, operationId);
}

async function createClaimedCandidate(
  context: EngineContext,
  candidate: Candidate,
  operationId: string,
): Promise<ProposeOutcome> {
  const status = await createOnly(context, "candidate", candidate.id, candidate, operationId);
  if (status === "conflict") {
    // The candidate id is already taken by DIFFERENT content: create-only
    // means no overwrite, ever. The digest claim stays behind and is repaired
    // by the next propose of this content.
    throw new LearningLoopError("store.conflict", [
      {
        code: "store.conflict",
        severity: "error",
        message: `candidate "${candidate.id}" already exists with different content; candidates are create-only and never overwritten`,
        details: { candidateId: candidate.id },
      },
    ]);
  }
  return outcomeFor(context, candidate, []);
}
