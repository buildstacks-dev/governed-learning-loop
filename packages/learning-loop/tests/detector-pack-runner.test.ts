// #30c2a deterministic selected-pack orchestration: stable C1 dry planning,
// explicit cap/refusal dispositions, and sequential exact-byte commit.
import { describe, expect, it } from "vitest";
import type {
  DetectorOrchestrationDisposition,
  DetectorPackManifest,
  DetectorPackRunInput,
  DetectorPackRunResult,
  DetectorRegistration,
  DetectorWindow,
  LearningLensRegistration,
  LearningStore,
  RegisteredDetectorImplementation,
  SemanticRegistryConfig,
} from "../src/index.js";
import {
  conservativePolicy,
  createLearningLoop,
  defineDetectorImplementation,
  detectorPackManifestDigest,
  detectorRegistrationDigest,
  learningLensRegistrationDigest,
  parseDetectorPackManifest,
  parseDetectorRegistration,
  parseLearningLensRegistration,
  parseSemanticRegistryConfig,
  semanticRegistryDigest,
  sha256HexOfCanonicalJson,
  toJsonValue,
} from "../src/index.js";
import type { EngineContext } from "../src/engine/context.js";
import { runDetectorPack } from "../src/engine/detector-pack-run.js";
import { persistDetectorExecution } from "../src/engine/semantic-persistence.js";
import { detectorRefKey, lensRefKey, packRefKey } from "../src/records/semantic-shared.js";
import { createInMemoryStore } from "../src/testing/index.js";
import {
  PRIVATE_LOCATOR,
  createRecurrenceRunnerHarness,
  detectedInsightDraft,
  recurrenceRunInput,
} from "./detector-recurrence-harness.js";
import type { SemanticEngineHarness } from "./semantic-engine-harness.js";
import { SEMANTIC_SCOPE_B, createSemanticEngineHarness } from "./semantic-engine-harness.js";

function detectorRef(detector: DetectorRegistration) {
  return { id: detector.id, version: detector.version, registrationDigest: detector.registrationDigest };
}

function lensRef(lens: LearningLensRegistration) {
  return { id: lens.id, version: lens.version, registrationDigest: lens.registrationDigest };
}

function packRef(pack: DetectorPackManifest) {
  return { id: pack.id, version: pack.version, manifestDigest: pack.manifestDigest };
}

function compareRef(left: object, right: object): number {
  const a = JSON.stringify(left);
  const b = JSON.stringify(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

function createPackManifest(
  id: string,
  detectors: readonly DetectorRegistration[],
  lenses: readonly LearningLensRegistration[],
): DetectorPackManifest {
  const kind: DetectorPackManifest["kind"] = "host";
  const base = {
    id,
    version: "1.0.0",
    kind,
    detectors: detectors.map(detectorRef).sort(compareRef),
    lenses: lenses.map(lensRef).sort(compareRef),
    changelogDigest: "c".repeat(64),
    supersedes: null,
  };
  return parseDetectorPackManifest({
    schemaVersion: 1,
    ...base,
    manifestDigest: detectorPackManifestDigest(base),
  });
}

function createLens(harness: SemanticEngineHarness, index: number, id?: string): LearningLensRegistration {
  const { schemaVersion: _schemaVersion, registrationDigest: _registrationDigest, ...current } = harness.lens;
  const objective = `Pack orchestration purpose ${index}.`;
  const base = {
    ...current,
    id: id ?? `pack-lens-${String(index).padStart(3, "0")}`,
    objective,
    objectiveDigest: sha256HexOfCanonicalJson(toJsonValue(objective)),
    supersedes: null,
  };
  return parseLearningLensRegistration({
    schemaVersion: 1,
    ...base,
    registrationDigest: learningLensRegistrationDigest(base),
  });
}

function createDetector(
  harness: SemanticEngineHarness,
  index: number,
  lensSelection: "any_registered" | "allowlist" = "any_registered",
  allowlistedLens?: LearningLensRegistration,
  id?: string,
  outputKind: DetectorRegistration["outputKind"] = harness.detector.outputKind,
): DetectorRegistration {
  const { schemaVersion: _schemaVersion, registrationDigest: _registrationDigest, ...current } = harness.detector;
  const configuration = { detector: "pack-fixture", index };
  const lensConstraint: DetectorRegistration["lensConstraint"] =
    outputKind === "evidence_health"
      ? { mode: "independent" }
      : lensSelection === "any_registered"
        ? { mode: "required", selection: "any_registered", registrations: [] }
        : {
            mode: "required",
            selection: "allowlist",
            registrations: allowlistedLens === undefined ? [] : [lensRef(allowlistedLens)],
          };
  const base = {
    ...current,
    id: id ?? `pack-detector-${String(index).padStart(4, "0")}`,
    implementationDigest: sha256HexOfCanonicalJson(toJsonValue({ implementation: index })),
    configuration,
    configurationDigest: sha256HexOfCanonicalJson(toJsonValue(configuration)),
    lensConstraint,
    outputKind,
    supersedes: null,
  };
  return parseDetectorRegistration({
    schemaVersion: 1,
    ...base,
    registrationDigest: detectorRegistrationDigest(base),
  });
}

function createRegistry(input: {
  readonly harness: SemanticEngineHarness;
  readonly detectors: readonly DetectorRegistration[];
  readonly lenses: readonly LearningLensRegistration[];
}): { readonly registry: SemanticRegistryConfig; readonly pack: DetectorPackManifest } {
  const detectorRefs = input.detectors.map(detectorRef).sort(compareRef);
  const lensRefs = input.lenses.map(lensRef).sort(compareRef);
  const pack = createPackManifest("orchestration-pack", input.detectors, input.lenses);
  const registryBase = {
    scopePolicyDigest: input.harness.context.scopePolicy.digest,
    detectors: [...input.detectors].sort((left, right) => compareRef(detectorRef(left), detectorRef(right))),
    packs: [pack],
    lenses: [...input.lenses].sort((left, right) => compareRef(lensRef(left), lensRef(right))),
    sourceProfiles: [input.harness.profile],
    selectedDetectorRefs: detectorRefs,
    selectedPackRefs: [packRef(pack)],
    selectedLensRefs: lensRefs,
  };
  const registry = parseSemanticRegistryConfig({
    schemaVersion: 1,
    ...registryBase,
    registryDigest: semanticRegistryDigest(registryBase),
  });
  return { registry, pack };
}

function insightDraft(window: DetectorWindow, index: number) {
  const evidenceDigest = window.evidence[0]?.reference.referenceDigest;
  return {
    learningClass: "system_meta",
    directObservation: {
      statement: "A pack detector observed an exact condition.",
      data: { index },
      evidenceReferenceDigests: evidenceDigest === undefined ? [] : [evidenceDigest],
    },
    interpretation: {
      statement: "The condition may indicate an avoidable pattern.",
      confidence: "medium",
      uncertainty: ["Causal impact remains unvalidated."],
    },
    impactHypothesis: { statement: "A reversible intervention may reduce recurrence." },
    contradictoryEvidenceReferenceDigests: [],
    evidenceHealthFindingIds: [],
    missingEvidence: [],
    applicability: { statement: "Applies only to the exact run scope.", exclusions: ["benchmark traffic"] },
    candidateIntervention: {
      summary: "Record a reversible pack note.",
      proposedDestinationKind: "report-note",
      proposedDestinationId: "host/semantic-note",
      contentDraft: { index },
      rollbackIntent: "Remove the unvalidated draft.",
    },
    validation: {
      method: "comparable-held-out-episodes",
      comparablePopulation: null,
      comparablePopulationDigest: null,
      successCriterion: "The declared exact metric changes.",
      guardrails: ["Do not suppress valid failures."],
      strategyDigest: sha256HexOfCanonicalJson(toJsonValue({ method: "held-out-comparable-episodes" })),
    },
    supersedes: null,
  };
}

function healthFindingDraft(window: DetectorWindow, affectedRecords: number) {
  const reference = window.evidence[0]?.reference;
  if (reference === undefined) throw new Error("pack health fixture requires exact evidence");
  return {
    code: "source.partial",
    effect: "limits_claims",
    sourceId: reference.sourceId,
    sourceRegistrationRevision: reference.sourceRegistrationRevision,
    sourceRef: reference.sourceRef,
    pageRef: reference.pageRef,
    completeness: "partial",
    affectedRecords,
  };
}

async function zeroCompatibleTargetPackFixture() {
  const harness = await createSemanticEngineHarness({ label: "zero-compatible-pack" });
  const allowedLens = createLens(harness, 0, "pack.lens.allowed");
  const incompatibleLens = createLens(harness, 1, "pack.lens.incompatible");
  const detector = createDetector(harness, 0, "allowlist", allowedLens, "pack.detector.allowlisted");
  const compatiblePack = createPackManifest("pack.compatible", [detector], [allowedLens]);
  const targetPack = createPackManifest("pack.target-incompatible", [detector], [incompatibleLens]);
  const registryBase = {
    scopePolicyDigest: harness.context.scopePolicy.digest,
    detectors: [detector],
    packs: [compatiblePack, targetPack].sort((left, right) => compareRef(packRef(left), packRef(right))),
    lenses: [allowedLens, incompatibleLens].sort((left, right) => compareRef(lensRef(left), lensRef(right))),
    sourceProfiles: [harness.profile],
    selectedDetectorRefs: [detectorRef(detector)],
    selectedPackRefs: [packRef(compatiblePack), packRef(targetPack)].sort(compareRef),
    selectedLensRefs: [lensRef(allowedLens), lensRef(incompatibleLens)].sort(compareRef),
  };
  const registry = parseSemanticRegistryConfig({
    schemaVersion: 1,
    ...registryBase,
    registryDigest: semanticRegistryDigest(registryBase),
  });
  let callbacks = 0;
  const implementation = defineDetectorImplementation({
    registration: detector,
    evaluate: () => {
      callbacks += 1;
      return { conditionDetected: false, insights: [], findings: [] };
    },
  });
  const store = createInMemoryStore();
  const learning = createLearningLoop({
    store,
    policy: conservativePolicy(),
    identity: harness.context.identity,
    scopePolicy: harness.context.scopePolicy,
    contentPolicies: [...harness.context.contentPoliciesById.values()],
    sources: [...harness.context.sources],
    semanticRegistry: registry,
    detectorImplementations: [implementation],
    queryCursorScope: "pack-zero-compatible",
  });
  const receipt = await learning.ingest(harness.source, {
    observations: [
      {
        id: "zero-compatible-observation",
        episodeId: "zero-compatible-episode",
        kind: "tool.process.completed",
        data: { pack: true },
      },
    ],
    episodes: [
      {
        id: "zero-compatible-episode",
        episodeClass: "interactive",
        scope: harness.scope,
        openedAt: "2026-08-20T02:00:00.000Z",
        closedAt: "2026-08-20T02:01:00.000Z",
      },
    ],
  });
  const context: EngineContext = {
    ...harness.context,
    store,
    semanticRegistry: registry,
    semanticDetectorsByRef: new Map([[detectorRefKey(detectorRef(detector)), detector]]),
    semanticPacksByRef: new Map([compatiblePack, targetPack].map((pack) => [packRefKey(packRef(pack)), pack])),
    semanticLensesByRef: new Map([allowedLens, incompatibleLens].map((lens) => [lensRefKey(lensRef(lens)), lens])),
    detectorImplementationsByRef: new Map([[detectorRefKey(implementation.detector), implementation]]),
    registryRevision: receipt.registryRevision,
  };
  return {
    callbacks: () => callbacks,
    context,
    detector,
    harness,
    learning,
    targetPack,
    episodeRecordId: `${harness.source.id}/zero-compatible-episode`,
  };
}

function recordingStore(base: LearningStore) {
  const writes: string[] = [];
  const store: LearningStore = {
    get: (key) => base.get(key),
    create: (key, value, digest, operationId) => {
      writes.push(`${key.namespace}/${key.kind}`);
      return base.create(key, value, digest, operationId);
    },
    compareAndSet: (key, expectedRevision, value, digest, operationId) => {
      writes.push(`${key.namespace}/${key.kind}`);
      return base.compareAndSet(key, expectedRevision, value, digest, operationId);
    },
    append: (stream, expectedRevision, entries, operationId) => {
      writes.push(`${stream.namespace}/${stream.kind}`);
      return base.append(stream, expectedRevision, entries, operationId);
    },
    tombstone: (input) => {
      writes.push(`${input.key.namespace}/${input.key.kind}`);
      return base.tombstone(input);
    },
    list: (query) => base.list(query),
  };
  return { store, writes };
}

function corruptSecondObservationListingStore(base: LearningStore) {
  let enabled = false;
  let observationListings = 0;
  const store: LearningStore = {
    get: (key) => base.get(key),
    create: (key, value, digest, operationId) => base.create(key, value, digest, operationId),
    compareAndSet: (key, expectedRevision, value, digest, operationId) =>
      base.compareAndSet(key, expectedRevision, value, digest, operationId),
    append: (stream, expectedRevision, entries, operationId) =>
      base.append(stream, expectedRevision, entries, operationId),
    tombstone: (input) => base.tombstone(input),
    list: async (query) => {
      const page = await base.list(query);
      if (!enabled || query.kind !== "observation") return page;
      observationListings += 1;
      if (observationListings !== 2) return page;
      return {
        ...page,
        records: page.records.map((record, index) => (index === 0 ? { ...record, digest: "0".repeat(64) } : record)),
      };
    },
  };
  return {
    store,
    enable: () => {
      enabled = true;
      observationListings = 0;
    },
  };
}

async function invokePackUnknown(method: (input: never) => unknown, input: unknown): Promise<unknown> {
  const result: unknown = Reflect.apply(method, undefined, [input]);
  if (!(result instanceof Promise)) throw new Error("detector pack runner did not return a Promise");
  return result;
}

async function packFixture(input: {
  readonly detectorCount: number;
  readonly lensCount?: number;
  readonly evaluate?: (detector: DetectorRegistration, window: DetectorWindow, calls: Map<string, number>) => unknown;
  readonly implementationCount?: number;
  readonly store?: LearningStore;
  readonly label?: string;
  readonly detectorIds?: readonly string[];
  readonly lensIds?: readonly string[];
  readonly detectorOutputKind?: DetectorRegistration["outputKind"];
}) {
  const harness = await createSemanticEngineHarness({ label: `base-${input.label ?? "pack"}` });
  const lenses = Array.from({ length: input.lensCount ?? 1 }, (_, index) =>
    createLens(harness, index, input.lensIds?.[index]),
  );
  const detectors = Array.from({ length: input.detectorCount }, (_, index) =>
    createDetector(harness, index, "any_registered", undefined, input.detectorIds?.[index], input.detectorOutputKind),
  );
  const { registry, pack } = createRegistry({ harness, detectors, lenses });
  const calls = new Map<string, number>();
  const implementationCount = input.implementationCount ?? detectors.length;
  const implementations: RegisteredDetectorImplementation[] = detectors.slice(0, implementationCount).map((detector) =>
    defineDetectorImplementation({
      registration: detector,
      evaluate: (window) => {
        calls.set(detector.id, (calls.get(detector.id) ?? 0) + 1);
        return (
          input.evaluate?.(detector, window, calls) ?? {
            conditionDetected: false,
            insights: [],
            findings: [],
          }
        );
      },
    }),
  );
  const store = input.store ?? createInMemoryStore();
  const learning = createLearningLoop({
    store,
    policy: conservativePolicy(),
    identity: harness.context.identity,
    scopePolicy: harness.context.scopePolicy,
    contentPolicies: [...harness.context.contentPoliciesById.values()],
    sources: [...harness.context.sources],
    semanticRegistry: registry,
    detectorImplementations: implementations,
    queryCursorScope: `pack-runner-${input.label ?? "fixture"}`,
  });
  const label = input.label ?? "pack";
  const receipt = await learning.ingest(harness.source, {
    observations: [
      {
        id: `${label}-observation`,
        episodeId: `${label}-episode`,
        kind: "tool.process.completed",
        data: { pack: true },
      },
    ],
    episodes: [
      {
        id: `${label}-episode`,
        episodeClass: "interactive",
        scope: harness.scope,
        openedAt: "2026-08-20T02:00:00.000Z",
        closedAt: "2026-08-20T02:01:00.000Z",
      },
    ],
  });
  const context: EngineContext = {
    ...harness.context,
    store,
    semanticRegistry: registry,
    semanticDetectorsByRef: new Map(detectors.map((detector) => [detectorRefKey(detectorRef(detector)), detector])),
    semanticPacksByRef: new Map([[packRefKey(packRef(pack)), pack]]),
    semanticLensesByRef: new Map(lenses.map((lens) => [lensRefKey(lensRef(lens)), lens])),
    detectorImplementationsByRef: new Map(
      implementations.map((implementation) => [detectorRefKey(implementation.detector), implementation]),
    ),
    registryRevision: receipt.registryRevision,
  };
  return {
    harness,
    detectors,
    lenses,
    registry,
    pack,
    calls,
    learning,
    store,
    context,
    episodeRecordId: `${harness.source.id}/${label}-episode`,
  };
}

describe("detector pack selection, planning, and explicit dispositions", () => {
  it("selects every exact detector/compatible-lens pair in stable order", async () => {
    const fixture = await packFixture({ detectorCount: 2, lensCount: 2, label: "selection" });
    const input: DetectorPackRunInput = {
      mode: "dry_run",
      pack: packRef(fixture.pack),
      scope: fixture.harness.scope,
      episodeRecordIds: [fixture.episodeRecordId],
    };
    const result: DetectorPackRunResult = await fixture.learning.runDetectorPack(input);
    const dispositions: DetectorOrchestrationDisposition[] = result.items.map((item) => item.disposition);
    expect(result.status).toBe("completed");
    expect(result.items).toHaveLength(4);
    expect(result.items.map((item) => `${item.detector.id}/${item.lens?.id}`)).toEqual([
      "pack-detector-0000/pack-lens-000",
      "pack-detector-0000/pack-lens-001",
      "pack-detector-0001/pack-lens-000",
      "pack-detector-0001/pack-lens-001",
    ]);
    expect(dispositions.every((disposition) => disposition === "executed")).toBe(true);
  });

  it("uses protocol code-unit order for Unicode detector/lens admission", async () => {
    const fixture = await packFixture({
      detectorCount: 2,
      detectorIds: ["pack.detector.é", "pack.detector.z"],
      lensCount: 2,
      lensIds: ["pack.lens.é", "pack.lens.z"],
      label: "unicode-order",
    });
    const result = await fixture.learning.runDetectorPack({
      mode: "dry_run",
      pack: packRef(fixture.pack),
      scope: fixture.harness.scope,
      episodeRecordIds: [fixture.episodeRecordId],
    });
    expect(result.items.map((item) => `${item.detector.id}/${item.lens?.id}`)).toEqual([
      "pack.detector.z/pack.lens.z",
      "pack.detector.z/pack.lens.é",
      "pack.detector.é/pack.lens.z",
      "pack.detector.é/pack.lens.é",
    ]);
  });

  it("represents unavailable/non-applicable/incomplete children explicitly and never exposes utility/provider fields", async () => {
    const fixture = await packFixture({ detectorCount: 3, implementationCount: 2, label: "explicit" });
    const result = await fixture.learning.runDetectorPack({
      mode: "dry_run",
      pack: packRef(fixture.pack),
      scope: SEMANTIC_SCOPE_B,
      episodeRecordIds: [fixture.episodeRecordId],
    });
    expect(result.items).toHaveLength(3);
    expect(result.items.every((item) => item.disposition === "not_applicable")).toBe(true);
    expect([...fixture.calls.values()].reduce((sum, count) => sum + count, 0)).toBe(0);
    const serialized = JSON.stringify(result);
    for (const forbidden of ["candidate", "provider", "improved", "efficient", "preference", "efficacy"]) {
      expect(serialized).not.toContain(`"${forbidden}"`);
    }
  });

  it("caps every selection beyond 100 with no callback and no silent truncation", async () => {
    const fixture = await packFixture({ detectorCount: 101, label: "invocation-cap" });
    const result = await fixture.learning.runDetectorPack({
      mode: "dry_run",
      pack: packRef(fixture.pack),
      scope: fixture.harness.scope,
      episodeRecordIds: [fixture.episodeRecordId],
    });
    expect(result.items).toHaveLength(101);
    expect(result.items.filter((item) => item.disposition === "executed")).toHaveLength(100);
    expect(result.items.filter((item) => item.disposition === "capped")).toHaveLength(1);
    expect(result.items.filter((item) => item.callbackInvoked)).toHaveLength(100);
    expect(result.items.at(-1)).toMatchObject({ disposition: "capped", callbackInvoked: false });
    expect([...fixture.calls.values()].reduce((sum, count) => sum + count, 0)).toBe(100);
  });

  it("fails over 5,000 considered detector/lens pairs before any callback", async () => {
    const fixture = await packFixture({ detectorCount: 71, lensCount: 71, label: "considered-cap" });
    await expect(
      fixture.learning.runDetectorPack({
        mode: "dry_run",
        pack: packRef(fixture.pack),
        scope: fixture.harness.scope,
        episodeRecordIds: [fixture.episodeRecordId],
      }),
    ).rejects.toMatchObject({ code: "detector.limit_exceeded" });
    expect([...fixture.calls.values()].reduce((sum, count) => sum + count, 0)).toBe(0);
  });

  it("parses exact selected-pack input and enforces sorted unique episode bounds before callbacks", async () => {
    const fixture = await packFixture({ detectorCount: 1, label: "input-bounds" });
    const mode: "dry_run" = "dry_run";
    const base = {
      mode,
      pack: packRef(fixture.pack),
      scope: fixture.harness.scope,
    };
    for (const episodeRecordIds of [
      ["source/z", "source/a"],
      [fixture.episodeRecordId, fixture.episodeRecordId],
    ]) {
      await expect(
        invokePackUnknown(fixture.learning.runDetectorPack, { ...base, episodeRecordIds }),
      ).rejects.toMatchObject({
        code: "schema.invalid",
      });
    }
    await expect(
      invokePackUnknown(fixture.learning.runDetectorPack, {
        ...base,
        episodeRecordIds: Array.from({ length: 501 }, (_, index) => `source/${String(index).padStart(3, "0")}`),
      }),
    ).rejects.toMatchObject({ code: "detector.limit_exceeded" });
    await expect(
      invokePackUnknown(fixture.learning.runDetectorPack, {
        ...base,
        pack: { ...base.pack, manifestDigest: "f".repeat(64) },
        episodeRecordIds: [fixture.episodeRecordId],
      }),
    ).rejects.toMatchObject({ code: "detector.input_invalid" });

    const bounded = await fixture.learning.runDetectorPack({
      ...base,
      episodeRecordIds: Array.from({ length: 500 }, (_, index) => `missing-source/${String(index).padStart(3, "0")}`),
    });
    expect(bounded.items).toHaveLength(1);
    expect(bounded.items[0]).toMatchObject({ disposition: "not_applicable", result: { callbackInvoked: false } });
    expect([...fixture.calls.values()].reduce((sum, count) => sum + count, 0)).toBe(0);
  });

  it("treats a missing exact selected lens registration as fatal store corruption", async () => {
    const fixture = await packFixture({ detectorCount: 1, label: "missing-compatible-lens" });
    const missingLensContext: EngineContext = { ...fixture.context, semanticLensesByRef: new Map() };
    await expect(
      runDetectorPack(missingLensContext, {
        mode: "dry_run",
        pack: packRef(fixture.pack),
        scope: fixture.harness.scope,
        episodeRecordIds: [fixture.episodeRecordId],
      }),
    ).rejects.toMatchObject({ code: "store.corrupt" });
    expect([...fixture.calls.values()].reduce((sum, count) => sum + count, 0)).toBe(0);
  });

  it("emits an explicit non-application when a selected target pack has no compatible lens", async () => {
    const fixture = await zeroCompatibleTargetPackFixture();
    const result = await fixture.learning.runDetectorPack({
      mode: "dry_run",
      pack: packRef(fixture.targetPack),
      scope: fixture.harness.scope,
      episodeRecordIds: [fixture.episodeRecordId],
    });
    expect(result.status).toBe("completed");
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      detector: detectorRef(fixture.detector),
      lens: null,
      disposition: "not_applicable",
      callbackInvoked: false,
    });
    expect(result.items[0]?.result).toBeUndefined();
    expect(fixture.callbacks()).toBe(0);
  });
});

describe("pack dry-run/commit exactness and aggregate caps", () => {
  it("records that a refused callback was attempted while continuing to represent later children", async () => {
    const fixture = await packFixture({
      detectorCount: 2,
      label: "callback-refused",
      evaluate: (detector) => {
        if (detector.id === "pack-detector-0000") throw new Error("detector callback refused");
        return { conditionDetected: false, insights: [], findings: [] };
      },
    });
    const result = await fixture.learning.runDetectorPack({
      mode: "dry_run",
      pack: packRef(fixture.pack),
      scope: fixture.harness.scope,
      episodeRecordIds: [fixture.episodeRecordId],
    });
    expect(result.status).toBe("partial");
    expect(result.items).toMatchObject([
      { disposition: "refused", callbackInvoked: true, diagnostics: [{ code: "detector.callback_failed" }] },
      { disposition: "executed", callbackInvoked: true },
    ]);
  });

  it("keeps dry-run zero-write and commit persists exact planned child bytes without callback rerun", async () => {
    const recorded = recordingStore(createInMemoryStore());
    const fixture = await packFixture({ detectorCount: 2, store: recorded.store, label: "dry-commit" });
    recorded.writes.length = 0;
    const input = {
      pack: packRef(fixture.pack),
      scope: fixture.harness.scope,
      episodeRecordIds: [fixture.episodeRecordId],
    };
    const dry = await fixture.learning.runDetectorPack({ mode: "dry_run", ...input });
    expect(recorded.writes).toEqual([]);
    expect([...fixture.calls.values()].reduce((sum, count) => sum + count, 0)).toBe(2);
    const committed = await fixture.learning.runDetectorPack({ mode: "commit", ...input });
    expect([...fixture.calls.values()].reduce((sum, count) => sum + count, 0)).toBe(4);
    expect(committed.items.map((item) => item.result?.execution)).toEqual(
      dry.items.map((item) => item.result?.execution),
    );
    expect(committed.items.every((item) => item.result?.persistence === "committed")).toBe(true);
    expect(
      (await fixture.store.list({ namespace: "learning", kind: "detector-execution", limit: 10 })).records,
    ).toHaveLength(2);
  });

  it("caps later children without callback after the aggregate 100-output budget is exhausted", async () => {
    const fixture = await packFixture({
      detectorCount: 2,
      label: "output-cap",
      evaluate: (detector, window) => ({
        conditionDetected: true,
        insights:
          detector.id === "pack-detector-0000"
            ? Array.from({ length: 100 }, (_, index) => insightDraft(window, index))
            : [insightDraft(window, 100)],
        findings: [],
      }),
    });
    const result = await fixture.learning.runDetectorPack({
      mode: "dry_run",
      pack: packRef(fixture.pack),
      scope: fixture.harness.scope,
      episodeRecordIds: [fixture.episodeRecordId],
    });
    expect(result.items).toHaveLength(2);
    expect(result.items[0]).toMatchObject({ disposition: "executed", result: { derivations: { length: 100 } } });
    expect(result.items[0]?.callbackInvoked).toBe(true);
    expect(result.items[1]).toMatchObject({ disposition: "capped", callbackInvoked: false });
    expect(fixture.calls.get("pack-detector-0000")).toBe(1);
    expect(fixture.calls.get("pack-detector-0001") ?? 0).toBe(0);
  });

  it("counts distinct content-addressed output ids rather than duplicate references toward the output ceiling", async () => {
    const fixture = await packFixture({
      detectorCount: 4,
      detectorOutputKind: "evidence_health",
      label: "distinct-output-cap",
      evaluate: (detector, window) => {
        const findings =
          detector.id === "pack-detector-0000" || detector.id === "pack-detector-0001"
            ? Array.from({ length: 99 }, (_, index) => healthFindingDraft(window, index + 1))
            : [healthFindingDraft(window, detector.id === "pack-detector-0002" ? 100 : 101)];
        return { conditionDetected: true, insights: [], findings };
      },
    });
    const result = await fixture.learning.runDetectorPack({
      mode: "dry_run",
      pack: packRef(fixture.pack),
      scope: fixture.harness.scope,
      episodeRecordIds: [fixture.episodeRecordId],
    });
    expect(result.items.map((item) => item.disposition)).toEqual(["executed", "executed", "executed", "capped"]);
    expect(result.items.map((item) => item.callbackInvoked)).toEqual([true, true, true, false]);
    const firstIds =
      result.items[0]?.result?.execution?.result.status === "applied"
        ? result.items[0].result.execution.result.evidenceHealthFindings.map((finding) => finding.id)
        : [];
    const duplicateIds =
      result.items[1]?.result?.execution?.result.status === "applied"
        ? result.items[1].result.execution.result.evidenceHealthFindings.map((finding) => finding.id)
        : [];
    expect(firstIds).toHaveLength(99);
    expect(duplicateIds).toEqual(firstIds);
    expect(result.items[2]?.result?.execution?.result).toMatchObject({ evidenceHealthFindings: [{}] });
    expect(result.items[3]?.result).toBeUndefined();
  });

  it("caps an over-budget child atomically after its callback and does not invoke later children", async () => {
    const fixture = await packFixture({
      detectorCount: 3,
      label: "atomic-output-cap",
      evaluate: (detector, window) => {
        const count = detector.id === "pack-detector-0000" ? 99 : detector.id === "pack-detector-0001" ? 2 : 1;
        return {
          conditionDetected: true,
          insights: Array.from({ length: count }, (_, index) => insightDraft(window, index)),
          findings: [],
        };
      },
    });
    const result = await fixture.learning.runDetectorPack({
      mode: "dry_run",
      pack: packRef(fixture.pack),
      scope: fixture.harness.scope,
      episodeRecordIds: [fixture.episodeRecordId],
    });
    expect(result.items.map((item) => item.disposition)).toEqual(["executed", "capped", "capped"]);
    expect(result.items.map((item) => item.callbackInvoked)).toEqual([true, true, false]);
    expect(result.items[0]?.result?.derivations).toHaveLength(99);
    expect(result.items[1]?.result).toBeUndefined();
    expect(result.items[2]?.result).toBeUndefined();
    expect(fixture.calls.get("pack-detector-0000")).toBe(1);
    expect(fixture.calls.get("pack-detector-0001")).toBe(1);
    expect(fixture.calls.get("pack-detector-0002") ?? 0).toBe(0);
  });

  it("caps a child atomically at the 64 MiB retained-result ceiling and does not invoke later children", async () => {
    const payload = "x".repeat(Math.floor(12.9 * 1_048_576));
    const fixture = await packFixture({
      detectorCount: 6,
      label: "retained-byte-cap",
      evaluate: (detector, window) => {
        const draft = insightDraft(window, Number.parseInt(detector.id.slice(-4), 10));
        return {
          conditionDetected: true,
          insights: [
            {
              ...draft,
              directObservation: {
                ...draft.directObservation,
                data: { payload },
              },
            },
          ],
          findings: [],
        };
      },
    });
    const result = await fixture.learning.runDetectorPack({
      mode: "dry_run",
      pack: packRef(fixture.pack),
      scope: fixture.harness.scope,
      episodeRecordIds: [fixture.episodeRecordId],
    });
    expect(result.items.map((item) => item.disposition)).toEqual([
      "executed",
      "executed",
      "executed",
      "executed",
      "capped",
      "capped",
    ]);
    expect(result.items.map((item) => item.callbackInvoked)).toEqual([true, true, true, true, true, false]);
    expect(result.items[4]?.result).toBeUndefined();
    expect(result.items[5]?.result).toBeUndefined();
  }, 30_000);

  it("refuses the whole plan without writes when exact semantic inputs change during planning", async () => {
    const store = createInMemoryStore();
    let changed = false;
    const fixture = await packFixture({
      detectorCount: 2,
      store,
      label: "pack-snapshot",
      evaluate: () => {
        if (!changed) {
          changed = true;
          const marker = toJsonValue({ marker: "semantic input changed" });
          void store.create(
            { namespace: "learning", kind: "detector-pack-test-marker", id: "changed" },
            marker,
            sha256HexOfCanonicalJson(marker),
            "detector-pack-test-marker/changed",
          );
        }
        return { conditionDetected: false, insights: [], findings: [] };
      },
    });
    const result = await fixture.learning.runDetectorPack({
      mode: "commit",
      pack: packRef(fixture.pack),
      scope: fixture.harness.scope,
      episodeRecordIds: [fixture.episodeRecordId],
    });
    expect(result.status).toBe("partial");
    expect(result.items).toHaveLength(2);
    expect(result.items.every((item) => item.disposition === "refused")).toBe(true);
    expect(result.items.map((item) => item.callbackInvoked)).toEqual([true, true]);
    expect(result.items.every((item) => item.diagnostics[0]?.code === "detector.pack_snapshot_changed")).toBe(true);
    expect((await store.list({ namespace: "learning", kind: "detector-execution", limit: 10 })).records).toEqual([]);
  });

  it("rethrows store.corrupt during planning and never commits a later peer", async () => {
    const base = createInMemoryStore();
    const corrupted = corruptSecondObservationListingStore(base);
    const fixture = await packFixture({ detectorCount: 2, store: corrupted.store, label: "store-corrupt" });
    corrupted.enable();
    await expect(
      fixture.learning.runDetectorPack({
        mode: "commit",
        pack: packRef(fixture.pack),
        scope: fixture.harness.scope,
        episodeRecordIds: [fixture.episodeRecordId],
      }),
    ).rejects.toMatchObject({ code: "store.corrupt" });
    expect([...fixture.calls.values()].reduce((sum, count) => sum + count, 0)).toBe(0);
    expect((await base.list({ namespace: "learning", kind: "detector-execution", limit: 10 })).records).toEqual([]);
  });

  it("retains sequential commit successes and emits explicit refused items for later failures", async () => {
    const base = createInMemoryStore();
    let executionCreates = 0;
    const failing: LearningStore = {
      get: (key) => base.get(key),
      create: (key, value, digest, operationId) => {
        if (key.kind === "detector-execution") {
          executionCreates += 1;
          if (executionCreates === 2) throw new Error("second detector receipt refused");
        }
        return base.create(key, value, digest, operationId);
      },
      compareAndSet: (key, expectedRevision, value, digest, operationId) =>
        base.compareAndSet(key, expectedRevision, value, digest, operationId),
      append: (stream, expectedRevision, entries, operationId) =>
        base.append(stream, expectedRevision, entries, operationId),
      tombstone: (input) => base.tombstone(input),
      list: (query) => base.list(query),
    };
    const fixture = await packFixture({ detectorCount: 2, store: failing, label: "partial-commit" });
    const result = await fixture.learning.runDetectorPack({
      mode: "commit",
      pack: packRef(fixture.pack),
      scope: fixture.harness.scope,
      episodeRecordIds: [fixture.episodeRecordId],
    });
    expect(result.status).toBe("partial");
    expect(result.items.map((item) => item.disposition)).toEqual(["executed", "refused"]);
    expect(result.items.map((item) => item.callbackInvoked)).toEqual([true, true]);
    expect(result.items).toHaveLength(2);
    expect((await base.list({ namespace: "learning", kind: "detector-execution", limit: 10 })).records).toHaveLength(1);
  });

  it("keeps existing non-application disposition status-first and normalizes commit mode without execution", async () => {
    const incomplete = await packFixture({
      detectorCount: 1,
      label: "existing-incomplete",
      implementationCount: 0,
    });
    const incompleteInput = {
      pack: packRef(incomplete.pack),
      scope: incomplete.harness.scope,
      episodeRecordIds: [incomplete.episodeRecordId],
    };
    await incomplete.learning.runDetectorPack({ mode: "commit", ...incompleteInput });
    const existing = await incomplete.learning.runDetectorPack({ mode: "commit", ...incompleteInput });
    expect(existing.items[0]).toMatchObject({
      disposition: "incomplete",
      callbackInvoked: false,
      result: { status: "incomplete", persistence: "existing", mode: "commit" },
    });

    const unbindable = await packFixture({ detectorCount: 1, label: "commit-no-execution" });
    const result = await unbindable.learning.runDetectorPack({
      mode: "commit",
      pack: packRef(unbindable.pack),
      scope: SEMANTIC_SCOPE_B,
      episodeRecordIds: [unbindable.episodeRecordId],
    });
    expect(result.items[0]).toMatchObject({
      disposition: "not_applicable",
      callbackInvoked: false,
      result: { mode: "commit", status: "not_applicable", persistence: "none", callbackInvoked: false },
    });
  });

  it("keeps historical applied-positive receipts without a decision binding read-only during runner and pack refresh", async () => {
    const harness = await createRecurrenceRunnerHarness({
      label: "pack-historical-unbound",
      evaluate: (window) => detectedInsightDraft(window, PRIVATE_LOCATOR),
    });
    const projected = await harness.learning.runDetector(recurrenceRunInput(harness, "dry_run"));
    if (projected.execution === undefined) throw new Error("expected projected historical execution");
    await persistDetectorExecution(harness.context, projected.execution, projected.derivations);
    expect(
      (await harness.store.list({ namespace: "learning", kind: "detector-recurrence-binding", limit: 10 })).records,
    ).toEqual([]);

    const existing = await harness.learning.runDetector(recurrenceRunInput(harness, "commit"));
    expect(existing).toMatchObject({
      persistence: "existing",
      callbackInvoked: false,
      recurrence: { status: "locator_unavailable" },
    });
    const packResult = await harness.learning.runDetectorPack({
      mode: "commit",
      pack: packRef(harness.pack),
      scope: harness.scope,
      episodeRecordIds: harness.episodeRecordIds,
    });
    expect(packResult.items[0]).toMatchObject({
      disposition: "existing",
      callbackInvoked: false,
      result: { persistence: "existing", recurrence: { status: "locator_unavailable" } },
    });
    expect(
      (await harness.store.list({ namespace: "learning", kind: "detector-recurrence-binding", limit: 10 })).records,
    ).toEqual([]);
    expect(
      (await harness.store.list({ namespace: "learning", kind: "detector-recurrence-group", limit: 10 })).records,
    ).toEqual([]);
    expect(harness.callbacks()).toBe(1);
  });
});
