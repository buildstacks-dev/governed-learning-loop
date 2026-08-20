# 0013 — Privacy-treated detector recurrence lineage

**Date:** 2026-08-20
**Status:** ratified — issue #30c2b1 recurrence lineage

## Context

Decision 0012 can execute an exact selected pack and report bounded child
dispositions, but every execution remains an isolated fact. Deduplication and
rejection suppression need a stable recurrence identity that can join the same
registered condition across exact populations and packs without joining
projects, lenses, detector versions, or private low-entropy values.

The first recurrence slice must establish that lineage before defining policy.
It must not infer a key from interpretation text, derivation or Candidate
content, counts, or a portable unsalted hash. It also must preserve c1's
existing-receipt terminal rule and byte-stable DetectorExecutionRecord and
InsightDerivation identities.

## Rulings

1. **A recurrence locator is an implementation output, not an observation.**
   DetectorRecurrenceLocator is a closed union:
   `public_structural { structuralLabel }` or
   `tenant_keyed_private { keyedDigest, keyPolicyDigest }`. Public labels are
   lower-case NFKC-stable ASCII tokens of at most 200 characters matching
   `[a-z0-9](?:[a-z0-9._:-]*[a-z0-9])?`. Private
   locators carry only a lower-case SHA-256 tenant-keyed digest; raw key
   material never crosses the callback boundary or persists.
2. **Registration privacy constrains the locator.** A detector with
   `signatureTreatment: none` cannot return one. `public_structural` and
   `tenant_keyed_private` accept only their matching branch; `mixed` accepts
   either. A private locator's keyPolicyDigest must exactly equal the detector
   privacy policy digest. The host-attested implementation is responsible for
   computing the keyed digest with the correct tenant secret and domain; the
   kernel never receives that secret.
3. **Draft compatibility is additive.** DetectorResultDraft adds optional
   `recurrenceLocator?: DetectorRecurrenceLocator | null`. Omission and null are
   equivalent, so every existing c1/c2a callback remains valid. Only
   `applied && conditionDetected` may carry a non-null locator. A negative,
   non-applicable, or incomplete result cannot manufacture recurrence.
4. **Run results separate execution from recurrence state.** Every
   DetectorRunResult adds a mandatory `recurrence` union:
   `grouped`, `execution_not_materialized`, `execution_not_applied`,
   `condition_not_detected`, or `locator_unavailable`. The non-applied branch
   retains the exact `not_applicable | incomplete` execution status. A grouped
   result carries the exact group-key digest, parsed locator, distinct episode
   identity count, and committed/projected execution count. No branch is a
   pass, harm judgment, preference, utility score, or efficacy verdict.
5. **Group identity excludes distribution.** The group key is the SHA-256
   digest of exact canonical content:

   ```text
   {
     domain: "detector-recurrence-group:v1",
     detector: {
       id, version, registrationDigest,
       configurationDigest, implementationDigest
     },
     lens,
     scope, scopeDigest, scopePolicyDigest,
     locator
   }
   ```

   Exact detector semantics, purpose lens, scope/isolation policy, and treated
   locator therefore isolate groups. Pack, loop-registry revision, population,
   evidence, outputs, interpretation, Candidate content, policy, and
   disposition are excluded. A pack is distribution metadata: moving the same
   exact detector/lens/scope/locator between packs must not bypass future
   deduplication or suppression. Every member still retains its exact pack and
   population lineage.
6. **Execution recurrence decisions are create-only.** Every newly evaluated
   detected execution writes one private ExecutionRecurrenceBinding at
   `detector-recurrence-binding/<executionId>`. It binds schema version, exact
   execution id/key/full digest, exact detector/pack/lens/scope and scope-policy
   lineage, nullable parsed locator, paired nullable group-key digest, exact
   nonempty canonical-unique episode id/identity/view members, and
   bindingDigest. A null pair records the
   callback's durable `locator_unavailable` decision and creates no group
   member. `bindingDigest` includes every preceding content field except schema
   version and itself. The same execution and decision is idempotent; null,
   another locator, or another execution result for that id conflicts before
   receipt. Historical receipts remain distinguishable because they have no
   binding at all.
7. **Qualified group members are append-only.** Only a non-null locator/group
   decision appends a private RecurrenceGroupMember under
   `detector-recurrence-group/<groupKeyDigest>`. It binds group,
   execution id/key/full digest, binding digest, exact pack, and memberDigest.
   Episode lineage remains once in the exact binding/execution and is loaded
   from that binding during folds rather than being duplicated in the group
   stream. The stream entry id is
   `execution:<executionId>:<executionDigest>` and the entry digest binds the
   complete member value. Group folds reparse unknown values and require the
   exact member, binding, privacy policy, detected-applied execution receipt,
   and population lineage to agree before counting it.
8. **Only exact committed members count.** `executionCount` counts distinct
   exact committed DetectorExecutionRecord receipts with exact binding/member
   lineage. `distinctEpisodeCount` unions their exact
   `episodeIdentityDigest` values; duplicate record ids, view digests, or
   repeated executions of one logical episode do not inflate recurrence.
   Counts are descriptive only.
9. **Dry-run counts are explicit previews.** A fresh grouped dry-run folds the
   exact currently committed group and adds its would-be execution once. It
   writes nothing. If the execution is already committed and bound, it is not
   added twice. Commit writes the exact binding and member, creates the
   execution receipt last, then reloads durable group counts. A later read may
   observe additional concurrent exact members; these counts are not a frozen
   calibration or experiment population.
10. **Receipt-last crash lineage is preserved.** The create-only execution
    scope index first locks the exact execution result digest. Recurrence
    binding and member follow that lock and still precede the detector execution
    receipt. This prevents losing-result lineage from poisoning the result that
    can win the receipt. An index/binding/member without that exact receipt is
    an orphan and contributes no count or authority. Same-byte retry after a
    failure or lost acknowledgement at lock, binding, member, or receipt
    forward-completes one exact graph. A receipt plus binding without its exact
    member, a mismatched member/binding/execution, a forbidden stored locator,
    or a self-digest/key mismatch is corruption. Append retry exhaustion is a
    typed store conflict.
11. **Historical executions are never backfilled.** An existing c1/c2a
    detected execution without a recurrence binding returns
    `locator_unavailable` and skips its callback permanently. Reading or
    rerunning does not infer a locator from output content and does not create a
    private binding. Existing execution and derivation bytes and digests remain
    unchanged.
12. **Folds are bounded and fail closed.** One group admits at most 5,000
    member entries, 50,000 total episode references across exact bindings, and
    5,000 distinct episode identity digests. Each exact ceiling is valid; the
    next value fails typed. Raw stream length is checked before entry parsing,
    and episode references are accumulated with bounded iteration rather than
    a flat unbounded allocation. Nothing truncates a group or returns a partial
    count. Orphans are excluded from returned counts only after their stored
    structure and exact binding relationship validate; malformed durable state
    is corruption.
13. **The public-surface increase is one type.** C2b1 exports only
    DetectorRecurrenceLocator. DetectorResultDraft and DetectorRunResult gain
    fields under existing symbols; private binding/member types, parsers,
    digests, fold helpers, and persistence remain unexported. The root snapshot
    increases from 146 to 147.

## Persistence order

For an exact newly evaluated detected execution, private receipt-last commit is:

1. validate the execution, evidence, derivations, locator treatment, prospective
   group capacity, and exact stable semantic snapshot;
2. persist the semantic registry snapshot, output health, derivation links,
   derivations, and derivation indexes;
3. create the exact execution scope-index result lock;
4. create the exact nullable execution recurrence decision binding;
5. for a qualified non-null locator, append the exact recurrence group member;
6. create DetectorExecutionRecord last;
7. reload and verify execution, binding, member, and current bounded counts.

The pack façade passes only the kernel-parsed locator from its private child
plan into this path. Callers still have no execution or recurrence writer.

## C2b1 and C2b2 sequencing

**Implemented in #30c2b1:** privacy-treated locator parsing, detector-policy
matching, pack-independent group identity, private create-only execution
bindings, append-only exact group members, receipt-last crash recovery,
bounded committed folds, dry-run previews, and public recurrence state on
DetectorRunResult.

**Implemented next by decision 0014:** an immutable orchestration policy,
lower host-configured invocation ceiling, separate transient insight and
evidence-health group caps, and explicit unassessed/capped reporting.
Suppression configuration is content-bound but non-enforcing.

**Implemented next by decision 0015:** durable normalized pack-run receipts,
receipt-last exact-scope indexes/query/view, immutable not-assessed governance
snapshots and historical/current audit separation.

**Implemented next by decision 0016:** private content-addressed
derivation-to-group claims, one exact nullable recurrence decision for every
new Candidate, claim-before-receipt recovery, and inline CandidateView
recurrence lineage.

**Still deferred:** Candidate/review assessment, deduplication,
decisive-rejection suppression and override evidence, assessed pack receipts,
and proposal admission. The recurrence, policy, receipt, and claim slices do
not refuse a Candidate because another claim exists.

**Implemented later by decision 0017:** observational Candidate/review
frontier assessment and current/historical assessed receipt views. Enforced
deduplication, suppression, override, and proposal admission remain deferred.

Reference detector contents and fixtures remain #30d. Optional semantic/model
workflows remain #13. Candidate-utility calibration and every quality or
improvement claim remain #26. Scheduling, provider routing, cost/time budgets,
publication, authorization, exposure, and activation stay outside this slice.

## Migration consequences

- DetectorExecutionRecord, InsightDerivation, Candidate, review, registry, and
  existing source/evidence bytes are unchanged. The two private recurrence
  kinds are additive.
- Existing callback output remains valid because recurrenceLocator is optional.
  DetectorRunResult consumers see one new mandatory, read-only recurrence
  field and must handle every closed status.
- Existing exact receipts remain terminal. Missing historical binding is
  `locator_unavailable`, never an invitation to rerun or migrate.
- Pack changes do not fork group identity. Detector, lens, scope-policy,
  implementation, configuration, locator treatment, or key-policy changes do.
- C2b1 adds no Candidate authority, provider dependency, destination,
  activation path, or efficacy metric. Decision 0014 adds only non-enforcing
  policy registration/transient caps; decision 0015 adds audit receipts/reads
  without Candidate governance; decision 0016 adds only private observational
  Candidate/group claims.
