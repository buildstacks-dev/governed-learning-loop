// Shared fixtures for the Observe+Govern engine tests. Not a test file.
import type {
  CandidateInput,
  CandidateReviewer,
  EvidencePage,
  EvidenceSource,
  LearningLoop,
  LearningStore,
  RegisteredSource,
  Scope,
  VerifiedPrincipal,
} from "../src/index.js";
import { conservativePolicy, createLearningLoop, defineSourceRegistration } from "../src/index.js";
import type { ManualEvidenceInput } from "../src/testing/index.js";
import {
  createExactScopePolicy,
  createFixedClock,
  createInMemoryStore,
  createManualEvidenceSource,
  createSequentialIds,
  createStructuredContentPolicy,
  createTestIdentityPort,
} from "../src/testing/index.js";

export const SCOPE: Scope = [
  { type: "project", id: "acme-api" },
  { type: "agent", id: "coding-agent" },
];

export const CONTENT_POLICY_ID = "structured-v1";

export interface Harness {
  readonly store: LearningStore;
  readonly learning: LearningLoop;
  readonly manual: RegisteredSource<ManualEvidenceInput>;
  readonly proposer: VerifiedPrincipal;
  /** Different principal id AND different independence domain from the proposer. */
  readonly reviewerB: VerifiedPrincipal;
  /** Different principal id, SAME independence domain as the proposer. */
  readonly reviewerSameDomain: VerifiedPrincipal;
}

export async function createHarness(extraSources: readonly RegisteredSource<unknown>[] = []): Promise<Harness> {
  const identities = createTestIdentityPort();
  const proposer = await identities.verify({
    principalId: "distiller-a",
    kind: "agent",
    independenceDomain: "provider-a",
  });
  const reviewerB = await identities.verify({
    principalId: "reviewer-b",
    kind: "agent",
    independenceDomain: "provider-b",
  });
  const reviewerSameDomain = await identities.verify({
    principalId: "reviewer-a2",
    kind: "agent",
    independenceDomain: "provider-a",
  });
  const manual = defineSourceRegistration({
    source: createManualEvidenceSource(),
    trustCeiling: "observed",
    contentPolicyId: CONTENT_POLICY_ID,
  });
  const store = createInMemoryStore();
  const learning = createLearningLoop({
    store,
    policy: conservativePolicy(),
    identity: identities,
    scopePolicy: createExactScopePolicy(),
    contentPolicies: [createStructuredContentPolicy({ id: CONTENT_POLICY_ID })],
    sources: [manual, ...extraSources],
    clock: createFixedClock("2026-08-16T10:00:00.000Z"),
    ids: createSequentialIds("t"),
  });
  return { store, learning, manual, proposer, reviewerB, reviewerSameDomain };
}

export function journeyEvidence(): ManualEvidenceInput {
  return {
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
        metric: { name: "typecheck", valueType: "boolean", unit: "pass", aggregation: "all" },
        value: false,
        evidenceIds: ["obs-42-typecheck"],
      },
    ],
    episodes: [
      {
        id: "change-42",
        scope: SCOPE,
        openedAt: "2026-08-12T16:00:00.000Z",
        closedAt: "2026-08-12T16:12:00.000Z",
        outcome: { status: "failed", measurementIds: ["measure-42-typecheck"] },
      },
    ],
  };
}

export function candidateInput(
  proposedBy: VerifiedPrincipal,
  overrides: Partial<Omit<CandidateInput, "proposedBy">> = {},
): CandidateInput {
  return {
    id: "cand-1",
    scope: SCOPE,
    problem: "TypeScript changes are reported complete before type checking.",
    hypothesis: "A completion preflight will catch unresolved type errors.",
    evidenceIds: ["obs-42-typecheck"],
    intervention: {
      destinationId: "agent-instructions",
      kind: "procedure",
      content: { text: "Before reporting a change complete, run the type-check command." },
      rollbackIntent: "Disable this instruction version.",
    },
    proposedRisk: "T1",
    proposedBy,
    ...overrides,
  };
}

/** A reviewer that echoes the reviewed candidate's binding and accepts, unless scripted otherwise. */
export function reviewerFor(
  principal: VerifiedPrincipal,
  script?: (input: { readonly candidate: { readonly id: string; readonly contentDigest: string } }) => unknown,
): CandidateReviewer {
  return {
    id: "reviewer-workflow",
    version: "1.0.0",
    principal,
    review: (input) =>
      Promise.resolve(
        script !== undefined
          ? script(input)
          : {
              candidateId: input.candidate.id,
              candidateDigest: input.candidate.contentDigest,
              disposition: "accept",
              findings: [],
            },
      ),
  };
}

/**
 * An evidence source that replays scripted raw pages verbatim. Pages are
 * deliberately typed `unknown` and cast at the yield: adapters can lie about
 * their types, and the engine must re-validate every page anyway. The cast
 * lives in test code only (the cast gate exempts tests).
 */
export function scriptedSource(id: string, pages: () => readonly unknown[]): EvidenceSource<null> {
  return {
    descriptor: { id, adapterVersion: "1.0.0" },
    probe: () => Promise.resolve({ supported: true, diagnostics: [] }),
    read: async function* (): AsyncIterable<EvidencePage> {
      for (const page of pages()) {
        yield page as EvidencePage;
      }
    },
  };
}
