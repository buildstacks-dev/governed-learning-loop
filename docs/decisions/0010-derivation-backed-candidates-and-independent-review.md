# 0010 — Derivation-backed Candidates and independent review

**Date:** 2026-08-20
**Status:** ratified — issue #30b2b Candidate resolution

## Context

Decision 0009 made InsightDerivation records durable, scope-isolated, and
auditable, but only the manual CandidateInput path could create an inert
Candidate. Allowing callers to copy semantic fields into that path would lose
the exact detector, lens, producer, counterevidence, population, and validation
lineage and would permit caller-supplied overrides.

Episode-only structural derivations also expose a deliberate schema tension:
Candidate v2 historically required at least one EvidenceRef, while a committed
InsightDerivation may be grounded entirely in an exact episode population. The
kernel needs a narrow additive exception without weakening manual candidates
or inventing an episode EvidenceRef.

## Rulings

1. **CandidateInput becomes an honest two-branch union.** The existing manual
   branch remains unchanged. A derivation branch contains only id, mandatory
   Scope locator, derivationId, proposed risk, verified proposer, and optional
   Candidate predecessor. It accepts no caller problem, hypothesis, evidence,
   intervention, derivation digest, or execution id. Supplying both branch
   shapes is an ambiguous trust-boundary error, not an override.
2. **Scope is a locator, not an assertion.** The derivation branch resolves the
   private exact-scope index before any target record. Missing and wrong-scope
   ids have the same refusal. The Candidate scope is copied from the resolved
   derivation and must equal the locator exactly.
3. **Only eligible derivations may be proposed.** The exact InsightDerivation
   view must be committed, configured by the current registry, and
   evidence-health ready. Interpretation, impact hypothesis, Candidate
   intervention, and validation must be non-null. Destination id, content
   draft, and rollback intent must be concrete. No provider call occurs.
4. **Candidate mapping is deterministic.** Candidate problem is the
   interpretation statement; hypothesis is the impact-hypothesis statement.
   EvidenceRefs concatenate direct-observation refs followed by contradictory
   refs, preserving order and rejecting duplicates across the combined list.
   Destination id/kind/content/rollback map from the proposed intervention.
   `derivationRef` is exact `{ id, digest }`. Proposed risk and proposedBy stay
   host-supplied governance facts; semantic output cannot lower risk or claim a
   verified proposer capability.
5. **Population-only Candidate v2 is a narrow exception.** A manual Candidate
   v2 still requires nonempty EvidenceRefs. A Candidate v2 with an exact
   derivationRef may use an empty list only when the resolved derivation has a
   nonempty, committed, current, evidence-health-ready episode population.
   Candidate v2 schema and canonical digest bytes do not change. The parser
   requires nonempty evidence or a derivationRef and requires
   `derivationRef.id === insight-${derivationRef.digest}`; store-backed views
   enforce the population condition.
6. **Candidate and derivation revision lineage mirror.** A derivation-backed
   Candidate has Candidate supersession exactly when its derivation has
   derivation supersession. The Candidate predecessor must itself carry a
   derivationRef equal to the derivation predecessor id/digest, and both chains
   retain their existing exact-scope and exact-original-digest rules. A manual
   predecessor or mismatched chain is refused rather than silently bridged.
7. **Proposal attribution and generation attribution remain distinct.** The
   Candidate proposedBy principal is the verified requester of the governed
   transition. The InsightDerivation producer remains the attributed generator
   through the exact derivation ref. Neither identity overwrites or impersonates
   the other, even when they happen to name the same principal.
8. **CandidateView exposes derivation lineage.** `derivationLineage` is
   `not_bound`, `resolved` with the exact InsightDerivationView, or `invalid`
   with diagnostics and an optional inspectable InsightDerivationView.
   `resolved` is reserved for a fully eligible exact Candidate/derivation
   mapping. Historical, orphaned, incomplete, invalid, or mapping-mismatched
   artifacts remain inspectable through the invalid branch without looking
   resolved. Candidate evidence health combines current Candidate refs with
   current derivation/execution health.
9. **Governance revalidates the mapping.** Stored derivation-backed Candidates
   must still match exact scope, problem, hypothesis, ordered evidence,
   intervention, and derivation id/digest. Missing or mismatched lineage,
   non-committed execution, historical registry, or non-ready evidence blocks
   review and publication without rewriting Candidate or review bytes.
10. **Review is independent from both promotion and generation.** Reviewer
    principal differs from Candidate proposedBy and from a non-null derivation
    producer principal. The lens's mandatory independent-from-generator policy
    always requires a different domain from a non-null producer principal.
    Proposer-domain separation remains gated by host risk policy. Reviewer
    implementation id/version also differs from the derivation producer
    implementation id/version, including a deterministic producer with no
    principal.
11. **Review receives detached derivation bytes.** CandidateReviewer input adds
    `derivation: InsightDerivation | null`, parsed and detached from the record
    used for binding. The engine checks the full InsightDerivationView but does
    not hand mutable view/governance objects to the external port. Lineage,
    evidence, producer independence, and exact Candidate bytes are revalidated
    before the callback and again after it returns. Calibration policy remains
    #13 work.
12. **The Candidate remains inert.** A derivation-backed proposal cannot
    authorize, publish, expose, validate, or establish utility. It only creates
    new Candidate-v2 governance content through the existing verified propose
    transition.
13. **No root symbol is added.** CandidateInput and CandidateView evolve in
    place, CandidateReviewer gains an inline input field, and Candidate v2's
    existing derivationRef becomes executable lineage. The public export count
    remains 137.

## Exact derived mapping

| Candidate field | InsightDerivation source |
| --- | --- |
| `scope` | `scope` |
| `problem` | `interpretation.statement` |
| `hypothesis` | `impactHypothesis.statement` |
| `evidenceRefs` | `directObservation.evidenceRefs`, then `contradictoryEvidenceRefs` |
| `intervention.destinationId` | `candidateIntervention.proposedDestinationId` |
| `intervention.kind` | `candidateIntervention.proposedDestinationKind` |
| `intervention.content` | `candidateIntervention.contentDraft` |
| `intervention.rollbackIntent` | `candidateIntervention.rollbackIntent` |
| `derivationRef` | `{ id, digest: derivationDigest }` |

Interpretation confidence, uncertainty, direct structured observation,
counterevidence classification, missing evidence, applicability, producer,
validation, and full population remain content-bound indirectly through the
derivation digest.

## Migration and sequencing consequences

- Candidate v1 bytes and permanent legacy-unbound status are unchanged.
- Existing manual Candidate v2 bytes, digests, and proposal calls are
  unchanged and report `derivationLineage: { status: "not_bound" }`.
- Existing Candidate v2 values with a derivationRef are revalidated. Missing,
  malformed, or mapping-inconsistent lineage becomes parse-invalid or
  governance-blocked; nothing is auto-repaired or auto-proposed.
- The population-only exception amends decision 0005 only for an exact
  committed derivationRef. A caller-created manual Candidate with empty
  evidence remains invalid.
- No new root export, store record kind, provider SDK, or public execution
  writer is introduced.
- Decision 0011 implements exact deterministic single-detector execution in
  #30c1; pack orchestration and scheduling remain #30c2. #13 owns
  semantic-provider and reviewer calibration workflows. #26 owns
  candidate-utility measurement and any quality claim.
