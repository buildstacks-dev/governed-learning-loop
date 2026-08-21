// Learning policy (contract §Policy model, narrowed to Observe+Govern).
// The public LearningPolicy type is the contract's `{ id, digest }`. The
// conservative policy additionally carries its rule data as a runtime `rules`
// field (serialized JsonValue) that the digest binds; the engine re-parses
// that field from the policy value at construction time (parse, don't cast)
// and refuses a policy whose digest does not match its rules.
import { sha256HexOfCanonicalJson } from "../canonical/canonical-json.js";
import type { JsonValue } from "../canonical/json.js";
import { invalid, parseBool, parseJson, parseNonEmptyText, readFields } from "../parse/toolkit.js";
import type { Parse } from "../parse/toolkit.js";

export interface LearningPolicy {
  readonly id: string;
  readonly digest: string;
}

/** Per-risk-tier review requirements (internal; not part of the public surface). */
export interface PolicyRiskRule {
  readonly independentReview: boolean;
  readonly independentDomain: boolean;
}

export interface PolicyRules {
  readonly risks: {
    readonly T0: PolicyRiskRule;
    readonly T1: PolicyRiskRule;
    readonly T2: PolicyRiskRule;
    readonly T3: PolicyRiskRule;
  };
}

const parseRiskRuleAt: Parse<PolicyRiskRule> = (input, path) => {
  const fields = readFields(input, path);
  return {
    independentReview: fields.req("independentReview", parseBool),
    independentDomain: fields.req("independentDomain", parseBool),
  };
};

const parseRisksAt: Parse<PolicyRules["risks"]> = (input, path) => {
  const fields = readFields(input, path);
  return {
    T0: fields.req("T0", parseRiskRuleAt),
    T1: fields.req("T1", parseRiskRuleAt),
    T2: fields.req("T2", parseRiskRuleAt),
    T3: fields.req("T3", parseRiskRuleAt),
  };
};

const parsePolicyRulesAt: Parse<PolicyRules> = (input, path) => {
  const fields = readFields(input, path);
  return {
    risks: fields.req("risks", parseRisksAt),
  };
};

/** The digest binds the policy id and the exact serialized rule data. */
export function learningPolicyDigest(id: string, rules: JsonValue): string {
  return sha256HexOfCanonicalJson({ id, rules });
}

// Rule data of the conservative default policy. Any change here changes the
// canonical bytes and therefore the policy digest. Decision 0026 retired the
// `publication.blockedPendingActivationTier` placeholder of decisions
// 0001–0025: publication is now governed by decisive review, a registered
// destination, and loop-bound authority, never by a standing block.
const CONSERVATIVE_RULES = {
  risks: {
    T0: { independentReview: true, independentDomain: false },
    T1: { independentReview: true, independentDomain: false },
    T2: { independentReview: true, independentDomain: true },
    T3: { independentReview: true, independentDomain: true },
  },
} as const;

/**
 * Conservative default policy (contract §Policy model): every risk tier
 * requires an independent review; T2 and above additionally require a
 * reviewer from a distinct independence domain. The rule data is serialized
 * to JsonValue and bound into the digest, so a rule change is a policy-digest
 * change.
 */
export function conservativePolicy(): LearningPolicy {
  const id = "conservative-v1";
  const rules: JsonValue = CONSERVATIVE_RULES;
  const policy = { id, digest: learningPolicyDigest(id, rules), rules };
  return policy;
}

export interface BoundLearningPolicy {
  readonly policy: LearningPolicy;
  readonly rules: PolicyRules;
}

/** Parses policy metadata and rules once, then returns immutable metadata for engine context. */
export function bindLearningPolicy(policy: LearningPolicy): BoundLearningPolicy {
  const fields = readFields(policy, ["policy"]);
  const id = fields.req("id", parseNonEmptyText);
  const digest = fields.req("digest", parseNonEmptyText);
  const rules = fields.opt("rules", parseJson);
  if (rules === undefined) {
    throw invalid(
      "config.invalid",
      `policy "${id}" carries no rule data; this milestone requires a rules-bearing policy like conservativePolicy()`,
      ["policy", "rules"],
    );
  }
  const recomputed = learningPolicyDigest(id, rules);
  if (recomputed !== digest) {
    throw invalid(
      "config.invalid",
      `policy "${id}" digest does not bind its rules (stored ${digest}, recomputed ${recomputed})`,
      ["policy", "digest"],
    );
  }
  return {
    policy: Object.freeze({ id, digest }),
    rules: parsePolicyRulesAt(rules, ["policy", "rules"]),
  };
}

/**
 * Recovers the rule data from a LearningPolicy value. The rules travel in a
 * runtime field beyond the public type, so they are validated from `unknown`
 * here, and the policy digest is recomputed from `{ id, rules }` — a policy
 * whose digest does not bind its rules is refused at construction time.
 */
export function extractPolicyRules(policy: LearningPolicy): PolicyRules {
  return bindLearningPolicy(policy).rules;
}
