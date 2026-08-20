# 0007 — Registered detectors, learning lenses, and insight derivations

**Date:** 2026-08-19
**Status:** ratified — issue #30a semantic records

## Context

The Observe/Govern kernel now binds source health, exact evidence, measurements,
outcomes, Candidates, and independent review, but it has no portable record for
the semantic step between minimized observations and `propose`. Application
heuristics can currently collapse a measured pattern, causal interpretation,
recommended intervention, and validation idea into one unversioned statement.

Cormidia's extraction appendix describes the intended reusable seam, while the
standalone repository remains contract authority. The kernel needs immutable
detector, pack, and purpose semantics plus an inert derivation record without
hardcoding Cormidia roles, provider traces, or one threshold catalog.

## Rulings

1. **The additive semantic record is `InsightDerivation`.**
   `CandidateDerivation` incorrectly suggests a Candidate already exists, and
   `LearningCase` does not state that evidence was transformed through explicit
   interpretation. An InsightDerivation remains advisory and inert; only the
   verified `propose` transition may create a Candidate.
2. **Purpose uses `LearningLensRegistration`.** A lens says what good means and
   how evidence is interpreted. Scope still says where learning applies;
   `LearningClass` says which semantic altitude is considered; destination says
   what may change. `PurposeProfile` is rejected because “profile” invites a
   host role/scope enum. The four reserved learning classes are
   `mechanical_execution`, `human_agent_interaction`, `role_craft`, and
   `system_meta`; bounded `host:<namespace>` extensions remain host data.
3. **`DetectorRegistration` binds executable semantics.** Its stable id and
   canonical SemVer bind maturity, implementation, full minimized configuration
   and thresholds plus adjacent digests, normalized vocabulary and capability
   requirements, observation kinds, trust/completeness floors, episode/scope/
   lens applicability, normalization/comparability, output kind, positive and
   negative fixtures, full false-positive policy, calibration population and
   evidence, privacy treatment, proposed validation criterion, supersession,
    and `registrationDigest`.
    Positive and negative fixture lists are both nonempty; fixture parsing
    success never substitutes for calibration.
4. **Detector output remains separated.** `outputKind` is exactly
   `evidence_health` or `insight_derivation`. The former produces the existing
   closed `EvidenceHealthFinding` family; it never creates a behavioral
   derivation or silently shares its denominator. Deterministic detection can
   establish that a condition occurred, not why it was harmful.
5. **`DetectorPackManifest` is availability, not authority.** A manifest binds
   a stable id/version, distribution kind (`core_structural`,
   `reference_operational`, or `host`), exact sorted detector and lens refs,
   changelog digest, supersession, and `manifestDigest`. Installing it grants no
   trust, execution, active context, publication, review, authorization, or
   validation power. A pack contains at least one exact detector registration;
   detector and lens refs are sorted and unique.
6. **Lens semantics are immutable and host-neutral.** A
   LearningLensRegistration binds objective, scope policy and applicability,
   episode classes, learning classes, evidence trust/completeness requirements,
   full qualitative rubric, required fingerprint kinds and calibration ids,
   permitted destination ids/kinds, exact generator/reviewer policy digests,
   disclosure/privacy policy, validation strategy, supersession, and
   `registrationDigest`. Objective, rubric, and validation-strategy content
   have adjacent recomputed digests. Support,
   Documentation, Cormidia roles, and personal projects are reference data, not
   enums.
   Decision 0009 additively widens the closed evidence-requirement kind from
   observation/measurement to observation/measurement/episode. Episode floors
   apply to the exact reloaded EpisodeIdentityRecord population; existing lens
   bytes and digests are unchanged.
7. **InsightDerivation preserves the full uncertainty chain.** It separately
   records exact scope/lens/detector/pack/population lineage, a direct
   observation with a human-readable statement and machine-readable `JsonValue`
   `data`, exact evidence and complete evidence-health findings, interpretation plus
   confidence and uncertainty, impact hypothesis, contradictory and missing
   evidence, applicability/exclusions, producer fingerprints and attribution,
   optional supersession, and an intervention paired with its validation plan.
   The intervention and validation values are both present or both null.
8. **Lens and producer lineage is mandatory.** Every derivation names one exact
   LearningLensRegistration. Producer lineage binds kind, implementation id/
   version/digest, principal and attestation when used, model/prompt/tool/budget
   fingerprints, and exact minimized-byte disclosure receipt lineage when an
   outbound semantic provider was used. Null cannot stand for an omitted
   required fingerprint under the lens requirements. Human producers require a
   human principal plus attestation; semantic producers require an agent or
   service principal plus attestation and bind model, prompt, tool-policy, and
   budget-policy digests. Deterministic
   producers require those provider fields to be null.
9. **Derivation identity is content-addressed.** `derivationDigest` binds every
   semantic field except schema, id, and the digest itself; `id` is exactly
   `insight-${derivationDigest}`. It binds full EvidenceRef and
   EvidenceHealthFinding values, not bare ids or asserted effects.
   Evidence-health findings constrain claims but never become behavioral evidence. The population
   episode list and direct evidence list cannot both be empty. Every population
   episode carries `scopeDigest`, and it must equal the derivation scope digest;
   population-only lineage cannot cross a project or isolation boundary.
   `populationDigest` binds exact `{ episodes, normalizationPolicyDigest,
   comparabilityPolicyDigest }`, not the episode array alone.
   Direct and contradictory EvidenceRefs must also carry the derivation's exact
   scope digest. Supersession binds the predecessor scope digest and cannot
   cross a project or isolation boundary. Population episode record ids use the
   4,096-character durable-id bound.
10. **Content/digest pairs are exact.** Detector configuration, thresholds,
    false-positive policy, calibration population, proposed validation
    criterion, and lens objective/rubric/validation strategy carry minimized
    public-safe content and adjacent lower-case SHA-256 digests. Parsers
    recompute every pair. Lens generator, reviewer, and disclosure policies
    carry their exact policy digests; required fingerprint/calibration ids are
    sorted and bound directly. Nullable content/digest fields are present
    together or absent together, including validation comparable-population
    content. Required detector configuration, false-positive policy, proposed
    validation criterion, and qualitative rubric are non-null JSON objects;
    present thresholds and calibration populations are also objects. Private configuration and low-entropy
    recurrence use tenant-keyed host treatment rather than leaking secrets into
    these records.
11. **Version and maturity changes are append-only.** One `(id, version)` has
    one digest. Any semantic field change requires a version bump and exact
    `supersedes` lineage. Maturity promotion also creates a new version.
    `calibrated` and `stable` require calibration population and evidence;
    `deprecated` registrations are non-executable and supersede the last active
    version. Historical derivations remain bound to their original detector,
    pack, lens, maturity, configuration, and fixtures.
12. **Missing capability is never pass.** The future execution record must use
    `applied`, `not_applicable`, and `incomplete`; an applied negative condition
    is not a quality pass. Empty windows make no provider call. This decision
    reserves that behavior but does not claim the engine exists in #30a.
13. **The root export increase is deliberate.** #30a adds exactly
    `scopeDigest`, `DetectorMaturity`, `DetectorOutputKind`, `LearningClass`,
    the four record types, their four digest functions, and their four
    unknown-first parsers. Registration helpers, execution records, detector
    engines, packs, provider workflows, and calibration utilities are not
    smuggled into this export change.

## Digest inclusion

| Record | Included | Excluded |
| --- | --- | --- |
| `DetectorRegistration` | Every field from id through supersedes, including full content and verified adjacent digests | `schemaVersion`, `registrationDigest` |
| `DetectorPackManifest` | Id, version, kind, exact detector/lens refs, changelog and supersession | `schemaVersion`, `manifestDigest` |
| `LearningLensRegistration` | Every field from id through supersedes, including objective, rubric, requirements, policies, strategies and adjacent digests | `schemaVersion`, `registrationDigest` |
| `InsightDerivation` | Every field from scope through producer, paired intervention/validation, same-scope supersession, full evidence, and complete evidence-health findings | `schemaVersion`, `id`, `derivationDigest` |

Set-like arrays are sorted and unique. Evidence, population, support, guardrail,
and validation arrays preserve declared order where order carries meaning and
remain duplicate-free. Scope entries recompute `scopeDigest`.

## Migration and sequencing consequences

- Existing source, episode, Candidate, review, outcome, receipt, and evidence
  bytes are unchanged. New semantic records are additive store kinds.
- Candidate v2 already carries optional `{ id, digest }` `derivationRef`.
  Detector-generated proposals must ask `propose` to load and derive that exact
  ref. Existing v2 Candidates without one remain valid manual proposals but
  cannot claim detector/lens lineage. Nothing auto-migrates.
- Selected detector, pack, and lens digests enter a future immutable loop
  registry revision, intentionally invalidating old opaque query cursors.
- Cormidia keeps org/app/role mapping, schedules, prompts, budgets, GitHub,
  approvals, and destinations in its adapter. The standalone package imports
  nothing from Cormidia.
- **Implemented in #30a:** the four record contracts, canonical digests,
  unknown-first parsers, scope digest, public exports, and conformance vectors.
- **Deferred to #30b:** immutable implementation pairing, loop-registry
  selection, `DetectorExecutionRecord`, typed execution/query views, and
  Candidate derivation-ref resolution, including verification that embedded
  evidence-health findings belong to the derivation's exact source/scope
  lineage.
- **Deferred to #30c:** eligibility/capability checks, exact population folds,
  pack selection, recurrence, clustering, deduplication, suppression, caps,
  dry-run results, and no-provider-on-empty execution.
- **Implemented by decision 0019 for #30d:** an opt-in host-bound core and
  reference-operational bundle, normalized structural vocabulary requirements,
  hermetic controls, personal two-project isolation, and exact
  Support/Documentation lens examples. Source requirements remain inert rather
  than capability grants, and calibration remains deferred to #26.
- **Implemented privately by decision 0021 for #13a:** provider-neutral
  workflow/turn definitions, exact minimized application-content byte intent,
  outbound authorization, create-only dispatch claims, closed sanitized result
  metadata, and scope-private receipt-last persistence—without egress, a public
  export, or completed output persistence.
- **Deferred to #13b/#13c:** nonforgeable prepared preview/provider capabilities,
  typed generation and actual handoff, then advisory qualitative review.
  Decisive calibrated model review remains #26.
- **Deferred to #26:** held-out candidate-utility calibration and any
  default-quality claim.

## 2026-08-20 implementation amendment

Decision 0009 implements private receipt-last persistence and typed audit
reads previously deferred to #30b. Decision 0010 implements derivation-backed
Candidate proposal and producer-independent review. Decision 0011 implements
single-detector execution in #30c1; orchestration stays #30c2.
