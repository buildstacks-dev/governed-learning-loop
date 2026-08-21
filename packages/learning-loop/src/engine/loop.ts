// createLearningLoop — the façade over the deterministic Observe+Govern
// engine (contract §The façade). The configuration is immutable: sources,
// content policies, scope policy, and learning policy are composed before
// construction and digested into a registry revision that is bound into every
// ingest receipt and publication plan. This config and façade are a
// deliberate narrowing of the contract's full LearningLoopConfig/LearningLoop:
// decision 0025 adds destinations, the authority port, preparePublication, and
// the refusal half of publish; the journaled publisher, outcome, and
// experiment members (outcomeSources, replayExecutors, resolveContext,
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
import type { AuthorityPort } from "../records/authorization.js";
import type { DestinationRegistration } from "../ports/destination.js";
import type { MeasurementRecord } from "../records/episode.js";
import type { Observation } from "../records/observation.js";
import type { CandidateReview } from "../records/review.js";
import type { Scope, ScopePolicy } from "../records/scope.js";
import type { SemanticRegistryConfig } from "../records/semantic-registry.js";
import { parseSemanticRegistryConfig } from "../records/semantic-registry.js";
import { detectorRefKey, lensRefKey, packRefKey } from "../records/semantic-shared.js";
import type { SourceSemanticProfile } from "../records/source-semantic-profile.js";
import type { DetectorOrchestrationPolicy } from "../records/detector-orchestration-policy.js";
import { parseDetectorOrchestrationPolicy } from "../records/detector-orchestration-policy.js";
import type { EvidenceHealthFinding, ImportReceipt, SourcePageReceipt } from "../records/source-health.js";
import type { EngineContext } from "./context.js";
import type { IngestOptions, IngestReceipt } from "./ingest.js";
import { runIngest } from "./ingest.js";
import { identityRegistryProjection } from "./identity.js";
import { authorityRegistryProjection } from "./authority.js";
import type { BoundDestination } from "./destination-registration.js";
import { bindDestinationRegistration } from "./destination-registration.js";
import type { PreparePublicationInput, PreparedPublication, PublicationOutcome, PublishInput } from "./publication.js";
import { runPreparePublication, runPublish } from "./publication.js";
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
import type {
  DetectorExecutionQuery,
  DetectorExecutionView,
  InsightDerivationQuery,
  InsightDerivationView,
} from "./semantic-query.js";
import {
  runDetectorExecutionQuery,
  runGetDetectorExecution,
  runGetInsightDerivation,
  runInsightDerivationQuery,
} from "./semantic-query.js";
import { adapterFor } from "./source-registration.js";
import type { RegisteredDetectorImplementation } from "./detector-implementation.js";
import { detectorImplementationRegistration } from "./detector-implementation.js";
import type { DetectorRunInput, DetectorRunResult } from "./detector-run.js";
import { runDetector } from "./detector-run.js";
import type { DetectorPackRunInput, DetectorPackRunResult } from "./detector-pack-run.js";
import { runDetectorPack } from "./detector-pack-run.js";
import type { DetectorPackRunQuery, DetectorPackRunView } from "./detector-pack-query.js";
import { runDetectorPackRunQuery, runGetDetectorPackRun } from "./detector-pack-query.js";

export interface LearningLoopConfig {
  readonly store: LearningStore;
  readonly policy: LearningPolicy;
  readonly identity: IdentityPort;
  readonly scopePolicy: ScopePolicy;
  readonly contentPolicies: readonly ContentPolicy[];
  readonly sources: readonly RegisteredSource<unknown>[];
  readonly semanticRegistry?: SemanticRegistryConfig;
  readonly detectorImplementations?: readonly RegisteredDetectorImplementation[];
  readonly detectorOrchestrationPolicy?: DetectorOrchestrationPolicy;
  /** Host destination registrations (contract §Publication destination); omitted means none. */
  readonly destinations?: readonly DestinationRegistration[];
  /** Loop-bound authority port (contract §Authority); omitted means publish cannot be authorized. */
  readonly authority?: AuthorityPort;
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
  queryInsightDerivations(input: InsightDerivationQuery): AsyncIterable<QueryPage<InsightDerivationView>>;
  queryDetectorExecutions(input: DetectorExecutionQuery): AsyncIterable<QueryPage<DetectorExecutionView>>;
  getImportReceipt(input: { readonly importReceiptId: string }): Promise<ImportReceipt | undefined>;
  getInsightDerivation(input: {
    readonly derivationId: string;
    readonly scope: Scope;
  }): Promise<InsightDerivationView | undefined>;
  getDetectorExecution(input: {
    readonly executionId: string;
    readonly scope: Scope;
  }): Promise<DetectorExecutionView | undefined>;
  propose(input: CandidateInput): Promise<ProposeOutcome>;
  reviewCandidate(input: CandidateReviewInput): Promise<CandidateReview>;
  getCandidateView(input: { readonly candidateId: string }): Promise<CandidateView | undefined>;
  preparePublication(input: PreparePublicationInput): Promise<PreparedPublication>;
  publish(input: PublishInput): Promise<PublicationOutcome>;
  report(input: LearningReportQuery): Promise<LearningReport>;
  runDetector(input: DetectorRunInput): Promise<DetectorRunResult>;
  runDetectorPack(input: DetectorPackRunInput): Promise<DetectorPackRunResult>;
  queryDetectorPackRuns(input: DetectorPackRunQuery): AsyncIterable<QueryPage<DetectorPackRunView>>;
  getDetectorPackRun(input: {
    readonly packRunReceiptId: string;
    readonly scope: Scope;
  }): Promise<DetectorPackRunView | undefined>;
}

const learningLoopContexts = new WeakMap<object, EngineContext>();

/** Private capability lookup used by opt-in package entrypoints. */
export function contextForLearningLoop(input: unknown): EngineContext {
  if (typeof input !== "object" || input === null) {
    throw invalid("config.invalid", "learning loop must be a kernel-created capability", ["loop"]);
  }
  const context = learningLoopContexts.get(input);
  if (context === undefined) {
    throw invalid("config.invalid", "learning loop was not created by createLearningLoop", ["loop"]);
  }
  return context;
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

function freezeSemanticValue<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const nested of Object.values(value)) freezeSemanticValue(nested);
    Object.freeze(value);
  }
  return value;
}

export function createLearningLoop(config: LearningLoopConfig): LearningLoop {
  const configuredSemanticRegistry = config.semanticRegistry;
  const configuredDetectorImplementations = config.detectorImplementations;
  const configuredDetectorOrchestrationPolicy = config.detectorOrchestrationPolicy;
  const configuredDestinations = config.destinations;
  const configuredAuthority = config.authority;
  const detectorOrchestrationPolicy =
    configuredDetectorOrchestrationPolicy === undefined
      ? undefined
      : freezeSemanticValue(parseDetectorOrchestrationPolicy(configuredDetectorOrchestrationPolicy));
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

  const destinationsById = new Map<string, BoundDestination>();
  if (configuredDestinations !== undefined) {
    if (!Array.isArray(configuredDestinations)) {
      throw invalid("config.invalid", "destinations must be an array of registrations", ["destinations"]);
    }
    for (const [index, registration] of configuredDestinations.entries()) {
      const destination = bindDestinationRegistration(registration, ["destinations", index]);
      if (destinationsById.has(destination.id)) {
        throw invalid("config.invalid", `duplicate destination id "${destination.id}"`, ["destinations", index]);
      }
      if (!contentPoliciesById.has(destination.contentPolicyId)) {
        throw invalid(
          "config.invalid",
          `destination "${destination.id}" names content policy "${destination.contentPolicyId}", which is not configured`,
          ["destinations", index, "contentPolicyId"],
        );
      }
      destinationsById.set(destination.id, destination);
    }
  }
  const authority = configuredAuthority === undefined ? undefined : authorityRegistryProjection(configuredAuthority);

  const boundPolicy = bindLearningPolicy(config.policy);
  const policy = boundPolicy.policy;
  const policyRules = boundPolicy.rules;
  const scopePolicy = snapshotScopePolicy(config.scopePolicy);
  const identityPort = config.identity;
  const identity = identityRegistryProjection(identityPort);
  const semanticRegistry =
    configuredSemanticRegistry === undefined
      ? undefined
      : freezeSemanticValue(parseSemanticRegistryConfig(configuredSemanticRegistry));
  if (semanticRegistry !== undefined && semanticRegistry.scopePolicyDigest !== scopePolicy.digest) {
    throw invalid("config.invalid", "semantic registry scope policy does not match the configured loop scope policy", [
      "semanticRegistry",
      "scopePolicyDigest",
    ]);
  }
  const sourcesById = new Map([...sources].map((source) => [source.id, source]));
  const sourceSemanticProfilesBySourceId = new Map<string, SourceSemanticProfile>();
  if (semanticRegistry !== undefined) {
    for (const [index, profile] of semanticRegistry.sourceProfiles.entries()) {
      const source = sourcesById.get(profile.sourceId);
      if (source === undefined) {
        throw invalid("config.invalid", "source semantic profile names an unconfigured source", [
          "semanticRegistry",
          "sourceProfiles",
          index,
          "sourceId",
        ]);
      }
      if (source.registryRevision !== profile.sourceRegistrationRevision) {
        throw invalid("config.invalid", "source semantic profile does not match the configured source revision", [
          "semanticRegistry",
          "sourceProfiles",
          index,
          "sourceRegistrationRevision",
        ]);
      }
      sourceSemanticProfilesBySourceId.set(profile.sourceId, profile);
    }
  }
  const semanticDetectorsByRef = new Map(
    semanticRegistry?.detectors.map((detector) => [
      detectorRefKey({
        id: detector.id,
        version: detector.version,
        registrationDigest: detector.registrationDigest,
      }),
      detector,
    ]) ?? [],
  );
  const semanticPacksByRef = new Map(
    semanticRegistry?.packs.map((pack) => [
      packRefKey({ id: pack.id, version: pack.version, manifestDigest: pack.manifestDigest }),
      pack,
    ]) ?? [],
  );
  const semanticLensesByRef = new Map(
    semanticRegistry?.lenses.map((lens) => [
      lensRefKey({ id: lens.id, version: lens.version, registrationDigest: lens.registrationDigest }),
      lens,
    ]) ?? [],
  );
  const detectorImplementationsByRef = new Map<string, RegisteredDetectorImplementation>();
  const detectorImplementationRegistryProjection: Array<{
    readonly detector: RegisteredDetectorImplementation["detector"];
    readonly implementationDigest: string;
    readonly registrationDigest: string;
  }> = [];
  if (configuredDetectorImplementations !== undefined) {
    for (const [index, capability] of configuredDetectorImplementations.entries()) {
      const registration = detectorImplementationRegistration(capability);
      const key = detectorRefKey(registration);
      const configured = semanticDetectorsByRef.get(key);
      if (
        configured === undefined ||
        configured.maturity === "deprecated" ||
        configured.implementationDigest !== capability.implementationDigest ||
        detectorImplementationsByRef.has(key)
      ) {
        throw invalid("config.invalid", "detector implementation does not match one exact installed registration", [
          "detectorImplementations",
          index,
        ]);
      }
      detectorImplementationsByRef.set(key, capability);
      detectorImplementationRegistryProjection.push({
        detector: capability.detector,
        implementationDigest: capability.implementationDigest,
        registrationDigest: capability.registrationDigest,
      });
    }
    detectorImplementationRegistryProjection.sort((left, right) =>
      detectorRefKey(left.detector) < detectorRefKey(right.detector) ? -1 : 1,
    );
  }
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
    ...(semanticRegistry !== undefined
      ? { semanticRegistry: { registryDigest: semanticRegistry.registryDigest } }
      : {}),
    ...(configuredDetectorImplementations !== undefined
      ? { detectorImplementations: detectorImplementationRegistryProjection }
      : {}),
    ...(detectorOrchestrationPolicy === undefined
      ? {}
      : { detectorOrchestrationPolicy: { policyDigest: detectorOrchestrationPolicy.policyDigest } }),
    ...(configuredDestinations === undefined
      ? {}
      : {
          destinations: [...destinationsById.values()]
            .map((destination) => ({ id: destination.id, registrationDigest: destination.registrationDigest }))
            .sort((left, right) => (left.id < right.id ? -1 : 1)),
        }),
    ...(authority === undefined ? {} : { authority }),
  });

  const context: EngineContext = {
    store: config.store,
    policy,
    policyRules,
    scopePolicy,
    contentPoliciesById,
    sources,
    identity: identityPort,
    ...(semanticRegistry !== undefined ? { semanticRegistry } : {}),
    semanticDetectorsByRef,
    semanticPacksByRef,
    semanticLensesByRef,
    sourceSemanticProfilesBySourceId,
    detectorImplementationsByRef,
    ...(detectorOrchestrationPolicy === undefined ? {} : { detectorOrchestrationPolicy }),
    ...(configuredAuthority === undefined ? {} : { authority: configuredAuthority }),
    destinationsById,
    registryRevision,
    queryCursorScopeDigest,
    clock: config.clock ?? systemClock,
    ids: config.ids ?? randomIds(),
  };

  const loop: LearningLoop = {
    ingest: <I>(source: RegisteredSource<I>, sourceInput: I, options?: IngestOptions) =>
      runIngest(context, source, sourceInput, options),
    queryObservations: (input) => runObservationQuery(context, input),
    queryMeasurements: (input) => runMeasurementQuery(context, input),
    queryEpisodes: (input) => runEpisodeQuery(context, input),
    querySourcePageReceipts: (input) => runSourcePageReceiptQuery(context, input),
    queryEvidenceHealthFindings: (input) => runEvidenceHealthQuery(context, input),
    queryInsightDerivations: (input) => runInsightDerivationQuery(context, input),
    queryDetectorExecutions: (input) => runDetectorExecutionQuery(context, input),
    getImportReceipt: (input) => runGetImportReceipt(context, input),
    getInsightDerivation: (input) => runGetInsightDerivation(context, input),
    getDetectorExecution: (input) => runGetDetectorExecution(context, input),
    propose: (input) => runPropose(context, input),
    reviewCandidate: (input) => runReviewCandidate(context, input),
    getCandidateView: (input) => runGetCandidateView(context, input),
    preparePublication: (input) => runPreparePublication(context, input),
    publish: (input) => runPublish(context, input),
    report: (input) => runReport(context, input),
    runDetector: (input) => runDetector(context, input),
    runDetectorPack: (input) => runDetectorPack(context, input),
    queryDetectorPackRuns: (input) => runDetectorPackRunQuery(context, input),
    getDetectorPackRun: (input) => runGetDetectorPackRun(context, input),
  };
  const frozen = Object.freeze(loop);
  learningLoopContexts.set(frozen, context);
  return frozen;
}
