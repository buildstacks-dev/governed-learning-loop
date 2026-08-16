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
