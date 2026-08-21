// Deterministic in-memory ReplayExecutor for tests, examples, and the replay
// executor conformance suite (decision 0028). It is inert by construction:
// nothing is restored, executed, or graded outside process memory — no
// workspace, model, tool, file, or network is touched. It is the reference for
// adapter authors of what the kernel verifies:
// - the attestation echoes every digest of the request (experiment,
//   definition, episode, arm, repetition, fingerprint, fixture, baseline,
//   grader, side-effect policy, nonce) together with this executor's exact
//   registration; the kernel refuses anything else as drift, contamination,
//   or attestation mismatch;
// - measurements are typed scalars against the frozen metric definitions the
//   grader script returns; a declared metric the script omits is
//   `metric_missing`, never zero;
// - the script can also report a failure, throw, or answer raw bytes so a
//   test can prove the kernel retains and classifies each case.
import { sha256HexOfCanonicalJson } from "../canonical/canonical-json.js";
import type { Diagnostic } from "../diagnostics.js";
import type { Money } from "../records/experiment.js";
import type { ReplayAttemptRequest, ReplayAttestation, ReplayExecutor, ReplayMeasurement } from "../records/replay.js";
import { defineReplayExecutor } from "../engine/replay-executor.js";

export type InMemoryReplayGrade =
  | {
      readonly status: "completed";
      readonly measurements: readonly ReplayMeasurement[];
      readonly cost?: Money;
      readonly durationMs?: number;
      /** Test hook: fields that override the faithful attestation (to simulate drift or contamination). */
      readonly attestation?: Partial<ReplayAttestation>;
    }
  | {
      readonly status: "failed";
      readonly diagnostics: readonly Diagnostic[];
      readonly cost?: Money;
      readonly durationMs?: number;
      /** When true the failure carries a faithful attestation. */
      readonly attested?: boolean;
    }
  | { readonly status: "throw" }
  | { readonly status: "raw"; readonly value: unknown };

export interface InMemoryReplayExecutorOptions {
  /** Executor id; default `in-memory-replay`. */
  readonly id?: string;
  /** Executor version; default `1.0.0`. */
  readonly version?: string;
  /** Configuration digest; default the digest of the executor id. */
  readonly configurationDigest?: string;
  /** Grades one request; default completes with one boolean `replay_completed: true` measurement. */
  readonly grade?: (request: ReplayAttemptRequest, attempt: number) => InMemoryReplayGrade;
}

export interface InMemoryReplayExecutor {
  /** The kernel-minted executor to configure on a loop (`replayExecutors: [memory.executor]`). */
  readonly executor: ReplayExecutor;
  /** Every request received, in order; the kernel never re-sends a slot it dispatched. */
  readonly requests: readonly ReplayAttemptRequest[];
  readonly calls: { readonly attempt: number };
}

export const IN_MEMORY_REPLAY_METRIC = Object.freeze({
  name: "replay_completed",
  valueType: "boolean",
  unit: "pass",
  aggregation: "all",
} as const);

function defaultGrade(): InMemoryReplayGrade {
  return { status: "completed", measurements: [{ metric: IN_MEMORY_REPLAY_METRIC, value: true }] };
}

/** The faithful attestation of a request by a given executor registration: exactly what the kernel verifies. */
export function faithfulAttestation(
  request: ReplayAttemptRequest,
  executor: { readonly id: string; readonly version: string; readonly registrationDigest: string },
): ReplayAttestation {
  return {
    executor: { id: executor.id, version: executor.version, registrationDigest: executor.registrationDigest },
    experimentId: request.experimentId,
    definitionDigest: request.definitionDigest,
    episodeId: request.episodeId,
    arm: request.arm,
    repetition: request.repetition,
    fingerprintDigest: request.fingerprintDigest,
    fixtureDigest: request.fixtureDigest,
    baselineSnapshotDigest: request.baselineSnapshotDigest,
    graderDigest: request.graderDigest,
    sideEffectPolicyDigest: request.sideEffectCapability.policyDigest,
    attestationNonce: request.sideEffectCapability.attestationNonce,
  };
}

export function createInMemoryReplayExecutor(options: InMemoryReplayExecutorOptions = {}): InMemoryReplayExecutor {
  const id = options.id ?? "in-memory-replay";
  const version = options.version ?? "1.0.0";
  const configurationDigest = options.configurationDigest ?? sha256HexOfCanonicalJson({ inMemoryReplayExecutor: id });
  const grade = options.grade ?? defaultGrade;
  const requests: ReplayAttemptRequest[] = [];
  const calls = { attempt: 0 };
  let registration: { readonly id: string; readonly version: string; readonly registrationDigest: string } | undefined;
  const executor = defineReplayExecutor({
    id,
    version,
    configurationDigest,
    attempt: (request) => {
      calls.attempt += 1;
      requests.push(structuredClone(request));
      if (registration === undefined) return Promise.reject(new Error("in-memory replay executor is not registered"));
      const graded = grade(request, calls.attempt);
      if (graded.status === "throw") return Promise.reject(new Error("in-memory replay executor scripted failure"));
      if (graded.status === "raw") return Promise.resolve(graded.value);
      const attestation = faithfulAttestation(request, registration);
      if (graded.status === "failed") {
        return Promise.resolve({
          status: "failed",
          ...(graded.attested === true ? { attestation } : {}),
          diagnostics: graded.diagnostics,
          ...(graded.cost !== undefined ? { cost: graded.cost } : {}),
          ...(graded.durationMs !== undefined ? { durationMs: graded.durationMs } : {}),
        });
      }
      return Promise.resolve({
        status: "completed",
        attestation: { ...attestation, ...graded.attestation },
        measurements: graded.measurements,
        ...(graded.cost !== undefined ? { cost: graded.cost } : {}),
        ...(graded.durationMs !== undefined ? { durationMs: graded.durationMs } : {}),
      });
    },
  });
  registration = { id: executor.id, version: executor.version, registrationDigest: executor.registrationDigest };
  return Object.freeze({ executor, requests, calls });
}
