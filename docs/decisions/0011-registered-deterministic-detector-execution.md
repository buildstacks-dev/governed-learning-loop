# 0011 — Registered deterministic detector execution

**Date:** 2026-08-20
**Status:** ratified — issue #30c1 deterministic runner

## Context

Decisions 0008–0010 bind detector semantics, exact execution facts, private
receipt-last persistence, and derivation-backed Candidate governance. They do
not yet provide a public-safe way for a host to pair executable code with one
DetectorRegistration or ask the kernel to construct and run an exact evidence
window.

Exposing DetectorExecutionRecord persistence or accepting caller-built windows
would let callers mint semantic lineage. An asynchronous callback would also
blur the deterministic detector boundary with the provider-mediated workflow
reserved for issue #13. The c1 runner therefore needs one narrow,
scope-explicit, capability-bound operation with exact dry-run behavior.

## Rulings

1. **Detector implementations are registered capabilities.**
   `defineDetectorImplementation` accepts an exact DetectorRegistration and a
   synchronous `evaluate(window): unknown` callback. It snapshots metadata,
   retains the callback in a private WeakMap, and returns a frozen
   RegisteredDetectorImplementation. Structurally similar objects are invalid.
   The capability grants callability only—not selection, trust, Candidate
   creation, publication, activation, or efficacy.
2. **The code fingerprint is host-attested.** The capability's detector ref,
   implementationDigest, and registrationDigest are content-bound. JavaScript
   function source is never canonicalized. The implementation digest must equal
   the immutable DetectorRegistration. `registrationDigest` is the digest of
   exact `{ detector, implementationDigest }`. The factory rejects deprecated
   registrations and non-callable evaluators.
3. **Callbacks are synchronous and deterministic.** `evaluate` returns
   `unknown` synchronously. Returning a Promise or any thenable is invalid,
   including a thenable hidden behind an object. Exceptions and malformed
   output produce sanitized failure diagnostics and no execution receipt. The
   kernel passes no store, identity, source-reader, provider, Candidate,
   publication, or authority capability. Host closures cannot be sandboxed,
   so purity remains a host registration and conformance responsibility.
4. **DetectorWindow is provider-neutral and exact.** It contains the selected
   detector/pack/lens invocation, exact scope and registry, source profiles,
   immutable population with resolved EpisodeViews and view digests, ordered
   normalized Observation/qualified Measurement records paired with complete
   EvidenceRefs, full evidence-health findings, capability union, and
   windowDigest. It never contains provider-native events, raw transcripts,
   adapter payloads, filesystem paths, or opaque source records.
5. **Only the kernel constructs windows.** DetectorRunInput contains mode,
   exact detector/pack/lens refs, mandatory Scope, and exact episode record ids
   in canonical sorted-unique order. It accepts no DetectorWindow, EvidenceRef,
   capability claim,
   implementation digest, thresholds, result, id, or digest. Population and
   evidence are materialized under a stable composite snapshot and deeply
   detached before callback invocation.
6. **DetectorResultDraft is applied-only.** A callback supplies only
   `conditionDetected`, insight drafts, and evidence-health drafts. It cannot
   select lifecycle status, scope, detector/pack/lens, source profiles,
   population, producer, trust, record ids, or canonical digests. The kernel
   derives direct and contradictory EvidenceRefs from exact window reference
   digests and mints complete finding, derivation, and execution lineage.
   A negative condition carries no drafts. A detected insight condition carries
   one or more insight drafts and no findings; a detected evidence-health
   condition carries one or more findings and no insight drafts.
7. **The kernel owns non-application.** Empty population, missing runtime
   implementation, unavailable capability, failed applicability, or unusable
   evidence produces `not_applicable` or `incomplete` without invoking the
   callback. Missing/invalid is never applied false, zero, or pass. A nonempty
   episode population with no event evidence may still be eligible for an
   episode-only structural detector.
8. **One mode-discriminated façade is sufficient.** `runDetector` accepts
   `mode: "dry_run" | "commit"`. Without an exact existing receipt, both modes
   independently rematerialize the exact window and invoke an eligible
   synchronous callback; commit does not accept or trust earlier dry-run bytes.
   An exact existing committed receipt is terminal for either mode and returns
   `existing` without callback invocation. Otherwise dry-run returns exact
   would-be execution and derivations with zero kernel/store writes, while
   commit evaluates and uses the existing private receipt-last persistence path.
9. **Run results state what happened.** DetectorRunResult reports input mode,
   execution lifecycle status, persistence (`none`, `committed`, or
   `existing`), whether the callback ran, optional exact execution, exact
   derivations, current evidence health, and sanitized diagnostics. Execution
   is absent only when preflight cannot form a bindable window. Non-ready but
   bindable windows still produce exact kernel-owned execution facts.
10. **No generated Candidate appears.** A positive insight run creates inert
    InsightDerivation records only in commit mode. It never calls `propose`,
    writes instructions, authorizes content, or claims validation or utility.
11. **Runtime availability is separate from semantic registration.**
    LearningLoopConfig gains optional detectorImplementations. SemanticRegistryConfig
    remains serializable and callback-free. Construction verifies exact
    factory identity, registration resolution, implementation digest, and
    uniqueness. A selected detector may remain audit-only without an
    implementation; run preflight then reports incomplete. Omission preserves
    pre-c1 loop-registry bytes, while configured capability presence enters the
    loop registry revision.
12. **Hard ceilings fail without truncation.** One call accepts at most 500
    episode ids, materializes at most 5,000 evidence records, accepts at most
    100 insight drafts or 100 health findings according to output kind, and
    allows at most 16 MiB of canonical DetectorWindow bytes and 16 MiB of
    canonical callback-output bytes. A ceiling breach is incomplete or a
    typed error, invokes no callback when discovered during preflight, and
    never truncates evidence or output silently.
13. **The public-surface increase is six symbols.** C1 adds
    RegisteredDetectorImplementation, defineDetectorImplementation,
    DetectorWindow, DetectorResultDraft, DetectorRunInput, and
    DetectorRunResult. `LearningLoop.runDetector` adds no standalone symbol.
    The root snapshot increases from 137 to 143.

## Mode and persistence matrix

| Situation | Callback | Dry-run persistence | Commit persistence |
| --- | --- | --- | --- |
| No bindable window | no | `none`, no execution | `none`, no execution |
| Bindable but not applicable/incomplete | no | exact would-be execution, `none` | exact execution, `committed` or `existing` |
| Exact committed receipt already exists | no | exact stored records, `existing` | exact stored records, `existing` |
| Eligible new window, callback returns applied draft | once | exact would-be records, `none` | exact records, `committed` |
| Callback throws, returns thenable, or malformed bytes | attempted once | no writes | no writes |

Dry-run promises zero kernel/store writes. It cannot prevent side effects from
host code captured in the callback closure; such behavior violates the
registered deterministic implementation contract.

## C1 and C2 sequencing

**Implemented in #30c1:** exact capability registration, loop binding, explicit
population window materialization, synchronous callback parsing, mode-driven
single-detector execution, dry-run zero-write behavior, engine-owned
non-application, lineage minting, persistence, and conformance ceilings.

**Implemented next in #30c2a by decision 0012:** exact selected-pack fan-out,
compatible-lens selection, explicit bounded dispositions, fixed aggregate
safety ceilings, transient batch dry runs, and sequential private child
persistence. C2a adds no durable pack receipt or policy authority.

**Deferred to immediate #30c2b:** privacy-treated recurrence keys, comparable
groups, clustering, deduplication, decisive-rejection suppression,
host-configured digested lower caps, and durable pack-run audit receipts.
Automatic population discovery and scheduling/routing remain outside c2a.

Decision 0019 implements #30d's opt-in host-bound reference detector contents
and hermetic controls through this exact capability seam. Semantic/model-
mediated generation and calibrated qualitative review remain #13. Detector and
Candidate-utility calibration and any default-quality claim remain #26.

## Migration consequences

- Existing semantic records, Candidates, reviews, cursors, and registry bytes
  are unchanged when detectorImplementations is omitted.
- Adding or removing a runtime implementation intentionally creates a new loop
  registry revision and invalidates cursors bound to the old loop.
- Existing selected detectors without runtime capabilities remain valid for
  audit and query; they are not silently executable.
- No public persistence input, plan object, result parser, provider SDK, or
  implementation WeakMap helper is exported.
