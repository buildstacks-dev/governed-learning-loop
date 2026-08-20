import { describe, expect, it } from "vitest";
import { LearningLoopError } from "../src/diagnostics.js";
import { candidateContentDigest, candidateScopeDigest, parseCandidate } from "../src/records/candidate.js";
import type { EvidenceRef } from "../src/records/evidence-ref.js";
import { evidenceRefDigest, parseEvidenceRef } from "../src/records/evidence-ref.js";
import { parseEpisodeRecord, parseMeasurementRecord, parseMetricDefinition } from "../src/records/episode.js";
import { parseObservation } from "../src/records/observation.js";
import { parsePrincipalRef } from "../src/records/principal.js";
import { parseProvenance } from "../src/records/provenance.js";
import { parseCandidateReview } from "../src/records/review.js";

function errorFrom(run: () => unknown): LearningLoopError {
  try {
    run();
  } catch (error) {
    if (error instanceof LearningLoopError) return error;
    throw error;
  }
  throw new Error("expected a LearningLoopError");
}

const provenanceFixture = {
  sourceId: "manual-source",
  adapterVersion: "1.0.0",
  sourceRef: "session-9",
  sourceRevision: "rev-1",
  contentDigest: "abc123",
  completeness: "complete",
  trust: "observed",
};

const observationFixture = {
  schemaVersion: 1,
  id: "obs-1",
  episodeId: "ep-1",
  occurredAt: "2026-08-16T10:00:00.000Z",
  kind: "tool.process.completed",
  provenance: provenanceFixture,
  data: { commandClass: "typecheck", exitCode: 1 },
};

const metricFixture = {
  name: "typecheck",
  valueType: "boolean",
  unit: "pass",
  aggregation: "all",
};

const measurementFixture = {
  schemaVersion: 1,
  id: "measure-1",
  episodeId: "ep-1",
  metric: metricFixture,
  value: false,
  evidenceIds: ["obs-1"],
  provenance: provenanceFixture,
};

const episodeFixture = {
  schemaVersion: 1,
  id: "ep-1",
  scope: [
    { type: "project", id: "acme-api" },
    { type: "agent", id: "coding-agent" },
  ],
  openedAt: "2026-08-16T09:00:00.000Z",
  closedAt: "2026-08-16T10:00:00.000Z",
  sourceRefs: ["session-9"],
  outcome: { status: "failed", measurementIds: ["measure-1"] },
  exposureIds: [],
};

const candidateBoundFields = {
  scope: [{ type: "project", id: "acme-api" }],
  problem: "Type errors are reported after completion.",
  hypothesis: "A preflight catches them earlier.",
  evidenceIds: ["obs-1"],
  intervention: {
    destinationId: "agent-instructions",
    kind: "procedure",
    content: { text: "Run the type-check before reporting complete." },
    rollbackIntent: "Disable this instruction version.",
  },
  proposedRisk: "T1",
} as const;

const candidateFixture = {
  ...candidateBoundFields,
  schemaVersion: 1,
  id: "cand-1",
  proposedBy: { id: "distiller-a", kind: "agent", independenceDomain: "provider-a" },
  proposerAttestationDigest: "attest-1",
  proposedAt: "2026-08-16T10:05:00.000Z",
  contentDigest: candidateContentDigest(candidateBoundFields),
};

const evidenceRefBound: Omit<EvidenceRef, "schemaVersion" | "referenceDigest"> = {
  kind: "observation",
  recordId: "manual-source/obs-1",
  recordDigest: "1".repeat(64),
  sourceId: "manual-source",
  sourceRegistrationRevision: "2".repeat(64),
  sourceRef: "artifact-1",
  sourceRevision: "revision-1",
  sourceRecordId: "obs-1",
  pageRef: "page-observation",
  pageReceiptId: `source-page-${"3".repeat(64)}`,
  pageReceiptDigest: "3".repeat(64),
  loopRegistryRevision: "4".repeat(64),
  trust: "observed",
  completeness: "complete",
  episode: {
    sourceId: "manual-source",
    episodeId: "ep-1",
    episodeRecordId: "manual-source/episode-record-1",
    episodeRecordDigest: "5".repeat(64),
    episodeIdentityDigest: "6".repeat(64),
    scopeDigest: candidateScopeDigest(candidateBoundFields.scope),
    pageReceiptId: `source-page-${"7".repeat(64)}`,
    pageReceiptDigest: "7".repeat(64),
  },
};

const evidenceRefFixture: EvidenceRef = {
  schemaVersion: 1,
  ...evidenceRefBound,
  referenceDigest: evidenceRefDigest(evidenceRefBound),
};

function candidateV2FixtureFor(
  evidenceRefs: readonly EvidenceRef[],
  lineage?: { readonly supersedes: string; readonly originalDigest: string },
) {
  const digestInput = {
    schemaVersion: 2 as const,
    scope: candidateBoundFields.scope,
    problem: candidateBoundFields.problem,
    hypothesis: candidateBoundFields.hypothesis,
    evidenceRefs,
    intervention: candidateBoundFields.intervention,
    proposedRisk: candidateBoundFields.proposedRisk,
    ...(lineage === undefined ? {} : lineage),
  };
  return {
    ...digestInput,
    id: "cand-v2",
    proposedBy: { id: "distiller-a", kind: "agent" as const, independenceDomain: "provider-a" },
    proposerAttestationDigest: "8".repeat(64),
    proposedAt: "2026-08-16T10:05:00.000Z",
    contentDigest: candidateContentDigest(digestInput),
  };
}

const candidateV2Fixture = candidateV2FixtureFor([evidenceRefFixture]);

const reviewFixture = {
  schemaVersion: 1,
  id: "review-1",
  candidateId: "cand-1",
  candidateDigest: candidateFixture.contentDigest,
  reviewer: { id: "reviewer-b", kind: "agent", independenceDomain: "provider-b" },
  reviewerAttestationDigest: "attest-2",
  reviewerImplementation: { id: "reviewer-workflow-b", version: "1.0.0" },
  disposition: "accept",
  findings: [],
  reviewedAt: "2026-08-16T10:10:00.000Z",
};

interface ParserCase {
  readonly name: string;
  readonly parse: (input: unknown) => unknown;
  readonly fixture: Record<string, unknown>;
  readonly requiredField: string;
  readonly wrongTypeField: string;
  readonly versioned: boolean;
}

const parserCases: readonly ParserCase[] = [
  {
    name: "parsePrincipalRef",
    parse: parsePrincipalRef,
    fixture: { id: "p-1", kind: "human", independenceDomain: "org-a" },
    requiredField: "independenceDomain",
    wrongTypeField: "kind",
    versioned: false,
  },
  {
    name: "parseProvenance",
    parse: parseProvenance,
    fixture: { ...provenanceFixture },
    requiredField: "contentDigest",
    wrongTypeField: "trust",
    versioned: false,
  },
  {
    name: "parseObservation",
    parse: parseObservation,
    fixture: { ...observationFixture },
    requiredField: "kind",
    wrongTypeField: "provenance",
    versioned: true,
  },
  {
    name: "parseMetricDefinition",
    parse: parseMetricDefinition,
    fixture: { ...metricFixture },
    requiredField: "aggregation",
    wrongTypeField: "valueType",
    versioned: false,
  },
  {
    name: "parseMeasurementRecord",
    parse: parseMeasurementRecord,
    fixture: { ...measurementFixture },
    requiredField: "evidenceIds",
    wrongTypeField: "metric",
    versioned: true,
  },
  {
    name: "parseEpisodeRecord",
    parse: parseEpisodeRecord,
    fixture: { ...episodeFixture },
    requiredField: "openedAt",
    wrongTypeField: "scope",
    versioned: true,
  },
  {
    name: "parseCandidate",
    parse: parseCandidate,
    fixture: { ...candidateFixture },
    requiredField: "hypothesis",
    wrongTypeField: "intervention",
    versioned: true,
  },
  {
    name: "parseEvidenceRef",
    parse: parseEvidenceRef,
    fixture: { ...evidenceRefFixture },
    requiredField: "recordDigest",
    wrongTypeField: "episode",
    versioned: true,
  },
  {
    name: "parseCandidateReview",
    parse: parseCandidateReview,
    fixture: { ...reviewFixture },
    requiredField: "candidateDigest",
    wrongTypeField: "disposition",
    versioned: true,
  },
];

describe.each(parserCases)("$name", ({ name, parse, fixture, requiredField, wrongTypeField, versioned }) => {
  it("accepts a valid fixture and round-trips its fields", () => {
    expect(parse(fixture)).toEqual(fixture);
  });

  it("ignores unknown fields (preserved-irrelevant) and drops them from the parsed value", () => {
    const parsed = parse({ ...fixture, futureField: "surprise", another: 42 });
    expect(parsed).toEqual(parse(fixture));
    expect(Object.keys(Object(parsed))).not.toContain("futureField");
  });

  it(`rejects a missing required field (${requiredField})`, () => {
    const broken = Object.fromEntries(Object.entries(fixture).filter(([key]) => key !== requiredField));
    const error = errorFrom(() => parse(broken));
    expect(error.code).toBe("schema.invalid");
    expect(error.diagnostics[0]?.path).toContain(requiredField);
  });

  it(`rejects a wrong-typed field (${wrongTypeField})`, () => {
    const error = errorFrom(() => parse({ ...fixture, [wrongTypeField]: 123 }));
    expect(error.code).toBe("schema.invalid");
  });

  it("rejects non-object input", () => {
    expect(errorFrom(() => parse("nope")).code).toBe("schema.invalid");
    expect(errorFrom(() => parse(null)).code).toBe("schema.invalid");
  });

  if (versioned) {
    it("rejects a wrong schemaVersion as schema.unsupported_version", () => {
      const wrongVersion = name === "parseCandidate" || name === "parseEvidenceRef" ? 3 : 2;
      expect(errorFrom(() => parse({ ...fixture, schemaVersion: wrongVersion })).code).toBe(
        "schema.unsupported_version",
      );
    });

    it("rejects a missing schemaVersion as schema.unsupported_version", () => {
      const broken = Object.fromEntries(Object.entries(fixture).filter(([key]) => key !== "schemaVersion"));
      expect(errorFrom(() => parse(broken)).code).toBe("schema.unsupported_version");
    });
  }
});

describe("parseCandidate digest verification", () => {
  it("rejects a tampered contentDigest as schema.corrupt", () => {
    const error = errorFrom(() => parseCandidate({ ...candidateFixture, contentDigest: "0".repeat(64) }));
    expect(error.code).toBe("schema.corrupt");
  });

  it("rejects mutated bound content whose stored digest no longer matches", () => {
    const error = errorFrom(() => parseCandidate({ ...candidateFixture, problem: "Rewritten after review." }));
    expect(error.code).toBe("schema.corrupt");
  });
});

describe("parseEvidenceRef exact lineage", () => {
  it("rejects a changed field whose reference digest is stale", () => {
    expect(errorFrom(() => parseEvidenceRef({ ...evidenceRefFixture, recordDigest: "9".repeat(64) })).code).toBe(
      "schema.corrupt",
    );
  });

  it("rejects self-consistently re-digested foreign record and episode ownership", () => {
    const foreignRecordBound = { ...evidenceRefBound, recordId: "other-source/obs-1" };
    expect(
      errorFrom(() =>
        parseEvidenceRef({
          schemaVersion: 1,
          ...foreignRecordBound,
          referenceDigest: evidenceRefDigest(foreignRecordBound),
        }),
      ).code,
    ).toBe("schema.corrupt");

    const foreignEpisodeBound = {
      ...evidenceRefBound,
      episode: { ...evidenceRefBound.episode, sourceId: "other-source" },
    };
    expect(
      errorFrom(() =>
        parseEvidenceRef({
          schemaVersion: 1,
          ...foreignEpisodeBound,
          referenceDigest: evidenceRefDigest(foreignEpisodeBound),
        }),
      ).code,
    ).toBe("schema.corrupt");
  });

  it("rejects self-consistently re-digested page receipt id/digest mismatches", () => {
    const evidencePageMismatch = { ...evidenceRefBound, pageReceiptId: `source-page-${"a".repeat(64)}` };
    expect(
      errorFrom(() =>
        parseEvidenceRef({
          schemaVersion: 1,
          ...evidencePageMismatch,
          referenceDigest: evidenceRefDigest(evidencePageMismatch),
        }),
      ).code,
    ).toBe("schema.corrupt");

    const episodePageMismatch = {
      ...evidenceRefBound,
      episode: { ...evidenceRefBound.episode, pageReceiptId: `source-page-${"b".repeat(64)}` },
    };
    expect(
      errorFrom(() =>
        parseEvidenceRef({
          schemaVersion: 1,
          ...episodePageMismatch,
          referenceDigest: evidenceRefDigest(episodePageMismatch),
        }),
      ).code,
    ).toBe("schema.corrupt");
  });
});

describe("parseCandidate schema v2 invariants", () => {
  it("accepts a valid receipt-bound candidate", () => {
    expect(parseCandidate(candidateV2Fixture)).toEqual(candidateV2Fixture);
  });

  it("requires a nonempty, duplicate-free ordered EvidenceRef list", () => {
    const empty = candidateV2FixtureFor([]);
    expect(errorFrom(() => parseCandidate(empty)).code).toBe("schema.invalid");

    const exactDuplicate = candidateV2FixtureFor([evidenceRefFixture, evidenceRefFixture]);
    expect(errorFrom(() => parseCandidate(exactDuplicate)).code).toBe("schema.invalid");

    const sameRecordBound = {
      ...evidenceRefBound,
      pageRef: "other-page",
      pageReceiptId: `source-page-${"c".repeat(64)}`,
      pageReceiptDigest: "c".repeat(64),
    };
    const sameRecord: EvidenceRef = {
      schemaVersion: 1,
      ...sameRecordBound,
      referenceDigest: evidenceRefDigest(sameRecordBound),
    };
    const recordDuplicate = candidateV2FixtureFor([evidenceRefFixture, sameRecord]);
    expect(errorFrom(() => parseCandidate(recordDuplicate)).code).toBe("schema.invalid");
  });

  it("requires every reference scope digest to equal the candidate scope", () => {
    const otherScopeBound = {
      ...evidenceRefBound,
      episode: { ...evidenceRefBound.episode, scopeDigest: candidateScopeDigest([{ type: "project", id: "other" }]) },
    };
    const otherScopeReference: EvidenceRef = {
      schemaVersion: 1,
      ...otherScopeBound,
      referenceDigest: evidenceRefDigest(otherScopeBound),
    };
    expect(errorFrom(() => parseCandidate(candidateV2FixtureFor([otherScopeReference]))).code).toBe("schema.corrupt");
  });

  it("requires supersedes and originalDigest together and binds both into contentDigest", () => {
    expect(errorFrom(() => parseCandidate({ ...candidateV2Fixture, supersedes: "candidate-old" })).code).toBe(
      "schema.invalid",
    );
    expect(errorFrom(() => parseCandidate({ ...candidateV2Fixture, originalDigest: "d".repeat(64) })).code).toBe(
      "schema.invalid",
    );

    const lineage = candidateV2FixtureFor([evidenceRefFixture], {
      supersedes: "candidate-old",
      originalDigest: "d".repeat(64),
    });
    expect(parseCandidate(lineage)).toEqual(lineage);
    expect(errorFrom(() => parseCandidate({ ...lineage, originalDigest: "e".repeat(64) })).code).toBe("schema.corrupt");
  });

  it("rejects tampering with any embedded reference or candidate content", () => {
    expect(
      errorFrom(() =>
        parseCandidate({
          ...candidateV2Fixture,
          evidenceRefs: [{ ...evidenceRefFixture, referenceDigest: "f".repeat(64) }],
        }),
      ).code,
    ).toBe("schema.corrupt");
    expect(errorFrom(() => parseCandidate({ ...candidateV2Fixture, problem: "tampered" })).code).toBe("schema.corrupt");
  });
});

describe("optional fields under exactOptionalPropertyTypes", () => {
  it("omits absent optional fields entirely", () => {
    const parsed = parseEpisodeRecord({
      schemaVersion: 1,
      id: "ep-2",
      scope: [{ type: "project", id: "acme-api" }],
      openedAt: "2026-08-16T09:00:00.000Z",
      sourceRefs: [],
      exposureIds: [],
    });
    expect("closedAt" in parsed).toBe(false);
    expect("outcome" in parsed).toBe(false);
    expect("fingerprintId" in parsed).toBe(false);
  });
});
