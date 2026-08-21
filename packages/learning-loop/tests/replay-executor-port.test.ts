// defineReplayExecutor (decision 0028): the identity/authority-port discipline
// applied to replay. The kernel mints a frozen, branded executor whose
// registration digest binds exact host metadata, captures the attempt
// callback at definition time, refuses structural lookalikes at loop
// construction, and binds configured executors into the registry revision.
import { describe, expect, it } from "vitest";
import type { ReplayAttemptRequest, ReplayExecutor } from "../src/index.js";
import { defineReplayExecutor, sha256HexOfCanonicalJson } from "../src/index.js";
import { replayExecutorRegistryProjection } from "../src/engine/replay-executor.js";
import { createInMemoryReplayExecutor } from "../src/testing/index.js";
import { journeyEvidence } from "./engine-harness.js";
import { createPublicationHarness } from "./publication-harness.js";

const CONFIGURATION_DIGEST = "3".repeat(64);

function executorFor(
  overrides: Partial<{ id: string; version: string; configurationDigest: string; attempt: unknown }> = {},
): ReplayExecutor {
  const input: unknown = {
    id: "replay.harness",
    version: "1.0.0",
    configurationDigest: CONFIGURATION_DIGEST,
    attempt: (request: ReplayAttemptRequest) => Promise.resolve({ echoed: request.arm }),
    ...overrides,
  };
  return defineReplayExecutor(input as Parameters<typeof defineReplayExecutor>[0]);
}

async function registryRevisionWith(replayExecutors: readonly ReplayExecutor[] | undefined): Promise<string> {
  const harness = await createPublicationHarness(replayExecutors === undefined ? {} : { replayExecutors });
  return (await harness.learning.ingest(harness.manual, journeyEvidence())).registryRevision;
}

function expectInvalid(run: () => unknown, code = "schema.invalid"): void {
  expect(run).toThrow(expect.objectContaining({ name: "LearningLoopError", code }));
}

describe("defineReplayExecutor", () => {
  it("mints a frozen executor whose registration digest binds id, version, and configuration", () => {
    const executor = executorFor();
    expect(Object.isFrozen(executor)).toBe(true);
    expect(executor.id).toBe("replay.harness");
    expect(executor.version).toBe("1.0.0");
    expect(executor.registrationDigest).toBe(
      sha256HexOfCanonicalJson({ id: "replay.harness", version: "1.0.0", configurationDigest: CONFIGURATION_DIGEST }),
    );
    expect(replayExecutorRegistryProjection(executor)).toEqual({
      id: "replay.harness",
      version: "1.0.0",
      configurationDigest: CONFIGURATION_DIGEST,
      registrationDigest: executor.registrationDigest,
    });
    expect(executorFor({ version: "1.0.1" }).registrationDigest).not.toBe(executor.registrationDigest);
  });

  it("captures the attempt callback at definition time so later mutation cannot change what runs", async () => {
    const input = {
      id: "replay.harness",
      version: "1.0.0",
      configurationDigest: CONFIGURATION_DIGEST,
      attempt: () => Promise.resolve({ version: "original" }),
    };
    const executor = defineReplayExecutor(input);
    input.attempt = () => Promise.resolve({ version: "swapped" });
    const request: unknown = { arm: "control" };
    expect(await executor.attempt(request as ReplayAttemptRequest)).toEqual({ version: "original" });
  });

  it("refuses malformed registration metadata and a non-function attempt", () => {
    expectInvalid(() => executorFor({ id: "" }));
    expectInvalid(() => executorFor({ id: "x".repeat(201) }));
    expectInvalid(() => executorFor({ id: "tab\there" }));
    expectInvalid(() => executorFor({ version: "" }));
    expectInvalid(() => executorFor({ configurationDigest: "sha256:nope" }));
    expectInvalid(() => executorFor({ attempt: "run" }));
  });

  it("refuses structural lookalikes and copies: only the minted instance is registered", () => {
    const executor = executorFor();
    const lookalike: unknown = {
      id: executor.id,
      version: executor.version,
      registrationDigest: executor.registrationDigest,
      attempt: () => Promise.resolve({}),
    };
    expectInvalid(() => replayExecutorRegistryProjection(lookalike as ReplayExecutor), "config.invalid");
    const copy: unknown = { ...executor };
    expectInvalid(() => replayExecutorRegistryProjection(copy as ReplayExecutor), "config.invalid");
    expectInvalid(() => replayExecutorRegistryProjection(null as unknown as ReplayExecutor), "config.invalid");
  });
});

describe("createLearningLoop with replay executors", () => {
  it("refuses lookalikes, duplicates, and a non-array at construction", async () => {
    const executor = executorFor();
    const lookalike: unknown = { ...executor };
    await expect(createPublicationHarness({ replayExecutors: [lookalike as ReplayExecutor] })).rejects.toMatchObject({
      code: "config.invalid",
    });
    await expect(createPublicationHarness({ replayExecutors: [executor, executor] })).rejects.toMatchObject({
      code: "config.invalid",
    });
    await expect(
      createPublicationHarness({ replayExecutors: [executor, executorFor({ configurationDigest: "4".repeat(64) })] }),
    ).rejects.toMatchObject({ code: "config.invalid" });
    const notArray: unknown = executor;
    await expect(
      createPublicationHarness({ replayExecutors: notArray as readonly ReplayExecutor[] }),
    ).rejects.toMatchObject({ code: "config.invalid" });
  });

  it("binds the sorted exact executor registrations into the registry revision; omission preserves prior bytes", async () => {
    const first = executorFor();
    const second = executorFor({ id: "replay.other" });
    const memory = createInMemoryReplayExecutor();
    const without = await registryRevisionWith(undefined);
    const empty = await registryRevisionWith([]);
    const withFirst = await registryRevisionWith([first]);
    const withBoth = await registryRevisionWith([first, second]);
    const withBothReversed = await registryRevisionWith([second, first]);
    const withMemory = await registryRevisionWith([memory.executor]);
    expect(without).not.toBe(empty);
    expect(withFirst).not.toBe(without);
    expect(withFirst).not.toBe(withBoth);
    expect(withBoth).toBe(withBothReversed);
    expect(withMemory).not.toBe(withFirst);
    // A fresh instance with the same exact metadata is the same registry bytes.
    expect(await registryRevisionWith([executorFor()])).toBe(withFirst);
    expect(await registryRevisionWith([executorFor({ version: "2.0.0" })])).not.toBe(withFirst);
  });
});
