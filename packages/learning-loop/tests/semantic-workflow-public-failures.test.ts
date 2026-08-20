// Hermetic provider boundary controls through the public /workflows API.
import { describe, expect, it } from "vitest";
import type { SemanticWorkflowBundle } from "@cormidia/learning-loop/workflows";
import {
  canonicalWorkflowBytes,
  createGenerationHarness,
  failedProviderResult,
  negativeProviderResult,
  positiveProviderResult,
  providerResultPayload,
  providerSignal,
  refusedProviderResult,
  workflowKeyedDigest,
} from "./semantic-workflow-generation-harness.js";

async function prepare(
  bundle: SemanticWorkflowBundle,
  input: Parameters<SemanticWorkflowBundle["prepareGeneration"]>[0],
) {
  const result = await bundle.prepareGeneration(input);
  if (result.status !== "prepared") throw new Error(`expected prepared workflow, got ${result.status}`);
  return result;
}

async function runLocal(
  script: (input: unknown) => Promise<unknown>,
  options: Parameters<typeof createGenerationHarness>[0] = {},
) {
  const harness = await createGenerationHarness({ transport: "local", ...options });
  harness.providerState.script = script;
  const prepared = await prepare(harness.bundle, harness.prepareInput);
  const result = await harness.bundle.runGeneration({ plan: prepared.plan, authorization: null });
  return { harness, prepared, result };
}

async function globalRecords(harness: Awaited<ReturnType<typeof createGenerationHarness>>, kind: string) {
  return (await harness.store.list({ namespace: "learning", kind, limit: 100 })).records;
}

async function queriedTurnIds(harness: Awaited<ReturnType<typeof createGenerationHarness>>): Promise<string[]> {
  const ids: string[] = [];
  for await (const page of harness.bundle.queryTurns({ scope: harness.scope, limit: 100 })) {
    ids.push(...page.items.map((item) => item.id));
  }
  return ids;
}

function nestedValue(levels: number): unknown {
  let value: unknown = null;
  for (let level = 0; level < levels; level += 1) value = { value };
  return value;
}

function structureNodes(input: unknown): number {
  const stack: unknown[] = [input];
  let count = 0;
  while (stack.length > 0) {
    const value = stack.pop();
    count += 1;
    if (Array.isArray(value)) {
      stack.push(...value);
    } else if (typeof value === "object" && value !== null) {
      stack.push(...Object.values(value));
    }
  }
  return count;
}

describe("public semantic generation provider failures", () => {
  it("commits explicit provider refusal and failure with static reasons and no derivations", async () => {
    const cases: readonly (readonly [string, (input: unknown) => Promise<unknown>])[] = [
      ["provider_refused", (input: unknown) => Promise.resolve(refusedProviderResult(input))],
      ["provider_failed", (input: unknown) => Promise.resolve(failedProviderResult(input))],
    ];
    for (const [status, script] of cases) {
      const { harness, result } = await runLocal(script);
      expect(result).toMatchObject({ status, persistence: "committed", callbackInvoked: true, derivations: [] });
      expect(result.turnId).not.toBeNull();
      if (result.turnId === null) throw new Error("noncompleted provider result omitted its turn id");
      await expect(harness.bundle.getTurn({ turnId: result.turnId, scope: harness.scope })).resolves.toMatchObject({
        status,
        output: { kind: "none", reasonCode: `workflow.${status}` },
      });
      expect(harness.providerState.calls).toHaveLength(1);
    }
  });

  it("sanitizes thrown provider errors into outcome_unknown without redispatch or durable error text", async () => {
    const canary = "PRIVATE-PROVIDER-THROW-CANARY";
    const { harness, prepared, result } = await runLocal(() => Promise.reject(new Error(canary)));
    expect(result).toMatchObject({
      status: "outcome_unknown",
      persistence: "dispatch_only",
      callbackInvoked: true,
      turnId: null,
      derivations: [],
    });
    expect(await globalRecords(harness, "semantic-workflow-dispatch")).toHaveLength(1);
    expect(await globalRecords(harness, "semantic-workflow-result")).toEqual([]);
    expect(await globalRecords(harness, "semantic-workflow-completion")).toEqual([]);
    await expect(queriedTurnIds(harness)).resolves.toEqual([]);
    expect(harness.providerState.calls).toHaveLength(1);
    const retried = await harness.bundle.runGeneration({ plan: prepared.plan, authorization: null });
    expect(retried.callbackInvoked).toBe(false);
    expect(harness.providerState.calls).toHaveLength(1);
    const durable = await harness.store.list({ namespace: "learning", limit: 1_000 });
    expect(JSON.stringify(durable.records)).not.toContain(canary);
  });

  it("aborts a nonsettling provider at its exact duration ceiling and never calls twice", async () => {
    const canary = "PRIVATE-PROVIDER-TIMEOUT-CANARY";
    const { harness, prepared, result } = await runLocal(
      (input) =>
        new Promise((_, reject) => {
          const signal = providerSignal(input);
          signal.addEventListener("abort", () => reject(new Error(canary)), { once: true });
        }),
      { maximumDurationMs: 5 },
    );
    expect(result).toMatchObject({
      status: "outcome_unknown",
      persistence: "dispatch_only",
      callbackInvoked: true,
      turnId: null,
    });
    expect(await globalRecords(harness, "semantic-workflow-dispatch")).toHaveLength(1);
    expect(await globalRecords(harness, "semantic-workflow-result")).toEqual([]);
    expect(await globalRecords(harness, "semantic-workflow-completion")).toEqual([]);
    await expect(queriedTurnIds(harness)).resolves.toEqual([]);
    expect(harness.providerState.calls).toHaveLength(1);
    const retried = await harness.bundle.runGeneration({ plan: prepared.plan, authorization: null });
    expect(retried.callbackInvoked).toBe(false);
    expect(harness.providerState.calls).toHaveLength(1);
    expect(JSON.stringify(await harness.store.list({ namespace: "learning", limit: 1_000 }))).not.toContain(canary);
  });

  it("classifies malformed provider envelopes, malformed generation drafts, and missing usage without outputs", async () => {
    const scripts: readonly ((input: unknown) => Promise<unknown>)[] = [
      () => Promise.resolve({ malformed: true }),
      (input) => {
        const value = positiveProviderResult(input);
        if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("fixture malformed");
        return Promise.resolve({ ...value, result: { conditionDetected: true, insights: "invalid", findings: [] } });
      },
      (input) => {
        const value = positiveProviderResult(input);
        if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("fixture malformed");
        return Promise.resolve({
          ...value,
          result: { conditionDetected: true, recurrenceLocator: null, insights: [], findings: [] },
        });
      },
      (input) => {
        const value = positiveProviderResult(input);
        if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("fixture malformed");
        const payload = providerResultPayload(value);
        if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
          throw new Error("fixture result malformed");
        }
        return Promise.resolve({
          ...value,
          result: {
            ...payload,
            recurrenceLocator: { treatment: "public_structural", structuralLabel: "forbidden" },
          },
        });
      },
      (input) => {
        const value = positiveProviderResult(input);
        if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("fixture malformed");
        const payload = providerResultPayload(value);
        if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
          throw new Error("fixture result malformed");
        }
        return Promise.resolve({
          ...value,
          result: { ...payload, conditionDetected: false },
        });
      },
      (input) => {
        const value = positiveProviderResult(input);
        if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("fixture malformed");
        const withoutUsage = Object.fromEntries(Object.entries(value).filter(([key]) => key !== "usage"));
        return Promise.resolve(withoutUsage);
      },
    ];
    for (const script of scripts) {
      const { result } = await runLocal(script);
      expect(result).toMatchObject({ status: "result_invalid", callbackInvoked: true, derivations: [] });
    }
  });

  it("projects unreported usage as an explicit reason and never as inferred zero", async () => {
    const unreportedRefusal = await runLocal((input) => {
      const value = refusedProviderResult(input);
      if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("fixture malformed");
      return Promise.resolve({ ...value, usage: null });
    });
    expect(unreportedRefusal.result.status).toBe("provider_refused");
    if (unreportedRefusal.result.turnId === null) throw new Error("refused result omitted its turn");
    const view = await unreportedRefusal.harness.bundle.getTurn({
      turnId: unreportedRefusal.result.turnId,
      scope: unreportedRefusal.harness.scope,
    });
    expect(view?.usage).toEqual({ status: "unreported", reasonCode: "usage.not_reported" });
    expect(JSON.stringify(view?.usage)).not.toContain("Tokens");

    const missingCompletedUsage = await runLocal((input) => {
      const value = positiveProviderResult(input);
      if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("fixture malformed");
      return Promise.resolve(Object.fromEntries(Object.entries(value).filter(([key]) => key !== "usage")));
    });
    expect(missingCompletedUsage.result.status).toBe("result_invalid");
    if (missingCompletedUsage.result.turnId === null) throw new Error("invalid result omitted its turn");
    const invalidView = await missingCompletedUsage.harness.bundle.getTurn({
      turnId: missingCompletedUsage.result.turnId,
      scope: missingCompletedUsage.harness.scope,
    });
    expect(invalidView?.usage).toEqual({ status: "unreported", reasonCode: "usage.not_reported" });
  });

  it("keeps reported usage exact, permits explicit zero, and never infers malformed measurements", async () => {
    const exact = await runLocal((input) => Promise.resolve(positiveProviderResult(input)), {
      maximumOutputTokens: 25,
    });
    expect(exact.result.status).toBe("completed");

    const exceeded = await runLocal(
      (input) => {
        const value = positiveProviderResult(input);
        if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("fixture malformed");
        return Promise.resolve({
          ...value,
          usage: {
            status: "reported",
            inputTokens: 100,
            outputTokens: 26,
            durationMs: 50,
            costMinorUnits: 1,
            currency: "USD",
          },
        });
      },
      { maximumOutputTokens: 25 },
    );
    expect(exceeded.result.status).toBe("result_limit");

    const zero = await runLocal((input) => {
      const value = positiveProviderResult(input);
      if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("fixture malformed");
      return Promise.resolve({
        ...value,
        usage: {
          status: "reported",
          inputTokens: 0,
          outputTokens: 0,
          durationMs: 0,
          costMinorUnits: 0,
          currency: "USD",
        },
      });
    });
    expect(zero.result.status).toBe("completed");

    const exactBudget = await runLocal((input) => {
      const value = positiveProviderResult(input);
      if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("fixture malformed");
      return Promise.resolve({
        ...value,
        usage: {
          status: "reported",
          inputTokens: 10_000,
          outputTokens: 2_000,
          durationMs: 1_000,
          costMinorUnits: 100,
          currency: "USD",
        },
      });
    });
    expect(exactBudget.result.status).toBe("completed");

    for (const usage of [
      {
        status: "reported",
        inputTokens: 10_001,
        outputTokens: 2_000,
        durationMs: 1_000,
        costMinorUnits: 100,
        currency: "USD",
      },
      {
        status: "reported",
        inputTokens: 10_000,
        outputTokens: 2_001,
        durationMs: 1_000,
        costMinorUnits: 100,
        currency: "USD",
      },
      {
        status: "reported",
        inputTokens: 10_000,
        outputTokens: 2_000,
        durationMs: 1_001,
        costMinorUnits: 100,
        currency: "USD",
      },
      {
        status: "reported",
        inputTokens: 10_000,
        outputTokens: 2_000,
        durationMs: 1_000,
        costMinorUnits: 101,
        currency: "USD",
      },
    ]) {
      const limited = await runLocal((input) => {
        const value = positiveProviderResult(input);
        if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("fixture malformed");
        return Promise.resolve({ ...value, usage });
      });
      expect(limited.result.status).toBe("result_limit");
    }

    for (const usage of [
      {
        status: "reported",
        inputTokens: -1,
        outputTokens: 0,
        durationMs: 0,
        costMinorUnits: 0,
        currency: "USD",
      },
      {
        status: "reported",
        inputTokens: 1.5,
        outputTokens: 0,
        durationMs: 0,
        costMinorUnits: 0,
        currency: "USD",
      },
      {
        status: "reported",
        inputTokens: Number.MAX_SAFE_INTEGER + 1,
        outputTokens: 0,
        durationMs: 0,
        costMinorUnits: 0,
        currency: "USD",
      },
      {
        status: "reported",
        inputTokens: 0,
        outputTokens: 0,
        durationMs: 0,
        costMinorUnits: null,
        currency: "USD",
      },
      {
        status: "reported",
        inputTokens: 0,
        outputTokens: 0,
        durationMs: 0,
        costMinorUnits: 0,
        currency: "EUR",
      },
    ]) {
      const malformed = await runLocal((input) => {
        const value = positiveProviderResult(input);
        if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("fixture malformed");
        return Promise.resolve({ ...value, usage });
      });
      expect(malformed.result.status).toBe("result_invalid");
    }
  });

  it("measures the actual callback envelope and records result_limit without retaining a raw body", async () => {
    const canary = "PRIVATE-OVERSIZE-RAW-RESPONSE-CANARY";
    let returned: unknown;
    const { harness, prepared, result } = await runLocal(
      (input) => {
        const value = positiveProviderResult(input);
        if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("fixture malformed");
        returned = { ...value, padding: `${canary}${"x".repeat(2_000)}` };
        return Promise.resolve(returned);
      },
      { maximumResponseBytes: 1_024 },
    );
    expect(result).toMatchObject({ status: "result_limit", callbackInvoked: true, derivations: [] });
    const exactBytes = canonicalWorkflowBytes(returned);
    expect(exactBytes.byteLength).toBeGreaterThan(1_024);
    const results = await globalRecords(harness, "semantic-workflow-result");
    expect(results).toHaveLength(1);
    expect(results[0]?.value).toMatchObject({
      status: "result_limit",
      response: {
        responseByteLength: exactBytes.byteLength,
        responseKeyedDigest: workflowKeyedDigest(exactBytes),
        requestAttestationDigest: prepared.preview.minimizedBytesDigest,
      },
    });
    expect(JSON.stringify(await harness.store.list({ namespace: "learning", limit: 1_000 }))).not.toContain(canary);
  });

  it("accepts the exact response-byte ceiling and classifies the next canonical byte as result_limit", async () => {
    const maximumBytes = 4_096;
    const baseValue = positiveProviderResult();
    if (typeof baseValue !== "object" || baseValue === null || Array.isArray(baseValue)) {
      throw new Error("provider response ceiling fixture is malformed");
    }
    const baselineBytes = canonicalWorkflowBytes({ ...baseValue, padding: "" }).byteLength;
    const paddingBytes = maximumBytes - baselineBytes;
    expect(paddingBytes).toBeGreaterThan(0);
    const exact = await runLocal(
      (input) => {
        const value = positiveProviderResult(input);
        if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("fixture malformed");
        return Promise.resolve({ ...value, padding: "x".repeat(paddingBytes) });
      },
      { maximumResponseBytes: maximumBytes },
    );
    expect(exact.result.status).toBe("completed");
    const exceeded = await runLocal(
      (input) => {
        const value = positiveProviderResult(input);
        if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("fixture malformed");
        return Promise.resolve({ ...value, padding: "x".repeat(paddingBytes + 1) });
      },
      { maximumResponseBytes: maximumBytes },
    );
    expect(exceeded.result).toMatchObject({ status: "result_limit", callbackInvoked: true, derivations: [] });
  });

  it("hard-bounds a huge string envelope at the absolute 16 MiB response ceiling", async () => {
    const maximumBytes = 16 * 1_048_576;
    const baseValue = positiveProviderResult();
    if (typeof baseValue !== "object" || baseValue === null || Array.isArray(baseValue)) {
      throw new Error("huge provider envelope fixture is malformed");
    }
    const baselineBytes = canonicalWorkflowBytes({ ...baseValue, padding: "" }).byteLength;
    const paddingBytes = maximumBytes - baselineBytes;
    const exact = await runLocal(
      (input) => {
        const value = positiveProviderResult(input);
        if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("fixture malformed");
        return Promise.resolve({ ...value, padding: "x".repeat(paddingBytes) });
      },
      { maximumResponseBytes: maximumBytes },
    );
    expect(exact.result.status).toBe("completed");
    const exceeded = await runLocal(
      (input) => {
        const value = positiveProviderResult(input);
        if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("fixture malformed");
        return Promise.resolve({ ...value, padding: "x".repeat(paddingBytes + 1) });
      },
      { maximumResponseBytes: maximumBytes },
    );
    expect(exceeded.result.status).toBe("result_limit");
  });

  it("counts escaped canonical response bytes exactly and rejects symbol-keyed response data", async () => {
    const maximumBytes = 16 * 1_048_576;
    const baseValue = positiveProviderResult();
    if (typeof baseValue !== "object" || baseValue === null || Array.isArray(baseValue)) {
      throw new Error("escaped provider envelope fixture is malformed");
    }
    const baselineBytes = canonicalWorkflowBytes({ ...baseValue, padding: "" }).byteLength;
    const remaining = maximumBytes - baselineBytes;
    const escaped = "\0".repeat(Math.floor(remaining / 6)) + "x".repeat(remaining % 6);
    expect(canonicalWorkflowBytes({ ...baseValue, padding: escaped }).byteLength).toBe(maximumBytes);

    const exact = await runLocal(
      (input) => {
        const value = positiveProviderResult(input);
        if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("fixture malformed");
        return Promise.resolve({ ...value, padding: escaped });
      },
      { maximumResponseBytes: maximumBytes },
    );
    expect(exact.result.status).toBe("completed");

    const exceeded = await runLocal(
      (input) => {
        const value = positiveProviderResult(input);
        if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("fixture malformed");
        return Promise.resolve({ ...value, padding: `${escaped}x` });
      },
      { maximumResponseBytes: maximumBytes },
    );
    expect(exceeded.result.status).toBe("result_limit");
    const exceededRecords = await globalRecords(exceeded.harness, "semantic-workflow-result");
    expect(exceededRecords[0]?.value).toMatchObject({ status: "result_limit", response: null });

    const symbolCanary = "PRIVATE-SYMBOL-RESPONSE-CANARY";
    const symbolResult = await runLocal((input) => {
      const value = positiveProviderResult(input);
      if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("fixture malformed");
      Object.defineProperty(value, Symbol("private-response"), {
        enumerable: true,
        value: symbolCanary,
      });
      return Promise.resolve(value);
    });
    expect(symbolResult.result.status).toBe("result_invalid");
    expect(JSON.stringify(await globalRecords(symbolResult.harness, "semantic-workflow-result"))).not.toContain(
      symbolCanary,
    );
  }, 120_000);

  it("classifies a scalar or key beyond the 16 MiB hard bound without retaining response metadata", async () => {
    const excessive = "x".repeat(16 * 1_048_576 + 1);
    const scripts: readonly ((input: unknown) => Promise<unknown>)[] = [
      (input) => {
        const value = positiveProviderResult(input);
        if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("fixture malformed");
        return Promise.resolve({ ...value, hardBoundScalar: excessive });
      },
      (input) => {
        const value = positiveProviderResult(input);
        if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("fixture malformed");
        return Promise.resolve({ ...value, [excessive]: null });
      },
    ];
    for (const script of scripts) {
      const outcome = await runLocal(script);
      expect(outcome.result).toMatchObject({
        status: "result_limit",
        callbackInvoked: true,
        turnId: expect.any(String),
      });
      const results = await globalRecords(outcome.harness, "semantic-workflow-result");
      expect(results).toHaveLength(1);
      expect(results[0]?.value).toMatchObject({ status: "result_limit", response: null });
    }
  });

  it("permits a typed negative completed generation with no derivations and explicit no-condition output", async () => {
    const { harness, result } = await runLocal((input) => Promise.resolve(negativeProviderResult(input)));
    expect(result).toMatchObject({ status: "completed", callbackInvoked: true, derivations: [] });
    if (result.turnId === null) throw new Error("negative completed generation omitted turn id");
    await expect(harness.bundle.getTurn({ turnId: result.turnId, scope: harness.scope })).resolves.toMatchObject({
      status: "completed",
      output: { kind: "none", reasonCode: "workflow.condition_not_detected" },
    });
  });

  it("computes response attestations in-kernel and rejects unknown accessors without invoking them", async () => {
    const canary = "PRIVATE-FORGED-ATTESTATION-CANARY";
    let returned: unknown;
    const forged = await runLocal((input) => {
      const value = positiveProviderResult(input);
      if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("fixture malformed");
      returned = {
        ...value,
        responseByteLength: 1,
        responseKeyedDigest: canary,
        requestAttestationDigest: canary,
      };
      return Promise.resolve(returned);
    });
    expect(forged.result.status).toBe("completed");
    const exactBytes = canonicalWorkflowBytes(returned);
    const stored = await globalRecords(forged.harness, "semantic-workflow-result");
    expect(stored[0]?.value).toMatchObject({
      response: {
        responseByteLength: exactBytes.byteLength,
        responseKeyedDigest: workflowKeyedDigest(exactBytes),
        requestAttestationDigest: forged.prepared.preview.minimizedBytesDigest,
      },
    });
    expect(JSON.stringify(await forged.harness.store.list({ namespace: "learning", limit: 1_000 }))).not.toContain(
      canary,
    );

    let reads = 0;
    const accessor = await runLocal((input) => {
      const value = positiveProviderResult(input);
      if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("fixture malformed");
      for (const key of ["responseByteLength", "responseKeyedDigest", "requestAttestationDigest"]) {
        Object.defineProperty(value, key, {
          enumerable: true,
          get: () => {
            reads += 1;
            return canary;
          },
        });
      }
      return Promise.resolve(value);
    });
    expect(accessor.result.status).toBe("result_invalid");
    expect(reads).toBe(0);
    expect(JSON.stringify(await globalRecords(accessor.harness, "semantic-workflow-result"))).not.toContain(canary);
  });

  it("takes one provider descriptor snapshot so a changing Proxy cannot swap attested bytes and parsed meaning", async () => {
    let ownKeyPasses = 0;
    const directReads: string[] = [];
    const initial = positiveProviderResult();
    if (typeof initial !== "object" || initial === null || Array.isArray(initial)) {
      throw new Error("changing provider proxy fixture is malformed");
    }
    const changed = { ...initial, status: "provider_refused", usage: null, result: null };
    const proxy = new Proxy(initial, {
      ownKeys: (target) => {
        ownKeyPasses += 1;
        return Reflect.ownKeys(target);
      },
      getOwnPropertyDescriptor: (target, property) =>
        Reflect.getOwnPropertyDescriptor(ownKeyPasses > 1 ? changed : target, property),
      get: (target, property, receiver) => {
        directReads.push(String(property));
        return Reflect.get(target, property, receiver);
      },
    });
    const outcome = await runLocal(() => Promise.resolve(proxy));
    expect(outcome.result.status).toBe("completed");
    expect(ownKeyPasses).toBe(1);
    expect(directReads.length).toBeGreaterThan(0);
    expect(new Set(directReads)).toEqual(new Set(["then"]));
  });

  it("accepts provider structures at depth 100 and 100,000 nodes and statically rejects each next unit", async () => {
    const exactDepth = await runLocal((input) => {
      const value = positiveProviderResult(input);
      if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("fixture malformed");
      return Promise.resolve({ ...value, structural: nestedValue(99) });
    });
    expect(exactDepth.result.status).toBe("completed");
    const excessiveDepth = await runLocal((input) => {
      const value = positiveProviderResult(input);
      if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("fixture malformed");
      return Promise.resolve({ ...value, structural: nestedValue(100) });
    });
    expect(excessiveDepth.result.status).toBe("result_invalid");

    const baseValue = positiveProviderResult();
    const remainingNodes = 100_000 - structureNodes(baseValue) - 1;
    expect(remainingNodes).toBeGreaterThan(0);
    const exactNodes = await runLocal((input) => {
      const value = positiveProviderResult(input);
      if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("fixture malformed");
      return Promise.resolve({ ...value, structural: Array.from({ length: remainingNodes }, () => null) });
    });
    expect(exactNodes.result.status).toBe("completed");
    const excessiveNodes = await runLocal((input) => {
      const value = positiveProviderResult(input);
      if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("fixture malformed");
      return Promise.resolve({ ...value, structural: Array.from({ length: remainingNodes + 1 }, () => null) });
    });
    expect(excessiveNodes.result.status).toBe("result_invalid");
  });
});
