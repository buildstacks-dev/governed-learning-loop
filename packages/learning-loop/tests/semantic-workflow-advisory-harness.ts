import type { Scope, VerifiedPrincipal } from "@cormidia/learning-loop";
import { toJsonValue } from "@cormidia/learning-loop";
import type { SemanticWorkflowBundle } from "@cormidia/learning-loop/workflows";
import { createSemanticWorkflowBundle } from "@cormidia/learning-loop/workflows";
import type {
  AuthorityState,
  GenerationHarness,
  GenerationHarnessOptions,
  ProviderState,
} from "./semantic-workflow-generation-harness.js";
import {
  createGenerationHarness,
  providerRequestBytes,
  WORKFLOW_AUTHORIZATION_POLICY_DIGEST,
  WORKFLOW_KEY_POLICY_DIGEST,
  WORKFLOW_MINIMIZATION_POLICY_DIGEST,
  WORKFLOW_SCOPE,
  workflowKeyedDigest,
} from "./semantic-workflow-generation-harness.js";
import { sha256HexOfCanonicalJson } from "../src/index.js";
import type { CandidateV2 } from "../src/records/candidate.js";

type SemanticWorkflowDefinition = ReturnType<typeof createSemanticWorkflowBundle.defineAdvisoryReview>;
type Transport = SemanticWorkflowDefinition["transport"];

const ADVISORY_RESULT_SCHEMA_ID = createSemanticWorkflowBundle.advisoryReviewResultSchema.id;
const ADVISORY_RESULT_SCHEMA_VERSION = createSemanticWorkflowBundle.advisoryReviewResultSchema.version;

function digest(label: string): string {
  return sha256HexOfCanonicalJson(toJsonValue({ label }));
}

export interface AdvisoryFactoryInput {
  readonly schemaVersion: 1;
  readonly loop: GenerationHarness["learning"];
  readonly definition: SemanticWorkflowDefinition;
  readonly reviewer: VerifiedPrincipal;
  readonly renderer: { readonly rendererDigest: string; readonly render: (input: unknown) => unknown };
  readonly minimizer: { readonly minimizationPolicyDigest: string; readonly minimize: (input: unknown) => unknown };
  readonly keyedDigester: { readonly keyPolicyDigest: string; readonly digest: (bytes: Uint8Array) => unknown };
  readonly tokenEstimator: {
    readonly tokenEstimatorDigest: string;
    readonly estimateInputTokens: (bytes: Uint8Array) => unknown;
  };
  readonly provider: { readonly registrationDigest: string; readonly invoke: (input: unknown) => Promise<unknown> };
  readonly disclosureAuthority?: {
    readonly authorizationPolicyDigest: string;
    readonly authorize: (input: unknown) => Promise<unknown>;
  };
}

export interface AdvisoryHarness extends GenerationHarness {
  readonly reviewer: VerifiedPrincipal;
  readonly proposer: VerifiedPrincipal;
  readonly candidate: CandidateV2;
  readonly advisoryDefinition: SemanticWorkflowDefinition;
  readonly advisoryBundle: SemanticWorkflowBundle;
  readonly advisoryFactoryInput: AdvisoryFactoryInput;
  readonly advisoryProviderState: ProviderState;
  readonly advisoryAuthorityState: AuthorityState;
  readonly advisoryPrepareInput: Parameters<SemanticWorkflowBundle["prepareAdvisoryReview"]>[0];
}

export interface AdvisoryHarnessOptions extends GenerationHarnessOptions {
  readonly proposedRisk?: "T0" | "T1" | "T2" | "T3";
  readonly reviewerPrincipalId?: string;
  readonly reviewerIndependenceDomain?: string;
  readonly candidateId?: string;
  readonly skipCandidate?: boolean;
  readonly derivationId?: string;
  readonly reviewerImplementation?: { readonly id: string; readonly version: string };
}

export function advisoryDefinitionFor(input: {
  readonly transport: Transport;
  readonly reviewer: VerifiedPrincipal;
  readonly budgets: {
    readonly maximumRequestBytes: number;
    readonly maximumResponseBytes: number;
    readonly maximumInputTokens: number;
    readonly maximumOutputTokens: number;
    readonly maximumDurationMs: number;
  };
  readonly implementation?: { readonly id: string; readonly version: string };
}): SemanticWorkflowDefinition {
  const schemaVersion: 1 = 1;
  const implementation = input.implementation ?? { id: "hermetic-advisory-review", version: "1.0.0" };
  return createSemanticWorkflowBundle.defineAdvisoryReview({
    schemaVersion,
    id: `hermetic-advisory-${input.transport}`,
    version: "1.0.0",
    transport: input.transport,
    implementation: {
      id: implementation.id,
      version: implementation.version,
      implementationDigest: digest(`advisory-implementation-${implementation.id}-${implementation.version}`),
    },
    providerModel: {
      provider: {
        id: "hermetic-advisory-provider",
        version: "1.0.0",
        providerFingerprintDigest: digest("hermetic-advisory-provider-fingerprint"),
        operationKeyPolicyDigest: digest("hermetic-advisory-operation-key-policy"),
      },
      model: { id: "hermetic-advisory-model", modelFingerprintDigest: digest("hermetic-advisory-model-fingerprint") },
    },
    prompt: { id: "hermetic-advisory-prompt", version: "1.0.0", promptDigest: digest("hermetic-advisory-prompt") },
    renderer: {
      id: "hermetic-advisory-renderer",
      version: "1.0.0",
      rendererDigest: digest("hermetic-advisory-renderer"),
    },
    budgetPolicy: {
      maximumRequestBytes: input.budgets.maximumRequestBytes,
      maximumResponseBytes: input.budgets.maximumResponseBytes,
      maximumEpisodes: 500,
      maximumEvidenceRefs: 5_000,
      maximumInputTokens: input.budgets.maximumInputTokens,
      maximumOutputTokens: input.budgets.maximumOutputTokens,
      maximumDurationMs: input.budgets.maximumDurationMs,
      tokenEstimatorDigest: digest("hermetic-token-estimator"),
      maximumCost: { minorUnits: 100, currency: "USD" },
    },
    disclosurePolicy: {
      mode: input.transport === "outbound" ? "explicit_authorization" : "forbidden",
      minimizationPolicyDigest: WORKFLOW_MINIMIZATION_POLICY_DIGEST,
      keyPolicyDigest: WORKFLOW_KEY_POLICY_DIGEST,
      authorizationPolicyDigest: WORKFLOW_AUTHORIZATION_POLICY_DIGEST,
      maximumAuthorizationAgeMs: 60_000,
    },
    principal: input.reviewer.ref,
    attestation: { id: input.reviewer.attestationId, digest: input.reviewer.attestationDigest },
  });
}

function isRecord(input: unknown): input is Readonly<Record<string, unknown>> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function field(input: unknown, key: string): unknown {
  if (!isRecord(input)) throw new Error("advisory callback input must be an object");
  return input[key];
}

export function positiveAdvisoryResult(providerInput?: unknown): unknown {
  if (providerInput !== undefined) providerRequestBytes(providerInput);
  return {
    schemaVersion: 1,
    id: ADVISORY_RESULT_SCHEMA_ID,
    version: ADVISORY_RESULT_SCHEMA_VERSION,
    status: "completed",
    providerReceipt: {
      id: "hermetic-advisory-provider-receipt",
      digest: digest("hermetic-advisory-provider-receipt"),
    },
    usage: {
      status: "reported",
      inputTokens: 90,
      outputTokens: 20,
      durationMs: 40,
      costMinorUnits: 1,
      currency: "USD",
    },
    result: {
      advisoryRecommendation: "revise",
      findings: [
        {
          code: "advisory.hypothesis_untested",
          severity: "warning",
          statement: "ADVISORY-STATEMENT-CANARY: the hypothesis has no contradicting probe.",
        },
      ],
    },
  };
}

export function refusedAdvisoryResult(providerInput?: unknown): unknown {
  const positive = positiveAdvisoryResult(providerInput);
  if (!isRecord(positive)) throw new Error("positive advisory fixture is malformed");
  return { ...positive, status: "provider_refused", result: null };
}

export function failedAdvisoryResult(providerInput?: unknown): unknown {
  const positive = positiveAdvisoryResult(providerInput);
  if (!isRecord(positive)) throw new Error("positive advisory fixture is malformed");
  return { ...positive, status: "provider_failed", result: null };
}

export async function proposeSubjectCandidate(
  harness: GenerationHarness,
  proposer: VerifiedPrincipal,
  overrides: {
    readonly id?: string;
    readonly proposedRisk?: "T0" | "T1" | "T2" | "T3";
    readonly derivationId?: string;
    readonly problem?: string;
  } = {},
): Promise<CandidateV2> {
  const scope: Scope = WORKFLOW_SCOPE;
  const outcome =
    overrides.derivationId === undefined
      ? await harness.learning.propose({
          id: overrides.id ?? "advisory-subject-candidate",
          scope,
          problem: overrides.problem ?? "Semantic observations recur without a standing note.",
          hypothesis: "A standing note would prevent repeated rediscovery.",
          evidenceIds: ["manual-evidence/semantic-workflow-observation"],
          intervention: {
            destinationId: "host/semantic-note",
            kind: "report-note",
            content: { text: "Record the recurring structural signal." },
            rollbackIntent: "Delete the note.",
          },
          proposedRisk: overrides.proposedRisk ?? "T1",
          proposedBy: proposer,
        })
      : await harness.learning.propose({
          id: overrides.id ?? "advisory-subject-candidate",
          scope,
          derivationId: overrides.derivationId,
          proposedRisk: overrides.proposedRisk ?? "T1",
          proposedBy: proposer,
        });
  return outcome.candidate;
}

export async function createAdvisoryHarness(options: AdvisoryHarnessOptions = {}): Promise<AdvisoryHarness> {
  const base = await createGenerationHarness(options);
  const transport = options.transport ?? "local";
  const proposer = await base.identity.verify({
    principalId: "advisory-proposer",
    kind: "human",
    independenceDomain: "advisory-proposer-domain",
  });
  const reviewer = await base.identity.verify({
    principalId: options.reviewerPrincipalId ?? "advisory-reviewer",
    kind: "service",
    independenceDomain: options.reviewerIndependenceDomain ?? "advisory-reviewer-domain",
  });
  const advisoryDefinition = advisoryDefinitionFor({
    transport,
    reviewer,
    budgets: {
      maximumRequestBytes: options.maximumRequestBytes ?? 1_048_576,
      maximumResponseBytes: options.maximumResponseBytes ?? 1_048_576,
      maximumInputTokens: options.maximumInputTokens ?? 10_000,
      maximumOutputTokens: options.maximumOutputTokens ?? 2_000,
      maximumDurationMs: options.maximumDurationMs ?? 1_000,
    },
    ...(options.reviewerImplementation === undefined ? {} : { implementation: options.reviewerImplementation }),
  });
  const advisoryProviderState: ProviderState = {
    calls: [],
    script: (input) => Promise.resolve(positiveAdvisoryResult(input)),
  };
  const advisoryAuthorityState: AuthorityState = {
    calls: [],
    script: () =>
      Promise.resolve({
        principal: base.authorizer,
        authorizedAt: "2026-08-20T00:01:30.000Z",
        expiresAt: "2026-08-20T00:02:30.000Z",
      }),
  };
  const schemaVersion: 1 = 1;
  const advisoryFactoryInput: AdvisoryFactoryInput = {
    schemaVersion,
    loop: base.learning,
    definition: advisoryDefinition,
    reviewer,
    renderer: {
      rendererDigest: advisoryDefinition.renderer.rendererDigest,
      render: (input: unknown) => ({
        schemaVersion: 1,
        definitionDigest: field(input, "definitionDigest"),
        subject: field(input, "subject"),
      }),
    },
    minimizer: {
      minimizationPolicyDigest: WORKFLOW_MINIMIZATION_POLICY_DIGEST,
      minimize: (input: unknown) => toJsonValue(field(input, "rendered")),
    },
    keyedDigester: {
      keyPolicyDigest: WORKFLOW_KEY_POLICY_DIGEST,
      digest: (bytes: Uint8Array) => workflowKeyedDigest(bytes),
    },
    tokenEstimator: {
      tokenEstimatorDigest: advisoryDefinition.budgetPolicy.tokenEstimatorDigest,
      estimateInputTokens: (bytes: Uint8Array) => Math.ceil(bytes.byteLength / 4),
    },
    provider: {
      registrationDigest: advisoryDefinition.providerModel.provider.registrationDigest,
      invoke: (input: unknown) => {
        advisoryProviderState.calls.push(input);
        return advisoryProviderState.script(input);
      },
    },
    ...(transport === "outbound"
      ? {
          disclosureAuthority: {
            authorizationPolicyDigest: WORKFLOW_AUTHORIZATION_POLICY_DIGEST,
            authorize: (input: unknown) => {
              advisoryAuthorityState.calls.push(input);
              return advisoryAuthorityState.script(input);
            },
          },
        }
      : {}),
  };
  const advisoryBundle = createSemanticWorkflowBundle(advisoryFactoryInput);
  const candidate =
    options.skipCandidate === true
      ? undefined
      : await proposeSubjectCandidate(base, proposer, {
          ...(options.candidateId === undefined ? {} : { id: options.candidateId }),
          ...(options.proposedRisk === undefined ? {} : { proposedRisk: options.proposedRisk }),
          ...(options.derivationId === undefined ? {} : { derivationId: options.derivationId }),
        });
  return {
    ...base,
    reviewer,
    proposer,
    get candidate(): CandidateV2 {
      if (candidate === undefined) {
        throw new Error("advisory harness was created with skipCandidate; no subject candidate exists");
      }
      return candidate;
    },
    advisoryDefinition,
    advisoryBundle,
    advisoryFactoryInput,
    advisoryProviderState,
    advisoryAuthorityState,
    advisoryPrepareInput: {
      candidateId: candidate?.id ?? "advisory-subject-candidate",
      scope: WORKFLOW_SCOPE,
      expiresAt: "2026-08-20T00:05:00.000Z",
    },
  };
}
