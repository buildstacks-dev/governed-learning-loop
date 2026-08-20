# 0008 — Semantic registry and detector execution facts

**Date:** 2026-08-20
**Status:** ratified — issue #30b1 registry and execution records

## Context

Decision 0007 made detector, pack, lens, and InsightDerivation semantics
immutable, content-addressed, and inert. Those records still did not say which
installed versions a particular loop selected, which normalized capabilities a
host granted to one exact source registration, or what immutable evidence
window one detector invocation considered.

The next contract slice needs those facts without exposing a public write path
that would let an adapter claim capabilities, invent a detector result, or
persist an execution outside a configured kernel runner. Registry selection is
availability, not authority. An execution record is an immutable receipt, not
proof that its detector was correctly implemented and not an authorization or
efficacy verdict.

## Rulings

1. **`SourceSemanticProfile` is an immutable host grant.** It binds one exact
   `sourceId` and `sourceRegistrationRevision` to an
   `observationVocabularyDigest`, sorted unique normalized `capabilities`,
   sorted unique normalized `observationKinds`, and `profileDigest`. An
   adapter cannot self-assign this record. A source without a configured
   profile contributes zero semantic capabilities to detector execution.
   Profile omission remains compatible with generic Observe ingest; when a
   profile is present, an observation whose normalized kind is absent from its
   `observationKinds` is rejected.
2. **`SemanticRegistryConfig` binds installation separately from selection.**
   It contains the complete immutable installed DetectorRegistration,
   DetectorPackManifest, LearningLensRegistration, and SourceSemanticProfile
   values plus exact selected detector, pack, and lens references. All
   collections are bounded, sorted, and unique. One logical id/version has one
   digest, and one source registration revision has one semantic profile.
3. **Registry references resolve exactly.** Every detector and lens uses the
   registry `scopePolicyDigest`; pack detector/lens refs and detector lens
   allowlists resolve to exact installed records. A pack cannot contain a
   deprecated detector, and a deprecated detector cannot be selected. Every
   selected detector and lens belongs to a selected pack. A selected
   `insight_derivation` detector and one compatible selected lens under its
   exact lens constraint co-occur in at least one exact selected pack;
   membership in separate packs is insufficient. Installing or selecting any
   record grants no trust, execution, review, publication, active-context,
   authorization, validation, or efficacy power.
4. **The loop snapshots the optional registry.** `createLearningLoop` parses
   and recursively freezes configured semantic values. It rejects a registry
   whose scope policy differs from the configured loop or whose source profile
   names an unconfigured source or a different source-registration revision.
   When present, only `{ registryDigest }` enters the loop registry identity;
   changing any bound semantic value changes the loop registry revision.
   Omitting `semanticRegistry` preserves the exact pre-#30b registry bytes. An
   explicitly configured empty registry is not equivalent to omission.
5. **`DetectorExecutionRecord` binds one exact invocation, window, and closed
   result.** Its detector ref adds exact configuration and implementation
   digests; its pack ref is required; its lens is required for
   `insight_derivation` and must be null for `evidence_health`. Scope,
   scope-policy, loop-registry, population, source profiles, evidence,
   evidence health, and capability facts are all content-bound.
6. **The evidence window is immutable and source-qualified.** Every source
   profile is complete and unique by source registration revision. The
   window's `availableCapabilities` is exactly the sorted set union of those
   profiles' capability lists; it is not a detector or adapter assertion.
   Every input EvidenceRef uses the execution's scope and loop registry and
   resolves to an exact window source profile. Every full input
   EvidenceHealthFinding names an exact window source registration. Evidence
   refs and findings remain distinct record families.
7. **Population identity binds immutable episode views.** For every population
   entry, `episodeViewDigest` is the digest of exact
   `{ episodeRecordId, episodeRecordDigest, episodeIdentityDigest,
   outcomeClaimDigest, scopeDigest }`. Every entry has the execution scope.
   Its durable `episodeRecordId` has the `<sourceId>/` prefix of one exact
   window source profile; #30b2 later revalidates the complete registration and
   episode-identity lineage before persistence or proposal use.
   `populationDigest` binds exact
   `{ episodes, normalizationPolicyDigest, comparabilityPolicyDigest }`, and
   `windowDigest` binds exact
   `{ sourceProfiles, population, evidenceRefs, evidenceHealthFindings,
   availableCapabilities }`. Population entries are ordered and unique by
   durable episode record id, episode identity digest, and view digest.
8. **Execution results use one closed status family.** The only statuses are
   `applied`, `not_applicable`, and `incomplete`; `pass` does not exist. An
   applied result carries `conditionDetected`, sorted unique derivation refs,
   and full output EvidenceHealthFinding values. A negative applied condition
   carries no outputs. A detected insight condition carries one or more
   derivation refs and no health outputs; a detected evidence-health condition
   carries one or more full health findings and no derivation refs.
   Non-applied results carry nonempty sorted unique `reasonCodes` plus sorted
   unique `missingCapabilities`, and a capability cannot be both available and
   missing. Missing capability is never zero and never pass.
9. **Execution key identity excludes only the result.**
   `executionKeyDigest` binds the complete invocation and immutable window but
   excludes schema, id, result, key digest, and execution digest. The record id
   is exactly `detector-execution-${executionKeyDigest}`.
   `executionDigest` additionally binds the closed result and the key digest,
   excluding only schema, id, and itself. Thus the same invocation/window with
   a different result has the same record id and a different execution digest;
   later create-only persistence must treat that as a conflict, never two
   valid attempts under one key.
10. **Execution records do not imply executable pairing.** The public parser
    and digest helpers let strict consumers validate transported facts, but
    #30b1 adds no façade method that accepts or stores a caller-supplied
    execution. Callable detector implementations must be paired with exact
    registered implementation digests inside the kernel. Kernel-controlled
    persistence, bounded derivation/execution queries, and Candidate derivation
    resolution remain #30b2/#30c work. Arbitrary public execution minting is
    forbidden.
11. **An execution fact is inert.** `conditionDetected: true` says only that a
    configured detector reported its registered condition over the bound
    window. It does not establish harm, cause, candidate utility,
    authorization, exposure, or validated improvement. Only the verified
    `propose` path may later resolve an eligible InsightDerivation into an
    inert Candidate.
12. **The public-surface increase is deliberate.** #30b1 adds exactly eleven
    root symbols: `SourceSemanticProfile`, `sourceSemanticProfileDigest`,
    `parseSourceSemanticProfile`, `SemanticRegistryConfig`,
    `semanticRegistryDigest`, `parseSemanticRegistryConfig`,
    `DetectorExecutionStatus`, `DetectorExecutionRecord`,
    `detectorExecutionKeyDigest`, `detectorExecutionDigest`, and
    `parseDetectorExecutionRecord`. The root snapshot therefore contains 133
    symbols. Callable detector ports, persistence inputs, execution views, and
    orchestration internals remain private or deferred.

## Digest inclusion

| Record or identity | Included | Excluded |
| --- | --- | --- |
| `SourceSemanticProfile.profileDigest` | Source id, exact source-registration revision, observation-vocabulary digest, capabilities, and observation kinds | `schemaVersion`, `profileDigest` |
| `SemanticRegistryConfig.registryDigest` | Scope-policy digest; full installed detector, pack, lens, and source-profile records; exact selected detector, pack, and lens refs | `schemaVersion`, `registryDigest` |
| `DetectorExecutionRecord.executionKeyDigest` | Loop-registry revision, detector plus configuration/implementation digests, required pack, output-dependent lens, scope and scope-policy facts, output kind, and complete immutable window | `schemaVersion`, `id`, `result`, `executionKeyDigest`, `executionDigest` |
| `DetectorExecutionRecord.executionDigest` | Everything in the execution key, the closed result, and `executionKeyDigest` | `schemaVersion`, `id`, `executionDigest` |

Set-like collections are sorted and unique. Evidence refs and population
episodes preserve declared order while remaining duplicate-free. Both input
and output evidence-health arrays carry full self-digested records, never bare
ids or asserted effects.

## Migration and sequencing consequences

- Existing record, receipt, Candidate, outcome, and loop-registry bytes remain
  unchanged when `semanticRegistry` is omitted. Configuring it intentionally
  creates a new registry revision and invalidates cursors bound to the old
  revision.
- Sources may continue generic ingest without a profile for compatibility, but
  they contribute no detector capability grant. Adding or changing a profile
  creates a new semantic registry digest and loop registry revision.
- No existing detector, pack, lens, InsightDerivation, or Candidate is
  rewritten. Historical records remain bound to their original versions and
  digests.
- **Implemented in #30b1:** source semantic profiles, immutable installed and
  selected registry configuration, loop/source-revision validation,
  profiled-observation-kind enforcement, DetectorExecutionRecord parsing and
  canonical identities, and the eleven explicit root exports.
- **Deferred to #30b2/#30c:** exact callable implementation pairing,
  kernel-only execution persistence, bounded derivation/execution views and
  queries, exact population registration/identity revalidation, Candidate
  derivation resolution, eligibility/capability checks, population folds, pack
  selection, recurrence, suppression, caps, dry-run output, and
  no-provider-on-empty execution.
- **Deferred to #30d:** core structural and opt-in reference pack contents and
  synthetic host consumers. **#13** owns optional semantic-provider workflows;
  **#26** owns held-out candidate-utility calibration. None is implied by this
  record slice.

## 2026-08-20 implementation amendment

Decision 0009 implements the kernel-private receipt-last persistence and
scope-partitioned typed audit reads previously deferred to #30b2a. Decision
0010 implements Candidate derivation resolution and independent review.
Callable detector execution remains #30c.
