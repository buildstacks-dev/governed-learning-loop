// #30c2b1 public recurrence locator boundary: exact privacy treatment,
// canonical structural labels, keyed private locators, and C1 compatibility.
import { describe, expect, it } from "vitest";
import type { DetectorRecurrenceLocator } from "../src/index.js";
import {
  PRIVATE_KEY_POLICY_DIGEST,
  PRIVATE_LOCATOR,
  PUBLIC_LOCATOR,
  createRecurrenceRunnerHarness,
  detectedInsightDraft,
  recurrenceRunInput,
} from "./detector-recurrence-harness.js";

async function recurrenceRecordCount(
  store: Awaited<ReturnType<typeof createRecurrenceRunnerHarness>>["store"],
): Promise<number> {
  const binding = await store.list({ namespace: "learning", kind: "detector-recurrence-binding", limit: 10 });
  const groups = await store.list({ namespace: "learning", kind: "detector-recurrence-group", limit: 10 });
  return binding.records.length + groups.records.length;
}

describe("DetectorRecurrenceLocator public boundary", () => {
  it("constructs both public root branches without exporting raw private locator content", () => {
    const structural: DetectorRecurrenceLocator = PUBLIC_LOCATOR;
    const keyed: DetectorRecurrenceLocator = PRIVATE_LOCATOR;
    expect([structural.treatment, keyed.treatment]).toEqual(["public_structural", "tenant_keyed_private"]);
    expect(JSON.stringify(keyed)).not.toContain("status_poll");
  });

  it("accepts only already-canonical public structural labels and never rewrites them", async () => {
    let locator: unknown = PUBLIC_LOCATOR;
    const harness = await createRecurrenceRunnerHarness({
      treatment: "public_structural",
      label: "structural-labels",
      evaluate: (window) => detectedInsightDraft(window, locator),
    });
    for (const structuralLabel of ["wait", "status_poll", "tool.wait:v1", `a${"b".repeat(198)}z`]) {
      locator = { treatment: "public_structural", structuralLabel };
      const result = await harness.learning.runDetector(recurrenceRunInput(harness, "dry_run"));
      expect(result.recurrence).toMatchObject({
        status: "grouped",
        locator: { treatment: "public_structural", structuralLabel },
      });
    }
    for (const structuralLabel of [
      "",
      "Status_Poll",
      " status_poll",
      "status_poll ",
      "-status",
      "status-",
      "private/path",
      "human correction text",
      "é",
      "e\u0301",
      "ｓｔａｔｕｓ",
      `a${"b".repeat(200)}`,
      "status\u0000poll",
    ]) {
      locator = { treatment: "public_structural", structuralLabel };
      await expect(harness.learning.runDetector(recurrenceRunInput(harness, "dry_run"))).rejects.toMatchObject({
        code: "detector.result_invalid",
      });
    }
    expect(await recurrenceRecordCount(harness.store)).toBe(0);
  });

  it("matches locator treatment to immutable detector privacy registration", async () => {
    const cases: readonly {
      readonly treatment: "none" | "public_structural" | "tenant_keyed_private" | "mixed";
      readonly locator: DetectorRecurrenceLocator;
      readonly accepted: boolean;
    }[] = [
      { treatment: "none", locator: PUBLIC_LOCATOR, accepted: false },
      { treatment: "public_structural", locator: PUBLIC_LOCATOR, accepted: true },
      { treatment: "public_structural", locator: PRIVATE_LOCATOR, accepted: false },
      { treatment: "tenant_keyed_private", locator: PRIVATE_LOCATOR, accepted: true },
      { treatment: "tenant_keyed_private", locator: PUBLIC_LOCATOR, accepted: false },
      { treatment: "mixed", locator: PUBLIC_LOCATOR, accepted: true },
      { treatment: "mixed", locator: PRIVATE_LOCATOR, accepted: true },
    ];
    for (const fixtureCase of cases) {
      const harness = await createRecurrenceRunnerHarness({
        treatment: fixtureCase.treatment,
        label: `treatment-${fixtureCase.treatment}-${fixtureCase.locator.treatment}`,
        evaluate: (window) => detectedInsightDraft(window, fixtureCase.locator),
      });
      const run = harness.learning.runDetector(recurrenceRunInput(harness, "dry_run"));
      if (fixtureCase.accepted) {
        await expect(run).resolves.toMatchObject({ recurrence: { status: "grouped", locator: fixtureCase.locator } });
      } else {
        await expect(run).rejects.toMatchObject({ code: "detector.result_invalid" });
      }
      expect(await recurrenceRecordCount(harness.store)).toBe(0);
    }
  });

  it("requires the exact keyed policy digest and drops private canaries before any durable boundary", async () => {
    let locator: unknown = PRIVATE_LOCATOR;
    const harness = await createRecurrenceRunnerHarness({
      treatment: "tenant_keyed_private",
      label: "keyed-policy",
      evaluate: (window) => detectedInsightDraft(window, locator),
    });
    locator = {
      ...PRIVATE_LOCATOR,
      rawLocator: "PRIVATE-LOW-ENTROPY-CANARY",
      nativePath: "/Users/private/project",
    };
    const accepted = await harness.learning.runDetector(recurrenceRunInput(harness, "dry_run"));
    expect(accepted.recurrence).toMatchObject({ status: "grouped", locator: PRIVATE_LOCATOR });
    expect(JSON.stringify(accepted)).not.toContain("PRIVATE-LOW-ENTROPY-CANARY");
    expect(JSON.stringify(accepted)).not.toContain("/Users/private/project");

    for (const invalidLocator of [
      { ...PRIVATE_LOCATOR, keyedDigest: "D".repeat(64) },
      { ...PRIVATE_LOCATOR, keyedDigest: "d".repeat(63) },
      { ...PRIVATE_LOCATOR, keyPolicyDigest: "b".repeat(64) },
    ]) {
      locator = invalidLocator;
      await expect(harness.learning.runDetector(recurrenceRunInput(harness, "dry_run"))).rejects.toMatchObject({
        code: "detector.result_invalid",
      });
    }
    expect(PRIVATE_LOCATOR.keyPolicyDigest).toBe(PRIVATE_KEY_POLICY_DIGEST);
    expect(await recurrenceRecordCount(harness.store)).toBe(0);
  });

  it("refuses a locator on a negative callback result", async () => {
    const harness = await createRecurrenceRunnerHarness({
      treatment: "public_structural",
      label: "negative-locator",
      evaluate: () => ({
        conditionDetected: false,
        insights: [],
        findings: [],
        recurrenceLocator: PUBLIC_LOCATOR,
      }),
    });
    await expect(harness.learning.runDetector(recurrenceRunInput(harness, "commit"))).rejects.toMatchObject({
      code: "detector.result_invalid",
    });
    expect(await recurrenceRecordCount(harness.store)).toBe(0);
  });

  it("preserves old callback omission and explicit null as byte-identical locator-unavailable executions", async () => {
    let explicitNull = false;
    const harness = await createRecurrenceRunnerHarness({
      treatment: "tenant_keyed_private",
      label: "locator-compatibility",
      evaluate: (window) => (explicitNull ? detectedInsightDraft(window, null) : detectedInsightDraft(window)),
    });
    const omitted = await harness.learning.runDetector(recurrenceRunInput(harness, "dry_run"));
    explicitNull = true;
    const nullable = await harness.learning.runDetector(recurrenceRunInput(harness, "dry_run"));
    expect(omitted.recurrence).toEqual({ status: "locator_unavailable" });
    expect(nullable.recurrence).toEqual({ status: "locator_unavailable" });
    expect(nullable.execution?.executionKeyDigest).toBe(omitted.execution?.executionKeyDigest);
    expect(nullable.execution?.executionDigest).toBe(omitted.execution?.executionDigest);
    expect(nullable.derivations.map((value) => value.derivationDigest)).toEqual(
      omitted.derivations.map((value) => value.derivationDigest),
    );
  });
});
