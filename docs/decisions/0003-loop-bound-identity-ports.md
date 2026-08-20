# 0003 — Loop-bound identity ports

**Date:** 2026-08-19
**Status:** ratified — issue #23 security correction

## Context

The ratified contract says the host owns authentication and that only its
configured `IdentityPort` may mint a `VerifiedPrincipal`. The initial
implementation made the brand symbol package-private, but exposed no root
factory that a host could use to attach it. The example therefore authenticated
against its own roster and delegated minting to `/testing`.

That workaround revealed a second defect. The package-private brand proved only
that some module in this package minted a handle. `LearningLoopConfig.identity`
was absent from the loop registry digest and engine context, so propose and
review could accept a handle minted by an unrelated test or host port. A public
minter without exact loop binding would preserve that confused-deputy path.

Identity registration lineage and live authority are related but different.
Registration bytes must be stable and content-digested across equivalent
compositions. Authority must not become transferable merely because another
object claims the same bytes.

## Rulings

1. **The kernel owns the minting factory.** The root exports
   `createIdentityPort`. Its inline input contains a stable `id` and `version`
   (each non-empty, control-free, and at most 200 characters), a host-computed
   `configurationDigest`, and a host verifier
   `(evidence: unknown) => Promise<unknown>`. No brand symbol becomes public,
   and a host no longer imports `/testing` to mint production handles.
2. **The host owns authentication; the kernel parses its result.** The verifier
   receives opaque evidence and is responsible for authenticating it. Its
   result crosses a trust boundary as `unknown` and must parse as
   `{ ref, attestationId, attestationDigest }`. The kernel requires the
   principal id and independence domain to be non-empty, control-free, and at
   most 1,000 characters; requires the attestation id to meet the same bound;
   requires a 64-character lower-case hexadecimal attestation digest;
   constructs a fresh frozen copy; and then brands it. Returning a branded or
   mutable host object is not a supported shortcut.
3. **Identity registrations are immutable and content-digested.** An
   `IdentityPort` exposes read-only `id`, `version`, `configurationDigest`, and
   `registrationDigest` fields plus a private phantom brand. The registration
   digest is SHA-256 over the protocol canonical JSON of exactly
   `{ id, version, configurationDigest }`. The computed digest, verifier
   function, and runtime token are excluded. Both configuration and attestation
   digests use 64-character lower-case hexadecimal rendering.
4. **Raw private configuration does not cross into the kernel.** The host, not
   the kernel, computes `configurationDigest` over the exact verifier policy,
   provider/realm mapping, principal-kind and independence-domain mapping, and
   other behavior that changes verification meaning. Raw rosters, secrets, and
   credentials are never factory input. A low-entropy private configuration
   uses a tenant-scoped keyed digest so a portable unsalted digest cannot become
   an enumeration oracle.
5. **Stable lineage is not live authority.** Equivalent inputs to two factory
   calls produce the same deterministic registration digest. Each call also
   receives a distinct unexported process-local token, associated with the port
   and every handle it mints through private weak maps. Propose and review
   require the token of the exact port instance retained by their loop. A
   foreign-port handle is refused even when its `PrincipalRef`, attestation
   fields, and registration metadata are byte-identical.
6. **Identity participates in the loop registry.** The loop-registry digest
   includes the configured identity port's exact public
   `{ id, version, configurationDigest, registrationDigest }` metadata.
   `createLearningLoop` rejects an unrecognized structural lookalike, retains
   the configured port in engine context, and performs exact-port handle checks
   before candidate proposal and review.
7. **Verified handles are ephemeral capabilities.** A `VerifiedPrincipal`
   remains non-serializable. Its private brand and port binding do not survive a
   process restart, structured clone, or JSON round trip. Hosts re-verify
   evidence through the newly composed port after restart; only `PrincipalRef`
   and the attestation digest are durable projections.

## Consequences

- `createIdentityPort` is one deliberate root export. `IdentityPort` gains
  registration metadata and a private phantom brand; no public verifier-result
  type or brand symbol is added to the export budget.
- `/testing` keeps the zero-argument `createTestIdentityPort` consumer API, but
  implements it as a deterministic wrapper around the root factory. Its fixed
  test registration is not accepted by a loop configured with another port.
- The transcript-insights demo keeps its host-owned roster and evidence parser,
  but moves minting to the root factory. Its runtime source graph no longer
  needs `/testing`, so the vitest import shim and stub can be removed.
- Adding identity metadata changes loop registry revisions and invalidates old
  opaque query cursors by design. Source registrations, durable evidence,
  schema-version-1 candidates, and schema-version-1 reviews are not rewritten.
  Existing durable attribution records do not become live capabilities; every
  new proposal or review requires a freshly verified exact-port handle.
- Conformance covers malformed verifier results, digest formatting, immutable
  copies, deterministic registration digests, distinct per-instance tokens,
  JavaScript-shaped lookalikes, two ports with byte-identical principal data,
  cross-port proposal/review refusal, test-port refusal, and registry revision
  changes when any identity registration field changes.
