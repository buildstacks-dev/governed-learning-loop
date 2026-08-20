# 0020 — Runtime-safe testing conformance

**Date:** 2026-08-20
**Status:** ratified — issue #24 testing-runtime decoupling

## Context

`@cormidia/learning-loop/testing` exports deterministic stores, clocks, ids,
builders, and the public LearningStore conformance runner. The runner formerly
imported Vitest at module evaluation time. Because `/testing` re-exported that
runner, a plain Node consumer importing any testing helper also loaded Vitest,
which fails outside a Vitest worker. PR #21 needed a local Vitest resolver stub
even though its runtime path did not intend to register a conformance suite.

The suite remains part of the public adapter contract. The fix must preserve
one supported `/testing` entrypoint and its export names without making a test
framework a runtime dependency.

## Rulings

1. **`/testing` is runtime-safe.** No source module reachable from the entrypoint
   imports Vitest or another test framework. Importing the entrypoint in plain
   Node neither inspects worker state nor registers or executes tests. Runtime
   consumers may use its stores, deterministic fixtures, and builders.
2. **The conformance runner uses explicit injection.** The existing
   `runLearningStoreConformance` function receives the store factory first and
   a required `{ describe, expect, it }` object second. It destructures that
   caller-owned API and registers the same ten LearningStore cases. It has no
   optional, global, lazy-import, or framework-specific fallback.
3. **The injected API is minimal and structural.** Its inline TypeScript shape
   contains only the suite/test registration functions and exact expectation
   matchers the conformance implementation calls. There is no Vitest type
   import and no new exported test-runner interface. Vitest's exported
   functions satisfy the shape under strict TypeScript without a cast; another
   runner may provide the same semantics.
4. **The migration is an intentional package-API change.** Adapter suites move
   from:

   ```ts
   runLearningStoreConformance(makeStore);
   ```

   to:

   ```ts
   import { runLearningStoreConformance } from "@cormidia/learning-loop/testing";
   import { describe, expect, it } from "vitest";

   runLearningStoreConformance(makeStore, { describe, expect, it });
   ```

   The caller therefore chooses and owns its test framework exactly where the
   suite is registered. Merely importing a different `/testing` helper needs no
   runner dependency or stub.
5. **The public names and package shape do not grow.** `/testing` still exports
   `LearningStoreFactory` and `runLearningStoreConformance`; no
   `/testing/conformance` subpath or named test-API type is added. The
   pre-reference entrypoints remain 154 symbols and `/reference-detectors`
   remains two, so the complete export snapshot stays at 156 without changing
   `docs/public-api.txt`.

## Validation and consequences

- Both the in-memory and filesystem adapters import the runner through the
  public `/testing` subpath and inject Vitest's actual exports. They execute the
  unchanged conformance cases.
- A separate child Node process removes Vitest and Node preload environment,
  self-imports `@cormidia/learning-loop/testing`, registers the suite through a
  caller-owned minimal API, and exercises the store, clock, and id helpers. Its
  repository-only resolver maps emitted `.js` specifiers to TypeScript sources
  solely because the unpublished development export map points at source; it
  neither imports nor stubs Vitest.
- Vitest remains a workspace development dependency for this repository. It is
  not imported by package source and does not become a package runtime
  dependency.
- No durable record, digest, store protocol, engine behavior, subpath, root
  symbol, or reference-detector symbol changes.
