# 0004 — Durable source-page receipts and evidence health

**Date:** 2026-08-19
**Status:** ratified — issue #31a integrity substrate

## Context

The first Observe implementation returned an ephemeral `IngestReceipt` and
stamped provenance on accepted derivatives, but it did not durably record what
the source said about each page. A multi-page ingest retained only the final
`sourceRevision`; missing, unreadable, unsupported, and corrupt sources had no
closed durable representation; diagnostic message bodies were the only place
some source-health facts survived; and a crash could leave derivatives with no
commit marker tying them to the exact source registration and content policy.

Registered detectors and semantic derivations must be able to distinguish a
healthy empty page from unavailable evidence. They also need exact revision,
configuration, derivative, and diagnostic lineage without persisting raw
source content or adapter-authored prose. These are evidence-health facts, not
behavioral learning candidates.

This decision is the first bounded slice of issue #31. It deliberately does
not ratify collision-safe candidate evidence references, a Candidate schema
migration, or measurement/outcome ownership rules.

## Rulings

1. **Every evidence page identifies its source and state explicitly.**
   `EvidencePage` requires bounded, control-free `sourceRef` and `pageRef`
   values plus a closed `state` union. `available` carries an exact
   `sourceRevision` and page completeness. `missing`, `unreadable`,
   `unsupported`, and `corrupt` may carry an `observedRevision` only when the
   adapter could authenticate bytes despite being unable to project them. A
   non-available page carries no derivatives. Empty arrays on an available
   complete page mean observed emptiness; they never stand for unavailable
   evidence.
2. **Source identity and revision values are already privacy-treated.**
   Adapters emit only public-safe values or tenant-scoped, domain-separated
   keyed locators. Raw paths, transcript identifiers, source bytes, diagnostic
   messages, and private low-entropy values do not enter durable records,
   receipts, or portable unsalted digests. The reference transcript adapters
   therefore key source, revision, session, project, and branch identities
   independently. The kernel treats these values as opaque identity, not
   authority.
3. **A `SourcePageReceipt` is the page commit marker.** Its `receiptDigest`
   binds exactly the source id and registration revision, adapter version,
   content-policy id and digest, loop registry revision, source/page
   references, page state, ordered derivative `(kind, id, digest)` tuples,
   projection counts (including rejected projections), normalized diagnostic
   `(code, severity, count)` tuples, and evidence-health finding ids.
   `schemaVersion`, `id`, and `receiptDigest` are excluded. The id is
   deterministically derived from `receiptDigest`. Diagnostic tuples are
   sorted, unique, and positive-count; no message, path, or arbitrary details
   are durable.
4. **Receipt-last persistence defines commitment.** The engine validates and
   persists accepted derivatives, then evidence-health findings, then the
   `SourcePageReceipt`. A page without its valid receipt is incomplete even if
   derivative records exist. Create-only persistence and deterministic ids let
   an explicit re-ingest finish the same page after an interrupted write.
5. **Evidence health is a separate closed record family.** An
   `EvidenceHealthFinding` uses only the closed codes `source.missing`,
   `source.unreadable`, `source.unsupported`, `source.corrupt`,
   `source.partial`, `source.revision_changed`, `source.record_rejected`,
   `source.content_policy_refused`, and `source.adapter_diagnostic`, and only
   the closed effects `limits_claims`, `blocks_audit`, and `blocks_use`. Its
   `findingDigest` binds code, effect, source registration and page identity,
   completeness, and affected-record count. It contains no free-form message
   or raw details and is never silently included in a behavioral candidate
   denominator.
6. **Revision claims are append-only and fail closed.** The first authenticated
   `(source registration revision, sourceRef, pageRef, revision)` claim is
   immutable whether it arrived as an available `sourceRevision` or an
   unavailable `observedRevision`. Repeating it is idempotent. A second
   distinct revision for the same source/page identity is not assumed to be an
   intentional update: the engine records `source.revision_changed`, emits a
   receipt with no committed derivatives from that claim, and refuses those
   derivatives. Explicit supersession and deletion lineage remains later
   issue #31 work.
7. **An `ImportReceipt` is durable and deterministic.** Its `receiptDigest`
   binds the source registration revision, loop registry revision, ordered
   page receipt ids, exact distinct source revisions, worst aggregate
   completeness, and evidence-health finding ids. The referenced content-
   addressed page receipts transitively bind adapter and content-policy
   registration, derivative tuples, projection counts, and normalized
   diagnostics. The import stores no clock time or random operation id.
   Re-ingesting identical committed pages under the same registrations
   produces the same import receipt id and bytes.
8. **The immediate ingest result points at durable truth.** `IngestReceipt`
   removes the misleading singular `sourceRevision` and adds exact
   `sourceRevisions`, ordered `pageReceiptIds`, and the parsed durable
   `importReceipt`; its `id` is that durable import receipt's id, not a fresh
   attempt id. Its net-new derivative ids, completeness, and sanitized
   transient diagnostics describe the same committed pages but are not added
   to the durable import bytes. An unavailable import therefore remains a
   typed, non-zero source-health result rather than an empty successful import.
9. **Receipt reads are typed and bounded.** The façade adds bounded
   `querySourcePageReceipts`, `queryEvidenceHealthFindings`, and exact
   `getImportReceipt` reads. They preserve the typed-query cursor, filter,
   snapshot-revision, closed-key, and resource-ceiling rules from decision
   0002 and never expose engine namespaces or record kinds.
10. **Candidate and measurement integrity remain separate slices.** Candidate
    schema v2, collision-safe evidence references, exact candidate/episode
    scope ownership, review invalidation, measurement value-type validation,
    and measurement/outcome/evidence ownership are explicitly deferred to
    #31b and #31c. Issue #31 remains open, and issue #30 must consume rather
    than duplicate the completed integrity substrate.

## Consequences

- `EvidencePage` is an adapter contract break: every adapter must deliberately
  report source/page identity and availability instead of relying on empty
  arrays or a sentinel revision.
- The transcript adapter `0.2.0` migration also replaces raw session/project/
  branch identities and portable source hashes with tenant-keyed identities,
  and declares an immutable advisory trust maximum. `0.1.1` state remains
  read-only audit history; it must not be re-ingested in place. Use a fresh
  state until a separately ratified versioned migration exists.
- `SourcePageReceipt`, `ImportReceipt`, `EvidenceHealthFinding`, their three
  parsers, and the two query inputs are deliberate root exports. The three
  façade reads add no store-level escape hatch.
- Durable receipt and health parsers accept `unknown`, recompute bound digests,
  enforce closed codes/states/effects and normalized tuple invariants, and
  reject inconsistent counts or foreign derivative tuples as typed corruption.
- Source-page and import receipts are audit records, not trust grants,
  publication authority, detector results, candidates, or efficacy evidence.
- Conformance for this slice covers every source state, multi-page and
  multi-revision imports, interruption before the commit marker, deterministic
  retry, second-revision refusal, normalized diagnostic counts, store
  corruption, bounded queries, and privacy canaries.
