import { describe, expect, it } from "vitest";
import type { DetectorPackManifest, DetectorRegistration, LearningLensRegistration } from "@cormidia/learning-loop";
import { detectorPackManifestDigest, detectorRegistrationDigest } from "@cormidia/learning-loop";
import type { ReferenceDetectorBundle } from "@cormidia/learning-loop/reference-detectors";
import { createReferenceDetectorBundle } from "@cormidia/learning-loop/reference-detectors";
import { createExactScopePolicy } from "@cormidia/learning-loop/testing";
import {
  allReferenceDetectors,
  createReferenceBundle,
  createReferenceLens,
  detectorRef,
  lensRef,
  packRef,
  referenceDigest,
} from "./reference-detector-harness.js";

const FAMILIES = [
  "attributed_human_redirection",
  "context_pressure_compaction",
  "coordination_attribution_integrity",
  "coordination_fanout",
  "repeated_status_polling",
  "tool_use_concentration",
] as const;

function canonical(value: unknown): string {
  return JSON.stringify(value);
}

function isDeepFrozen(value: unknown, seen: Set<object> = new Set()): boolean {
  if (typeof value !== "object" || value === null || seen.has(value)) return true;
  seen.add(value);
  if (!Object.isFrozen(value)) return false;
  return Object.values(value).every((nested) => isDeepFrozen(nested, seen));
}

function fixtureFamilyOf(detector: DetectorRegistration): (typeof FAMILIES)[number] {
  const family = FAMILIES.find((candidate) => detector.id.includes(`.${candidate}.`));
  if (family === undefined) throw new Error(`reference detector id has no known family: ${detector.id}`);
  return family;
}

function registrationBase(
  detector: DetectorRegistration,
): Omit<DetectorRegistration, "schemaVersion" | "registrationDigest"> {
  const { schemaVersion: _schemaVersion, registrationDigest: _registrationDigest, ...base } = detector;
  return base;
}

function packBase(pack: DetectorPackManifest): Omit<DetectorPackManifest, "schemaVersion" | "manifestDigest"> {
  const { schemaVersion: _schemaVersion, manifestDigest: _manifestDigest, ...base } = pack;
  return base;
}

function factoryInput(lenses: readonly LearningLensRegistration[]): unknown {
  return {
    schemaVersion: 1,
    registrationNamespace: "reference.factory-controls",
    scopePolicyDigest: createExactScopePolicy().digest,
    lenses,
  };
}

function generatedIds(bundle: ReferenceDetectorBundle): readonly string[] {
  return [
    ...allReferenceDetectors(bundle).map((detector) => detector.id),
    bundle.coreStructural.pack.id,
    bundle.referenceOperational.pack.id,
  ].sort();
}

describe("reference detector public bundle factory", () => {
  it("imports exactly the public subpath symbols and returns a deeply frozen inert bundle", () => {
    const bundle: ReferenceDetectorBundle = createReferenceBundle();
    expect(bundle).toMatchObject({ schemaVersion: 1, catalogVersion: "0.1.0" });
    expect(isDeepFrozen(bundle)).toBe(true);
    expect(Object.keys(bundle).sort()).toEqual([
      "catalogVersion",
      "coreStructural",
      "fixtures",
      "hostBindingDigest",
      "lenses",
      "referenceOperational",
      "registrationNamespace",
      "schemaVersion",
      "scopePolicyDigest",
      "sourceRequirements",
    ]);
  });

  it("drops unknown fields, never echoes their bytes, and snapshots mutable input before return", () => {
    const canary = "PRIVATE-REFERENCE-FACTORY-CANARY";
    const bundle = createReferenceBundle({ extra: { future: { nested: canary } } });
    expect(JSON.stringify(bundle)).not.toContain(canary);

    const baseline = createReferenceBundle();
    const mutableLenses = baseline.lenses.map((lens) => structuredClone(lens));
    const mutableInput = {
      schemaVersion: 1,
      registrationNamespace: "reference.snapshot-controls",
      scopePolicyDigest: baseline.scopePolicyDigest,
      lenses: mutableLenses,
      futureField: canary,
    };
    const snapshot = createReferenceDetectorBundle(mutableInput);
    const before = canonical(snapshot);
    Reflect.set(mutableInput, "registrationNamespace", "mutated");
    const firstLens = mutableLenses[0];
    if (firstLens !== undefined) Reflect.set(firstLens, "objective", canary);
    mutableLenses.reverse();
    expect(canonical(snapshot)).toBe(before);
    expect(JSON.stringify(snapshot)).not.toContain(canary);
    expect(isDeepFrozen(snapshot)).toBe(true);
  });

  it("is reorder-stable for exact lenses and reproduces every stable id and digest", () => {
    const baseline = createReferenceBundle({ registrationNamespace: "reference.reorder-controls" });
    const reordered = createReferenceDetectorBundle({
      schemaVersion: 1,
      registrationNamespace: baseline.registrationNamespace,
      scopePolicyDigest: baseline.scopePolicyDigest,
      lenses: [...baseline.lenses].reverse(),
    });
    expect(canonical(reordered)).toBe(canonical(baseline));

    const repeated = createReferenceBundle({ registrationNamespace: baseline.registrationNamespace });
    expect(repeated.hostBindingDigest).toBe(baseline.hostBindingDigest);
    expect(allReferenceDetectors(repeated).map((detector) => [detector.id, detector.registrationDigest])).toEqual(
      allReferenceDetectors(baseline).map((detector) => [detector.id, detector.registrationDigest]),
    );
    expect([repeated.coreStructural.pack, repeated.referenceOperational.pack].map(packRef)).toEqual(
      [baseline.coreStructural.pack, baseline.referenceOperational.pack].map(packRef),
    );
    expect(repeated.fixtures).toEqual(baseline.fixtures);
  });

  it("pins host binding to namespace, exact scope policy, and sorted exact lens refs", () => {
    const baseline = createReferenceBundle({ registrationNamespace: "reference.host-binding-controls" });
    const expected = referenceDigest({
      domain: "reference-detector-host-binding:v1",
      registrationNamespace: baseline.registrationNamespace,
      scopePolicyDigest: baseline.scopePolicyDigest,
      lenses: baseline.lenses.map(lensRef),
    });
    expect(baseline.hostBindingDigest).toBe(expected);
    expect(generatedIds(baseline).every((id) => id.endsWith(`.${expected}`))).toBe(true);

    const changedLenses = baseline.lenses.map((lens, index) =>
      index === 0
        ? createReferenceLens({
            id: lens.id,
            objective: `${lens.objective} Changed exact purpose content.`,
            scopePolicyDigest: baseline.scopePolicyDigest,
          })
        : lens,
    );
    const changedLensBundle = createReferenceDetectorBundle({
      schemaVersion: 1,
      registrationNamespace: baseline.registrationNamespace,
      scopePolicyDigest: baseline.scopePolicyDigest,
      lenses: changedLenses,
    });
    expect(changedLensBundle.hostBindingDigest).not.toBe(baseline.hostBindingDigest);
    expect(generatedIds(changedLensBundle)).not.toEqual(generatedIds(baseline));

    const changedScopePolicy = createExactScopePolicy({
      id: "reference-host-binding-scope-v2",
      isolationSegmentTypes: ["project"],
    });
    const changedScopeLenses = baseline.lenses.map((lens) =>
      createReferenceLens({
        id: lens.id,
        objective: lens.objective,
        scopePolicyDigest: changedScopePolicy.digest,
      }),
    );
    const changedScopeBundle = createReferenceDetectorBundle({
      schemaVersion: 1,
      registrationNamespace: baseline.registrationNamespace,
      scopePolicyDigest: changedScopePolicy.digest,
      lenses: changedScopeLenses,
    });
    expect(changedScopeBundle.hostBindingDigest).not.toBe(baseline.hostBindingDigest);
    expect(generatedIds(changedScopeBundle)).not.toEqual(generatedIds(baseline));
    expect(
      allReferenceDetectors(changedScopeBundle).every(
        (detector) => detector.scopePolicyDigest === changedScopePolicy.digest,
      ),
    ).toBe(true);
  });

  it("refuses malformed, missing, duplicate, scope-inconsistent, and corrupt-lens inputs", () => {
    const baseline = createReferenceBundle();
    const lens = baseline.lenses[0];
    if (lens === undefined) throw new Error("reference bundle requires a host lens");
    const wrongScopeLens = createReferenceLens({
      id: "reference-wrong-scope",
      objective: "This lens deliberately belongs to a different scope policy.",
      scopePolicyDigest: "0".repeat(64),
    });
    const cases: readonly unknown[] = [
      null,
      {},
      {
        schemaVersion: 2,
        registrationNamespace: "reference.bad",
        scopePolicyDigest: baseline.scopePolicyDigest,
        lenses: [],
      },
      { schemaVersion: 1, registrationNamespace: "", scopePolicyDigest: baseline.scopePolicyDigest, lenses: [lens] },
      { schemaVersion: 1, registrationNamespace: "reference.bad", scopePolicyDigest: "bad", lenses: [lens] },
      {
        schemaVersion: 1,
        registrationNamespace: "reference.bad",
        scopePolicyDigest: baseline.scopePolicyDigest,
        lenses: 1,
      },
      factoryInput([lens, lens]),
      factoryInput([wrongScopeLens]),
      factoryInput([{ ...lens, objective: "digest-corrupt" }]),
    ];
    for (const value of cases) {
      expect(() => createReferenceDetectorBundle(value)).toThrowError();
    }
  });

  it("binds every shipped fixture digest into exactly one matching detector registration", () => {
    const bundle = createReferenceBundle();
    const detectors = allReferenceDetectors(bundle);
    expect(detectors).toHaveLength(6);
    expect(bundle.fixtures.map((fixture) => fixture.detectorFamily).sort()).toEqual([
      "attributed_human_redirection",
      "attributed_human_redirection",
      "context_pressure_compaction",
      "context_pressure_compaction",
      "coordination_attribution_integrity",
      "coordination_attribution_integrity",
      "coordination_fanout",
      "coordination_fanout",
      "repeated_status_polling",
      "repeated_status_polling",
      "tool_use_concentration",
      "tool_use_concentration",
    ]);
    const declared = new Set<string>();
    for (const fixture of bundle.fixtures) {
      const { fixtureDigest, ...base } = fixture;
      expect(fixtureDigest).toBe(referenceDigest(base));
      const detector = detectors.find((candidate) => fixtureFamilyOf(candidate) === fixture.detectorFamily);
      if (detector === undefined) throw new Error(`fixture has no detector: ${fixture.id}`);
      const expectedDigests =
        fixture.control === "positive" ? detector.positiveFixtureDigests : detector.negativeFixtureDigests;
      expect(expectedDigests).toContain(fixtureDigest);
      expect(declared.has(fixtureDigest)).toBe(false);
      declared.add(fixtureDigest);
    }
    expect(declared.size).toBe(bundle.fixtures.length);
    for (const detector of detectors) {
      const family = fixtureFamilyOf(detector);
      expect(detector.positiveFixtureDigests).toEqual(
        bundle.fixtures
          .filter((fixture) => fixture.detectorFamily === family && fixture.control === "positive")
          .map((fixture) => fixture.fixtureDigest)
          .sort(),
      );
      expect(detector.negativeFixtureDigests).toEqual(
        bundle.fixtures
          .filter((fixture) => fixture.detectorFamily === family && fixture.control === "negative")
          .map((fixture) => fixture.fixtureDigest)
          .sort(),
      );
    }
  });

  it("keeps pack fragments, implementations, source requirements, and canonical digests reciprocal", () => {
    const bundle = createReferenceBundle();
    const fragments = [bundle.coreStructural, bundle.referenceOperational];
    expect(bundle.coreStructural.pack.kind).toBe("core_structural");
    expect(bundle.referenceOperational.pack.kind).toBe("reference_operational");
    for (const fragment of fragments) {
      expect(fragment.pack.manifestDigest).toBe(detectorPackManifestDigest(packBase(fragment.pack)));
      expect(fragment.pack.detectors).toEqual(fragment.detectors.map(detectorRef));
      expect(fragment.implementations.map((implementation) => implementation.detector)).toEqual(
        fragment.detectors.map(detectorRef),
      );
      for (const detector of fragment.detectors) {
        expect(detector.registrationDigest).toBe(detectorRegistrationDigest(registrationBase(detector)));
        expect(detector.maturity).toBe("experimental");
        expect(detector.privacy.signatureTreatment).toBe("none");
      }
    }
    expect(bundle.sourceRequirements.detectors.map((requirement) => requirement.detectorId).sort()).toEqual(
      allReferenceDetectors(bundle)
        .map((detector) => detector.id)
        .sort(),
    );
    expect(referenceDigest({ namespace: "different" })).not.toBe(bundle.hostBindingDigest);
    expect(createReferenceBundle({ registrationNamespace: "reference.other" }).hostBindingDigest).not.toBe(
      bundle.hostBindingDigest,
    );
  });
});
