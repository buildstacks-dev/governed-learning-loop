// The in-memory store must pass the public LearningStore conformance suite —
// the suite, not this file, is the contract.
import { createInMemoryStore, runLearningStoreConformance } from "@cormidia/learning-loop/testing";
import { describe, expect, it } from "vitest";

runLearningStoreConformance(() => createInMemoryStore(), { describe, expect, it });
