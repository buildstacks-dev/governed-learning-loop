# 0014 — Registered detector-orchestration policy

**Date:** 2026-08-20
**Status:** ratified — issue #30c2b2-policy

## Context

Decisions 0012 and 0013 provide fixed protocol safety ceilings, bounded pack
fan-out, and privacy-treated recurrence lineage. Hosts still cannot lower the
pack invocation or grouped-result limits through immutable configuration.
Future Candidate deduplication and rejection suppression also need an exact
policy identity, but their durable claims, pack receipts, and admission state
machine are not yet safe to land in the same slice.

This decision registers the complete policy bytes now while making only the
bounded, transient behavior executable. Merely parsing a future suppression
rule must not be presented as enforcement.

## Rulings

1. **DetectorOrchestrationPolicy is immutable host configuration.** Schema
   version 1 binds a canonical id, SemVer version, exact caps, exact rejection
   suppression configuration, and policyDigest. It is host configuration—not
   detector output, pack authority, a Candidate decision, or a schedule.
2. **Caps can only tighten protocol ceilings.** Exact fields and ranges are:

   ```text
   maximumInvocationsPerRun:          integer 1..100
   maximumInsightGroupsPerRun:        integer 0..100
   maximumEvidenceHealthGroupsPerRun: integer 0..100
   ```

   The c2a hard limits on considered selections, output records, result bytes,
   episode ids, and detector-window bytes remain unchanged. Policy cannot raise
   any kernel limit.
3. **Suppression configuration is registered but inert.** The closed value is
   either `{ mode: "disabled" }` or
   `{ mode: "evidence_multiplier", minimumDistinctEpisodeMultiplier }`, where
   the multiplier is an integer from 2 through 100. Both branches are parsed
   and digested. Neither branch currently reads Candidate/review state,
   deduplicates, suppresses, refuses a proposal, or authorizes an override.
   Enforcement requires the deferred receipt and Candidate-claim slices.
4. **The policy digest binds exact content.**
   `detectorOrchestrationPolicyDigest` hashes exact canonical
   `{ id, version, caps, rejectionSuppression }`. It excludes schemaVersion and
   policyDigest. Unknown-first parsing recomputes the digest and rejects unsafe
   integers, invalid SemVer, closed-value mismatch, and corrupt bytes.
5. **Configuration is optional and snapshotted.** LearningLoopConfig adds
   optional `detectorOrchestrationPolicy`. Construction parses and deeply
   freezes it once. Omission preserves the c2b1 loop-registry bytes and pack
   result shape. Presence contributes exact `{ policyDigest }` to the loop
   registry revision, so policy changes intentionally invalidate registry-bound
   cursors and produce new child execution lineage.
6. **Invocation caps prevent later callbacks.** When configured,
   maximumInvocationsPerRun replaces c2a's admission ceiling of 100 with the
   lower exact value. Every later runnable detector/lens item remains visible
   as the ordinary `capped` orchestration disposition with no callback.
   Non-runnable selections do not consume an invocation.
7. **Group caps are transient classifications.** A policy-configured pack
   result item adds optional recurrenceDisposition:
   `not_grouped | unassessed | capped`. Non-grouped recurrence states report
   `not_grouped`. Exact grouped insight and evidence-health results use separate
   counters in stable pack-item order; each unique group-key digest consumes
   its family counter once. A group inside its family cap is `unassessed`; a
   group beyond it is `capped`.
8. **Transient group caps do not suppress durable facts.** An unassessed or
   recurrence-capped item still retains its exact DetectorRunResult. Commit
   still uses c2b1 private receipt-last child persistence, including recurrence
   decision/member lineage. `capped` here marks bounded pack reporting and
   makes overall pack status partial; it does not delete, truncate, reject, or
   suppress the underlying execution, derivation, or evidence-health finding.
   A recurrence-capped item adds the static warning diagnostic
   `detector.pack_group_capped`; messages carry no evidence content.
9. **Evidence-health and behavioral denominators remain separate.** Insight
   groups and evidence-health groups have independent caps and counters. No
   evidence-health group becomes a behavioral Candidate or silently consumes
   the insight-group denominator.
10. **Omission has two exact meanings.** Without a configured policy,
    recurrenceDisposition is omitted and c2b1 pack behavior is unchanged.
    With a policy, the field is present only when an exact retained
    DetectorRunResult supplies a recurrence state. A capped/refused item with
    no retained result omits the field because grouping is unknown; it must not
    be mislabeled `not_grouped`. `not_grouped` is reserved for an exact retained
    non-grouped result. No public result claims that an unassessed group is
    available, useful, harmful, suppressed, or improved.
11. **The public-surface increase is three symbols.** This slice exports
    DetectorOrchestrationPolicy, detectorOrchestrationPolicyDigest, and
    parseDetectorOrchestrationPolicy. DetectorPackRunResult changes under its
    existing symbol. The root snapshot increases from 147 to 150.

## Executable and deferred behavior

| Policy content | Implemented now | Explicitly not implemented |
| --- | --- | --- |
| maximumInvocationsPerRun | Lower callback/admission ceiling | Scheduling, frequency or cost budgets |
| maximumInsightGroupsPerRun | Transient `unassessed`/`capped` classification | Candidate deduplication or admission |
| maximumEvidenceHealthGroupsPerRun | Separate transient classification | Behavioral Candidate routing |
| rejectionSuppression.disabled | Parsed and digested | A claim that no other governance rule applies |
| rejectionSuppression.evidence_multiplier | Parsed and digested only | Review lookup, suppression, override or proposal refusal |

## Deferred C2b2 slices

**Implemented in this policy slice:** immutable policy record/digest/parser,
optional loop binding, lower invocation admission, separate transient grouped
result caps, and explicit `not_grouped | unassessed | capped` reporting.

**Implemented next by decision 0015:** DetectorPackRunReceipt, exact pack-run
key/full digests, receipt-last exact-scope persistence/query/view, immutable
not-assessed governance-snapshot lineage, and historical/current view
separation.

**Implemented next by decision 0016:** kernel-derived private
derivation/Candidate recurrence claims, exact frozen proposal populations and
historical-unbound Candidate views. These claims remain observational.

**Implemented next by decision 0017:** exact active-frontier Candidate/review
assessment and observational available/deduplicated/suppressed receipt states,
including checked evidence-multiplier thresholds.

**Deferred to the Candidate-admission slice:** enforced deduplication,
decisive-rejection suppression, evidence-multiplier override admission,
enforced same-group supersession, and concurrent proposal refusal. That slice
must not infer claims for historical/manual/unbound Candidates.

Reference detector contents remain #30d. Optional semantic/model workflows
remain #13. Candidate-utility calibration and every quality or improvement
claim remain #26. Scheduling, provider routing, cost/time budgets,
publication, authorization, exposure, and activation remain outside this
policy.

## Migration consequences

- Existing detector, execution, recurrence, derivation, Candidate, review, and
  source/evidence bytes are unchanged. This slice adds no durable store kind.
- Omitting detectorOrchestrationPolicy preserves prior registry bytes and
  omits recurrenceDisposition from pack results.
- Configuring or changing the policy creates a new loop-registry revision;
  historical executions and recurrence groups remain bound to their exact
  prior revisions and are never relabeled.
- Registered rejectionSuppression bytes remain non-enforcing after decision
  0017 lands observational assessment; a separate decision must land proposal
  controls.
- No public pack receipt, query, writer, Candidate mutation, provider SDK,
  destination, activation path, or efficacy metric is added.
