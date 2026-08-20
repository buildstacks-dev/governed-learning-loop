import { Buffer } from "node:buffer";
import type { DetectorWindow } from "../engine/detector-window.js";
import type { EngineContext } from "../engine/context.js";
import type { SemanticWorkflowDefinition } from "./workflow-definition.js";
import type { SemanticTurnReservation, SemanticDisclosureAuthorization } from "./semantic-turn-intent.js";
import type { SemanticWorkflowAttemptIndex, SemanticWorkflowExecutionPlanLock } from "./semantic-generation-record.js";
import type { DetectorOrchestrationPolicy } from "../records/detector-orchestration-policy.js";
import type { buildRegistrySnapshot } from "../engine/semantic-graph.js";
import type { assembleAppliedDetectorResult } from "../engine/detector-draft.js";

export interface CapabilityCallbacks {
  readonly render: (input: { readonly window: DetectorWindow; readonly definitionDigest: string }) => unknown;
  readonly minimize: (input: { readonly rendered: unknown; readonly windowDigest: string }) => unknown;
  readonly digest: (bytes: Uint8Array) => unknown;
  readonly estimateInputTokens: (bytes: Uint8Array) => unknown;
  readonly invokeProvider: (input: {
    readonly operation: { readonly id: string; readonly idempotencyKey: string };
    readonly request: {
      readonly mediaType: "application/json";
      readonly encoding: "utf-8";
      readonly bytes: Uint8Array;
      readonly byteLength: number;
      readonly estimatedInputTokens: number;
      readonly minimizedBytesDigest: string;
      readonly keyPolicyDigest: string;
    };
    readonly model: { readonly id: string; readonly modelFingerprintDigest: string };
    readonly toolPolicy: { readonly mode: "none"; readonly policyDigest: string };
    readonly budgetPolicy: {
      readonly maximumInputTokens: number;
      readonly maximumOutputTokens: number;
      readonly maximumDurationMs: number;
      readonly maximumCost: { readonly minorUnits: number; readonly currency: string } | null;
    };
    readonly signal: AbortSignal;
  }) => Promise<unknown>;
  readonly authorize?: (input: {
    readonly preview: {
      readonly mediaType: "application/json";
      readonly encoding: "utf-8";
      readonly bytes: Uint8Array;
      readonly byteLength: number;
      readonly estimatedInputTokens: number;
      readonly minimizedBytesDigest: string;
      readonly keyPolicyDigest: string;
    };
    readonly scopeDigest: string;
    readonly definitionDigest: string;
    readonly evidence: unknown;
  }) => Promise<unknown>;
}

export interface PreparedPlanBinding {
  readonly token: object;
  readonly context: EngineContext;
  readonly definition: SemanticWorkflowDefinition;
  readonly callbacks: CapabilityCallbacks;
  readonly window: DetectorWindow;
  readonly executionTemplate: ReturnType<typeof assembleAppliedDetectorResult>["execution"];
  readonly episodeCompleteness: readonly {
    readonly episodeRecordId: string;
    readonly episodeViewDigest: string;
    readonly completeness: "complete" | "partial" | "unknown";
  }[];
  readonly registrySnapshot: ReturnType<typeof buildRegistrySnapshot>;
  readonly orchestrationPolicy: DetectorOrchestrationPolicy | null;
  readonly reservation: SemanticTurnReservation;
  readonly planLock: SemanticWorkflowExecutionPlanLock;
  readonly attempt: SemanticWorkflowAttemptIndex;
  readonly requestText: string;
}

export interface AuthorizationCapabilityBinding {
  readonly token: object;
  readonly plan: object;
  readonly record: SemanticDisclosureAuthorization;
}

export const preparedPlans = new WeakMap<object, PreparedPlanBinding>();
export const authorizationCapabilities = new WeakMap<object, AuthorizationCapabilityBinding>();

export function bytesOf(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, "utf8"));
}
