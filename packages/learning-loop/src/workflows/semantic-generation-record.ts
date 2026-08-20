// Private exact binding from one completed provider turn to the ordinary
// DetectorExecution/InsightDerivation graph. This record is inert: it grants
// no proposal, review, retry, provider, disclosure, or publication authority.
import { Buffer } from "node:buffer";
import { canonicalJsonText, sha256HexOfCanonicalJson } from "../canonical/canonical-json.js";
import { toJsonValue } from "../canonical/to-json-value.js";
import { invalid, parseOneOf } from "../parse/toolkit.js";
import type { DetectorExecutionRecord } from "../records/detector-execution.js";
import { assertSortedUnique, parseDigestAt, parseDurableId } from "../records/semantic-shared.js";
import type { InsightDerivation } from "../records/insight-derivation.js";
import { parseInsightDerivation } from "../records/insight-derivation.js";
import { parseDetectorExecutionRecord } from "../records/detector-execution.js";
import type { SemanticRegistrySnapshot } from "../engine/semantic-graph.js";
import { parseSemanticRegistrySnapshot } from "../engine/semantic-graph.js";
import type { DetectorOrchestrationPolicy } from "../records/detector-orchestration-policy.js";
import { parseDetectorOrchestrationPolicy } from "../records/detector-orchestration-policy.js";
import type { ExecutionRecurrenceBinding } from "../engine/detector-recurrence.js";
import {
  buildUnavailableExecutionRecurrenceBinding,
  parseExecutionRecurrenceBinding,
} from "../engine/detector-recurrence.js";
import type { SemanticResultBinding } from "./semantic-turn-outcome.js";
import { parseSemanticResultBinding } from "./semantic-turn-outcome.js";
import { readSemanticWorkflowFields as readFields } from "./workflow-structure.js";
import { parseSemanticWorkflowArray } from "./workflow-structure.js";
import { SEMANTIC_WORKFLOW_MAX_CANONICAL_BYTES } from "./workflow-definition.js";

const EXECUTION_DOMAIN = "semantic-workflow-execution:v1";
const PLAN_LOCK_DOMAIN = "semantic-workflow-execution-plan-lock:v1";
const COMPLETION_INTENT_DOMAIN = "semantic-workflow-completion-intent:v1";
const ATTEMPT_INDEX_DOMAIN = "semantic-workflow-attempt-index:v1";
const MAX_DERIVATION_REFS = 100;
const MAX_COMPLETION_INTENT_BYTES = 64 * 1_048_576;
const COMPLETENESS = ["complete", "partial", "unknown"] as const;

export interface SemanticWorkflowExecutionBinding {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly turnKeyDigest: string;
  readonly reservationDigest: string;
  readonly resultBindingDigest: string;
  readonly definitionDigest: string;
  readonly detectorExecution: {
    readonly id: string;
    readonly executionKeyDigest: string;
    readonly executionDigest: string;
  };
  readonly derivationRefs: readonly {
    readonly id: string;
    readonly derivationDigest: string;
    readonly scopeDigest: string;
  }[];
  readonly workflowExecutionKeyDigest: string;
  readonly workflowExecutionDigest: string;
}

export interface SemanticWorkflowExecutionPlanLock {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly detectorExecutionKeyDigest: string;
  readonly turnKeyDigest: string;
  readonly reservationId: string;
  readonly reservationDigest: string;
  readonly definitionDigest: string;
  readonly scopeDigest: string;
  readonly request: {
    readonly byteLength: number;
    readonly estimatedInputTokens: number;
    readonly minimizedBytesDigest: string;
    readonly keyPolicyDigest: string;
  };
  readonly lockDigest: string;
}

export interface SemanticWorkflowCompletionIntent {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly detectorExecutionKeyDigest: string;
  readonly turnKeyDigest: string;
  readonly reservationDigest: string;
  readonly planLockDigest: string;
  readonly registrySnapshot: SemanticRegistrySnapshot;
  readonly executionTemplate: DetectorExecutionRecord;
  readonly episodeCompleteness: readonly {
    readonly episodeRecordId: string;
    readonly episodeViewDigest: string;
    readonly completeness: "complete" | "partial" | "unknown";
  }[];
  readonly detectorOrchestrationPolicy: DetectorOrchestrationPolicy | null;
  readonly recurrenceBinding: ExecutionRecurrenceBinding | null;
  readonly result: SemanticResultBinding;
  readonly workflowExecution: SemanticWorkflowExecutionBinding;
  readonly execution: DetectorExecutionRecord;
  readonly derivations: readonly InsightDerivation[];
  readonly intentDigest: string;
}

export interface SemanticWorkflowAttemptIndex {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly attemptId: string;
  readonly scopeDigest: string;
  readonly definitionDigest: string;
  readonly reservationId: string;
  readonly reservationDigest: string;
  readonly planLockId: string;
  readonly planLockDigest: string;
  readonly detectorExecutionKeyDigest: string;
  readonly attemptDigest: string;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

function bindingDigest(
  input: Omit<SemanticWorkflowExecutionBinding, "schemaVersion" | "id" | "workflowExecutionDigest">,
): string {
  return sha256HexOfCanonicalJson(toJsonValue({ domain: EXECUTION_DOMAIN, ...input }));
}

function parseDerivationRef(
  input: unknown,
  path: readonly (string | number)[],
): SemanticWorkflowExecutionBinding["derivationRefs"][number] {
  const fields = readFields(input, path);
  const id = fields.req("id", parseDurableId);
  const derivationDigest = fields.req("derivationDigest", parseDigestAt);
  if (id !== `insight-${derivationDigest}`) {
    throw invalid("schema.corrupt", "workflow derivation id does not match its digest", [...path, "id"]);
  }
  return {
    id,
    derivationDigest,
    scopeDigest: fields.req("scopeDigest", parseDigestAt),
  };
}

export function parseSemanticWorkflowExecutionBinding(input: unknown): SemanticWorkflowExecutionBinding {
  const fields = readFields(input, []);
  const schemaVersion = fields.schemaVersion1();
  const detectorFields = readFields(
    fields.req("detectorExecution", (value) => value),
    ["detectorExecution"],
  );
  const detectorExecution = {
    id: detectorFields.req("id", parseDurableId),
    executionKeyDigest: detectorFields.req("executionKeyDigest", parseDigestAt),
    executionDigest: detectorFields.req("executionDigest", parseDigestAt),
  };
  if (detectorExecution.id !== `detector-execution-${detectorExecution.executionKeyDigest}`) {
    throw invalid("schema.corrupt", "workflow detector execution id does not match its key digest", [
      "detectorExecution",
      "id",
    ]);
  }
  const derivationRefs = fields.req(
    "derivationRefs",
    parseSemanticWorkflowArray(parseDerivationRef, MAX_DERIVATION_REFS, "workflow derivation references"),
  );
  assertSortedUnique(derivationRefs, (reference) => reference.id, ["derivationRefs"]);
  const base = {
    turnKeyDigest: fields.req("turnKeyDigest", parseDigestAt),
    reservationDigest: fields.req("reservationDigest", parseDigestAt),
    resultBindingDigest: fields.req("resultBindingDigest", parseDigestAt),
    definitionDigest: fields.req("definitionDigest", parseDigestAt),
    detectorExecution,
    derivationRefs,
  };
  const workflowExecutionKeyDigest = fields.req("workflowExecutionKeyDigest", parseDigestAt);
  if (workflowExecutionKeyDigest !== detectorExecution.executionKeyDigest) {
    throw invalid("schema.corrupt", "workflow execution key digest does not match its exact inputs", [
      "workflowExecutionKeyDigest",
    ]);
  }
  const id = fields.req("id", parseDurableId);
  if (id !== `semantic-workflow-execution-${workflowExecutionKeyDigest}`) {
    throw invalid("schema.corrupt", "workflow execution id does not match its key digest", ["id"]);
  }
  const withKey = { ...base, workflowExecutionKeyDigest };
  const workflowExecutionDigest = fields.req("workflowExecutionDigest", parseDigestAt);
  if (workflowExecutionDigest !== bindingDigest(withKey)) {
    throw invalid("schema.corrupt", "workflow execution digest does not match its exact content", [
      "workflowExecutionDigest",
    ]);
  }
  return deepFreeze({ schemaVersion, id, ...withKey, workflowExecutionDigest });
}

export function buildSemanticWorkflowExecutionBinding(input: {
  readonly turnKeyDigest: string;
  readonly reservationDigest: string;
  readonly resultBindingDigest: string;
  readonly definitionDigest: string;
  readonly execution: DetectorExecutionRecord;
  readonly derivations: readonly InsightDerivation[];
}): SemanticWorkflowExecutionBinding {
  const derivationRefs = input.derivations
    .map((derivation) => ({
      id: derivation.id,
      derivationDigest: derivation.derivationDigest,
      scopeDigest: derivation.scopeDigest,
    }))
    .sort((left, right) => (left.id < right.id ? -1 : 1));
  const base = {
    turnKeyDigest: input.turnKeyDigest,
    reservationDigest: input.reservationDigest,
    resultBindingDigest: input.resultBindingDigest,
    definitionDigest: input.definitionDigest,
    detectorExecution: {
      id: input.execution.id,
      executionKeyDigest: input.execution.executionKeyDigest,
      executionDigest: input.execution.executionDigest,
    },
    derivationRefs,
  };
  const workflowExecutionKeyDigest = base.detectorExecution.executionKeyDigest;
  const withKey = { ...base, workflowExecutionKeyDigest };
  return parseSemanticWorkflowExecutionBinding({
    schemaVersion: 1,
    id: `semantic-workflow-execution-${workflowExecutionKeyDigest}`,
    ...withKey,
    workflowExecutionDigest: bindingDigest(withKey),
  });
}

function planLockDigest(input: Omit<SemanticWorkflowExecutionPlanLock, "schemaVersion" | "id" | "lockDigest">): string {
  return sha256HexOfCanonicalJson(toJsonValue({ domain: PLAN_LOCK_DOMAIN, ...input }));
}

export function parseSemanticWorkflowExecutionPlanLock(input: unknown): SemanticWorkflowExecutionPlanLock {
  const fields = readFields(input, []);
  const schemaVersion = fields.schemaVersion1();
  const requestFields = readFields(
    fields.req("request", (value) => value),
    ["request"],
  );
  const byteLength = requestFields.req("byteLength", (value, path) => {
    if (
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      value < 1 ||
      value > SEMANTIC_WORKFLOW_MAX_CANONICAL_BYTES
    ) {
      throw invalid("schema.invalid", "workflow plan request length must be a positive safe integer", path);
    }
    return value;
  });
  const estimatedInputTokens = requestFields.req("estimatedInputTokens", (value, path) => {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
      throw invalid("schema.invalid", "workflow plan input-token estimate must be nonnegative", path);
    }
    return value;
  });
  const base = {
    detectorExecutionKeyDigest: fields.req("detectorExecutionKeyDigest", parseDigestAt),
    turnKeyDigest: fields.req("turnKeyDigest", parseDigestAt),
    reservationId: fields.req("reservationId", parseDurableId),
    reservationDigest: fields.req("reservationDigest", parseDigestAt),
    definitionDigest: fields.req("definitionDigest", parseDigestAt),
    scopeDigest: fields.req("scopeDigest", parseDigestAt),
    request: {
      byteLength,
      estimatedInputTokens,
      minimizedBytesDigest: requestFields.req("minimizedBytesDigest", parseDigestAt),
      keyPolicyDigest: requestFields.req("keyPolicyDigest", parseDigestAt),
    },
  };
  const id = fields.req("id", parseDurableId);
  if (id !== `semantic-workflow-execution-plan-${base.detectorExecutionKeyDigest}`) {
    throw invalid("schema.corrupt", "workflow plan lock id does not match the detector execution key", ["id"]);
  }
  const lockDigest = fields.req("lockDigest", parseDigestAt);
  if (lockDigest !== planLockDigest(base)) {
    throw invalid("schema.corrupt", "workflow plan lock digest does not match its exact content", ["lockDigest"]);
  }
  return deepFreeze({ schemaVersion, id, ...base, lockDigest });
}

export function buildSemanticWorkflowExecutionPlanLock(
  input: Omit<SemanticWorkflowExecutionPlanLock, "schemaVersion" | "id" | "lockDigest">,
): SemanticWorkflowExecutionPlanLock {
  return parseSemanticWorkflowExecutionPlanLock({
    schemaVersion: 1,
    id: `semantic-workflow-execution-plan-${input.detectorExecutionKeyDigest}`,
    ...input,
    lockDigest: planLockDigest(input),
  });
}

function completionIntentDigest(
  input: Omit<SemanticWorkflowCompletionIntent, "schemaVersion" | "id" | "intentDigest">,
): string {
  return sha256HexOfCanonicalJson(toJsonValue({ domain: COMPLETION_INTENT_DOMAIN, ...input }));
}

export function parseSemanticWorkflowCompletionIntent(input: unknown): SemanticWorkflowCompletionIntent {
  const fields = readFields(input, []);
  const schemaVersion = fields.schemaVersion1();
  const derivations = fields.req(
    "derivations",
    parseSemanticWorkflowArray(
      (value) => parseInsightDerivation(value),
      MAX_DERIVATION_REFS,
      "semantic workflow completion derivations",
    ),
  );
  const episodeCompleteness = fields.req(
    "episodeCompleteness",
    parseSemanticWorkflowArray(
      (value, path) => {
        const nested = readFields(value, path);
        return {
          episodeRecordId: nested.req("episodeRecordId", parseDurableId),
          episodeViewDigest: nested.req("episodeViewDigest", parseDigestAt),
          completeness: nested.req("completeness", parseOneOf(COMPLETENESS)),
        };
      },
      500,
      "semantic workflow episode completeness",
    ),
  );
  const base = {
    detectorExecutionKeyDigest: fields.req("detectorExecutionKeyDigest", parseDigestAt),
    turnKeyDigest: fields.req("turnKeyDigest", parseDigestAt),
    reservationDigest: fields.req("reservationDigest", parseDigestAt),
    planLockDigest: fields.req("planLockDigest", parseDigestAt),
    registrySnapshot: fields.req("registrySnapshot", parseSemanticRegistrySnapshot),
    executionTemplate: fields.req("executionTemplate", parseDetectorExecutionRecord),
    episodeCompleteness,
    detectorOrchestrationPolicy: fields.req("detectorOrchestrationPolicy", (value) =>
      value === null ? null : parseDetectorOrchestrationPolicy(value),
    ),
    recurrenceBinding: fields.req("recurrenceBinding", (value, path) =>
      value === null ? null : parseExecutionRecurrenceBinding(value, path),
    ),
    result: fields.req("result", parseSemanticResultBinding),
    workflowExecution: fields.req("workflowExecution", parseSemanticWorkflowExecutionBinding),
    execution: fields.req("execution", parseDetectorExecutionRecord),
    derivations,
  };
  const id = fields.req("id", parseDurableId);
  if (id !== `semantic-workflow-completion-${base.detectorExecutionKeyDigest}`) {
    throw invalid("schema.corrupt", "workflow completion intent id does not match the child execution key", ["id"]);
  }
  const executionRefs = base.execution.result.status === "applied" ? base.execution.result.derivationRefs : [];
  const derivationRefs = derivations.map((derivation) => ({
    id: derivation.id,
    derivationDigest: derivation.derivationDigest,
    scopeDigest: derivation.scopeDigest,
  }));
  const expectedRecurrence =
    base.execution.result.status === "applied" && base.execution.result.conditionDetected
      ? buildUnavailableExecutionRecurrenceBinding(base.execution)
      : null;
  if (
    base.execution.executionKeyDigest !== base.detectorExecutionKeyDigest ||
    base.registrySnapshot.loopRegistryRevision !== base.execution.loopRegistryRevision ||
    base.executionTemplate.executionKeyDigest !== base.detectorExecutionKeyDigest ||
    base.executionTemplate.result.status !== "applied" ||
    base.executionTemplate.result.conditionDetected ||
    base.executionTemplate.result.derivationRefs.length !== 0 ||
    base.executionTemplate.result.evidenceHealthFindings.length !== 0 ||
    base.executionTemplate.window.windowDigest !== base.execution.window.windowDigest ||
    episodeCompleteness.length !== base.executionTemplate.window.population.episodes.length ||
    episodeCompleteness.some(
      (entry, index) =>
        entry.episodeRecordId !== base.executionTemplate.window.population.episodes[index]?.episodeRecordId ||
        entry.episodeViewDigest !== base.executionTemplate.window.population.episodes[index]?.episodeViewDigest,
    ) ||
    base.workflowExecution.workflowExecutionKeyDigest !== base.detectorExecutionKeyDigest ||
    base.workflowExecution.detectorExecution.executionDigest !== base.execution.executionDigest ||
    base.workflowExecution.turnKeyDigest !== base.turnKeyDigest ||
    base.workflowExecution.reservationDigest !== base.reservationDigest ||
    base.workflowExecution.resultBindingDigest !== base.result.bindingDigest ||
    base.result.turnKeyDigest !== base.turnKeyDigest ||
    canonicalJsonText(toJsonValue(base.workflowExecution.derivationRefs)) !==
      canonicalJsonText(toJsonValue(executionRefs)) ||
    canonicalJsonText(toJsonValue(derivationRefs)) !== canonicalJsonText(toJsonValue(executionRefs)) ||
    base.execution.result.status !== "applied" ||
    (base.execution.result.conditionDetected ? executionRefs.length === 0 : executionRefs.length !== 0) ||
    canonicalJsonText(toJsonValue(base.recurrenceBinding)) !== canonicalJsonText(toJsonValue(expectedRecurrence))
  ) {
    throw invalid("schema.corrupt", "workflow completion intent graph is not exactly reciprocal", []);
  }
  const intentDigest = fields.req("intentDigest", parseDigestAt);
  if (intentDigest !== completionIntentDigest(base)) {
    throw invalid("schema.corrupt", "workflow completion intent digest does not match its graph", ["intentDigest"]);
  }
  const parsed = deepFreeze({ schemaVersion, id, ...base, intentDigest });
  if (Buffer.byteLength(canonicalJsonText(toJsonValue(parsed)), "utf8") > MAX_COMPLETION_INTENT_BYTES) {
    throw invalid("semantic.workflow_limit", "workflow completion intent exceeds its aggregate byte ceiling", []);
  }
  return parsed;
}

export function buildSemanticWorkflowCompletionIntent(
  input: Omit<SemanticWorkflowCompletionIntent, "schemaVersion" | "id" | "intentDigest">,
): SemanticWorkflowCompletionIntent {
  return parseSemanticWorkflowCompletionIntent({
    schemaVersion: 1,
    id: `semantic-workflow-completion-${input.detectorExecutionKeyDigest}`,
    ...input,
    intentDigest: completionIntentDigest(input),
  });
}

function attemptIndexDigest(
  input: Omit<SemanticWorkflowAttemptIndex, "schemaVersion" | "id" | "attemptDigest">,
): string {
  return sha256HexOfCanonicalJson(toJsonValue({ domain: ATTEMPT_INDEX_DOMAIN, ...input }));
}

export function parseSemanticWorkflowAttemptIndex(input: unknown): SemanticWorkflowAttemptIndex {
  const fields = readFields(input, []);
  const schemaVersion = fields.schemaVersion1();
  const base = {
    attemptId: fields.req("attemptId", parseDurableId),
    scopeDigest: fields.req("scopeDigest", parseDigestAt),
    definitionDigest: fields.req("definitionDigest", parseDigestAt),
    reservationId: fields.req("reservationId", parseDurableId),
    reservationDigest: fields.req("reservationDigest", parseDigestAt),
    planLockId: fields.req("planLockId", parseDurableId),
    planLockDigest: fields.req("planLockDigest", parseDigestAt),
    detectorExecutionKeyDigest: fields.req("detectorExecutionKeyDigest", parseDigestAt),
  };
  const id = fields.req("id", parseDurableId);
  if (id !== base.attemptId || id !== `semantic-workflow-attempt-${base.detectorExecutionKeyDigest}`) {
    throw invalid("schema.corrupt", "workflow attempt identity does not match its execution key", ["id"]);
  }
  const attemptDigest = fields.req("attemptDigest", parseDigestAt);
  if (attemptDigest !== attemptIndexDigest(base)) {
    throw invalid("schema.corrupt", "workflow attempt digest does not match its exact content", ["attemptDigest"]);
  }
  return deepFreeze({ schemaVersion, id, ...base, attemptDigest });
}

export function buildSemanticWorkflowAttemptIndex(
  input: Omit<SemanticWorkflowAttemptIndex, "schemaVersion" | "id" | "attemptDigest">,
): SemanticWorkflowAttemptIndex {
  return parseSemanticWorkflowAttemptIndex({
    schemaVersion: 1,
    id: input.attemptId,
    ...input,
    attemptDigest: attemptIndexDigest(input),
  });
}
