# 0031 — Private-repository release approval uses an explicit maintainer dispatch

**Date:** 2026-08-23  
**Status:** ratified by the maintainer after the Phase 4 environment bootstrap;
amends Decision 0030 R4 only.

## Context

Decision 0030 required the `publish` job to use a GitHub environment named
`npm-publish`, with Bikram Gupta as its required reviewer. The source repository
remains private and the `cormidia` organization uses GitHub Team.

The maintainer attempted to create the rule after the 0.1.1 publication commit
and tags existed. GitHub created the environment but returned HTTP 422 for its
required-reviewer rule: that protection is unavailable to private repositories
on GitHub Team. The resulting environment had an empty `protection_rules`
array and therefore provided no approval gate. GitHub Enterprise Cloud would
make the rule available, but upgrading solely to add a second click by the same
sole maintainer is not proportionate to this pre-1.0 release.

The relevant authority facts are unchanged: Bikram Gupta is the repository's
sole owner and the only ratified npm publisher. No independent second release
principal exists. The unavailable environment would have allowed self-review,
so it would not have created principal independence.

## Ruling

The release remains manual, exact, OIDC-only, and maintainer-gated, but it does
not use a GitHub environment.

`release.yml` has a required boolean `publish` dispatch input whose default is
`false`:

- `publish=false` runs the Node 22/24/26 verification matrix, builds and
  inspects the package, and seals the exact `learning-loop-candidate` artifact.
  The digest input may be omitted to discover the canonical GitHub/Linux
  sha256, or supplied to bind an already reviewed candidate. The publish job is
  skipped and receives no OIDC permission.
- `publish=true` is an explicit publication instruction. Only GitHub actor
  `bikramgupta` is admitted for that mode. The new run repeats the complete
  verification matrix before the publish job becomes eligible for
  `id-token: write`.

The operating procedure uses two dispatches. The maintainer first dispatches
with `publish=false`, reviews the successful checks and sealed artifact, and
only then dispatches the same exact commit, tag, and digest with
`publish=true`. For the one-time bootstrap, the maintainer publishes the sealed
artifact interactively between those dispatches; the second dispatch must
observe matching registry integrity and no-op.

The first live verify-only dispatch exposed one private-repository checkout
defect: checkout correctly removed its credential, but a later `git fetch`
therefore could not authenticate. The corrected workflow checks out the exact
tag with full history, verifies that it resolves to the approved commit, and
proves that commit is an ancestor of the dispatch-time `main` SHA supplied by
GitHub. It performs no post-checkout fetch and still persists no credential.

All other Decision 0030 R4 controls remain mandatory:

- the exact commit must be on `main`;
- the existing exact tag must resolve to that commit and match package version;
- `publish=true` requires the expected lowercase tarball sha256 as a dispatch
  input and it must match the rebuilt artifact;
- Node 22, 24, and 26 each run check, test, build, strict tarball consumption,
  and npm dry-run contents validation;
- every action is pinned by commit SHA;
- npm CLI is pinned above the trusted-publishing minimum;
- the publish command remains
  `npm publish <tarball> --access public --ignore-scripts`;
- registry reconciliation no-ops only on matching sha512 integrity and fails on
  different integrity;
- no npm token is created, requested, accepted, stored, or exposed; and
- agents never create tags, dispatch publication, bootstrap-publish, configure
  npm trust, or change package security settings.

## Trusted-publisher configuration

After the interactive bootstrap, npm is configured for GitHub organization
`cormidia`, repository `governed-learning-loop`, workflow filename
`release.yml`, no environment name, and allowed action `npm publish` only. The
maintainer then enables “Require two-factor authentication and disallow
tokens.” OIDC remains short-lived and workflow-bound.

## Consequences

- GitHub Enterprise is not required for this release.
- The maintainer deleted the incomplete, unprotected `npm-publish` environment.
- Publication intent is an explicit second maintainer dispatch rather than an
  environment-review click by the same person.
- The repository remains private, so npm provenance remains unavailable and
  deferred exactly as Decision 0030 records.

## 0.1.1 release evidence

- The maintainer deleted the incomplete environment, bootstrap-published the
  exact sealed tarball, configured npm trusted publishing with no environment,
  allowed only `npm publish`, and enabled “Require two-factor authentication
  and disallow tokens.”
- Verify-only run `32657463744` passed Node 22/24/26, sealed 400 allowed files,
  and uploaded `learning-loop-candidate` with sha256
  `a989d765f75a55328168d51cf3ef0f8c9291e6aaef2b253330a9edffed251cb4`.
- The public registry tarball has that exact sha256 and npm integrity
  `sha512-ojnPKpp1TW/o9XvYMZldOLvESRvqyXlt3xdRgjJ/YjBlulqMiA2NizCI4AhXPHhZlOpQ8WYOO/Xoo1lx1h3v9w==`.
- Publish-intent run `32672996829` passed the same matrix, observed matching
  registry integrity, skipped `npm publish`, and reconciled successfully.
- A clean registry consumer installed exactly one package and imported the
  root and `/testing` entrypoints successfully.
