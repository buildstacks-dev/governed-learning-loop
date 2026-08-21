# 0028 — Frozen experiments, attested replay, and paired verdicts

**Date:** 2026-08-21
**Status:** ratified — issue #12; closes #12 and completes M4 Validate on the
package side, which completes the M1–M4 kernel milestone ladder

## Context

Decisions 0025–0027 made publication exact, journaled, and idempotent, gave
every intervention an append-only four-dimensional state history whose
`validation` stayed `untested`, and froze what a future episode was served
into a resolution receipt with host-evidenced exposure sets. Issue #12 is the
Validate tier: an `ExperimentDefinition` declared before any result exists,
with frozen digests for eligibility, fingerprints, metric, guardrails, grader,
and stopping rule; a `ReplayExecutor` port whose attestation the kernel
verifies; and verdict computation in which missing arms, metrics, or graders
are invalid and never neutral (kernel invariant 5), a guardrail regression
defeats an improvement verdict, every attempt is retained, the episode is the
treatment unit, and repetitions are nested within it.

The contract already named the shapes (`ExperimentDefinition`,
`ReplayExecutor`, `ReplayAttemptRequest`, `EvaluationResult`,
`declareExperiment`, `runExperiment`, `replayExecutors`) but left three
things open that this decision rules: how the kernel knows *which* episodes
to replay when it is handed only an eligibility-set digest, how the kernel
can compute a verdict when the contract says the core invents no universal
statistical threshold, and how an evaluation enters the intervention's
`validation` state without a `validate` edge in the decision-0026 table.
Kernel invariants 3 (authorized ≠ validated), 5 (missing measurement is never
zero and never a pass), 6 (trust is granted by host registration), and 7
(kernel-minted capabilities) shape every ruling below.

## Rulings

1. **A definition is declared before any result and freezes the exact
   population.** `ExperimentDefinition` is the contract shape plus one
   additive field, `eligibleEpisodeIds`: the exact, ordered, duplicate-free
   durable episode record ids (1–1,000) the design replays. The kernel
   recomputes `eligibilitySetDigest` over that set under
   `experiment-eligibility-set:v1` and refuses a digest that does not bind
   it; `pairCount` must equal the set size. Identifiers alone never freeze a
   population: a host episode id is refused as unknown, and every eligible id
   must be a durable episode on the loop whose identity resolved. The
   definition digest (`experiment-definition:v1`) covers every frozen field
   and excludes `schemaVersion`, the caller-chosen `id`, `declaredAt`, and
   itself. Declaration is create-only: the same design declared again under
   the same id is the stored declaration under any clock; a different design
   under the same id is `experiment.already_declared`; a different id with
   the same design is a separate experiment.
2. **Control and treatment must differ, and metrics must be comparable.**
   Identical control and treatment fingerprint digests are refused at
   declaration (`schema.invalid`): identical arms cannot be compared, so the
   contract's "a replay with identical control and treatment fingerprints is
   invalid" is enforced before any attempt. The primary metric and every
   guardrail metric are number- or boolean-valued; `minimumUsefulEffect` is
   a positive finite number; `perEpisodeAggregation` is one of the closed
   nested-repetition aggregations (`mean|median|sum-of-nested-repetitions-v1`
   for numbers, `all|any|majority-of-nested-repetitions-v1` for booleans) and
   must fit the primary metric's value type. A `must_pass` or
   `must_not_regress` guardrail takes a boolean metric and no threshold; a
   `maximum` guardrail takes a number metric and a finite threshold; a
   guardrail metric's own `aggregation` reduces its nested repetitions
   (`all|any` for booleans, `mean|median|sum` for numbers). Metric names are
   unique across the primary metric and the guardrails. Repetitions per pair
   are 1–100 and the design holds at most 10,000 slots.
3. **The kernel applies content-bound reference rules, not an invented
   threshold.** `referenceExperimentRules()` returns three frozen rule
   documents — `paired-mean-difference` (decision), `missing-is-invalid`
   (missingness), and `complete-design-or-ceiling` (stopping) — each with its
   digest under `experiment-rule:v1`, plus the closed per-episode aggregation
   vocabulary. A definition's `decisionRuleDigest`,
   `primaryMetric.missingnessRuleDigest`, and `stoppingRuleDigest` must name
   exactly those digests; any other rule is `experiment.rule_unknown`
   because the kernel cannot apply a rule it does not know. The rules are
   data so a host can read, cite, and pin them; a host-registered evaluator
   port is explicitly not part of this slice.
4. **The replay executor is kernel-minted and loop-bound.**
   `defineReplayExecutor({ id, version, configurationDigest, attempt })`
   follows the identity/authority-port discipline: it parses the metadata,
   captures the host callback at definition time, and returns a frozen,
   branded executor whose `registrationDigest` is the digest of
   `{ id, version, configurationDigest }`. `LearningLoopConfig.replayExecutors`
   accepts only factory-minted executors (a structural lookalike, a spread
   copy, a duplicate id or digest, and a non-array are `config.invalid`) and,
   when present, contributes the sorted exact `{ id, registrationDigest }`
   list to the registry revision; omission preserves prior bytes. A
   definition's `replayExecutorDigest` must name a configured executor at
   declaration and again at run time (`experiment.executor_unavailable`,
   zero writes).
5. **The subject is a journaled `publish` intervention in any state.** The
   definition's `interventionId` must resolve to a born intervention fold on
   this loop (`experiment.intervention_not_found`) whose header action is
   `publish` (`experiment.intervention_mismatch` for a disable, rollback, or
   compensate reversal). Publication, authorization, and activation state do
   not matter: a published-inactive (proposal-class) or disabled intervention
   is evaluated by replay exactly like an active one, because validation is
   an independent dimension.
6. **The request carries every digest the attestation must echo.**
   `ReplayAttemptRequest` is the contract shape plus additive
   `definitionDigest`, `episodeIdentity` (the resolved adapter identity of
   the durable episode), `baselineSnapshotDigest`, and `graderDigest`.
   `episodeId` is the durable episode record id; the arm's fingerprint,
   the fixture set, the side-effect policy with `denyByDefault: true`, and a
   kernel-minted `attestationNonce` complete it. `budget.maximumCost` is the
   remaining cost ceiling when one is declared, and under a ceiling cost is
   attestation content: a completed attempt must attest a cost in the
   ceiling's currency that does not exceed that budget — a missing,
   foreign-currency, or over-budget cost is `attestation_mismatch`, never
   zero spend (kernel invariant 5). The executor answers
   `unknown`; the kernel parses a `ReplayAttemptResult`: `completed` with a
   `ReplayAttestation` (the executor's exact registration plus every request
   digest, arm, repetition, and nonce), up to 100 typed measurements with
   unique metric names, and optional cost/duration; or `failed` with bounded
   diagnostics and an optional attestation. Nothing else of the host value is
   retained, and an unparseable value persists only kernel diagnostics.
7. **Every slot is journaled before the executor runs and never
   re-executed.** The design runs in declared order — eligible episode, then
   repetition, then control before treatment. Each slot's attempt record
   (`attempt-<digest>` over experiment, definition, episode, arm, and
   repetition) is created `dispatched` with its exact request before the
   executor is invoked and made terminal (`completed`, `failed`, or
   `rejected`) by one compare-and-set afterwards. A runner that finds a
   dispatched record — after its own crash, on a reconstructed host, or
   under a concurrent runner — never invokes the executor for that slot: the
   executor may have run, so the slot is `outcome_unknown` (the decision-0022
   dispatch posture) and the evaluation is invalid. Completed records retain
   the attestation, only the declared metrics' measurements (others are
   counted, not stored), and attested cost/duration; an executor that throws
   is retained as `failed` with a fixed kernel diagnostic and no error text;
   a returned value the kernel cannot read for any reason — a kernel refusal
   or a hostile value whose own accessors throw — is retained as `rejected`
   with kernel diagnostics only (`experiment.result_unparseable` when no
   kernel diagnostic exists), so no slot is ever stranded `dispatched` by a
   bad result.
8. **Classification is closed and verification is exact.** Each slot is
   `valid`, `not_run`, `outcome_unknown`, `failed`, `rejected`,
   `fingerprint_drift` (attested fingerprint is neither arm),
   `contaminated` (attested fingerprint is the other arm's),
   `attestation_mismatch` (executor registration, experiment, definition,
   episode, arm, repetition, fixture, baseline, grader, side-effect policy,
   nonce, or cost disagree), or `metric_missing` (a declared metric absent
   or not byte-equal to its frozen definition). The stopping rule halts at
   the first non-valid slot and when attested cumulative cost reaches the
   ceiling within the rule tolerance; later slots are `not_run`, and the
   `experiment.stopped` warning is recorded only when a slot was actually
   skipped.
9. **Missing is invalid, never neutral; a ceiling stop is inconclusive.** Any
   slot other than `valid` or `not_run` makes the verdict `invalid` with no
   analysis: nothing is imputed, excluded, or scored neutrally. A design
   stopped by the cost ceiling over an otherwise valid prefix is
   `inconclusive` with `experiment.stopped`, never a claim over a partial
   design. Only a complete valid design is analyzed.
10. **The episode is the unit; the reference rule decides; a guardrail
    regression defeats improvement.** Per episode and arm, nested
    repetitions reduce through the declared aggregation (booleans count as
    1/0); `favorableDelta` is treatment − control for `higher` and control −
    treatment for `lower`. Guardrails are evaluated per episode on the
    treatment arm (`must_pass`: aggregate true; `maximum`: aggregate ≤
    threshold) or against control (`must_not_regress`: no episode with a true
    control aggregate and a false treatment aggregate). Any guardrail
    regression is `regressed` whatever the primary metric did
    (`experiment.guardrail_regression` names the metric and episodes).
    Otherwise `improved` requires `meanFavorableDelta ≥ minimumUsefulEffect`
    and more favorable than unfavorable pairs; `regressed` the mirror; every
    other complete design is `inconclusive`. Every boundary comparison —
    effect size, pair sign, guardrail threshold, cost ceiling, budget —
    applies the rule tolerance `1e-9`, which the rule document carries, so
    an effect of `0.7 − 0.4` against a declared minimum of `0.3` is reached.
    The rule is one pure function, `referenceVerdict(analysis)`, shared by
    the engine that mints an evaluation and the parser that reads one: the
    analysis carries `direction` and `minimumUsefulEffect` with the pairs,
    mean, counts, and guardrail outcomes, and `parseEvaluationResult`
    refuses a record whose favorable deltas, summary, or verdict do not
    follow from its own bytes. An implementation change is therefore a
    record change, not a silent drift behind a prose digest.
11. **One experiment yields one content-addressed evaluation.**
    `EvaluationResult` is the contract shape plus additive `interventionId`,
    `registryRevision`, `classifications` (one per declared slot, in run
    order, with the attempt id or `null` for `not_run`), `analysis` (present
    exactly when every slot is valid), `evaluatedAt`, and
    `evaluationDigest`. Its id is `evaluation-<digest>` over the experiment id
    and definition digest under `experiment-evaluation-key:v1`, so a rerun
    returns the stored evaluation with zero executor calls and zero writes,
    and a concurrent second runner converges on the first persisted record.
    Hosts must serialize runners per experiment: a second live runner finds
    the first runner's dispatched slot, cannot know whether its executor
    ran, classifies it `outcome_unknown`, and its honestly invalid
    evaluation is the one that persists; the first runner then adopts it
    and never re-executes the slot (pinned by the concurrency test). A
    re-run after a changed executor, a concurrent runner, or a different
    verdict is a new experiment declaration, never a rewrite.
12. **Evaluations bind into the intervention through the `validate` edge.**
    The legal-transition table gains `validate`: `validation` alone moves,
    from any value to a different verdict (never back to `untested`), on an
    intervention whose authorization is no longer `pending`. The 135
    Activate edges of decision 0026 are unchanged; `validate` adds 16
    ordered validation moves on each of the 32 structurally valid non-pending
    triples, 512 edges, for a pinned total of 647. Persistence is index-first
    and edge-last: the evaluation id is appended to a private per-intervention
    stream (`intervention-evaluation`, capped at 1,000), the evaluation is
    created, then the `validate` transition is appended with the evaluation
    as evidence unless the intervention already holds that verdict or a
    transition already cites the evaluation. Only the latest indexed
    evaluation may move the state: rereading an older evaluation after a
    newer experiment changed the verdict is a pure read, never a rewrite.
    `InterventionRecord.evaluationIds` folds the index verified against each
    durable evaluation through a light read of its identity and verdict
    fields (the store layer has already digest-checked the bytes), so the
    resolution and publication paths stay cheap; an orphan index entry from
    a crash does not count, and a validate transition citing an unindexed
    evaluation, or one whose verdict differs from the state the edge lands
    on, is `store.corrupt` — an id never freezes a verdict. Authorized ≠ validated stays
    permanent: nothing here publishes, activates, or grants authority.
13. **Exposure arms bind declared experiments.** `acknowledgeExposure` now
    accepts `experiment: { experimentId, arm }` when the experiment is
    declared on this loop (`exposure.experiment_unavailable` otherwise) and
    the arm agrees with the applied entries: a `treatment` exposure applies
    the experiment's intervention and a `control` exposure does not
    (`exposure.experiment_arm_mismatch`). The set records the arm; it still
    grants nothing.
14. **System fingerprints are order-independent digests of named
    components.** `SystemFingerprint` and `FingerprintComponent` ship with
    `systemFingerprintDigest` (components sorted by unique name under
    `system-fingerprint:v1`) and `parseSystemFingerprint`; the kernel never
    inspects component content.
15. **Conformance and the inert executor ship in `/testing`.**
    `createInMemoryReplayExecutor` grades from a script, attests faithfully,
    records every request, and can answer failure, throw, or raw bytes;
    `runReplayExecutorConformance(makeExecutor, { describe, expect, it })`
    proves an executor is kernel-minted, never throws or mutates a
    well-formed request, answers parseably, and attests exactly the request
    and its own registration whenever it attests. Every replay executor must
    pass it.
16. **The public surface grows by 25 names.** Root: `FingerprintComponent`,
    `SystemFingerprint`, `parseSystemFingerprint`, `systemFingerprintDigest`,
    `ExperimentDefinition`, `ExperimentDefinitionInput`, `Money`,
    `EvaluationResult`, `ReferenceExperimentRules`, `eligibilitySetDigest`,
    `experimentDefinitionDigest`, `parseExperimentDefinition`,
    `parseEvaluationResult`, `referenceExperimentRules`,
    `ReplayAttemptRequest`, `ReplayAttemptResult`, `ReplayAttestation`,
    `ReplayExecutor`, `parseReplayAttemptResult`, and `defineReplayExecutor`;
    `/testing`: `InMemoryReplayExecutor`, `InMemoryReplayExecutorOptions`,
    `createInMemoryReplayExecutor`, `ReplayExecutorFactory`, and
    `runReplayExecutorConformance`. `LearningLoop` gains `declareExperiment`
    and `runExperiment`; `LearningLoopConfig` gains `replayExecutors`. The
    all-entrypoint snapshot moves from 196 to 221. Attempt records, the
    evaluation index, the rule documents' internals, and the attempt
    classification helpers stay private.

## Digest and identity matrix

| Value | Domain tag | Includes | Excludes |
| --- | --- | --- | --- |
| rule `digest` | `experiment-rule:v1` | the rule document | — |
| `eligibilitySetDigest` | `experiment-eligibility-set:v1` | ordered eligible episode record ids | — |
| `definitionDigest` | `experiment-definition:v1` | every frozen field incl. eligibleEpisodeIds, metrics, guardrails, costCeiling | schemaVersion, id, declaredAt, definitionDigest |
| attempt `id` | `experiment-attempt-key:v1` | experimentId, definitionDigest, episodeId, arm, repetition | result; prefixed `attempt-` |
| `attemptDigest` (private) | `experiment-attempt:v1` | slot, request, dispatchedAt, status, retained result, completedAt | schemaVersion, id, attemptDigest |
| evaluation `id` | `experiment-evaluation-key:v1` | experimentId, definitionDigest | — ; prefixed `evaluation-` |
| `evaluationDigest` | `experiment-evaluation:v1` | experimentId, definitionDigest, interventionId, registryRevision, attemptIds, classifications, analysis, verdict, diagnostics | schemaVersion, id, evaluatedAt, evaluationDigest |
| executor `registrationDigest` | — | `{ id, version, configurationDigest }` | adapter behavior |
| fingerprint `digest` | `system-fingerprint:v1` | components sorted by name | id |

Golden vectors pinned in `tests/experiment-records.test.ts`: decision rule
`f48d6a599a9852780f2aaed0a252d2228de819e94e15059c1e78a1e16fe138ae`,
missingness rule
`27d56075f08372836fd728392de66e45cb0a9397ccca1a1a9b5aaa8558dd12aa`,
stopping rule
`f5c8c5d642a68d57f42adead8b44dc2a090c7f811f3cd3a4757939b096a488cd`, the
fixture eligibility-set, definition, evaluation, and fingerprint digests.

## Error codes added

`experiment.rule_unknown`, `experiment.executor_unavailable`,
`experiment.intervention_not_found`, `experiment.intervention_mismatch`,
`experiment.episode_unknown`, `experiment.already_declared`,
`experiment.not_predeclared`, `experiment.missing_arm`,
`experiment.missing_metric`, `experiment.fingerprint_drift`,
`experiment.contaminated`, `experiment.attestation_mismatch`,
`experiment.guardrail_regression`, `experiment.stopped`,
`experiment.executor_error`, `experiment.result_unparseable`,
`experiment.limit_exceeded`, and `exposure.experiment_arm_mismatch`; `experiment.verdict` is the informational
analysis diagnostic. Malformed input is `schema.invalid`; a lookalike
executor is `config.invalid`; a broken journal is `store.corrupt`.

## Validation evidence

L1 contract/schema/digest controls: the three rule digests pinned; the
definition round-trip with unknown-field dropping, the eligibility-set and
definition digest goldens, digest movement for every frozen field and
stability across id and declaredAt, and refusal of identical arms, forged or
mismatched eligibility sets, duplicate or empty populations, string or
mis-aggregated metrics, non-positive effects, ill-fitting guardrails,
duplicate metric names, over-ceiling designs, non-positive ceilings,
malformed intervention ids, stale digests, and unsupported versions; attempt
and evaluation id derivation; evaluation round-trip and golden, id/digest/
attempt-list consistency, and the classification/verdict matrix (no analysis
without a fully valid design, `invalid` for any non-valid slot,
`inconclusive` only over `not_run`, never `invalid` for a valid design);
fingerprint order independence and refusals; replay result parsing with
unknown statuses, mistyped values, duplicate names, and unbounded output
refused, and attestation mismatch enumeration per field.

L2 deterministic engine controls: the executor factory (frozen, branded,
captured callback, malformed metadata refused, lookalikes and copies refused,
loop construction refusing lookalikes, duplicates, and non-arrays, registry
revision binding and order independence); declaration (persisted frozen
record, idempotence under a ticking clock, changed-design refusal, rule/
executor/intervention/reversal/episode refusals with zero writes, disabled
subject accepted, malformed input, nothing granted); runs (the improved
evaluation with exact requests, nonces, retained attempts, and the validate
edge; idempotent rerun with zero calls and writes; inconclusive; primary
regression; majority-of-pairs rule; nested repetitions; lower-is-better mean;
must_not_regress, maximum, and must_pass guardrails defeating improvement;
missing metric, wrong metric definition, executor failure, thrown executor,
unparseable result, fingerprint drift, contamination, nonce/executor/grader/
currency mismatch each invalidating with retained attempts; ceiling stop with
remaining budgets; refusals for undeclared, malformed, and executor-less
runs; later experiments binding later verdicts without rewriting or flipping
back; same-verdict evaluations binding without a new transition; an older
evaluation reread after a newer verdict staying a pure read; a tampered
validate edge whose evaluation says another verdict folding as corruption;
missing and over-budget cost under a ceiling; a ceiling reached on the final
slot; the tolerance at the effect boundary and at the ceiling; a hostile
result with throwing accessors retained as rejected; disabled interventions
evaluated; exposure arms). Crash conformance injects a crash
before and after the definition create, the first and fourth attempt
dispatch and compare-and-set, the evaluation index append, the evaluation
create, and the validate transition, then proves a reconstructed host
converges on the byte-exact evaluation of a clean run without re-executing
any dispatched slot — or, for a dispatch whose result never landed, an
honestly invalid evaluation — and that a concurrent second runner converges
on one evaluation, which is the invalid one (hosts serialize runners). The in-memory executor passes the public conformance
suite.

- **L3 live executor evidence:** empty; no workspace, model, or tool was
  driven. The shipped executor is inert.
- **L4 semantic/model evaluation:** empty.
- **L5 operational/SLO evidence:** empty. A run costs one definition read,
  one evaluation read, and per slot one attempt get, one create, one
  executor call, one compare-and-set, and one reload; finalization costs an
  index append, an evaluation create, a fold, and at most one transition
  append.
- **L6 longitudinal acceptance evidence:** empty; no real intervention has
  been evaluated, which is exactly what an `inconclusive` or `untested`
  state says.

## Migration consequences

- Four private store kinds are added: `experiment-definition`,
  `experiment-attempt`, `experiment-evaluation`, and the per-intervention
  `intervention-evaluation` stream. None is a supported consumer API.
- The legal-transition table grows from 135 to 647 edges; every stored
  Activate transition remains legal, and `InterventionRecord.validation` can
  now leave `untested`. `GovernanceView.validation` still reports `untested`
  — the candidate-level fold over its interventions' evaluations, and the
  `report` fold over interventions and evaluations, are recorded debt.
- `ExposureInput.experiment` is accepted for declared experiments; the
  decision-0027 refusal now fires only for an undeclared experiment id.
- The contract's `ExperimentDefinition`, `ReplayAttemptRequest`, and
  `EvaluationResult` gain additive fields; the example digests become
  `sha256HexOfCanonicalJson` calls over host artifacts and the reference
  rule digests. Outcome sources (`outcomeSources`, `recordOutcomes`) remain
  unimplemented.
- M4 is complete on the package side: M1–M4 are closed. The remaining
  package debts are the candidate-level validation fold, the report fold,
  outcome sources, and a host-registered evaluator port; the remaining
  program debt is the Cormidia adapter migration (#14).
