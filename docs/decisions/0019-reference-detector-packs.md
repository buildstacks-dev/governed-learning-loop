# 0019 — Host-bound reference detector packs

**Date:** 2026-08-20
**Status:** ratified — issue #30d reference packs and synthetic controls

## Context

Decisions 0007 through 0018 define immutable semantic registrations, exact
source capability grants, synchronous deterministic detector execution,
bounded pack orchestration, private recurrence, descriptive receipts, and
serialized Candidate admission. Those mechanisms intentionally contain no
detector catalog. A host can register code, but the package does not yet ship a
portable, inspectable example of a core structural pack or an opt-in operational
pack.

Issue #30d requires reference contents without turning one threshold list into
kernel truth. The contents must remain provider-neutral, operate only on
explicit normalized evidence, distinguish source availability from behavior,
work under host purpose lenses, and preserve the rule that an observed pattern
is not a claim of harm, inefficiency, preference, utility, or efficacy.

## Rulings

1. **Reference contents use an opt-in subpath.**
   `@cormidia/learning-loop/reference-detectors` exports exactly
   `ReferenceDetectorBundle` and `createReferenceDetectorBundle`. The root
   entrypoint remains the protocol/engine surface. The subpath has no runtime
   dependency, provider SDK, filesystem reader, discovery behavior, scheduler,
   model workflow, or effect capability.
2. **One unknown-first factory creates a host-bound bundle.** The factory input
   is exact `{ schemaVersion: 1, registrationNamespace, scopePolicyDigest,
   lenses }`. It parses bounded, control-free values and exact unique
   LearningLensRegistration values, sorts the lenses by exact ref, snapshots
   them, and returns immutable detector registrations, exact pack manifests,
   runtime implementation capabilities, fixture descriptors, and inert source
   requirements. It does not create a SemanticRegistryConfig, select anything,
   configure a loop, or run a detector.
3. **Host binding is content-addressed.** `hostBindingDigest` is the SHA-256 of
   canonical exact `{ domain:"reference-detector-host-binding:v1",
   registrationNamespace, scopePolicyDigest, lenses }`, where `lenses` contains
   the sorted exact `{ id, version, registrationDigest }` refs. Detector ids are
   `<namespace>.reference.<family>.<hostBindingDigest>` and pack ids use the
   same formula with family `core_structural` or `reference_operational`. The
   fixed shipped algorithm version is `0.1.0`; all detector registrations remain
   experimental. Two calls over identical bytes produce the same public semantic
   records. Different namespaces, scope policies, or lens registrations create
   parallel host-bound instances with different ids and no
   same-id/version/different-digest collision.
4. **Algorithm change and host binding are different axes.** Changing shipped
   code, thresholds, configuration, normalized vocabulary, fixtures,
   false-positive policy, privacy policy, or proposed validation criteria
   requires a new algorithm version and future exact supersession lineage.
   Changing only the host namespace, scope policy, or exact lens set creates a
   parallel bundle instance; it does not claim to supersede another host's
   instance. Each runtime implementation reparses its own exact registration
   configuration and thresholds into a frozen policy; malformed or
   family-inconsistent registered policy is `detector.implementation_invalid`,
   never replaced by hidden callback defaults.
5. **Exact lens allowlists preserve purpose without role enums.** Every insight
   detector binds the supplied exact lenses in a sorted allowlist, and both pack
   manifests contain the same exact lens refs. Consequently one bundle can run
   the same evidence under Support and Documentation lenses and mint distinct
   lens-bound derivations. The kernel does not standardize either role, their
   names, objectives, destinations, or scopes.
   Each input lens must use the same scope-policy digest, permit deterministic
   generation, require observation-only evidence, carry no runtime calibration
   requirement, require no producer fingerprint beyond `implementation`, and
   include `human_agent_interaction`, `mechanical_execution`, and `system_meta`.
6. **Source requirements are inert.** The bundle describes an exact observation
   vocabulary, accepted kinds, and required capability names. Those values are
   not SourceSemanticProfiles, capability grants, source registrations, registry
   fragments, or adapter attestations. A host must separately bind only the
   capabilities one exact configured source revision truly provides. The
   current transcript adapters do not claim these new capabilities.
7. **The catalog has two exact packs.** The `core_structural` pack contains the
   coordination-attribution integrity detector. The `reference_operational`
   pack contains repeated status polling, context pressure/explicit compaction,
   repeated or concentrated tool use, coordination fan-out, and attributed
   human-redirection detectors. Pack membership is distribution, not trust or
   authority.
8. **Every callback emits at most one structural derivation.** A detected
   condition cites exact window evidence and emits one fixed-text
   InsightDerivation draft. The core integrity detector keeps interpretation
   null; operational detectors use one fixed `unknown`-confidence,
   review-required interpretation. Impact hypothesis, Candidate intervention,
   validation, and supersession remain null. A negative condition emits no
   draft. All registrations forbid recurrence locators, so no positive result
   enters a recurrence group or serialized recurrence admission.
9. **The detector names describe conditions, not judgments.** Polling is a
   count of normalized status checks; context pressure is an exact configured
   utilization/compaction signal; tool repetition/concentration is a structural
   distribution; fan-out is an exact declared child graph; redirection is an
   attributed review-needed signal. None establishes that the behavior was
   wasteful, harmful, preferred, correct, or causally responsible for an
   outcome. Counts alone never establish a human preference.
10. **Normalized inputs fail closed.** Detector callbacks parse every targeted
    Observation.data value from its JSON shape. Missing, malformed, mixed-source,
    open, or unresolved lineage is refused or excluded by exact registered
    applicability; it never becomes an applied negative, zero, or pass. The
    `single_source_closed_episodes` vocabulary rule and every registration's
    `closedEpisodePopulation:true` policy require `closedAt` on every selected
    episode. The v1 vocabulary does not infer cross-source ordering or join
    independent transcripts.
11. **Unavailable-source coverage stays native.** `missing`, `unreadable`, and
    `unsupported` pages intentionally contain no projections and therefore
    cannot enter an episode-anchored DetectorWindow. Their reference controls
    exercise SourcePageReceipt and EvidenceHealthFinding directly. There is no
    synthetic coverage detector and no behavioral derivation for source
    unavailability. Positive evidence-health callback recovery remains an
    existing detector-runner/persistence debt outside these packs; #30d does
    not silently claim to close it.
12. **This is hermetic structural validation, not calibration.** #30d supplies
    L1 contract checks and L2 deterministic synthetic controls only. L3 live
    source validation, L4 semantic/model evals, L5 operations/SLO evidence, and
    L6 longitudinal acceptance evidence are empty for this slice. Issue #26
    owns calibration, held-out candidate-utility evaluation, and any
    default-quality claim. Issue #13 owns model-mediated semantic workflows and
    disclosure receipts.

## Reference family matrix

Every registration binds the exact positive and negative fixture digests for
its row. Thresholds are fixture-scale detector configuration, not kernel
constants or calibrated defaults.

| Pack | Detector family | Normalized evidence | Exact positive condition | Required negative control |
| --- | --- | --- | --- | --- |
| Core structural | Coordination attribution integrity | One delegated, asserted-closed population plus exact Episode parent lineage | Any broken root, missing parent, or cycle | One exact acyclic closed parent/descendant graph |
| Reference operational | Repeated status polling | Primary `status_poll` operation observations | At least 4 consecutive `unchanged` polls for one tenant-keyed target | Fewer polls or an intervening change/progress operation |
| Reference operational | Context pressure / explicit compaction | Primary utilization and explicit compaction observations | At least 3 consecutive utilization samples at or above 9,000 basis points, or at least 2 explicit compactions | Ordinary bounded context use below both branches |
| Reference operational | Tool repetition / concentration | Primary completed tool operations | At least 12 operations and either one tenant-keyed signature repeated at least 4 times or one operation class at least 7,500 basis points | A complex legitimate 48-operation case whose signatures are unique and largest class is 5,000 basis points |
| Reference operational | Coordination fan-out | One exact acyclic delegated closed population | At least 4 direct children and at least 6 total descendants | Ordinary bounded attributed delegation |
| Reference operational | Attributed human redirection | Primary sequenced interaction turns with exact reply sequence | At least 2 exact human-correction → agent-turn pairs across at least 2 episodes | Non-primary traffic and uncited/single-episode correction signals |

The vocabulary kinds are `reference.operation.completed.v1`,
`reference.context.utilization.v1`, `reference.context.compaction.v1`,
`reference.coordination.population.v1`, and `reference.interaction.turn.v1`.
Required capabilities are the relevant subsets of
`reference.traffic.classification.v1`, `reference.operation.sequence.v1`,
`reference.context.pressure.v1`,
`reference.coordination.attribution.v1`, and
`reference.interaction.cited-redirection.v1`.

Operation records bind nonnegative per-episode sequence, closed intent/state,
bounded operation class, tenant-keyed target and signature digests, and closed
traffic class. Context utilization uses integer basis points from 0 through
10,000; compaction binds before/after utilization and requires `after < before`.
Coordination markers bind an asserted-closed Boolean and delegated
classification, while exact parent ids
come from resolved EpisodeIdentityRecord values. Interaction turns bind
sequence, `human | agent`, correction Boolean, nullable cited reply sequence,
and traffic class. Every sequence is unique within its episode.
The vocabulary's sorted traffic-class set is `automated`, `benchmark`,
`delegated`, `guardian`, `primary`, `replay`, and `reviewer`.

The vocabulary record is `cormidia.reference-observation-vocabulary@0.1.0`, with
digest `e8f396b7b5e4bad4ee67d1737c144c92d2ca1ecf8f4f59d1835b91ef9b9dec4f`,
and binds these exact schemas; unknown data fields are ignored when the callback
constructs its fresh narrowed value:

| Kind | Required data | Additional constraints |
| --- | --- | --- |
| `reference.operation.completed.v1` | `sequence` nonnegative safe integer; `intent` = `progress | status_poll | tool | wait`; `state` = `changed | failed | succeeded | unchanged | unknown`; bounded control-free `operationClass`; tenant-keyed lower-case SHA-256 `targetKeyedDigest` and `signatureKeyedDigest`; closed `trafficClass` | Sequence unique per episode |
| `reference.context.utilization.v1` | `sequence`; `utilizationBasisPoints` integer 0–10,000; closed `trafficClass` | Sequence unique per episode |
| `reference.context.compaction.v1` | `sequence`; `beforeUtilizationBasisPoints`; `afterUtilizationBasisPoints`; closed `trafficClass` | Sequence unique per episode and `after < before` |
| `reference.coordination.population.v1` | `closedPopulation:true`; `trafficClass:"delegated"` | Exactly one marker; marker episode is the root |
| `reference.interaction.turn.v1` | `sequence`; `actor` = `agent | human`; Boolean `correction`; nullable nonnegative `replyToSequence`; closed `trafficClass` | Sequence unique per episode; cited target is earlier and in the same episode |

The vocabulary additionally binds population rule
`single_source_closed_episodes`: all selected episodes resolve to the one exact
window source and carry `closedAt`.

These thresholds, shapes, fixed output statements/data, and fixture digests are
part of the `0.1.0` bytes. They are fixture-scale reference configuration, not
kernel thresholds or calibrated defaults, and are pinned by self-tests.

The twelve shipped fixture descriptors are:

| Family | Positive fixture | Negative fixture |
| --- | --- | --- |
| Coordination attribution integrity | `reference.fixture.coordination_attribution_integrity.positive.v1`: one child names a missing parent | `reference.fixture.coordination_attribution_integrity.negative.v1`: one exact root→child graph |
| Repeated status polling | `reference.fixture.repeated_status_polling.positive.v1`: 4 consecutive unchanged polls | `reference.fixture.repeated_status_polling.negative.v1`: longest unchanged run is 2 around a changed state |
| Context pressure / explicit compaction | `reference.fixture.context_pressure_compaction.positive.v1`: 9,100/9,300/9,500 basis-point run plus 2 explicit 9,500→4,000 compactions | `reference.fixture.context_pressure_compaction.negative.v1`: interrupted high samples plus 1 compaction |
| Tool repetition / concentration | `reference.fixture.tool_use_concentration.positive.v1`: 12 tools, 9/3 classes and 4 repeated signatures | `reference.fixture.tool_use_concentration.complex-legitimate-negative.v1`: 48 successful tools, 24/12/12 classes, 48 unique signatures |
| Coordination fan-out | `reference.fixture.coordination_fanout.positive.v1`: 4 direct children and 6 descendants | `reference.fixture.coordination_fanout.negative.v1`: 3 direct children and 6 descendants |
| Attributed human redirection | `reference.fixture.attributed_human_redirection.positive.v1`: 2 exact pairs across 2 episodes | `reference.fixture.attributed_human_redirection.negative.v1`: only 1 eligible primary pair; the second target is non-eligible replay traffic |

Additional hermetic boundary controls pin polling episode/sequence gaps,
context branch thresholds and interruption, tool OR branches and denominator,
fan-out at 4/5, redirection at 2 pairs/1 episode, all excluded traffic classes,
missing/self/forward cited-target refusal, open-episode refusal, duplicate
coordination markers, repeated-citation deduplication, and explicit compaction
refusal when `after >= before`.

The exact source-requirement projection is:

| Family | Required capabilities | Accepted observation kinds |
| --- | --- | --- |
| Coordination attribution integrity | `reference.coordination.attribution.v1`, `reference.traffic.classification.v1` | `reference.coordination.population.v1` |
| Repeated status polling | `reference.operation.sequence.v1`, `reference.traffic.classification.v1` | `reference.operation.completed.v1` |
| Context pressure / explicit compaction | `reference.context.pressure.v1`, `reference.traffic.classification.v1` | `reference.context.compaction.v1`, `reference.context.utilization.v1` |
| Tool repetition / concentration | `reference.operation.sequence.v1`, `reference.traffic.classification.v1` | `reference.operation.completed.v1` |
| Coordination fan-out | `reference.coordination.attribution.v1`, `reference.traffic.classification.v1` | `reference.coordination.population.v1` |
| Attributed human redirection | `reference.interaction.cited-redirection.v1`, `reference.traffic.classification.v1` | `reference.interaction.turn.v1` |

Every detector has advisory minimum trust, complete minimum evidence, any
episode class, invocation scope, null comparability/calibration, an exact lens
allowlist, `insight_derivation` output, forbidden transient content, no
recurrence signature treatment, `closedEpisodePopulation:true`, and explicit
false-positive policy. Each exact registration binds one positive and one
negative fixture; the tool detector's negative is additionally marked
complex-legitimate.

The fixed direct-observation outputs are:

| Family | Statement | Structural data fields after `family` |
| --- | --- | --- |
| Coordination attribution integrity | `A closed coordination population contains structurally invalid attribution lineage.` | `brokenRootCount`, `missingParentCount`, `cycleCount` |
| Repeated status polling | `The configured consecutive unchanged status-poll condition was observed.` | `longestConsecutiveRun` |
| Context pressure / explicit compaction | `The configured explicit context-pressure or compaction condition was observed.` | `longestHighPressureRun`, `explicitCompactions`, `maximumUtilizationBasisPoints` |
| Tool repetition / concentration | `The configured repeated or concentrated tool-use condition was observed.` | `completedOperations`, `maximumRepeatedSignatureCount`, `dominantOperationClassBasisPoints` |
| Coordination fan-out | `The configured coordination fan-out condition was observed in a closed attributed population.` | `directChildren`, `descendants`, `maximumDepth` |
| Attributed human redirection | `The configured exact human-to-agent cited redirection condition was observed across distinct episodes.` | `citedPairCount`, `distinctEpisodeCount` |

Every operational output has the exact interpretation `This structural
condition requires purpose-specific review before any behavioral conclusion.`,
confidence `unknown`, and uncertainty `The condition alone does not establish
harm, inefficiency, preference, utility, or efficacy.` Every output uses exact
applicability `Applies only to the exact normalized single-source population
supplied to this execution.` and exclusion `No causal, quality, authority,
preference, or utility conclusion is included.` The redirection output
additionally records missing capability
`interaction.cited_turn_review`, reason `interpretation.review_required`, with
effect `limits_claims`.

## Privacy, authority, and bounds

- Normalized records contain structural scalars and private, tenant-treated
  lineage only. The bundle receives no raw messages, tool arguments/results,
  filesystem paths, source readers, or private locator key.
- `registrationNamespace` is embedded verbatim in public detector/pack ids; a
  host supplies only public-safe namespace text, never a raw tenant, project,
  path, account, or other private identifier.
- Output text is fixed and never repeats a tool name, message, private episode
  id, host lens objective, or raw adapter value. Exact EvidenceRefs carry the
  auditable citation.
- Every detector uses `signatureTreatment: "none"` and returns no recurrence
  locator. The bundle creates no recurrence group, Candidate, Review, receipt,
  publication, authorization, activation, context resolution, provider turn,
  or effect.
- The callbacks are synchronous, deterministic, and bounded by the existing
  DetectorWindow ceilings. They use protocol code-unit ordering, not locale,
  current time, randomness, filesystem state, or network state. Sorting is
  bounded by at most 5,000 evidence records, and coordination graph work by the
  500-episode population ceiling. Nothing is silently truncated.

## Validation evidence

The synthetic suite proves:

- every registered positive and negative fixture digest resolves to exact
  shipped fixture bytes and its detector returns the declared result;
- immutable literal `0.1.0` vectors pin the host binding, vocabulary, every
  detector registration, pack, fixture, and per-family positive derivation/
  execution identity; changing those bytes requires a catalog version bump;
- two personal-project scopes remain isolated, while a separately declared
  cross-project craft scope is a distinct exact population;
- the same evidence under exact Support and Documentation lenses produces
  distinct scope- and lens-bound derivations without kernel role enums;
- a complex legitimate high-tool fixture is negative;
- traffic classification precedes every human-redirection claim;
- missing capability, malformed normalized data, open lineage, and source
  mixing fail closed without an applied negative;
- positive results create no recurrence, Candidate, Review, provider call, or
  effect; and
- source missing/unreadable/unsupported cases remain exact native health facts
  with no detector callback.

## Migration and public surface

- Existing record schemas, digests, stores, detector executions, derivations,
  Candidates, reviews, recurrence, receipts, and admission bytes are unchanged.
  Constructing no reference bundle preserves every pre-#30d registry byte.
- Installing/selecting a bundle or adding its runtime implementations creates a
  new semantic/loop registry revision through the existing mechanisms. Existing
  executions remain historical and are never relabeled.
- The root snapshot remains 154 symbols. The new subpath adds exactly
  `ReferenceDetectorBundle` and `createReferenceDetectorBundle`, for 156 public
  symbols across all supported entrypoints.
- No deep import, record writer, parser toolkit, fixture mutator, callback, raw
  implementation helper, SourceSemanticProfile factory, or registry-composition
  helper is public.
