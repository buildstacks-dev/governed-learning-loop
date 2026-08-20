// Private, inert pre-dispatch records for one semantic workflow turn. These
// records bind exact minimized-request metadata and authorization; they never
// contain the request bytes and grant no Candidate, Review, or effect authority.
import type { JsonValue } from "../canonical/json.js";
import { toJsonValue } from "../canonical/to-json-value.js";
import { invalid, parseBool, parseOneOf } from "../parse/toolkit.js";
import type { Parse } from "../parse/toolkit.js";
import type { PrincipalRef } from "../records/principal.js";
import { parsePrincipalRefAt } from "../records/principal.js";
import {
  assertSortedUnique,
  canonicalKey,
  digestOf,
  parseDetectorRefAt,
  parseDigestAt,
  parseDurableId,
  parseId,
  parseLensRefAt,
  parseNullable,
  parsePackRefAt,
} from "../records/semantic-shared.js";
import type { DetectorRef, LensRef, PackRef } from "../records/semantic-shared.js";
import type { SemanticWorkflowDefinition } from "./workflow-definition.js";
import {
  parseSemanticWorkflowDefinition,
  SEMANTIC_WORKFLOW_MAX_EVIDENCE_REFS,
  SEMANTIC_WORKFLOW_MAX_EPISODES,
} from "./workflow-definition.js";
import {
  parseSemanticWorkflowArray as parseBoundedArray,
  readSemanticWorkflowFields as readFields,
} from "./workflow-structure.js";

const TURN_KEY_DOMAIN = "semantic-workflow-turn-key:v1";
const RESERVATION_DOMAIN = "semantic-workflow-reservation:v1";
const AUTHORIZATION_DOMAIN = "semantic-workflow-authorization:v1";
const RESERVATION_ID_PREFIX = "semantic-workflow-reservation-";
const AUTHORIZATION_ID_PREFIX = "semantic-workflow-authorization-";
const SOURCE_OUTBOUND_POLICIES = ["forbidden", "explicit_receipt_required"] as const;

export interface SemanticGenerationTarget {
  readonly kind: "generation";
  readonly detector: DetectorRef;
  readonly pack: PackRef;
  readonly lens: LensRef;
  readonly windowDigest: string;
  readonly executionKeyDigest: string;
  readonly episodeRecordIds: readonly string[];
  readonly disclosedEvidenceReferenceDigests: readonly string[];
}

export interface SemanticAdvisoryReviewTarget {
  readonly kind: "advisory_review";
  readonly candidateId: string;
  readonly candidateDigest: string;
  readonly derivation: {
    readonly id: string;
    readonly derivationDigest: string;
    readonly scopeDigest: string;
  } | null;
  readonly evidenceSetDigest: string;
}

export type SemanticTurnTarget = SemanticGenerationTarget | SemanticAdvisoryReviewTarget;

export interface SemanticTurnRequestBinding {
  readonly mediaType: "application/json";
  readonly encoding: "utf-8";
  readonly byteLength: number;
  readonly minimizedBytesDigest: string;
  readonly keyPolicyDigest: string;
}

export interface SemanticTurnSourcePolicy {
  readonly sourceId: string;
  readonly contentPolicyId: string;
  readonly contentPolicyDigest: string;
  readonly outboundUse: (typeof SOURCE_OUTBOUND_POLICIES)[number];
}

export interface SemanticTurnReservation {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly runId: string;
  readonly loopRegistryRevision: string;
  readonly semanticRegistryDigest: string;
  readonly scopeDigest: string;
  readonly target: SemanticTurnTarget;
  readonly definition: SemanticWorkflowDefinition;
  readonly request: SemanticTurnRequestBinding;
  readonly sourcePolicies: readonly SemanticTurnSourcePolicy[];
  readonly disclosureExpected: boolean;
  readonly expiresAt: string;
  readonly turnKeyDigest: string;
  readonly reservationDigest: string;
}

export type SemanticTurnKeyInput = Omit<
  SemanticTurnReservation,
  "schemaVersion" | "id" | "expiresAt" | "turnKeyDigest" | "reservationDigest"
>;

export type SemanticTurnReservationInput = Omit<
  SemanticTurnReservation,
  "schemaVersion" | "id" | "turnKeyDigest" | "reservationDigest"
>;

export interface SemanticDisclosureAuthorization {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly turnKeyDigest: string;
  readonly reservationId: string;
  readonly reservationDigest: string;
  readonly scopeDigest: string;
  readonly request: {
    readonly byteLength: number;
    readonly minimizedBytesDigest: string;
  };
  readonly providerRegistrationDigest: string;
  readonly authorizer: PrincipalRef;
  readonly authorizerAttestation: {
    readonly id: string;
    readonly digest: string;
  };
  readonly authorizationPolicyDigest: string;
  readonly authorizedAt: string;
  readonly expiresAt: string;
  readonly authorizationDigest: string;
}

export interface SemanticDisclosureAuthorizationInput {
  readonly authorizer: PrincipalRef;
  readonly authorizerAttestation: {
    readonly id: string;
    readonly digest: string;
  };
  readonly authorizedAt: string;
  readonly expiresAt: string;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

function parsePositiveSafeInteger(maximum: number, label: string): Parse<number> {
  return (input, path) => {
    if (typeof input !== "number" || !Number.isSafeInteger(input) || input < 1 || input > maximum) {
      throw invalid("schema.invalid", `${label} must be an integer from 1 through ${maximum}`, path);
    }
    return input;
  };
}

const parseCanonicalTimestamp: Parse<string> = (input, path) => {
  if (typeof input !== "string") throw invalid("schema.invalid", "timestamp must be a string", path);
  const milliseconds = Date.parse(input);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== input) {
    throw invalid("schema.invalid", "timestamp must be canonical RFC 3339 UTC with milliseconds", path);
  }
  return input;
};

function parseDerivationRefAt(
  input: unknown,
  path: readonly (string | number)[],
): NonNullable<SemanticAdvisoryReviewTarget["derivation"]> {
  const fields = readFields(input, path);
  const derivationDigest = fields.req("derivationDigest", parseDigestAt);
  const id = fields.req("id", parseId);
  if (id !== `insight-${derivationDigest}`) {
    throw invalid("schema.corrupt", "derivation id does not match its digest", [...path, "id"]);
  }
  return {
    id,
    derivationDigest,
    scopeDigest: fields.req("scopeDigest", parseDigestAt),
  };
}

function parseGenerationTargetAt(
  input: unknown,
  path: readonly (string | number)[],
  definition: SemanticWorkflowDefinition,
): SemanticGenerationTarget {
  const fields = readFields(input, path);
  const episodeRecordIds = fields.req(
    "episodeRecordIds",
    parseBoundedArray(parseDurableId, SEMANTIC_WORKFLOW_MAX_EPISODES, "workflow episode record ids"),
  );
  if (episodeRecordIds.length > definition.budgetPolicy.maximumEpisodes) {
    throw invalid("schema.invalid", "workflow episode population exceeds its registered budget", [
      ...path,
      "episodeRecordIds",
    ]);
  }
  if (episodeRecordIds.length === 0) {
    throw invalid("schema.invalid", "generation turn reservation requires a nonempty exact episode population", [
      ...path,
      "episodeRecordIds",
    ]);
  }
  assertSortedUnique(episodeRecordIds, (value) => value, [...path, "episodeRecordIds"]);
  const disclosedEvidenceReferenceDigests = fields.req(
    "disclosedEvidenceReferenceDigests",
    parseBoundedArray(parseDigestAt, SEMANTIC_WORKFLOW_MAX_EVIDENCE_REFS, "disclosed evidence reference digests"),
  );
  if (disclosedEvidenceReferenceDigests.length > definition.budgetPolicy.maximumEvidenceRefs) {
    throw invalid("schema.invalid", "workflow evidence population exceeds its registered budget", [
      ...path,
      "disclosedEvidenceReferenceDigests",
    ]);
  }
  assertSortedUnique(disclosedEvidenceReferenceDigests, (value) => value, [
    ...path,
    "disclosedEvidenceReferenceDigests",
  ]);
  return {
    kind: fields.req("kind", parseOneOf(["generation"])),
    detector: fields.req("detector", parseDetectorRefAt),
    pack: fields.req("pack", parsePackRefAt),
    lens: fields.req("lens", parseLensRefAt),
    windowDigest: fields.req("windowDigest", parseDigestAt),
    executionKeyDigest: fields.req("executionKeyDigest", parseDigestAt),
    episodeRecordIds,
    disclosedEvidenceReferenceDigests,
  };
}

function parseAdvisoryReviewTargetAt(
  input: unknown,
  path: readonly (string | number)[],
  exactScopeDigest: string,
): SemanticAdvisoryReviewTarget {
  const fields = readFields(input, path);
  const derivation = fields.req("derivation", parseNullable(parseDerivationRefAt));
  if (derivation !== null && derivation.scopeDigest !== exactScopeDigest) {
    throw invalid("schema.corrupt", "review derivation scope does not match the turn scope", [
      ...path,
      "derivation",
      "scopeDigest",
    ]);
  }
  return {
    kind: fields.req("kind", parseOneOf(["advisory_review"])),
    candidateId: fields.req("candidateId", parseDurableId),
    candidateDigest: fields.req("candidateDigest", parseDigestAt),
    derivation,
    evidenceSetDigest: fields.req("evidenceSetDigest", parseDigestAt),
  };
}

function parseTargetAt(
  input: unknown,
  path: readonly (string | number)[],
  definition: SemanticWorkflowDefinition,
  exactScopeDigest: string,
): SemanticTurnTarget {
  const fields = readFields(input, path);
  const kind = fields.req("kind", parseOneOf(["generation", "advisory_review"]));
  if (kind !== definition.lane) {
    throw invalid("schema.corrupt", "workflow lane does not match its turn target", [...path, "kind"]);
  }
  return kind === "generation"
    ? parseGenerationTargetAt(input, path, definition)
    : parseAdvisoryReviewTargetAt(input, path, exactScopeDigest);
}

function parseRequestAt(
  input: unknown,
  path: readonly (string | number)[],
  definition: SemanticWorkflowDefinition,
): SemanticTurnRequestBinding {
  const fields = readFields(input, path);
  const byteLength = fields.req(
    "byteLength",
    parsePositiveSafeInteger(definition.budgetPolicy.maximumRequestBytes, "minimized request byte length"),
  );
  const keyPolicyDigest = fields.req("keyPolicyDigest", parseDigestAt);
  if (keyPolicyDigest !== definition.disclosurePolicy.keyPolicyDigest) {
    throw invalid("schema.corrupt", "request key policy does not match the workflow definition", [
      ...path,
      "keyPolicyDigest",
    ]);
  }
  return {
    mediaType: fields.req("mediaType", parseOneOf(["application/json"])),
    encoding: fields.req("encoding", parseOneOf(["utf-8"])),
    byteLength,
    minimizedBytesDigest: fields.req("minimizedBytesDigest", parseDigestAt),
    keyPolicyDigest,
  };
}

const parseSourcePolicyAt: Parse<SemanticTurnSourcePolicy> = (input, path) => {
  const fields = readFields(input, path);
  return {
    sourceId: fields.req("sourceId", parseId),
    contentPolicyId: fields.req("contentPolicyId", parseId),
    contentPolicyDigest: fields.req("contentPolicyDigest", parseDigestAt),
    outboundUse: fields.req("outboundUse", parseOneOf(SOURCE_OUTBOUND_POLICIES)),
  };
};

function sourcePolicyKey(value: SemanticTurnSourcePolicy): string {
  return canonicalKey([value.sourceId, value.contentPolicyId, value.contentPolicyDigest, value.outboundUse]);
}

function parseSourcePoliciesAt(
  input: unknown,
  path: readonly (string | number)[],
): readonly SemanticTurnSourcePolicy[] {
  const values = parseBoundedArray(
    parseSourcePolicyAt,
    SEMANTIC_WORKFLOW_MAX_EVIDENCE_REFS,
    "workflow source policies",
  )(input, path);
  assertSortedUnique(values, sourcePolicyKey, path);
  const sourceIds = new Set<string>();
  for (const [index, value] of values.entries()) {
    if (sourceIds.has(value.sourceId)) {
      throw invalid("schema.invalid", "a workflow source may bind exactly one content policy", [
        ...path,
        index,
        "sourceId",
      ]);
    }
    sourceIds.add(value.sourceId);
  }
  return values;
}

function semanticTurnKeyContent(input: SemanticTurnKeyInput): JsonValue {
  return toJsonValue({
    domain: TURN_KEY_DOMAIN,
    runId: input.runId,
    loopRegistryRevision: input.loopRegistryRevision,
    semanticRegistryDigest: input.semanticRegistryDigest,
    scopeDigest: input.scopeDigest,
    target: input.target,
    definition: input.definition,
    request: input.request,
    sourcePolicies: input.sourcePolicies,
    disclosureExpected: input.disclosureExpected,
  });
}

export function semanticTurnKeyDigest(input: SemanticTurnKeyInput): string {
  return digestOf(semanticTurnKeyContent(input));
}

function semanticTurnReservationContent(
  input: Omit<SemanticTurnReservation, "schemaVersion" | "id" | "reservationDigest">,
): JsonValue {
  return toJsonValue({
    domain: RESERVATION_DOMAIN,
    runId: input.runId,
    loopRegistryRevision: input.loopRegistryRevision,
    semanticRegistryDigest: input.semanticRegistryDigest,
    scopeDigest: input.scopeDigest,
    target: input.target,
    definition: input.definition,
    request: input.request,
    sourcePolicies: input.sourcePolicies,
    disclosureExpected: input.disclosureExpected,
    expiresAt: input.expiresAt,
    turnKeyDigest: input.turnKeyDigest,
  });
}

export function semanticTurnReservationDigest(
  input: Omit<SemanticTurnReservation, "schemaVersion" | "id" | "reservationDigest">,
): string {
  return digestOf(semanticTurnReservationContent(input));
}

function assertDisclosurePolicy(
  definition: SemanticWorkflowDefinition,
  sourcePolicies: readonly SemanticTurnSourcePolicy[],
  disclosureExpected: boolean,
): void {
  const expected = definition.transport === "outbound";
  if (disclosureExpected !== expected) {
    throw invalid("schema.corrupt", "disclosure expectation does not match workflow transport", ["disclosureExpected"]);
  }
  if (expected) {
    if (
      definition.disclosurePolicy.mode !== "explicit_authorization" ||
      sourcePolicies.some((policy) => policy.outboundUse !== "explicit_receipt_required")
    ) {
      throw invalid("schema.invalid", "outbound workflow content requires exact authorization-eligible policies", [
        "sourcePolicies",
      ]);
    }
    return;
  }
  if (definition.disclosurePolicy.mode !== "forbidden") {
    throw invalid("schema.corrupt", "local workflow disclosure policy must remain forbidden", [
      "definition",
      "disclosurePolicy",
    ]);
  }
}

export function parseSemanticTurnReservation(input: unknown): SemanticTurnReservation {
  const fields = readFields(input, []);
  const schemaVersion = fields.schemaVersion1();
  const definition = fields.req("definition", (value) => parseSemanticWorkflowDefinition(value));
  const scopeDigest = fields.req("scopeDigest", parseDigestAt);
  const target = fields.req("target", (value, path) => parseTargetAt(value, path, definition, scopeDigest));
  const request = fields.req("request", (value, path) => parseRequestAt(value, path, definition));
  const sourcePolicies = fields.req("sourcePolicies", parseSourcePoliciesAt);
  const disclosureExpected = fields.req("disclosureExpected", parseBool);
  assertDisclosurePolicy(definition, sourcePolicies, disclosureExpected);
  const semanticInputs: SemanticTurnKeyInput = {
    runId: fields.req("runId", parseDurableId),
    loopRegistryRevision: fields.req("loopRegistryRevision", parseDigestAt),
    semanticRegistryDigest: fields.req("semanticRegistryDigest", parseDigestAt),
    scopeDigest,
    target,
    definition,
    request,
    sourcePolicies,
    disclosureExpected,
  };
  const turnKeyDigest = fields.req("turnKeyDigest", parseDigestAt);
  if (turnKeyDigest !== semanticTurnKeyDigest(semanticInputs)) {
    throw invalid("schema.corrupt", "semantic turn key digest does not match its semantic inputs", ["turnKeyDigest"]);
  }
  const id = fields.req("id", parseDurableId);
  if (id !== `${RESERVATION_ID_PREFIX}${turnKeyDigest}`) {
    throw invalid("schema.corrupt", "semantic turn reservation id does not match its key digest", ["id"]);
  }
  const base = {
    ...semanticInputs,
    expiresAt: fields.req("expiresAt", parseCanonicalTimestamp),
    turnKeyDigest,
  };
  const reservationDigest = fields.req("reservationDigest", parseDigestAt);
  if (reservationDigest !== semanticTurnReservationDigest(base)) {
    throw invalid("schema.corrupt", "semantic turn reservation digest does not match its bound fields", [
      "reservationDigest",
    ]);
  }
  return deepFreeze({ schemaVersion, id, ...base, reservationDigest });
}

export function buildSemanticTurnReservation(input: SemanticTurnReservationInput): SemanticTurnReservation {
  const semanticInputs: SemanticTurnKeyInput = {
    runId: input.runId,
    loopRegistryRevision: input.loopRegistryRevision,
    semanticRegistryDigest: input.semanticRegistryDigest,
    scopeDigest: input.scopeDigest,
    target: input.target,
    definition: input.definition,
    request: input.request,
    sourcePolicies: input.sourcePolicies,
    disclosureExpected: input.disclosureExpected,
  };
  const turnKeyDigest = semanticTurnKeyDigest(semanticInputs);
  const base = { ...semanticInputs, expiresAt: input.expiresAt, turnKeyDigest };
  return parseSemanticTurnReservation({
    schemaVersion: 1,
    id: `${RESERVATION_ID_PREFIX}${turnKeyDigest}`,
    ...base,
    reservationDigest: semanticTurnReservationDigest(base),
  });
}

function semanticDisclosureAuthorizationContent(
  input: Omit<SemanticDisclosureAuthorization, "schemaVersion" | "id" | "authorizationDigest">,
): JsonValue {
  return toJsonValue({
    domain: AUTHORIZATION_DOMAIN,
    turnKeyDigest: input.turnKeyDigest,
    reservationId: input.reservationId,
    reservationDigest: input.reservationDigest,
    scopeDigest: input.scopeDigest,
    request: input.request,
    providerRegistrationDigest: input.providerRegistrationDigest,
    authorizer: input.authorizer,
    authorizerAttestation: input.authorizerAttestation,
    authorizationPolicyDigest: input.authorizationPolicyDigest,
    authorizedAt: input.authorizedAt,
    expiresAt: input.expiresAt,
  });
}

export function semanticDisclosureAuthorizationDigest(
  input: Omit<SemanticDisclosureAuthorization, "schemaVersion" | "id" | "authorizationDigest">,
): string {
  return digestOf(semanticDisclosureAuthorizationContent(input));
}

function parseAuthorizationRequestAt(
  input: unknown,
  path: readonly (string | number)[],
): SemanticDisclosureAuthorization["request"] {
  const fields = readFields(input, path);
  return {
    byteLength: fields.req(
      "byteLength",
      parsePositiveSafeInteger(Number.MAX_SAFE_INTEGER, "authorized request byte length"),
    ),
    minimizedBytesDigest: fields.req("minimizedBytesDigest", parseDigestAt),
  };
}

function parseAttestationAt(
  input: unknown,
  path: readonly (string | number)[],
): SemanticDisclosureAuthorization["authorizerAttestation"] {
  const fields = readFields(input, path);
  return {
    id: fields.req("id", parseId),
    digest: fields.req("digest", parseDigestAt),
  };
}

function assertExactAuthorizationReservation(
  authorization: Omit<SemanticDisclosureAuthorization, "schemaVersion" | "id" | "authorizationDigest">,
  reservation: SemanticTurnReservation,
): void {
  if (
    authorization.turnKeyDigest !== reservation.turnKeyDigest ||
    authorization.reservationId !== reservation.id ||
    authorization.reservationDigest !== reservation.reservationDigest ||
    authorization.scopeDigest !== reservation.scopeDigest ||
    authorization.request.byteLength !== reservation.request.byteLength ||
    authorization.request.minimizedBytesDigest !== reservation.request.minimizedBytesDigest ||
    authorization.providerRegistrationDigest !== reservation.definition.providerModel.provider.registrationDigest ||
    authorization.authorizationPolicyDigest !== reservation.definition.disclosurePolicy.authorizationPolicyDigest
  ) {
    throw invalid("schema.corrupt", "disclosure authorization does not match its exact reservation", [
      "reservationDigest",
    ]);
  }
}

function assertAuthorizationWindow(
  authorization: Pick<SemanticDisclosureAuthorization, "authorizedAt" | "expiresAt">,
  reservation: SemanticTurnReservation,
): void {
  const authorizedAt = Date.parse(authorization.authorizedAt);
  const expiresAt = Date.parse(authorization.expiresAt);
  const reservationExpiresAt = Date.parse(reservation.expiresAt);
  const maximumAge = reservation.definition.disclosurePolicy.maximumAuthorizationAgeMs;
  if (expiresAt <= authorizedAt || expiresAt - authorizedAt > maximumAge || expiresAt > reservationExpiresAt) {
    throw invalid(
      "schema.invalid",
      "authorization expiry must follow authorization, stay within policy age, and not outlive its reservation",
      ["expiresAt"],
    );
  }
}

export function parseSemanticDisclosureAuthorization(
  input: unknown,
  reservationInput: unknown,
): SemanticDisclosureAuthorization {
  const reservation = parseSemanticTurnReservation(reservationInput);
  if (
    reservation.definition.transport !== "outbound" ||
    reservation.definition.disclosurePolicy.mode !== "explicit_authorization" ||
    !reservation.disclosureExpected
  ) {
    throw invalid("schema.invalid", "local semantic turns cannot carry disclosure authorization", ["reservationId"]);
  }
  const fields = readFields(input, []);
  const schemaVersion = fields.schemaVersion1();
  const base = {
    turnKeyDigest: fields.req("turnKeyDigest", parseDigestAt),
    reservationId: fields.req("reservationId", parseDurableId),
    reservationDigest: fields.req("reservationDigest", parseDigestAt),
    scopeDigest: fields.req("scopeDigest", parseDigestAt),
    request: fields.req("request", parseAuthorizationRequestAt),
    providerRegistrationDigest: fields.req("providerRegistrationDigest", parseDigestAt),
    authorizer: fields.req("authorizer", parsePrincipalRefAt),
    authorizerAttestation: fields.req("authorizerAttestation", parseAttestationAt),
    authorizationPolicyDigest: fields.req("authorizationPolicyDigest", parseDigestAt),
    authorizedAt: fields.req("authorizedAt", parseCanonicalTimestamp),
    expiresAt: fields.req("expiresAt", parseCanonicalTimestamp),
  };
  assertExactAuthorizationReservation(base, reservation);
  assertAuthorizationWindow(base, reservation);
  const id = fields.req("id", parseDurableId);
  if (id !== `${AUTHORIZATION_ID_PREFIX}${reservation.turnKeyDigest}`) {
    throw invalid("schema.corrupt", "semantic disclosure authorization id does not match its turn key", ["id"]);
  }
  const authorizationDigest = fields.req("authorizationDigest", parseDigestAt);
  if (authorizationDigest !== semanticDisclosureAuthorizationDigest(base)) {
    throw invalid("schema.corrupt", "semantic disclosure authorization digest does not match its bound fields", [
      "authorizationDigest",
    ]);
  }
  return deepFreeze({ schemaVersion, id, ...base, authorizationDigest });
}

export function buildSemanticDisclosureAuthorization(
  reservationInput: unknown,
  input: SemanticDisclosureAuthorizationInput,
): SemanticDisclosureAuthorization {
  const reservation = parseSemanticTurnReservation(reservationInput);
  const base = {
    turnKeyDigest: reservation.turnKeyDigest,
    reservationId: reservation.id,
    reservationDigest: reservation.reservationDigest,
    scopeDigest: reservation.scopeDigest,
    request: {
      byteLength: reservation.request.byteLength,
      minimizedBytesDigest: reservation.request.minimizedBytesDigest,
    },
    providerRegistrationDigest: reservation.definition.providerModel.provider.registrationDigest,
    authorizer: input.authorizer,
    authorizerAttestation: input.authorizerAttestation,
    authorizationPolicyDigest: reservation.definition.disclosurePolicy.authorizationPolicyDigest,
    authorizedAt: input.authorizedAt,
    expiresAt: input.expiresAt,
  };
  return parseSemanticDisclosureAuthorization(
    {
      schemaVersion: 1,
      id: `${AUTHORIZATION_ID_PREFIX}${reservation.turnKeyDigest}`,
      ...base,
      authorizationDigest: semanticDisclosureAuthorizationDigest(base),
    },
    reservation,
  );
}
