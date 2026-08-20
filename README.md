# governed-learning-loop

A **governed adaptation kernel** for TypeScript agent products: turn evidence from
completed agent work into scoped, reviewable, safely activated, and measurable
improvements — without surrendering your agent framework, model provider, or
storage system.

> An agent should not be allowed to turn its own story about a run directly into
> permanent instructions. This library exists to make the trustworthy path —
> evidence provenance, inert proposals, independent review, exact-content
> authorization, deterministic publication, rollback, and outcome measurement —
> cheaper than the shortcut.

**Status: pre-alpha, unpublished, private.** This is governed adaptation
*infrastructure*. It is **not** proven automatic self-improvement, and no claim
here says a learned intervention has been shown to improve later agent work.

## What it does

| Level | You integrate | You get |
| --- | --- | --- |
| Observe | Episodes, observations, source receipts, outcomes | A durable, provenance-bearing account plus bounded typed episode and evidence views |
| Govern | Receipt-bound candidates, independent review, policy, rejection | Proposed lessons with exact evidence/episode lineage that stay **inert** until independently reviewed |
| Activate *(planned)* | Content-bound authorization, deterministic publication, rollback | Exact versions introduced under host authority, disable/rollback explicit |
| Validate *(planned)* | Frozen experiments, paired replay, guardrails | Attributable evidence that a change helped — or an honest inconclusive verdict |

Observe and Govern are implemented first; Activate and Validate are tracked in
the issue backlog and are orthogonal capabilities, not implied by the first two.

## Package shape

```text
@cormidia/learning-loop          (working name; final npm identity undecided)
├── .          domain records, unknown-first parsers, deterministic engine, ports
├── /node      local filesystem (JSON Lines) store adapters
├── /testing   runtime-safe stores, deterministic fixtures, injected conformance suites
├── /reference-detectors  opt-in host-bound deterministic pack bundle
└── adapters/  transcript source adapters (Claude Code, Codex) — explicit input only
```

The kernel is headless and dependency-light: no model-provider SDKs, no agent
framework, no scheduler, no UI. Hosts own execution, identity, approvals,
storage deployment, and side effects.

Importing `/testing` in plain Node does not load Vitest or register tests. Store
adapters run the public suite by supplying their own runner functions:

```ts
import { runLearningStoreConformance } from "@cormidia/learning-loop/testing";
import { describe, expect, it } from "vitest";

runLearningStoreConformance(makeStore, { describe, expect, it });
```

The required second argument replaces the former one-argument call. It keeps
the deterministic stores, clocks, ids, and builders usable outside a test
worker without adding a test-framework runtime dependency.

## Typed reads

Consumers read observations, measurements, episode views, and candidate
governance through the `LearningLoop` façade. Queries return bounded typed
pages with opaque cursors; engine namespaces and record kinds are private and
unsupported integration points. A page revision records the append-visible
store state observed for that page. It is not a frozen detector, calibration,
or experiment population—those workflows must bind an exact eligible set.

New proposals persist Candidate v2 records with kernel-minted `EvidenceRef`
bindings to exact records, source-page receipts, episode identity, scope, and
evidence health. Historical Candidate v1 records remain byte-stable audit
history, permanently `legacy_unbound`; later receipts never auto-migrate or
make them review-eligible.

Measurements enforce their declared runtime value type and bind exact
same-source, same-revision observation support before they can enter a v2
measurement reference. Episode outcomes append retained claims rather than
rewriting episodes; typed episode views expose the latest claim, full attempt
history, and closed evidence health. Raw legacy outcomes remain unqualified.

## Semantic record seam

The root record contract now distinguishes four independent semantic
dimensions: detector semantics (`DetectorRegistration`), distribution
(`DetectorPackManifest`), purpose (`LearningLensRegistration`), and an inert
fact-to-hypothesis chain (`InsightDerivation`). Scope still answers where a
learning applies; a lens answers what good means; a learning class identifies
mechanical, interaction, role/craft, or system/meta altitude. Support,
Documentation, Cormidia roles, and personal-project names remain host data.

The implemented #30b1 registry now snapshots full installed records plus exact
selected detector, pack, and lens refs. A host-granted `SourceSemanticProfile`
binds normalized capabilities and observation kinds to one exact source
registration revision; adapters cannot claim those capabilities themselves.
An unprofiled source remains compatible with generic Observe ingest but grants
zero detector capabilities, while profiled ingest rejects undeclared
normalized observation kinds. Omitting the optional semantic registry preserves
the prior loop-registry bytes.

`DetectorExecutionRecord` now provides an immutable, unknown-first-parsed fact
for one exact invocation, evidence window, and closed
`applied | not_applicable | incomplete` result. Its required pack, output-bound
lens, source profiles, episode-view population, evidence, full evidence-health
inputs/outputs, and exact capability union are content-bound. The execution key
excludes the result; the full execution digest includes it. There is no `pass`,
and a detected condition still does not claim harm, authority, candidate
utility, or improvement.

The implemented #30b2a seam persists semantic facts through a private
receipt-last graph: durable registry snapshot, provenance links, derivations,
scope-partitioned private indexes, then execution receipt. Public reads require
exact scope, page only that scope's private index, and distinguish
committed/orphaned/invalid lineage, current versus historical registry binding,
and current evidence health. Historical and crash-interrupted facts stay
auditable but never become authority. Learning lenses may require exact episode
population evidence as well as observation or measurement evidence.

There is deliberately no public arbitrary execution-record write. #30b2b adds explicit derivation-backed
Candidate proposal with exact field mapping, population-only episode support,
mirrored revision lineage, and review independent from proposer and producer.

#30c1 adds non-forgeable deterministic detector implementations and one
mode-driven `runDetector` façade. The kernel constructs provider-neutral
windows, rejects asynchronous/thenable callbacks, owns non-applicable and
incomplete results, and mints all lineage. New eligible dry runs evaluate but
write nothing; commit rematerializes and evaluates again before private
persistence. An exact committed receipt is returned without re-evaluation.
No detector run creates a Candidate.

#30c2a adds bounded `runDetectorPack` fan-out over one exact selected pack,
scope, and caller-declared episode population. Exact detector/lens pairs use
stable protocol ordering and every bounded non-application, cap, or refusal is
returned explicitly with callback-attempt visibility. Dry-run remains
zero-write; commit persists retained child graphs sequentially through the
same private receipt-last path. The pack report is transient and deliberately
not batch-atomic: there is no pack receipt, public writer, durable rate cap,
deduplication claim, suppression claim, Candidate, or utility verdict.
Hard ceilings allow at most 5,000 considered pairs, 100 admitted child runs,
100 unique new content-addressed output records, and 64 MiB of retained
canonical child results.

#30c2b1 adds an optional privacy-treated recurrence locator to a positive
detector result and durable private execution-to-group lineage. Public
structural labels and tenant-keyed private digests are registration-constrained;
raw private key material never crosses the callback. Group identity binds the
exact detector version/configuration/implementation, lens, scope policy, and
locator while deliberately excluding pack distribution and episode
membership. Dry runs expose a zero-write projected count; commits lock an
exact nullable recurrence decision, append a member only for a qualified
locator, and leave the execution receipt last before reloading bounded counts.
Historical unbound executions are never rerun or migrated. Counts are
descriptive, not harm, preference, utility, or efficacy claims. Folds fail
closed above 5,000 members, 50,000 exact episode references, or 5,000 distinct
episode identities.

#30c2b2-policy adds an optional content-digested orchestration policy. Hosts
may lower the 100-child admission ceiling and independently cap transient
insight/evidence-health group reporting. Configured pack items explicitly say
`not_grouped | unassessed | capped` only when an exact child result is retained;
no-result items omit the unknown classification. Group-capped child facts
still persist and remain inert. Rejection-suppression configuration is
registered and digested but grants nothing by itself. Subsequent slices add
durable pack receipts/queries, observational Candidate-to-group claims and
assessment, then decision 0018 separately enforces the same pure classifier
through a serialized pre-write Candidate admission snapshot.

#30c2b2-receipts adds a content-bound DetectorPackRunReceipt for configured
commit runs whose requested population resolves one-to-one in the exact scope.
It embeds the full policy, normalized retry-stable child/recurrence facts and a
content-bound governance snapshot (explicitly not assessed when ineligible,
otherwise observationally assessed); callback activity and `existing`
persistence state remain transient. Child graphs commit first, a scope-private
result lock follows, and the receipt is last, so retries forward-complete while
honestly preserving non-atomic child commits. Public query/get methods require
exact scope and views independently report registry, policy, receipt/child
commit, governance and current evidence health. Missing/wrong-scope inputs,
policy omission and dry runs create no receipt. The assessed Candidate/review
branch is content-bound and independently revalidated; its classifications
remain non-enforcing.

#30c2b2-claims adds private observational links from an exact committed
derivation execution to one recurrence group and from every new Candidate to a
nullable recurrence decision. Grouped Candidates freeze exact proposal-time
member references and the full committed episode-identity baseline; current
group growth is reported separately. The decision freezes the full
Candidate-v2 snapshot, and the content-ownership lock binds both complete
Candidate and claim bytes before the optional group member and Candidate
record, so exact same-proposer retry forward-completes without rewriting
historical Candidates. CandidateView
exposes `recurrenceLineage`, but claims do not deduplicate, suppress, refuse,
review, authorize or validate a proposal.

#30c2b2-assessment adds a private review-history marker/index and mints
observational assessed governance for uncapped insight groups with one complete
active frontier. The pure parser/runtime classifier distinguishes available,
deduplicated, suppressed, and ambiguous revision state under exact review
append order and checked evidence-multiplier thresholds. Capped insight and
evidence-health groups remain not assessed and do no Candidate/review work.
Exact views distinguish current, historical, invalid, and not-assessed
governance with a shared 50,000-work-unit ceiling. None of these descriptions
changes `propose`, review eligibility, publication, authority, utility, or
efficacy. Candidate evidence revalidation still inherits global evidence
revision/receipt scanning, so complete scope-local analysis work remains an
explicit follow-up rather than a shipped claim.

#30c2b2-admission serializes subject grouped proposals through one private
per-recurrence-group CAS slot stream. Admission double-reads an exact
policy/registry/recurrence/frontier snapshot before writing anything for the
proposed Candidate. Empty groups admit one fresh Candidate; revise and eligible
reject branches require exact same-group supersession; below-threshold
rejections and deduplicated/ambiguous frontiers refuse generically. A sole exact
pre-marker predecessor can migrate only through mirrored supersession.

The durable order is recurrence decision, neutral content lock, review marker,
snapshot, reservation, slot, binding, group member, then Candidate receipt.
Retries forward-complete the winning slot; stale absence caches reload and a
new unvalidated tail is never extended. Slotted snapshot+reservation history is
bounded to an aggregate 64 MiB, including the prospective pair before the slot.
CandidateView exposes closed `admissionLineage`; invalid admission blocks review
before and after its callback, while exact historical admission remains
reviewable. Admission adds no public writer or root export and grants no
publication, authority, validation, utility, or efficacy.

This guarantee assumes a trusted host exclusively cuts a group/scope over to a
configured admission-capable loop. Concurrent old or policy-unconfigured
writers remain non-subject and can bypass the stream. Candidate evidence checks
also retain the documented global revision/source-receipt scan debt, so the
library still does not claim completely scope-local assessment work.

#30d adds the opt-in `/reference-detectors` subpath. Its unknown-first factory
content-addresses one exact host namespace, scope policy and sorted purpose-lens
set into host-bound ids for experimental detector registrations and pack
manifests at catalog version `0.1.0`. The returned bundle
contains a core coordination-attribution integrity detector plus operational
polling, context-pressure/explicit-compaction, tool-concentration,
coordination-fan-out and attributed-redirection detectors. Source requirements
are inert descriptions, not SourceSemanticProfiles or capability grants; the
current transcript adapters do not claim them. Positive callbacks emit at most
one fixed structural derivation with no recurrence locator and null
intervention/validation. They create no Candidate, Review, provider call or
effect and claim no harm, inefficiency, preference, utility or efficacy.

Missing, unreadable and unsupported evidence stays in the native
SourcePageReceipt/EvidenceHealthFinding path because unavailable pages have no
episode population for a DetectorWindow. The shipped reference cases are L1
contract plus L2 hermetic controls only. Optional semantic providers remain
#13; held-out detector/candidate-utility calibration and every default-quality
claim remain #26.
Evidence-health findings stay separate from behavioral derivations, and only
the verified `propose` path may turn a derivation into an inert Candidate.

#13a adds only the private provider-turn substrate required before an optional
model workflow can be safe to connect. An immutable workflow definition binds
provider/model, prompt, renderer, output schema, a deny-all tool policy, exact
budgets, disclosure policy and producer attribution. A request reservation
binds one exact scope, semantic target, minimized application-content byte
length and tenant-keyed digest, and the exact source/content policies. Outbound
turns additionally require a content-bound authorization before one create-only
dispatch claim.

The staged durable order is reservation, outbound authorization, dispatch,
closed noncompleted result, scope-private index, then the scope-private turn
receipt last. Every acknowledged write is reloaded. A dispatch without a result
is `outcome_unknown`; an existing claim is never permission to redispatch.
Authorization is not a disclosure receipt, and `created` is not provider
authority. No preview, request bytes, raw response, provider error, transcript
text, Candidate, Review, provider callback, SDK or effect is stored or invoked.
Completed semantic result/terminal persistence is deliberately refused until
#13b supplies typed minimized generation output and exact sidecars. Advisory
review dispatch remains #13c, and no model review becomes decisive before #26
ratifies calibrated reviewer capabilities.

The exact-byte claim is the content-bearing application payload handed to a
future registered provider port, not credentials, transport headers, TLS
framing or unverifiable SDK wire bytes. #13a exposes no `/workflows` entrypoint
and adds no public symbol. Its validation evidence is L1 contract/goldens plus
L2 hermetic crash, concurrency, privacy and scope controls; L3 live-provider,
L4 semantic/model, L5 operations/SLO and L6 longitudinal evidence are empty.

## The demo: transcript insights

`examples/transcript-insights` is a small local CLI that ingests your own
Claude Code and Codex session logs **one day at a time**, entirely locally,
and reports recurring friction plus grounded (inert) improvement candidates.
It is the library's second consumer and its honesty check: transcript-derived
evidence is capped at *advisory* trust, message text never enters the durable
store by default, and nothing calls a model unless you explicitly opt in.

## Development

- Node >= 22, pnpm (pinned via `packageManager`).
- `pnpm install` · `pnpm check` (lint + typecheck + gates) · `pnpm test`.
- All changes land through a PR and **squash-merge**; see `AGENTS.md`.

## Provenance

Extracted from Cormidia per the ratified proposal
`research/2026-08-12_learning-loop-library/` (Cormidia repo). The API contract
adopted for this repo lives in `docs/contract/`; deviations from the original
proposal are recorded in `docs/decisions/`.
