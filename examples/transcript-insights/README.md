# transcript-insights

A local CLI that ingests your own Claude Code and Codex session logs, one day
at a time, into a governed learning store — and reports recurring friction
plus inert candidates. It is the library's proving ground as a true second
consumer: everything goes through the public package surfaces
(`@cormidia/learning-loop`, `@cormidia/learning-loop/node`,
`@cormidia/learning-loop/testing`, `@cormidia/learning-loop-transcript-sources`).

## Privacy posture

- **Local only.** No network, no telemetry, no model calls anywhere in this
  app — distillation is deterministic heuristics.
- **Redacted at emission.** The transcript adapters project structural
  features only (counts, tool names, outcomes, token totals); message text,
  tool arguments, tool results, and full paths never reach the store.
- **Advisory ceiling.** Both sources are registered at trust class
  `advisory`; nothing here can activate anything — candidates stay inert and
  publication is always blocked.
- **Aggregate output.** Diagnostics are printed as counts by code, never as
  message bodies.
- **Explicit inputs.** THIS demo (host code) discovers session files under
  the `--root` you name and hands the adapters an explicit file list; the
  adapters never crawl.

## Usage

Run from the repository root (Node >= 22.18, `pnpm install` done):

```sh
pnpm --filter transcript-insights start -- --help
```

Ingest one day of Claude Code history into a state directory you choose:

```sh
pnpm --filter transcript-insights start -- ingest \
  --provider claude-code --root ~/.claude/projects \
  --day 2026-08-14 --state ~/ti-state
```

Backfill a whole month of both providers (resumable — just re-run; ingestion
is idempotent, so already-imported days report zero net-new):

```sh
pnpm --filter transcript-insights start -- backfill \
  --provider claude-code --root ~/.claude/projects \
  --from 2026-07-01 --to 2026-07-31 --state ~/ti-state
pnpm --filter transcript-insights start -- backfill \
  --provider codex --root ~/.codex/sessions \
  --from 2026-07-01 --to 2026-07-31 --state ~/ti-state
```

Then distill, review, and report:

```sh
pnpm --filter transcript-insights start -- distill --state ~/ti-state
pnpm --filter transcript-insights start -- review --state ~/ti-state \
  --candidate <id-from-distill> --accept --note "recurs for me too"
pnpm --filter transcript-insights start -- report --state ~/ti-state
```

Long-running commands emit plain, non-TTY progress lines through stdout.
Every command starts by naming its resolved state directory. `report` and the
scan phase of `distill` report record/page counts as they fold the store;
`ingest` and `backfill` announce each day's aggregate file count before ingest
and emit a heartbeat every five seconds while a day is still running. These
lines contain counts, provider/day identifiers, and diagnostic codes only —
never transcript content or session paths. `report` is read-only; `distill`
writes only after the scan, when it proposes qualifying inert candidates.

## How days are attributed

- `claude-code`: `<root>/*/*.jsonl` whose file **mtime** falls on `--day`
  (local time). Heuristic limits: a session spanning midnight lands wholly on
  the day of its last write, and touching an old file re-dates it.
- `codex`: `<root>/YYYY/MM/DD/*.jsonl` — the provider already partitions by
  day directory.

## State directory

- `locator.key` — 32 random bytes (hex, mode 0600), minted on first run and
  reused. It salts the adapters' keyed cwd locator so paths never enter a
  dictionary-recoverable digest. Deleting it makes future re-ingests of
  already-imported sessions conflict on the session-meta record; keep it with
  the store.
- `store/` — the kernel's file store (append-only governed records) plus this
  demo's own `demo` namespace holding per-day aggregate ingest summaries
  (counts and diagnostic codes only).

The first list in a process validates the namespace's record files and builds
an insertion-ordered path catalog in memory. Later cursor pages seek through
that catalog and reopen only the records in the requested page. A report over
an existing large state therefore performs linear filesystem work rather than
re-reading the whole namespace for every 200-record page; no derived index or
transcript data is persisted.

## What the report claims — and what it doesn't

The report shows ingestion health, per-project friction signals (correction
signals, tool failures, task aborts, usage totals), and the inert candidate
queue with the engine's governance view. All evidence is advisory and
transcript-derived: it demonstrates recurrence, not causation, and the report
never claims measured outcomes.

Known caveat: Claude Code usage totals currently undercount to zero because
of an upstream adapter defect (same-line projections share a source record
id; the engine keeps the first and drops the rest as `store.conflict` — the
counts appear honestly in the report's diagnostics section).

## Launcher note

`node src/cli.ts` works because the entry registers a scoped `node:module`
resolve hook first: the workspace's dev-mode exports point at TypeScript
sources with `.js` specifiers, which Node's native type stripping does not
remap, and the kernel's `/testing` entrypoint eagerly imports vitest (stubbed
for the CLI process). A published dist would need neither shim; see the PR
notes for the upstream feedback.
