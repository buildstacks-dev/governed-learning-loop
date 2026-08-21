// Replay attempt journal record (decision 0028). Private store kind
// `experiment-attempt`, one record per declared design slot, keyed by the
// content-addressed attempt id. An attempt is written `dispatched` with its
// exact request (nonce and budget included) BEFORE the executor is invoked
// and completed with one compare-and-set afterwards, so a crash between the
// two leaves a durable dispatched record that no later runner re-executes:
// the executor may have run, so the slot is `outcome_unknown` and the
// evaluation is invalid (the decision-0022 dispatch-only posture). Completed
// results retain the parsed attestation, the declared metrics' measurements,
// and attested cost/duration; failed results retain the executor's bounded
// diagnostics; a result the kernel could not parse is retained as `rejected`
// with kernel diagnostics only. Raw executor bytes never persist.
import { sha256HexOfCanonicalJson } from "../canonical/canonical-json.js";
import type { JsonValue } from "../canonical/json.js";
import { toJsonValue } from "../canonical/to-json-value.js";
import type { Diagnostic } from "../diagnostics.js";
import { LearningLoopError } from "../diagnostics.js";
import { invalid, parseOneOf, readFields } from "../parse/toolkit.js";
import type { Parse } from "../parse/toolkit.js";
import type { ExperimentArm, Money } from "../records/experiment.js";
import {
  EXPERIMENT_ARMS,
  diagnosticContent,
  experimentAttemptIdFor,
  moneyContent,
  parseBoundedDiagnosticAt,
  parseBoundedInteger,
  parseMoneyAt,
} from "../records/experiment.js";
import type { ReplayAttemptRequest, ReplayAttestation, ReplayMeasurement } from "../records/replay.js";
import {
  MAX_REPLAY_DIAGNOSTICS,
  MAX_REPLAY_MEASUREMENTS,
  parseDurationAt,
  parseRepetitionAt,
  parseReplayAttemptRequestAt,
  parseReplayAttestationAt,
  parseReplayMeasurementAt,
} from "../records/replay.js";
import {
  parseBoundedArray,
  parseCanonicalTimestampAt,
  parseDigestAt,
  parseDurableId,
  parseId,
} from "../records/semantic-shared.js";
import type { EngineContext } from "./context.js";
import { loadStoredRecord, parseWriteResult, recordDigest, recordKey } from "./context.js";

export type AttemptRecordStatus = "dispatched" | "completed" | "failed" | "rejected";
const ATTEMPT_RECORD_STATUSES = ["dispatched", "completed", "failed", "rejected"] as const;
const ATTEMPT_KIND = "experiment-attempt";
const ATTEMPT_DIGEST_DOMAIN = "experiment-attempt:v1";
const MAX_KERNEL_DIAGNOSTICS = 1_000;

export interface CompletedAttemptResult {
  readonly attestation: ReplayAttestation;
  /** Only the declared primary and guardrail metrics are retained. */
  readonly measurements: readonly ReplayMeasurement[];
  readonly ignoredMeasurementCount: number;
  readonly cost?: Money;
  readonly durationMs?: number;
}

export interface FailedAttemptResult {
  readonly attestation?: ReplayAttestation;
  readonly diagnostics: readonly Diagnostic[];
  readonly cost?: Money;
  readonly durationMs?: number;
}

export interface ExperimentAttempt {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly experimentId: string;
  readonly definitionDigest: string;
  readonly episodeId: string;
  readonly arm: ExperimentArm;
  readonly repetition: number;
  readonly request: ReplayAttemptRequest;
  readonly dispatchedAt: string;
  readonly status: AttemptRecordStatus;
  readonly completed?: CompletedAttemptResult;
  readonly failed?: FailedAttemptResult;
  /** Kernel diagnostics explaining why the executor's value could not be parsed. */
  readonly rejected?: readonly Diagnostic[];
  readonly completedAt?: string;
  readonly attemptDigest: string;
}

type AttemptContent = Omit<ExperimentAttempt, "schemaVersion" | "id" | "attemptDigest">;

function corrupt(message: string): LearningLoopError {
  return new LearningLoopError("store.corrupt", [{ code: "store.corrupt", severity: "error", message }]);
}

function attemptContent(input: AttemptContent): JsonValue {
  return {
    domain: ATTEMPT_DIGEST_DOMAIN,
    experimentId: input.experimentId,
    definitionDigest: input.definitionDigest,
    episodeId: input.episodeId,
    arm: input.arm,
    repetition: input.repetition,
    request: toJsonValue(input.request),
    dispatchedAt: input.dispatchedAt,
    status: input.status,
    ...(input.completed !== undefined
      ? {
          completed: {
            attestation: toJsonValue(input.completed.attestation),
            measurements: input.completed.measurements.map((measurement) => ({
              metric: toJsonValue(measurement.metric),
              value: measurement.value,
            })),
            ignoredMeasurementCount: input.completed.ignoredMeasurementCount,
            ...(input.completed.cost !== undefined ? { cost: moneyContent(input.completed.cost) } : {}),
            ...(input.completed.durationMs !== undefined ? { durationMs: input.completed.durationMs } : {}),
          },
        }
      : {}),
    ...(input.failed !== undefined
      ? {
          failed: {
            ...(input.failed.attestation !== undefined ? { attestation: toJsonValue(input.failed.attestation) } : {}),
            diagnostics: input.failed.diagnostics.map(diagnosticContent),
            ...(input.failed.cost !== undefined ? { cost: moneyContent(input.failed.cost) } : {}),
            ...(input.failed.durationMs !== undefined ? { durationMs: input.failed.durationMs } : {}),
          },
        }
      : {}),
    ...(input.rejected !== undefined ? { rejected: input.rejected.map(diagnosticContent) } : {}),
    ...(input.completedAt !== undefined ? { completedAt: input.completedAt } : {}),
  };
}

export function experimentAttemptDigest(input: AttemptContent): string {
  return sha256HexOfCanonicalJson(attemptContent(input));
}

const parseCountAt = parseBoundedInteger(0, MAX_REPLAY_MEASUREMENTS, "ignoredMeasurementCount");

const parseCompletedAt: Parse<CompletedAttemptResult> = (input, path) => {
  const fields = readFields(input, path);
  const cost = fields.opt("cost", parseMoneyAt);
  const durationMs = fields.opt("durationMs", parseDurationAt);
  return {
    attestation: fields.req("attestation", parseReplayAttestationAt),
    measurements: fields.req(
      "measurements",
      parseBoundedArray(parseReplayMeasurementAt, MAX_REPLAY_MEASUREMENTS, "retained measurements"),
    ),
    ignoredMeasurementCount: fields.req("ignoredMeasurementCount", parseCountAt),
    ...(cost !== undefined ? { cost } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
  };
};

const parseFailedAt: Parse<FailedAttemptResult> = (input, path) => {
  const fields = readFields(input, path);
  const attestation = fields.opt("attestation", parseReplayAttestationAt);
  const cost = fields.opt("cost", parseMoneyAt);
  const durationMs = fields.opt("durationMs", parseDurationAt);
  return {
    ...(attestation !== undefined ? { attestation } : {}),
    diagnostics: fields.req(
      "diagnostics",
      parseBoundedArray(parseBoundedDiagnosticAt, MAX_REPLAY_DIAGNOSTICS, "executor diagnostics"),
    ),
    ...(cost !== undefined ? { cost } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
  };
};

export function parseExperimentAttempt(input: unknown): ExperimentAttempt {
  const fields = readFields(input, []);
  const schemaVersion = fields.schemaVersion1();
  const status = fields.req("status", parseOneOf(ATTEMPT_RECORD_STATUSES));
  const completed = fields.opt("completed", parseCompletedAt);
  const failed = fields.opt("failed", parseFailedAt);
  const rejected = fields.opt(
    "rejected",
    parseBoundedArray(parseBoundedDiagnosticAt, MAX_KERNEL_DIAGNOSTICS, "rejection diagnostics"),
  );
  const completedAt = fields.opt("completedAt", parseCanonicalTimestampAt);
  const terminalParts = [completed, failed, rejected].filter((part) => part !== undefined).length;
  if (status === "dispatched" ? terminalParts !== 0 || completedAt !== undefined : terminalParts !== 1) {
    throw invalid("schema.invalid", "attempt status does not agree with its result parts", ["status"]);
  }
  if (
    (status === "completed" && completed === undefined) ||
    (status === "failed" && failed === undefined) ||
    (status === "rejected" && rejected === undefined)
  ) {
    throw invalid("schema.invalid", "attempt status does not agree with its result part", ["status"]);
  }
  if (status !== "dispatched" && completedAt === undefined) {
    throw invalid("schema.invalid", "a terminal attempt records when it completed", ["completedAt"]);
  }
  const content: AttemptContent = {
    experimentId: fields.req("experimentId", parseId),
    definitionDigest: fields.req("definitionDigest", parseDigestAt),
    episodeId: fields.req("episodeId", parseDurableId),
    arm: fields.req("arm", parseOneOf(EXPERIMENT_ARMS)),
    repetition: fields.req("repetition", parseRepetitionAt),
    request: fields.req("request", parseReplayAttemptRequestAt),
    dispatchedAt: fields.req("dispatchedAt", parseCanonicalTimestampAt),
    status,
    ...(completed !== undefined ? { completed } : {}),
    ...(failed !== undefined ? { failed } : {}),
    ...(rejected !== undefined ? { rejected } : {}),
    ...(completedAt !== undefined ? { completedAt } : {}),
  };
  if (
    content.request.experimentId !== content.experimentId ||
    content.request.definitionDigest !== content.definitionDigest ||
    content.request.episodeId !== content.episodeId ||
    content.request.arm !== content.arm ||
    content.request.repetition !== content.repetition
  ) {
    throw invalid("schema.corrupt", "attempt request does not match its slot", ["request"]);
  }
  const attemptDigest = fields.req("attemptDigest", parseDigestAt);
  if (attemptDigest !== experimentAttemptDigest(content)) {
    throw invalid("schema.corrupt", "attempt digest does not match its content", ["attemptDigest"]);
  }
  const id = fields.req("id", parseDurableId);
  if (id !== experimentAttemptIdFor(content)) {
    throw invalid("schema.corrupt", "attempt id does not derive from its slot", ["id"]);
  }
  return { schemaVersion, id, ...content, attemptDigest };
}

export function buildExperimentAttempt(content: AttemptContent): ExperimentAttempt {
  return parseExperimentAttempt({
    schemaVersion: 1,
    id: experimentAttemptIdFor(content),
    ...content,
    attemptDigest: experimentAttemptDigest(content),
  });
}

export interface StoredAttempt {
  readonly attempt: ExperimentAttempt;
  readonly revision: string;
}

export async function loadExperimentAttempt(
  context: EngineContext,
  attemptId: string,
): Promise<StoredAttempt | undefined> {
  const stored = await loadStoredRecord(context, ATTEMPT_KIND, attemptId);
  if (stored === undefined) return undefined;
  const attempt = parseExperimentAttempt(stored.value);
  if (attempt.id !== attemptId) throw corrupt("stored experiment attempt id does not match its record key");
  return { attempt, revision: stored.revision };
}

/**
 * Create-only dispatch record. Only `created` carries the revision the
 * terminal compare-and-set needs; `owned_elsewhere` (a conflict or an
 * identical replayed dispatch) means another dispatch owns this slot.
 */
export async function dispatchExperimentAttempt(
  context: EngineContext,
  attempt: ExperimentAttempt,
): Promise<{ readonly status: "created"; readonly revision: string } | { readonly status: "owned_elsewhere" }> {
  if (attempt.status !== "dispatched") throw corrupt("only a dispatched attempt may be created");
  const value = toJsonValue(attempt);
  const raw: unknown = await context.store.create(
    recordKey(ATTEMPT_KIND, attempt.id),
    value,
    recordDigest(value),
    `experiment-attempt/${attempt.id}`,
  );
  const result = parseWriteResult(raw);
  if (result.status === "updated") throw corrupt("store returned updated for an attempt create");
  return result.status === "created" ? { status: "created", revision: result.revision } : { status: "owned_elsewhere" };
}

/** The single compare-and-set that makes a dispatched attempt terminal. */
export async function completeExperimentAttempt(
  context: EngineContext,
  expectedRevision: string,
  attempt: ExperimentAttempt,
): Promise<ExperimentAttempt> {
  if (attempt.status === "dispatched") throw corrupt("a terminal attempt must not be dispatched");
  const value = toJsonValue(attempt);
  const raw: unknown = await context.store.compareAndSet(
    recordKey(ATTEMPT_KIND, attempt.id),
    expectedRevision,
    value,
    recordDigest(value),
    `experiment-attempt/${attempt.id}/${attempt.status}`,
  );
  const result = parseWriteResult(raw);
  if (result.status === "conflict") {
    throw new LearningLoopError("store.conflict", [
      {
        code: "store.conflict",
        severity: "error",
        message: `experiment attempt "${attempt.id}" changed while its result was being recorded`,
      },
    ]);
  }
  const reloaded = await loadExperimentAttempt(context, attempt.id);
  if (reloaded === undefined || reloaded.attempt.attemptDigest !== attempt.attemptDigest) {
    throw corrupt("experiment attempt result was acknowledged but is not the stored record");
  }
  return reloaded.attempt;
}
