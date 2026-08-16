// conservativePolicy: rule data is serialized and digest-bound — a rule
// change is a digest change, and the engine refuses a policy whose digest
// does not bind its rules.
import { describe, expect, it } from "vitest";
import type { JsonValue } from "../src/index.js";
import { conservativePolicy } from "../src/index.js";
import { extractPolicyRules, learningPolicyDigest } from "../src/engine/policy.js";

// The ratified conservative rule set, pinned. Changing the shipped rules must
// break this test AND change the policy digest.
const EXPECTED_RULES = {
  risks: {
    T0: { independentReview: true, independentDomain: false },
    T1: { independentReview: true, independentDomain: false },
    T2: { independentReview: true, independentDomain: true },
    T3: { independentReview: true, independentDomain: true },
  },
  publication: { blockedPendingActivationTier: true },
} as const;

describe("conservativePolicy", () => {
  it("requires independent review at every tier and a distinct domain from T2 up", () => {
    const rules = extractPolicyRules(conservativePolicy());
    expect(rules).toEqual(EXPECTED_RULES);
  });

  it("digests its serialized rule data deterministically", () => {
    const policy = conservativePolicy();
    expect(policy.id).toBe("conservative-v1");
    expect(policy.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(policy.digest).toBe(conservativePolicy().digest);
    const serialized: JsonValue = EXPECTED_RULES;
    expect(policy.digest).toBe(learningPolicyDigest(policy.id, serialized));
  });

  it("changes its digest when any rule changes", () => {
    const policy = conservativePolicy();
    const weakened: JsonValue = {
      risks: {
        T0: { independentReview: true, independentDomain: false },
        T1: { independentReview: true, independentDomain: false },
        T2: { independentReview: true, independentDomain: false },
        T3: { independentReview: true, independentDomain: true },
      },
      publication: { blockedPendingActivationTier: true },
    };
    expect(learningPolicyDigest(policy.id, weakened)).not.toBe(policy.digest);
    const renamed: JsonValue = EXPECTED_RULES;
    expect(learningPolicyDigest("conservative-v2", renamed)).not.toBe(policy.digest);
  });

  it("refuses tampered rules: the digest must bind the exact rule bytes", () => {
    const policy = conservativePolicy();
    const tampered = {
      id: policy.id,
      digest: policy.digest,
      rules: {
        risks: {
          T0: { independentReview: false, independentDomain: false },
          T1: { independentReview: true, independentDomain: false },
          T2: { independentReview: true, independentDomain: true },
          T3: { independentReview: true, independentDomain: true },
        },
        publication: { blockedPendingActivationTier: true },
      },
    };
    expect(() => extractPolicyRules(tampered)).toThrow(/digest does not bind/);
  });
});
