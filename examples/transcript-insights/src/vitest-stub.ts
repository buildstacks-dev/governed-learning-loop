// Stand-in for "vitest" when the CLI runs under plain `node`.
//
// The kernel's /testing entrypoint re-exports its store-conformance suite,
// whose module eagerly imports vitest — and vitest throws at import time
// outside a vitest worker. This demo needs /testing only for
// createTestIdentityPort (the sole public VerifiedPrincipal minter), so
// src/cli.ts resolves that one importer's "vitest" to this stub. The stubbed
// functions are never called: the CLI never runs the conformance suite, and
// each throws loudly if that ever changes. Reported as consumer feedback in
// the PR — a vitest-free /testing split would delete this file.
function refuse(): never {
  throw new Error(
    "vitest is not available outside a test run; transcript-insights never executes the store conformance suite",
  );
}

export const describe = refuse;
export const it = refuse;
export const expect = refuse;
