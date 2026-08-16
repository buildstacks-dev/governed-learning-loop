import { describe, expect, it } from "vitest";
import { LearningLoopError } from "../src/diagnostics.js";
import { candidateContentDigest, parseCandidate } from "../src/records/candidate.js";
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
    name: "parseCandidateReview",
    parse: parseCandidateReview,
    fixture: { ...reviewFixture },
    requiredField: "candidateDigest",
    wrongTypeField: "disposition",
    versioned: true,
  },
];

describe.each(parserCases)("$name", ({ parse, fixture, requiredField, wrongTypeField, versioned }) => {
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
      expect(errorFrom(() => parse({ ...fixture, schemaVersion: 2 })).code).toBe("schema.unsupported_version");
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
