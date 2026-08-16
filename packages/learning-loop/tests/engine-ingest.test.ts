// Ingest conformance: idempotent re-ingest, registered-source gating, the
// host-granted trust ceiling, and create-only conflict surfacing.
import { describe, expect, it } from "vitest";
import { defineSourceRegistration, parseObservation } from "../src/index.js";
import { createManualEvidenceSource } from "../src/testing/index.js";
import { CONTENT_POLICY_ID, createHarness, journeyEvidence, scriptedSource } from "./engine-harness.js";

describe("learning.ingest", () => {
  it("re-ingesting identical input is idempotent: zero net-new ids, no conflicts", async () => {
    const { learning, manual } = await createHarness();
    const first = await learning.ingest(manual, journeyEvidence());
    expect(first.observationIds).toEqual(["manual-evidence/obs-42-typecheck"]);
    expect(first.measurementIds).toEqual(["manual-evidence/measure-42-typecheck"]);
    expect(first.episodeIds).toEqual(["manual-evidence/change-42"]);

    const second = await learning.ingest(manual, journeyEvidence());
    expect(second.observationIds).toEqual([]);
    expect(second.measurementIds).toEqual([]);
    expect(second.episodeIds).toEqual([]);
    expect(second.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
    expect(second.diagnostics.some((diagnostic) => diagnostic.code === "ingest.duplicate")).toBe(true);
    expect(second.sourceRevision).toBe(first.sourceRevision);
    expect(second.registryRevision).toBe(first.registryRevision);
  });

  it("a source that is not part of the loop's registry is refused with a typed error", async () => {
    const { learning } = await createHarness();
    const rogue = defineSourceRegistration({
      source: createManualEvidenceSource(),
      trustCeiling: "observed",
      contentPolicyId: CONTENT_POLICY_ID,
    });
    await expect(learning.ingest(rogue, journeyEvidence())).rejects.toMatchObject({
      name: "LearningLoopError",
      code: "source.not_registered",
    });
  });

  it("an adapter cannot exceed its registered trust ceiling, whatever it projects", async () => {
    const junkObservation = {
      sourceRecordId: "obs-claimed-verified",
      episodeId: "ep-1",
      kind: "tool.process.completed",
      data: { ok: true },
      completeness: "complete",
      // Adversarial junk: the adapter claims trust it was never granted.
      trust: "verified",
      provenance: { trust: "verified" },
    };
    const page = {
      sourceRevision: "rev-1",
      observations: [junkObservation],
      measurements: [],
      episodes: [],
      diagnostics: [],
    };
    const adversarial = defineSourceRegistration({
      source: scriptedSource("adversarial", () => [page]),
      trustCeiling: "advisory",
      contentPolicyId: CONTENT_POLICY_ID,
    });
    const { learning, store } = await createHarness([adversarial]);
    const receipt = await learning.ingest(adversarial, null);
    expect(receipt.observationIds).toEqual(["adversarial/obs-claimed-verified"]);

    const stored = await store.get({
      namespace: "learning",
      kind: "observation",
      id: "adversarial/obs-claimed-verified",
    });
    expect(stored).toBeDefined();
    const observation = parseObservation(stored?.value);
    expect(observation.provenance.trust).toBe("advisory");
    expect(observation.provenance.sourceId).toBe("adversarial");
    // The junk fields never reach the durable record.
    expect(observation.data).toEqual({ ok: true });
  });

  it("a same-id record with different content is a conflict diagnostic, never an overwrite", async () => {
    const { learning, manual, store } = await createHarness();
    await learning.ingest(manual, journeyEvidence());

    const mutated = {
      observations: [
        {
          id: "obs-42-typecheck",
          episodeId: "change-42",
          kind: "tool.process.completed",
          data: { commandClass: "typecheck", exitCode: 0 },
        },
      ],
    };
    const receipt = await learning.ingest(manual, mutated);
    expect(receipt.observationIds).toEqual([]);
    expect(
      receipt.diagnostics.some((diagnostic) => diagnostic.code === "store.conflict" && diagnostic.severity === "error"),
    ).toBe(true);

    const stored = await store.get({
      namespace: "learning",
      kind: "observation",
      id: "manual-evidence/obs-42-typecheck",
    });
    const observation = parseObservation(stored?.value);
    expect(observation.data).toEqual({ commandClass: "typecheck", exitCode: 1 });
  });

  it("a malformed projection becomes a diagnostic without discarding its siblings", async () => {
    const goodObservation = {
      sourceRecordId: "obs-good",
      episodeId: "ep-1",
      kind: "tool.process.completed",
      data: { ok: true },
      completeness: "complete",
    };
    const brokenPage = {
      sourceRevision: "rev-1",
      observations: [{ episodeId: "ep-1" }, goodObservation],
      measurements: [],
      episodes: [],
      diagnostics: [],
    };
    const source = defineSourceRegistration({
      source: scriptedSource("mixed", () => [brokenPage]),
      trustCeiling: "observed",
      contentPolicyId: CONTENT_POLICY_ID,
    });
    const { learning } = await createHarness([source]);
    const receipt = await learning.ingest(source, null);
    expect(receipt.observationIds).toEqual(["mixed/obs-good"]);
    expect(receipt.diagnostics.some((diagnostic) => diagnostic.code === "schema.invalid")).toBe(true);
  });
});
