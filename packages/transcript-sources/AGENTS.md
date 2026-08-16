# packages/transcript-sources — AGENTS.md

Transcript source adapters (Claude Code, Codex) for `@cormidia/learning-loop`.
The root AGENTS.md applies in full; this file restates the privacy rules that
are NON-NEGOTIABLE for this package (decision 0001, ruling 7).

## Privacy rules

- **Explicit inputs only.** The caller enumerates files
  (`{ kind: "explicit_files", paths, locatorKey }`). Adapters never discover,
  glob, crawl, or follow symlinks — every path is `lstat`ed and opened with
  `O_NOFOLLOW`; symlinks and non-regular files are refused with a diagnostic.
- **Advisory trust ceiling.** Host registration caps transcript sources at
  `advisory`; nothing in this package may raise trust, and no adapter emits
  measurements (metric trust is a separate, host-registered path).
- **Redaction precedes persistence.** The projections these adapters emit are
  what gets persisted, so minimize at emission: no message text, tool
  arguments, tool results, instructions, or full filesystem paths in any
  projection. Emitted features: char counts, actor, tool names, outcomes,
  token counts, task signals, provider/version metadata, project slug (cwd
  basename), and a keyed cwd locator (`sha256(locatorKey + ":" + cwd)`) so raw
  paths never enter a dictionary-recoverable digest.
- **Heuristics are transient.** Correction-signal regexes run over human text
  in memory; the text is dropped, only the boolean survives.
- **Ceilings fail closed** (`src/limits.ts`): 50 MiB/file, 2 MiB/line, 200k
  records/file. A breach yields a skipped file or a partial page plus a
  diagnostic — never a crash, never silent truncation.
- **Diagnostics never echo transcript content.** Static messages only: never
  interpolate line content and never propagate `JSON.parse` error messages
  (V8 quotes the input bytes in them). Files are referenced by input index
  and basename, never by full path.
- **Fixtures are synthetic.** Never copy real transcript content — text,
  prompts, paths, ids — into code, fixtures, tests, or comments. Verifying
  STRUCTURE (keys, types, enum values) against local logs is fine.
- **No outbound calls.** These adapters read local files and emit projections;
  they never receive network, authority, publication, or context capabilities.

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
