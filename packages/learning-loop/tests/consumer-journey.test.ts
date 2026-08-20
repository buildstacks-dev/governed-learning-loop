// The ratified contract's opening consumer journey (docs/contract/
// api-contract.md, first code block), near-verbatim: imports are relative
// instead of package-named and console.log became assertions. If this test
// needs more than mechanical adjustment, the implementation has drifted from
// the contract.
import { expect, test } from "vitest";
import { conservativePolicy, createLearningLoop, defineSourceRegistration } from "../src/index.js";
import {
  createExactScopePolicy,
  createInMemoryStore,
  createManualEvidenceSource,
  createStructuredContentPolicy,
  createTestIdentityPort,
} from "../src/testing/index.js";

test("the contract's opening consumer journey runs end to end", async () => {
  const identities = createTestIdentityPort();
  const proposer = await identities.verify({
    principalId: "distiller-a",
    kind: "agent",
    independenceDomain: "provider-a",
  });

  const localRunner = defineSourceRegistration({
    source: createManualEvidenceSource(),
    trustCeiling: "observed",
    contentPolicyId: "structured-local-events-v1",
  });

  const structuredContent = createStructuredContentPolicy({
    id: "structured-local-events-v1",
  });

  const learning = createLearningLoop({
    store: createInMemoryStore(),
    policy: conservativePolicy(),
    identity: identities,
    scopePolicy: createExactScopePolicy(),
    contentPolicies: [structuredContent],
    sources: [localRunner],
  });

  const receipt = await learning.ingest(localRunner, {
    observations: [
      {
        id: "obs-42-typecheck",
        episodeId: "change-42",
        occurredAt: "2026-08-12T16:11:00.000Z",
        kind: "tool.process.completed",
        data: { commandClass: "typecheck", exitCode: 1 },
      },
    ],
    measurements: [
      {
        id: "measure-42-typecheck",
        episodeId: "change-42",
        metric: {
          name: "typecheck",
          valueType: "boolean",
          unit: "pass",
          aggregation: "all",
        },
        value: false,
        evidenceIds: ["obs-42-typecheck"],
      },
    ],
    episodes: [
      {
        id: "change-42",
        scope: [
          { type: "project", id: "acme-api" },
          { type: "agent", id: "coding-agent" },
        ],
        openedAt: "2026-08-12T16:00:00.000Z",
        closedAt: "2026-08-12T16:12:00.000Z",
        outcome: {
          status: "failed",
          measurementIds: ["measure-42-typecheck"],
        },
      },
    ],
  });

  expect(receipt.observationIds).toHaveLength(1);
  expect(receipt.measurementIds).toHaveLength(1);
  expect(receipt.episodeIds).toHaveLength(1);
  expect(receipt.completeness).toBe("complete");
  expect(receipt.registryRevision).toMatch(/^[0-9a-f]{64}$/);
  expect(receipt.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);

  const proposal = await learning.propose({
    id: "candidate-typecheck-before-complete",
    scope: [
      { type: "project", id: "acme-api" },
      { type: "agent", id: "coding-agent" },
    ],
    problem: "TypeScript changes are reported complete before type checking.",
    hypothesis: "A completion preflight will catch unresolved type errors.",
    evidenceIds: ["manual-evidence/obs-42-typecheck"],
    intervention: {
      destinationId: "agent-instructions",
      kind: "procedure",
      content: {
        text: "Before reporting a TypeScript code change complete, run the repository type-check command and resolve failures.",
      },
      rollbackIntent: "Disable this instruction version.",
    },
    proposedRisk: "T1",
    proposedBy: proposer,
  });

  const candidate = proposal.candidate;
  expect(candidate.id).toBe("candidate-typecheck-before-complete");
  expect(candidate.proposedBy).toEqual({ id: "distiller-a", kind: "agent", independenceDomain: "provider-a" });
  expect(candidate.contentDigest).toMatch(/^[0-9a-f]{64}$/);

  // { review: "required", publication: "blocked", validation: "untested" }
  expect(proposal.governance.review).toBe("required");
  expect(proposal.governance.publication).toBe("blocked");
  expect(proposal.governance.validation).toBe("untested");
  expect(proposal.governance.reasons.some((reason) => reason.code === "policy.blocked")).toBe(true);
});
