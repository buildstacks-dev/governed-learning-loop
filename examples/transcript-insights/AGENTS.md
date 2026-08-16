# AGENTS.md — examples/transcript-insights

Local conventions on top of the repository rules:

- **Package-name imports only.** This example consumes
  `@cormidia/learning-loop`, `@cormidia/learning-loop/node`,
  `@cormidia/learning-loop/testing`, and
  `@cormidia/learning-loop-transcript-sources` — never relative imports into
  `packages/` and never deep subpaths. It is the second-consumer proving
  ground; friction goes into PR feedback, not into workarounds that touch the
  packages.
- **The `demo` store namespace belongs to this app.** Kernel records live in
  the engine's `learning` namespace (read-only here, validated on read with
  the public parsers); demo bookkeeping (per-day ingest summaries) lives in
  `demo`. Never write into `learning`.
- **Aggregate output only.** CLI output and demo-owned records carry counts
  and diagnostic CODES, never diagnostic message bodies, transcript content,
  or full paths.
- **No model calls.** Distillation is deterministic; keep it that way.
- **Report wording.** The report claims recurrence, never causation, and
  never uses the kernel's measured-outcome vocabulary ("improvement" /
  "improved") — a test enforces this.
- **Fixtures are hand-authored.** Test sessions are synthetic; never copy
  real transcript lines into fixtures.
- **src/cli.ts owns the runtime shims** (`.js`→`.ts` resolve retry, vitest
  stub for the /testing entrypoint). Tests import `src/run.ts` directly and
  must not depend on the shims.
