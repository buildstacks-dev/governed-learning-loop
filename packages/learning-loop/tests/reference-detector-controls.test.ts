import { describe, expect, it } from "vitest";
import type {
  DetectorRegistration,
  DetectorRunResult,
  EvidencePage,
  EvidenceSource,
  JsonValue,
  RegisteredSource,
  Scope,
} from "@cormidia/learning-loop";
import {
  conservativePolicy,
  createLearningLoop,
  defineSourceRegistration,
  sha256HexOfCanonicalJson,
  toJsonValue,
} from "@cormidia/learning-loop";
import type { ReferenceDetectorBundle } from "@cormidia/learning-loop/reference-detectors";
import type { ManualEvidenceInput } from "@cormidia/learning-loop/testing";
import {
  createExactScopePolicy,
  createInMemoryStore,
  createManualEvidenceSource,
  createStructuredContentPolicy,
  createTestIdentityPort,
} from "@cormidia/learning-loop/testing";
import {
  REFERENCE_CONTENT_POLICY_ID,
  REFERENCE_CRAFT_SCOPE,
  REFERENCE_SCOPE_A,
  REFERENCE_SCOPE_B,
  allReferenceDetectors,
  createHostReferenceProfile,
  createReferenceBundle,
  createReferenceHarness,
  createReferenceRegistry,
  detectorRef,
  lensRef,
  packRef,
  parseReferenceFixtureInput,
} from "./reference-detector-harness.js";

const FAMILIES = [
  "attributed_human_redirection",
  "context_pressure_compaction",
  "coordination_attribution_integrity",
  "coordination_fanout",
  "repeated_status_polling",
  "tool_use_concentration",
] as const;
type Family = (typeof FAMILIES)[number];

interface FamilyRun {
  readonly harness: ReturnType<typeof createReferenceHarness>;
  readonly detector: DetectorRegistration;
  readonly input: ManualEvidenceInput;
  readonly scope: Scope;
  readonly episodeRecordIds: readonly string[];
  readonly result: DetectorRunResult;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function familyOf(detector: DetectorRegistration): Family {
  const family = FAMILIES.find((candidate) => detector.id.includes(`.${candidate}.`));
  if (family === undefined) throw new Error(`unknown reference detector family for ${detector.id}`);
  return family;
}

function detectorFor(bundle: ReferenceDetectorBundle, family: Family): DetectorRegistration {
  const detector = allReferenceDetectors(bundle).find((candidate) => familyOf(candidate) === family);
  if (detector === undefined) throw new Error(`missing reference detector ${family}`);
  return detector;
}

function fragmentFor(bundle: ReferenceDetectorBundle, family: Family) {
  return family === "coordination_attribution_integrity" ? bundle.coreStructural : bundle.referenceOperational;
}

function fixtureFor(bundle: ReferenceDetectorBundle, family: Family, control: "positive" | "negative") {
  const fixture = bundle.fixtures.find(
    (candidate) => candidate.detectorFamily === family && candidate.control === control,
  );
  if (fixture === undefined) throw new Error(`missing ${control} fixture for ${family}`);
  return fixture;
}

function scopeOf(input: ManualEvidenceInput): Scope {
  const scope = input.episodes?.[0]?.scope;
  if (scope === undefined) throw new Error("reference fixture requires an episode scope");
  return scope;
}

function conditionOf(result: DetectorRunResult): boolean {
  const execution = result.execution;
  if (execution === undefined || execution.result.status !== "applied") {
    throw new Error("reference detector did not produce an applied execution");
  }
  return execution.result.conditionDetected;
}

async function runFamily(input: {
  readonly family: Family;
  readonly evidenceInput: ManualEvidenceInput;
  readonly mode?: "dry_run" | "commit";
  readonly harness?: ReturnType<typeof createReferenceHarness>;
}): Promise<FamilyRun> {
  const harness = input.harness ?? createReferenceHarness();
  const receipt = await harness.learning.ingest(harness.source, input.evidenceInput);
  const detector = detectorFor(harness.bundle, input.family);
  const fragment = fragmentFor(harness.bundle, input.family);
  const lens = harness.bundle.lenses[0];
  if (lens === undefined) throw new Error("reference detector harness requires a lens");
  const scope = scopeOf(input.evidenceInput);
  const episodeRecordIds = [...receipt.episodeIds].sort(compareText);
  const result = await harness.learning.runDetector({
    mode: input.mode ?? "dry_run",
    detector: detectorRef(detector),
    pack: packRef(fragment.pack),
    lens: lensRef(lens),
    scope,
    episodeRecordIds,
  });
  return { harness, detector, input: input.evidenceInput, scope, episodeRecordIds, result };
}

function jsonRecord(input: JsonValue): Readonly<Record<string, JsonValue>> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("expected fixture JSON object");
  }
  return Object.fromEntries(Object.entries(input));
}

function malformedTargetedData(input: ManualEvidenceInput): ManualEvidenceInput {
  let changed = false;
  const observations = (input.observations ?? []).map((observation) => {
    if (changed) return observation;
    changed = true;
    return { ...observation, data: { malformed: true } };
  });
  if (!changed) throw new Error("targeted malformed control requires an observation");
  return { ...input, observations };
}

function withTrafficClass(input: ManualEvidenceInput, trafficClass: string): ManualEvidenceInput {
  return {
    ...input,
    observations: (input.observations ?? []).map((observation) => ({
      ...observation,
      data: toJsonValue({ ...jsonRecord(observation.data), trafficClass }),
    })),
  };
}

function withScopeAndPrefix(input: ManualEvidenceInput, scope: Scope, prefix: string): ManualEvidenceInput {
  const episodeIds = new Map((input.episodes ?? []).map((episode) => [episode.id, `${prefix}-${episode.id}`]));
  const mappedEpisodeId = (id: string): string => episodeIds.get(id) ?? `${prefix}-${id}`;
  return {
    observations: (input.observations ?? []).map((observation) => ({
      ...observation,
      id: `${prefix}-${observation.id}`,
      episodeId: mappedEpisodeId(observation.episodeId),
    })),
    episodes: (input.episodes ?? []).map((episode) => ({
      ...episode,
      id: mappedEpisodeId(episode.id),
      ...(episode.parentEpisodeId === undefined ? {} : { parentEpisodeId: mappedEpisodeId(episode.parentEpisodeId) }),
      scope,
    })),
  };
}

function withSequences(input: ManualEvidenceInput, sequences: readonly number[]): ManualEvidenceInput {
  const observations = input.observations ?? [];
  if (observations.length !== sequences.length) throw new Error("sequence control does not cover every observation");
  return {
    ...input,
    observations: observations.map((observation, index) => ({
      ...observation,
      data: toJsonValue({ ...jsonRecord(observation.data), sequence: sequences[index] ?? -1 }),
    })),
  };
}

function toolingVariant(input: {
  readonly count: number;
  readonly dominantCount: number;
  readonly repeatedSignatureCount: number;
}): ManualEvidenceInput {
  const base = parseReferenceFixtureInput(
    fixtureFor(createReferenceBundle(), "tool_use_concentration", "positive").input,
  );
  const template = base.observations?.[0];
  const episode = base.episodes?.[0];
  if (template === undefined || episode === undefined) throw new Error("tooling template is incomplete");
  const digestFor = (label: string): string => sha256HexOfCanonicalJson(toJsonValue({ label }));
  return {
    observations: Array.from({ length: input.count }, (_, index) => ({
      ...template,
      id: `tooling-boundary-${String(index).padStart(2, "0")}`,
      data: toJsonValue({
        sequence: index,
        intent: "tool",
        state: "succeeded",
        operationClass: index < input.dominantCount ? "dominant" : "other",
        targetKeyedDigest: digestFor(`target-${String(index)}`),
        signatureKeyedDigest: digestFor(
          index < input.repeatedSignatureCount ? "repeated" : `signature-${String(index)}`,
        ),
        trafficClass: "primary",
      }),
    })),
    episodes: [episode],
  };
}

function namedManualSource(id: string): EvidenceSource<ManualEvidenceInput> {
  const base = createManualEvidenceSource();
  return {
    descriptor: { id, adapterVersion: base.descriptor.adapterVersion },
    probe: (input) => base.probe(input),
    read: (input, cursor) => base.read(input, cursor),
  };
}

function partialManualSource(): EvidenceSource<ManualEvidenceInput> {
  const base = createManualEvidenceSource();
  return {
    descriptor: { id: "reference-partial-source", adapterVersion: base.descriptor.adapterVersion },
    probe: (input) => base.probe(input),
    read: async function* (input, cursor): AsyncIterable<EvidencePage> {
      for await (const page of base.read(input, cursor)) {
        if (page.state.status !== "available") throw new Error("manual source unexpectedly became unavailable");
        yield {
          ...page,
          state: { ...page.state, completeness: "partial" },
          observations: page.observations.map((observation) => ({ ...observation, completeness: "partial" })),
          episodes: page.episodes.map((episode) => ({ ...episode, completeness: "partial" })),
        };
      }
    },
  };
}

async function assertNoAuthorityEffects(run: FamilyRun): Promise<void> {
  expect(await run.harness.learning.report({ scope: run.scope })).toMatchObject({
    candidateIds: [],
    interventionIds: [],
    evaluationIds: [],
  });
  expect((await run.harness.store.list({ namespace: "learning", kind: "candidate", limit: 10 })).records).toEqual([]);
  expect((await run.harness.store.list({ namespace: "learning", kind: "review", limit: 10 })).records).toEqual([]);
  expect(
    (await run.harness.store.list({ namespace: "learning", kind: "detector-recurrence-group", limit: 10 })).records,
  ).toEqual([]);
  for (const kind of [
    "candidate-admission-binding",
    "candidate-admission-reservation",
    "candidate-admission-snapshot",
    "candidate-recurrence-admission",
  ]) {
    expect((await run.harness.store.list({ namespace: "learning", kind, limit: 10 })).records, kind).toEqual([]);
  }
}

describe("reference detector shipped controls through the public runtime", () => {
  it("runs every shipped positive and paired negative through ingest, profile, registry, and runDetector", async () => {
    const catalog = createReferenceBundle();
    for (const family of FAMILIES) {
      for (const control of ["positive", "negative"] as const) {
        const fixture = fixtureFor(catalog, family, control);
        const run = await runFamily({
          family,
          evidenceInput: parseReferenceFixtureInput(fixture.input),
          mode: control === "positive" ? "commit" : "dry_run",
        });
        expect(conditionOf(run.result), fixture.id).toBe(fixture.expected.conditionDetected);
        expect(run.result.callbackInvoked, fixture.id).toBe(true);
        expect(run.result.recurrence, fixture.id).toEqual(
          control === "positive" ? { status: "locator_unavailable" } : { status: "condition_not_detected" },
        );
        expect(run.result.derivations, fixture.id).toHaveLength(control === "positive" ? 1 : 0);
        const exactLens = run.harness.bundle.lenses[0];
        if (exactLens === undefined) throw new Error("reference detector run requires one exact lens");
        for (const derivation of run.result.derivations) {
          expect(derivation).toMatchObject({
            scope: run.scope,
            lens: lensRef(exactLens),
            producer: {
              kind: "deterministic",
              principal: null,
              attestation: null,
              modelFingerprintDigest: null,
              promptDigest: null,
              toolPolicyDigest: null,
              budgetPolicyDigest: null,
              disclosure: null,
            },
            impactHypothesis: null,
            candidateIntervention: null,
            validation: null,
          });
        }
        await assertNoAuthorityEffects(run);

        if (control === "positive") {
          const retried = await run.harness.learning.runDetector({
            mode: "commit",
            detector: detectorRef(run.detector),
            pack: packRef(fragmentFor(run.harness.bundle, family).pack),
            lens: lensRef(exactLens),
            scope: run.scope,
            episodeRecordIds: run.episodeRecordIds,
          });
          expect(retried).toMatchObject({ persistence: "existing", callbackInvoked: false });
          expect(retried.execution?.executionDigest).toBe(run.result.execution?.executionDigest);
          const derivation = run.result.derivations[0];
          if (derivation === undefined) throw new Error("positive reference detector requires one derivation");
          const proposer = await run.harness.identity.verify({
            principalId: `reference-proposer-${family}`,
            kind: "agent",
            independenceDomain: "reference-proposal-controls",
          });
          await expect(
            run.harness.learning.propose({
              id: `reference-proposal-${family}`,
              scope: run.scope,
              derivationId: derivation.id,
              proposedRisk: "T1",
              proposedBy: proposer,
            }),
          ).rejects.toMatchObject({ code: "candidate.derivation_invalid" });
          await assertNoAuthorityEffects(run);
        }
      }
    }
  });

  it("keeps the complex legitimate 48-operation control negative with exact 24/12/12 classes", async () => {
    const bundle = createReferenceBundle();
    const fixture = fixtureFor(bundle, "tool_use_concentration", "negative");
    expect(fixture.complexLegitimate).toBe(true);
    const input = parseReferenceFixtureInput(fixture.input);
    const operations = input.observations ?? [];
    expect(operations).toHaveLength(48);
    const classes = new Map<string, number>();
    const signatures = new Set<string>();
    for (const observation of operations) {
      const data = jsonRecord(observation.data);
      expect(data.state).toBe("succeeded");
      const operationClass = data.operationClass;
      const signature = data.signatureKeyedDigest;
      if (typeof operationClass !== "string" || typeof signature !== "string") {
        throw new Error("complex tooling control is malformed");
      }
      classes.set(operationClass, (classes.get(operationClass) ?? 0) + 1);
      signatures.add(signature);
    }
    expect([...classes.values()].sort((left, right) => right - left)).toEqual([24, 12, 12]);
    expect(signatures.size).toBe(48);
    const run = await runFamily({ family: "tool_use_concentration", evidenceInput: input });
    expect(conditionOf(run.result)).toBe(false);
    expect(run.result.derivations).toEqual([]);
  });

  it("refuses malformed targeted normalized data instead of returning an applied negative", async () => {
    const bundle = createReferenceBundle();
    for (const family of FAMILIES) {
      const fixture = fixtureFor(bundle, family, "positive");
      const run = runFamily({
        family,
        evidenceInput: malformedTargetedData(parseReferenceFixtureInput(fixture.input)),
      });
      await expect(run, fixture.id).rejects.toMatchObject({ code: "detector.callback_failed" });
    }
  });

  it("classifies reviewer, guardian, benchmark, replay, automated, and delegated corrections as negative", async () => {
    const fixture = fixtureFor(createReferenceBundle(), "attributed_human_redirection", "positive");
    const input = parseReferenceFixtureInput(fixture.input);
    for (const trafficClass of ["reviewer", "guardian", "benchmark", "replay", "automated", "delegated"]) {
      const run = await runFamily({
        family: "attributed_human_redirection",
        evidenceInput: withTrafficClass(input, trafficClass),
      });
      expect(conditionOf(run.result), trafficClass).toBe(false);
      expect(run.result.derivations, trafficClass).toEqual([]);
    }
  });

  it("detects broken closed attribution but makes fan-out refuse the same invalid graph", async () => {
    const bundle = createReferenceBundle();
    const broken = parseReferenceFixtureInput(
      fixtureFor(bundle, "coordination_attribution_integrity", "positive").input,
    );
    const attribution = await runFamily({ family: "coordination_attribution_integrity", evidenceInput: broken });
    expect(conditionOf(attribution.result)).toBe(true);
    await expect(runFamily({ family: "coordination_fanout", evidenceInput: broken })).rejects.toMatchObject({
      code: "detector.callback_failed",
    });
    const valid = parseReferenceFixtureInput(fixtureFor(bundle, "coordination_fanout", "positive").input);
    const integrity = await runFamily({ family: "coordination_attribution_integrity", evidenceInput: valid });
    expect(conditionOf(integrity.result)).toBe(false);
  });
});

describe("reference detector adversarial boundaries and lineage controls", () => {
  it("binds the exact vocabulary schema and every evaluator threshold into registration", () => {
    const bundle = createReferenceBundle();
    expect(bundle.sourceRequirements.observationVocabularyDigest).toBe(
      "e8f396b7b5e4bad4ee67d1737c144c92d2ca1ecf8f4f59d1835b91ef9b9dec4f",
    );
    expect(detectorFor(bundle, "coordination_attribution_integrity").thresholds).toBeNull();
    expect(detectorFor(bundle, "repeated_status_polling").thresholds).toEqual({
      minimumConsecutiveUnchangedPolls: 4,
    });
    expect(detectorFor(bundle, "context_pressure_compaction").thresholds).toEqual({
      highUtilizationBasisPoints: 9_000,
      minimumConsecutiveHighSamples: 3,
      minimumExplicitCompactions: 2,
    });
    expect(detectorFor(bundle, "tool_use_concentration").thresholds).toEqual({
      dominantOperationClassBasisPoints: 7_500,
      minimumCompletedOperations: 12,
      minimumRepeatedSignatureCount: 4,
    });
    expect(detectorFor(bundle, "coordination_fanout").thresholds).toEqual({
      minimumDescendants: 6,
      minimumDirectChildren: 4,
    });
    expect(detectorFor(bundle, "attributed_human_redirection").thresholds).toEqual({
      minimumDistinctEpisodes: 2,
      minimumExactPairs: 2,
    });
  });

  it("does not concatenate polling runs across episodes or sequence gaps", async () => {
    const base = parseReferenceFixtureInput(
      fixtureFor(createReferenceBundle(), "repeated_status_polling", "positive").input,
    );
    const episode = base.episodes?.[0];
    if (episode === undefined) throw new Error("polling control requires an episode");
    const splitEpisodeId = `${episode.id}-split`;
    const split: ManualEvidenceInput = {
      observations: (base.observations ?? []).map((observation, index) => ({
        ...observation,
        episodeId: index < 2 ? episode.id : splitEpisodeId,
        data: toJsonValue({ ...jsonRecord(observation.data), sequence: index % 2 }),
      })),
      episodes: [episode, { ...episode, id: splitEpisodeId }],
    };
    const splitRun = await runFamily({ family: "repeated_status_polling", evidenceInput: split });
    expect(conditionOf(splitRun.result)).toBe(false);

    const gap = withSequences(base, [0, 1, 3, 4]);
    const gapRun = await runFamily({ family: "repeated_status_polling", evidenceInput: gap });
    expect(conditionOf(gapRun.result)).toBe(false);
  });

  it("refuses an open episode instead of classifying an incomplete population", async () => {
    const base = parseReferenceFixtureInput(
      fixtureFor(createReferenceBundle(), "repeated_status_polling", "positive").input,
    );
    const open: ManualEvidenceInput = {
      ...base,
      episodes: (base.episodes ?? []).map((episode) => {
        const { closedAt: _closedAt, ...withoutClosedAt } = episode;
        return withoutClosedAt;
      }),
    };
    await expect(runFamily({ family: "repeated_status_polling", evidenceInput: open })).rejects.toMatchObject({
      code: "detector.callback_failed",
    });
  });

  it("tests context pressure and explicit compaction branches independently at their boundaries", async () => {
    const base = parseReferenceFixtureInput(
      fixtureFor(createReferenceBundle(), "context_pressure_compaction", "positive").input,
    );
    const utilization = (base.observations ?? []).filter(
      (observation) => observation.kind === "reference.context.utilization.v1",
    );
    const compactions = (base.observations ?? []).filter(
      (observation) => observation.kind === "reference.context.compaction.v1",
    );
    const pressureOnly = withSequences({ ...base, observations: utilization }, [0, 1, 2]);
    expect(
      conditionOf((await runFamily({ family: "context_pressure_compaction", evidenceInput: pressureOnly })).result),
    ).toBe(true);
    const pressureOneBelow = withSequences({ ...base, observations: utilization.slice(0, 2) }, [0, 1]);
    expect(
      conditionOf((await runFamily({ family: "context_pressure_compaction", evidenceInput: pressureOneBelow })).result),
    ).toBe(false);
    const pressureGap = withSequences({ ...base, observations: utilization }, [0, 1, 3]);
    expect(
      conditionOf((await runFamily({ family: "context_pressure_compaction", evidenceInput: pressureGap })).result),
    ).toBe(false);

    const compactionOnly = withSequences({ ...base, observations: compactions }, [0, 1]);
    expect(
      conditionOf((await runFamily({ family: "context_pressure_compaction", evidenceInput: compactionOnly })).result),
    ).toBe(true);
    const compactionOneBelow = withSequences({ ...base, observations: compactions.slice(0, 1) }, [0]);
    expect(
      conditionOf(
        (await runFamily({ family: "context_pressure_compaction", evidenceInput: compactionOneBelow })).result,
      ),
    ).toBe(false);
    const nonReducingCompaction: ManualEvidenceInput = {
      ...base,
      observations: compactions.slice(0, 1).map((observation) => ({
        ...observation,
        data: toJsonValue({
          ...jsonRecord(observation.data),
          beforeUtilizationBasisPoints: 9_000,
          afterUtilizationBasisPoints: 9_000,
        }),
      })),
    };
    await expect(
      runFamily({ family: "context_pressure_compaction", evidenceInput: nonReducingCompaction }),
    ).rejects.toMatchObject({ code: "detector.callback_failed" });

    const interrupted = withSequences(
      {
        ...base,
        observations: [utilization[0], utilization[1], compactions[0], utilization[2]].flatMap((value) => value ?? []),
      },
      [0, 1, 2, 3],
    );
    expect(
      conditionOf((await runFamily({ family: "context_pressure_compaction", evidenceInput: interrupted })).result),
    ).toBe(false);

    const positive = await runFamily({ family: "context_pressure_compaction", evidenceInput: base });
    const derivation = positive.result.derivations[0];
    if (derivation === undefined) throw new Error("positive context control requires a derivation");
    expect(derivation.directObservation.evidenceRefs).toHaveLength(5);
    expect(derivation.directObservation.data).toEqual({
      family: "context_pressure_compaction",
      longestHighPressureRun: 3,
      explicitCompactions: 2,
      maximumUtilizationBasisPoints: 9_500,
    });
  });

  it("tests tool repetition, concentration, and minimum-denominator branches independently", async () => {
    const repeatAtThreshold = toolingVariant({ count: 12, dominantCount: 6, repeatedSignatureCount: 4 });
    const repeatOneBelow = toolingVariant({ count: 12, dominantCount: 6, repeatedSignatureCount: 3 });
    expect(
      conditionOf((await runFamily({ family: "tool_use_concentration", evidenceInput: repeatAtThreshold })).result),
    ).toBe(true);
    expect(
      conditionOf((await runFamily({ family: "tool_use_concentration", evidenceInput: repeatOneBelow })).result),
    ).toBe(false);

    const concentrationAtThreshold = toolingVariant({ count: 40, dominantCount: 30, repeatedSignatureCount: 1 });
    const concentrationOneBelow = toolingVariant({ count: 40, dominantCount: 29, repeatedSignatureCount: 1 });
    expect(
      conditionOf(
        (await runFamily({ family: "tool_use_concentration", evidenceInput: concentrationAtThreshold })).result,
      ),
    ).toBe(true);
    expect(
      conditionOf((await runFamily({ family: "tool_use_concentration", evidenceInput: concentrationOneBelow })).result),
    ).toBe(false);

    const denominatorOneBelow = toolingVariant({ count: 11, dominantCount: 11, repeatedSignatureCount: 11 });
    expect(
      conditionOf((await runFamily({ family: "tool_use_concentration", evidenceInput: denominatorOneBelow })).result),
    ).toBe(false);
  });

  it("refuses duplicate coordination root markers", async () => {
    const base = parseReferenceFixtureInput(
      fixtureFor(createReferenceBundle(), "coordination_fanout", "positive").input,
    );
    const marker = base.observations?.[0];
    if (marker === undefined) throw new Error("coordination control requires a root marker");
    const duplicate: ManualEvidenceInput = {
      ...base,
      observations: [...(base.observations ?? []), { ...marker, id: `${marker.id}-duplicate` }],
    };
    for (const family of ["coordination_attribution_integrity", "coordination_fanout"] as const) {
      await expect(runFamily({ family, evidenceInput: duplicate })).rejects.toMatchObject({
        code: "detector.callback_failed",
      });
    }
  });

  it("requires both fan-out thresholds instead of direct children alone", async () => {
    const positive = parseReferenceFixtureInput(
      fixtureFor(createReferenceBundle(), "coordination_fanout", "positive").input,
    );
    const episodes = positive.episodes ?? [];
    const descendantsOneBelow: ManualEvidenceInput = { ...positive, episodes: episodes.slice(0, -1) };
    const run = await runFamily({ family: "coordination_fanout", evidenceInput: descendantsOneBelow });
    expect(conditionOf(run.result)).toBe(false);
  });

  it("deduplicates repeated cited agent evidence while preserving exact correction-pair semantics", async () => {
    const base = parseReferenceFixtureInput(
      fixtureFor(createReferenceBundle(), "attributed_human_redirection", "positive").input,
    );
    const repeatedCorrections = (base.observations ?? []).flatMap((observation) => {
      const data = jsonRecord(observation.data);
      if (data.actor !== "human" || data.correction !== true) return [observation];
      return [
        observation,
        {
          ...observation,
          id: `${observation.id}-repeat`,
          data: toJsonValue({ ...data, sequence: 2 }),
        },
      ];
    });
    const run = await runFamily({
      family: "attributed_human_redirection",
      evidenceInput: { ...base, observations: repeatedCorrections },
    });
    expect(conditionOf(run.result)).toBe(true);
    const derivation = run.result.derivations[0];
    if (derivation === undefined) throw new Error("repeated redirection control requires a derivation");
    expect(derivation.directObservation.data).toEqual({
      family: "attributed_human_redirection",
      citedPairCount: 4,
      distinctEpisodeCount: 2,
    });
    expect(derivation.directObservation.evidenceRefs).toHaveLength(6);
    expect(new Set(derivation.directObservation.evidenceRefs.map((reference) => reference.referenceDigest)).size).toBe(
      6,
    );
  });

  it("keeps two exact redirection pairs in one episode below the distinct-episode threshold", async () => {
    const base = parseReferenceFixtureInput(
      fixtureFor(createReferenceBundle(), "attributed_human_redirection", "positive").input,
    );
    const firstEpisode = base.episodes?.[0];
    const turns = base.observations ?? [];
    if (firstEpisode === undefined || turns.length !== 4) throw new Error("redirection boundary fixture is incomplete");
    const oneEpisode: ManualEvidenceInput = {
      episodes: [firstEpisode],
      observations: turns.map((turn, index) => ({
        ...turn,
        episodeId: firstEpisode.id,
        data: toJsonValue({
          ...jsonRecord(turn.data),
          sequence: index,
          replyToSequence: index % 2 === 0 ? null : index - 1,
        }),
      })),
    };
    const run = await runFamily({ family: "attributed_human_redirection", evidenceInput: oneEpisode });
    expect(conditionOf(run.result)).toBe(false);
    expect(run.result.derivations).toEqual([]);
  });

  it("refuses an eligible human correction whose cited target is absent from its episode", async () => {
    const base = parseReferenceFixtureInput(
      fixtureFor(createReferenceBundle(), "attributed_human_redirection", "positive").input,
    );
    let changed = false;
    const observations = (base.observations ?? []).map((observation) => {
      const data = jsonRecord(observation.data);
      if (changed || data.actor !== "human" || data.correction !== true) return observation;
      changed = true;
      return { ...observation, data: toJsonValue({ ...data, replyToSequence: 99 }) };
    });
    if (!changed) throw new Error("redirection missing-target control requires a human correction");
    await expect(
      runFamily({ family: "attributed_human_redirection", evidenceInput: { ...base, observations } }),
    ).rejects.toMatchObject({ code: "detector.callback_failed" });
  });

  it("refuses a human correction that cites its own turn", async () => {
    const base = parseReferenceFixtureInput(
      fixtureFor(createReferenceBundle(), "attributed_human_redirection", "positive").input,
    );
    let changed = false;
    const observations = (base.observations ?? []).map((observation) => {
      const data = jsonRecord(observation.data);
      if (changed || data.actor !== "human" || data.correction !== true) return observation;
      changed = true;
      return { ...observation, data: toJsonValue({ ...data, replyToSequence: data.sequence }) };
    });
    if (!changed) throw new Error("redirection self-citation control requires a human correction");
    await expect(
      runFamily({ family: "attributed_human_redirection", evidenceInput: { ...base, observations } }),
    ).rejects.toMatchObject({ code: "detector.callback_failed" });
  });

  it("refuses forward human citations even when the target later resolves to an agent turn", async () => {
    const base = parseReferenceFixtureInput(
      fixtureFor(createReferenceBundle(), "attributed_human_redirection", "positive").input,
    );
    const observations = (base.observations ?? []).map((observation) => {
      const data = jsonRecord(observation.data);
      if (data.actor === "agent") {
        return { ...observation, data: toJsonValue({ ...data, sequence: 1, replyToSequence: null }) };
      }
      if (data.actor === "human" && data.correction === true) {
        return { ...observation, data: toJsonValue({ ...data, sequence: 0, replyToSequence: 1 }) };
      }
      return observation;
    });
    await expect(
      runFamily({ family: "attributed_human_redirection", evidenceInput: { ...base, observations } }),
    ).rejects.toMatchObject({ code: "detector.callback_failed" });
  });
});

describe("reference detector preflight, lenses, and isolation", () => {
  it("keeps missing profile/capability/vocabulary non-applicable and unhealthy evidence incomplete without callback", async () => {
    const bundle = createReferenceBundle();
    const fixture = fixtureFor(bundle, "repeated_status_polling", "positive");
    const input = parseReferenceFixtureInput(fixture.input);
    const detector = detectorFor(bundle, "repeated_status_polling");
    const full = createReferenceHarness({ bundle });
    const missingCapability = full.profile?.capabilities.filter(
      (capability) => capability !== detector.requiredCapabilities[0],
    );
    if (missingCapability === undefined) throw new Error("reference full profile is missing");
    const cases = [
      { name: "profile", harness: createReferenceHarness({ bundle, profileMode: "absent" }), status: "not_applicable" },
      {
        name: "capability",
        harness: createReferenceHarness({ bundle, profileOptions: { capabilities: missingCapability } }),
        status: "not_applicable",
      },
      {
        name: "vocabulary",
        harness: createReferenceHarness({
          bundle,
          profileOptions: { observationVocabularyDigest: "0".repeat(64) },
        }),
        status: "not_applicable",
      },
      {
        name: "partial",
        harness: createReferenceHarness({ bundle, sourceAdapter: partialManualSource() }),
        status: "incomplete",
      },
    ];
    for (const fixtureCase of cases) {
      const run = await runFamily({
        family: "repeated_status_polling",
        evidenceInput: input,
        harness: fixtureCase.harness,
      });
      expect(run.result.status, fixtureCase.name).toBe(fixtureCase.status);
      expect(run.result.callbackInvoked, fixtureCase.name).toBe(false);
      expect(run.result.derivations, fixtureCase.name).toEqual([]);
    }
  });

  it("runs identical evidence under Support and Documentation lenses in the exact same pack", async () => {
    const harness = createReferenceHarness();
    const fixture = fixtureFor(harness.bundle, "repeated_status_polling", "positive");
    const input = parseReferenceFixtureInput(fixture.input);
    const receipt = await harness.learning.ingest(harness.source, input);
    const result = await harness.learning.runDetectorPack({
      mode: "dry_run",
      pack: packRef(harness.bundle.referenceOperational.pack),
      scope: scopeOf(input),
      episodeRecordIds: [...receipt.episodeIds].sort(compareText),
    });
    const polling = detectorFor(harness.bundle, "repeated_status_polling");
    const items = result.items.filter(
      (item) => item.detector.registrationDigest === polling.registrationDigest && item.result !== undefined,
    );
    expect(items).toHaveLength(2);
    expect(items.map((item) => item.lens?.id).sort()).toEqual(harness.bundle.lenses.map((lens) => lens.id).sort());
    const derivations = items.flatMap((item) => item.result?.derivations ?? []);
    expect(derivations).toHaveLength(2);
    expect(new Set(derivations.map((derivation) => derivation.id)).size).toBe(2);
    expect(new Set(derivations.map((derivation) => derivation.lens.registrationDigest)).size).toBe(2);
    expect(derivations[0]?.directObservation).toEqual(derivations[1]?.directObservation);
    expect(await harness.learning.report({ scope: scopeOf(input) })).toMatchObject({ candidateIds: [] });
  });

  it("keeps two exact project scopes isolated in one configured loop", async () => {
    const harness = createReferenceHarness();
    const fixture = fixtureFor(harness.bundle, "repeated_status_polling", "positive");
    const base = parseReferenceFixtureInput(fixture.input);
    const projectA = withScopeAndPrefix(base, REFERENCE_SCOPE_A, "project-a");
    const projectB = withScopeAndPrefix(base, REFERENCE_SCOPE_B, "project-b");
    const receiptA = await harness.learning.ingest(harness.source, projectA);
    const receiptB = await harness.learning.ingest(harness.source, projectB);
    const detector = detectorFor(harness.bundle, "repeated_status_polling");
    const lens = harness.bundle.lenses[0];
    if (lens === undefined) throw new Error("reference isolation requires a lens");
    for (const [scope, ids] of [
      [REFERENCE_SCOPE_A, receiptA.episodeIds],
      [REFERENCE_SCOPE_B, receiptB.episodeIds],
    ] as const) {
      const result = await harness.learning.runDetector({
        mode: "dry_run",
        detector: detectorRef(detector),
        pack: packRef(harness.bundle.referenceOperational.pack),
        lens: lensRef(lens),
        scope,
        episodeRecordIds: [...ids].sort(compareText),
      });
      expect(conditionOf(result)).toBe(true);
      expect(result.derivations[0]?.scope).toEqual(scope);
    }
    const foreign = await harness.learning.runDetector({
      mode: "dry_run",
      detector: detectorRef(detector),
      pack: packRef(harness.bundle.referenceOperational.pack),
      lens: lensRef(lens),
      scope: REFERENCE_SCOPE_A,
      episodeRecordIds: [...receiptB.episodeIds].sort(compareText),
    });
    expect(foreign).toMatchObject({ status: "not_applicable", callbackInvoked: false });
    expect(JSON.stringify(foreign)).not.toContain(receiptB.episodeIds[0] ?? "foreign-episode");
  });

  it("uses a separately materialized craft population without union-reading either personal project", async () => {
    const harness = createReferenceHarness();
    const fixture = fixtureFor(harness.bundle, "repeated_status_polling", "positive");
    const base = parseReferenceFixtureInput(fixture.input);
    const project = withScopeAndPrefix(base, REFERENCE_SCOPE_A, "private-project");
    const craft = withScopeAndPrefix(base, REFERENCE_CRAFT_SCOPE, "explicit-craft");
    const projectReceipt = await harness.learning.ingest(harness.source, project);
    const craftReceipt = await harness.learning.ingest(harness.source, craft);
    const detector = detectorFor(harness.bundle, "repeated_status_polling");
    const lens = harness.bundle.lenses[0];
    if (lens === undefined) throw new Error("reference craft control requires a lens");
    const craftRun = await harness.learning.runDetector({
      mode: "dry_run",
      detector: detectorRef(detector),
      pack: packRef(harness.bundle.referenceOperational.pack),
      lens: lensRef(lens),
      scope: REFERENCE_CRAFT_SCOPE,
      episodeRecordIds: [...craftReceipt.episodeIds].sort(compareText),
    });
    expect(conditionOf(craftRun)).toBe(true);
    expect(craftRun.derivations[0]?.scope).toEqual(REFERENCE_CRAFT_SCOPE);

    const foreignProject = await harness.learning.runDetector({
      mode: "dry_run",
      detector: detectorRef(detector),
      pack: packRef(harness.bundle.referenceOperational.pack),
      lens: lensRef(lens),
      scope: REFERENCE_CRAFT_SCOPE,
      episodeRecordIds: [...projectReceipt.episodeIds].sort(compareText),
    });
    expect(foreignProject).toMatchObject({ status: "not_applicable", callbackInvoked: false });
    expect(JSON.stringify(foreignProject)).not.toContain(projectReceipt.episodeIds[0] ?? "private-project");

    const craftEpisodes: string[] = [];
    for await (const page of harness.learning.queryEpisodes({ scope: REFERENCE_CRAFT_SCOPE, limit: 10 })) {
      craftEpisodes.push(...page.items.map((view) => view.episode.id));
    }
    expect(craftEpisodes).toEqual(craftReceipt.episodeIds);
    expect(craftEpisodes.some((id) => projectReceipt.episodeIds.includes(id))).toBe(false);
  });

  it("fails closed when another source supplies a capability missing from the evidence source", async () => {
    const bundle = createReferenceBundle();
    const detector = detectorFor(bundle, "repeated_status_polling");
    const sourceA: RegisteredSource<ManualEvidenceInput> = defineSourceRegistration({
      source: namedManualSource("reference-union-source-a"),
      trustCeiling: "observed",
      contentPolicyId: REFERENCE_CONTENT_POLICY_ID,
    });
    const sourceB: RegisteredSource<ManualEvidenceInput> = defineSourceRegistration({
      source: namedManualSource("reference-union-source-b"),
      trustCeiling: "observed",
      contentPolicyId: REFERENCE_CONTENT_POLICY_ID,
    });
    const fullA = createHostReferenceProfile(bundle, sourceA);
    const profileA = createHostReferenceProfile(bundle, sourceA, {
      capabilities: fullA.capabilities.filter((capability) => capability !== detector.requiredCapabilities[0]),
    });
    const profileB = createHostReferenceProfile(bundle, sourceB);
    const store = createInMemoryStore();
    const learning = createLearningLoop({
      store,
      policy: conservativePolicy(),
      identity: createTestIdentityPort(),
      scopePolicy: createExactScopePolicy(),
      contentPolicies: [createStructuredContentPolicy({ id: REFERENCE_CONTENT_POLICY_ID })],
      sources: [sourceA, sourceB],
      semanticRegistry: createReferenceRegistry(bundle, [profileA, profileB]),
      detectorImplementations: [
        ...bundle.coreStructural.implementations,
        ...bundle.referenceOperational.implementations,
      ],
      queryCursorScope: "reference-capability-union",
    });
    const input = parseReferenceFixtureInput(fixtureFor(bundle, "repeated_status_polling", "positive").input);
    const [receiptA, receiptB] = await Promise.all([learning.ingest(sourceA, input), learning.ingest(sourceB, input)]);
    const lens = bundle.lenses[0];
    if (lens === undefined) throw new Error("reference union test requires a lens");
    await expect(
      learning.runDetector({
        mode: "dry_run",
        detector: detectorRef(detector),
        pack: packRef(bundle.referenceOperational.pack),
        lens: lensRef(lens),
        scope: scopeOf(input),
        episodeRecordIds: [...receiptA.episodeIds, ...receiptB.episodeIds].sort(compareText),
      }),
    ).rejects.toMatchObject({ code: "detector.callback_failed" });
    expect((await store.list({ namespace: "learning", kind: "detector-execution", limit: 10 })).records).toEqual([]);
  });
});
