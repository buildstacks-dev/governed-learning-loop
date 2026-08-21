// Resolution receipt and exposure set records (contract §The façade,
// §Intervention, exposure, and efficacy; decision 0027): content-addressed
// ids, recomputed digests on parse, bounded and duplicate-free entries, and
// the one-exposure-per-resolution id derivation.
import { describe, expect, it } from "vitest";
import type { ExposureSetRecord, ResolvedContext } from "../src/index.js";
import { parseExposureSetRecord, parseResolvedContext, scopeDigest, sha256HexOfCanonicalJson } from "../src/index.js";
import { exposureSetDigest, exposureSetIdFor, sameExposureContent } from "../src/records/exposure.js";
import {
  resolutionQueryDigest,
  resolvedContextDigest,
  resolvedContextIdFor,
  resolvedEntryIdFor,
} from "../src/records/resolution.js";
import { SCOPE } from "./engine-harness.js";

const PLAN_DIGEST = "a".repeat(64);
const SECOND_PLAN_DIGEST = "b".repeat(64);
const TRANSITION_ID = `transition-${"c".repeat(64)}`;
const CONTENT = { text: "Before reporting a change complete, run the type-check command." };
const CONTENT_DIGEST = sha256HexOfCanonicalJson(CONTENT);

function entryFor(planDigest: string, overrides: Record<string, unknown> = {}) {
  const interventionId = `intervention-${planDigest}`;
  return {
    id: resolvedEntryIdFor({ interventionId, transitionId: TRANSITION_ID, contentDigest: CONTENT_DIGEST }),
    interventionId,
    candidateId: "cand-1",
    candidateDigest: "d".repeat(64),
    planDigest,
    destinationId: "agent-instructions",
    scopeDigest: scopeDigest(SCOPE),
    transitionId: TRANSITION_ID,
    content: CONTENT,
    contentDigest: CONTENT_DIGEST,
    ...overrides,
  };
}

function receiptFor(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const content = {
    episodeId: "change-57",
    scope: SCOPE,
    scopeDigest: scopeDigest(SCOPE),
    scopePolicyDigest: "1".repeat(64),
    registryRevision: "2".repeat(64),
    policyDigest: "3".repeat(64),
    queryDigest: resolutionQueryDigest({ taskClass: "typescript-code-change" }),
    budget: { maximumEntries: 8, maximumCharacters: 4_000 },
    entries: [entryFor(PLAN_DIGEST)],
    omittedInterventionIds: [`intervention-${SECOND_PLAN_DIGEST}`],
    ...overrides,
  };
  const receiptDigest = resolvedContextDigest(content);
  return {
    schemaVersion: 1,
    id: resolvedContextIdFor(receiptDigest),
    ...content,
    resolvedAt: "2026-08-16T10:00:00.000Z",
    receiptDigest,
  };
}

function exposureFor(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const receipt = parseResolvedContext(receiptFor());
  const content = {
    episodeId: receipt.episodeId,
    resolutionReceiptId: receipt.id,
    entries: receipt.entries.map((entry) => ({
      interventionId: entry.interventionId,
      resolvedContentDigest: entry.contentDigest,
    })),
    assignmentId: "ordinary-resolution-v1",
    fingerprintId: "fp-agent-run-v9",
    evidenceIds: ["manual-evidence/obs-57-applied"],
    exposedAt: "2026-08-16T10:05:00.000Z",
    ...overrides,
  };
  return {
    schemaVersion: 1,
    id: exposureSetIdFor(receipt.receiptDigest),
    ...content,
    exposureDigest: exposureSetDigest(content),
  };
}

function rejects(run: () => unknown, code: string, pathTail?: string | number): void {
  let thrown: unknown;
  try {
    run();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toMatchObject({ name: "LearningLoopError", code });
  if (pathTail !== undefined && typeof thrown === "object" && thrown !== null && "diagnostics" in thrown) {
    const diagnostics: unknown = thrown.diagnostics;
    expect(Array.isArray(diagnostics) && diagnostics[0]?.path?.at(-1)).toBe(pathTail);
  }
}

describe("ResolvedContext: the resolution receipt", () => {
  it("round-trips, recomputes every digest, and drops unknown fields", () => {
    const raw = receiptFor();
    const parsed = parseResolvedContext({ ...raw, extra: "ignored" });
    expect(parsed).toEqual(raw);
    expect(parsed.id).toBe(`resolution-${parsed.receiptDigest}`);
    expect(parseResolvedContext(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
  });

  it("pins the receipt, entry, and query digest vectors", () => {
    const parsed = parseResolvedContext(receiptFor());
    expect(resolutionQueryDigest({ taskClass: "typescript-code-change" })).toBe(
      sha256HexOfCanonicalJson({
        domain: "context-resolution-query:v1",
        query: { taskClass: "typescript-code-change" },
      }),
    );
    expect(parsed.entries[0]?.id).toBe(
      `entry-${sha256HexOfCanonicalJson({
        domain: "context-resolution-entry:v1",
        interventionId: `intervention-${PLAN_DIGEST}`,
        transitionId: TRANSITION_ID,
        contentDigest: CONTENT_DIGEST,
      })}`,
    );
    expect({ receiptDigest: parsed.receiptDigest }).toEqual({ receiptDigest: RECEIPT_DIGEST_GOLDEN });
  });

  it("changes digest for every bound field and never for the timestamp", () => {
    const base = parseResolvedContext(receiptFor());
    const variants: Record<string, unknown>[] = [
      { episodeId: "change-58" },
      { scope: [{ type: "project", id: "other" }], scopeDigest: scopeDigest([{ type: "project", id: "other" }]) },
      { scopePolicyDigest: "9".repeat(64) },
      { registryRevision: "9".repeat(64) },
      { policyDigest: "9".repeat(64) },
      { queryDigest: "9".repeat(64) },
      { budget: { maximumEntries: 9, maximumCharacters: 4_000 } },
      { budget: { maximumEntries: 8, maximumCharacters: 4_001 } },
      { entries: [] },
      { entries: [entryFor(SECOND_PLAN_DIGEST)], omittedInterventionIds: [] },
      { omittedInterventionIds: [] },
    ];
    for (const variant of variants) {
      const parsed = parseResolvedContext(receiptFor(variant));
      expect(parsed.receiptDigest).not.toBe(base.receiptDigest);
      expect(parsed.id).not.toBe(base.id);
    }
    const later = parseResolvedContext({ ...receiptFor(), resolvedAt: "2026-08-17T00:00:00.000Z" });
    expect(later.receiptDigest).toBe(base.receiptDigest);
    expect(later.id).toBe(base.id);
  });

  it("refuses an id, receipt digest, scope digest, entry id, or content digest that does not match", () => {
    rejects(
      () => parseResolvedContext({ ...receiptFor(), id: `resolution-${"0".repeat(64)}` }),
      "schema.corrupt",
      "id",
    );
    rejects(
      () => parseResolvedContext({ ...receiptFor(), receiptDigest: "0".repeat(64) }),
      "schema.corrupt",
      "receiptDigest",
    );
    rejects(() => parseResolvedContext(receiptFor({ scopeDigest: "0".repeat(64) })), "schema.corrupt", "scopeDigest");
    rejects(
      () => parseResolvedContext(receiptFor({ entries: [entryFor(PLAN_DIGEST, { id: "entry-wrong" })] })),
      "schema.corrupt",
      "id",
    );
    rejects(
      () => parseResolvedContext(receiptFor({ entries: [entryFor(PLAN_DIGEST, { content: { text: "altered" } })] })),
      "schema.corrupt",
      "contentDigest",
    );
    rejects(
      () => parseResolvedContext(receiptFor({ entries: [entryFor(PLAN_DIGEST, { planDigest: SECOND_PLAN_DIGEST })] })),
      "schema.corrupt",
      "interventionId",
    );
  });

  it("refuses duplicate interventions, served-and-omitted ids, over-budget entries, and bad budgets", () => {
    const otherHead = `transition-${"e".repeat(64)}`;
    const sameInterventionAgain = entryFor(PLAN_DIGEST, {
      id: resolvedEntryIdFor({
        interventionId: `intervention-${PLAN_DIGEST}`,
        transitionId: otherHead,
        contentDigest: CONTENT_DIGEST,
      }),
      transitionId: otherHead,
    });
    rejects(
      () => parseResolvedContext(receiptFor({ entries: [entryFor(PLAN_DIGEST), sameInterventionAgain] })),
      "schema.invalid",
      "interventionId",
    );
    rejects(
      () => parseResolvedContext(receiptFor({ entries: [entryFor(PLAN_DIGEST), entryFor(PLAN_DIGEST)] })),
      "schema.invalid",
      "id",
    );
    rejects(
      () => parseResolvedContext(receiptFor({ omittedInterventionIds: [`intervention-${PLAN_DIGEST}`] })),
      "schema.invalid",
      0,
    );
    rejects(
      () =>
        parseResolvedContext(
          receiptFor({
            omittedInterventionIds: [`intervention-${SECOND_PLAN_DIGEST}`, `intervention-${SECOND_PLAN_DIGEST}`],
          }),
        ),
      "schema.invalid",
      1,
    );
    rejects(
      () =>
        parseResolvedContext(
          receiptFor({
            budget: { maximumEntries: 1, maximumCharacters: 4_000 },
            entries: [entryFor(PLAN_DIGEST), entryFor(SECOND_PLAN_DIGEST)],
            omittedInterventionIds: [],
          }),
        ),
      "schema.invalid",
      "entries",
    );
    for (const budget of [
      { maximumEntries: 0, maximumCharacters: 1 },
      { maximumEntries: 1_001, maximumCharacters: 1 },
      { maximumEntries: 1, maximumCharacters: 0 },
      { maximumEntries: 1, maximumCharacters: 10_000_001 },
      { maximumEntries: 1.5, maximumCharacters: 1 },
    ]) {
      rejects(() => parseResolvedContext(receiptFor({ budget })), "schema.invalid");
    }
    rejects(() => parseResolvedContext(receiptFor({ scope: [] })), "schema.invalid", "scope");
    rejects(() => parseResolvedContext({ ...receiptFor(), resolvedAt: "2026-08-16T10:00:00Z" }), "schema.invalid");
    rejects(() => parseResolvedContext({ ...receiptFor(), schemaVersion: 2 }), "schema.unsupported_version");
  });
});

describe("ExposureSetRecord", () => {
  it("round-trips, derives its id from the resolution receipt, and pins its digest vector", () => {
    const raw = exposureFor();
    const parsed = parseExposureSetRecord({ ...raw, extra: "ignored" });
    expect(parsed).toEqual(raw);
    expect(parsed.id).toBe(`exposure-${parseResolvedContext(receiptFor()).receiptDigest}`);
    expect({ exposureDigest: parsed.exposureDigest }).toEqual({ exposureDigest: EXPOSURE_DIGEST_GOLDEN });
    const withExperiment = parseExposureSetRecord(
      exposureFor({ experiment: { experimentId: "exp-1", arm: "treatment" } }),
    );
    expect(withExperiment.experiment).toEqual({ experimentId: "exp-1", arm: "treatment" });
    expect(withExperiment.exposureDigest).not.toBe(parsed.exposureDigest);
  });

  it("refuses an id not derived from its receipt, a malformed receipt id, and a stale digest", () => {
    rejects(
      () => parseExposureSetRecord({ ...exposureFor(), id: `exposure-${"0".repeat(64)}` }),
      "schema.corrupt",
      "id",
    );
    rejects(
      () => parseExposureSetRecord(exposureFor({ resolutionReceiptId: "resolution-short" })),
      "schema.invalid",
      "resolutionReceiptId",
    );
    rejects(
      () => parseExposureSetRecord({ ...exposureFor(), exposureDigest: "0".repeat(64) }),
      "schema.corrupt",
      "exposureDigest",
    );
    rejects(
      () => parseExposureSetRecord({ ...exposureFor(), assignmentId: "other" }),
      "schema.corrupt",
      "exposureDigest",
    );
  });

  it("requires evidence and unique entries per intervention, and a closed experiment arm", () => {
    rejects(() => parseExposureSetRecord(exposureFor({ evidenceIds: [] })), "schema.invalid", "evidenceIds");
    rejects(() => parseExposureSetRecord(exposureFor({ evidenceIds: ["a", "a"] })), "schema.invalid", 1);
    const entry = { interventionId: `intervention-${PLAN_DIGEST}`, resolvedContentDigest: CONTENT_DIGEST };
    rejects(() => parseExposureSetRecord(exposureFor({ entries: [entry, entry] })), "schema.invalid", 1);
    rejects(
      () => parseExposureSetRecord(exposureFor({ experiment: { experimentId: "exp-1", arm: "placebo" } })),
      "schema.invalid",
      "arm",
    );
    const empty = parseExposureSetRecord(exposureFor({ entries: [] }));
    expect(empty.entries).toEqual([]);
  });

  it("treats two sets that differ only in exposedAt as the same exposure", () => {
    const left = parseExposureSetRecord(exposureFor());
    const right = parseExposureSetRecord(exposureFor({ exposedAt: "2026-08-17T00:00:00.000Z" }));
    const other = parseExposureSetRecord(exposureFor({ fingerprintId: "fp-other" }));
    expect(left.exposureDigest).not.toBe(right.exposureDigest);
    expect(sameExposureContent(left, right)).toBe(true);
    expect(sameExposureContent(left, other)).toBe(false);
  });
});

// Golden vectors: recompute deliberately when a digest domain changes, never
// to make a failing test pass.
const RECEIPT_DIGEST_GOLDEN = "0b8d6cd11409e52ddd09b2e3f0de2c093a36221be6fdf5bbf9d34a4fc53327c7";
const EXPOSURE_DIGEST_GOLDEN = "c5d70082a3db45a4a098aaa8ec8e6ac4abf3344e180e2c4cf936ee2d263edf98";

// Keep the record types in view so a shape change here is a visible diff.
const _typeCheck: readonly [ResolvedContext, ExposureSetRecord] | undefined = undefined;
void _typeCheck;
