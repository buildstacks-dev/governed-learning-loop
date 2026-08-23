# 0030 — Public npm publication under Apache-2.0 with source-available tarballs and OIDC

**Date:** 2026-08-23  
**Status:** ratified by the maintainer for `@cormidia/learning-loop@0.1.1`;
amends Decision 0029 R2, R4, R5, R6, and R8 where this decision is more
specific.

## Context

Decision 0029 deliberately left licensing and public npm publication for a
separate human ruling. Issue #62 carried those gates. The maintainer has now
approved a first public-registry release while keeping the source repository
private until the project is stable. The publication must not create a path
from agent access to npm credentials or release authority.

The `cormidia` npm organization exists and is owned by the maintainer.
`@cormidia/learning-loop` returned 404 and was verified unpublished on
2026-08-22. The public landing repository is
`https://github.com/cormidia/cormidia-web`; the source repository remains the
private `cormidia/governed-learning-loop` repository.

## Rulings

### R1 — Apache-2.0 from the first public version

`@cormidia/learning-loop` is licensed under Apache-2.0 from day one of public
distribution. The package contains the Apache-2.0 `LICENSE`, a `NOTICE`
crediting Bikram Gupta (2026), and the extraction provenance recorded by
Decision 0029. Its manifest declares `"license": "Apache-2.0"`.

This ruling applies to the package being published. The transcript-source and
example packages remain private and outside this release.

### R2 — The tarball contains compiled output and corresponding source

The public tarball contains `dist/`, `src/`, `LICENSE`, `NOTICE`, and
`README.md`. TypeScript tests are excluded, as are test and fixture
directories, documentation directories, environment-shaped files, JavaScript
source maps, and declaration maps. The public runtime fixtures that are part
of the ratified `/reference-detectors` contract remain ordinary source modules;
no standalone fixture directory ships.

The development export map continues to resolve to `src/*.ts`. The packed
export map continues to resolve to `dist/*.js` with `dist/*.d.ts` declarations.
Packaging gate 9 builds with `pnpm pack`, validates that every shipped source
module has JavaScript and declaration counterparts, installs the exact tarball
into a clean strict-NodeNext TypeScript consumer, imports all five documented
entrypoints, and verifies that no runtime dependency or model-provider SDK was
installed. A separate `npm pack --dry-run` assertion checks the same allowlist.

### R3 — Existing npm scope and exact package identity

The package publishes into the existing maintainer-owned npm scope as
`@cormidia/learning-loop`. No new npm organization or alternate package name
is created.

### R4 — OIDC trusted publishing, never an npm token

The release workflow is manual-dispatch only and accepts an exact 40-character
commit, an existing `vX.Y.Z` tag, and the expected lowercase tarball sha256.
It verifies that the commit is on `main`, the existing tag resolves to that
commit, and the tag matches the package version. Node 22, 24, and 26 each run
`pnpm check`, `pnpm test`, `pnpm build`, packaging gate 9, and the npm dry-run
contents assertion. Node 24 seals the exact tarball, prints its sha256, and
uploads the `learning-loop-candidate` artifact.

The publish job uses the protected `npm-publish` GitHub environment,
`id-token: write`, and npm CLI 11.19.0. Every action is pinned by commit SHA.
It runs exactly:

```text
npm publish <sealed-tarball> --access public --ignore-scripts
```

It never uses, requests, accepts, or stores an npm token. Because npm cannot
issue provenance for a private GitHub repository, the workflow deliberately
does not pass `--provenance`.

npm trusted-publisher configuration requires an existing package. Therefore
the maintainer alone performs the one-time bootstrap publication from their
machine with 2FA, using the tarball downloaded from the successful verify job
after independently matching its sha256. The maintainer then configures the
trusted publisher for repository `cormidia/governed-learning-loop`, workflow
`release.yml`, environment `npm-publish`, and enables “Require two-factor
authentication and disallow tokens.” Agents never run that bootstrap command,
handle a credential, configure the environment, create a tag, or approve a
workflow run.

Before attempting publication, the workflow reads npm registry integrity. An
absent exact version may publish; an existing version with matching sha512
integrity is a successful no-op; an existing version with different integrity
fails closed. The same dispatch inputs can therefore be rerun after the
bootstrap publication without an immutable-version error.

### R5 — Public landing homepage and honest source metadata

The package homepage is `https://github.com/cormidia/cormidia-web#readme`.
That public repository is a landing page only: it names
`@cormidia/learning-loop`, `validation-architect`,
`validation-architect-design`, and `cormidia`; marks them work in progress;
links their npm pages; and carries Apache-2.0 landing-page licensing plus an
email security contact. It contains no product source and no private-repository
links.

The package `repository` metadata continues to name the real private source
repository. It is not redirected to the landing repository.

### R6 — Preserve the vendored baseline and publish 0.1.1

The maintainer creates `v0.1.0` at `a32759d`, the exact tree from which
Cormidia's vendored tarball was packed, and creates `v0.1.1` at the publication
PR's squash commit. The first npm registry version is 0.1.1. The preparation
PR bumps the manifest to 0.1.1 but retains `"private": true`; a second,
publication-only PR removes that one field after green CI. Both changes land by
squash merge. Cormidia's vendored tarball is not changed in this campaign.

## Deferred visibility change

The source repository remains private while the package stabilizes. A future
separately approved action may make it public. That action must update security
intake, enable GitHub private vulnerability reporting, and enable npm
provenance in the release workflow at the same time. None of those visibility
changes is part of this publication.

## Consequences

- `@cormidia/learning-loop@0.1.1` becomes a public, source-available Apache-2.0
  package without making the source repository public.
- Package contents and consumer resolution are executable CI gates, not a
  hand-inspected checklist.
- npm release authority remains human-gated and credentialless from GitHub;
  authorization to publish is not delegated to a stored secret.
- Registry immutability is reconciled explicitly, making bootstrap recovery
  and later job retries safe for the exact candidate and fail-closed otherwise.
