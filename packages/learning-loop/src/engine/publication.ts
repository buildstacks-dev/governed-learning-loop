// learning.preparePublication and the refusal half of learning.publish
// (contract §Publication plan and authorization binding, §Authority,
// §Publication destination; decision 0025).
//
// Preparation is side-effect-free against the destination (`prepare` only)
// and persists exactly one create-only, content-addressed plan record.
// Publish reloads the plan, revalidates every bound field against the current
// loop, requires decisive governance, consults the loop's exact authority
// port, and refuses pending, denied, invalid, expired, and binding-mismatched
// (wrong-base) authorizations. No refusal path — and, in this slice, no
// authorized path — performs a destination write or a store write. The
// authorized branch ends at the activation-tier gate; the journaled publisher
// (issue #10, second half) replaces that gate and keeps every check before it.
import { canonicalJsonText } from "../canonical/canonical-json.js";
import { toJsonValue } from "../canonical/to-json-value.js";
import type { Diagnostic } from "../diagnostics.js";
import { LearningLoopError } from "../diagnostics.js";
import { invalid, parseOneOf, readFields } from "../parse/toolkit.js";
import type { Candidate, CandidateV2 } from "../records/candidate.js";
import type {
  AuthorizationBinding,
  PreparedEffect,
  PublicationLineage,
  PublicationPlan,
} from "../records/publication.js";
import {
  authorizationBindingDigest,
  authorizationBindingForPlan,
  PUBLICATION_ACTIONS,
  parseEffectsAt,
  parsePublicationPlan,
  publicationPlanDigest,
  publicationPlanIdFor,
} from "../records/publication.js";
import { parseDurableId, parseId, scopeDigest } from "../records/semantic-shared.js";
import { assertVerifiedAuthorization } from "./authority.js";
import type { EngineContext } from "./context.js";
import { createOnly, effectiveRisk, errorDiagnostics, loadCandidate, loadStoredRecord } from "./context.js";
import type { BoundDestination } from "./destination-registration.js";
import { targetPermitted } from "./destination-registration.js";
import type { GovernanceView } from "./governance.js";
import { parseContentPolicyResult } from "./ingest.js";
import type { CandidateGovernanceState } from "./views.js";
import { candidateGovernanceStateOf } from "./views.js";

export interface PreparePublicationInput {
  readonly candidateId: string;
  readonly destinationId: string;
  readonly expectedBase?: string;
  readonly action?: PublicationPlan["action"];
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
 * Publication outcome of this slice. Only refusals exist until the journaled
 * publisher lands: `pending`/`denied` report the authority decision,
 * `blocked` reports policy, governance, binding drift, or the activation-tier
 * gate, and `failed` is reserved for adapter failures in the publisher.
 */
export type PublicationOutcome = {
  readonly status: "pending" | "denied" | "blocked" | "failed";
  readonly diagnostics: readonly Diagnostic[];
};

const PLAN_KIND = "publication-plan";

function refusal(code: string, message: string, extra: readonly Diagnostic[] = []): LearningLoopError {
  return new LearningLoopError(code, [{ code, severity: "error", message }, ...extra]);
}

function diagnostic(code: string, message: string): Diagnostic {
  return { code, severity: "error", message };
}

function outcome(status: PublicationOutcome["status"], diagnostics: readonly Diagnostic[]): PublicationOutcome {
  return Object.freeze({ status, diagnostics: Object.freeze([...diagnostics]) });
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
  for (const [index, effect] of effects.entries()) {
    if (!targetPermitted(effect.target, destination.permittedTargetPatterns)) {
      throw refusal(
        "publication.target_not_permitted",
        `destination "${destination.id}" registration does not permit the target of effect ${index} ("${effect.id}")`,
      );
    }
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

async function governanceStateOf(context: EngineContext, candidate: Candidate): Promise<CandidateGovernanceState> {
  const riskRule = context.policyRules.risks[effectiveRisk(context, candidate)];
  return candidateGovernanceStateOf(context, candidate, riskRule.independentReview);
}

export async function runPreparePublication(
  context: EngineContext,
  input: PreparePublicationInput,
): Promise<PreparedPublication> {
  const fields = readFields(input, ["preparePublication"]);
  const candidateId = fields.req("candidateId", parseDurableId);
  const destinationId = fields.req("destinationId", parseId);
  const expectedBase = fields.opt("expectedBase", parseId);
  const action = fields.opt("action", parseOneOf(PUBLICATION_ACTIONS)) ?? "publish";
  if (action !== "publish") {
    throw refusal(
      "publication.action_unavailable",
      `action "${action}" requires a published intervention; the journaled publisher (issue #10, second half) is not part of this slice`,
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
  const state = await governanceStateOf(context, candidate);
  const invalidReasons = candidateInvalidDiagnostics(state);
  if (invalidReasons.length > 0) {
    throw new LearningLoopError("publication.candidate_invalid", invalidReasons);
  }
  const lineage = lineageFor(context, candidate, destination, state);
  const effects = await prepareEffects(context, destination, candidate, expectedBase);
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
  if (destination === undefined) {
    reasons.push(
      diagnostic("publication.binding_mismatch", `destination "${plan.destinationId}" is not registered on this loop`),
    );
  } else if (destination.registrationDigest !== plan.lineage.destinationRegistrationDigest) {
    reasons.push(
      diagnostic(
        "publication.binding_mismatch",
        `destination "${plan.destinationId}" registration changed since the plan`,
      ),
    );
  }
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

export async function runPublish(context: EngineContext, input: PublishInput): Promise<PublicationOutcome> {
  // Capture caller-owned evidence exactly once; it is opaque to the kernel.
  const authorizationEvidence: unknown = input.authorizationEvidence;
  const fields = readFields(input, ["publish"]);
  const planId = fields.req("planId", parseDurableId);
  const stored = await loadStoredRecord(context, PLAN_KIND, planId);
  if (stored === undefined) throw refusal("publication.plan_not_found", `publication plan "${planId}" does not exist`);
  const plan = parsePublicationPlan(stored.value);
  if (plan.id !== planId)
    throw invalid("store.corrupt", "stored publication plan id does not match its record key", ["id"]);

  const destination = context.destinationsById?.get(plan.destinationId);
  const candidate = await loadCandidate(context, plan.candidateId);
  const drift = bindingDrift(context, plan, destination, candidate);
  if (drift.length > 0 || candidate === undefined) {
    return outcome("blocked", drift);
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

  const authority = context.authority;
  if (authority === undefined) {
    return outcome("blocked", [
      diagnostic(
        "policy.authority_insufficient",
        "no authority port is configured on this loop; publication cannot be authorized",
      ),
    ]);
  }
  const binding = authorizationBindingForPlan(plan);
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
  if (authorization.bindingDigest !== authorizationBindingDigest(binding)) {
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

  // Activation-tier gate: every check above is final; the journaled publisher
  // (issue #10, second half) continues from here. Nothing is written.
  return outcome("blocked", [
    diagnostic(
      "policy.blocked",
      context.policyRules.publication.blockedPendingActivationTier
        ? "publication is blocked pending the activation tier: the journaled publisher is not part of this slice (decision 0025, issue #10)"
        : "publication is unavailable: the journaled publisher is not part of this slice (decision 0025, issue #10)",
    ),
  ]);
}
