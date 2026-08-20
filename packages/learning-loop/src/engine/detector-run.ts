// One exact selected detector invocation: bounded materialization, synchronous
// deterministic evaluation, dry-run projection, and optional inert commit.
import { Buffer } from "node:buffer";
import { canonicalJsonText } from "../canonical/canonical-json.js";
import { toJsonValue } from "../canonical/to-json-value.js";
import type { Diagnostic } from "../diagnostics.js";
import { LearningLoopError } from "../diagnostics.js";
import { invalid, parseOneOf, readFields } from "../parse/toolkit.js";
import type { DetectorExecutionRecord, DetectorExecutionStatus } from "../records/detector-execution.js";
import type { InsightDerivation } from "../records/insight-derivation.js";
import type { Scope } from "../records/scope.js";
import {
  assertSortedUnique,
  detectorRefKey,
  lensRefKey,
  packRefKey,
  parseBoundedArray,
  parseDetectorRefAt,
  parseDurableId,
  parseLensRefAt,
  parseNullable,
  parsePackRefAt,
  scopeDigest,
} from "../records/semantic-shared.js";
import type { EngineContext } from "./context.js";
import type { EvidenceHealthView } from "./evidence-binding.js";
import {
  assembleAppliedDetectorResult,
  assembleNonAppliedDetectorResult,
  parseDetectorResultDraft,
} from "./detector-draft.js";
import type { DetectorResultDraft } from "./detector-draft.js";
import { evaluateDetectorImplementation } from "./detector-implementation.js";
import { materializeDetectorWindow } from "./detector-window.js";
import {
  loadDetectorExecutionRecord,
  loadInsightDerivationRecord,
  semanticGraphSnapshotRevision,
} from "./semantic-graph.js";
import { persistDetectorExecution } from "./semantic-persistence.js";
import { loadDetectorExecutionView } from "./semantic-views.js";

const MAX_EPISODE_IDS = 500;
const MAX_SNAPSHOT_ATTEMPTS = 3;
const MAX_RESULT_BYTES = 16 * 1_048_576;

export interface DetectorRunInput {
  readonly mode: "dry_run" | "commit";
  readonly detector: { readonly id: string; readonly version: string; readonly registrationDigest: string };
  readonly pack: { readonly id: string; readonly version: string; readonly manifestDigest: string };
  readonly lens: { readonly id: string; readonly version: string; readonly registrationDigest: string } | null;
  readonly scope: Scope;
  readonly episodeRecordIds: readonly string[];
}

export interface DetectorRunResult {
  readonly mode: DetectorRunInput["mode"];
  readonly status: DetectorExecutionStatus;
  readonly persistence: "none" | "committed" | "existing";
  readonly callbackInvoked: boolean;
  readonly execution?: DetectorExecutionRecord;
  readonly derivations: readonly InsightDerivation[];
  readonly evidenceHealth: EvidenceHealthView;
  readonly diagnostics: readonly Diagnostic[];
}

function parseInput(context: EngineContext, input: unknown): DetectorRunInput {
  const fields = readFields(input, ["detectorRunInput"]);
  const episodeRecordIds = fields.req("episodeRecordIds", (value, path) => {
    if (Array.isArray(value) && value.length > MAX_EPISODE_IDS) {
      throw new LearningLoopError("detector.limit_exceeded", [
        { code: "detector.limit_exceeded", severity: "error", message: "detector episode input exceeds its ceiling" },
      ]);
    }
    return parseBoundedArray(parseDurableId, MAX_EPISODE_IDS, "episode record ids")(value, path);
  });
  assertSortedUnique(episodeRecordIds, (id) => id, ["detectorRunInput", "episodeRecordIds"]);
  const validatedScope = context.scopePolicy.validate(fields.req("scope", (value) => value));
  const scope = Object.freeze(validatedScope.map((segment) => Object.freeze({ type: segment.type, id: segment.id })));
  return {
    mode: fields.req("mode", parseOneOf(["dry_run", "commit"])),
    detector: fields.req("detector", parseDetectorRefAt),
    pack: fields.req("pack", parsePackRefAt),
    lens: fields.req("lens", parseNullable(parseLensRefAt)),
    scope,
    episodeRecordIds,
  };
}

function applicableScope(
  constraint:
    | { readonly mode: "invocation" }
    | { readonly mode: "exact"; readonly scopes: readonly { readonly scopeDigest: string }[] },
  exactScopeDigest: string,
): boolean {
  return constraint.mode === "invocation" || constraint.scopes.some((entry) => entry.scopeDigest === exactScopeDigest);
}

function reasonDiagnostics(reasons: readonly string[]): readonly Diagnostic[] {
  return reasons.map((code) => ({
    code: `detector.${code}`,
    severity: "warning",
    message: "detector did not apply to the exact window",
  }));
}

async function existingBundle(
  context: EngineContext,
  executionId: string,
): Promise<
  { readonly execution: DetectorExecutionRecord; readonly derivations: readonly InsightDerivation[] } | undefined
> {
  const execution = await loadDetectorExecutionRecord(context, executionId);
  if (execution === undefined) return undefined;
  const derivations: InsightDerivation[] = [];
  if (execution.result.status === "applied") {
    for (const reference of execution.result.derivationRefs) {
      const derivation = await loadInsightDerivationRecord(context, reference.id);
      if (derivation === undefined || derivation.derivationDigest !== reference.derivationDigest) {
        throw invalid("store.corrupt", "existing detector execution has a missing derivation output", []);
      }
      derivations.push(derivation);
    }
  }
  return { execution, derivations };
}

function noExecutionResult(
  input: DetectorRunInput,
  status: "not_applicable" | "incomplete",
  reasons: readonly string[],
  evidenceHealth: EvidenceHealthView = { status: "ready", diagnostics: [] },
): DetectorRunResult {
  return {
    mode: input.mode,
    status,
    persistence: "none",
    callbackInvoked: false,
    derivations: [],
    evidenceHealth,
    diagnostics: [...reasonDiagnostics(reasons), ...evidenceHealth.diagnostics],
  };
}

const detectorRunFailureCallbacks = new WeakMap<object, boolean>();

export function detectorRunFailureCallbackInvoked(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  return detectorRunFailureCallbacks.get(error) ?? false;
}

async function runDetectorInternal(
  context: EngineContext,
  rawInput: DetectorRunInput,
  state: { callbackInvoked: boolean },
): Promise<DetectorRunResult> {
  const input = parseInput(context, rawInput);
  const registry = context.semanticRegistry;
  const inputLens = input.lens;
  const detector = context.semanticDetectorsByRef?.get(detectorRefKey(input.detector));
  const pack = context.semanticPacksByRef?.get(packRefKey(input.pack));
  const lens = inputLens === null ? undefined : context.semanticLensesByRef?.get(lensRefKey(inputLens));
  if (
    registry === undefined ||
    detector === undefined ||
    pack === undefined ||
    !registry.selectedDetectorRefs.some((reference) => detectorRefKey(reference) === detectorRefKey(input.detector)) ||
    !registry.selectedPackRefs.some((reference) => packRefKey(reference) === packRefKey(input.pack)) ||
    !pack.detectors.some((reference) => detectorRefKey(reference) === detectorRefKey(input.detector))
  ) {
    throw invalid("detector.input_invalid", "detector run selection is not current", []);
  }
  if (
    (detector.outputKind === "evidence_health" && inputLens !== null) ||
    (detector.outputKind === "insight_derivation" &&
      (inputLens === null ||
        lens === undefined ||
        !registry.selectedLensRefs.some((reference) => lensRefKey(reference) === lensRefKey(inputLens)) ||
        !pack.lenses.some((reference) => lensRefKey(reference) === lensRefKey(inputLens))))
  ) {
    throw invalid("detector.input_invalid", "detector run lens selection is invalid", []);
  }
  const exactScopeDigest = scopeDigest(input.scope);
  if (!applicableScope(detector.scopeConstraint, exactScopeDigest)) {
    return noExecutionResult(input, "not_applicable", ["scope.not_applicable"]);
  }
  if (lens !== undefined && !applicableScope(lens.applicableScopes, exactScopeDigest)) {
    return noExecutionResult(input, "not_applicable", ["lens.not_applicable"]);
  }
  if (lens !== undefined && inputLens !== null) {
    const constraint = detector.lensConstraint;
    const compatible =
      constraint.mode === "required" &&
      (constraint.selection === "any_registered" ||
        constraint.registrations.some((reference) => lensRefKey(reference) === lensRefKey(inputLens)));
    if (
      !compatible ||
      !lens.generatorPolicy.allowedKinds.includes("deterministic") ||
      lens.requiredFingerprintKinds.some((kind) => kind !== "implementation") ||
      lens.requiredCalibrationIds.length !== 0
    ) {
      return noExecutionResult(input, "not_applicable", ["lens.generator_not_applicable"]);
    }
  }

  let materialized: Awaited<ReturnType<typeof materializeDetectorWindow>> | undefined;
  let materializedRevision: string | undefined;
  for (let attempt = 0; attempt < MAX_SNAPSHOT_ATTEMPTS; attempt += 1) {
    const before = await semanticGraphSnapshotRevision(context);
    materialized = await materializeDetectorWindow({
      context,
      detector,
      pack: input.pack,
      lens: inputLens,
      ...(lens === undefined ? {} : { lensRegistration: lens }),
      scope: input.scope,
      episodeRecordIds: input.episodeRecordIds,
    });
    const after = await semanticGraphSnapshotRevision(context);
    if (before === after) {
      materializedRevision = after;
      break;
    }
    materialized = undefined;
  }
  if (materialized === undefined) {
    throw new LearningLoopError("detector.snapshot_changed", [
      { code: "detector.snapshot_changed", severity: "error", message: "detector window changed repeatedly" },
    ]);
  }
  if (!materialized.bindable) {
    const status = materialized.status === "ready" ? "incomplete" : materialized.status;
    return noExecutionResult(input, status, materialized.reasonCodes, materialized.evidenceHealth);
  }
  const implementation = context.detectorImplementationsByRef?.get(detectorRefKey(input.detector));
  if (implementation === undefined && materialized.status === "ready") {
    materialized = {
      ...materialized,
      status: "incomplete",
      reasonCodes: [...materialized.reasonCodes, "implementation.missing"].sort(),
    };
  }
  const tentative =
    materialized.status === "ready"
      ? assembleAppliedDetectorResult(materialized.window, {
          conditionDetected: false,
          insights: [],
          findings: [],
        }).execution
      : assembleNonAppliedDetectorResult(
          materialized.window,
          materialized.status,
          materialized.reasonCodes,
          materialized.missingCapabilities,
        );
  const existing = await existingBundle(context, tentative.id);
  if (existing !== undefined) {
    if (input.mode === "commit") {
      await persistDetectorExecution(context, existing.execution, existing.derivations);
    }
    const view = await loadDetectorExecutionView(context, existing.execution.id, input.scope);
    if (view === undefined || view.commitBinding.status !== "committed") {
      throw invalid("store.corrupt", "existing detector execution graph is incomplete", []);
    }
    return {
      mode: input.mode,
      status: existing.execution.result.status,
      persistence: "existing",
      callbackInvoked: false,
      execution: existing.execution,
      derivations: existing.derivations,
      evidenceHealth: view.evidenceHealth,
      diagnostics: view.evidenceHealth.diagnostics,
    };
  }

  let execution = tentative;
  let derivations: readonly InsightDerivation[] = [];
  let callbackInvoked = false;
  if (materialized.status === "ready" && implementation !== undefined) {
    callbackInvoked = true;
    state.callbackInvoked = true;
    let rawDraft: unknown;
    try {
      rawDraft = evaluateDetectorImplementation(implementation, materialized.window);
    } catch (error) {
      if (error instanceof LearningLoopError && error.code === "detector.implementation_invalid") {
        throw new LearningLoopError("detector.implementation_invalid", [
          {
            code: "detector.implementation_invalid",
            severity: "error",
            message: "detector implementation violated its synchronous contract",
          },
        ]);
      }
      throw new LearningLoopError("detector.callback_failed", [
        { code: "detector.callback_failed", severity: "error", message: "detector implementation failed" },
      ]);
    }
    let draft: DetectorResultDraft;
    try {
      const snapshot = toJsonValue(rawDraft);
      if (Buffer.byteLength(canonicalJsonText(snapshot), "utf8") > MAX_RESULT_BYTES) {
        throw new LearningLoopError("detector.limit_exceeded", [
          { code: "detector.limit_exceeded", severity: "error", message: "detector result exceeds its ceiling" },
        ]);
      }
      draft = parseDetectorResultDraft(snapshot);
    } catch (error) {
      if (error instanceof LearningLoopError && error.code === "detector.limit_exceeded") throw error;
      throw new LearningLoopError("detector.result_invalid", [
        { code: "detector.result_invalid", severity: "error", message: "detector result failed validation" },
      ]);
    }
    let assembled: ReturnType<typeof assembleAppliedDetectorResult>;
    try {
      assembled = assembleAppliedDetectorResult(materialized.window, draft);
    } catch (error) {
      if (!(error instanceof LearningLoopError)) throw error;
      throw new LearningLoopError("detector.result_invalid", [
        { code: "detector.result_invalid", severity: "error", message: "detector result cannot be assembled" },
      ]);
    }
    execution = assembled.execution;
    derivations = assembled.derivations;
    const afterCallback = await semanticGraphSnapshotRevision(context);
    if (materializedRevision === undefined || afterCallback !== materializedRevision) {
      throw new LearningLoopError("detector.snapshot_changed", [
        { code: "detector.snapshot_changed", severity: "error", message: "detector window changed during evaluation" },
      ]);
    }
  }

  if (input.mode === "commit") {
    await persistDetectorExecution(context, execution, derivations);
  }
  return {
    mode: input.mode,
    status: execution.result.status,
    persistence: input.mode === "commit" ? "committed" : "none",
    callbackInvoked,
    execution,
    derivations,
    evidenceHealth: materialized.evidenceHealth,
    diagnostics: [...reasonDiagnostics(materialized.reasonCodes), ...materialized.evidenceHealth.diagnostics],
  };
}

export async function runDetector(context: EngineContext, rawInput: DetectorRunInput): Promise<DetectorRunResult> {
  const state = { callbackInvoked: false };
  try {
    return await runDetectorInternal(context, rawInput, state);
  } catch (error) {
    if (typeof error === "object" && error !== null) {
      detectorRunFailureCallbacks.set(error, state.callbackInvoked);
    }
    throw error;
  }
}
