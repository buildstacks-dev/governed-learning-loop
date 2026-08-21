// Private durable journal of the Activate publisher (decision 0026). Nothing
// here is a public symbol or a supported consumer API. The journal for one
// exact plan is, in write order:
//   1. publication-authorization  — the consumption record: the exact verified
//      authorization bound to the exact plan binding at consumption time;
//   2. intervention               — the create-only header binding candidate,
//      plan, destination, action, scope, and parent intervention;
//   3. intervention-scope-index   — a create-only membership record in a
//      scope-derived namespace, written before the first transition so no
//      later backfill is ever needed;
//   4. intervention-transition    — the append-only state history (stream id
//      is the intervention id; entry id is the content-addressed transition
//      id); the first entry is the authorize edge;
//   5. publication-receipt        — one create-only record per applied effect,
//      keyed by the kernel idempotency key, written after the destination
//      acknowledged the effect and before the publish edge;
//   6. the parent's reversal edge (disable/rollback/compensate plans only);
//   7. the publish edge, last.
// Every writer reloads first and forward-completes: a retry converges on the
// same bytes, a lost acknowledgement is repaired by reloading, and a
// concurrent contender loses cleanly on create-only or expected-revision
// conflicts. The InterventionRecord is never persisted as such: it is the
// deterministic fold of the header plus the stream.
import { sha256HexOfCanonicalJson } from "../canonical/canonical-json.js";
import type { JsonValue } from "../canonical/json.js";
import { toJsonValue } from "../canonical/to-json-value.js";
import type { Diagnostic } from "../diagnostics.js";
import { LearningLoopError } from "../diagnostics.js";
import { invalid, parseArrayOf, parseNonEmptyText, parseOneOf, readFields } from "../parse/toolkit.js";
import type { Parse } from "../parse/toolkit.js";
import type { RecordKey, StoredRecord } from "../ports/store.js";
import type { VerifiedAuthorization } from "../records/authorization.js";
import type { InterventionRecord, InterventionState, InterventionTransition } from "../records/intervention.js";
import {
  INITIAL_INTERVENTION_STATE,
  interventionTransitionDigest,
  interventionTransitionIdFor,
  interventionTransitionKind,
  parseInterventionRecord,
  parseInterventionTransition,
  sameInterventionState,
} from "../records/intervention.js";
import type { PrincipalRef } from "../records/principal.js";
import { parsePrincipalRefAt } from "../records/principal.js";
import type { EffectClass, PreparedEffect, PublicationPlan, PublicationReceipt } from "../records/publication.js";
import {
  EFFECT_CLASSES,
  PUBLICATION_ACTIONS,
  parsePublicationReceiptAt,
  publicationEffectIdempotencyKey,
  publicationPlanIdFor,
  publicationReceiptMismatchReasons,
} from "../records/publication.js";
import {
  parseBoundedArray,
  parseCanonicalTimestampAt,
  parseDigestAt,
  parseDurableId,
  parseId,
  parseNullable,
} from "../records/semantic-shared.js";
import type { EngineContext } from "./context.js";
import { createOnly, loadStoredRecord, parseWriteResult, recordDigest, recordKey } from "./context.js";
import type { ExperimentVerdict } from "../records/experiment.js";
import { EXPERIMENT_VERDICTS } from "../records/experiment.js";

const INTERVENTION_ID_PREFIX = "intervention-";
const AUTHORIZATION_ID_PREFIX = "authorization-";
const RECEIPT_ID_PREFIX = "receipt-";
const SCOPE_INDEX_KIND = "intervention-scope-index";
const CONSUMPTION_DIGEST_DOMAIN = "publication-authorization:v1";
const HEADER_DIGEST_DOMAIN = "intervention-header:v1";
const MEMBERSHIP_DIGEST_DOMAIN = "intervention-scope-membership:v1";
const STORED_RECEIPT_DIGEST_DOMAIN = "publication-receipt:v1";
const MAX_APPEND_ATTEMPTS = 8;
const MAX_TRANSITIONS_PER_INTERVENTION = 1_000;
const MAX_SCOPE_MEMBERSHIPS = 10_000;
const SCOPE_INDEX_PAGE = 100;
const MAX_EFFECT_INDEX = 1_000;
const EVALUATION_INDEX_KIND = "intervention-evaluation";
const MAX_EVALUATIONS_PER_INTERVENTION = 1_000;

export function interventionIdFor(planDigest: string): string {
  return `${INTERVENTION_ID_PREFIX}${planDigest}`;
}

export function authorizationConsumptionIdFor(planDigest: string): string {
  return `${AUTHORIZATION_ID_PREFIX}${planDigest}`;
}

export function receiptIdFor(idempotencyKey: string): string {
  return `${RECEIPT_ID_PREFIX}${idempotencyKey}`;
}

export function interventionScopeNamespace(scopeDigest: string): string {
  return `learning-intervention-scope-${scopeDigest}`;
}

function corrupt(message: string, extra: readonly Diagnostic[] = []): LearningLoopError {
  return new LearningLoopError("store.corrupt", [{ code: "store.corrupt", severity: "error", message }, ...extra]);
}

function sameCanonical(left: unknown, right: unknown): boolean {
  return recordDigest(toJsonValue(left)) === recordDigest(toJsonValue(right));
}

// ---------------------------------------------------------------------------
// Authorization consumption

export interface ConsumedAuthorization {
  readonly id: string;
  readonly principal: PrincipalRef;
  readonly principalAttestationDigest: string;
  readonly bindingDigest: string;
  readonly authorizedAt: string;
  readonly expiresAt?: string;
}

export interface AuthorizationConsumption {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly planId: string;
  readonly planDigest: string;
  readonly bindingDigest: string;
  readonly authorization: ConsumedAuthorization;
  readonly registryRevision: string;
  readonly policyDigest: string;
  readonly consumedAt: string;
  readonly consumptionDigest: string;
}

type ConsumptionContent = Omit<AuthorizationConsumption, "schemaVersion" | "id" | "consumptionDigest">;

function consumptionContent(input: ConsumptionContent): JsonValue {
  return toJsonValue({
    domain: CONSUMPTION_DIGEST_DOMAIN,
    planId: input.planId,
    planDigest: input.planDigest,
    bindingDigest: input.bindingDigest,
    authorization: {
      id: input.authorization.id,
      principal: input.authorization.principal,
      principalAttestationDigest: input.authorization.principalAttestationDigest,
      bindingDigest: input.authorization.bindingDigest,
      authorizedAt: input.authorization.authorizedAt,
      ...(input.authorization.expiresAt !== undefined ? { expiresAt: input.authorization.expiresAt } : {}),
    },
    registryRevision: input.registryRevision,
    policyDigest: input.policyDigest,
    consumedAt: input.consumedAt,
  });
}

const parseConsumedAuthorizationAt: Parse<ConsumedAuthorization> = (input, path) => {
  const fields = readFields(input, path);
  const expiresAt = fields.opt("expiresAt", parseCanonicalTimestampAt);
  return {
    id: fields.req("id", parseDurableId),
    principal: fields.req("principal", parsePrincipalRefAt),
    principalAttestationDigest: fields.req("principalAttestationDigest", parseDigestAt),
    bindingDigest: fields.req("bindingDigest", parseDigestAt),
    authorizedAt: fields.req("authorizedAt", parseCanonicalTimestampAt),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
  };
};

export function parseAuthorizationConsumption(input: unknown): AuthorizationConsumption {
  const fields = readFields(input, []);
  const schemaVersion = fields.schemaVersion1();
  const content: ConsumptionContent = {
    planId: fields.req("planId", parseDurableId),
    planDigest: fields.req("planDigest", parseDigestAt),
    bindingDigest: fields.req("bindingDigest", parseDigestAt),
    authorization: fields.req("authorization", parseConsumedAuthorizationAt),
    registryRevision: fields.req("registryRevision", parseDigestAt),
    policyDigest: fields.req("policyDigest", parseDigestAt),
    consumedAt: fields.req("consumedAt", parseCanonicalTimestampAt),
  };
  const id = fields.req("id", parseDurableId);
  const consumptionDigest = fields.req("consumptionDigest", parseDigestAt);
  if (
    id !== authorizationConsumptionIdFor(content.planDigest) ||
    content.planId !== publicationPlanIdFor(content.planDigest)
  ) {
    throw invalid("schema.corrupt", "authorization consumption id does not match its plan", ["id"]);
  }
  if (content.authorization.bindingDigest !== content.bindingDigest) {
    throw invalid("schema.corrupt", "consumed authorization binds another binding digest", ["authorization"]);
  }
  if (consumptionDigest !== sha256HexOfCanonicalJson(consumptionContent(content))) {
    throw invalid("schema.corrupt", "authorization consumption digest does not match its content", [
      "consumptionDigest",
    ]);
  }
  return Object.freeze({ schemaVersion, id, ...content, consumptionDigest });
}

export function buildAuthorizationConsumption(
  context: EngineContext,
  plan: PublicationPlan,
  bindingDigest: string,
  authorization: VerifiedAuthorization,
): AuthorizationConsumption {
  const content: ConsumptionContent = {
    planId: plan.id,
    planDigest: plan.planDigest,
    bindingDigest,
    authorization: {
      id: authorization.id,
      principal: { ...authorization.principal },
      principalAttestationDigest: authorization.principalAttestationDigest,
      bindingDigest: authorization.bindingDigest,
      authorizedAt: authorization.authorizedAt,
      ...(authorization.expiresAt !== undefined ? { expiresAt: authorization.expiresAt } : {}),
    },
    registryRevision: context.registryRevision,
    policyDigest: context.policy.digest,
    consumedAt: context.clock.now(),
  };
  return parseAuthorizationConsumption({
    schemaVersion: 1,
    id: authorizationConsumptionIdFor(plan.planDigest),
    ...content,
    consumptionDigest: sha256HexOfCanonicalJson(consumptionContent(content)),
  });
}

export async function loadAuthorizationConsumption(
  context: EngineContext,
  planDigest: string,
): Promise<AuthorizationConsumption | undefined> {
  const stored = await loadStoredRecord(
    context,
    "publication-authorization",
    authorizationConsumptionIdFor(planDigest),
  );
  if (stored === undefined) return undefined;
  const consumption = parseAuthorizationConsumption(stored.value);
  if (consumption.planDigest !== planDigest) throw corrupt("authorization consumption belongs to another plan");
  return consumption;
}

/**
 * Create-only consumption. `exists_same` and a conflict that reloads to the
 * same plan/binding are both "another attempt consumed first"; only the
 * timestamp may differ. Returns the durable record and whether it pre-existed.
 */
export async function ensureAuthorizationConsumption(
  context: EngineContext,
  consumption: AuthorizationConsumption,
): Promise<{ readonly consumption: AuthorizationConsumption; readonly preexisting: boolean }> {
  const status = await createOnly(
    context,
    "publication-authorization",
    consumption.id,
    consumption,
    `publication-authorization/${consumption.id}`,
  );
  if (status === "created") return { consumption, preexisting: false };
  const stored = await loadAuthorizationConsumption(context, consumption.planDigest);
  if (
    stored === undefined ||
    stored.planId !== consumption.planId ||
    stored.bindingDigest !== consumption.bindingDigest ||
    stored.registryRevision !== consumption.registryRevision ||
    stored.policyDigest !== consumption.policyDigest
  ) {
    throw corrupt("an authorization consumption for this plan holds different bound content");
  }
  return { consumption: stored, preexisting: true };
}

// ---------------------------------------------------------------------------
// Intervention header

export interface InterventionHeader {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly candidateId: string;
  readonly candidateDigest: string;
  readonly planId: string;
  readonly planDigest: string;
  readonly destinationId: string;
  readonly action: PublicationPlan["action"];
  readonly effectClass: EffectClass;
  readonly scopeDigest: string;
  readonly parentInterventionId: string | null;
  readonly authorizationId: string;
  readonly createdAt: string;
  readonly headerDigest: string;
}

type HeaderContent = Omit<InterventionHeader, "schemaVersion" | "id" | "headerDigest">;

function headerContent(input: HeaderContent): JsonValue {
  return toJsonValue({
    domain: HEADER_DIGEST_DOMAIN,
    candidateId: input.candidateId,
    candidateDigest: input.candidateDigest,
    planId: input.planId,
    planDigest: input.planDigest,
    destinationId: input.destinationId,
    action: input.action,
    effectClass: input.effectClass,
    scopeDigest: input.scopeDigest,
    parentInterventionId: input.parentInterventionId,
    authorizationId: input.authorizationId,
    createdAt: input.createdAt,
  });
}

export function parseInterventionHeader(input: unknown): InterventionHeader {
  const fields = readFields(input, []);
  const schemaVersion = fields.schemaVersion1();
  const content: HeaderContent = {
    candidateId: fields.req("candidateId", parseDurableId),
    candidateDigest: fields.req("candidateDigest", parseDigestAt),
    planId: fields.req("planId", parseDurableId),
    planDigest: fields.req("planDigest", parseDigestAt),
    destinationId: fields.req("destinationId", parseId),
    action: fields.req("action", parseOneOf(PUBLICATION_ACTIONS)),
    effectClass: fields.req("effectClass", parseOneOf(EFFECT_CLASSES)),
    scopeDigest: fields.req("scopeDigest", parseDigestAt),
    parentInterventionId: fields.req("parentInterventionId", parseNullable(parseDurableId)),
    authorizationId: fields.req("authorizationId", parseDurableId),
    createdAt: fields.req("createdAt", parseCanonicalTimestampAt),
  };
  const id = fields.req("id", parseDurableId);
  const headerDigest = fields.req("headerDigest", parseDigestAt);
  if (
    id !== interventionIdFor(content.planDigest) ||
    content.planId !== publicationPlanIdFor(content.planDigest) ||
    content.authorizationId !== authorizationConsumptionIdFor(content.planDigest)
  ) {
    throw invalid("schema.corrupt", "intervention header id does not match its plan", ["id"]);
  }
  if ((content.action === "publish") !== (content.parentInterventionId === null)) {
    throw invalid("schema.corrupt", "intervention header parent does not agree with its action", [
      "parentInterventionId",
    ]);
  }
  if (content.parentInterventionId === id) {
    throw invalid("schema.corrupt", "an intervention cannot be its own parent", ["parentInterventionId"]);
  }
  if (headerDigest !== sha256HexOfCanonicalJson(headerContent(content))) {
    throw invalid("schema.corrupt", "intervention header digest does not match its content", ["headerDigest"]);
  }
  return Object.freeze({ schemaVersion, id, ...content, headerDigest });
}

export function buildInterventionHeader(context: EngineContext, plan: PublicationPlan): InterventionHeader {
  const content: HeaderContent = {
    candidateId: plan.candidateId,
    candidateDigest: plan.candidateDigest,
    planId: plan.id,
    planDigest: plan.planDigest,
    destinationId: plan.destinationId,
    action: plan.action,
    effectClass: plan.effectClass,
    scopeDigest: plan.lineage.scopeDigest,
    parentInterventionId: plan.lineage.parentInterventionId ?? null,
    authorizationId: authorizationConsumptionIdFor(plan.planDigest),
    createdAt: context.clock.now(),
  };
  return parseInterventionHeader({
    schemaVersion: 1,
    id: interventionIdFor(plan.planDigest),
    ...content,
    headerDigest: sha256HexOfCanonicalJson(headerContent(content)),
  });
}

export async function loadInterventionHeader(
  context: EngineContext,
  interventionId: string,
): Promise<InterventionHeader | undefined> {
  const stored = await loadStoredRecord(context, "intervention", interventionId);
  if (stored === undefined) return undefined;
  const header = parseInterventionHeader(stored.value);
  if (header.id !== interventionId) throw corrupt("stored intervention header id does not match its record key");
  return header;
}

export async function ensureInterventionHeader(
  context: EngineContext,
  header: InterventionHeader,
): Promise<InterventionHeader> {
  const status = await createOnly(context, "intervention", header.id, header, `intervention/${header.id}`);
  if (status === "created") return header;
  const stored = await loadInterventionHeader(context, header.id);
  if (stored === undefined) throw corrupt("intervention header conflicted but cannot be reloaded");
  const { createdAt: _storedCreatedAt, headerDigest: _storedDigest, ...storedBound } = stored;
  const { createdAt: _createdAt, headerDigest: _digest, ...bound } = header;
  if (!sameCanonical(storedBound, bound)) throw corrupt("an intervention header for this plan holds different content");
  return stored;
}

// ---------------------------------------------------------------------------
// Scope membership index

export interface InterventionScopeMembership {
  readonly schemaVersion: 1;
  readonly scopeDigest: string;
  readonly interventionId: string;
  readonly candidateId: string;
  readonly candidateDigest: string;
  readonly destinationId: string;
  readonly action: PublicationPlan["action"];
  readonly parentInterventionId: string | null;
  readonly indexDigest: string;
}

type MembershipContent = Omit<InterventionScopeMembership, "schemaVersion" | "indexDigest">;

function membershipContent(input: MembershipContent): JsonValue {
  return toJsonValue({ domain: MEMBERSHIP_DIGEST_DOMAIN, ...input });
}

export function parseInterventionScopeMembership(input: unknown): InterventionScopeMembership {
  const fields = readFields(input, []);
  const schemaVersion = fields.schemaVersion1();
  const content: MembershipContent = {
    scopeDigest: fields.req("scopeDigest", parseDigestAt),
    interventionId: fields.req("interventionId", parseDurableId),
    candidateId: fields.req("candidateId", parseDurableId),
    candidateDigest: fields.req("candidateDigest", parseDigestAt),
    destinationId: fields.req("destinationId", parseId),
    action: fields.req("action", parseOneOf(PUBLICATION_ACTIONS)),
    parentInterventionId: fields.req("parentInterventionId", parseNullable(parseDurableId)),
  };
  const indexDigest = fields.req("indexDigest", parseDigestAt);
  if (indexDigest !== sha256HexOfCanonicalJson(membershipContent(content))) {
    throw invalid("schema.corrupt", "intervention scope membership digest is invalid", ["indexDigest"]);
  }
  return Object.freeze({ schemaVersion, ...content, indexDigest });
}

export function buildInterventionScopeMembership(header: InterventionHeader): InterventionScopeMembership {
  const content: MembershipContent = {
    scopeDigest: header.scopeDigest,
    interventionId: header.id,
    candidateId: header.candidateId,
    candidateDigest: header.candidateDigest,
    destinationId: header.destinationId,
    action: header.action,
    parentInterventionId: header.parentInterventionId,
  };
  return parseInterventionScopeMembership({
    schemaVersion: 1,
    ...content,
    indexDigest: sha256HexOfCanonicalJson(membershipContent(content)),
  });
}

function membershipKey(membership: { readonly scopeDigest: string; readonly interventionId: string }): RecordKey {
  return {
    namespace: interventionScopeNamespace(membership.scopeDigest),
    kind: SCOPE_INDEX_KIND,
    id: membership.interventionId,
  };
}

const parseUnknown: Parse<unknown> = (input) => input;

function parseStoredMembership(input: unknown, scopeDigest: string): InterventionScopeMembership {
  const fields = readFields(input, ["store", "interventionScopeMembership"]);
  const keyFields = readFields(fields.req("key", parseUnknown), ["store", "interventionScopeMembership", "key"]);
  const value = fields.req("value", parseUnknown);
  const digest = fields.req("digest", parseNonEmptyText);
  const id = keyFields.req("id", parseNonEmptyText);
  if (
    keyFields.req("namespace", parseNonEmptyText) !== interventionScopeNamespace(scopeDigest) ||
    keyFields.req("kind", parseNonEmptyText) !== SCOPE_INDEX_KIND ||
    digest !== recordDigest(toJsonValue(value))
  ) {
    throw corrupt("intervention scope membership envelope is invalid");
  }
  const membership = parseInterventionScopeMembership(value);
  if (membership.scopeDigest !== scopeDigest || membership.interventionId !== id) {
    throw corrupt("intervention scope membership belongs to another target");
  }
  return membership;
}

export async function ensureInterventionScopeMembership(
  context: EngineContext,
  membership: InterventionScopeMembership,
): Promise<void> {
  const value = toJsonValue(membership);
  const raw: unknown = await context.store.create(
    membershipKey(membership),
    value,
    recordDigest(value),
    `intervention-scope/${membership.scopeDigest}/${membership.interventionId}`,
  );
  const result = parseWriteResult(raw);
  if (result.status === "updated") throw corrupt("intervention scope membership was updated");
  if (result.status === "conflict") throw corrupt("intervention scope membership conflicts with different content");
  const stored: unknown = await context.store.get(membershipKey(membership));
  if (stored === undefined) throw corrupt("intervention scope membership was not preserved");
  const reloaded = parseStoredMembership(stored, membership.scopeDigest);
  if (reloaded.indexDigest !== membership.indexDigest) throw corrupt("intervention scope membership was not preserved");
}

/** Every membership in one exact scope, insertion-ordered; fails closed above the ceiling. */
export async function listInterventionScopeMemberships(
  context: EngineContext,
  scopeDigest: string,
): Promise<readonly InterventionScopeMembership[]> {
  const memberships: InterventionScopeMembership[] = [];
  let cursor: string | undefined;
  const seenCursors = new Set<string>();
  for (;;) {
    const raw: unknown = await context.store.list({
      namespace: interventionScopeNamespace(scopeDigest),
      kind: SCOPE_INDEX_KIND,
      ...(cursor !== undefined ? { cursor } : {}),
      limit: SCOPE_INDEX_PAGE,
    });
    const fields = readFields(raw, ["store", "list", SCOPE_INDEX_KIND]);
    const records = fields.req("records", parseArrayOf(parseUnknown));
    if (records.length > SCOPE_INDEX_PAGE) throw corrupt("store listing exceeded the requested page limit");
    for (const record of records) memberships.push(parseStoredMembership(record, scopeDigest));
    if (memberships.length > MAX_SCOPE_MEMBERSHIPS) {
      throw new LearningLoopError("publication.limit_exceeded", [
        {
          code: "publication.limit_exceeded",
          severity: "error",
          message: `scope holds more than ${MAX_SCOPE_MEMBERSHIPS} interventions`,
        },
      ]);
    }
    const next = fields.opt("nextCursor", parseNonEmptyText);
    if (next === undefined) return memberships;
    if (seenCursors.has(next)) throw corrupt("intervention scope listing cycled its cursor");
    seenCursors.add(next);
    cursor = next;
  }
}

// ---------------------------------------------------------------------------
// Stored receipts

export interface StoredPublicationReceipt {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly planId: string;
  readonly planDigest: string;
  readonly interventionId: string;
  readonly effectId: string;
  readonly effectIndex: number;
  readonly idempotencyKey: string;
  readonly receipt: PublicationReceipt;
  readonly receiptDigest: string;
}

type StoredReceiptContent = Omit<StoredPublicationReceipt, "schemaVersion" | "id" | "receiptDigest">;

function storedReceiptContent(input: StoredReceiptContent): JsonValue {
  return toJsonValue({
    domain: STORED_RECEIPT_DIGEST_DOMAIN,
    planId: input.planId,
    planDigest: input.planDigest,
    interventionId: input.interventionId,
    effectId: input.effectId,
    effectIndex: input.effectIndex,
    idempotencyKey: input.idempotencyKey,
    receipt: {
      destinationId: input.receipt.destinationId,
      effectId: input.receipt.effectId,
      target: input.receipt.target,
      ...(input.receipt.expectedBase !== undefined ? { expectedBase: input.receipt.expectedBase } : {}),
      ...(input.receipt.finalVersion !== undefined ? { finalVersion: input.receipt.finalVersion } : {}),
      payloadDigest: input.receipt.payloadDigest,
      idempotencyKey: input.receipt.idempotencyKey,
      appliedAt: input.receipt.appliedAt,
    },
  });
}

const parseEffectIndexAt: Parse<number> = (input, path) => {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input < 0 || input >= MAX_EFFECT_INDEX) {
    throw invalid("schema.invalid", "effect index must be a bounded non-negative integer", path);
  }
  return input;
};

export function parseStoredPublicationReceipt(input: unknown): StoredPublicationReceipt {
  const fields = readFields(input, []);
  const schemaVersion = fields.schemaVersion1();
  const content: StoredReceiptContent = {
    planId: fields.req("planId", parseDurableId),
    planDigest: fields.req("planDigest", parseDigestAt),
    interventionId: fields.req("interventionId", parseDurableId),
    effectId: fields.req("effectId", parseId),
    effectIndex: fields.req("effectIndex", parseEffectIndexAt),
    idempotencyKey: fields.req("idempotencyKey", parseDurableId),
    receipt: fields.req("receipt", parsePublicationReceiptAt),
  };
  const id = fields.req("id", parseDurableId);
  const receiptDigest = fields.req("receiptDigest", parseDigestAt);
  if (
    id !== receiptIdFor(content.idempotencyKey) ||
    content.idempotencyKey !== publicationEffectIdempotencyKey(content.planDigest, content.effectId) ||
    content.planId !== publicationPlanIdFor(content.planDigest) ||
    content.interventionId !== interventionIdFor(content.planDigest) ||
    content.receipt.idempotencyKey !== content.idempotencyKey ||
    content.receipt.effectId !== content.effectId
  ) {
    throw invalid("schema.corrupt", "stored publication receipt does not bind its plan, effect, and key", ["id"]);
  }
  if (receiptDigest !== sha256HexOfCanonicalJson(storedReceiptContent(content))) {
    throw invalid("schema.corrupt", "stored publication receipt digest does not match its content", ["receiptDigest"]);
  }
  return Object.freeze({ schemaVersion, id, ...content, receiptDigest });
}

export function buildStoredPublicationReceipt(input: {
  readonly plan: PublicationPlan;
  readonly effect: PreparedEffect;
  readonly effectIndex: number;
  readonly idempotencyKey: string;
  readonly receipt: PublicationReceipt;
}): StoredPublicationReceipt {
  const content: StoredReceiptContent = {
    planId: input.plan.id,
    planDigest: input.plan.planDigest,
    interventionId: interventionIdFor(input.plan.planDigest),
    effectId: input.effect.id,
    effectIndex: input.effectIndex,
    idempotencyKey: input.idempotencyKey,
    receipt: input.receipt,
  };
  return parseStoredPublicationReceipt({
    schemaVersion: 1,
    id: receiptIdFor(input.idempotencyKey),
    ...content,
    receiptDigest: sha256HexOfCanonicalJson(storedReceiptContent(content)),
  });
}

export async function loadStoredPublicationReceipt(
  context: EngineContext,
  receiptId: string,
): Promise<StoredPublicationReceipt | undefined> {
  const stored = await loadStoredRecord(context, "publication-receipt", receiptId);
  if (stored === undefined) return undefined;
  const receipt = parseStoredPublicationReceipt(stored.value);
  if (receipt.id !== receiptId) throw corrupt("stored publication receipt id does not match its record key");
  return receipt;
}

/** A stored receipt must bind the exact plan, effect position, key, and effect content. */
export function assertStoredReceiptBinds(
  stored: StoredPublicationReceipt,
  input: {
    readonly plan: PublicationPlan;
    readonly effect: PreparedEffect;
    readonly effectIndex: number;
    readonly idempotencyKey: string;
  },
): void {
  const mismatches = publicationReceiptMismatchReasons(stored.receipt, {
    destinationId: input.plan.destinationId,
    effect: input.effect,
    idempotencyKey: input.idempotencyKey,
  });
  if (
    stored.planDigest !== input.plan.planDigest ||
    stored.effectIndex !== input.effectIndex ||
    stored.idempotencyKey !== input.idempotencyKey ||
    mismatches.length > 0
  ) {
    throw corrupt(
      "a stored publication receipt does not bind the exact effect of its plan",
      mismatches.map((reason) => ({
        code: "publication.receipt_mismatch",
        severity: "error",
        message: reason.message,
        path: ["receipt", reason.field],
      })),
    );
  }
}

/**
 * Create-only receipt. A conflict means another attempt persisted a receipt
 * for the same key first (its `appliedAt` or `finalVersion` may differ); the
 * stored one is canonical provided it binds the same exact effect.
 */
export async function ensureStoredPublicationReceipt(
  context: EngineContext,
  receipt: StoredPublicationReceipt,
  plan: PublicationPlan,
  effect: PreparedEffect,
): Promise<StoredPublicationReceipt> {
  const status = await createOnly(
    context,
    "publication-receipt",
    receipt.id,
    receipt,
    `publication-receipt/${receipt.id}`,
  );
  if (status === "created") return receipt;
  const stored = await loadStoredPublicationReceipt(context, receipt.id);
  if (stored === undefined) throw corrupt("publication receipt conflicted but cannot be reloaded");
  assertStoredReceiptBinds(stored, {
    plan,
    effect,
    effectIndex: receipt.effectIndex,
    idempotencyKey: receipt.idempotencyKey,
  });
  return stored;
}

// ---------------------------------------------------------------------------
// Transition stream

interface TransitionStream {
  readonly transitions: readonly InterventionTransition[];
  readonly revision: string;
}

const parseStreamEntryAt: Parse<{ readonly id: string; readonly digest: string; readonly value: unknown }> = (
  input,
  path,
) => {
  const fields = readFields(input, path);
  return {
    id: fields.req("id", parseNonEmptyText),
    digest: fields.req("digest", parseNonEmptyText),
    value: fields.req("value", parseUnknown),
  };
};

function transitionEntries(stored: StoredRecord, interventionId: string): readonly InterventionTransition[] {
  const entries = parseBoundedArray(
    parseStreamEntryAt,
    MAX_TRANSITIONS_PER_INTERVENTION,
    "intervention transitions",
  )(stored.value, ["store", "intervention-transition"]);
  const transitions: InterventionTransition[] = [];
  let expectedFrom: InterventionState = INITIAL_INTERVENTION_STATE;
  for (const [index, entry] of entries.entries()) {
    let transition: InterventionTransition;
    try {
      transition = parseInterventionTransition(entry.value);
    } catch (error) {
      if (error instanceof LearningLoopError) {
        throw corrupt(`intervention transition ${index} is malformed`, error.diagnostics);
      }
      throw error;
    }
    if (
      entry.id !== transition.id ||
      entry.digest !== recordDigest(toJsonValue(transition)) ||
      transition.interventionId !== interventionId ||
      !sameInterventionState(transition.from, expectedFrom)
    ) {
      throw corrupt(`intervention transition ${index} does not continue its stream`);
    }
    transitions.push(transition);
    expectedFrom = transition.to;
  }
  return transitions;
}

async function loadTransitionStream(
  context: EngineContext,
  interventionId: string,
): Promise<TransitionStream | undefined> {
  const stored = await loadStoredRecord(context, "intervention-transition", interventionId);
  if (stored === undefined) return undefined;
  return { transitions: transitionEntries(stored, interventionId), revision: stored.revision };
}

function currentStateOf(stream: TransitionStream | undefined): InterventionState {
  const last = stream?.transitions[stream.transitions.length - 1];
  return last === undefined ? INITIAL_INTERVENTION_STATE : last.to;
}

/**
 * Reload-first append. `next` maps the CURRENT state to the target state, or
 * to `undefined` when the stream already reflects the intended fact (retry,
 * lost acknowledgement, or a concurrent contender that got there first).
 * Expected-revision appends serialize contenders; a conflict reloads.
 */
export async function appendInterventionTransition(
  context: EngineContext,
  interventionId: string,
  next: (current: InterventionState) => InterventionState | undefined,
  evidenceIds: readonly string[],
): Promise<InterventionTransition> {
  for (let attempt = 0; attempt < MAX_APPEND_ATTEMPTS; attempt += 1) {
    const stream = await loadTransitionStream(context, interventionId);
    const current = currentStateOf(stream);
    const target = next(current);
    const head = stream?.transitions[stream.transitions.length - 1];
    if (target === undefined) {
      if (head === undefined) throw corrupt("intervention transition stream is empty where a state was expected");
      return head;
    }
    if (interventionTransitionKind(current, target) === undefined) {
      throw corrupt("a requested intervention transition is outside the legal-transition table");
    }
    const content = {
      interventionId,
      from: current,
      to: target,
      evidenceIds: [...evidenceIds],
      occurredAt: context.clock.now(),
    };
    const transition = parseInterventionTransition({
      schemaVersion: 1,
      id: interventionTransitionIdFor(interventionTransitionDigest(content)),
      ...content,
    });
    const value = toJsonValue(transition);
    const raw: unknown = await context.store.append(
      recordKey("intervention-transition", interventionId),
      stream?.revision,
      [{ id: transition.id, digest: recordDigest(value), value }],
      `intervention-transition/${interventionId}/${transition.id}`,
    );
    const result = parseWriteResult(raw);
    if (result.status === "conflict") continue;
    const reloaded = await loadTransitionStream(context, interventionId);
    const reloadedHead = reloaded?.transitions[reloaded.transitions.length - 1];
    if (reloadedHead === undefined || !sameInterventionState(reloadedHead.to, target)) {
      throw corrupt("intervention transition was acknowledged but is not the stream head");
    }
    return reloadedHead;
  }
  throw new LearningLoopError("store.conflict", [
    {
      code: "store.conflict",
      severity: "error",
      message: `intervention "${interventionId}" transition stream changed ${MAX_APPEND_ATTEMPTS} times while appending`,
    },
  ]);
}

// ---------------------------------------------------------------------------
// Intervention evaluation index (decision 0028)

export interface InterventionEvaluationEntry {
  readonly evaluationId: string;
  readonly experimentId: string;
  readonly interventionId: string;
}

const parseEvaluationEntryAt: Parse<InterventionEvaluationEntry> = (input, path) => {
  const fields = readFields(input, path);
  return {
    evaluationId: fields.req("evaluationId", parseDurableId),
    experimentId: fields.req("experimentId", parseId),
    interventionId: fields.req("interventionId", parseDurableId),
  };
};

interface EvaluationIndex {
  readonly entries: readonly InterventionEvaluationEntry[];
  readonly revision: string;
}

async function loadEvaluationIndex(
  context: EngineContext,
  interventionId: string,
): Promise<EvaluationIndex | undefined> {
  const stored = await loadStoredRecord(context, EVALUATION_INDEX_KIND, interventionId);
  if (stored === undefined) return undefined;
  const raw = parseBoundedArray(
    parseStreamEntryAt,
    MAX_EVALUATIONS_PER_INTERVENTION,
    "intervention evaluation entries",
  )(stored.value, ["store", EVALUATION_INDEX_KIND]);
  const entries = raw.map((entry, index) => {
    const value = parseEvaluationEntryAt(entry.value, ["store", EVALUATION_INDEX_KIND, index]);
    if (
      entry.id !== value.evaluationId ||
      entry.digest !== recordDigest(toJsonValue(value)) ||
      value.interventionId !== interventionId
    ) {
      throw corrupt(`intervention evaluation index entry ${index} does not bind its evaluation`);
    }
    return value;
  });
  return { entries, revision: stored.revision };
}

/**
 * Reload-first append of an evaluation's index entry BEFORE the evaluation
 * record is created, so a crash leaves at most an orphan entry that readers
 * ignore. A present entry is "another attempt got here first".
 */
export async function ensureInterventionEvaluationIndexed(
  context: EngineContext,
  entry: InterventionEvaluationEntry,
): Promise<void> {
  for (let attempt = 0; attempt < MAX_APPEND_ATTEMPTS; attempt += 1) {
    const index = await loadEvaluationIndex(context, entry.interventionId);
    const present = index?.entries.find((candidate) => candidate.evaluationId === entry.evaluationId);
    if (present !== undefined) {
      if (present.experimentId !== entry.experimentId) {
        throw corrupt(`intervention evaluation index binds "${entry.evaluationId}" to another experiment`);
      }
      return;
    }
    if (index !== undefined && index.entries.length >= MAX_EVALUATIONS_PER_INTERVENTION) {
      throw new LearningLoopError("experiment.limit_exceeded", [
        {
          code: "experiment.limit_exceeded",
          severity: "error",
          message: `intervention "${entry.interventionId}" already holds ${MAX_EVALUATIONS_PER_INTERVENTION} evaluations`,
        },
      ]);
    }
    const value = toJsonValue(entry);
    const raw: unknown = await context.store.append(
      recordKey(EVALUATION_INDEX_KIND, entry.interventionId),
      index?.revision,
      [{ id: entry.evaluationId, digest: recordDigest(value), value }],
      `intervention-evaluation/${entry.interventionId}/${entry.evaluationId}`,
    );
    const result = parseWriteResult(raw);
    if (result.status === "conflict") continue;
    return;
  }
  throw new LearningLoopError("store.conflict", [
    {
      code: "store.conflict",
      severity: "error",
      message: `intervention "${entry.interventionId}" evaluation index changed ${MAX_APPEND_ATTEMPTS} times while appending`,
    },
  ]);
}

export interface BoundEvaluation {
  readonly id: string;
  readonly experimentId: string;
  readonly verdict: ExperimentVerdict;
}

/**
 * Evaluations bound to one intervention, in index order, each verified to
 * exist and to name this intervention and its index entry's experiment. The
 * stored bytes are digest-checked by the store layer; only the identity and
 * verdict fields are read here, so the fold stays cheap on the resolution
 * and publication paths. An orphan index entry whose evaluation does not
 * exist is a crash remnant and does not count; a malformed or mismatched
 * evaluation is store corruption.
 */
export async function loadInterventionEvaluations(
  context: EngineContext,
  interventionId: string,
): Promise<readonly BoundEvaluation[]> {
  const index = await loadEvaluationIndex(context, interventionId);
  if (index === undefined) return [];
  const stored = await Promise.all(
    index.entries.map((entry) => loadStoredRecord(context, "experiment-evaluation", entry.evaluationId)),
  );
  const evaluations: BoundEvaluation[] = [];
  for (const [position, entry] of index.entries.entries()) {
    const record = stored[position];
    if (record === undefined) continue;
    let bound: BoundEvaluation;
    try {
      const fields = readFields(record.value, ["store", "experiment-evaluation"]);
      bound = {
        id: fields.req("id", parseDurableId),
        experimentId: fields.req("experimentId", parseId),
        verdict: fields.req("verdict", parseOneOf(EXPERIMENT_VERDICTS)),
      };
      if (fields.req("interventionId", parseDurableId) !== interventionId) {
        throw corrupt(`evaluation "${entry.evaluationId}" does not name intervention "${interventionId}"`);
      }
    } catch (error) {
      if (error instanceof LearningLoopError) {
        throw corrupt(`evaluation "${entry.evaluationId}" is malformed`, error.diagnostics);
      }
      throw error;
    }
    if (bound.id !== entry.evaluationId || bound.experimentId !== entry.experimentId) {
      throw corrupt(`evaluation "${entry.evaluationId}" does not match its intervention index entry`);
    }
    evaluations.push(bound);
  }
  return evaluations;
}

// ---------------------------------------------------------------------------
// Fold

export interface InterventionFold {
  readonly header: InterventionHeader;
  readonly transitions: readonly InterventionTransition[];
  readonly state: InterventionState;
  /** Absent until the first transition is durable: an unborn header is an orphan remnant. */
  readonly record: InterventionRecord | undefined;
}

function foldRecord(
  header: InterventionHeader,
  transitions: readonly InterventionTransition[],
  evaluations: readonly BoundEvaluation[],
): InterventionRecord {
  const last = transitions[transitions.length - 1];
  if (last === undefined) throw corrupt("cannot fold an intervention without transitions");
  const receiptIds = new Set<string>();
  const authorizationIds = new Set<string>();
  const verdictByEvaluation = new Map(evaluations.map((evaluation) => [evaluation.id, evaluation.verdict]));
  for (const transition of transitions) {
    const kind = interventionTransitionKind(transition.from, transition.to);
    if (kind === "authorize") {
      for (const id of transition.evidenceIds) authorizationIds.add(id);
    } else if (kind === "publish" || kind === "fail") {
      for (const id of transition.evidenceIds) receiptIds.add(id);
    } else if (kind === "validate") {
      // A validate edge cites the evaluation that moved the state; the
      // evaluation index is the complete list (same-verdict evaluations append
      // no edge), so every cited evaluation must be indexed, durable, and say
      // exactly the verdict the edge lands on — an id never freezes a verdict.
      for (const id of transition.evidenceIds) {
        const verdict = verdictByEvaluation.get(id);
        if (verdict === undefined) {
          throw corrupt(`intervention "${header.id}" validate transition cites an evaluation that is not bound`);
        }
        if (verdict !== transition.to.validation) {
          throw corrupt(
            `intervention "${header.id}" validate transition lands on "${transition.to.validation}" but its evaluation says "${verdict}"`,
          );
        }
      }
    }
  }
  return parseInterventionRecord({
    schemaVersion: 1,
    id: header.id,
    candidateId: header.candidateId,
    planId: header.planId,
    ...(header.parentInterventionId === null ? {} : { parentInterventionId: header.parentInterventionId }),
    state: last.to,
    publicationReceiptIds: [...receiptIds],
    authorizationIds: [...authorizationIds],
    evaluationIds: evaluations.map((evaluation) => evaluation.id),
    latestTransitionId: last.id,
  });
}

export async function loadInterventionFold(
  context: EngineContext,
  interventionId: string,
): Promise<InterventionFold | undefined> {
  const header = await loadInterventionHeader(context, interventionId);
  if (header === undefined) return undefined;
  const stream = await loadTransitionStream(context, interventionId);
  const transitions = stream?.transitions ?? [];
  const evaluations = transitions.length === 0 ? [] : await loadInterventionEvaluations(context, interventionId);
  return {
    header,
    transitions,
    state: currentStateOf(stream),
    record: transitions.length === 0 ? undefined : foldRecord(header, transitions, evaluations),
  };
}

/** Loads and verifies every receipt a folded record cites, in citation order. */
export async function loadFoldReceipts(
  context: EngineContext,
  record: InterventionRecord,
  plan: PublicationPlan,
): Promise<readonly StoredPublicationReceipt[]> {
  const effectsById = new Map(plan.effects.map((effect, index) => [effect.id, { effect, index }]));
  const receipts: StoredPublicationReceipt[] = [];
  for (const receiptId of record.publicationReceiptIds) {
    const stored = await loadStoredPublicationReceipt(context, receiptId);
    if (stored === undefined) throw corrupt(`intervention "${record.id}" cites a missing receipt "${receiptId}"`);
    const effect = effectsById.get(stored.effectId);
    if (stored.interventionId !== record.id || effect === undefined) {
      throw corrupt(`receipt "${receiptId}" does not belong to intervention "${record.id}"`);
    }
    assertStoredReceiptBinds(stored, {
      plan,
      effect: effect.effect,
      effectIndex: effect.index,
      idempotencyKey: publicationEffectIdempotencyKey(plan.planDigest, effect.effect.id),
    });
    receipts.push(stored);
  }
  return receipts;
}
