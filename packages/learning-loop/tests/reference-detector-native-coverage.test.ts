import { describe, expect, it } from "vitest";
import type { EvidencePage, EvidenceSource, LearningLoop, QueryPage } from "../src/index.js";
import { conservativePolicy, createLearningLoop, defineSourceRegistration } from "../src/index.js";
import {
  createExactScopePolicy,
  createInMemoryStore,
  createStructuredContentPolicy,
  createTestIdentityPort,
} from "../src/testing/index.js";

const REFERENCE_CONTENT_POLICY_ID = "reference-structured-v1";
const REFERENCE_SCOPE_A = [{ type: "project", id: "reference-project-a" }];

async function collect<T>(pages: AsyncIterable<QueryPage<T>>): Promise<readonly T[]> {
  const items: T[] = [];
  for await (const page of pages) items.push(...page.items);
  return items;
}

function nativeCoverageSource(): EvidenceSource<null> {
  const pages: readonly EvidencePage[] = [
    {
      sourceRef: "reference-available-artifact",
      pageRef: "reference-complete-empty",
      state: { status: "available", sourceRevision: "reference-available-r1", completeness: "complete" },
      observations: [],
      measurements: [],
      episodes: [],
      diagnostics: [],
    },
    {
      sourceRef: "reference-missing-artifact",
      pageRef: "reference-missing",
      state: { status: "missing" },
      observations: [],
      measurements: [],
      episodes: [],
      diagnostics: [],
    },
    {
      sourceRef: "reference-unreadable-artifact",
      pageRef: "reference-unreadable",
      state: { status: "unreadable", observedRevision: "reference-unreadable-r1" },
      observations: [],
      measurements: [],
      episodes: [],
      diagnostics: [],
    },
    {
      sourceRef: "reference-unsupported-artifact",
      pageRef: "reference-unsupported",
      state: { status: "unsupported", observedRevision: "reference-unsupported-r1" },
      observations: [],
      measurements: [],
      episodes: [],
      diagnostics: [],
    },
  ];
  return {
    descriptor: { id: "reference-native-coverage", adapterVersion: "1.0.0" },
    probe: () => Promise.resolve({ supported: true, diagnostics: [] }),
    read: async function* (): AsyncIterable<EvidencePage> {
      for (const page of pages) yield page;
    },
  };
}

function learningForNativeCoverage(): LearningLoop {
  const source = defineSourceRegistration({
    source: nativeCoverageSource(),
    trustCeiling: "observed",
    contentPolicyId: REFERENCE_CONTENT_POLICY_ID,
  });
  const contentPolicy = createStructuredContentPolicy({ id: REFERENCE_CONTENT_POLICY_ID });
  return createLearningLoop({
    store: createInMemoryStore(),
    policy: conservativePolicy(),
    identity: createTestIdentityPort(),
    scopePolicy: createExactScopePolicy(),
    contentPolicies: [contentPolicy],
    sources: [source],
    queryCursorScope: "reference-native-coverage",
  });
}

describe("reference detector native evidence coverage controls", () => {
  it("keeps unavailable pages separate from a complete observed-empty page and behavioral learning", async () => {
    const source = defineSourceRegistration({
      source: nativeCoverageSource(),
      trustCeiling: "observed",
      contentPolicyId: REFERENCE_CONTENT_POLICY_ID,
    });
    const contentPolicy = createStructuredContentPolicy({ id: REFERENCE_CONTENT_POLICY_ID });
    const learning = createLearningLoop({
      store: createInMemoryStore(),
      policy: conservativePolicy(),
      identity: createTestIdentityPort(),
      scopePolicy: createExactScopePolicy(),
      contentPolicies: [contentPolicy],
      sources: [source],
      queryCursorScope: "reference-native-coverage-controls",
    });

    const ingest = await learning.ingest(source, null);
    expect(ingest.observationIds).toEqual([]);
    expect(ingest.measurementIds).toEqual([]);
    expect(ingest.episodeIds).toEqual([]);

    const receipts = await collect(learning.querySourcePageReceipts({ sourceIds: [source.id], limit: 10 }));
    expect(receipts.map((receipt) => [receipt.pageRef, receipt.state.status])).toEqual([
      ["reference-complete-empty", "available"],
      ["reference-missing", "missing"],
      ["reference-unreadable", "unreadable"],
      ["reference-unsupported", "unsupported"],
    ]);
    expect(receipts[0]).toMatchObject({
      state: { status: "available", completeness: "complete" },
      derivatives: [],
      projectionCounts: { observations: 0, measurements: 0, episodes: 0, rejected: 0 },
      healthFindingIds: [],
    });

    const findings = await collect(learning.queryEvidenceHealthFindings({ sourceIds: [source.id], limit: 10 }));
    expect(findings).toEqual([
      expect.objectContaining({
        code: "source.missing",
        effect: "blocks_use",
        pageRef: "reference-missing",
        completeness: "unknown",
        affectedRecords: 0,
      }),
      expect.objectContaining({
        code: "source.unreadable",
        effect: "blocks_use",
        pageRef: "reference-unreadable",
        completeness: "unknown",
        affectedRecords: 0,
      }),
      expect.objectContaining({
        code: "source.unsupported",
        effect: "blocks_use",
        pageRef: "reference-unsupported",
        completeness: "unknown",
        affectedRecords: 0,
      }),
    ]);
    expect(await collect(learning.queryObservations({ sourceIds: [source.id], limit: 10 }))).toEqual([]);
    expect(await collect(learning.queryEpisodes({ sourceIds: [source.id], limit: 10 }))).toEqual([]);
    expect(
      await collect(
        learning.queryInsightDerivations({
          scope: REFERENCE_SCOPE_A,
          commitStatuses: ["committed", "orphaned", "invalid"],
          registryStatuses: ["configured", "historical_unconfigured"],
          limit: 10,
        }),
      ),
    ).toEqual([]);
    expect(await learning.report({ scope: REFERENCE_SCOPE_A })).toMatchObject({
      candidateIds: [],
      interventionIds: [],
      evaluationIds: [],
    });
  });

  it("does not need a detector or provider to preserve native closed health states", async () => {
    const learning = learningForNativeCoverage();
    const serialized = JSON.stringify(await learning.report({ scope: REFERENCE_SCOPE_A }));
    expect(serialized).not.toContain("provider");
    expect(serialized).not.toContain("candidateUtility");
    expect(serialized).not.toContain("recurrence");
    expect(serialized).not.toContain("admission");
  });
});
