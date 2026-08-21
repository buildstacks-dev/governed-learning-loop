// Publication plan and authorization binding (contract §Publication plan and
// authorization binding; receipt shape from §Publication destination).
// Approvals bind exact content (kernel invariant 4): a plan is content-
// addressed over candidate, destination, action, effect class, effective
// risk, every prepared effect, policy, and the semantic lineage closure; the
// binding a host approves derives from the plan and carries one closure
// digest. Changing content, destination, scope, base, risk, action, policy,
// or lineage changes both digests. These records are inert: parsing or
// holding one grants no authority, publication, activation, or validation.
import { sha256HexOfCanonicalJson } from "../canonical/canonical-json.js";
import type { JsonValue } from "../canonical/json.js";
import { toJsonValue } from "../canonical/to-json-value.js";
import { invalid, parseJson, parseNonEmptyText, parseOneOf, readFields } from "../parse/toolkit.js";
import type { Parse, ParsePath } from "../parse/toolkit.js";
import type { RiskTier } from "./candidate.js";
import type { DetectorRef, LensRef, PackRef } from "./semantic-shared.js";
import {
  assertSortedUnique,
  parseBoundedArray,
  parseDetectorRefAt,
  parseDigestAt,
  parseDurableId,
  parseId,
  parseLensRefAt,
  parseNullable,
  parsePackRefAt,
  parseStatement,
} from "./semantic-shared.js";

export type EffectClass = "proposal" | "context" | "external" | "authority";

export const EFFECT_CLASSES = ["proposal", "context", "external", "authority"] as const;
export const PUBLICATION_ACTIONS = ["publish", "disable", "rollback", "compensate"] as const;
const AFTER_EFFECT_KINDS = ["disable", "rollback", "compensate", "irreversible"] as const;
const RISK_TIERS = ["T0", "T1", "T2", "T3"] as const;

/** Hard ceiling on prepared effects per plan; a destination above it is refused, never truncated. */
export const MAX_EFFECTS_PER_PLAN = 100;
const PLAN_DIGEST_DOMAIN = "publication-plan:v1";
const BINDING_DIGEST_DOMAIN = "authorization-binding:v1";
const LINEAGE_CLOSURE_DOMAIN = "publication-lineage-closure:v1";
const PLAN_ID_PREFIX = "plan-";
const INSIGHT_ID_PREFIX = "insight-";

export type AfterEffectSemantics =
  | { readonly kind: "disable"; readonly payload: JsonValue }
  | { readonly kind: "rollback"; readonly payload: JsonValue }
  | { readonly kind: "compensate"; readonly payload: JsonValue }
  | { readonly kind: "irreversible"; readonly rationale: string };

export interface PreparedEffect {
  readonly id: string;
  readonly kind: string;
  readonly target: string;
  readonly expectedBase?: string;
  readonly payload: JsonValue;
  readonly payloadDigest: string;
  readonly afterEffect: AfterEffectSemantics;
}

/**
 * The semantic closure a plan binds beyond the candidate digest: the exact
 * scope, loop scope policy, loop registry revision (which itself binds policy,
 * identity, content policies, sources, semantic registry, destinations, and
 * authority), the exact host destination registration, and — for a
 * derivation-backed candidate — the exact derivation with its detector, lens,
 * and pack references. A manual candidate binds `derivation: null`.
 */
export interface PublicationLineage {
  readonly scopeDigest: string;
  readonly scopePolicyDigest: string;
  readonly registryRevision: string;
  readonly destinationRegistrationDigest: string;
  readonly derivation: {
    readonly id: string;
    readonly digest: string;
    readonly detector: DetectorRef;
    readonly lens: LensRef;
    readonly pack: PackRef | null;
  } | null;
}

export interface PublicationPlan {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly candidateId: string;
  readonly candidateDigest: string;
  readonly destinationId: string;
  readonly action: "publish" | "disable" | "rollback" | "compensate";
  readonly effectClass: EffectClass;
  readonly effectiveRisk: RiskTier;
  readonly effects: readonly PreparedEffect[];
  readonly lineage: PublicationLineage;
  readonly planDigest: string;
  readonly policyDigest: string;
  readonly createdAt: string;
}

export interface AuthorizationBinding {
  readonly planDigest: string;
  readonly candidateDigest: string;
  readonly destinationId: string;
  readonly effectClass: EffectClass;
  readonly effectiveRisk: RiskTier;
  readonly action: PublicationPlan["action"];
  readonly expectedBases: readonly string[];
  readonly policyDigest: string;
  readonly lineageClosureDigest: string;
}

export interface PublicationReceipt {
  readonly destinationId: string;
  readonly effectId: string;
  readonly target: string;
  readonly expectedBase?: string;
  readonly finalVersion?: string;
  readonly payloadDigest: string;
  readonly idempotencyKey: string;
  readonly appliedAt: string;
}

const parseTimestampAt: Parse<string> = (input, path) => {
  const value = parseNonEmptyText(input, path);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw invalid("schema.invalid", "timestamp must be canonical RFC 3339 UTC with milliseconds", path);
  }
  return value;
};

const parseAfterEffectAt: Parse<AfterEffectSemantics> = (input, path) => {
  const fields = readFields(input, path);
  const kind = fields.req("kind", parseOneOf(AFTER_EFFECT_KINDS));
  if (kind === "irreversible") return { kind, rationale: fields.req("rationale", parseStatement) };
  const payload = fields.req("payload", parseJson);
  if (kind === "disable") return { kind, payload };
  if (kind === "rollback") return { kind, payload };
  return { kind, payload };
};

export const parsePreparedEffectAt: Parse<PreparedEffect> = (input, path) => {
  const fields = readFields(input, path);
  const id = fields.req("id", parseId);
  const kind = fields.req("kind", parseId);
  const target = fields.req("target", parseDurableId);
  const expectedBase = fields.opt("expectedBase", parseId);
  const payload = fields.req("payload", parseJson);
  const payloadDigest = fields.req("payloadDigest", parseDigestAt);
  if (payloadDigest !== sha256HexOfCanonicalJson(payload)) {
    throw invalid("schema.corrupt", "prepared effect payloadDigest does not match its canonical payload", [
      ...path,
      "payloadDigest",
    ]);
  }
  const afterEffect = fields.req("afterEffect", parseAfterEffectAt);
  return {
    id,
    kind,
    target,
    ...(expectedBase !== undefined ? { expectedBase } : {}),
    payload,
    payloadDigest,
    afterEffect,
  };
};

/** Unknown-first parser for one prepared effect; recomputes the payload digest. */
export function parsePreparedEffect(input: unknown): PreparedEffect {
  return parsePreparedEffectAt(input, []);
}

const parseLineageDerivationAt: Parse<NonNullable<PublicationLineage["derivation"]>> = (input, path) => {
  const fields = readFields(input, path);
  const id = fields.req("id", parseDurableId);
  const digest = fields.req("digest", parseDigestAt);
  if (id !== `${INSIGHT_ID_PREFIX}${digest}`) {
    throw invalid("schema.corrupt", "lineage derivation id does not match its digest", [...path, "id"]);
  }
  return {
    id,
    digest,
    detector: fields.req("detector", parseDetectorRefAt),
    lens: fields.req("lens", parseLensRefAt),
    pack: fields.req("pack", parseNullable(parsePackRefAt)),
  };
};

export const parsePublicationLineageAt: Parse<PublicationLineage> = (input, path) => {
  const fields = readFields(input, path);
  return {
    scopeDigest: fields.req("scopeDigest", parseDigestAt),
    scopePolicyDigest: fields.req("scopePolicyDigest", parseDigestAt),
    registryRevision: fields.req("registryRevision", parseDigestAt),
    destinationRegistrationDigest: fields.req("destinationRegistrationDigest", parseDigestAt),
    derivation: fields.req("derivation", parseNullable(parseLineageDerivationAt)),
  };
};

function effectContent(effect: PreparedEffect): JsonValue {
  return toJsonValue({
    id: effect.id,
    kind: effect.kind,
    target: effect.target,
    ...(effect.expectedBase !== undefined ? { expectedBase: effect.expectedBase } : {}),
    payload: effect.payload,
    payloadDigest: effect.payloadDigest,
    afterEffect: effect.afterEffect,
  });
}

function lineageContent(lineage: PublicationLineage): JsonValue {
  return toJsonValue({
    scopeDigest: lineage.scopeDigest,
    scopePolicyDigest: lineage.scopePolicyDigest,
    registryRevision: lineage.registryRevision,
    destinationRegistrationDigest: lineage.destinationRegistrationDigest,
    derivation:
      lineage.derivation === null
        ? null
        : {
            id: lineage.derivation.id,
            digest: lineage.derivation.digest,
            detector: lineage.derivation.detector,
            lens: lineage.derivation.lens,
            pack: lineage.derivation.pack,
          },
  });
}

/**
 * Plan content digest. Includes candidateId, candidateDigest, destinationId,
 * action, effectClass, effectiveRisk, every full prepared effect in order,
 * policyDigest, and the full lineage under a domain-separation tag. Excludes
 * schemaVersion, id, planDigest, and createdAt.
 */
export function publicationPlanDigest(
  input: Omit<PublicationPlan, "schemaVersion" | "id" | "planDigest" | "createdAt">,
): string {
  return sha256HexOfCanonicalJson({
    domain: PLAN_DIGEST_DOMAIN,
    candidateId: input.candidateId,
    candidateDigest: input.candidateDigest,
    destinationId: input.destinationId,
    action: input.action,
    effectClass: input.effectClass,
    effectiveRisk: input.effectiveRisk,
    effects: input.effects.map(effectContent),
    policyDigest: input.policyDigest,
    lineage: lineageContent(input.lineage),
  });
}

/** Content-addressed plan id: the plan is its digest. */
export function publicationPlanIdFor(planDigest: string): string {
  return `${PLAN_ID_PREFIX}${planDigest}`;
}

/** One canonical digest over the candidate digest plus the full lineage closure. */
export function publicationLineageClosureDigest(candidateDigest: string, lineage: PublicationLineage): string {
  return sha256HexOfCanonicalJson({
    domain: LINEAGE_CLOSURE_DOMAIN,
    candidateDigest,
    lineage: lineageContent(lineage),
  });
}

/**
 * Binding digest: every AuthorizationBinding field under a domain-separation
 * tag. A VerifiedAuthorization is usable only when its bindingDigest equals
 * this value for the exact current plan.
 */
export function authorizationBindingDigest(binding: AuthorizationBinding): string {
  return sha256HexOfCanonicalJson({
    domain: BINDING_DIGEST_DOMAIN,
    planDigest: binding.planDigest,
    candidateDigest: binding.candidateDigest,
    destinationId: binding.destinationId,
    effectClass: binding.effectClass,
    effectiveRisk: binding.effectiveRisk,
    action: binding.action,
    expectedBases: [...binding.expectedBases],
    policyDigest: binding.policyDigest,
    lineageClosureDigest: binding.lineageClosureDigest,
  });
}

function assertUniqueEffectIds(effects: readonly PreparedEffect[], path: ParsePath): void {
  const ids = new Set<string>();
  for (const [index, effect] of effects.entries()) {
    if (ids.has(effect.id))
      throw invalid("schema.invalid", "prepared effect ids must be unique", [...path, index, "id"]);
    ids.add(effect.id);
  }
}

export const parseEffectsAt: Parse<readonly PreparedEffect[]> = (input, path) => {
  const effects = parseBoundedArray(parsePreparedEffectAt, MAX_EFFECTS_PER_PLAN, "prepared effects")(input, path);
  if (effects.length === 0) throw invalid("schema.invalid", "a publication plan requires at least one effect", path);
  assertUniqueEffectIds(effects, path);
  return effects;
};

/** Unknown-first parser; recomputes planDigest, every payload digest, and the content-addressed id. */
export function parsePublicationPlan(input: unknown): PublicationPlan {
  const fields = readFields(input, []);
  const schemaVersion = fields.schemaVersion1();
  const content = {
    candidateId: fields.req("candidateId", parseDurableId),
    candidateDigest: fields.req("candidateDigest", parseDigestAt),
    destinationId: fields.req("destinationId", parseId),
    action: fields.req("action", parseOneOf(PUBLICATION_ACTIONS)),
    effectClass: fields.req("effectClass", parseOneOf(EFFECT_CLASSES)),
    effectiveRisk: fields.req("effectiveRisk", parseOneOf(RISK_TIERS)),
    effects: fields.req("effects", parseEffectsAt),
    lineage: fields.req("lineage", parsePublicationLineageAt),
    policyDigest: fields.req("policyDigest", parseDigestAt),
  };
  const planDigest = fields.req("planDigest", parseDigestAt);
  const recomputed = publicationPlanDigest(content);
  if (planDigest !== recomputed) {
    throw invalid(
      "schema.corrupt",
      `publication plan planDigest does not match its bound fields (stored ${planDigest}, recomputed ${recomputed})`,
      ["planDigest"],
    );
  }
  const id = fields.req("id", parseDurableId);
  if (id !== publicationPlanIdFor(planDigest)) {
    throw invalid("schema.corrupt", "publication plan id does not match its content digest", ["id"]);
  }
  const createdAt = fields.req("createdAt", parseTimestampAt);
  return { schemaVersion, id, ...content, planDigest, createdAt };
}

/** The binding a host approves is a pure projection of the exact plan. */
export function authorizationBindingForPlan(plan: PublicationPlan): AuthorizationBinding {
  const bases = new Set<string>();
  for (const effect of plan.effects) {
    if (effect.expectedBase !== undefined) bases.add(effect.expectedBase);
  }
  return Object.freeze({
    planDigest: plan.planDigest,
    candidateDigest: plan.candidateDigest,
    destinationId: plan.destinationId,
    effectClass: plan.effectClass,
    effectiveRisk: plan.effectiveRisk,
    action: plan.action,
    expectedBases: Object.freeze([...bases].sort()),
    policyDigest: plan.policyDigest,
    lineageClosureDigest: publicationLineageClosureDigest(plan.candidateDigest, plan.lineage),
  });
}

/** Unknown-first parser for a binding; expectedBases must be sorted and unique. */
export function parseAuthorizationBinding(input: unknown): AuthorizationBinding {
  const fields = readFields(input, []);
  const expectedBases = fields.req("expectedBases", parseBoundedArray(parseId, MAX_EFFECTS_PER_PLAN, "expected bases"));
  assertSortedUnique(expectedBases, (value) => value, ["expectedBases"]);
  return {
    planDigest: fields.req("planDigest", parseDigestAt),
    candidateDigest: fields.req("candidateDigest", parseDigestAt),
    destinationId: fields.req("destinationId", parseId),
    effectClass: fields.req("effectClass", parseOneOf(EFFECT_CLASSES)),
    effectiveRisk: fields.req("effectiveRisk", parseOneOf(RISK_TIERS)),
    action: fields.req("action", parseOneOf(PUBLICATION_ACTIONS)),
    expectedBases,
    policyDigest: fields.req("policyDigest", parseDigestAt),
    lineageClosureDigest: fields.req("lineageClosureDigest", parseDigestAt),
  };
}
