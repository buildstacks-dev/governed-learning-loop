# 0018 — Serialized recurrence proposal admission

**Date:** 2026-08-20
**Status:** ratified — issue #30c2b2-admission

## Context

Decision 0014 registers an immutable detector-orchestration policy, decision
0016 records exact private derivation/Candidate recurrence claims, and decision
0017 defines one pure active-frontier classifier. Those slices deliberately do
not make a receipt, claim, or classification enforce `propose`.

This decision adds that enforcement as a separate Candidate operation. It must
refuse duplicate or suppressed recurrence-group proposals without first
creating facts for the refused Candidate, serialize concurrent admissible
proposals without a global journal, recover every post-slot crash with the
Candidate receipt last, and preserve historical/manual/unbound compatibility.
Admission still creates only an inert Candidate. It is not review, publication,
authorization, validation, utility, or efficacy.

## Subject boundary

1. **Admission is configured-loop behavior.** A new Candidate-v2 proposal is
   subject when it is derivation-backed, resolves an exact grouped recurrence
   claim, and the loop has a DetectorOrchestrationPolicy. Manual Candidates,
   derivation-unbound Candidates, and policy-unconfigured proposals remain
   outside recurrence admission. A configured derivation whose exact committed
   claims prove grouped recurrence cannot use an unbound decision to bypass the
   gate.
2. **Terminal history is never backfilled.** A Candidate that committed before
   admission remains `not_subject`; a later configured read or exact retry does
   not add an admission binding. A policy-unconfigured grouped Candidate is
   reported `policy_unconfigured` in that loop and
   `historical_pre_admission` after configured cutover.
3. **A pre-admission orphan is not terminal history.** If a grouped claim and
   content lock exist without `admissionExpected:true` and without a Candidate
   receipt, a configured loop refuses it generically. It cannot direct-complete
   beside the admission stream. The same orphan may finish only through a
   policy-unconfigured loop, after which it is ordinary pre-admission history.
4. **The host owns cutover.** DetectorOrchestrationPolicy is trusted immutable
   host configuration. A host must exclusively cut over a recurrence
   group/scope before relying on serialized enforcement. A concurrent old
   runtime or policy-unconfigured writer is intentionally non-subject and can
   bypass this gate; the kernel therefore makes no mixed-runtime or
   cross-configuration serialization claim.

## Exact admission matrix

The admission snapshot calls the same pure classifier ratified by decision
0017, but it always assesses the current insight group as uncapped. Pack-run
group caps remain reporting caps and do not decide Candidate admission.

| Stable active frontier | Admission result | Required Candidate lineage |
| --- | --- | --- |
| Empty | admit as `group_available` | `supersedes` absent |
| Any latest review is null, `accept`, or `escalate` | refuse | none accepted |
| More than one otherwise eligible predecessor | refuse as ambiguous/deduplicated | none accepted |
| One latest `revise` | admit as `required_supersession` | exact same-group predecessor |
| One latest `reject`, suppression disabled | admit as `required_supersession` | exact same-group predecessor |
| Any multiplier rejection below threshold | refuse as suppressed | none accepted |
| One governing rejection at or above threshold | admit as `rejection_override` | exact predecessor and exact governing rejection |
| One exact active pre-marker predecessor | admit as `historical_supersession` | mirrored same-group successor of that sole predecessor |
| Typed-incomplete or invalid active lineage | refuse | none accepted |

The multiplier threshold remains
`ceil(rejected proposal distinct-episode count × configured multiplier)`;
equality admits the override. Suppression outranks deduplication, which
outranks availability. A Candidate's `supersedes` must exactly equal the
classifier's `requiredSupersedes`; an unrelated successor cannot satisfy the
gate.

Admission recursively validates the frozen admission lineage of every active
subject Candidate used by the snapshot. A missing/tampered binding, snapshot,
reservation, slot, group member, review marker, embedded predecessor, registry
snapshot, recurrence population, or embedded governance binding makes that
frontier incomplete and refuses succession. A valid admission bound to a
different current policy or registry is historical, not invalid. A historical
supersession predecessor must remain non-subject and unmarked; changing it into
an invalid subject cannot preserve the successor's historical basis.

## Stable snapshot and per-group serialization

5. **Policy refusal is pre-write.** The kernel prepares and checks admission
   before persisting the proposed Candidate's recurrence decision, content
   lock, review marker, snapshot, reservation, slot, group member, or receipt.
   A clean policy refusal therefore creates zero facts for that Candidate. A
   call may first forward-complete a different already-winning reservation;
   those recovery writes belong to the earlier proposal, not the refused one.
   A contender that passed preflight and only later lost the slot may retain
   its inert decision/lock/marker/snapshot/reservation attempt; it has no
   binding, group member, or Candidate receipt and must retry its exact id.
6. **The snapshot is read twice.** One materialization binds the exact loop
   registry revision, full policy, group/scope, current admission-stream head,
   exact committed recurrence members and episode identities, and the complete
   assessed frontier or historical predecessor. Two consecutive
   materializations must have the same `snapshotDigest`. The kernel retries at
   most three pairs and then returns `candidate.snapshot_changed`.
7. **The stable read freezes the decision inputs.** Later append-only review,
   recurrence-population, or group growth does not rewrite the snapshot. Exact
   referenced bytes must remain valid, and frozen recurrence members/episode
   identities must remain a current subset. There is deliberately no shared
   journal spanning review, evidence, recurrence, and Candidate records.
8. **One group has one admission stream.** The private
   `candidate-recurrence-admission/<groupKeyDigest>` append stream is scoped by
   the recurrence group (and therefore its exact scope semantics). Its rolling
   head digest commits every preceding slot. The fixed slot id is
   `slot:<reservationKeyDigest>`. The empty head hashes
   `{ domain:"candidate-recurrence-admission-head:v1", previous:null }`; each
   next head hashes the same domain, prior head, and exact stored slot
   `{ id,digest,value }`.
9. **The reservation key is the CAS identity.** It hashes the domain
   `candidate-recurrence-admission-slot:v1`, registry revision, policy digest,
   group/scope digests, pre-slot stream-head digest, and complete snapshot
   digest. Two proposals based on one exact state compete for one slot; only
   one expected-revision append can win. A conflict forward-completes the
   winner and recomputes policy. Eight unsuccessful slot attempts return
   `candidate.admission_in_progress`.
10. **Only a validated stream may be extended.** Forward completion returns
    the exact stream it validated, never a newly reloaded unvalidated tail. If
    another pending slot appears concurrently, the stale expected revision
    conflicts and the next attempt processes that head. Completion also proves
    that every predecessor slot has a terminal Candidate before accepting a
    later slot.
11. **Append-only caches prove presence, not absence.** A retry may cache the
    group-Candidate members before another retry completes the same pending
    slot. Cached presence is sufficient; cached absence triggers an exact
    reload before corruption is declared.

## Private records and receipt-last order

The content lock adds only the neutral Boolean `admissionExpected:true` for a
subject proposal. It binds the full Candidate and recurrence claim but no
admission policy, snapshot, reservation, or outcome. The private admission
records are:

```ts
type CandidateClaimRef = {
  readonly candidateId: string;
  readonly candidateDigest: string;
  readonly claimDigest: string;
};

type AssessedGovernance = Extract<
  DetectorPackRunGroupGovernance,
  { readonly status: "assessed" }
>;

type GroupedCandidateClaim = Extract<
  CandidateRecurrenceClaim,
  { readonly status: "grouped" }
>;

interface CandidateAdmissionSnapshot {
  readonly schemaVersion: 1;
  readonly loopRegistryRevision: string;
  readonly policy: DetectorOrchestrationPolicy;
  readonly groupKeyDigest: string;
  readonly scopeDigest: string;
  readonly admissionStreamSnapshotDigest: string;
  readonly groupMembers: readonly RecurrenceCommittedMemberSnapshot[];
  readonly groupMemberSnapshotDigest: string;
  readonly executionCount: number;
  readonly episodeIdentityDigests: readonly string[];
  readonly episodeIdentitySetDigest: string;
  readonly distinctEpisodeCount: number;
  readonly assessment:
    | { readonly status: "assessed"; readonly governance: AssessedGovernance }
    | { readonly status: "historical_supersession"; readonly predecessor: CandidateClaimRef };
  readonly snapshotDigest: string;
}

interface CandidateAdmissionReservation {
  readonly schemaVersion: 1;
  readonly reservationKeyDigest: string;
  readonly reservationDigest: string;
  readonly candidateId: string;
  readonly candidateDigest: string;
  readonly candidateClaimDigest: string;
  readonly candidateContentLockDigest: string;
  readonly groupKeyDigest: string;
  readonly scopeDigest: string;
  readonly policyDigest: string;
  readonly snapshotDigest: string;
  readonly basis:
    | "group_available"
    | "required_supersession"
    | "rejection_override"
    | "historical_supersession";
  readonly requiredSupersedes: CandidateClaimRef | null;
  readonly candidate: CandidateV2;
  readonly candidateClaim: GroupedCandidateClaim;
}

interface CandidateAdmissionBinding {
  readonly schemaVersion: 1;
  readonly candidateId: string;
  readonly candidateDigest: string;
  readonly candidateClaimDigest: string;
  readonly candidateContentLockDigest: string;
  readonly groupKeyDigest: string;
  readonly scopeDigest: string;
  readonly policyDigest: string;
  readonly snapshotDigest: string;
  readonly reservationKeyDigest: string;
  readonly reservationDigest: string;
  readonly bindingDigest: string;
}

interface CandidateAdmissionSlot {
  readonly schemaVersion: 1;
  readonly reservationKeyDigest: string;
  readonly reservationDigest: string;
  readonly snapshotDigest: string;
  readonly slotDigest: string;
}
```

12. **The terminal order is fixed.** For a subject Candidate the durable order
    is recurrence decision, neutral content lock, review marker,
    content-addressed snapshot, content-addressed reservation, per-group CAS
    slot, Candidate-id admission binding, group-Candidate member, then Candidate
    receipt. The private keys are
    `candidate-admission-snapshot/<snapshotDigest>`,
    `candidate-admission-reservation/<reservationDigest>`,
    `candidate-admission-binding/<candidateId>`, and
    `candidate-recurrence-admission/<groupKeyDigest>`. The receipt is last.
13. **The slot is the recovery boundary.** Before a slot wins, missing
    decision/lock/marker/snapshot/reservation bytes are never inferred or
    backfilled. After it wins, any retry may forward-complete the exact binding,
    group member, and Candidate receipt. A nonterminal slot may only be the
    stream head.
14. **Acknowledgements are not trusted.** Every create/append success is
    reloaded and compared with the exact canonical bytes. Lost acknowledgements
    are idempotent; a success that was not preserved is `store.corrupt`.
    Content, Candidate id, proposer, attestation, and `proposedAt` remain frozen
    across retry.

## CandidateView and review behavior

`CandidateView.admissionLineage` is a closed union:

- `not_subject` with `manual`, `recurrence_unbound`, `policy_unconfigured`, or
  `historical_pre_admission`;
- `resolved` with binding, reservation-key, reservation, snapshot, and policy
  digests plus the exact admission basis;
- `historical` with the same immutable projection, a historical-policy warning,
  and no reclassification; or
- `invalid` with typed diagnostics.

The historical warning code is `candidate.admission_policy_historical`; the
invalid-view diagnostic is `candidate.admission_invalid`.

The public projection deliberately omits the admission group, full policy,
frontier, review, snapshot population, reservation Candidate, and private slot.
`recurrenceLineage` remains a separate view dimension.

An invalid admission lineage forces Candidate governance review/publication to
`blocked`. `reviewCandidate` checks admission before invoking the reviewer and
again after the callback, before appending a review ref or creating a Review.
It fails `review.admission_invalid`. An occupied review id cannot bypass the
first check. Historical and non-subject Candidates remain reviewable under the
pre-existing evidence, derivation, lineage, and independence rules.

Assessed pack governance also treats an active subject Candidate with invalid
admission lineage as `candidate_governance_incomplete`; an embedded assessed
binding that no longer has valid subject admission is invalid. Pack receipt
classification remains descriptive and grants no proposal or publication
authority—the separate pre-write admission snapshot is the enforcing fact.

## Bounds, privacy, and errors

- One admission stream and one group-Candidate stream admit at most 5,000
  entries. One snapshot admits at most 5,000 recurrence members and 5,000
  distinct episode identities.
- Snapshot and reservation parsers each fail above 64 MiB canonical bytes; the
  admission stream has the same byte ceiling. In addition, the aggregate raw
  canonical bytes of every slotted snapshot+reservation pair in one group may
  not exceed 64 MiB. Preflight includes the prospective pair before persisting
  either record or appending its slot. Exactly 64 MiB is recoverable after a
  post-slot crash; the next byte returns `candidate.admission_limit` with no new
  slot.
- One recursive admission fold validates at most 5,000 distinct Candidates,
  caches exact per-group streams/governance, and detects cycles. The existing
  50,000 Candidate/claim/member/review governance-work ceiling remains in
  force. Nothing is truncated.
- Existing Candidate evidence/derivation checks still inherit global
  evidence-kind revisions and source-receipt/health scans. Admission does not
  claim fully scope-local work until exact-reference source-receipt and health
  indexes replace that debt.
- Admission records and writers remain engine-private. Generic refusal,
  contention, churn, and limit diagnostics do not echo the private group key,
  Candidate frontier, predecessor id, or policy branch.

The closed admission error family is:

- `candidate.admission_refused` for a policy, subject-boundary, invalid-frontier,
  or historical-migration refusal;
- `candidate.snapshot_changed` after repeated unstable double reads;
- `candidate.admission_in_progress` after bounded slot contention;
- `candidate.admission_limit` for slot/member/byte/validation work ceilings;
- existing `store.conflict` for content ownership/id contention; and
- raw `schema.corrupt` or `store.corrupt` for malformed or impossible durable
  graphs.

## Migration and public surface

- Candidate, Review, detector, derivation, recurrence, policy, and receipt
  canonical bytes are unchanged. The four admission record kinds and additive
  `admissionExpected` lock field are private.
- Historical terminal Candidates are not rewritten. Grouped pre-admission
  crash remnants cannot race configured admission; deterministic concurrency
  tests pin that refusal, validated-stream extension, stale-member reload, and
  exact aggregate-byte crash recovery.
- CandidateView evolves under its existing export. No parser, digest helper,
  record type, writer, or façade method is added at the root; the public export
  snapshot remains 154.
- Admission does not authorize, activate, publish, review, validate, measure,
  establish utility, or prove efficacy. Reference detector packs remain #30d,
  semantic-provider workflows remain #13, and Candidate-utility calibration
  remains #26.
