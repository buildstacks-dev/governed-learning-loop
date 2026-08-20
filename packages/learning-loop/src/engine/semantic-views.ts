// Semantic commit, registry, and evidence-health views.
import type { Diagnostic } from "../diagnostics.js";
import { LearningLoopError } from "../diagnostics.js";
import { invalid } from "../parse/toolkit.js";
import type { DetectorExecutionRecord } from "../records/detector-execution.js";
import type { InsightDerivation } from "../records/insight-derivation.js";
import type { Scope } from "../records/scope.js";
import { canonicalKey, scopeDigest } from "../records/semantic-shared.js";
import type { EvidenceHealthFinding } from "../records/source-health.js";
import type { EngineContext } from "./context.js";
import type { EvidenceHealthView } from "./evidence-binding.js";
import { resolveCandidateEvidence } from "./evidence-binding.js";
import type { DerivationExecutionLink } from "./semantic-graph.js";
import {
  loadDerivationLinks,
  loadDetectorExecutionRecord,
  loadInsightDerivationRecord,
  loadRegistrySnapshot,
} from "./semantic-graph.js";
import {
  diagnostic,
  healthFindingBelongsToWindow,
  loadExactHealthFinding,
  mergeHealth,
  sameCanonical,
  validateDerivationAgainstExecution,
  validateExecutionAgainstSnapshot,
  validateHistoricalWindowEvidence,
  validateInputHealth,
  validatePopulation,
  validateWindowEvidence,
} from "./semantic-validation.js";

type RegistryBinding =
  | { readonly status: "configured" }
  | { readonly status: "historical_unconfigured"; readonly diagnostics: readonly Diagnostic[] };

export interface InsightDerivationView {
  readonly derivation: InsightDerivation;
  readonly registryBinding: RegistryBinding;
  readonly commitBinding:
    | {
        readonly status: "committed";
        readonly executionRefs: readonly {
          readonly id: string;
          readonly executionKeyDigest: string;
          readonly executionDigest: string;
          readonly loopRegistryRevision: string;
          readonly semanticRegistryDigest: string;
        }[];
      }
    | { readonly status: "orphaned"; readonly diagnostics: readonly Diagnostic[] }
    | { readonly status: "invalid"; readonly diagnostics: readonly Diagnostic[] };
  readonly evidenceHealth: EvidenceHealthView;
}

export interface DetectorExecutionView {
  readonly execution: DetectorExecutionRecord;
  readonly registryBinding: RegistryBinding;
  readonly commitBinding:
    | { readonly status: "committed" }
    | { readonly status: "invalid"; readonly diagnostics: readonly Diagnostic[] };
  readonly evidenceHealth: EvidenceHealthView;
}

function executionNamesDerivation(execution: DetectorExecutionRecord, derivation: InsightDerivation): boolean {
  return (
    execution.result.status === "applied" &&
    execution.result.derivationRefs.some(
      (reference) =>
        reference.id === derivation.id &&
        reference.derivationDigest === derivation.derivationDigest &&
        reference.scopeDigest === derivation.scopeDigest,
    )
  );
}

function currentRegistryBinding(
  context: EngineContext,
  links: readonly DerivationExecutionLink[],
  committedDigests: ReadonlySet<string>,
): RegistryBinding {
  const registryDigest = context.semanticRegistry?.registryDigest;
  if (
    registryDigest !== undefined &&
    links.some(
      (link) =>
        committedDigests.has(link.executionDigest) &&
        link.loopRegistryRevision === context.registryRevision &&
        link.semanticRegistryDigest === registryDigest,
    )
  ) {
    return { status: "configured" };
  }
  return {
    status: "historical_unconfigured",
    diagnostics: [
      diagnostic(
        "semantic.registry_historical",
        "warning",
        "semantic fact is not selected by the current loop registry",
      ),
    ],
  };
}

async function executionRegistryBinding(
  context: EngineContext,
  execution: DetectorExecutionRecord,
): Promise<RegistryBinding> {
  const snapshot = await loadRegistrySnapshot(context, execution.loopRegistryRevision);
  if (snapshot === undefined) {
    return {
      status: "historical_unconfigured",
      diagnostics: [diagnostic("semantic.registry_missing", "error", "execution registry snapshot is unavailable")],
    };
  }
  if (
    execution.loopRegistryRevision === context.registryRevision &&
    context.semanticRegistry?.registryDigest === snapshot.semanticRegistry.registryDigest
  ) {
    return { status: "configured" };
  }
  return {
    status: "historical_unconfigured",
    diagnostics: [
      diagnostic("semantic.registry_historical", "warning", "execution belongs to a historical semantic registry"),
    ],
  };
}

async function executionEvidenceHealth(
  context: EngineContext,
  execution: DetectorExecutionRecord,
): Promise<EvidenceHealthView> {
  try {
    const snapshot = await loadRegistrySnapshot(context, execution.loopRegistryRevision);
    if (snapshot === undefined)
      throw invalid("semantic.registry_missing", "execution registry snapshot is unavailable", []);
    validateExecutionAgainstSnapshot(execution, snapshot.semanticRegistry);
    await validatePopulation(context, execution, snapshot.semanticRegistry);
    const evidence =
      execution.loopRegistryRevision === context.registryRevision &&
      context.semanticRegistry?.registryDigest === snapshot.semanticRegistry.registryDigest
        ? await validateWindowEvidence(context, execution, snapshot.semanticRegistry)
        : await validateHistoricalWindowEvidence(context, execution, snapshot.semanticRegistry);
    const inputFindings = await validateInputHealth(context, execution);
    const outputFindings: EvidenceHealthFinding[] = [];
    if (execution.result.status === "applied") {
      for (const finding of execution.result.evidenceHealthFindings) {
        outputFindings.push(await loadExactHealthFinding(context, finding));
      }
    }
    return mergeHealth(evidence, [...inputFindings, ...outputFindings]);
  } catch (error) {
    if (!(error instanceof LearningLoopError)) throw error;
    return {
      status: "invalid",
      diagnostics: [
        diagnostic("semantic.evidence_invalid", "error", "semantic execution evidence is no longer valid"),
        ...error.diagnostics,
      ],
    };
  }
}

async function resolveExecutionCommit(
  context: EngineContext,
  execution: DetectorExecutionRecord,
): Promise<DetectorExecutionView["commitBinding"]> {
  const snapshot = await loadRegistrySnapshot(context, execution.loopRegistryRevision);
  if (
    snapshot === undefined ||
    !execution.window.sourceProfiles.every((profile) =>
      snapshot.semanticRegistry.sourceProfiles.some((stored) => sameCanonical(stored, profile)),
    )
  ) {
    return {
      status: "invalid",
      diagnostics: [
        diagnostic("semantic.commit_invalid", "error", "execution registry snapshot is missing or mismatched"),
      ],
    };
  }
  try {
    validateExecutionAgainstSnapshot(execution, snapshot.semanticRegistry);
  } catch (error) {
    if (!(error instanceof LearningLoopError)) throw error;
    return {
      status: "invalid",
      diagnostics: [diagnostic("semantic.commit_invalid", "error", "execution registry lineage is invalid")],
    };
  }
  if (execution.result.status !== "applied") return { status: "committed" };
  for (const finding of execution.result.evidenceHealthFindings) {
    try {
      const exact = await loadExactHealthFinding(context, finding);
      if (!(await healthFindingBelongsToWindow(context, execution, exact))) {
        throw invalid("semantic.health_unrelated", "execution health output is unrelated to its window", []);
      }
    } catch (error) {
      if (!(error instanceof LearningLoopError)) throw error;
      return {
        status: "invalid",
        diagnostics: [diagnostic("semantic.commit_invalid", "error", "execution health output is missing")],
      };
    }
  }
  for (const reference of execution.result.derivationRefs) {
    const derivation = await loadInsightDerivationRecord(context, reference.id);
    const links = await loadDerivationLinks(context, reference.id);
    const reciprocal = links.some(
      (link) =>
        link.executionId === execution.id &&
        link.executionDigest === execution.executionDigest &&
        link.derivationDigest === reference.derivationDigest &&
        link.scopeDigest === reference.scopeDigest &&
        link.loopRegistryRevision === execution.loopRegistryRevision &&
        link.semanticRegistryDigest === snapshot.semanticRegistry.registryDigest,
    );
    if (
      derivation === undefined ||
      derivation.derivationDigest !== reference.derivationDigest ||
      derivation.scopeDigest !== reference.scopeDigest ||
      !reciprocal
    ) {
      return {
        status: "invalid",
        diagnostics: [
          diagnostic("semantic.commit_invalid", "error", "execution derivation output is missing or non-reciprocal"),
        ],
      };
    }
    try {
      validateDerivationAgainstExecution(execution, derivation, snapshot.semanticRegistry);
    } catch (error) {
      if (!(error instanceof LearningLoopError)) throw error;
      return {
        status: "invalid",
        diagnostics: [diagnostic("semantic.commit_invalid", "error", "execution derivation policy is invalid")],
      };
    }
  }
  return { status: "committed" };
}

async function loadDetectorExecutionViewOnce(
  context: EngineContext,
  executionId: string,
  exactScopeDigest: string,
): Promise<DetectorExecutionView | undefined> {
  const execution = await loadDetectorExecutionRecord(context, executionId);
  if (execution === undefined || execution.scopeDigest !== exactScopeDigest) return undefined;
  return {
    execution,
    registryBinding: await executionRegistryBinding(context, execution),
    commitBinding: await resolveExecutionCommit(context, execution),
    evidenceHealth: await executionEvidenceHealth(context, execution),
  };
}

async function derivationEvidenceHealth(
  context: EngineContext,
  derivation: InsightDerivation,
  committedExecutions: readonly DetectorExecutionRecord[],
): Promise<EvidenceHealthView> {
  const evidenceIds = [...derivation.directObservation.evidenceRefs, ...derivation.contradictoryEvidenceRefs].map(
    (reference) => reference.recordId,
  );
  let base: EvidenceHealthView = { status: "ready", diagnostics: [] };
  if (committedExecutions.length > 0) {
    for (const execution of committedExecutions) {
      const health = await executionEvidenceHealth(context, execution);
      if (health.status === "invalid") base = health;
      else if (health.status === "incomplete" && base.status === "ready") base = health;
    }
  } else if (evidenceIds.length > 0) {
    try {
      const resolved = await resolveCandidateEvidence(context, evidenceIds, derivation.scope);
      const expected = [...derivation.directObservation.evidenceRefs, ...derivation.contradictoryEvidenceRefs];
      if (
        resolved.refs.length !== expected.length ||
        !resolved.refs.every((reference, index) => sameCanonical(reference, expected[index]))
      ) {
        throw invalid("semantic.evidence_invalid", "derivation evidence does not match current durable lineage", []);
      }
      base = resolved.health;
    } catch (error) {
      if (!(error instanceof LearningLoopError)) throw error;
      base = {
        status: "invalid",
        diagnostics: [
          diagnostic("semantic.evidence_invalid", "error", "semantic derivation evidence is no longer valid"),
          ...error.diagnostics,
        ],
      };
    }
  } else if (committedExecutions.length === 0) {
    base = {
      status: "invalid",
      diagnostics: [diagnostic("semantic.evidence_invalid", "error", "population-only derivation is not committed")],
    };
  }
  const findings: EvidenceHealthFinding[] = [];
  for (const finding of derivation.evidenceHealthFindings) {
    try {
      findings.push(await loadExactHealthFinding(context, finding));
    } catch (error) {
      if (!(error instanceof LearningLoopError)) throw error;
      return {
        status: "invalid",
        diagnostics: [diagnostic("semantic.evidence_invalid", "error", "derivation health finding is unavailable")],
      };
    }
  }
  return mergeHealth(base, findings);
}

async function loadInsightDerivationViewOnce(
  context: EngineContext,
  derivationId: string,
  exactScopeDigest: string,
): Promise<InsightDerivationView | undefined> {
  const derivation = await loadInsightDerivationRecord(context, derivationId);
  if (derivation === undefined || derivation.scopeDigest !== exactScopeDigest) return undefined;
  const links = await loadDerivationLinks(context, derivation.id);
  const committed: Array<{ readonly link: DerivationExecutionLink; readonly execution: DetectorExecutionRecord }> = [];
  const invalidDiagnostics: Diagnostic[] = [];
  const orphanDiagnostics: Diagnostic[] = [];
  for (const link of links) {
    const snapshot = await loadRegistrySnapshot(context, link.loopRegistryRevision);
    if (snapshot === undefined || snapshot.semanticRegistry.registryDigest !== link.semanticRegistryDigest) {
      invalidDiagnostics.push(
        diagnostic("semantic.commit_invalid", "error", "derivation link registry snapshot is missing or mismatched"),
      );
      continue;
    }
    const execution = await loadDetectorExecutionRecord(context, link.executionId);
    if (execution === undefined || execution.executionDigest !== link.executionDigest) {
      orphanDiagnostics.push(
        diagnostic("semantic.commit_orphaned", "warning", "derivation link has no exact execution receipt"),
      );
      continue;
    }
    if (!executionNamesDerivation(execution, derivation)) {
      invalidDiagnostics.push(
        diagnostic("semantic.commit_invalid", "error", "execution receipt does not reciprocate its derivation link"),
      );
      continue;
    }
    const executionCommit = await resolveExecutionCommit(context, execution);
    if (executionCommit.status !== "committed") {
      invalidDiagnostics.push(
        diagnostic("semantic.commit_invalid", "error", "derivation execution receipt has an invalid output graph"),
      );
      continue;
    }
    committed.push({ link, execution });
  }
  const executionRefs = committed
    .map(({ link }) => ({
      id: link.executionId,
      executionKeyDigest: link.executionKeyDigest,
      executionDigest: link.executionDigest,
      loopRegistryRevision: link.loopRegistryRevision,
      semanticRegistryDigest: link.semanticRegistryDigest,
    }))
    .sort((left, right) => canonicalKey(left).localeCompare(canonicalKey(right)));
  const committedDigests = new Set(committed.map(({ link }) => link.executionDigest));
  const commitBinding: InsightDerivationView["commitBinding"] =
    invalidDiagnostics.length > 0
      ? { status: "invalid", diagnostics: invalidDiagnostics }
      : executionRefs.length > 0
        ? { status: "committed", executionRefs }
        : {
            status: "orphaned",
            diagnostics:
              orphanDiagnostics.length > 0
                ? orphanDiagnostics
                : [diagnostic("semantic.commit_orphaned", "warning", "derivation has no execution receipt")],
          };
  return {
    derivation,
    registryBinding: currentRegistryBinding(context, links, committedDigests),
    commitBinding,
    evidenceHealth: await derivationEvidenceHealth(
      context,
      derivation,
      committed.map(({ execution }) => execution),
    ),
  };
}

export function loadInsightDerivationView(
  context: EngineContext,
  derivationId: string,
  scope: Scope,
): Promise<InsightDerivationView | undefined> {
  const exactScope = context.scopePolicy.validate(scope);
  const exactScopeDigest = scopeDigest(exactScope);
  return loadInsightDerivationViewOnce(context, derivationId, exactScopeDigest);
}

export function loadDetectorExecutionView(
  context: EngineContext,
  executionId: string,
  scope: Scope,
): Promise<DetectorExecutionView | undefined> {
  const exactScope = context.scopePolicy.validate(scope);
  const exactScopeDigest = scopeDigest(exactScope);
  return loadDetectorExecutionViewOnce(context, executionId, exactScopeDigest);
}
