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
├── /testing   in-memory stores, deterministic clocks/ids, builders, conformance suites
└── adapters/  transcript source adapters (Claude Code, Codex) — explicit input only
```

The kernel is headless and dependency-light: no model-provider SDKs, no agent
framework, no scheduler, no UI. Hosts own execution, identity, approvals,
storage deployment, and side effects.

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

There is deliberately no public execution-write method. Callable detector
pairing and orchestration remain #30c. #30b2b adds explicit derivation-backed
Candidate proposal with exact field mapping, population-only episode support,
mirrored revision lineage, and review independent from proposer and producer.
Reference packs/examples are #30d; optional semantic providers are #13;
held-out candidate-utility calibration is #26.
Evidence-health findings stay separate from behavioral derivations, and only
the verified `propose` path may turn a derivation into an inert Candidate.

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
