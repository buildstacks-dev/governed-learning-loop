// Engine-private receipt-last persistence and read graph for semantic facts.
// Public parsing grants no store authority; only kernel orchestration calls
// persistDetectorExecution.
import { LearningLoopError } from "../diagnostics.js";
import { invalid } from "../parse/toolkit.js";
import type { DetectorExecutionRecord } from "../records/detector-execution.js";
import { parseDetectorExecutionRecord } from "../records/detector-execution.js";
import type { InsightDerivation } from "../records/insight-derivation.js";
import type { EngineContext } from "./context.js";
import { createOnly } from "./context.js";
import {
  appendDerivationLink,
  buildDerivationLink,
  buildRegistrySnapshot,
  loadDerivationLinks,
  loadDetectorExecutionRecord,
  loadInsightDerivationRecord,
  persistRegistrySnapshot,
  semanticGraphSnapshotRevision,
  parseSemanticRegistrySnapshot,
} from "./semantic-graph.js";
import type { SemanticRegistrySnapshot } from "./semantic-graph.js";
import {
  diagnostic,
  expectedDerivationRefs,
  healthFindingBelongsToWindow,
  mergeHealth,
  parseDerivations,
  validateCurrentRegistry,
  validateDerivationAgainstExecution,
  validateDerivationBundle,
  validateDerivationSupersessions,
  validateInputHealth,
  validateExecutionAgainstSnapshot,
  validateHistoricalWindowEvidence,
  validatePopulation,
  validateWindowEvidence,
} from "./semantic-validation.js";
import { persistHealthFinding } from "./source-receipts.js";
import { persistDetectorExecutionScopeIndex, persistInsightDerivationScopeIndex } from "./semantic-scope-index.js";
import {
  buildDerivationRecurrenceClaims,
  loadCommittedDerivationRecurrenceClaims,
  persistDerivationRecurrenceClaims,
} from "./recurrence-claims.js";
import type { ExecutionRecurrenceBinding } from "./detector-recurrence.js";
import {
  persistPreparedExecutionRecurrence,
  prepareExecutionRecurrence,
  recurrenceForExecution,
  loadExecutionRecurrenceBinding,
} from "./detector-recurrence.js";
import {
  loadSemanticWorkflowCompletionIntent,
  validateSemanticWorkflowExecutionPrewriteLineage,
} from "../workflows/semantic-generation-persistence.js";

const MAX_SNAPSHOT_ATTEMPTS = 3;

async function persistDerivation(context: EngineContext, derivation: InsightDerivation): Promise<void> {
  const status = await createOnly(
    context,
    "insight-derivation",
    derivation.id,
    derivation,
    `insight-derivation/${derivation.id}`,
  );
  if (status === "conflict") throw invalid("store.corrupt", "insight derivation id collision", []);
}

async function persistDerivationAndIndex(context: EngineContext, derivation: InsightDerivation): Promise<void> {
  try {
    await persistDerivation(context, derivation);
  } catch (error) {
    const stored = await loadInsightDerivationRecord(context, derivation.id);
    if (stored !== undefined && stored.derivationDigest === derivation.derivationDigest) {
      await persistInsightDerivationScopeIndex(context, derivation);
    }
    throw error;
  }
  await persistInsightDerivationScopeIndex(context, derivation);
}

async function persistExecutionReceipt(context: EngineContext, execution: DetectorExecutionRecord): Promise<void> {
  const status = await createOnly(
    context,
    "detector-execution",
    execution.id,
    execution,
    `detector-execution/${execution.id}/${execution.executionDigest}`,
  );
  if (status === "conflict") {
    throw new LearningLoopError("semantic.execution_conflict", [
      diagnostic("semantic.execution_conflict", "error", "the exact detector invocation already has another result"),
    ]);
  }
}

async function validatePrewriteBundle(
  context: EngineContext,
  execution: DetectorExecutionRecord,
  derivations: readonly InsightDerivation[],
): Promise<void> {
  validateCurrentRegistry(context, execution);
  validateDerivationBundle(context, execution, derivations);
  await validateDerivationSupersessions(context, derivations);
  await validateSemanticWorkflowExecutionPrewriteLineage(context, execution, derivations);
  await validatePopulation(context, execution);
  const evidence = await validateWindowEvidence(context, execution);
  const inputFindings = await validateInputHealth(context, execution);
  const inputHealth = mergeHealth(evidence, inputFindings);
  if (execution.result.status === "applied" && inputHealth.status === "invalid") {
    throw invalid("semantic.evidence_invalid", "applied execution is blocked by invalid input evidence", []);
  }
  if (execution.result.status === "applied") {
    for (const finding of execution.result.evidenceHealthFindings) {
      if (!(await healthFindingBelongsToWindow(context, execution, finding))) {
        throw invalid("semantic.health_unrelated", "execution output health finding is unrelated to its window", []);
      }
    }
  }
}

/** Kernel-private receipt-last commit; no public façade delegates to this function. */
export async function persistDetectorExecution(
  context: EngineContext,
  executionInput: unknown,
  derivationsInput: unknown,
  recurrenceLocatorInput?: unknown,
): Promise<void> {
  const execution = parseDetectorExecutionRecord(executionInput);
  const derivations = parseDerivations(derivationsInput);
  let stable = false;
  let recurrenceBinding: ExecutionRecurrenceBinding | undefined;
  for (let attempt = 0; attempt < MAX_SNAPSHOT_ATTEMPTS; attempt += 1) {
    const before = await semanticGraphSnapshotRevision(context);
    try {
      await validatePrewriteBundle(context, execution, derivations);
      recurrenceBinding = await prepareExecutionRecurrence(context, execution, recurrenceLocatorInput);
    } catch (error) {
      if (
        error instanceof LearningLoopError &&
        (error.code === "evidence.snapshot_changed" || error.code === "semantic.snapshot_changed")
      ) {
        continue;
      }
      throw error;
    }
    const after = await semanticGraphSnapshotRevision(context);
    if (before === after) {
      stable = true;
      break;
    }
  }
  if (!stable) {
    throw new LearningLoopError("semantic.snapshot_changed", [
      diagnostic("semantic.snapshot_changed", "error", "semantic evidence changed repeatedly before persistence"),
    ]);
  }

  const snapshot = buildRegistrySnapshot(context);
  await persistRegistrySnapshot(context, snapshot);
  if (execution.result.status === "applied") {
    for (const finding of execution.result.evidenceHealthFindings) await persistHealthFinding(context, finding);
  }
  const links = expectedDerivationRefs(execution).map((reference) =>
    buildDerivationLink(execution, snapshot.semanticRegistry.registryDigest, reference),
  );
  for (const link of links) await appendDerivationLink(context, link);
  for (const derivation of derivations) {
    await persistDerivationAndIndex(context, derivation);
  }
  await persistDetectorExecutionScopeIndex(context, execution);
  if (recurrenceBinding !== undefined) {
    await persistPreparedExecutionRecurrence(context, recurrenceBinding);
  }
  const derivationRecurrenceClaims = buildDerivationRecurrenceClaims(execution, recurrenceBinding, derivations);
  await persistDerivationRecurrenceClaims(context, derivationRecurrenceClaims);
  await persistExecutionReceipt(context, execution);

  const reloaded = await loadDetectorExecutionRecord(context, execution.id);
  if (reloaded === undefined || reloaded.executionDigest !== execution.executionDigest) {
    throw invalid("store.corrupt", "detector execution receipt was not preserved", []);
  }
  if (recurrenceBinding !== undefined) {
    const recurrence = await recurrenceForExecution(context, reloaded, recurrenceBinding.locator);
    if (
      (recurrenceBinding.locator === null && recurrence.status !== "locator_unavailable") ||
      (recurrenceBinding.locator !== null &&
        (recurrence.status !== "grouped" || recurrence.groupKeyDigest !== recurrenceBinding.groupKeyDigest))
    ) {
      throw invalid("store.corrupt", "detector recurrence lineage was not preserved", []);
    }
  }
  for (const derivation of derivations) {
    const stored = await loadInsightDerivationRecord(context, derivation.id);
    const storedLinks = await loadDerivationLinks(context, derivation.id);
    if (
      stored === undefined ||
      stored.derivationDigest !== derivation.derivationDigest ||
      !storedLinks.some((link) => links.some((expected) => expected.linkDigest === link.linkDigest))
    ) {
      throw invalid("store.corrupt", "semantic execution graph was not preserved", []);
    }
  }
  for (const expected of derivationRecurrenceClaims) {
    const claims = await loadCommittedDerivationRecurrenceClaims(
      context,
      expected.derivationId,
      expected.derivationDigest,
    );
    if (!claims.some((claim) => claim.claimDigest === expected.claimDigest)) {
      throw invalid("store.corrupt", "derivation recurrence claim was not preserved", []);
    }
  }
}

/**
 * #13b recovery path. It consumes the registry snapshot frozen in the first
 * post-callback completion intent and never substitutes the latest registry or
 * rematerializes a different detector window.
 */
export async function persistSemanticWorkflowDetectorExecution(
  context: EngineContext,
  executionInput: unknown,
  derivationsInput: unknown,
  registrySnapshotInput: unknown,
): Promise<void> {
  const execution = parseDetectorExecutionRecord(executionInput);
  const derivations = parseDerivations(derivationsInput);
  const snapshot: SemanticRegistrySnapshot = parseSemanticRegistrySnapshot(registrySnapshotInput);
  if (snapshot.loopRegistryRevision !== execution.loopRegistryRevision) {
    throw invalid("semantic.registry_mismatch", "workflow registry snapshot belongs to another execution", []);
  }
  validateExecutionAgainstSnapshot(execution, snapshot.semanticRegistry);
  const exactReferences = expectedDerivationRefs(execution);
  if (
    exactReferences.length !== derivations.length ||
    !exactReferences.every((reference, index) => {
      const derivation = derivations[index];
      return (
        derivation !== undefined &&
        derivation.id === reference.id &&
        derivation.derivationDigest === reference.derivationDigest &&
        derivation.scopeDigest === reference.scopeDigest
      );
    })
  ) {
    throw invalid("semantic.derivation_mismatch", "workflow derivations do not match the exact execution", []);
  }
  for (const derivation of derivations) {
    validateDerivationAgainstExecution(execution, derivation, snapshot.semanticRegistry);
  }
  await validateDerivationSupersessions(context, derivations);
  await validatePopulation(context, execution, snapshot.semanticRegistry, { outcomeMode: "historical" });
  const evidence = await validateHistoricalWindowEvidence(context, execution, snapshot.semanticRegistry, {
    includeCurrentHealth: false,
  });
  const inputFindings = await validateInputHealth(context, execution);
  const inputHealth = mergeHealth(evidence, inputFindings);
  if (execution.result.status === "applied" && inputHealth.status === "invalid") {
    throw invalid("semantic.evidence_invalid", "semantic workflow evidence is invalid", []);
  }
  if (execution.result.status === "applied") {
    for (const finding of execution.result.evidenceHealthFindings) {
      if (!(await healthFindingBelongsToWindow(context, execution, finding))) {
        throw invalid("semantic.health_unrelated", "workflow health output is unrelated to its exact window", []);
      }
    }
  }
  await validateSemanticWorkflowExecutionPrewriteLineage(context, execution, derivations);
  const completionIntent = await loadSemanticWorkflowCompletionIntent(context, execution.executionKeyDigest);
  if (completionIntent === undefined || completionIntent.registrySnapshot.snapshotDigest !== snapshot.snapshotDigest) {
    throw invalid("semantic.workflow_incomplete", "semantic workflow recovery intent is unavailable", []);
  }

  await persistRegistrySnapshot(context, snapshot);
  if (execution.result.status === "applied") {
    for (const finding of execution.result.evidenceHealthFindings) await persistHealthFinding(context, finding);
  }
  const links = expectedDerivationRefs(execution).map((reference) =>
    buildDerivationLink(execution, snapshot.semanticRegistry.registryDigest, reference),
  );
  for (const link of links) await appendDerivationLink(context, link);
  for (const derivation of derivations) await persistDerivationAndIndex(context, derivation);
  await persistDetectorExecutionScopeIndex(context, execution);
  if (completionIntent.recurrenceBinding !== null) {
    await persistPreparedExecutionRecurrence(context, completionIntent.recurrenceBinding);
  }
  const derivationRecurrenceClaims = buildDerivationRecurrenceClaims(
    execution,
    completionIntent.recurrenceBinding ?? undefined,
    derivations,
  );
  await persistDerivationRecurrenceClaims(context, derivationRecurrenceClaims);
  await persistExecutionReceipt(context, execution);

  const reloaded = await loadDetectorExecutionRecord(context, execution.id);
  if (reloaded === undefined || reloaded.executionDigest !== execution.executionDigest) {
    throw invalid("store.corrupt", "semantic workflow execution receipt was not preserved", []);
  }
  if (completionIntent.recurrenceBinding !== null) {
    const storedRecurrence = await loadExecutionRecurrenceBinding(context, execution.id);
    if (storedRecurrence?.bindingDigest !== completionIntent.recurrenceBinding.bindingDigest) {
      throw invalid("store.corrupt", "semantic workflow recurrence binding was not preserved", []);
    }
  }
  for (const derivation of derivations) {
    const stored = await loadInsightDerivationRecord(context, derivation.id);
    const storedLinks = await loadDerivationLinks(context, derivation.id);
    if (
      stored === undefined ||
      stored.derivationDigest !== derivation.derivationDigest ||
      !storedLinks.some((link) => links.some((expected) => expected.linkDigest === link.linkDigest))
    ) {
      throw invalid("store.corrupt", "semantic workflow derivation graph was not preserved", []);
    }
  }
}

export type { DetectorExecutionView, InsightDerivationView } from "./semantic-views.js";
export { loadDetectorExecutionView, loadInsightDerivationView } from "./semantic-views.js";
