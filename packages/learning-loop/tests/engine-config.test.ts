// createLearningLoop construction: the registry is validated and digested up
// front — misconfiguration is a construction error, never a latent runtime
// surprise.
import { describe, expect, it } from "vitest";
import type { LearningLoopConfig } from "../src/index.js";
import { conservativePolicy, createLearningLoop, defineSourceRegistration } from "../src/index.js";
import { defineSourceRegistration as portsOnlyRegistration } from "../src/ports/evidence.js";
import {
  createExactScopePolicy,
  createInMemoryStore,
  createManualEvidenceSource,
  createStructuredContentPolicy,
  createTestIdentityPort,
} from "../src/testing/index.js";

function baseConfig(): LearningLoopConfig {
  return {
    store: createInMemoryStore(),
    policy: conservativePolicy(),
    identity: createTestIdentityPort(),
    scopePolicy: createExactScopePolicy(),
    contentPolicies: [createStructuredContentPolicy({ id: "structured-v1" })],
    sources: [
      defineSourceRegistration({
        source: createManualEvidenceSource(),
        trustCeiling: "observed",
        contentPolicyId: "structured-v1",
      }),
    ],
  };
}

describe("createLearningLoop configuration", () => {
  it("accepts a well-formed registry", () => {
    expect(() => createLearningLoop(baseConfig())).not.toThrow();
  });

  it("rejects a source naming an unconfigured content policy", () => {
    const config = baseConfig();
    const orphan = defineSourceRegistration({
      source: createManualEvidenceSource(),
      trustCeiling: "observed",
      contentPolicyId: "no-such-policy",
    });
    expect(() => createLearningLoop({ ...config, sources: [orphan] })).toThrow(/no-such-policy/);
  });

  it("rejects duplicate content policy ids and duplicate source ids", () => {
    const config = baseConfig();
    expect(() =>
      createLearningLoop({
        ...config,
        contentPolicies: [
          createStructuredContentPolicy({ id: "structured-v1" }),
          createStructuredContentPolicy({ id: "structured-v1" }),
        ],
      }),
    ).toThrow(/duplicate content policy/);
    const twin = defineSourceRegistration({
      source: createManualEvidenceSource(),
      trustCeiling: "advisory",
      contentPolicyId: "structured-v1",
    });
    expect(() => createLearningLoop({ ...config, sources: [...config.sources, twin] })).toThrow(/duplicate source/);
  });

  it("rejects a registration the engine has no adapter for", () => {
    const config = baseConfig();
    const adapterless = portsOnlyRegistration({
      source: createManualEvidenceSource(),
      trustCeiling: "observed",
      contentPolicyId: "structured-v1",
    });
    expect(() => createLearningLoop({ ...config, sources: [adapterless] })).toThrow(/no adapter/);
  });

  it("rejects a policy that carries no digest-bound rule data", () => {
    const config = baseConfig();
    expect(() => createLearningLoop({ ...config, policy: { id: "bare", digest: "f".repeat(64) } })).toThrow(
      /no rule data/,
    );
  });

  it("binds every registered component into the registry revision", async () => {
    const identities = createTestIdentityPort();
    const makeLoopRevision = async (trustCeiling: "observed" | "advisory") => {
      const source = defineSourceRegistration({
        source: createManualEvidenceSource(),
        trustCeiling,
        contentPolicyId: "structured-v1",
      });
      const learning = createLearningLoop({
        store: createInMemoryStore(),
        policy: conservativePolicy(),
        identity: identities,
        scopePolicy: createExactScopePolicy(),
        contentPolicies: [createStructuredContentPolicy({ id: "structured-v1" })],
        sources: [source],
      });
      const receipt = await learning.ingest(source, { observations: [] });
      return receipt.registryRevision;
    };
    const observed = await makeLoopRevision("observed");
    const observedAgain = await makeLoopRevision("observed");
    const advisory = await makeLoopRevision("advisory");
    expect(observed).toBe(observedAgain);
    expect(observed).not.toBe(advisory);
  });
});
