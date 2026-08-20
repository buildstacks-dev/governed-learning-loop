// #30b2b derivation-backed Candidate proposal: scoped eligibility, exact
// kernel mapping, population-only lineage, and manual-path compatibility.
import { describe, expect, it } from "vitest";
import type { CandidateInput, InsightDerivation, LearningStore, VerifiedPrincipal } from "../src/index.js";
import {
  candidateContentDigest,
  detectorExecutionDigest,
  detectorExecutionKeyDigest,
  insightDerivationDigest,
  parseDetectorExecutionRecord,
  parseInsightDerivation,
  sha256HexOfCanonicalJson,
  toJsonValue,
} from "../src/index.js";
import type { EngineContext } from "../src/engine/context.js";
import { resolveCandidateEvidence } from "../src/engine/evidence-binding.js";
import { persistDetectorExecution } from "../src/engine/semantic-persistence.js";
import { evidenceHealthFindingDigest } from "../src/records/source-health.js";
import { createInMemoryStore } from "../src/testing/index.js";
import type { SemanticEngineHarness } from "./semantic-engine-harness.js";
import { SEMANTIC_SCOPE_B, createSemanticEngineHarness, createSemanticFacts } from "./semantic-engine-harness.js";

type DerivedCandidateInput = Extract<CandidateInput, { readonly derivationId: string }>;

function derivedInput(
  proposedBy: VerifiedPrincipal,
  derivation: InsightDerivation,
  overrides: Partial<Omit<DerivedCandidateInput, "proposedBy" | "derivationId" | "scope">> = {},
): DerivedCandidateInput {
  return {
    id: "derived-candidate",
    scope: derivation.scope,
    derivationId: derivation.id,
    proposedRisk: "T1",
    proposedBy,
    ...overrides,
  };
}

async function storedCount(store: LearningStore, kind: string): Promise<number> {
  return (await store.list({ namespace: "learning", kind, limit: 1_000 })).records.length;
}

function hidingGetStore(base: LearningStore, kind: string, id: string): LearningStore {
  return {
    get: (key) => (key.kind === kind && key.id === id ? Promise.resolve(undefined) : base.get(key)),
    create: (key, value, digest, operationId) => base.create(key, value, digest, operationId),
    compareAndSet: (key, expectedRevision, value, digest, operationId) =>
      base.compareAndSet(key, expectedRevision, value, digest, operationId),
    append: (stream, expectedRevision, entries, operationId) =>
      base.append(stream, expectedRevision, entries, operationId),
    tombstone: (input) => base.tombstone(input),
    list: (query) => base.list(query),
  };
}

function redigestDerivation(input: InsightDerivation): InsightDerivation {
  const { schemaVersion: _schemaVersion, id: _id, derivationDigest: _derivationDigest, ...base } = input;
  const derivationDigest = insightDerivationDigest(base);
  return parseInsightDerivation({
    schemaVersion: 1,
    id: `insight-${derivationDigest}`,
    ...base,
    derivationDigest,
  });
}

function bindExecutionDerivation(
  execution: ReturnType<typeof createSemanticFacts>["execution"],
  derivation: InsightDerivation,
) {
  const result = {
    status: "applied" as const,
    conditionDetected: true,
    derivationRefs: [
      { id: derivation.id, derivationDigest: derivation.derivationDigest, scopeDigest: derivation.scopeDigest },
    ],
    evidenceHealthFindings: [],
  };
  const executionKeyDigest = detectorExecutionKeyDigest(execution);
  const executionDigest = detectorExecutionDigest({ ...execution, result, executionKeyDigest });
  return parseDetectorExecutionRecord({
    ...execution,
    id: `detector-execution-${executionKeyDigest}`,
    result,
    executionKeyDigest,
    executionDigest,
  });
}

function withAdditionalPopulation(
  baseFacts: ReturnType<typeof createSemanticFacts>,
  extraEpisode: SemanticEngineHarness["episodeView"],
  supersedes: InsightDerivation["supersedes"],
) {
  const episodes = [
    ...baseFacts.derivation.population.episodes,
    {
      episodeRecordId: extraEpisode.episodeRecordId,
      episodeViewDigest: extraEpisode.episodeViewDigest,
      scopeDigest: extraEpisode.scopeDigest,
    },
  ];
  const normalizationPolicyDigest = baseFacts.derivation.population.normalizationPolicyDigest;
  const comparabilityPolicyDigest = baseFacts.derivation.population.comparabilityPolicyDigest;
  const population = {
    episodes,
    normalizationPolicyDigest,
    comparabilityPolicyDigest,
    populationDigest: sha256HexOfCanonicalJson(
      toJsonValue({ episodes, normalizationPolicyDigest, comparabilityPolicyDigest }),
    ),
  };
  const derivation = redigestDerivation({
    ...baseFacts.derivation,
    population,
    directObservation: {
      ...baseFacts.derivation.directObservation,
      data: { condition: `population-${episodes.length}` },
    },
    supersedes,
  });
  const executionEpisodes = [...baseFacts.execution.window.population.episodes, extraEpisode];
  const executionPopulation = {
    episodes: executionEpisodes,
    normalizationPolicyDigest,
    comparabilityPolicyDigest,
    populationDigest: sha256HexOfCanonicalJson(
      toJsonValue({ episodes: executionEpisodes, normalizationPolicyDigest, comparabilityPolicyDigest }),
    ),
  };
  const windowBase = { ...baseFacts.execution.window, population: executionPopulation };
  const window = {
    ...windowBase,
    windowDigest: sha256HexOfCanonicalJson(
      toJsonValue({
        sourceProfiles: windowBase.sourceProfiles,
        population: windowBase.population,
        evidenceRefs: windowBase.evidenceRefs,
        evidenceHealthFindings: windowBase.evidenceHealthFindings,
        availableCapabilities: windowBase.availableCapabilities,
      }),
    ),
  };
  return { derivation, execution: bindExecutionDerivation({ ...baseFacts.execution, window }, derivation) };
}

function loggingStore(base: LearningStore) {
  const gets: Array<{ readonly namespace: string; readonly kind: string; readonly id: string }> = [];
  let enabled = false;
  const store: LearningStore = {
    get: (key) => {
      if (enabled) gets.push(key);
      return base.get(key);
    },
    create: (key, value, digest, operationId) => base.create(key, value, digest, operationId),
    compareAndSet: (key, expectedRevision, value, digest, operationId) =>
      base.compareAndSet(key, expectedRevision, value, digest, operationId),
    append: (stream, expectedRevision, entries, operationId) =>
      base.append(stream, expectedRevision, entries, operationId),
    tombstone: (input) => base.tombstone(input),
    list: (query) => base.list(query),
  };
  return { store, gets, enable: () => (enabled = true) };
}

function derivationSnapshotChangingStore(base: LearningStore, mode: "once" | "always") {
  let enabled = false;
  let changes = 0;
  let indexKey: { readonly namespace: string; readonly kind: string; readonly id: string } | undefined;
  const store: LearningStore = {
    get: async (key) => {
      const stored = await base.get(key);
      if (
        enabled &&
        key.kind === "insight-derivation" &&
        indexKey !== undefined &&
        (mode === "always" || changes === 0)
      ) {
        const index = await base.get(indexKey);
        if (index === undefined) throw new Error("derived snapshot fixture requires a scope index");
        changes += 1;
        const value = toJsonValue(index.value);
        const result = await base.compareAndSet(
          indexKey,
          index.revision,
          value,
          index.digest,
          `derived-candidate-snapshot-${changes}`,
        );
        if (result.status !== "updated") throw new Error("derived snapshot mutation failed");
      }
      return stored;
    },
    create: (key, value, digest, operationId) => base.create(key, value, digest, operationId),
    compareAndSet: (key, expectedRevision, value, digest, operationId) =>
      base.compareAndSet(key, expectedRevision, value, digest, operationId),
    append: (stream, expectedRevision, entries, operationId) =>
      base.append(stream, expectedRevision, entries, operationId),
    tombstone: (input) => base.tombstone(input),
    list: (query) => base.list(query),
  };
  return {
    store,
    enable: (derivation: InsightDerivation) => {
      indexKey = {
        namespace: `learning-semantic-scope-${derivation.scopeDigest}`,
        kind: "insight-derivation-index",
        id: derivation.id,
      };
      enabled = true;
    },
    changes: () => changes,
  };
}

function failBeforeExecutionReceipt(base: LearningStore): LearningStore {
  let failed = false;
  return {
    get: (key) => base.get(key),
    create: (key, value, digest, operationId) => {
      if (!failed && key.kind === "detector-execution") {
        failed = true;
        throw new Error("pre-receipt derivation crash");
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
}

function isPromiseLike(input: unknown): input is PromiseLike<unknown> {
  return typeof input === "object" && input !== null && "then" in input && typeof input.then === "function";
}

async function invokeUnknownPropose(method: (input: never) => unknown, input: unknown): Promise<unknown> {
  const output: unknown = Reflect.apply(method, undefined, [input]);
  if (!isPromiseLike(output)) throw new Error("propose trust-boundary fixture returned another type");
  return output;
}

async function committedFixture(input: { readonly populationOnly?: boolean; readonly store?: LearningStore } = {}) {
  const harness = await createSemanticEngineHarness({
    ...(input.store === undefined ? {} : { store: input.store }),
    lensEvidenceKind: input.populationOnly === true ? "episode" : "observation",
  });
  const facts = createSemanticFacts(harness, { withEvidence: input.populationOnly !== true });
  await persistDetectorExecution(harness.context, facts.execution, [facts.derivation]);
  const proposer = await harness.context.identity.verify({
    principalId: "derived-proposer",
    kind: "agent",
    independenceDomain: "derived-proposer-domain",
  });
  return { harness, facts, proposer };
}

describe("derivation-backed CandidateInput and exact mapping", () => {
  it("maps interpretation, impact, direct+counterevidence, destination, and exact derivationRef", async () => {
    const harness = await createSemanticEngineHarness();
    await harness.learning.ingest(harness.source, {
      observations: [
        {
          id: "counter-observation",
          episodeId: "counter-episode",
          kind: "tool.process.completed",
          data: { counterexample: true },
        },
      ],
      episodes: [
        {
          id: "counter-episode",
          episodeClass: "interactive",
          scope: harness.scope,
          openedAt: "2026-08-20T00:03:00.000Z",
          closedAt: "2026-08-20T00:04:00.000Z",
        },
      ],
    });
    const counterResolution = await resolveCandidateEvidence(
      harness.context,
      [`${harness.source.id}/counter-observation`],
      harness.scope,
    );
    const counter = counterResolution.refs[0];
    if (counter === undefined) throw new Error("missing counterevidence fixture");
    const facts = createSemanticFacts(harness, { contradictoryEvidenceRefs: [counter] });
    await persistDetectorExecution(harness.context, facts.execution, [facts.derivation]);
    const proposer = await harness.context.identity.verify({
      principalId: "mapping-proposer",
      kind: "agent",
      independenceDomain: "mapping-domain",
    });

    const outcome = await harness.learning.propose(derivedInput(proposer, facts.derivation));

    expect(outcome.candidate).toMatchObject({
      schemaVersion: 2,
      scope: facts.derivation.scope,
      problem: facts.derivation.interpretation?.statement,
      hypothesis: facts.derivation.impactHypothesis?.statement,
      evidenceRefs: [harness.evidence, counter],
      intervention: {
        destinationId: facts.derivation.candidateIntervention?.proposedDestinationId,
        kind: facts.derivation.candidateIntervention?.proposedDestinationKind,
        content: facts.derivation.candidateIntervention?.contentDraft,
        rollbackIntent: facts.derivation.candidateIntervention?.rollbackIntent,
      },
      derivationRef: { id: facts.derivation.id, digest: facts.derivation.derivationDigest },
      proposedBy: proposer.ref,
    });
    expect(outcome.candidate.contentDigest).toBe(candidateContentDigest(outcome.candidate));
    expect(outcome.derivationLineage).toMatchObject({
      status: "resolved",
      derivation: { derivation: { id: facts.derivation.id } },
    });
    expect(outcome.evidenceHealth.status).toBe("ready");
  });

  it("permits population-only Candidate-v2 lineage while manual empty evidence remains refused", async () => {
    const { harness, facts, proposer } = await committedFixture({ populationOnly: true });
    const outcome = await harness.learning.propose(derivedInput(proposer, facts.derivation));
    expect(outcome.candidate.evidenceRefs).toEqual([]);
    expect(outcome.candidate.derivationRef).toEqual({
      id: facts.derivation.id,
      digest: facts.derivation.derivationDigest,
    });
    expect(outcome.derivationLineage.status).toBe("resolved");

    await expect(
      harness.learning.propose({
        id: "manual-empty",
        scope: harness.scope,
        problem: "Manual input has no evidence.",
        hypothesis: "It must remain refused.",
        evidenceIds: [],
        intervention: {
          destinationId: "host/semantic-note",
          kind: "report-note",
          content: { text: "manual" },
          rollbackIntent: "Remove the note.",
        },
        proposedRisk: "T1",
        proposedBy: proposer,
      }),
    ).rejects.toMatchObject({ code: "candidate.evidence_invalid" });
  });

  it("rejects runtime semantic overrides without invoking their getters", async () => {
    const { harness, facts, proposer } = await committedFixture();
    for (const override of ["problem", "hypothesis", "evidenceIds", "intervention"] as const) {
      let reads = 0;
      const input = {
        id: `override-refusal-${override}`,
        scope: facts.derivation.scope,
        derivationId: facts.derivation.id,
        proposedRisk: "T1",
        proposedBy: proposer,
      };
      Object.defineProperty(input, override, {
        enumerable: true,
        get: () => {
          reads += 1;
          return "forged override";
        },
      });
      await expect(invokeUnknownPropose(harness.learning.propose, input)).rejects.toMatchObject({
        code: "candidate.derivation_override",
      });
      expect(reads).toBe(0);
    }
    expect(await storedCount(harness.store, "candidate")).toBe(0);
    expect(await storedCount(harness.store, "candidate-by-digest")).toBe(0);
  });

  it("refuses null destination, content, rollback, or semantic interpretation fields before candidate writes", async () => {
    const mutations: readonly {
      readonly name: string;
      readonly mutate: (derivation: InsightDerivation) => InsightDerivation;
    }[] = [
      {
        name: "destination",
        mutate: (derivation) => {
          const intervention = derivation.candidateIntervention;
          if (intervention === null) throw new Error("missing destination fixture");
          return redigestDerivation({
            ...derivation,
            candidateIntervention: { ...intervention, proposedDestinationId: null },
          });
        },
      },
      {
        name: "content",
        mutate: (derivation) => {
          const intervention = derivation.candidateIntervention;
          if (intervention === null) throw new Error("missing content fixture");
          return redigestDerivation({ ...derivation, candidateIntervention: { ...intervention, contentDraft: null } });
        },
      },
      {
        name: "rollback",
        mutate: (derivation) => {
          const intervention = derivation.candidateIntervention;
          if (intervention === null) throw new Error("missing rollback fixture");
          return redigestDerivation({
            ...derivation,
            candidateIntervention: { ...intervention, rollbackIntent: null },
          });
        },
      },
      {
        name: "interpretation",
        mutate: (derivation) =>
          redigestDerivation({
            ...derivation,
            interpretation: null,
            impactHypothesis: null,
            candidateIntervention: null,
            validation: null,
          }),
      },
    ];
    for (const mutation of mutations) {
      const harness = await createSemanticEngineHarness({ label: `mapping-${mutation.name}` });
      const baseFacts = createSemanticFacts(harness);
      const derivation = mutation.mutate(baseFacts.derivation);
      const execution = bindExecutionDerivation(baseFacts.execution, derivation);
      await persistDetectorExecution(harness.context, execution, [derivation]);
      const proposer = await harness.context.identity.verify({
        principalId: `mapping-${mutation.name}-proposer`,
        kind: "agent",
        independenceDomain: `mapping-${mutation.name}-domain`,
      });
      await expect(harness.learning.propose(derivedInput(proposer, derivation))).rejects.toMatchObject({
        code: "candidate.derivation_invalid",
      });
      expect(await storedCount(harness.store, "candidate")).toBe(0);
      expect(await storedCount(harness.store, "candidate-by-digest")).toBe(0);
    }
  });

  it("allows population-grounded counterevidence but refuses duplicates across direct/counter claims", async () => {
    for (const mode of ["counter-only", "duplicate"] as const) {
      const harness = await createSemanticEngineHarness({ label: `counter-${mode}` });
      const baseFacts = createSemanticFacts(harness);
      const derivation = redigestDerivation({
        ...baseFacts.derivation,
        directObservation: {
          ...baseFacts.derivation.directObservation,
          evidenceRefs: mode === "counter-only" ? [] : [harness.evidence],
        },
        contradictoryEvidenceRefs: [harness.evidence],
      });
      const execution = bindExecutionDerivation(baseFacts.execution, derivation);
      await persistDetectorExecution(harness.context, execution, [derivation]);
      const proposer = await harness.context.identity.verify({
        principalId: `counter-${mode}-proposer`,
        kind: "agent",
        independenceDomain: `counter-${mode}-domain`,
      });
      if (mode === "counter-only") {
        await expect(harness.learning.propose(derivedInput(proposer, derivation))).resolves.toMatchObject({
          candidate: { evidenceRefs: [harness.evidence] },
        });
      } else {
        await expect(harness.learning.propose(derivedInput(proposer, derivation))).rejects.toMatchObject({
          code: "candidate.derivation_invalid",
        });
        expect(await storedCount(harness.store, "candidate")).toBe(0);
      }
    }
  });

  it("captures derivation, scope, proposer, id, risk, and supersedes getters once before awaiting", async () => {
    const { harness, facts, proposer } = await committedFixture();
    const forgedPrincipal = await harness.context.identity.verify({
      principalId: "getter-forgery",
      kind: "agent",
      independenceDomain: "forged-domain",
    });
    const reads = { id: 0, scope: 0, derivation: 0, risk: 0, proposer: 0, supersedes: 0 };
    const input = {
      get id() {
        reads.id += 1;
        return reads.id === 1 ? "getter-derived" : "forged-id";
      },
      get scope() {
        reads.scope += 1;
        return reads.scope === 1 ? facts.derivation.scope : SEMANTIC_SCOPE_B;
      },
      get derivationId() {
        reads.derivation += 1;
        return reads.derivation === 1 ? facts.derivation.id : `insight-${"0".repeat(64)}`;
      },
      get proposedRisk() {
        reads.risk += 1;
        return reads.risk === 1 ? "T1" : "T3";
      },
      get proposedBy() {
        reads.proposer += 1;
        return reads.proposer === 1 ? proposer : forgedPrincipal;
      },
      get supersedes() {
        reads.supersedes += 1;
        return reads.supersedes === 1 ? undefined : "forged-predecessor";
      },
    };
    const raw = await invokeUnknownPropose(harness.learning.propose, input);
    if (typeof raw !== "object" || raw === null || !("candidate" in raw)) {
      throw new Error("getter proposal did not return a candidate outcome");
    }
    expect(reads).toEqual({ id: 1, scope: 1, derivation: 1, risk: 1, proposer: 1, supersedes: 1 });
    expect(raw.candidate).toMatchObject({ id: "getter-derived", proposedRisk: "T1", proposedBy: proposer.ref });
  });
});

describe("derived proposal eligibility, isolation, and dedup", () => {
  it("uses the same no-oracle refusal for missing and wrong-scope derivations and never gets the foreign target", async () => {
    const base = createInMemoryStore();
    const observed = loggingStore(base);
    const { harness, facts, proposer } = await committedFixture({ store: observed.store });
    observed.enable();
    await expect(
      harness.learning.propose({
        ...derivedInput(proposer, facts.derivation),
        id: "wrong-scope-derived",
        scope: SEMANTIC_SCOPE_B,
      }),
    ).rejects.toMatchObject({ code: "candidate.derivation_not_found" });
    expect(observed.gets).not.toContainEqual({
      namespace: "learning",
      kind: "insight-derivation",
      id: facts.derivation.id,
    });
    await expect(
      harness.learning.propose({
        ...derivedInput(proposer, facts.derivation),
        id: "missing-derived",
        derivationId: `insight-${"0".repeat(64)}`,
      }),
    ).rejects.toMatchObject({ code: "candidate.derivation_not_found" });
  });

  it("refuses orphaned, historical, incomplete, and invalid derivations before candidate/index writes", async () => {
    const orphanBase = createInMemoryStore();
    const orphanHarness = await createSemanticEngineHarness({ store: failBeforeExecutionReceipt(orphanBase) });
    const orphanFacts = createSemanticFacts(orphanHarness);
    await expect(
      persistDetectorExecution(orphanHarness.context, orphanFacts.execution, [orphanFacts.derivation]),
    ).rejects.toThrow("pre-receipt derivation crash");
    const orphanProposer = await orphanHarness.context.identity.verify({
      principalId: "orphan-proposer",
      kind: "agent",
      independenceDomain: "orphan-domain",
    });
    await expect(
      orphanHarness.learning.propose(derivedInput(orphanProposer, orphanFacts.derivation)),
    ).rejects.toMatchObject({ code: "candidate.derivation_uncommitted" });

    const { harness, facts, proposer } = await committedFixture();
    const historicalContext: EngineContext = { ...harness.context, registryRevision: "f".repeat(64) };
    const { runPropose } = await import("../src/engine/propose.js");
    await expect(runPropose(historicalContext, derivedInput(proposer, facts.derivation))).rejects.toMatchObject({
      code: "candidate.derivation_historical",
    });

    const findingBase = {
      code: "source.partial" as const,
      effect: "limits_claims" as const,
      sourceId: harness.evidence.sourceId,
      sourceRegistrationRevision: harness.evidence.sourceRegistrationRevision,
      sourceRef: harness.evidence.sourceRef,
      pageRef: harness.evidence.pageRef,
      completeness: "partial" as const,
      affectedRecords: 1,
    };
    const findingDigest = evidenceHealthFindingDigest(findingBase);
    const finding = {
      schemaVersion: 1 as const,
      id: `evidence-health-${findingDigest}`,
      ...findingBase,
      findingDigest,
    };
    const findingValue = toJsonValue(finding);
    await harness.store.create(
      { namespace: "learning", kind: "evidence-health", id: finding.id },
      findingValue,
      sha256HexOfCanonicalJson(findingValue),
      "derived-incomplete-health",
    );
    await expect(
      harness.learning.propose({ ...derivedInput(proposer, facts.derivation), id: "incomplete-derived" }),
    ).rejects.toMatchObject({ code: "candidate.derivation_evidence_invalid" });

    const invalidContext: EngineContext = {
      ...harness.context,
      store: hidingGetStore(harness.store, "semantic-registry-snapshot", facts.execution.loopRegistryRevision),
    };
    await expect(
      runPropose(invalidContext, { ...derivedInput(proposer, facts.derivation), id: "invalid-derived" }),
    ).rejects.toMatchObject({ code: expect.stringMatching(/^candidate\.derivation_/) });
    expect(await storedCount(orphanBase, "candidate")).toBe(0);
  });

  it("deduplicates identical derived content while keeping manual content distinct through derivationRef", async () => {
    const { harness, facts, proposer } = await committedFixture();
    const first = await harness.learning.propose(
      derivedInput(proposer, facts.derivation, { id: "derived-dedup-first" }),
    );
    const duplicate = await harness.learning.propose(
      derivedInput(proposer, facts.derivation, { id: "derived-dedup-second" }),
    );
    expect(duplicate.candidate.id).toBe(first.candidate.id);
    expect(duplicate.governance.reasons).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "candidate.duplicate_content" })]),
    );

    const manual = await harness.learning.propose({
      id: "manual-equivalent",
      scope: facts.derivation.scope,
      problem: facts.derivation.interpretation?.statement ?? "missing",
      hypothesis: facts.derivation.impactHypothesis?.statement ?? "missing",
      evidenceIds: facts.derivation.directObservation.evidenceRefs.map((reference) => reference.recordId),
      intervention: first.candidate.intervention,
      proposedRisk: first.candidate.proposedRisk,
      proposedBy: proposer,
    });
    expect(manual.candidate.derivationRef).toBeUndefined();
    expect(manual.derivationLineage).toEqual({ status: "not_bound" });
    expect(manual.candidate.contentDigest).not.toBe(first.candidate.contentDigest);
    expect(await storedCount(harness.store, "candidate")).toBe(2);
  });

  it("keeps identical mapped fields from different derivation digests as distinct Candidate content", async () => {
    const store = createInMemoryStore();
    const harness = await createSemanticEngineHarness({ store, label: "distinct-derivation-base" });
    const extraA = await createSemanticEngineHarness({ store, label: "distinct-derivation-extra-a" });
    const extraB = await createSemanticEngineHarness({ store, label: "distinct-derivation-extra-b" });
    const baseFacts = createSemanticFacts(harness);
    const factsA = withAdditionalPopulation(baseFacts, extraA.episodeView, null);
    const factsB = withAdditionalPopulation(baseFacts, extraB.episodeView, null);
    await persistDetectorExecution(harness.context, factsA.execution, [factsA.derivation]);
    await persistDetectorExecution(harness.context, factsB.execution, [factsB.derivation]);
    const proposer = await harness.context.identity.verify({
      principalId: "distinct-derivation-proposer",
      kind: "agent",
      independenceDomain: "distinct-derivation-domain",
    });
    const candidateA = await harness.learning.propose(
      derivedInput(proposer, factsA.derivation, { id: "distinct-derivation-candidate-a" }),
    );
    const candidateB = await harness.learning.propose(
      derivedInput(proposer, factsB.derivation, { id: "distinct-derivation-candidate-b" }),
    );
    expect(candidateA.candidate).toMatchObject({
      problem: candidateB.candidate.problem,
      hypothesis: candidateB.candidate.hypothesis,
      evidenceRefs: candidateB.candidate.evidenceRefs,
      intervention: candidateB.candidate.intervention,
    });
    expect(candidateA.candidate.derivationRef).not.toEqual(candidateB.candidate.derivationRef);
    expect(candidateA.candidate.contentDigest).not.toBe(candidateB.candidate.contentDigest);
    expect(await storedCount(store, "candidate")).toBe(2);
  });

  it("retries one composite derivation change and fails without candidate/index writes after repeated churn", async () => {
    const once = derivationSnapshotChangingStore(createInMemoryStore(), "once");
    const stable = await committedFixture({ store: once.store });
    once.enable(stable.facts.derivation);
    await expect(
      stable.harness.learning.propose(
        derivedInput(stable.proposer, stable.facts.derivation, { id: "stable-derived-snapshot" }),
      ),
    ).resolves.toMatchObject({ candidate: { id: "stable-derived-snapshot" } });
    expect(once.changes()).toBe(1);

    const always = derivationSnapshotChangingStore(createInMemoryStore(), "always");
    const unstable = await committedFixture({ store: always.store });
    always.enable(unstable.facts.derivation);
    await expect(
      unstable.harness.learning.propose(
        derivedInput(unstable.proposer, unstable.facts.derivation, { id: "unstable-derived-snapshot" }),
      ),
    ).rejects.toMatchObject({ code: "candidate.derivation_snapshot_changed" });
    expect(always.changes()).toBeGreaterThanOrEqual(3);
    expect(await storedCount(unstable.harness.store, "candidate")).toBe(0);
    expect(await storedCount(unstable.harness.store, "candidate-by-digest")).toBe(0);
  });

  it("converges concurrent identical derived proposals to one Candidate content owner", async () => {
    const { harness, facts, proposer } = await committedFixture();
    const outcomes = await Promise.all([
      harness.learning.propose(derivedInput(proposer, facts.derivation, { id: "concurrent-derived-a" })),
      harness.learning.propose(derivedInput(proposer, facts.derivation, { id: "concurrent-derived-b" })),
    ]);
    expect(new Set(outcomes.map((outcome) => outcome.candidate.id)).size).toBe(1);
    expect(await storedCount(harness.store, "candidate")).toBe(1);
    expect(await storedCount(harness.store, "candidate-by-digest")).toBe(1);
  });

  it("mirrors Candidate and derivation supersession exactly and never reuses predecessor review", async () => {
    const store = createInMemoryStore();
    const harness = await createSemanticEngineHarness({ store, label: "candidate-predecessor" });
    const extra = await createSemanticEngineHarness({ store, label: "candidate-successor-population" });
    const alternate = await createSemanticEngineHarness({ store, label: "candidate-alternate-population" });
    const predecessorFacts = createSemanticFacts(harness);
    await persistDetectorExecution(harness.context, predecessorFacts.execution, [predecessorFacts.derivation]);
    const proposer = await harness.context.identity.verify({
      principalId: "supersession-proposer",
      kind: "agent",
      independenceDomain: "supersession-proposer-domain",
    });
    const predecessor = await harness.learning.propose(
      derivedInput(proposer, predecessorFacts.derivation, { id: "candidate-predecessor" }),
    );
    const reviewerPrincipal = await harness.context.identity.verify({
      principalId: "predecessor-reviewer",
      kind: "agent",
      independenceDomain: "predecessor-review-domain",
    });
    await harness.learning.reviewCandidate({
      id: "predecessor-review",
      candidateId: predecessor.candidate.id,
      reviewer: {
        id: "predecessor-review-workflow",
        version: "1.0.0",
        principal: reviewerPrincipal,
        review: (input) =>
          Promise.resolve({
            candidateId: input.candidate.id,
            candidateDigest: input.candidate.contentDigest,
            disposition: "accept",
            findings: [],
          }),
      },
    });

    const predecessorRef = {
      id: predecessorFacts.derivation.id,
      derivationDigest: predecessorFacts.derivation.derivationDigest,
      scopeDigest: predecessorFacts.derivation.scopeDigest,
    };
    const successorFacts = withAdditionalPopulation(predecessorFacts, extra.episodeView, predecessorRef);
    await persistDetectorExecution(harness.context, successorFacts.execution, [successorFacts.derivation]);
    const successor = await harness.learning.propose(
      derivedInput(proposer, successorFacts.derivation, {
        id: "candidate-successor",
        supersedes: predecessor.candidate.id,
      }),
    );
    expect(successor.candidate).toMatchObject({
      supersedes: predecessor.candidate.id,
      originalDigest: predecessor.candidate.contentDigest,
      derivationRef: {
        id: successorFacts.derivation.id,
        digest: successorFacts.derivation.derivationDigest,
      },
    });
    expect(successor.governance.review).toBe("required");
    expect((await store.list({ namespace: "learning", kind: "review", limit: 10 })).records).toHaveLength(1);

    await expect(
      harness.learning.propose(
        derivedInput(proposer, successorFacts.derivation, { id: "missing-candidate-supersedes" }),
      ),
    ).rejects.toMatchObject({ code: "candidate.derivation_supersedes_mismatch" });

    const alternateFacts = withAdditionalPopulation(predecessorFacts, alternate.episodeView, null);
    await persistDetectorExecution(harness.context, alternateFacts.execution, [alternateFacts.derivation]);
    const alternateCandidate = await harness.learning.propose(
      derivedInput(proposer, alternateFacts.derivation, { id: "alternate-derived-candidate" }),
    );
    await expect(
      harness.learning.propose(
        derivedInput(proposer, alternateFacts.derivation, {
          id: "candidate-only-supersedes",
          supersedes: predecessor.candidate.id,
        }),
      ),
    ).rejects.toMatchObject({ code: "candidate.derivation_supersedes_mismatch" });
    await expect(
      harness.learning.propose(
        derivedInput(proposer, successorFacts.derivation, {
          id: "wrong-candidate-predecessor",
          supersedes: alternateCandidate.candidate.id,
        }),
      ),
    ).rejects.toMatchObject({ code: "candidate.derivation_supersedes_mismatch" });

    await expect(
      harness.learning.propose({
        id: "manual-successor-to-derived",
        scope: predecessorFacts.derivation.scope,
        problem: predecessorFacts.derivation.interpretation?.statement ?? "missing",
        hypothesis: predecessorFacts.derivation.impactHypothesis?.statement ?? "missing",
        evidenceIds: predecessorFacts.derivation.directObservation.evidenceRefs.map((reference) => reference.recordId),
        intervention: predecessor.candidate.intervention,
        proposedRisk: "T1",
        proposedBy: proposer,
        supersedes: predecessor.candidate.id,
      }),
    ).rejects.toMatchObject({ code: "candidate.derivation_supersedes_mismatch" });

    const manualPredecessor = await harness.learning.propose({
      id: "manual-predecessor-for-derived",
      scope: predecessorFacts.derivation.scope,
      problem: "A manual predecessor cannot anchor derivation lineage.",
      hypothesis: "Derived succession must remain mirrored.",
      evidenceIds: predecessorFacts.derivation.directObservation.evidenceRefs.map((reference) => reference.recordId),
      intervention: predecessor.candidate.intervention,
      proposedRisk: "T1",
      proposedBy: proposer,
    });
    await expect(
      harness.learning.propose(
        derivedInput(proposer, predecessorFacts.derivation, {
          id: "derived-successor-to-manual",
          supersedes: manualPredecessor.candidate.id,
        }),
      ),
    ).rejects.toMatchObject({ code: "candidate.derivation_supersedes_mismatch" });
  });
});
