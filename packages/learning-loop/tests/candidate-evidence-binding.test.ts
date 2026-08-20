// Candidate-v2 evidence binding conformance (#31b): exact durable ids,
// collision-safe source/episode/page lineage, health-gated inert governance,
// explicit supersession, and fail-closed revalidation after durable changes.
import { describe, expect, it } from "vitest";
import type {
  CandidateReviewer,
  CandidateV1,
  EvidencePage,
  LearningStore,
  QueryPage,
  RegisteredSource,
  Scope,
  ScopePolicy,
  VerifiedPrincipal,
} from "../src/index.js";
import {
  candidateContentDigest,
  conservativePolicy,
  createLearningLoop,
  defineSourceRegistration,
  parseCandidate,
  parseObservation,
  parseSourcePageReceipt,
  sha256HexOfCanonicalJson,
  toJsonValue,
} from "../src/index.js";
import { recordDigest } from "../src/engine/context.js";
import { buildHealthFinding, buildSourcePageReceipt } from "../src/engine/source-receipts.js";
import {
  createExactScopePolicy,
  createFixedClock,
  createInMemoryStore,
  createSequentialIds,
  createStructuredContentPolicy,
  createTestIdentityPort,
} from "../src/testing/index.js";
import {
  CONTENT_POLICY_ID,
  SCOPE,
  candidateInput,
  createCandidateHarness,
  createHarness,
  reviewerFor,
  scriptedSource,
} from "./engine-harness.js";

const PROJECT_A: Scope = [{ type: "project", id: "project-a" }];
const PROJECT_B: Scope = [{ type: "project", id: "project-b" }];

async function itemsOf<T>(iterable: AsyncIterable<QueryPage<T>>): Promise<readonly T[]> {
  const items: T[] = [];
  for await (const page of iterable) items.push(...page.items);
  return items;
}

async function storedValues(store: LearningStore, kind: string): Promise<readonly unknown[]> {
  const values: unknown[] = [];
  let cursor: string | undefined;
  do {
    const page = await store.list({
      namespace: "learning",
      kind,
      limit: 500,
      ...(cursor === undefined ? {} : { cursor }),
    });
    values.push(...page.records.map((record) => record.value));
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return values;
}

async function expectNoCandidateWrites(store: LearningStore, candidateId: string): Promise<void> {
  expect(await store.get({ namespace: "learning", kind: "candidate", id: candidateId })).toBeUndefined();
  expect(await storedValues(store, "candidate-by-digest")).toEqual([]);
}

async function overwriteRecord(
  store: LearningStore,
  kind: string,
  id: string,
  value: unknown,
  operationId: string,
): Promise<void> {
  const current = await store.get({ namespace: "learning", kind, id });
  if (current === undefined) throw new Error(`missing ${kind} fixture ${id}`);
  const json = toJsonValue(value);
  await expect(
    store.compareAndSet({ namespace: "learning", kind, id }, current.revision, json, recordDigest(json), operationId),
  ).resolves.toMatchObject({ status: "updated" });
}

function snapshotChangingStore(
  base: LearningStore,
  mode: "once" | "always",
): { readonly store: LearningStore; readonly mutationCount: () => number } {
  let mutations = 0;
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
      if (query.kind === "source-page-receipt" && query.limit === 100 && (mode === "always" || mutations === 0)) {
        const finding = buildHealthFinding({
          code: "source.partial",
          effect: "limits_claims",
          sourceId: "snapshot-noise",
          sourceRegistrationRevision: "f".repeat(64),
          sourceRef: "unrelated-artifact",
          pageRef: `unrelated-page-${mutations}`,
          completeness: "complete",
          affectedRecords: 0,
        });
        const value = toJsonValue(finding);
        const result = await base.create(
          { namespace: "learning", kind: "evidence-health", id: finding.id },
          value,
          recordDigest(value),
          `snapshot-noise-${mutations}`,
        );
        if (result.status !== "created") throw new Error("snapshot fixture mutation was not created");
        mutations += 1;
      }
      return page;
    },
  };
  return { store, mutationCount: () => mutations };
}

function page(input: {
  readonly sourceRef: string;
  readonly pageRef: string;
  readonly revision: string;
  readonly completeness: "complete" | "partial" | "unknown";
  readonly observations?: EvidencePage["observations"];
  readonly episodes?: EvidencePage["episodes"];
  readonly measurements?: EvidencePage["measurements"];
  readonly diagnostics?: EvidencePage["diagnostics"];
}): EvidencePage {
  return {
    sourceRef: input.sourceRef,
    pageRef: input.pageRef,
    state: {
      status: "available",
      sourceRevision: input.revision,
      completeness: input.completeness,
    },
    observations: input.observations ?? [],
    measurements: input.measurements ?? [],
    episodes: input.episodes ?? [],
    diagnostics: input.diagnostics ?? [],
  };
}

function boundPages(input: {
  readonly revision: string;
  readonly scope: Scope;
  readonly completeness?: "complete" | "partial" | "unknown";
  readonly observationIds?: readonly string[];
  readonly sourceRef?: string;
  readonly diagnostic?: EvidencePage["diagnostics"][number];
  readonly privateCanary?: string;
}): readonly EvidencePage[] {
  const completeness = input.completeness ?? "complete";
  const observationIds = input.observationIds ?? ["observation-a"];
  const sourceRef = input.sourceRef ?? "artifact-ref";
  return [
    page({
      sourceRef,
      pageRef: "evidence-page",
      revision: input.revision,
      completeness,
      observations: observationIds.map((sourceRecordId) => ({
        sourceRecordId,
        episodeId: "logical-episode",
        kind: "agent.turn.completed",
        data: input.privateCanary === undefined ? { phase: "complete" } : { privateContent: input.privateCanary },
        completeness,
      })),
      ...(input.diagnostic === undefined ? {} : { diagnostics: [input.diagnostic] }),
    }),
    page({
      sourceRef,
      pageRef: "episode-page",
      revision: input.revision,
      completeness,
      episodes: [
        {
          sourceRecordId: "episode-record",
          episodeId: "logical-episode",
          episodeClass: "interactive",
          completeness,
          scope: input.scope,
          openedAt: "2026-08-19T00:00:00.000Z",
          closedAt: "2026-08-19T00:01:00.000Z",
          status: "succeeded",
          measurementSourceRecordIds: [],
        },
      ],
    }),
  ];
}

function registerBoundSource(id: string, pages: () => readonly EvidencePage[]): RegisteredSource<null> {
  return defineSourceRegistration({
    source: scriptedSource(id, pages),
    trustCeiling: "observed",
    contentPolicyId: CONTENT_POLICY_ID,
  });
}

async function insertLegacyCandidate(store: LearningStore, candidate: CandidateV1): Promise<void> {
  const value = toJsonValue(candidate);
  await expect(
    store.create(
      { namespace: "learning", kind: "candidate", id: candidate.id },
      value,
      recordDigest(value),
      `legacy/${candidate.id}`,
    ),
  ).resolves.toMatchObject({ status: "created" });
}

function legacyCandidate(input: {
  readonly id: string;
  readonly proposedBy: CandidateV1["proposedBy"];
  readonly proposerAttestationDigest: string;
}): CandidateV1 {
  const bound = {
    scope: SCOPE,
    problem: "Historical unbound candidate.",
    hypothesis: "Historical evidence ids may have supported this claim.",
    evidenceIds: ["manual-evidence/obs-42-typecheck"],
    intervention: {
      destinationId: "agent-instructions",
      kind: "procedure",
      content: { text: "Historical content." },
      rollbackIntent: "Remove the historical content.",
    },
    proposedRisk: "T1" as const,
  };
  return {
    schemaVersion: 1,
    id: input.id,
    ...bound,
    proposedBy: input.proposedBy,
    proposerAttestationDigest: input.proposerAttestationDigest,
    proposedAt: "2026-08-15T00:00:00.000Z",
    contentDigest: candidateContentDigest(bound),
  };
}

function countingReviewer(principal: Parameters<typeof reviewerFor>[0], calls: { value: number }): CandidateReviewer {
  return reviewerFor(principal, (input) => {
    calls.value += 1;
    return {
      candidateId: input.candidate.id,
      candidateDigest: input.candidate.contentDigest,
      disposition: "accept",
      findings: [],
    };
  });
}

describe("Candidate-v2 exact evidence binding", () => {
  it("preserves request order and binds separate evidence/episode receipts without persisting private content", async () => {
    const privateCanary = "PRIVATE-EVIDENCE-CONTENT-CANARY-31b";
    const source = registerBoundSource("ordered-source", () =>
      boundPages({
        revision: "ordered-revision",
        scope: PROJECT_A,
        observationIds: ["observation-a", "observation-b"],
        privateCanary,
      }),
    );
    const { learning, proposer } = await createHarness([source]);
    await learning.ingest(source, null);

    const outcome = await learning.propose(
      candidateInput(proposer, {
        id: "ordered-candidate",
        scope: PROJECT_A,
        evidenceIds: ["ordered-source/observation-b", "ordered-source/observation-a"],
      }),
    );

    expect(outcome.candidate.schemaVersion).toBe(2);
    expect(outcome.evidenceHealth).toEqual({ status: "ready", diagnostics: [] });
    expect(outcome.candidate.evidenceRefs.map((reference) => reference.recordId)).toEqual([
      "ordered-source/observation-b",
      "ordered-source/observation-a",
    ]);
    for (const reference of outcome.candidate.evidenceRefs) {
      expect(reference).toMatchObject({
        kind: "observation",
        sourceId: "ordered-source",
        sourceRecordId: expect.stringMatching(/^observation-/),
        pageRef: "evidence-page",
        completeness: "complete",
        trust: "observed",
        episode: {
          sourceId: "ordered-source",
          episodeId: "logical-episode",
          episodeRecordId: "ordered-source/episode-record",
        },
      });
      expect(reference.pageReceiptId).not.toBe(reference.episode.pageReceiptId);
      expect(reference.referenceDigest).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(JSON.stringify(outcome.candidate)).not.toContain(privateCanary);
    await expect(learning.getCandidateView({ candidateId: outcome.candidate.id })).resolves.toMatchObject({
      evidenceHealth: { status: "ready" },
      governance: { review: "required", publication: "blocked" },
    });
  });

  it("refuses empty, raw, missing, and duplicate evidence ids before candidate or digest-index writes", async () => {
    const cases: readonly { readonly id: string; readonly evidenceIds: readonly string[] }[] = [
      { id: "empty-evidence", evidenceIds: [] },
      { id: "raw-evidence", evidenceIds: ["obs-42-typecheck"] },
      { id: "missing-evidence", evidenceIds: ["manual-evidence/missing"] },
      {
        id: "duplicate-evidence",
        evidenceIds: ["manual-evidence/obs-42-typecheck", "manual-evidence/obs-42-typecheck"],
      },
    ];
    for (const testCase of cases) {
      const { learning, store, proposer } = await createCandidateHarness();
      await expect(
        learning.propose(candidateInput(proposer, { id: testCase.id, evidenceIds: testCase.evidenceIds })),
      ).rejects.toMatchObject({ code: "candidate.evidence_invalid" });
      await expectNoCandidateWrites(store, testCase.id);
    }
  });

  it("refuses exact evidence whose episode belongs to another project before any candidate write", async () => {
    const { learning, store, proposer } = await createCandidateHarness();
    await expect(
      learning.propose(candidateInput(proposer, { id: "scope-mismatch", scope: PROJECT_B })),
    ).rejects.toMatchObject({ code: "candidate.evidence_invalid" });
    await expectNoCandidateWrites(store, "scope-mismatch");
  });

  it("refuses an existing evidence record whose source-page commit marker is missing", async () => {
    const { learning, store, manual, proposer } = await createCandidateHarness();
    const receipts = await itemsOf(learning.querySourcePageReceipts({ sourceIds: [manual.id], limit: 10 }));
    const receipt = receipts[0];
    if (receipt === undefined) throw new Error("missing source page receipt fixture");
    const stored = await store.get({ namespace: "learning", kind: "source-page-receipt", id: receipt.id });
    if (stored === undefined) throw new Error("missing stored source page receipt fixture");
    await expect(
      store.tombstone({
        key: { namespace: "learning", kind: "source-page-receipt", id: receipt.id },
        expectedRevision: stored.revision,
        reasonCode: "test.missing_commit_marker",
        operationId: "remove-page-receipt",
      }),
    ).resolves.toMatchObject({ status: "updated" });

    await expect(learning.propose(candidateInput(proposer, { id: "missing-receipt-candidate" }))).rejects.toMatchObject(
      { code: "candidate.evidence_invalid" },
    );
    await expectNoCandidateWrites(store, "missing-receipt-candidate");
  });

  it("keeps same-native-id sources and projects isolated and selects only the exact qualified record", async () => {
    const privateCanary = "PRIVATE-CROSS-PROJECT-CANARY-31b";
    const sourceA = registerBoundSource("project-a-source", () =>
      boundPages({
        revision: "project-a-revision",
        scope: PROJECT_A,
        observationIds: ["shared-native-id"],
        privateCanary,
      }),
    );
    const sourceB = registerBoundSource("project-b-source", () =>
      boundPages({
        revision: "project-b-revision",
        scope: PROJECT_B,
        observationIds: ["shared-native-id"],
        privateCanary,
      }),
    );
    const { learning, store, proposer } = await createHarness([sourceA, sourceB]);
    await learning.ingest(sourceA, null);
    await learning.ingest(sourceB, null);

    const projectA = await learning.propose(
      candidateInput(proposer, {
        id: "project-a-candidate",
        scope: PROJECT_A,
        evidenceIds: ["project-a-source/shared-native-id"],
      }),
    );
    expect(projectA.candidate.evidenceRefs[0]?.sourceId).toBe("project-a-source");
    expect(JSON.stringify(projectA.candidate)).not.toContain(privateCanary);
    const indexCountBeforeRefusal = (await storedValues(store, "candidate-by-digest")).length;

    await expect(
      learning.propose(
        candidateInput(proposer, {
          id: "cross-project-candidate",
          scope: PROJECT_A,
          evidenceIds: ["project-b-source/shared-native-id"],
        }),
      ),
    ).rejects.toMatchObject({ code: "candidate.evidence_invalid" });
    expect(
      await store.get({ namespace: "learning", kind: "candidate", id: "cross-project-candidate" }),
    ).toBeUndefined();
    expect(await storedValues(store, "candidate-by-digest")).toHaveLength(indexCountBeforeRefusal);

    await expect(learning.report({ scope: PROJECT_A })).resolves.toMatchObject({
      candidateIds: ["project-a-candidate"],
    });
    await expect(
      learning.report({ sourceIds: ["project-b-source"], episodeIds: ["logical-episode"] }),
    ).resolves.toMatchObject({ candidateIds: [] });
  });

  it("refuses ambiguous exact derivative receipts before candidate and digest-index writes", async () => {
    const { learning, store, manual, proposer } = await createCandidateHarness();
    const receipts = await itemsOf(learning.querySourcePageReceipts({ sourceIds: [manual.id], limit: 10 }));
    const original = receipts[0];
    if (original === undefined || original.state.status !== "available") throw new Error("missing receipt fixture");
    const derivative = original.derivatives.find(
      (item) => item.kind === "observation" && item.id === "manual-evidence/obs-42-typecheck",
    );
    if (derivative === undefined) throw new Error("missing observation derivative fixture");
    const ambiguous = buildSourcePageReceipt({
      sourceId: original.sourceId,
      sourceRegistrationRevision: original.sourceRegistrationRevision,
      adapterVersion: original.adapterVersion,
      contentPolicyId: original.contentPolicyId,
      contentPolicyDigest: original.contentPolicyDigest,
      loopRegistryRevision: original.loopRegistryRevision,
      sourceRef: original.sourceRef,
      pageRef: "ambiguous-evidence-page",
      state: original.state,
      derivatives: [derivative],
      projectionCounts: { observations: 1, measurements: 0, episodes: 0, rejected: 0 },
      diagnostics: [],
      healthFindingIds: [],
    });
    const value = toJsonValue(ambiguous);
    await expect(
      store.create(
        { namespace: "learning", kind: "source-page-receipt", id: ambiguous.id },
        value,
        recordDigest(value),
        "ambiguous-receipt",
      ),
    ).resolves.toMatchObject({ status: "created" });

    await expect(
      learning.propose(candidateInput(proposer, { id: "ambiguous-receipt-candidate" })),
    ).rejects.toMatchObject({ code: "candidate.evidence_invalid" });
    await expectNoCandidateWrites(store, "ambiguous-receipt-candidate");
  });

  it("refuses a conflicting episode identity before candidate and digest-index writes", async () => {
    const { learning, store, manual, proposer } = await createCandidateHarness();
    const episodeRecordId = "manual-evidence/change-42";
    const identityStream = await store.get({ namespace: "learning", kind: "episode-identity", id: episodeRecordId });
    if (identityStream === undefined) throw new Error("missing episode identity fixture");
    const conflictingIdentity = {
      schemaVersion: 1,
      episodeRecordId,
      sourceId: manual.id,
      sourceRecordId: "change-42",
      episodeId: "conflicting-logical-episode",
      registryRevision: manual.registryRevision,
      trustCeiling: manual.trustCeiling,
      completeness: "complete",
    };
    const value = toJsonValue(conflictingIdentity);
    const digest = recordDigest(value);
    await expect(
      store.append(
        { namespace: "learning", kind: "episode-identity", id: episodeRecordId },
        identityStream.revision,
        [{ id: `identity:${digest}`, digest, value }],
        "conflicting-episode-identity",
      ),
    ).resolves.toMatchObject({ status: "updated" });

    await expect(
      learning.propose(candidateInput(proposer, { id: "identity-conflict-candidate" })),
    ).rejects.toMatchObject({ code: "candidate.evidence_invalid" });
    await expectNoCandidateWrites(store, "identity-conflict-candidate");
  });

  for (const fixture of [
    { name: "partial", completeness: "partial" as const, diagnostic: undefined },
    {
      name: "blocks-audit",
      completeness: "complete" as const,
      diagnostic: {
        code: "source.incomplete",
        severity: "error" as const,
        message: "synthetic adapter evidence is not audit-grade",
      },
    },
  ]) {
    it(`persists ${fixture.name} evidence only as an inert incomplete candidate and never calls a reviewer`, async () => {
      const source = registerBoundSource(`incomplete-${fixture.name}`, () =>
        boundPages({
          revision: `${fixture.name}-revision`,
          scope: PROJECT_A,
          completeness: fixture.completeness,
          ...(fixture.diagnostic === undefined ? {} : { diagnostic: fixture.diagnostic }),
        }),
      );
      const { learning, proposer, reviewerB } = await createHarness([source]);
      await learning.ingest(source, null);
      const outcome = await learning.propose(
        candidateInput(proposer, {
          id: `${fixture.name}-candidate`,
          scope: PROJECT_A,
          evidenceIds: [`incomplete-${fixture.name}/observation-a`],
        }),
      );
      expect(outcome.evidenceHealth.status).toBe("incomplete");
      expect(outcome.governance).toMatchObject({ review: "blocked", publication: "blocked" });

      const calls = { value: 0 };
      await expect(
        learning.reviewCandidate({
          id: `${fixture.name}-review`,
          candidateId: outcome.candidate.id,
          reviewer: countingReviewer(reviewerB, calls),
        }),
      ).rejects.toMatchObject({ code: "review.evidence_incomplete" });
      expect(calls.value).toBe(0);
    });
  }

  it("refuses blocks_use evidence before candidate or digest-index writes", async () => {
    let revision = "usable-r1";
    const source = registerBoundSource("blocks-use-source", () => boundPages({ revision, scope: PROJECT_A }));
    const { learning, store, proposer } = await createHarness([source]);
    await learning.ingest(source, null);
    revision = "blocked-r2";
    await learning.ingest(source, null);

    await expect(
      learning.propose(
        candidateInput(proposer, {
          id: "blocks-use-candidate",
          scope: PROJECT_A,
          evidenceIds: ["blocks-use-source/observation-a"],
        }),
      ),
    ).rejects.toMatchObject({ code: "candidate.evidence_invalid" });
    await expectNoCandidateWrites(store, "blocks-use-candidate");
  });

  it("refuses measurement evidence until #31c ownership rules land", async () => {
    const { learning, store, proposer } = await createCandidateHarness();
    await expect(
      learning.propose(
        candidateInput(proposer, {
          id: "measurement-candidate",
          evidenceIds: ["manual-evidence/measure-42-typecheck"],
        }),
      ),
    ).rejects.toMatchObject({ code: "candidate.evidence_invalid" });
    await expectNoCandidateWrites(store, "measurement-candidate");
  });

  it("retries one composite evidence snapshot change and commits only the stable result", async () => {
    const changing = snapshotChangingStore(createInMemoryStore(), "once");
    const { learning, proposer } = await createCandidateHarness([], { store: changing.store });

    const outcome = await learning.propose(candidateInput(proposer, { id: "snapshot-retry-candidate" }));
    expect(changing.mutationCount()).toBe(1);
    expect(outcome).toMatchObject({
      candidate: { id: "snapshot-retry-candidate", schemaVersion: 2 },
      evidenceHealth: { status: "ready" },
    });
  });

  it("fails after three unstable evidence snapshots without writing a candidate or digest index", async () => {
    const changing = snapshotChangingStore(createInMemoryStore(), "always");
    const { learning, store, proposer } = await createCandidateHarness([], { store: changing.store });

    await expect(learning.propose(candidateInput(proposer, { id: "snapshot-never-stable" }))).rejects.toMatchObject({
      code: "evidence.snapshot_changed",
    });
    expect(changing.mutationCount()).toBeGreaterThanOrEqual(3);
    await expectNoCandidateWrites(store, "snapshot-never-stable");
  });
});

describe("legacy and supersession evidence lineage", () => {
  it("keeps v1 audit bytes legacy_unbound and refuses review before invoking the callback", async () => {
    const { learning, store, proposer, reviewerB } = await createCandidateHarness();
    const legacy = legacyCandidate({
      id: "legacy-candidate",
      proposedBy: proposer.ref,
      proposerAttestationDigest: proposer.attestationDigest,
    });
    await insertLegacyCandidate(store, legacy);

    const view = await learning.getCandidateView({ candidateId: legacy.id });
    expect(view).toMatchObject({
      candidate: legacy,
      evidenceHealth: { status: "legacy_unbound" },
      governance: { review: "blocked", publication: "blocked" },
    });
    expect((await learning.report({})).candidateIds).toContain(legacy.id);
    expect((await learning.report({ sourceIds: ["manual-evidence"] })).candidateIds).not.toContain(legacy.id);

    const calls = { value: 0 };
    await expect(
      learning.reviewCandidate({
        id: "legacy-review",
        candidateId: legacy.id,
        reviewer: countingReviewer(reviewerB, calls),
      }),
    ).rejects.toMatchObject({ code: "review.evidence_unbound" });
    expect(calls.value).toBe(0);
    expect((await store.get({ namespace: "learning", kind: "candidate", id: legacy.id }))?.value).toEqual(
      toJsonValue(legacy),
    );
  });

  it("derives originalDigest for explicit v1 and v2 successors without carrying reviews forward", async () => {
    const { learning, store, proposer, reviewerB } = await createCandidateHarness();
    const legacy = legacyCandidate({
      id: "legacy-predecessor",
      proposedBy: proposer.ref,
      proposerAttestationDigest: proposer.attestationDigest,
    });
    await insertLegacyCandidate(store, legacy);

    const fromLegacy = await learning.propose(
      candidateInput(proposer, {
        id: "successor-from-v1",
        hypothesis: "A newly bound candidate replaces the legacy claim.",
        supersedes: legacy.id,
      }),
    );
    expect(fromLegacy.candidate).toMatchObject({
      schemaVersion: 2,
      supersedes: legacy.id,
      originalDigest: legacy.contentDigest,
    });
    expect(fromLegacy.governance.review).toBe("required");

    const predecessorV2 = await learning.propose(
      candidateInput(proposer, {
        id: "v2-predecessor",
        problem: "A separately reviewed v2 predecessor.",
      }),
    );
    await learning.reviewCandidate({
      id: "v2-predecessor-review",
      candidateId: predecessorV2.candidate.id,
      reviewer: reviewerFor(reviewerB),
    });
    expect((await learning.getCandidateView({ candidateId: predecessorV2.candidate.id }))?.governance.review).toBe(
      "accepted",
    );

    const successorV2 = await learning.propose(
      candidateInput(proposer, {
        id: "successor-from-v2",
        problem: "A separately reviewed v2 predecessor.",
        hypothesis: "Changed successor content requires a fresh review.",
        supersedes: predecessorV2.candidate.id,
      }),
    );
    expect(successorV2.candidate).toMatchObject({
      supersedes: predecessorV2.candidate.id,
      originalDigest: predecessorV2.candidate.contentDigest,
    });
    expect(successorV2.governance.review).toBe("required");
    expect(successorV2.candidate.contentDigest).not.toBe(predecessorV2.candidate.contentDigest);
  });
});

describe("adversarial proposal, review, lineage, and report boundaries", () => {
  it("captures swapping proposedBy and supersedes getters exactly once before awaiting", async () => {
    const { learning, proposer, reviewerB } = await createCandidateHarness();
    const proposedByBase = candidateInput(proposer, { id: "getter-attribution-candidate" });
    let proposedByReads = 0;
    const proposedByInput = {
      ...proposedByBase,
      get proposedBy(): VerifiedPrincipal {
        proposedByReads += 1;
        return proposedByReads === 1 ? proposer : reviewerB;
      },
    };
    const attributed = await learning.propose(proposedByInput);
    expect(proposedByReads).toBe(1);
    expect(attributed.candidate.proposedBy).toEqual(proposer.ref);
    expect(attributed.candidate.proposerAttestationDigest).toBe(proposer.attestationDigest);

    const predecessorA = await learning.propose(
      candidateInput(proposer, { id: "getter-predecessor-a", problem: "Getter predecessor A." }),
    );
    const predecessorB = await learning.propose(
      candidateInput(proposer, { id: "getter-predecessor-b", problem: "Getter predecessor B." }),
    );
    const supersedesBase = candidateInput(proposer, {
      id: "getter-successor",
      hypothesis: "The captured first predecessor is authoritative.",
    });
    let supersedesReads = 0;
    const supersedesInput = {
      ...supersedesBase,
      get supersedes(): string {
        supersedesReads += 1;
        return supersedesReads === 1 ? predecessorA.candidate.id : predecessorB.candidate.id;
      },
    };
    const successor = await learning.propose(supersedesInput);
    expect(supersedesReads).toBe(1);
    expect(successor.candidate).toMatchObject({
      supersedes: predecessorA.candidate.id,
      originalDigest: predecessorA.candidate.contentDigest,
    });
  });

  it("does not let a reviewer mutate the detached candidate or reviewer port to redirect persisted review", async () => {
    const { learning, proposer, reviewerB } = await createCandidateHarness();
    const target = await learning.propose(candidateInput(proposer, { id: "review-mutation-target" }));
    const reviewerOwned = await learning.propose(
      candidateInput(reviewerB, {
        id: "reviewer-owned-candidate",
        problem: "This candidate was proposed by the would-be reviewer.",
      }),
    );
    const mutableReviewer: {
      id: string;
      version: string;
      principal: VerifiedPrincipal;
      review: CandidateReviewer["review"];
    } = {
      id: "mutation-reviewer",
      version: "1.0.0",
      principal: reviewerB,
      review: (input) => {
        expect(Reflect.set(input.candidate, "id", reviewerOwned.candidate.id)).toBe(false);
        expect(Reflect.set(input.candidate, "contentDigest", reviewerOwned.candidate.contentDigest)).toBe(false);
        mutableReviewer.id = "forged-reviewer-id";
        mutableReviewer.version = "9.9.9";
        mutableReviewer.principal = proposer;
        return Promise.resolve({
          candidateId: target.candidate.id,
          candidateDigest: target.candidate.contentDigest,
          disposition: "accept",
          findings: [],
        });
      },
    };

    const review = await learning.reviewCandidate({
      id: "mutation-safe-review",
      candidateId: target.candidate.id,
      reviewer: mutableReviewer,
    });
    expect(review).toMatchObject({
      candidateId: target.candidate.id,
      candidateDigest: target.candidate.contentDigest,
      reviewer: reviewerB.ref,
      reviewerImplementation: { id: "mutation-reviewer", version: "1.0.0" },
    });
    expect(review.candidateId).not.toBe(reviewerOwned.candidate.id);
  });

  it("returns an identical occupied review without callback and conflicts on foreign content before callback", async () => {
    const { learning, proposer, reviewerB } = await createCandidateHarness();
    const firstCandidate = await learning.propose(candidateInput(proposer, { id: "occupied-review-first" }));
    const first = await learning.reviewCandidate({
      id: "occupied-review-id",
      candidateId: firstCandidate.candidate.id,
      reviewer: reviewerFor(reviewerB),
    });

    const calls = { value: 0 };
    const replay = await learning.reviewCandidate({
      id: "occupied-review-id",
      candidateId: firstCandidate.candidate.id,
      reviewer: countingReviewer(reviewerB, calls),
    });
    expect(replay).toEqual(first);
    expect(calls.value).toBe(0);

    const secondCandidate = await learning.propose(
      candidateInput(proposer, { id: "occupied-review-second", problem: "Different candidate content." }),
    );
    await expect(
      learning.reviewCandidate({
        id: "occupied-review-id",
        candidateId: secondCandidate.candidate.id,
        reviewer: countingReviewer(reviewerB, calls),
      }),
    ).rejects.toMatchObject({ code: "store.conflict" });
    expect(calls.value).toBe(0);
  });

  it("revalidates evidence changed during the reviewer callback and refuses to persist the review", async () => {
    let revision = "during-review-r1";
    const source = registerBoundSource("during-review-source", () => boundPages({ revision, scope: PROJECT_A }));
    const { learning, store, proposer, reviewerB } = await createHarness([source]);
    await learning.ingest(source, null);
    const outcome = await learning.propose(
      candidateInput(proposer, {
        id: "during-review-candidate",
        scope: PROJECT_A,
        evidenceIds: ["during-review-source/observation-a"],
      }),
    );
    let calls = 0;
    const reviewer: CandidateReviewer = {
      id: "during-review-reviewer",
      version: "1.0.0",
      principal: reviewerB,
      review: async (input) => {
        calls += 1;
        revision = "during-review-r2";
        await learning.ingest(source, null);
        return {
          candidateId: input.candidate.id,
          candidateDigest: input.candidate.contentDigest,
          disposition: "accept",
          findings: [],
        };
      },
    };

    await expect(
      learning.reviewCandidate({
        id: "during-review-id",
        candidateId: outcome.candidate.id,
        reviewer,
      }),
    ).rejects.toMatchObject({ code: "review.evidence_invalid" });
    expect(calls).toBe(1);
    expect(await store.get({ namespace: "learning", kind: "review", id: "during-review-id" })).toBeUndefined();
  });

  it("detects callback-time candidate attribution mutation even when contentDigest is unchanged", async () => {
    const { learning, store, proposer, reviewerB } = await createCandidateHarness();
    const outcome = await learning.propose(candidateInput(proposer, { id: "attribution-cas-candidate" }));
    let calls = 0;
    const reviewer: CandidateReviewer = {
      id: "attribution-cas-reviewer",
      version: "1.0.0",
      principal: reviewerB,
      review: async (input) => {
        calls += 1;
        await overwriteRecord(
          store,
          "candidate",
          outcome.candidate.id,
          {
            ...outcome.candidate,
            proposedBy: reviewerB.ref,
            proposerAttestationDigest: reviewerB.attestationDigest,
          },
          "mutate-candidate-attribution-during-review",
        );
        return {
          candidateId: input.candidate.id,
          candidateDigest: input.candidate.contentDigest,
          disposition: "accept",
          findings: [],
        };
      },
    };

    await expect(
      learning.reviewCandidate({
        id: "attribution-cas-review",
        candidateId: outcome.candidate.id,
        reviewer,
      }),
    ).rejects.toMatchObject({ code: "review.binding_mismatch" });
    expect(calls).toBe(1);
    expect(await store.get({ namespace: "learning", kind: "review", id: "attribution-cas-review" })).toBeUndefined();
  });

  it("treats forged stored self, same-domain, and accept-with-blocking reviews as corruption", async () => {
    const variants = ["self", "same-domain", "accept-blocking"] as const;
    for (const variant of variants) {
      const { learning, store, proposer, reviewerB, reviewerSameDomain } = await createCandidateHarness();
      const outcome = await learning.propose(
        candidateInput(proposer, {
          id: `forged-${variant}-candidate`,
          ...(variant === "same-domain" ? { proposedRisk: "T2" } : {}),
        }),
      );
      const forgedReviewer = variant === "self" ? proposer : variant === "same-domain" ? reviewerSameDomain : reviewerB;
      const review = {
        schemaVersion: 1,
        id: `forged-${variant}-review`,
        candidateId: outcome.candidate.id,
        candidateDigest: outcome.candidate.contentDigest,
        reviewer: forgedReviewer.ref,
        reviewerAttestationDigest: forgedReviewer.attestationDigest,
        reviewerImplementation: { id: "forged-reviewer", version: "1.0.0" },
        disposition: "accept",
        findings:
          variant === "accept-blocking"
            ? [{ code: "forged.blocking", severity: "blocking", message: "must never be accepted" }]
            : [],
        reviewedAt: "2026-08-19T00:00:00.000Z",
      };
      const value = toJsonValue(review);
      await expect(
        store.create(
          { namespace: "learning", kind: "review", id: review.id },
          value,
          recordDigest(value),
          `forge-${variant}-review`,
        ),
      ).resolves.toMatchObject({ status: "created" });

      await expect(learning.getCandidateView({ candidateId: outcome.candidate.id })).rejects.toMatchObject({
        code: "store.corrupt",
      });
    }
  });

  it("rejects a stored candidate whose inner id differs from its record key before view or review", async () => {
    const { learning, store, proposer, reviewerB } = await createCandidateHarness();
    const outcome = await learning.propose(candidateInput(proposer, { id: "candidate-key-binding" }));
    await overwriteRecord(
      store,
      "candidate",
      outcome.candidate.id,
      { ...outcome.candidate, id: "foreign-inner-candidate-id" },
      "tamper-candidate-inner-id",
    );

    await expect(learning.getCandidateView({ candidateId: outcome.candidate.id })).rejects.toMatchObject({
      code: "store.corrupt",
    });
    await expect(learning.report({})).rejects.toMatchObject({ code: "store.corrupt" });
    const calls = { value: 0 };
    await expect(
      learning.reviewCandidate({
        id: "candidate-key-binding-review",
        candidateId: outcome.candidate.id,
        reviewer: countingReviewer(reviewerB, calls),
      }),
    ).rejects.toMatchObject({ code: "store.corrupt" });
    expect(calls.value).toBe(0);
  });

  it("rejects a review-list record whose inner id differs from its record key", async () => {
    const { learning, store, proposer, reviewerB } = await createCandidateHarness();
    const outcome = await learning.propose(candidateInput(proposer, { id: "review-list-key-candidate" }));
    const review = await learning.reviewCandidate({
      id: "review-list-key",
      candidateId: outcome.candidate.id,
      reviewer: reviewerFor(reviewerB),
    });
    await overwriteRecord(
      store,
      "review",
      review.id,
      { ...review, id: "foreign-inner-review-id" },
      "tamper-review-inner-id",
    );

    await expect(learning.getCandidateView({ candidateId: outcome.candidate.id })).rejects.toMatchObject({
      code: "store.corrupt",
    });
  });

  it("refuses cross-scope supersession at proposal time and blocks fabricated cross-scope lineage on read", async () => {
    const sourceA = registerBoundSource("lineage-project-a", () =>
      boundPages({ revision: "lineage-a-r1", scope: PROJECT_A }),
    );
    const sourceB = registerBoundSource("lineage-project-b", () =>
      boundPages({ revision: "lineage-b-r1", scope: PROJECT_B }),
    );
    const { learning, store, proposer, reviewerB } = await createHarness([sourceA, sourceB]);
    await learning.ingest(sourceA, null);
    await learning.ingest(sourceB, null);
    const predecessorA = await learning.propose(
      candidateInput(proposer, {
        id: "lineage-predecessor-a",
        scope: PROJECT_A,
        evidenceIds: ["lineage-project-a/observation-a"],
      }),
    );
    const predecessorB = await learning.propose(
      candidateInput(proposer, {
        id: "lineage-predecessor-b",
        scope: PROJECT_B,
        evidenceIds: ["lineage-project-b/observation-a"],
      }),
    );
    const indexCount = (await storedValues(store, "candidate-by-digest")).length;
    await expect(
      learning.propose(
        candidateInput(proposer, {
          id: "cross-scope-successor-refused",
          scope: PROJECT_B,
          evidenceIds: ["lineage-project-b/observation-a"],
          supersedes: predecessorA.candidate.id,
        }),
      ),
    ).rejects.toMatchObject({ code: "candidate.supersedes_scope_mismatch" });
    expect(await storedValues(store, "candidate-by-digest")).toHaveLength(indexCount);

    const fabricatedBase = {
      ...predecessorA.candidate,
      id: "fabricated-cross-scope-lineage",
      hypothesis: "This stored candidate names a predecessor from another project.",
      supersedes: predecessorB.candidate.id,
      originalDigest: predecessorB.candidate.contentDigest,
    };
    const fabricated = parseCandidate({
      ...fabricatedBase,
      contentDigest: candidateContentDigest(fabricatedBase),
    });
    const fabricatedValue = toJsonValue(fabricated);
    await expect(
      store.create(
        { namespace: "learning", kind: "candidate", id: fabricated.id },
        fabricatedValue,
        recordDigest(fabricatedValue),
        "fabricated-cross-scope-lineage",
      ),
    ).resolves.toMatchObject({ status: "created" });

    const view = await learning.getCandidateView({ candidateId: fabricated.id });
    expect(view).toMatchObject({
      evidenceHealth: { status: "ready" },
      governance: { review: "blocked", publication: "blocked" },
    });
    expect(view?.governance.reasons.some((reason) => reason.code === "candidate.supersedes_scope_mismatch")).toBe(true);
    const calls = { value: 0 };
    await expect(
      learning.reviewCandidate({
        id: "fabricated-cross-scope-review",
        candidateId: fabricated.id,
        reviewer: countingReviewer(reviewerB, calls),
      }),
    ).rejects.toMatchObject({ code: "review.lineage_invalid" });
    expect(calls.value).toBe(0);
  });

  it("reports exact scopes even when the host precedence comparator claims different projects are equal", async () => {
    const exact = createExactScopePolicy({ id: "unsafe-precedence-base", isolationSegmentTypes: ["project"] });
    let compareCalls = 0;
    const unsafeScopePolicy: ScopePolicy = {
      id: "unsafe-precedence-policy",
      digest: sha256HexOfCanonicalJson({ kind: "unsafe-precedence-policy", version: 1 }),
      isolationSegmentTypes: ["project"],
      validate: exact.validate,
      ancestors: exact.ancestors,
      comparePrecedence: () => {
        compareCalls += 1;
        return 0;
      },
    };
    const sourceA = registerBoundSource("report-project-a", () =>
      boundPages({ revision: "report-a-r1", scope: PROJECT_A }),
    );
    const sourceB = registerBoundSource("report-project-b", () =>
      boundPages({ revision: "report-b-r1", scope: PROJECT_B }),
    );
    const identities = createTestIdentityPort();
    const proposer = await identities.verify({
      principalId: "report-proposer",
      kind: "agent",
      independenceDomain: "report-tests",
    });
    const learning = createLearningLoop({
      store: createInMemoryStore(),
      policy: conservativePolicy(),
      identity: identities,
      scopePolicy: unsafeScopePolicy,
      contentPolicies: [createStructuredContentPolicy({ id: CONTENT_POLICY_ID })],
      sources: [sourceA, sourceB],
      queryCursorScope: "unsafe-precedence-report-tests",
      clock: createFixedClock("2026-08-19T00:00:00.000Z"),
      ids: createSequentialIds("unsafe-precedence"),
    });
    await learning.ingest(sourceA, null);
    await learning.ingest(sourceB, null);
    await learning.propose(
      candidateInput(proposer, {
        id: "report-exact-a",
        scope: PROJECT_A,
        evidenceIds: ["report-project-a/observation-a"],
      }),
    );
    await learning.propose(
      candidateInput(proposer, {
        id: "report-exact-b",
        scope: PROJECT_B,
        evidenceIds: ["report-project-b/observation-a"],
        problem: "A separate project has separate candidate content.",
      }),
    );

    await expect(learning.report({ scope: PROJECT_A })).resolves.toMatchObject({ candidateIds: ["report-exact-a"] });
    await expect(learning.report({ scope: PROJECT_B })).resolves.toMatchObject({ candidateIds: ["report-exact-b"] });
    expect(compareCalls).toBe(0);
  });
});

describe("post-proposal evidence revalidation", () => {
  it("marks a candidate invalid after its exact evidence record bytes change and never calls review", async () => {
    const { learning, store, proposer, reviewerB } = await createCandidateHarness();
    const outcome = await learning.propose(candidateInput(proposer, { id: "record-tamper-candidate" }));
    const id = "manual-evidence/obs-42-typecheck";
    const stored = await store.get({ namespace: "learning", kind: "observation", id });
    if (stored === undefined) throw new Error("missing observation fixture");
    const observation = parseObservation(stored.value);
    await overwriteRecord(
      store,
      "observation",
      id,
      { ...observation, data: { commandClass: "tampered-after-proposal", exitCode: 0 } },
      "tamper-observation",
    );

    await expect(learning.getCandidateView({ candidateId: outcome.candidate.id })).resolves.toMatchObject({
      evidenceHealth: { status: "invalid" },
      governance: { review: "blocked", publication: "blocked" },
    });
    const calls = { value: 0 };
    await expect(
      learning.reviewCandidate({
        id: "record-tamper-review",
        candidateId: outcome.candidate.id,
        reviewer: countingReviewer(reviewerB, calls),
      }),
    ).rejects.toMatchObject({ code: "review.evidence_invalid" });
    expect(calls.value).toBe(0);
  });

  it("fails closed after a referenced page receipt is corrupt and never calls review", async () => {
    const { learning, store, proposer, reviewerB } = await createCandidateHarness();
    const outcome = await learning.propose(candidateInput(proposer, { id: "receipt-tamper-candidate" }));
    const receiptId = outcome.candidate.evidenceRefs[0]?.pageReceiptId;
    if (receiptId === undefined) throw new Error("missing receipt reference fixture");
    const stored = await store.get({ namespace: "learning", kind: "source-page-receipt", id: receiptId });
    if (stored === undefined) throw new Error("missing source page receipt fixture");
    const receipt = parseSourcePageReceipt(stored.value);
    await overwriteRecord(
      store,
      "source-page-receipt",
      receiptId,
      { ...receipt, adapterVersion: "tampered-after-proposal" },
      "tamper-receipt",
    );

    await expect(learning.getCandidateView({ candidateId: outcome.candidate.id })).rejects.toMatchObject({
      code: "schema.corrupt",
    });
    const calls = { value: 0 };
    await expect(
      learning.reviewCandidate({
        id: "receipt-tamper-review",
        candidateId: outcome.candidate.id,
        reviewer: countingReviewer(reviewerB, calls),
      }),
    ).rejects.toMatchObject({ code: "schema.corrupt" });
    expect(calls.value).toBe(0);
  });

  it("fails closed after a referenced health finding is corrupt and never calls review", async () => {
    const { learning, store, proposer, reviewerB } = await createCandidateHarness();
    const outcome = await learning.propose(candidateInput(proposer, { id: "health-tamper-candidate" }));
    expect(outcome.evidenceHealth.status).toBe("ready");
    const receiptId = outcome.candidate.evidenceRefs[0]?.pageReceiptId;
    if (receiptId === undefined) throw new Error("missing receipt reference fixture");
    const storedReceipt = await store.get({ namespace: "learning", kind: "source-page-receipt", id: receiptId });
    if (storedReceipt === undefined) throw new Error("missing source page receipt fixture");
    const receipt = parseSourcePageReceipt(storedReceipt.value);
    const finding = buildHealthFinding({
      code: "source.partial",
      effect: "limits_claims",
      sourceId: receipt.sourceId,
      sourceRegistrationRevision: receipt.sourceRegistrationRevision,
      sourceRef: receipt.sourceRef,
      pageRef: receipt.pageRef,
      completeness: "complete",
      affectedRecords: 1,
    });
    const corruptFinding = { ...finding, affectedRecords: 2 };
    const corruptValue = toJsonValue(corruptFinding);
    await expect(
      store.create(
        { namespace: "learning", kind: "evidence-health", id: finding.id },
        corruptValue,
        recordDigest(corruptValue),
        "tamper-health",
      ),
    ).resolves.toMatchObject({ status: "created" });

    await expect(learning.getCandidateView({ candidateId: outcome.candidate.id })).rejects.toMatchObject({
      code: "schema.corrupt",
    });
    const calls = { value: 0 };
    await expect(
      learning.reviewCandidate({
        id: "health-tamper-review",
        candidateId: outcome.candidate.id,
        reviewer: countingReviewer(reviewerB, calls),
      }),
    ).rejects.toMatchObject({ code: "schema.corrupt" });
    expect(calls.value).toBe(0);
  });

  it("blocks view and review when a later revision creates blocks_use health", async () => {
    let revision = "candidate-r1";
    const source = registerBoundSource("later-revision-source", () => boundPages({ revision, scope: PROJECT_A }));
    const { learning, proposer, reviewerB } = await createHarness([source]);
    await learning.ingest(source, null);
    const outcome = await learning.propose(
      candidateInput(proposer, {
        id: "later-revision-candidate",
        scope: PROJECT_A,
        evidenceIds: ["later-revision-source/observation-a"],
      }),
    );
    expect(outcome.evidenceHealth.status).toBe("ready");

    revision = "candidate-r2";
    await learning.ingest(source, null);
    await expect(learning.getCandidateView({ candidateId: outcome.candidate.id })).resolves.toMatchObject({
      evidenceHealth: { status: "invalid" },
      governance: { review: "blocked", publication: "blocked" },
    });
    const calls = { value: 0 };
    await expect(
      learning.reviewCandidate({
        id: "later-revision-review",
        candidateId: outcome.candidate.id,
        reviewer: countingReviewer(reviewerB, calls),
      }),
    ).rejects.toMatchObject({ code: "review.evidence_invalid" });
    expect(calls.value).toBe(0);
  });
});
