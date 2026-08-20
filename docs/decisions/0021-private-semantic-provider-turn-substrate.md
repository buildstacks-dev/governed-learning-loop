# 0021 — Private semantic provider-turn substrate

**Date:** 2026-08-20
**Status:** ratified — issue #13a records, intent, and receipt-last persistence

## Context

Decision 0007 reserved provider-neutral semantic generation, exact outbound
preview/disclosure lineage, and calibrated qualitative review for issue #13.
Decisions 0008 through 0019 then supplied the exact semantic registry,
provider-neutral DetectorWindow, immutable execution/derivation graph, inert
Candidate boundary, recurrence governance, serialized proposal admission, and
reference structural controls that #13 must consume rather than duplicate.

The first #13 slice must establish truthful crash and privacy facts before any
model call exists. A single “disclosure receipt” cannot do that: authorization
must precede a possible external handoff, while a receipt can only describe an
observed result afterward. A crash after a dispatch claim but before a result is
ambiguous and must not cause an automatic second call. The substrate also must
not let self-digested provider, authorizer, or workflow bytes become an egress
capability, a decisive review, or a Candidate entitlement.

## Rulings

1. **#13 is split at the external-effect boundary.** #13a contains private
   records, parsers, digest rules, staged create-only persistence, exact-scope
   reads, and deterministic controls only. It exports no root or subpath symbol
   and contains no provider callback, SDK, HTTP client, request renderer,
   preview UI, model output integration, Candidate/Review writer, publication,
   or other effect. #13b owns the first typed generation/preview/provider
   capability and egress integration. #13c owns advisory semantic review and
   its evaluation scaffold. A model-mediated `CandidateReview` cannot become
   decisive until #26 supplies a separately ratified, factory-minted calibrated
   capability.
2. **One immutable definition binds the workflow claim.** A private
   `SemanticWorkflowDefinition` binds exact id/version, lane
   (`generation | advisory_review`), transport (`local | outbound`),
   implementation, provider/model, prompt, renderer, output schema, deny-all
   tool policy, budgets, disclosure policy, producer principal/attestation, and
   calibration posture. Provider idempotency is required and binds the policy
   deriving one operation key. Generation calibration is null; advisory review
   is explicitly `unverified`. These are inert bytes, not factory branding or
   host authority.
3. **The application-content byte claim is exact but narrow.** A reservation
   binds media type `application/json`, encoding `utf-8`, exact positive byte
   length, tenant-treated `minimizedBytesDigest`, and the exact key-policy
   digest. The digest covers the application content that a future prepared
   plan will preview and hand to a registered provider port. It does not claim
   to cover API credentials, transport headers, TLS framing, SDK-generated wire
   serialization, or bytes a malicious adapter sends independently. #13a stores
   neither the preview nor request bytes.
4. **Content-bearing digests are privacy-treated.** Request and response byte
   digests are paired with exact host key-policy digests. Low-entropy or private
   content uses tenant-scoped, domain-separated keyed treatment, never a
   portable unsalted hash vulnerable to dictionary recovery. Durable records
   contain structural lengths/digests only, not request bytes, raw response
   bytes, provider error text, prompt text, transcript text, tool arguments,
   tool results, or private locator keys.
5. **A reservation binds exact semantic input.** Its turn key binds run id,
   loop/semantic registry, scope, complete workflow definition, minimized
   request, exact source/content policies, transport disclosure expectation, and
   a lane-specific target. Generation binds exact detector/pack/lens refs,
   window and execution-key digests, a nonempty sorted population of at most 500
   episode-record ids, and at most 5,000 sorted disclosed EvidenceRef digests.
   Advisory-review target bytes are a non-dispatchable future scaffold. Expiry
   changes the full reservation digest but not the semantic turn key, so expiry
   extension cannot disguise a new semantic request.
6. **Authorization is pre-dispatch permission, not a disclosure receipt.** An
   outbound reservation requires one exact
   `SemanticDisclosureAuthorization`; a local reservation requires null. The
   record binds reservation/turn/scope, exact request length/digest, provider
   registration, authorization policy, authorizer principal/attestation, and a
   bounded authorization interval that cannot outlive the reservation. It says
   only that these bytes were authorized. In #13a its principal/attestation are
   still record data; #13b must require a loop/plan-bound capability minted by a
   host disclosure-authority port before egress.
7. **Dispatch is a create-only claim, not evidence that a network call
   happened.** `claimSemanticDispatch` reloads the exact committed reservation
   and authorization, stamps `startedAt` from the kernel clock, verifies
   `authorizedAt <= startedAt < expiresAt`, and derives one provider operation
   id/idempotency key from the exact turn key, provider registration, and
   operation-key policy. A concurrent winner returns `created`; every exact
   retry returns `existing`. Existing is never permission to redispatch.
8. **The claim is necessary but insufficient for future egress.** Before an
   actual #13b handoff, the kernel must additionally authenticate a nonforgeable
   prepared-plan capability owning the exact previewed bytes and
   kernel-materialized window, authenticate exact provider/workflow and host
   disclosure-authority capabilities, revalidate the current window/evidence,
   and recheck authorization expiry immediately before the callback. The bare
   definition, authorization record, reservation, or `created` result grants no
   provider authority.
9. **Generation claim-time policy is conjunctive and current.** Before creating
   a new dispatch marker, #13a requires the exact current loop and semantic
   registry; exact registered source ownership and content-policy id/digest/
   outbound mode; selected detector, pack, and lens membership; an
   `insight_derivation` detector whose implementation and
   `configuration.workflowDefinitionDigest` bind the exact workflow; exact lens
   compatibility; the public producer fingerprint set
   `budget | implementation | model | prompt | tool`; no required calibration;
   semantic-judgment permission; and the transport-specific detector/lens
   privacy gates. Outbound requires explicit-disclosure policies throughout;
   local generation requires `memory_only`. Advisory-review dispatch remains
   unavailable until #13c.
10. **Dispatch ambiguity is permanent and non-retriable by this slice.** A
    committed dispatch marker with no result classifies `outcome_unknown`.
    Neither the classifier nor any #13a helper invokes, resumes, recovers, or
    redispatches a provider. #13b may recover only through an exact
    provider-operation lookup or a provider idempotency guarantee; absence of
    that proof remains `outcome_unknown`, never an automatic second call.
11. **Result facts use closed, minimized states.** Status is exactly
    `completed | provider_refused | provider_failed | result_invalid |
    result_limit | outcome_unknown`. Completed parser bytes require a known
    response, reported usage, exact normalized-result digest, and no reason.
    Every noncompleted result requires no normalized result and exactly
    `workflow.<status>`. Unreported usage is only `usage.not_reported`, except
    `outcome_unknown` requires `usage.outcome_unknown`; zero tokens/duration/cost
    remain valid only when explicitly reported. Provider-native errors and
    refusal prose never enter durable reason bytes.
12. **Known overruns remain audit facts.** Definition budgets bind request and
    response bytes, episodes, EvidenceRefs, input/output tokens, duration, one
    attempt, token estimator, and optional exact currency/minor-unit ceiling.
    Successful completion must prove reported usage and remain within every
    configured ceiling. A `result_limit` may retain a safe-integer observed
    `responseByteLength` greater than 16 MiB plus its keyed digest without
    retaining or parsing the response body. Missing usage is never zero and a
    known overrun is not erased into `outcome_unknown`.
13. **Completed output is parser-only in #13a.** Completed record shapes and
    golden digests reserve future compatibility, but persistence and reads
    reject `completed` with `semantic.workflow_output_unavailable`. #13a has no
    typed generation execution/derivation or advisory-assessment sidecar and no
    operation-specific minimizer for arbitrary provider JSON. #13b/#13c must
    add those exact sidecars, schema/minimization capabilities, and reload rules
    before completed result or terminal persistence becomes legal.
14. **Persistence is staged and receipt-last.** The only legal writer sequence
    is:

    1. global private reservation;
    2. global private authorization iff outbound;
    3. global private dispatch marker;
    4. global private noncompleted result binding;
    5. exact-scope private turn index;
    6. exact-scope private `SemanticTurnReceipt`, last.

    Each stage parses unknown input, reloads every prerequisite and every
    acknowledged write, compares exact raw canonical bytes rather than a parser
    projection, and refuses create conflicts or fake success. The terminal
    writer reloads the entire exact graph before index and receipt. Lost
    acknowledgements converge by exact create-only retry without overwriting.
15. **Terminal reads are scope-private.** Index and terminal receipt live in a
    namespace derived only from `scopeDigest`. A direct read consults that
    index before the scoped receipt and never probes a foreign-scope target.
    An index orphan is invisible until the exact receipt exists. The composite
    scope revision binds both the index-kind and scoped-turn-kind revisions, so
    the index-before-receipt interval and receipt arrival have distinct
    revisions without foreign-scope churn.
16. **Unknown-first parsing has its own workflow trust guard.** Workflow records
    use shallow snapshots of own enumerable data properties; inherited,
    non-enumerable, and accessor-backed known fields cannot enter parsed or
    canonical bytes, while unknown accessor fields are not invoked. Workflow
    arrays require own data indices. Arbitrary normalized JSON receives an
    iterative descriptor preflight before recursive conversion, rejects
    accessors/cycles, and fails closed above depth 100 or 100,000 nodes.
17. **Resource ceilings fail without truncation.** Canonical workflow records,
    request policy, and normalized-result parser bytes are capped at 16 MiB;
    definition ceilings may only lower request/response admission. Populations
    cap at 500 episodes and 5,000 EvidenceRefs; result reasons cap at their exact
    closed singleton; output references cap at 100; integer usage, duration,
    byte-length, and cost fields are nonnegative safe integers. No failure logs
    or diagnostics echo request, response, provider error, or transcript
    content.
18. **The records grant no authority or quality claim.** A definition,
    reservation, authorization, dispatch, result, index, or terminal receipt is
    not trust, source capability, disclosure proof, detector truth, Candidate,
    Review, proposal admission, publication, activation, validation, utility,
    efficacy, calibration, or improvement. Candidate inertness and
    authorized-versus-validated separation remain unchanged.

## Private record and digest matrix

| Private record | Exact role | Identity/digest rule |
| --- | --- | --- |
| `SemanticWorkflowDefinition` | Immutable workflow/provider/model/prompt/tool/budget/disclosure claim | `definitionDigest` binds every semantic field under `semantic-workflow-definition:v1` |
| `SemanticTurnReservation` | Exact request/scope/target/source-policy intent | id `semantic-workflow-reservation-<turnKeyDigest>`; turn key excludes expiry; `reservationDigest` includes it |
| `SemanticDisclosureAuthorization` | Exact outbound authorization before dispatch | id `semantic-workflow-authorization-<turnKeyDigest>`; digest binds authorizer and exact request/reservation |
| `SemanticDispatchMarker` | One create-only provider-operation claim | id `semantic-workflow-dispatch-<turnKeyDigest>`; digest binds operation/idempotency key and kernel time |
| `SemanticResultBinding` | Closed minimized result/usage audit fact | id `semantic-workflow-result-<turnKeyDigest>`; digest binds response metadata, usage, normalized result when parser-only completed, and exact reasons |
| `SemanticTurnScopeIndex` | Scope-private terminal locator | digest binds scope, turn id/key/digest |
| `SemanticTurnReceipt` | Receipt-last committed graph | id `semantic-workflow-turn-<turnKeyDigest>`; `turnDigest` binds every exact sidecar ref, lane, scope, status, and output projection |

Every digest is domain-separated. Unknown input fields are dropped from the
fresh parsed value and therefore cannot silently enter identity.

## Validation evidence

#13a supplies L1 contract/golden vectors and L2 deterministic hermetic controls
only. The controls cover every digest field, transport/lane/policy matrix,
byte/episode/evidence/depth/node boundary at and above its ceiling, accessor and
own-byte attacks, closed result/usage pairing, privacy canaries, current
registry/source/workflow/privacy mutations, authorization expiry, competing
dispatch claims, every crash/write boundary, lost acknowledgement, fake
success, raw-extra-field mutation, wrong-scope no-oracle reads, orphan
invisibility, and the scope index/terminal revision interval.

- **L3 live-source/provider evidence:** empty.
- **L4 semantic/model evaluation:** empty; scaffold deferred to #13c.
- **L5 operational/SLO evidence:** empty.
- **L6 longitudinal acceptance evidence:** empty; scaffold deferred to #13c.

Issue #26 still owns calibration, held-out Candidate utility, and every
default-quality or improvement claim.

## Migration, package, and sequencing consequences

- Existing root records, semantic execution/derivation graphs, Candidates,
  Reviews, recurrence, admission, source receipts, and digests are unchanged.
- Four global private engine kinds are added for reservation, authorization,
  dispatch, and result sidecars; the terminal turn kind is stored only in its
  scope-derived namespace alongside the private index. No engine kind or
  namespace is a supported consumer API.
- The public snapshot remains 156 symbols across the existing root, node,
  testing, and reference-detector entrypoints. The planned `/workflows`
  subpath is not exported in #13a.
- Root and `/workflows` acquire no provider SDK or runtime dependency. Future
  OpenAI, Anthropic, Google, xAI, or other integrations remain optional
  companion adapters and may not leak SDK types into the protocol.
- Campaign order is refined to `#13a → #13b → #13c → #26`; #13a completion
  does not close the model-mediated workflow issue.
