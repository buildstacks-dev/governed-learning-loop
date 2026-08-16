import { describe, expect, it } from "vitest";
import type { Diagnostic } from "../src/diagnostics.js";
import type { EvidencePage, EvidenceSource } from "../src/ports/evidence.js";
import { defineSourceRegistration } from "../src/ports/evidence.js";

interface ManualInput {
  readonly events: readonly string[];
}

function makeSource(id: string, adapterVersion: string): EvidenceSource<ManualInput> {
  const diagnostics: readonly Diagnostic[] = [];
  return {
    descriptor: { id, adapterVersion },
    probe: (input) => Promise.resolve({ supported: input.events.length >= 0, diagnostics }),
    read: () => {
      const page: EvidencePage = {
        sourceRevision: "rev-1",
        observations: [],
        measurements: [],
        episodes: [],
        diagnostics,
      };
      return {
        [Symbol.asyncIterator]: () => {
          let done = false;
          return {
            next: () => {
              if (done) return Promise.resolve({ done: true, value: undefined });
              done = true;
              return Promise.resolve({ done: false, value: page });
            },
          };
        },
      };
    },
  };
}

describe("defineSourceRegistration", () => {
  it("captures the source id, trust ceiling, and content policy id", () => {
    const registered = defineSourceRegistration({
      source: makeSource("manual-events", "1.0.0"),
      trustCeiling: "observed",
      contentPolicyId: "structured-local-events-v1",
    });
    expect(registered.id).toBe("manual-events");
    expect(registered.trustCeiling).toBe("observed");
    expect(registered.contentPolicyId).toBe("structured-local-events-v1");
    expect(registered.registryRevision).toMatch(/^[0-9a-f]{64}$/);
  });

  it("computes the same registry revision for the same registration", () => {
    const a = defineSourceRegistration({
      source: makeSource("manual-events", "1.0.0"),
      trustCeiling: "observed",
      contentPolicyId: "policy-1",
    });
    const b = defineSourceRegistration({
      source: makeSource("manual-events", "1.0.0"),
      trustCeiling: "observed",
      contentPolicyId: "policy-1",
    });
    expect(a.registryRevision).toBe(b.registryRevision);
  });

  it("changes the registry revision when any bound component changes", () => {
    const baseline = defineSourceRegistration({
      source: makeSource("manual-events", "1.0.0"),
      trustCeiling: "observed",
      contentPolicyId: "policy-1",
    }).registryRevision;
    const adapterBump = defineSourceRegistration({
      source: makeSource("manual-events", "1.1.0"),
      trustCeiling: "observed",
      contentPolicyId: "policy-1",
    }).registryRevision;
    const ceilingChange = defineSourceRegistration({
      source: makeSource("manual-events", "1.0.0"),
      trustCeiling: "advisory",
      contentPolicyId: "policy-1",
    }).registryRevision;
    const policyChange = defineSourceRegistration({
      source: makeSource("manual-events", "1.0.0"),
      trustCeiling: "observed",
      contentPolicyId: "policy-2",
    }).registryRevision;
    expect(new Set([baseline, adapterBump, ceilingChange, policyChange]).size).toBe(4);
  });
});
