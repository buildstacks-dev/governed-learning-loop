// Private immutable registration for one provider-neutral semantic workflow.
// This module defines configuration facts only. It has no provider callback,
// store writer, Candidate/Review authority, publication capability, or effect.
import { sha256HexOfCanonicalJson } from "../canonical/canonical-json.js";
import type { JsonValue } from "../canonical/json.js";
import { toJsonValue } from "../canonical/to-json-value.js";
import { invalid, parseNonEmptyText, parseOneOf } from "../parse/toolkit.js";
import type { Parse } from "../parse/toolkit.js";
import type { PrincipalRef } from "../records/principal.js";
import { parsePrincipalRefAt } from "../records/principal.js";
import { digestOf, parseDigestAt, parseId, parseNullable, parseSemVer } from "../records/semantic-shared.js";
import { readSemanticWorkflowFields as readFields } from "./workflow-structure.js";

export const SEMANTIC_WORKFLOW_MAX_CANONICAL_BYTES = 16 * 1_048_576;
export const SEMANTIC_WORKFLOW_MAX_EPISODES = 500;
export const SEMANTIC_WORKFLOW_MAX_EVIDENCE_REFS = 5_000;
export const SEMANTIC_WORKFLOW_MAX_DURATION_MS = 86_400_000;

const WORKFLOW_LANES = ["generation", "advisory_review"] as const;
const WORKFLOW_TRANSPORTS = ["local", "outbound"] as const;
const DISCLOSURE_MODES = ["forbidden", "explicit_authorization"] as const;
const PROVIDER_REGISTRATION_DOMAIN = "semantic-provider-registration:v1";
const PROVIDER_MODEL_DOMAIN = "semantic-provider-model:v1";
const TOOL_POLICY_DOMAIN = "semantic-workflow-tool-policy:v1";
const BUDGET_POLICY_DOMAIN = "semantic-workflow-budget-policy:v1";
const DISCLOSURE_POLICY_DOMAIN = "semantic-workflow-disclosure-policy:v1";
const DEFINITION_DOMAIN = "semantic-workflow-definition:v1";

type SemanticWorkflowLane = (typeof WORKFLOW_LANES)[number];
type SemanticWorkflowTransport = (typeof WORKFLOW_TRANSPORTS)[number];

export interface SemanticWorkflowDefinition {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly version: string;
  readonly lane: SemanticWorkflowLane;
  readonly transport: SemanticWorkflowTransport;
  readonly implementation: {
    readonly id: string;
    readonly version: string;
    readonly implementationDigest: string;
  };
  readonly providerModel: {
    readonly provider: {
      readonly id: string;
      readonly version: string;
      readonly providerFingerprintDigest: string;
      readonly idempotency: {
        readonly mode: "required";
        /** Binds the host policy deriving one operation key from the exact reservation key. */
        readonly operationKeyPolicyDigest: string;
      };
      readonly registrationDigest: string;
    };
    readonly model: {
      readonly id: string;
      readonly modelFingerprintDigest: string;
    };
    readonly providerModelDigest: string;
  };
  readonly prompt: {
    readonly id: string;
    readonly version: string;
    readonly promptDigest: string;
  };
  readonly renderer: {
    readonly id: string;
    readonly version: string;
    readonly rendererDigest: string;
  };
  readonly outputSchema: {
    readonly id: string;
    readonly version: string;
    readonly schemaDigest: string;
  };
  readonly toolPolicy: {
    readonly mode: "none";
    readonly policyDigest: string;
  };
  readonly budgetPolicy: {
    readonly maximumRequestBytes: number;
    readonly maximumResponseBytes: number;
    readonly maximumEpisodes: number;
    readonly maximumEvidenceRefs: number;
    readonly maximumInputTokens: number;
    readonly maximumOutputTokens: number;
    readonly maximumDurationMs: number;
    readonly maximumAttempts: 1;
    readonly tokenEstimatorDigest: string;
    readonly maximumCost: {
      readonly minorUnits: number;
      readonly currency: string;
    } | null;
    readonly policyDigest: string;
  };
  readonly disclosurePolicy: {
    readonly mode: (typeof DISCLOSURE_MODES)[number];
    readonly minimizationPolicyDigest: string;
    readonly keyPolicyDigest: string;
    readonly authorizationPolicyDigest: string;
    readonly maximumAuthorizationAgeMs: number;
    readonly policyDigest: string;
  };
  readonly principal: PrincipalRef;
  readonly attestation: {
    readonly id: string;
    readonly digest: string;
  };
  readonly calibration: null | {
    readonly status: "unverified";
    readonly calibrationId: null;
    readonly calibrationDigest: null;
  };
  readonly definitionDigest: string;
}

type SemanticProvider = SemanticWorkflowDefinition["providerModel"]["provider"];
type SemanticProviderModel = SemanticWorkflowDefinition["providerModel"];
type SemanticToolPolicy = SemanticWorkflowDefinition["toolPolicy"];
type SemanticBudgetPolicy = SemanticWorkflowDefinition["budgetPolicy"];
type SemanticDisclosurePolicy = SemanticWorkflowDefinition["disclosurePolicy"];

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

function parseBoundedNonnegativeInteger(maximum: number, label: string): Parse<number> {
  return (input, path) => {
    if (typeof input !== "number" || !Number.isSafeInteger(input) || input < 0 || input > maximum) {
      throw invalid("schema.invalid", `${label} must be an integer from 0 through ${maximum}`, path);
    }
    return input;
  };
}

const parseNull: Parse<null> = (input, path) => {
  if (input !== null) throw invalid("schema.invalid", "expected null", path);
  return null;
};

const parseOne: Parse<1> = (input, path) => {
  if (input !== 1) throw invalid("schema.invalid", "maximum attempts must be exactly one", path);
  return 1;
};

function parsePositiveSafeInteger(maximum: number, label: string): Parse<number> {
  return (input, path) => {
    if (typeof input !== "number" || !Number.isSafeInteger(input) || input < 1 || input > maximum) {
      throw invalid("schema.invalid", `${label} must be an integer from 1 through ${maximum}`, path);
    }
    return input;
  };
}

const parseCurrency: Parse<string> = (input, path) => {
  const value = parseNonEmptyText(input, path);
  if (!/^[A-Z]{3}$/.test(value)) {
    throw invalid("schema.invalid", "currency must be a three-letter upper-case code", path);
  }
  return value;
};

const parseCostAt: Parse<NonNullable<SemanticBudgetPolicy["maximumCost"]>> = (input, path) => {
  const fields = readFields(input, path);
  return {
    minorUnits: fields.req("minorUnits", parseBoundedNonnegativeInteger(Number.MAX_SAFE_INTEGER, "cost minor units")),
    currency: fields.req("currency", parseCurrency),
  };
};

function semanticProviderRegistrationContent(input: Omit<SemanticProvider, "registrationDigest">): JsonValue {
  return toJsonValue({
    domain: PROVIDER_REGISTRATION_DOMAIN,
    id: input.id,
    version: input.version,
    providerFingerprintDigest: input.providerFingerprintDigest,
    idempotency: input.idempotency,
  });
}

export function semanticProviderRegistrationDigest(input: Omit<SemanticProvider, "registrationDigest">): string {
  return sha256HexOfCanonicalJson(semanticProviderRegistrationContent(input));
}

function semanticProviderModelContent(input: Omit<SemanticProviderModel, "providerModelDigest">): JsonValue {
  return toJsonValue({ domain: PROVIDER_MODEL_DOMAIN, provider: input.provider, model: input.model });
}

export function semanticProviderModelDigest(input: Omit<SemanticProviderModel, "providerModelDigest">): string {
  return sha256HexOfCanonicalJson(semanticProviderModelContent(input));
}

export function semanticWorkflowToolPolicyDigest(input: Omit<SemanticToolPolicy, "policyDigest">): string {
  return digestOf({ domain: TOOL_POLICY_DOMAIN, ...input });
}

export function semanticWorkflowBudgetPolicyDigest(input: Omit<SemanticBudgetPolicy, "policyDigest">): string {
  return digestOf({ domain: BUDGET_POLICY_DOMAIN, ...input });
}

export function semanticWorkflowDisclosurePolicyDigest(input: Omit<SemanticDisclosurePolicy, "policyDigest">): string {
  return digestOf({ domain: DISCLOSURE_POLICY_DOMAIN, ...input });
}

function semanticWorkflowDefinitionContent(
  input: Omit<SemanticWorkflowDefinition, "schemaVersion" | "definitionDigest">,
): JsonValue {
  return toJsonValue({
    domain: DEFINITION_DOMAIN,
    id: input.id,
    version: input.version,
    lane: input.lane,
    transport: input.transport,
    implementation: input.implementation,
    providerModel: input.providerModel,
    prompt: input.prompt,
    renderer: input.renderer,
    outputSchema: input.outputSchema,
    toolPolicy: input.toolPolicy,
    budgetPolicy: input.budgetPolicy,
    disclosurePolicy: input.disclosurePolicy,
    principal: input.principal,
    attestation: input.attestation,
    calibration: input.calibration,
  });
}

export function semanticWorkflowDefinitionDigest(
  input: Omit<SemanticWorkflowDefinition, "schemaVersion" | "definitionDigest">,
): string {
  return sha256HexOfCanonicalJson(semanticWorkflowDefinitionContent(input));
}

function parseImplementationAt(
  input: unknown,
  path: readonly (string | number)[],
): SemanticWorkflowDefinition["implementation"] {
  const fields = readFields(input, path);
  return {
    id: fields.req("id", parseId),
    version: fields.req("version", parseSemVer),
    implementationDigest: fields.req("implementationDigest", parseDigestAt),
  };
}

function parseProviderAt(input: unknown, path: readonly (string | number)[]): SemanticProvider {
  const fields = readFields(input, path);
  const idempotencyFields = readFields(
    fields.req("idempotency", (value) => value),
    [...path, "idempotency"],
  );
  const base: Omit<SemanticProvider, "registrationDigest"> = {
    id: fields.req("id", parseId),
    version: fields.req("version", parseSemVer),
    providerFingerprintDigest: fields.req("providerFingerprintDigest", parseDigestAt),
    idempotency: {
      mode: idempotencyFields.req("mode", parseOneOf(["required"])),
      operationKeyPolicyDigest: idempotencyFields.req("operationKeyPolicyDigest", parseDigestAt),
    },
  };
  const registrationDigest = fields.req("registrationDigest", parseDigestAt);
  if (registrationDigest !== semanticProviderRegistrationDigest(base)) {
    throw invalid("schema.corrupt", "provider registration digest does not match its bound fields", [
      ...path,
      "registrationDigest",
    ]);
  }
  return { ...base, registrationDigest };
}

function parseProviderModelAt(input: unknown, path: readonly (string | number)[]): SemanticProviderModel {
  const fields = readFields(input, path);
  const modelFields = readFields(
    fields.req("model", (value) => value),
    [...path, "model"],
  );
  const base = {
    provider: fields.req("provider", parseProviderAt),
    model: {
      id: modelFields.req("id", parseId),
      modelFingerprintDigest: modelFields.req("modelFingerprintDigest", parseDigestAt),
    },
  };
  const providerModelDigest = fields.req("providerModelDigest", parseDigestAt);
  if (providerModelDigest !== semanticProviderModelDigest(base)) {
    throw invalid("schema.corrupt", "provider/model digest does not match its bound fields", [
      ...path,
      "providerModelDigest",
    ]);
  }
  return { ...base, providerModelDigest };
}

function parsePromptAt(input: unknown, path: readonly (string | number)[]): SemanticWorkflowDefinition["prompt"] {
  const fields = readFields(input, path);
  return {
    id: fields.req("id", parseId),
    version: fields.req("version", parseSemVer),
    promptDigest: fields.req("promptDigest", parseDigestAt),
  };
}

function parseRendererAt(input: unknown, path: readonly (string | number)[]): SemanticWorkflowDefinition["renderer"] {
  const fields = readFields(input, path);
  return {
    id: fields.req("id", parseId),
    version: fields.req("version", parseSemVer),
    rendererDigest: fields.req("rendererDigest", parseDigestAt),
  };
}

function parseOutputSchemaAt(
  input: unknown,
  path: readonly (string | number)[],
): SemanticWorkflowDefinition["outputSchema"] {
  const fields = readFields(input, path);
  return {
    id: fields.req("id", parseId),
    version: fields.req("version", parseSemVer),
    schemaDigest: fields.req("schemaDigest", parseDigestAt),
  };
}

function parseToolPolicyAt(input: unknown, path: readonly (string | number)[]): SemanticToolPolicy {
  const fields = readFields(input, path);
  const base: Omit<SemanticToolPolicy, "policyDigest"> = {
    mode: fields.req("mode", parseOneOf(["none"])),
  };
  const policyDigest = fields.req("policyDigest", parseDigestAt);
  if (policyDigest !== semanticWorkflowToolPolicyDigest(base)) {
    throw invalid("schema.corrupt", "tool policy digest does not match the no-tools policy", [...path, "policyDigest"]);
  }
  return { ...base, policyDigest };
}

function parseBudgetPolicyAt(input: unknown, path: readonly (string | number)[]): SemanticBudgetPolicy {
  const fields = readFields(input, path);
  const base = {
    maximumRequestBytes: fields.req(
      "maximumRequestBytes",
      parseBoundedNonnegativeInteger(SEMANTIC_WORKFLOW_MAX_CANONICAL_BYTES, "maximum request bytes"),
    ),
    maximumResponseBytes: fields.req(
      "maximumResponseBytes",
      parseBoundedNonnegativeInteger(SEMANTIC_WORKFLOW_MAX_CANONICAL_BYTES, "maximum response bytes"),
    ),
    maximumEpisodes: fields.req(
      "maximumEpisodes",
      parseBoundedNonnegativeInteger(SEMANTIC_WORKFLOW_MAX_EPISODES, "maximum episodes"),
    ),
    maximumEvidenceRefs: fields.req(
      "maximumEvidenceRefs",
      parseBoundedNonnegativeInteger(SEMANTIC_WORKFLOW_MAX_EVIDENCE_REFS, "maximum evidence references"),
    ),
    maximumInputTokens: fields.req(
      "maximumInputTokens",
      parseBoundedNonnegativeInteger(Number.MAX_SAFE_INTEGER, "maximum input tokens"),
    ),
    maximumOutputTokens: fields.req(
      "maximumOutputTokens",
      parseBoundedNonnegativeInteger(Number.MAX_SAFE_INTEGER, "maximum output tokens"),
    ),
    maximumDurationMs: fields.req(
      "maximumDurationMs",
      parseBoundedNonnegativeInteger(SEMANTIC_WORKFLOW_MAX_DURATION_MS, "maximum duration milliseconds"),
    ),
    maximumAttempts: fields.req("maximumAttempts", parseOne),
    tokenEstimatorDigest: fields.req("tokenEstimatorDigest", parseDigestAt),
    maximumCost: fields.req("maximumCost", parseNullable(parseCostAt)),
  };
  const policyDigest = fields.req("policyDigest", parseDigestAt);
  if (policyDigest !== semanticWorkflowBudgetPolicyDigest(base)) {
    throw invalid("schema.corrupt", "budget policy digest does not match its exact ceilings", [
      ...path,
      "policyDigest",
    ]);
  }
  return { ...base, policyDigest };
}

function parseDisclosurePolicyAt(input: unknown, path: readonly (string | number)[]): SemanticDisclosurePolicy {
  const fields = readFields(input, path);
  const base = {
    mode: fields.req("mode", parseOneOf(DISCLOSURE_MODES)),
    minimizationPolicyDigest: fields.req("minimizationPolicyDigest", parseDigestAt),
    keyPolicyDigest: fields.req("keyPolicyDigest", parseDigestAt),
    authorizationPolicyDigest: fields.req("authorizationPolicyDigest", parseDigestAt),
    maximumAuthorizationAgeMs: fields.req(
      "maximumAuthorizationAgeMs",
      parsePositiveSafeInteger(SEMANTIC_WORKFLOW_MAX_DURATION_MS, "maximum authorization age milliseconds"),
    ),
  };
  const policyDigest = fields.req("policyDigest", parseDigestAt);
  if (policyDigest !== semanticWorkflowDisclosurePolicyDigest(base)) {
    throw invalid("schema.corrupt", "disclosure policy digest does not match its exact mode", [
      ...path,
      "policyDigest",
    ]);
  }
  return { ...base, policyDigest };
}

function parseAttestationAt(
  input: unknown,
  path: readonly (string | number)[],
): SemanticWorkflowDefinition["attestation"] {
  const fields = readFields(input, path);
  return {
    id: fields.req("id", parseId),
    digest: fields.req("digest", parseDigestAt),
  };
}

function parseCalibrationAt(
  input: unknown,
  path: readonly (string | number)[],
): NonNullable<SemanticWorkflowDefinition["calibration"]> {
  const fields = readFields(input, path);
  return {
    status: fields.req("status", parseOneOf(["unverified"])),
    calibrationId: fields.req("calibrationId", parseNull),
    calibrationDigest: fields.req("calibrationDigest", parseNull),
  };
}

export function parseSemanticWorkflowDefinition(input: unknown): SemanticWorkflowDefinition {
  const fields = readFields(input, []);
  const schemaVersion = fields.schemaVersion1();
  const lane = fields.req("lane", parseOneOf(WORKFLOW_LANES));
  const transport = fields.req("transport", parseOneOf(WORKFLOW_TRANSPORTS));
  const disclosurePolicy = fields.req("disclosurePolicy", parseDisclosurePolicyAt);
  if (
    (transport === "local" && disclosurePolicy.mode !== "forbidden") ||
    (transport === "outbound" && disclosurePolicy.mode !== "explicit_authorization")
  ) {
    throw invalid("schema.invalid", "workflow transport and disclosure policy are inconsistent", [
      "disclosurePolicy",
      "mode",
    ]);
  }
  const calibration = fields.req("calibration", parseNullable(parseCalibrationAt));
  if ((lane === "generation" && calibration !== null) || (lane === "advisory_review" && calibration === null)) {
    throw invalid("schema.invalid", "generation calibration is null and advisory review calibration is unverified", [
      "calibration",
    ]);
  }
  const base = {
    id: fields.req("id", parseId),
    version: fields.req("version", parseSemVer),
    lane,
    transport,
    implementation: fields.req("implementation", parseImplementationAt),
    providerModel: fields.req("providerModel", parseProviderModelAt),
    prompt: fields.req("prompt", parsePromptAt),
    renderer: fields.req("renderer", parseRendererAt),
    outputSchema: fields.req("outputSchema", parseOutputSchemaAt),
    toolPolicy: fields.req("toolPolicy", parseToolPolicyAt),
    budgetPolicy: fields.req("budgetPolicy", parseBudgetPolicyAt),
    disclosurePolicy,
    principal: fields.req("principal", parsePrincipalRefAt),
    attestation: fields.req("attestation", parseAttestationAt),
    calibration,
  };
  const definitionDigest = fields.req("definitionDigest", parseDigestAt);
  if (definitionDigest !== semanticWorkflowDefinitionDigest(base)) {
    throw invalid("schema.corrupt", "workflow definition digest does not match its bound fields", ["definitionDigest"]);
  }
  return deepFreeze({ schemaVersion, ...base, definitionDigest });
}
