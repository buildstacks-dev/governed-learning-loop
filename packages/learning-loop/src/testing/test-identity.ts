// Deterministic IdentityPort for tests and examples. Verification evidence is
// parsed from `unknown` — `{ principalId, kind, independenceDomain }` — and
// the attestation id/digest are pure functions of that input, so the same
// evidence always mints the same VerifiedPrincipal. Minting delegates to the
// root createIdentityPort factory; ordinary caller data cannot attach a brand
// or choose an identity outside the parsed test evidence.
import { sha256HexOfCanonicalJson } from "../canonical/canonical-json.js";
import { createIdentityPort } from "../engine/identity.js";
import { parseNonEmptyText, parseOneOf, readFields } from "../parse/toolkit.js";
import type { IdentityPort } from "../records/principal.js";

const PRINCIPAL_KINDS = ["human", "agent", "service"] as const;
const TEST_IDENTITY_CONFIGURATION_DIGEST = sha256HexOfCanonicalJson({
  kind: "deterministic-test-identity",
  schemaVersion: 1,
});

export function createTestIdentityPort(): IdentityPort {
  return createIdentityPort({
    id: "testing/deterministic-identity",
    version: "1.0.0",
    configurationDigest: TEST_IDENTITY_CONFIGURATION_DIGEST,
    verify: (evidence: unknown): Promise<unknown> => {
      const fields = readFields(evidence, ["evidence"]);
      const ref = {
        id: fields.req("principalId", parseNonEmptyText),
        kind: fields.req("kind", parseOneOf(PRINCIPAL_KINDS)),
        independenceDomain: fields.req("independenceDomain", parseNonEmptyText),
      };
      const attestationDigest = sha256HexOfCanonicalJson({
        principalId: ref.id,
        kind: ref.kind,
        independenceDomain: ref.independenceDomain,
      });
      return Promise.resolve({
        ref,
        attestationId: `test-attestation-${attestationDigest.slice(0, 16)}`,
        attestationDigest,
      });
    },
  });
}
