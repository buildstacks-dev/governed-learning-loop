import { sha256HexOfCanonicalJson } from "../canonical/canonical-json.js";
import { toJsonValue } from "../canonical/to-json-value.js";
import { invalid } from "../parse/toolkit.js";
import { parseDigestAt, parseId, parseSemVer } from "../records/semantic-shared.js";
import { parsePrincipalRefAt } from "../records/principal.js";
import type { SemanticWorkflowDefinition } from "./workflow-definition.js";
import {
  parseSemanticWorkflowDefinition,
  semanticProviderModelDigest,
  semanticProviderRegistrationDigest,
  semanticWorkflowBudgetPolicyDigest,
  semanticWorkflowDefinitionDigest,
  semanticWorkflowDisclosurePolicyDigest,
  semanticWorkflowToolPolicyDigest,
} from "./workflow-definition.js";
import { readSemanticWorkflowFields as readFields } from "./workflow-structure.js";

export const GENERATION_RESULT_SCHEMA_ID = "cormidia.semantic-generation-result";
export const GENERATION_RESULT_SCHEMA_VERSION = "1.0.0";
const SCHEMA_VERSION: 1 = 1;
export const GENERATION_RESULT_SCHEMA_DIGEST = sha256HexOfCanonicalJson(
  toJsonValue({
    schemaVersion: SCHEMA_VERSION,
    id: GENERATION_RESULT_SCHEMA_ID,
    version: GENERATION_RESULT_SCHEMA_VERSION,
    envelope: {
      schemaVersion: SCHEMA_VERSION,
      id: GENERATION_RESULT_SCHEMA_ID,
      version: GENERATION_RESULT_SCHEMA_VERSION,
      status: ["completed", "provider_refused", "provider_failed"],
      providerReceipt: ["id", "digest"],
      usage: "reported_or_null",
      result: "DetectorResultDraft_or_null",
    },
    tools: "none",
    recurrenceLocator: "forbidden",
  }),
);

export const GENERATION_RESULT_SCHEMA = Object.freeze({
  schemaVersion: SCHEMA_VERSION,
  id: GENERATION_RESULT_SCHEMA_ID,
  version: GENERATION_RESULT_SCHEMA_VERSION,
  schemaDigest: GENERATION_RESULT_SCHEMA_DIGEST,
});

export const ADVISORY_REVIEW_RESULT_SCHEMA_ID = "cormidia.semantic-advisory-review-result";
export const ADVISORY_REVIEW_RESULT_SCHEMA_VERSION = "1.0.0";
export const ADVISORY_REVIEW_RESULT_SCHEMA_DIGEST = sha256HexOfCanonicalJson(
  toJsonValue({
    schemaVersion: SCHEMA_VERSION,
    id: ADVISORY_REVIEW_RESULT_SCHEMA_ID,
    version: ADVISORY_REVIEW_RESULT_SCHEMA_VERSION,
    envelope: {
      schemaVersion: SCHEMA_VERSION,
      id: ADVISORY_REVIEW_RESULT_SCHEMA_ID,
      version: ADVISORY_REVIEW_RESULT_SCHEMA_VERSION,
      status: ["completed", "provider_refused", "provider_failed"],
      providerReceipt: ["id", "digest"],
      usage: "reported_or_null",
      result: {
        advisoryRecommendation: ["support", "revise", "oppose", "escalate"],
        findings: ["code", "severity", "statement"],
      },
    },
    tools: "none",
    calibration: "unverified",
  }),
);

export const ADVISORY_REVIEW_RESULT_SCHEMA = Object.freeze({
  schemaVersion: SCHEMA_VERSION,
  id: ADVISORY_REVIEW_RESULT_SCHEMA_ID,
  version: ADVISORY_REVIEW_RESULT_SCHEMA_VERSION,
  schemaDigest: ADVISORY_REVIEW_RESULT_SCHEMA_DIGEST,
});

export interface DefineGenerationInput {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly version: string;
  readonly transport: "local" | "outbound";
  readonly implementation: { readonly id: string; readonly version: string; readonly implementationDigest: string };
  readonly providerModel: {
    readonly provider: {
      readonly id: string;
      readonly version: string;
      readonly providerFingerprintDigest: string;
      readonly operationKeyPolicyDigest: string;
    };
    readonly model: { readonly id: string; readonly modelFingerprintDigest: string };
  };
  readonly prompt: { readonly id: string; readonly version: string; readonly promptDigest: string };
  readonly renderer: { readonly id: string; readonly version: string; readonly rendererDigest: string };
  readonly budgetPolicy: Omit<SemanticWorkflowDefinition["budgetPolicy"], "policyDigest" | "maximumAttempts">;
  readonly disclosurePolicy: Omit<SemanticWorkflowDefinition["disclosurePolicy"], "policyDigest">;
  readonly principal: SemanticWorkflowDefinition["principal"];
  readonly attestation: SemanticWorkflowDefinition["attestation"];
}

export type DefineAdvisoryReviewInput = DefineGenerationInput;

function parseNonnegativeInteger(input: unknown, path: readonly (string | number)[]): number {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input < 0) {
    throw invalid("schema.invalid", "value must be a nonnegative safe integer", path);
  }
  return input;
}

function defineWorkflow(
  input: DefineGenerationInput,
  options: {
    readonly lane: SemanticWorkflowDefinition["lane"];
    readonly outputSchema: {
      readonly id: string;
      readonly version: string;
      readonly schemaDigest: string;
    };
    readonly calibration: SemanticWorkflowDefinition["calibration"];
  },
): SemanticWorkflowDefinition {
  const fields = readFields(input, ["defineGeneration"]);
  fields.schemaVersion1();
  const implementationFields = readFields(
    fields.req("implementation", (value) => value),
    ["implementation"],
  );
  const providerModelFields = readFields(
    fields.req("providerModel", (value) => value),
    ["providerModel"],
  );
  const providerFields = readFields(
    providerModelFields.req("provider", (value) => value),
    ["providerModel", "provider"],
  );
  const modelFields = readFields(
    providerModelFields.req("model", (value) => value),
    ["providerModel", "model"],
  );
  const promptFields = readFields(
    fields.req("prompt", (value) => value),
    ["prompt"],
  );
  const rendererFields = readFields(
    fields.req("renderer", (value) => value),
    ["renderer"],
  );
  const budgetFields = readFields(
    fields.req("budgetPolicy", (value) => value),
    ["budgetPolicy"],
  );
  const disclosureFields = readFields(
    fields.req("disclosurePolicy", (value) => value),
    ["disclosurePolicy"],
  );
  const transport = fields.req("transport", (value, path): "local" | "outbound" => {
    if (value !== "local" && value !== "outbound")
      throw invalid("schema.invalid", "workflow transport is invalid", path);
    return value;
  });
  const requiredMode: "required" = "required";
  const providerBase = {
    id: providerFields.req("id", parseId),
    version: providerFields.req("version", parseSemVer),
    providerFingerprintDigest: providerFields.req("providerFingerprintDigest", parseDigestAt),
    idempotency: {
      mode: requiredMode,
      operationKeyPolicyDigest: providerFields.req("operationKeyPolicyDigest", parseDigestAt),
    },
  };
  const provider = { ...providerBase, registrationDigest: semanticProviderRegistrationDigest(providerBase) };
  const model = {
    id: modelFields.req("id", parseId),
    modelFingerprintDigest: modelFields.req("modelFingerprintDigest", parseDigestAt),
  };
  const providerModelBase = { provider, model };
  const providerModel = { ...providerModelBase, providerModelDigest: semanticProviderModelDigest(providerModelBase) };
  const maximumCost = budgetFields.req("maximumCost", (value, path) => {
    if (value === null) return null;
    const nested = readFields(value, path);
    const currency = nested.req("currency", (currencyValue, currencyPath) => {
      if (typeof currencyValue !== "string" || !/^[A-Z]{3}$/.test(currencyValue)) {
        throw invalid("schema.invalid", "maximum cost currency is invalid", currencyPath);
      }
      return currencyValue;
    });
    return { minorUnits: nested.req("minorUnits", parseNonnegativeInteger), currency };
  });
  const maximumAttempts: 1 = 1;
  const budgetBase = {
    maximumRequestBytes: budgetFields.req("maximumRequestBytes", parseNonnegativeInteger),
    maximumResponseBytes: budgetFields.req("maximumResponseBytes", parseNonnegativeInteger),
    maximumEpisodes: budgetFields.req("maximumEpisodes", parseNonnegativeInteger),
    maximumEvidenceRefs: budgetFields.req("maximumEvidenceRefs", parseNonnegativeInteger),
    maximumInputTokens: budgetFields.req("maximumInputTokens", parseNonnegativeInteger),
    maximumOutputTokens: budgetFields.req("maximumOutputTokens", parseNonnegativeInteger),
    maximumDurationMs: budgetFields.req("maximumDurationMs", parseNonnegativeInteger),
    maximumAttempts,
    tokenEstimatorDigest: budgetFields.req("tokenEstimatorDigest", parseDigestAt),
    maximumCost,
  };
  const budgetPolicy = { ...budgetBase, policyDigest: semanticWorkflowBudgetPolicyDigest(budgetBase) };
  const disclosureMode = disclosureFields.req("mode", (value, path): "forbidden" | "explicit_authorization" => {
    if (value !== "forbidden" && value !== "explicit_authorization") {
      throw invalid("schema.invalid", "workflow disclosure mode is invalid", path);
    }
    return value;
  });
  const disclosureBase = {
    mode: disclosureMode,
    minimizationPolicyDigest: disclosureFields.req("minimizationPolicyDigest", parseDigestAt),
    keyPolicyDigest: disclosureFields.req("keyPolicyDigest", parseDigestAt),
    authorizationPolicyDigest: disclosureFields.req("authorizationPolicyDigest", parseDigestAt),
    maximumAuthorizationAgeMs: disclosureFields.req("maximumAuthorizationAgeMs", parseNonnegativeInteger),
  };
  const disclosurePolicy = { ...disclosureBase, policyDigest: semanticWorkflowDisclosurePolicyDigest(disclosureBase) };
  const toolMode: "none" = "none";
  const toolBase = { mode: toolMode };
  const toolPolicy = { ...toolBase, policyDigest: semanticWorkflowToolPolicyDigest(toolBase) };
  const attestationFields = readFields(
    fields.req("attestation", (value) => value),
    ["attestation"],
  );
  const definitionBase = {
    id: fields.req("id", parseId),
    version: fields.req("version", parseSemVer),
    lane: options.lane,
    transport,
    implementation: {
      id: implementationFields.req("id", parseId),
      version: implementationFields.req("version", parseSemVer),
      implementationDigest: implementationFields.req("implementationDigest", parseDigestAt),
    },
    providerModel,
    prompt: {
      id: promptFields.req("id", parseId),
      version: promptFields.req("version", parseSemVer),
      promptDigest: promptFields.req("promptDigest", parseDigestAt),
    },
    renderer: {
      id: rendererFields.req("id", parseId),
      version: rendererFields.req("version", parseSemVer),
      rendererDigest: rendererFields.req("rendererDigest", parseDigestAt),
    },
    outputSchema: options.outputSchema,
    toolPolicy,
    budgetPolicy,
    disclosurePolicy,
    principal: fields.req("principal", parsePrincipalRefAt),
    attestation: {
      id: attestationFields.req("id", parseId),
      digest: attestationFields.req("digest", parseDigestAt),
    },
    calibration: options.calibration,
  };
  return parseSemanticWorkflowDefinition({
    schemaVersion: 1,
    ...definitionBase,
    definitionDigest: semanticWorkflowDefinitionDigest(definitionBase),
  });
}

export function defineGeneration(input: DefineGenerationInput): SemanticWorkflowDefinition {
  return defineWorkflow(input, {
    lane: "generation",
    outputSchema: GENERATION_RESULT_SCHEMA,
    calibration: null,
  });
}

export function defineAdvisoryReview(input: DefineAdvisoryReviewInput): SemanticWorkflowDefinition {
  return defineWorkflow(input, {
    lane: "advisory_review",
    outputSchema: ADVISORY_REVIEW_RESULT_SCHEMA,
    calibration: { status: "unverified", calibrationId: null, calibrationDigest: null },
  });
}
