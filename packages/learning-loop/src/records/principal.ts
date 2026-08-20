// Principal and independence (contract §Principal and independence).
// PrincipalRef is the serializable projection; VerifiedPrincipal is a branded
// handle only an IdentityPort implementation can mint (the brand symbol lives
// in the internal ./brands.js module and is never publicly exported).
import { parseNonEmptyText, parseOneOf, readFields } from "../parse/toolkit.js";
import type { Parse } from "../parse/toolkit.js";
import { identityPortBrand, verifiedPrincipalBrand } from "./brands.js";

const PRINCIPAL_KINDS = ["human", "agent", "service"] as const;

export interface PrincipalRef {
  readonly id: string;
  readonly kind: "human" | "agent" | "service";
  readonly independenceDomain: string;
}

export interface VerifiedPrincipal {
  readonly ref: PrincipalRef;
  readonly attestationId: string;
  readonly attestationDigest: string;
  readonly [verifiedPrincipalBrand]: true;
}

export interface IdentityPort {
  readonly id: string;
  readonly version: string;
  readonly configurationDigest: string;
  readonly registrationDigest: string;
  verify(evidence: unknown): Promise<VerifiedPrincipal>;
  readonly [identityPortBrand]: true;
}

export const parsePrincipalRefAt: Parse<PrincipalRef> = (input, path) => {
  const fields = readFields(input, path);
  return {
    id: fields.req("id", parseNonEmptyText),
    kind: fields.req("kind", parseOneOf(PRINCIPAL_KINDS)),
    independenceDomain: fields.req("independenceDomain", parseNonEmptyText),
  };
};

export function parsePrincipalRef(input: unknown): PrincipalRef {
  return parsePrincipalRefAt(input, []);
}
