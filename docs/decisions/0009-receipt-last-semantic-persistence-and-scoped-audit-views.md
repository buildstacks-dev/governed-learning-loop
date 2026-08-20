# 0009 — Receipt-last semantic persistence and scoped audit views

**Date:** 2026-08-20
**Status:** ratified — issue #30b2a persistence and public reads

## Context

Decisions 0007 and 0008 established immutable semantic registrations,
InsightDerivation, configured selection, source capability grants, and the
DetectorExecutionRecord. A parser still did not make an execution a durable
kernel fact. The library needed crash-safe persistence, historical registry
validation, and bounded public reads without exposing a method through which a
caller or adapter could mint an execution result.

Semantic facts also have three independent health dimensions: whether the
receipt graph committed, whether its registry is selected by the current loop,
and whether its evidence remains usable now. Collapsing those dimensions would
hide abandoned attempts, strengthen historical records, or mistake evidence
failure for an absent execution.

## Rulings

1. **Persistence remains engine-private.** The internal
   `persistDetectorExecution(context, execution, derivations)` parses both
   inputs from `unknown`, but no `LearningLoop` method, public input type, or
   root export delegates to it. Public execution parsers validate transported
   bytes; they grant no store or detector authority. #30c callable detector
   orchestration is the intended writer.
2. **Historical configuration is durable.** A private
   `SemanticRegistrySnapshot` stores one exact loop-registry revision and the
   full SemanticRegistryConfig under that revision. `snapshotDigest` binds
   both. Historical reads validate against this durable snapshot rather than
   current in-memory registration or an adapter claim.
3. **Derivation/execution provenance is append-only.** A private
   `DerivationExecutionLink` binds derivation id/digest/scope, execution
   id/key/full digest, loop-registry revision, semantic-registry digest, and
   `linkDigest`. The append-stream key is the derivation id; entry id is exactly
   `execution:${executionId}:${executionDigest}`. Different execution results
   therefore remain distinct abandoned attempts and cannot alias the winner.
4. **The execution receipt is last.** After stable read-only validation, the
   kernel creates the registry snapshot, persists result health findings,
   appends provenance-bearing links, creates derivations and their exact-scope
   indexes, creates the execution scope index, and creates the
   DetectorExecutionRecord last. It then reloads the exact graph. Link-first
   order ensures every persisted derivation has registry provenance; an index
   is never authoritative without its exact target. A crash before a scope
   index is invisible to public reads; a derivation indexed before its missing
   execution receipt is audit-visible as orphaned and repaired by exact retry.
   Same-byte retries are idempotent. A same-key/different-result receipt is a
   conflict. Partial records are retained for audit rather than deleted.
5. **Commit binding is explicit.** An InsightDerivation view is `committed`
   when at least one exact link resolves an exact execution receipt that names
   it, `orphaned` when only missing or losing execution attempts remain, and
   `invalid` when an exact reciprocal graph is inconsistent. A committed view
   exposes sorted exact execution refs including registry provenance. An
   execution view is `committed` or `invalid`; it has no orphaned state because
   the execution record is the receipt. Malformed bytes, key/id mismatch, or
   self-digest corruption fail as store corruption rather than a typed view.
6. **Registry binding is independent.** `configured` means at least one exact
   committed execution uses the current selected registry. Otherwise the fact
   is `historical_unconfigured` with diagnostics. A historical fact stays
   readable and may retain several exact execution refs across registry
   revisions, but it gains no current authority.
7. **Evidence health is current and separate.** Both public views carry the
   existing EvidenceHealthView. Current durable records, receipts, episode
   identity, outcome lineage, source health, and qualified measurement support
   are revalidated. Historical registry integrity never upgrades missing,
   incomplete, invalid, or legacy-unbound evidence. Commit, registry, and
   evidence-health states are never inferred from one another.
8. **Prewrite validation is cross-record and fail-closed.** Persistence
   requires the current selected detector/pack/lens graph, exact configuration
   and implementation digests, scope policies and constraints, exact source
   profiles and vocabulary, detector population policies and capabilities,
   reloaded episode views, exact EvidenceRefs and health findings, reciprocal
   result outputs, and derivations whose scope, detector, pack, lens,
   population, evidence, producer, destination, and validation policy match
   the execution and lens. Supersession resolves an exact same-scope predecessor
   with a committed reciprocal execution. Historical qualified measurements
   revalidate every ordered supporting observation and receipt. Applied
   execution with invalid input evidence is refused.
9. **Episode is a first-class lens evidence kind.** LearningLensRegistration
   evidence requirements accept `observation`, `measurement`, or `episode`.
   An episode requirement needs a nonempty exact derivation population. Its
   minimum trust and completeness are checked against the digested, reloaded
   EpisodeIdentityRecord. This additive parser widening changes no existing
   observation/measurement lens bytes or digests.
10. **Every semantic read requires exact scope.** InsightDerivationQuery,
    DetectorExecutionQuery, `getInsightDerivation`, and
    `getDetectorExecution` require a Scope. A wrong-scope direct get returns
    undefined, indistinguishable from absence. Reads first resolve a private
    index in namespace `learning-semantic-scope-${scopeDigest}` with fixed
    `insight-derivation-index` and `detector-execution-index` kinds; neither
    primary pagination nor a direct get touches another scope's target records.
    Query cursors bind normalized filters, exact scope, current loop registry,
    query kind, scope-local store cursor, and cursor-scope digest.
    `conditionDetected` matches only applied executions; non-applied is never
    treated as false.
11. **Partial state remains auditable.** Derivation queries can filter and
    return `committed`, `orphaned`, and `invalid` bindings. Execution queries
    return committed or invalid receipts. Hiding crash and losing-result state
    would make retry and concurrency history unauditable; exposing it never
    makes it eligible for proposal.
12. **Semantic pages use a composite snapshot.** The kernel digests a fixed,
    deterministically ordered revision tuple over semantic snapshots,
    derivations, links, executions, exact-scope indexes,
    observations, measurements, episodes, identity/outcome streams, source
    revisions and receipts, evidence health, and derivative ownership. It
    assembles a whole page or get between equal before/after tuples, retries at
    most three times, then fails with `query.snapshot_changed`. That global
    tuple is internal only. A public semantic page `snapshotRevision` digests
    its exact scope-index page revision plus its canonical returned same-scope
    views; an empty page reveals only the scope-local index revision. Each later
    page remains append-visible and is not a frozen detector, calibration, or
    experiment population.
13. **The public-surface increase is four types.** #30b2a adds exactly
    InsightDerivationQuery, InsightDerivationView, DetectorExecutionQuery, and
    DetectorExecutionView, taking the root snapshot to 137 symbols. The four
    LearningLoop read methods add no standalone symbol. Private graph records,
    parsers, persistence helpers, and validation folds remain unexported.

## Private digest inclusion

| Record | Included | Excluded |
| --- | --- | --- |
| `SemanticRegistrySnapshot.snapshotDigest` | Exact loop-registry revision and full SemanticRegistryConfig | `schemaVersion`, `snapshotDigest` |
| `DerivationExecutionLink.linkDigest` | Derivation id/digest/scope, execution id/key/full digest, loop-registry revision, and semantic-registry digest | `schemaVersion`, `linkDigest` |
| Derivation link stream entry digest | Full DerivationExecutionLink value, including schema and its verified link digest | Nothing |
| Exact-scope index `indexDigest` | Fixed index kind, exact target id/digest, and scope digest | `schemaVersion`, `indexDigest` |

These private identities add no public canonicalization API.

## Migration and sequencing consequences

- Existing semantic and lifecycle record bytes are unchanged. Registry
  snapshots, derivations, links, exact-scope indexes, and execution receipts
  are additive private store records.
- Existing externally parsed #30a/#30b1 records are not auto-committed or
  migrated. Only the private receipt-last path creates an eligible graph.
- A derivation is not Candidate-eligible merely because it is readable. #30b2b
  must require committed, configured, evidence-health-ready lineage and bind
  the exact derivation ref through verified `propose`.
- #30c owns callable detector pairing, windows, eligibility, caps,
  deduplication, suppression, dry-run execution, and no-provider-on-empty
  behavior. #13 owns optional semantic-provider generation. #26 owns
  candidate-utility calibration and any quality claim.
