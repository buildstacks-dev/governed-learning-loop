# 0012 — Bounded detector-pack orchestration without pack authority

**Date:** 2026-08-20
**Status:** ratified — issue #30c2a pack runner

## Context

Decision 0011 provides one exact, capability-bound detector run over one
caller-declared episode population. A host can call it repeatedly, but doing so
outside the kernel would leave pack membership, detector/lens fan-out,
ordering, aggregate resource ceilings, and skipped work implicit.

The first pack slice must make those choices inspectable without prematurely
ratifying recurrence identity or a suppression ledger. In particular, a
pack-wide write API or caller-minted pack receipt would create a second semantic
lineage authority. A durable pack receipt also cannot be defined honestly until
keyed recurrence, rejection suppression, and their immutable policy snapshot
are specified together.

## Rulings

1. **One selected-pack façade owns orchestration.** `runDetectorPack` accepts
   only mode, one exact selected pack ref, mandatory exact Scope, and canonical
   sorted-unique episode record ids. Callers cannot submit detector/lens pairs,
   windows, execution bytes, dispositions, caps, ids, digests, or persistence
   instructions.
2. **Pair selection is exact and deterministic.** The kernel considers only
   exact selected detectors in the exact selected pack. An evidence-health
   detector pairs with `lens: null`; an insight detector pairs with each
   compatible exact selected lens contained in that same pack. Pairs are
   ordered by protocol code-unit ordering of their exact detector then lens
   reference keys, never locale ordering. A coherent insight detector with no
   compatible lens in the requested pack produces an explicit
   `not_applicable` item. A missing exact registration named by the immutable
   registry is corruption and fails the whole call.
3. **Dispositions are closed orchestration summaries.** Each considered item
   reports its exact detector and lens, one of `executed | existing |
   not_applicable | incomplete | capped | refused`, whether its callback ran,
   an optional exact DetectorRunResult, and sanitized diagnostics.
   `not_applicable` and `incomplete` take precedence over `existing`, so an
   existing non-application fact never looks ready. `completed | partial` is
   only the pack call's orchestration status; it is not a detector result,
   pass, efficacy verdict, or improvement claim.
4. **Hard ceilings are kernel constants in c2a.** Input retains c1's maximum of
   500 episode ids. More than 5,000 detector/lens selections fails before any
   callback. At most 100 child invocations are admitted. The report retains at
   most 100 unique new content-addressed output records in total—
   InsightDerivations plus detector-output EvidenceHealthFindings—and at most
   64 MiB of canonical, mode-normalized child-result bytes. Exact existing
   outputs do not count as new outputs but do count toward retained bytes;
   repeated ids inside the same plan count once.
5. **Caps never truncate a child.** If one evaluated child would cross the
   aggregate output or byte ceiling, that whole item is `capped`, its result is
   discarded, and `callbackInvoked` remains true. Later runnable items are
   explicitly capped without callback invocation. Items beyond the invocation
   ceiling are likewise retained as capped dispositions. There is no silent
   omission or partial derivation/finding list.
6. **Planning is snapshot-stable.** The kernel constructs each child through
   the c1 unknown-first runner in dry-run mode under one before/after semantic
   graph snapshot. If the aggregate snapshot changes, no pack write occurs and
   every non-capped attempted item is returned as refused with sanitized
   snapshot diagnostics. Corrupt store or registry state is fatal rather than
   being downgraded to a normal refusal.
7. **Modes do not accept caller plans.** A public `dry_run` performs zero
   kernel/store writes. A `commit` call independently constructs one private
   exact plan, then persists its retained child execution graphs sequentially
   through the existing private receipt-last path. It does not accept bytes
   from an earlier public dry-run and does not invoke a child callback a second
   time within the same pack call. Nested DetectorRunResult values are
   normalized to the requested pack mode and final persistence state. An exact
   existing child receipt remains terminal and skips its callback.
8. **The pack call is transient and not batch-atomic.** C2a creates no
   DetectorPackRunReceipt, pack-run id/digest, store kind, query, or arbitrary
   persistence method. Earlier exact child commits may remain if a later child
   is refused; retry relies on child-level idempotency. Consequently the
   per-call caps are safety ceilings, not a durable rate, deduplication, or
   suppression policy. Repeated calls may observe earlier children as existing
   and must not be presented as one frozen campaign.
9. **Pack execution grants no learning authority.** Neither mode calls
   `propose`, creates a Candidate, writes active context, receives a provider
   capability, schedules work, routes publication, authorizes content, or
   claims utility. As in c1, the kernel cannot sandbox side effects hidden in
   host callback closures. A detected condition still does not establish harm
   or efficacy.
10. **The public-surface increase is three types.** C2a exports
    DetectorOrchestrationDisposition, DetectorPackRunInput, and
    DetectorPackRunResult. `LearningLoop.runDetectorPack` adds no standalone
    symbol. The root snapshot increases from 143 to 146.

## Persistence and failure matrix

| Situation | Callback | Returned item | Durable effect |
| --- | --- | --- | --- |
| No compatible lens in this pack | no | `not_applicable`, no child result | none |
| Child is non-applicable or incomplete | no | exact status-first result when bindable | commit may persist the exact child fact |
| Exact child receipt already exists | no | exact stored result; semantic status remains visible | none beyond idempotent existing state |
| Eligible retained child | once | exact result | dry-run none; commit uses private receipt-last persistence |
| Invocation/output/byte ceiling | no, except the first evaluated crossing item | `capped`; no result bytes retained | none for that child |
| Callback/result refusal | attempted at most once | `refused`; callback attempt remains visible | none for that child |
| Corrupt registry/store graph | no further callbacks | call throws | no later child commit |

Commit is intentionally not a transaction across children. Individual
receipt-last graphs retain their existing crash and idempotency guarantees.

## C2a and C2b sequencing

**Implemented in #30c2a:** exact selected-pack fan-out, compatible lens
selection, stable ordering, explicit per-item dispositions, callback-attempt
visibility, aggregate dry planning, fixed safety ceilings, dry-run zero-write
behavior, and sequential private child persistence.

**Implemented next in #30c2b1 by decision 0013:** privacy-treated recurrence
locators, pack-independent group identity, private create-only execution
bindings, append-only members, bounded committed folds, crash recovery, and
dry-run group previews. Counts remain descriptive and grant no authority.

**Implemented next by decision 0014:** registered host-digested lower
invocation/group caps and transient `not_grouped | unassessed | capped`
classification. Rejection-suppression configuration remains non-enforcing.

**Implemented next by decision 0015:** durable normalized pack-run receipts,
receipt-last exact-scope audit reads and immutable not-assessed governance
snapshots. No public receipt writer is exposed.

**Implemented next by decision 0016:** private derivation/Candidate recurrence
claims, exact frozen proposal baselines and observational CandidateView
lineage.

**Still deferred:** assessed availability, deduplication,
decisive-rejection suppression and override evidence, and proposal admission.

Reference detector contents and synthetic controls remain #30d. Optional
semantic/model workflows remain #13. Candidate-utility calibration and every
default-quality claim remain #26. Scheduling, provider routing, budgets,
publication, and active-context effects remain host or later lifecycle work.

## Migration consequences

- Existing detector, execution, derivation, Candidate, review, query, cursor,
  and registry bytes are unchanged. C2a adds no durable record kind.
- Existing c1 callers continue to use `runDetector`; pack orchestration is an
  additive convenience over the same exact child facts.
- No historical execution is automatically grouped, deduplicated, suppressed,
  or relabeled. C2b must add explicit new lineage for those claims.
- Strict consumers gain exactly three root type exports and one method on
  LearningLoop. No parser or digest is exported because C2a has no pack record.
