// Kernel-owned AuthorityPort factory and exact runtime binding (decision
// 0025), following the identity-port discipline of decision 0003. Stable
// registration metadata contributes to deterministic loop identity; a fresh,
// private token per factory call is the non-serializable minting capability.
// The host authenticates approvers and maps its approvals; the kernel parses
// the host result from `unknown`, requires the approved binding digest to
// equal the digest of the binding it asked about, and brands the result.
import { sha256HexOfCanonicalJson } from "../canonical/canonical-json.js";
import type { Diagnostic } from "../diagnostics.js";
import {
  invalid,
  parseArrayOf,
  parseJson,
  parseNonEmptyText,
  parseOneOf,
  parseText,
  readFields,
} from "../parse/toolkit.js";
import type { Parse } from "../parse/toolkit.js";
import type { AuthorityPort, AuthorityVerification, VerifiedAuthorization } from "../records/authorization.js";
import { authorityPortBrand, verifiedAuthorizationBrand } from "../records/brands.js";
import type { PrincipalRef } from "../records/principal.js";
import type { AuthorizationBinding } from "../records/publication.js";
import { authorizationBindingDigest } from "../records/publication.js";

const MAX_REGISTRATION_TEXT_LENGTH = 200;
const MAX_PRINCIPAL_TEXT_LENGTH = 1_000;
const MAX_AUTHORIZATION_ID_LENGTH = 1_000;
const MAX_DIAGNOSTIC_COUNT = 100;
const MAX_DIAGNOSTIC_TEXT_LENGTH = 10_000;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const PRINCIPAL_KINDS = ["human", "agent", "service"] as const;
const VERIFICATION_STATUSES = ["authorized", "pending", "denied", "invalid", "expired"] as const;
const DIAGNOSTIC_SEVERITIES = ["info", "warning", "error"] as const;

interface AuthorityRegistration {
  readonly id: string;
  readonly version: string;
  readonly configurationDigest: string;
  readonly registrationDigest: string;
  readonly token: object;
}

interface AuthorizationMaterial {
  readonly id: string;
  readonly principal: PrincipalRef;
  readonly principalAttestationDigest: string;
  readonly bindingDigest: string;
  readonly authorizedAt: string;
  readonly expiresAt?: string;
}

type ParsedVerification =
  | { readonly status: "authorized"; readonly material: AuthorizationMaterial }
  | { readonly status: "pending" | "denied" | "invalid" | "expired"; readonly diagnostics: readonly Diagnostic[] };

const portRegistrations = new WeakMap<AuthorityPort, AuthorityRegistration>();
const authorizationRegistrations = new WeakMap<object, AuthorityRegistration>();

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
const parseAuthorizationId = parseBoundedControlFreeText(MAX_AUTHORIZATION_ID_LENGTH);

const parseDigest: Parse<string> = (input, path) => {
  const value = parseNonEmptyText(input, path);
  if (!DIGEST_PATTERN.test(value)) {
    throw invalid("schema.invalid", "expected a 64-character lower-case hexadecimal digest", path);
  }
  return value;
};

const parseTimestamp: Parse<string> = (input, path) => {
  const value = parseNonEmptyText(input, path);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw invalid("schema.invalid", "timestamp must be canonical RFC 3339 UTC with milliseconds", path);
  }
  return value;
};

const parseAuthorityPrincipalRefAt: Parse<PrincipalRef> = (input, path) => {
  const fields = readFields(input, path);
  return {
    id: fields.req("id", parsePrincipalText),
    kind: fields.req("kind", parseOneOf(PRINCIPAL_KINDS)),
    independenceDomain: fields.req("independenceDomain", parsePrincipalText),
  };
};

const parseDiagnosticText: Parse<string> = (input, path) => {
  const value = parseText(input, path);
  if (value.length > MAX_DIAGNOSTIC_TEXT_LENGTH) {
    throw invalid("schema.invalid", `diagnostic text exceeds ${MAX_DIAGNOSTIC_TEXT_LENGTH} characters`, path);
  }
  return value;
};

const parsePathSegment: Parse<string | number> = (input, path) => {
  if (typeof input === "string") return input;
  if (typeof input === "number" && Number.isSafeInteger(input) && input >= 0) return input;
  throw invalid("schema.invalid", "diagnostic path segments must be strings or non-negative integers", path);
};

const parseDiagnosticAt: Parse<Diagnostic> = (input, path) => {
  const fields = readFields(input, path);
  const code = fields.req("code", parseRegistrationText);
  const severity = fields.req("severity", parseOneOf(DIAGNOSTIC_SEVERITIES));
  const message = fields.req("message", parseDiagnosticText);
  const diagnosticPath = fields.opt("path", parseArrayOf(parsePathSegment));
  const details = fields.opt("details", parseJson);
  return {
    code,
    severity,
    message,
    ...(diagnosticPath !== undefined ? { path: diagnosticPath } : {}),
    ...(details !== undefined ? { details } : {}),
  };
};

function parseVerificationResult(input: unknown): ParsedVerification {
  const fields = readFields(input, ["authorityVerification"]);
  const status = fields.req("status", parseOneOf(VERIFICATION_STATUSES));
  if (status !== "authorized") {
    const diagnostics = fields.req("diagnostics", parseArrayOf(parseDiagnosticAt));
    if (diagnostics.length > MAX_DIAGNOSTIC_COUNT) {
      throw invalid("schema.invalid", `authority diagnostics exceed ${MAX_DIAGNOSTIC_COUNT} entries`, [
        "authorityVerification",
        "diagnostics",
      ]);
    }
    return { status, diagnostics };
  }
  const material = readFields(
    fields.req("authorization", (value) => value),
    ["authorityVerification", "authorization"],
  );
  const authorizedAt = material.req("authorizedAt", parseTimestamp);
  const expiresAt = material.opt("expiresAt", parseTimestamp);
  if (expiresAt !== undefined && Date.parse(expiresAt) <= Date.parse(authorizedAt)) {
    throw invalid("schema.invalid", "authorization expiresAt must be later than authorizedAt", [
      "authorityVerification",
      "authorization",
      "expiresAt",
    ]);
  }
  return {
    status,
    material: {
      id: material.req("id", parseAuthorizationId),
      principal: material.req("principal", parseAuthorityPrincipalRefAt),
      principalAttestationDigest: material.req("principalAttestationDigest", parseDigest),
      bindingDigest: material.req("bindingDigest", parseDigest),
      authorizedAt,
      ...(expiresAt !== undefined ? { expiresAt } : {}),
    },
  };
}

function bindingMismatch(expected: string, actual: string): AuthorityVerification {
  const diagnostics: readonly Diagnostic[] = Object.freeze([
    {
      code: "publication.binding_mismatch",
      severity: "error",
      message: "host authorization approves a different binding than the one verified",
      details: { expectedBindingDigest: expected, approvedBindingDigest: actual },
    },
  ]);
  return Object.freeze({ status: "invalid", diagnostics });
}

export function createAuthorityPort(input: {
  readonly id: string;
  readonly version: string;
  readonly configurationDigest: string;
  readonly verify: (input: { readonly evidence: unknown; readonly binding: AuthorizationBinding }) => Promise<unknown>;
}): AuthorityPort {
  const fields = readFields(input, ["authorityPort"]);
  const id = fields.req("id", parseRegistrationText);
  const version = fields.req("version", parseRegistrationText);
  const configurationDigest = fields.req("configurationDigest", parseDigest);
  const verifier = input.verify;
  if (typeof verifier !== "function") {
    throw invalid("schema.invalid", "authority verifier must be a function", ["authorityPort", "verify"]);
  }
  const registrationDigest = sha256HexOfCanonicalJson({ id, version, configurationDigest });
  const registration: AuthorityRegistration = Object.freeze({
    id,
    version,
    configurationDigest,
    registrationDigest,
    token: Object.freeze({}),
  });
  const port: AuthorityPort = {
    id,
    version,
    configurationDigest,
    registrationDigest,
    verify: async (request): Promise<AuthorityVerification> => {
      const binding = Object.freeze({
        ...request.binding,
        expectedBases: Object.freeze([...request.binding.expectedBases]),
      });
      const expectedBindingDigest = authorizationBindingDigest(binding);
      const parsed = parseVerificationResult(await verifier({ evidence: request.evidence, binding }));
      if (parsed.status !== "authorized") {
        return Object.freeze({ status: parsed.status, diagnostics: Object.freeze([...parsed.diagnostics]) });
      }
      if (parsed.material.bindingDigest !== expectedBindingDigest) {
        return bindingMismatch(expectedBindingDigest, parsed.material.bindingDigest);
      }
      const authorization: VerifiedAuthorization = {
        id: parsed.material.id,
        principal: Object.freeze({ ...parsed.material.principal }),
        principalAttestationDigest: parsed.material.principalAttestationDigest,
        bindingDigest: parsed.material.bindingDigest,
        authorizedAt: parsed.material.authorizedAt,
        ...(parsed.material.expiresAt !== undefined ? { expiresAt: parsed.material.expiresAt } : {}),
        [verifiedAuthorizationBrand]: true,
      };
      Object.freeze(authorization);
      authorizationRegistrations.set(authorization, registration);
      return Object.freeze({ status: "authorized", authorization });
    },
    [authorityPortBrand]: true,
  };
  const frozen = Object.freeze(port);
  portRegistrations.set(frozen, registration);
  return frozen;
}

export function authorityRegistryProjection(port: AuthorityPort): {
  readonly id: string;
  readonly version: string;
  readonly configurationDigest: string;
  readonly registrationDigest: string;
} {
  const unknownPort: unknown = port;
  if (typeof unknownPort !== "object" || unknownPort === null) {
    throw invalid("config.invalid", "authority port must be an object", ["authority"]);
  }
  const registration = portRegistrations.get(port);
  if (registration === undefined) {
    throw invalid("config.invalid", "authority port was not created by createAuthorityPort", ["authority"]);
  }
  return {
    id: registration.id,
    version: registration.version,
    configurationDigest: registration.configurationDigest,
    registrationDigest: registration.registrationDigest,
  };
}

export function assertVerifiedAuthorization(
  authority: AuthorityPort,
  authorization: unknown,
  role: string,
): asserts authorization is VerifiedAuthorization {
  const expected = portRegistrations.get(authority);
  if (expected === undefined) {
    throw invalid("config.invalid", "configured authority port has no kernel registration", ["authority"]);
  }
  if (typeof authorization !== "object" || authorization === null) {
    throw invalid("authority.unverified", `${role} is not a verified authorization handle`, [role]);
  }
  const actual = authorizationRegistrations.get(authorization);
  if (actual?.token !== expected.token) {
    throw invalid("authority.unverified", `${role} was not minted by this loop's configured authority port`, [role]);
  }
  const fields = readFields(authorization, [role]);
  fields.req("id", parseAuthorizationId);
  fields.req("principal", parseAuthorityPrincipalRefAt);
  fields.req("principalAttestationDigest", parseDigest);
  fields.req("bindingDigest", parseDigest);
  fields.req("authorizedAt", parseTimestamp);
  fields.opt("expiresAt", parseTimestamp);
}
