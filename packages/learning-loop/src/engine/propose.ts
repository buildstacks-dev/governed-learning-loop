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
import { parseDurableId } from "../records/semantic-shared.js";
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
import { ensureCandidateReviewMarker } from "./candidate-review-index.js";
import type { CandidateView } from "./query.js";
import { candidateGovernanceStateOf } from "./views.js";
import { persistCandidateScopeMembership } from "./candidate-scope-index.js";
import { resolveCandidateEvidence } from "./evidence-binding.js";
import { candidateDerivationSupersessionDiagnostics, resolveDerivedCandidateInput } from "./derivation-binding.js";
import type { CandidateContentLock } from "./candidate-content-lock.js";
import { loadCandidateContentLock, parseCandidateContentLock } from "./candidate-content-lock.js";
import type { CandidateAdmissionPreparation } from "./recurrence-admission.js";
import { admitCandidateByRecurrence, prepareCandidateAdmission } from "./recurrence-admission.js";
import type { CandidateRecurrenceClaim } from "./recurrence-claims.js";
import {
  loadCandidateRecurrenceClaim,
  loadCommittedDerivationRecurrenceClaims,
  persistCandidateRecurrenceClaim,
  persistCandidateRecurrenceDecision,
  prepareCandidateRecurrenceClaim,
} from "./recurrence-claims.js";

interface CandidateInputCommon {
  readonly id: string;
  readonly proposedRisk: RiskTier;
  readonly proposedBy: VerifiedPrincipal;
  readonly supersedes?: string;
}

export type CandidateInput =
  | (CandidateInputCommon & {
      readonly scope: Scope;
      readonly problem: string;
      readonly hypothesis: string;
      readonly evidenceIds: readonly string[];
      readonly intervention: CandidateIntervention;
      readonly derivationId?: never;
    })
  | (CandidateInputCommon & {
      readonly scope: Scope;
      readonly derivationId: string;
      readonly problem?: never;
      readonly hypothesis?: never;
      readonly evidenceIds?: never;
      readonly intervention?: never;
    });

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

function hasOwnField(input: unknown, key: string): boolean {
  return typeof input === "object" && input !== null && Object.hasOwn(input, key);
}

function snapshotScope(scope: Scope): Scope {
  return Object.freeze(scope.map((segment) => Object.freeze({ type: segment.type, id: segment.id })));
}

async function loadAnchoredRetryClaim(
  context: EngineContext,
  candidateId: string,
  scope: Scope,
  proposerRef: VerifiedPrincipal["ref"],
  proposerAttestationDigest: string,
): Promise<
  | {
      readonly claim: CandidateRecurrenceClaim;
      readonly candidate: CandidateV2;
    }
  | undefined
> {
  const claim = await loadCandidateRecurrenceClaim(context, candidateId);
  if (claim === undefined) return undefined;
  if (claim.scopeDigest !== candidateScopeDigest(scope)) {
    throw new LearningLoopError("store.corrupt", [
      { code: "store.corrupt", severity: "error", message: "anchored Candidate retry input is mismatched" },
    ]);
  }
  if (
    recordDigest(toJsonValue(claim.candidate.proposedBy)) !== recordDigest(toJsonValue(proposerRef)) ||
    claim.candidate.proposerAttestationDigest !== proposerAttestationDigest
  ) {
    throw new LearningLoopError("store.conflict", [
      { code: "store.conflict", severity: "error", message: "anchored Candidate belongs to another proposer" },
    ]);
  }
  const stored = await loadStoredRecord(context, "candidate-by-digest", claim.candidateDigest);
  if (stored === undefined) return { claim, candidate: claim.candidate };
  const entry = parseCandidateContentLock(stored.value);
  if (entry.candidateId !== candidateId) {
    throw new LearningLoopError("store.conflict", [
      { code: "store.conflict", severity: "error", message: "candidate content is owned by another proposal" },
    ]);
  }
  if (
    entry.contentDigest !== claim.candidateDigest ||
    entry.recurrenceClaimDigest !== claim.claimDigest ||
    entry.recurrenceClaim === undefined ||
    recordDigest(toJsonValue(entry.recurrenceClaim)) !== recordDigest(toJsonValue(claim))
  ) {
    throw new LearningLoopError("store.corrupt", [
      { code: "store.corrupt", severity: "error", message: "anchored Candidate retry content lock is mismatched" },
    ]);
  }
  const lockedCandidate = entry.candidate;
  if (
    lockedCandidate === undefined ||
    recordDigest(toJsonValue(lockedCandidate.proposedBy)) !== recordDigest(toJsonValue(proposerRef)) ||
    lockedCandidate.proposerAttestationDigest !== proposerAttestationDigest
  ) {
    throw new LearningLoopError("store.conflict", [
      { code: "store.conflict", severity: "error", message: "anchored Candidate belongs to another proposer" },
    ]);
  }
  return { claim, candidate: lockedCandidate };
}

async function outcomeFor(
  context: EngineContext,
  candidate: Candidate,
  extraReasons: readonly Diagnostic[],
): Promise<ProposeOutcome> {
  const requiresIndependentReview = context.policyRules.risks[effectiveRisk(context, candidate)].independentReview;
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
  return {
    candidate,
    governance,
    evidenceHealth: state.evidenceHealth,
    derivationLineage: state.derivationLineage,
    recurrenceLineage: state.recurrenceLineage,
    admissionLineage: state.admissionLineage,
  };
}

export async function runPropose(context: EngineContext, input: CandidateInput): Promise<ProposeOutcome> {
  // Capture every caller-owned property exactly once before the first await.
  // The verified handle is a runtime capability; later getter reads must not
  // be able to swap its durable attribution projection.
  const proposedBy = input.proposedBy;
  assertVerifiedPrincipal(context.identity, proposedBy, "proposedBy");
  const fields = readFields(input, ["candidateInput"]);
  const id = fields.req("id", parseNonEmptyText);
  let scope = snapshotScope(context.scopePolicy.validate(fields.req("scope", parseUnknown)));
  const hasDerivationId = hasOwnField(input, "derivationId");
  const derivationId = hasDerivationId ? fields.req("derivationId", parseDurableId) : undefined;
  const proposedRisk = fields.req("proposedRisk", parseOneOf(RISK_TIERS));
  const supersedes = fields.opt("supersedes", parseNonEmptyText);
  const proposerRef = Object.freeze({ ...proposedBy.ref });
  const proposerAttestationDigest = proposedBy.attestationDigest;
  let problem: string;
  let hypothesis: string;
  let evidenceRefs: CandidateV2["evidenceRefs"];
  let intervention: CandidateIntervention;
  let derivationRef: CandidateV2["derivationRef"];
  let anchoredRetry:
    | {
        readonly claim: CandidateRecurrenceClaim;
        readonly candidate: CandidateV2;
      }
    | undefined;
  if (derivationId === undefined) {
    problem = fields.req("problem", parseNonEmptyText);
    hypothesis = fields.req("hypothesis", parseNonEmptyText);
    const evidenceIds = fields.req("evidenceIds", parseArrayOf(parseNonEmptyText));
    intervention = fields.req("intervention", parseInterventionAt);
    anchoredRetry = await loadAnchoredRetryClaim(context, id, scope, proposerRef, proposerAttestationDigest);
    if (anchoredRetry !== undefined) {
      const locked = anchoredRetry.candidate;
      if (
        anchoredRetry.claim.status !== "not_bound" ||
        anchoredRetry.claim.reason !== "manual" ||
        locked.derivationRef !== undefined ||
        locked.problem !== problem ||
        locked.hypothesis !== hypothesis ||
        recordDigest(toJsonValue(locked.intervention)) !== recordDigest(toJsonValue(intervention)) ||
        locked.proposedRisk !== proposedRisk ||
        locked.supersedes !== supersedes ||
        recordDigest(toJsonValue(locked.evidenceRefs.map((reference) => reference.recordId))) !==
          recordDigest(toJsonValue(evidenceIds))
      ) {
        throw new LearningLoopError("store.conflict", [
          { code: "store.conflict", severity: "error", message: "manual Candidate retry differs from anchored bytes" },
        ]);
      }
      scope = locked.scope;
      problem = locked.problem;
      hypothesis = locked.hypothesis;
      evidenceRefs = locked.evidenceRefs;
      intervention = locked.intervention;
    } else {
      const evidence = await resolveCandidateEvidence(context, evidenceIds, scope);
      if (evidence.health.status === "invalid" || evidence.refs.length !== evidenceIds.length) {
        throw new LearningLoopError("candidate.evidence_invalid", evidence.health.diagnostics);
      }
      evidenceRefs = evidence.refs;
    }
  } else {
    for (const override of ["problem", "hypothesis", "evidenceIds", "intervention"]) {
      if (hasOwnField(input, override)) {
        throw new LearningLoopError("candidate.derivation_override", [
          {
            code: "candidate.derivation_override",
            severity: "error",
            message: "derivation-backed proposal cannot override kernel-derived semantic fields",
          },
        ]);
      }
    }
    anchoredRetry = await loadAnchoredRetryClaim(context, id, scope, proposerRef, proposerAttestationDigest);
    if (anchoredRetry === undefined) {
      const resolved = await resolveDerivedCandidateInput(context, derivationId, scope);
      scope = resolved.derivation.scope;
      problem = resolved.problem;
      hypothesis = resolved.hypothesis;
      evidenceRefs = resolved.evidenceRefs;
      intervention = resolved.intervention;
      derivationRef = { id: resolved.derivation.id, digest: resolved.derivation.derivationDigest };
    } else {
      if (
        anchoredRetry.candidate.derivationRef?.id !== derivationId ||
        anchoredRetry.candidate.proposedRisk !== proposedRisk ||
        anchoredRetry.candidate.supersedes !== supersedes
      ) {
        throw new LearningLoopError("store.conflict", [
          { code: "store.conflict", severity: "error", message: "derived Candidate retry differs from anchored bytes" },
        ]);
      }
      const locked = anchoredRetry.candidate;
      scope = locked.scope;
      problem = locked.problem;
      hypothesis = locked.hypothesis;
      evidenceRefs = locked.evidenceRefs;
      intervention = locked.intervention;
      derivationRef = locked.derivationRef;
    }
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
    evidenceRefs,
    intervention,
    proposedRisk,
    ...(derivationRef === undefined ? {} : { derivationRef }),
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
    evidenceRefs,
    intervention,
    proposedRisk,
    ...(derivationRef === undefined ? {} : { derivationRef }),
    proposedBy: proposerRef,
    proposerAttestationDigest,
    proposedAt: context.clock.now(),
    contentDigest,
  };
  const assembled: CandidateV2 =
    supersedes === undefined || originalDigest === undefined
      ? assembledBase
      : { ...assembledBase, supersedes, originalDigest };
  const parsedCandidate = parseCandidate(assembled);
  if (parsedCandidate.schemaVersion !== 2) {
    throw new LearningLoopError("store.corrupt", [
      { code: "store.corrupt", severity: "error", message: "propose assembled a legacy Candidate" },
    ]);
  }
  let candidate: CandidateV2 = parsedCandidate;
  const derivationSupersession = await candidateDerivationSupersessionDiagnostics(context, candidate);
  if (derivationSupersession.length > 0) {
    throw new LearningLoopError("candidate.derivation_supersedes_mismatch", derivationSupersession);
  }
  if (anchoredRetry?.candidate !== undefined) {
    if (anchoredRetry.candidate.contentDigest !== candidate.contentDigest) {
      throw new LearningLoopError("store.corrupt", [
        { code: "store.corrupt", severity: "error", message: "anchored Candidate content changed during retry" },
      ]);
    }
    candidate = anchoredRetry.candidate;
  }
  const terminalCandidate = await loadCandidate(context, candidate.id);
  if (terminalCandidate !== undefined) {
    if (terminalCandidate.contentDigest !== candidate.contentDigest) {
      throw new LearningLoopError("store.conflict", [
        {
          code: "store.conflict",
          severity: "error",
          message: `candidate "${candidate.id}" already exists with different content`,
        },
      ]);
    }
    return outcomeFor(context, terminalCandidate, [
      {
        code: "candidate.duplicate_content",
        severity: "info",
        message: "candidate id already holds the exact content; returning the terminal Candidate",
      },
    ]);
  }
  const recurrenceClaim = anchoredRetry?.claim ?? (await prepareCandidateRecurrenceClaim(context, candidate));
  if (!recurrenceClaimMatchesCandidate(candidate, recurrenceClaim)) {
    throw new LearningLoopError("store.corrupt", [
      { code: "store.corrupt", severity: "error", message: "Candidate recurrence decision is mismatched" },
    ]);
  }
  const indexEntry: CandidateContentLock = {
    candidateId: candidate.id,
    contentDigest,
    recurrenceClaimDigest: recurrenceClaim.claimDigest,
    recurrenceClaim,
    candidate,
    ...(recurrenceClaim.status === "grouped" && context.detectorOrchestrationPolicy !== undefined
      ? { admissionExpected: true }
      : {}),
  };
  const preexistingContentLock = await loadCandidateContentLock(context, contentDigest);
  const legacyInProgressLock =
    preexistingContentLock !== undefined &&
    preexistingContentLock.candidateId === candidate.id &&
    preexistingContentLock.contentDigest === candidate.contentDigest &&
    preexistingContentLock.recurrenceClaimDigest === recurrenceClaim.claimDigest &&
    preexistingContentLock.admissionExpected !== true;
  if (
    legacyInProgressLock &&
    recurrenceClaim.status === "grouped" &&
    context.detectorOrchestrationPolicy !== undefined
  ) {
    throw new LearningLoopError("candidate.admission_refused", [
      {
        code: "candidate.admission_refused",
        severity: "error",
        message: "Candidate recurrence admission was refused",
      },
    ]);
  }
  let admissionPreparation: CandidateAdmissionPreparation | undefined;
  if (context.detectorOrchestrationPolicy !== undefined && candidate.derivationRef !== undefined) {
    if (recurrenceClaim.status === "grouped") {
      admissionPreparation = await prepareCandidateAdmission(context, candidate, recurrenceClaim, indexEntry);
      if (admissionPreparation.status === "completed") {
        return outcomeFor(context, admissionPreparation.candidate, [
          {
            code: "candidate.duplicate_content",
            severity: "info",
            message: "Candidate recurrence admission was already completed",
          },
        ]);
      }
    } else {
      const exactDerivationClaims = await loadCommittedDerivationRecurrenceClaims(
        context,
        candidate.derivationRef.id,
        candidate.derivationRef.digest,
      );
      if (exactDerivationClaims.length > 0) {
        throw new LearningLoopError("candidate.admission_refused", [
          {
            code: "candidate.admission_refused",
            severity: "error",
            message: "Candidate recurrence admission was refused",
          },
        ]);
      }
    }
  }
  await persistCandidateRecurrenceDecision(context, recurrenceClaim);
  const operationId = `propose/${candidate.id}/${contentDigest}`;

  // Atomic private content-ownership/result lock: exactly one candidate id and
  // recurrence decision can own this content digest. It is audit lineage, not
  // a public authority or publication entitlement.
  const indexStatus = await createOnly(context, "candidate-by-digest", contentDigest, indexEntry, operationId);
  if (indexStatus === "created") {
    return createClaimedCandidate(context, candidate, recurrenceClaim, operationId, admissionPreparation);
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
  const existingEntry = parseCandidateContentLock(storedIndex.value);
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
    const anchoredClaim = await loadCandidateRecurrenceClaim(context, candidate.id);
    if (existingEntry.recurrenceClaimDigest !== undefined && existingEntry.recurrenceClaim !== undefined) {
      const exactAnchoredClaim = anchoredClaim ?? existingEntry.recurrenceClaim;
      if (
        existingEntry.recurrenceClaimDigest !== exactAnchoredClaim.claimDigest ||
        !recurrenceClaimMatchesCandidate(candidate, exactAnchoredClaim) ||
        (anchoredClaim !== undefined &&
          recordDigest(toJsonValue(anchoredClaim)) !== recordDigest(toJsonValue(existingEntry.recurrenceClaim)))
      ) {
        throw new LearningLoopError("store.corrupt", [
          {
            code: "store.corrupt",
            severity: "error",
            message: "candidate content lock and anchored recurrence decision are mismatched",
          },
        ]);
      }
      return createClaimedCandidate(context, candidate, exactAnchoredClaim, operationId, admissionPreparation);
    }
    if (anchoredClaim !== undefined || existingEntry.recurrenceClaim !== undefined) {
      throw new LearningLoopError("store.corrupt", [
        {
          code: "store.corrupt",
          severity: "error",
          message: "candidate recurrence decision is not anchored by its content lock",
        },
      ]);
    }
  }
  if (existing === undefined && existingEntry.candidateId !== candidate.id) {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const committed = await loadCandidate(context, existingEntry.candidateId);
      if (committed !== undefined) {
        if (committed.contentDigest !== contentDigest) {
          throw new LearningLoopError("store.corrupt", [
            {
              code: "store.corrupt",
              severity: "error",
              message: "in-progress recurrence claim committed other content",
            },
          ]);
        }
        return outcomeFor(context, committed, [
          {
            code: "candidate.duplicate_content",
            severity: "info",
            message: "candidate content was committed concurrently; returning the exact content owner",
          },
        ]);
      }
      await loadCandidateRecurrenceClaim(context, existingEntry.candidateId);
    }
    throw new LearningLoopError("store.conflict", [
      {
        code: "store.conflict",
        severity: "error",
        message: "candidate content is already owned by another in-progress proposal; retry",
      },
    ]);
  }
  if (existing !== undefined && existingEntry.candidateId === candidate.id) {
    throw new LearningLoopError("store.conflict", [
      {
        code: "store.conflict",
        severity: "error",
        message: "candidate id already holds other content and its content lock cannot be repaired",
      },
    ]);
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
  return createClaimedCandidate(context, candidate, recurrenceClaim, operationId, admissionPreparation);
}

async function createClaimedCandidate(
  context: EngineContext,
  candidate: CandidateV2,
  recurrenceClaim: CandidateRecurrenceClaim,
  operationId: string,
  admissionPreparation?: CandidateAdmissionPreparation,
): Promise<ProposeOutcome> {
  const existing = await loadCandidate(context, candidate.id);
  if (existing !== undefined) {
    if (existing.contentDigest === candidate.contentDigest) {
      const lock = await loadCandidateContentLock(context, candidate.contentDigest);
      if (existing.schemaVersion === 2 && recurrenceClaim.status === "grouped" && lock?.admissionExpected === true) {
        const completed = await admitCandidateByRecurrence(
          context,
          existing,
          recurrenceClaim,
          lock,
          admissionPreparation,
        );
        return outcomeFor(context, completed, []);
      }
      return outcomeFor(context, existing, []);
    }
    throw new LearningLoopError("store.conflict", [
      {
        code: "store.conflict",
        severity: "error",
        message: `candidate "${candidate.id}" already exists with different content; candidates are create-only and never overwritten`,
      },
    ]);
  }
  await assertCandidateContentLock(context, candidate, recurrenceClaim);
  const lock = await loadCandidateContentLock(context, candidate.contentDigest);
  if (lock === undefined) {
    throw new LearningLoopError("store.corrupt", [
      { code: "store.corrupt", severity: "error", message: "candidate content lock disappeared before receipt" },
    ]);
  }
  if (recurrenceClaim.status === "grouped" && lock.admissionExpected === true) {
    const admitted = await admitCandidateByRecurrence(context, candidate, recurrenceClaim, lock, admissionPreparation);
    return outcomeFor(context, admitted, []);
  }
  await ensureCandidateReviewMarker(context, candidate);
  await persistCandidateRecurrenceClaim(context, recurrenceClaim);
  await assertCandidateContentLock(context, candidate, recurrenceClaim);
  await persistCandidateScopeMembership(context, candidate);
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

function recurrenceClaimMatchesCandidate(candidate: Candidate, claim: CandidateRecurrenceClaim): boolean {
  if (
    candidate.schemaVersion !== 2 ||
    claim.candidateId !== candidate.id ||
    claim.candidateDigest !== candidate.contentDigest ||
    claim.scopeDigest !== candidateScopeDigest(candidate.scope) ||
    recordDigest(toJsonValue(claim.candidate)) !== recordDigest(toJsonValue(candidate))
  ) {
    return false;
  }
  if (claim.status === "not_bound") {
    const manual = candidate.schemaVersion !== 2 || candidate.derivationRef === undefined;
    return (claim.reason === "manual") === manual;
  }
  return (
    candidate.schemaVersion === 2 &&
    candidate.derivationRef !== undefined &&
    candidate.derivationRef.id === claim.derivationId &&
    candidate.derivationRef.digest === claim.derivationDigest &&
    (candidate.supersedes === undefined
      ? claim.supersedes === null
      : claim.supersedes?.candidateId === candidate.supersedes)
  );
}

async function assertCandidateContentLock(
  context: EngineContext,
  candidate: Candidate,
  recurrenceClaim: CandidateRecurrenceClaim,
): Promise<void> {
  const stored = await loadStoredRecord(context, "candidate-by-digest", candidate.contentDigest);
  if (stored === undefined) {
    throw new LearningLoopError("store.corrupt", [
      { code: "store.corrupt", severity: "error", message: "candidate content lock disappeared before receipt" },
    ]);
  }
  const entry = parseCandidateContentLock(stored.value);
  if (
    entry.candidateId !== candidate.id ||
    entry.contentDigest !== candidate.contentDigest ||
    entry.recurrenceClaimDigest !== recurrenceClaim.claimDigest ||
    entry.recurrenceClaim === undefined ||
    recordDigest(toJsonValue(entry.recurrenceClaim)) !== recordDigest(toJsonValue(recurrenceClaim))
  ) {
    throw new LearningLoopError("store.conflict", [
      { code: "store.conflict", severity: "error", message: "candidate content lock changed before receipt" },
    ]);
  }
}
