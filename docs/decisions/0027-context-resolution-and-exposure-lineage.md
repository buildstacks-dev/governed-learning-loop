# 0027 — Context resolution and exposure lineage

**Date:** 2026-08-21
**Status:** ratified — issue #11; closes #11 and completes M3 Activate on the
package side, which satisfies the package half of the #14 migration gate

## Context

Decisions 0025 and 0026 made publication exact, authorized, journaled, and
idempotent, and left every published intervention with an append-only state
history and a create-only scope membership index. Issue #11 is the read side
of Activate: `resolveContext` must serve a future episode only the content
that is authorized, active, and scope-matching, frozen in a receipt so a
mid-run publication cannot change treatment; `acknowledgeExposure` must
record which of that frozen content the host actually applied, with exact
intervention lineage and host-observed evidence. Kernel invariant 1 (a
candidate is inert and never resolves into active context) is the rule that
shapes everything below, together with invariants 3 (authorized ≠
validated), 5 (missing evidence is never a pass), and 6 (trust is granted by
host registration, never claimed).

The contract's resolution and exposure shapes predate Activate. This decision
keeps every contract field and adds the lineage fields a receipt needs to be
verifiable from its own bytes.

## Rulings

1. **Resolution reads only the Activate journal.** `resolveContext` lists
   the decision-0026 scope membership index (`learning-intervention-scope-
   <scopeDigest>`) for the exact scope and for every ancestor the configured
   scope policy permits, then folds each member's header and transition
   stream, loads its plan with the bound digest, loads its candidate with the
   bound digest, and verifies every journaled receipt the folded record
   cites. It never reads the candidate namespace or the candidate scope
   index: a candidate, a prepared plan, or a pending, denied, expired, or
   wrong-base authorization leaves no membership, so a candidate structurally
   cannot resolve. A candidate-shaped record planted in the membership index
   is visible corruption (`schema.*`/`store.corrupt`), never context.
2. **Only published, authorized, active, context-class `publish`
   interventions resolve.** A member resolves when its header action is
   `publish`, its header effect class is `context`, and its current state is
   `publication: published`, `authorization: authorized | not_required`, and
   `activation: active`. A proposal-class publication (inactive by decision
   0026-3), an `external` or `authority` publication (in force, but not
   agent context), a failed, disabled, or rolled-back intervention, and a
   reversal intervention are excluded. An unborn header (no first
   transition) is an orphan remnant and does not count.
3. **Scope matching is exact first, then policy ancestors, and isolation is
   kernel-enforced.** The ordered match list is the exact scope, then
   `scopePolicy.ancestors(scope)` sorted by `comparePrecedence` with higher
   precedence first (policy order on ties). Every ancestor is revalidated
   through `scopePolicy.validate`, must differ from the scope and from every
   other ancestor, and must carry exactly the scope's segments of every
   `isolationSegmentTypes` type — a policy that infers an ancestor across an
   isolation boundary, repeats a scope, or returns a non-array is
   `config.invalid`; more than 100 ancestors is `resolution.limit_exceeded`.
   Within one scope, members order by journal birth (`createdAt`, then
   intervention id). The exact scope policy ships no ancestors, so exact
   match remains the default.
4. **A stale version refuses visibly.** A still-active intervention whose
   candidate has been superseded (`supersedes` plus exact `originalDigest`)
   by the candidate of another active intervention in the same scope is a
   stale version. Resolution refuses with `resolution.intervention_stale`
   naming both interventions, writes nothing, and resumes once the host
   disables or rolls back the stale version through the journaled path. It
   is never served alongside its successor and never silently dropped. A
   superseded candidate whose successor is not yet active is not stale: the
   only authorized version is still the one in force.
5. **Destination registration drift refuses visibly; other drift is bound,
   not refused.** An active member whose destination is not registered, or
   is registered with a registration digest or effect class other than the
   one its plan bound, refuses the whole resolution with
   `resolution.destination_drift` — the host changed what the destination
   means and must restore the registration or reverse the intervention.
   Registry revision, learning policy, and scope policy drift do not refuse:
   the receipt binds the current `registryRevision`, `policyDigest`, and
   `scopePolicyDigest`, and every entry binds its plan digest, whose lineage
   binds the values at publication.
6. **The budget is a precedence-ordered prefix with visible omissions.**
   `budget.maximumEntries` (1–1,000) and `budget.maximumCharacters`
   (1–10,000,000) are refused outside their ranges, never clamped. Entries
   are taken in match order; an entry's cost is the UTF-16 code-unit length
   of its canonical JSON content. The first entry that would exceed either
   limit closes the budget, and it and every later active intervention are
   listed in `omittedInterventionIds`. A skipped-and-continue fill would let
   a smaller, lower-precedence entry change treatment; the prefix keeps the
   order a host can reason about.
7. **The receipt is content-addressed, create-only, and idempotent.**
   `ResolvedContext` is the receipt: `schemaVersion`, `id`, `episodeId`, the
   exact `scope` and `scopeDigest`, `scopePolicyDigest`, `registryRevision`,
   `policyDigest`, `queryDigest`, `budget`, `entries`,
   `omittedInterventionIds`, `resolvedAt`, and `receiptDigest`. The digest
   excludes `schemaVersion`, `id`, `resolvedAt`, and itself; the id is
   `resolution-<receiptDigest>`. The same episode resolved against the same
   active set under the same loop is therefore one receipt even under a
   ticking clock (the first persisted receipt is canonical), and a changed
   active set is a new receipt; the earlier receipt's bytes never change.
   The caller query enters the receipt only as a domain-tagged digest —
   query text, which may carry prompt content, never persists.
8. **An entry serves the candidate's reviewed intervention content with
   exact lineage.** `content` is the exact `intervention.content` of the
   candidate the plan bound (the bytes the decisive review and the
   authorization binding cover), `contentDigest` its canonical digest, and
   the entry binds `interventionId`, `candidateId`, `candidateDigest`,
   `planDigest`, `destinationId`, the matched `scopeDigest`, and the
   intervention's `transitionId` (its state head at resolution). The entry
   id is `entry-<digest>` over intervention id, transition id, and content
   digest. One intervention appears at most once per receipt.
9. **One resolution yields one exposure set.** `acknowledgeExposure` binds
   `ExposureSetRecord` to the exact receipt: its id is
   `exposure-<receiptDigest>`, every `appliedEntryIds` member must be an
   entry of that receipt (`exposure.entry_unknown` otherwise), and the set
   carries exactly one `{ interventionId, resolvedContentDigest }` per
   applied entry, in receipt order. Applying a subset, or nothing (a control
   exposure), is permitted; the set still cites its evidence. A retry with
   the same content returns the stored set and writes nothing, under any
   clock; a second acknowledgement of the same receipt with different
   content is `exposure.already_acknowledged` naming the stored set. The
   record adds `exposureDigest` over every field but `schemaVersion`, `id`,
   and itself; only `exposedAt` is ignored when two acknowledgements are
   compared.
10. **Exposure requires host-observed evidence of the same episode.**
    `evidenceIds` must be non-empty (`exposure.evidence_required`), and each
    id must be a durable observation on this loop
    (`exposure.evidence_not_found`), carrying `observed` or `verified` trust
    (`exposure.evidence_untrusted` — transcript-class `advisory` evidence
    never proves an exposure), and belonging to the resolved episode
    (`exposure.evidence_mismatch`). `assignmentId` and `fingerprintId` are
    recorded as host identifiers; the fingerprint record family belongs to
    the Validate tier. An `experiment` arm is refused with
    `exposure.experiment_unavailable` until that tier declares
    `ExperimentDefinition` records, because an unverifiable arm claim must
    not enter durable lineage.
11. **Exposure writes are index-first and forward-completing.** The set's id
    is appended to the private per-episode index stream `episode-exposure`
    (keyed by the host episode id, capped at 1,000 sets) before the
    create-only `exposure-set` record. Every writer reloads first: a present
    index entry or an existing equal set is "another attempt got here
    first". A crash before or after either write leaves at most an orphan
    index entry, which readers ignore, and a retry on a reconstructed host
    converges on the byte-exact set of a clean run.
12. **Exposure sets fold into the episode view.** `EpisodeView.episode.
    exposureIds` lists the acknowledged sets of the episode whose identity
    resolved to the host episode id, verified against each durable set. The
    ingested `EpisodeRecord` bytes keep `exposureIds: []`; the view is a
    fold, like the outcome fold of decision 0006. An unresolved identity
    folds nothing.
13. **Nothing here is a utility or efficacy claim.** A resolved entry does
    not validate its intervention, an acknowledged exposure does not improve
    it, and `validation` stays `untested` until the Validate tier evaluates
    a bound experiment. Resolution and exposure are lineage for #12, not a
    verdict.
14. **The public surface grows by eight root names.** `ResolvedContext`,
    `ResolvedEntry`, `parseResolvedContext`, `ExposureEntry`,
    `ExposureSetRecord`, `parseExposureSetRecord`, `ResolveContextInput`, and
    `ExposureInput`; `LearningLoop` gains `resolveContext` and
    `acknowledgeExposure`. The all-entrypoint snapshot moves from 188 to
    196. The receipt kind, the exposure kind, the index stream, and the
    bound-intervention loader stay private.

## Digest and identity matrix

| Value | Domain tag | Includes | Excludes |
| --- | --- | --- | --- |
| entry `id` | `context-resolution-entry:v1` | interventionId, transitionId, contentDigest | everything else; prefixed `entry-` |
| `queryDigest` | `context-resolution-query:v1` | the caller query | — |
| `receiptDigest` | `context-resolution:v1` | episodeId, scope, scopeDigest, scopePolicyDigest, registryRevision, policyDigest, queryDigest, budget, ordered entries, ordered omittedInterventionIds | schemaVersion, id, resolvedAt, receiptDigest |
| receipt `id` | — | `resolution-<receiptDigest>` | — |
| `exposureDigest` | `exposure-set:v1` | episodeId, resolutionReceiptId, ordered entries, assignmentId, experiment (when present), fingerprintId, ordered evidenceIds, exposedAt | schemaVersion, id, exposureDigest |
| exposure `id` | — | `exposure-<receiptDigest>` of the cited receipt | — |

Golden vectors pinned in `tests/resolution-records.test.ts`: the fixture
receipt digest `0b8d6cd11409e52ddd09b2e3f0de2c093a36221be6fdf5bbf9d34a4fc53327c7`
and exposure digest `c5d70082a3db45a4a098aaa8ec8e6ac4abf3344e180e2c4cf936ee2d263edf98`.

## Error codes added

`resolution.destination_drift`, `resolution.intervention_stale`,
`resolution.limit_exceeded`, `exposure.resolution_not_found`,
`exposure.entry_unknown`, `exposure.evidence_required`,
`exposure.evidence_not_found`, `exposure.evidence_untrusted`,
`exposure.evidence_mismatch`, `exposure.experiment_unavailable`,
`exposure.already_acknowledged`, and `exposure.limit_exceeded`. Malformed
input is `schema.invalid`; a misbehaving scope policy is `config.invalid`;
a broken journal is `store.corrupt`.

## Validation evidence

L1 contract/schema/digest controls: receipt and exposure round-trips with
unknown-field dropping; the pinned receipt, entry, query, and exposure digest
vectors; digest movement for every bound receipt field and stability across
`resolvedAt`; refusal of mismatched ids, receipt/scope/content digests, a
plan digest that disagrees with the intervention id, duplicate interventions
and entry ids, served-and-omitted ids, over-budget entries, out-of-range
budgets, empty scopes, noncanonical timestamps, and unsupported versions;
exposure id derivation, malformed receipt ids, stale digests, required and
unique evidence, unique entries, the closed experiment arm, and
timestamp-only equality.

L2 deterministic engine controls: the exact receipt for one active
intervention with frozen result and stored bytes; idempotence under a
ticking clock with zero writes; a candidate that never resolves while
proposed, accepted, planned, or pending, plus a planted membership record
that fails visibly; proposal-class inactivity and external-class exclusion;
disabled, rolled-back, and failed interventions never resolving while the
earlier receipt stays byte-stable; the stale-version refusal with zero writes
and recovery after disable; destination drift and deregistration refusals
with zero writes and recovery after restoration; registry drift tolerated and
bound; exact-only matching under the exact policy; a mid-run publication
leaving the earlier receipt unchanged; the prefix budget at every boundary
with exact omissions; malformed input with zero writes; ancestor ordering
and per-scope binding under a custom policy; and refusal of boundary-crossing,
repeating, non-array, invalid-scope, and flooding policies. For exposure: one
entry per applied intervention with the frozen digest and the episode-view
fold over unchanged stored bytes; idempotent retries under a ticking clock;
refusal of a different second acknowledgement; subsets and empty sets in
receipt order; acknowledgement after a later disable; every refusal
(unknown receipt, unknown entry, duplicate entries, no evidence, missing
evidence, other-episode evidence, advisory evidence from a separately
registered advisory source, experiment arm, malformed input) with zero
writes. Crash conformance injects a crash before and after the index append
and before and after the set create, then proves a reconstructed host
converges on the byte-exact set and journal of a clean run, and that an
orphan index entry does not count until its set exists.

- **L3 live destination/authority evidence:** empty; no external system was
  called.
- **L4 semantic/model evaluation:** empty.
- **L5 operational/SLO evidence:** empty. Resolution costs one membership
  listing per matched scope plus, per member, a header, stream, plan,
  candidate, and receipt read; no cache exists, and the stale-version check
  compares only active members (an inactive successor is not consulted).
- **L6 longitudinal acceptance evidence:** empty; no exposure has been
  measured, which is exactly what `validation: "untested"` states.

## Migration consequences

- Three private store kinds are added: `context-resolution`, `exposure-set`,
  and the per-episode `episode-exposure` stream. None is a supported consumer
  API.
- `EpisodeView.episode.exposureIds` can now be non-empty for an episode
  whose identity resolved; stored `EpisodeRecord` bytes, receipts, and every
  existing golden are unchanged.
- The contract's `ResolvedContext`, `ResolvedEntry`, and `ExposureSetRecord`
  gain additive lineage fields; `ExposureInput.experiment` is refused until
  the Validate tier.
- M3 is complete on the package side (#10 and #11 closed). The package half
  of the #14 gate ("blocked on M1 + M3") is satisfied; the remaining M3
  debt is the Cormidia adapter in the Cormidia repo, and the remaining
  package debt is #12 (Validate), which will consume the exposure sets,
  fingerprints, and assignment ids recorded here.
