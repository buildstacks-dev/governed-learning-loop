// The /testing in-memory replay executor must pass the public replay
// executor conformance suite — the suite, not this file, is the contract —
// and its reference semantics (faithful attestation, scripted failure, raw
// and thrown answers, recorded requests) are pinned here for adapter authors.
import { describe, expect, it } from "vitest";
import type { ReplayAttemptRequest } from "../src/index.js";
import { parseReplayAttemptResult } from "../src/index.js";
import { faithfulAttestation } from "../src/testing/in-memory-replay-executor.js";
import { createInMemoryReplayExecutor, runReplayExecutorConformance } from "../src/testing/index.js";
import { CONTROL_FINGERPRINT, PRIMARY_METRIC, hostDigest } from "./experiment-harness.js";

runReplayExecutorConformance(() => createInMemoryReplayExecutor().executor, { describe, expect, it });

function request(nonce: string): ReplayAttemptRequest {
  return {
    experimentId: "exp-1",
    definitionDigest: hostDigest("definition"),
    episodeId: "manual-evidence/exp-ep-1",
    episodeIdentity: { sourceId: "manual-evidence", sourceRecordId: "exp-ep-1", episodeId: "exp-ep-1" },
    arm: "control",
    repetition: 1,
    fingerprintDigest: CONTROL_FINGERPRINT,
    fixtureDigest: hostDigest("fixtures"),
    baselineSnapshotDigest: hostDigest("baseline"),
    graderDigest: hostDigest("grader"),
    sideEffectCapability: { policyDigest: hostDigest("side-effects"), denyByDefault: true, attestationNonce: nonce },
    budget: {},
  };
}

describe("createInMemoryReplayExecutor reference semantics", () => {
  it("answers the default grade with a faithful attestation and records every request", async () => {
    const memory = createInMemoryReplayExecutor();
    const result = parseReplayAttemptResult(await memory.executor.attempt(request("n-1")));
    expect(result).toEqual({
      status: "completed",
      attestation: faithfulAttestation(request("n-1"), memory.executor),
      measurements: [
        { metric: { name: "replay_completed", valueType: "boolean", unit: "pass", aggregation: "all" }, value: true },
      ],
    });
    expect(memory.calls.attempt).toBe(1);
    expect(memory.requests).toEqual([request("n-1")]);
    expect(memory.executor.id).toBe("in-memory-replay");
  });

  it("scripts completed, failed, thrown, and raw answers for kernel classification tests", async () => {
    const memory = createInMemoryReplayExecutor({
      id: "scripted",
      grade: (_request, attempt) => {
        if (attempt === 1)
          return {
            status: "completed",
            measurements: [{ metric: PRIMARY_METRIC, value: false }],
            cost: { amount: 2, currency: "USD" },
          };
        if (attempt === 2)
          return {
            status: "failed",
            diagnostics: [{ code: "host.timeout", severity: "error", message: "timed out" }],
            attested: true,
          };
        if (attempt === 3) return { status: "throw" };
        return { status: "raw", value: "not a result" };
      },
    });
    const completed = parseReplayAttemptResult(await memory.executor.attempt(request("n-1")));
    expect(completed.status).toBe("completed");
    if (completed.status === "completed") {
      expect(completed.measurements).toEqual([{ metric: PRIMARY_METRIC, value: false }]);
      expect(completed.cost).toEqual({ amount: 2, currency: "USD" });
    }
    const failed = parseReplayAttemptResult(await memory.executor.attempt(request("n-2")));
    expect(failed.status).toBe("failed");
    if (failed.status === "failed") {
      expect(failed.attestation).toEqual(faithfulAttestation(request("n-2"), memory.executor));
      expect(failed.diagnostics[0]?.code).toBe("host.timeout");
    }
    await expect(memory.executor.attempt(request("n-3"))).rejects.toThrow(/scripted failure/);
    expect(await memory.executor.attempt(request("n-4"))).toBe("not a result");
    expect(memory.calls.attempt).toBe(4);
  });
});
