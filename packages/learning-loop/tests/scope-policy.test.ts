import { describe, expect, it } from "vitest";
import { LearningLoopError } from "../src/diagnostics.js";
import { createExactScopePolicy } from "../src/records/scope.js";

function errorFrom(run: () => unknown): LearningLoopError {
  try {
    run();
  } catch (error) {
    if (error instanceof LearningLoopError) return error;
    throw error;
  }
  throw new Error("expected a LearningLoopError");
}

describe("createExactScopePolicy", () => {
  const policy = createExactScopePolicy();

  it("has a stable content digest bound to id and isolation segment types", () => {
    expect(policy.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(createExactScopePolicy().digest).toBe(policy.digest);
    expect(createExactScopePolicy({ isolationSegmentTypes: ["tenant"] }).digest).not.toBe(policy.digest);
    expect(createExactScopePolicy({ id: "scope-exact-v2" }).digest).not.toBe(policy.digest);
  });

  it("validates a well-formed scope and preserves the given order", () => {
    const scope = policy.validate([
      { type: "tenant", id: "acme" },
      { type: "project", id: "support" },
    ]);
    expect(scope).toEqual([
      { type: "tenant", id: "acme" },
      { type: "project", id: "support" },
    ]);
  });

  it("ignores unknown segment fields while validating", () => {
    expect(policy.validate([{ type: "project", id: "support", note: "extra" }])).toEqual([
      { type: "project", id: "support" },
    ]);
  });

  const invalidScopes: readonly { name: string; input: unknown }[] = [
    { name: "non-array input", input: { type: "project", id: "x" } },
    { name: "empty scope", input: [] },
    { name: "empty segment type", input: [{ type: "", id: "x" }] },
    { name: "empty segment id", input: [{ type: "project", id: "" }] },
    { name: "missing id", input: [{ type: "project" }] },
    { name: "non-string id", input: [{ type: "project", id: 7 }] },
    { name: "id longer than 200 characters", input: [{ type: "project", id: "x".repeat(201) }] },
    { name: "control character in id", input: [{ type: "project", id: "line\nbreak" }] },
    { name: "control character in type", input: [{ type: "pro\tject", id: "x" }] },
  ];

  for (const { name, input } of invalidScopes) {
    it(`rejects ${name}`, () => {
      expect(errorFrom(() => policy.validate(input)).code).toBe("schema.invalid");
    });
  }

  it("accepts segment text of exactly 200 characters", () => {
    expect(policy.validate([{ type: "project", id: "x".repeat(200) }])).toHaveLength(1);
  });

  it("returns no ancestors, even with isolation segment types configured", () => {
    const isolated = createExactScopePolicy({ isolationSegmentTypes: ["tenant"] });
    expect(isolated.isolationSegmentTypes).toEqual(["tenant"]);
    expect(
      isolated.ancestors([
        { type: "tenant", id: "acme" },
        { type: "project", id: "support" },
      ]),
    ).toEqual([]);
  });

  it("comparePrecedence: identical scopes tie; longer scopes take precedence; ties break deterministically", () => {
    const short = policy.validate([{ type: "project", id: "a" }]);
    const long = policy.validate([
      { type: "project", id: "a" },
      { type: "agent", id: "b" },
    ]);
    const peer = policy.validate([{ type: "project", id: "b" }]);
    expect(policy.comparePrecedence(short, short)).toBe(0);
    expect(policy.comparePrecedence(long, short)).toBe(1);
    expect(policy.comparePrecedence(short, long)).toBe(-1);
    const tie = policy.comparePrecedence(short, peer);
    expect(tie).not.toBe(0);
    expect(policy.comparePrecedence(peer, short)).toBe(-tie);
  });
});
