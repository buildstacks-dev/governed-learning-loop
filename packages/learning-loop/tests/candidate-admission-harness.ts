import type {
  CandidateInput,
  DetectorExecutionRecord,
  DetectorOrchestrationPolicy,
  InsightDerivation,
  LearningStore,
  Scope,
  VerifiedPrincipal,
} from "../src/index.js";
import {
  detectorExecutionDigest,
  insightDerivationDigest,
  parseDetectorExecutionRecord,
  parseInsightDerivation,
} from "../src/index.js";
import type { EngineContext } from "../src/engine/context.js";
import { runPropose } from "../src/engine/propose.js";
import { persistDetectorExecution } from "../src/engine/semantic-persistence.js";
import type { RecurrenceRunnerHarness } from "./detector-recurrence-harness.js";
import {
  PRIVATE_LOCATOR,
  createDetectorOrchestrationPolicy,
  createRecurrenceRunnerHarness,
  detectedInsightDraft,
  detectorRef,
  packRef,
} from "./detector-recurrence-harness.js";

type DerivedCandidateInput = Extract<CandidateInput, { readonly derivationId: string }>;

export interface AdmissionHarness {
  readonly harness: RecurrenceRunnerHarness;
  readonly context: EngineContext;
  readonly proposer: VerifiedPrincipal;
  readonly derivation: InsightDerivation;
  readonly execution: DetectorExecutionRecord;
  readonly groupKeyDigest: string;
}

export async function createAdmissionHarness(input: {
  readonly label: string;
  readonly store?: LearningStore;
  readonly policy?: DetectorOrchestrationPolicy;
  readonly episodeCount?: number;
  readonly initialEpisodeCount?: number;
  readonly scope?: Scope;
}): Promise<AdmissionHarness> {
  const harness = await createRecurrenceRunnerHarness({
    label: input.label,
    ...(input.store === undefined ? {} : { store: input.store }),
    episodeCount: input.episodeCount ?? 2,
    detectorOrchestrationPolicy: input.policy ?? createDetectorOrchestrationPolicy(),
    ...(input.scope === undefined ? {} : { scope: input.scope }),
    evaluate: (window) => detectedInsightDraft(window, PRIVATE_LOCATOR),
  });
  const result = await harness.learning.runDetector({
    mode: "commit",
    detector: detectorRef(harness.detector),
    pack: packRef(harness.pack),
    lens: harness.registry.selectedLensRefs[0] ?? null,
    scope: harness.scope,
    episodeRecordIds: harness.episodeRecordIds.slice(0, input.initialEpisodeCount ?? 1),
  });
  const derivation = result.derivations[0];
  const execution = result.execution;
  if (derivation === undefined || execution === undefined || result.recurrence.status !== "grouped") {
    throw new Error("admission harness did not create one grouped derivation");
  }
  const proposer = await harness.context.identity.verify({
    principalId: `${input.label}-proposer`,
    kind: "agent",
    independenceDomain: `${input.label}-domain`,
  });
  return {
    harness,
    context: harness.context,
    proposer,
    derivation,
    execution,
    groupKeyDigest: result.recurrence.groupKeyDigest,
  };
}

export function admissionCandidateInput(
  fixture: AdmissionHarness,
  id: string,
  input: {
    readonly derivationId?: string;
    readonly proposedRisk?: "T0" | "T1" | "T2" | "T3";
    readonly supersedes?: string;
  } = {},
): DerivedCandidateInput {
  return {
    id,
    scope: fixture.harness.scope,
    derivationId: input.derivationId ?? fixture.derivation.id,
    proposedRisk: input.proposedRisk ?? "T1",
    proposedBy: fixture.proposer,
    ...(input.supersedes === undefined ? {} : { supersedes: input.supersedes }),
  };
}

export async function proposeAdmissionCandidate(
  fixture: AdmissionHarness,
  id: string,
  input: Parameters<typeof admissionCandidateInput>[2] = {},
) {
  return fixture.harness.learning.propose(admissionCandidateInput(fixture, id, input));
}

export async function proposePreAdmissionCandidate(
  fixture: AdmissionHarness,
  id: string,
  input: Parameters<typeof admissionCandidateInput>[2] = {},
) {
  const { detectorOrchestrationPolicy: _policy, ...legacyContext } = fixture.context;
  return runPropose(legacyContext, admissionCandidateInput(fixture, id, input));
}

function supersedingDerivation(current: InsightDerivation, predecessor: InsightDerivation): InsightDerivation {
  const { schemaVersion: _schemaVersion, id: _id, derivationDigest: _derivationDigest, ...base } = current;
  const changed = {
    ...base,
    directObservation: { ...base.directObservation, data: { successor: predecessor.derivationDigest } },
    supersedes: {
      id: predecessor.id,
      derivationDigest: predecessor.derivationDigest,
      scopeDigest: predecessor.scopeDigest,
    },
  };
  const derivationDigest = insightDerivationDigest(changed);
  return parseInsightDerivation({
    schemaVersion: 1,
    id: `insight-${derivationDigest}`,
    ...changed,
    derivationDigest,
  });
}

function bindExecution(execution: DetectorExecutionRecord, derivation: InsightDerivation): DetectorExecutionRecord {
  const result = {
    status: "applied" as const,
    conditionDetected: true,
    derivationRefs: [
      { id: derivation.id, derivationDigest: derivation.derivationDigest, scopeDigest: derivation.scopeDigest },
    ],
    evidenceHealthFindings: [],
  };
  return parseDetectorExecutionRecord({
    ...execution,
    result,
    executionDigest: detectorExecutionDigest({
      ...execution,
      result,
      executionKeyDigest: execution.executionKeyDigest,
    }),
  });
}

export async function createAdmissionSuccessorFacts(
  fixture: AdmissionHarness,
  episodeRecordIds: readonly string[] = fixture.harness.episodeRecordIds,
) {
  const lens = fixture.harness.registry.selectedLensRefs[0];
  if (lens === undefined) throw new Error("admission successor fixture omitted its lens");
  const dry = await fixture.harness.learning.runDetector({
    mode: "dry_run",
    detector: detectorRef(fixture.harness.detector),
    pack: packRef(fixture.harness.pack),
    lens,
    scope: fixture.harness.scope,
    episodeRecordIds,
  });
  const draftDerivation = dry.derivations[0];
  const draftExecution = dry.execution;
  if (draftDerivation === undefined || draftExecution === undefined) {
    throw new Error("admission successor dry run omitted its output");
  }
  const derivation = supersedingDerivation(draftDerivation, fixture.derivation);
  const execution = bindExecution(draftExecution, derivation);
  await persistDetectorExecution(fixture.context, execution, [derivation], PRIVATE_LOCATOR);
  return { derivation, execution };
}
