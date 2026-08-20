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
  Missing, unreadable, unsupported, corrupt, partial, or revision-changed
  evidence produces closed evidence-health records; it is never silently an
  empty successful page or a behavioral candidate.
- **Candidate evidence is kernel-resolved and content-bound.** Callers request
  exact durable observation ids; only `propose` may resolve records, episode
  identity, scope, and source-page receipts into ordered, nonempty,
  duplicate-free Candidate-v2 `EvidenceRef` values. Candidate v1 remains
  byte-stable, `legacy_unbound`, and audit-only, with no automatic migration. A
  successor is an explicit new proposal with exact predecessor lineage.
  Candidate views expose only the closed evidence-health status; it grants no
  trust or authority. Measurement references stay refused until issue #31c
  lands their ownership rules.
- **ESM only, strict TypeScript.** Subpath exports (`.`, `/node`, `/testing`)
  with no supported deep imports.

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
