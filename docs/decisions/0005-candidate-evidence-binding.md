# 0005 — Collision-safe candidate evidence binding

**Date:** 2026-08-19
**Status:** ratified — issue #31b candidate integrity

## Context

Decision 0004 made source-page state and derivative lineage durable, but it
deliberately left schema-version-1 `Candidate.evidenceIds` unchanged. A bare
record id cannot prove which source registration, source revision, page
receipt, record bytes, episode identity, or scope a proposal relied on. It can
also collide with another source's record id. The later existence of a receipt
must not retroactively give those historical bytes a stronger meaning.

Candidates need an exact, privacy-treated evidence binding before a review or
eventual authorization can make a defensible claim. That binding must survive
different pages for the evidence record and its episode, must preserve the
order selected by the proposer, and must fail closed when any durable lineage
is missing or inconsistent. Measurement ownership is not yet sufficiently
defined to enter that binding; it remains issue #31c work.

## Rulings

1. **`EvidenceRef` is the exact candidate-evidence lineage record.** Schema
   version 1 contains `kind`, durable `recordId` and `recordDigest`, source id
   and registration revision, source/page/revision/source-record identity, the
   evidence page receipt id and digest, loop registry revision, trust and
   completeness, and an `episode` object. The episode object binds source and
   provider-neutral episode identity, durable episode record id and digest,
   episode-identity sidecar digest, canonical scope digest, and its own page
   receipt id and digest. Evidence and episode receipts are separate because
   the two derivatives may have been committed on different pages.
2. **Reference digests bind all lineage fields.** `referenceDigest` is the
   lower-case SHA-256 digest of protocol-canonical JSON containing every
   `EvidenceRef` field except `schemaVersion` and `referenceDigest` itself.
   Parsers accept `unknown`, construct a fresh parsed object that drops
   preserved-irrelevant unknown fields, reject malformed or inconsistent
   bound fields, recompute the digest, and enforce that `recordId` is exactly
   `${sourceId}/${sourceRecordId}`, episode ownership remains under that same
   source, `pageReceiptId` equals
   `source-page-${pageReceiptDigest}`, and `episode.pageReceiptId` equals
   `source-page-${episode.pageReceiptDigest}`.
3. **Receipt and episode validation happens at proposal time.** The verified
   `propose` path loads and parses the exact evidence record, episode record,
   episode-identity claim, and both page receipts. It verifies their derivative
   tuples, digests, registration and loop revisions, source/page/revision
   identity, episode identity, and scope. Both `parseCandidate` and `propose`
   require every reference's episode scope digest to equal the canonical
   digest of the candidate scope. Missing, corrupt, ambiguous, or mismatched
   lineage refuses candidate creation. The resolver compares every
   evidence-bearing namespace revision before and after the composite fold and
   retries rather than accepting an append-visible mixture.
4. **Callers request evidence; only the kernel constructs references.**
   `CandidateInput.evidenceIds` remains an ordered list of durable record ids
   to resolve. A caller does not submit `EvidenceRef` values or
   `originalDigest`. `propose` preserves request order, resolves each id
   against durable truth, and creates only a schema-version-2 candidate. An
   `ProposeOutcome` therefore narrows its `candidate` to `CandidateV2`. An
   `EvidenceRef` parser makes stored bytes inspectable; it is not a minting or
   trust-grant capability. Evidence requests, and the resulting references,
   must be nonempty. V2 references are unique by both `referenceDigest` and
   `(kind, recordId)`, so re-listing one record cannot double-count support.
5. **Candidate is a versioned union.** `CandidateV1` is the historical shape,
   byte-for-byte: it retains `schemaVersion: 1`, `evidenceIds`, its old digest
   input and canonical bytes, and optional `supersedes`. `CandidateV2` uses
   `schemaVersion: 2`, replaces `evidenceIds` with ordered `evidenceRefs`, may
   carry an optional exact `{ id, digest }` `derivationRef`, and adds optional
   `originalDigest` beside `supersedes`. The public `Candidate` type is
   `CandidateV1 | CandidateV2`.
6. **V1 is permanently `legacy_unbound` and audit-only.** Existing v1
   candidates and reviews remain parseable as historical records, but their
   bare evidence ids are never reinterpreted through current receipts. They
   cannot become publication-eligible, active context, or evidence-backed
   behavioral claims. No read, startup path, re-ingest, or package upgrade
   rewrites or auto-migrates them.
7. **A usable successor is an explicit re-proposal, not a migration.** A host
   requests a new candidate id and may name a prior candidate with
   `supersedes`. The kernel loads that exact prior record and derives
   `originalDigest`; callers cannot assert it. V2 requires `supersedes` and
   `originalDigest` either both to be present or both absent. The pair is
   content-bound, and the predecessor must have the exact same scope. Reads
   revalidate predecessor id, digest, and scope. Cross-isolation lineage needs
   a future explicit policy path; changing the predecessor or any new content
   creates a different candidate digest and cannot reuse an earlier review or
   authorization.
8. **V2 digests are domain-separated and complete.** The v1 digest input and
   canonical bytes stay exactly unchanged. The v2 digest input requires and
   includes `schemaVersion: 2`, all existing governance content fields, every
   full `EvidenceRef` in order, optional `derivationRef`, and optional
   `supersedes`/`originalDigest`. Identity, proposer attribution, proposal
   time, and `contentDigest` remain excluded as before.
9. **Source health constrains evidence use.** A referenced `blocks_use`
   finding refuses proposal resolution. `limits_claims` and `blocks_audit`
   (and partial or unknown completeness) may produce an inert candidate, but
   its evidence health is `incomplete`, governance stays blocked, and no
   reviewer is called. These constraints are not silently converted into
   behavioral evidence or a zero-valued result.
10. **Measurement references remain closed until #31c.** The EvidenceRef
    schema reserves `kind: "measurement"`, but `propose` refuses to mint such
    a reference until value-type validation and exact measurement/evidence/
    episode/outcome ownership land together. Receipt existence alone does not
    make a measurement eligible.
11. **Evidence health remains inspectable and closed.** `CandidateView` and
    `ProposeOutcome` include an `EvidenceHealthView` whose status is exactly
    `ready`, `incomplete`, `invalid`, or `legacy_unbound`, plus typed
    diagnostics. The view reports constraints; it is not evidence, trust,
    review, authorization, or validation.
12. **The root export increase is deliberate.** `EvidenceRef`,
    `evidenceRefDigest`, `parseEvidenceRef`, `CandidateV1`, `CandidateV2`, and
    `EvidenceHealthView` join the root surface. Existing `Candidate`,
    `CandidateDigestInput`, `candidateContentDigest`, and `parseCandidate`
    remain the ordinary union API; no receipt lookup, sidecar, namespace, or
    evidence-resolution/minting helper becomes public.

## Consequences

- New successful proposals are v2 records with receipt-bound observation
  evidence; consumers must discriminate `candidate.schemaVersion` before
  accessing `evidenceIds` or `evidenceRefs`.
- The same source record committed under different registration, revision,
  page, episode, scope, or bytes produces a different reference and candidate
  digest. Ordering evidence differently also produces a different candidate
  digest.
- Re-proposing a v1 candidate is an attributed new governance action. It may
  preserve explicit lineage through `supersedes` and `originalDigest`, but it
  never copies reviews, approvals, or authority from the predecessor.
- Review invocation captures proposer, candidate, and reviewer bindings before
  the external callback, revalidates exact candidate bytes, lineage, and
  evidence afterward, and preflights occupied review ids. Governance reads
  re-check stored review key binding, structural validity, and independence;
  forged stored acceptances fail as corruption rather than becoming decisive.
- Conformance for #31b covers cross-source id collisions, distinct evidence
  and episode pages, corrupted derivative and receipt bindings, registry and
  source revision mismatches, unresolved or conflicting episode identity,
  scope mismatch, blocking source health, ordered-reference digest vectors,
  v1 byte stability, audit-only v1 reads, and explicit v1-to-v2 re-proposal.
- #31c must add the missing measurement ownership checks before enabling
  measurement evidence requests; it must not weaken the EvidenceRef binding or
  reinterpret already-stored candidates.

## 2026-08-20 derivation amendment

Decision 0010 retains nonempty evidence for manual Candidate v2 but permits an
empty list with an exact `derivationRef` only when store-backed governance
resolves a committed, current, evidence-health-ready nonempty episode
population. The ref id is exactly `insight-${digest}`. Existing Candidate bytes,
schema version, and digest inclusion remain unchanged.
