# transcript-insights

A local CLI that ingests your own Claude Code and Codex session logs, one day
at a time, into a governed learning store — and reports recurring friction
plus inert candidates. It is the library's proving ground as a true second
consumer: everything goes through the public package surfaces
(`@cormidia/learning-loop`, `@cormidia/learning-loop/node`,
`@cormidia/learning-loop-transcript-sources`; test fixtures additionally use
`@cormidia/learning-loop/testing`).

## Privacy posture

- **Local only.** No network, no telemetry, no model calls anywhere in this
  app — distillation is deterministic heuristics.
- **Redacted at emission.** The transcript adapters project structural
  features only (counts, tool names, outcomes, token totals); message text,
  tool arguments, tool results, native session ids, cwd values, branch names,
  and full paths never reach the store. Stable source, revision, session, cwd,
  and branch identities are separate tenant-keyed HMAC locators.
- **Advisory ceiling.** Both sources are registered at trust class
  `advisory`, and their immutable descriptor prevents a stronger
  registration. Nothing here can activate anything — candidates stay inert
  and publication is always blocked.
- **Aggregate output.** Diagnostics are printed as counts by code, never as
  message bodies.
- **Explicit inputs.** THIS demo (host code) discovers session files under
  the `--root` you name and hands the adapters an explicit file list plus
  that root; the adapters never crawl, confine every file to the root, and
  refuse any symbolic link on the way.
- **Policy-bound receipts.** Both adapters run under the shipped default
  `TranscriptPrivacyPolicy`; its `{ id, digest }` is bound into every import
  receipt, so the exact privacy posture that governed an import is auditable.

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
  reused for the lifetime of the store. It keys independent HMAC domains for
  source paths, source revisions, native session ids, cwd values, and branch
  names so none enters a portable dictionary-recoverable digest. Deleting,
  rotating, or copying this key across tenants changes durable identity and
  can fragment or duplicate future imports; back it up with the store.
- `store/` — the kernel's file store (append-only governed records) plus this
  demo's own `demo` namespace holding per-day aggregate ingest summaries
  (counts and diagnostic codes only).

### Adapter state compatibility

Adapter `0.2.0` replaced the `0.1.1` raw session identifiers, cwd basenames,
branch names, and unkeyed source revisions with tenant-keyed identities;
`0.3.0` adds the bound privacy policy, structural token shapes for provider
identifiers, and duplicate-segment collapsing, which changes some projections
and every receipt. Those bytes intentionally cannot be reinterpreted in place:
re-ingesting an older state with a newer adapter can create parallel
identities, mix incompatible history, or conflict where an old durable id is
reused. Preserve the old directory for read-only audit use and choose a fresh
state directory for `0.3.0` ingestion until an explicit versioned migration
exists. Do not delete the old directory as an upgrade shortcut.

Reports and distillation stream typed, bounded observation and episode pages
through the kernel façade. The app never knows the kernel's store namespace or
record kinds. Cursor pages remain insertion ordered, so a report over an
existing large state performs linear filesystem work rather than accumulating
the raw store in memory. The demo persists no transcript content or app-owned
derived index.

## What the report claims — and what it doesn't

The report shows ingestion health, per-project friction signals (correction
signals, tool failures, task aborts, usage totals), and the inert candidate
queue with the engine's governance view. All evidence is advisory and
transcript-derived: it demonstrates recurrence, not causation, and the report
never claims measured outcomes.

## Launcher note

`node src/cli.ts` works because the entry registers a scoped `node:module`
resolve hook first: the workspace's dev-mode exports point at TypeScript
sources with `.js` specifiers, which Node's native type stripping does not
remap. The runtime now mints demo identities through the root
`createIdentityPort` factory and does not import the `/testing` entrypoint. A
published dist would not need the source-resolution shim.
