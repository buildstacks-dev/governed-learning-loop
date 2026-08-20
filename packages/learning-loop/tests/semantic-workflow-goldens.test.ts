// Immutable #13a protocol vectors. Any intentional change to these bytes must
// be accompanied by an explicit workflow record/domain version decision.
import { describe, expect, it } from "vitest";
import { sha256HexOfCanonicalJson, toJsonValue } from "../src/index.js";
import type { SemanticTurnReservation } from "../src/workflows/semantic-turn-intent.js";
import {
  buildSemanticDisclosureAuthorization,
  buildSemanticTurnReservation,
} from "../src/workflows/semantic-turn-intent.js";
import {
  buildSemanticDispatchMarker,
  buildSemanticResultBinding,
  buildSemanticTurnReceipt,
  buildSemanticTurnScopeIndex,
  semanticNormalizedResultDigest,
} from "../src/workflows/semantic-turn-outcome.js";
import type { SemanticTurnReceipt } from "../src/workflows/semantic-turn-outcome.js";
import { semanticProviderOperationKeyDigest } from "../src/workflows/semantic-turn-persistence.js";
import type { SemanticWorkflowDefinition } from "../src/workflows/workflow-definition.js";
import {
  parseSemanticWorkflowDefinition,
  semanticProviderModelDigest,
  semanticProviderRegistrationDigest,
  semanticWorkflowBudgetPolicyDigest,
  semanticWorkflowDefinitionDigest,
  semanticWorkflowDisclosurePolicyDigest,
  semanticWorkflowToolPolicyDigest,
} from "../src/workflows/workflow-definition.js";

type Lane = SemanticWorkflowDefinition["lane"];
type Transport = SemanticWorkflowDefinition["transport"];
type Provider = SemanticWorkflowDefinition["providerModel"]["provider"];
type Budget = SemanticWorkflowDefinition["budgetPolicy"];
type Disclosure = SemanticWorkflowDefinition["disclosurePolicy"];

function digest(label: string): string {
  return sha256HexOfCanonicalJson(toJsonValue({ label }));
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

function definition(lane: Lane, transport: Transport): SemanticWorkflowDefinition {
  const providerBase: Omit<Provider, "registrationDigest"> = {
    id: "golden-provider",
    version: "1.2.3",
    providerFingerprintDigest: digest("golden-provider-fingerprint"),
    idempotency: { mode: "required", operationKeyPolicyDigest: digest("golden-operation-key-policy") },
  };
  const provider = {
    ...providerBase,
    registrationDigest: semanticProviderRegistrationDigest(providerBase),
  };
  const providerModelBase = {
    provider,
    model: { id: "golden-model", modelFingerprintDigest: digest("golden-model-fingerprint") },
  };
  const providerModel = {
    ...providerModelBase,
    providerModelDigest: semanticProviderModelDigest(providerModelBase),
  };
  const toolBase = { mode: "none" as const };
  const toolPolicy = { ...toolBase, policyDigest: semanticWorkflowToolPolicyDigest(toolBase) };
  const budgetBase: Omit<Budget, "policyDigest"> = {
    maximumRequestBytes: 1_048_576,
    maximumResponseBytes: 524_288,
    maximumEpisodes: 250,
    maximumEvidenceRefs: 2_500,
    maximumInputTokens: 12_000,
    maximumOutputTokens: 2_000,
    maximumDurationMs: 45_000,
    maximumAttempts: 1,
    tokenEstimatorDigest: digest("golden-token-estimator"),
    maximumCost: { minorUnits: 125, currency: "USD" },
  };
  const budgetPolicy = { ...budgetBase, policyDigest: semanticWorkflowBudgetPolicyDigest(budgetBase) };
  const disclosureBase: Omit<Disclosure, "policyDigest"> = {
    mode: transport === "outbound" ? "explicit_authorization" : "forbidden",
    minimizationPolicyDigest: digest("golden-minimization-policy"),
    keyPolicyDigest: digest("golden-disclosure-key-policy"),
    authorizationPolicyDigest: digest("golden-authorization-policy"),
    maximumAuthorizationAgeMs: 90_000,
  };
  const disclosurePolicy = {
    ...disclosureBase,
    policyDigest: semanticWorkflowDisclosurePolicyDigest(disclosureBase),
  };
  const base: Omit<SemanticWorkflowDefinition, "schemaVersion" | "definitionDigest"> = {
    id: `golden-${lane}-${transport}`,
    version: "1.0.0",
    lane,
    transport,
    implementation: {
      id: "golden-workflow",
      version: "1.0.0",
      implementationDigest: digest("golden-implementation"),
    },
    providerModel,
    prompt: { id: "golden-prompt", version: "2.0.0", promptDigest: digest("golden-prompt") },
    renderer: { id: "golden-renderer", version: "3.0.0", rendererDigest: digest("golden-renderer") },
    outputSchema: { id: "golden-output", version: "4.0.0", schemaDigest: digest("golden-output-schema") },
    toolPolicy,
    budgetPolicy,
    disclosurePolicy,
    principal: { id: "golden-producer", kind: "service", independenceDomain: "golden-provider-domain" },
    attestation: { id: "golden-producer-attestation", digest: digest("golden-producer-attestation") },
    calibration: lane === "generation" ? null : { status: "unverified", calibrationId: null, calibrationDigest: null },
  };
  return parseSemanticWorkflowDefinition({
    schemaVersion: 1,
    ...base,
    definitionDigest: semanticWorkflowDefinitionDigest(base),
  });
}

function reservation(lane: Lane, transport: Transport): SemanticTurnReservation {
  const workflow = definition(lane, transport);
  const common = {
    runId: `golden-${lane}-${transport}-run`,
    loopRegistryRevision: digest("golden-loop-registry"),
    semanticRegistryDigest: digest("golden-semantic-registry"),
    scopeDigest: digest("golden-scope"),
    definition: workflow,
    request: {
      mediaType: "application/json" as const,
      encoding: "utf-8" as const,
      byteLength: 4_096,
      minimizedBytesDigest: digest(`golden-request-${lane}-${transport}`),
      keyPolicyDigest: workflow.disclosurePolicy.keyPolicyDigest,
    },
    sourcePolicies: [
      {
        sourceId: "golden-source",
        contentPolicyId: "golden-content-policy",
        contentPolicyDigest: digest("golden-content-policy"),
        outboundUse: transport === "outbound" ? ("explicit_receipt_required" as const) : ("forbidden" as const),
      },
    ],
    disclosureExpected: transport === "outbound",
    expiresAt: "2026-08-20T00:05:00.000Z",
  };
  if (lane === "advisory_review") {
    const derivationDigest = digest("golden-review-derivation");
    return buildSemanticTurnReservation({
      ...common,
      target: {
        kind: "advisory_review",
        candidateId: "golden-candidate",
        candidateDigest: digest("golden-candidate"),
        derivation: {
          id: `insight-${derivationDigest}`,
          derivationDigest,
          scopeDigest: common.scopeDigest,
        },
        evidenceSetDigest: digest("golden-review-evidence-set"),
      },
    });
  }
  return buildSemanticTurnReservation({
    ...common,
    target: {
      kind: "generation",
      detector: { id: "golden-detector", version: "1.0.0", registrationDigest: digest("golden-detector") },
      pack: { id: "golden-pack", version: "1.0.0", manifestDigest: digest("golden-pack") },
      lens: { id: "golden-lens", version: "1.0.0", registrationDigest: digest("golden-lens") },
      windowDigest: digest("golden-window"),
      executionKeyDigest: digest("golden-execution-key"),
      episodeRecordIds: ["golden-source/episode-001", "golden-source/episode-002"],
      disclosedEvidenceReferenceDigests: [digest("golden-evidence-a"), digest("golden-evidence-b")].sort(),
    },
  });
}

function terminalGraph(lane: Lane, transport: Transport) {
  const reserved = reservation(lane, transport);
  const authorization =
    transport === "outbound"
      ? buildSemanticDisclosureAuthorization(reserved, {
          authorizer: { id: "golden-authorizer", kind: "human", independenceDomain: "golden-human-domain" },
          authorizerAttestation: {
            id: "golden-authorization-attestation",
            digest: digest("golden-authorization-attestation"),
          },
          authorizedAt: "2026-08-20T00:00:10.000Z",
          expiresAt: "2026-08-20T00:01:00.000Z",
        })
      : null;
  const dispatch = buildSemanticDispatchMarker({
    turnKeyDigest: reserved.turnKeyDigest,
    reservationDigest: reserved.reservationDigest,
    authorizationDigest: authorization?.authorizationDigest ?? null,
    providerOperationId: `golden-operation-${lane}-${transport}`,
    idempotencyKey: `golden-operation-key-${lane}-${transport}`,
    startedAt: "2026-08-20T00:00:20.000Z",
  });
  const normalizedResult = toJsonValue({ conditionDetected: true, semantic: "golden" });
  const result = buildSemanticResultBinding({
    turnKeyDigest: reserved.turnKeyDigest,
    reservationDigest: reserved.reservationDigest,
    dispatchDigest: dispatch.dispatchDigest,
    status: "completed",
    response: {
      providerReceiptId: `golden-provider-receipt-${lane}-${transport}`,
      providerReceiptDigest: digest(`golden-provider-receipt-${lane}-${transport}`),
      requestAttestationDigest: digest(`golden-request-attestation-${lane}-${transport}`),
      responseByteLength: 1_024,
      responseKeyedDigest: digest(`golden-response-${lane}-${transport}`),
      keyPolicyDigest: reserved.definition.disclosurePolicy.keyPolicyDigest,
    },
    usage: {
      status: "reported",
      inputTokens: 800,
      outputTokens: 120,
      durationMs: 2_500,
      costMinorUnits: 4,
      currency: "USD",
    },
    normalizedResult,
    normalizedResultDigest: semanticNormalizedResultDigest(normalizedResult),
    reasonCodes: [],
  });
  const output: SemanticTurnReceipt["output"] =
    lane === "advisory_review"
      ? {
          kind: "advisory_review",
          assessmentId: `semantic-review-assessment-${digest("golden-assessment")}`,
          assessmentDigest: digest("golden-assessment"),
        }
      : (() => {
          const executionKeyDigest = digest("golden-workflow-execution-key");
          const derivationDigest = digest("golden-output-derivation");
          return {
            kind: "generation" as const,
            workflowExecutionId: `semantic-workflow-execution-${executionKeyDigest}`,
            workflowExecutionKeyDigest: executionKeyDigest,
            workflowExecutionDigest: digest("golden-workflow-execution"),
            derivationRefs: [
              {
                id: `insight-${derivationDigest}`,
                derivationDigest,
                scopeDigest: reserved.scopeDigest,
              },
            ],
          };
        })();
  const turn = buildSemanticTurnReceipt({
    turnKeyDigest: reserved.turnKeyDigest,
    reservation: { id: reserved.id, reservationDigest: reserved.reservationDigest },
    authorization:
      authorization === null ? null : { id: authorization.id, authorizationDigest: authorization.authorizationDigest },
    dispatch: { id: dispatch.id, dispatchDigest: dispatch.dispatchDigest },
    result: { id: result.id, bindingDigest: result.bindingDigest },
    lane,
    scopeDigest: reserved.scopeDigest,
    status: "completed",
    output,
  });
  const index = buildSemanticTurnScopeIndex({
    scopeDigest: turn.scopeDigest,
    turnId: turn.id,
    turnKeyDigest: turn.turnKeyDigest,
    turnDigest: turn.turnDigest,
  });
  return { reserved, authorization, dispatch, normalizedResult, result, turn, index };
}

function vectors() {
  const local = terminalGraph("generation", "local");
  const outbound = terminalGraph("generation", "outbound");
  const review = terminalGraph("advisory_review", "outbound");
  return {
    definitions: {
      providerRegistration: local.reserved.definition.providerModel.provider.registrationDigest,
      providerModel: local.reserved.definition.providerModel.providerModelDigest,
      toolPolicy: local.reserved.definition.toolPolicy.policyDigest,
      budgetPolicy: local.reserved.definition.budgetPolicy.policyDigest,
      localDisclosurePolicy: local.reserved.definition.disclosurePolicy.policyDigest,
      outboundDisclosurePolicy: outbound.reserved.definition.disclosurePolicy.policyDigest,
      localGeneration: local.reserved.definition.definitionDigest,
      outboundGeneration: outbound.reserved.definition.definitionDigest,
      outboundAdvisoryReview: review.reserved.definition.definitionDigest,
    },
    reservations: {
      localGenerationKey: local.reserved.turnKeyDigest,
      localGenerationFull: local.reserved.reservationDigest,
      outboundGenerationKey: outbound.reserved.turnKeyDigest,
      outboundGenerationFull: outbound.reserved.reservationDigest,
      advisoryReviewKey: review.reserved.turnKeyDigest,
      advisoryReviewFull: review.reserved.reservationDigest,
    },
    authorizations: {
      outboundGeneration: outbound.authorization?.authorizationDigest,
      advisoryReview: review.authorization?.authorizationDigest,
    },
    dispatches: {
      providerOperation: semanticProviderOperationKeyDigest(outbound.reserved),
      localGeneration: local.dispatch.dispatchDigest,
      outboundGeneration: outbound.dispatch.dispatchDigest,
      advisoryReview: review.dispatch.dispatchDigest,
    },
    results: {
      normalized: semanticNormalizedResultDigest(local.normalizedResult),
      localGeneration: local.result.bindingDigest,
      outboundGeneration: outbound.result.bindingDigest,
      advisoryReview: review.result.bindingDigest,
    },
    turns: {
      localGeneration: local.turn.turnDigest,
      outboundGeneration: outbound.turn.turnDigest,
      advisoryReview: review.turn.turnDigest,
    },
    indexes: {
      localGeneration: local.index.indexDigest,
      outboundGeneration: outbound.index.indexDigest,
      advisoryReview: review.index.indexDigest,
    },
  };
}

const V1_GOLDENS = deepFreeze({
  definitions: {
    providerRegistration: "429e6a4332d2760a6a3e44c6464346d24971a6386c3e265ae539cadf570eeabb",
    providerModel: "9e8815df7b77a497103416ca26730825590dcd8ec57f0db5c9e839661ea4b063",
    toolPolicy: "a4479b60a3b58b97808bb3ad9d0e0d40c7d0167876f908b818de807571953fbe",
    budgetPolicy: "8c55465e4d0f066ef61fa466c3f87ca14ab2ea2d82ce1763e89e5698dd7eafa4",
    localDisclosurePolicy: "a0e030be25aa4ab41805bab446064f825662554051b03854484721aa831379a7",
    outboundDisclosurePolicy: "cc7e3b8b7f1bad28cdbefa8a51758c86802e6863eac410838bb39284141953df",
    localGeneration: "cc4d332741161b019ac005431245cd23630bc18b91a9ebc9af997f2e34855297",
    outboundGeneration: "3954cbc6ea9093256b3c5005e02dcb5bfe2803575d1d1fc51a898f77c57513e5",
    outboundAdvisoryReview: "56f244c80ea905c5809633a770c119e6d55c50b1094caf4ba38edbd20a79e394",
  },
  reservations: {
    localGenerationKey: "2a862f25e18e91089a68ab728d8e3829398b636c3388822778a5a38203112dcd",
    localGenerationFull: "ca6ab1858d1ccad596bf33d89f4ad5e87e784961e138959111750683297f15a7",
    outboundGenerationKey: "2693eaca7ebb23512afac04736681ec99e3a35021730322b199f7008a1680398",
    outboundGenerationFull: "f53f2f872cf57ad2ab12fa48f65b773a2734f5465ecb7218ed420f4a611dad74",
    advisoryReviewKey: "5585c8bf9b4f6740302482307ac99f22b580b81373287132b2c7586d01415181",
    advisoryReviewFull: "2a920a303932a6e530e50456fd823f553e36cd7de3ea4fdf38d279086f4b2cc8",
  },
  authorizations: {
    outboundGeneration: "d43df99867c6b7c03525ae4e649fb0ecba065643dbbea0de1b78ef7769f6e184",
    advisoryReview: "8f3dcf9bc43969666a1498c7b353a892d8b47dba059245fbd616e6453f3bf013",
  },
  dispatches: {
    providerOperation: "87d08cb714f11b91d83ac95cddc207cefc9c71b00fd2d33a04469e6cc2438e74",
    localGeneration: "565832fcaae2992769a6490cbb0285f0917929ea8d28786064b063e4440859da",
    outboundGeneration: "f9b0a3826b805f6f78bdf333651491391db7aee716878c23908e1c5111404afc",
    advisoryReview: "ee66de415cc8b558e0d8476ce832706da36786b4b6704a06d987cf0379b72872",
  },
  results: {
    normalized: "e890b68faac35acaccc7225b010b817a1761a8839c12423e963c99dc6fa2424c",
    localGeneration: "731e73f09e3089ad8dc7b9d4e609fe40ff95bc0e716b367ae18ddb61010eebda",
    outboundGeneration: "66dd32110daf5594e330c247f03edf662ff3a0296b2cc41801806737c4bad020",
    advisoryReview: "611a6efbb510d53ec1537d9d135c07e2874cae0016c89cfd5f47d69ded6e6bce",
  },
  turns: {
    localGeneration: "a249f0ab90ce8dd938141f532dc87034f6bab382e1321486203d8182a8745f4e",
    outboundGeneration: "6e14a4fe6ba9d709a4f4f08815893fbeec543421fcab4af9502fdca6f29e8278",
    advisoryReview: "c9ecc3df7a1110837a67c17e4df6316c9665ae5a713eedcb0845f8f619b17f52",
  },
  indexes: {
    localGeneration: "14f2aba098d889e8dc92816b13e43d585ae6dc726eb6e8c166184f3278c99867",
    outboundGeneration: "80ff533d39c597189c4bff6fc1b35f13d3c246f68d26fc969352cbdfc6edc519",
    advisoryReview: "a6a1f23abacc941a22aeaaead4c7a92962a094e5e0fa0d4c1a9d48c7622dfd7d",
  },
});

describe("semantic workflow v1 immutable digest vectors", () => {
  it("pins every definition, intent, outcome, terminal receipt, and scope-index domain", () => {
    expect(vectors()).toEqual(V1_GOLDENS);
    expectDeepFrozen(V1_GOLDENS);
  });
});

function expectDeepFrozen(input: unknown): void {
  if (typeof input !== "object" || input === null) return;
  expect(Object.isFrozen(input)).toBe(true);
  for (const value of Object.values(input)) expectDeepFrozen(value);
}
