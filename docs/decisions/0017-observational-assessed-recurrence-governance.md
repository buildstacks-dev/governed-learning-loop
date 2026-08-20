# 0017 — Observational assessed recurrence governance

**Date:** 2026-08-20
**Status:** ratified — issue #30c2b2-assessment

## Context

Decision 0016 records exact private derivation/Candidate recurrence claims but
deliberately leaves every pack receipt `not_assessed`. Decision 0014 already
registers a rejection-suppression policy, and decision 0015 reserves an exact
assessed receipt branch. This slice may now describe the current Candidate and
review frontier, but it must not turn that description into proposal admission,
authority, utility, or efficacy.

Global review scans are not acceptable for this fold: foreign-scope review
volume would affect exact-scope work and an absent historical review could be
mistaken for a current pending Candidate. New Candidates therefore establish a
private, bounded review-history marker before their terminal receipt.

## Rulings

1. **Assessment is observational only.** `available`, `deduplicated`,
   `suppressed`, and `capped` are immutable receipt descriptions. They do not
   refuse or deduplicate `propose`, suppress a Candidate, require a successor,
   authorize publication, establish utility, or prove improvement.
2. **Review history is exact-addressed and receipt-last.** The private
   `candidate-review/<candidateId>` append stream begins with exactly one marker
   at entry zero:
   `{ kind:"marker", candidateId, candidateDigest, scopeDigest,
   recurrenceClaimDigest }`. Its framed id is
   `marker:<candidateDigest>:<recurrenceClaimDigest>`. Every later review entry
   binds `{ kind:"review", reviewId, recordDigest, candidateId,
   candidateDigest, scopeDigest }` under fixed id `review:<reviewId>`.
3. **The marker precedes the Candidate receipt.** Candidate recurrence decision,
   full Candidate/claim content lock, exact review marker, optional group member,
   then Candidate receipt is the terminal order. A marker failure leaves no
   Candidate. Exact retry reloads each prior write without duplicating it.
4. **A review ref precedes the Review receipt.** The independently attributed
   review callback and post-callback revalidation run first, the exact index ref
   is appended/reloaded, and CandidateReview is created last. A missing receipt
   is an orphan attempt and does not become latest. Same review id/different
   bytes conflicts at the fixed stream-entry id. Exact lost-ack retry returns
   the one receipt without another callback.
5. **Review order is append order.** The latest review is the last committed,
   exact-digest, Candidate-binding review ref in stream insertion order.
   `reviewedAt` is canonical audit content and never an ordering or tie-break
   clock. Every indexed review reuses the existing structural,
   proposer/producer/reviewer-independence, risk-domain, and blocking-finding
   validation.
6. **Pre-marker history is never guessed.** A Candidate without a marker remains
   reviewable through the existing API, but its reviews remain unindexed audit
   history. If such a Candidate is active in a recurrence frontier, governance
   is `not_assessed/candidate_review_history_unavailable`. No read, review,
   package upgrade, or receipt run backfills a marker.
7. **The active frontier is exact.** Load committed group Candidate claims,
   ignore claim-before-Candidate orphans, verify every terminal Candidate against
   its full embedded claim/lock bytes, and form exact same-group supersession
   edges. A claim is active when no other committed valid claim supersedes it.
   Cycles, foreign predecessors, or impossible exact edges are store corruption.
   A valid successor removes its predecessor; superseded review history is not
   read.
8. **Candidate bindings contain only the frontier.** Sorted CandidateBindings
   bind exact Candidate content, recurrence claim, derivation, proposal-time
   episode set/count, same-group predecessor, and the exact latest indexed
   review or null. Superseded Candidate history remains anchored by the
   successor claim rather than being repeated in the receipt.
9. **Typed-invalid active facts prevent assessment.** A frontier Candidate whose
   current recurrence, derivation, evidence, or mirrored lineage is typed
   invalid makes the whole group
   `not_assessed/candidate_governance_incomplete`. It is never silently excluded
   to reveal an older predecessor or to declare the group available. Malformed
   records, digests, indexes, and impossible bindings still propagate raw
   `schema.corrupt` or `store.corrupt`.
10. **Evidence-health groups are not Candidate groups.** They remain
    `not_assessed/candidate_governance_not_applicable`; an evidence-health group
    never becomes assessed/available merely because it has no Candidate.
11. **The policy group cap is an assessment cap.** A capped insight group does
    zero Candidate/review work and records
    `not_assessed/candidate_governance_capped` with `groupDisposition:capped`.
    Legacy schema-v1 assessed+capped bytes remain parseable only with an empty
    Candidate frontier, null required fields, and the exact pack-cap reason;
    views always report them historical.

## Exact frontier matrix

The uncapped insight classifier applies this precedence:

| Active frontier | Result | Required fields | Exact reason code(s) |
| --- | --- | --- | --- |
| Empty | `available` | all null | `candidate.group_available` |
| Any latest null, `accept`, or `escalate` | `deduplicated` | all null | `candidate.group_deduplicated` |
| More than one otherwise-eligible required predecessor | `deduplicated` | all null | `candidate.frontier_ambiguous`, `candidate.group_deduplicated` |
| One latest `revise` | `available` | exact `requiredSupersedes` | `candidate.revision_required` |
| One latest `reject`, suppression disabled | `available` | exact `requiredSupersedes` | `candidate.rejection_suppression_disabled` |
| Any multiplier rejection below threshold | `suppressed` | exact predecessor, rejection, and threshold | `candidate.rejection_suppressed` |
| One multiplier rejection at/above threshold | `available` | exact predecessor, rejection, and threshold | `candidate.rejection_override_available` |

Suppression outranks deduplication, which outranks availability. With multiple
below-threshold rejections, the governing rejection has the greatest required
threshold. A tie uses ascending canonical code-unit order of
`[candidateId,candidateDigest,claimDigest,reviewId,reviewRecordDigest]`.
Canonical tie-breaking is not used to hide multiple available predecessor
branches; the schema can require only one predecessor, so those are explicitly
ambiguous/deduplicated.

The absolute threshold is:

```text
ceil(rejected proposal distinct-episode count × registered multiplier)
```

Both inputs are safe bounded integers; multiplication and the result are still
checked for safe-integer overflow. Equality satisfies the threshold. Missing,
invalid, or overflowed measurement is never zero, clamped, or a pass.

The current assessed reason-code vocabulary is closed to:

- `candidate.group_available`;
- `candidate.group_deduplicated`;
- `candidate.frontier_ambiguous`;
- `candidate.revision_required`;
- `candidate.rejection_suppression_disabled`;
- `candidate.rejection_suppressed`;
- `candidate.rejection_override_available`.

`detector.pack_group_capped` remains the exact item/legacy assessed-cap reason,
not a current assessed-classifier result.

## Receipt and view semantics

The record layer owns one pure assessed classifier used by both runtime minting
and unknown-first receipt parsing. The parser recomputes the complete branch
from embedded policy, frozen group distinct count, and frontier bindings; it
rejects incompatible dispositions, required fields, reviews, thresholds, and
reason codes.

`governanceSnapshotDigest` already binds exact group key, execution/distinct
counts, episode-set digest, and full governance. `packRunKeyDigest` already
binds that snapshot. Candidate, review, threshold, or group-population change
therefore creates a new pack-run identity; it never changes the recurrence
group key and never overwrites an old receipt.

Receipt-wide `governanceBinding` is:

- `current` only when every policy-admitted assessable insight group is
  assessed, every embedded binding exists exact, the frozen recurrence snapshot
  equals the current group, and registry/policy/current classification match;
- `not_assessed` when an admitted insight group was recorded deferred,
  pre-marker, or incomplete; intentional evidence-health and capped-group
  exemptions do not by themselves prevent another admitted assessed group from
  being current;
- `historical` when valid assessed bytes are no longer the current frontier,
  review, policy/registry, or recurrence snapshot; or for legacy
  assessed+capped bytes; and
- `invalid` when an embedded exact Candidate, claim, marker, review, group, or
  receipt binding is missing or mismatched. An invalid pack commit graph cannot
  simultaneously report governance current.

Later append-only group growth is valid commit lineage but makes the older
governance snapshot historical. Not-assessed receipts stay not-assessed and are
never upgraded on read.

## Bounds and isolation

- Review ids use the existing 4,096-character durable-id bound before callback
  or persistence; framed stream-entry ids include their fixed prefix.
- A Candidate review stream admits at most 5,000 review refs plus its marker.
- One pack receipt build, direct view, or query page admits at most 50,000 total
  Candidate, proposal-member, derivation-claim, indexed-review, and embedded
  CandidateBinding work units. Exact 50,000 succeeds; 50,001 fails without
  truncation.
- Current recurrence/group/Candidate/review results are memoized per exact
  group/Candidate within one build or page. Capped groups do no assessment work.
- Candidate/review group reads are direct by exact group and Candidate id. The
  candidate-review kind is deliberately excluded from the global detector
  semantic-graph revision, so foreign review traffic does not churn detector
  planning or same-scope receipt pages.

One inherited limitation remains explicit: current Candidate
evidence/derivation revalidation still uses global evidence-kind revisions and
source-receipt/health scans. Concurrent foreign evidence or Candidate-claim
traffic may therefore cause bounded retries/work even though it cannot merge
scopes, enter the frontier, or alter returned exact-scope content. A later
exact-reference evidence-health/source-receipt index must close this before the
campaign claims fully scope-local analysis work.

Decision 0018 additively extends active-Candidate completeness: a Candidate
that is subject to serialized admission must retain a recursively exact
admission graph. Invalid subject admission produces
`candidate_governance_incomplete`, and an embedded assessed binding whose
subject admission becomes invalid is itself invalid. Non-subject historical,
manual, unbound, and policy-unconfigured Candidates retain this decision's
compatibility behavior. Receipt/view classification remains descriptive; only
the separate decision-0018 admission snapshot enforces `propose`.

## Migration and public surface

- New Candidate and review private marker/ref records are additive. Existing
  Candidate, review, claim, execution, and receipt canonical bytes are not
  rewritten.
- Pre-marker Candidates/reviews remain usable audit/governance records but do
  not enter assessed recurrence receipts until an explicit future migration or
  exact successor creates a complete frontier.
- CandidateReview ids outside the already-ratified 4,096 durable-id bound are
  out-of-contract historical bytes and fail parsing; no migration is inferred.
- Existing `candidate_claims_deferred` and legacy assessed+capped receipt bytes
  remain parseable historical audit.
- DetectorPackRunResult's transient `recurrenceDisposition` remains the
  orchestration cap classification; assessed governance lives only in the
  optional durable receipt/view.
- No root symbol is added. DetectorPackRunReceipt and DetectorPackRunView evolve
  under existing exports; the public snapshot remains 154.
- Decision 0018 separately implements proposal enforcement, automatic
  deduplication/suppression and review-based admission by freezing a fresh
  classifier result into a private snapshot/reservation/per-group-slot graph.
  This decision's receipt/view bytes remain descriptive and never become an
  entitlement. Publication, authorization, validation, utility, and efficacy
  remain outside admission. Decision 0019 implements #30d detector packs with
  recurrence disabled and therefore no assessed frontier; #13 owns semantic-
  provider workflows, and #26 owns detector/Candidate-utility calibration.
