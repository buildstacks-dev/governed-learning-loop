import type { DetectorWindow } from "../engine/detector-window.js";
import { materializeDetectorWindow } from "../engine/detector-window.js";
import type { LearningLoop } from "../engine/loop.js";
import { contextForLearningLoop } from "../engine/loop.js";
import { assertVerifiedPrincipal } from "../engine/identity.js";
import { invalid } from "../parse/toolkit.js";
import { canonicalJsonText, sha256HexOfCanonicalJson } from "../canonical/canonical-json.js";
import { toJsonValue } from "../canonical/to-json-value.js";
import type { VerifiedPrincipal } from "../records/principal.js";
import {
  assertSortedUnique,
  detectorRefKey,
  lensRefKey,
  packRefKey,
  parseDetectorRefAt,
  parseDigestAt,
  parseDurableId,
  parseLensRefAt,
  parsePackRefAt,
  scopeDigest,
} from "../records/semantic-shared.js";
import type { SemanticWorkflowBundle } from "./types.js";
import {
  ADVISORY_REVIEW_RESULT_SCHEMA,
  ADVISORY_REVIEW_RESULT_SCHEMA_DIGEST,
  ADVISORY_REVIEW_RESULT_SCHEMA_ID,
  ADVISORY_REVIEW_RESULT_SCHEMA_VERSION,
  defineAdvisoryReview,
  defineGeneration,
  GENERATION_RESULT_SCHEMA,
  GENERATION_RESULT_SCHEMA_DIGEST,
  GENERATION_RESULT_SCHEMA_ID,
  GENERATION_RESULT_SCHEMA_VERSION,
} from "./generation-schema.js";
import { getTurn, queryTurns } from "./generation-query.js";
import { authorizeGeneration, recoverGeneration, runGeneration } from "./generation-run.js";
import type { CapabilityCallbacks, PreparedPlanBinding } from "./generation-internal.js";
import { bytesOf, preparedPlans } from "./generation-internal.js";
import { parseSemanticWorkflowDefinition, SEMANTIC_WORKFLOW_MAX_DURATION_MS } from "./workflow-definition.js";
import {
  assertSemanticWorkflowStructureBound,
  parseSemanticWorkflowArray,
  readSemanticWorkflowFields as readFields,
} from "./workflow-structure.js";
import { assembleAppliedDetectorResult } from "../engine/detector-draft.js";
import { buildRegistrySnapshot, loadDetectorExecutionRecord } from "../engine/semantic-graph.js";
import { loadSemanticWorkflowChildViews } from "../engine/semantic-views.js";
import { semanticGraphSnapshotRevision } from "../engine/semantic-graph.js";
import type { SemanticWorkflowDefinition } from "./workflow-definition.js";
import type { EngineContext } from "../engine/context.js";
import { buildSemanticTurnReservation } from "./semantic-turn-intent.js";
import {
  buildSemanticWorkflowAttemptIndex,
  buildSemanticWorkflowExecutionPlanLock,
} from "./semantic-generation-record.js";
import {
  loadSemanticGenerationTurnByScope,
  loadSemanticWorkflowExecutionBinding,
} from "./semantic-generation-persistence.js";

interface SemanticWorkflowBundleConfig {
  readonly schemaVersion: number;
  readonly loop: LearningLoop;
  readonly definition: unknown;
  readonly producer?: VerifiedPrincipal;
  readonly reviewer?: VerifiedPrincipal;
  readonly renderer: {
    readonly rendererDigest: string;
    readonly render: (input: { readonly window: DetectorWindow; readonly definitionDigest: string }) => unknown;
  };
  readonly minimizer: {
    readonly minimizationPolicyDigest: string;
    readonly minimize: (input: { readonly rendered: unknown; readonly windowDigest: string }) => unknown;
  };
  readonly keyedDigester: {
    readonly keyPolicyDigest: string;
    readonly digest: (bytes: Uint8Array) => unknown;
  };
  readonly tokenEstimator: {
    readonly tokenEstimatorDigest: string;
    readonly estimateInputTokens: (bytes: Uint8Array) => unknown;
  };
  readonly provider: {
    readonly registrationDigest: string;
    readonly invoke: (input: {
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
  };
  readonly disclosureAuthority?: {
    readonly authorizationPolicyDigest: string;
    readonly authorize: (input: {
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
  };
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

type UnknownCallback = (input: unknown) => unknown;

function callSync(callback: UnknownCallback, input: unknown): unknown {
  try {
    return callback(input);
  } catch {
    throw invalid("semantic.workflow_callback_failed", "semantic workflow capability failed", []);
  }
}

function callAsync(callback: UnknownCallback, input: unknown): Promise<unknown> {
  try {
    const returned = callback(input);
    const pending = returned instanceof Promise ? returned : Promise.resolve(returned);
    return pending.catch(() => {
      throw invalid("semantic.workflow_callback_failed", "semantic workflow capability failed", []);
    });
  } catch {
    return Promise.reject(invalid("semantic.workflow_callback_failed", "semantic workflow capability failed", []));
  }
}

function parseCanonicalTimestamp(input: unknown, path: readonly (string | number)[]): string {
  if (typeof input !== "string") throw invalid("schema.invalid", "timestamp must be a string", path);
  const milliseconds = Date.parse(input);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== input) {
    throw invalid("schema.invalid", "timestamp must be canonical RFC 3339 UTC with milliseconds", path);
  }
  return input;
}

function parseNonnegativeInteger(input: unknown, path: readonly (string | number)[]): number {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input < 0) {
    throw invalid("schema.invalid", "value must be a nonnegative safe integer", path);
  }
  return input;
}

function parseKeyedDigest(callback: CapabilityCallbacks["digest"], bytes: Uint8Array): string {
  return parseDigestAt(callback(new Uint8Array(bytes)), ["keyedDigester", "result"]);
}

function estimateTokens(callback: CapabilityCallbacks["estimateInputTokens"], bytes: Uint8Array): number {
  return parseNonnegativeInteger(callback(new Uint8Array(bytes)), ["tokenEstimator", "result"]);
}

function exactSelection(
  context: EngineContext,
  definition: SemanticWorkflowDefinition,
  input: unknown,
): {
  readonly detector: NonNullable<EngineContext["semanticRegistry"]>["detectors"][number];
  readonly pack: NonNullable<EngineContext["semanticRegistry"]>["packs"][number];
  readonly lens: NonNullable<EngineContext["semanticRegistry"]>["lenses"][number];
  readonly detectorRef: ReturnType<typeof parseDetectorRefAt>;
  readonly packRef: ReturnType<typeof parsePackRefAt>;
  readonly lensRef: ReturnType<typeof parseLensRefAt>;
  readonly scope: DetectorWindow["scope"];
  readonly episodeRecordIds: readonly string[];
  readonly expiresAt: string;
} {
  const fields = readFields(input, ["prepareGeneration"]);
  const detectorRef = fields.req("detector", parseDetectorRefAt);
  const packRef = fields.req("pack", parsePackRefAt);
  const lensRef = fields.req("lens", parseLensRefAt);
  const episodeRecordIds = fields.req(
    "episodeRecordIds",
    parseSemanticWorkflowArray(parseDurableId, definition.budgetPolicy.maximumEpisodes, "workflow episode ids"),
  );
  assertSortedUnique(episodeRecordIds, (value) => value, ["episodeRecordIds"]);
  const scope = Object.freeze(
    context.scopePolicy
      .validate(fields.req("scope", (value) => value))
      .map((segment) => Object.freeze({ type: segment.type, id: segment.id })),
  );
  const expiresAt = fields.req("expiresAt", parseCanonicalTimestamp);
  const now = Date.parse(context.clock.now());
  const expiry = Date.parse(expiresAt);
  if (expiry <= now || expiry - now > SEMANTIC_WORKFLOW_MAX_DURATION_MS) {
    throw invalid("schema.invalid", "workflow plan expiry must be within the next 24 hours", ["expiresAt"]);
  }
  const registry = context.semanticRegistry;
  const detector = context.semanticDetectorsByRef?.get(detectorRefKey(detectorRef));
  const pack = context.semanticPacksByRef?.get(packRefKey(packRef));
  const lens = context.semanticLensesByRef?.get(lensRefKey(lensRef));
  const detectorConfiguration = detector === undefined ? undefined : readFields(detector.configuration, ["detector"]);
  const workflowDefinitionDigest = detectorConfiguration?.req("workflowDefinitionDigest", parseDigestAt);
  const lensCompatible =
    detector?.lensConstraint.mode === "required" &&
    (detector.lensConstraint.selection === "any_registered" ||
      detector.lensConstraint.registrations.some((reference) => lensRefKey(reference) === lensRefKey(lensRef)));
  if (
    registry === undefined ||
    detector === undefined ||
    pack === undefined ||
    lens === undefined ||
    !registry.selectedDetectorRefs.some((reference) => detectorRefKey(reference) === detectorRefKey(detectorRef)) ||
    !registry.selectedPackRefs.some((reference) => packRefKey(reference) === packRefKey(packRef)) ||
    !registry.selectedLensRefs.some((reference) => lensRefKey(reference) === lensRefKey(lensRef)) ||
    !pack.detectors.some((reference) => detectorRefKey(reference) === detectorRefKey(detectorRef)) ||
    !pack.lenses.some((reference) => lensRefKey(reference) === lensRefKey(lensRef)) ||
    detector.outputKind !== "insight_derivation" ||
    detector.implementationDigest !== definition.implementation.implementationDigest ||
    workflowDefinitionDigest !== definition.definitionDigest ||
    !lensCompatible ||
    !lens.generatorPolicy.allowedKinds.includes("semantic_judgment") ||
    lens.generatorPolicy.allowedKinds.some((kind) => kind !== "semantic_judgment") ||
    lens.requiredCalibrationIds.length !== 0 ||
    [...lens.requiredFingerprintKinds].sort(compareText).join("|") !==
      ["budget", "implementation", "model", "prompt", "tool"].sort(compareText).join("|") ||
    context.detectorImplementationsByRef?.has(detectorRefKey(detectorRef)) === true
  ) {
    throw invalid("semantic.workflow_definition_mismatch", "semantic generation selection is unavailable", []);
  }
  const privacyEligible =
    definition.transport === "outbound"
      ? detector.privacy.transientContent === "explicit_disclosure_receipt" &&
        lens.privacy.outboundDisclosure === "explicit_disclosure_receipt"
      : detector.privacy.transientContent === "memory_only";
  if (!privacyEligible) {
    throw invalid("semantic.workflow_disclosure_forbidden", "semantic generation privacy policy forbids use", []);
  }
  return { detector, pack, lens, detectorRef, packRef, lensRef, scope, episodeRecordIds, expiresAt };
}

async function materializeStable(
  context: EngineContext,
  selection: ReturnType<typeof exactSelection>,
): Promise<Awaited<ReturnType<typeof materializeDetectorWindow>>> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const before = await semanticGraphSnapshotRevision(context);
    const materialized = await materializeDetectorWindow({
      context,
      detector: selection.detector,
      pack: selection.packRef,
      lens: selection.lensRef,
      lensRegistration: selection.lens,
      scope: selection.scope,
      episodeRecordIds: selection.episodeRecordIds,
    });
    const after = await semanticGraphSnapshotRevision(context);
    if (before === after) return materialized;
  }
  throw invalid("semantic.workflow_snapshot_changed", "semantic generation input changed repeatedly", []);
}

function renderRequest(
  callbacks: CapabilityCallbacks,
  definition: SemanticWorkflowDefinition,
  window: DetectorWindow,
): {
  readonly text: string;
  readonly byteLength: number;
  readonly digest: string;
  readonly estimatedInputTokens: number;
} {
  const rendered = callbacks.render({ window, definitionDigest: definition.definitionDigest });
  assertSemanticWorkflowStructureBound(rendered);
  const minimized = callbacks.minimize({ rendered, windowDigest: window.windowDigest });
  assertSemanticWorkflowStructureBound(minimized);
  const instructions = toJsonValue(minimized);
  const text = canonicalJsonText(
    toJsonValue({
      schemaVersion: 1,
      definition: {
        id: definition.id,
        version: definition.version,
        definitionDigest: definition.definitionDigest,
      },
      prompt: definition.prompt,
      instructions,
      window,
    }),
  );
  const bytes = bytesOf(text);
  if (bytes.byteLength < 1 || bytes.byteLength > definition.budgetPolicy.maximumRequestBytes) {
    throw invalid("semantic.workflow_limit", "minimized semantic request exceeds its byte budget", []);
  }
  const digest = parseKeyedDigest(callbacks.digest, bytes);
  const estimatedInputTokens = estimateTokens(callbacks.estimateInputTokens, bytes);
  if (estimatedInputTokens > definition.budgetPolicy.maximumInputTokens) {
    throw invalid("semantic.workflow_limit", "semantic request exceeds its input-token budget", []);
  }
  return { text, byteLength: bytes.byteLength, digest, estimatedInputTokens };
}

function sourcePoliciesForWindow(
  context: EngineContext,
  definition: SemanticWorkflowDefinition,
  window: DetectorWindow,
) {
  const sources = new Map([...context.sources].map((source) => [source.id, source]));
  return window.sourceProfiles
    .map((profile) => {
      const source = sources.get(profile.sourceId);
      const policy = source === undefined ? undefined : context.contentPoliciesById.get(source.contentPolicyId);
      if (source === undefined || policy === undefined) {
        throw invalid("semantic.workflow_disclosure_forbidden", "semantic source policy is unavailable", []);
      }
      if (definition.transport === "outbound" && policy.outboundUse !== "explicit_receipt_required") {
        throw invalid("semantic.workflow_disclosure_forbidden", "source content policy forbids outbound use", []);
      }
      return {
        sourceId: source.id,
        contentPolicyId: policy.id,
        contentPolicyDigest: policy.digest,
        outboundUse: policy.outboundUse,
      };
    })
    .sort((left, right) => compareText(canonicalJsonText(toJsonValue(left)), canonicalJsonText(toJsonValue(right))));
}

async function revalidatePreparedPlan(plan: PreparedPlanBinding): Promise<void> {
  if (Date.parse(plan.context.clock.now()) >= Date.parse(plan.reservation.expiresAt)) {
    throw invalid("semantic.workflow_expired", "semantic generation plan has expired", []);
  }
  const target = plan.reservation.target;
  if (target.kind !== "generation") throw invalid("schema.corrupt", "generation plan has another lane", []);
  const selection = exactSelection(plan.context, plan.definition, {
    detector: target.detector,
    pack: target.pack,
    lens: target.lens,
    scope: plan.window.scope,
    episodeRecordIds: target.episodeRecordIds,
    expiresAt: plan.reservation.expiresAt,
  });
  const materialized = await materializeStable(plan.context, selection);
  if (
    !materialized.bindable ||
    materialized.status !== "ready" ||
    canonicalJsonText(toJsonValue(materialized.window)) !== canonicalJsonText(toJsonValue(plan.window))
  ) {
    throw invalid("semantic.workflow_historical", "semantic generation window changed before dispatch", []);
  }
  const currentSourcePolicies = sourcePoliciesForWindow(plan.context, plan.definition, plan.window);
  if (
    currentSourcePolicies.length !== plan.reservation.sourcePolicies.length ||
    !currentSourcePolicies.every(
      (policy, index) =>
        canonicalJsonText(toJsonValue(policy)) ===
        canonicalJsonText(toJsonValue(plan.reservation.sourcePolicies[index])),
    )
  ) {
    throw invalid("semantic.workflow_plan_invalid", "semantic generation policies changed", []);
  }
}

async function prepareGeneration(
  token: object,
  context: EngineContext,
  definition: SemanticWorkflowDefinition,
  callbacks: CapabilityCallbacks,
  input: unknown,
): ReturnType<SemanticWorkflowBundle["prepareGeneration"]> {
  const selection = exactSelection(context, definition, input);
  const materialized = await materializeStable(context, selection);
  if (!materialized.bindable || materialized.status !== "ready") {
    const severity: "warning" = "warning";
    return {
      status: materialized.status === "ready" ? "incomplete" : materialized.status,
      preview: null,
      diagnostics: materialized.reasonCodes.map((reasonCode) => ({
        code: `workflow.${reasonCode}`,
        severity,
        message: "semantic generation input is unavailable",
      })),
    };
  }
  const negativeDraft = {
    conditionDetected: false,
    recurrenceLocator: null,
    insights: [],
    findings: [],
  };
  const executionTemplate = assembleAppliedDetectorResult(materialized.window, negativeDraft).execution;
  const existing = await loadDetectorExecutionRecord(context, executionTemplate.id);
  if (existing !== undefined) {
    const workflowBinding = await loadSemanticWorkflowExecutionBinding(context, existing.executionKeyDigest);
    if (workflowBinding === undefined) {
      throw invalid("semantic.workflow_incomplete", "existing semantic execution has no workflow binding", []);
    }
    const terminal = await loadSemanticGenerationTurnByScope(
      context,
      `semantic-workflow-turn-${workflowBinding.turnKeyDigest}`,
      existing.scopeDigest,
    );
    if (
      terminal === undefined ||
      workflowBinding.definitionDigest !== definition.definitionDigest ||
      workflowBinding.detectorExecution.id !== existing.id ||
      workflowBinding.detectorExecution.executionDigest !== existing.executionDigest ||
      terminal.reservation.definition.definitionDigest !== definition.definitionDigest ||
      terminal.reservation.target.kind !== "generation" ||
      terminal.reservation.target.executionKeyDigest !== existing.executionKeyDigest ||
      terminal.reservation.target.windowDigest !== materialized.window.windowDigest
    ) {
      throw invalid("semantic.workflow_incomplete", "existing semantic execution has no terminal workflow turn", []);
    }
    const childViews = await loadSemanticWorkflowChildViews(context, existing.id, selection.scope);
    if (childViews === undefined || childViews.execution.commitBinding.status !== "committed") {
      throw invalid("store.corrupt", "existing execution view is unavailable", []);
    }
    return {
      status: "execution_existing",
      preview: null,
      windowDigest: materialized.window.windowDigest,
      executionKeyDigest: existing.executionKeyDigest,
      execution: childViews.execution,
      derivations: childViews.derivations,
    };
  }
  const sourcePolicies = sourcePoliciesForWindow(context, definition, materialized.window);
  const request = renderRequest(callbacks, definition, materialized.window);
  const registry = context.semanticRegistry;
  if (registry === undefined) throw invalid("semantic.registry_required", "semantic registry is unavailable", []);
  const exactScopeDigest = scopeDigest(selection.scope);
  const runIdDigest = sha256HexOfCanonicalJson(
    toJsonValue({
      domain: "semantic-workflow-generation-run:v1",
      detectorExecutionKeyDigest: executionTemplate.executionKeyDigest,
      definitionDigest: definition.definitionDigest,
    }),
  );
  const reservation = buildSemanticTurnReservation({
    runId: `semantic-workflow-run-${runIdDigest}`,
    loopRegistryRevision: context.registryRevision,
    semanticRegistryDigest: registry.registryDigest,
    scopeDigest: exactScopeDigest,
    target: {
      kind: "generation",
      detector: selection.detectorRef,
      pack: selection.packRef,
      lens: selection.lensRef,
      windowDigest: materialized.window.windowDigest,
      executionKeyDigest: executionTemplate.executionKeyDigest,
      episodeRecordIds: selection.episodeRecordIds,
      disclosedEvidenceReferenceDigests: materialized.window.evidence
        .map((entry) => entry.reference.referenceDigest)
        .sort(compareText),
      disclosedEvidenceHealthFindings: materialized.window.evidenceHealthFindings
        .map((finding) => ({ id: finding.id, findingDigest: finding.findingDigest }))
        .sort((left, right) => compareText(left.id, right.id)),
    },
    definition,
    request: {
      mediaType: "application/json",
      encoding: "utf-8",
      byteLength: request.byteLength,
      estimatedInputTokens: request.estimatedInputTokens,
      minimizedBytesDigest: request.digest,
      keyPolicyDigest: definition.disclosurePolicy.keyPolicyDigest,
    },
    sourcePolicies,
    disclosureExpected: definition.transport === "outbound",
    expiresAt: selection.expiresAt,
  });
  const planLock = buildSemanticWorkflowExecutionPlanLock({
    detectorExecutionKeyDigest: executionTemplate.executionKeyDigest,
    turnKeyDigest: reservation.turnKeyDigest,
    reservationId: reservation.id,
    reservationDigest: reservation.reservationDigest,
    definitionDigest: definition.definitionDigest,
    scopeDigest: exactScopeDigest,
    request: {
      byteLength: request.byteLength,
      estimatedInputTokens: request.estimatedInputTokens,
      minimizedBytesDigest: request.digest,
      keyPolicyDigest: definition.disclosurePolicy.keyPolicyDigest,
    },
  });
  const attemptId = `semantic-workflow-attempt-${executionTemplate.executionKeyDigest}`;
  const attempt = buildSemanticWorkflowAttemptIndex({
    attemptId,
    scopeDigest: exactScopeDigest,
    definitionDigest: definition.definitionDigest,
    reservationId: reservation.id,
    reservationDigest: reservation.reservationDigest,
    planLockId: planLock.id,
    planLockDigest: planLock.lockDigest,
    detectorExecutionKeyDigest: executionTemplate.executionKeyDigest,
  });
  const handle = Object.freeze({});
  preparedPlans.set(handle, {
    token,
    context,
    definition,
    callbacks,
    window: materialized.window,
    executionTemplate,
    episodeCompleteness: materialized.window.population.episodes.map((episode) => ({
      episodeRecordId: episode.view.episode.id,
      episodeViewDigest: episode.episodeViewDigest,
      completeness: episode.view.identity.status === "resolved" ? episode.view.identity.completeness : "unknown",
    })),
    registrySnapshot: buildRegistrySnapshot(context),
    orchestrationPolicy: context.detectorOrchestrationPolicy ?? null,
    reservation,
    planLock,
    attempt,
    requestText: request.text,
  });
  return {
    status: "prepared",
    plan: handle,
    attemptId,
    preview: {
      mediaType: "application/json",
      encoding: "utf-8",
      bytes: bytesOf(request.text),
      byteLength: request.byteLength,
      estimatedInputTokens: request.estimatedInputTokens,
      minimizedBytesDigest: request.digest,
      keyPolicyDigest: definition.disclosurePolicy.keyPolicyDigest,
    },
    windowDigest: materialized.window.windowDigest,
    executionKeyDigest: executionTemplate.executionKeyDigest,
  };
}

function requireFunction(value: unknown, path: readonly (string | number)[]): asserts value is UnknownCallback {
  if (typeof value !== "function") throw invalid("config.invalid", "workflow capability must be a function", path);
}

function laneUnavailable(): never {
  throw invalid("semantic.workflow_lane_unavailable", "workflow method is unavailable for this bundle lane", []);
}

/** Creates one loop-bound, provider-neutral semantic generation capability. */
function createBundle(input: SemanticWorkflowBundleConfig): SemanticWorkflowBundle {
  const raw: unknown = input;
  const fields = readFields(raw, ["semanticWorkflowBundle"]);
  fields.schemaVersion1();
  const context = contextForLearningLoop(fields.req("loop", (value) => value));
  const definition = parseSemanticWorkflowDefinition(fields.req("definition", (value) => value));
  const generation = definition.lane === "generation";
  if (
    (generation && definition.calibration !== null) ||
    (!generation &&
      (definition.calibration === null ||
        definition.calibration.status !== "unverified" ||
        definition.calibration.calibrationId !== null ||
        definition.calibration.calibrationDigest !== null))
  ) {
    throw invalid("config.invalid", "workflow definition has an invalid lane calibration posture", ["definition"]);
  }
  const expectedSchema = generation
    ? {
        id: GENERATION_RESULT_SCHEMA_ID,
        version: GENERATION_RESULT_SCHEMA_VERSION,
        digest: GENERATION_RESULT_SCHEMA_DIGEST,
      }
    : {
        id: ADVISORY_REVIEW_RESULT_SCHEMA_ID,
        version: ADVISORY_REVIEW_RESULT_SCHEMA_VERSION,
        digest: ADVISORY_REVIEW_RESULT_SCHEMA_DIGEST,
      };
  if (
    definition.outputSchema.id !== expectedSchema.id ||
    definition.outputSchema.version !== expectedSchema.version ||
    definition.outputSchema.schemaDigest !== expectedSchema.digest
  ) {
    throw invalid("config.invalid", "workflow definition must bind its exact kernel result schema", [
      "definition",
      "outputSchema",
    ]);
  }
  const principalRole = generation ? "producer" : "reviewer";
  const principalCapability = fields.req(principalRole, (value) => value);
  assertVerifiedPrincipal(context.identity, principalCapability, principalRole);
  if (
    principalCapability.ref.id !== definition.principal.id ||
    principalCapability.ref.kind !== definition.principal.kind ||
    principalCapability.ref.independenceDomain !== definition.principal.independenceDomain ||
    principalCapability.attestationId !== definition.attestation.id ||
    principalCapability.attestationDigest !== definition.attestation.digest
  ) {
    throw invalid("config.invalid", "verified principal does not match the workflow definition", [principalRole]);
  }
  const rendererFields = readFields(
    fields.req("renderer", (value) => value),
    ["renderer"],
  );
  const minimizerFields = readFields(
    fields.req("minimizer", (value) => value),
    ["minimizer"],
  );
  const digesterFields = readFields(
    fields.req("keyedDigester", (value) => value),
    ["keyedDigester"],
  );
  const estimatorFields = readFields(
    fields.req("tokenEstimator", (value) => value),
    ["tokenEstimator"],
  );
  const providerFields = readFields(
    fields.req("provider", (value) => value),
    ["provider"],
  );
  const rendererDigest = rendererFields.req("rendererDigest", parseDigestAt);
  const minimizationPolicyDigest = minimizerFields.req("minimizationPolicyDigest", parseDigestAt);
  const keyPolicyDigest = digesterFields.req("keyPolicyDigest", parseDigestAt);
  const providerRegistrationDigest = providerFields.req("registrationDigest", parseDigestAt);
  const tokenEstimatorDigest = estimatorFields.req("tokenEstimatorDigest", parseDigestAt);
  const renderCallback = rendererFields.req("render", (value) => value);
  const minimizeCallback = minimizerFields.req("minimize", (value) => value);
  const digestCallback = digesterFields.req("digest", (value) => value);
  const providerCallback = providerFields.req("invoke", (value) => value);
  const estimateInputTokensCallback = estimatorFields.req("estimateInputTokens", (value) => value);
  requireFunction(renderCallback, ["renderer", "render"]);
  requireFunction(minimizeCallback, ["minimizer", "minimize"]);
  requireFunction(digestCallback, ["keyedDigester", "digest"]);
  requireFunction(providerCallback, ["provider", "invoke"]);
  requireFunction(estimateInputTokensCallback, ["tokenEstimator", "estimateInputTokens"]);
  if (
    rendererDigest !== definition.renderer.rendererDigest ||
    minimizationPolicyDigest !== definition.disclosurePolicy.minimizationPolicyDigest ||
    keyPolicyDigest !== definition.disclosurePolicy.keyPolicyDigest ||
    providerRegistrationDigest !== definition.providerModel.provider.registrationDigest ||
    tokenEstimatorDigest !== definition.budgetPolicy.tokenEstimatorDigest
  ) {
    throw invalid("config.invalid", "workflow capability fingerprints do not match the definition", []);
  }
  const authorityInput = fields.opt("disclosureAuthority", (value) => value);
  const authorityFields =
    authorityInput === undefined ? undefined : readFields(authorityInput, ["disclosureAuthority"]);
  const authorityPolicyDigest = authorityFields?.req("authorizationPolicyDigest", parseDigestAt);
  const authorityCallback = authorityFields?.req("authorize", (value) => value);
  if (definition.transport === "outbound") {
    if (
      authorityFields === undefined ||
      authorityPolicyDigest !== definition.disclosurePolicy.authorizationPolicyDigest ||
      authorityCallback === undefined
    ) {
      throw invalid("config.invalid", "outbound workflow requires its exact disclosure authority", [
        "disclosureAuthority",
      ]);
    }
    requireFunction(authorityCallback, ["disclosureAuthority", "authorize"]);
  } else if (authorityFields !== undefined) {
    throw invalid("config.invalid", "local workflow cannot configure a disclosure authority", ["disclosureAuthority"]);
  }
  if (authorityCallback !== undefined) {
    requireFunction(authorityCallback, ["disclosureAuthority", "authorize"]);
  }

  const callbacks: CapabilityCallbacks = Object.freeze({
    render: (value: Parameters<CapabilityCallbacks["render"]>[0]) => callSync(renderCallback, value),
    minimize: (value: Parameters<CapabilityCallbacks["minimize"]>[0]) => callSync(minimizeCallback, value),
    digest: (value: Uint8Array) => callSync(digestCallback, value),
    estimateInputTokens: (value: Uint8Array) => callSync(estimateInputTokensCallback, value),
    invokeProvider: (value: Parameters<CapabilityCallbacks["invokeProvider"]>[0]) => callAsync(providerCallback, value),
    ...(authorityCallback === undefined
      ? {}
      : {
          authorize: (value: Parameters<NonNullable<CapabilityCallbacks["authorize"]>>[0]) =>
            callAsync(authorityCallback, value),
        }),
  });
  const token = Object.freeze({});
  const bundle: SemanticWorkflowBundle = {
    schemaVersion: 1,
    definitionDigest: definition.definitionDigest,
    prepareGeneration: async (value) =>
      generation ? await prepareGeneration(token, context, definition, callbacks, value) : laneUnavailable(),
    authorizeGeneration: async (value) => (generation ? await authorizeGeneration(token, value) : laneUnavailable()),
    runGeneration: async (value) =>
      generation ? await runGeneration(token, value, revalidatePreparedPlan) : laneUnavailable(),
    recoverGeneration: async (value) =>
      generation ? await recoverGeneration(context, definition, value) : laneUnavailable(),
    prepareAdvisoryReview: async () => laneUnavailable(),
    authorizeAdvisoryReview: async () => laneUnavailable(),
    runAdvisoryReview: async () => laneUnavailable(),
    recoverAdvisoryReview: async () => laneUnavailable(),
    getTurn: async (value) => await getTurn(context, definition.definitionDigest, value),
    queryTurns: (value) => queryTurns(context, definition.definitionDigest, value),
  };
  return Object.freeze(bundle);
}

export const createSemanticWorkflowBundle = Object.freeze(
  Object.assign(createBundle, {
    defineAdvisoryReview,
    defineGeneration,
    advisoryReviewResultSchema: ADVISORY_REVIEW_RESULT_SCHEMA,
    generationResultSchema: GENERATION_RESULT_SCHEMA,
  }),
);
