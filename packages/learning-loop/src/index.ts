// @cormidia/learning-loop — governed adaptation kernel (root entrypoint).
// Records, unknown-first parsers, deterministic digests, ports.
// Public surface is gated by scripts/check-exports.mjs; the internal parser
// toolkit (src/parse/) and brand symbols (src/records/brands.ts) stay private.

export const PROTOCOL_SCHEMA_VERSION = 1;

export type { JsonPrimitive, JsonValue } from "./canonical/json.js";
export { toJsonValue } from "./canonical/to-json-value.js";
export { canonicalJsonText, sha256HexOfCanonicalJson } from "./canonical/canonical-json.js";
export type { Diagnostic } from "./diagnostics.js";
export { LearningLoopError } from "./diagnostics.js";

export type { Scope, ScopePolicy, ScopeSegment } from "./records/scope.js";
export { createExactScopePolicy } from "./records/scope.js";
export type { IdentityPort, PrincipalRef, VerifiedPrincipal } from "./records/principal.js";
export { parsePrincipalRef } from "./records/principal.js";
export { createIdentityPort } from "./engine/identity.js";
export type { ContentPolicy, Provenance, SourceDescriptor, TrustClass } from "./records/provenance.js";
export { parseProvenance } from "./records/provenance.js";
export type { Observation } from "./records/observation.js";
export { parseObservation } from "./records/observation.js";
export type { EpisodeOutcome, EpisodeRecord, MeasurementRecord, MetricDefinition } from "./records/episode.js";
export { parseEpisodeRecord, parseMeasurementRecord, parseMetricDefinition } from "./records/episode.js";
export type { Candidate, CandidateDigestInput, CandidateIntervention, RiskTier } from "./records/candidate.js";
export { candidateContentDigest, maxRiskTier, parseCandidate } from "./records/candidate.js";
export type { CandidateReview, ReviewDisposition, ReviewFinding } from "./records/review.js";
export { parseCandidateReview, reviewInvalidReasons } from "./records/review.js";
export type { EvidenceHealthFinding, ImportReceipt, SourcePageReceipt } from "./records/source-health.js";
export { parseEvidenceHealthFinding, parseImportReceipt, parseSourcePageReceipt } from "./records/source-health.js";

export type { LearningStore, RecordKey, StoredRecord, StreamEntry, WriteResult } from "./ports/store.js";
export type { EvidencePage, EvidenceSource, ProjectedEpisode } from "./ports/evidence.js";
export type { ProjectedMeasurement, ProjectedObservation, RegisteredSource } from "./ports/evidence.js";
// The root registration helper is the engine's wrapper: the ports-layer
// helper computes the same branded registration, but only the wrapper pairs
// the adapter with it so the engine can stream pages during ingest.
export { defineSourceRegistration } from "./engine/source-registration.js";
export type { Clock, IdGenerator } from "./ports/clock.js";

export type { LearningPolicy } from "./engine/policy.js";
export { conservativePolicy } from "./engine/policy.js";
export type { GovernanceView } from "./engine/governance.js";
export type { IngestReceipt } from "./engine/ingest.js";
export type { CandidateInput, ProposeOutcome } from "./engine/propose.js";
export type { CandidateView, EpisodeQuery, EpisodeView, EvidenceHealthQuery } from "./engine/query.js";
export type { MeasurementQuery, ObservationQuery, QueryPage } from "./engine/query.js";
export type { SourcePageReceiptQuery } from "./engine/query.js";
export type { CandidateReviewer, CandidateReviewInput } from "./engine/review.js";
export type { LearningReport, LearningReportQuery } from "./engine/report.js";
export type { LearningLoop, LearningLoopConfig } from "./engine/loop.js";
export { createLearningLoop } from "./engine/loop.js";
