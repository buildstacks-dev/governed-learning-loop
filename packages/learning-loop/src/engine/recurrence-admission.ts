// Serialized Candidate recurrence admission orchestration and audit views.
import { sha256HexOfCanonicalJson } from "../canonical/canonical-json.js";
import { toJsonValue } from "../canonical/to-json-value.js";
import { LearningLoopError } from "../diagnostics.js";
import type { Candidate, CandidateV2 } from "../records/candidate.js";
import { candidateScopeDigest } from "../records/candidate.js";
import type { DetectorPackRunGroupGovernance } from "../records/detector-pack-run-receipt.js";
import { invalid } from "../parse/toolkit.js";
import type { CandidateContentLock } from "./candidate-content-lock.js";
import { candidateContentLockDigest, loadCandidateContentLock } from "./candidate-content-lock.js";
import type { EngineContext } from "./context.js";
import { createOnly, loadCandidate, loadStoredRecord, recordDigest } from "./context.js";
import { loadCandidateScopeMembership, persistCandidateScopeMembership } from "./candidate-scope-index.js";
import type { CurrentGroupCandidateClaim } from "./recurrence-claims.js";
import {
  candidateRecurrenceGroupMemberCount,
  loadCandidateRecurrenceClaim,
  loadCandidateRecurrenceGroupMemberKeys,
  loadCandidateRecurrenceLineage,
  persistCandidateRecurrenceGroupMember,
  validatePreparedCandidateRecurrenceClaim,
} from "./recurrence-claims.js";
import type { recurrenceReceiptLineage } from "./detector-recurrence.js";
import { loadRegistrySnapshot } from "./semantic-graph.js";
import {
  assessRecurrenceGroupGovernance,
  createRecurrenceGovernanceReadCache,
  embeddedAssessedGovernanceIsExact,
} from "./recurrence-governance.js";
import type { RecurrenceGovernanceReadCache } from "./recurrence-governance.js";
import {
  ensureCandidateReviewMarker,
  loadCandidateReviewMarker,
  loadIndexedCandidateReviews,
} from "./candidate-review-index.js";
import { revalidateCandidateDerivation } from "./derivation-binding.js";
import { revalidateCandidateEvidence } from "./evidence-binding.js";
import { candidateLineageDiagnostics } from "./candidate-lineage.js";
import type {
  CandidateAdmissionBinding,
  CandidateAdmissionReservation,
  CandidateAdmissionSnapshot,
  CandidateAdmissionStreamState,
  CandidateAdmissionSubjectCache,
  CandidateClaimRef,
  GroupedCandidateClaim,
  StoredAdmissionSlot,
} from "./recurrence-admission-records.js";
import {
  MAX_ADMISSION_RECORD_BYTES,
  MAX_ADMISSION_SLOTS,
  appendCandidateAdmissionSlot,
  buildCandidateAdmissionBinding,
  candidateAdmissionReservationDigest,
  candidateAdmissionReservationKeyDigest,
  candidateAdmissionRawBundleBytes,
  candidateAdmissionSnapshotDigest,
  candidateContentLockMatchesReservation,
  candidateAdmissionSubjectBindingStatus,
  createCandidateAdmissionSubjectCache,
  loadCandidateAdmissionBinding,
  loadCandidateAdmissionReservation,
  loadCandidateAdmissionReservationBundle,
  loadCandidateAdmissionSnapshot,
  loadCandidateAdmissionStream,
  nextStreamSnapshotDigest,
  parseCandidateAdmissionReservation,
  parseCandidateAdmissionBinding,
  parseCandidateAdmissionSnapshot,
  persistCandidateAdmissionBinding,
  persistCandidateAdmissionReservation,
  persistCandidateAdmissionSnapshot,
  streamSnapshotDigest,
} from "./recurrence-admission-records.js";

export type {
  CandidateAdmissionBinding,
  CandidateAdmissionReservation,
  CandidateAdmissionSnapshot,
  CandidateAdmissionStreamState,
} from "./recurrence-admission-records.js";
export {
  appendCandidateAdmissionSlot,
  buildCandidateAdmissionBinding,
  candidateAdmissionBindingDigest,
  candidateAdmissionReservationDigest,
  candidateAdmissionReservationKeyDigest,
  candidateAdmissionRawBundleBytes,
  candidateAdmissionSnapshotDigest,
  candidateContentLockMatchesReservation,
  loadCandidateAdmissionBinding,
  loadCandidateAdmissionReservation,
  loadCandidateAdmissionSnapshot,
  loadCandidateAdmissionStream,
  parseCandidateAdmissionBinding,
  parseCandidateAdmissionReservation,
  parseCandidateAdmissionSnapshot,
  persistCandidateAdmissionBinding,
  persistCandidateAdmissionReservation,
  persistCandidateAdmissionSnapshot,
} from "./recurrence-admission-records.js";

const MAX_SNAPSHOT_ATTEMPTS = 3;
const MAX_ADMISSION_VALIDATIONS = 5_000;

export interface CandidateAdmissionEligibilityCache {
  readonly subject: CandidateAdmissionSubjectCache;
  readonly governance: RecurrenceGovernanceReadCache;
  readonly statuses: Map<string, Promise<"not_subject" | "valid" | "invalid">>;
  readonly active: Set<string>;
}

export function createCandidateAdmissionEligibilityCache(): CandidateAdmissionEligibilityCache {
  return {
    subject: createCandidateAdmissionSubjectCache(),
    governance: createRecurrenceGovernanceReadCache(),
    statuses: new Map(),
    active: new Set(),
  };
}

function digest(input: unknown): string {
  return sha256HexOfCanonicalJson(toJsonValue(input));
}

export function assertCandidateAdmissionHistoryByteLimit(
  retainedBytes: number,
  snapshot: CandidateAdmissionSnapshot,
  reservation: CandidateAdmissionReservation,
): void {
  const prospectiveBytes = candidateAdmissionRawBundleBytes(reservation, snapshot);
  if (retainedBytes + prospectiveBytes > MAX_ADMISSION_RECORD_BYTES) {
    throw new LearningLoopError("candidate.admission_limit", [
      {
        code: "candidate.admission_limit",
        severity: "error",
        message: "Candidate recurrence admission history exceeds its work ceiling",
      },
    ]);
  }
}

function admissionRefused(): never {
  throw new LearningLoopError("candidate.admission_refused", [
    {
      code: "candidate.admission_refused",
      severity: "error",
      message: "Candidate recurrence admission was refused",
    },
  ]);
}

function exactClaimRef(left: CandidateClaimRef | null, right: CandidateClaimRef | null): boolean {
  return recordDigest(toJsonValue(left)) === recordDigest(toJsonValue(right));
}

function activeFrontier(claims: readonly CurrentGroupCandidateClaim[]): readonly CurrentGroupCandidateClaim[] {
  const byDigest = new Map(claims.map((current) => [current.claim.claimDigest, current]));
  const superseded = new Set<string>();
  for (const current of claims) {
    const predecessor = current.claim.supersedes;
    if (predecessor === null) continue;
    const exact = byDigest.get(predecessor.claimDigest);
    if (
      exact === undefined ||
      exact.candidate.id !== predecessor.candidateId ||
      exact.candidate.contentDigest !== predecessor.candidateDigest
    ) {
      throw invalid("store.corrupt", "Candidate admission frontier has an impossible predecessor", []);
    }
    superseded.add(predecessor.claimDigest);
  }
  return claims.filter((current) => !superseded.has(current.claim.claimDigest));
}

async function materializeCandidateAdmissionSnapshot(
  context: EngineContext,
  claim: GroupedCandidateClaim,
  stream: CandidateAdmissionStreamState,
): Promise<CandidateAdmissionSnapshot> {
  const policy = context.detectorOrchestrationPolicy;
  if (policy === undefined) admissionRefused();
  const candidateDerivation = await revalidateCandidateDerivation(context, claim.candidate);
  const candidateEvidence = await revalidateCandidateEvidence(context, claim.candidate);
  const candidateLineage = await candidateLineageDiagnostics(context, claim.candidate);
  if (
    candidateDerivation.status !== "resolved" ||
    candidateEvidence.health.status !== "ready" ||
    candidateLineage.length > 0
  ) {
    admissionRefused();
  }
  let lineage: Awaited<ReturnType<typeof recurrenceReceiptLineage>>;
  try {
    lineage = await validatePreparedCandidateRecurrenceClaim(context, claim.candidate, claim);
  } catch (error) {
    if (error instanceof LearningLoopError && error.code === "candidate.recurrence_invalid") admissionRefused();
    throw error;
  }
  const cache = createRecurrenceGovernanceReadCache();
  const admissionEligibilityCache = createCandidateAdmissionEligibilityCache();
  const workBudget = { claimRefs: 0 };
  let governance: DetectorPackRunGroupGovernance;
  try {
    governance = await assessRecurrenceGroupGovernance(context, {
      groupKeyDigest: claim.groupKeyDigest,
      currentDistinctEpisodeCount: lineage.episodeIdentityDigests.length,
      capped: false,
      policy,
      workBudget,
      groupLineage: lineage,
      cache,
      candidateAdmissionStatus: (candidate) =>
        candidateAdmissionEligibilityStatus(context, candidate, admissionEligibilityCache),
    });
  } catch (error) {
    if (error instanceof LearningLoopError && error.code === "detector.limit_exceeded") {
      throw new LearningLoopError("candidate.admission_limit", [
        {
          code: "candidate.admission_limit",
          severity: "error",
          message: "Candidate recurrence admission exceeded its work ceiling",
        },
      ]);
    }
    throw error;
  }
  let assessment: CandidateAdmissionSnapshot["assessment"];
  if (governance.status === "assessed") {
    assessment = { status: "assessed", governance };
  } else if (governance.reason === "candidate_review_history_unavailable" && claim.supersedes !== null) {
    const pendingClaims = cache.groupClaims.get(claim.groupKeyDigest);
    const frontier = pendingClaims === undefined ? [] : activeFrontier(await pendingClaims);
    const predecessor = frontier[0];
    if (
      frontier.length !== 1 ||
      predecessor === undefined ||
      predecessor.claim.claimDigest !== claim.supersedes.claimDigest ||
      predecessor.candidate.id !== claim.supersedes.candidateId ||
      predecessor.candidate.contentDigest !== claim.supersedes.candidateDigest
    ) {
      admissionRefused();
    }
    assessment = { status: "historical_supersession", predecessor: claim.supersedes };
  } else {
    admissionRefused();
  }
  const base = {
    loopRegistryRevision: context.registryRevision,
    policy,
    groupKeyDigest: claim.groupKeyDigest,
    scopeDigest: claim.scopeDigest,
    admissionStreamSnapshotDigest: stream.snapshotDigest,
    groupMembers: lineage.members,
    groupMemberSnapshotDigest: digest(lineage.members),
    executionCount: lineage.executionCount,
    episodeIdentityDigests: lineage.episodeIdentityDigests,
    episodeIdentitySetDigest: digest(lineage.episodeIdentityDigests),
    distinctEpisodeCount: lineage.episodeIdentityDigests.length,
    assessment,
  };
  return parseCandidateAdmissionSnapshot({
    schemaVersion: 1,
    ...base,
    snapshotDigest: candidateAdmissionSnapshotDigest(base),
  });
}

export async function buildStableCandidateAdmissionSnapshot(
  context: EngineContext,
  claim: GroupedCandidateClaim,
  stream: CandidateAdmissionStreamState,
): Promise<CandidateAdmissionSnapshot> {
  for (let attempt = 0; attempt < MAX_SNAPSHOT_ATTEMPTS; attempt += 1) {
    const first = await materializeCandidateAdmissionSnapshot(context, claim, stream);
    const second = await materializeCandidateAdmissionSnapshot(context, claim, stream);
    if (first.snapshotDigest === second.snapshotDigest) return second;
  }
  throw new LearningLoopError("candidate.snapshot_changed", [
    {
      code: "candidate.snapshot_changed",
      severity: "error",
      message: "Candidate recurrence admission snapshot changed repeatedly",
    },
  ]);
}

function reservationBasis(
  snapshot: CandidateAdmissionSnapshot,
  claim: GroupedCandidateClaim,
):
  | {
      readonly basis: CandidateAdmissionReservation["basis"];
      readonly requiredSupersedes: CandidateClaimRef | null;
    }
  | undefined {
  if (snapshot.assessment.status === "historical_supersession") {
    if (!exactClaimRef(claim.supersedes, snapshot.assessment.predecessor)) return undefined;
    return { basis: "historical_supersession", requiredSupersedes: snapshot.assessment.predecessor };
  }
  const governance = snapshot.assessment.governance;
  if (governance.groupDisposition !== "available") return undefined;
  const requiredSupersedes = governance.requiredSupersedes;
  if (!exactClaimRef(claim.supersedes, requiredSupersedes)) return undefined;
  if (requiredSupersedes === null) return { basis: "group_available", requiredSupersedes };
  if (governance.governingRejection !== null || governance.requiredOverrideCount !== null) {
    if (
      governance.governingRejection === null ||
      governance.requiredOverrideCount === null ||
      snapshot.distinctEpisodeCount < governance.requiredOverrideCount
    ) {
      return undefined;
    }
    return { basis: "rejection_override", requiredSupersedes };
  }
  return { basis: "required_supersession", requiredSupersedes };
}

export function buildCandidateAdmissionReservation(input: {
  readonly candidate: CandidateV2;
  readonly claim: GroupedCandidateClaim;
  readonly lock: CandidateContentLock;
  readonly snapshot: CandidateAdmissionSnapshot;
}): CandidateAdmissionReservation {
  if (
    input.lock.admissionExpected !== true ||
    input.lock.candidateId !== input.candidate.id ||
    input.lock.contentDigest !== input.candidate.contentDigest ||
    input.lock.recurrenceClaimDigest !== input.claim.claimDigest ||
    input.snapshot.groupKeyDigest !== input.claim.groupKeyDigest ||
    input.snapshot.scopeDigest !== input.claim.scopeDigest
  ) {
    throw invalid("store.corrupt", "Candidate admission input lineage is mismatched", []);
  }
  const basis = reservationBasis(input.snapshot, input.claim);
  if (basis === undefined) admissionRefused();
  const reservationKeyDigest = candidateAdmissionReservationKeyDigest(input.snapshot);
  const base = {
    reservationKeyDigest,
    candidateId: input.candidate.id,
    candidateDigest: input.candidate.contentDigest,
    candidateClaimDigest: input.claim.claimDigest,
    candidateContentLockDigest: candidateContentLockDigest(input.lock),
    groupKeyDigest: input.claim.groupKeyDigest,
    scopeDigest: input.claim.scopeDigest,
    policyDigest: input.snapshot.policy.policyDigest,
    snapshotDigest: input.snapshot.snapshotDigest,
    basis: basis.basis,
    requiredSupersedes: basis.requiredSupersedes,
    candidate: input.candidate,
    candidateClaim: input.claim,
  };
  return parseCandidateAdmissionReservation({
    schemaVersion: 1,
    ...base,
    reservationDigest: candidateAdmissionReservationDigest(base),
  });
}

export type CandidateAdmissionPreparation =
  | { readonly status: "completed"; readonly candidate: CandidateV2 }
  | {
      readonly status: "prepared";
      readonly stream: CandidateAdmissionStreamState;
      readonly snapshot: CandidateAdmissionSnapshot;
      readonly reservation: CandidateAdmissionReservation;
    };

interface ForwardCompletedAdmissionStream {
  readonly stream: CandidateAdmissionStreamState;
  readonly retainedBytes: number;
}

export async function prepareCandidateAdmission(
  context: EngineContext,
  candidate: CandidateV2,
  claim: GroupedCandidateClaim,
  lock: CandidateContentLock,
): Promise<CandidateAdmissionPreparation> {
  let forwarded: ForwardCompletedAdmissionStream;
  try {
    forwarded = await forwardCompleteCandidateAdmissions(context, claim.groupKeyDigest);
  } catch (error) {
    if (error instanceof LearningLoopError && error.code === "detector.limit_exceeded") {
      throw new LearningLoopError("candidate.admission_limit", [
        {
          code: "candidate.admission_limit",
          severity: "error",
          message: "Candidate recurrence admission stream reached its ceiling",
        },
      ]);
    }
    throw error;
  }
  const stream = forwarded.stream;
  const completed = await loadCandidate(context, candidate.id);
  if (completed !== undefined) {
    if (
      completed.schemaVersion !== 2 ||
      recordDigest(toJsonValue(completed)) !== recordDigest(toJsonValue(candidate))
    ) {
      throw invalid("store.corrupt", "completed admission belongs to another Candidate", []);
    }
    const lineage = await loadCandidateAdmissionLineageRecords(context, completed);
    if (lineage.status !== "resolved") {
      throw invalid("store.corrupt", "completed Candidate has no exact admission lineage", []);
    }
    return { status: "completed", candidate: completed };
  }
  if (stream.slots.length >= MAX_ADMISSION_SLOTS) {
    throw new LearningLoopError("candidate.admission_limit", [
      {
        code: "candidate.admission_limit",
        severity: "error",
        message: "Candidate recurrence admission stream reached its ceiling",
      },
    ]);
  }
  if ((await candidateRecurrenceGroupMemberCount(context, claim.groupKeyDigest)) >= MAX_ADMISSION_SLOTS) {
    throw new LearningLoopError("candidate.admission_limit", [
      {
        code: "candidate.admission_limit",
        severity: "error",
        message: "Candidate recurrence admission group reached its ceiling",
      },
    ]);
  }
  let snapshot: CandidateAdmissionSnapshot;
  let reservation: CandidateAdmissionReservation;
  try {
    snapshot = await buildStableCandidateAdmissionSnapshot(context, claim, stream);
    if (reservationBasis(snapshot, claim) === undefined) admissionRefused();
    reservation = buildCandidateAdmissionReservation({ candidate, claim, lock, snapshot });
    assertCandidateAdmissionHistoryByteLimit(forwarded.retainedBytes, snapshot, reservation);
  } catch (error) {
    if (error instanceof LearningLoopError && error.code === "schema.invalid") {
      throw new LearningLoopError("candidate.admission_limit", [
        {
          code: "candidate.admission_limit",
          severity: "error",
          message: "Candidate recurrence admission record exceeded its ceiling",
        },
      ]);
    }
    throw error;
  }
  return { status: "prepared", stream, snapshot, reservation };
}

function admissionInProgress(): never {
  throw new LearningLoopError("candidate.admission_in_progress", [
    {
      code: "candidate.admission_in_progress",
      severity: "error",
      message: "Candidate recurrence admission is being completed",
    },
  ]);
}

function slotMatchesReservation(slot: StoredAdmissionSlot, reservation: CandidateAdmissionReservation): boolean {
  return (
    slot.value.reservationKeyDigest === reservation.reservationKeyDigest &&
    slot.value.reservationDigest === reservation.reservationDigest &&
    slot.value.snapshotDigest === reservation.snapshotDigest
  );
}

async function reservationSlotIsExact(
  context: EngineContext,
  reservation: CandidateAdmissionReservation,
): Promise<boolean> {
  const stream = await loadCandidateAdmissionStream(context, reservation.groupKeyDigest);
  const slotIndex = stream.slots.findIndex(
    (candidateSlot) => candidateSlot.id === `slot:${reservation.reservationKeyDigest}`,
  );
  const slot = slotIndex < 0 ? undefined : stream.slots[slotIndex];
  if (slot === undefined || !slotMatchesReservation(slot, reservation)) {
    return false;
  }
  const snapshot = await loadCandidateAdmissionSnapshot(context, reservation.snapshotDigest);
  if (
    snapshot === undefined ||
    snapshot.admissionStreamSnapshotDigest !== streamSnapshotDigest(stream.slots.slice(0, slotIndex))
  ) {
    return false;
  }
  return true;
}

async function assertReservationSlot(
  context: EngineContext,
  reservation: CandidateAdmissionReservation,
): Promise<void> {
  if (!(await reservationSlotIsExact(context, reservation))) {
    throw invalid("store.corrupt", "Candidate admission reservation has no exact winning slot", []);
  }
  const stream = await loadCandidateAdmissionStream(context, reservation.groupKeyDigest);
  const slotIndex = stream.slots.findIndex((slot) => slot.id === `slot:${reservation.reservationKeyDigest}`);
  for (const predecessorSlot of stream.slots.slice(0, slotIndex)) {
    const predecessor = await loadCandidateAdmissionReservation(context, predecessorSlot.value.reservationDigest);
    if (predecessor === undefined || (await loadCandidate(context, predecessor.candidateId)) === undefined) {
      throw invalid("store.corrupt", "Candidate admission slot has a nonterminal predecessor", []);
    }
  }
}

async function admissionSnapshotLineageIsExact(
  context: EngineContext,
  snapshot: CandidateAdmissionSnapshot,
  reservation: CandidateAdmissionReservation,
  eligibilityCache: CandidateAdmissionEligibilityCache,
): Promise<boolean> {
  if ((await loadRegistrySnapshot(context, snapshot.loopRegistryRevision)) === undefined) return false;
  let lineage: Awaited<ReturnType<typeof recurrenceReceiptLineage>>;
  try {
    lineage = await validatePreparedCandidateRecurrenceClaim(
      context,
      reservation.candidate,
      reservation.candidateClaim,
    );
  } catch (error) {
    if (error instanceof LearningLoopError && error.code === "candidate.recurrence_invalid") return false;
    throw error;
  }
  const currentMembers = new Map(lineage.members.map((member) => [member.executionId, member]));
  if (
    lineage.binding?.groupKeyDigest !== snapshot.groupKeyDigest ||
    snapshot.groupMembers.some((member) => {
      const current = currentMembers.get(member.executionId);
      return current === undefined || recordDigest(toJsonValue(current)) !== recordDigest(toJsonValue(member));
    }) ||
    snapshot.episodeIdentityDigests.some((identity) => !lineage.episodeIdentityDigests.includes(identity))
  ) {
    return false;
  }
  if (snapshot.assessment.status === "assessed") {
    const embeddedExact = await embeddedAssessedGovernanceIsExact(context, {
      groupKeyDigest: snapshot.groupKeyDigest,
      governance: snapshot.assessment.governance,
      workBudget: { claimRefs: 0 },
      groupLineage: lineage,
      cache: eligibilityCache.governance,
    });
    if (!embeddedExact) return false;
    for (const binding of snapshot.assessment.governance.candidateBindings) {
      const boundCandidate = await loadCandidate(context, binding.candidateId);
      if (
        boundCandidate === undefined ||
        boundCandidate.contentDigest !== binding.candidateDigest ||
        (await candidateAdmissionEligibilityStatus(context, boundCandidate, eligibilityCache)) === "invalid"
      ) {
        return false;
      }
    }
    return true;
  }
  const predecessor = await loadCandidate(context, snapshot.assessment.predecessor.candidateId);
  const predecessorClaim = await loadCandidateRecurrenceClaim(context, snapshot.assessment.predecessor.candidateId);
  if (
    predecessor === undefined ||
    predecessorClaim?.status !== "grouped" ||
    predecessor.contentDigest !== snapshot.assessment.predecessor.candidateDigest ||
    predecessorClaim.claimDigest !== snapshot.assessment.predecessor.claimDigest ||
    predecessorClaim.groupKeyDigest !== snapshot.groupKeyDigest
  ) {
    return false;
  }
  const predecessorLineage = await loadCandidateRecurrenceLineage(context, predecessor);
  const reviews = await loadIndexedCandidateReviews(context, predecessor);
  const predecessorAdmission = await candidateAdmissionEligibilityStatus(context, predecessor, eligibilityCache);
  return (
    predecessorLineage.status === "resolved" && reviews.status === "unmarked" && predecessorAdmission === "not_subject"
  );
}

async function completeAdmissionReservation(
  context: EngineContext,
  reservation: CandidateAdmissionReservation,
): Promise<CandidateV2> {
  await assertReservationSlot(context, reservation);
  const lock = await loadCandidateContentLock(context, reservation.candidateDigest);
  if (lock === undefined || !candidateContentLockMatchesReservation(lock, reservation)) {
    throw invalid("store.corrupt", "Candidate admission content ownership is mismatched", []);
  }
  const claim = await loadCandidateRecurrenceClaim(context, reservation.candidateId);
  if (
    claim?.status !== "grouped" ||
    claim.claimDigest !== reservation.candidateClaimDigest ||
    recordDigest(toJsonValue(claim)) !== recordDigest(toJsonValue(reservation.candidateClaim))
  ) {
    throw invalid("store.corrupt", "Candidate admission recurrence decision is mismatched", []);
  }
  const exactReviewMarker = await loadCandidateReviewMarker(context, reservation.candidate);
  if (exactReviewMarker.status !== "ready") {
    throw invalid("store.corrupt", "winning admission Candidate review marker is missing", []);
  }
  const exactBinding = buildCandidateAdmissionBinding(reservation);
  const terminalBefore = await loadCandidate(context, reservation.candidateId);
  if (terminalBefore !== undefined) {
    const scopeMembership = await loadCandidateScopeMembership(context, {
      scopeDigest: candidateScopeDigest(reservation.candidate.scope),
      candidateId: reservation.candidateId,
    });
    const storedBinding = await loadCandidateAdmissionBinding(context, reservation.candidateId);
    if (
      terminalBefore.schemaVersion !== 2 ||
      recordDigest(toJsonValue(terminalBefore)) !== recordDigest(toJsonValue(reservation.candidate)) ||
      storedBinding === undefined ||
      // A terminal written before the scope index existed legitimately has no
      // membership record; only a mismatched membership is corruption.
      (scopeMembership !== undefined && scopeMembership.candidateDigest !== reservation.candidateDigest) ||
      recordDigest(toJsonValue(storedBinding)) !== recordDigest(toJsonValue(exactBinding))
    ) {
      throw invalid("store.corrupt", "terminal Candidate admission graph is mismatched", []);
    }
    return terminalBefore;
  }
  if (exactReviewMarker.refCount !== 0) {
    const terminalAfterMarker = await loadCandidate(context, reservation.candidateId);
    const bindingAfterMarker = await loadCandidateAdmissionBinding(context, reservation.candidateId);
    const memberKeysAfterMarker = await loadCandidateRecurrenceGroupMemberKeys(context, reservation.groupKeyDigest);
    if (
      terminalAfterMarker?.schemaVersion === 2 &&
      recordDigest(toJsonValue(terminalAfterMarker)) === recordDigest(toJsonValue(reservation.candidate)) &&
      bindingAfterMarker !== undefined &&
      recordDigest(toJsonValue(bindingAfterMarker)) === recordDigest(toJsonValue(exactBinding)) &&
      memberKeysAfterMarker.has(`${reservation.candidateId}\u0000${reservation.candidateClaimDigest}`)
    ) {
      return terminalAfterMarker;
    }
    throw invalid("store.corrupt", "nonterminal admission Candidate has pre-receipt review history", []);
  }
  const snapshot = await loadCandidateAdmissionSnapshot(context, reservation.snapshotDigest);
  if (
    snapshot === undefined ||
    !(await admissionSnapshotLineageIsExact(context, snapshot, reservation, createCandidateAdmissionEligibilityCache()))
  ) {
    throw invalid("store.corrupt", "Candidate admission snapshot lineage is no longer exact", []);
  }
  await persistCandidateAdmissionBinding(context, exactBinding);
  await persistCandidateRecurrenceGroupMember(context, reservation.candidateClaim);
  await persistCandidateScopeMembership(context, reservation.candidate);
  const status = await createOnly(
    context,
    "candidate",
    reservation.candidateId,
    reservation.candidate,
    `candidate-admission/${reservation.reservationDigest}/${reservation.candidateId}`,
  );
  if (status === "conflict") throw invalid("store.corrupt", "winning admission Candidate id is occupied", []);
  const terminal = await loadCandidate(context, reservation.candidateId);
  if (
    terminal?.schemaVersion !== 2 ||
    recordDigest(toJsonValue(terminal)) !== recordDigest(toJsonValue(reservation.candidate))
  ) {
    throw invalid("store.corrupt", "winning admission Candidate receipt was not preserved", []);
  }
  return terminal;
}

export async function forwardCompleteCandidateAdmissions(
  context: EngineContext,
  groupKeyDigest: string,
): Promise<ForwardCompletedAdmissionStream> {
  const stream = await loadCandidateAdmissionStream(context, groupKeyDigest);
  const groupCandidateMembers = await loadCandidateRecurrenceGroupMemberKeys(context, groupKeyDigest);
  const markerWorkBudget = { claimRefs: 0 };
  let prefixDigest = streamSnapshotDigest([]);
  let retainedBytes = 0;
  for (const [index, slot] of stream.slots.entries()) {
    const bundle = await loadCandidateAdmissionReservationBundle(context, slot.value.reservationDigest);
    const reservation = bundle?.reservation;
    if (bundle === undefined || reservation === undefined || !slotMatchesReservation(slot, reservation)) {
      throw invalid("store.corrupt", "Candidate admission slot reservation is missing or mismatched", []);
    }
    const snapshot = bundle.snapshot;
    retainedBytes += bundle.rawBytes;
    if (retainedBytes > MAX_ADMISSION_RECORD_BYTES) {
      throw new LearningLoopError("candidate.admission_limit", [
        {
          code: "candidate.admission_limit",
          severity: "error",
          message: "Candidate recurrence admission history exceeds its work ceiling",
        },
      ]);
    }
    if (
      snapshot === undefined ||
      snapshot.admissionStreamSnapshotDigest !== prefixDigest ||
      reservation.groupKeyDigest !== groupKeyDigest
    ) {
      throw invalid("store.corrupt", "Candidate admission slot does not bind its exact stream predecessor", []);
    }
    const terminal = await loadCandidate(context, reservation.candidateId);
    if (terminal === undefined) {
      if (index !== stream.slots.length - 1) {
        throw invalid("store.corrupt", "nonterminal Candidate admission slot is not the stream head", []);
      }
      await completeAdmissionReservation(context, reservation);
    } else {
      const binding = await loadCandidateAdmissionBinding(context, reservation.candidateId);
      const lock = await loadCandidateContentLock(context, reservation.candidateDigest);
      const claim = await loadCandidateRecurrenceClaim(context, reservation.candidateId);
      const marker = await loadCandidateReviewMarker(context, reservation.candidate, markerWorkBudget);
      const expectedBinding = buildCandidateAdmissionBinding(reservation);
      const memberKey = `${reservation.candidateId}\u0000${reservation.candidateClaimDigest}`;
      const memberPresent =
        groupCandidateMembers.has(memberKey) ||
        (await loadCandidateRecurrenceGroupMemberKeys(context, groupKeyDigest)).has(memberKey);
      if (
        terminal.schemaVersion !== 2 ||
        recordDigest(toJsonValue(terminal)) !== recordDigest(toJsonValue(reservation.candidate)) ||
        binding === undefined ||
        recordDigest(toJsonValue(binding)) !== recordDigest(toJsonValue(expectedBinding)) ||
        lock === undefined ||
        !candidateContentLockMatchesReservation(lock, reservation) ||
        claim?.status !== "grouped" ||
        recordDigest(toJsonValue(claim)) !== recordDigest(toJsonValue(reservation.candidateClaim)) ||
        marker.status !== "ready" ||
        !memberPresent
      ) {
        throw invalid("store.corrupt", "completed Candidate admission slot is mismatched", []);
      }
    }
    prefixDigest = nextStreamSnapshotDigest(prefixDigest, slot);
  }
  return { stream, retainedBytes };
}

export async function admitCandidateByRecurrence(
  context: EngineContext,
  candidate: CandidateV2,
  claim: GroupedCandidateClaim,
  lock: CandidateContentLock,
  preparation?: CandidateAdmissionPreparation,
): Promise<CandidateV2> {
  const terminal = await loadCandidate(context, candidate.id);
  if (terminal !== undefined) {
    if (terminal.schemaVersion !== 2 || recordDigest(toJsonValue(terminal)) !== recordDigest(toJsonValue(candidate))) {
      throw invalid("store.corrupt", "terminal admission Candidate is mismatched", []);
    }
    const lineage = await loadCandidateAdmissionLineageRecords(context, terminal);
    if (lineage.status !== "resolved") {
      throw invalid("store.corrupt", "terminal admission Candidate has no exact admission binding", []);
    }
    return terminal;
  }
  if (preparation?.status === "completed") return preparation.candidate;
  await ensureCandidateReviewMarker(context, candidate);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const prepared = preparation ?? (await prepareCandidateAdmission(context, candidate, claim, lock));
    preparation = undefined;
    if (prepared.status === "completed") return prepared.candidate;
    const stream = prepared.stream;
    const snapshot = prepared.snapshot;
    const reservation = prepared.reservation;
    await persistCandidateAdmissionSnapshot(context, snapshot);
    await persistCandidateAdmissionReservation(context, reservation);
    const appended = await appendCandidateAdmissionSlot(context, reservation, stream);
    if (appended === "conflict") continue;
    return completeAdmissionReservation(context, reservation);
  }
  admissionInProgress();
}

export async function loadCandidateAdmissionLineageRecords(
  context: EngineContext,
  candidate: CandidateV2,
  eligibilityCache: CandidateAdmissionEligibilityCache = createCandidateAdmissionEligibilityCache(),
): Promise<
  | {
      readonly status: "not_subject";
      readonly reason: "manual" | "recurrence_unbound" | "historical_pre_admission" | "policy_unconfigured";
    }
  | {
      readonly status: "resolved";
      readonly lock: CandidateContentLock;
      readonly claim: GroupedCandidateClaim;
      readonly binding: CandidateAdmissionBinding;
      readonly reservation: CandidateAdmissionReservation;
      readonly snapshot: CandidateAdmissionSnapshot;
      readonly policyStatus: "configured" | "historical";
    }
  | { readonly status: "invalid" }
> {
  const subjectStatus = await candidateAdmissionSubjectBindingStatus(context, candidate, eligibilityCache.subject);
  if (subjectStatus === "invalid") return { status: "invalid" };
  const lock = await loadCandidateContentLock(context, candidate.contentDigest);
  if (lock === undefined) return { status: "invalid" };
  const binding = await loadCandidateAdmissionBinding(context, candidate.id);
  if (lock.admissionExpected !== true) {
    if (binding !== undefined) return { status: "invalid" };
    let reason: "manual" | "recurrence_unbound" | "historical_pre_admission" | "policy_unconfigured";
    if (lock.recurrenceClaim?.status === "not_bound" && lock.recurrenceClaim.reason === "manual") {
      reason = "manual";
    } else if (lock.recurrenceClaim?.status === "not_bound") reason = "recurrence_unbound";
    else if (context.detectorOrchestrationPolicy === undefined) reason = "policy_unconfigured";
    else if (lock.recurrenceClaim?.status === "grouped") reason = "historical_pre_admission";
    else reason = "historical_pre_admission";
    return {
      status: "not_subject",
      reason,
    };
  }
  const claim = await loadCandidateRecurrenceClaim(context, candidate.id);
  if (
    claim?.status !== "grouped" ||
    binding === undefined ||
    lock.candidateId !== candidate.id ||
    recordDigest(toJsonValue(lock.candidate)) !== recordDigest(toJsonValue(candidate)) ||
    binding.candidateDigest !== candidate.contentDigest ||
    binding.candidateClaimDigest !== claim.claimDigest ||
    binding.candidateContentLockDigest !== candidateContentLockDigest(lock)
  ) {
    return { status: "invalid" };
  }
  const reviewIndex = await loadIndexedCandidateReviews(context, candidate);
  if (reviewIndex.status !== "ready") return { status: "invalid" };
  const candidateRecurrence = await loadCandidateRecurrenceLineage(context, candidate);
  if (
    candidateRecurrence.status !== "resolved" ||
    candidateRecurrence.claimDigest !== claim.claimDigest ||
    candidateRecurrence.groupKeyDigest !== claim.groupKeyDigest
  ) {
    return { status: "invalid" };
  }
  const reservationBundle = await loadCandidateAdmissionReservationBundle(context, binding.reservationDigest);
  const reservation = reservationBundle?.reservation;
  if (
    reservation === undefined ||
    reservation.reservationKeyDigest !== binding.reservationKeyDigest ||
    reservation.snapshotDigest !== binding.snapshotDigest ||
    reservation.groupKeyDigest !== binding.groupKeyDigest ||
    reservation.scopeDigest !== binding.scopeDigest ||
    reservation.policyDigest !== binding.policyDigest ||
    reservation.candidateContentLockDigest !== binding.candidateContentLockDigest ||
    recordDigest(toJsonValue(reservation.candidate)) !== recordDigest(toJsonValue(candidate)) ||
    recordDigest(toJsonValue(reservation.candidateClaim)) !== recordDigest(toJsonValue(claim)) ||
    recordDigest(toJsonValue(binding)) !== recordDigest(toJsonValue(buildCandidateAdmissionBinding(reservation))) ||
    !candidateContentLockMatchesReservation(lock, reservation)
  ) {
    return { status: "invalid" };
  }
  const snapshot = reservationBundle?.snapshot;
  if (
    snapshot === undefined ||
    !(await admissionSnapshotLineageIsExact(context, snapshot, reservation, eligibilityCache))
  ) {
    return { status: "invalid" };
  }
  if (!(await reservationSlotIsExact(context, reservation))) return { status: "invalid" };
  return {
    status: "resolved",
    lock,
    claim,
    binding,
    reservation,
    snapshot,
    policyStatus:
      context.detectorOrchestrationPolicy?.policyDigest === binding.policyDigest &&
      context.registryRevision === snapshot.loopRegistryRevision
        ? "configured"
        : "historical",
  };
}

export async function candidateAdmissionEligibilityStatus(
  context: EngineContext,
  candidate: Candidate,
  cache: CandidateAdmissionEligibilityCache = createCandidateAdmissionEligibilityCache(),
): Promise<"not_subject" | "valid" | "invalid"> {
  if (candidate.schemaVersion !== 2) return "invalid";
  const key = `${candidate.id}\u0000${candidate.contentDigest}`;
  if (cache.active.has(key)) return "invalid";
  const existing = cache.statuses.get(key);
  if (existing !== undefined) return existing;
  if (cache.statuses.size >= MAX_ADMISSION_VALIDATIONS) {
    throw new LearningLoopError("candidate.admission_limit", [
      {
        code: "candidate.admission_limit",
        severity: "error",
        message: "Candidate admission validation exceeds its work ceiling",
      },
    ]);
  }
  const pending = (async (): Promise<"not_subject" | "valid" | "invalid"> => {
    cache.active.add(key);
    try {
      const lineage = await loadCandidateAdmissionLineageRecords(context, candidate, cache);
      if (lineage.status === "invalid") return "invalid";
      return lineage.status === "resolved" ? "valid" : "not_subject";
    } finally {
      cache.active.delete(key);
    }
  })();
  cache.statuses.set(key, pending);
  return pending;
}

export async function candidateAdmissionLineageRevision(
  context: EngineContext,
  candidate: CandidateV2,
): Promise<string> {
  const lock = await loadStoredRecord(context, "candidate-by-digest", candidate.contentDigest);
  const reviewMarker = await loadStoredRecord(context, "candidate-review", candidate.id);
  const bindingStored = await loadStoredRecord(context, "candidate-admission-binding", candidate.id);
  let reservationStored: Awaited<ReturnType<typeof loadStoredRecord>>;
  let snapshotStored: Awaited<ReturnType<typeof loadStoredRecord>>;
  let streamStored: Awaited<ReturnType<typeof loadStoredRecord>>;
  if (bindingStored === undefined) {
    reservationStored = undefined;
    snapshotStored = undefined;
    streamStored = undefined;
  } else {
    const binding = parseCandidateAdmissionBinding(bindingStored.value);
    reservationStored = await loadStoredRecord(context, "candidate-admission-reservation", binding.reservationDigest);
    snapshotStored = await loadStoredRecord(context, "candidate-admission-snapshot", binding.snapshotDigest);
    streamStored = await loadStoredRecord(context, "candidate-recurrence-admission", binding.groupKeyDigest);
  }
  const revisionOf = (stored: Awaited<ReturnType<typeof loadStoredRecord>>): unknown =>
    stored === undefined ? null : { revision: stored.revision, digest: stored.digest };
  return digest({
    lock: revisionOf(lock),
    reviewMarker: revisionOf(reviewMarker),
    binding: revisionOf(bindingStored),
    reservation: revisionOf(reservationStored),
    snapshot: revisionOf(snapshotStored),
    stream: revisionOf(streamStored),
  });
}
