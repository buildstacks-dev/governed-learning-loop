# 0029 — Package identity, license, Node range, exports, security intake, ownership, and the Cormidia consumption mechanism

**Date:** 2026-08-21
**Status:** ratified 2026-08-21 by the maintainer — issue #15 (release gate
12 of the originating review brief,
`research/2026-08-12_learning-loop-library/README.md` in the Cormidia repo).
Rulings R1 and R3–R9 follow the recommendation; R2 keeps `UNLICENSED` until
publication approval.

## Context

Release gate 12 reads: *"final package name, license, Node support range,
repository home, maintainer policy, security reporting, and release process have
explicit human decisions."* Issue #15 carries those rulings plus the
module/exports policy, and the campaign plan adds one more that must be settled
before the Cormidia migration (P9/P10): how Cormidia consumes this package
before — or without — npm publication.

What is true today:

- `packages/learning-loop/package.json`: `@cormidia/learning-loop@0.0.0`,
  `"private": true`, `"license": "UNLICENSED"`, `engines.node >=22.18`,
  `exports` pointing at `src/*.ts`, no `files`, no `repository`/`author`.
  A `pnpm pack` today yields 768 entries (1.3 MB): `src/`, `dist/`, `tests/`,
  and both tsconfigs.
- Repository: `github.com/cormidia/governed-learning-loop`, private, in the
  `cormidia` GitHub organization. Ruleset "Production Protection" on `main`:
  pull request required, linear history, review-thread resolution, zero
  required approvals, no CODEOWNERS review.
- npm: `@cormidia/learning-loop` is unclaimed (404). The unscoped `cormidia`
  package (0.0.1, 2026-08-03, maintainer `bikramgupta`) already anchors the
  brand on npm. Ownership of the `@cormidia` scope could not be verified from
  this machine (no npm login) — it is a precondition to check, not a ruling.
- Cormidia: `engines.node >=26`, CI on Node 26, **no license field and no
  LICENSE file**, deliberately a single package (PURPOSE.md "Repo shape — one
  repo, one package", no workspace), and a `check-pinned-deps` gate that admits
  only exact semver, `npm:` aliases with exact versions, or `file:` tarballs
  whose filename carries the exact version. Cormidia already consumes an
  unpublished package that way: `validation-architect` is
  `file:vendor/validation-architect-0.4.16.tgz`, committed under `vendor/`,
  with its sha512 recorded in `pnpm-lock.yaml`. Cormidia's
  `minimumReleaseAge: 4320` (3 days) applies to registry-resolved versions
  only. Its release path is RQ-1: an annotated exact tag carrying a human
  approval bound to the action hash; the org can never approve its own release.
- Node: 22.18.0 is the release where type stripping became enabled by default,
  which is why the floor is `22.18` rather than `22` — the `src/*.ts` exports
  and the demo CLI depend on it (`module.registerHooks` has been available
  since 22.15). Node 26 has no `--experimental-transform-types`, so relative
  `.js` specifiers inside the package never remap to `.ts` in plain Node; the
  demo registers a scoped resolve hook (PR #21 finding 3). Release schedule:
  v20 EOL 2026-04-30 (past); v22 EOL 2027-04-30; v24 maintenance 2026-10-20,
  EOL 2028-04-30; v26 LTS 2026-10-28, EOL 2029-04-30.
- Kernel invariants unaffected: zero runtime dependencies, no Cormidia imports,
  ESM-only strict TypeScript, five subpath exports, export ratchet on
  `docs/public-api.txt`.

## Rulings

Each ruling lists the options weighed, the recommendation put to the
maintainer, the ruling, and what changes in this PR versus what waits for
publication approval.

### R1 — npm identity

Options: (a) `@cormidia/learning-loop` (working name); (b) a separate product
name with Cormidia provenance only in docs (review-brief challenge point 4);
(c) an unscoped name.

**Ruling: (a), as recommended.** The scope is the provenance claim and the trademark
boundary; the GitHub org and the unscoped `cormidia` package already exist, and
the review brief, contract, README, and every consumer import use the name.
Renaming later is a one-line `exports`/import change plus a deprecation
notice; inventing a second brand now buys nothing. Companion identities:
`@cormidia/learning-loop-transcript-sources` keeps its name and stays
`private: true` — it is dogfood-grade (#56 open) and not part of the first
publication; `examples/transcript-insights` never publishes.

Precondition before any publication (not applied here): confirm the `@cormidia`
npm organization exists and is owned by the maintainer's npm account.

### R2 — License

Options: (a) Apache-2.0; (b) MIT; (c) keep `UNLICENSED` until publication.

Recommendation put forward: (a) Apache-2.0 — §3 explicit patent grant in both
directions (a governed-activation kernel is exactly the kind of mechanism
patents get asserted against), §5 inbound-contribution terms without a
separate CLA, and §6 — no trademark license — which protects the `Cormidia`
name the `@cormidia` scope carries.

**Ruling: (c) — keep `UNLICENSED` for now.** No `LICENSE` or `NOTICE` file is
added and every package keeps `"license": "UNLICENSED"`. The license is chosen
on the publication issue, before `"private": true` is removed; Apache-2.0
stays the standing recommendation there, with the copyright holder to be
named at that time. Until then nobody outside the organization receives a
copy, so no grant is needed or implied.

### R3 — Tested Node support range

Options: (a) keep `>=22.18`, test 22/24/26; (b) raise to `>=24`; (c) inherit
Cormidia's `>=26`.

**Ruling: (a), as recommended, CI matrix included in this PR.** Floor policy: the oldest non-EOL LTS line, raised
only in a minor release with a decision entry — the next scheduled move is
dropping 22 after 2027-04-30. `22.18` stays the exact floor because the
source-shaped exports need default-on type stripping. "Tested" means CI runs
the full gate on every line in the range, so `ci.yml` becomes a 22/24/26
matrix (today only 22 is tested in CI; 26 is exercised only on the maintainer's
machine). `@types/node` tracks the floor (`^22`), never the host, so no API
absent on 22 can be used by accident. (c) would narrow adoption for no kernel
benefit; (b) gains nothing until 22 is EOL.

### R4 — Module and exports policy

Options: (a) ESM-only; development exports stay on `src/*.ts`, the published
shape is `dist/` with declarations via `publishConfig.exports`; (b) switch
`exports` to `dist/` for everyone now; (c) add CommonJS.

**Ruling: (a), as recommended.** ESM-only with an explicit `exports` map (`.`, `/node`,
`/testing`, `/reference-detectors`, `/workflows`, plus `./package.json`), no
`main`, no deep imports, `sideEffects: false`. Consumers need TypeScript
`moduleResolution` `node16`/`nodenext`/`bundler`. CommonJS waits for adopter
evidence (contract §Package shape). Option (b) would force every workspace
consumer and Vitest run through a build step and break the export ratchet's
source scan; (a) gives the tarball exactly what the packaging gate demands —
`.js`, `.d.ts`, declaration maps, source maps — while the workspace keeps
source-level imports. Applied now as metadata: `files: ["dist"]`,
`publishConfig.exports` → `dist`, `publishConfig.access: "public"`, and a
`prepack` that builds so a tarball is never stale. The PR #21 resolve hook
remains a workspace-only shim; tarball consumers never see `.ts`. The strict
tarball-consumer test (packaging gate 9) is a follow-up, tracked on the
publication issue.

### R5 — Security intake

Options: (a) `SECURITY.md` now: private-repo issues until public, GitHub
private vulnerability reporting once public, no email published; (b) same
plus a published maintainer email; (c) defer to publication.

**Ruling: (a), as recommended.** While the repository is private, only organization
members can see it, so a private issue is an adequate intake; the moment the
repository becomes public, GitHub private vulnerability reporting is enabled
in the same action and `SECURITY.md` already points to it. Supported-version
policy: none before 1.0 — fixes land on `main` and the next tag. Supply-chain
posture is already in force (zero runtime dependencies, `minimumReleaseAge`,
frozen lockfile); a scheduled dependency audit and secret scanning mirror
Cormidia's and are deferred to the publication issue.

### R6 — Repository home and maintainer ownership

Options: (a) `cormidia/governed-learning-loop` stays home, single maintainer;
(b) move under a neutral organization.

**Ruling: (a), as recommended.** Home: `github.com/cormidia/governed-learning-loop`,
private until publication approval; flipping visibility is itself a
release-shaped action. Maintainer: Bikram Gupta (`@bikramgupta`) — sole
committer-of-record, sole npm publisher, sole holder of release authority.
Working policy as already practised: every change through a PR and
squash-merge under the maintainer's account; agent sessions open and merge
PRs, humans alone tag, publish, or change visibility. Applied now:
`author`, `repository`, `bugs`, and `homepage` fields. CODEOWNERS is omitted —
the ruleset does not require code-owner review and a one-person file would be
decorative.

### R7 — Cormidia consumption mechanism before/without npm publication

Options: (a) vendored tarball — `file:vendor/cormidia-learning-loop-<v>.tgz`,
the exact pattern Cormidia uses for `validation-architect`; (b) GitHub
Packages private registry under `@cormidia`; (c) git-tag dependency
`github:cormidia/governed-learning-loop#vX.Y.Z`; (d) workspace or `pnpm link`.

**Ruling: (a), as recommended.** It passes Cormidia's pinned-dependency gate
unchanged, records a sha512 in `pnpm-lock.yaml`, needs no registry
credentials in CI or on laptops, is exempt from the three-day
`minimumReleaseAge` window, and preserves Cormidia's one-repo-one-package
shape. (b) adds token plumbing everywhere and either a three-day wait or an
`minimumReleaseAgeExclude` entry per version; (c) fails the exact-pin gate,
needs `dist` built at install time from a private repository, and has no
integrity hash; (d) is ruled out by Cormidia's repo-shape decision and is not
reproducible. Procedure: tag `vX.Y.Z` on a green `main` commit → `pnpm pack`
from that commit → attach the tarball to a GitHub release in this repository
→ copy into Cormidia `vendor/` → `pnpm install` → the Cormidia PR cites tag,
commit, and tarball sha512. Moving to npm later is a one-line specifier
change.

### R8 — Versioning and release process

Options: (a) 0.x semver, hand-cut tags, npm publication only through an
RQ-1-style exact-tag workflow after separate human approval; (b) automate
tags and publication now.

**Ruling: (a), as recommended.** `0.0.0` means "untagged". The first tag is
`v0.1.0`, cut when the Cormidia migration phase A (P9) starts. In 0.x a
breaking public-surface change bumps the minor; `docs/public-api.txt` diff
between tags is the surface changelog. Tags are cut by the maintainer by
hand; no workflow tags or publishes until an exact-tag release workflow
modeled on Cormidia's RQ-1 (annotated tag, human approval bound to the
action hash, provenance) exists. Removing `"private": true` happens only in
the approved publication PR.

### R9 — Issue #15 disposition

Options: (a) close #15 when this decision merges and open a new
"Publish `@cormidia/learning-loop` 0.x" issue carrying the publication
checklist; (b) leave #15 open with only the publication-approval step.

**Ruling: (a), as recommended.** The gate asked for rulings; they are recorded. A
fresh issue states the remaining preconditions without a decision label
staying open for months: `@cormidia` npm org verified, packaging-gate
tarball-consumer test, release workflow, dependency audit and secret scanning,
visibility flip, `private` removal.

## Consequences applied in this PR

- `packages/learning-loop/package.json`: `author`, `homepage`, `repository`
  (with `directory`), `bugs`, `files: ["dist"]`, `./package.json` export,
  `publishConfig` (`access: "public"`, `exports` → `dist` with `types` and
  `default` conditions), package-level `build` and `prepack` scripts.
  `private`, `license`, `engines`, and the development `exports` are
  unchanged.
- `packages/transcript-sources/package.json`: the same `author`, `homepage`,
  `repository`, and `bugs` fields; still `private`, still `UNLICENSED`.
- `SECURITY.md` at the root.
- `ci.yml`: the `core` job runs as a 22/24/26 matrix with `fail-fast: false`.
- README "Package shape" and "Development" lines and the AGENTS.md ESM bullet
  updated to the rulings.

## Validation evidence

- `pnpm check` green: biome, the three typechecks, `check-casts`, and
  `check-exports` (221 public symbols, snapshot unchanged — this decision adds
  no public symbol).
- `pnpm test`: 114 files, 1,322 tests passed.
- `pnpm pack` from `packages/learning-loop` with `dist/` deleted first:
  `prepack` rebuilt it; the tarball is 529 entries / 640 KB — 528 under
  `dist/` (132 each of `.js`, `.js.map`, `.d.ts`, `.d.ts.map`) plus
  `package.json`. The packed manifest has `exports` rewritten to the `dist`
  shape with `types`/`default` conditions, `publishConfig.exports` and
  `prepack` stripped, and `"private": true` / `"license": "UNLICENSED"`
  retained, so an accidental `npm publish` of the tarball is still refused.
- Scratch consumer: `npm install <tarball>`, then a plain-Node dynamic import
  of `.`, `/node`, `/testing`, `/reference-detectors`, `/workflows`, and
  `./package.json` on Node 22.23.2, 24.19.0, and 26.7.0 (66 / 1 / 12 / 1 / 1
  exports); deep imports into `dist/` and `src/` are refused with
  `ERR_PACKAGE_PATH_NOT_EXPORTED`. A strict `NodeNext` consumer
  (`exactOptionalPropertyTypes`, `skipLibCheck: false`) typechecks against
  the tarball's declarations with TypeScript 5.9.3.
- Not yet evidence: the committed tarball-consumer test (packaging gate 9) and
  the first CI matrix run, which this PR triggers.

## Deferred until publication approval

License choice and `LICENSE`/`NOTICE` files (R2), removal of `"private":
true`, npm organization verification, the strict tarball-consumer test
(packaging gate 9), the release workflow, dependency audit and secret
scanning, and the visibility change — all tracked on the publication issue
opened when #15 closes.
