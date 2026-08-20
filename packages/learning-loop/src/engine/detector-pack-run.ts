// Deterministic selected-pack orchestration over exact C1 dry-run outputs.
import { Buffer } from "node:buffer";
import { canonicalJsonText } from "../canonical/canonical-json.js";
import { toJsonValue } from "../canonical/to-json-value.js";
import type { Diagnostic } from "../diagnostics.js";
import { LearningLoopError } from "../diagnostics.js";
import { invalid, parseOneOf, readFields } from "../parse/toolkit.js";
import type { Scope } from "../records/scope.js";
import {
  assertSortedUnique,
  detectorRefKey,
  lensRefKey,
  packRefKey,
  parseBoundedArray,
  parseDurableId,
  parsePackRefAt,
} from "../records/semantic-shared.js";
import type { EngineContext } from "./context.js";
import type { DetectorRunInput, DetectorRunResult } from "./detector-run.js";
import { detectorRunFailureCallbackInvoked, runDetector } from "./detector-run.js";
import { semanticGraphSnapshotRevision } from "./semantic-graph.js";
import { persistDetectorExecution } from "./semantic-persistence.js";

const MAX_EPISODE_IDS = 500;
const MAX_CONSIDERED_SELECTIONS = 5_000;
const MAX_ADMITTED_INVOCATIONS = 100;
const MAX_NEW_OUTPUTS = 100;
const MAX_RETAINED_RESULT_BYTES = 64 * 1_048_576;

export type DetectorOrchestrationDisposition =
  | "executed"
  | "existing"
  | "not_applicable"
  | "incomplete"
  | "capped"
  | "refused";

export interface DetectorPackRunInput {
  readonly mode: "dry_run" | "commit";
  readonly pack: { readonly id: string; readonly version: string; readonly manifestDigest: string };
  readonly scope: Scope;
  readonly episodeRecordIds: readonly string[];
}

export interface DetectorPackRunResult {
  readonly mode: DetectorPackRunInput["mode"];
  readonly status: "completed" | "partial";
  readonly pack: DetectorPackRunInput["pack"];
  readonly scope: Scope;
  readonly items: readonly {
    readonly detector: DetectorRunInput["detector"];
    readonly lens: DetectorRunInput["lens"];
    readonly disposition: DetectorOrchestrationDisposition;
    readonly callbackInvoked: boolean;
    readonly result?: DetectorRunResult;
    readonly diagnostics: readonly Diagnostic[];
  }[];
  readonly diagnostics: readonly Diagnostic[];
}

type Selection =
  | {
      readonly status: "runnable";
      readonly detector: DetectorRunInput["detector"];
      readonly lens: DetectorRunInput["lens"];
    }
  | {
      readonly status: "not_applicable";
      readonly detector: DetectorRunInput["detector"];
      readonly lens: null;
    };

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function diagnostic(code: string, severity: Diagnostic["severity"], message: string): Diagnostic {
  return { code, severity, message };
}

function parseInput(context: EngineContext, input: unknown): DetectorPackRunInput {
  const fields = readFields(input, ["detectorPackRunInput"]);
  const episodeRecordIds = fields.req("episodeRecordIds", (value, path) => {
    if (Array.isArray(value) && value.length > MAX_EPISODE_IDS) {
      throw new LearningLoopError("detector.limit_exceeded", [
        diagnostic("detector.limit_exceeded", "error", "detector pack episode input exceeds its ceiling"),
      ]);
    }
    return parseBoundedArray(parseDurableId, MAX_EPISODE_IDS, "episode record ids")(value, path);
  });
  assertSortedUnique(episodeRecordIds, (id) => id, ["detectorPackRunInput", "episodeRecordIds"]);
  const validatedScope = context.scopePolicy.validate(fields.req("scope", (value) => value));
  const scope = Object.freeze(validatedScope.map((segment) => Object.freeze({ type: segment.type, id: segment.id })));
  return {
    mode: fields.req("mode", parseOneOf(["dry_run", "commit"])),
    pack: fields.req("pack", parsePackRefAt),
    scope,
    episodeRecordIds,
  };
}

function compatibleLenses(
  context: EngineContext,
  detector: NonNullable<EngineContext["semanticRegistry"]>["detectors"][number],
  pack: NonNullable<EngineContext["semanticRegistry"]>["packs"][number],
): DetectorRunInput["lens"][] {
  if (detector.outputKind === "evidence_health") return [null];
  const registry = context.semanticRegistry;
  if (registry === undefined || detector.lensConstraint.mode !== "required") return [];
  const selected = new Set(registry.selectedLensRefs.map(lensRefKey));
  const allowlisted =
    detector.lensConstraint.selection === "allowlist"
      ? new Set(detector.lensConstraint.registrations.map(lensRefKey))
      : undefined;
  return pack.lenses.filter((lens) => {
    const key = lensRefKey(lens);
    if (!selected.has(key) || (allowlisted !== undefined && !allowlisted.has(key))) return false;
    if (context.semanticLensesByRef?.has(key) !== true) {
      throw invalid("store.corrupt", "selected learning-lens registration is unavailable", []);
    }
    return true;
  });
}

function addSelection(target: Selection[], selection: Selection): void {
  if (target.length >= MAX_CONSIDERED_SELECTIONS) {
    throw new LearningLoopError("detector.limit_exceeded", [
      diagnostic("detector.limit_exceeded", "error", "detector pack selection combinations exceed their ceiling"),
    ]);
  }
  target.push(selection);
}

function selections(context: EngineContext, packRef: DetectorPackRunInput["pack"]): Selection[] {
  const registry = context.semanticRegistry;
  const pack = context.semanticPacksByRef?.get(packRefKey(packRef));
  if (
    registry === undefined ||
    pack === undefined ||
    !registry.selectedPackRefs.some((reference) => packRefKey(reference) === packRefKey(packRef))
  ) {
    throw invalid("detector.input_invalid", "detector pack is not selected", []);
  }
  const selectedDetectors = new Set(registry.selectedDetectorRefs.map(detectorRefKey));
  const result: Selection[] = [];
  for (const detectorRef of pack.detectors) {
    if (!selectedDetectors.has(detectorRefKey(detectorRef))) continue;
    const detector = context.semanticDetectorsByRef?.get(detectorRefKey(detectorRef));
    if (detector === undefined) throw invalid("store.corrupt", "selected detector registration is unavailable", []);
    const detectorProjection = {
      id: detector.id,
      version: detector.version,
      registrationDigest: detector.registrationDigest,
    };
    const lenses = compatibleLenses(context, detector, pack);
    if (detector.outputKind === "insight_derivation" && lenses.length === 0) {
      addSelection(result, { status: "not_applicable", detector: detectorProjection, lens: null });
      continue;
    }
    for (const lens of lenses) {
      addSelection(result, { status: "runnable", detector: detectorProjection, lens });
    }
  }
  return result.sort((left, right) => {
    const detectorOrder = compareText(detectorRefKey(left.detector), detectorRefKey(right.detector));
    if (detectorOrder !== 0) return detectorOrder;
    return compareText(
      left.lens === null ? "" : lensRefKey(left.lens),
      right.lens === null ? "" : lensRefKey(right.lens),
    );
  });
}

function disposition(result: DetectorRunResult): DetectorOrchestrationDisposition {
  if (result.status === "not_applicable") return "not_applicable";
  if (result.status === "incomplete") return "incomplete";
  if (result.persistence === "existing") return "existing";
  return "executed";
}

function normalizedResult(result: DetectorRunResult, mode: DetectorPackRunInput["mode"]): DetectorRunResult {
  const persistence =
    result.persistence === "existing"
      ? "existing"
      : mode === "commit" && result.execution !== undefined
        ? "committed"
        : "none";
  return { ...result, mode, persistence };
}

function outputKeys(result: DetectorRunResult): readonly string[] {
  const findings = result.execution?.result.status === "applied" ? result.execution.result.evidenceHealthFindings : [];
  return [
    ...result.derivations.map((derivation) => `derivation:${derivation.id}`),
    ...findings.map((finding) => `finding:${finding.id}`),
  ];
}

function retainedBytes(result: DetectorRunResult): number {
  return Buffer.byteLength(canonicalJsonText(toJsonValue(result)), "utf8");
}

function refusablePlanningError(error: unknown): error is LearningLoopError {
  if (!(error instanceof LearningLoopError)) return false;
  return (
    error.code === "detector.callback_failed" ||
    error.code === "detector.implementation_invalid" ||
    error.code === "detector.result_invalid" ||
    error.code === "detector.limit_exceeded" ||
    error.code === "detector.snapshot_changed"
  );
}

function cappedItem(
  selection: Pick<Selection, "detector" | "lens">,
  callbackInvoked: boolean,
  code: string,
): DetectorPackRunResult["items"][number] {
  return {
    detector: selection.detector,
    lens: selection.lens,
    disposition: "capped",
    callbackInvoked,
    diagnostics: [diagnostic(code, "warning", "detector invocation was not admitted by the pack ceiling")],
  };
}

function refusedItem(
  selection: Pick<Selection, "detector" | "lens">,
  callbackInvoked: boolean,
  code: string,
  message: string,
): DetectorPackRunResult["items"][number] {
  return {
    detector: selection.detector,
    lens: selection.lens,
    disposition: "refused",
    callbackInvoked,
    diagnostics: [diagnostic(code, "error", message)],
  };
}

function resultWithStatus(input: DetectorPackRunInput, items: DetectorPackRunResult["items"]): DetectorPackRunResult {
  const partial = items.some(
    (item) => item.disposition === "capped" || item.disposition === "refused" || item.disposition === "incomplete",
  );
  return {
    mode: input.mode,
    status: partial ? "partial" : "completed",
    pack: input.pack,
    scope: input.scope,
    items,
    diagnostics: partial
      ? [diagnostic("detector.pack_partial", "warning", "detector pack completed with non-ready invocations")]
      : [],
  };
}

export async function runDetectorPack(
  context: EngineContext,
  rawInput: DetectorPackRunInput,
): Promise<DetectorPackRunResult> {
  const input = parseInput(context, rawInput);
  const plannedSelections = selections(context, input.pack);
  const items: DetectorPackRunResult["items"][number][] = [];
  let admittedInvocations = 0;
  let accumulatedOutputs = 0;
  let accumulatedBytes = 0;
  const knownOutputKeys = new Set<string>();
  let aggregateCapReached = false;
  const before = await semanticGraphSnapshotRevision(context);
  for (const selection of plannedSelections) {
    if (selection.status === "not_applicable") {
      items.push({
        detector: selection.detector,
        lens: null,
        disposition: "not_applicable",
        callbackInvoked: false,
        diagnostics: [
          diagnostic(
            "detector.pack_lens_unavailable",
            "warning",
            "selected insight detector has no compatible selected lens in this pack",
          ),
        ],
      });
      continue;
    }
    if (aggregateCapReached) {
      items.push(cappedItem(selection, false, "detector.pack_aggregate_capped"));
      continue;
    }
    if (admittedInvocations >= MAX_ADMITTED_INVOCATIONS) {
      items.push(cappedItem(selection, false, "detector.pack_invocation_capped"));
      continue;
    }
    admittedInvocations += 1;
    try {
      const planned = await runDetector(context, {
        mode: "dry_run",
        detector: selection.detector,
        pack: input.pack,
        lens: selection.lens,
        scope: input.scope,
        episodeRecordIds: input.episodeRecordIds,
      });
      const result = normalizedResult(planned, input.mode);
      const outputs = outputKeys(result);
      const newOutputs =
        result.persistence === "existing" ? [] : outputs.filter((output) => !knownOutputKeys.has(output));
      const bytes = retainedBytes(result);
      if (
        accumulatedOutputs + newOutputs.length > MAX_NEW_OUTPUTS ||
        accumulatedBytes + bytes > MAX_RETAINED_RESULT_BYTES
      ) {
        if (result.persistence === "existing") {
          for (const output of outputs) knownOutputKeys.add(output);
        }
        aggregateCapReached = true;
        items.push(cappedItem(selection, result.callbackInvoked, "detector.pack_aggregate_capped"));
        continue;
      }
      for (const output of outputs) knownOutputKeys.add(output);
      accumulatedOutputs += newOutputs.length;
      accumulatedBytes += bytes;
      if (accumulatedOutputs === MAX_NEW_OUTPUTS || accumulatedBytes === MAX_RETAINED_RESULT_BYTES) {
        aggregateCapReached = true;
      }
      items.push({
        detector: selection.detector,
        lens: selection.lens,
        disposition: disposition(result),
        callbackInvoked: result.callbackInvoked,
        result,
        diagnostics: result.diagnostics,
      });
    } catch (error) {
      if (!refusablePlanningError(error)) throw error;
      items.push(
        refusedItem(
          selection,
          detectorRunFailureCallbackInvoked(error),
          error.code,
          "detector pack invocation was refused",
        ),
      );
    }
  }
  const after = await semanticGraphSnapshotRevision(context);
  if (before !== after) {
    return resultWithStatus(
      input,
      items.map((item) =>
        item.disposition === "capped"
          ? item
          : refusedItem(
              item,
              item.callbackInvoked,
              "detector.pack_snapshot_changed",
              "detector pack inputs changed during planning",
            ),
      ),
    );
  }

  if (input.mode === "commit") {
    for (const [index, item] of items.entries()) {
      const result = item.result;
      if (item.disposition === "capped" || item.disposition === "refused" || result?.execution === undefined) continue;
      if (result.persistence === "existing") continue;
      try {
        await persistDetectorExecution(context, result.execution, result.derivations);
      } catch (error) {
        const code =
          error instanceof LearningLoopError
            ? error.code === "store.conflict" ||
              error.code === "store.unavailable" ||
              error.code === "semantic.execution_conflict"
              ? error.code
              : undefined
            : "detector.pack_commit_failed";
        if (code === undefined) throw error;
        items[index] = refusedItem(item, item.callbackInvoked, code, "detector pack invocation commit was refused");
      }
    }
  }
  return resultWithStatus(input, items);
}
