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

export type { LearningStore, RecordKey, StoredRecord, StreamEntry, WriteResult } from "./ports/store.js";
export type { EvidencePage, EvidenceSource, ProjectedEpisode } from "./ports/evidence.js";
export type { ProjectedMeasurement, ProjectedObservation, RegisteredSource } from "./ports/evidence.js";
export { defineSourceRegistration } from "./ports/evidence.js";
export type { Clock, IdGenerator } from "./ports/clock.js";
