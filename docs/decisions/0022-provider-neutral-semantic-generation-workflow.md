# 0022 — Provider-neutral semantic generation workflow

**Date:** 2026-08-20
**Status:** ratified — issue #13b public generation, provider handoff, and recovery

## Context

Decision 0021 established the private semantic provider-turn substrate without
egress or completed-output persistence. It deliberately left four questions to
#13b: how a consumer defines the exact workflow before constructing its loop,
how previewed bytes become one authorized provider call, how typed model output
enters the existing DetectorExecution/InsightDerivation graph, and how a host
recovers after losing process-local capability handles.

The generation lane must answer those questions without creating a second
semantic graph, trusting provider-supplied measurements, turning model text into
a Candidate, or implying that a valid schema is a calibrated or useful result.
It must also preserve the #13a rule that an ambiguous dispatch is never an
automatic retry.

## Rulings

1. **The public surface is exactly two names.** The optional
   `@cormidia/learning-loop/workflows` subpath exports only
   `SemanticWorkflowBundle` and `createSemanticWorkflowBundle`. The frozen
   factory carries `defineGeneration(...)` and `generationResultSchema` as
   typed static properties, so a strict consumer can construct the exact
   definition, bind its digest into a DetectorRegistration, create the loop,
   and then create the bundle without a deep import. The bundle exposes
   `prepareGeneration`, `authorizeGeneration`, `runGeneration`,
   `recoverGeneration`, `getTurn`, and `queryTurns`. #13c may extend this bundle
   with advisory-review methods but does not receive new public symbols by
   default.
2. **One factory brands every authority-bearing callback.** Bundle creation
   binds one exact LearningLoop, generation definition, loop-verified producer,
   synchronous renderer, synchronous minimizer, tenant-keyed digester,
   synchronous token estimator, provider callback, and—only for outbound
   transport—disclosure-authority callback. Every registered digest must equal
   the definition. The factory snapshots callbacks and mints WeakMap-bound
   prepared-plan and authorization handles; copied objects, another bundle's
   handles, and bare self-digested records are rejected. No provider SDK type
   enters the package.
3. **Generation is an exact semantic-only selection.** Preparation requires a
   currently selected detector, pack, and lens; an `insight_derivation`
   detector whose implementation and
   `configuration.workflowDefinitionDigest` match the definition; exact pack
   and lens compatibility; a lens whose only generator kind is
   `semantic_judgment`; the exact public producer fingerprint set
   `budget | implementation | model | prompt | tool`; no required calibration;
   and no deterministic implementation registered for the detector. Outbound
   transport requires explicit-disclosure privacy from detector, lens, and
   every source policy; local transport requires memory-only detector content.
4. **Preparation is stable, exact, and side-effect-free.** The kernel resolves
   at most 500 sorted unique episode ids and 5,000 exact EvidenceRefs through
   the detector-specific batch resolver, materializes one complete
   DetectorWindow, and retries a changing semantic snapshot at most three
   times. Empty, not-applicable, incomplete, historical, over-budget, or
   ineligible input makes no provider call. Preparation writes nothing and
   invokes neither the provider nor disclosure authority.
5. **The kernel owns the request envelope.** Renderer output can add minimized
   host instructions but cannot omit the definition, prompt, normalized
   DetectorWindow, complete population, EvidenceRefs, or evidence-health
   findings. The kernel canonicalizes the final schema-versioned JSON envelope
   once, estimates its input tokens once, applies exact request-byte and token
   ceilings, and privately retains those bytes in the prepared plan. The
   preview returns a caller-owned copy; mutating it cannot change the retained
   request.
6. **The byte claim is exact application content, not wire proof.** Preview,
   authorization, reservation, and provider handoff bind the same UTF-8
   `application/json` byte string, exact byte length, tenant-keyed digest, and
   key-policy digest. The provider receives a fresh copy. This proves the
   content handed to the registered callback. It does not prove credentials,
   SDK transformations, HTTP headers, compression, TLS framing, network
   delivery, or any bytes a malicious adapter sends independently.
7. **One DetectorExecution key has one exact prepared request.** A deterministic
   run id and create-only `SemanticWorkflowExecutionPlanLock` serialize the
   target DetectorExecution key before authorization or dispatch. A
   scope-and-definition-private `SemanticWorkflowAttemptIndex` binds the safe
   public `attemptId` to that exact reservation, plan lock, definition, scope,
   and execution key. Same bytes retry; a different render, expiry, request, or
   reservation for the same execution key conflicts before a second callback.
   Both normal and recovery adoption recheck the winning attempt after awaited
   reads so a contender cannot win between validation and use.
8. **Outbound authorization is exact permission, not observed disclosure.** The
   disclosure-authority capability receives an exact preview copy, scope,
   definition digest, and caller-supplied evidence. Its result must contain a
   principal verified by the loop identity port and a bounded interval that
   cannot outlive the reservation. The authorization handle is bound to the
   exact bundle and plan. Local generation requires null. Neither the handle
   nor durable authorization record proves that bytes left the process.
9. **Current policy is checked twice before a new call.** A run first verifies
   the exact current window, registry, source ownership/policy, privacy, and
   expiry before writing intent facts. Durable order before egress is
   reservation, execution-plan lock, outbound authorization when required,
   attempt index, and then a second stable current check. The dispatch claim is
   created immediately afterward, using the kernel clock. Only a newly created
   claim permits one immediate provider invocation; an existing claim never
   does. A pre-call refusal creates no dispatch marker and makes no provider
   call.
10. **The provider port is narrow and tool-free.** The callback receives only
    the exact operation/idempotency key, request copy and structural metadata,
    model identity/fingerprint, `toolPolicy.mode = "none"`, registered budgets,
    and AbortSignal. It never receives EngineContext, LearningStore, identity
    minting, authorization minting, `propose`, review, publication, or effect
    capabilities. Maximum attempts is one. A throw, rejection, or timeout after
    dispatch remains ambiguous even when abort was requested.
11. **The kernel, not the provider, measures callback content.** Provider
    output crosses one descriptor-snapshot boundary that rejects accessors,
    symbols, cycles, non-JSON values, depth above 100, more than 100,000 nodes,
    or canonical application content above 16 MiB. Canonical escaping, object
    punctuation, and keys count toward the byte ceiling. Parsing, typed output,
    byte length, tenant-keyed response digest, and request attestation all use
    that same detached value. Provider-reported lengths, digests, and request
    attestations are ignored. A provider-native receipt id/digest is validated
    transiently but never persisted or exposed; the kernel mints the durable
    response receipt from its keyed response digest and provider registration.
12. **Result and usage states are closed.** Runtime behavior is:

    | State | Response metadata | Usage | Normalized output | Durable reason |
    | --- | --- | --- | --- | --- |
    | `completed` | required | reported and within every configured ceiling | exact typed DetectorResultDraft | none |
    | `provider_refused` / `provider_failed` | required | reported or `usage.not_reported` | none | exactly `workflow.<status>` |
    | `result_invalid` | present only when exact canonical response bytes were measured | reported only when structurally valid, otherwise `usage.not_reported` | none | `workflow.result_invalid` |
    | `result_limit` | present when a lower registered ceiling was measured; null when the absolute hard bound prevented retention | reported when safely parsed, otherwise `usage.not_reported` | none | `workflow.result_limit` |
    | `outcome_unknown` | no synthesized result record | unknown | none | transient dispatch-only classification |

    Reported zero remains zero. Missing usage is never zero. Completed output
    requires exact input/output token and duration ceilings and, when cost is
    configured, exact currency and minor units. Provider-native refusal or
    error prose never enters durable reason bytes.
13. **Typed generation reuses the semantic graph.** The fixed
    `generationResultSchema` admits only a closed provider envelope and a
    DetectorResultDraft. Model output cannot choose recurrence, output health
    findings, record ids/digests, principals, trust, Candidates, Reviews, or
    effects. It may fill the existing typed candidate-intervention hypothesis
    field, but that remains derivation content and never mints a Candidate.
    Findings and recurrence locator must be empty/null. Every cited EvidenceRef
    digest and evidence-health id/digest must be a subset of the exact disclosed
    window. The kernel assembles and re-parses the ordinary
    DetectorExecutionRecord and InsightDerivation records, with exact producer
    principal/attestation, implementation/model/prompt/tool/budget
    fingerprints, and a disclosure reference to the durable result binding.
14. **Completed output is enabled only through typed sidecars.** #13a's generic
    completed writer/read guard remains closed. The #13b path first persists a
    bounded `SemanticWorkflowCompletionIntent` containing the normalized result,
    compact execution template, exact episode completeness, registry snapshot,
    orchestration policy, recurrence decision, workflow binding, execution, and
    derivations. It then writes result binding, workflow-execution binding,
    ordinary semantic registry/derivation/index/recurrence facts, the ordinary
    DetectorExecution receipt last in that child graph, the general scope turn
    index, and finally the scope-and-definition-private SemanticTurnReceipt.
    Every prerequisite and acknowledged write is exactly reloaded.
15. **Semantic recurrence is explicit but unavailable.** A positive applied
    generation writes the ordinary nullable recurrence binding with locator
    unavailable before the DetectorExecution receipt; a negative completed
    generation writes no recurrence binding. The model cannot provide a
    locator. The captured orchestration policy is historical recovery lineage,
    not a deduplication, suppression, grouping, admission, or quality claim.
16. **Known facts recover; ambiguous dispatch never retries.** The first awaited
    write after a synchronously validated completed callback is the completion
    intent. A process may later reconstruct the exact bundle and call
    `recoverGeneration({ attemptId, scope })`: the method consults only the
    exact scope-and-definition attempt namespace before global facts, invokes no
    renderer, minimizer, estimator, digester, authority, or provider, and does
    not require current-window or unexpired-plan status. It forward-completes an
    exact completion intent or noncompleted result and returns an existing
    terminal. An indexed attempt with no dispatch returns `not_dispatched`.
    Dispatch without a durable result or completion intent returns
    `outcome_unknown` with `persistence: "dispatch_only"` and can never trigger
    an automatic second call.
17. **Public reads are scope-and-definition private.** New terminal receipts
    live in a namespace derived from both scope and definition; the general
    exact-scope index remains for private #13a-compatible direct get. Public get
    probes the definition-local terminal before any global target. Public query
    lists only that namespace, pages at most four terminal graphs per store
    read under the 64 MiB/5,000-child-reference work ceiling, and uses an opaque
    cursor bound to scope, definition, registry revision, and query-cursor store
    scope. Its revision derives only from the definition-local terminal stream,
    so another definition cannot churn, consume, corrupt, or reveal this
    bundle's query. Legacy #13a indexes without definition remain available only
    through the private compatibility read.
18. **Batch detector evidence does not widen Candidate evidence.** Detector and
    semantic-window resolution admits 5,000 exact evidence references through a
    shared bounded batch fold. Candidate proposal remains capped at 1,000.
    Neither limit truncates, and neither makes evidence trusted, complete, or
    sufficient merely because it was resolved.
19. **Generation remains inert.** No #13b method creates or reviews a Candidate,
    invokes proposal admission, authorizes publication, activates context,
    applies an effect, validates an intervention, or claims utility, efficacy,
    preference, harm, or improvement. Generation is attributed, but there is no
    reviewer in this slice. Calibration is absent by construction. #13c owns
    advisory review, and #26 owns any decisive calibrated-review or default-
    quality claim.
20. **Provider implementations stay outside the kernel.** The root and
    `/workflows` retain zero runtime dependencies and no provider SDK. Provider,
    renderer, minimizer, token-estimator, keyed-digest, and disclosure-authority
    adapters are host or optional companion code with independent release and
    privacy posture.

## Public method summary

| Method | Effect boundary | Durable outcome |
| --- | --- | --- |
| `prepareGeneration` | no writes, authority call, or provider call | opaque plan, safe attempt id, exact preview; or closed nonapplication/existing execution |
| `authorizeGeneration` | host disclosure-authority callback only | opaque plan-bound authorization; persistence waits for run |
| `runGeneration` | at most one provider callback after durable dispatch | committed/existing terminal, or dispatch-only ambiguity |
| `recoverGeneration` | no provider or authority callback | forward-completed known facts, existing terminal, `not_dispatched`, or `outcome_unknown` |
| `getTurn` / `queryTurns` | read-only exact scope and definition | minimized typed audit views |

## Validation evidence

#13b supplies L1 contract, schema, digest, and public-surface controls plus L2
deterministic hermetic callback/store controls. They cover strict supported-
entrypoint setup, exact request/response bytes, canonical escaping, proxy and
accessor attacks, provider/authority exception privacy, every configured
budget boundary, 500/5,000 population/evidence limits, exact token estimation,
same-key concurrency and interleaving, every durable crash edge, lost
acknowledgements, process reconstruction, current-policy pre-call refusal,
historical recovery, recurrence, wrong-scope/definition no-oracle reads,
definition-local cursor/revision isolation, typed semantic sidecar enforcement,
and absence of Candidate/Review/effect records.

- **L3 live-source/provider evidence:** empty; no live provider was called.
- **L4 semantic/model evaluation:** empty; no model-quality or reviewer scaffold
  was run.
- **L5 operational/SLO evidence:** empty.
- **L6 longitudinal acceptance evidence:** empty.

Issue #26 still owns held-out detector/Candidate utility, reviewer calibration,
and every default-quality or improvement claim.

## Migration, package, and sequencing consequences

- Existing root exports and deterministic detector APIs are unchanged.
- `/workflows` adds exactly two public symbols, increasing the all-entrypoint
  export snapshot from 156 to 158.
- New private plan, attempt, completion, and workflow-execution records are
  additive. New turn indexes include `definitionDigest`; legacy #13a indexes
  remain byte-valid for private direct reads.
- Completed result parser shapes from #13a are now persistable only through the
  typed generation integration. Generic completed persistence remains refused.
- The next campaign order is `#13c → #26`; completing #13b generation does not
  ship advisory review or calibration.
