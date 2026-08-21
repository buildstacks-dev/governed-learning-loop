// Intervention state, record, and transition (contract §Intervention,
// exposure, and efficacy; decision 0026). Publication, authorization,
// activation, and validation are four independent dimensions, never one
// lifecycle enum: authorized ≠ validated, permanently (kernel invariant 3).
// State history is append-only — the engine folds InterventionTransition
// records into the current InterventionRecord view — and the legal-transition
// table below is part of the protocol. It forbids active-plus-unpublished,
// any validation claim without a bound evaluation, and publication from any
// authorization state other than authorized or not_required. No transition
// in this slice changes validation, revokes, or expires: evaluation-bound
// transitions belong to the Validate tier, and later revocation is an
// explicit host policy and a preauthorized effect, never an implied edge.
import { sha256HexOfCanonicalJson } from "../canonical/canonical-json.js";
import type { JsonValue } from "../canonical/json.js";
import type { Diagnostic } from "../diagnostics.js";
import { LearningLoopError } from "../diagnostics.js";
import { invalid, parseOneOf, readFields } from "../parse/toolkit.js";
import type { Parse, ParsePath } from "../parse/toolkit.js";
import { parseBoundedArray, parseCanonicalTimestampAt, parseDurableId } from "./semantic-shared.js";

export interface InterventionState {
  readonly publication: "unpublished" | "published" | "failed" | "rolled_back";
  readonly authorization: "not_required" | "pending" | "authorized" | "revoked" | "expired";
  readonly activation: "inactive" | "active" | "disabled";
  readonly validation: "untested" | "invalid" | "inconclusive" | "improved" | "regressed";
}

export interface InterventionRecord {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly candidateId: string;
  readonly planId: string;
  readonly parentInterventionId?: string;
  readonly state: InterventionState;
  readonly publicationReceiptIds: readonly string[];
  readonly authorizationIds: readonly string[];
  readonly evaluationIds: readonly string[];
  readonly latestTransitionId: string;
}

export interface InterventionTransition {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly interventionId: string;
  readonly from: InterventionState;
  readonly to: InterventionState;
  readonly evidenceIds: readonly string[];
  readonly occurredAt: string;
}

/**
 * The kind of a legal transition, derived from its exact from/to pair.
 * `disable` covers both the disable and compensate plan actions: their
 * kernel-state effect is identical (activation becomes `disabled`); the
 * child plan's `action` records which one ran.
 */
export type InterventionTransitionKind = "authorize" | "publish" | "fail" | "disable" | "rollback";

const PUBLICATION_STATES = ["unpublished", "published", "failed", "rolled_back"] as const;
const AUTHORIZATION_STATES = ["not_required", "pending", "authorized", "revoked", "expired"] as const;
const ACTIVATION_STATES = ["inactive", "active", "disabled"] as const;
const VALIDATION_STATES = ["untested", "invalid", "inconclusive", "improved", "regressed"] as const;
const TRANSITION_DIGEST_DOMAIN = "intervention-transition:v1";
const TRANSITION_ID_PREFIX = "transition-";
/** Evidence and lineage ids per record are bounded well above the 100-effect plan ceiling. */
export const MAX_INTERVENTION_REFERENCES = 1_000;

/** Every intervention starts here; the first durable transition leaves it. */
export const INITIAL_INTERVENTION_STATE: InterventionState = Object.freeze({
  publication: "unpublished",
  authorization: "pending",
  activation: "inactive",
  validation: "untested",
});

function diagnostic(code: string, message: string, path: ParsePath): Diagnostic {
  return { code, severity: "error", message, path };
}

/**
 * Structural invariants one state must satisfy on its own: an active
 * intervention is published; a pending one is unpublished and inactive; a
 * rolled-back one is disabled; nothing published, failed, or rolled back
 * is still pending.
 */
export function interventionStateInvalidReasons(state: InterventionState, path: ParsePath = []): readonly Diagnostic[] {
  const reasons: Diagnostic[] = [];
  if (state.activation === "active" && state.publication !== "published") {
    reasons.push(diagnostic("schema.invalid", "an active intervention must be published", [...path, "activation"]));
  }
  if (state.authorization === "pending" && (state.publication !== "unpublished" || state.activation !== "inactive")) {
    reasons.push(
      diagnostic("schema.invalid", "a pending authorization permits neither publication nor activation", [
        ...path,
        "authorization",
      ]),
    );
  }
  if (state.publication === "rolled_back" && state.activation !== "disabled") {
    reasons.push(diagnostic("schema.invalid", "a rolled-back intervention must be disabled", [...path, "activation"]));
  }
  return reasons;
}

function permitsPublication(authorization: InterventionState["authorization"]): boolean {
  return authorization === "authorized" || authorization === "not_required";
}

function appliedPublication(publication: InterventionState["publication"]): boolean {
  return publication === "published" || publication === "failed";
}

/**
 * The legal-transition table. Returns the transition kind for a legal pair
 * and `undefined` for every other pair. Validation never changes here (no
 * evaluation record exists before the Validate tier), and no edge mints
 * `revoked` or `expired`.
 */
export function interventionTransitionKind(
  from: InterventionState,
  to: InterventionState,
): InterventionTransitionKind | undefined {
  if (interventionStateInvalidReasons(from).length > 0 || interventionStateInvalidReasons(to).length > 0) {
    return undefined;
  }
  if (from.validation !== to.validation) return undefined;
  if (from.authorization === "pending") {
    return to.authorization === "authorized" &&
      from.publication === "unpublished" &&
      to.publication === "unpublished" &&
      from.activation === "inactive" &&
      to.activation === "inactive"
      ? "authorize"
      : undefined;
  }
  if (from.authorization !== to.authorization || !permitsPublication(from.authorization)) return undefined;
  if (
    (from.publication === "unpublished" || from.publication === "failed") &&
    from.activation === "inactive" &&
    to.publication === "published" &&
    (to.activation === "active" || to.activation === "inactive")
  ) {
    return "publish";
  }
  if (
    from.publication === "unpublished" &&
    from.activation === "inactive" &&
    to.publication === "failed" &&
    to.activation === "inactive"
  ) {
    return "fail";
  }
  if (
    appliedPublication(from.publication) &&
    from.publication === to.publication &&
    (from.activation === "active" || from.activation === "inactive") &&
    to.activation === "disabled"
  ) {
    return "disable";
  }
  if (appliedPublication(from.publication) && to.publication === "rolled_back" && to.activation === "disabled") {
    return "rollback";
  }
  return undefined;
}

export const parseInterventionStateAt: Parse<InterventionState> = (input, path) => {
  const fields = readFields(input, path);
  const state: InterventionState = {
    publication: fields.req("publication", parseOneOf(PUBLICATION_STATES)),
    authorization: fields.req("authorization", parseOneOf(AUTHORIZATION_STATES)),
    activation: fields.req("activation", parseOneOf(ACTIVATION_STATES)),
    validation: fields.req("validation", parseOneOf(VALIDATION_STATES)),
  };
  const reasons = interventionStateInvalidReasons(state, path);
  const first = reasons[0];
  if (first !== undefined) throw new LearningLoopError(first.code, reasons);
  return state;
};

function assertUniqueIds(values: readonly string[], path: ParsePath): void {
  const seen = new Set<string>();
  for (const [index, value] of values.entries()) {
    if (seen.has(value)) throw invalid("schema.invalid", "identifiers must be unique", [...path, index]);
    seen.add(value);
  }
}

const parseReferenceIdsAt: Parse<readonly string[]> = (input, path) => {
  const ids = parseBoundedArray(parseDurableId, MAX_INTERVENTION_REFERENCES, "identifiers")(input, path);
  assertUniqueIds(ids, path);
  return ids;
};

function stateContent(state: InterventionState): JsonValue {
  return {
    publication: state.publication,
    authorization: state.authorization,
    activation: state.activation,
    validation: state.validation,
  };
}

/** Transition content digest: interventionId, from, to, ordered evidence ids, and occurredAt. */
export function interventionTransitionDigest(input: Omit<InterventionTransition, "schemaVersion" | "id">): string {
  return sha256HexOfCanonicalJson({
    domain: TRANSITION_DIGEST_DOMAIN,
    interventionId: input.interventionId,
    from: stateContent(input.from),
    to: stateContent(input.to),
    evidenceIds: [...input.evidenceIds],
    occurredAt: input.occurredAt,
  });
}

/** Content-addressed transition id: the transition is its digest. */
export function interventionTransitionIdFor(transitionDigest: string): string {
  return `${TRANSITION_ID_PREFIX}${transitionDigest}`;
}

/**
 * Unknown-first parser. Refuses a pair outside the legal-transition table,
 * evidence-free authorize/publish/disable/rollback edges, and an id that
 * does not equal the recomputed content digest.
 */
export function parseInterventionTransition(input: unknown): InterventionTransition {
  const fields = readFields(input, []);
  const schemaVersion = fields.schemaVersion1();
  const content = {
    interventionId: fields.req("interventionId", parseDurableId),
    from: fields.req("from", parseInterventionStateAt),
    to: fields.req("to", parseInterventionStateAt),
    evidenceIds: fields.req("evidenceIds", parseReferenceIdsAt),
    occurredAt: fields.req("occurredAt", parseCanonicalTimestampAt),
  };
  const kind = interventionTransitionKind(content.from, content.to);
  if (kind === undefined) {
    throw invalid("schema.invalid", "intervention transition is not in the legal-transition table", ["to"]);
  }
  if (kind !== "fail" && content.evidenceIds.length === 0) {
    throw invalid("schema.invalid", `a ${kind} transition requires bound evidence`, ["evidenceIds"]);
  }
  const id = fields.req("id", parseDurableId);
  const recomputed = interventionTransitionIdFor(interventionTransitionDigest(content));
  if (id !== recomputed) {
    throw invalid("schema.corrupt", "intervention transition id does not match its content digest", ["id"]);
  }
  return { schemaVersion, id, ...content };
}

/**
 * Unknown-first parser for the folded view. Structural rules: a published
 * intervention cites at least one publication receipt, an authorized one
 * cites at least one authorization, and any validation other than
 * `untested` cites at least one evaluation (never implied by authorization).
 */
export function parseInterventionRecord(input: unknown): InterventionRecord {
  const fields = readFields(input, []);
  const schemaVersion = fields.schemaVersion1();
  const id = fields.req("id", parseDurableId);
  const candidateId = fields.req("candidateId", parseDurableId);
  const planId = fields.req("planId", parseDurableId);
  const parentInterventionId = fields.opt("parentInterventionId", parseDurableId);
  const state = fields.req("state", parseInterventionStateAt);
  const publicationReceiptIds = fields.req("publicationReceiptIds", parseReferenceIdsAt);
  const authorizationIds = fields.req("authorizationIds", parseReferenceIdsAt);
  const evaluationIds = fields.req("evaluationIds", parseReferenceIdsAt);
  const latestTransitionId = fields.req("latestTransitionId", parseDurableId);
  if (parentInterventionId === id) {
    throw invalid("schema.invalid", "an intervention cannot be its own parent", ["parentInterventionId"]);
  }
  if (state.publication === "published" && publicationReceiptIds.length === 0) {
    throw invalid("schema.invalid", "a published intervention must cite its publication receipts", [
      "publicationReceiptIds",
    ]);
  }
  if (state.authorization === "authorized" && authorizationIds.length === 0) {
    throw invalid("schema.invalid", "an authorized intervention must cite its authorization", ["authorizationIds"]);
  }
  if (state.validation !== "untested" && evaluationIds.length === 0) {
    throw invalid("schema.invalid", "a validation claim requires at least one bound evaluation", ["evaluationIds"]);
  }
  return {
    schemaVersion,
    id,
    candidateId,
    planId,
    ...(parentInterventionId !== undefined ? { parentInterventionId } : {}),
    state,
    publicationReceiptIds,
    authorizationIds,
    evaluationIds,
    latestTransitionId,
  };
}

export function sameInterventionState(left: InterventionState, right: InterventionState): boolean {
  return (
    left.publication === right.publication &&
    left.authorization === right.authorization &&
    left.activation === right.activation &&
    left.validation === right.validation
  );
}
