// PublicationDestination conformance suite (contract §Publication destination,
// §Conformance suites; decision 0026). Registers caller-supplied describe/it
// blocks for a destination factory; every destination adapter must pass
// unchanged. A fresh destination is created per test. The suite exercises the
// adapter alone — no loop, no authority — against the claims the kernel's
// journaled publisher relies on: parseable side-effect-free preparation,
// receipts that prove the exact effect, idempotent retry under one key, a
// distinct effect under a new key, and base refusal when bases are declared.
// Importing this module never loads or registers a test framework.
import { sha256HexOfCanonicalJson } from "../canonical/canonical-json.js";
import { toJsonValue } from "../canonical/to-json-value.js";
import type { PublicationDestination } from "../ports/destination.js";
import type { Candidate } from "../records/candidate.js";
import { candidateContentDigest } from "../records/candidate.js";
import type { PreparedEffect, PublicationReceipt } from "../records/publication.js";
import {
  parsePreparedEffect,
  parsePublicationReceipt,
  publicationReceiptMismatchReasons,
} from "../records/publication.js";

export type PublicationDestinationFactory = () => PublicationDestination | Promise<PublicationDestination>;

const KEY_DOMAIN = "destination-conformance-key:v1";

/** A synthetic, self-consistent legacy (v1) candidate; `prepare` accepts any Candidate shape. */
function conformanceCandidate(destinationId: string): Candidate {
  const bound = {
    scope: [{ type: "project", id: "conformance" }],
    problem: "Conformance: the destination must apply exactly what the kernel authorized.",
    hypothesis: "A receipt-proving, idempotent destination never duplicates an effect.",
    evidenceIds: ["conformance/observation-1"],
    intervention: {
      destinationId,
      kind: "procedure",
      content: { text: "Conformance instruction content." },
      rollbackIntent: "Disable this instruction version.",
    },
    proposedRisk: "T1" as const,
  };
  return {
    ...bound,
    schemaVersion: 1,
    id: "conformance-candidate-1",
    proposedBy: { id: "conformance-proposer", kind: "service", independenceDomain: "conformance" },
    proposerAttestationDigest: "c".repeat(64),
    proposedAt: "2026-08-21T00:00:00.000Z",
    contentDigest: candidateContentDigest(bound),
  };
}

function keyFor(label: string): string {
  return sha256HexOfCanonicalJson({ domain: KEY_DOMAIN, label });
}

async function preparedEffects(
  destination: PublicationDestination,
  candidate: Candidate,
  expectedBase?: string,
): Promise<readonly PreparedEffect[]> {
  const raw: unknown = await destination.prepare({
    candidate,
    ...(expectedBase !== undefined ? { expectedBase } : {}),
  });
  if (!Array.isArray(raw)) throw new Error("prepare must resolve to an array of prepared effects");
  return raw.map((effect: unknown) => parsePreparedEffect(effect));
}

async function applied(
  destination: PublicationDestination,
  effect: PreparedEffect,
  idempotencyKey: string,
): Promise<PublicationReceipt> {
  const raw: unknown = await destination.applyEffect({ effect, idempotencyKey });
  return parsePublicationReceipt(raw);
}

async function rejects(run: () => Promise<unknown>): Promise<boolean> {
  try {
    await run();
    return false;
  } catch {
    return true;
  }
}

function canonical(value: unknown): string {
  return sha256HexOfCanonicalJson(toJsonValue(value));
}

export function runPublicationDestinationConformance(
  makeDestination: PublicationDestinationFactory,
  testApi: {
    readonly describe: (name: string, suite: () => void) => void;
    readonly it: (name: string, test: () => void | Promise<void>) => void;
    readonly expect: (actual: unknown) => {
      readonly not: {
        readonly toBe: (expected: unknown) => void;
      };
      readonly toBe: (expected: unknown) => void;
      readonly toBeDefined: () => void;
      readonly toBeLessThanOrEqual: (expected: number) => void;
      readonly toBeUndefined: () => void;
      readonly toEqual: (expected: unknown) => void;
    };
  },
): void {
  const { describe, expect, it } = testApi;
  describe("PublicationDestination conformance", () => {
    it("prepare is side-effect-free and returns parseable, unique, digest-true effects", async () => {
      const destination = await makeDestination();
      const candidate = conformanceCandidate(destination.id);
      const first = await preparedEffects(destination, candidate);
      const second = await preparedEffects(destination, candidate);
      expect(first.length > 0).toBe(true);
      expect(first.length).toBeLessThanOrEqual(100);
      expect(new Set(first.map((effect) => effect.id)).size).toBe(first.length);
      expect(canonical(second)).toBe(canonical(first));
      for (const effect of first) expect(effect.payloadDigest).toBe(sha256HexOfCanonicalJson(effect.payload));
    });

    it("echoes a requested base into every effect that declares one", async () => {
      const destination = await makeDestination();
      const candidate = conformanceCandidate(destination.id);
      const effects = await preparedEffects(destination, candidate, "conformance-requested-base");
      for (const effect of effects) {
        if (effect.expectedBase !== undefined) expect(effect.expectedBase).toBe("conformance-requested-base");
      }
    });

    it("applyEffect returns a receipt proving destination, effect, target, payload, base, and key", async () => {
      const destination = await makeDestination();
      const candidate = conformanceCandidate(destination.id);
      const effects = await preparedEffects(destination, candidate);
      for (const [index, effect] of effects.entries()) {
        const key = keyFor(`prove-${index}`);
        const receipt = await applied(destination, effect, key);
        expect(
          publicationReceiptMismatchReasons(receipt, { destinationId: destination.id, effect, idempotencyKey: key }),
        ).toEqual([]);
      }
    });

    it("a repeated idempotency key returns the same receipt and applies nothing new", async () => {
      const destination = await makeDestination();
      const candidate = conformanceCandidate(destination.id);
      const [effect] = await preparedEffects(destination, candidate);
      if (effect === undefined) throw new Error("prepare returned no effect");
      const key = keyFor("repeat");
      const first = await applied(destination, effect, key);
      const second = await applied(destination, effect, key);
      expect(canonical(second)).toBe(canonical(first));
      // The base did not move: a fresh effect prepared at the reported final
      // version still applies. Adapters without versions skip this half.
      if (first.finalVersion !== undefined) {
        const next = await preparedEffects(destination, candidate, first.finalVersion);
        const [nextEffect] = next;
        if (nextEffect === undefined) throw new Error("prepare returned no effect");
        if (nextEffect.expectedBase !== undefined) {
          const nextReceipt = await applied(destination, nextEffect, keyFor("after-repeat"));
          expect(nextReceipt.idempotencyKey).toBe(keyFor("after-repeat"));
        }
      }
    });

    it("a new idempotency key applies a distinct effect", async () => {
      const destination = await makeDestination();
      const candidate = conformanceCandidate(destination.id);
      const [effect] = await preparedEffects(destination, candidate);
      if (effect === undefined) throw new Error("prepare returned no effect");
      const first = await applied(destination, effect, keyFor("distinct-1"));
      const base = first.finalVersion;
      const [again] = base === undefined ? [effect] : await preparedEffects(destination, candidate, base);
      if (again === undefined) throw new Error("prepare returned no effect");
      const second = await applied(destination, again, keyFor("distinct-2"));
      expect(second.idempotencyKey).toBe(keyFor("distinct-2"));
      expect(second.idempotencyKey).not.toBe(first.idempotencyKey);
      if (first.finalVersion !== undefined && second.finalVersion !== undefined) {
        expect(second.finalVersion).not.toBe(first.finalVersion);
      }
    });

    it("refuses the same idempotency key for a different effect, or returns the original receipt", async () => {
      const destination = await makeDestination();
      const candidate = conformanceCandidate(destination.id);
      const [effect] = await preparedEffects(destination, candidate);
      if (effect === undefined) throw new Error("prepare returned no effect");
      const key = keyFor("reuse");
      const original = await applied(destination, effect, key);
      const payload = { text: "Different content under a reused key." };
      const other = parsePreparedEffect({ ...effect, payload, payloadDigest: sha256HexOfCanonicalJson(payload) });
      let reused: PublicationReceipt | undefined;
      const refused = await rejects(async () => {
        reused = await applied(destination, other, key);
      });
      if (!refused) expect(canonical(reused)).toBe(canonical(original));
    });

    it("refuses an effect whose expected base is not the current base, when bases are declared", async () => {
      const destination = await makeDestination();
      const candidate = conformanceCandidate(destination.id);
      const [effect] = await preparedEffects(destination, candidate);
      if (effect === undefined) throw new Error("prepare returned no effect");
      if (effect.expectedBase === undefined) return; // the adapter declares no bases
      const stale = parsePreparedEffect({ ...effect, expectedBase: `${effect.expectedBase}-stale` });
      expect(await rejects(() => applied(destination, stale, keyFor("stale-base")))).toBe(true);
    });
  });
}
