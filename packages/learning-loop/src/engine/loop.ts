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
import { invalid, parseNonEmptyText } from "../parse/toolkit.js";
import type { Clock, IdGenerator } from "../ports/clock.js";
import type { RegisteredSource } from "../ports/evidence.js";
import type { LearningStore } from "../ports/store.js";
import type { ContentPolicy } from "../records/provenance.js";
import type { IdentityPort } from "../records/principal.js";
import type { MeasurementRecord } from "../records/episode.js";
import type { Observation } from "../records/observation.js";
import type { CandidateReview } from "../records/review.js";
import type { ScopePolicy } from "../records/scope.js";
import type { EvidenceHealthFinding, ImportReceipt, SourcePageReceipt } from "../records/source-health.js";
import type { EngineContext } from "./context.js";
import type { IngestOptions, IngestReceipt } from "./ingest.js";
import { runIngest } from "./ingest.js";
import { identityRegistryProjection } from "./identity.js";
import type { LearningPolicy } from "./policy.js";
import { bindLearningPolicy } from "./policy.js";
import type { CandidateInput, ProposeOutcome } from "./propose.js";
import { runPropose } from "./propose.js";
import type {
  CandidateView,
  EvidenceHealthQuery,
  EpisodeQuery,
  EpisodeView,
  MeasurementQuery,
  ObservationQuery,
  QueryPage,
  SourcePageReceiptQuery,
} from "./query.js";
import {
  runEpisodeQuery,
  runEvidenceHealthQuery,
  runGetCandidateView,
  runGetImportReceipt,
  runMeasurementQuery,
  runObservationQuery,
  runSourcePageReceiptQuery,
} from "./query.js";
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
  /** Stable host/store scope for resumable query cursors; omitted means process-local cursors. */
  readonly queryCursorScope?: string;
  readonly clock?: Clock;
  readonly ids?: IdGenerator;
}

export interface LearningLoop {
  ingest<I>(source: RegisteredSource<I>, sourceInput: I, options?: IngestOptions): Promise<IngestReceipt>;
  queryObservations(input: ObservationQuery): AsyncIterable<QueryPage<Observation>>;
  queryMeasurements(input: MeasurementQuery): AsyncIterable<QueryPage<MeasurementRecord>>;
  queryEpisodes(input: EpisodeQuery): AsyncIterable<QueryPage<EpisodeView>>;
  querySourcePageReceipts(input: SourcePageReceiptQuery): AsyncIterable<QueryPage<SourcePageReceipt>>;
  queryEvidenceHealthFindings(input: EvidenceHealthQuery): AsyncIterable<QueryPage<EvidenceHealthFinding>>;
  getImportReceipt(input: { readonly importReceiptId: string }): Promise<ImportReceipt | undefined>;
  propose(input: CandidateInput): Promise<ProposeOutcome>;
  reviewCandidate(input: CandidateReviewInput): Promise<CandidateReview>;
  getCandidateView(input: { readonly candidateId: string }): Promise<CandidateView | undefined>;
  report(input: LearningReportQuery): Promise<LearningReport>;
}

const systemClock: Clock = { now: () => new Date().toISOString() };

function randomIds(): IdGenerator {
  return { next: (namespace) => `${namespace}-${randomUUID()}` };
}

function snapshotContentPolicy(policy: ContentPolicy): ContentPolicy {
  const id = policy.id;
  const digest = policy.digest;
  const maximumInputBytes = policy.maximumInputBytes;
  const outboundUse = policy.outboundUse;
  const configuredTransform = policy.transform;
  let snapshot: ContentPolicy | undefined;
  const transform: ContentPolicy["transform"] = (input) => {
    if (snapshot === undefined) {
      throw invalid("config.invalid", "content policy snapshot was invoked before construction", ["contentPolicies"]);
    }
    return configuredTransform.call(snapshot, input);
  };
  snapshot = Object.freeze({
    id,
    digest,
    maximumInputBytes,
    outboundUse,
    transform,
  });
  return snapshot;
}

function snapshotScopePolicy(policy: ScopePolicy): ScopePolicy {
  const id = policy.id;
  const digest = policy.digest;
  const isolationSegmentTypes = Object.freeze([...policy.isolationSegmentTypes]);
  const configuredValidate = policy.validate;
  const configuredAncestors = policy.ancestors;
  const configuredComparePrecedence = policy.comparePrecedence;
  let snapshot: ScopePolicy | undefined;
  const current = (): ScopePolicy => {
    if (snapshot === undefined) {
      throw invalid("config.invalid", "scope policy snapshot was invoked before construction", ["scopePolicy"]);
    }
    return snapshot;
  };
  const validate: ScopePolicy["validate"] = (input) => configuredValidate.call(current(), input);
  const ancestors: ScopePolicy["ancestors"] = (scope) => configuredAncestors.call(current(), scope);
  const comparePrecedence: ScopePolicy["comparePrecedence"] = (left, right) =>
    configuredComparePrecedence.call(current(), left, right);
  snapshot = Object.freeze({
    id,
    digest,
    isolationSegmentTypes,
    validate,
    ancestors,
    comparePrecedence,
  });
  return snapshot;
}

export function createLearningLoop(config: LearningLoopConfig): LearningLoop {
  const contentPoliciesById = new Map<string, ContentPolicy>();
  for (const configuredPolicy of config.contentPolicies) {
    const policy = snapshotContentPolicy(configuredPolicy);
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

  const boundPolicy = bindLearningPolicy(config.policy);
  const policy = boundPolicy.policy;
  const policyRules = boundPolicy.rules;
  const scopePolicy = snapshotScopePolicy(config.scopePolicy);
  const identityPort = config.identity;
  const identity = identityRegistryProjection(identityPort);
  const queryCursorScope =
    config.queryCursorScope === undefined
      ? `process:${randomUUID()}`
      : parseNonEmptyText(config.queryCursorScope, ["queryCursorScope"]);
  if (queryCursorScope.length > 1_000) {
    throw invalid("config.invalid", "queryCursorScope exceeds 1000 characters", ["queryCursorScope"]);
  }
  const queryCursorScopeDigest = sha256HexOfCanonicalJson({
    queryCursorScope,
  });

  // The immutable registry, digested. Any change to any registered component
  // is a new registry revision; the revision is bound into ingest receipts.
  const registryRevision = sha256HexOfCanonicalJson({
    policy: { id: policy.id, digest: policy.digest },
    identity,
    scopePolicy: { id: scopePolicy.id, digest: scopePolicy.digest },
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
    policy,
    policyRules,
    scopePolicy,
    contentPoliciesById,
    sources,
    identity: identityPort,
    registryRevision,
    queryCursorScopeDigest,
    clock: config.clock ?? systemClock,
    ids: config.ids ?? randomIds(),
  };

  return {
    ingest: <I>(source: RegisteredSource<I>, sourceInput: I, options?: IngestOptions) =>
      runIngest(context, source, sourceInput, options),
    queryObservations: (input) => runObservationQuery(context, input),
    queryMeasurements: (input) => runMeasurementQuery(context, input),
    queryEpisodes: (input) => runEpisodeQuery(context, input),
    querySourcePageReceipts: (input) => runSourcePageReceiptQuery(context, input),
    queryEvidenceHealthFindings: (input) => runEvidenceHealthQuery(context, input),
    getImportReceipt: (input) => runGetImportReceipt(context, input),
    propose: (input) => runPropose(context, input),
    reviewCandidate: (input) => runReviewCandidate(context, input),
    getCandidateView: (input) => runGetCandidateView(context, input),
    report: (input) => runReport(context, input),
  };
}
