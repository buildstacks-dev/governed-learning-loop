# 0024 — Activate records, loop-bound authority, and host destination registrations

**Date:** 2026-08-21
**Status:** ratified — issue #10 first half (records, authority, destinations);
the journaled publisher remains open on #10

## Context

Issue #10 asks for the Activate tier of contract §Publication plan and
authorization binding, §Authority, and §Publication destination: the
PreparedEffect / PublicationPlan / AuthorizationBinding / VerifiedAuthorization
records, an AuthorityPort, host-owned DestinationRegistration with a monotonic
risk floor, and a journaled idempotent publisher with crash-resume. Its
lifecycle clarification (2026-08-19) adds that a plan and binding must bind the
complete semantic closure — candidate v2 plus exact derivation, detector
registration, pack manifest, lens, scope policy, destination, risk, content,
base, action, and policy identities — that a v1 candidate cannot become active
under the default policy, that reviewer-driven risk downgrades and direct
rollback helpers are not preserved, and that disable/rollback/compensation
travel through new bound plans and the same journal.

Activate is the largest tier, so it is split the way #13 was. This decision
ships the half that makes the records exact and the refusals provable — the
records, the authority capability, the destination registrations, plan
preparation, and every refusal check of `publish` — without any path that
writes to a destination. The journaled publisher (applyEffect, receipts,
intervention state, crash-resume, and the disable/rollback/compensate plans) is
the second half. Until it lands, nothing in this package activates anything,
which is also why this slice does not cross the #26 candidate-utility gate:
that gate applies to the authorized branch the publisher will add.

Kernel invariants 4 (approvals bind exact content) and 7 (verified capabilities
are loop-bound) shape every ruling below.

## Rulings

1. **Activate records are exact and inert.** `EffectClass`,
   `AfterEffectSemantics`, `PreparedEffect`, `PublicationLineage`,
   `PublicationPlan`, `AuthorizationBinding`, and `PublicationReceipt` are the
   contract shapes plus one additive `lineage` field on the plan and one
   additive `lineageClosureDigest` field on the binding. Parsers are
   unknown-first, drop unknown fields, recompute every payload digest, the
   plan digest, and the content-addressed plan id, and bound effects to 100 per
   plan without truncation. Timestamps are canonical RFC 3339 UTC with
   milliseconds. Holding, parsing, or persisting any of these records grants no
   authority, publication, activation, or validation state.
2. **A plan binds the complete semantic closure.** `plan.lineage` carries the
   candidate's exact scope digest, the loop scope-policy digest, the loop
   registry revision (which itself binds policy, identity, content policies,
   sources, semantic registry, destinations, and authority), the exact host
   destination-registration digest, and — for a derivation-backed candidate —
   the exact derivation id/digest with its detector, lens, and pack references.
   A manual candidate binds `derivation: null`. The binding carries one
   `lineageClosureDigest` over the candidate digest plus that lineage. A
   schema-version-1 candidate cannot become a plan
   (`publication.candidate_legacy_unbound`).
3. **Plan and binding digests have exact inclusion tables.**
   `publicationPlanDigest` hashes `{ candidateId, candidateDigest,
   destinationId, action, effectClass, effectiveRisk, effects[], policyDigest,
   lineage }` under the domain tag `publication-plan:v1` and excludes
   `schemaVersion`, `id`, `planDigest`, and `createdAt`; the plan id is
   `plan-<planDigest>`. `authorizationBindingDigest` hashes every binding field
   under `authorization-binding:v1`; `expectedBases` is the sorted, unique set
   of effect bases. Changing content, destination, scope, base, risk, action,
   policy, or any lineage member changes the plan digest, the binding digest,
   or both; a `VerifiedAuthorization` is usable only while its `bindingDigest`
   equals the binding digest of the exact current plan.
4. **The authority port is kernel-minted and loop-bound.** The root exports
   `createAuthorityPort({ id, version, configurationDigest, verify })`, the
   authority analogue of decision 0003. The host authenticates approvers and
   maps its approvals; its result crosses the boundary as `unknown` and must
   parse as `{ status: "authorized", authorization }` or
   `{ status: "pending" | "denied" | "invalid" | "expired", diagnostics }`
   (at most 100 diagnostics). An authorized result must name a `bindingDigest`
   equal to the digest of the binding the kernel asked about; otherwise the port
   returns a closed `invalid` decision carrying `publication.binding_mismatch`
   and mints nothing. Accepted material is copied, frozen, branded, and bound
   through a private weak association to a distinct per-instance token.
   Registration bytes `{ id, version, configurationDigest }` digest to
   `registrationDigest` and contribute to the loop registry revision; a
   structural lookalike is refused at construction; handles are
   non-serializable and must be re-verified after restart. `LearningLoopConfig`
   gains `authority?: AuthorityPort`.
5. **Destination registrations are host-owned and snapshotted.**
   `LearningLoopConfig` gains `destinations?: readonly DestinationRegistration[]`.
   Construction parses each registration once — adapter id, closed effect
   class, closed risk floor, 1–100 unique control-free target patterns of at
   most 200 characters, authorization rule id, and a content policy id that
   names a configured content policy — captures `prepare`/`applyEffect` bound
   to the adapter, and refuses duplicates. Every registration failure is
   `config.invalid`. An `authority` destination must declare the `T3` floor.
   `registrationDigest` hashes exactly the host-owned fields under
   `destination-registration:v1`; adapter behavior is excluded. When
   `destinations` is present the registry revision gains the sorted
   `{ id, registrationDigest }` list; omission preserves prior bytes.
6. **Target patterns are literal except `*`.** `*` matches a run of characters
   other than `/`; there is no `**`, `?`, or character class. Matching is a
   bounded dynamic program, so a hostile pattern cannot trigger backtracking
   blow-up. Every prepared effect's target must match at least one registered
   pattern (`publication.target_not_permitted`).
7. **Effective risk is the monotonic maximum everywhere.** `effectiveRisk` is
   `max(proposedRisk, riskFloor)` of the registered destination the candidate's
   intervention names; an unregistered destination contributes no floor. The
   same function drives review independence, governance, proposal, candidate
   views, and advisory-review independence, so registering a `T2` destination
   raises a `T1` proposal's review requirements. Neither a proposer, a reviewer,
   nor an adapter can lower the result.
8. **`preparePublication` is destination-side-effect-free and persists one
   plan.** Order: parse input; refuse non-`publish` actions
   (`publication.action_unavailable`); resolve the registered destination
   (`publication.destination_unknown`); load the candidate
   (`publication.candidate_not_found`), refuse v1, and require that the
   candidate's intervention names the requested destination
   (`publication.destination_mismatch`); compute governance and refuse
   non-ready evidence or invalid derivation/admission lineage
   (`publication.candidate_invalid`); derive the lineage; call the adapter's
   `prepare` exactly once with the candidate and requested base; parse the
   effects (`publication.effect_invalid`), check targets, require any echoed
   base to equal the requested base (`publication.base_mismatch`), apply the
   after-effect matrix; admit every payload through the destination's content
   policy, which must return the payload unchanged and without error
   diagnostics (`publication.content_policy_refused`); then create the plan
   record. A governance state short of accepted review does not refuse
   preparation — the returned `governance` reports it. The plan is
   content-addressed, so repeated preparation returns the first persisted plan
   and writes nothing new; a create-only conflict can differ only in
   `createdAt` and resolves to the stored plan.
9. **After-effect semantics follow effect class.** A `context` destination
   must provide `disable` or `rollback` for every effect; `compensate` and
   `irreversible` there are `publication.after_effect_invalid`. `proposal`,
   `external`, and `authority` destinations may declare any of the four,
   including `irreversible` with a rationale; the host's `riskFloor` is where an
   irreversible destination's floor lives.
10. **`publish` refuses before any write, in a fixed order.** Load the plan
    (`publication.plan_not_found` throws); compare registry revision, policy,
    scope policy, destination registration digest, and candidate digest to the
    current loop (`blocked`, `publication.binding_mismatch`); recompute
    governance and require `accepted` or `not_required` review with intact
    evidence/derivation/admission lineage (`blocked`, `policy.blocked` plus the
    governance reasons); require a configured authority
    (`blocked`, `policy.authority_insufficient`); call the loop's exact
    authority port with the opaque evidence and the binding derived from the
    plan (`pending` → `pending`; `denied`, `invalid`, `expired` → `denied`,
    each tagged `authority.<status>` ahead of the host diagnostics); assert the
    exact-port handle; require `bindingDigest` equality (`denied`,
    `publication.binding_mismatch`); require `expiresAt` later than the loop
    clock (`denied`, `authority.expired`). Authority is consulted only after
    governance passes, so a pending host approval is never requested for a
    plan policy already blocks.
11. **The authorized branch ends at the activation-tier gate.** In this slice
    a fully authorized plan returns `blocked` with `policy.blocked` naming the
    journaled publisher. No refusal path and no authorized path performs a
    destination write or a store write; `preparePublication`'s plan record is
    the only durable fact Activate adds. The journaled publisher keeps every
    check in ruling 10 verbatim and continues from the gate.
12. **The public surface grows by nineteen names.** Root adds
    `EffectClass`, `AfterEffectSemantics`, `PreparedEffect`,
    `PublicationLineage`, `PublicationPlan`, `AuthorizationBinding`,
    `PublicationReceipt`, `parsePreparedEffect`, `parsePublicationPlan`,
    `publicationPlanDigest`, `parseAuthorizationBinding`,
    `authorizationBindingDigest`, `AuthorityPort`, `VerifiedAuthorization`,
    `createAuthorityPort`, `PublicationDestination`,
    `DestinationRegistration`, `PreparedPublication`, and `PublicationOutcome`.
    The all-entrypoint snapshot moves from 158 to 177. `PublicationOutcome` is
    the refusal subset `{ status: pending | denied | blocked | failed,
    diagnostics }`; the publisher widens it additively with the
    `published | resumed | no_op` variants and `InterventionRecord`. No
    `/testing` destination or authority helper and no destination conformance
    runner is added yet.

## Digest and identity matrix

| Value | Domain tag | Includes | Excludes |
| --- | --- | --- | --- |
| `planDigest` | `publication-plan:v1` | candidateId, candidateDigest, destinationId, action, effectClass, effectiveRisk, ordered full effects, policyDigest, lineage | schemaVersion, id, planDigest, createdAt |
| plan `id` | — | `plan-<planDigest>` | — |
| `lineageClosureDigest` | `publication-lineage-closure:v1` | candidateDigest, full lineage | effects, policy, action, risk |
| binding digest | `authorization-binding:v1` | every AuthorizationBinding field | — |
| `registrationDigest` (destination) | `destination-registration:v1` | destinationId, effectClass, riskFloor, permittedTargetPatterns, authorizationRuleId, contentPolicyId | adapter behavior |
| `registrationDigest` (authority) | — | `{ id, version, configurationDigest }` | verifier, runtime token |
| `payloadDigest` | — | canonical JSON of the effect payload | — |

## Error codes added

`publication.plan_not_found`, `publication.destination_unknown`,
`publication.destination_mismatch`, `publication.candidate_not_found`,
`publication.candidate_legacy_unbound`, `publication.candidate_invalid`,
`publication.action_unavailable`, `publication.effect_invalid`,
`publication.target_not_permitted`, `publication.base_mismatch`,
`publication.after_effect_invalid`, `publication.content_policy_refused`,
`publication.binding_mismatch`, `authority.pending`, `authority.denied`,
`authority.invalid`, `authority.expired`, `authority.unverified`, plus the
existing `policy.blocked`, `policy.authority_insufficient`, `config.invalid`,
`schema.invalid`, and `schema.corrupt`.

## Validation evidence

L1 contract/schema/digest controls: record round-trips and unknown-field
dropping, digest goldens, every bound field changing the plan and binding
digests, effect-order sensitivity, the lineage closure excluding effects and
policy, malformed shapes, the 100-effect boundary, authority registration
goldens and malformed-host-result refusals, destination-registration
refusals, registry-revision binding for authority and destinations, and
target-pattern semantics including a star-heavy hostile pattern.

L2 deterministic engine controls: exact plan contents against a live loop,
idempotent preparation across a ticking clock, base binding, every preparation
refusal with a store snapshot and destination spy proving no write, snapshot
immunity to later caller mutation of a registration, the destination floor
raising review independence, a derivation-backed candidate binding detector,
lens, and pack, and the refusal conformance matrix — host pending/denied/
invalid/expired, kernel-clock expiry, wrong-base approval, stale approval of an
earlier plan, missing authority, missing or rejected review, registry and
registration drift, unregistered destination, unknown plan, malformed input —
each proving zero destination writes and zero store writes, with the
authorized branch stopping at the activation-tier gate under the same proof.

- **L3 live destination/authority evidence:** empty; no external system was
  called.
- **L4 semantic/model evaluation:** empty.
- **L5 operational/SLO evidence:** empty.
- **L6 longitudinal acceptance evidence:** empty.

## Deferred to the second half of #10

The journaled idempotent publisher: `applyEffect` with kernel idempotency
keys, `PublicationReceipt` parsing and receipt verification,
`InterventionRecord`/`InterventionTransition` and the legal-transition table,
crash-resume at every journal step (retry completes the same plan or no-ops),
disable/rollback/compensate as new bound plans through the same path,
authorization consumption records, refusal of plans whose candidate has been
superseded, a destination conformance runner and `/testing` helpers,
`GovernanceView.publication: "eligible"`, retirement of the
`blockedPendingActivationTier` placeholder rule, and the #26 gate before the
authorized branch may write.

## Migration consequences

- Existing candidate, review, evidence, semantic, recurrence, admission, and
  workflow bytes are unchanged. One private store kind, `publication-plan`, is
  added; it is not a supported consumer API.
- Omitting `destinations` and `authority` preserves prior loop-registry bytes
  exactly. Configuring either creates a new registry revision and therefore
  invalidates old opaque query cursors by design.
- Registering a destination whose floor exceeds a candidate's proposed risk
  raises that candidate's review requirements from the next review on;
  historical reviews are not relabeled.
- `effectiveRisk` is now context-bound inside the engine; no public signature
  changes.
