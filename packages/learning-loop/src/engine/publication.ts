// learning.preparePublication, learning.publish, and learning.getIntervention
// (contract §Publication plan and authorization binding, §Authority,
// §Publication destination, §Intervention; decisions 0025 and 0026).
//
// Preparation is side-effect-free against the destination (`prepare` only,
// and only for publish plans) and persists exactly one create-only,
// content-addressed plan record. A disable, rollback, or compensate plan is
// prepared from the exact published parent intervention's journaled receipts
// and declared after-effects — never from a second adapter call — and binds
// that parent into its lineage closure. Publish keeps every refusal check of
// decision 0025 verbatim, then continues into the journaled publisher: it
// consumes the verified authorization into a durable record, journals the
// intervention header, scope membership, and authorize edge, applies every
// effect through `applyEffect` under a kernel idempotency key with the
// receipt journaled before the next effect, appends the parent's reversal
// edge for derived plans, and writes the publish edge last. A retry reloads
// the journal and forward-completes the same plan or no-ops; it never
// re-consults authority for a consumed plan and never re-applies an effect
// whose receipt is durable. An adapter failure is journaled as `failed` and
// the same plan remains resumable.
import { canonicalJsonText, sha256HexOfCanonicalJson } from "../canonical/canonical-json.js";
import { toJsonValue } from "../canonical/to-json-value.js";
import type { Diagnostic } from "../diagnostics.js";
import { LearningLoopError } from "../diagnostics.js";
import { invalid, parseNonEmptyText, parseOneOf, readFields } from "../parse/toolkit.js";
import type { Candidate, CandidateV2 } from "../records/candidate.js";
import { candidateScopeDigest, parseCandidate } from "../records/candidate.js";
import type { InterventionRecord, InterventionState } from "../records/intervention.js";
import type {
  AuthorizationBinding,
  PreparedEffect,
  PublicationLineage,
  PublicationPlan,
  PublicationReceipt,
} from "../records/publication.js";
import {
  authorizationBindingDigest,
  authorizationBindingForPlan,
  PUBLICATION_ACTIONS,
  parseEffectsAt,
  parsePreparedEffect,
  parsePublicationPlan,
  parsePublicationReceiptAt,
  publicationEffectIdempotencyKey,
  publicationPlanDigest,
  publicationPlanIdFor,
  publicationReceiptMismatchReasons,
} from "../records/publication.js";
import { parseDurableId, parseId, scopeDigest } from "../records/semantic-shared.js";
import { assertVerifiedAuthorization } from "./authority.js";
import type { EngineContext } from "./context.js";
import {
  createOnly,
  effectiveRisk,
  errorDiagnostics,
  iterateRecordPages,
  loadCandidate,
  loadStoredRecord,
} from "./context.js";
import type { BoundDestination } from "./destination-registration.js";
import { targetPermitted } from "./destination-registration.js";
import type { GovernanceView } from "./governance.js";
import { parseContentPolicyResult } from "./ingest.js";
import type { AuthorizationConsumption, InterventionFold, StoredPublicationReceipt } from "./publication-journal.js";
import {
  appendInterventionTransition,
  buildAuthorizationConsumption,
  buildInterventionHeader,
  buildInterventionScopeMembership,
  buildStoredPublicationReceipt,
  ensureAuthorizationConsumption,
  ensureInterventionHeader,
  ensureInterventionScopeMembership,
  ensureStoredPublicationReceipt,
  assertStoredReceiptBinds,
  interventionIdFor,
  listInterventionScopeMemberships,
  loadAuthorizationConsumption,
  loadFoldReceipts,
  loadInterventionFold,
  loadStoredPublicationReceipt,
  receiptIdFor,
} from "./publication-journal.js";
import type { CandidateGovernanceState } from "./views.js";
import { candidateGovernanceStateOf } from "./views.js";

export interface PreparePublicationInput {
  readonly candidateId: string;
  readonly destinationId: string;
  readonly expectedBase?: string;
  readonly action?: PublicationPlan["action"];
  /** Names the exact published intervention a disable/rollback/compensate plan reverses when more than one qualifies. */
  readonly interventionId?: string;
}

export interface PreparedPublication {
  readonly plan: PublicationPlan;
  readonly authorizationBinding: AuthorizationBinding;
  readonly governance: GovernanceView;
}

export interface PublishInput {
  readonly planId: string;
  readonly authorizationEvidence?: unknown;
}

/**
 * `published`: this call created and completed the journal. `resumed`: a
 * journal already existed and this call completed it. `no_op`: the journal
 * was already complete and this call wrote nothing and called no adapter.
 * `pending`/`denied` report the authority decision; `blocked` reports policy,
 * governance, binding drift, parent state, or supersession; `failed` reports
 * an adapter failure or receipt mismatch — the same plan remains resumable.
 */
export type PublicationOutcome =
  | {
      readonly status: "published" | "resumed" | "no_op";
      readonly intervention: InterventionRecord;
      readonly receipts: readonly PublicationReceipt[];
    }
  | {
      readonly status: "pending" | "denied" | "blocked" | "failed";
      readonly diagnostics: readonly Diagnostic[];
    };

const PLAN_KIND = "publication-plan";
const MAX_ADAPTER_ERROR_TEXT = 1_000;
const REVERSAL_ACTIONS = ["disable", "rollback", "compensate"] as const;
type ReversalAction = (typeof REVERSAL_ACTIONS)[number];

function refusal(code: string, message: string, extra: readonly Diagnostic[] = []): LearningLoopError {
  return new LearningLoopError(code, [{ code, severity: "error", message }, ...extra]);
}

function diagnostic(code: string, message: string): Diagnostic {
  return { code, severity: "error", message };
}

function outcome(
  status: "pending" | "denied" | "blocked" | "failed",
  diagnostics: readonly Diagnostic[],
): PublicationOutcome {
  return Object.freeze({ status, diagnostics: Object.freeze([...diagnostics]) });
}

function completion(
  status: "published" | "resumed" | "no_op",
  intervention: InterventionRecord,
  receipts: readonly StoredPublicationReceipt[],
): PublicationOutcome {
  return Object.freeze({
    status,
    intervention: Object.freeze(intervention),
    receipts: Object.freeze(receipts.map((stored) => Object.freeze({ ...stored.receipt }))),
  });
}

function isReversalAction(action: PublicationPlan["action"]): action is ReversalAction {
  return action !== "publish";
}

/** Evidence, derivation, and admission lineage must all be intact before a plan binds them. */
function candidateInvalidDiagnostics(state: CandidateGovernanceState): readonly Diagnostic[] {
  const reasons: Diagnostic[] = [];
  if (state.evidenceHealth.status !== "ready") {
    reasons.push(
      diagnostic("publication.candidate_invalid", `candidate evidence health is "${state.evidenceHealth.status}"`),
      ...state.evidenceHealth.diagnostics,
    );
  }
  if (state.derivationLineage.status === "invalid") {
    reasons.push(
      diagnostic("publication.candidate_invalid", "candidate derivation lineage is invalid"),
      ...state.derivationLineage.diagnostics,
    );
  }
  if (state.admissionLineage.status === "invalid") {
    reasons.push(
      diagnostic("publication.candidate_invalid", "candidate admission lineage is invalid"),
      ...state.admissionLineage.diagnostics,
    );
  }
  return reasons;
}

function lineageFor(
  context: EngineContext,
  candidate: CandidateV2,
  destination: BoundDestination,
  state: CandidateGovernanceState,
): PublicationLineage {
  let derivation: PublicationLineage["derivation"] = null;
  if (candidate.derivationRef !== undefined) {
    if (state.derivationLineage.status !== "resolved") {
      throw refusal("publication.candidate_invalid", "derivation-backed candidate lineage did not resolve");
    }
    const record = state.derivationLineage.derivation.derivation;
    if (record.id !== candidate.derivationRef.id || record.derivationDigest !== candidate.derivationRef.digest) {
      throw invalid("store.corrupt", "resolved derivation does not match the candidate derivation reference", [
        "derivationRef",
      ]);
    }
    derivation = {
      id: record.id,
      digest: record.derivationDigest,
      detector: {
        id: record.detector.id,
        version: record.detector.version,
        registrationDigest: record.detector.registrationDigest,
      },
      lens: { id: record.lens.id, version: record.lens.version, registrationDigest: record.lens.registrationDigest },
      pack:
        record.pack === null
          ? null
          : { id: record.pack.id, version: record.pack.version, manifestDigest: record.pack.manifestDigest },
    };
  }
  return {
    scopeDigest: scopeDigest(candidate.scope),
    scopePolicyDigest: context.scopePolicy.digest,
    registryRevision: context.registryRevision,
    destinationRegistrationDigest: destination.registrationDigest,
    derivation,
  };
}

function assertAfterEffectPermitted(destination: BoundDestination, effect: PreparedEffect, index: number): void {
  const kind = effect.afterEffect.kind;
  if (destination.effectClass === "context" && (kind === "compensate" || kind === "irreversible")) {
    throw refusal(
      "publication.after_effect_invalid",
      `context destination "${destination.id}" must provide disable or rollback for effect ${index} ("${effect.id}"), not ${kind}`,
    );
  }
}

async function admitEffectContent(
  context: EngineContext,
  destination: BoundDestination,
  effects: readonly PreparedEffect[],
): Promise<void> {
  const policy = context.contentPoliciesById.get(destination.contentPolicyId);
  if (policy === undefined) {
    throw invalid("config.invalid", `destination "${destination.id}" names an unconfigured content policy`, [
      "destinations",
    ]);
  }
  for (const [index, effect] of effects.entries()) {
    let rawTransformed: unknown;
    try {
      rawTransformed = await policy.transform(effect.payload);
    } catch (error) {
      throw refusal(
        "publication.content_policy_refused",
        `content policy "${policy.id}" refused effect ${index} ("${effect.id}")`,
        errorDiagnostics(error),
      );
    }
    const transformed = parseContentPolicyResult(rawTransformed);
    const errors = transformed.diagnostics.filter((entry) => entry.severity === "error");
    if (errors.length > 0) {
      throw refusal(
        "publication.content_policy_refused",
        `content policy "${policy.id}" refused effect ${index} ("${effect.id}")`,
        errors,
      );
    }
    if (canonicalJsonText(transformed.accepted) !== canonicalJsonText(effect.payload)) {
      throw refusal(
        "publication.content_policy_refused",
        `content policy "${policy.id}" altered effect ${index} ("${effect.id}"); destinations must prepare already-admissible payloads`,
      );
    }
  }
}

function assertTargetsPermitted(destination: BoundDestination, effects: readonly PreparedEffect[]): void {
  for (const [index, effect] of effects.entries()) {
    if (!targetPermitted(effect.target, destination.permittedTargetPatterns)) {
      throw refusal(
        "publication.target_not_permitted",
        `destination "${destination.id}" registration does not permit the target of effect ${index} ("${effect.id}")`,
      );
    }
  }
}

async function prepareEffects(
  context: EngineContext,
  destination: BoundDestination,
  candidate: Candidate,
  expectedBase: string | undefined,
): Promise<readonly PreparedEffect[]> {
  const raw: unknown = await destination.prepare({
    candidate,
    ...(expectedBase !== undefined ? { expectedBase } : {}),
  });
  let effects: readonly PreparedEffect[];
  try {
    effects = parseEffectsAt(raw, ["destination", "prepare"]);
  } catch (error) {
    throw refusal(
      "publication.effect_invalid",
      `destination "${destination.id}" prepared effects that do not parse`,
      errorDiagnostics(error),
    );
  }
  assertTargetsPermitted(destination, effects);
  for (const [index, effect] of effects.entries()) {
    if (expectedBase !== undefined && effect.expectedBase !== undefined && effect.expectedBase !== expectedBase) {
      throw refusal(
        "publication.base_mismatch",
        `effect ${index} ("${effect.id}") expects base "${effect.expectedBase}" but the plan was requested against "${expectedBase}"`,
      );
    }
    assertAfterEffectPermitted(destination, effect, index);
  }
  await admitEffectContent(context, destination, effects);
  return effects;
}

async function persistPlan(context: EngineContext, plan: PublicationPlan): Promise<PublicationPlan> {
  const status = await createOnly(context, PLAN_KIND, plan.id, plan, `publication-plan/${plan.id}`);
  if (status === "created" || status === "exists_same") return plan;
  // A content-addressed id can only conflict on the unbound createdAt field;
  // the first persisted plan is the canonical one.
  const stored = await loadStoredRecord(context, PLAN_KIND, plan.id);
  if (stored === undefined) {
    throw invalid("store.corrupt", "publication plan conflicted but cannot be reloaded", ["publicationPlan"]);
  }
  const existing = parsePublicationPlan(stored.value);
  if (existing.id !== plan.id || existing.planDigest !== plan.planDigest) {
    throw invalid("store.corrupt", "stored publication plan does not match its content-addressed id", [
      "publicationPlan",
    ]);
  }
  return existing;
}

async function loadPlan(context: EngineContext, planId: string): Promise<PublicationPlan | undefined> {
  const stored = await loadStoredRecord(context, PLAN_KIND, planId);
  if (stored === undefined) return undefined;
  const plan = parsePublicationPlan(stored.value);
  if (plan.id !== planId)
    throw invalid("store.corrupt", "stored publication plan id does not match its record key", ["id"]);
  return plan;
}

async function governanceStateOf(context: EngineContext, candidate: Candidate): Promise<CandidateGovernanceState> {
  const riskRule = context.policyRules.risks[effectiveRisk(context, candidate)];
  return candidateGovernanceStateOf(context, candidate, riskRule.independentReview);
}

// ---------------------------------------------------------------------------
// Reversal plans: disable, rollback, compensate

/**
 * The parent state a completed reversal produces from `current`:
 * `transition` with the target, `already` when the parent already reflects
 * at least that much deactivation, or `illegal` when the action is not in
 * the legal-transition table from `current`.
 */
export function reversalTarget(
  action: ReversalAction,
  current: InterventionState,
): { readonly kind: "transition"; readonly to: InterventionState } | { readonly kind: "already" | "illegal" } {
  const applied = current.publication === "published" || current.publication === "failed";
  if (current.publication === "rolled_back") return { kind: "already" };
  if (!applied) return { kind: "illegal" };
  if (action === "rollback") {
    return { kind: "transition", to: { ...current, publication: "rolled_back", activation: "disabled" } };
  }
  if (current.activation === "disabled") return { kind: "already" };
  return { kind: "transition", to: { ...current, activation: "disabled" } };
}

interface ParentIntervention {
  readonly fold: InterventionFold;
  readonly record: InterventionRecord;
  readonly plan: PublicationPlan;
}

async function loadParent(context: EngineContext, interventionId: string): Promise<ParentIntervention | undefined> {
  const fold = await loadInterventionFold(context, interventionId);
  if (fold === undefined || fold.record === undefined) return undefined;
  const plan = await loadPlan(context, fold.header.planId);
  if (plan === undefined || plan.planDigest !== fold.header.planDigest) {
    throw invalid("store.corrupt", `intervention "${interventionId}" names a missing or mismatched plan`, ["planId"]);
  }
  return { fold, record: fold.record, plan };
}

function parentMismatch(parent: ParentIntervention, candidate: Candidate, destinationId: string): string | undefined {
  if (parent.fold.header.action !== "publish") return "names an intervention that is itself a reversal";
  if (parent.fold.header.candidateId !== candidate.id) return "belongs to another candidate";
  if (parent.fold.header.candidateDigest !== candidate.contentDigest) return "binds another candidate digest";
  if (parent.fold.header.destinationId !== destinationId) return "belongs to another destination";
  return undefined;
}

async function resolveParentIntervention(
  context: EngineContext,
  candidate: Candidate,
  destinationId: string,
  action: ReversalAction,
  interventionId: string | undefined,
): Promise<ParentIntervention> {
  if (interventionId !== undefined) {
    const parent = await loadParent(context, interventionId);
    if (parent === undefined) {
      throw refusal("publication.intervention_not_found", `intervention "${interventionId}" does not exist`);
    }
    const mismatch = parentMismatch(parent, candidate, destinationId);
    if (mismatch !== undefined) {
      throw refusal("publication.intervention_mismatch", `intervention "${interventionId}" ${mismatch}`);
    }
    if (reversalTarget(action, parent.record.state).kind !== "transition") {
      throw refusal(
        "publication.parent_state_invalid",
        `intervention "${interventionId}" state does not permit ${action}: publication "${parent.record.state.publication}", activation "${parent.record.state.activation}"`,
      );
    }
    return parent;
  }
  const memberships = await listInterventionScopeMemberships(context, candidateScopeDigest(candidate.scope));
  const qualifying: ParentIntervention[] = [];
  for (const membership of memberships) {
    if (
      membership.action !== "publish" ||
      membership.candidateId !== candidate.id ||
      membership.destinationId !== destinationId
    ) {
      continue;
    }
    const parent = await loadParent(context, membership.interventionId);
    if (parent === undefined) continue; // unborn header: an orphan remnant, not an intervention
    if (parentMismatch(parent, candidate, destinationId) !== undefined) continue;
    if (reversalTarget(action, parent.record.state).kind === "transition") qualifying.push(parent);
  }
  const [first, second] = qualifying;
  if (first === undefined) {
    throw refusal(
      "publication.intervention_not_found",
      `candidate "${candidate.id}" has no published intervention at destination "${destinationId}" that permits ${action}`,
    );
  }
  if (second !== undefined) {
    throw refusal(
      "publication.intervention_ambiguous",
      `candidate "${candidate.id}" has ${qualifying.length} interventions at destination "${destinationId}" that permit ${action}; name one with interventionId`,
    );
  }
  return first;
}

/**
 * Reversal effects come from the parent plan's declared after-effects, one
 * per journaled receipt whose after-effect kind equals the action. Each keeps
 * the parent effect id and target, carries the adapter's declared payload,
 * and binds the receipt's final version as its base; its own after-effect is
 * irreversible because the kernel's only reversal of a reversal is a new
 * publish plan.
 */
async function deriveReversalEffects(
  context: EngineContext,
  destination: BoundDestination,
  parent: ParentIntervention,
  action: ReversalAction,
): Promise<readonly PreparedEffect[]> {
  const receipts = await loadFoldReceipts(context, parent.record, parent.plan);
  const receiptsByEffect = new Map(receipts.map((stored) => [stored.effectId, stored.receipt]));
  const effects: PreparedEffect[] = [];
  for (const effect of parent.plan.effects) {
    const receipt = receiptsByEffect.get(effect.id);
    if (receipt === undefined || effect.afterEffect.kind !== action) continue;
    const payload = effect.afterEffect.payload;
    effects.push(
      parsePreparedEffect(
        toJsonValue({
          id: effect.id,
          kind: action,
          target: effect.target,
          ...(receipt.finalVersion !== undefined ? { expectedBase: receipt.finalVersion } : {}),
          payload,
          payloadDigest: sha256HexOfCanonicalJson(payload),
          afterEffect: {
            kind: "irreversible",
            rationale: `${action} of effect "${effect.id}" of plan "${parent.plan.id}"; reversing it requires a new publish plan`,
          },
        }),
      ),
    );
  }
  if (effects.length === 0) {
    throw refusal(
      "publication.after_effect_unavailable",
      `intervention "${parent.record.id}" has no applied effect that declares a ${action} after-effect`,
    );
  }
  assertTargetsPermitted(destination, effects);
  await admitEffectContent(context, destination, effects);
  return effects;
}

// ---------------------------------------------------------------------------
// preparePublication

export async function runPreparePublication(
  context: EngineContext,
  input: PreparePublicationInput,
): Promise<PreparedPublication> {
  const fields = readFields(input, ["preparePublication"]);
  const candidateId = fields.req("candidateId", parseDurableId);
  const destinationId = fields.req("destinationId", parseId);
  const expectedBase = fields.opt("expectedBase", parseId);
  const action = fields.opt("action", parseOneOf(PUBLICATION_ACTIONS)) ?? "publish";
  const interventionId = fields.opt("interventionId", parseDurableId);
  if (action === "publish" && interventionId !== undefined) {
    throw invalid("schema.invalid", "interventionId applies only to disable, rollback, and compensate plans", [
      "preparePublication",
      "interventionId",
    ]);
  }
  if (action !== "publish" && expectedBase !== undefined) {
    throw invalid(
      "schema.invalid",
      `a ${action} plan binds the published final version; a caller base is not accepted`,
      ["preparePublication", "expectedBase"],
    );
  }
  const destination = context.destinationsById?.get(destinationId);
  if (destination === undefined) {
    throw refusal("publication.destination_unknown", `destination "${destinationId}" is not registered on this loop`);
  }
  const candidate = await loadCandidate(context, candidateId);
  if (candidate === undefined) {
    throw refusal("publication.candidate_not_found", `candidate "${candidateId}" does not exist`);
  }
  if (candidate.schemaVersion !== 2) {
    throw refusal(
      "publication.candidate_legacy_unbound",
      `candidate "${candidateId}" is a schema-version-1 legacy record and cannot become a publication plan`,
    );
  }
  if (candidate.intervention.destinationId !== destinationId) {
    throw refusal(
      "publication.destination_mismatch",
      `candidate "${candidateId}" proposes destination "${candidate.intervention.destinationId}", not "${destinationId}"`,
    );
  }

  let lineage: PublicationLineage;
  let effects: readonly PreparedEffect[];
  let state: CandidateGovernanceState;
  if (isReversalAction(action)) {
    const parent = await resolveParentIntervention(context, candidate, destinationId, action, interventionId);
    effects = await deriveReversalEffects(context, destination, parent, action);
    lineage = {
      scopeDigest: scopeDigest(candidate.scope),
      scopePolicyDigest: context.scopePolicy.digest,
      registryRevision: context.registryRevision,
      destinationRegistrationDigest: destination.registrationDigest,
      derivation: parent.plan.lineage.derivation,
      parentInterventionId: parent.record.id,
    };
    state = await governanceStateOf(context, candidate);
  } else {
    state = await governanceStateOf(context, candidate);
    const invalidReasons = candidateInvalidDiagnostics(state);
    if (invalidReasons.length > 0) {
      throw new LearningLoopError("publication.candidate_invalid", invalidReasons);
    }
    lineage = lineageFor(context, candidate, destination, state);
    effects = await prepareEffects(context, destination, candidate, expectedBase);
  }
  const content = {
    candidateId: candidate.id,
    candidateDigest: candidate.contentDigest,
    destinationId,
    action,
    effectClass: destination.effectClass,
    effectiveRisk: effectiveRisk(context, candidate),
    effects,
    lineage,
    policyDigest: context.policy.digest,
  };
  const planDigest = publicationPlanDigest(content);
  const plan = parsePublicationPlan(
    toJsonValue({
      schemaVersion: 1,
      id: publicationPlanIdFor(planDigest),
      ...content,
      planDigest,
      createdAt: context.clock.now(),
    }),
  );
  const persisted = await persistPlan(context, plan);
  return Object.freeze({
    plan: persisted,
    authorizationBinding: authorizationBindingForPlan(persisted),
    governance: state.governance,
  });
}

// ---------------------------------------------------------------------------
// publish: refusal checks (decision 0025, kept verbatim)

function bindingDrift(
  context: EngineContext,
  plan: PublicationPlan,
  destination: BoundDestination | undefined,
  candidate: Candidate | undefined,
): readonly Diagnostic[] {
  const reasons: Diagnostic[] = [];
  if (plan.lineage.registryRevision !== context.registryRevision) {
    reasons.push(
      diagnostic("publication.binding_mismatch", "the loop registry revision changed since the plan was prepared"),
    );
  }
  if (plan.policyDigest !== context.policy.digest) {
    reasons.push(diagnostic("publication.binding_mismatch", "the learning policy changed since the plan was prepared"));
  }
  if (plan.lineage.scopePolicyDigest !== context.scopePolicy.digest) {
    reasons.push(diagnostic("publication.binding_mismatch", "the scope policy changed since the plan was prepared"));
  }
  reasons.push(...destinationDrift(plan, destination));
  if (candidate === undefined) {
    reasons.push(diagnostic("publication.binding_mismatch", `candidate "${plan.candidateId}" no longer exists`));
  } else if (candidate.contentDigest !== plan.candidateDigest) {
    reasons.push(
      diagnostic(
        "publication.binding_mismatch",
        `candidate "${plan.candidateId}" content differs from the bound digest`,
      ),
    );
  }
  return reasons;
}

function destinationDrift(plan: PublicationPlan, destination: BoundDestination | undefined): readonly Diagnostic[] {
  if (destination === undefined) {
    return [
      diagnostic("publication.binding_mismatch", `destination "${plan.destinationId}" is not registered on this loop`),
    ];
  }
  if (destination.registrationDigest !== plan.lineage.destinationRegistrationDigest) {
    return [
      diagnostic(
        "publication.binding_mismatch",
        `destination "${plan.destinationId}" registration changed since the plan`,
      ),
    ];
  }
  return [];
}

/**
 * A candidate is superseded once an exact v2 successor names it through
 * `supersedes` with its exact content digest in the same scope. The scan
 * reads only the `supersedes` field of other candidates before parsing a
 * match; it inherits the global candidate-kind scan debt noted elsewhere.
 */
async function candidateSupersededBy(context: EngineContext, candidate: CandidateV2): Promise<string | undefined> {
  for await (const page of iterateRecordPages(context.store, "candidate", { limit: 100 })) {
    for (const record of page.records) {
      const supersedes = readFields(record.value, ["store", "candidate"]).opt("supersedes", parseNonEmptyText);
      if (supersedes !== candidate.id) continue;
      const successor = parseCandidate(record.value);
      if (successor.id !== record.key.id) {
        throw invalid("store.corrupt", "stored candidate id does not match its record key", ["id"]);
      }
      if (
        successor.schemaVersion === 2 &&
        successor.originalDigest === candidate.contentDigest &&
        candidateScopeDigest(successor.scope) === candidateScopeDigest(candidate.scope)
      ) {
        return successor.id;
      }
    }
  }
  return undefined;
}

async function parentReadiness(
  context: EngineContext,
  plan: PublicationPlan,
  candidate: Candidate,
): Promise<readonly Diagnostic[]> {
  const parentId = plan.lineage.parentInterventionId;
  if (parentId === undefined || !isReversalAction(plan.action)) {
    throw invalid("store.corrupt", "a reversal plan must bind its parent intervention", ["lineage"]);
  }
  const parent = await loadParent(context, parentId);
  if (parent === undefined) {
    return [diagnostic("publication.intervention_not_found", `parent intervention "${parentId}" does not exist`)];
  }
  const mismatch = parentMismatch(parent, candidate, plan.destinationId);
  if (mismatch !== undefined) {
    return [diagnostic("publication.intervention_mismatch", `parent intervention "${parentId}" ${mismatch}`)];
  }
  const target = reversalTarget(plan.action, parent.record.state);
  if (target.kind !== "transition") {
    return [
      diagnostic(
        "publication.parent_state_invalid",
        `parent intervention "${parentId}" state does not permit ${plan.action}: publication "${parent.record.state.publication}", activation "${parent.record.state.activation}"`,
      ),
    ];
  }
  const receipts = await loadFoldReceipts(context, parent.record, parent.plan);
  const applied = new Set(receipts.map((stored) => stored.effectId));
  for (const effect of plan.effects) {
    if (!applied.has(effect.id)) {
      return [
        diagnostic(
          "publication.intervention_mismatch",
          `parent intervention "${parentId}" holds no receipt for effect "${effect.id}"`,
        ),
      ];
    }
  }
  return [];
}

// ---------------------------------------------------------------------------
// publish: the journal

function adapterFailureDiagnostics(code: string, message: string, error: unknown): readonly Diagnostic[] {
  if (error instanceof LearningLoopError) return [diagnostic(code, message), ...error.diagnostics];
  const text =
    error instanceof Error ? error.message : typeof error === "string" ? error : "non-error value thrown by adapter";
  return [
    diagnostic(code, message),
    {
      code: "publication.destination_failed",
      severity: "error",
      message: text.length > MAX_ADAPTER_ERROR_TEXT ? `${text.slice(0, MAX_ADAPTER_ERROR_TEXT)}…` : text,
    },
  ];
}

async function recordFailure(
  context: EngineContext,
  interventionId: string,
  receipts: readonly StoredPublicationReceipt[],
  diagnostics: readonly Diagnostic[],
): Promise<PublicationOutcome> {
  await appendInterventionTransition(
    context,
    interventionId,
    (current) => (current.publication === "unpublished" ? { ...current, publication: "failed" } : undefined),
    receipts.map((stored) => stored.id),
  );
  return outcome("failed", diagnostics);
}

async function applyOneEffect(
  context: EngineContext,
  plan: PublicationPlan,
  destination: BoundDestination,
  effect: PreparedEffect,
  effectIndex: number,
): Promise<
  | { readonly status: "applied" | "existing"; readonly stored: StoredPublicationReceipt }
  | { readonly status: "failed"; readonly diagnostics: readonly Diagnostic[] }
> {
  const idempotencyKey = publicationEffectIdempotencyKey(plan.planDigest, effect.id);
  const existing = await loadStoredPublicationReceipt(context, receiptIdFor(idempotencyKey));
  if (existing !== undefined) {
    assertStoredReceiptBinds(existing, { plan, effect, effectIndex, idempotencyKey });
    return { status: "existing", stored: existing };
  }
  // The adapter receives a detached, frozen copy; it cannot mutate the plan.
  const detached = Object.freeze(parsePreparedEffect(toJsonValue(effect)));
  let raw: unknown;
  try {
    raw = await destination.applyEffect({ effect: detached, idempotencyKey });
  } catch (error) {
    return {
      status: "failed",
      diagnostics: adapterFailureDiagnostics(
        "publication.destination_failed",
        `destination "${destination.id}" failed to apply effect ${effectIndex} ("${effect.id}"); the same plan may be retried`,
        error,
      ),
    };
  }
  let receipt: PublicationReceipt;
  try {
    receipt = parsePublicationReceiptAt(raw, ["destination", "applyEffect"]);
  } catch (error) {
    return {
      status: "failed",
      diagnostics: adapterFailureDiagnostics(
        "publication.receipt_invalid",
        `destination "${destination.id}" returned a receipt that does not parse for effect ${effectIndex} ("${effect.id}")`,
        error,
      ),
    };
  }
  const mismatches = publicationReceiptMismatchReasons(receipt, {
    destinationId: plan.destinationId,
    effect,
    idempotencyKey,
  });
  if (mismatches.length > 0) {
    return {
      status: "failed",
      diagnostics: [
        diagnostic(
          "publication.receipt_mismatch",
          `destination "${destination.id}" receipt does not prove effect ${effectIndex} ("${effect.id}")`,
        ),
        ...mismatches.map(
          (reason): Diagnostic => ({
            code: "publication.receipt_mismatch",
            severity: "error",
            message: reason.message,
            path: ["destination", "applyEffect", reason.field],
          }),
        ),
      ],
    };
  }
  const stored = await ensureStoredPublicationReceipt(
    context,
    buildStoredPublicationReceipt({ plan, effect, effectIndex, idempotencyKey, receipt }),
    plan,
    effect,
  );
  return { status: "applied", stored };
}

function publishedStateFor(plan: PublicationPlan): (current: InterventionState) => InterventionState | undefined {
  const activation = plan.action === "publish" && plan.effectClass !== "proposal" ? "active" : "inactive";
  return (current) =>
    current.publication === "published" ? undefined : { ...current, publication: "published", activation };
}

async function completeJournal(
  context: EngineContext,
  plan: PublicationPlan,
  destination: BoundDestination,
  consumption: AuthorizationConsumption,
  entryStatus: "published" | "resumed",
): Promise<PublicationOutcome> {
  const interventionId = interventionIdFor(plan.planDigest);
  let activity = entryStatus === "published" ? 1 : 0;
  const header = await ensureInterventionHeader(context, buildInterventionHeader(context, plan));
  await ensureInterventionScopeMembership(context, buildInterventionScopeMembership(header));
  await appendInterventionTransition(
    context,
    interventionId,
    (current) => (current.authorization === "pending" ? { ...current, authorization: "authorized" } : undefined),
    [consumption.id],
  );
  const receipts: StoredPublicationReceipt[] = [];
  for (const [effectIndex, effect] of plan.effects.entries()) {
    const applied = await applyOneEffect(context, plan, destination, effect, effectIndex);
    if (applied.status === "failed") return recordFailure(context, interventionId, receipts, applied.diagnostics);
    if (applied.status === "applied") activity += 1;
    receipts.push(applied.stored);
  }
  if (isReversalAction(plan.action)) {
    const parentId = plan.lineage.parentInterventionId;
    if (parentId === undefined) throw invalid("store.corrupt", "a reversal plan must bind its parent", ["lineage"]);
    const action = plan.action;
    await appendInterventionTransition(
      context,
      parentId,
      (current) => {
        const target = reversalTarget(action, current);
        if (target.kind === "illegal") {
          throw invalid("store.corrupt", `parent intervention "${parentId}" regressed below its reversal`, ["parent"]);
        }
        return target.kind === "transition" ? target.to : undefined;
      },
      [interventionId],
    );
  }
  const before = await loadInterventionFold(context, interventionId);
  await appendInterventionTransition(
    context,
    interventionId,
    publishedStateFor(plan),
    receipts.map((stored) => stored.id),
  );
  if (before?.state.publication !== "published") activity += 1;
  const fold = await loadInterventionFold(context, interventionId);
  if (fold?.record === undefined || fold.record.state.publication !== "published") {
    throw invalid("store.corrupt", "publication journal did not converge on a published intervention", [
      "intervention",
    ]);
  }
  const finalReceipts = await loadFoldReceipts(context, fold.record, plan);
  return completion(activity === 0 ? "no_op" : entryStatus, fold.record, finalReceipts);
}

export async function runPublish(context: EngineContext, input: PublishInput): Promise<PublicationOutcome> {
  // Capture caller-owned evidence exactly once; it is opaque to the kernel.
  const authorizationEvidence: unknown = input.authorizationEvidence;
  const fields = readFields(input, ["publish"]);
  const planId = fields.req("planId", parseDurableId);
  const plan = await loadPlan(context, planId);
  if (plan === undefined) throw refusal("publication.plan_not_found", `publication plan "${planId}" does not exist`);
  const destination = context.destinationsById?.get(plan.destinationId);
  const binding = authorizationBindingForPlan(plan);
  const bindingDigest = authorizationBindingDigest(binding);

  // Resume: a consumed plan never re-consults authority. It forward-completes
  // on the exact registered destination or waits, blocked, until the host
  // restores that registration.
  const consumed = await loadAuthorizationConsumption(context, plan.planDigest);
  if (consumed !== undefined) {
    if (consumed.bindingDigest !== bindingDigest) {
      throw invalid("store.corrupt", "authorization consumption binds another plan binding", ["consumption"]);
    }
    const drift = destinationDrift(plan, destination);
    if (drift.length > 0 || destination === undefined) return outcome("blocked", drift);
    const fold = await loadInterventionFold(context, interventionIdFor(plan.planDigest));
    if (fold?.record !== undefined && fold.record.state.publication === "published") {
      return completion("no_op", fold.record, await loadFoldReceipts(context, fold.record, plan));
    }
    return completeJournal(context, plan, destination, consumed, "resumed");
  }

  const candidate = await loadCandidate(context, plan.candidateId);
  const drift = bindingDrift(context, plan, destination, candidate);
  if (drift.length > 0 || candidate === undefined || destination === undefined) {
    return outcome("blocked", drift);
  }
  if (candidate.schemaVersion !== 2) {
    return outcome("blocked", [
      diagnostic("publication.candidate_legacy_unbound", `candidate "${candidate.id}" is a legacy record`),
    ]);
  }
  if (isReversalAction(plan.action)) {
    // A reversal needs authority, never a fresh decisive review: a later
    // rejection or evidence invalidation is a reason to reverse, not a bar.
    const parentReasons = await parentReadiness(context, plan, candidate);
    if (parentReasons.length > 0) return outcome("blocked", parentReasons);
  } else {
    const successor = await candidateSupersededBy(context, candidate);
    if (successor !== undefined) {
      return outcome("blocked", [
        diagnostic(
          "publication.candidate_superseded",
          `candidate "${candidate.id}" has been superseded by "${successor}"; publish the successor instead`,
        ),
      ]);
    }
    const state = await governanceStateOf(context, candidate);
    const invalidReasons = candidateInvalidDiagnostics(state);
    if (invalidReasons.length > 0) return outcome("blocked", invalidReasons);
    if (state.governance.review !== "accepted" && state.governance.review !== "not_required") {
      return outcome("blocked", [
        diagnostic(
          "policy.blocked",
          `publication requires decisive review; governance review state is "${state.governance.review}"`,
        ),
        ...state.governance.reasons.filter((reason) => reason.code !== "policy.blocked"),
      ]);
    }
  }

  const authority = context.authority;
  if (authority === undefined) {
    return outcome("blocked", [
      diagnostic(
        "policy.authority_insufficient",
        "no authority port is configured on this loop; publication cannot be authorized",
      ),
    ]);
  }
  const verification = await authority.verify({ evidence: authorizationEvidence, binding });
  if (verification.status !== "authorized") {
    const status = verification.status === "pending" ? "pending" : "denied";
    return outcome(status, [
      diagnostic(
        `authority.${verification.status}`,
        `host authority reported "${verification.status}" for plan "${plan.id}"`,
      ),
      ...verification.diagnostics,
    ]);
  }
  const authorization = verification.authorization;
  assertVerifiedAuthorization(authority, authorization, "authorization");
  if (authorization.bindingDigest !== bindingDigest) {
    return outcome("denied", [
      diagnostic(
        "publication.binding_mismatch",
        "verified authorization binds a different plan, content, destination, base, risk, action, or policy",
      ),
    ]);
  }
  if (authorization.expiresAt !== undefined && Date.parse(authorization.expiresAt) <= Date.parse(context.clock.now())) {
    return outcome("denied", [
      diagnostic("authority.expired", `authorization "${authorization.id}" expired at ${authorization.expiresAt}`),
    ]);
  }

  // Consumption is the first durable journal fact; from here the plan is
  // resumable and authority is never consulted again for it.
  const ensured = await ensureAuthorizationConsumption(
    context,
    buildAuthorizationConsumption(context, plan, bindingDigest, authorization),
  );
  return completeJournal(
    context,
    plan,
    destination,
    ensured.consumption,
    ensured.preexisting ? "resumed" : "published",
  );
}

// ---------------------------------------------------------------------------
// getIntervention

export async function runGetIntervention(
  context: EngineContext,
  input: { readonly interventionId: string },
): Promise<InterventionRecord | undefined> {
  const fields = readFields(input, ["getIntervention"]);
  const interventionId = fields.req("interventionId", parseDurableId);
  const parent = await loadParent(context, interventionId);
  if (parent === undefined) return undefined;
  await loadFoldReceipts(context, parent.record, parent.plan);
  if (parent.record.authorizationIds.length > 0) {
    const consumption = await loadAuthorizationConsumption(context, parent.plan.planDigest);
    if (consumption === undefined || !parent.record.authorizationIds.includes(consumption.id)) {
      throw invalid("store.corrupt", `intervention "${interventionId}" cites a missing authorization consumption`, [
        "authorizationIds",
      ]);
    }
  }
  return Object.freeze(parent.record);
}
