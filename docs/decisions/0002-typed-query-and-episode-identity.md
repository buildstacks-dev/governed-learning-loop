# 0002 — Typed queries, episode identity, and campaign order

**Date:** 2026-08-19
**Status:** ratified — explicit human campaign instruction (Bikram Gupta, 2026-08-19)

## Context

The first public consumer proved that exposing `LearningStore` is not a usable
read contract. It had to know the engine's private namespace and record kinds,
reconstruct episode identity from observations, and re-propose a candidate to
obtain its current governance view. The same read seam is a prerequisite for
registered detectors, qualitative workflows, and honest calibration.

Existing schema-version-1 `EpisodeRecord` bytes are already durable. Rewriting
them to add adapter identity would change historical bytes without a migration
contract, so episode identity must be recovered without altering those records.

## Rulings

1. **The API contract is normative.** `docs/contract/api-contract.md` is the
   ratified public contract for this repository. Its stale proposal-status line
   is corrected in this decision.
2. **Campaign dependency order is explicit.** The active order is
   `#25 → #23/#31 → #30 → #13a → #13b → #13c → #26 → #10 → #11 → #12 → #14`.
   Decision 0021 refines #13 into a private no-egress substrate, typed
   generation/provider integration, then advisory review; it does not move
   decisive calibrated review ahead of #26. This supersedes
   decision 0001's coarse Observe/Govern-then-Activate-then-Validate order; it
   does not weaken the independence of the four lifecycle tiers.
3. **Public reads are typed and bounded.** The façade exposes domain-specific
   observation, measurement, and episode queries as
   `AsyncIterable<QueryPage<T>>`. Every request requires a page `limit` from 1
   through 500. Consumers never address engine namespaces or record kinds.
4. **Cursors are opaque query capabilities.** A cursor binds the domain kind,
   normalized filters, immutable loop registry revision, and query-cursor
   store scope. Reusing it with a different query, registry, or store is
   invalid. Hosts may configure a stable non-secret tenant/store scope for
   cross-instance resume; omission creates a process-local scope. `limit` is
   deliberately excluded from the binding so a resumed reader may change page
   size. Query keys are closed and filter/cursor sizes are bounded; ingestion
   applies matching bounds to queryable projection identifiers so a typo,
   oversized input, or accepted-but-unaddressable identifier cannot silently
   broaden or exhaust a read.
5. **Query revisions are append-visible, not frozen populations.** Each page's
   `snapshotRevision` identifies the store revision observed for that page.
   Later pages may include records appended after an earlier page. A query
   cursor and its revisions therefore do not establish a frozen detector,
   calibration, or experiment population; those workflows must persist and
   digest an exact eligible set separately.
6. **Episode identity uses an internal immutable sidecar.** At ingestion the
   engine binds a stored `EpisodeRecord.id` to the registered source id, source
   record id, provider-neutral episode id, optional parent/episode class,
   registry revision, trust ceiling, and episode completeness. The sidecar is
   an engine-private append-only claim stream: one distinct claim resolves,
   while two claims atomically fold to conflict without a second marker write.
   It leaves `EpisodeRecord` schema-version-1 bytes unchanged. Idempotent
   re-ingestion backfills missing sidecars for existing records; disagreement
   fails closed and the public `EpisodeView` reports unresolved identity with
   typed diagnostics. Schema-version-1 source ids reserve `/` as their durable
   source/record delimiter; registration rejects source ids containing it.
7. **Candidate lookup is read-only.** `getCandidateView` loads and validates the
   stored candidate and folds its reviews. It never calls `propose`, claims a
   digest, or writes store state.

## Consequences

- `QueryPage`, the three query inputs, `EpisodeView`, `CandidateView`, and the
  new façade methods are deliberate additions to the root export budget.
- `ProposeOutcome` extends `CandidateView`, so proposal and later read paths
  expose the same candidate/governance projection.
- Consumers migrate from direct `LearningStore.list` calls to the façade.
  Internal namespace layout remains unsupported.
- Page revisions are suitable for detecting append visibility and diagnosing
  drift, but never substitute for the frozen eligibility-set digests required
  by candidate-utility studies or efficacy experiments.
