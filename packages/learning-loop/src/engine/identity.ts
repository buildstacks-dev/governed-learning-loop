// Runtime check that a principal handle really was minted by an IdentityPort.
// The brand is a type-level guarantee for TypeScript consumers; this guards
// the same invariant against plain-JavaScript callers: only code holding the
// module-private brand symbol can have attached it.
import { invalid, parseNonEmptyText, readFields } from "../parse/toolkit.js";
import { verifiedPrincipalBrand } from "../records/brands.js";
import type { VerifiedPrincipal } from "../records/principal.js";
import { parsePrincipalRefAt } from "../records/principal.js";

export function assertVerifiedPrincipal(principal: VerifiedPrincipal, role: string): void {
  const carrier: { readonly [verifiedPrincipalBrand]?: unknown } = principal;
  if (carrier[verifiedPrincipalBrand] !== true) {
    throw invalid(
      "identity.unverified",
      `${role} is not a VerifiedPrincipal minted by an IdentityPort; the engine records identities only from verified handles`,
      [role],
    );
  }
  const fields = readFields(principal, [role]);
  fields.req("ref", parsePrincipalRefAt);
  fields.req("attestationId", parseNonEmptyText);
  fields.req("attestationDigest", parseNonEmptyText);
}
