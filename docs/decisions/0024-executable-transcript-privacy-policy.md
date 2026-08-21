# 0024 — Executable transcript privacy policy and adversarial negative controls

**Date:** 2026-08-21
**Status:** ratified — issue #9 (milestone M2)

## Context

Decision 0001 made transcript privacy defaults non-negotiable and decision
0004 made source/page lineage durable, but the policy an adapter actually ran
under was implicit: ceilings were module constants, symlink refusal covered
only the final path component, native type/tool/version strings were copied
verbatim (truncated to 64 characters), nothing bounded nesting depth or
processing time, and no durable record said which privacy posture governed a
given import. The extraction plan (§Executable transcript privacy policy)
requires each adapter to run under a content-addressed
`TranscriptPrivacyPolicy` whose receipt is bound to the import, plus an
executable negative-control catalog. Issue #9 is also a prerequisite for the
optional semantic workflows of #13, which already keep outbound disclosure
under their own authorization and receipt discipline (decisions 0021–0023).

## Rulings

1. **The kernel binds an opaque, content-addressed source privacy-policy
   declaration as lineage.** `SourceDescriptor` gains an optional
   `privacyPolicy: { id, digest }`. `defineSourceRegistration` parses it from
   the untrusted descriptor (bounded control-free id, lowercase SHA-256 digest;
   any malformation is `config.invalid`), snapshots it so later descriptor
   mutation cannot rebind receipts, and folds it into the source registration
   revision. Ingest writes the exact declaration into every
   `SourcePageReceipt` and `ImportReceipt` as an optional `privacyPolicy`
   member that enters both digests only when present, so historical receipts
   keep their bytes. The kernel never sees policy content, cannot verify that
   an adapter enforced it, and treats the declaration like `adapterVersion`:
   exact audit lineage, never trust, authority, or validation.
2. **`TranscriptPrivacyPolicy` is an executable, private-value-free record of
   the adapter package.** Its `policyDigest` is the SHA-256 of the canonical
   JSON of every field except `schemaVersion` and itself. The record carries
   no path, key, tenant, or session value by construction, so the plain digest
   is safe to persist and to dictionary-probe. The parser accepts `unknown`,
   recomputes the digest, ignores unknown fields (which therefore never enter
   the digest), and enforces **closed literals** for input mechanism
   (`explicit_files`), discovery (`forbidden`), access (`read_only`), symlinks
   (`refuse`), decoding of compressed input (`refuse`), raw-content
   persistence (`never`), message text (`structural_features_only`), private
   identities (`tenant_keyed`), diagnostics (`static_codes_only`), duplicate
   segments (`collapse`), outbound model calls (`forbidden`), derived-artifact
   publication (`private`), classification (`sensitive_untrusted`), processing
   basis (`explicit_user_selection`), and trust maximum (`advisory`). No policy
   content can loosen these; only a new schema version could admit other
   values, and an adapter that wanted outbound disclosure would have to go
   through the separately authorized `/workflows` path, never this policy.
3. **Ceilings are policy content and may only tighten.** File bytes, line
   bytes, records per file, nesting depth, and processing milliseconds per
   file are integers from 1 through the shipped maxima in `limits.ts`
   (50 MiB, 2 MiB, 200,000, 128, 60,000 ms). Every breach fails closed with a
   `source.limit_exceeded` diagnostic naming the ceiling kind and counts: a
   breach on the first content line refuses the file whole (`corrupt` with its
   observed revision), a later breach skips the line or remainder and marks
   the page `partial`. Nesting depth is checked by a bounded pre-parse bracket
   scan before `JSON.parse`; compressed or binary input (gzip, zlib, zstd, xz,
   bzip2, zip, 7z magic bytes, or a raw NUL) is refused as `unsupported`
   before any decoding because the adapters have no inflate path.
4. **Root confinement is executable and required by default.** The input
   gains optional `roots`; the default policy sets
   `input.rootConfinement: "required"`, so a call without roots is a typed
   `schema.invalid` error. Paths and roots are normalized lexically (never
   resolved through links) at the input boundary, duplicate paths are refused
   typed, and every file must sit lexically inside one root, have no symbolic
   link on any directory between the root and the file, and still resolve
   inside the resolved root — on top of the existing final-component `lstat`
   plus `O_NOFOLLOW` refusal. Confinement refusals are per-file
   `source.input_refused` pages in state `unreadable` (or `missing`), so the
   cursor stays index-aligned and the kernel records a durable
   `source.unreadable` evidence-health finding. A root that is itself a link
   is accepted as the caller's declared boundary. Private identities are
   keyed over the normalized path.
5. **Provider identifiers are admitted by structural shape, never by
   truncation.** Native record types must be lowercase snake/kebab tokens,
   tool names identifier-shaped tokens, both at most 64 characters with no
   run longer than 24 characters between separators and no run of four or
   more digits; provider versions project only their numeric core. Anything
   else projects as the fixed token `non_conforming`. This is a shape filter,
   not a secret detector: a lowercase-kebab string is indistinguishable from a
   provider type name and is admitted whole. There is no truncation of
   arbitrary text anywhere in the adapters, so no secret can straddle a cut.
6. **Duplicated segments never become independent recurrence.** A repeated
   explicit path is a typed input error. Inside one Claude Code file a
   repeated native `uuid` is a collapsed duplicate segment (counted in an
   info-level `source.duplicate_segment` diagnostic, not incompleteness).
   Codex event duplicates of response items stay silent. A byte-identical copy
   under another path yields the same episode identity and zero net-new
   derivatives: the kernel folds the episode as reused and rejects the
   conflicting observation records, durably, in the copy's page receipt.
   Cross-file duplicated prefixes of forked sessions are an explicit known
   boundary and are not claimed.
7. **Injection safety is structural.** The adapter package imports only
   `node:buffer`, `node:crypto`, `node:fs`, `node:fs/promises`, `node:path`,
   `node:perf_hooks`, and the kernel; it composes no execution, network,
   authority, publication, environment, or logging capability, and a test
   pins that import graph and forbids dynamic import, `eval`, `Function`,
   `fetch`, `process.env`, and console or stream writes. Every projection
   stays inside a closed per-kind key vocabulary with structural string
   values, transcripts stay `advisory`, and episode status stays `unknown`
   regardless of wording.
8. **`disposition` is declared and digested but not yet enforced.** The
   policy records `onSourceDeletion` and `onConsentRevocation`
   (`tombstone_and_refuse | retain_under_basis | queue_human_disposition`,
   the latter without `retain_under_basis`) so the host's commitment is bound
   into receipts, but the kernel has no deletion or revocation lineage API
   (decision 0004 defers it to issue #31). Nothing in this decision tombstones
   or deletes a derivative.
9. **Adapter version 0.3.0.** Policy-bound reads, token shapes, and duplicate
   collapsing change some projections and every receipt, so both adapters
   bump to `0.3.0-experimental+…`. `0.2.0` states remain read-only audit
   history and are not re-ingested in place; use a fresh state until an
   explicit versioned migration exists.

## Consequences

- No new root symbol: `SourceDescriptor`, `SourcePageReceipt`, and
  `ImportReceipt` gain an optional member; `docs/public-api.txt` is unchanged.
  The adapter package exports `TranscriptPrivacyPolicy`,
  `TranscriptSourceOptions`, `defaultTranscriptPrivacyPolicy`,
  `parseTranscriptPrivacyPolicy`, `transcriptPrivacyPolicyDigest`,
  `MAX_NESTING_DEPTH`, and `MAX_PROCESSING_MILLIS_PER_FILE`.
- `createClaudeCodeTranscriptSource` and `createCodexTranscriptSource` accept
  `{ privacyPolicy }` and parse it from `unknown`; omission means the shipped
  conservative default, whose digest is pinned as a golden vector.
- Hosts that enumerate files must now declare `roots` (the example passes its
  `--root`). A host that genuinely cannot declare roots must register a policy
  with `rootConfinement: "optional"`, which still refuses every symlink.
- The negative-control catalog ships as executable fixtures under
  `packages/transcript-sources/tests/negative-controls/`: truncation
  straddling, prompt injection, decompression and nesting bombs, path
  traversal and symlink escape, duplicated segments, and leakage into logs,
  diagnostics, thrown errors, durable bytes, and dictionary-recoverable
  hashes. Each control also runs through a real kernel loop over a filesystem
  store and greps every durable byte for its canary.
- Calibration of any default-quality claim, outbound disclosure previews and
  receipts for model workflows, and deletion/revocation enforcement remain
  with #26, #13's ratified decisions, and #31 respectively.
