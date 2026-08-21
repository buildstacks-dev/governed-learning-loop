# packages/transcript-sources — AGENTS.md

Transcript source adapters (Claude Code, Codex) for `@cormidia/learning-loop`.
The root AGENTS.md applies in full; this file restates the privacy rules that
are NON-NEGOTIABLE for this package (decision 0001, ruling 7).

## Privacy rules

- **One content-addressed policy governs every read.** Each adapter runs
  under a `TranscriptPrivacyPolicy` (`src/privacy-policy.ts`, decision 0024):
  the factory parses the configured policy from `unknown` (default: the
  shipped conservative policy) and declares `{ id, digest: policyDigest }` on
  its `SourceDescriptor.privacyPolicy`, which the kernel binds into the source
  registration revision and every page/import receipt. The policy holds no
  private values; every single-valued member is a closed literal the parser
  refuses to loosen; ceilings may only tighten `src/limits.ts`. Changing the
  default changes its pinned golden digest — do that deliberately.
- **Explicit inputs only.** The caller enumerates files
  (`{ kind: "explicit_files", paths, locatorKey, roots }`). Adapters never
  discover, glob, crawl, or follow symlinks. Paths and roots are normalized
  lexically; every file must sit inside a declared root (required by the
  default policy), no directory between the root and the file may be a
  symbolic link, the resolved path must stay inside the resolved root, and
  the file is then `lstat`ed and opened with `O_NOFOLLOW`. Duplicate explicit
  paths are a typed input error; confinement refusals are per-file
  `source.input_refused` pages so the cursor stays index-aligned.
- **Advisory trust ceiling.** Host registration caps transcript sources at
  `advisory`; the descriptor carries that immutable maximum and registration
  must reject `observed` or `verified`. Nothing in this package may raise
  trust, and no adapter emits measurements (metric trust is a separate,
  host-registered path).
- **Stable tenant key.** `locatorKey` contains at least 32 UTF-8 bytes of
  tenant-scoped secret key material and remains stable for the lifetime of its
  store. It keys independent HMAC domains for source paths, source revisions,
  native session ids, cwd values, and branch values. A short, shared, rotated,
  or regenerated key is a privacy and identity defect, not a harmless retry.
- **Redaction precedes persistence.** The projections these adapters emit are
  what gets persisted, so minimize at emission: no message text, tool
  arguments, tool results, instructions, native session ids, cwd values,
  branch names, or full filesystem paths in any projection. Emitted features:
  char counts, actor, tool names, outcomes, token counts, task signals,
  provider/version metadata, and domain-separated tenant HMAC locators for
  source, revision, session, cwd, and branch identity. Project scope uses the
  cwd locator rather than a raw basename.
- **Provider identifiers are shape-admitted, never truncated.** Native record
  types, tool names, and version strings are the only strings copied out of a
  transcript; `src/project.ts` admits them only when they have the structural
  shape of their kind (bounded tokens, no long runs, no digit runs; versions
  keep only their numeric core) and otherwise projects `non_conforming`.
  Never add a `slice`/truncate of transcript-derived text anywhere.
- **Duplicated segments collapse.** A repeated native record identity inside
  one file projects once (`source.duplicate_segment`, info, not
  incompleteness); Codex event duplicates of response items stay silent; a
  byte-identical copy under another path folds to the same episode in the
  kernel with no net-new derivative.
- **Heuristics are transient.** Correction-signal regexes run over human text
  in memory; the text is dropped, only the boolean survives.
- **Ceilings fail closed** (`src/limits.ts` are the maxima; the policy may
  tighten): 50 MiB/file, 2 MiB/line, 200k records/file, nesting depth 128
  (pre-parse bracket scan), 60 s/file. A breach yields a refused file or a
  partial page plus a `source.limit_exceeded` diagnostic naming the ceiling —
  never a crash, never silent truncation. Compressed or binary input (magic
  bytes or a raw NUL) is refused before decoding; there is no inflate path.
- **Diagnostics never echo transcript content.** Static messages only: never
  interpolate line content and never propagate `JSON.parse` error messages
  (V8 quotes the input bytes in them). Files are referenced by input index
  only, never by basename or full path.
- **Fixtures are synthetic.** Never copy real transcript content — text,
  prompts, paths, ids — into code, fixtures, tests, or comments. Verifying
  STRUCTURE (keys, types, enum values) against local logs is fine.
- **No outbound calls, no capabilities.** These adapters read local files and
  emit projections; they never receive network, authority, publication, or
  context capabilities. The import allowlist (`node:buffer`, `node:crypto`,
  `node:fs`, `node:fs/promises`, `node:path`, `node:perf_hooks`, the kernel)
  is pinned by a test, as is the absence of dynamic import, `eval`,
  `Function`, `fetch`, `process.env`, and console or stream writes.
- **The negative-control catalog is the executable statement of these rules.**
  `tests/negative-controls/` covers truncation straddling, prompt injection,
  decompression and nesting bombs, path traversal and symlink escape,
  duplicated segments, and leakage into logs, diagnostics, thrown errors,
  durable bytes, and dictionary-recoverable hashes. Extend a control when you
  touch the behaviour it pins; never soften one to pass.

## Shape

- `src/index.ts` is the only entrypoint (`.` export); no deep imports.
- This package doubles as the strict second consumer of the kernel: import
  `@cormidia/learning-loop` by name only — never relative paths into
  `../learning-loop`, never subpath internals.
- Unknown-first parsing per the kernel idiom: provider records arrive as
  `unknown`, are narrowed with type predicates (`src/narrow.ts`), and drift
  refuses typed (`source.unsupported_format`) instead of guessing. Unknown
  record types stay visible as `transcript.unknown` observations carrying
  only the native type name, never the payload.
- Adapter version `0.2.0` deliberately changed durable identities from
  `0.1.1`; `0.3.0` adds policy-bound reads, token shapes, and duplicate
  collapsing, changing some projections and every receipt. An old state is
  preserved for read/audit use but is not re-ingested in place; use a fresh
  state or an explicit future migration.
