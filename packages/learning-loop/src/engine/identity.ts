// Kernel-owned IdentityPort factory and exact runtime binding. Stable
// registration metadata contributes to deterministic loop identity; a fresh,
// private token per factory call is the non-serializable minting capability.
import { sha256HexOfCanonicalJson } from "../canonical/canonical-json.js";
import { invalid, parseNonEmptyText, parseOneOf, readFields } from "../parse/toolkit.js";
import type { Parse } from "../parse/toolkit.js";
import { identityPortBrand, verifiedPrincipalBrand } from "../records/brands.js";
import type { IdentityPort, PrincipalRef, VerifiedPrincipal } from "../records/principal.js";

const MAX_REGISTRATION_TEXT_LENGTH = 200;
const MAX_PRINCIPAL_TEXT_LENGTH = 1_000;
const MAX_ATTESTATION_ID_LENGTH = 1_000;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const PRINCIPAL_KINDS = ["human", "agent", "service"] as const;

interface IdentityRegistration {
  readonly id: string;
  readonly version: string;
  readonly configurationDigest: string;
  readonly registrationDigest: string;
  readonly token: object;
}

interface IdentityVerificationResult {
  readonly ref: PrincipalRef;
  readonly attestationId: string;
  readonly attestationDigest: string;
}

const portRegistrations = new WeakMap<IdentityPort, IdentityRegistration>();
const principalRegistrations = new WeakMap<VerifiedPrincipal, IdentityRegistration>();

function parseBoundedControlFreeText(maximumLength: number): Parse<string> {
  return (input, path) => {
    const value = parseNonEmptyText(input, path);
    if (value.length > maximumLength) {
      throw invalid("schema.invalid", `text exceeds ${maximumLength} characters`, path);
    }
    for (const character of value) {
      const code = character.codePointAt(0) ?? 0;
      if (code < 0x20 || code === 0x7f) {
        throw invalid("schema.invalid", "text contains a control character", path);
      }
    }
    return value;
  };
}

const parseRegistrationText = parseBoundedControlFreeText(MAX_REGISTRATION_TEXT_LENGTH);
const parsePrincipalText = parseBoundedControlFreeText(MAX_PRINCIPAL_TEXT_LENGTH);
const parseAttestationId = parseBoundedControlFreeText(MAX_ATTESTATION_ID_LENGTH);

const parseDigest: Parse<string> = (input, path) => {
  const value = parseNonEmptyText(input, path);
  if (!DIGEST_PATTERN.test(value)) {
    throw invalid("schema.invalid", "expected a 64-character lower-case hexadecimal digest", path);
  }
  return value;
};

const parseIdentityPrincipalRefAt: Parse<PrincipalRef> = (input, path) => {
  const fields = readFields(input, path);
  return {
    id: fields.req("id", parsePrincipalText),
    kind: fields.req("kind", parseOneOf(PRINCIPAL_KINDS)),
    independenceDomain: fields.req("independenceDomain", parsePrincipalText),
  };
};

function parseVerificationResult(input: unknown): IdentityVerificationResult {
  const fields = readFields(input, ["identityVerification"]);
  return {
    ref: fields.req("ref", parseIdentityPrincipalRefAt),
    attestationId: fields.req("attestationId", parseAttestationId),
    attestationDigest: fields.req("attestationDigest", parseDigest),
  };
}

export function createIdentityPort(input: {
  readonly id: string;
  readonly version: string;
  readonly configurationDigest: string;
  readonly verify: (evidence: unknown) => Promise<unknown>;
}): IdentityPort {
  const fields = readFields(input, ["identityPort"]);
  const id = fields.req("id", parseRegistrationText);
  const version = fields.req("version", parseRegistrationText);
  const configurationDigest = fields.req("configurationDigest", parseDigest);
  const verifier = input.verify;
  if (typeof verifier !== "function") {
    throw invalid("schema.invalid", "identity verifier must be a function", ["identityPort", "verify"]);
  }
  const registrationDigest = sha256HexOfCanonicalJson({ id, version, configurationDigest });
  const registration: IdentityRegistration = Object.freeze({
    id,
    version,
    configurationDigest,
    registrationDigest,
    token: Object.freeze({}),
  });
  const port: IdentityPort = {
    id,
    version,
    configurationDigest,
    registrationDigest,
    verify: async (evidence: unknown): Promise<VerifiedPrincipal> => {
      const parsed = parseVerificationResult(await verifier(evidence));
      const ref = Object.freeze({ ...parsed.ref });
      const principal: VerifiedPrincipal = {
        ref,
        attestationId: parsed.attestationId,
        attestationDigest: parsed.attestationDigest,
        [verifiedPrincipalBrand]: true,
      };
      Object.freeze(principal);
      principalRegistrations.set(principal, registration);
      return principal;
    },
    [identityPortBrand]: true,
  };
  const frozen = Object.freeze(port);
  portRegistrations.set(frozen, registration);
  return frozen;
}

export function identityRegistryProjection(port: IdentityPort): {
  readonly id: string;
  readonly version: string;
  readonly configurationDigest: string;
  readonly registrationDigest: string;
} {
  const unknownPort: unknown = port;
  if (typeof unknownPort !== "object" || unknownPort === null) {
    throw invalid("config.invalid", "identity port must be an object", ["identity"]);
  }
  const registration = portRegistrations.get(port);
  if (registration === undefined) {
    throw invalid("config.invalid", "identity port was not created by createIdentityPort", ["identity"]);
  }
  return {
    id: registration.id,
    version: registration.version,
    configurationDigest: registration.configurationDigest,
    registrationDigest: registration.registrationDigest,
  };
}

export function assertVerifiedPrincipal(identity: IdentityPort, principal: VerifiedPrincipal, role: string): void {
  const expected = portRegistrations.get(identity);
  if (expected === undefined) {
    throw invalid("config.invalid", "configured identity port has no kernel registration", ["identity"]);
  }
  const unknownPrincipal: unknown = principal;
  if (typeof unknownPrincipal !== "object" || unknownPrincipal === null) {
    throw invalid("identity.unverified", `${role} is not a verified principal handle`, [role]);
  }
  const actual = principalRegistrations.get(principal);
  const carrier: { readonly [verifiedPrincipalBrand]?: unknown } = principal;
  if (actual?.token !== expected.token || carrier[verifiedPrincipalBrand] !== true) {
    throw invalid("identity.unverified", `${role} was not minted by this loop's configured identity port`, [role]);
  }
  const fields = readFields(principal, [role]);
  fields.req("ref", parseIdentityPrincipalRefAt);
  fields.req("attestationId", parseAttestationId);
  fields.req("attestationDigest", parseDigest);
}
