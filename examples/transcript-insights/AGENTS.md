# AGENTS.md — examples/transcript-insights

Local conventions on top of the repository rules:

- **Package-name imports only.** This example consumes
  `@cormidia/learning-loop`, `@cormidia/learning-loop/node`,
  and `@cormidia/learning-loop-transcript-sources` at runtime;
  `@cormidia/learning-loop/testing` is test-only. Never use relative imports
  into `packages/` or deep subpaths. It is the second-consumer proving ground;
  friction goes into PR feedback, not into workarounds that touch the packages.
- **The `demo` store namespace belongs to this app.** Kernel observations,
  episodes, and candidate governance are read only through the public learning
  façade; the app never names or lists an engine namespace or record kind.
  Demo bookkeeping (per-day ingest summaries) lives in `demo`.
- **Aggregate output only.** CLI output and demo-owned records carry counts
  and diagnostic CODES, never diagnostic message bodies, transcript content,
  or full paths.
- **No model calls.** Distillation is deterministic; keep it that way.
- **Report wording.** The report claims recurrence, never causation, and
  never uses the kernel's measured-outcome vocabulary ("improvement" /
  "improved") — a test enforces this.
- **Fixtures are hand-authored.** Test sessions are synthetic; never copy
  real transcript lines into fixtures.
- **src/cli.ts owns the source launcher shim** (the `.js`→`.ts` resolve retry).
  Tests import `src/run.ts` directly and must not depend on the shim.
