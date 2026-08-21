// @cormidia/learning-loop/testing — in-memory stores, deterministic clocks and
// identifiers, and conformance suites.
export { createInMemoryStore } from "./in-memory-store.js";
export type { FixedClock } from "./deterministic.js";
export { createFixedClock, createSequentialIds } from "./deterministic.js";
export type { LearningStoreFactory } from "./store-conformance.js";
export { runLearningStoreConformance } from "./store-conformance.js";
// Re-exported here because the ratified contract's consumer journey imports
// the exact scope policy from the /testing entrypoint; the implementation is
// kernel domain code and also ships from the root.
export { createExactScopePolicy } from "../records/scope.js";
export { createTestIdentityPort } from "./test-identity.js";
export type { ManualEvidenceInput } from "./manual-evidence.js";
export { createManualEvidenceSource } from "./manual-evidence.js";
export { createStructuredContentPolicy } from "./structured-content.js";
// Activate (decision 0026): an inert in-memory versioned destination and the
// injected destination conformance suite every adapter must pass.
export type { InMemoryDestination, InMemoryDestinationOptions } from "./in-memory-destination.js";
export { createInMemoryDestination } from "./in-memory-destination.js";
export type { PublicationDestinationFactory } from "./destination-conformance.js";
export { runPublicationDestinationConformance } from "./destination-conformance.js";
