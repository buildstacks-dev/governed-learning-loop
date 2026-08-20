// Cross-record validation for semantic persistence and historical reads.
import { canonicalJsonText } from "../canonical/canonical-json.js";
import { toJsonValue } from "../canonical/to-json-value.js";
import type { Diagnostic } from "../diagnostics.js";
import { LearningLoopError } from "../diagnostics.js";
import { invalid } from "../parse/toolkit.js";
import type { DetectorExecutionRecord } from "../records/detector-execution.js";
import type { EvidenceRef } from "../records/evidence-ref.js";
import type { EpisodeRecord } from "../records/episode.js";
import { parseEpisodeRecord } from "../records/episode.js";
import type { InsightDerivation } from "../records/insight-derivation.js";
import { parseInsightDerivation } from "../records/insight-derivation.js";
import type { SemanticRegistryConfig } from "../records/semantic-registry.js";
import {
  canonicalKey,
  detectorRefKey,
  lensRefKey,
  packRefKey,
  parseBoundedArray,
  scopeDigest,
} from "../records/semantic-shared.js";
import type { EvidenceHealthFinding, SourcePageReceipt } from "../records/source-health.js";
import { parseEvidenceHealthFinding, parseSourcePageReceipt } from "../records/source-health.js";
import type { EngineContext } from "./context.js";
import { iterateRecordPages, loadStoredRecord, recordDigest } from "./context.js";
import type { DetectorEvidenceInput, EvidenceHealthView } from "./evidence-binding.js";
import { resolveDetectorEvidence } from "./evidence-binding.js";
import { loadEpisodeIdentityState } from "./episode-identity.js";
import { loadLatestEpisodeOutcomeClaim } from "./episode-outcome.js";
import {
  loadDerivationLinks,
  loadDetectorExecutionRecord,
  loadInsightDerivationRecord,
  loadRegistrySnapshot,
} from "./semantic-graph.js";

export { validateHistoricalWindowEvidence } from "./semantic-historical-evidence.js";

const MAX_DERIVATIONS = 1_000;
const SCAN_PAGE_LIMIT = 100;

export function diagnostic(code: string, severity: Diagnostic["severity"], message: string): Diagnostic {
  return { code, severity, message };
}

export function sameCanonical(left: unknown, right: unknown): boolean {
  return canonicalJsonText(toJsonValue(left)) === canonicalJsonText(toJsonValue(right));
}

function trustRank(value: EvidenceRef["trust"]): number {
  if (value === "untrusted") return 0;
  if (value === "advisory") return 1;
  if (value === "observed") return 2;
  return 3;
}

function completenessRank(value: EvidenceRef["completeness"]): number {
  if (value === "unknown") return 0;
  if (value === "partial") return 1;
  return 2;
}

function exactDetectorRef(execution: DetectorExecutionRecord): string {
  return detectorRefKey(execution.detector);
}

function exactPackRef(execution: DetectorExecutionRecord): string {
  return packRefKey(execution.pack);
}

function exactLensRef(execution: DetectorExecutionRecord): string | undefined {
  return execution.lens === null ? undefined : lensRefKey(execution.lens);
}

export function validateCurrentRegistry(context: EngineContext, execution: DetectorExecutionRecord): void {
  const registry = context.semanticRegistry;
  if (registry === undefined || execution.loopRegistryRevision !== context.registryRevision) {
    throw invalid(
      "semantic.registry_mismatch",
      "detector execution does not belong to the current semantic registry",
      [],
    );
  }
  if (
    execution.scopePolicyDigest !== context.scopePolicy.digest ||
    execution.scopePolicyDigest !== registry.scopePolicyDigest
  ) {
    throw invalid("semantic.scope_policy_mismatch", "detector execution scope policy is not current", []);
  }
  const detector = context.semanticDetectorsByRef?.get(exactDetectorRef(execution));
  const pack = context.semanticPacksByRef?.get(exactPackRef(execution));
  const executionLens = execution.lens;
  const lensKey = exactLensRef(execution);
  const lens = lensKey === undefined ? undefined : context.semanticLensesByRef?.get(lensKey);
  const selectedDetectors = new Set(registry.selectedDetectorRefs.map(detectorRefKey));
  const selectedPacks = new Set(registry.selectedPackRefs.map(packRefKey));
  const selectedLenses = new Set(registry.selectedLensRefs.map(lensRefKey));
  if (
    detector === undefined ||
    pack === undefined ||
    !selectedDetectors.has(detectorRefKey(execution.detector)) ||
    !selectedPacks.has(packRefKey(execution.pack))
  ) {
    throw invalid("semantic.registry_mismatch", "detector execution references an unselected detector or pack", []);
  }
  if (
    detector.configurationDigest !== execution.detector.configurationDigest ||
    detector.implementationDigest !== execution.detector.implementationDigest ||
    detector.outputKind !== execution.outputKind ||
    detector.scopePolicyDigest !== execution.scopePolicyDigest ||
    !pack.detectors.some((reference) => detectorRefKey(reference) === detectorRefKey(execution.detector))
  ) {
    throw invalid("semantic.registry_mismatch", "detector execution does not match its selected registration", []);
  }
  if (!isScopeAllowed(detector.scopeConstraint, execution.scopeDigest)) {
    throw invalid("semantic.scope_invalid", "execution scope is outside detector applicability", []);
  }
  if (executionLens === null) {
    if (execution.outputKind !== "evidence_health") {
      throw invalid("semantic.registry_mismatch", "insight execution has no selected learning lens", []);
    }
  } else if (
    lens === undefined ||
    !selectedLenses.has(lensRefKey(executionLens)) ||
    !pack.lenses.some((reference) => lensRefKey(reference) === lensRefKey(executionLens)) ||
    lens.scopePolicyDigest !== execution.scopePolicyDigest
  ) {
    throw invalid("semantic.registry_mismatch", "detector execution learning lens is not selected in its pack", []);
  }
  if (executionLens !== null) {
    const constraint = detector.lensConstraint;
    if (
      constraint.mode !== "required" ||
      (constraint.selection === "allowlist" &&
        !constraint.registrations.some((reference) => lensRefKey(reference) === lensRefKey(executionLens)))
    ) {
      throw invalid("semantic.lens_invalid", "execution lens is incompatible with detector registration", []);
    }
  }
  if (lens !== undefined && !isScopeAllowed(lens.applicableScopes, execution.scopeDigest)) {
    throw invalid("semantic.scope_invalid", "execution scope is outside learning lens applicability", []);
  }
  const exactProfiles = new Map(registry.sourceProfiles.map((profile) => [profile.profileDigest, profile]));
  for (const profile of execution.window.sourceProfiles) {
    if (!sameCanonical(exactProfiles.get(profile.profileDigest), profile)) {
      throw invalid("semantic.registry_mismatch", "execution window contains a non-current source profile", []);
    }
    if (profile.observationVocabularyDigest !== detector.observationVocabularyDigest) {
      throw invalid("semantic.vocabulary_mismatch", "execution window vocabulary does not match its detector", []);
    }
  }
  if (
    execution.window.population.normalizationPolicyDigest !== detector.normalizationPolicyDigest ||
    execution.window.population.comparabilityPolicyDigest !== detector.comparabilityPolicyDigest
  ) {
    throw invalid(
      "semantic.population_policy_mismatch",
      "execution population policies do not match detector registration",
      [],
    );
  }
  const available = new Set(execution.window.availableCapabilities);
  if (execution.result.status === "applied") {
    for (const capability of detector.requiredCapabilities) {
      if (!available.has(capability)) {
        throw invalid("semantic.capability_missing", "applied detector execution lacks a required capability", []);
      }
    }
  } else {
    for (const capability of execution.result.missingCapabilities) {
      if (!detector.requiredCapabilities.includes(capability)) {
        throw invalid("semantic.capability_invalid", "execution reports an undeclared missing capability", []);
      }
    }
  }
}

export function validateExecutionAgainstSnapshot(
  execution: DetectorExecutionRecord,
  registry: SemanticRegistryConfig,
): void {
  const executionLens = execution.lens;
  const detector = registry.detectors.find(
    (candidate) => detectorRefKey(candidate) === detectorRefKey(execution.detector),
  );
  const pack = registry.packs.find((candidate) => packRefKey(candidate) === packRefKey(execution.pack));
  const lens =
    executionLens === null
      ? undefined
      : registry.lenses.find((candidate) => lensRefKey(candidate) === lensRefKey(executionLens));
  if (
    detector === undefined ||
    pack === undefined ||
    execution.scopePolicyDigest !== registry.scopePolicyDigest ||
    detector.configurationDigest !== execution.detector.configurationDigest ||
    detector.implementationDigest !== execution.detector.implementationDigest ||
    detector.outputKind !== execution.outputKind ||
    !registry.selectedDetectorRefs.some(
      (reference) => detectorRefKey(reference) === detectorRefKey(execution.detector),
    ) ||
    !registry.selectedPackRefs.some((reference) => packRefKey(reference) === packRefKey(execution.pack)) ||
    !pack.detectors.some((reference) => detectorRefKey(reference) === detectorRefKey(execution.detector)) ||
    !isScopeAllowed(detector.scopeConstraint, execution.scopeDigest)
  ) {
    throw invalid("semantic.registry_mismatch", "execution does not match its durable semantic registry snapshot", []);
  }
  if (executionLens === null) {
    if (execution.outputKind !== "evidence_health") {
      throw invalid("semantic.registry_mismatch", "historical insight execution has no learning lens", []);
    }
  } else if (
    lens === undefined ||
    !registry.selectedLensRefs.some((reference) => lensRefKey(reference) === lensRefKey(executionLens)) ||
    !pack.lenses.some((reference) => lensRefKey(reference) === lensRefKey(executionLens))
  ) {
    throw invalid("semantic.registry_mismatch", "execution lens does not match its durable registry snapshot", []);
  }
  if (executionLens !== null) {
    const constraint = detector.lensConstraint;
    if (
      lens === undefined ||
      !isScopeAllowed(lens.applicableScopes, execution.scopeDigest) ||
      constraint.mode !== "required" ||
      (constraint.selection === "allowlist" &&
        !constraint.registrations.some((reference) => lensRefKey(reference) === lensRefKey(executionLens)))
    ) {
      throw invalid("semantic.lens_invalid", "execution lens is incompatible with its durable registry snapshot", []);
    }
  }
  if (
    !execution.window.sourceProfiles.every((profile) =>
      registry.sourceProfiles.some((stored) => sameCanonical(stored, profile)),
    ) ||
    execution.window.sourceProfiles.some(
      (profile) => profile.observationVocabularyDigest !== detector.observationVocabularyDigest,
    ) ||
    execution.window.population.normalizationPolicyDigest !== detector.normalizationPolicyDigest ||
    execution.window.population.comparabilityPolicyDigest !== detector.comparabilityPolicyDigest
  ) {
    throw invalid("semantic.registry_mismatch", "execution window does not match its durable registry snapshot", []);
  }
  const available = new Set(execution.window.availableCapabilities);
  if (execution.result.status === "applied") {
    if (detector.requiredCapabilities.some((capability) => !available.has(capability))) {
      throw invalid("semantic.capability_missing", "historical applied execution lacks a required capability", []);
    }
  } else if (
    execution.result.missingCapabilities.some((capability) => !detector.requiredCapabilities.includes(capability))
  ) {
    throw invalid("semantic.capability_invalid", "historical execution reports an undeclared capability", []);
  }
}

export async function validatePopulation(
  context: EngineContext,
  execution: DetectorExecutionRecord,
  registry: SemanticRegistryConfig | undefined = context.semanticRegistry,
  options: { readonly outcomeMode?: "latest" | "historical" } = {},
): Promise<void> {
  const executionLens = execution.lens;
  const detector = registry?.detectors.find(
    (candidate) => detectorRefKey(candidate) === detectorRefKey(execution.detector),
  );
  if (detector === undefined) throw invalid("semantic.registry_mismatch", "detector registration is unavailable", []);
  const detectorClasses =
    detector.episodeClasses.mode === "include" ? new Set(detector.episodeClasses.values) : undefined;
  const lens =
    executionLens === null
      ? undefined
      : registry?.lenses.find((candidate) => lensRefKey(candidate) === lensRefKey(executionLens));
  const lensClasses = lens?.episodeClasses.mode === "include" ? new Set(lens.episodeClasses.values) : undefined;
  const episodeRequirement = lens?.evidenceRequirements.find((requirement) => requirement.kind === "episode");
  if (
    execution.result.status === "applied" &&
    episodeRequirement !== undefined &&
    execution.window.population.episodes.length === 0
  ) {
    throw invalid("semantic.population_invalid", "learning lens requires nonempty episode evidence", []);
  }
  for (const episodeInput of execution.window.population.episodes) {
    const stored = await loadStoredRecord(context, "episode", episodeInput.episodeRecordId);
    if (stored === undefined || stored.digest !== episodeInput.episodeRecordDigest) {
      throw invalid("semantic.population_invalid", "execution population episode is missing or changed", []);
    }
    const episode: EpisodeRecord = parseEpisodeRecord(stored.value);
    if (episode.id !== episodeInput.episodeRecordId || scopeDigest(episode.scope) !== execution.scopeDigest) {
      throw invalid("semantic.population_invalid", "execution population episode has foreign identity or scope", []);
    }
    const identityState = await loadEpisodeIdentityState(context, episode.id);
    if (
      identityState.status !== "resolved" ||
      recordDigest(toJsonValue(identityState.identity)) !== episodeInput.episodeIdentityDigest
    ) {
      throw invalid("semantic.population_invalid", "execution population identity is unresolved or changed", []);
    }
    if (
      execution.result.status === "applied" &&
      episodeRequirement !== undefined &&
      (trustRank(identityState.identity.trustCeiling) < trustRank(episodeRequirement.minimumTrust) ||
        completenessRank(identityState.identity.completeness) <
          completenessRank(episodeRequirement.minimumCompleteness))
    ) {
      throw invalid("semantic.population_invalid", "episode identity is below learning lens evidence requirements", []);
    }
    if (detectorClasses !== undefined || lensClasses !== undefined) {
      const episodeClass = identityState.identity.episodeClass;
      if (
        episodeClass === undefined ||
        (detectorClasses !== undefined && !detectorClasses.has(episodeClass)) ||
        (lensClasses !== undefined && !lensClasses.has(episodeClass))
      ) {
        throw invalid("semantic.population_invalid", "execution population episode class is not applicable", []);
      }
    }
    const profile = execution.window.sourceProfiles.find(
      (candidate) => candidate.sourceId === identityState.identity.sourceId,
    );
    if (profile === undefined || profile.sourceRegistrationRevision !== identityState.identity.registryRevision) {
      throw invalid("semantic.population_invalid", "execution population episode has no exact source profile", []);
    }
    const outcome = await loadLatestEpisodeOutcomeClaim(context, episode.id);
    const outcomeValid =
      options.outcomeMode === "historical"
        ? episodeInput.outcomeClaimDigest === null || outcome.historyDigests.includes(episodeInput.outcomeClaimDigest)
        : (episodeInput.outcomeClaimDigest === null && outcome.status === "missing") ||
          (episodeInput.outcomeClaimDigest !== null &&
            outcome.status === "resolved" &&
            outcome.latest.claimDigest === episodeInput.outcomeClaimDigest);
    if (!outcomeValid) {
      throw invalid("semantic.population_invalid", "execution population outcome lineage is missing or changed", []);
    }
  }
}

export async function validateWindowEvidence(
  context: EngineContext,
  execution: DetectorExecutionRecord,
  registry: SemanticRegistryConfig | undefined = context.semanticRegistry,
): Promise<EvidenceHealthView> {
  if (execution.window.evidenceRefs.length === 0) return { status: "ready", diagnostics: [] };
  const exactInputs: DetectorEvidenceInput[] = [];
  const exactInputIds = new Set<string>();
  for (const reference of execution.window.evidenceRefs) {
    if (!exactInputIds.has(reference.recordId)) {
      exactInputs.push(
        reference.kind === "observation"
          ? { kind: "observation", recordId: reference.recordId }
          : { kind: "measurement", recordId: reference.recordId },
      );
      exactInputIds.add(reference.recordId);
    }
    if (reference.kind !== "measurement" || reference.schemaVersion !== 2) continue;
    for (const supporting of reference.supportingEvidenceRefs) {
      if (exactInputIds.has(supporting.recordId)) continue;
      exactInputs.push({ kind: "observation", recordId: supporting.recordId });
      exactInputIds.add(supporting.recordId);
    }
  }
  const resolved = await resolveDetectorEvidence(context, exactInputs, execution.scope);
  const resolvedById = new Map(resolved.refs.map((reference) => [reference.recordId, reference]));
  if (
    resolved.refs.length !== exactInputs.length ||
    !execution.window.evidenceRefs.every((reference) => sameCanonical(resolvedById.get(reference.recordId), reference))
  ) {
    throw invalid("semantic.evidence_invalid", "execution evidence no longer matches durable lineage", []);
  }
  const detector = registry?.detectors.find(
    (candidate) => detectorRefKey(candidate) === detectorRefKey(execution.detector),
  );
  for (const [index, reference] of resolved.refs.entries()) {
    if (reference.kind !== "observation") continue;
    const record = resolved.records[index];
    if (
      detector !== undefined &&
      (record === undefined || !("kind" in record) || !detector.acceptedObservationKinds.includes(record.kind))
    ) {
      throw invalid("semantic.observation_kind_invalid", "execution contains an unaccepted observation kind", []);
    }
  }
  if (detector !== undefined && execution.result.status === "applied") {
    for (const reference of resolved.refs) {
      if (
        trustRank(reference.trust) < trustRank(detector.minimumTrust) ||
        completenessRank(reference.completeness) < completenessRank(detector.minimumCompleteness)
      ) {
        throw invalid("semantic.evidence_incomplete", "applied execution evidence is below detector requirements", []);
      }
    }
  }
  return resolved.health;
}

export async function loadExactHealthFinding(
  context: EngineContext,
  finding: EvidenceHealthFinding,
): Promise<EvidenceHealthFinding> {
  const stored = await loadStoredRecord(context, "evidence-health", finding.id);
  if (stored === undefined)
    throw invalid("semantic.health_missing", "referenced evidence health finding is missing", []);
  const parsed = parseEvidenceHealthFinding(stored.value);
  if (parsed.id !== stored.key.id || !sameCanonical(parsed, finding)) {
    throw invalid("store.corrupt", "stored evidence health finding does not match its exact reference", []);
  }
  return parsed;
}

export async function healthFindingBelongsToWindow(
  context: EngineContext,
  execution: DetectorExecutionRecord,
  finding: EvidenceHealthFinding,
): Promise<boolean> {
  if (
    execution.window.evidenceRefs.some(
      (reference) =>
        reference.sourceId === finding.sourceId &&
        reference.sourceRegistrationRevision === finding.sourceRegistrationRevision &&
        reference.sourceRef === finding.sourceRef &&
        reference.pageRef === finding.pageRef,
    )
  ) {
    return true;
  }
  const episodes = new Set(
    execution.window.population.episodes.map((episode) =>
      canonicalKey([episode.episodeRecordId, episode.episodeRecordDigest]),
    ),
  );
  for await (const page of iterateRecordPages(context.store, "source-page-receipt", { limit: SCAN_PAGE_LIMIT })) {
    for (const stored of page.records) {
      const receipt: SourcePageReceipt = parseSourcePageReceipt(stored.value);
      if (receipt.id !== stored.key.id) {
        throw invalid("store.corrupt", "stored source page receipt id does not match its key", []);
      }
      if (
        receipt.sourceId !== finding.sourceId ||
        receipt.sourceRegistrationRevision !== finding.sourceRegistrationRevision ||
        receipt.sourceRef !== finding.sourceRef ||
        receipt.pageRef !== finding.pageRef
      ) {
        continue;
      }
      if (
        receipt.derivatives.some(
          (derivative) =>
            derivative.kind === "episode" && episodes.has(canonicalKey([derivative.id, derivative.digest])),
        )
      ) {
        return true;
      }
    }
  }
  return false;
}

export function mergeHealth(base: EvidenceHealthView, findings: readonly EvidenceHealthFinding[]): EvidenceHealthView {
  let status = base.status;
  const diagnostics = [...base.diagnostics];
  for (const finding of findings) {
    if (finding.effect === "blocks_use") status = "invalid";
    else if (status === "ready") status = "incomplete";
    diagnostics.push(
      diagnostic(
        finding.effect === "blocks_use" ? "semantic.evidence_blocked" : "semantic.evidence_limited",
        finding.effect === "blocks_use" ? "error" : "warning",
        "semantic evidence is constrained by a durable evidence-health finding",
      ),
    );
  }
  return { status, diagnostics };
}

export async function validateInputHealth(
  context: EngineContext,
  execution: DetectorExecutionRecord,
): Promise<readonly EvidenceHealthFinding[]> {
  const findings: EvidenceHealthFinding[] = [];
  for (const finding of execution.window.evidenceHealthFindings) {
    const exact = await loadExactHealthFinding(context, finding);
    if (!(await healthFindingBelongsToWindow(context, execution, exact))) {
      throw invalid("semantic.health_unrelated", "evidence health finding is unrelated to the execution window", []);
    }
    findings.push(exact);
  }
  return findings;
}

export function parseDerivations(input: unknown): readonly InsightDerivation[] {
  return parseBoundedArray(
    (value) => parseInsightDerivation(value),
    MAX_DERIVATIONS,
    "insight derivations",
  )(input, ["derivations"]);
}

function isScopeAllowed(
  constraint:
    | { readonly mode: "invocation" }
    | { readonly mode: "exact"; readonly scopes: readonly { readonly scopeDigest: string }[] },
  exactScopeDigest: string,
): boolean {
  return constraint.mode === "invocation" || constraint.scopes.some((entry) => entry.scopeDigest === exactScopeDigest);
}

export function validateDerivationAgainstExecution(
  execution: DetectorExecutionRecord,
  derivation: InsightDerivation,
  registry: SemanticRegistryConfig,
): void {
  const executionLens = execution.lens;
  const detector = registry.detectors.find(
    (candidate) => detectorRefKey(candidate) === detectorRefKey(execution.detector),
  );
  const lens =
    executionLens === null
      ? undefined
      : registry.lenses.find((candidate) => lensRefKey(candidate) === lensRefKey(executionLens));
  if (
    detector === undefined ||
    lens === undefined ||
    execution.outputKind !== "insight_derivation" ||
    derivation.detector.id !== execution.detector.id ||
    derivation.detector.version !== execution.detector.version ||
    derivation.detector.registrationDigest !== execution.detector.registrationDigest ||
    derivation.detector.configurationDigest !== execution.detector.configurationDigest ||
    !sameCanonical(derivation.pack, execution.pack) ||
    !sameCanonical(derivation.lens, execution.lens) ||
    derivation.scopeDigest !== execution.scopeDigest ||
    derivation.scopePolicyDigest !== execution.scopePolicyDigest
  ) {
    throw invalid("semantic.derivation_mismatch", "insight derivation does not match its detector execution", []);
  }
  if (
    derivation.population.normalizationPolicyDigest !== execution.window.population.normalizationPolicyDigest ||
    derivation.population.comparabilityPolicyDigest !== execution.window.population.comparabilityPolicyDigest ||
    derivation.population.episodes.length !== execution.window.population.episodes.length ||
    !derivation.population.episodes.every((episode, index) => {
      const exact = execution.window.population.episodes[index];
      return (
        exact !== undefined &&
        episode.episodeRecordId === exact.episodeRecordId &&
        episode.episodeViewDigest === exact.episodeViewDigest &&
        episode.scopeDigest === exact.scopeDigest
      );
    })
  ) {
    throw invalid("semantic.derivation_mismatch", "insight population does not match its execution window", []);
  }
  const windowEvidence = new Set(execution.window.evidenceRefs.map((reference) => reference.referenceDigest));
  const derivationEvidence = [...derivation.directObservation.evidenceRefs, ...derivation.contradictoryEvidenceRefs];
  for (const reference of derivationEvidence) {
    if (!windowEvidence.has(reference.referenceDigest)) {
      throw invalid(
        "semantic.derivation_mismatch",
        "insight derivation cites evidence outside its execution window",
        [],
      );
    }
  }
  const availableHealth = new Set([
    ...execution.window.evidenceHealthFindings.map((finding) => finding.findingDigest),
    ...(execution.result.status === "applied"
      ? execution.result.evidenceHealthFindings.map((finding) => finding.findingDigest)
      : []),
  ]);
  if (derivation.evidenceHealthFindings.some((finding) => !availableHealth.has(finding.findingDigest))) {
    throw invalid("semantic.derivation_mismatch", "insight derivation cites health outside its execution window", []);
  }
  const producer = derivation.producer;
  const requiredFingerprintPresent = lens.requiredFingerprintKinds.every((kind) => {
    if (kind === "implementation") return producer.implementationDigest === execution.detector.implementationDigest;
    if (kind === "model") return producer.modelFingerprintDigest !== null;
    if (kind === "prompt") return producer.promptDigest !== null;
    if (kind === "tool") return producer.toolPolicyDigest !== null;
    if (kind === "budget") return producer.budgetPolicyDigest !== null;
    return false;
  });
  const producerValid =
    producer.kind === "deterministic"
      ? producer.implementationDigest === execution.detector.implementationDigest &&
        producer.principal === null &&
        producer.attestation === null &&
        producer.modelFingerprintDigest === null &&
        producer.promptDigest === null &&
        producer.toolPolicyDigest === null &&
        producer.budgetPolicyDigest === null &&
        producer.disclosure === null
      : producer.kind === "semantic_judgment"
        ? producer.implementationDigest === execution.detector.implementationDigest &&
          producer.principal !== null &&
          producer.attestation !== null &&
          ((detector.privacy.transientContent === "memory_only" && producer.disclosure === null) ||
            (detector.privacy.transientContent === "explicit_disclosure_receipt" && producer.disclosure !== null))
        : false;
  if (
    !lens.generatorPolicy.allowedKinds.includes(producer.kind) ||
    !requiredFingerprintPresent ||
    !producerValid ||
    lens.requiredCalibrationIds.length !== 0 ||
    !lens.learningClasses.includes(derivation.learningClass) ||
    !isScopeAllowed(lens.applicableScopes, derivation.scopeDigest)
  ) {
    throw invalid(
      "semantic.derivation_policy_invalid",
      "insight derivation producer does not satisfy its learning lens",
      [],
    );
  }
  for (const requirement of lens.evidenceRequirements) {
    if (requirement.kind === "episode") continue;
    const matching = derivationEvidence.filter((reference) => reference.kind === requirement.kind);
    if (
      matching.length === 0 ||
      matching.some(
        (reference) =>
          trustRank(reference.trust) < trustRank(requirement.minimumTrust) ||
          completenessRank(reference.completeness) < completenessRank(requirement.minimumCompleteness),
      )
    ) {
      throw invalid("semantic.derivation_policy_invalid", "derivation evidence does not satisfy its lens", []);
    }
  }
  const permittedEvidenceKinds = new Set(
    lens.evidenceRequirements
      .filter((requirement) => requirement.kind !== "episode")
      .map((requirement) => requirement.kind),
  );
  if (derivationEvidence.some((reference) => !permittedEvidenceKinds.has(reference.kind))) {
    throw invalid(
      "semantic.derivation_policy_invalid",
      "derivation contains an evidence kind its lens did not permit",
      [],
    );
  }
  if (derivation.candidateIntervention !== null) {
    const intervention = derivation.candidateIntervention;
    if (!lens.permittedDestinationKinds.includes(intervention.proposedDestinationKind)) {
      throw invalid("semantic.derivation_policy_invalid", "derivation destination kind is not permitted", []);
    }
    if (
      intervention.proposedDestinationId !== null &&
      !lens.permittedDestinationIds.includes(intervention.proposedDestinationId)
    ) {
      throw invalid("semantic.derivation_policy_invalid", "derivation destination id is not permitted", []);
    }
    if (derivation.validation?.strategyDigest !== lens.validationStrategyDigest) {
      throw invalid("semantic.derivation_policy_invalid", "derivation validation strategy is not permitted", []);
    }
  }
}

export function expectedDerivationRefs(execution: DetectorExecutionRecord): readonly {
  readonly id: string;
  readonly derivationDigest: string;
  readonly scopeDigest: string;
}[] {
  return execution.result.status === "applied" ? execution.result.derivationRefs : [];
}

export function validateDerivationBundle(
  context: EngineContext,
  execution: DetectorExecutionRecord,
  derivations: readonly InsightDerivation[],
): void {
  const registry = context.semanticRegistry;
  if (registry === undefined) throw invalid("semantic.registry_required", "semantic registry is unavailable", []);
  const references = expectedDerivationRefs(execution);
  if (references.length !== derivations.length) {
    throw invalid("semantic.derivation_mismatch", "execution derivation outputs do not match the supplied bundle", []);
  }
  for (const [index, reference] of references.entries()) {
    const derivation = derivations[index];
    if (
      derivation === undefined ||
      derivation.id !== reference.id ||
      derivation.derivationDigest !== reference.derivationDigest ||
      derivation.scopeDigest !== reference.scopeDigest
    ) {
      throw invalid("semantic.derivation_mismatch", "execution derivation reference does not match supplied bytes", []);
    }
    validateDerivationAgainstExecution(execution, derivation, registry);
  }
}

async function executionGraphIsReciprocal(
  context: EngineContext,
  execution: DetectorExecutionRecord,
): Promise<boolean> {
  const snapshot = await loadRegistrySnapshot(context, execution.loopRegistryRevision);
  if (snapshot === undefined) return false;
  try {
    validateExecutionAgainstSnapshot(execution, snapshot.semanticRegistry);
  } catch (error) {
    if (error instanceof LearningLoopError) return false;
    throw error;
  }
  if (execution.result.status !== "applied") return true;
  for (const finding of execution.result.evidenceHealthFindings) {
    try {
      const exact = await loadExactHealthFinding(context, finding);
      if (!(await healthFindingBelongsToWindow(context, execution, exact))) return false;
    } catch (error) {
      if (error instanceof LearningLoopError) return false;
      throw error;
    }
  }
  for (const reference of execution.result.derivationRefs) {
    const derivation = await loadInsightDerivationRecord(context, reference.id);
    if (
      derivation === undefined ||
      derivation.derivationDigest !== reference.derivationDigest ||
      derivation.scopeDigest !== reference.scopeDigest
    ) {
      return false;
    }
    try {
      validateDerivationAgainstExecution(execution, derivation, snapshot.semanticRegistry);
    } catch (error) {
      if (error instanceof LearningLoopError) return false;
      throw error;
    }
    const links = await loadDerivationLinks(context, reference.id);
    if (
      !links.some(
        (link) =>
          link.executionId === execution.id &&
          link.executionDigest === execution.executionDigest &&
          link.derivationDigest === reference.derivationDigest &&
          link.scopeDigest === reference.scopeDigest &&
          link.loopRegistryRevision === execution.loopRegistryRevision &&
          link.semanticRegistryDigest === snapshot.semanticRegistry.registryDigest,
      )
    ) {
      return false;
    }
  }
  return true;
}

export async function validateDerivationSupersessions(
  context: EngineContext,
  derivations: readonly InsightDerivation[],
): Promise<void> {
  for (const derivation of derivations) {
    const supersedes = derivation.supersedes;
    if (supersedes === null) continue;
    const predecessor = await loadInsightDerivationRecord(context, supersedes.id);
    if (
      predecessor === undefined ||
      predecessor.derivationDigest !== supersedes.derivationDigest ||
      predecessor.scopeDigest !== supersedes.scopeDigest ||
      predecessor.scopeDigest !== derivation.scopeDigest
    ) {
      throw invalid(
        "semantic.supersedes_invalid",
        "superseded derivation is missing or does not match exact scope",
        [],
      );
    }
    const links = await loadDerivationLinks(context, predecessor.id);
    let committed = false;
    for (const link of links) {
      if (link.derivationDigest !== predecessor.derivationDigest || link.scopeDigest !== predecessor.scopeDigest) {
        continue;
      }
      const execution = await loadDetectorExecutionRecord(context, link.executionId);
      if (
        execution !== undefined &&
        execution.executionDigest === link.executionDigest &&
        execution.result.status === "applied" &&
        execution.result.derivationRefs.some(
          (reference) =>
            reference.id === predecessor.id &&
            reference.derivationDigest === predecessor.derivationDigest &&
            reference.scopeDigest === predecessor.scopeDigest,
        ) &&
        (await executionGraphIsReciprocal(context, execution))
      ) {
        committed = true;
        break;
      }
    }
    if (!committed) {
      throw invalid("semantic.supersedes_invalid", "superseded derivation has no committed reciprocal execution", []);
    }
  }
}
