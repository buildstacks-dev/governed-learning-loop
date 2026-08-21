// createAuthorityPort (decision 0025): the identity-port discipline applied
// to host approvals. The kernel parses the host result from `unknown`,
// requires the approved binding digest to equal the binding it asked about,
// brands a frozen handle, and accepts handles only from the exact port
// instance configured on a loop.
import { describe, expect, it } from "vitest";
import type { AuthorityPort, AuthorizationBinding, LearningLoopConfig } from "../src/index.js";
import {
  authorizationBindingDigest,
  conservativePolicy,
  createAuthorityPort,
  createLearningLoop,
  defineSourceRegistration,
  sha256HexOfCanonicalJson,
} from "../src/index.js";
import { assertVerifiedAuthorization } from "../src/engine/authority.js";
import {
  createExactScopePolicy,
  createInMemoryStore,
  createManualEvidenceSource,
  createStructuredContentPolicy,
  createTestIdentityPort,
} from "../src/testing/index.js";
import { AUTHORIZED_AT, EXPIRES_AT, defaultAuthorityScript, scriptedAuthority } from "./publication-harness.js";

const D = (character: string): string => character.repeat(64);

const BINDING: AuthorizationBinding = {
  planDigest: D("a"),
  candidateDigest: D("b"),
  destinationId: "agent-instructions",
  effectClass: "context",
  effectiveRisk: "T1",
  action: "publish",
  expectedBases: ["instructions-v7"],
  policyDigest: D("c"),
  lineageClosureDigest: D("d"),
};

function validMaterial(bindingDigest = authorizationBindingDigest(BINDING)) {
  return {
    id: "approval-1",
    principal: { id: "approver-h", kind: "human", independenceDomain: "ops" },
    principalAttestationDigest: D("e"),
    bindingDigest,
    authorizedAt: AUTHORIZED_AT,
    expiresAt: EXPIRES_AT,
  };
}

function hostAuthority(
  options: {
    readonly id?: string;
    readonly version?: string;
    readonly configurationDigest?: string;
    readonly verify?: (input: {
      readonly evidence: unknown;
      readonly binding: AuthorizationBinding;
    }) => Promise<unknown>;
  } = {},
): AuthorityPort {
  return createAuthorityPort({
    id: options.id ?? "authority.example",
    version: options.version ?? "1.0.0",
    configurationDigest: options.configurationDigest ?? D("2"),
    verify: options.verify ?? (() => Promise.resolve({ status: "authorized", authorization: validMaterial() })),
  });
}

function loopConfig(authority: unknown): LearningLoopConfig {
  const contentPolicyId = "authority-test-content-v1";
  const source = defineSourceRegistration({
    source: createManualEvidenceSource(),
    trustCeiling: "observed",
    contentPolicyId,
  });
  const config: unknown = {
    store: createInMemoryStore(),
    policy: conservativePolicy(),
    identity: createTestIdentityPort(),
    scopePolicy: createExactScopePolicy(),
    contentPolicies: [createStructuredContentPolicy({ id: contentPolicyId })],
    sources: [source],
    authority,
  };
  return config as LearningLoopConfig;
}

function createPortFromUnknown(input: unknown): unknown {
  return Reflect.apply(createAuthorityPort, undefined, [input]);
}

async function registryRevisionOf(config: LearningLoopConfig): Promise<string> {
  const learning = createLearningLoop(config);
  const source = config.sources[0];
  if (source === undefined) throw new Error("harness source missing");
  const receipt = await learning.ingest(source, { observations: [] });
  return receipt.registryRevision;
}

describe("createAuthorityPort", () => {
  it("pins the canonical registration digest and freezes the factory products", async () => {
    const authority = hostAuthority();
    expect(authority).toMatchObject({
      id: "authority.example",
      version: "1.0.0",
      configurationDigest: D("2"),
      registrationDigest: "328c9846b1a92668a7ac3961dfd853026d4ab4217c97718e44cacd4477333924",
    });
    expect(authority.registrationDigest).toBe(
      sha256HexOfCanonicalJson({ id: "authority.example", version: "1.0.0", configurationDigest: D("2") }),
    );
    expect(Object.isFrozen(authority)).toBe(true);

    const verification = await authority.verify({ evidence: { opaque: true }, binding: BINDING });
    expect(verification.status).toBe("authorized");
    if (verification.status !== "authorized") return;
    expect(verification.authorization).toMatchObject(validMaterial());
    expect(Object.isFrozen(verification)).toBe(true);
    expect(Object.isFrozen(verification.authorization)).toBe(true);
    expect(Object.isFrozen(verification.authorization.principal)).toBe(true);
  });

  it("is stable for equivalent registrations and changes for id, version, or configuration", () => {
    const baseline = hostAuthority().registrationDigest;
    expect(hostAuthority().registrationDigest).toBe(baseline);
    const changed = [
      hostAuthority({ id: "authority.other" }).registrationDigest,
      hostAuthority({ version: "1.0.1" }).registrationDigest,
      hostAuthority({ configurationDigest: D("3") }).registrationDigest,
    ];
    expect(new Set([baseline, ...changed]).size).toBe(4);
  });

  it("passes opaque evidence and a frozen copy of the exact binding to the host verifier", async () => {
    const evidence = Object.freeze({ token: Symbol("opaque") });
    let observed: { readonly evidence: unknown; readonly binding: AuthorizationBinding } | undefined;
    const authority = hostAuthority({
      verify: (input) => {
        observed = input;
        return Promise.resolve({ status: "authorized", authorization: validMaterial() });
      },
    });
    await authority.verify({ evidence, binding: BINDING });
    expect(observed?.evidence).toBe(evidence);
    expect(observed?.binding).toEqual(BINDING);
    expect(Object.isFrozen(observed?.binding)).toBe(true);
    expect(Object.isFrozen(observed?.binding.expectedBases)).toBe(true);
  });

  it("captures the registered verifier instead of following later input mutation", async () => {
    const factoryInput = {
      id: "authority.captured",
      version: "1.0.0",
      configurationDigest: D("2"),
      verify: (_input: { readonly evidence: unknown; readonly binding: AuthorizationBinding }): Promise<unknown> =>
        Promise.resolve({ status: "pending", diagnostics: [] }),
    };
    const authority = createAuthorityPort(factoryInput);
    factoryInput.verify = () => Promise.resolve(null);
    await expect(authority.verify({ evidence: null, binding: BINDING })).resolves.toEqual({
      status: "pending",
      diagnostics: [],
    });
  });

  it("rejects invalid registration metadata and a non-function verifier", () => {
    const baseline = {
      id: "authority.invalid-input",
      version: "1.0.0",
      configurationDigest: D("2"),
      verify: () => Promise.resolve(null),
    };
    for (const input of [
      { ...baseline, id: "" },
      { ...baseline, id: "i".repeat(201) },
      { ...baseline, id: "authority\ncontrol" },
      { ...baseline, version: "" },
      { ...baseline, configurationDigest: "2".repeat(63) },
      { ...baseline, configurationDigest: "A".repeat(64) },
      { ...baseline, verify: null },
    ]) {
      expect(() => createPortFromUnknown(input)).toThrow(
        expect.objectContaining({ name: "LearningLoopError", code: "schema.invalid" }),
      );
    }
  });

  const passthrough = ["pending", "denied", "invalid", "expired"] as const;
  for (const status of passthrough) {
    it(`passes a host "${status}" decision through with its diagnostics and mints no handle`, async () => {
      const diagnostics = [{ code: "host.reason", severity: "warning", message: "approval workflow state" }];
      const authority = hostAuthority({ verify: () => Promise.resolve({ status, diagnostics }) });
      const verification = await authority.verify({ evidence: null, binding: BINDING });
      expect(verification).toEqual({ status, diagnostics });
      expect(Object.isFrozen(verification)).toBe(true);
    });
  }

  it("maps an approval of a different binding to a closed invalid decision without minting a handle", async () => {
    const otherBase = { ...BINDING, expectedBases: ["instructions-v6"] };
    const authority = hostAuthority({
      verify: () =>
        Promise.resolve({ status: "authorized", authorization: validMaterial(authorizationBindingDigest(otherBase)) }),
    });
    const verification = await authority.verify({ evidence: null, binding: BINDING });
    expect(verification.status).toBe("invalid");
    if (verification.status === "authorized") return;
    expect(verification.diagnostics[0]?.code).toBe("publication.binding_mismatch");
    expect(verification.diagnostics[0]?.details).toEqual({
      expectedBindingDigest: authorizationBindingDigest(BINDING),
      approvedBindingDigest: authorizationBindingDigest(otherBase),
    });
  });

  const malformed: readonly { readonly name: string; readonly result: unknown }[] = [
    { name: "non-object", result: null },
    { name: "unknown-status", result: { status: "approved", authorization: validMaterial() } },
    { name: "pending-without-diagnostics", result: { status: "pending" } },
    { name: "authorized-without-material", result: { status: "authorized" } },
    {
      name: "invalid-principal-kind",
      result: {
        status: "authorized",
        authorization: { ...validMaterial(), principal: { id: "x", kind: "robot", independenceDomain: "ops" } },
      },
    },
    { name: "empty-id", result: { status: "authorized", authorization: { ...validMaterial(), id: "" } } },
    {
      name: "oversized-id",
      result: { status: "authorized", authorization: { ...validMaterial(), id: "a".repeat(1_001) } },
    },
    {
      name: "upper-case-binding-digest",
      result: { status: "authorized", authorization: { ...validMaterial(), bindingDigest: "A".repeat(64) } },
    },
    {
      name: "non-canonical-authorizedAt",
      result: { status: "authorized", authorization: { ...validMaterial(), authorizedAt: "2026-08-16T09:59:00Z" } },
    },
    {
      name: "expiry-not-after-authorization",
      result: { status: "authorized", authorization: { ...validMaterial(), expiresAt: AUTHORIZED_AT } },
    },
    {
      name: "diagnostic-invalid-severity",
      result: { status: "denied", diagnostics: [{ code: "x", severity: "fatal", message: "m" }] },
    },
    {
      name: "too-many-diagnostics",
      result: {
        status: "denied",
        diagnostics: Array.from({ length: 101 }, () => ({ code: "x", severity: "error", message: "m" })),
      },
    },
  ];
  for (const example of malformed) {
    it(`refuses malformed verifier output: ${example.name}`, async () => {
      const authority = hostAuthority({ verify: () => Promise.resolve(example.result) });
      await expect(authority.verify({ evidence: null, binding: BINDING })).rejects.toMatchObject({
        name: "LearningLoopError",
        code: "schema.invalid",
      });
    });
  }

  it("omits expiresAt exactly when the host omits it", async () => {
    const { id, principal, principalAttestationDigest, bindingDigest, authorizedAt } = validMaterial();
    const authority = hostAuthority({
      verify: () =>
        Promise.resolve({
          status: "authorized",
          authorization: { id, principal, principalAttestationDigest, bindingDigest, authorizedAt },
        }),
    });
    const verification = await authority.verify({ evidence: null, binding: BINDING });
    if (verification.status !== "authorized") throw new Error("expected authorized");
    expect("expiresAt" in verification.authorization).toBe(false);
  });
});

describe("exact-port authorization binding", () => {
  it("accepts a handle from the minting port and refuses byte-identical handles from another instance", async () => {
    const first = hostAuthority();
    const second = hostAuthority();
    expect(first.registrationDigest).toBe(second.registrationDigest);
    const verification = await second.verify({ evidence: null, binding: BINDING });
    if (verification.status !== "authorized") throw new Error("expected authorized");
    expect(() => assertVerifiedAuthorization(second, verification.authorization, "authorization")).not.toThrow();
    expect(() => assertVerifiedAuthorization(first, verification.authorization, "authorization")).toThrow(
      expect.objectContaining({ name: "LearningLoopError", code: "authority.unverified" }),
    );
  });

  it("refuses JavaScript-shaped lookalikes and a structural copy of a handle", async () => {
    const authority = hostAuthority();
    const verification = await authority.verify({ evidence: null, binding: BINDING });
    if (verification.status !== "authorized") throw new Error("expected authorized");
    for (const lookalike of [null, "approval-1", validMaterial(), { ...verification.authorization }]) {
      expect(() => assertVerifiedAuthorization(authority, lookalike, "authorization")).toThrow(
        expect.objectContaining({ name: "LearningLoopError", code: "authority.unverified" }),
      );
    }
  });

  it("rejects a structural copy of a factory port at loop construction", () => {
    const authority = hostAuthority();
    const lookalike = { ...authority };
    expect(() => createLearningLoop(loopConfig(lookalike))).toThrow(
      expect.objectContaining({ name: "LearningLoopError", code: "config.invalid" }),
    );
    expect(() => createLearningLoop(loopConfig(authority))).not.toThrow();
  });

  it("binds the authority registration into the loop registry revision", async () => {
    const withoutAuthority = await registryRevisionOf(loopConfig(undefined));
    const baseline = await registryRevisionOf(loopConfig(hostAuthority()));
    const equivalent = await registryRevisionOf(loopConfig(hostAuthority()));
    const otherId = await registryRevisionOf(loopConfig(hostAuthority({ id: "authority.other" })));
    const otherVersion = await registryRevisionOf(loopConfig(hostAuthority({ version: "2.0.0" })));
    const otherConfiguration = await registryRevisionOf(loopConfig(hostAuthority({ configurationDigest: D("9") })));
    expect(baseline).toBe(equivalent);
    expect(new Set([withoutAuthority, baseline, otherId, otherVersion, otherConfiguration]).size).toBe(5);
  });

  it("the harness authority script binds the exact verified binding by default", async () => {
    const spy = scriptedAuthority(defaultAuthorityScript);
    const verification = await spy.port.verify({ evidence: { decision: "authorized" }, binding: BINDING });
    expect(verification.status).toBe("authorized");
    if (verification.status !== "authorized") return;
    expect(verification.authorization.bindingDigest).toBe(authorizationBindingDigest(BINDING));
    expect(spy.calls).toHaveLength(1);
  });
});
