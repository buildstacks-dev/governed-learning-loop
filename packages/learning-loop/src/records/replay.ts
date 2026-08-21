// Replay executor port, attempt request, attestation, and attempt result
// (contract §Replay and outcomes; decision 0028). The host executor owns
// restoring the environment from the baseline snapshot, enforcing the
// deny-by-default side-effect policy, hiding fixtures, running the agent
// under the requested fingerprint, and grading. It returns `unknown`; the
// kernel parses an attestation that must echo every digest of the request
// it was asked to run under — experiment, definition, episode, arm,
// repetition, fingerprint, fixture set, baseline, grader, side-effect policy,
// and the kernel-minted nonce — together with the executor's own exact
// registration. Measurements are typed scalars against frozen metric
// definitions. The kernel cannot sandbox host code; it verifies registration
// and attestation digests, detects fingerprint drift and contamination,
// applies the frozen reference rules, and retains every attempt.
import type { Diagnostic } from "../diagnostics.js";
import { invalid, parseOneOf, parseScalar, readFields } from "../parse/toolkit.js";
import type { Parse } from "../parse/toolkit.js";
import { replayExecutorBrand } from "./brands.js";
import type { MetricDefinition } from "./episode.js";
import { parseMetricDefinitionAt } from "./episode.js";
import type { ExperimentArm, Money } from "./experiment.js";
import {
  EXPERIMENT_ARMS,
  MAX_REPETITIONS_PER_PAIR,
  parseBoundedDiagnosticAt,
  parseBoundedInteger,
  parseMoneyAt,
  sameMetricDefinition,
} from "./experiment.js";
import {
  parseBoundedArray,
  parseBoundedText,
  parseDigestAt,
  parseDurableId,
  parseId,
  parseTrue,
} from "./semantic-shared.js";

export interface ReplayExecutor {
  readonly id: string;
  readonly version: string;
  readonly registrationDigest: string;
  readonly [replayExecutorBrand]: true;

  attempt(input: ReplayAttemptRequest): Promise<unknown>;
}

export interface ReplayAttemptRequest {
  readonly experimentId: string;
  /** Additive (decision 0028): the frozen definition the attempt belongs to. */
  readonly definitionDigest: string;
  /** The exact durable episode record id (the kernel's treatment unit). */
  readonly episodeId: string;
  /** Additive (decision 0028): the resolved adapter identity of that episode. */
  readonly episodeIdentity: {
    readonly sourceId: string;
    readonly sourceRecordId: string;
    readonly episodeId: string;
  };
  readonly arm: ExperimentArm;
  readonly repetition: number;
  readonly fingerprintDigest: string;
  readonly fixtureDigest: string;
  /** Additive (decision 0028): the baseline snapshot the executor must restore. */
  readonly baselineSnapshotDigest: string;
  /** Additive (decision 0028): the grader the executor must attest to. */
  readonly graderDigest: string;
  readonly sideEffectCapability: {
    readonly policyDigest: string;
    readonly denyByDefault: true;
    readonly attestationNonce: string;
  };
  readonly budget: {
    readonly maximumCost?: Money;
    readonly maximumDurationMs?: number;
  };
}

export interface ReplayAttestation {
  readonly executor: {
    readonly id: string;
    readonly version: string;
    readonly registrationDigest: string;
  };
  readonly experimentId: string;
  readonly definitionDigest: string;
  readonly episodeId: string;
  readonly arm: ExperimentArm;
  readonly repetition: number;
  readonly fingerprintDigest: string;
  readonly fixtureDigest: string;
  readonly baselineSnapshotDigest: string;
  readonly graderDigest: string;
  readonly sideEffectPolicyDigest: string;
  readonly attestationNonce: string;
}

export interface ReplayMeasurement {
  readonly metric: MetricDefinition;
  readonly value: number | string | boolean;
}

export type ReplayAttemptResult =
  | {
      readonly status: "completed";
      readonly attestation: ReplayAttestation;
      readonly measurements: readonly ReplayMeasurement[];
      readonly cost?: Money;
      readonly durationMs?: number;
    }
  | {
      readonly status: "failed";
      readonly attestation?: ReplayAttestation;
      readonly diagnostics: readonly Diagnostic[];
      readonly cost?: Money;
      readonly durationMs?: number;
    };

/** Measurements per attempt result; a larger grader output fails closed. */
export const MAX_REPLAY_MEASUREMENTS = 100;
/** Diagnostics per failed attempt; bounded like host authority diagnostics. */
export const MAX_REPLAY_DIAGNOSTICS = 100;
const MAX_REGISTRATION_TEXT_LENGTH = 200;
const MAX_DURATION_MS = 1_000 * 60 * 60 * 24 * 365;
const REPLAY_RESULT_STATUSES = ["completed", "failed"] as const;

export const parseExecutorRegistrationText = parseBoundedText(
  MAX_REGISTRATION_TEXT_LENGTH,
  "executor registration text",
);

/** Nested repetition index, shared by requests, attestations, and attempt records. */
export const parseRepetitionAt = parseBoundedInteger(1, MAX_REPETITIONS_PER_PAIR, "repetition");

/** Attested wall-clock duration, shared by results and attempt records. */
export const parseDurationAt = parseBoundedInteger(0, MAX_DURATION_MS, "durationMs");

const parseEpisodeIdentityAt: Parse<ReplayAttemptRequest["episodeIdentity"]> = (input, path) => {
  const fields = readFields(input, path);
  return {
    sourceId: fields.req("sourceId", parseId),
    sourceRecordId: fields.req("sourceRecordId", parseId),
    episodeId: fields.req("episodeId", parseId),
  };
};

const parseSideEffectCapabilityAt: Parse<ReplayAttemptRequest["sideEffectCapability"]> = (input, path) => {
  const fields = readFields(input, path);
  return {
    policyDigest: fields.req("policyDigest", parseDigestAt),
    denyByDefault: fields.req("denyByDefault", parseTrue),
    attestationNonce: fields.req("attestationNonce", parseId),
  };
};

const parseBudgetAt: Parse<ReplayAttemptRequest["budget"]> = (input, path) => {
  const fields = readFields(input, path);
  const maximumCost = fields.opt("maximumCost", parseMoneyAt);
  const maximumDurationMs = fields.opt("maximumDurationMs", parseDurationAt);
  return {
    ...(maximumCost !== undefined ? { maximumCost } : {}),
    ...(maximumDurationMs !== undefined ? { maximumDurationMs } : {}),
  };
};

export const parseReplayAttemptRequestAt: Parse<ReplayAttemptRequest> = (input, path) => {
  const fields = readFields(input, path);
  return {
    experimentId: fields.req("experimentId", parseId),
    definitionDigest: fields.req("definitionDigest", parseDigestAt),
    episodeId: fields.req("episodeId", parseDurableId),
    episodeIdentity: fields.req("episodeIdentity", parseEpisodeIdentityAt),
    arm: fields.req("arm", parseOneOf(EXPERIMENT_ARMS)),
    repetition: fields.req("repetition", parseRepetitionAt),
    fingerprintDigest: fields.req("fingerprintDigest", parseDigestAt),
    fixtureDigest: fields.req("fixtureDigest", parseDigestAt),
    baselineSnapshotDigest: fields.req("baselineSnapshotDigest", parseDigestAt),
    graderDigest: fields.req("graderDigest", parseDigestAt),
    sideEffectCapability: fields.req("sideEffectCapability", parseSideEffectCapabilityAt),
    budget: fields.req("budget", parseBudgetAt),
  };
};

const parseExecutorRefAt: Parse<ReplayAttestation["executor"]> = (input, path) => {
  const fields = readFields(input, path);
  return {
    id: fields.req("id", parseExecutorRegistrationText),
    version: fields.req("version", parseExecutorRegistrationText),
    registrationDigest: fields.req("registrationDigest", parseDigestAt),
  };
};

export const parseReplayAttestationAt: Parse<ReplayAttestation> = (input, path) => {
  const fields = readFields(input, path);
  return {
    executor: fields.req("executor", parseExecutorRefAt),
    experimentId: fields.req("experimentId", parseId),
    definitionDigest: fields.req("definitionDigest", parseDigestAt),
    episodeId: fields.req("episodeId", parseDurableId),
    arm: fields.req("arm", parseOneOf(EXPERIMENT_ARMS)),
    repetition: fields.req("repetition", parseRepetitionAt),
    fingerprintDigest: fields.req("fingerprintDigest", parseDigestAt),
    fixtureDigest: fields.req("fixtureDigest", parseDigestAt),
    baselineSnapshotDigest: fields.req("baselineSnapshotDigest", parseDigestAt),
    graderDigest: fields.req("graderDigest", parseDigestAt),
    sideEffectPolicyDigest: fields.req("sideEffectPolicyDigest", parseDigestAt),
    attestationNonce: fields.req("attestationNonce", parseId),
  };
};

export const parseReplayMeasurementAt: Parse<ReplayMeasurement> = (input, path) => {
  const fields = readFields(input, path);
  const metric = fields.req("metric", parseMetricDefinitionAt);
  const value = fields.req("value", parseScalar);
  if (typeof value !== metric.valueType) {
    throw invalid("schema.invalid", `replay measurement value must have runtime type ${metric.valueType}`, [
      ...path,
      "value",
    ]);
  }
  return { metric, value };
};

function parseReplayDiagnostics(input: unknown, path: readonly (string | number)[]): readonly Diagnostic[] {
  return parseBoundedArray(parseBoundedDiagnosticAt, MAX_REPLAY_DIAGNOSTICS, "replay diagnostics")(input, path);
}

/**
 * Unknown-first parser for what an executor returns. A completed result
 * carries an attestation and typed measurements with unique metric names; a
 * failed result carries bounded diagnostics and an optional attestation.
 * Unknown fields are dropped; nothing else of the host value is retained.
 */
export function parseReplayAttemptResult(input: unknown): ReplayAttemptResult {
  const path = ["replayAttemptResult"];
  const fields = readFields(input, path);
  const status = fields.req("status", parseOneOf(REPLAY_RESULT_STATUSES));
  const cost = fields.opt("cost", parseMoneyAt);
  const durationMs = fields.opt("durationMs", parseDurationAt);
  const optional = {
    ...(cost !== undefined ? { cost } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
  };
  if (status === "failed") {
    const attestation = fields.opt("attestation", parseReplayAttestationAt);
    return {
      status,
      ...(attestation !== undefined ? { attestation } : {}),
      diagnostics: fields.req("diagnostics", parseReplayDiagnostics),
      ...optional,
    };
  }
  const measurements = fields.req(
    "measurements",
    parseBoundedArray(parseReplayMeasurementAt, MAX_REPLAY_MEASUREMENTS, "replay measurements"),
  );
  const names = new Set<string>();
  for (const [index, measurement] of measurements.entries()) {
    if (names.has(measurement.metric.name)) {
      throw invalid("schema.invalid", "replay measurements must have unique metric names", [
        ...path,
        "measurements",
        index,
        "metric",
        "name",
      ]);
    }
    names.add(measurement.metric.name);
  }
  return {
    status,
    attestation: fields.req("attestation", parseReplayAttestationAt),
    measurements,
    ...optional,
  };
}

export interface AttestationExpectation {
  readonly request: ReplayAttemptRequest;
  readonly executor: { readonly id: string; readonly version: string; readonly registrationDigest: string };
}

/**
 * Every way an attestation can disagree with the request it answers and the
 * executor that was asked, as stable diagnostics. The fingerprint is reported
 * separately by `attestedFingerprintMismatch` because the kernel classifies
 * a drifted and a contaminated fingerprint differently.
 */
export function replayAttestationMismatchReasons(
  attestation: ReplayAttestation,
  expected: AttestationExpectation,
): readonly Diagnostic[] {
  const reasons: Diagnostic[] = [];
  const mismatch = (field: string, expectedValue: string | number, actual: string | number): void => {
    reasons.push({
      code: "experiment.attestation_mismatch",
      severity: "error",
      message: `replay attestation ${field} does not match the request`,
      path: ["attestation", field],
      details: { expected: expectedValue, actual },
    });
  };
  const request = expected.request;
  if (attestation.executor.id !== expected.executor.id)
    mismatch("executor.id", expected.executor.id, attestation.executor.id);
  if (attestation.executor.version !== expected.executor.version) {
    mismatch("executor.version", expected.executor.version, attestation.executor.version);
  }
  if (attestation.executor.registrationDigest !== expected.executor.registrationDigest) {
    mismatch(
      "executor.registrationDigest",
      expected.executor.registrationDigest,
      attestation.executor.registrationDigest,
    );
  }
  if (attestation.experimentId !== request.experimentId)
    mismatch("experimentId", request.experimentId, attestation.experimentId);
  if (attestation.definitionDigest !== request.definitionDigest) {
    mismatch("definitionDigest", request.definitionDigest, attestation.definitionDigest);
  }
  if (attestation.episodeId !== request.episodeId) mismatch("episodeId", request.episodeId, attestation.episodeId);
  if (attestation.arm !== request.arm) mismatch("arm", request.arm, attestation.arm);
  if (attestation.repetition !== request.repetition) mismatch("repetition", request.repetition, attestation.repetition);
  if (attestation.fixtureDigest !== request.fixtureDigest)
    mismatch("fixtureDigest", request.fixtureDigest, attestation.fixtureDigest);
  if (attestation.baselineSnapshotDigest !== request.baselineSnapshotDigest) {
    mismatch("baselineSnapshotDigest", request.baselineSnapshotDigest, attestation.baselineSnapshotDigest);
  }
  if (attestation.graderDigest !== request.graderDigest)
    mismatch("graderDigest", request.graderDigest, attestation.graderDigest);
  if (attestation.sideEffectPolicyDigest !== request.sideEffectCapability.policyDigest) {
    mismatch("sideEffectPolicyDigest", request.sideEffectCapability.policyDigest, attestation.sideEffectPolicyDigest);
  }
  if (attestation.attestationNonce !== request.sideEffectCapability.attestationNonce) {
    mismatch("attestationNonce", request.sideEffectCapability.attestationNonce, attestation.attestationNonce);
  }
  return reasons;
}

/** Finds the declared metric among an attempt's measurements by exact definition equality. */
export function findReplayMeasurement(
  measurements: readonly ReplayMeasurement[],
  metric: MetricDefinition,
): ReplayMeasurement | undefined {
  return measurements.find(
    (measurement) => measurement.metric.name === metric.name && sameMetricDefinition(measurement.metric, metric),
  );
}
