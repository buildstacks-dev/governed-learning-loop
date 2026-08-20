// #30c1 exact deterministic detector runner: kernel-owned eligibility,
// provider-neutral frozen windows, unknown output parsing, and zero-write dry runs.
import { describe, expect, it } from "vitest";
import type { DetectorResultDraft, DetectorRunInput, DetectorWindow, LearningStore } from "../src/index.js";
import {
  conservativePolicy,
  createLearningLoop,
  defineDetectorImplementation,
  scopeDigest,
  sha256HexOfCanonicalJson,
  toJsonValue,
} from "../src/index.js";
import { createInMemoryStore } from "../src/testing/index.js";
import type { SemanticEngineHarness } from "./semantic-engine-harness.js";
import { SEMANTIC_SCOPE_B, createSemanticEngineHarness } from "./semantic-engine-harness.js";

function opaqueThenable(): object {
  const key = ["th", "en"].join("");
  return Object.defineProperty({}, key, { value: () => undefined, enumerable: true });
}

function detectorRef(harness: SemanticEngineHarness) {
  return {
    id: harness.detector.id,
    version: harness.detector.version,
    registrationDigest: harness.detector.registrationDigest,
  };
}

function packRef(harness: SemanticEngineHarness) {
  return { id: harness.pack.id, version: harness.pack.version, manifestDigest: harness.pack.manifestDigest };
}

function lensRef(harness: SemanticEngineHarness) {
  return { id: harness.lens.id, version: harness.lens.version, registrationDigest: harness.lens.registrationDigest };
}

function runInput(
  harness: SemanticEngineHarness,
  mode: DetectorRunInput["mode"],
  episodeRecordIds: readonly string[],
): DetectorRunInput {
  return {
    mode,
    detector: detectorRef(harness),
    pack: packRef(harness),
    lens: harness.detector.outputKind === "insight_derivation" ? lensRef(harness) : null,
    scope: harness.scope,
    episodeRecordIds,
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

function toggledSnapshotStore(base: LearningStore) {
  let hidden = false;
  const store: LearningStore = {
    get: (key) => (hidden && key.kind === "semantic-registry-snapshot" ? Promise.resolve(undefined) : base.get(key)),
    create: (key, value, digest, operationId) => base.create(key, value, digest, operationId),
    compareAndSet: (key, expectedRevision, value, digest, operationId) =>
      base.compareAndSet(key, expectedRevision, value, digest, operationId),
    append: (stream, expectedRevision, entries, operationId) =>
      base.append(stream, expectedRevision, entries, operationId),
    tombstone: (input) => base.tombstone(input),
    list: (query) => base.list(query),
  };
  return { store, hide: () => (hidden = true) };
}

async function createRunnerFixture(input: {
  readonly evaluate?: (window: DetectorWindow) => unknown;
  readonly implementation?: boolean;
  readonly harnessOptions?: Parameters<typeof createSemanticEngineHarness>[0];
  readonly store?: LearningStore;
  readonly label?: string;
}) {
  const harness = await createSemanticEngineHarness(input.harnessOptions ?? {});
  const implementation =
    input.implementation === false
      ? undefined
      : defineDetectorImplementation({
          registration: harness.detector,
          evaluate: input.evaluate ?? (() => ({ conditionDetected: false, insights: [], findings: [] })),
        });
  const store = input.store ?? createInMemoryStore();
  const learning = createLearningLoop({
    store,
    policy: conservativePolicy(),
    identity: harness.context.identity,
    scopePolicy: harness.context.scopePolicy,
    contentPolicies: [...harness.context.contentPoliciesById.values()],
    sources: [...harness.context.sources],
    semanticRegistry: harness.registry,
    ...(implementation === undefined ? {} : { detectorImplementations: [implementation] }),
    queryCursorScope: `detector-runner-${input.label ?? "fixture"}`,
  });
  const label = input.label ?? "runner";
  await learning.ingest(harness.source, {
    observations: [
      {
        id: `${label}-observation`,
        episodeId: `${label}-episode`,
        kind: "tool.process.completed",
        data: { commandClass: "verify", exitCode: 1, activityCount: 500 },
      },
    ],
    episodes: [
      {
        id: `${label}-episode`,
        episodeClass: "interactive",
        scope: harness.scope,
        openedAt: "2026-08-20T01:00:00.000Z",
        closedAt: "2026-08-20T01:01:00.000Z",
      },
    ],
  });
  return {
    harness,
    implementation,
    learning,
    store,
    episodeRecordId: `${harness.source.id}/${label}-episode`,
  };
}

function insightDraft(window: DetectorWindow, label = "one"): DetectorResultDraft["insights"][number] {
  const evidence = window.evidence[0]?.reference.referenceDigest;
  return {
    learningClass: "system_meta",
    directObservation: {
      statement: "A deterministic verification condition was detected.",
      data: { condition: "verification", label },
      evidenceReferenceDigests: evidence === undefined ? [] : [evidence],
    },
    interpretation: {
      statement: "The condition may indicate avoidable verification friction.",
      confidence: "medium",
      uncertainty: ["Causal impact remains unvalidated."],
    },
    impactHypothesis: { statement: "A verifier step may reduce incomplete attempts." },
    contradictoryEvidenceReferenceDigests: [],
    evidenceHealthFindingIds: [],
    missingEvidence: [],
    applicability: { statement: "Applies only to this exact scope.", exclusions: ["benchmark traffic"] },
    candidateIntervention: {
      summary: "Run the verifier before completion.",
      proposedDestinationKind: "report-note",
      proposedDestinationId: "host/semantic-note",
      contentDraft: { action: "verify" },
      rollbackIntent: "Remove the unvalidated draft.",
    },
    validation: {
      method: "comparable-held-out-episodes",
      comparablePopulation: null,
      comparablePopulationDigest: null,
      successCriterion: "Verifier-backed completion increases.",
      guardrails: ["Do not suppress valid failures."],
      strategyDigest: sha256HexOfCanonicalJson(toJsonValue({ method: "held-out-comparable-episodes" })),
    },
    supersedes: null,
  };
}

async function kernelRecordCounts(store: LearningStore): Promise<Readonly<Record<string, number>>> {
  const result: Record<string, number> = {};
  for (const kind of [
    "semantic-registry-snapshot",
    "evidence-health",
    "derivation-execution",
    "insight-derivation",
    "detector-execution",
    "candidate",
    "review",
  ]) {
    result[kind] = (await store.list({ namespace: "learning", kind, limit: 1_000 })).records.length;
  }
  return result;
}

describe("DetectorWindow and kernel-owned preflight", () => {
  it("passes a deeply frozen provider-neutral exact window and does not infer harm from high counts", async () => {
    let captured: DetectorWindow | undefined;
    const fixture = await createRunnerFixture({
      evaluate: (window) => {
        captured = window;
        expect(Object.isFrozen(window)).toBe(true);
        expect(Object.isFrozen(window.population.episodes)).toBe(true);
        expect(Object.isFrozen(window.evidence)).toBe(true);
        expect(Reflect.set(window, "scope", SEMANTIC_SCOPE_B)).toBe(false);
        expect("store" in window).toBe(false);
        expect("source" in window).toBe(false);
        expect("provider" in window).toBe(false);
        return { conditionDetected: false, insights: [], findings: [] };
      },
    });
    const result = await fixture.learning.runDetector(runInput(fixture.harness, "dry_run", [fixture.episodeRecordId]));
    expect(result).toMatchObject({
      mode: "dry_run",
      status: "applied",
      persistence: "none",
      callbackInvoked: true,
      execution: { result: { status: "applied", conditionDetected: false } },
    });
    expect(captured).toMatchObject({
      schemaVersion: 1,
      scope: fixture.harness.scope,
      population: { episodes: [{ view: { episode: { id: fixture.episodeRecordId } } }] },
      evidence: [{ kind: "observation", record: { kind: "tool.process.completed" } }],
      availableCapabilities: ["operation.state"],
    });
  });

  it("does not invoke callbacks for empty, missing implementation/capability, scope, class, trust, or event evidence", async () => {
    const cases = [
      { name: "empty", options: {}, ids: [] as readonly string[], expected: "not_applicable" },
      { name: "missing-implementation", options: {}, implementation: false, expected: "incomplete" },
      {
        name: "missing-capability",
        options: { detectorRequiredCapabilities: ["missing.capability"] },
        expected: "not_applicable",
      },
      {
        name: "scope",
        options: {
          detectorScopeConstraint: {
            mode: "exact" as const,
            scopes: [{ scope: SEMANTIC_SCOPE_B, scopeDigest: scopeDigest(SEMANTIC_SCOPE_B) }],
          },
        },
        expected: "not_applicable",
      },
      {
        name: "class",
        options: { detectorEpisodeClasses: { mode: "include" as const, values: ["automation"] } },
        expected: "not_applicable",
      },
      { name: "trust", options: { detectorMinimumTrust: "verified" as const }, expected: "incomplete" },
      {
        name: "no-events",
        options: { detectorAcceptedObservationKinds: ["operation.other"] },
        expected: "incomplete",
      },
    ];
    for (const fixtureCase of cases) {
      let calls = 0;
      const fixture = await createRunnerFixture({
        label: `preflight-${fixtureCase.name}`,
        ...(fixtureCase.implementation === undefined ? {} : { implementation: fixtureCase.implementation }),
        harnessOptions: fixtureCase.options,
        evaluate: () => {
          calls += 1;
          return { conditionDetected: false, insights: [], findings: [] };
        },
      });
      const ids = fixtureCase.ids ?? [fixture.episodeRecordId];
      const before = await kernelRecordCounts(fixture.store);
      const result = await fixture.learning.runDetector(runInput(fixture.harness, "dry_run", ids));
      expect(result.status, fixtureCase.name).toBe(fixtureCase.expected);
      expect(result.callbackInvoked, fixtureCase.name).toBe(false);
      expect(calls, fixtureCase.name).toBe(0);
      if (fixtureCase.name !== "empty" && fixtureCase.name !== "scope" && fixtureCase.name !== "class") {
        expect(result.execution?.result.status, fixtureCase.name).toBe(fixtureCase.expected);
      }
      expect(await kernelRecordCounts(fixture.store), fixtureCase.name).toEqual(before);
    }
  });

  it("keeps a nonempty episode-only window callback-eligible without event evidence", async () => {
    let calls = 0;
    const fixture = await createRunnerFixture({
      harnessOptions: {
        lensEvidenceKind: "episode",
        detectorAcceptedObservationKinds: ["operation.other"],
      },
      evaluate: (window) => {
        calls += 1;
        return { conditionDetected: true, insights: [insightDraft(window)], findings: [] };
      },
    });
    const result = await fixture.learning.runDetector(runInput(fixture.harness, "dry_run", [fixture.episodeRecordId]));
    expect(calls).toBe(1);
    expect(result).toMatchObject({ status: "applied", callbackInvoked: true, derivations: [{}] });
    expect(result.execution?.window.evidenceRefs).toEqual([]);
  });

  it("commits a bindable kernel-owned non-application fact without invoking callback", async () => {
    let calls = 0;
    const fixture = await createRunnerFixture({
      harnessOptions: { detectorRequiredCapabilities: ["missing.capability"] },
      evaluate: () => {
        calls += 1;
        return { conditionDetected: false, insights: [], findings: [] };
      },
    });
    const result = await fixture.learning.runDetector(runInput(fixture.harness, "commit", [fixture.episodeRecordId]));
    expect(result).toMatchObject({
      status: "not_applicable",
      persistence: "committed",
      callbackInvoked: false,
      execution: { result: { status: "not_applicable", missingCapabilities: ["missing.capability"] } },
    });
    expect(calls).toBe(0);
    expect(
      (await fixture.store.list({ namespace: "learning", kind: "detector-execution", limit: 10 })).records,
    ).toHaveLength(1);
  });

  it("rejects foreign detector/pack/lens selection and duplicate/unsorted episode ids before callback", async () => {
    let calls = 0;
    const fixture = await createRunnerFixture({
      evaluate: () => {
        calls += 1;
        return { conditionDetected: false, insights: [], findings: [] };
      },
    });
    const base = runInput(fixture.harness, "dry_run", [fixture.episodeRecordId]);
    for (const input of [
      { ...base, detector: { ...base.detector, registrationDigest: "0".repeat(64) } },
      { ...base, pack: { ...base.pack, manifestDigest: "0".repeat(64) } },
      { ...base, lens: null },
      { ...base, episodeRecordIds: [fixture.episodeRecordId, fixture.episodeRecordId] },
    ]) {
      await expect(fixture.learning.runDetector(input)).rejects.toMatchObject({
        code: expect.stringMatching(/^(detector|schema)\./),
      });
    }
    expect(calls).toBe(0);
  });
});

describe("detector applied output, dry-run, persistence, and callback refusal", () => {
  it("keeps dry-run zero-write, commit reruns exact bytes, and existing commit skips callback", async () => {
    const recorded = recordingStore(createInMemoryStore());
    let calls = 0;
    const fixture = await createRunnerFixture({
      store: recorded.store,
      evaluate: () => {
        calls += 1;
        return { conditionDetected: false, insights: [], findings: [] };
      },
    });
    recorded.writes.length = 0;
    const dry = await fixture.learning.runDetector(runInput(fixture.harness, "dry_run", [fixture.episodeRecordId]));
    expect(recorded.writes).toEqual([]);
    expect(await kernelRecordCounts(fixture.store)).toEqual({
      "semantic-registry-snapshot": 0,
      "evidence-health": 0,
      "derivation-execution": 0,
      "insight-derivation": 0,
      "detector-execution": 0,
      candidate: 0,
      review: 0,
    });
    const committed = await fixture.learning.runDetector(
      runInput(fixture.harness, "commit", [fixture.episodeRecordId]),
    );
    expect(calls).toBe(2);
    expect(committed).toMatchObject({ persistence: "committed", callbackInvoked: true });
    expect(committed.execution).toEqual(dry.execution);
    const existing = await fixture.learning.runDetector(runInput(fixture.harness, "commit", [fixture.episodeRecordId]));
    expect(existing).toMatchObject({ persistence: "existing", callbackInvoked: false });
    expect(calls).toBe(2);
    expect(await kernelRecordCounts(fixture.store)).toMatchObject({
      "semantic-registry-snapshot": 1,
      "detector-execution": 1,
      candidate: 0,
      review: 0,
    });
  });

  it("assembles and commits exact insight lineage without creating a Candidate", async () => {
    const fixture = await createRunnerFixture({
      evaluate: (window) => ({ conditionDetected: true, insights: [insightDraft(window)], findings: [] }),
    });
    const result = await fixture.learning.runDetector(runInput(fixture.harness, "commit", [fixture.episodeRecordId]));
    expect(result).toMatchObject({
      status: "applied",
      persistence: "committed",
      callbackInvoked: true,
      execution: { result: { conditionDetected: true, derivationRefs: [{}] } },
      derivations: [{ producer: { kind: "deterministic" } }],
    });
    expect((await fixture.store.list({ namespace: "learning", kind: "candidate", limit: 10 })).records).toEqual([]);
    const view = await fixture.learning.getInsightDerivation({
      derivationId: result.derivations[0]?.id ?? "missing",
      scope: fixture.harness.scope,
    });
    expect(view).toMatchObject({ commitBinding: { status: "committed" } });
  });

  it("preserves callback draft order across multiple distinct derivations", async () => {
    const fixture = await createRunnerFixture({
      label: "multi-output",
      evaluate: (window) => ({
        conditionDetected: true,
        insights: [insightDraft(window, "first"), insightDraft(window, "second")],
        findings: [],
      }),
    });
    const result = await fixture.learning.runDetector(runInput(fixture.harness, "commit", [fixture.episodeRecordId]));
    expect(result.derivations.map((derivation) => derivation.directObservation.data)).toEqual([
      { condition: "verification", label: "first" },
      { condition: "verification", label: "second" },
    ]);
    expect(
      result.execution?.result.status === "applied"
        ? result.execution.result.derivationRefs.map((reference) => reference.id)
        : [],
    ).toEqual(result.derivations.map((derivation) => derivation.id));
  });

  it("snapshots callback-owned output getters exactly once before parsing", async () => {
    const reads = { condition: 0, insights: 0, findings: 0 };
    const fixture = await createRunnerFixture({
      label: "output-getters",
      evaluate: () => ({
        get conditionDetected() {
          reads.condition += 1;
          return reads.condition !== 1;
        },
        get insights() {
          reads.insights += 1;
          return [];
        },
        get findings() {
          reads.findings += 1;
          return [];
        },
      }),
    });
    const result = await fixture.learning.runDetector(runInput(fixture.harness, "dry_run", [fixture.episodeRecordId]));
    expect(reads).toEqual({ condition: 1, insights: 1, findings: 1 });
    expect(result.execution?.result).toMatchObject({ status: "applied", conditionDetected: false });
  });

  it("assembles related evidence-health output and refuses unrelated findings", async () => {
    const related = await createRunnerFixture({
      harnessOptions: { detectorOutputKind: "evidence_health" },
      evaluate: (window) => {
        const reference = window.evidence[0]?.reference;
        if (reference === undefined) throw new Error("missing health draft reference");
        return {
          conditionDetected: true,
          insights: [],
          findings: [
            {
              code: "source.partial",
              effect: "limits_claims",
              sourceId: reference.sourceId,
              sourceRegistrationRevision: reference.sourceRegistrationRevision,
              sourceRef: reference.sourceRef,
              pageRef: reference.pageRef,
              completeness: "partial",
              affectedRecords: 1,
            },
          ],
        };
      },
    });
    const result = await related.learning.runDetector(runInput(related.harness, "commit", [related.episodeRecordId]));
    expect(result.execution?.result).toMatchObject({ evidenceHealthFindings: [{}] });

    const unrelated = await createRunnerFixture({
      harnessOptions: { detectorOutputKind: "evidence_health" },
      evaluate: (window) => {
        const reference = window.evidence[0]?.reference;
        if (reference === undefined) throw new Error("missing unrelated finding fixture");
        return {
          conditionDetected: true,
          insights: [],
          findings: [
            {
              code: "source.partial",
              effect: "limits_claims",
              sourceId: reference.sourceId,
              sourceRegistrationRevision: reference.sourceRegistrationRevision,
              sourceRef: "foreign-source-ref",
              pageRef: reference.pageRef,
              completeness: "partial",
              affectedRecords: 1,
            },
          ],
        };
      },
    });
    await expect(
      unrelated.learning.runDetector(runInput(unrelated.harness, "commit", [unrelated.episodeRecordId])),
    ).rejects.toMatchObject({ code: expect.stringMatching(/^semantic\.|^detector\./) });
    expect((await kernelRecordCounts(unrelated.store))["detector-execution"]).toBe(0);
  });

  it("rejects throws, Promise/thenable, malformed, mixed, foreign, and over-cap output atomically", async () => {
    const malformed: readonly {
      readonly name: string;
      readonly evaluate: (window: DetectorWindow) => unknown;
      readonly code: string;
    }[] = [
      {
        name: "throw",
        evaluate: () => {
          throw new Error("PRIVATE-CALLBACK-CANARY");
        },
        code: "detector.callback_failed",
      },
      { name: "promise", evaluate: () => Promise.resolve({}), code: "detector.implementation_invalid" },
      {
        name: "thenable",
        evaluate: opaqueThenable,
        code: "detector.implementation_invalid",
      },
      { name: "null", evaluate: () => null, code: "detector.result_invalid" },
      {
        name: "negative-output",
        evaluate: (window) => ({ conditionDetected: false, insights: [insightDraft(window)], findings: [] }),
        code: "detector.result_invalid",
      },
      {
        name: "mixed",
        evaluate: (window) => ({
          conditionDetected: true,
          insights: [insightDraft(window)],
          findings: [{ code: "source.partial" }],
        }),
        code: "detector.result_invalid",
      },
      {
        name: "foreign-evidence",
        evaluate: (window) => ({
          conditionDetected: true,
          insights: [
            {
              ...insightDraft(window),
              directObservation: {
                ...insightDraft(window).directObservation,
                evidenceReferenceDigests: ["0".repeat(64)],
              },
            },
          ],
          findings: [],
        }),
        code: "detector.result_invalid",
      },
      {
        name: "over-cap",
        evaluate: (window) => ({
          conditionDetected: true,
          insights: Array.from({ length: 101 }, (_, index) => insightDraft(window, String(index))),
          findings: [],
        }),
        code: "detector.result_invalid",
      },
      {
        name: "byte-cap",
        evaluate: (window) => {
          const draft = insightDraft(window, "byte-cap");
          return {
            conditionDetected: true,
            insights: [
              {
                ...draft,
                directObservation: {
                  ...draft.directObservation,
                  data: { oversized: "x".repeat(17 * 1_048_576) },
                },
              },
            ],
            findings: [],
          };
        },
        code: "detector.limit_exceeded",
      },
    ];
    for (const fixtureCase of malformed) {
      const fixture = await createRunnerFixture({
        label: `malformed-${fixtureCase.name}`,
        evaluate: fixtureCase.evaluate,
      });
      await expect(
        fixture.learning.runDetector(runInput(fixture.harness, "commit", [fixture.episodeRecordId])),
      ).rejects.toMatchObject({ code: fixtureCase.code });
      expect((await kernelRecordCounts(fixture.store))["detector-execution"], fixtureCase.name).toBe(0);
    }
  });
});

describe("detector runner ceilings, isolation, TOCTOU, and concurrency", () => {
  it("never treats an existing receipt with a missing registry snapshot as a valid duplicate", async () => {
    const toggled = toggledSnapshotStore(createInMemoryStore());
    const fixture = await createRunnerFixture({ store: toggled.store });
    await fixture.learning.runDetector(runInput(fixture.harness, "commit", [fixture.episodeRecordId]));
    toggled.hide();
    await expect(
      fixture.learning.runDetector(runInput(fixture.harness, "commit", [fixture.episodeRecordId])),
    ).rejects.toMatchObject({ code: expect.stringMatching(/^(detector|semantic|store)\./) });
  });

  it("accepts the 500-episode input ceiling and rejects 501 without callback", async () => {
    let calls = 0;
    const fixture = await createRunnerFixture({
      evaluate: () => {
        calls += 1;
        return { conditionDetected: false, insights: [], findings: [] };
      },
    });
    const within = Array.from(
      { length: 500 },
      (_, index) => `missing-source/episode-${String(index).padStart(3, "0")}`,
    );
    const result = await fixture.learning.runDetector(runInput(fixture.harness, "dry_run", within));
    expect(result.status).toBe("not_applicable");
    expect(calls).toBe(0);
    await expect(
      fixture.learning.runDetector(runInput(fixture.harness, "dry_run", [...within, "missing-source/episode-500"])),
    ).rejects.toMatchObject({ code: "detector.limit_exceeded" });
    expect(calls).toBe(0);
  });

  it("does not expose or execute a foreign-project episode", async () => {
    let calls = 0;
    const fixture = await createRunnerFixture({
      evaluate: () => {
        calls += 1;
        return { conditionDetected: false, insights: [], findings: [] };
      },
    });
    const result = await fixture.learning.runDetector({
      ...runInput(fixture.harness, "dry_run", [fixture.episodeRecordId]),
      scope: SEMANTIC_SCOPE_B,
    });
    expect(result.status).toBe("not_applicable");
    expect(result.callbackInvoked).toBe(false);
    expect(calls).toBe(0);
    expect(JSON.stringify(result)).not.toContain(fixture.episodeRecordId);
  });

  it("refuses commit when evidence changes synchronously inside callback", async () => {
    const base = createInMemoryStore();
    let mutation: (() => void) | undefined;
    const fixture = await createRunnerFixture({
      store: base,
      evaluate: () => {
        mutation?.();
        return { conditionDetected: false, insights: [], findings: [] };
      },
    });
    const stored = await base.get({
      namespace: "learning",
      kind: "observation",
      id: `${fixture.harness.source.id}/runner-observation`,
    });
    if (stored === undefined) throw new Error("missing callback TOCTOU observation");
    mutation = () => {
      const value = toJsonValue(stored.value);
      void base.compareAndSet(stored.key, stored.revision, value, stored.digest, "detector-callback-toctou");
    };
    await expect(
      fixture.learning.runDetector(runInput(fixture.harness, "commit", [fixture.episodeRecordId])),
    ).rejects.toMatchObject({ code: "detector.snapshot_changed" });
    expect((await kernelRecordCounts(base))["detector-execution"]).toBe(0);
  });

  it("concurrent identical commits preserve one exact execution; conflicting results never overwrite", async () => {
    let resultLabel = "same";
    const fixture = await createRunnerFixture({
      evaluate: (window) => ({
        conditionDetected: true,
        insights: [insightDraft(window, resultLabel)],
        findings: [],
      }),
    });
    const input = runInput(fixture.harness, "commit", [fixture.episodeRecordId]);
    const identical = await Promise.all([fixture.learning.runDetector(input), fixture.learning.runDetector(input)]);
    expect(new Set(identical.map((result) => result.execution?.executionDigest)).size).toBe(1);
    expect(
      (await fixture.store.list({ namespace: "learning", kind: "detector-execution", limit: 10 })).records,
    ).toHaveLength(1);

    const conflicting = await createRunnerFixture({
      label: "conflicting",
      evaluate: (window) => ({
        conditionDetected: true,
        insights: [insightDraft(window, resultLabel)],
        findings: [],
      }),
    });
    const conflictingInput = runInput(conflicting.harness, "commit", [conflicting.episodeRecordId]);
    resultLabel = "left";
    const left = await conflicting.learning.runDetector(conflictingInput);
    resultLabel = "right";
    const right = await conflicting.learning.runDetector(conflictingInput);
    expect(right.persistence).toBe("existing");
    expect(right.execution?.executionDigest).toBe(left.execution?.executionDigest);
  });
});
