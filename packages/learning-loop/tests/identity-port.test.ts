import { describe, expect, it } from "vitest";
import type { IdentityPort, LearningLoopConfig, PrincipalRef } from "../src/index.js";
import {
  conservativePolicy,
  createIdentityPort,
  createLearningLoop,
  defineSourceRegistration,
  sha256HexOfCanonicalJson,
} from "../src/index.js";
import {
  createExactScopePolicy,
  createInMemoryStore,
  createManualEvidenceSource,
  createStructuredContentPolicy,
} from "../src/testing/index.js";

const CONFIGURATION_DIGEST = "1".repeat(64);
const ATTESTATION_DIGEST = "a".repeat(64);

const PRINCIPAL: PrincipalRef = {
  id: "distiller-a",
  kind: "agent",
  independenceDomain: "provider-a",
};

function validMaterial(): {
  readonly ref: PrincipalRef;
  readonly attestationId: string;
  readonly attestationDigest: string;
} {
  return {
    ref: PRINCIPAL,
    attestationId: "attestation-distiller-a",
    attestationDigest: ATTESTATION_DIGEST,
  };
}

function hostIdentity(
  options: {
    readonly id?: string;
    readonly version?: string;
    readonly configurationDigest?: string;
    readonly verify?: (evidence: unknown) => Promise<unknown>;
  } = {},
): IdentityPort {
  return createIdentityPort({
    id: options.id ?? "identity.example",
    version: options.version ?? "1.0.0",
    configurationDigest: options.configurationDigest ?? CONFIGURATION_DIGEST,
    verify: options.verify ?? (() => Promise.resolve(validMaterial())),
  });
}

function loopConfig(identity: IdentityPort): LearningLoopConfig {
  const contentPolicyId = "identity-test-content-v1";
  const source = defineSourceRegistration({
    source: createManualEvidenceSource(),
    trustCeiling: "observed",
    contentPolicyId,
  });
  return {
    store: createInMemoryStore(),
    policy: conservativePolicy(),
    identity,
    scopePolicy: createExactScopePolicy(),
    contentPolicies: [createStructuredContentPolicy({ id: contentPolicyId })],
    sources: [source],
  };
}

function constructFromUnknown(config: unknown): unknown {
  return Reflect.apply(createLearningLoop, undefined, [config]);
}

function createPortFromUnknown(input: unknown): unknown {
  return Reflect.apply(createIdentityPort, undefined, [input]);
}

describe("createIdentityPort", () => {
  it("pins the canonical registration digest and freezes the factory products", async () => {
    const identity = hostIdentity();
    expect(identity).toMatchObject({
      id: "identity.example",
      version: "1.0.0",
      configurationDigest: CONFIGURATION_DIGEST,
      registrationDigest: "e31e62f38fd1c7069525184f7395878bbe0f65a15f3c61bfbccf60b2bb5a3155",
    });
    expect(Object.isFrozen(identity)).toBe(true);

    const principal = await identity.verify({ opaque: true });
    expect(principal).toMatchObject(validMaterial());
    expect(Object.isFrozen(principal)).toBe(true);
    expect(Object.isFrozen(principal.ref)).toBe(true);
  });

  it("is stable for equivalent registrations and changes for id, version, or configuration", () => {
    const baseline = hostIdentity().registrationDigest;
    expect(hostIdentity().registrationDigest).toBe(baseline);
    const idChanged = hostIdentity({ id: "identity.other" }).registrationDigest;
    const versionChanged = hostIdentity({ version: "1.0.1" }).registrationDigest;
    const configurationChanged = hostIdentity({
      configurationDigest: sha256HexOfCanonicalJson({ configuration: "v2" }),
    }).registrationDigest;
    expect(new Set([baseline, idChanged, versionChanged, configurationChanged]).size).toBe(4);
  });

  it("passes opaque evidence to the host verifier without interpreting it", async () => {
    const evidence = Object.freeze({ token: Symbol("opaque") });
    let observed: unknown;
    const identity = hostIdentity({
      verify: (input: unknown) => {
        observed = input;
        return Promise.resolve(validMaterial());
      },
    });
    await identity.verify(evidence);
    expect(observed).toBe(evidence);
  });

  it("captures the registered verifier instead of following later input mutation", async () => {
    const factoryInput: {
      id: string;
      version: string;
      configurationDigest: string;
      verify: (evidence: unknown) => Promise<unknown>;
    } = {
      id: "identity.captured-verifier",
      version: "1.0.0",
      configurationDigest: CONFIGURATION_DIGEST,
      verify: (_evidence: unknown) => Promise.resolve(validMaterial()),
    };
    const identity = createIdentityPort(factoryInput);
    factoryInput.verify = () => Promise.resolve(null);

    await expect(identity.verify({ opaque: true })).resolves.toMatchObject(validMaterial());
  });

  it("reads an accessor-backed verifier exactly once", async () => {
    let reads = 0;
    const input = {
      id: "identity.accessor-verifier",
      version: "1.0.0",
      configurationDigest: CONFIGURATION_DIGEST,
      get verify(): (evidence: unknown) => Promise<unknown> {
        reads += 1;
        return reads === 1 ? () => Promise.resolve(validMaterial()) : () => Promise.resolve(null);
      },
    };
    const identity = createIdentityPort(input);
    expect(reads).toBe(1);
    await expect(identity.verify({ opaque: true })).resolves.toMatchObject(validMaterial());
    expect(reads).toBe(1);
  });

  it("rejects invalid registration metadata and a non-function verifier", () => {
    const baseline = {
      id: "identity.invalid-input",
      version: "1.0.0",
      configurationDigest: CONFIGURATION_DIGEST,
      verify: () => Promise.resolve(validMaterial()),
    };
    const invalidInputs: readonly unknown[] = [
      { ...baseline, id: "" },
      { ...baseline, id: "i".repeat(201) },
      { ...baseline, id: "identity\ncontrol" },
      { ...baseline, version: "" },
      { ...baseline, version: "v".repeat(201) },
      { ...baseline, version: "version\ncontrol" },
      { ...baseline, configurationDigest: "a".repeat(63) },
      { ...baseline, configurationDigest: "A".repeat(64) },
      { ...baseline, verify: null },
    ];
    for (const input of invalidInputs) {
      expect(() => createPortFromUnknown(input)).toThrow(
        expect.objectContaining({ name: "LearningLoopError", code: "schema.invalid" }),
      );
    }
  });

  const malformed: readonly { readonly name: string; readonly result: unknown }[] = [
    { name: "non-object", result: null },
    {
      name: "missing-ref",
      result: { attestationId: "attestation-distiller-a", attestationDigest: ATTESTATION_DIGEST },
    },
    {
      name: "empty-principal-id",
      result: {
        ref: { ...PRINCIPAL, id: "" },
        attestationId: "attestation-distiller-a",
        attestationDigest: ATTESTATION_DIGEST,
      },
    },
    {
      name: "invalid-principal-kind",
      result: {
        ref: { ...PRINCIPAL, kind: "robot" },
        attestationId: "attestation-distiller-a",
        attestationDigest: ATTESTATION_DIGEST,
      },
    },
    {
      name: "oversized-principal-id",
      result: {
        ref: { ...PRINCIPAL, id: "p".repeat(1_001) },
        attestationId: "attestation-distiller-a",
        attestationDigest: ATTESTATION_DIGEST,
      },
    },
    {
      name: "control-character-independence-domain",
      result: {
        ref: { ...PRINCIPAL, independenceDomain: "provider\ncontrol" },
        attestationId: "attestation-distiller-a",
        attestationDigest: ATTESTATION_DIGEST,
      },
    },
    {
      name: "empty-attestation-id",
      result: { ref: PRINCIPAL, attestationId: "", attestationDigest: ATTESTATION_DIGEST },
    },
    {
      name: "oversized-attestation-id",
      result: { ref: PRINCIPAL, attestationId: "a".repeat(1_001), attestationDigest: ATTESTATION_DIGEST },
    },
    {
      name: "invalid-attestation-digest",
      result: { ref: PRINCIPAL, attestationId: "attestation-distiller-a", attestationDigest: "not-a-digest" },
    },
    {
      name: "upper-case-attestation-digest",
      result: { ref: PRINCIPAL, attestationId: "attestation-distiller-a", attestationDigest: "A".repeat(64) },
    },
  ];

  for (const example of malformed) {
    it(`refuses malformed verifier output: ${example.name}`, async () => {
      const identity = hostIdentity({ verify: () => Promise.resolve(example.result) });
      await expect(identity.verify({ opaque: true })).rejects.toMatchObject({
        name: "LearningLoopError",
        code: "schema.invalid",
      });
    });
  }

  it("rejects a structural copy of a factory port at loop construction", () => {
    const identity = hostIdentity();
    const lookalike = { ...identity };
    const config: unknown = { ...loopConfig(identity), identity: lookalike };
    expect(() => constructFromUnknown(config)).toThrow(
      expect.objectContaining({ name: "LearningLoopError", code: "config.invalid" }),
    );
  });
});
