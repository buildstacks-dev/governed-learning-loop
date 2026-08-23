# Security policy

`@cormidia/learning-loop` is pre-1.0 and its first public-registry release is
being prepared. There are no supported release lines yet: fixes land on `main`
and ship in the next tag. Decisions 0029 and 0030 record the intake and release
policy below.

## Reporting a vulnerability

- While this repository is private, open an issue in this repository. Only
  organization members can see it, so the report stays confidential by
  construction. Label it `security`.
- Once the repository is public, use GitHub private vulnerability reporting
  ("Report a vulnerability" under the Security tab). It is enabled in the same
  action that makes the repository public. Do not open a public issue for an
  unfixed vulnerability.
- Email [security@cormidia.dev](mailto:security@cormidia.dev). Do not include
  credentials, tokens, production data, or raw private transcripts.

Include the affected entrypoint (`.`, `/node`, `/testing`,
`/reference-detectors`, `/workflows`), a minimal reproduction, and which
kernel invariant you believe is broken (candidate inertness, proposer/reviewer
independence, authorized ≠ validated, exact-content binding, fail-closed
measurement, host-granted trust, loop-bound principals). Reports that show an
invariant can be bypassed from inside a host are in scope even when the host is
misconfigured.

## What is in scope

- Any way for a candidate, transcript-derived record, or model output to reach
  active context, authority, publication, or a non-`untested` validation state
  without the recorded human path.
- Any transcript-adapter path that persists or echoes raw transcript content,
  escapes the caller-declared roots, follows a symbolic link, or exceeds a
  declared ceiling.
- Any store or journal sequence where two writers, or a crash between steps,
  yields a record that passes the public parsers but violates a digest or
  lineage rule.

## Supply chain

The root package has zero runtime dependencies and imports only `node:`
built-ins. Development dependencies are installed with a frozen lockfile behind
a three-day minimum release age (`pnpm-workspace.yaml`). The exact-tag release
workflow authenticates to npm only through OIDC trusted publishing, carries no
npm token, seals and verifies the candidate tarball digest, and refuses an
existing version unless registry integrity matches exactly.
