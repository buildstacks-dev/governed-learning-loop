// Verified authorization handles and the authority port (contract §Authority).
// VerifiedAuthorization is a branded, non-serializable capability only a
// kernel-created AuthorityPort can mint (decision 0025); the brand symbols
// live in ./brands.js and are never exported. Its durable projections are
// the PrincipalRef, attestation digest, binding digest, and timestamps.
import type { Diagnostic } from "../diagnostics.js";
import { authorityPortBrand, verifiedAuthorizationBrand } from "./brands.js";
import type { PrincipalRef } from "./principal.js";
import type { AuthorizationBinding } from "./publication.js";

export interface VerifiedAuthorization {
  readonly id: string;
  readonly principal: PrincipalRef;
  readonly principalAttestationDigest: string;
  readonly bindingDigest: string;
  readonly authorizedAt: string;
  readonly expiresAt?: string;
  readonly [verifiedAuthorizationBrand]: true;
}

export interface AuthorityPort {
  readonly id: string;
  readonly version: string;
  readonly configurationDigest: string;
  readonly registrationDigest: string;
  readonly [authorityPortBrand]: true;

  verify(input: { readonly evidence: unknown; readonly binding: AuthorizationBinding }): Promise<
    | { readonly status: "authorized"; readonly authorization: VerifiedAuthorization }
    | {
        readonly status: "pending" | "denied" | "invalid" | "expired";
        readonly diagnostics: readonly Diagnostic[];
      }
  >;
}

/** Internal alias for the closed verification result; not a public symbol. */
export type AuthorityVerification = Awaited<ReturnType<AuthorityPort["verify"]>>;
