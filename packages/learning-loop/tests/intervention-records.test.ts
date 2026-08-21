// Intervention records (decision 0026): four independent state dimensions,
// the protocol legal-transition table, content-addressed transitions, and
// the folded record's structural rules. Authorized ≠ validated, permanently.
import { describe, expect, it } from "vitest";
import type { InterventionRecord, InterventionState, InterventionTransition } from "../src/index.js";
import {
  parseInterventionRecord,
  parseInterventionTransition,
  sha256HexOfCanonicalJson,
  toJsonValue,
} from "../src/index.js";
import {
  INITIAL_INTERVENTION_STATE,
  interventionStateInvalidReasons,
  interventionTransitionDigest,
  interventionTransitionIdFor,
  interventionTransitionKind,
} from "../src/records/intervention.js";

const PUBLICATION = ["unpublished", "published", "failed", "rolled_back"] as const;
const AUTHORIZATION = ["not_required", "pending", "authorized", "revoked", "expired"] as const;
const ACTIVATION = ["inactive", "active", "disabled"] as const;
const VALIDATION = ["untested", "invalid", "inconclusive", "improved", "regressed"] as const;
const NOW = "2026-08-16T10:00:00.000Z";
const INTERVENTION_ID = `intervention-${"1".repeat(64)}`;

function state(overrides: Partial<InterventionState> = {}): InterventionState {
  return { ...INITIAL_INTERVENTION_STATE, ...overrides };
}

const AUTHORIZED = state({ authorization: "authorized" });
const PUBLISHED_ACTIVE = state({ publication: "published", authorization: "authorized", activation: "active" });
const PUBLISHED_INACTIVE = state({ publication: "published", authorization: "authorized" });
const FAILED = state({ publication: "failed", authorization: "authorized" });
const DISABLED = state({ publication: "published", authorization: "authorized", activation: "disabled" });
const ROLLED_BACK = state({ publication: "rolled_back", authorization: "authorized", activation: "disabled" });

function allStates(): readonly InterventionState[] {
  const states: InterventionState[] = [];
  for (const publication of PUBLICATION)
    for (const authorization of AUTHORIZATION)
      for (const activation of ACTIVATION)
        for (const validation of VALIDATION) states.push({ publication, authorization, activation, validation });
  return states;
}

function transition(
  from: InterventionState,
  to: InterventionState,
  evidenceIds: readonly string[] = [`authorization-${"2".repeat(64)}`],
): InterventionTransition {
  const content = { interventionId: INTERVENTION_ID, from, to, evidenceIds, occurredAt: NOW };
  return parseInterventionTransition({
    schemaVersion: 1,
    id: interventionTransitionIdFor(interventionTransitionDigest(content)),
    ...content,
  });
}

function record(overrides: Partial<InterventionRecord> = {}): InterventionRecord {
  return parseInterventionRecord({
    schemaVersion: 1,
    id: INTERVENTION_ID,
    candidateId: "cand-1",
    planId: `plan-${"1".repeat(64)}`,
    state: PUBLISHED_ACTIVE,
    publicationReceiptIds: [`receipt-${"3".repeat(64)}`],
    authorizationIds: [`authorization-${"2".repeat(64)}`],
    evaluationIds: [],
    latestTransitionId: `transition-${"4".repeat(64)}`,
    ...overrides,
  });
}

function expectError(run: () => unknown, code: string): void {
  expect(run).toThrow(expect.objectContaining({ name: "LearningLoopError", code }));
}

describe("InterventionState invariants", () => {
  it("forbids active-plus-unpublished, pending-plus-applied, and rolled-back-plus-not-disabled", () => {
    expect(interventionStateInvalidReasons(INITIAL_INTERVENTION_STATE)).toEqual([]);
    expect(interventionStateInvalidReasons(PUBLISHED_ACTIVE)).toEqual([]);
    for (const invalid of [
      state({ activation: "active" }),
      state({ publication: "failed", authorization: "authorized", activation: "active" }),
      state({ publication: "rolled_back", authorization: "authorized", activation: "active" }),
      state({ publication: "published" }),
      state({ activation: "disabled" }),
      state({ publication: "rolled_back", authorization: "authorized" }),
    ]) {
      expect(interventionStateInvalidReasons(invalid).length).toBeGreaterThan(0);
    }
  });
});

describe("the legal-transition table", () => {
  it("names every edge the journaled publisher and its reversals use", () => {
    expect(interventionTransitionKind(INITIAL_INTERVENTION_STATE, AUTHORIZED)).toBe("authorize");
    expect(interventionTransitionKind(AUTHORIZED, PUBLISHED_ACTIVE)).toBe("publish");
    expect(interventionTransitionKind(AUTHORIZED, PUBLISHED_INACTIVE)).toBe("publish");
    expect(interventionTransitionKind(AUTHORIZED, FAILED)).toBe("fail");
    expect(interventionTransitionKind(FAILED, PUBLISHED_ACTIVE)).toBe("publish");
    expect(interventionTransitionKind(PUBLISHED_ACTIVE, DISABLED)).toBe("disable");
    expect(interventionTransitionKind(PUBLISHED_INACTIVE, DISABLED)).toBe("disable");
    expect(interventionTransitionKind(FAILED, { ...FAILED, activation: "disabled" })).toBe("disable");
    expect(interventionTransitionKind(PUBLISHED_ACTIVE, ROLLED_BACK)).toBe("rollback");
    expect(interventionTransitionKind(DISABLED, ROLLED_BACK)).toBe("rollback");
    expect(interventionTransitionKind(FAILED, ROLLED_BACK)).toBe("rollback");
    const notRequired = state({ authorization: "not_required" });
    expect(interventionTransitionKind(notRequired, { ...PUBLISHED_ACTIVE, authorization: "not_required" })).toBe(
      "publish",
    );
  });

  it("refuses publication from pending, revoked, or expired authority, re-enabling, regression, and validation edges", () => {
    for (const [from, to] of [
      [INITIAL_INTERVENTION_STATE, { ...PUBLISHED_ACTIVE, authorization: "pending" as const }],
      [state({ authorization: "revoked" }), { ...PUBLISHED_ACTIVE, authorization: "revoked" as const }],
      [state({ authorization: "expired" }), { ...PUBLISHED_ACTIVE, authorization: "expired" as const }],
      [AUTHORIZED, state({ authorization: "revoked" })],
      [AUTHORIZED, state({ authorization: "expired" })],
      [INITIAL_INTERVENTION_STATE, PUBLISHED_ACTIVE],
      [AUTHORIZED, ROLLED_BACK],
      [DISABLED, PUBLISHED_ACTIVE],
      [PUBLISHED_ACTIVE, AUTHORIZED],
      [PUBLISHED_ACTIVE, PUBLISHED_ACTIVE],
      [FAILED, FAILED],
      [ROLLED_BACK, DISABLED],
      [PUBLISHED_ACTIVE, { ...PUBLISHED_ACTIVE, validation: "improved" as const }],
      [AUTHORIZED, { ...PUBLISHED_ACTIVE, validation: "inconclusive" as const }],
      [INITIAL_INTERVENTION_STATE, INITIAL_INTERVENTION_STATE],
    ] as const) {
      expect(interventionTransitionKind(from, to)).toBeUndefined();
    }
  });

  it("over the full state product, every legal edge keeps validation, changes authority only pending→authorized, and lands on a valid state", () => {
    const states = allStates();
    let legal = 0;
    for (const from of states) {
      for (const to of states) {
        const kind = interventionTransitionKind(from, to);
        if (kind === undefined) continue;
        legal += 1;
        expect(from.validation).toBe(to.validation);
        expect(interventionStateInvalidReasons(to)).toEqual([]);
        expect(interventionStateInvalidReasons(from)).toEqual([]);
        if (kind === "authorize") {
          expect([from.authorization, to.authorization]).toEqual(["pending", "authorized"]);
        } else {
          expect(from.authorization).toBe(to.authorization);
          expect(["authorized", "not_required"]).toContain(from.authorization);
        }
        expect(to.authorization === "revoked" || to.authorization === "expired").toBe(false);
        if (to.activation === "active") expect(to.publication).toBe("published");
      }
    }
    // Pinned: 2 permitting authority modes × (publish 4 + fail 1 + disable 3 + rollback 5) × 5 validation
    // values, plus 5 authorize edges. Changing the table must change this number deliberately.
    expect(legal).toBe(135);
  });
});

describe("InterventionTransition", () => {
  it("round-trips, drops unknown fields, and pins the content-addressed id golden", () => {
    const parsed = transition(INITIAL_INTERVENTION_STATE, AUTHORIZED);
    const reparsed = parseInterventionTransition({ ...parsed, unknownField: 1, from: { ...parsed.from, extra: 2 } });
    expect(reparsed).toEqual(parsed);
    expect(parsed.id).toMatch(/^transition-[0-9a-f]{64}$/);
    expect(parsed.id).toBe(
      interventionTransitionIdFor(
        sha256HexOfCanonicalJson(
          toJsonValue({
            domain: "intervention-transition:v1",
            interventionId: INTERVENTION_ID,
            from: INITIAL_INTERVENTION_STATE,
            to: AUTHORIZED,
            evidenceIds: [`authorization-${"2".repeat(64)}`],
            occurredAt: NOW,
          }),
        ),
      ),
    );
  });

  it("refuses illegal pairs, evidence-free authorize/publish/disable/rollback edges, duplicate evidence, bad ids, and noncanonical time", () => {
    expectError(() => transition(INITIAL_INTERVENTION_STATE, PUBLISHED_ACTIVE), "schema.invalid");
    expectError(() => transition(INITIAL_INTERVENTION_STATE, AUTHORIZED, []), "schema.invalid");
    expectError(() => transition(AUTHORIZED, PUBLISHED_ACTIVE, []), "schema.invalid");
    expectError(() => transition(PUBLISHED_ACTIVE, DISABLED, []), "schema.invalid");
    expectError(() => transition(PUBLISHED_ACTIVE, ROLLED_BACK, []), "schema.invalid");
    expect(transition(AUTHORIZED, FAILED, []).evidenceIds).toEqual([]);
    expectError(() => transition(AUTHORIZED, PUBLISHED_ACTIVE, ["receipt-a", "receipt-a"]), "schema.invalid");
    const valid = transition(INITIAL_INTERVENTION_STATE, AUTHORIZED);
    expectError(() => parseInterventionTransition({ ...valid, id: `transition-${"0".repeat(64)}` }), "schema.corrupt");
    expectError(() => parseInterventionTransition({ ...valid, occurredAt: "2026-08-16T10:00:00Z" }), "schema.invalid");
    expectError(() => parseInterventionTransition({ ...valid, schemaVersion: 2 }), "schema.unsupported_version");
    expectError(
      () => parseInterventionTransition({ ...valid, to: { ...AUTHORIZED, activation: "active" } }),
      "schema.invalid",
    );
  });
});

describe("InterventionRecord", () => {
  it("round-trips, drops unknown fields, and omits an absent parent", () => {
    const parsed = record();
    expect(parseInterventionRecord({ ...parsed, extra: true })).toEqual(parsed);
    expect("parentInterventionId" in parsed).toBe(false);
    const child = record({ parentInterventionId: `intervention-${"5".repeat(64)}`, state: PUBLISHED_INACTIVE });
    expect(child.parentInterventionId).toBe(`intervention-${"5".repeat(64)}`);
  });

  it("keeps authorized and validated distinct: a validation claim needs an evaluation, never an authorization", () => {
    for (const validation of ["invalid", "inconclusive", "improved", "regressed"] as const) {
      expectError(() => record({ state: { ...PUBLISHED_ACTIVE, validation } }), "schema.invalid");
    }
    const evaluated = record({
      state: { ...PUBLISHED_ACTIVE, validation: "inconclusive" },
      evaluationIds: ["evaluation-1"],
    });
    expect(evaluated.state.authorization).toBe("authorized");
    expect(evaluated.state.validation).toBe("inconclusive");
  });

  it("requires receipts when published, an authorization when authorized, and no self-parent", () => {
    expectError(() => record({ publicationReceiptIds: [] }), "schema.invalid");
    expectError(() => record({ authorizationIds: [] }), "schema.invalid");
    expectError(() => record({ parentInterventionId: INTERVENTION_ID }), "schema.invalid");
    expectError(() => record({ state: state({ activation: "active" }) }), "schema.invalid");
    expect(record({ state: FAILED, publicationReceiptIds: [] }).state.publication).toBe("failed");
    expect(
      record({ state: INITIAL_INTERVENTION_STATE, publicationReceiptIds: [], authorizationIds: [] }).state,
    ).toEqual(INITIAL_INTERVENTION_STATE);
  });
});
