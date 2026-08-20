# 0016 — Private derivation and Candidate recurrence claims

**Date:** 2026-08-20
**Status:** ratified — issue #30c2b2-claims

## Context

Decision 0013 binds a detected execution to one privacy-treated recurrence
group, decision 0010 binds a Candidate to an exact InsightDerivation, and
decision 0015 reserves an assessed pack-receipt governance branch. No durable
fact yet proves that one derivation or Candidate belongs to one recurrence
group. Computing that relationship later would silently reinterpret historical
records and would leave no proposal-time episode baseline for future review and
suppression policy.

This slice adds only private observational lineage. It does not assess pack
governance, deduplicate or suppress a Candidate, or refuse a proposal because a
group already has a Candidate.

## Rulings

1. **Claims are kernel-private audit facts.** `DerivationRecurrenceClaim`,
   `CandidateRecurrenceClaim`, their append streams, parsers, digests, loaders,
   and writers are not root exports and have no public mint method. Store input
   remains unknown-first parsed.
2. **A derivation claim binds one exact committed witness.** Its content is:
   `schemaVersion`, derivation id/digest, execution id/key/full digest,
   `scopeDigest`, `groupKeyDigest`, recurrence `decisionBindingDigest`,
   derivation `populationDigest`, sorted nonempty episode-identity digests,
   their set digest/count, and `claimDigest`. Ids must match their content
   digests. The claim digest hashes every field except schema and itself.
3. **Derivation reuse is append-only but group-exact.** A content-addressed
   claim is stored under its `claimDigest`; the per-derivation
   `derivation-recurrence/<derivationId>` stream appends
   `claim:<claimDigest>`. Multiple exact execution witnesses may survive across
   packs only when every committed claim resolves the same group. A second
   exact group is `store.corrupt`, never an arbitrary winner. Orphan claims
   whose execution receipt is absent do not count.
4. **Committed means the whole mechanical graph resolves.** A derivation claim
   revalidates the exact derivation, execution receipt, execution commit view,
   recurrence decision binding, group member, population and group key. A
   binding without its member or receipt is not sufficient.
5. **Derivation claims precede the execution receipt.** Private semantic
   persistence writes registry/evidence facts, derivation links and records,
   the execution scope result lock, recurrence decision/member, derivation
   recurrence claim plus append reference, then the DetectorExecutionRecord
   receipt last. Exact retry reloads the claim graph and forward-completes a
   crash without duplicating one claim.
6. **Every new Candidate receives one nullable recurrence decision.** The
   create-only record key is the Candidate id. Common content binds Candidate
   id/content digest, exact scope digest, the complete parsed Candidate-v2
   snapshot, status and claim digest. This freezes proposer, attestation and
   proposal time at the first decision write. A `not_bound` decision records
   `manual` or `derivation_unbound`. A `grouped`
   decision additionally binds exact derivation id/digest, sorted nonempty
   derivation-claim digests, group key, sorted exact proposal-time group-member
   snapshots and their digest, sorted full-group episode identities at
   proposal and their set digest/count, and an exact nullable same-group
   Candidate predecessor `{ candidateId, candidateDigest, claimDigest }`.
   Candidate claim digest hashes every content field in its selected branch,
   including the embedded Candidate and proposal snapshots, except schema and
   itself.
7. **The proposal baseline is the full committed group.** A grouped Candidate
   freezes all committed recurrence-group episode identity digests observed at
   proposal, not merely its derivation witness populations. Each frozen member
   binds exact execution id/key/full digest, recurrence-decision digest and
   member digest. The baseline is recomputed from those exact member bindings;
   every derivation witness population must be a subset. Later append-only
   group growth may make current members and counts a superset; it never
   rewrites the frozen baseline.
8. **Candidate claim ordering is receipt-last.** `propose` first creates and
   reloads the Candidate-id recurrence decision containing exact Candidate
   bytes. It then obtains the content-digest ownership lock, which additively
   binds the recurrence claim digest, complete parsed claim and complete parsed
   Candidate for new proposals. After revalidating that lock it appends and
   reloads the group member when grouped, revalidates the unchanged lock again,
   and creates the Candidate record last. A crash before the Candidate leaves
   an inert anchored decision/member whose exact Candidate attribution,
   proposal time and recurrence baseline are recoverable even if evidence or
   the group changes. Retrying requires the same verified proposer
   ref/attestation and forward-completes those locked bytes; another proposer or
   proposed id cannot steal them. Historical ownership locks without the
   optional recurrence digest/claim/Candidate triple remain byte-compatible.
9. **Historical Candidates are never migrated on read.** A Candidate without a
   decision reports `historical_unbound` even if later detector activity creates
   derivation claims. Reads, reviews, package upgrades, and receipt assessment
   do not backfill it. Current manual and unavailable-derivation proposals bind
   explicit `manual` and `derivation_unbound` decisions respectively.
10. **CandidateView exposes recurrence lineage inline.** `recurrenceLineage`
    is:
    - `not_bound` with `manual | derivation_unbound | historical_unbound`;
    - `resolved` with exact claim/group/derivation/set digests, frozen proposal
      count, and current committed execution/distinct-episode counts; or
    - `invalid` with diagnostics and an optional immutable claim projection.
    It is independent of `derivationLineage`, evidence health and GovernanceView.
11. **Observational invalidity is not a new governance rule.** A typed invalid
    recurrence lineage does not change review or proposal disposition in this
    slice. Malformed envelopes, ids, self-digests, stream entries, foreign
    scope, or impossible cross-record bindings propagate their raw
    `schema.corrupt` or `store.corrupt` trust-boundary error and fail closed
    instead of being downgraded to a typed invalid view.
12. **Proposal admission is unchanged.** Two fresh, distinct Candidate contents
    may acquire claims in one group concurrently. This slice neither consults
    `rejectionSuppression` nor returns deduplicated/suppressed/override
    dispositions. Same-group supersession is recorded exactly but not required
    by a new admission policy.
13. **Pack governance assessment remains deferred.** Pack receipts minted by
    this runtime still carry `not_assessed/candidate_claims_deferred`; the
    reserved assessed parser branch stays historical and non-enforcing. No
    Candidate or review is read while minting a receipt in this slice.
14. **Claims never change recurrence identity.** Group keys still bind only the
    exact detector/configuration/implementation, lens, scope policy and treated
    locator. They exclude pack, registry, population, derivation, Candidate,
    review and orchestration policy. Future Candidate/review assessment belongs
    in `governanceSnapshotDigest`, which is already included by
    `packRunKeyDigest`; it must never be folded into the group key.
15. **Review assessment has one future owner.** The next assessment decision
    must reuse structurally valid exact Candidate reviews and the existing
    proposer/producer/reviewer independence checks. No-review, accept,
    escalate, revise or reject semantics are inferred by this claim-only slice.
16. **Bounds fail closed without truncation.** Claim and group-Candidate streams
    admit at most 5,000 entries; episode identity sets admit at most 5,000
    values. Multiple same-group witnesses share one bounded group fold. The
    existing recurrence ceilings of 5,000 members, 50,000 episode references
    and 5,000 distinct identities remain authoritative.
17. **The public-surface increase is zero.** CandidateView evolves under its
    existing symbol. Candidate, derivation, execution, recurrence and receipt
    canonical bytes are unchanged. The root export snapshot remains 154.

## Engine-private record shapes

```ts
interface DerivationRecurrenceClaim {
  readonly schemaVersion: 1;
  readonly derivationId: string;
  readonly derivationDigest: string;
  readonly executionId: string;
  readonly executionKeyDigest: string;
  readonly executionDigest: string;
  readonly scopeDigest: string;
  readonly groupKeyDigest: string;
  readonly decisionBindingDigest: string;
  readonly populationDigest: string;
  readonly episodeIdentityDigests: readonly string[];
  readonly episodeIdentitySetDigest: string;
  readonly distinctEpisodeCount: number;
  readonly claimDigest: string;
}

type CandidateRecurrenceClaim =
  | {
      readonly schemaVersion: 1;
      readonly candidateId: string;
      readonly candidateDigest: string;
      readonly scopeDigest: string;
      readonly candidate: CandidateV2;
      readonly status: "not_bound";
      readonly reason: "manual" | "derivation_unbound";
      readonly claimDigest: string;
    }
  | {
      readonly schemaVersion: 1;
      readonly candidateId: string;
      readonly candidateDigest: string;
      readonly scopeDigest: string;
      readonly candidate: CandidateV2;
      readonly status: "grouped";
      readonly derivationId: string;
      readonly derivationDigest: string;
      readonly derivationClaimDigests: readonly string[];
      readonly groupKeyDigest: string;
      readonly proposalMembers: readonly {
        readonly executionId: string;
        readonly executionKeyDigest: string;
        readonly executionDigest: string;
        readonly decisionBindingDigest: string;
        readonly memberDigest: string;
      }[];
      readonly proposalMemberSnapshotDigest: string;
      readonly episodeIdentityDigestsAtProposal: readonly string[];
      readonly episodeIdentitySetDigest: string;
      readonly distinctEpisodeCount: number;
      readonly supersedes: {
        readonly candidateId: string;
        readonly candidateDigest: string;
        readonly claimDigest: string;
      } | null;
      readonly claimDigest: string;
    };
```

## Migration and sequencing consequences

- Existing record/digest goldens and the 154-symbol public snapshot are
  unchanged.
- Historical Candidates with no recurrence decision remain explicitly
  unbound when their content-ownership lock has no recurrence
  digest/claim/Candidate triple; there is no scan, rewrite or read-time
  backfill. A claim-aware
  ownership lock with a missing or mismatched decision is typed invalid.
- New private claim kinds contribute to the semantic graph retry revision so a
  Candidate view cannot combine claim bytes from different snapshots.
- Orphan claim records and append entries remain for crash audit and exact
  retry. Only exact terminal execution or Candidate receipts make them count.
- Decision 0017 implements observational Candidate/review frontier assessment
  and assessed pack receipt views. Enforced group deduplication, rejection
  suppression and serialized proposal admission remain later work. #30d owns
  detector contents, #13 provider workflows, and #26 candidate-utility
  calibration.

The original rulings above remain the exact claim-only boundary at the time
0016 landed. Decision 0017 is additive: it reads those claims into immutable
receipt descriptions but does not turn them into proposal enforcement or
authority.
