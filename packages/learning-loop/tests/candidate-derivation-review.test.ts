// #30b2b decisive review over derivation-backed Candidates: detached semantic
// context, post-callback graph revalidation, and producer independence.
import { describe, expect, it } from "vitest";
import type {
  CandidateReviewer,
  CandidateV2,
  InsightDerivation,
  LearningStore,
  ObservationEvidenceRef,
  VerifiedPrincipal,
} from "../src/index.js";
import {
  candidateContentDigest,
  evidenceRefDigest,
  parseCandidateReview,
  parseCandidate,
  sha256HexOfCanonicalJson,
  toJsonValue,
} from "../src/index.js";
import { evidenceHealthFindingDigest } from "../src/records/source-health.js";
import { candidateScopeDigest } from "../src/records/candidate.js";
import { contextForLearningLoop } from "../src/engine/loop.js";
import { persistDetectorExecution } from "../src/engine/semantic-persistence.js";
import { createInMemoryStore } from "../src/testing/index.js";
import { createSemanticEngineHarness, createSemanticFacts } from "./semantic-engine-harness.js";
import { SEMANTIC_SCOPE_B } from "./semantic-engine-harness.js";
import { createGenerationHarness, positiveProviderResult } from "./semantic-workflow-generation-harness.js";

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

async function appendIndexedReview(
  store: LearningStore,
  candidate: CandidateV2,
  review: ReturnType<typeof parseCandidateReview>,
): Promise<void> {
  const stream = { namespace: "learning", kind: "candidate-review", id: candidate.id };
  const stored = await store.get(stream);
  if (stored === undefined) throw new Error("indexed review fixture requires a Candidate review marker");
  const reviewValue = toJsonValue(review);
  const recordDigest = sha256HexOfCanonicalJson(reviewValue);
  const value = toJsonValue({
    kind: "review",
    reviewId: review.id,
    recordDigest,
    candidateId: candidate.id,
    candidateDigest: candidate.contentDigest,
    scopeDigest: candidateScopeDigest(candidate.scope),
  });
  const result = await store.append(
    stream,
    stored.revision,
    [{ id: `review:${review.id}`, digest: sha256HexOfCanonicalJson(value), value }],
    `seed-indexed-review/${review.id}`,
  );
  if (result.status !== "updated") throw new Error("indexed review fixture did not append its reference");
}

function candidateFoldChangingStore(base: LearningStore, mode: "semantic-once" | "review-once" | "review-always") {
  let changes = 0;
  let configured:
    | {
        readonly registryRevision: string;
        readonly candidate: CandidateV2;
        readonly reviewer: VerifiedPrincipal;
      }
    | undefined;
  const store: LearningStore = {
    get: async (key) => {
      const stored = await base.get(key);
      const value = configured;
      if (
        value !== undefined &&
        key.namespace === "learning" &&
        key.kind === "candidate-review" &&
        key.id === value.candidate.id &&
        (mode === "review-always" || changes === 0)
      ) {
        changes += 1;
        if (mode === "semantic-once") {
          const snapshotKey = {
            namespace: "learning",
            kind: "semantic-registry-snapshot",
            id: value.registryRevision,
          };
          const snapshot = await base.get(snapshotKey);
          if (snapshot === undefined) throw new Error("candidate fold requires semantic snapshot");
          const snapshotValue = toJsonValue(snapshot.value);
          const result = await base.compareAndSet(
            snapshotKey,
            snapshot.revision,
            snapshotValue,
            snapshot.digest,
            "candidate-fold-semantic-change",
          );
          if (result.status !== "updated") throw new Error("semantic fold mutation did not commit");
        } else {
          const record = parseCandidateReview({
            schemaVersion: 1,
            id: `candidate-fold-review-${changes}`,
            candidateId: value.candidate.id,
            candidateDigest: value.candidate.contentDigest,
            reviewer: value.reviewer.ref,
            reviewerAttestationDigest: value.reviewer.attestationDigest,
            reviewerImplementation: { id: "candidate-fold-reviewer", version: "1.0.0" },
            disposition: "reject",
            findings: [],
            reviewedAt: `2026-08-20T00:2${changes}:00.000Z`,
          });
          await appendIndexedReview(base, value.candidate, record);
          const reviewValue = toJsonValue(record);
          await base.create(
            { namespace: "learning", kind: "review", id: record.id },
            reviewValue,
            sha256HexOfCanonicalJson(reviewValue),
            `candidate-fold-review-${changes}`,
          );
        }
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
    configure: (value: {
      readonly registryRevision: string;
      readonly candidate: CandidateV2;
      readonly reviewer: VerifiedPrincipal;
    }) => {
      configured = value;
    },
    changes: () => changes,
  };
}

async function fixture(input: { readonly populationOnly?: boolean; readonly store?: LearningStore } = {}) {
  const harness = await createSemanticEngineHarness({
    ...(input.store === undefined ? {} : { store: input.store }),
    lensEvidenceKind: input.populationOnly === true ? "episode" : "observation",
  });
  const facts = createSemanticFacts(harness, { withEvidence: input.populationOnly !== true });
  await persistDetectorExecution(harness.context, facts.execution, [facts.derivation]);
  const proposer = await harness.context.identity.verify({
    principalId: "review-derived-proposer",
    kind: "agent",
    independenceDomain: "review-derived-proposer-domain",
  });
  const candidate = (
    await harness.learning.propose({
      id: "review-derived-candidate",
      scope: facts.derivation.scope,
      derivationId: facts.derivation.id,
      proposedRisk: "T1",
      proposedBy: proposer,
    })
  ).candidate;
  return { harness, facts, proposer, candidate };
}

async function reviewerPrincipal(
  identity: { verify(input: unknown): Promise<VerifiedPrincipal> },
  input: { readonly id: string; readonly domain: string },
): Promise<VerifiedPrincipal> {
  return identity.verify({ principalId: input.id, kind: "agent", independenceDomain: input.domain });
}

function acceptingReviewer(input: {
  readonly principal: VerifiedPrincipal;
  readonly id?: string;
  readonly version?: string;
  readonly onReview?: (value: {
    readonly candidate: CandidateV2;
    readonly evidence: readonly unknown[];
    readonly derivation: InsightDerivation | null;
  }) => void | Promise<void>;
}): CandidateReviewer {
  return {
    id: input.id ?? "independent-derived-reviewer",
    version: input.version ?? "1.0.0",
    principal: input.principal,
    review: async (value) => {
      if (value.candidate.schemaVersion !== 2) throw new Error("expected Candidate-v2 review fixture");
      await input.onReview?.({
        candidate: value.candidate,
        evidence: value.evidence,
        derivation: value.derivation,
      });
      return {
        candidateId: value.candidate.id,
        candidateDigest: value.candidate.contentDigest,
        disposition: "accept",
        findings: [],
      };
    },
  };
}

async function semanticProducerFixture() {
  const generation = await createGenerationHarness();
  const comparablePopulation = { episodeClass: "interactive", split: "held-out" };
  generation.providerState.script = (input) => {
    const envelope = positiveProviderResult(input);
    if (typeof envelope !== "object" || envelope === null || Array.isArray(envelope)) {
      throw new Error("semantic producer provider fixture is malformed");
    }
    return Promise.resolve({
      ...envelope,
      result: {
        conditionDetected: true,
        recurrenceLocator: null,
        insights: [
          {
            learningClass: "system_meta",
            directObservation: {
              statement: "The exact episode population contains a reviewable structural condition.",
              data: { condition: "semantic-producer-review" },
              evidenceReferenceDigests: [],
            },
            interpretation: {
              statement: "The condition may be reduced by a governed host intervention.",
              confidence: "unknown",
              uncertainty: ["Causal impact remains unvalidated."],
            },
            impactHypothesis: { statement: "The intervention may reduce incomplete verification attempts." },
            contradictoryEvidenceReferenceDigests: [],
            evidenceHealthFindingIds: [],
            missingEvidence: [],
            applicability: { statement: "Applies only to this exact project scope.", exclusions: [] },
            candidateIntervention: {
              summary: "Run the registered verifier before a completion claim.",
              proposedDestinationKind: "report-note",
              proposedDestinationId: "host/semantic-note",
              contentDraft: { action: "verify-before-completion" },
              rollbackIntent: "Remove the unvalidated draft.",
            },
            validation: {
              method: "comparable-held-out-episodes",
              comparablePopulation,
              comparablePopulationDigest: sha256HexOfCanonicalJson(toJsonValue(comparablePopulation)),
              successCriterion: "Verifier-backed completion claims increase.",
              guardrails: ["Do not suppress valid failures."],
              strategyDigest: generation.lens.validationStrategyDigest,
            },
            supersedes: null,
          },
        ],
        findings: [],
      },
    });
  };
  const prepared = await generation.bundle.prepareGeneration(generation.prepareInput);
  if (prepared.status !== "prepared") throw new Error(`expected prepared generation, got ${prepared.status}`);
  const generated = await generation.bundle.runGeneration({ plan: prepared.plan, authorization: null });
  if (generated.status !== "completed") throw new Error(`expected completed generation, got ${generated.status}`);
  const derivation = generated.derivations[0];
  if (derivation === undefined) throw new Error("semantic producer generation omitted its derivation");
  const producer = generation.producer;
  const context = contextForLearningLoop(generation.learning);
  const proposer = await context.identity.verify({
    principalId: "semantic-candidate-adopter",
    kind: "agent",
    independenceDomain: "semantic-adopter-domain",
  });
  const candidate = (
    await generation.learning.propose({
      id: "semantic-producer-candidate",
      scope: derivation.scope,
      derivationId: derivation.id,
      proposedRisk: "T1",
      proposedBy: proposer,
    })
  ).candidate;
  if (candidate.schemaVersion !== 2) throw new Error("expected semantic producer Candidate-v2");
  return {
    harness: { ...generation, context },
    producer,
    derivation,
    proposer,
    candidate,
  };
}

async function overwriteCandidate(
  store: LearningStore,
  candidate: CandidateV2,
  mutation: Partial<CandidateV2>,
): Promise<CandidateV2> {
  const changed = { ...candidate, ...mutation };
  const parsed = parseCandidate({ ...changed, contentDigest: candidateContentDigest(changed) });
  if (parsed.schemaVersion !== 2) throw new Error("expected overwritten Candidate-v2");
  const stored = await store.get({ namespace: "learning", kind: "candidate", id: candidate.id });
  if (stored === undefined) throw new Error("missing Candidate overwrite fixture");
  const value = toJsonValue(parsed);
  const result = await store.compareAndSet(
    stored.key,
    stored.revision,
    value,
    sha256HexOfCanonicalJson(value),
    `overwrite-derived-candidate-${candidate.id}`,
  );
  if (result.status !== "updated") throw new Error("Candidate overwrite fixture did not update");
  return parsed;
}

describe("derivation-backed review context and revalidation", () => {
  it("keeps manual review compatible and passes derivation:null", async () => {
    const harness = await createSemanticEngineHarness();
    const proposer = await reviewerPrincipal(harness.context.identity, {
      id: "manual-review-proposer",
      domain: "manual-review-proposer-domain",
    });
    const candidate = (
      await harness.learning.propose({
        id: "manual-review-candidate",
        scope: harness.scope,
        problem: "A manual candidate remains supported.",
        hypothesis: "Its reviewer receives no derivation.",
        evidenceIds: [harness.evidence.recordId],
        intervention: {
          destinationId: "host/semantic-note",
          kind: "report-note",
          content: { text: "manual" },
          rollbackIntent: "Remove the note.",
        },
        proposedRisk: "T1",
        proposedBy: proposer,
      })
    ).candidate;
    const principal = await reviewerPrincipal(harness.context.identity, {
      id: "manual-reviewer",
      domain: "manual-review-domain",
    });
    let received: InsightDerivation | null | undefined;
    await harness.learning.reviewCandidate({
      id: "manual-compatible-review",
      candidateId: candidate.id,
      reviewer: acceptingReviewer({
        principal,
        onReview: ({ derivation }) => {
          received = derivation;
        },
      }),
    });
    expect(received).toBeNull();
    await expect(harness.learning.getCandidateView({ candidateId: candidate.id })).resolves.toMatchObject({
      derivationLineage: { status: "not_bound" },
    });
  });

  it("passes population-only evidence=[] and a detached parsed derivation to the reviewer", async () => {
    const { harness, facts, candidate } = await fixture({ populationOnly: true });
    const principal = await reviewerPrincipal(harness.context.identity, {
      id: "population-reviewer",
      domain: "population-review-domain",
    });
    let callbackCandidate: CandidateV2 | undefined;
    let callbackEvidence: readonly unknown[] | undefined;
    let callbackDerivation: InsightDerivation | null | undefined;
    const reviewer = acceptingReviewer({
      principal,
      onReview: ({ candidate: reviewed, evidence, derivation }) => {
        callbackCandidate = reviewed;
        callbackEvidence = evidence;
        callbackDerivation = derivation;
        expect(Object.isFrozen(derivation)).toBe(true);
        expect(Reflect.set(derivation ?? {}, "interpretation", null)).toBe(false);
      },
    });

    await expect(
      harness.learning.reviewCandidate({ id: "population-review", candidateId: candidate.id, reviewer }),
    ).resolves.toMatchObject({ disposition: "accept" });
    expect(callbackCandidate).toEqual(candidate);
    expect(callbackEvidence).toEqual([]);
    expect(callbackDerivation).toEqual(facts.derivation);
    expect(callbackDerivation).not.toBe(facts.derivation);
  });

  it("never invokes the callback when derivation lineage is invalid before review", async () => {
    const toggled = toggledSnapshotStore(createInMemoryStore());
    const { harness, candidate } = await fixture({ store: toggled.store });
    const principal = await reviewerPrincipal(harness.context.identity, {
      id: "invalid-lineage-reviewer",
      domain: "invalid-lineage-domain",
    });
    let calls = 0;
    toggled.hide();
    await expect(
      harness.learning.reviewCandidate({
        id: "invalid-lineage-review",
        candidateId: candidate.id,
        reviewer: acceptingReviewer({
          principal,
          onReview: () => {
            calls += 1;
          },
        }),
      }),
    ).rejects.toMatchObject({ code: "review.derivation_invalid" });
    expect(calls).toBe(0);
  });

  it("revalidates the graph after callback and writes no review when it changes", async () => {
    const toggled = toggledSnapshotStore(createInMemoryStore());
    const { harness, candidate } = await fixture({ store: toggled.store });
    const principal = await reviewerPrincipal(harness.context.identity, {
      id: "toctou-derived-reviewer",
      domain: "toctou-derived-domain",
    });
    let calls = 0;
    await expect(
      harness.learning.reviewCandidate({
        id: "toctou-derived-review",
        candidateId: candidate.id,
        reviewer: acceptingReviewer({
          principal,
          onReview: () => {
            calls += 1;
            toggled.hide();
          },
        }),
      }),
    ).rejects.toMatchObject({ code: "review.derivation_invalid" });
    expect(calls).toBe(1);
    expect((await harness.store.list({ namespace: "learning", kind: "review", limit: 10 })).records).toEqual([]);
  });

  it("blocks reviewer implementation equal to deterministic derivation producer before callback", async () => {
    const { harness, facts, candidate } = await fixture();
    const principal = await reviewerPrincipal(harness.context.identity, {
      id: "implementation-reviewer",
      domain: "implementation-review-domain",
    });
    let calls = 0;
    await expect(
      harness.learning.reviewCandidate({
        id: "same-implementation-review",
        candidateId: candidate.id,
        reviewer: acceptingReviewer({
          principal,
          id: facts.derivation.producer.implementationId,
          version: facts.derivation.producer.implementationVersion,
          onReview: () => {
            calls += 1;
          },
        }),
      }),
    ).rejects.toMatchObject({ code: "review.not_independent" });
    expect(calls).toBe(0);
  });

  it("later derivation invalidation changes CandidateView lineage and blocks governance", async () => {
    const toggled = toggledSnapshotStore(createInMemoryStore());
    const { harness, candidate } = await fixture({ store: toggled.store });
    const before = await harness.store.get({ namespace: "learning", kind: "candidate", id: candidate.id });
    await expect(harness.learning.getCandidateView({ candidateId: candidate.id })).resolves.toMatchObject({
      derivationLineage: { status: "resolved" },
      evidenceHealth: { status: "ready" },
    });
    toggled.hide();
    await expect(harness.learning.getCandidateView({ candidateId: candidate.id })).resolves.toMatchObject({
      derivationLineage: { status: "invalid", derivation: expect.any(Object) },
      evidenceHealth: { status: "invalid" },
      governance: { review: "blocked", publication: "blocked" },
    });
    const after = await harness.store.get({ namespace: "learning", kind: "candidate", id: candidate.id });
    expect(after).toMatchObject({ revision: before?.revision, digest: before?.digest, value: before?.value });
  });

  it("later limits_claims health invalidates derived lineage and skips review callback", async () => {
    const { harness, facts, candidate } = await fixture();
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
    const value = toJsonValue(finding);
    await harness.store.create(
      { namespace: "learning", kind: "evidence-health", id: finding.id },
      value,
      sha256HexOfCanonicalJson(value),
      "late-derived-limits-health",
    );
    await expect(harness.learning.getCandidateView({ candidateId: candidate.id })).resolves.toMatchObject({
      derivationLineage: { status: "invalid", derivation: expect.any(Object) },
      evidenceHealth: { status: "invalid" },
      governance: { review: "blocked", publication: "blocked" },
    });
    const principal = await reviewerPrincipal(harness.context.identity, {
      id: "late-health-reviewer",
      domain: "late-health-domain",
    });
    let calls = 0;
    await expect(
      harness.learning.reviewCandidate({
        id: "late-health-review",
        candidateId: candidate.id,
        reviewer: acceptingReviewer({
          principal,
          onReview: () => {
            calls += 1;
          },
        }),
      }),
    ).rejects.toMatchObject({ code: "review.derivation_invalid" });
    expect(calls).toBe(0);
    expect(facts.derivation.id).toBe(candidate.derivationRef?.id);
  });

  it("treats stored mapping or derivationRef forgery as an exact marker corruption and never calls review", async () => {
    for (const mode of ["problem", "evidence", "intervention", "scope", "derivationRef"] as const) {
      const { harness, candidate } = await fixture();
      const reference = candidate.evidenceRefs[0];
      if (reference === undefined || reference.schemaVersion !== 1 || reference.kind !== "observation") {
        throw new Error("missing Candidate mapping observation fixture");
      }
      const { schemaVersion: _referenceSchema, referenceDigest: _referenceDigest, ...referenceBase } = reference;
      const changedReferenceBase = {
        ...referenceBase,
        episode: { ...referenceBase.episode, scopeDigest: candidateScopeDigest(SEMANTIC_SCOPE_B) },
      };
      const changedReference: ObservationEvidenceRef = {
        schemaVersion: 1,
        ...changedReferenceBase,
        kind: "observation",
        referenceDigest: evidenceRefDigest(changedReferenceBase),
      };
      const mutation: Partial<CandidateV2> =
        mode === "problem"
          ? { problem: "forged mapped problem" }
          : mode === "evidence"
            ? { evidenceRefs: [] }
            : mode === "intervention"
              ? { intervention: { ...candidate.intervention, content: { forged: true } } }
              : mode === "scope"
                ? { scope: SEMANTIC_SCOPE_B, evidenceRefs: [changedReference] }
                : {
                    derivationRef: {
                      id: `insight-${"0".repeat(64)}`,
                      digest: "0".repeat(64),
                    },
                  };
      const changed = await overwriteCandidate(harness.store, candidate, mutation);
      await expect(harness.learning.getCandidateView({ candidateId: changed.id })).rejects.toMatchObject({
        code: "store.corrupt",
      });
      const principal = await reviewerPrincipal(harness.context.identity, {
        id: `forged-${mode}-reviewer`,
        domain: `forged-${mode}-domain`,
      });
      let calls = 0;
      await expect(
        harness.learning.reviewCandidate({
          id: `forged-${mode}-review`,
          candidateId: changed.id,
          reviewer: acceptingReviewer({
            principal,
            onReview: () => {
              calls += 1;
            },
          }),
        }),
      ).rejects.toMatchObject({ code: "review.derivation_invalid" });
      expect(calls).toBe(0);
    }
  });

  it("treats forged mirrored supersession as marker corruption and an occupied review id cannot bypass lineage", async () => {
    const { harness, proposer, candidate } = await fixture();
    const manualPredecessor = await harness.learning.propose({
      id: "forged-lineage-manual-predecessor",
      scope: candidate.scope,
      problem: "A manual predecessor cannot satisfy derivation lineage.",
      hypothesis: "The fold must reject the mismatch.",
      evidenceIds: [harness.evidence.recordId],
      intervention: candidate.intervention,
      proposedRisk: "T1",
      proposedBy: proposer,
    });
    const changed = await overwriteCandidate(harness.store, candidate, {
      supersedes: manualPredecessor.candidate.id,
      originalDigest: manualPredecessor.candidate.contentDigest,
    });
    await expect(harness.learning.getCandidateView({ candidateId: changed.id })).rejects.toMatchObject({
      code: "store.corrupt",
    });

    const principal = await reviewerPrincipal(harness.context.identity, {
      id: "occupied-lineage-reviewer",
      domain: "occupied-lineage-domain",
    });
    const existing = parseCandidateReview({
      schemaVersion: 1,
      id: "occupied-lineage-review",
      candidateId: changed.id,
      candidateDigest: changed.contentDigest,
      reviewer: principal.ref,
      reviewerAttestationDigest: principal.attestationDigest,
      reviewerImplementation: { id: "occupied-lineage-workflow", version: "1.0.0" },
      disposition: "accept",
      findings: [],
      reviewedAt: "2026-08-20T00:13:00.000Z",
    });
    const value = toJsonValue(existing);
    await harness.store.create(
      { namespace: "learning", kind: "review", id: existing.id },
      value,
      sha256HexOfCanonicalJson(value),
      "seed-occupied-lineage-review",
    );
    let calls = 0;
    await expect(
      harness.learning.reviewCandidate({
        id: existing.id,
        candidateId: changed.id,
        reviewer: acceptingReviewer({
          principal,
          id: existing.reviewerImplementation.id,
          version: existing.reviewerImplementation.version,
          onReview: () => {
            calls += 1;
          },
        }),
      }),
    ).rejects.toMatchObject({ code: "review.lineage_invalid" });
    expect(calls).toBe(0);
  });
});

describe("stored review independence from derivation producer", () => {
  it("rejects reviewer principal, domain, or implementation shared with an attributed producer", async () => {
    const { harness, producer, derivation, candidate } = await semanticProducerFixture();
    const sameDomain = await reviewerPrincipal(harness.context.identity, {
      id: "same-producer-domain-reviewer",
      domain: producer.ref.independenceDomain,
    });
    const independent = await reviewerPrincipal(harness.context.identity, {
      id: "independent-semantic-reviewer",
      domain: "independent-semantic-domain",
    });
    const cases = [
      {
        id: "producer-principal-review",
        reviewer: acceptingReviewer({ principal: producer }),
      },
      {
        id: "producer-domain-review",
        reviewer: acceptingReviewer({ principal: sameDomain }),
      },
      {
        id: "producer-implementation-review",
        reviewer: acceptingReviewer({
          principal: independent,
          id: derivation.producer.implementationId,
          version: derivation.producer.implementationVersion,
        }),
      },
    ];
    for (const fixtureCase of cases) {
      let calls = 0;
      const reviewer: CandidateReviewer = {
        ...fixtureCase.reviewer,
        review: (input) => {
          calls += 1;
          return fixtureCase.reviewer.review(input);
        },
      };
      await expect(
        harness.learning.reviewCandidate({ id: fixtureCase.id, candidateId: candidate.id, reviewer }),
      ).rejects.toMatchObject({ code: "review.not_independent" });
      expect(calls).toBe(0);
    }

    let independentCalls = 0;
    await expect(
      harness.learning.reviewCandidate({
        id: "independent-semantic-review",
        candidateId: candidate.id,
        reviewer: acceptingReviewer({
          principal: independent,
          id: "other-reviewer",
          version: "2.0.1",
          onReview: () => {
            independentCalls += 1;
          },
        }),
      }),
    ).resolves.toMatchObject({ disposition: "accept" });
    expect(independentCalls).toBe(1);
  });

  it("treats a forged accepted review by the producer implementation as store corruption", async () => {
    const { harness, facts, candidate } = await fixture();
    const principal = await reviewerPrincipal(harness.context.identity, {
      id: "forged-implementation-principal",
      domain: "forged-implementation-domain",
    });
    const record = parseCandidateReview({
      schemaVersion: 1,
      id: "forged-producer-review",
      candidateId: candidate.id,
      candidateDigest: candidate.contentDigest,
      reviewer: principal.ref,
      reviewerAttestationDigest: principal.attestationDigest,
      reviewerImplementation: {
        id: facts.derivation.producer.implementationId,
        version: facts.derivation.producer.implementationVersion,
      },
      disposition: "accept",
      findings: [],
      reviewedAt: "2026-08-20T00:10:00.000Z",
    });
    const value = toJsonValue(record);
    await appendIndexedReview(harness.store, candidate, record);
    await harness.store.create(
      { namespace: "learning", kind: "review", id: record.id },
      value,
      sha256HexOfCanonicalJson(value),
      "forge-producer-review",
    );
    await expect(harness.learning.getCandidateView({ candidateId: candidate.id })).rejects.toMatchObject({
      code: "store.corrupt",
    });
  });

  it("treats stored accepted reviews by the attributed producer principal or domain as corruption", async () => {
    for (const mode of ["principal", "domain"] as const) {
      const { harness, producer, candidate } = await semanticProducerFixture();
      const reviewer =
        mode === "principal"
          ? producer
          : await reviewerPrincipal(harness.context.identity, {
              id: "forged-same-domain-principal",
              domain: producer.ref.independenceDomain,
            });
      const record = parseCandidateReview({
        schemaVersion: 1,
        id: `forged-producer-${mode}-review`,
        candidateId: candidate.id,
        candidateDigest: candidate.contentDigest,
        reviewer: reviewer.ref,
        reviewerAttestationDigest: reviewer.attestationDigest,
        reviewerImplementation: { id: `forged-${mode}-workflow`, version: "1.0.0" },
        disposition: "accept",
        findings: [],
        reviewedAt: "2026-08-20T00:11:00.000Z",
      });
      const value = toJsonValue(record);
      await appendIndexedReview(harness.store, candidate, record);
      await harness.store.create(
        { namespace: "learning", kind: "review", id: record.id },
        value,
        sha256HexOfCanonicalJson(value),
        `forge-producer-${mode}-review`,
      );
      await expect(harness.learning.getCandidateView({ candidateId: candidate.id })).rejects.toMatchObject({
        code: "store.corrupt",
      });
    }
  });

  it("does not let an occupied review id bypass producer independence", async () => {
    const { harness, producer, derivation, candidate } = await semanticProducerFixture();
    const record = parseCandidateReview({
      schemaVersion: 1,
      id: "occupied-producer-review",
      candidateId: candidate.id,
      candidateDigest: candidate.contentDigest,
      reviewer: producer.ref,
      reviewerAttestationDigest: producer.attestationDigest,
      reviewerImplementation: {
        id: derivation.producer.implementationId,
        version: derivation.producer.implementationVersion,
      },
      disposition: "accept",
      findings: [],
      reviewedAt: "2026-08-20T00:12:00.000Z",
    });
    const value = toJsonValue(record);
    await harness.store.create(
      { namespace: "learning", kind: "review", id: record.id },
      value,
      sha256HexOfCanonicalJson(value),
      "seed-occupied-producer-review",
    );
    let calls = 0;
    await expect(
      harness.learning.reviewCandidate({
        id: record.id,
        candidateId: candidate.id,
        reviewer: acceptingReviewer({
          principal: producer,
          id: derivation.producer.implementationId,
          version: derivation.producer.implementationVersion,
          onReview: () => {
            calls += 1;
          },
        }),
      }),
    ).rejects.toMatchObject({ code: "review.not_independent" });
    expect(calls).toBe(0);
  });
});

describe("CandidateView composite semantic/review snapshots", () => {
  for (const mode of ["semantic-once", "review-once", "review-always"] as const) {
    it(`${mode} never returns stale accepted governance`, async () => {
      const changing = candidateFoldChangingStore(createInMemoryStore(), mode);
      const { harness, candidate } = await fixture({ store: changing.store });
      const principal = await reviewerPrincipal(harness.context.identity, {
        id: `candidate-fold-${mode}-principal`,
        domain: `candidate-fold-${mode}-domain`,
      });
      await harness.learning.reviewCandidate({
        id: `candidate-fold-initial-${mode}`,
        candidateId: candidate.id,
        reviewer: acceptingReviewer({ principal, id: "candidate-fold-reviewer", version: "1.0.0" }),
      });
      changing.configure({
        registryRevision: harness.context.registryRevision,
        candidate,
        reviewer: principal,
      });

      if (mode === "review-always") {
        await expect(harness.learning.getCandidateView({ candidateId: candidate.id })).rejects.toMatchObject({
          code: "candidate.snapshot_changed",
        });
        expect(changing.changes()).toBeGreaterThanOrEqual(3);
      } else {
        const view = await harness.learning.getCandidateView({ candidateId: candidate.id });
        expect(changing.changes()).toBe(1);
        if (mode === "semantic-once") {
          expect(view?.governance.review).toBe("accepted");
        } else {
          expect(view?.governance.review).not.toBe("accepted");
          expect(view?.governance).toMatchObject({ review: "blocked", publication: "blocked" });
        }
      }
    });
  }
});

describe("manual Candidate supersession versus derivation lineage", () => {
  it("treats post-receipt manual supersession mutation as exact marker corruption", async () => {
    const store = createInMemoryStore();
    const harness = await createSemanticEngineHarness({ store, label: "manual-lineage-a" });
    const projectB = await createSemanticEngineHarness({
      store,
      label: "manual-lineage-b",
      scope: [{ type: "project", id: "manual-lineage-project-b" }],
    });
    const proposer = await reviewerPrincipal(harness.context.identity, {
      id: "manual-lineage-proposer",
      domain: "manual-lineage-domain",
    });
    const proposerB = await reviewerPrincipal(projectB.context.identity, {
      id: "manual-lineage-proposer-b",
      domain: "manual-lineage-domain-b",
    });
    const proposeManual = (
      id: string,
      input: {
        readonly learning: typeof harness.learning;
        readonly scope: typeof harness.scope;
        readonly evidenceId: string;
        readonly proposedBy: VerifiedPrincipal;
      } = {
        learning: harness.learning,
        scope: harness.scope,
        evidenceId: harness.evidence.recordId,
        proposedBy: proposer,
      },
    ) =>
      input.learning.propose({
        id,
        scope: input.scope,
        problem: `Manual problem ${id}`,
        hypothesis: `Manual hypothesis ${id}`,
        evidenceIds: [input.evidenceId],
        intervention: {
          destinationId: "host/semantic-note",
          kind: "report-note",
          content: { id },
          rollbackIntent: "Remove the note.",
        },
        proposedRisk: "T1",
        proposedBy: input.proposedBy,
      });

    const sameScopePredecessor = await proposeManual("manual-lineage-predecessor");
    const projectBPredecessor = await proposeManual("manual-lineage-project-b-predecessor", {
      learning: projectB.learning,
      scope: projectB.scope,
      evidenceId: projectB.evidence.recordId,
      proposedBy: proposerB,
    });
    const defects = [
      {
        id: "manual-lineage-missing",
        supersedes: "missing-manual-predecessor",
        originalDigest: "0".repeat(64),
        reason: "candidate.supersedes_not_found",
      },
      {
        id: "manual-lineage-self",
        supersedes: "manual-lineage-self",
        originalDigest: "0".repeat(64),
        reason: "candidate.supersedes_invalid",
      },
      {
        id: "manual-lineage-digest",
        supersedes: sameScopePredecessor.candidate.id,
        originalDigest: "0".repeat(64),
        reason: "candidate.original_digest_mismatch",
      },
      {
        id: "manual-lineage-scope",
        supersedes: projectBPredecessor.candidate.id,
        originalDigest: projectBPredecessor.candidate.contentDigest,
        reason: "candidate.supersedes_scope_mismatch",
      },
    ];
    for (const defect of defects) {
      const proposed = await proposeManual(defect.id);
      const changed = await overwriteCandidate(store, proposed.candidate, {
        supersedes: defect.supersedes,
        originalDigest: defect.originalDigest,
      });
      await expect(harness.learning.getCandidateView({ candidateId: changed.id })).rejects.toMatchObject({
        code: "store.corrupt",
      });
    }

    const facts = createSemanticFacts(harness);
    await persistDetectorExecution(harness.context, facts.execution, [facts.derivation]);
    const derivedPredecessor = await harness.learning.propose({
      id: "manual-lineage-derived-predecessor",
      scope: facts.derivation.scope,
      derivationId: facts.derivation.id,
      proposedRisk: "T1",
      proposedBy: proposer,
    });
    const manualSuccessor = await proposeManual("manual-lineage-to-derived");
    const forged = await overwriteCandidate(store, manualSuccessor.candidate, {
      supersedes: derivedPredecessor.candidate.id,
      originalDigest: derivedPredecessor.candidate.contentDigest,
    });
    await expect(harness.learning.getCandidateView({ candidateId: forged.id })).rejects.toMatchObject({
      code: "store.corrupt",
    });
  });
});
