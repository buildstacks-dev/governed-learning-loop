// createLearningLoop construction: the registry is validated and digested up
// front — misconfiguration is a construction error, never a latent runtime
// surprise.
import { describe, expect, it } from "vitest";
import type { IdentityPort, LearningLoopConfig } from "../src/index.js";
import { conservativePolicy, createIdentityPort, createLearningLoop, defineSourceRegistration } from "../src/index.js";
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

function registeredIdentity(
  options: { readonly id?: string; readonly version?: string; readonly configurationDigest?: string } = {},
): IdentityPort {
  return createIdentityPort({
    id: options.id ?? "identity.registry-test",
    version: options.version ?? "1.0.0",
    configurationDigest: options.configurationDigest ?? "1".repeat(64),
    verify: () =>
      Promise.resolve({
        ref: { id: "registry-agent", kind: "agent", independenceDomain: "registry-tests" },
        attestationId: "registry-attestation",
        attestationDigest: "a".repeat(64),
      }),
  });
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

  it("captures an accessor-backed configured identity exactly once", () => {
    const config = baseConfig();
    const first = registeredIdentity({ id: "identity.first" });
    const second = registeredIdentity({ id: "identity.second" });
    let reads = 0;
    const accessorConfig = {
      ...config,
      get identity(): IdentityPort {
        reads += 1;
        return reads === 1 ? first : second;
      },
    };

    expect(() => createLearningLoop(accessorConfig)).not.toThrow();
    expect(reads).toBe(1);
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

  it("binds stable identity registration content into the loop registry revision", async () => {
    const makeLoopRevision = async (identity: IdentityPort) => {
      const config = baseConfig();
      const source = config.sources[0];
      if (source === undefined) throw new Error("expected the base source registration");
      const learning = createLearningLoop({ ...config, identity });
      const receipt = await learning.ingest(source, { observations: [] });
      return receipt.registryRevision;
    };

    const baseline = await makeLoopRevision(registeredIdentity());
    const equivalent = await makeLoopRevision(registeredIdentity());
    const idChanged = await makeLoopRevision(registeredIdentity({ id: "identity.registry-test.other" }));
    const versionChanged = await makeLoopRevision(registeredIdentity({ version: "1.0.1" }));
    const configurationChanged = await makeLoopRevision(registeredIdentity({ configurationDigest: "2".repeat(64) }));

    expect(equivalent).toBe(baseline);
    expect(new Set([baseline, idChanged, versionChanged, configurationChanged]).size).toBe(4);
  });
});
