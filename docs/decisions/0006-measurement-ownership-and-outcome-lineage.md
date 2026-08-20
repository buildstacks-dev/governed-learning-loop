# 0006 — Measurement ownership and append-only outcome lineage

**Date:** 2026-08-19
**Status:** ratified — issue #31c measurement integrity

## Context

Decisions 0004 and 0005 bound source pages and candidate observations to exact
durable lineage, but schema-version-1 measurement references remained
deliberately unqualified. A `MeasurementRecord` could declare one metric value
type while carrying another runtime scalar, cite observations from another
source or episode, or appear in an `EpisodeRecord.outcome` without an exact
append-visible ownership claim. Treating those shapes as zero, successful, or
efficacy evidence would violate the kernel's fail-closed measurement rule.

Late outcomes also cannot rewrite a durable `EpisodeRecord`. They need retained
attempt history and a latest folded view without making the same episode
derivative appear committed by two source-page receipts.

## Rulings

1. **Metric value type is a runtime invariant.** `parseMeasurementRecord`
   requires `typeof value` to equal `metric.valueType` exactly after finite
   scalar parsing. A mismatch is invalid evidence, never coercion, zero, false,
   or a passing value.
2. **EvidenceRef v1 remains byte-stable.** The former `EvidenceRef` shape is
   named `EvidenceRefV1`; its schema, canonical digest bytes, and acceptance of
   `kind: "observation" | "measurement"` do not change. An
   `ObservationEvidenceRef` is the v1 observation subtype. A v1 measurement
   reference remains parseable audit history but is permanently unqualified
   for outcome, candidate, validation, or improvement claims.
3. **Qualified measurements use `MeasurementEvidenceRefV2`.** It carries
   `schemaVersion: 2`, `kind: "measurement"`, every existing common record,
   source, receipt, trust, completeness, and episode field, plus a nonempty
   ordered `supportingEvidenceRefs` array of at most 1,000
   `ObservationEvidenceRef` values. `EvidenceRef` becomes the v1-or-v2 union.
4. **V2 reference digests are domain-separated.** V1 `referenceDigest` bytes
   remain exactly unchanged. V2 canonical bytes include `schemaVersion: 2`,
   every common lineage field, and every complete supporting observation
   reference in order. `schemaVersion` is included and `referenceDigest` is
   excluded. Reordering or changing one support changes the digest.
5. **Supporting observation ownership is exact.** Supports are unique by both
   `referenceDigest` and durable `recordId`. Every support has the same
   `sourceId`, source registration revision, privacy-treated source reference,
   source revision, loop registry revision, and exact episode record, identity,
   scope, and episode-receipt lineage as the measurement. Evidence and
   measurement page receipts may differ within that exact source revision.
6. **Citations resolve before qualification.** Measurement minting resolves
   every `MeasurementRecord.evidenceIds` entry to one committed observation in
   the declared order. Missing, extra, ambiguous, corrupt, cross-source,
   cross-revision, cross-episode, or duplicate support refuses qualification.
   Trust, completeness, and source-health constraints are retained; incomplete
   cited observations never become an implicit pass.
7. **Outcomes are append-only claims.** Normal ingest, not a new public append
   façade, may append a content-digested episode-outcome claim after resolving
   its measurements to v2 references. A claim binds exact episode/source
   identity, status, and ordered measurement references. Every attempt remains
   in ordered history; the latest valid claim supplies the current folded
   outcome. Concurrent appends use the store stream primitive and deterministic
   ids.
8. **Episode views expose lineage, not raw outcome assertions.** `EpisodeView`
   strips the stored schema-v1 `EpisodeRecord.outcome` field and adds
   `outcomeLineage`: `absent`, `legacy_unbound` with diagnostics, or `resolved`
   with the latest claim digest, ordered history digests, exact v2 measurement
   references, and closed evidence health. A resolved latest claim synthesizes
   `episode.outcome.status` and measurement ids from those references.
9. **Candidate measurement eligibility follows the latest claim.** A v2
   measurement reference may support a candidate only when it is an exact
   member of the latest resolved outcome claim for that episode and its current
   evidence health permits use. Historical attempts remain visible but do not
   silently replace the latest population or verdict.
10. **Legacy raw outcomes are unqualified.** Existing `EpisodeRecord.outcome`
    bytes remain immutable audit history. Without an append-only claim they
    produce `legacy_unbound`, not a resolved outcome, and their bare
    `measurementIds` are never retroactively strengthened by later receipts.
11. **Ownership mismatch is evidence health.** The closed code
    `source.ownership_mismatch` records source, citation, measurement, episode,
    or outcome ownership conflicts with effect `blocks_use`. It is not a
    behavioral learning candidate and cannot enter a passing denominator.
12. **Reasserted projections are counted, not recommitted.** New source-page
    receipts may carry optional nonnegative safe-integer
    `projectionCounts.reused`. Valid `exists_same` projections already committed
    by another exact page receipt increment `reused` and do not add a second
    derivative tuple. The accounting invariant is `derivatives.length +
    rejected + reused = total projections`. Historical receipts omit the field,
    parse it as zero for invariants, preserve its omission, and retain their
    exact digest bytes. New ingest receipts include `reused` only when nonzero,
    so an idempotent read of an older exact page reproduces its original bytes.
    A private create-only derivative-owner claim is written before the
    derivative record and binds one source/page plus content-policy/loop
    configuration identity. It bootstraps from a
    historical committed receipt. Concurrent different pages therefore cannot
    both emit the same derivative tuple: one owns it and the other records
    reuse. A claim without its eventual page receipt grants nothing and remains
    incomplete until the owning page is explicitly retried.
13. **Missing or invalid is never pass.** No absent claim, missing measurement,
    invalid runtime value, incomplete citation, ownership mismatch, or legacy
    record is converted to zero or success. Such evidence remains absent,
    incomplete, invalid, or legacy-unbound until exact qualifying lineage is
    appended.
14. **The root export increase is deliberate.** `EvidenceRefV1`,
    `ObservationEvidenceRef`, and `MeasurementEvidenceRefV2` join the root
    surface. `EvidenceRef`, `evidenceRefDigest`, and `parseEvidenceRef` become
    the additive union API. Outcome claims and their append machinery remain
    engine-private.

## Consequences

- V1 observation and measurement reference golden vectors remain unchanged;
  v2 measurement vectors pin schema domain separation and ordered support.
- Outcome attempts are retained rather than overwritten, while public episode
  reads expose one latest resolved fold with its full history.
- Late outcome pages can reuse the immutable EpisodeRecord without creating an
  ambiguous second episode receipt.
- Candidate counts, raw outcome status, and structurally present measurements
  still do not establish improvement. Validate requires a separately frozen,
  comparable experiment with valid measurements and guardrails.
- Conformance covers metric runtime types, citation ownership and order,
  duplicate/missing supports, v1 digest stability, v2 digest vectors, legacy
  outcome handling, append concurrency/history, reused receipt accounting,
  and fail-closed missingness.
