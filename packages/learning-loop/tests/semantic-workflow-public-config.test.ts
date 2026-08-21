// Public consumer contract: workflow capability creation is exercised only
// through the opt-in package subpath. Private records remain test-harness data.
import { describe, expect, it } from "vitest";
import type { SemanticWorkflowBundle } from "@cormidia/learning-loop/workflows";
import { createSemanticWorkflowBundle } from "@cormidia/learning-loop/workflows";
import * as workflowEntrypoint from "@cormidia/learning-loop/workflows";
import { createGenerationHarness } from "./semantic-workflow-generation-harness.js";

describe("@cormidia/learning-loop/workflows capability factory", () => {
  it("exports one runtime factory plus one type and returns a frozen exact-definition bundle", async () => {
    expect(Object.keys(workflowEntrypoint)).toEqual(["createSemanticWorkflowBundle"]);
    expect(Object.keys(createSemanticWorkflowBundle).sort()).toEqual([
      "advisoryReviewResultSchema",
      "defineAdvisoryReview",
      "defineGeneration",
      "generationResultSchema",
    ]);
    expect(createSemanticWorkflowBundle.generationResultSchema).toMatchObject({
      schemaVersion: 1,
      id: "cormidia.semantic-generation-result",
      version: "1.0.0",
      schemaDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    // A schema-byte change requires a public schema-version bump before this golden moves.
    expect(createSemanticWorkflowBundle.generationResultSchema.schemaDigest).toBe(
      "e9275ce28d92bb7fff915466757d6eba6cac32840c08ec1dc5f455d85d682a1f",
    );
    expect(createSemanticWorkflowBundle.advisoryReviewResultSchema).toMatchObject({
      schemaVersion: 1,
      id: "cormidia.semantic-advisory-review-result",
      version: "1.0.0",
      schemaDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    // A schema-byte change requires a public schema-version bump before this golden moves.
    expect(createSemanticWorkflowBundle.advisoryReviewResultSchema.schemaDigest).toBe(
      "e34155e3439b6520c7fd794b5672e661b7d1dcaa67a6bb48916e031d9b5746a4",
    );
    expect(Object.isFrozen(createSemanticWorkflowBundle.generationResultSchema)).toBe(true);
    expect(Object.isFrozen(createSemanticWorkflowBundle.advisoryReviewResultSchema)).toBe(true);
    const harness = await createGenerationHarness();
    const bundle: SemanticWorkflowBundle = harness.bundle;
    expect(bundle).toMatchObject({ schemaVersion: 1, definitionDigest: harness.definition.definitionDigest });
    expect(Object.isFrozen(bundle)).toBe(true);
    expect(Object.keys(bundle).sort()).toEqual(
      [
        "authorizeAdvisoryReview",
        "authorizeGeneration",
        "definitionDigest",
        "getTurn",
        "prepareAdvisoryReview",
        "prepareGeneration",
        "queryTurns",
        "recoverAdvisoryReview",
        "recoverGeneration",
        "runAdvisoryReview",
        "runGeneration",
        "schemaVersion",
      ].sort(),
    );
    for (const method of [
      () => bundle.prepareAdvisoryReview({ candidateId: "candidate", scope: harness.scope, expiresAt: "x" }),
      () => bundle.authorizeAdvisoryReview({ plan: {}, evidence: null }),
      () => bundle.runAdvisoryReview({ plan: {}, authorization: null }),
      () => bundle.recoverAdvisoryReview({ attemptId: "attempt", scope: harness.scope }),
    ]) {
      await expect(method()).rejects.toMatchObject({ code: "semantic.workflow_lane_unavailable" });
    }
  });

  it("pins definition identity to every provider, model, prompt, renderer, implementation, budget, and disclosure fingerprint", async () => {
    const harness = await createGenerationHarness();
    const definition = harness.definition;
    const schemaVersion: 1 = 1;
    const input = {
      schemaVersion,
      id: definition.id,
      version: definition.version,
      transport: definition.transport,
      implementation: definition.implementation,
      providerModel: {
        provider: {
          id: definition.providerModel.provider.id,
          version: definition.providerModel.provider.version,
          providerFingerprintDigest: definition.providerModel.provider.providerFingerprintDigest,
          operationKeyPolicyDigest: definition.providerModel.provider.idempotency.operationKeyPolicyDigest,
        },
        model: definition.providerModel.model,
      },
      prompt: definition.prompt,
      renderer: definition.renderer,
      budgetPolicy: {
        maximumRequestBytes: definition.budgetPolicy.maximumRequestBytes,
        maximumResponseBytes: definition.budgetPolicy.maximumResponseBytes,
        maximumEpisodes: definition.budgetPolicy.maximumEpisodes,
        maximumEvidenceRefs: definition.budgetPolicy.maximumEvidenceRefs,
        maximumInputTokens: definition.budgetPolicy.maximumInputTokens,
        maximumOutputTokens: definition.budgetPolicy.maximumOutputTokens,
        maximumDurationMs: definition.budgetPolicy.maximumDurationMs,
        tokenEstimatorDigest: definition.budgetPolicy.tokenEstimatorDigest,
        maximumCost: definition.budgetPolicy.maximumCost,
      },
      disclosurePolicy: {
        mode: definition.disclosurePolicy.mode,
        minimizationPolicyDigest: definition.disclosurePolicy.minimizationPolicyDigest,
        keyPolicyDigest: definition.disclosurePolicy.keyPolicyDigest,
        authorizationPolicyDigest: definition.disclosurePolicy.authorizationPolicyDigest,
        maximumAuthorizationAgeMs: definition.disclosurePolicy.maximumAuthorizationAgeMs,
      },
      principal: definition.principal,
      attestation: definition.attestation,
    };
    const exact = createSemanticWorkflowBundle.defineGeneration(input);
    expect(exact).toEqual(definition);
    // A canonical definition-shape change requires the corresponding public version decision before this golden moves.
    expect(exact.definitionDigest).toBe("1a02a23ce7fbe4d6b08cdfecbef4f76118c1dedbd4499b14285e51e294260ebd");
    const foreign = "0".repeat(64);
    const variants = [
      {
        ...input,
        implementation: { ...input.implementation, implementationDigest: foreign },
      },
      {
        ...input,
        providerModel: {
          ...input.providerModel,
          provider: { ...input.providerModel.provider, providerFingerprintDigest: foreign },
        },
      },
      {
        ...input,
        providerModel: {
          ...input.providerModel,
          model: { ...input.providerModel.model, modelFingerprintDigest: foreign },
        },
      },
      { ...input, prompt: { ...input.prompt, promptDigest: foreign } },
      { ...input, renderer: { ...input.renderer, rendererDigest: foreign } },
      {
        ...input,
        budgetPolicy: { ...input.budgetPolicy, tokenEstimatorDigest: foreign },
      },
      {
        ...input,
        budgetPolicy: {
          ...input.budgetPolicy,
          maximumOutputTokens: input.budgetPolicy.maximumOutputTokens + 1,
        },
      },
      {
        ...input,
        disclosurePolicy: { ...input.disclosurePolicy, minimizationPolicyDigest: foreign },
      },
      {
        ...input,
        disclosurePolicy: { ...input.disclosurePolicy, keyPolicyDigest: foreign },
      },
      {
        ...input,
        disclosurePolicy: { ...input.disclosurePolicy, authorizationPolicyDigest: foreign },
      },
    ].map((variant) => createSemanticWorkflowBundle.defineGeneration(variant));
    expect(new Set(variants.map((variant) => variant.definitionDigest)).size).toBe(variants.length);
    expect(variants.every((variant) => variant.definitionDigest !== exact.definitionDigest)).toBe(true);
  });

  it("refuses cloned loop/producer capabilities and every mismatched callback fingerprint", async () => {
    const harness = await createGenerationHarness({ transport: "outbound" });
    const clonedLoop = Object.freeze({ ...harness.learning });
    const forgedProducer = Object.freeze({ ...harness.producer });
    const cases = [
      { ...harness.factoryInput, loop: clonedLoop },
      (() => {
        const value = { ...harness.factoryInput };
        Reflect.set(value, "producer", forgedProducer);
        return value;
      })(),
      {
        ...harness.factoryInput,
        renderer: { ...harness.factoryInput.renderer, rendererDigest: "0".repeat(64) },
      },
      {
        ...harness.factoryInput,
        minimizer: { ...harness.factoryInput.minimizer, minimizationPolicyDigest: "0".repeat(64) },
      },
      {
        ...harness.factoryInput,
        keyedDigester: { ...harness.factoryInput.keyedDigester, keyPolicyDigest: "0".repeat(64) },
      },
      {
        ...harness.factoryInput,
        tokenEstimator: { ...harness.factoryInput.tokenEstimator, tokenEstimatorDigest: "0".repeat(64) },
      },
      {
        ...harness.factoryInput,
        provider: { ...harness.factoryInput.provider, registrationDigest: "0".repeat(64) },
      },
      {
        ...harness.factoryInput,
        disclosureAuthority: {
          ...harness.factoryInput.disclosureAuthority,
          authorizationPolicyDigest: "0".repeat(64),
          authorize: harness.factoryInput.disclosureAuthority?.authorize ?? (() => Promise.resolve({})),
        },
      },
    ];
    for (const value of cases) {
      expect(() => createSemanticWorkflowBundle(value)).toThrowError(
        expect.objectContaining({ code: expect.stringMatching(/^config\.|^schema\.|^identity\./) }),
      );
    }
  });

  it("requires outbound authority and forbids one on a local definition", async () => {
    const outbound = await createGenerationHarness({ transport: "outbound" });
    const missingAuthority = { ...outbound.factoryInput };
    Reflect.deleteProperty(missingAuthority, "disclosureAuthority");
    expect(() => createSemanticWorkflowBundle(missingAuthority)).toThrowError(
      expect.objectContaining({ code: "config.invalid" }),
    );

    const local = await createGenerationHarness({ transport: "local" });
    const authority = outbound.factoryInput.disclosureAuthority;
    if (authority === undefined) throw new Error("outbound fixture omitted disclosure authority");
    expect(() =>
      createSemanticWorkflowBundle({
        ...local.factoryInput,
        disclosureAuthority: authority,
      }),
    ).toThrowError(expect.objectContaining({ code: "config.invalid" }));
  });

  it("ignores unknown inert configuration fields without invoking their accessors", async () => {
    const harness = await createGenerationHarness();
    let reads = 0;
    const input = { ...harness.factoryInput };
    Object.defineProperty(input, "unknown", {
      enumerable: true,
      get: () => {
        reads += 1;
        throw new Error("PRIVATE-CONFIG-CANARY");
      },
    });
    expect(() => createSemanticWorkflowBundle(input)).not.toThrow();
    expect(reads).toBe(0);
  });
});
