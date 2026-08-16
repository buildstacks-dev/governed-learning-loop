# 0001 — Extraction charter: repo-first, Observe+Govern first

**Date:** 2026-08-16
**Status:** ratified — explicit human instruction (Bikram Gupta, 2026-08-16)

## Rulings

1. **This repository exists now, and is the source of truth.** The originating
   proposal (Cormidia `research/2026-08-12_learning-loop-library/`) recommended
   an in-repo extraction seam first, with repository creation later. The human
   owner explicitly authorized creating `cormidia/governed-learning-loop`
   (private) on 2026-08-16. The drift risk the proposal guarded against is
   addressed by making this repo canonical from day one: nothing here is a
   copy of Cormidia's implementation, and Cormidia migrates onto this package
   as a consumer campaign (issue #14) rather than keeping a fork.
2. **Contract adopted.** `docs/contract/api-contract.md` is adopted as the
   ratified contract for schema version 1. Amendments happen by exact diff to
   that file with a decision record.
3. **Build order: Observe + Govern first** (records, digests, engine, stores,
   transcript adapters, demo app), then Activate (issues #10–#11), then
   Validate (issues #12–#13). Activation and validation remain orthogonal
   capabilities; nothing in the first milestones may imply them.
4. **Naming and publication deferred.** `@cormidia/learning-loop` is a working
   name. `"private": true` and `UNLICENSED` stand until the package-identity
   ruling (issue #15) and an exact human release approval through Cormidia's
   release path.
5. **Node floor >= 22.18** (native type-stripping band), deliberately wider
   than Cormidia's Node 26 floor; `erasableSyntaxOnly` enforces the compatible
   TypeScript subset. CI runs on Node 22 to prevent Node-26-only API creep.
6. **Workspace layout.** Unlike Cormidia (deliberately not a workspace), this
   repo is a pnpm workspace: `packages/learning-loop` is the library;
   `examples/*` are true consumers importing only public exports. Dev-mode
   `exports` point at TypeScript sources; publish-time artifacts are a later,
   separately gated packaging task.
7. **Transcript privacy defaults are non-negotiable** and restated in
   AGENTS.md: explicit inputs, advisory trust ceiling, redaction before
   persistence, local-only by default, no outbound model calls without opt-in.

## Consequences

- Cormidia's learning subsystem keeps operating unchanged until the migration
  campaign; no Cormidia code changes land as part of the kernel milestones.
- Every invariant in AGENTS.md ships as an executable conformance test before
  the surface claiming it is documented as supported.
