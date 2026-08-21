// learning.acknowledgeExposure (contract §Intervention, exposure, and
// efficacy; decision 0027): one resolution yields one exposure set with
// exactly one entry per applied intervention, bound to the exact frozen
// content digest; host-observed (observed or verified, same-episode)
// evidence is required; a retry is idempotent and a different second
// acknowledgement is refused; a crash before or after either write
// converges on retry; and acknowledged sets fold into the episode view.
import { describe, expect, it } from "vitest";
import type { Candidate, EpisodeView, ExposureSetRecord, LearningStore, ResolvedContext } from "../src/index.js";
import { defineSourceRegistration, parseExposureSetRecord, parseEpisodeRecord } from "../src/index.js";
import { createInMemoryStore, createManualEvidenceSource } from "../src/testing/index.js";
import { CONTENT_POLICY_ID, SCOPE, type candidateInput } from "./engine-harness.js";
import {
  DESTINATION_ID,
  completed,
  createPublicationHarness,
  faultStore,
  type PublicationHarness,
  type PublicationHarnessOptions,
  type StoreFault,
} from "./publication-harness.js";

const BASE = "instructions-v7";
/** The journey episode: its observation is `observed` evidence of this episode. */
const EPISODE_ID = "change-42";
const EVIDENCE_ID = "manual-evidence/obs-42-typecheck";
const QUERY = { taskClass: "typescript-code-change" };
const BUDGET = { maximumEntries: 8, maximumCharacters: 4_000 };

type CandidateOverrides = Parameters<typeof candidateInput>[1];

async function publish(harness: PublicationHarness, candidate: Candidate): Promise<string> {
  const prepared = await harness.learning.preparePublication({
    candidateId: candidate.id,
    destinationId: DESTINATION_ID,
    expectedBase: BASE,
  });
  return completed(
    await harness.learning.publish({ planId: prepared.plan.id, authorizationEvidence: { decision: "authorized" } }),
  ).intervention.id;
}

function secondCandidate(): CandidateOverrides {
  return {
    id: "cand-2",
    intervention: {
      destinationId: DESTINATION_ID,
      kind: "procedure",
      content: { text: "Prefer small, reviewable commits." },
      rollbackIntent: "Disable this instruction version.",
    },
  };
}

interface Resolved {
  readonly harness: PublicationHarness;
  readonly candidates: readonly Candidate[];
  readonly interventionIds: readonly string[];
  readonly resolved: ResolvedContext;
}

async function resolvedHarness(options: PublicationHarnessOptions = {}, episodeId = EPISODE_ID): Promise<Resolved> {
  const harness = await createPublicationHarness(options);
  const first = await harness.acceptedCandidate();
  const firstId = await publish(harness, first);
  harness.clock.tick();
  const second = await harness.acceptedCandidate(secondCandidate());
  const secondId = await publish(harness, second);
  const resolved = await harness.learning.resolveContext({ episodeId, scope: SCOPE, query: QUERY, budget: BUDGET });
  expect(resolved.entries.map((entry) => entry.interventionId)).toEqual([firstId, secondId]);
  return { harness, candidates: [first, second], interventionIds: [firstId, secondId], resolved };
}

function exposureInput(resolved: ResolvedContext, overrides: Record<string, unknown> = {}) {
  return {
    resolutionReceiptId: resolved.id,
    appliedEntryIds: resolved.entries.map((entry) => entry.id),
    assignmentId: "ordinary-resolution-v1",
    fingerprintId: "fp-agent-run-v9",
    evidenceIds: [EVIDENCE_ID],
    ...overrides,
  };
}

function addedKinds(before: string, after: string): readonly string[] {
  const previous = new Set(JSON.parse(before).map((entry: unknown) => JSON.stringify(entry)));
  return JSON.parse(after)
    .filter((entry: unknown) => !previous.has(JSON.stringify(entry)))
    .map((entry: readonly [string, string, string]) => entry[0])
    .sort();
}

async function expectRefusal(run: () => Promise<unknown>, code: string): Promise<void> {
  await expect(run()).rejects.toMatchObject({ name: "LearningLoopError", code });
}

async function episodeView(harness: PublicationHarness, episodeId: string): Promise<EpisodeView | undefined> {
  for await (const page of harness.learning.queryEpisodes({ episodeIds: [episodeId], limit: 10 })) {
    const item = page.items[0];
    if (item !== undefined) return item;
  }
  return undefined;
}

describe("learning.acknowledgeExposure: one resolution, one exposure set", () => {
  it("records one entry per applied intervention bound to the frozen content digest, and folds into the episode view", async () => {
    const { harness, interventionIds, resolved } = await resolvedHarness();
    const before = await harness.storeSnapshot();
    const exposure = await harness.learning.acknowledgeExposure(exposureInput(resolved));
    expect(exposure).toEqual({
      schemaVersion: 1,
      id: `exposure-${resolved.receiptDigest}`,
      episodeId: EPISODE_ID,
      resolutionReceiptId: resolved.id,
      entries: interventionIds.map((interventionId, index) => ({
        interventionId,
        resolvedContentDigest: resolved.entries[index]?.contentDigest,
      })),
      assignmentId: "ordinary-resolution-v1",
      fingerprintId: "fp-agent-run-v9",
      evidenceIds: [EVIDENCE_ID],
      exposedAt: harness.clock.now(),
      exposureDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(parseExposureSetRecord(exposure)).toEqual(exposure);
    expect(Object.isFrozen(exposure)).toBe(true);
    expect(Object.isFrozen(exposure.entries)).toBe(true);
    expect(addedKinds(before, await harness.storeSnapshot())).toEqual(["episode-exposure", "exposure-set"]);

    const view = await episodeView(harness, EPISODE_ID);
    expect(view?.identity.status).toBe("resolved");
    expect(view?.episode.exposureIds).toEqual([exposure.id]);
    // The ingested EpisodeRecord bytes are untouched; the view is a fold.
    const storedEpisode = await harness.store.get({
      namespace: "learning",
      kind: "episode",
      id: `manual-evidence/${EPISODE_ID}`,
    });
    expect(parseEpisodeRecord(storedEpisode?.value).exposureIds).toEqual([]);
  });

  it("a retry is idempotent, including under a ticking clock, and writes nothing", async () => {
    const { harness, resolved } = await resolvedHarness();
    const exposure = await harness.learning.acknowledgeExposure(exposureInput(resolved));
    const after = await harness.storeSnapshot();
    expect(await harness.learning.acknowledgeExposure(exposureInput(resolved))).toEqual(exposure);
    harness.clock.tick();
    expect(await harness.learning.acknowledgeExposure(exposureInput(resolved))).toEqual(exposure);
    expect(await harness.storeSnapshot()).toBe(after);
  });

  it("a second acknowledgement of the same resolution with different content is refused visibly", async () => {
    const { harness, resolved } = await resolvedHarness();
    const exposure = await harness.learning.acknowledgeExposure(exposureInput(resolved));
    const after = await harness.storeSnapshot();
    for (const overrides of [
      { appliedEntryIds: [resolved.entries[0]?.id] },
      { assignmentId: "other-assignment" },
      { fingerprintId: "fp-other" },
    ]) {
      await expect(harness.learning.acknowledgeExposure(exposureInput(resolved, overrides))).rejects.toMatchObject({
        name: "LearningLoopError",
        code: "exposure.already_acknowledged",
        diagnostics: [expect.objectContaining({ details: { exposureSetId: exposure.id } })],
      });
    }
    expect(await harness.storeSnapshot()).toBe(after);
  });

  it("applied entries may be a subset of the receipt, including none, always in receipt order", async () => {
    const { harness, interventionIds, resolved } = await resolvedHarness();
    const lastOnly = await harness.learning.acknowledgeExposure(
      exposureInput(resolved, { appliedEntryIds: [resolved.entries[1]?.id] }),
    );
    expect(lastOnly.entries.map((entry) => entry.interventionId)).toEqual([interventionIds[1]]);

    const other = await harness.learning.resolveContext({
      episodeId: EPISODE_ID,
      scope: SCOPE,
      query: { taskClass: "documentation" },
      budget: BUDGET,
    });
    expect(other.id).not.toBe(resolved.id);
    const none = await harness.learning.acknowledgeExposure(exposureInput(other, { appliedEntryIds: [] }));
    expect(none.entries).toEqual([]);
    expect((await episodeView(harness, EPISODE_ID))?.episode.exposureIds).toEqual([lastOnly.id, none.id]);
  });

  it("an intervention disabled after resolution still acknowledges the content the receipt froze", async () => {
    const { harness, candidates, resolved } = await resolvedHarness();
    const prepared = await harness.learning.preparePublication({
      candidateId: candidates[0]?.id ?? "",
      destinationId: DESTINATION_ID,
      action: "disable",
    });
    completed(
      await harness.learning.publish({ planId: prepared.plan.id, authorizationEvidence: { decision: "authorized" } }),
    );
    const exposure = await harness.learning.acknowledgeExposure(exposureInput(resolved));
    expect(exposure.entries).toHaveLength(2);
  });
});

describe("learning.acknowledgeExposure: refusals with zero writes", () => {
  async function refusing(
    overrides: Record<string, unknown>,
    code: string,
    options: PublicationHarnessOptions = {},
  ): Promise<void> {
    const { harness, resolved } = await resolvedHarness(options);
    const before = await harness.storeSnapshot();
    await expectRefusal(() => harness.learning.acknowledgeExposure(exposureInput(resolved, overrides)), code);
    expect(await harness.storeSnapshot()).toBe(before);
  }

  it("an unknown resolution receipt", () =>
    refusing({ resolutionReceiptId: `resolution-${"0".repeat(64)}` }, "exposure.resolution_not_found"));

  it("an entry the receipt did not freeze", () =>
    refusing({ appliedEntryIds: [`entry-${"0".repeat(64)}`] }, "exposure.entry_unknown"));

  it("duplicate applied entries", async () => {
    const { harness, resolved } = await resolvedHarness();
    const id = resolved.entries[0]?.id;
    await expectRefusal(
      () => harness.learning.acknowledgeExposure(exposureInput(resolved, { appliedEntryIds: [id, id] })),
      "schema.invalid",
    );
  });

  it("no evidence at all: a caller assertion is not evidence", () =>
    refusing({ evidenceIds: [] }, "exposure.evidence_required"));

  it("evidence that is not a durable observation", () =>
    refusing({ evidenceIds: ["manual-evidence/obs-missing"] }, "exposure.evidence_not_found"));

  it("evidence of another episode", async () => {
    const { harness, resolved } = await resolvedHarness({}, "change-57");
    await expectRefusal(
      () => harness.learning.acknowledgeExposure(exposureInput(resolved)),
      "exposure.evidence_mismatch",
    );
  });

  it("advisory evidence: trust is host-granted and transcript-class evidence never proves exposure", async () => {
    const advisory = defineSourceRegistration({
      source: { ...createManualEvidenceSource(), descriptor: { id: "advisory-evidence", adapterVersion: "1.0.0" } },
      trustCeiling: "advisory",
      contentPolicyId: CONTENT_POLICY_ID,
    });
    const { harness, resolved } = await resolvedHarness({ extraSources: [advisory] });
    await harness.learning.ingest(advisory, {
      observations: [
        {
          id: "obs-42-applied",
          episodeId: EPISODE_ID,
          occurredAt: "2026-08-12T16:11:30.000Z",
          kind: "host.resolution.applied",
          data: { entries: 2 },
        },
      ],
    });
    const before = await harness.storeSnapshot();
    await expectRefusal(
      () =>
        harness.learning.acknowledgeExposure(
          exposureInput(resolved, { evidenceIds: ["advisory-evidence/obs-42-applied"] }),
        ),
      "exposure.evidence_untrusted",
    );
    expect(await harness.storeSnapshot()).toBe(before);
  });

  it("an experiment arm before the Validate tier declares experiments", () =>
    refusing({ experiment: { experimentId: "exp-1", arm: "treatment" } }, "exposure.experiment_unavailable"));

  it("malformed input", async () => {
    const { harness, resolved } = await resolvedHarness();
    const before = await harness.storeSnapshot();
    for (const overrides of [
      { assignmentId: "" },
      { fingerprintId: "" },
      { appliedEntryIds: "all" },
      { evidenceIds: [1] },
    ]) {
      await expectRefusal(
        () => harness.learning.acknowledgeExposure(exposureInput(resolved, overrides)),
        "schema.invalid",
      );
    }
    expect(await harness.storeSnapshot()).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Crash conformance

const EXPOSURE_KINDS = ["episode-exposure", "exposure-set"] as const;

async function exposureJournal(store: LearningStore): Promise<string> {
  const listing: string[] = [];
  for (const kind of EXPOSURE_KINDS) {
    const page = await store.list({ namespace: "learning", kind, limit: 10_000 });
    for (const record of page.records) listing.push(JSON.stringify([kind, record.key.id, record.digest]));
  }
  return JSON.stringify(listing.sort());
}

describe("learning.acknowledgeExposure: crash conformance", () => {
  const faults: readonly StoreFault[] = [
    { operation: "append", kind: "episode-exposure", when: "before" },
    { operation: "append", kind: "episode-exposure", when: "after" },
    { operation: "create", kind: "exposure-set", when: "before" },
    { operation: "create", kind: "exposure-set", when: "after" },
  ];

  it("a clean acknowledgement is the reference journal", async () => {
    const { harness, resolved } = await resolvedHarness();
    const exposure = await harness.learning.acknowledgeExposure(exposureInput(resolved));
    expect(await exposureJournal(harness.store)).toContain(exposure.id);
  });

  for (const fault of faults) {
    it(`a crash ${fault.when} ${fault.operation} ${fault.kind} converges on retry`, async () => {
      const clean = await resolvedHarness();
      const reference = await clean.harness.learning.acknowledgeExposure(exposureInput(clean.resolved));
      const referenceJournal = await exposureJournal(clean.harness.store);

      const base = createInMemoryStore();
      const faulted = faultStore(base, fault, { armed: false });
      const crashed = await resolvedHarness({ store: faulted.store });
      faulted.arm();
      await expect(crashed.harness.learning.acknowledgeExposure(exposureInput(crashed.resolved))).rejects.toThrow(
        /injected crash/,
      );
      expect(faulted.fired()).toBe(true);
      // A reconstructed host on the bare store, at the same wall-clock time,
      // forward-completes the same set.
      const rebuilt = await createPublicationHarness({ store: base, destination: crashed.harness.destination });
      rebuilt.clock.tick();
      const exposure = await rebuilt.learning.acknowledgeExposure(exposureInput(crashed.resolved));
      expect(exposure).toEqual(reference);
      expect(await exposureJournal(base)).toBe(referenceJournal);
      expect((await episodeView(rebuilt, EPISODE_ID))?.episode.exposureIds).toEqual([exposure.id]);
    });
  }

  it("an orphan index entry without its set does not count and is repaired by the retry", async () => {
    const base = createInMemoryStore();
    const faulted = faultStore(base, { operation: "create", kind: "exposure-set", when: "before" }, { armed: false });
    const crashed = await resolvedHarness({ store: faulted.store });
    faulted.arm();
    await expect(crashed.harness.learning.acknowledgeExposure(exposureInput(crashed.resolved))).rejects.toThrow();
    const rebuilt = await createPublicationHarness({ store: base, destination: crashed.harness.destination });
    expect((await episodeView(rebuilt, EPISODE_ID))?.episode.exposureIds).toEqual([]);
    const exposure: ExposureSetRecord = await rebuilt.learning.acknowledgeExposure(exposureInput(crashed.resolved));
    expect((await episodeView(rebuilt, EPISODE_ID))?.episode.exposureIds).toEqual([exposure.id]);
  });
});
