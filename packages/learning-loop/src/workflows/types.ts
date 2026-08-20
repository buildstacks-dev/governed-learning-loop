import type { DetectorExecutionRecord } from "../records/detector-execution.js";
import type { InsightDerivation } from "../records/insight-derivation.js";
import type { Scope } from "../records/scope.js";
import type { DetectorRunInput } from "../engine/detector-run.js";
import type { DetectorExecutionView, InsightDerivationView } from "../engine/semantic-views.js";
import type { Diagnostic } from "../diagnostics.js";

type SemanticWorkflowResultStatus =
  | "completed"
  | "provider_refused"
  | "provider_failed"
  | "result_invalid"
  | "result_limit"
  | "outcome_unknown";

interface SemanticWorkflowPreview {
  readonly mediaType: "application/json";
  readonly encoding: "utf-8";
  /** A caller-owned copy. Mutation cannot change the privately held plan bytes. */
  readonly bytes: Uint8Array;
  readonly byteLength: number;
  readonly estimatedInputTokens: number;
  readonly minimizedBytesDigest: string;
  readonly keyPolicyDigest: string;
}

interface SemanticWorkflowTurnView {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly turnKeyDigest: string;
  readonly definition: {
    readonly id: string;
    readonly version: string;
    readonly definitionDigest: string;
  };
  readonly transport: "local" | "outbound";
  readonly scopeDigest: string;
  readonly status: SemanticWorkflowResultStatus;
  readonly request: {
    readonly byteLength: number;
    readonly estimatedInputTokens: number | null;
    readonly minimizedBytesDigest: string;
    readonly keyPolicyDigest: string;
  };
  readonly dispatchClaimedAt: string;
  readonly authorization:
    | { readonly status: "not_required" }
    | {
        readonly status: "authorized";
        readonly authorizationDigest: string;
        readonly authorizedAt: string;
        readonly expiresAt: string;
      };
  readonly disclosure:
    | { readonly status: "not_observed" }
    | {
        readonly status: "result_attested";
        readonly responseReceiptId: string;
        readonly responseReceiptDigest: string;
      };
  readonly usage:
    | {
        readonly status: "reported";
        readonly inputTokens: number;
        readonly outputTokens: number;
        readonly durationMs: number;
        readonly costMinorUnits: number | null;
        readonly currency: string | null;
      }
    | { readonly status: "unreported"; readonly reasonCode: "usage.not_reported" | "usage.outcome_unknown" };
  readonly output:
    | {
        readonly kind: "none";
        readonly reasonCode:
          | "workflow.condition_not_detected"
          | "workflow.provider_refused"
          | "workflow.provider_failed"
          | "workflow.result_invalid"
          | "workflow.result_limit"
          | "workflow.outcome_unknown";
      }
    | {
        readonly kind: "generation";
        readonly workflowExecutionId: string;
        readonly workflowExecutionKeyDigest: string;
        readonly workflowExecutionDigest: string;
        readonly execution: DetectorExecutionView;
        readonly derivations: readonly InsightDerivationView[];
      };
  readonly turnDigest: string;
}

export interface SemanticWorkflowBundle {
  readonly schemaVersion: 1;
  readonly definitionDigest: string;
  prepareGeneration(input: {
    readonly detector: DetectorRunInput["detector"];
    readonly pack: DetectorRunInput["pack"];
    readonly lens: NonNullable<DetectorRunInput["lens"]>;
    readonly scope: Scope;
    readonly episodeRecordIds: readonly string[];
    readonly expiresAt: string;
  }): Promise<
    | {
        readonly status: "prepared";
        readonly plan: object;
        readonly attemptId: string;
        readonly preview: SemanticWorkflowPreview;
        readonly windowDigest: string;
        readonly executionKeyDigest: string;
      }
    | {
        readonly status: "execution_existing";
        readonly preview: null;
        readonly windowDigest: string;
        readonly executionKeyDigest: string;
        readonly execution: DetectorExecutionView;
        readonly derivations: readonly InsightDerivationView[];
      }
    | {
        readonly status: "not_applicable" | "incomplete";
        readonly preview: null;
        readonly diagnostics: readonly Diagnostic[];
      }
  >;
  authorizeGeneration(input: { readonly plan: object; readonly evidence: unknown }): Promise<{
    readonly authorization: object;
    readonly authorizedAt: string;
    readonly expiresAt: string;
  }>;
  runGeneration(input: { readonly plan: object; readonly authorization: object | null }): Promise<{
    readonly status: SemanticWorkflowResultStatus;
    readonly persistence: "committed" | "existing" | "dispatch_only";
    readonly callbackInvoked: boolean;
    readonly turnId: string | null;
    readonly execution?: DetectorExecutionRecord;
    readonly derivations: readonly InsightDerivation[];
  }>;
  recoverGeneration(input: { readonly attemptId: string; readonly scope: Scope }): Promise<{
    readonly status: SemanticWorkflowResultStatus | "not_dispatched";
    readonly persistence: "committed" | "existing" | "dispatch_only" | "not_dispatched";
    readonly callbackInvoked: boolean;
    readonly turnId: string | null;
    readonly execution?: DetectorExecutionRecord;
    readonly derivations: readonly InsightDerivation[];
  }>;
  getTurn(input: { readonly turnId: string; readonly scope: Scope }): Promise<SemanticWorkflowTurnView | undefined>;
  queryTurns(input: {
    readonly scope: Scope;
    readonly limit: number;
    readonly cursor?: string | undefined;
  }): AsyncIterable<{
    readonly items: readonly SemanticWorkflowTurnView[];
    readonly nextCursor?: string;
    readonly snapshotRevision: string;
  }>;
}
