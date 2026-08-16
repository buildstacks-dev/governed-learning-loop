// Deterministic IdentityPort for tests and examples. Verification evidence is
// parsed from `unknown` — `{ principalId, kind, independenceDomain }` — and
// the attestation id/digest are pure functions of that input, so the same
// evidence always mints the same VerifiedPrincipal. Only this module (via the
// package-private brand symbol) can attach the brand; ordinary caller data
// cannot choose an identity.
import { sha256HexOfCanonicalJson } from "../canonical/canonical-json.js";
import { parseNonEmptyText, parseOneOf, readFields } from "../parse/toolkit.js";
import { verifiedPrincipalBrand } from "../records/brands.js";
import type { IdentityPort, VerifiedPrincipal } from "../records/principal.js";

const PRINCIPAL_KINDS = ["human", "agent", "service"] as const;

export function createTestIdentityPort(): IdentityPort {
  return {
    verify: (evidence: unknown): Promise<VerifiedPrincipal> => {
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
      const principal: VerifiedPrincipal = {
        ref,
        attestationId: `test-attestation-${attestationDigest.slice(0, 16)}`,
        attestationDigest,
        [verifiedPrincipalBrand]: true,
      };
      return Promise.resolve(principal);
    },
  };
}
