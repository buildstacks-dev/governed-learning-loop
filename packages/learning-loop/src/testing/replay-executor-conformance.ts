// ReplayExecutor conformance suite (contract §Replay and outcomes,
// §Conformance suites; decision 0028). Registers caller-supplied describe/it
// blocks for an executor factory; every replay executor must pass unchanged.
// The suite exercises the executor alone — no loop, no experiment — against
// the claims the kernel's runner relies on: the executor is kernel-minted,
// never throws on a well-formed request, never mutates the request, answers
// with a parseable result, and — whenever it attests — attests exactly the
// request it was given (experiment, definition, episode, arm, repetition,
// fingerprint, fixture, baseline, grader, side-effect policy, nonce) and its
// own exact registration, with uniquely named, type-true measurements.
// Importing this module never loads or registers a test framework.
import { sha256HexOfCanonicalJson } from "../canonical/canonical-json.js";
import { toJsonValue } from "../canonical/to-json-value.js";
import { replayExecutorRegistryProjection } from "../engine/replay-executor.js";
import type { ReplayAttemptRequest, ReplayAttestation, ReplayExecutor } from "../records/replay.js";
import { parseReplayAttemptResult, replayAttestationMismatchReasons } from "../records/replay.js";

export type ReplayExecutorFactory = () => ReplayExecutor | Promise<ReplayExecutor>;

const CONFORMANCE_DOMAIN = "replay-executor-conformance:v1";

function digestOf(label: string): string {
  return sha256HexOfCanonicalJson({ domain: CONFORMANCE_DOMAIN, label });
}

/** A synthetic, self-consistent request; executors may complete or fail it but must attest faithfully. */
function conformanceRequest(
  overrides: Partial<Pick<ReplayAttemptRequest, "arm" | "repetition" | "fingerprintDigest">> & {
    readonly nonce: string;
  },
): ReplayAttemptRequest {
  const arm = overrides.arm ?? "control";
  return {
    experimentId: "conformance-experiment",
    definitionDigest: digestOf("definition"),
    episodeId: "conformance-source/episode-1",
    episodeIdentity: { sourceId: "conformance-source", sourceRecordId: "episode-1", episodeId: "episode-1" },
    arm,
    repetition: overrides.repetition ?? 1,
    fingerprintDigest: overrides.fingerprintDigest ?? digestOf(`${arm}-fingerprint`),
    fixtureDigest: digestOf("fixtures"),
    baselineSnapshotDigest: digestOf("baseline"),
    graderDigest: digestOf("grader"),
    sideEffectCapability: {
      policyDigest: digestOf("side-effects"),
      denyByDefault: true,
      attestationNonce: overrides.nonce,
    },
    budget: { maximumCost: { amount: 1, currency: "USD" }, maximumDurationMs: 60_000 },
  };
}

function canonical(value: unknown): string {
  return sha256HexOfCanonicalJson(toJsonValue(value));
}

async function attempted(
  executor: ReplayExecutor,
  request: ReplayAttemptRequest,
): Promise<ReturnType<typeof parseReplayAttemptResult>> {
  const raw: unknown = await executor.attempt(request);
  return parseReplayAttemptResult(raw);
}

function attestationOf(result: ReturnType<typeof parseReplayAttemptResult>): ReplayAttestation | undefined {
  return result.attestation;
}

export function runReplayExecutorConformance(
  makeExecutor: ReplayExecutorFactory,
  testApi: {
    readonly describe: (name: string, suite: () => void) => void;
    readonly it: (name: string, test: () => void | Promise<void>) => void;
    readonly expect: (actual: unknown) => {
      readonly not: {
        readonly toBe: (expected: unknown) => void;
      };
      readonly toBe: (expected: unknown) => void;
      readonly toBeDefined: () => void;
      readonly toBeLessThanOrEqual: (expected: number) => void;
      readonly toBeUndefined: () => void;
      readonly toEqual: (expected: unknown) => void;
    };
  },
): void {
  const { describe, expect, it } = testApi;
  describe("ReplayExecutor conformance", () => {
    it("is kernel-minted and exposes its exact registration", async () => {
      const executor = await makeExecutor();
      const registration = replayExecutorRegistryProjection(executor);
      expect(registration.id).toBe(executor.id);
      expect(registration.version).toBe(executor.version);
      expect(registration.registrationDigest).toBe(executor.registrationDigest);
      expect(Object.isFrozen(executor)).toBe(true);
    });

    it("answers a well-formed request with a parseable result without throwing or mutating the request", async () => {
      const executor = await makeExecutor();
      const request = conformanceRequest({ nonce: "conformance-nonce-1" });
      const before = canonical(request);
      const result = await attempted(executor, request);
      expect(canonical(request)).toBe(before);
      expect(result.status === "completed" || result.status === "failed").toBe(true);
      if (result.status === "failed") expect(result.diagnostics.length > 0).toBe(true);
    });

    it("attests exactly the request it was given and its own registration", async () => {
      const executor = await makeExecutor();
      const request = conformanceRequest({ nonce: "conformance-nonce-2", arm: "treatment", repetition: 2 });
      const result = await attempted(executor, request);
      const attestation = attestationOf(result);
      if (result.status === "completed") expect(attestation).toBeDefined();
      if (attestation !== undefined) {
        expect(attestation.fingerprintDigest).toBe(request.fingerprintDigest);
        expect(
          replayAttestationMismatchReasons(attestation, {
            request,
            executor: { id: executor.id, version: executor.version, registrationDigest: executor.registrationDigest },
          }),
        ).toEqual([]);
      }
    });

    it("echoes a fresh nonce and arm per request rather than a remembered attestation", async () => {
      const executor = await makeExecutor();
      const first = await attempted(executor, conformanceRequest({ nonce: "conformance-nonce-3", arm: "control" }));
      const second = await attempted(executor, conformanceRequest({ nonce: "conformance-nonce-4", arm: "treatment" }));
      const firstAttestation = attestationOf(first);
      const secondAttestation = attestationOf(second);
      if (firstAttestation !== undefined && secondAttestation !== undefined) {
        expect(firstAttestation.attestationNonce).toBe("conformance-nonce-3");
        expect(secondAttestation.attestationNonce).toBe("conformance-nonce-4");
        expect(firstAttestation.arm).toBe("control");
        expect(secondAttestation.arm).toBe("treatment");
        expect(secondAttestation.fingerprintDigest).not.toBe(firstAttestation.fingerprintDigest);
      }
    });

    it("grades with uniquely named, type-true measurements when it completes", async () => {
      const executor = await makeExecutor();
      const result = await attempted(executor, conformanceRequest({ nonce: "conformance-nonce-5" }));
      if (result.status !== "completed") return;
      expect(result.measurements.length).toBeLessThanOrEqual(100);
      const names = new Set(result.measurements.map((measurement) => measurement.metric.name));
      expect(names.size).toBe(result.measurements.length);
      for (const measurement of result.measurements) {
        expect(typeof measurement.value).toBe(measurement.metric.valueType);
      }
    });
  });
}
