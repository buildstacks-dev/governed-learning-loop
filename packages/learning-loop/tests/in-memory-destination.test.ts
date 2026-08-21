// The /testing in-memory destination must pass the public destination
// conformance suite — the suite, not this file, is the contract — and its
// reference semantics (versioned bases, idempotent keys, declared
// after-effects) are pinned here for adapter authors.
import { describe, expect, it } from "vitest";
import type { Candidate, PreparedEffect } from "../src/index.js";
import { candidateContentDigest, parsePreparedEffect, sha256HexOfCanonicalJson } from "../src/index.js";
import {
  createFixedClock,
  createInMemoryDestination,
  runPublicationDestinationConformance,
} from "../src/testing/index.js";

const NOW = "2026-08-16T10:00:00.000Z";

runPublicationDestinationConformance(() => createInMemoryDestination({ clock: createFixedClock(NOW) }), {
  describe,
  expect,
  it,
});

function candidateFor(destinationId: string, text = "Run the type-check first."): Candidate {
  const bound = {
    scope: [{ type: "project", id: "acme" }],
    problem: "p",
    hypothesis: "h",
    evidenceIds: ["obs-1"],
    intervention: { destinationId, kind: "procedure", content: { text }, rollbackIntent: "disable" },
    proposedRisk: "T1" as const,
  };
  return {
    ...bound,
    schemaVersion: 1,
    id: "cand-memory",
    proposedBy: { id: "p", kind: "agent", independenceDomain: "a" },
    proposerAttestationDigest: "a".repeat(64),
    proposedAt: NOW,
    contentDigest: candidateContentDigest(bound),
  };
}

async function firstEffect(
  destination: ReturnType<typeof createInMemoryDestination>,
  candidate: Candidate,
  expectedBase?: string,
): Promise<PreparedEffect> {
  const [effect] = await destination.prepare({ candidate, ...(expectedBase !== undefined ? { expectedBase } : {}) });
  if (effect === undefined) throw new Error("no effect");
  return effect;
}

describe("createInMemoryDestination reference semantics", () => {
  it("prepares one write bound to the current version and declares an executable disable after-effect", async () => {
    const destination = createInMemoryDestination({ id: "ctx", clock: createFixedClock(NOW) });
    const candidate = candidateFor("ctx");
    const effect = await firstEffect(destination, candidate);
    expect(effect).toEqual({
      id: "write-1",
      kind: "context.write",
      target: "ctx/procedure",
      expectedBase: "v0",
      payload: { text: "Run the type-check first." },
      payloadDigest: sha256HexOfCanonicalJson({ text: "Run the type-check first." }),
      afterEffect: { kind: "disable", payload: { disables: { target: "ctx/procedure", effectId: "write-1" } } },
    });
    expect(destination.calls).toEqual({ prepare: 1, applyEffect: 0, applied: 0 });
    expect(destination.read("ctx/procedure")).toEqual({
      target: "ctx/procedure",
      currentVersion: "v0",
      content: null,
      versions: [],
    });
  });

  it("applies once per key, answers a repeated key from memory, and refuses key reuse and stale bases", async () => {
    const destination = createInMemoryDestination({ id: "ctx", clock: createFixedClock(NOW) });
    const candidate = candidateFor("ctx");
    const effect = await firstEffect(destination, candidate);
    const receipt = await destination.applyEffect({ effect, idempotencyKey: "k1" });
    expect(receipt).toEqual({
      destinationId: "ctx",
      effectId: "write-1",
      target: "ctx/procedure",
      expectedBase: "v0",
      finalVersion: "v1",
      payloadDigest: effect.payloadDigest,
      idempotencyKey: "k1",
      appliedAt: NOW,
    });
    expect(await destination.applyEffect({ effect, idempotencyKey: "k1" })).toEqual(receipt);
    expect(destination.calls).toEqual({ prepare: 1, applyEffect: 2, applied: 1 });
    expect(destination.read("ctx/procedure").content).toEqual({ text: "Run the type-check first." });
    await expect(destination.applyEffect({ effect, idempotencyKey: "k2" })).rejects.toMatchObject({
      code: "publication.base_mismatch",
    });
    const other = parsePreparedEffect({
      ...effect,
      payload: { text: "x" },
      payloadDigest: sha256HexOfCanonicalJson({ text: "x" }),
    });
    await expect(destination.applyEffect({ effect: other, idempotencyKey: "k1" })).rejects.toMatchObject({
      code: "publication.receipt_mismatch",
    });
    expect(destination.receipts()).toEqual([receipt]);
  });

  it("executes disable, rollback, and compensate payloads as new versions", async () => {
    const clock = createFixedClock(NOW);
    const disable = createInMemoryDestination({ id: "ctx", clock });
    const candidate = candidateFor("ctx");
    const write = await firstEffect(disable, candidate);
    await disable.applyEffect({ effect: write, idempotencyKey: "w" });
    const disableEffect = parsePreparedEffect({
      id: "write-1",
      kind: "disable",
      target: "ctx/procedure",
      expectedBase: "v1",
      payload: { disables: { target: "ctx/procedure", effectId: "write-1" } },
      payloadDigest: sha256HexOfCanonicalJson({ disables: { target: "ctx/procedure", effectId: "write-1" } }),
      afterEffect: { kind: "irreversible", rationale: "reversal" },
    });
    const disabled = await disable.applyEffect({ effect: disableEffect, idempotencyKey: "d" });
    expect(disabled.finalVersion).toBe("v2");
    expect(disable.read("ctx/procedure").content).toBeNull();
    expect(disable.read("ctx/procedure").versions.map((version) => version.kind)).toEqual(["write", "disable"]);
    await expect(
      disable.applyEffect({
        effect: {
          ...disableEffect,
          payload: { disables: { target: "ctx/procedure", effectId: "nope" } },
          payloadDigest: sha256HexOfCanonicalJson({ disables: { target: "ctx/procedure", effectId: "nope" } }),
          expectedBase: "v2",
        },
        idempotencyKey: "d2",
      }),
    ).rejects.toMatchObject({ code: "publication.effect_invalid" });

    const rollback = createInMemoryDestination({ id: "ctx", clock, afterEffect: "rollback" });
    const first = await firstEffect(rollback, candidate);
    expect(first.afterEffect).toEqual({ kind: "rollback", payload: { restore: null } });
    await rollback.applyEffect({ effect: first, idempotencyKey: "w" });
    const second = await firstEffect(rollback, candidateFor("ctx", "Second version."));
    expect(second.afterEffect).toEqual({
      kind: "rollback",
      payload: { restore: { text: "Run the type-check first." } },
    });
    await rollback.applyEffect({ effect: second, idempotencyKey: "w2" });
    const restored = await rollback.applyEffect({
      effect: parsePreparedEffect({
        id: "write-1",
        kind: "rollback",
        target: "ctx/procedure",
        expectedBase: "v2",
        payload: { restore: { text: "Run the type-check first." } },
        payloadDigest: sha256HexOfCanonicalJson({ restore: { text: "Run the type-check first." } }),
        afterEffect: { kind: "irreversible", rationale: "reversal" },
      }),
      idempotencyKey: "r",
    });
    expect(restored.finalVersion).toBe("v3");
    expect(rollback.read("ctx/procedure").content).toEqual({ text: "Run the type-check first." });

    const compensate = createInMemoryDestination({ id: "tickets", clock, afterEffect: "compensate" });
    const ticket = await firstEffect(compensate, candidateFor("tickets"));
    expect(ticket.afterEffect).toEqual({
      kind: "compensate",
      payload: { compensates: { target: "tickets/procedure", effectId: "write-1" } },
    });
    const irreversible = createInMemoryDestination({ id: "mail", clock, afterEffect: "irreversible" });
    expect((await firstEffect(irreversible, candidateFor("mail"))).afterEffect.kind).toBe("irreversible");
  });

  it("honors a custom target function and a requested base", async () => {
    const destination = createInMemoryDestination({
      id: "ctx",
      clock: createFixedClock(NOW),
      targetFor: (candidate) => `ctx/${candidate.scope.map((segment) => segment.id).join("/")}`,
    });
    const effect = await firstEffect(destination, candidateFor("ctx"), "requested");
    expect(effect.target).toBe("ctx/acme");
    expect(effect.expectedBase).toBe("requested");
    await expect(destination.applyEffect({ effect, idempotencyKey: "k" })).rejects.toMatchObject({
      code: "publication.base_mismatch",
    });
  });
});
