// #30c2b1 C1 runner recurrence projection: closed statuses, zero-write dry
// previews, exact committed counts, historical compatibility, and isolation.
import { describe, expect, it } from "vitest";
import {
  PRIVATE_LOCATOR,
  createRecurrenceRunnerHarness,
  detectedInsightDraft,
  recurrenceRunInput,
} from "./detector-recurrence-harness.js";

async function countKind(
  store: Awaited<ReturnType<typeof createRecurrenceRunnerHarness>>["store"],
  kind: string,
): Promise<number> {
  return (await store.list({ namespace: "learning", kind, limit: 100 })).records.length;
}

describe("detector recurrence runner statuses", () => {
  it("distinguishes unmaterialized, nonapplied, negative, and locator-unavailable executions", async () => {
    const empty = await createRecurrenceRunnerHarness({ label: "status-empty" });
    const emptyResult = await empty.learning.runDetector(recurrenceRunInput(empty, "dry_run", []));
    expect(emptyResult).toMatchObject({
      status: "not_applicable",
      callbackInvoked: false,
      recurrence: { status: "execution_not_applied", executionStatus: "not_applicable" },
    });
    const missingResult = await empty.learning.runDetector(
      recurrenceRunInput(empty, "dry_run", ["missing-source/missing-episode"]),
    );
    expect(missingResult).toMatchObject({
      status: "not_applicable",
      callbackInvoked: false,
      recurrence: { status: "execution_not_materialized" },
    });

    const incomplete = await createRecurrenceRunnerHarness({ label: "status-incomplete", implementation: false });
    const incompleteResult = await incomplete.learning.runDetector(recurrenceRunInput(incomplete, "dry_run"));
    expect(incompleteResult).toMatchObject({
      status: "incomplete",
      callbackInvoked: false,
      recurrence: { status: "execution_not_applied", executionStatus: "incomplete" },
    });

    const notApplicable = await createRecurrenceRunnerHarness({
      label: "status-not-applicable",
      detectorRequiredCapabilities: ["missing.capability"],
    });
    const notApplicableResult = await notApplicable.learning.runDetector(recurrenceRunInput(notApplicable, "dry_run"));
    expect(notApplicableResult).toMatchObject({
      status: "not_applicable",
      callbackInvoked: false,
      recurrence: { status: "execution_not_applied", executionStatus: "not_applicable" },
    });

    const negative = await createRecurrenceRunnerHarness({ label: "status-negative" });
    const negativeResult = await negative.learning.runDetector(recurrenceRunInput(negative, "dry_run"));
    expect(negativeResult).toMatchObject({
      status: "applied",
      callbackInvoked: true,
      recurrence: { status: "condition_not_detected" },
    });

    const unlocated = await createRecurrenceRunnerHarness({
      label: "status-unlocated",
      evaluate: detectedInsightDraft,
    });
    const unlocatedResult = await unlocated.learning.runDetector(recurrenceRunInput(unlocated, "dry_run"));
    expect(unlocatedResult).toMatchObject({
      status: "applied",
      callbackInvoked: true,
      recurrence: { status: "locator_unavailable" },
    });
  });

  it("previews a valid dry group without writes, commits exact counts, and skips the existing callback", async () => {
    const harness = await createRecurrenceRunnerHarness({
      label: "dry-commit-existing",
      evaluate: (window) => detectedInsightDraft(window, PRIVATE_LOCATOR),
    });
    const dry = await harness.learning.runDetector(recurrenceRunInput(harness, "dry_run"));
    expect(dry).toMatchObject({
      mode: "dry_run",
      persistence: "none",
      callbackInvoked: true,
      recurrence: { status: "grouped", locator: PRIVATE_LOCATOR, executionCount: 1, distinctEpisodeCount: 1 },
    });
    expect(await countKind(harness.store, "detector-recurrence-binding")).toBe(0);
    expect(await countKind(harness.store, "detector-recurrence-group")).toBe(0);
    expect(await countKind(harness.store, "detector-execution")).toBe(0);

    const committed = await harness.learning.runDetector(recurrenceRunInput(harness, "commit"));
    expect(committed).toMatchObject({
      mode: "commit",
      persistence: "committed",
      callbackInvoked: true,
      recurrence: { status: "grouped", locator: PRIVATE_LOCATOR, executionCount: 1, distinctEpisodeCount: 1 },
    });
    expect(await countKind(harness.store, "detector-recurrence-binding")).toBe(1);
    expect(await countKind(harness.store, "detector-recurrence-group")).toBe(1);
    expect(await countKind(harness.store, "detector-execution")).toBe(1);

    const existing = await harness.learning.runDetector(recurrenceRunInput(harness, "commit"));
    expect(existing).toMatchObject({
      persistence: "existing",
      callbackInvoked: false,
      recurrence: { status: "grouped", locator: PRIVATE_LOCATOR, executionCount: 1, distinctEpisodeCount: 1 },
    });
    expect(harness.callbacks()).toBe(2);
  });

  it("adds a would-be dry execution once to current committed counts and converges after commit", async () => {
    const harness = await createRecurrenceRunnerHarness({
      label: "preview-counts",
      episodeCount: 2,
      evaluate: (window) => detectedInsightDraft(window, PRIVATE_LOCATOR),
    });
    const first = await harness.learning.runDetector(
      recurrenceRunInput(harness, "commit", [harness.episodeRecordIds[0] ?? "missing"]),
    );
    expect(first.recurrence).toMatchObject({ status: "grouped", executionCount: 1, distinctEpisodeCount: 1 });

    const preview = await harness.learning.runDetector(
      recurrenceRunInput(harness, "dry_run", [harness.episodeRecordIds[1] ?? "missing"]),
    );
    expect(preview.recurrence).toMatchObject({ status: "grouped", executionCount: 2, distinctEpisodeCount: 2 });
    expect(await countKind(harness.store, "detector-recurrence-binding")).toBe(1);

    const second = await harness.learning.runDetector(
      recurrenceRunInput(harness, "commit", [harness.episodeRecordIds[1] ?? "missing"]),
    );
    expect(second.recurrence).toMatchObject({ status: "grouped", executionCount: 2, distinctEpisodeCount: 2 });
    const repeated = await harness.learning.runDetector(
      recurrenceRunInput(harness, "dry_run", [harness.episodeRecordIds[1] ?? "missing"]),
    );
    expect(repeated.recurrence).toMatchObject({ status: "grouped", executionCount: 2, distinctEpisodeCount: 2 });
  });

  it("concurrently retains different exact execution members without losing group counts", async () => {
    const harness = await createRecurrenceRunnerHarness({
      label: "concurrent-members",
      episodeCount: 2,
      evaluate: (window) => detectedInsightDraft(window, PRIVATE_LOCATOR),
    });
    await Promise.all(
      harness.episodeRecordIds.map((episodeRecordId) =>
        harness.learning.runDetector(recurrenceRunInput(harness, "commit", [episodeRecordId])),
      ),
    );
    const stable = await harness.learning.runDetector(
      recurrenceRunInput(harness, "commit", [harness.episodeRecordIds[0] ?? "missing"]),
    );
    expect(stable).toMatchObject({
      persistence: "existing",
      callbackInvoked: false,
      recurrence: { status: "grouped", executionCount: 2, distinctEpisodeCount: 2 },
    });
    expect(await countKind(harness.store, "detector-recurrence-binding")).toBe(2);
    const group = await harness.store.list({ namespace: "learning", kind: "detector-recurrence-group", limit: 10 });
    expect(group.records).toHaveLength(1);
    expect(group.records[0]?.value).toHaveLength(2);
  });

  it("persists an unavailable decision and never backfills it from a later callback", async () => {
    let locatorAvailable = false;
    const harness = await createRecurrenceRunnerHarness({
      label: "historical-unbound",
      evaluate: (window) =>
        locatorAvailable ? detectedInsightDraft(window, PRIVATE_LOCATOR) : detectedInsightDraft(window),
    });
    const committed = await harness.learning.runDetector(recurrenceRunInput(harness, "commit"));
    expect(committed.recurrence).toEqual({ status: "locator_unavailable" });
    locatorAvailable = true;
    const existing = await harness.learning.runDetector(recurrenceRunInput(harness, "commit"));
    expect(existing).toMatchObject({
      persistence: "existing",
      callbackInvoked: false,
      recurrence: { status: "locator_unavailable" },
    });
    expect(harness.callbacks()).toBe(1);
    expect(await countKind(harness.store, "detector-recurrence-binding")).toBe(1);
    expect(await countKind(harness.store, "detector-recurrence-group")).toBe(0);
  });

  it("reports recurrence as descriptive lineage and creates no authority or utility fact", async () => {
    const harness = await createRecurrenceRunnerHarness({
      label: "no-utility",
      evaluate: (window) => detectedInsightDraft(window, PRIVATE_LOCATOR),
    });
    const result = await harness.learning.runDetector(recurrenceRunInput(harness, "commit"));
    const serialized = JSON.stringify(result);
    for (const forbidden of [
      "actionable",
      "authorized",
      "candidate",
      "efficacy",
      "improved",
      "preference",
      "provider",
      "suppressed",
      "utility",
    ]) {
      expect(serialized).not.toContain(`"${forbidden}"`);
    }
    expect(await countKind(harness.store, "candidate")).toBe(0);
    expect(await countKind(harness.store, "review")).toBe(0);
  });
});
