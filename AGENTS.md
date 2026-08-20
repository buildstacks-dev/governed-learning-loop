# AGENTS.md

## What this repo is

The standalone **governed adaptation kernel** extracted from Cormidia
(`research/2026-08-12_learning-loop-library/` in the Cormidia repo is the
originating proposal). This repository is the **source of truth** for the
learning-loop protocol and implementation; Cormidia becomes a consumer of this
package, never the other way around.

`docs/contract/api-contract.md` is the ratified public contract. On conflict
between code and contract, open an issue — never silently drift either one.
`docs/decisions/` records dated deviations and rulings.

## Working rules

- **Every change lands through a PR and squash-merge.** Never push directly to
  `main` after the bootstrap commit.
- **Parse, don't cast.** Everything crossing a trust boundary (file/store
  reads, transcript records, subprocess output, caller input at the façade)
  arrives as `unknown` and goes through a runtime validator that throws or
  returns typed diagnostics. Types flow from validators; a bare `as T` at a
  boundary is a defect. `any`, `as`, and non-null `!` are gate failures, not
  style choices; `unknown` plus narrowing is the sanctioned exit.
- **Zero runtime dependencies in the root package.** `node:` built-ins only.
  No model-provider SDKs anywhere in this repo. Adding any dependency is a
  decision recorded in `docs/decisions/`, not a convenience.
- **No Cormidia imports.** The kernel must compile and test with no knowledge
  of Cormidia's org, loop, runtime, scheduler, GitHub operations, or prompts.
  Cormidia-specific mapping lives in Cormidia's adapter layer, in the Cormidia
  repo.
- **Never weaken a gate or test to make something pass.** Extend cases; never
  soften one. Every defect fix deposits its detector in the same PR.
- **Public surface is budgeted.** New exported symbols from the root are an
  explicit decision (export-ratchet test). Orchestration internals stay
  private.
- **Public reads are domain-typed and bounded.** Consumers, including examples,
  use the façade's observation, measurement, episode, and candidate views.
  Engine namespaces and record kinds are private implementation details. Query
  cursors are opaque, and append-visible page revisions are never treated as a
  frozen detector, calibration, or experiment population.
- **Source health is durable and separate from learning.** Every source page
  declares an opaque, privacy-treated source/page identity and a closed
  availability state. Receipt-last persistence binds exact registration,
  policy, revision, derivative, count, and normalized diagnostic lineage.
  A private create-only page-owner claim prevents concurrent pages from both
  committing one derivative; reasserted records are counted as reused without
  creating a second commit receipt.
  Missing, unreadable, unsupported, corrupt, partial, or revision-changed
  evidence produces closed evidence-health records; it is never silently an
  empty successful page or a behavioral candidate.
- **Candidate evidence is kernel-resolved and content-bound.** Callers request
  exact durable observation or qualified measurement ids; only `propose` may
  resolve records, episode identity, scope, and source-page receipts into
  ordered, nonempty, duplicate-free Candidate-v2 `EvidenceRef` values.
  Candidate v1 remains
  byte-stable, `legacy_unbound`, and audit-only, with no automatic migration. A
  successor is an explicit new proposal with exact predecessor lineage.
  Candidate views expose closed evidence-health and derivation-lineage states;
  neither grants trust or authority.
- **Derivation-backed proposals are resolved, never copied.** Their mandatory
  scope is a locator for an exact committed/current InsightDerivation. Problem,
  hypothesis, direct-then-contradictory evidence, intervention, and derivation
  ref are kernel-derived; caller overrides are refused. Empty Candidate-v2
  evidence is permitted only for exact committed episode-population lineage.
  Candidate and derivation supersession mirror, and decisive review is
  independent from both verified proposer and attributed producer. Producer
  principal, domain, and implementation separation is unconditional under the
  lens; proposer-domain separation remains risk-policy gated.
- **Measurements and outcomes are ownership-bound.** Runtime values exactly
  match their metric value type. Qualified measurement references bind a
  nonempty ordered set of same-source, same-revision, same-episode observation
  references. Normal ingest appends retained outcome claims; raw legacy outcome
  ids, missing values, ownership mismatches, and incomplete evidence never pass
  or become zero.
- **Semantic dimensions stay independent.** Scope says where learning applies;
  a registered lens says what good means; learning class says which semantic
  altitude is considered; a detector says which condition was observed; a
  destination says what may change. Roles and provider categories are host
  data, never kernel enums.
- **Registered semantics are immutable and inert.** Detector, pack, and lens
  records bind full minimized content plus verified digests. InsightDerivation
  keeps direct observation, uncertain interpretation, impact hypothesis,
  intervention, and validation separate. Evidence health remains a separate
  record family, packs grant no authority, and only verified `propose` may
  create a Candidate. Registered records do not imply an installed detector
  engine, selected reference bundle, semantic-provider workflow, or measured
  candidate utility.
  Lens evidence requirements may name observation, measurement, or exact
  episode-population evidence; episode trust/completeness comes from reloaded
  digested identity records.
- **Semantic capability is host-granted and registry-bound.** A
  `SourceSemanticProfile` belongs to one exact configured source registration;
  it is never an adapter claim. Absence grants zero detector capabilities while
  preserving generic ingest compatibility. When present, undeclared normalized
  observation kinds are rejected. The optional semantic registry snapshots
  full installed records and exact selected detector/pack/lens refs; omitting it
  preserves the prior loop-registry bytes. Installation and selection grant no
  authority.
- **Detector execution facts are closed and engine-owned.** An execution binds
  one exact invocation/window, required pack, output-dependent lens, immutable
  episode-view population, full input/output evidence-health records, and the
  exact sorted capability union. Its key excludes the result and its full
  digest includes it; a different result for the same key is a conflict. Only
  `applied`, `not_applicable`, and `incomplete` exist—never `pass`. Public
  parsing does not authorize public execution minting. Persistence is a private
  receipt-last graph whose append-only links precede derivations and whose
  execution receipt is last.
- **Deterministic detector code is capability-bound.** Only a factory-minted
  RegisteredDetectorImplementation can pair synchronous code with an exact
  DetectorRegistration. The kernel constructs provider-neutral windows and
  mints all lifecycle/semantic lineage; callbacks cannot choose
  not-applicable/incomplete, trust, ids, digests, Candidates, or authority.
  Promise/thenable results are forbidden. A new dry-run evaluates eligible code
  with zero kernel/store writes; commit rematerializes and evaluates again. An
  exact committed receipt is terminal for either mode and skips evaluation.
  Empty or unusable windows never invoke the callback, and hard ceilings fail
  without truncation.
- **Reference detectors are opt-in structural examples.** The
  `/reference-detectors` factory accepts an exact host namespace, scope-policy
  digest, and sorted purpose lenses, then returns host-bound experimental core
  and operational registrations, manifests, synchronous implementations, and
  inert source requirements. It never creates a source profile, registry,
  selection, loop, recurrence locator, Candidate, Review, provider call, or
  effect. Every positive result emits at most one fixed structural derivation
  with null intervention/validation. Counts do not establish harm,
  inefficiency, preference, utility, or efficacy. Missing/unreadable/unsupported
  coverage remains native source health, not a detector. Calibration and every
  default-quality claim remain #26.
- **Semantic generation is factory-bound, exact, and inert.** Decisions 0021
  and 0022 keep definitions, reservations, authorization, dispatch, results,
  plan/attempt/completion sidecars and receipt-last persistence private. The
  `/workflows` subpath exports only `SemanticWorkflowBundle` and
  `createSemanticWorkflowBundle`; definition/schema setup is carried on the
  frozen factory. Prepared plans and outbound authorization are loop/bundle-
  bound capabilities. Preparation writes nothing, includes the complete
  kernel-materialized window in the exact previewed application payload, and
  estimates tokens once. A run revalidates current registry/window/source/
  privacy/expiry twice, persists reservation→plan→authorization iff
  outbound→scope+definition attempt, and permits one callback only on a newly
  created dispatch. Existing dispatch never redispatches. Provider output is
  descriptor-snapshotted once, hard-bounded by exact canonical bytes, measured
  and tenant-key-digested by the kernel, then admitted only through the fixed
  typed DetectorResultDraft schema into the ordinary
  DetectorExecution/InsightDerivation graph. Request/preview/raw-response/
  native-provider-receipt/error bytes never persist. Authorization is not proof
  of disclosure, and application callback bytes are not provider wire proof.
  Process recovery is attempt-index-first, scope-and-definition private, invokes
  no provider/authority, ignores current expiry only for known post-dispatch
  facts, and leaves dispatch-only ambiguity `outcome_unknown`. Positive semantic
  recurrence is explicitly locator-unavailable. Detector/semantic window
  evidence resolves at most 5,000 exact refs through its batch fold; Candidate
  proposal keeps its independent 1,000-ref cap. No workflow method creates a
  Candidate/Review, proposal admission, publication, activation, validation,
  effect, authority, utility, efficacy, or calibration claim. #13c owns
  advisory review; decisive calibrated review remains #26.
- **Pack orchestration is bounded and transient.** `runDetectorPack` derives
  exact selected detector/compatible-lens pairs for one caller-declared scope
  and episode population, orders them by protocol code-unit keys, and reports
  every bounded cap or refusal with callback-attempt visibility. It admits at
  most 100 child runs, retains at most 100 unique new content-addressed output
  records and 64 MiB of canonical child results, and never truncates one
  child. Dry-run writes
  nothing; commit persists exact child graphs sequentially and is not a batch
  transaction. C2a creates no pack receipt, durable cap/suppression policy,
  Candidate, provider turn, or authority.
- **Recurrence lineage is privacy-treated and receipt-last.** A detector may
  optionally emit one canonical public structural locator or tenant-keyed
  private digest permitted by its exact privacy registration; raw private key
  material never crosses or persists. Group identity binds exact
  detector/lens/scope semantics but excludes pack distribution and population.
  The create-only execution scope index locks the result, then a create-only
  nullable recurrence decision locks locator availability before any qualified
  member append; the execution receipt remains last.
  Orphan crash remnants do not count, and historical unbound receipts are
  never backfilled. Folds fail closed above 5,000 members, 50,000 total episode
  references, or 5,000 distinct episode identities. Counts are descriptive
  only. C2b1 grants no deduplication, suppression, Candidate, authority,
  utility, or efficacy claim.
- **Orchestration policy is inert until a separate admission snapshot uses it.** An
  optional immutable DetectorOrchestrationPolicy contributes its exact digest
  to loop identity, may lower the 100-child callback ceiling, and separately
  classifies retained exact insight/evidence-health recurrence states as
  `not_grouped | unassessed | capped`. Group caps are transient reporting
  dispositions: no-result items omit the unknown classification, and caps do
  not truncate or block exact child persistence.
  rejectionSuppression bytes are registered and digested but remain
  non-enforcing in policy, receipt, claim, and assessed-view records. Only the
  decision-0018 serialized pre-write admission graph may enforce them for a
  subject Candidate.
- **Pack receipts are retry-stable, scoped audit facts.** Only a configured
  commit with a one-to-one exact-scope population may create a
  DetectorPackRunReceipt; dry, policy-omitted, missing or wrong-scope inputs
  create none. Durable items normalize away callback and `existing` state,
  bind full policy/registry/population/child/recurrence/governance lineage, and
  contain only stable reason codes. Child graphs and the exact registry
  snapshot precede a scope-private result lock; the receipt is last and is not
  a transaction across children. Reads require exact scope and revalidate every
  child and recurrence reference. Observational assessed bytes bind an exact
  active Candidate/review frontier but grant no proposal refusal, suppression,
  authority, utility or efficacy.
- **Recurrence claims are private and observational.** Exact grouped
  derivations append content-addressed same-group execution claims before the
  execution receipt. Every new Candidate first freezes an exact Candidate-v2
  snapshot in a `manual`, `derivation_unbound`, or grouped recurrence decision;
  the content-ownership lock binds that full decision/Candidate before the
  optional group append and Candidate receipt. Grouped decisions freeze exact
  proposal-time recurrence members and the full episode-identity baseline;
  later group growth is only a current superset. Historical Candidates are
  never backfilled. CandidateView exposes the closed recurrence-lineage status,
  but this slice does not deduplicate, suppress, refuse, review, authorize,
  validate, or claim utility. Raw malformed claim graphs remain
  `schema.corrupt` or `store.corrupt`.
- **Assessed recurrence receipts and views are descriptive.** Every new Candidate has a
  private review-history marker before its receipt; exact review refs append
  before Review receipts and latest means committed append order. Uncapped
  insight groups classify only the exact active frontier under one shared pure
  parser/runtime matrix. Capped insight and evidence-health groups do no
  Candidate assessment work. Pre-marker or typed-incomplete active frontiers
  remain explicitly not assessed. Pack build/direct/page folds share bounded
  caches and fail above 50,000 governance work units. Current, historical,
  invalid, commit, registry, policy, and evidence-health dimensions stay
  separate. A receipt/view classification grants nothing; admission separately
  freezes the same pure classifier before a subject proposal writes facts.
  Candidate evidence/derivation revalidation still inherits global evidence
  revision/scanning work; do not claim fully scope-local assessment work until
  exact-reference source-receipt/health indexes replace that debt.
- **Configured recurrence admission is serialized and receipt-last.** A
  derivation-backed grouped Candidate under an exact configured policy must
  pass two identical policy/registry/group/frontier reads before any proposed-
  Candidate write. Empty groups admit once; revise and eligible rejection
  branches require exact same-group supersession; deduplicated, ambiguous,
  below-threshold, typed-incomplete, and recursively invalid subject frontiers
  refuse generically. A sole exact non-subject pre-marker predecessor may
  migrate only through mirrored supersession. One per-group CAS slot orders
  contenders without a shared journal. Durable order is recurrence decision,
  neutral content lock, review marker, snapshot, reservation, slot, binding,
  group member, then Candidate receipt. Forward recovery may prove cached
  presence but must reload cached absence; it never extends an unvalidated
  tail. Slotted snapshot+reservation history is capped at an aggregate 64 MiB,
  including the prospective pair before slot append. CandidateView exposes
  closed admission lineage; invalid blocks review before and after callback,
  while exact historical admission remains reviewable. The trusted host must
  exclusively cut over the group/scope: concurrent old or policy-unconfigured
  writers remain non-subject and are outside the enforcement claim. Admission
  grants no publication, authority, validation, utility, or efficacy and adds
  no root export.
- **Semantic audit reads require exact scope.** Public derivation/execution
  queries and gets never enumerate without a caller-supplied exact scope.
  Their private pagination/get indexes live in a namespace derived solely from
  that scope digest; foreign-scope targets and cursors are never consulted.
  Commit binding, current-registry binding, and current evidence health remain
  separate. Orphaned, invalid, and historical facts are audit-visible but
  inert. Composite pages retry boundedly on graph churn and are never treated
  as frozen calibration or experiment populations.
- **Testing utilities are runtime-safe.** Importing `/testing` outside a test
  worker must not load or register a test framework. Public conformance runners
  receive the caller's minimal `{ describe, expect, it }` API explicitly, and
  every store adapter runs the same suite through that injected seam.
- **ESM only, strict TypeScript.** Subpath exports (`.`, `/node`, `/testing`,
  `/reference-detectors`, `/workflows`) with no supported deep imports.

## Non-negotiable kernel invariants

These are protocol rules, not configuration:

1. A **candidate is inert** — it can never resolve into active context, and
   the kernel never turns model output into an entitlement.
2. **Generation and review are attributed and independent** — the same
   verified principal must not both propose and provide the decisive review.
3. **Authorized ≠ validated**, permanently. Policy permission and measured
   improvement are different records; neither implies the other.
4. **Approvals bind exact content** — changing content, destination, scope, or
   base voids the binding.
5. **Missing or invalid measurement is never zero and never a pass.**
6. **Trust is granted by host registration, not claimed by adapters** —
   transcript-derived evidence is capped at `advisory`.
7. **Verified principals are loop-bound capabilities** — only a kernel-created
   identity port may mint them, and propose/review accept a handle only from
   the exact identity-port instance configured on that loop.

## Transcript adapter privacy rules

- Explicit inputs only (user-selected paths or caller-owned readers); an
  adapter never crawls a home directory on its own initiative.
- Redaction precedes persistence: raw message text does not enter the durable
  store by default — only minimized, structural features.
- No outbound model calls by default; enabling them requires explicit opt-in
  and an exact preview of outbound bytes.
- Byte/record/nesting/time ceilings fail closed.
- Logs and diagnostics never echo transcript content.

## Testing expectations

Minimum for any change: `pnpm test && pnpm typecheck` (and `pnpm check` before
a PR). Conformance suites are part of the API: invariants ship as executable
tests, and every adapter (store, source, destination) must pass its conformance
runner. Golden vectors pin canonical bytes and digests across runtimes.

## Maintenance

When a change alters architecture, commands, conventions, API contracts, or
privacy behavior, update this file and the relevant `docs/` page in the same
PR. When adding a subsystem, add or update the nearest AGENTS.md.
