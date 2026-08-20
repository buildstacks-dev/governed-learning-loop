// Configuration immutability controls: createLearningLoop snapshots policy
// metadata/rules and scope behavior so later host-object mutation cannot alter
// governance bindings or cross an isolation boundary.
import { describe, expect, it } from "vitest";
import type { CandidateReviewer, QueryPage, Scope, ScopePolicy } from "../src/index.js";
import { conservativePolicy, createLearningLoop, defineSourceRegistration } from "../src/index.js";
import { learningPolicyDigest } from "../src/engine/policy.js";
import {
  createExactScopePolicy,
  createFixedClock,
  createInMemoryStore,
  createManualEvidenceSource,
  createSequentialIds,
  createStructuredContentPolicy,
  createTestIdentityPort,
} from "../src/testing/index.js";
import { CONTENT_POLICY_ID, candidateInput, journeyEvidence } from "./engine-harness.js";

async function itemsOf<T>(iterable: AsyncIterable<QueryPage<T>>): Promise<readonly T[]> {
  const items: T[] = [];
  for await (const page of iterable) items.push(...page.items);
  return items;
}

describe("createLearningLoop configuration snapshots", () => {
  it("keeps the configured policy digest and independent-domain rules after the original policy is mutated", async () => {
    const rules = {
      risks: {
        T0: { independentReview: true, independentDomain: false },
        T1: { independentReview: true, independentDomain: false },
        T2: { independentReview: true, independentDomain: true },
        T3: { independentReview: true, independentDomain: true },
      },
      publication: { blockedPendingActivationTier: true },
    };
    const policyId = "mutable-policy-snapshot-test";
    const configuredPolicyDigest = learningPolicyDigest(policyId, rules);
    const mutablePolicy = { id: policyId, digest: configuredPolicyDigest, rules };
    const identities = createTestIdentityPort();
    const proposer = await identities.verify({
      principalId: "policy-proposer",
      kind: "agent",
      independenceDomain: "shared-domain",
    });
    const sameDomainReviewer = await identities.verify({
      principalId: "policy-reviewer",
      kind: "agent",
      independenceDomain: "shared-domain",
    });
    const manual = defineSourceRegistration({
      source: createManualEvidenceSource(),
      trustCeiling: "observed",
      contentPolicyId: CONTENT_POLICY_ID,
    });
    const learning = createLearningLoop({
      store: createInMemoryStore(),
      policy: mutablePolicy,
      identity: identities,
      scopePolicy: createExactScopePolicy(),
      contentPolicies: [createStructuredContentPolicy({ id: CONTENT_POLICY_ID })],
      sources: [manual],
      queryCursorScope: "policy-snapshot-tests",
      clock: createFixedClock("2026-08-19T00:00:00.000Z"),
      ids: createSequentialIds("policy-snapshot"),
    });

    const beforeMutation = await learning.ingest(manual, journeyEvidence());
    mutablePolicy.digest = "0".repeat(64);
    rules.risks.T2.independentReview = false;
    rules.risks.T2.independentDomain = false;
    rules.publication.blockedPendingActivationTier = false;
    const afterMutation = await learning.ingest(manual, journeyEvidence());

    const proposal = await learning.propose(
      candidateInput(proposer, { id: "policy-snapshot-candidate", proposedRisk: "T2" }),
    );
    let reviewerPolicyDigest: string | undefined;
    const reviewer: CandidateReviewer = {
      id: "policy-snapshot-reviewer",
      version: "1.0.0",
      principal: sameDomainReviewer,
      review: (input) => {
        reviewerPolicyDigest = input.policyDigest;
        return Promise.resolve({
          candidateId: input.candidate.id,
          candidateDigest: input.candidate.contentDigest,
          disposition: "accept",
          findings: [],
        });
      },
    };

    await expect(
      learning.reviewCandidate({
        id: "policy-snapshot-review",
        candidateId: proposal.candidate.id,
        reviewer,
      }),
    ).rejects.toMatchObject({ code: "review.not_independent" });
    expect(reviewerPolicyDigest).toBe(configuredPolicyDigest);
    expect(afterMutation.registryRevision).toBe(beforeMutation.registryRevision);
  });

  it("keeps configured scope validation, precedence, and isolation after the original scope policy is mutated", async () => {
    const projectA: Scope = [{ type: "project", id: "project-a" }];
    const projectB: Scope = [{ type: "project", id: "project-b" }];
    const configuredIsolationTypes = ["project"];
    const exact = createExactScopePolicy({
      id: "mutable-scope-snapshot-test",
      isolationSegmentTypes: configuredIsolationTypes,
    });
    const mutableScopePolicy: {
      id: string;
      digest: string;
      isolationSegmentTypes: string[];
      validate: ScopePolicy["validate"];
      ancestors: ScopePolicy["ancestors"];
      comparePrecedence: ScopePolicy["comparePrecedence"];
    } = {
      id: exact.id,
      digest: exact.digest,
      isolationSegmentTypes: configuredIsolationTypes,
      validate: exact.validate,
      ancestors: exact.ancestors,
      comparePrecedence: exact.comparePrecedence,
    };
    const identities = createTestIdentityPort();
    const proposer = await identities.verify({
      principalId: "scope-proposer",
      kind: "agent",
      independenceDomain: "scope-domain",
    });
    const manual = defineSourceRegistration({
      source: createManualEvidenceSource(),
      trustCeiling: "observed",
      contentPolicyId: CONTENT_POLICY_ID,
    });
    const learning = createLearningLoop({
      store: createInMemoryStore(),
      policy: conservativePolicy(),
      identity: identities,
      scopePolicy: mutableScopePolicy,
      contentPolicies: [createStructuredContentPolicy({ id: CONTENT_POLICY_ID })],
      sources: [manual],
      queryCursorScope: "scope-snapshot-tests",
      clock: createFixedClock("2026-08-19T00:00:00.000Z"),
      ids: createSequentialIds("scope-snapshot"),
    });

    mutableScopePolicy.validate = () => projectB;
    mutableScopePolicy.comparePrecedence = () => 0;
    configuredIsolationTypes.splice(0, configuredIsolationTypes.length, "tenant");

    await learning.ingest(manual, {
      observations: [
        {
          id: "scope-observation",
          episodeId: "scope-episode",
          kind: "agent.turn.completed",
          data: { project: "a" },
        },
      ],
      episodes: [
        {
          id: "scope-episode",
          scope: projectA,
          openedAt: "2026-08-19T00:00:00.000Z",
          closedAt: "2026-08-19T00:01:00.000Z",
          outcome: { status: "succeeded", measurementIds: [] },
        },
      ],
    });
    const proposal = await learning.propose(
      candidateInput(proposer, {
        id: "scope-snapshot-candidate",
        scope: projectA,
        evidenceIds: ["scope-observation"],
      }),
    );

    const projectAEpisodes = await itemsOf(learning.queryEpisodes({ scope: projectA, limit: 10 }));
    const projectBEpisodes = await itemsOf(learning.queryEpisodes({ scope: projectB, limit: 10 }));
    const projectAReport = await learning.report({ scope: projectA });
    const projectBReport = await learning.report({ scope: projectB });

    expect(projectAEpisodes).toHaveLength(1);
    expect(projectAEpisodes[0]?.episode.scope).toEqual(projectA);
    expect(projectBEpisodes).toEqual([]);
    expect(proposal.candidate.scope).toEqual(projectA);
    expect(projectAReport.candidateIds).toEqual([proposal.candidate.id]);
    expect(projectBReport.candidateIds).toEqual([]);
  });
});
