# 0015 — Durable detector-pack run receipts and scoped audit reads

**Date:** 2026-08-20
**Status:** ratified — issue #30c2b2-receipts

## Context

Decision 0014 registers immutable orchestration policy and returns transient
pack/group dispositions. It still leaves no durable fact explaining which
exact population, child executions, recurrence groups, policy and bounded
dispositions one committed pack call observed. Persisting the transient result
directly would be incorrect: callback-attempt and `existing` fields change on
retry, current recurrence counts may grow, diagnostics may change with evidence
health, and unresolved caller ids must not become durable cross-scope content.

This slice adds a kernel-created audit receipt and exact-scope read surface. It
does not assess Candidate governance or enforce the registered rejection
suppression configuration.

## Rulings

1. **Only configured commit runs may create a receipt.** `runDetectorPack`
   returns optional `receipt?: DetectorPackRunReceipt`. The field is present
   only after a commit under an exact DetectorOrchestrationPolicy successfully
   persists or reuses the exact receipt. Dry runs, policy omission, snapshot
   refusal, and populations that cannot be proven one-to-one in the exact
   scope remain transient and create no receipt or index.
2. **Unresolved caller ids never persist.** Receipt population binds canonical
   sorted requestedEpisodeRecordIds and one positional resolvedEpisodes entry
   for every requested id. Each resolved entry binds episode record, identity,
   outcome-claim and view digests plus exact scope digest. Nonempty missing,
   unreadable, wrong-scope or canary ids make the receipt unavailable rather
   than being copied into a same-scope audit record. Empty input may bind the
   exact empty population. populationDigest hashes exact
   `{ requestedEpisodeRecordIds, resolvedEpisodes }`.
3. **Transient retry fields are excluded.** Durable items never carry
   callbackInvoked or persistence-dependent `existing`. executionDisposition is
   closed to `executed | not_applicable | incomplete | capped | refused`;
   applied existing executions normalize to executed, while existing
   non-applied executions retain their semantic status. reasonCodes are sorted
   retry-stable execution/preflight/pack codes, never mutable EvidenceHealthView
   diagnostics or diagnostic messages.
4. **Every item binds exact semantic lineage.** An item binds exact detector
   id/version/registration/configuration/implementation, nullable exact lens,
   output kind, normalized execution disposition, nullable execution
   id/key/full digest, recurrence, reason codes and itemDigest. Insight output
   requires a lens except the explicit no-compatible-lens non-application;
   evidence-health output is lens-independent.
5. **Absent recurrence is explicit.** A non-grouped item records one closed
   reason: `execution_not_materialized | execution_not_applied |
   condition_not_detected | locator_unavailable | result_not_retained` plus a
   nullable decisionBindingDigest. Only locator_unavailable may retain an exact
   nullable-decision binding digest. Cross-field parsing requires absent reason,
   execution disposition and execution reference to agree.
6. **Grouped recurrence freezes one exact group snapshot.** It binds group key,
   treated locator, decision binding digest, nonzero committed execution count,
   sorted nonempty episodeIdentityDigests, exact count and set digest, and one
   governance branch. Repeated receipt items for one group must carry identical
   counts, set digest and governance.
7. **Governance is explicitly not assessed in this slice.** The kernel mints
   only `{ status: "not_assessed", reason: "candidate_claims_deferred",
   groupDisposition: "unassessed" | "capped" }`, recomputed from stable item
   order, exact unique group keys, output family and the embedded full policy.
   It reads no Candidate or review and creates no Candidate/group claim.
8. **The parser reserves an exact future assessed branch.** Assessed governance
   structurally binds exact Candidate id/content/claim and derivation digests,
   episode-set digest/count, exact supersession claim, latest review id/record
   digest/disposition/time, exact required predecessor, paired governing
   rejection/override count, closed group disposition and sorted reason codes.
   The receipt runtime does not mint or treat that branch as current; views
   report it historical until the Candidate-governance decision lands.
9. **Governance snapshot identity includes group state.**
   governanceSnapshotDigest hashes sorted unique group projections containing
   group key, execution count, distinct-episode count, episode-set digest and
   full governance branch. Normal group growth or future Candidate/review
   assessment therefore creates a new pack-run identity instead of changing an
   old receipt or producing a false same-key conflict.
10. **Pack-run key bytes are retry-stable.** packRunKeyDigest hashes exact
    domain, loop/semantic registry, policy ref, pack, scope/policy, population
    digest, governance snapshot digest, and sorted selection projections
    containing detector/lens/output kind, child execution key or null, and
    exact recurrence group key or null. Like
    DetectorExecutionRecord.executionKeyDigest, it excludes result fields:
    execution disposition, reason codes, absent reason, callback/persistence
    activity, child full execution digests and direct recurrence results/counts.
    governanceSnapshotDigest is included because it is a frozen external
    group/governance input and already binds group keys/counts/set digests. The
    key also excludes schema, id, item/full receipt digests and itself. The id is exactly
    `detector-pack-run-${packRunKeyDigest}`.
11. **Full receipt bytes are independently bound.** Each itemDigest hashes its
    complete item except itself. receiptDigest hashes the complete receipt
    content including full embedded policy, population, items, governance
    snapshot and packRunKeyDigest, excluding schema, id and itself. Same key
    with another full receipt is `semantic.pack_run_conflict`; nothing
    overwrites.
12. **Receipt-last is non-atomic across children.** Exact child execution and
    recurrence graphs commit first. The kernel then resolves one stable receipt
    snapshot, ensures the exact semantic-registry snapshot, creates a
    scope-partitioned result-lock index, and creates DetectorPackRunReceipt
    last. An index without receipt is invisible; same-byte retry
    forward-completes. Child facts may remain if receipt creation later fails.
13. **A durable receipt is audit, not a callback cache.** Because group and
    governance identity are resolved after child planning, discovering an
    existing pack receipt may still require evaluating uncached/capped child
    callbacks. Exact committed child execution receipts retain their c1
    callback-skip guarantee. The returned receipt alone does not imply the
    whole pack was one transaction.
14. **Reads require exact scope.** `queryDetectorPackRuns` and
    `getDetectorPackRun` consult only a namespace derived from the caller's
    exact scope digest before loading a receipt. Wrong-scope direct gets return
    undefined without touching a global target. Query filters are bounded and
    cursors bind normalized filters excluding page limit, current registry and
    cursor store scope. No locator, private keyed digest or group-key search is
    exposed.
15. **Views keep independent dimensions separate.** DetectorPackRunView reports
    immutable receipt, current/historical semantic-registry binding,
    current/historical policy binding, receipt commit integrity, each child
    execution's commit integrity, current aggregate evidence health, and
    governance binding. Not-assessed receipts remain not_assessed; structurally
    assessed receipts are historical, never silently current or enforcing.
16. **Reads revalidate complete provenance.** A committed child must resolve
    exact detector/pack/lens/output kind, registry revision, scope/scope-policy,
    execution key/full digest and recurrence decision/group lineage from the
    receipt. The view also replays the selected detector/lens fan-out and exact
    invocation/aggregate-cap ordering under the embedded policy. Missing or
    mismatched registry snapshot, scope index, receipt, child, recurrence
    binding/member or privacy treatment makes the typed view invalid; malformed
    stored bytes are store corruption.
17. **Resource ceilings fail closed.** Receipts are capped at 64 MiB canonical
    bytes, 5,000 items, 500 population episodes, the policy's 100-or-lower
    committed-execution and grouped-item bounds, 50,000 total group identity
    references, 50,000 future Candidate bindings, 5,000 identities per group
    and 1,000 reason codes. Nothing truncates a receipt, governance set or query
    filter. One query page admits at most 64 MiB of receipt bytes, 5,000 receipt
    items, 5,000 child refs, 5,000 population-episode resolutions and 100 unique
    recurrence-group folds; direct gets inherit one receipt's equivalent bounds.
18. **The public-surface increase is four symbols.** This slice exports
    DetectorPackRunReceipt, parseDetectorPackRunReceipt,
    DetectorPackRunQuery and DetectorPackRunView. LearningLoop gains query/get
    methods and DetectorPackRunResult gains an optional receipt under existing
    symbols. No public digest helper or writer is exported. The root snapshot
    increases from 150 to 154.

## Exact read surface

DetectorPackRunQuery requires scope and limit, and may filter exact receipt,
pack id/version/manifest, policy digest, detector id/registration, lens
registration, normalized execution disposition, group disposition, recurrence
status, governance status, receipt status, current registry status and receipt
commit status. Arrays are bounded set-like filters; different fields intersect.
Cursors are opaque. There is no free-text, diagnostic-message, locator or
group-key search.

DetectorPackRunView contains:

- receipt;
- registryBinding: configured or historical_unconfigured;
- policyBinding: configured or historical_unconfigured;
- commitBinding: committed or invalid;
- childBindings with exact execution id, committed/invalid and diagnostics;
- governanceBinding: not_assessed, current, historical or invalid;
- aggregate current EvidenceHealthView.

## Deferred governance

Decision 0016 subsequently implements private derivation/Candidate recurrence
claims and group-Candidate append lineage, derived only from exact qualified
execution/derivation facts. Receipt minting in the current runtime still does
not read those claims. Current Candidate/review assessment, deduplication,
suppression, override, assessed receipt minting and proposal admission remain
deferred. Historical/manual/unbound Candidates are never auto-migrated.

Reference detector contents remain #30d. Semantic/model workflows remain #13.
Candidate-utility calibration and every quality/improvement claim remain #26.
Scheduling, cost/time budgets, publication, authorization, exposure and
activation remain outside this receipt.

## Migration consequences

- Existing execution, recurrence, derivation, Candidate, review, policy and
  source/evidence bytes are unchanged. The receipt record and exact-scope index
  are additive.
- Policy omission, dry runs and unresolved populations preserve the prior
  result shape with receipt omitted and create no durable receipt/index.
- Historical receipts retain their embedded full policy and immutable
  governance snapshot. Current policy, evidence health and future governance
  remain separate view dimensions.
- Assessed governance bytes may parse for forward audit but are not current or
  enforcing in this runtime.
- No receipt creates a Candidate, grants review, suppression, publication,
  authorization, activation, validation, utility or efficacy.
