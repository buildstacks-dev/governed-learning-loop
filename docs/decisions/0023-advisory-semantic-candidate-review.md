# 0023 — Advisory semantic review of an exact Candidate

**Date:** 2026-08-20
**Status:** ratified — issue #13c advisory review through the `/workflows` bundle

## Context

Decision 0021 reserved the `advisory_review` lane as a non-dispatchable
scaffold, and Decision 0022 ruled that #13c may extend `SemanticWorkflowBundle`
with advisory-review methods without new public symbols. The advisory lane must
let a model read one exact inert Candidate and return an attributed,
uncalibrated opinion — without creating a decisive `CandidateReview`, without
persisting provider prose, without a second semantic graph, and without turning
"a model answered" into admission, publication, or quality evidence. Kernel
invariant 2 (attributed, independent generation and review) must hold at this
boundary even though the assessment is not decisive.

## Rulings

1. **The public surface still names exactly two symbols.** `/workflows` exports
   only `SemanticWorkflowBundle` and `createSemanticWorkflowBundle`. The frozen
   factory gains `defineAdvisoryReview(...)` and `advisoryReviewResultSchema`
   as typed statics beside the #13b generation statics; per Decision 0022
   ruling 1 these are not new exports and the all-entrypoint snapshot remains
   158. The bundle gains `prepareAdvisoryReview`, `authorizeAdvisoryReview`,
   `runAdvisoryReview`, and `recoverAdvisoryReview`. One bundle serves one
   lane: generation methods on an advisory bundle, and advisory methods on a
   generation bundle, refuse with `semantic.workflow_lane_unavailable`.
2. **An advisory definition is the generation definition with an inverted
   calibration posture.** `defineAdvisoryReview` fixes lane `advisory_review`,
   calibration exactly `{ status: "unverified", calibrationId: null,
   calibrationDigest: null }`, maximum attempts one, tool mode `none`, and the
   fixed `cormidia.semantic-advisory-review-result` schema. The bundle factory
   verifies the loop-verified **reviewer** principal against the definition the
   same way #13b verifies the producer. No detector, pack, lens, or
   `workflowDefinitionDigest` detector binding participates: the advisory
   subject is a Candidate, not a window.
3. **The subject is located scope-first through a create-only membership
   index.** `propose` and recurrence admission persist a
   `CandidateScopeMembership` projection (scope-digest namespace, candidate id,
   exact content digest) immediately before the Candidate receipt.
   `prepareAdvisoryReview` consults only that scope namespace before any global
   record: an unknown, wrong-scope, or digest-mismatched subject returns one
   indistinguishable `workflow.candidate_unavailable` incomplete result without
   probing the global candidate kind — no foreign-scope oracle. The index is a
   pure locator: historical Candidates are never bulk-backfilled (an exact
   idempotent admission retry may converge one), a Candidate without membership
   is simply not an advisory subject, and a pre-#13c admission terminal without
   membership is legitimate history, not corruption.
4. **The subject graph is immutable under the read.** Every consulted fact —
   candidate bytes, content lock, recurrence decision, derivation, admission
   binding, membership — is create-only and durably precedes the Candidate
   receipt, so subject resolution needs no snapshot-retry loop. Candidate v1
   subjects are refused (`workflow.candidate_legacy_unbound`); invalid
   derivation or admission lineage refuses with a closed diagnostic rather
   than reviewing a corrupt subject.
5. **Reviewer independence is enforced before any write, twice.** The
   definition principal must not be the candidate's proposer; under the
   effective risk policy's `independentDomain` rule it must not share the
   proposer's independence domain; and for a derivation-backed subject it must
   not be the derivation producer, share the producer's independence domain,
   or reuse the producer's implementation id and version
   (`semantic.workflow_reviewer_not_independent`). The same check runs in both
   pre-dispatch revalidations.
6. **The kernel owns the advisory envelope.** Preparation renders
   `{ subject, definitionDigest }` through the registered synchronous renderer
   and minimizer, then canonicalizes one schema-versioned envelope of
   definition identity, prompt binding, minimized host instructions, and the
   complete kernel-materialized subject: exact candidate bytes, full derivation
   bytes or null, the closed admission projection, and the evidence-set digest
   over the candidate's sorted evidence-reference digests. Byte and token
   budgets, the tenant-keyed digest, and the single token estimate follow #13b
   exactly. Preparation writes nothing and calls no provider or authority.
7. **One advisory review key owns one exact prepared request.** The key digests
   candidate id, candidate content digest, definition digest, and scope digest.
   A create-only `SemanticAdvisoryReviewPlanLock` serializes it, and a
   scope-and-definition-private `SemanticAdvisoryAttemptIndex`
   (`semantic-workflow-advisory-attempt-<reviewKey>`) binds the safe public
   attempt id to the exact reservation and plan lock. Same bytes converge; a
   different render for an owned key conflicts before a second callback.
8. **Dispatch order and transport rules are #13b's.** Durable order is
   reservation, advisory plan lock, outbound authorization iff outbound,
   attempt index, second subject/policy revalidation, then one create-only
   dispatch claim; only a newly created claim permits one immediate provider
   callback. The #13a claim-time advisory refusal is replaced by the lane's
   current checks: exact current loop and semantic registry plus current
   source ownership/content policies at the claim, and the async subject facts
   in the bundle's twice-run revalidation. Advisory source policies are the
   policies of every source cited by the candidate's and derivation's evidence
   references; the set may be empty for content that is not source-derived,
   and outbound transport still requires explicit-receipt policies throughout.
9. **Provider statement prose never becomes durable bytes.** The fixed result
   schema admits `{ advisoryRecommendation: support | revise | oppose |
   escalate, findings: [{ code, severity, statement }] (≤100) }`; a `support`
   recommendation with a blocking finding is invalid. The kernel measures the
   response exactly as #13b does, then digests each finding statement with the
   registered tenant-keyed digester and retains only
   `statementKeyedDigest` and the exact `statementByteLength`. The durable
   normalized result is that digested projection; raw statements, raw response
   bytes, request bytes, and provider-native receipts never persist.
10. **The assessment is a workflow-private audit fact.** A completed run mints
    one content-addressed `SemanticAdvisoryAssessment`
    (`semantic-review-assessment-<digest>`) binding qualification
    `advisory_uncalibrated`, the exact candidate id/digest and scope, the
    digested findings, subject-snapshot/evidence-set/admission-lineage digests,
    the derivation reference or null, the closed admission projection, and the
    definition's full reviewer attribution with calibration absent by
    construction. It is not a `CandidateReview`, never enters the
    candidate-review index or governance view, does not touch the
    DetectorExecution/InsightDerivation graph, and grants no admission,
    publication, activation, validation, authority, utility, efficacy, or
    calibration claim. `CandidateView` governance is byte-identical before and
    after an assessment.
11. **Completion is intent-first and receipt-last.** The first awaited write
    after synchronous response validation and statement digestion is the
    `SemanticAdvisoryCompletionIntent` (result binding plus assessment,
    reciprocity-checked). Then result binding, assessment record, the general
    scope turn index, and the scope-and-definition-private terminal receipt
    last, whose output binds the exact assessment id and digest. Noncompleted
    results commit through the shared #13a noncompleted path with lane
    `advisory_review`.
12. **Recovery is attempt-index-first and never a second call.**
    `recoverAdvisoryReview({ attemptId, scope })` consults the
    scope-and-definition advisory attempt namespace before global facts,
    invokes no renderer, minimizer, estimator, digester, authority, or
    provider, ignores current expiry only to forward-complete a durable intent
    or noncompleted result, and returns existing terminals with their
    assessment views. No attempt returns `not_dispatched`; dispatch without a
    known fact returns `outcome_unknown` with `persistence: "dispatch_only"`,
    permanently.
13. **Turn reads are lane-aware and stay scope-and-definition private.** An
    advisory bundle's `getTurn`/`queryTurns` load only advisory terminals in
    its definition-local namespace, resolve the assessment through the exact
    typed graph, and reuse the #13b cursor binding (scope, definition, registry
    revision, query-cursor scope); advisory turns count one child reference
    against the shared 64 MiB / 5,000-reference work ceiling. A generation
    bundle on the same loop and scope sees no advisory turn and rejects
    advisory cursors.
14. **The WIP surface was corrected, not extended.** The draft turn-view
    `derivationRef.derivationViewDigest` was replaced by the target's stable
    `scopeDigest` (view digests are time-varying and cannot be bound), and the
    draft admission-recovery membership check was relaxed to treat a missing
    membership on a pre-index terminal as history while still refusing any
    mismatched membership.

## Private record and digest matrix

| Private record | Exact role | Identity/digest rule |
| --- | --- | --- |
| `CandidateScopeMembership` | Scope-private create-only Candidate locator | scope-digest namespace, id = candidate id, `indexDigest` under `candidate-scope-membership:v1` |
| `SemanticAdvisoryReviewPlanLock` | One exact prepared request per review key | id `semantic-workflow-advisory-plan-<reviewKey>` under `semantic-workflow-advisory-plan-lock:v1` |
| `SemanticAdvisoryAttemptIndex` | Scope-and-definition-private attempt locator | id `semantic-workflow-advisory-attempt-<reviewKey>` under `semantic-workflow-advisory-attempt-index:v1` |
| `SemanticAdvisoryCompletionIntent` | First-awaited-write forward-completion fact | id `semantic-workflow-advisory-completion-<reviewKey>` under `semantic-workflow-advisory-completion-intent:v1` |
| `SemanticAdvisoryAssessment` | Content-addressed advisory_uncalibrated opinion | id `semantic-review-assessment-<assessmentDigest>` under `semantic-workflow-advisory-assessment:v1` |

The review key digests `{candidateId, candidateDigest, definitionDigest,
scopeDigest}` under `semantic-workflow-advisory-review-key:v1`; subject
snapshot, evidence set, and admission lineage digests are separately
domain-separated.

## Public method summary

| Method | Effect boundary | Durable outcome |
| --- | --- | --- |
| `prepareAdvisoryReview` | no writes, authority call, or provider call | opaque plan, safe attempt id, exact preview; or closed subject-unavailable incomplete |
| `authorizeAdvisoryReview` | host disclosure-authority callback only | opaque plan-bound authorization; persistence waits for run |
| `runAdvisoryReview` | at most one provider callback after durable dispatch | committed/existing terminal with assessment, or dispatch-only ambiguity |
| `recoverAdvisoryReview` | no provider or authority callback | forward-completed known facts, existing terminal, `not_dispatched`, or `outcome_unknown` |

## Validation evidence

#13c supplies L1 contract, schema, digest, and public-surface controls plus L2
deterministic hermetic callback/store controls. They cover the factory statics
and bundle key surface, cross-lane refusals, advisory definition/calibration
posture, draft and assessment parsing with tamper and accessor attacks,
digest-domain goldens, statement-privacy canaries over every stored byte,
zero-write preparation, outbound authorization binding, closed
refused/failed/invalid/limit classification, duration-ceiling abort, provider
throw as permanent dispatch-only ambiguity with no automatic retry, every
durable crash boundary with attempt-index-first recovery, lost
acknowledgements, fake success, process reconstruction, same-key concurrency
and different-render conflict, derivation-backed subject binding, all four
reviewer-independence refusals, legacy-v1 and unknown/wrong-scope no-oracle
subjects, definition-local get/query/cursor isolation, and the absence of any
Candidate, Review, or governance mutation.

- **L3 live-source/provider evidence:** empty; no live provider was called.
- **L4 semantic/model evaluation:** empty; assessment quality is unmeasured by
  construction — `advisory_uncalibrated` is a posture, not a claim.
- **L5 operational/SLO evidence:** empty.
- **L6 longitudinal acceptance evidence:** empty.

Issue #26 owns reviewer calibration, held-out detector/Candidate utility, and
every decisive or default-quality claim.

## Migration, package, and sequencing consequences

- `/workflows` still exports exactly two names; the all-entrypoint snapshot
  remains 158. The factory statics grow from two to four properties.
- Three global private engine kinds are added (`semantic-workflow-advisory-plan`,
  `semantic-workflow-advisory-completion`,
  `semantic-workflow-advisory-assessment`) plus the scope-namespace advisory
  attempt kind and the candidate scope-membership kind. None is a supported
  consumer API.
- New Candidates gain the scope-membership locator at proposal/admission time;
  existing Candidates are unchanged bytes and remain outside the advisory
  subject set unless an exact idempotent admission retry converges one.
- The #13a rule that `claimSemanticDispatch` refuses advisory targets is
  replaced by the lane's claim-time current checks; every other 0021/0022
  ordering, privacy, and authority exclusion is unchanged.
- With #13b generation and #13c advisory review shipped, the model-mediated
  distiller and reviewer of issue #13 both exist. Calibration, decisive
  model-mediated review, and default-quality claims remain #26.
