// The demo host's IdentityPort: a fixed two-principal roster.
//
// A real host owns the decision of WHO exists and in which independence
// domain; that policy lives here. The kernel deliberately keeps the
// VerifiedPrincipal brand symbol private, so no host can construct a branded
// principal from the public surface — the only public minter is the /testing
// identity port. This port therefore enforces the roster itself and delegates
// the final minting step to createTestIdentityPort. (Recorded as consumer
// feedback in the PR: a host-facing minting helper would let hosts implement
// IdentityPort without importing /testing.)
import type { IdentityPort, VerifiedPrincipal } from "@cormidia/learning-loop";
import { LearningLoopError } from "@cormidia/learning-loop";
import { createTestIdentityPort } from "@cormidia/learning-loop/testing";
import { isUnknownRecord } from "./json.js";

interface RosterEntry {
  readonly kind: "human" | "agent";
  readonly independenceDomain: string;
}

// demo-distiller proposes candidates; local-human reviews them. Distinct
// principals in distinct independence domains, so the conservative policy's
// independent-review rule is satisfiable from this one CLI.
const ROSTER: ReadonlyMap<string, RosterEntry> = new Map([
  ["demo-distiller", { kind: "agent", independenceDomain: "demo-heuristics" }],
  ["local-human", { kind: "human", independenceDomain: "human-local" }],
]);

function refuse(message: string): LearningLoopError {
  return new LearningLoopError("identity.unverified", [{ code: "identity.unverified", severity: "error", message }]);
}

export function createDemoIdentityPort(): IdentityPort {
  const minter = createTestIdentityPort();
  return {
    verify: (evidence: unknown): Promise<VerifiedPrincipal> => {
      if (!isUnknownRecord(evidence)) {
        throw refuse("identity evidence must be an object of the form { principalId }");
      }
      const principalId = evidence.principalId;
      if (typeof principalId !== "string" || principalId.length === 0) {
        throw refuse("identity evidence must carry a non-empty string principalId");
      }
      const entry = ROSTER.get(principalId);
      if (entry === undefined) {
        throw refuse(`principal "${principalId}" is not on this demo's roster`);
      }
      return minter.verify({
        principalId,
        kind: entry.kind,
        independenceDomain: entry.independenceDomain,
      });
    },
  };
}
