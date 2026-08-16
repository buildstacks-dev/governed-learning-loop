// createLearningLoop — the façade over the deterministic Observe+Govern
// engine (contract §The façade). The configuration is immutable: sources,
// content policies, scope policy, and learning policy are composed before
// construction and digested into a registry revision that is bound into every
// ingest receipt. This milestone's config and façade are a deliberate
// narrowing of the contract's full LearningLoopConfig/LearningLoop: the
// activation, outcome, and experiment members (destinations, outcomeSources,
// replayExecutors, preparePublication, publish, resolveContext,
// acknowledgeExposure, declareExperiment, runExperiment, recordOutcomes) do
// not exist yet — a smaller surface now, additive later.
import { randomUUID } from "node:crypto";
import { sha256HexOfCanonicalJson } from "../canonical/canonical-json.js";
import { invalid } from "../parse/toolkit.js";
import type { Clock, IdGenerator } from "../ports/clock.js";
import type { RegisteredSource } from "../ports/evidence.js";
import type { LearningStore } from "../ports/store.js";
import type { ContentPolicy } from "../records/provenance.js";
import type { IdentityPort } from "../records/principal.js";
import type { CandidateReview } from "../records/review.js";
import type { ScopePolicy } from "../records/scope.js";
import type { EngineContext } from "./context.js";
import type { IngestOptions, IngestReceipt } from "./ingest.js";
import { runIngest } from "./ingest.js";
import type { LearningPolicy } from "./policy.js";
import { extractPolicyRules } from "./policy.js";
import type { CandidateInput, ProposeOutcome } from "./propose.js";
import { runPropose } from "./propose.js";
import type { LearningReport, LearningReportQuery } from "./report.js";
import { runReport } from "./report.js";
import type { CandidateReviewInput } from "./review.js";
import { runReviewCandidate } from "./review.js";
import { adapterFor } from "./source-registration.js";

export interface LearningLoopConfig {
  readonly store: LearningStore;
  readonly policy: LearningPolicy;
  readonly identity: IdentityPort;
  readonly scopePolicy: ScopePolicy;
  readonly contentPolicies: readonly ContentPolicy[];
  readonly sources: readonly RegisteredSource<unknown>[];
  readonly clock?: Clock;
  readonly ids?: IdGenerator;
}

export interface LearningLoop {
  ingest<I>(source: RegisteredSource<I>, sourceInput: I, options?: IngestOptions): Promise<IngestReceipt>;
  propose(input: CandidateInput): Promise<ProposeOutcome>;
  reviewCandidate(input: CandidateReviewInput): Promise<CandidateReview>;
  report(input: LearningReportQuery): Promise<LearningReport>;
}

const systemClock: Clock = { now: () => new Date().toISOString() };

function randomIds(): IdGenerator {
  return { next: (namespace) => `${namespace}-${randomUUID()}` };
}

export function createLearningLoop(config: LearningLoopConfig): LearningLoop {
  const contentPoliciesById = new Map<string, ContentPolicy>();
  for (const policy of config.contentPolicies) {
    if (contentPoliciesById.has(policy.id)) {
      throw invalid("config.invalid", `duplicate content policy id "${policy.id}"`, ["contentPolicies"]);
    }
    contentPoliciesById.set(policy.id, policy);
  }

  const sourceIds = new Set<string>();
  const sources = new Set<RegisteredSource<unknown>>();
  for (const source of config.sources) {
    if (sourceIds.has(source.id)) {
      throw invalid("config.invalid", `duplicate source id "${source.id}"`, ["sources"]);
    }
    if (!contentPoliciesById.has(source.contentPolicyId)) {
      throw invalid(
        "config.invalid",
        `source "${source.id}" names content policy "${source.contentPolicyId}", which is not configured`,
        ["sources"],
      );
    }
    if (adapterFor(source) === undefined) {
      throw invalid(
        "config.invalid",
        `source "${source.id}" was not created by defineSourceRegistration; the engine has no adapter for it`,
        ["sources"],
      );
    }
    sourceIds.add(source.id);
    sources.add(source);
  }

  const policyRules = extractPolicyRules(config.policy);

  // The immutable registry, digested. Any change to any registered component
  // is a new registry revision; the revision is bound into ingest receipts.
  const registryRevision = sha256HexOfCanonicalJson({
    policy: { id: config.policy.id, digest: config.policy.digest },
    scopePolicy: { id: config.scopePolicy.id, digest: config.scopePolicy.digest },
    contentPolicies: [...contentPoliciesById.values()]
      .map((policy) => ({ id: policy.id, digest: policy.digest }))
      .sort((left, right) => (left.id < right.id ? -1 : 1)),
    sources: [...sources]
      .map((source) => ({
        id: source.id,
        registryRevision: source.registryRevision,
        trustCeiling: source.trustCeiling,
        contentPolicyId: source.contentPolicyId,
      }))
      .sort((left, right) => (left.id < right.id ? -1 : 1)),
  });

  const context: EngineContext = {
    store: config.store,
    policy: config.policy,
    policyRules,
    scopePolicy: config.scopePolicy,
    contentPoliciesById,
    sources,
    registryRevision,
    clock: config.clock ?? systemClock,
    ids: config.ids ?? randomIds(),
  };

  return {
    ingest: <I>(source: RegisteredSource<I>, sourceInput: I, options?: IngestOptions) =>
      runIngest(context, source, sourceInput, options),
    propose: (input) => runPropose(context, input),
    reviewCandidate: (input) => runReviewCandidate(context, input),
    report: (input) => runReport(context, input),
  };
}
