// #30c1 non-forgeable synchronous detector implementation capabilities.
import { describe, expect, it } from "vitest";
import type { RegisteredDetectorImplementation, SemanticRegistryConfig } from "../src/index.js";
import {
  conservativePolicy,
  createLearningLoop,
  detectorRegistrationDigest,
  parseDetectorRegistration,
  sha256HexOfCanonicalJson,
} from "../src/index.js";
import {
  defineDetectorImplementation,
  detectorImplementationRegistration,
  evaluateDetectorImplementation,
} from "../src/engine/detector-implementation.js";
import { createInMemoryStore } from "../src/testing/index.js";
import type { SemanticEngineHarness } from "./semantic-engine-harness.js";
import { createSemanticEngineHarness } from "./semantic-engine-harness.js";

function opaqueThenable(): object {
  const key = ["th", "en"].join("");
  return Object.defineProperty({}, key, { value: () => undefined, enumerable: true });
}

function createLoop(
  harness: SemanticEngineHarness,
  implementations: readonly RegisteredDetectorImplementation[],
  semanticRegistry: SemanticRegistryConfig | null = harness.registry,
) {
  return createLearningLoop({
    store: createInMemoryStore(),
    policy: conservativePolicy(),
    identity: harness.context.identity,
    scopePolicy: harness.context.scopePolicy,
    contentPolicies: [...harness.context.contentPoliciesById.values()],
    sources: [...harness.context.sources],
    ...(semanticRegistry === null ? {} : { semanticRegistry }),
    detectorImplementations: implementations,
    queryCursorScope: "detector-implementation-tests",
  });
}

async function registryRevision(
  harness: SemanticEngineHarness,
  implementations: readonly RegisteredDetectorImplementation[],
): Promise<string> {
  const learning = createLoop(harness, implementations);
  return (
    await learning.ingest(harness.source, {
      observations: [],
      measurements: [],
      episodes: [],
    })
  ).registryRevision;
}

describe("defineDetectorImplementation", () => {
  it("snapshots exact registration/callback metadata and freezes only the returned capability", async () => {
    const harness = await createSemanticEngineHarness();
    const registration = structuredClone(harness.detector);
    const calls: unknown[] = [];
    const input = {
      registration,
      evaluate: (window: unknown) => {
        calls.push(window);
        return { conditionDetected: false, insights: [], findings: [] };
      },
    };
    const implementation = defineDetectorImplementation(input);
    expect(Object.isFrozen(implementation)).toBe(true);
    expect(Object.isFrozen(implementation.detector)).toBe(true);
    expect(implementation).toMatchObject({
      detector: {
        id: harness.detector.id,
        version: harness.detector.version,
        registrationDigest: harness.detector.registrationDigest,
      },
      implementationDigest: harness.detector.implementationDigest,
      registrationDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(implementation.registrationDigest).toBe(
      sha256HexOfCanonicalJson({
        detector: implementation.detector,
        implementationDigest: implementation.implementationDigest,
      }),
    );

    Reflect.set(registration, "id", "forged.detector");
    Reflect.set(input, "evaluate", () => ({ conditionDetected: true, insights: [], findings: [] }));
    const marker = Object.freeze({ marker: "provider-neutral-window" });
    expect(Reflect.apply(evaluateDetectorImplementation, undefined, [implementation, marker])).toMatchObject({
      conditionDetected: false,
    });
    expect(calls).toEqual([marker]);
    expect(detectorImplementationRegistration(implementation)).toEqual(harness.detector);
  });

  it("rejects non-callable evaluators, Promise/thenable results, and deprecated registrations", async () => {
    const harness = await createSemanticEngineHarness();
    expect(() =>
      Reflect.apply(defineDetectorImplementation, undefined, [{ registration: harness.detector, evaluate: null }]),
    ).toThrowError(expect.objectContaining({ code: "detector.implementation_invalid" }));

    const thenable = opaqueThenable();
    for (const result of [Promise.resolve({ conditionDetected: false }), thenable]) {
      const implementation = defineDetectorImplementation({
        registration: harness.detector,
        evaluate: () => result,
      });
      expect(() =>
        Reflect.apply(evaluateDetectorImplementation, undefined, [implementation, Object.freeze({})]),
      ).toThrowError(expect.objectContaining({ code: "detector.implementation_invalid" }));
    }

    const { schemaVersion: _schemaVersion, registrationDigest: _registrationDigest, ...currentBase } = harness.detector;
    const deprecatedBase = {
      ...currentBase,
      version: "2.0.0",
      maturity: "deprecated" as const,
      supersedes: {
        id: harness.detector.id,
        version: harness.detector.version,
        registrationDigest: harness.detector.registrationDigest,
      },
    };
    const deprecated = parseDetectorRegistration({
      schemaVersion: 1,
      ...deprecatedBase,
      registrationDigest: detectorRegistrationDigest(deprecatedBase),
    });
    expect(() =>
      defineDetectorImplementation({
        registration: deprecated,
        evaluate: () => ({ conditionDetected: false, insights: [], findings: [] }),
      }),
    ).toThrowError(expect.objectContaining({ code: "detector.implementation_invalid" }));
  });

  it("rejects spread/clone lookalikes, registry mismatch, and duplicate runtime pairing", async () => {
    const harness = await createSemanticEngineHarness();
    const implementation = defineDetectorImplementation({
      registration: harness.detector,
      evaluate: () => ({ conditionDetected: false, insights: [], findings: [] }),
    });
    for (const lookalike of [{ ...implementation }, structuredClone(implementation)]) {
      expect(() => Reflect.apply(detectorImplementationRegistration, undefined, [lookalike])).toThrowError(
        expect.objectContaining({ code: "config.invalid" }),
      );
      expect(() => Reflect.apply(createLoop, undefined, [harness, [lookalike], harness.registry])).toThrowError(
        expect.objectContaining({ code: "config.invalid" }),
      );
    }
    expect(() => createLoop(harness, [implementation, implementation])).toThrowError(
      expect.objectContaining({ code: "config.invalid" }),
    );
    expect(() => createLoop(harness, [implementation], null)).toThrowError(
      expect.objectContaining({ code: "config.invalid" }),
    );
  });

  it("binds configured capability presence into loop identity while equivalent factories remain stable", async () => {
    const harness = await createSemanticEngineHarness();
    const first = defineDetectorImplementation({
      registration: harness.detector,
      evaluate: () => ({ conditionDetected: false, insights: [], findings: [] }),
    });
    const equivalent = defineDetectorImplementation({
      registration: structuredClone(harness.detector),
      evaluate: () => ({ conditionDetected: true, insights: [], findings: [] }),
    });
    const without = await registryRevision(harness, []);
    const withFirst = await registryRevision(harness, [first]);
    const withEquivalent = await registryRevision(harness, [equivalent]);
    expect(withFirst).not.toBe(without);
    expect(withEquivalent).toBe(withFirst);
  });
});
