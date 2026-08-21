// Activate records (decision 0025): PreparedEffect, PublicationPlan,
// AuthorizationBinding parsers and digests. Approvals bind exact content —
// every bound field changes the plan digest, the binding digest, or both.
import { describe, expect, it } from "vitest";
import type { AuthorizationBinding, PreparedEffect, PublicationLineage, PublicationPlan } from "../src/index.js";
import {
  authorizationBindingDigest,
  parseAuthorizationBinding,
  parsePreparedEffect,
  parsePublicationPlan,
  publicationPlanDigest,
  sha256HexOfCanonicalJson,
} from "../src/index.js";
import {
  authorizationBindingForPlan,
  publicationLineageClosureDigest,
  publicationPlanIdFor,
} from "../src/records/publication.js";

const D = (character: string): string => character.repeat(64);
const NOW = "2026-08-16T10:00:00.000Z";
const PAYLOAD = { text: "Run the type-check before reporting complete." };

function effect(overrides: Partial<PreparedEffect> = {}): PreparedEffect {
  const payload = overrides.payload ?? PAYLOAD;
  return {
    id: "effect-1",
    kind: "instruction.write",
    target: "agent-instructions/CLAUDE.md",
    expectedBase: "instructions-v7",
    payload,
    payloadDigest: sha256HexOfCanonicalJson(payload),
    afterEffect: { kind: "disable", payload: { disable: "effect-1" } },
    ...overrides,
  };
}

const DERIVATION: NonNullable<PublicationLineage["derivation"]> = {
  id: `insight-${D("7")}`,
  digest: D("7"),
  detector: { id: "detector.example", version: "1.0.0", registrationDigest: D("8") },
  lens: { id: "lens.example", version: "1.0.0", registrationDigest: D("9") },
  pack: null,
};

function lineage(overrides: Partial<PublicationLineage> = {}): PublicationLineage {
  return {
    scopeDigest: D("1"),
    scopePolicyDigest: D("2"),
    registryRevision: D("3"),
    destinationRegistrationDigest: D("4"),
    derivation: null,
    ...overrides,
  };
}

type PlanContent = Omit<PublicationPlan, "schemaVersion" | "id" | "planDigest" | "createdAt">;

function content(overrides: Partial<PlanContent> = {}): PlanContent {
  return {
    candidateId: "cand-1",
    candidateDigest: D("5"),
    destinationId: "agent-instructions",
    action: "publish",
    effectClass: "context",
    effectiveRisk: "T1",
    effects: [effect()],
    lineage: lineage(),
    policyDigest: D("6"),
    ...overrides,
  };
}

function planFrom(planContent: PlanContent, createdAt = NOW): PublicationPlan {
  const planDigest = publicationPlanDigest(planContent);
  return parsePublicationPlan({
    schemaVersion: 1,
    id: publicationPlanIdFor(planDigest),
    ...planContent,
    planDigest,
    createdAt,
  });
}

function expectError(run: () => unknown, code: string): void {
  expect(run).toThrow(expect.objectContaining({ name: "LearningLoopError", code }));
}

describe("PreparedEffect", () => {
  it("round-trips, drops unknown fields, omits an absent base, and accepts every after-effect kind", () => {
    const parsed = parsePreparedEffect({ ...effect(), unknownField: "drop-me" });
    expect(parsed).toEqual(effect());
    expect("unknownField" in parsed).toBe(false);
    const { expectedBase: _expectedBase, ...withoutBase } = effect();
    expect("expectedBase" in parsePreparedEffect(withoutBase)).toBe(false);
    for (const afterEffect of [
      { kind: "disable" as const, payload: { version: 1 } },
      { kind: "rollback" as const, payload: [1, 2] },
      { kind: "compensate" as const, payload: "close-ticket" },
      { kind: "irreversible" as const, rationale: "outbound email cannot be recalled" },
    ]) {
      expect(parsePreparedEffect(effect({ afterEffect })).afterEffect).toEqual(afterEffect);
    }
  });

  it("recomputes the payload digest and refuses malformed shapes", () => {
    expectError(() => parsePreparedEffect(effect({ payloadDigest: D("0") })), "schema.corrupt");
    expectError(() => parsePreparedEffect({ ...effect(), payload: undefined }), "schema.invalid");
    expectError(() => parsePreparedEffect({ ...effect(), id: "" }), "schema.invalid");
    expectError(() => parsePreparedEffect({ ...effect(), target: "x".repeat(4_097) }), "schema.invalid");
    expectError(
      () => parsePreparedEffect({ ...effect(), afterEffect: { kind: "undo", payload: {} } }),
      "schema.invalid",
    );
    expectError(() => parsePreparedEffect({ ...effect(), afterEffect: { kind: "irreversible" } }), "schema.invalid");
    expectError(() => parsePreparedEffect({ ...effect(), afterEffect: { kind: "disable" } }), "schema.invalid");
    expectError(() => parsePreparedEffect({ ...effect(), payload: { when: new Date(0) } }), "schema.invalid");
  });
});

describe("PublicationPlan", () => {
  it("round-trips unknown input, drops unknown fields, and pins the digest goldens", () => {
    const plan = planFrom(content());
    const parsed = parsePublicationPlan({ ...plan, unknownTopLevel: true, lineage: { ...plan.lineage, extra: 1 } });
    expect(parsed).toEqual(plan);
    expect(JSON.stringify(parsed)).not.toContain("unknown");
    expect(plan.id).toBe(`plan-${plan.planDigest}`);
    expect(plan.planDigest).toBe("ef29b8ea4a4350f62444881dc356ffc4d08741f16039549658dad145df73b512");
    const binding = authorizationBindingForPlan(plan);
    expect(authorizationBindingDigest(binding)).toBe(
      "46f19e83b3e0240ccd41ebf55e3e1e2fcae7037694e6a0975bf00e6d20069a37",
    );
    expect(binding.lineageClosureDigest).toBe("5ac7bd20d6d0fe507668b64212386e941731dd52bd2a581f6404380b207db68b");
    expect(binding.lineageClosureDigest).toBe(publicationLineageClosureDigest(plan.candidateDigest, plan.lineage));
  });

  it("excludes id and createdAt from the plan digest", () => {
    const first = planFrom(content(), NOW);
    const second = planFrom(content(), "2026-08-17T10:00:00.000Z");
    expect(second.planDigest).toBe(first.planDigest);
    expect(second.id).toBe(first.id);
  });

  it("changes the plan digest for every bound field, effect field, effect order, and lineage field", () => {
    const baseline = publicationPlanDigest(content());
    const variants: readonly PlanContent[] = [
      content({ candidateId: "cand-2" }),
      content({ candidateDigest: D("a") }),
      content({ destinationId: "other-destination" }),
      content({ action: "disable" }),
      content({ effectClass: "proposal" }),
      content({ effectiveRisk: "T2" }),
      content({ effects: [effect({ id: "effect-2" })] }),
      content({ effects: [effect({ kind: "instruction.append" })] }),
      content({ effects: [effect({ target: "agent-instructions/AGENTS.md" })] }),
      content({ effects: [effect({ expectedBase: "instructions-v8" })] }),
      content({ effects: [parsePreparedEffect((({ expectedBase: _base, ...rest }) => rest)(effect()))] }),
      content({ effects: [effect({ payload: { text: "other" } })] }),
      content({ effects: [effect({ afterEffect: { kind: "rollback", payload: { disable: "effect-1" } } })] }),
      content({ effects: [effect({ afterEffect: { kind: "disable", payload: { disable: "effect-2" } } })] }),
      content({ effects: [effect(), effect({ id: "effect-2" })] }),
      content({ effects: [effect({ id: "effect-2" }), effect()] }),
      content({ policyDigest: D("b") }),
      content({ lineage: lineage({ scopeDigest: D("c") }) }),
      content({ lineage: lineage({ scopePolicyDigest: D("c") }) }),
      content({ lineage: lineage({ registryRevision: D("c") }) }),
      content({ lineage: lineage({ destinationRegistrationDigest: D("c") }) }),
      content({ lineage: lineage({ derivation: DERIVATION }) }),
      content({
        lineage: lineage({ derivation: { ...DERIVATION, detector: { ...DERIVATION.detector, version: "1.0.1" } } }),
      }),
      content({
        lineage: lineage({ derivation: { ...DERIVATION, lens: { ...DERIVATION.lens, registrationDigest: D("f") } } }),
      }),
      content({
        lineage: lineage({
          derivation: { ...DERIVATION, pack: { id: "pack.example", version: "1.0.0", manifestDigest: D("e") } },
        }),
      }),
    ];
    const digests = variants.map((variant) => publicationPlanDigest(variant));
    expect(new Set([baseline, ...digests]).size).toBe(variants.length + 1);
    for (const variant of variants) expect(() => planFrom(variant)).not.toThrow();
  });

  it("refuses wrong versions, digest or id mismatches, empty/duplicate/over-limit effects, and bad lineage", () => {
    const plan = planFrom(content());
    expectError(() => parsePublicationPlan({ ...plan, schemaVersion: 2 }), "schema.unsupported_version");
    expectError(() => parsePublicationPlan({ ...plan, planDigest: D("0") }), "schema.corrupt");
    expectError(() => parsePublicationPlan({ ...plan, id: "plan-other" }), "schema.corrupt");
    expectError(() => parsePublicationPlan({ ...plan, createdAt: "2026-08-16T10:00:00Z" }), "schema.invalid");
    expectError(() => parsePublicationPlan({ ...plan, effectiveRisk: "T9" }), "schema.invalid");
    expectError(() => parsePublicationPlan({ ...plan, candidateDigest: "A".repeat(64) }), "schema.invalid");
    expectError(() => planFrom(content({ effects: [] })), "schema.invalid");
    expectError(() => planFrom(content({ effects: [effect(), effect()] })), "schema.invalid");
    expectError(
      () =>
        planFrom(content({ effects: Array.from({ length: 101 }, (_, index) => effect({ id: `effect-${index}` })) })),
      "schema.invalid",
    );
    expectError(() => planFrom(content({ effects: [effect({ payloadDigest: D("0") })] })), "schema.corrupt");
    expectError(
      () => planFrom(content({ lineage: lineage({ derivation: { ...DERIVATION, id: `insight-${D("0")}` } }) })),
      "schema.corrupt",
    );
    expectError(
      () =>
        planFrom(
          content({
            lineage: lineage({ derivation: { ...DERIVATION, detector: { ...DERIVATION.detector, version: "v1" } } }),
          }),
        ),
      "schema.invalid",
    );
    expectError(
      () => parsePublicationPlan({ ...plan, lineage: { ...plan.lineage, derivation: undefined } }),
      "schema.invalid",
    );
  });

  it("accepts exactly 100 effects", () => {
    const plan = planFrom(
      content({ effects: Array.from({ length: 100 }, (_, index) => effect({ id: `effect-${index}` })) }),
    );
    expect(plan.effects).toHaveLength(100);
  });
});

describe("AuthorizationBinding", () => {
  it("derives from the plan with sorted, unique expected bases and round-trips through the parser", () => {
    const plan = planFrom(
      content({
        effects: [
          effect({ id: "e-1", expectedBase: "v9" }),
          effect({ id: "e-2", expectedBase: "v7" }),
          effect({ id: "e-3", expectedBase: "v9" }),
          parsePreparedEffect((({ expectedBase: _base, ...rest }) => rest)(effect({ id: "e-4" }))),
        ],
      }),
    );
    const binding = authorizationBindingForPlan(plan);
    expect(binding).toEqual({
      planDigest: plan.planDigest,
      candidateDigest: plan.candidateDigest,
      destinationId: plan.destinationId,
      effectClass: plan.effectClass,
      effectiveRisk: plan.effectiveRisk,
      action: plan.action,
      expectedBases: ["v7", "v9"],
      policyDigest: plan.policyDigest,
      lineageClosureDigest: publicationLineageClosureDigest(plan.candidateDigest, plan.lineage),
    });
    expect(Object.isFrozen(binding)).toBe(true);
    expect(parseAuthorizationBinding({ ...binding, unknown: 1 })).toEqual(binding);
  });

  it("changes the binding digest for every binding field", () => {
    const binding = authorizationBindingForPlan(planFrom(content()));
    const baseline = authorizationBindingDigest(binding);
    const variants: readonly AuthorizationBinding[] = [
      { ...binding, planDigest: D("0") },
      { ...binding, candidateDigest: D("0") },
      { ...binding, destinationId: "other" },
      { ...binding, effectClass: "external" },
      { ...binding, effectiveRisk: "T3" },
      { ...binding, action: "rollback" },
      { ...binding, expectedBases: [] },
      { ...binding, expectedBases: ["instructions-v6"] },
      { ...binding, policyDigest: D("0") },
      { ...binding, lineageClosureDigest: D("0") },
    ];
    expect(new Set([baseline, ...variants.map((variant) => authorizationBindingDigest(variant))]).size).toBe(
      variants.length + 1,
    );
  });

  it("the lineage closure digest binds candidate and lineage but not effects or policy", () => {
    const base = planFrom(content());
    const sameLineage = planFrom(content({ effects: [effect({ id: "other" })], policyDigest: D("0") }));
    const otherCandidate = planFrom(content({ candidateDigest: D("0") }));
    const otherLineage = planFrom(content({ lineage: lineage({ registryRevision: D("0") }) }));
    const closure = (plan: PublicationPlan) => authorizationBindingForPlan(plan).lineageClosureDigest;
    expect(closure(sameLineage)).toBe(closure(base));
    expect(closure(otherCandidate)).not.toBe(closure(base));
    expect(closure(otherLineage)).not.toBe(closure(base));
  });

  it("refuses unsorted or duplicate expected bases and malformed fields", () => {
    const binding = authorizationBindingForPlan(planFrom(content()));
    expectError(() => parseAuthorizationBinding({ ...binding, expectedBases: ["v9", "v7"] }), "schema.invalid");
    expectError(() => parseAuthorizationBinding({ ...binding, expectedBases: ["v7", "v7"] }), "schema.invalid");
    expectError(() => parseAuthorizationBinding({ ...binding, action: "apply" }), "schema.invalid");
    expectError(() => parseAuthorizationBinding({ ...binding, lineageClosureDigest: "nope" }), "schema.invalid");
    expectError(() => parseAuthorizationBinding(null), "schema.invalid");
  });
});
