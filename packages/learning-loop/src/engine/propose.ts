// learning.propose — records an INERT candidate (contract §Candidate; a
// candidate can never resolve into active context). Scope is validated by the
// configured scope policy, the content digest binds the governance-relevant
// fields, and proposals deduplicate atomically on that digest through a
// create-only index record: identical content never creates a twin candidate.
import { toJsonValue } from "../canonical/to-json-value.js";
import type { Diagnostic } from "../diagnostics.js";
import { LearningLoopError } from "../diagnostics.js";
import { parseArrayOf, parseJson, parseNonEmptyText, parseOneOf, readFields } from "../parse/toolkit.js";
import type { Parse } from "../parse/toolkit.js";
import type { Candidate, CandidateIntervention, CandidateV2, RiskTier } from "../records/candidate.js";
import { candidateContentDigest, candidateScopeDigest, parseCandidate } from "../records/candidate.js";
import type { VerifiedPrincipal } from "../records/principal.js";
import type { Scope } from "../records/scope.js";
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
import { candidateGovernanceStateOf } from "./views.js";
import { resolveCandidateEvidence } from "./evidence-binding.js";

export interface CandidateInput {
  readonly id: string;
  readonly scope: Scope;
  readonly problem: string;
  readonly hypothesis: string;
  /** Exact durable observation ids; the kernel resolves and persists EvidenceRefs. */
  readonly evidenceIds: readonly string[];
  readonly intervention: CandidateIntervention;
  readonly proposedRisk: RiskTier;
  readonly proposedBy: VerifiedPrincipal;
  readonly supersedes?: string;
}

export interface ProposeOutcome extends Omit<CandidateView, "candidate"> {
  readonly candidate: CandidateV2;
}

const RISK_TIERS = ["T0", "T1", "T2", "T3"] as const;
const parseUnknown: Parse<unknown> = (value) => value;

const parseInterventionAt: Parse<CandidateIntervention> = (value, path) => {
  const fields = readFields(value, path);
  return {
    destinationId: fields.req("destinationId", parseNonEmptyText),
    kind: fields.req("kind", parseNonEmptyText),
    content: fields.req("content", parseJson),
    rollbackIntent: fields.req("rollbackIntent", parseNonEmptyText),
  };
};

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
  const state = await candidateGovernanceStateOf(context, candidate, requiresIndependentReview);
  const governance =
    extraReasons.length === 0
      ? state.governance
      : { ...state.governance, reasons: [...extraReasons, ...state.governance.reasons] };
  if (candidate.schemaVersion !== 2) {
    throw new LearningLoopError("store.corrupt", [
      {
        code: "store.corrupt",
        severity: "error",
        message: "the schema-v2 propose path resolved a legacy candidate",
      },
    ]);
  }
  return { candidate, governance, evidenceHealth: state.evidenceHealth };
}

export async function runPropose(context: EngineContext, input: CandidateInput): Promise<ProposeOutcome> {
  // Capture every caller-owned property exactly once before the first await.
  // The verified handle is a runtime capability; later getter reads must not
  // be able to swap its durable attribution projection.
  const proposedBy = input.proposedBy;
  assertVerifiedPrincipal(context.identity, proposedBy, "proposedBy");
  const fields = readFields(input, ["candidateInput"]);
  const id = fields.req("id", parseNonEmptyText);
  const scope = context.scopePolicy.validate(fields.req("scope", parseUnknown));
  const problem = fields.req("problem", parseNonEmptyText);
  const hypothesis = fields.req("hypothesis", parseNonEmptyText);
  const evidenceIds = fields.req("evidenceIds", parseArrayOf(parseNonEmptyText));
  const intervention = fields.req("intervention", parseInterventionAt);
  const proposedRisk = fields.req("proposedRisk", parseOneOf(RISK_TIERS));
  const supersedes = fields.opt("supersedes", parseNonEmptyText);
  const proposerRef = Object.freeze({ ...proposedBy.ref });
  const proposerAttestationDigest = proposedBy.attestationDigest;

  const evidence = await resolveCandidateEvidence(context, evidenceIds, scope);
  if (evidence.health.status === "invalid" || evidence.refs.length !== evidenceIds.length) {
    throw new LearningLoopError("candidate.evidence_invalid", evidence.health.diagnostics);
  }

  let originalDigest: string | undefined;
  if (supersedes !== undefined) {
    if (supersedes === id) {
      throw new LearningLoopError("candidate.supersedes_invalid", [
        {
          code: "candidate.supersedes_invalid",
          severity: "error",
          message: "a candidate cannot supersede itself",
        },
      ]);
    }
    const predecessor = await loadCandidate(context, supersedes);
    if (predecessor === undefined) {
      throw new LearningLoopError("candidate.supersedes_not_found", [
        {
          code: "candidate.supersedes_not_found",
          severity: "error",
          message: "the candidate named by supersedes does not exist",
        },
      ]);
    }
    if (candidateScopeDigest(predecessor.scope) !== candidateScopeDigest(scope)) {
      throw new LearningLoopError("candidate.supersedes_scope_mismatch", [
        {
          code: "candidate.supersedes_scope_mismatch",
          severity: "error",
          message: "a candidate may supersede only a predecessor with the exact same scope",
        },
      ]);
    }
    originalDigest = predecessor.contentDigest;
  }

  const digestBase = {
    schemaVersion: 2 as const,
    scope,
    problem,
    hypothesis,
    evidenceRefs: evidence.refs,
    intervention,
    proposedRisk,
  };
  const contentDigest =
    supersedes === undefined || originalDigest === undefined
      ? candidateContentDigest(digestBase)
      : candidateContentDigest({ ...digestBase, supersedes, originalDigest });
  const assembledBase = {
    schemaVersion: 2 as const,
    id,
    scope,
    problem,
    hypothesis,
    evidenceRefs: evidence.refs,
    intervention,
    proposedRisk,
    proposedBy: proposerRef,
    proposerAttestationDigest,
    proposedAt: context.clock.now(),
    contentDigest,
  };
  const assembled: CandidateV2 =
    supersedes === undefined || originalDigest === undefined
      ? assembledBase
      : { ...assembledBase, supersedes, originalDigest };
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
