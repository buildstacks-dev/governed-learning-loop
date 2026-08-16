// The in-memory store must pass the public LearningStore conformance suite —
// the suite, not this file, is the contract.
import { createInMemoryStore } from "../src/testing/in-memory-store.js";
import { runLearningStoreConformance } from "../src/testing/store-conformance.js";

runLearningStoreConformance(() => createInMemoryStore());
