// The demo host's IdentityPort: a fixed two-principal roster. The host parses
// opaque evidence and owns the roster decision; createIdentityPort validates
// the verifier result and is the only code that mints the kernel handle.
import type { IdentityPort } from "@cormidia/learning-loop";
import { LearningLoopError, createIdentityPort, sha256HexOfCanonicalJson } from "@cormidia/learning-loop";
import { isUnknownRecord } from "./json.js";

interface RosterEntry {
  readonly kind: "human" | "agent";
  readonly independenceDomain: string;
}

// demo-distiller proposes candidates; local-human reviews them. Distinct
// principals in distinct independence domains, so the conservative policy's
// independent-review rule is satisfiable from this one CLI.
const ROSTER_ENTRIES: readonly (readonly [string, RosterEntry])[] = [
  ["demo-distiller", { kind: "agent", independenceDomain: "demo-heuristics" }],
  ["local-human", { kind: "human", independenceDomain: "human-local" }],
];

const ROSTER: ReadonlyMap<string, RosterEntry> = new Map(ROSTER_ENTRIES);

// This roster is synthetic and committed in source, so its canonical digest
// contains no private, low-entropy host configuration. A real host should
// supply a privacy-safe (for example, tenant-keyed) configuration digest.
const ROSTER_CONFIGURATION_DIGEST = sha256HexOfCanonicalJson({
  kind: "fixed-demo-roster",
  principals: ROSTER_ENTRIES.map(([id, entry]) => ({
    id,
    kind: entry.kind,
    independenceDomain: entry.independenceDomain,
  })),
});

function refuse(message: string): LearningLoopError {
  return new LearningLoopError("identity.unverified", [{ code: "identity.unverified", severity: "error", message }]);
}

export function createDemoIdentityPort(): IdentityPort {
  return createIdentityPort({
    id: "transcript-insights-demo-roster",
    version: "1.0.0",
    configurationDigest: ROSTER_CONFIGURATION_DIGEST,
    verify: (evidence: unknown): Promise<unknown> => {
      if (!isUnknownRecord(evidence)) {
        throw refuse("identity evidence must be an object of the form { principalId }");
      }
      const principalId = evidence.principalId;
      if (typeof principalId !== "string" || principalId.length === 0) {
        throw refuse("identity evidence must carry a non-empty string principalId");
      }
      const entry = ROSTER.get(principalId);
      if (entry === undefined) {
        throw refuse("identity evidence names a principal outside this demo's roster");
      }
      const ref = {
        id: principalId,
        kind: entry.kind,
        independenceDomain: entry.independenceDomain,
      };
      const attestationDigest = sha256HexOfCanonicalJson({
        configurationDigest: ROSTER_CONFIGURATION_DIGEST,
        principalId: ref.id,
        kind: ref.kind,
        independenceDomain: ref.independenceDomain,
      });
      return Promise.resolve({
        ref,
        attestationId: `demo-roster-${attestationDigest.slice(0, 16)}`,
        attestationDigest,
      });
    },
  });
}
