# 0026 — Journaled idempotent publisher, intervention history, and reversal plans

**Date:** 2026-08-21
**Status:** ratified — issue #10 second half; closes #10 and completes M3
Activate on the package side

## Context

Decision 0025 shipped the records-and-refusal half of Activate: exact
content-addressed plans, the loop-bound authority port, host destination
registrations, `preparePublication`, and every refusal check of `publish`,
with the authorized branch stopping at a placeholder gate so that nothing in
the package could write to a destination. Issue #10 left open the journaled
idempotent publisher — `applyEffect` under kernel idempotency keys, receipt
verification, `InterventionRecord`/`InterventionTransition` with the
protocol's legal-transition table, crash-resume at every journal step,
disable/rollback/compensate as new bound plans through the same path,
authorization consumption records, superseded-candidate refusal, a destination
conformance runner with `/testing` helpers, `GovernanceView.publication:
"eligible"`, retirement of the `blockedPendingActivationTier` placeholder,
and the #26 gate before the authorized branch may write.

The #10 lifecycle clarification (2026-08-19) required implementing Activate
only after the #26 candidate-utility gate. Issue #26 closed on 2026-08-21
with its human verdict (0 wanted / 4 unsure / 54 not wanted over 58 inert
heuristic candidates; recommendation "add projection kinds", tracked as #56).
The gate is therefore passed procedurally, and its verdict is exactly why
nothing below is automatic: a host authority decides every publication, and a
published intervention's `validation` stays `untested` until the Validate
tier measures it (kernel invariant 3).

Kernel invariants 3 (authorized ≠ validated), 4 (approvals bind exact
content), and 7 (loop-bound capabilities), plus the receipt-last discipline
of decisions 0009, 0015, and 0018, shape every ruling below.

## Rulings

1. **Intervention state has four independent dimensions and an append-only
   history.** `InterventionState`, `InterventionRecord`, and
   `InterventionTransition` are the contract shapes. A transition is
   content-addressed (`transition-<digest>` over interventionId, from, to,
   ordered evidence ids, and occurredAt under `intervention-transition:v1`),
   parsed unknown-first, and refused unless its from/to pair is in the
   legal-transition table. The `InterventionRecord` is never persisted as
   such: it is the deterministic fold of a private create-only header plus the
   intervention's transition stream, reread on every access.
2. **The legal-transition table is closed and part of the protocol.** Every
   intervention starts at `{ unpublished, pending, inactive, untested }`. The
   legal edges are `authorize` (pending → authorized, nothing else changes),
   `publish` (unpublished or failed, inactive → published, active or
   inactive), `fail` (unpublished → failed), `disable` (published or failed,
   active or inactive → disabled; publication unchanged), and `rollback`
   (published or failed → rolled_back, disabled). Every edge keeps
   `validation` unchanged; only `authorize` changes authorization; no edge
   mints `revoked` or `expired`. Structural invariants hold on every state:
   active ⇒ published, pending ⇒ unpublished and inactive, rolled_back ⇒
   disabled. A record claiming any validation other than `untested` without
   at least one bound evaluation is invalid, a published record cites at
   least one receipt, an authorized record cites at least one authorization.
   Over the full state product the table admits exactly 135 edges; that
   number is pinned. Evaluation-bound validation edges belong to #12; later
   revocation is an explicit host policy and a preauthorized effect, never an
   implied transition.
3. **Activation follows effect class.** A completed `publish` plan makes the
   intervention `active` for `context`, `external`, and `authority`
   destinations — the effect is in force — and `inactive` for a `proposal`
   destination, whose publication is an inert ticket or draft. A completed
   reversal plan's own intervention is `published` and `inactive`.
4. **Authorization is consumed into a durable record before any effect.** A
   verified authorization that passes every decision-0025 check is copied
   into a private create-only `publication-authorization` record
   (`authorization-<planDigest>`) binding plan id/digest, the exact binding
   digest, the authorization's id, principal, attestation digest, binding
   digest, and timestamps, the registry revision, the policy digest, and
   `consumedAt`, under `publication-authorization:v1`. It is the first journal
   fact and the intervention's `authorizationIds` cite it. A consumed plan
   never re-consults authority: a retry, a reconstructed host, or a host
   whose authority would now deny all continue from the consumption. This is
   the "authority that was pending, expired or revoked at consumption time"
   rule of the contract made durable.
5. **The journal has a fixed write order and the publish edge is last.** For
   one exact plan the order is: consumption; the private `intervention`
   header (`intervention-<planDigest>`, binding candidate, plan, destination,
   action, effect class, scope digest, parent, and authorization id); a
   create-only scope membership record in the namespace
   `learning-intervention-scope-<scopeDigest>` (written at birth so no
   backfill is ever needed, and the only enumeration #11's resolver will
   have); the `authorize` edge; one create-only `publication-receipt` per
   effect, in plan order, each written after the destination acknowledged
   the effect and before the next effect is attempted; the parent's reversal
   edge for derived plans; then the `publish` edge. Every writer reloads
   before it writes and forward-completes: `exists_same` and a conflict that
   reloads to the same bound content (timestamps excepted) are "another
   attempt got here first"; expected-revision appends serialize contenders;
   an illegal append target is store corruption. A header without its first
   transition is an unborn remnant that reads as absent.
6. **Effects apply under kernel idempotency keys and receipts are verified.**
   The key for an effect is the protocol digest of `{ planDigest, effectId }`
   under `publication-effect-idempotency:v1`, so a re-prepared plan yields new
   keys. The adapter receives a frozen detached copy of the effect and the
   key; its result is parsed from `unknown` as a `PublicationReceipt` and must
   name the plan's destination, the effect id, target, payload digest, key,
   and the exact `expectedBase` the effect bound (both absent or equal).
   A parse failure is `publication.receipt_invalid`, a binding failure is
   `publication.receipt_mismatch`, and a thrown adapter error is
   `publication.destination_failed` carrying at most 1,000 characters of the
   adapter message; none of them journals a receipt. The receipt record
   (`receipt-<key>`, `publication-receipt:v1`) binds plan id/digest,
   intervention id, effect id and index, key, and the full receipt. A retry
   never calls `applyEffect` for an effect whose receipt is durable; when the
   receipt is not durable it re-sends the same key, and the destination
   conformance suite is where "same key ⇒ same receipt, no second effect" is
   proven. The kernel therefore never duplicates an effect it journaled and
   relies on the adapter's idempotency only across a lost acknowledgement.
7. **Adapter failure is journaled and resumable.** The first failed effect
   appends the `fail` edge with the receipts journaled so far as evidence and
   returns `failed` with transient diagnostics; the receipts already
   journaled stay. A retry of the same plan resumes from the first effect
   without a receipt and, on success, appends `publish` from `failed`. A
   repeated failure appends nothing new. No API abandons a journal: a failed
   intervention is either resumed or reversed.
8. **Resume forward-completes on the exact destination registration.** Once
   consumed, a plan ignores registry, policy, scope-policy, candidate, and
   supersession drift — a half-applied plan is never stranded by an
   unrelated registration — but it requires the destination to be registered
   with the exact registration digest the plan bound, because only that
   registration names the adapter the host authorized. Otherwise `publish` is
   `blocked` with `publication.binding_mismatch`, writes nothing, and resumes
   once the host restores the registration.
9. **Outcome status is exact.** `published`: no journal existed and this call
   completed it. `resumed`: a journal existed and this call performed at
   least one write or adapter call to complete it. `no_op`: the journal was
   already complete and this call wrote nothing and called no adapter. Two
   concurrent publishes of one plan converge on one journal and one
   destination effect: one reports `published`, the other `resumed`.
10. **A superseded candidate cannot publish.** Before governance, the fresh
    path of a `publish` plan scans for a schema-version-2 successor naming the
    candidate through `supersedes` with its exact `originalDigest` in the
    same scope and refuses with `publication.candidate_superseded`, writing
    nothing and consulting no authority. The scan reads only the `supersedes`
    field of other candidates before parsing a match and inherits the global
    candidate-kind scan debt already noted for evidence revalidation.
11. **Disable, rollback, and compensate are new bound plans through the same
    path.** `preparePublication` accepts the three actions with an optional
    additive `interventionId`. The parent is the one published or failed
    intervention of the same candidate at the same destination whose current
    state permits the action, located through the scope membership index;
    zero qualifying parents is `publication.intervention_not_found`, more
    than one is `publication.intervention_ambiguous` until `interventionId`
    names one, a named parent of another candidate, destination, or action is
    `publication.intervention_mismatch`, and a named parent whose state does
    not permit the action is `publication.parent_state_invalid`. A caller
    `expectedBase` on a reversal, or `interventionId` on a publish, is
    `schema.invalid`. The effects are derived — never re-prepared by the
    adapter — from the parent plan: one per journaled receipt whose declared
    after-effect kind equals the action, keeping the parent effect id and
    target, carrying the adapter's declared after-effect payload, binding the
    receipt's `finalVersion` as `expectedBase` when the destination reported
    one, and declaring an `irreversible` after-effect whose rationale states
    that reversing a reversal is a new publish plan; no such effect is
    `publication.after_effect_unavailable`. Targets are rechecked against the
    current registration and payloads readmitted through the destination's
    content policy; the after-effect matrix of ruling 0025-9 applies to
    forward effects only. The plan's lineage copies the parent plan's exact
    derivation and binds the parent through the new optional
    `PublicationLineage.parentInterventionId`, which enters the plan digest
    and the lineage closure digest only when present, so every publish-plan
    digest is byte-stable; the parser requires the field exactly for
    reversal actions. A reversal never reverses a reversal.
12. **A reversal needs authority, not a fresh decisive review.** At publish,
    a reversal plan passes the same binding-drift checks, then verifies the
    parent exists, matches, still permits the action, and holds a receipt for
    every derived effect (`blocked` otherwise), then consults authority
    exactly as a publish plan does. It skips the decisive-review and
    supersession checks: a later rejection, evidence invalidation, or
    supersession is a reason to reverse, never a bar. Completion appends the
    parent's `disable` or `rollback` edge (compensate shares the `disable`
    edge; the child plan's `action` records which ran) with the child
    intervention id as evidence, before the child's own `publish` edge. A
    parent already at or beyond the target state is left untouched; the
    parent's receipts and earlier transitions are never rewritten.
13. **Governance eligibility is a policy statement, never a grant.**
    `computeGovernanceView` now takes `destinationRegistered` and
    `authorityConfigured`; `publication` is `eligible` only with `accepted`
    or `not_required` review, a registered destination for the candidate's
    intervention, and a configured authority port, and each missing
    condition is a stated reason (`policy.blocked`,
    `publication.destination_unknown`, `policy.authority_insufficient`).
    Eligibility changes nothing durable and is not an authorization; after a
    denied publish a candidate is still eligible, and after a successful one
    `validation` is still `untested`.
14. **The placeholder rule is retired.** `PolicyRules` loses `publication`
    and `conservativePolicy()` no longer carries
    `blockedPendingActivationTier`. Its rule bytes, and therefore its digest
    and every loop registry revision derived from it, change; the id stays
    `conservative-v1` because the digest is the identity. Publication is
    governed by decisive review, registration, and authority, never by a
    standing block.
15. **`getIntervention` is a pure exact read.** It folds the header and
    stream, verifies the plan exists with the bound digest, reloads and
    verifies every cited receipt and the authorization consumption, and
    returns `undefined` for an unknown id or an unborn header. Corruption is
    a typed `store.corrupt`, never absence.
16. **The `/testing` subpath gains an inert destination and the destination
    conformance runner.** `createInMemoryDestination` keeps a per-target
    append-only version log in process memory: `prepare` is side-effect-free
    and binds the requested base or the target's current version (`v0` when
    empty) with an executable declared after-effect of the configured kind;
    `applyEffect` refuses a stale base (`publication.base_mismatch`), appends
    one version per new key, answers a repeated key from memory, refuses a
    reused key for another effect, and executes the disable, rollback, and
    compensate payloads the kernel derives. `runPublicationDestinationConformance(makeDestination,
    { describe, expect, it })` follows decision 0020's explicit injection and
    registers seven cases: side-effect-free parseable preparation, echoed
    bases, receipts proving the exact effect, same-key idempotency without
    moving the base, distinct effects under new keys, refused key reuse, and
    stale-base refusal when bases are declared. Importing `/testing` still
    loads no test framework.
17. **The public surface grows by eleven names.** Root adds
    `InterventionState`, `InterventionRecord`, `InterventionTransition`,
    `parseInterventionRecord`, `parseInterventionTransition`, and
    `parsePublicationReceipt`; `/testing` adds `InMemoryDestination`,
    `InMemoryDestinationOptions`, `createInMemoryDestination`,
    `PublicationDestinationFactory`, and
    `runPublicationDestinationConformance`. `LearningLoop` gains
    `getIntervention`; `PublicationOutcome` gains the
    `published | resumed | no_op` completion variants carrying the
    `InterventionRecord` and the bare receipts. The all-entrypoint snapshot
    moves from 177 to 188. The journal records, idempotency-key formula,
    header, membership index, and fold are private.

## Digest and identity matrix

| Value | Domain tag | Includes | Excludes |
| --- | --- | --- | --- |
| transition `id` | `intervention-transition:v1` | interventionId, from, to, ordered evidenceIds, occurredAt | schemaVersion, id |
| idempotency key | `publication-effect-idempotency:v1` | planDigest, effectId | everything else; a re-prepared plan yields new keys |
| `consumptionDigest` | `publication-authorization:v1` | planId, planDigest, bindingDigest, consumed authorization projection, registryRevision, policyDigest, consumedAt | schemaVersion, id, host evidence bytes |
| `headerDigest` | `intervention-header:v1` | candidate id/digest, plan id/digest, destinationId, action, effectClass, scopeDigest, parentInterventionId, authorizationId, createdAt | schemaVersion, id |
| `indexDigest` (scope membership) | `intervention-scope-membership:v1` | scopeDigest, interventionId, candidate id/digest, destinationId, action, parentInterventionId | schemaVersion |
| `receiptDigest` (stored receipt) | `publication-receipt:v1` | plan id/digest, interventionId, effectId, effectIndex, idempotencyKey, full receipt | schemaVersion, id |
| `planDigest` / `lineageClosureDigest` | unchanged tags | additionally `lineage.parentInterventionId` when present | absent field leaves 0025 bytes unchanged |
| intervention `id` | — | `intervention-<planDigest>` | — |
| consumption `id` | — | `authorization-<planDigest>` | — |
| receipt `id` | — | `receipt-<idempotencyKey>` | — |

## Error codes added

`publication.candidate_superseded`, `publication.intervention_not_found`,
`publication.intervention_ambiguous`, `publication.intervention_mismatch`,
`publication.parent_state_invalid`, `publication.after_effect_unavailable`,
`publication.receipt_invalid`, `publication.destination_failed`,
`publication.limit_exceeded`, plus the contract's existing
`publication.receipt_mismatch` now minted. `publication.action_unavailable`
is no longer minted.

## Validation evidence

L1 contract/schema/digest controls: state invariants; the named legal edges
and the refused ones (pending/revoked/expired publication, re-enabling,
regression, validation edges, self-edges); an exhaustive pass over the 300
states proving every legal edge keeps validation, changes authority only
pending→authorized, lands on a valid state, and totals exactly 135;
transition round-trip, unknown-field dropping, content-addressed id
recomputation, evidence rules, duplicate evidence, noncanonical time, wrong
version; record rules (receipts when published, authorization when
authorized, evaluation for any validation claim, no self-parent); the
reversal-plan lineage field entering the plan and closure digests while the
publish-plan golden stays byte-identical; the in-memory destination's
reference semantics; and the destination conformance suite run against it.

L2 deterministic engine controls: exact published outcome, receipts,
intervention record, idempotency-key formula, frozen adapter input, store
additions, `getIntervention` equality; authorize-before-publish edge order
with exact evidence and the durable consumption; no-op retries with and
without evidence and under a now-denying authority; invariant 3 through the
view, the record, the parser, and the absence of any validation method;
multi-effect order and distinct keys; proposal-class inactivity; journaled
adapter failure, stuck retry, and resume with exact call accounting; receipt
mismatch/invalid cases; superseded refusal with zero writes; concurrent
convergence; unborn-header reads; reversal preparation without adapter calls
and idempotently; disable, rollback, and compensate completions with parent
transitions; every reversal refusal; parent-state movement blocking at
publish; reversal under a later rejection; reversal of a failed parent; and
the no-side-door check. Crash conformance injects a crash before and after
every journal write for a publish plan (twelve faults) and for a disable
plan (ten faults, including the parent edge), then proves a reconstructed
host converges to the byte-exact journal of a clean run with each effect
applied at the destination exactly once, plus consumed-authority finality,
registration-gated resume, and registry-drift forward completion.

Retiring the placeholder rule moved the `conservative-v1` digest and with it
every registry revision, so 34 registry-bound goldens were re-pinned in this
PR: the admission snapshot/reservation/binding/stream digests, the pack-run
item/key/receipt digests, two recurrence claim digests, the pre-#30b registry
revision, three workflow binding/lock/intent/attempt digests, and the
eighteen positive derivation/execution identities of the reference-detector
v0.1.0 vectors. Digests that do not bind the registry revision — population,
governance snapshot, the reference host-binding, vocabulary, registration,
pack, and fixture digests, and every 0025 publication golden — are unchanged,
which is why no catalog version bump accompanies the re-pin.

- **L3 live destination/authority evidence:** empty; no external system was
  called. The only shipped destination is the inert in-memory one.
- **L4 semantic/model evaluation:** empty.
- **L5 operational/SLO evidence:** empty.
- **L6 longitudinal acceptance evidence:** empty; no intervention has been
  measured, which is exactly what `validation: "untested"` states.

## Migration consequences

- Five private store kinds are added: `publication-authorization`,
  `intervention`, `intervention-transition`, `publication-receipt`, and the
  scope-namespaced `intervention-scope-index`. None is a supported consumer
  API.
- `conservativePolicy()` changes digest. Every loop using it computes a new
  registry revision: opaque query cursors invalidate by design, plans prepared
  under the old policy are refused by binding drift and must be re-prepared,
  and already-consumed journals forward-complete (ruling 8). Historical
  records keep their bytes.
- `PublicationLineage` gains the optional `parentInterventionId`; publish
  plans never carry it and keep their digests.
- `GovernanceView.publication` can now be `eligible`; hosts that treated
  `blocked` as the only value must read the reasons instead.
- The package side of the #14 migration gate ("blocked on M1 + M3") now
  waits only on #11 (context resolution and exposure lineage), which will
  consume the scope membership index and `InterventionRecord` fold added
  here.
