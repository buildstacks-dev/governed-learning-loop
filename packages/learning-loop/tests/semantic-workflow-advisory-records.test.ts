// #13c advisory record controls: unknown-first parsing, exact digest binding,
// closed enums, statement-privacy shape, and reciprocity of the completion
// intent graph. These records grant no Candidate, Review, or effect authority.
import { describe, expect, it } from "vitest";
import { sha256HexOfCanonicalJson, toJsonValue } from "../src/index.js";
import type { JsonValue } from "../src/index.js";
import {
  advisoryNormalizedResult,
  advisoryStatementByteLength,
  buildSemanticAdvisoryAssessment,
  buildSemanticAdvisoryAttemptIndex,
  buildSemanticAdvisoryCompletionIntent,
  buildSemanticAdvisoryReviewPlanLock,
  parseAdvisoryReviewResultDraft,
  parseSemanticAdvisoryAssessment,
  parseSemanticAdvisoryAttemptIndex,
  parseSemanticAdvisoryCompletionIntent,
  parseSemanticAdvisoryReviewPlanLock,
  semanticAdvisoryAdmissionLineageDigest,
  semanticAdvisoryEvidenceSetDigest,
  semanticAdvisoryReviewKeyDigest,
  semanticAdvisorySubjectSnapshotDigest,
} from "../src/workflows/advisory-review-record.js";
import type { SemanticAdvisoryAssessment } from "../src/workflows/advisory-review-record.js";
import { buildSemanticResultBinding, semanticNormalizedResultDigest } from "../src/workflows/semantic-turn-outcome.js";
import { buildCandidateScopeMembership, parseCandidateScopeMembership } from "../src/engine/candidate-scope-index.js";
import { createAdvisoryHarness } from "./semantic-workflow-advisory-harness.js";

function digest(label: string): string {
  return sha256HexOfCanonicalJson(toJsonValue({ label }));
}

const SCOPE_DIGEST = digest("advisory-record-scope");
const DEFINITION_DIGEST = digest("advisory-record-definition");
const CANDIDATE_DIGEST = digest("advisory-record-candidate");
const CANDIDATE_ID = "advisory-record-candidate";

const REVIEW_KEY = semanticAdvisoryReviewKeyDigest({
  candidateId: CANDIDATE_ID,
  candidateDigest: CANDIDATE_DIGEST,
  definitionDigest: DEFINITION_DIGEST,
  scopeDigest: SCOPE_DIGEST,
});

function reviewer(): SemanticAdvisoryAssessment["reviewer"] {
  return {
    principal: { id: "advisory-record-reviewer", kind: "service", independenceDomain: "advisory-record-domain" },
    attestation: { id: "advisory-record-attestation", digest: digest("advisory-record-attestation") },
    implementation: { id: "advisory-record-implementation", version: "1.0.0", digest: digest("advisory-impl") },
    modelFingerprintDigest: digest("advisory-record-model"),
    promptDigest: digest("advisory-record-prompt"),
    rendererDigest: digest("advisory-record-renderer"),
    outputSchemaDigest: digest("advisory-record-schema"),
    toolPolicyDigest: digest("advisory-record-tool"),
    budgetPolicyDigest: digest("advisory-record-budget"),
    calibration: { status: "unverified", calibrationId: null, calibrationDigest: null },
  };
}

function assessmentInput(): Omit<SemanticAdvisoryAssessment, "schemaVersion" | "id" | "assessmentDigest"> {
  const admission = { status: "not_subject", reason: "manual" } as const;
  return {
    turnKeyDigest: digest("advisory-record-turn-key"),
    reservationDigest: digest("advisory-record-reservation"),
    resultBindingDigest: digest("advisory-record-result-binding"),
    definitionDigest: DEFINITION_DIGEST,
    qualification: "advisory_uncalibrated",
    candidateId: CANDIDATE_ID,
    candidateDigest: CANDIDATE_DIGEST,
    scopeDigest: SCOPE_DIGEST,
    advisoryRecommendation: "revise",
    findings: [
      {
        code: "advisory.record_control",
        severity: "warning",
        statementKeyedDigest: digest("advisory-record-statement"),
        statementByteLength: 42,
      },
    ],
    keyPolicyDigest: digest("advisory-record-key-policy"),
    subjectSnapshotDigest: digest("advisory-record-subject"),
    evidenceSetDigest: digest("advisory-record-evidence-set"),
    derivationRef: null,
    admission,
    admissionLineageDigest: semanticAdvisoryAdmissionLineageDigest(admission),
    reviewer: reviewer(),
  };
}

describe("advisory review result draft", () => {
  it("parses a closed recommendation with bounded findings and refuses every deviation", () => {
    const draft = parseAdvisoryReviewResultDraft({
      advisoryRecommendation: "oppose",
      findings: [{ code: "advisory.blocking", severity: "blocking", statement: "The hypothesis is contradicted." }],
    });
    expect(draft.advisoryRecommendation).toBe("oppose");
    expect(draft.findings.length).toBe(1);
    const invalidCases: readonly unknown[] = [
      { advisoryRecommendation: "approve", findings: [] },
      { advisoryRecommendation: "support", findings: [{ code: "x", severity: "blocking", statement: "s" }] },
      {
        advisoryRecommendation: "revise",
        findings: Array.from({ length: 101 }, (_unused, index) => ({
          code: `advisory.f${index}`,
          severity: "info",
          statement: "s",
        })),
      },
      { advisoryRecommendation: "revise", findings: [{ code: "x", severity: "fatal", statement: "s" }] },
      { advisoryRecommendation: "revise", findings: [{ code: "x", severity: "info", statement: "" }] },
      { advisoryRecommendation: "revise" },
    ];
    for (const input of invalidCases) {
      expect(() => parseAdvisoryReviewResultDraft(input)).toThrowError(
        expect.objectContaining({ code: expect.stringMatching(/^schema\./) }),
      );
    }
  });

  it("never invokes accessor-backed fields on the untrusted draft", () => {
    const hostile: Record<string, unknown> = { advisoryRecommendation: "revise", findings: [] };
    let reads = 0;
    Object.defineProperty(hostile, "extra", {
      enumerable: true,
      get: () => {
        reads += 1;
        throw new Error("DRAFT-ACCESSOR-CANARY");
      },
    });
    expect(() => parseAdvisoryReviewResultDraft(hostile)).not.toThrow();
    expect(reads).toBe(0);
  });
});

describe("advisory assessment record", () => {
  it("binds every semantic field into the assessment digest and content-addressed id", () => {
    const built = buildSemanticAdvisoryAssessment(assessmentInput());
    expect(built.id).toBe(`semantic-review-assessment-${built.assessmentDigest}`);
    expect(parseSemanticAdvisoryAssessment(toJsonValue(built))).toEqual(built);
    const foreign = "0".repeat(64);
    const tampered: readonly Record<string, unknown>[] = [
      { ...built, candidateDigest: foreign },
      { ...built, advisoryRecommendation: "support" },
      { ...built, subjectSnapshotDigest: foreign },
      { ...built, evidenceSetDigest: foreign },
      { ...built, admissionLineageDigest: foreign },
      { ...built, qualification: "calibrated" },
      { ...built, id: `semantic-review-assessment-${foreign}` },
    ];
    for (const value of tampered) {
      expect(() => parseSemanticAdvisoryAssessment(value)).toThrowError(
        expect.objectContaining({ code: expect.stringMatching(/^schema\./) }),
      );
    }
  });

  it("refuses a non-null calibration, a support assessment with blocking findings, and foreign derivation scopes", () => {
    const base = assessmentInput();
    const calibrated = {
      ...base,
      reviewer: {
        ...base.reviewer,
        calibration: { status: "unverified", calibrationId: "calibration-1", calibrationDigest: digest("cal") },
      },
    };
    expect(() =>
      parseSemanticAdvisoryAssessment({
        schemaVersion: 1,
        id: "semantic-review-assessment-x",
        ...calibrated,
        assessmentDigest: "0".repeat(64),
      }),
    ).toThrowError(expect.objectContaining({ code: expect.stringMatching(/^schema\./) }));
    const supportBlocking = {
      ...base,
      advisoryRecommendation: "support" as const,
      findings: [
        {
          code: "advisory.blocking",
          severity: "blocking" as const,
          statementKeyedDigest: digest("blocking"),
          statementByteLength: 10,
        },
      ],
    };
    expect(() => buildSemanticAdvisoryAssessment(supportBlocking)).toThrowError(
      expect.objectContaining({ code: expect.stringMatching(/^schema\./) }),
    );
    const derivationDigest = digest("advisory-derivation");
    const foreignDerivation = {
      ...base,
      derivationRef: { id: `insight-${derivationDigest}`, derivationDigest, scopeDigest: digest("another-scope") },
    };
    expect(() => buildSemanticAdvisoryAssessment(foreignDerivation)).toThrowError(
      expect.objectContaining({ code: expect.stringMatching(/^schema\./) }),
    );
  });
});

describe("advisory plan lock and attempt index", () => {
  it("binds the plan lock to the exact review key derived from its subject", () => {
    const lock = buildSemanticAdvisoryReviewPlanLock({
      reviewKeyDigest: REVIEW_KEY,
      turnKeyDigest: digest("advisory-record-turn-key"),
      reservationId: `semantic-workflow-reservation-${digest("advisory-record-turn-key")}`,
      reservationDigest: digest("advisory-record-reservation"),
      definitionDigest: DEFINITION_DIGEST,
      scopeDigest: SCOPE_DIGEST,
      candidateId: CANDIDATE_ID,
      candidateDigest: CANDIDATE_DIGEST,
      request: {
        byteLength: 512,
        estimatedInputTokens: 128,
        minimizedBytesDigest: digest("advisory-record-request"),
        keyPolicyDigest: digest("advisory-record-key-policy"),
      },
    });
    expect(lock.id).toBe(`semantic-workflow-advisory-plan-${REVIEW_KEY}`);
    expect(parseSemanticAdvisoryReviewPlanLock(toJsonValue(lock))).toEqual(lock);
    expect(() => parseSemanticAdvisoryReviewPlanLock({ ...lock, candidateDigest: "1".repeat(64) })).toThrowError(
      expect.objectContaining({ code: expect.stringMatching(/^schema\./) }),
    );
    const attempt = buildSemanticAdvisoryAttemptIndex({
      attemptId: `semantic-workflow-advisory-attempt-${REVIEW_KEY}`,
      scopeDigest: SCOPE_DIGEST,
      definitionDigest: DEFINITION_DIGEST,
      reservationId: lock.reservationId,
      reservationDigest: lock.reservationDigest,
      planLockId: lock.id,
      planLockDigest: lock.lockDigest,
      reviewKeyDigest: REVIEW_KEY,
    });
    expect(parseSemanticAdvisoryAttemptIndex(toJsonValue(attempt))).toEqual(attempt);
    expect(() =>
      parseSemanticAdvisoryAttemptIndex({ ...attempt, planLockId: "semantic-workflow-advisory-plan-x" }),
    ).toThrowError(expect.objectContaining({ code: expect.stringMatching(/^schema\./) }));
  });
});

describe("advisory completion intent", () => {
  it("requires an exactly reciprocal completed result, assessment, and digested normalized projection", () => {
    const assessmentBase = assessmentInput();
    const normalized: JsonValue = advisoryNormalizedResult(assessmentBase);
    const turnKeyDigest = assessmentBase.turnKeyDigest;
    const result = buildSemanticResultBinding({
      turnKeyDigest,
      reservationDigest: assessmentBase.reservationDigest,
      dispatchDigest: digest("advisory-record-dispatch"),
      status: "completed",
      response: {
        providerReceiptId: `semantic-workflow-provider-receipt-${digest("advisory-record-receipt")}`,
        providerReceiptDigest: digest("advisory-record-receipt"),
        requestAttestationDigest: digest("advisory-record-request"),
        responseByteLength: 256,
        responseKeyedDigest: digest("advisory-record-response"),
        keyPolicyDigest: digest("advisory-record-key-policy"),
      },
      usage: {
        status: "reported",
        inputTokens: 10,
        outputTokens: 5,
        durationMs: 3,
        costMinorUnits: null,
        currency: null,
      },
      normalizedResult: normalized,
      normalizedResultDigest: semanticNormalizedResultDigest(normalized),
      reasonCodes: [],
    });
    const assessment = buildSemanticAdvisoryAssessment({
      ...assessmentBase,
      resultBindingDigest: result.bindingDigest,
    });
    const reviewKeyDigest = semanticAdvisoryReviewKeyDigest({
      candidateId: assessment.candidateId,
      candidateDigest: assessment.candidateDigest,
      definitionDigest: assessment.definitionDigest,
      scopeDigest: assessment.scopeDigest,
    });
    const intent = buildSemanticAdvisoryCompletionIntent({
      reviewKeyDigest,
      turnKeyDigest,
      reservationDigest: assessment.reservationDigest,
      planLockDigest: digest("advisory-record-plan-lock"),
      result,
      assessment,
    });
    expect(intent.id).toBe(`semantic-workflow-advisory-completion-${reviewKeyDigest}`);
    expect(parseSemanticAdvisoryCompletionIntent(toJsonValue(intent))).toEqual(intent);
    // A mismatched review key, foreign result binding, or divergent
    // normalized projection is refused before persistence.
    expect(() => parseSemanticAdvisoryCompletionIntent({ ...intent, reviewKeyDigest: "2".repeat(64) })).toThrowError(
      expect.objectContaining({ code: expect.stringMatching(/^schema\./) }),
    );
    const divergentAssessment = buildSemanticAdvisoryAssessment({
      ...assessmentBase,
      resultBindingDigest: result.bindingDigest,
      advisoryRecommendation: "oppose",
    });
    expect(() =>
      buildSemanticAdvisoryCompletionIntent({
        reviewKeyDigest,
        turnKeyDigest,
        reservationDigest: assessment.reservationDigest,
        planLockDigest: digest("advisory-record-plan-lock"),
        result,
        assessment: divergentAssessment,
      }),
    ).toThrowError(expect.objectContaining({ code: expect.stringMatching(/^schema\./) }));
  });
});

describe("advisory digest helpers and goldens", () => {
  it("pins the review-key, evidence-set, subject, and admission-lineage digest domains", () => {
    // Deliberate golden vectors: a digest-domain change is a ratified decision,
    // not an incidental refactor.
    expect(REVIEW_KEY).toBe("7413d921a61ba4137c859b0ea1020c0f0c1a3ad6e5720aba62ef77cc0f7f7cc7");
    expect(semanticAdvisoryEvidenceSetDigest([digest("advisory-evidence-a")])).toBe(
      "8d019bead2f8be2a70b34900849b5361afe5686999f426efdbef9dec8f22fed0",
    );
    expect(
      semanticAdvisorySubjectSnapshotDigest({
        candidate: { id: CANDIDATE_ID },
        derivation: null,
        admission: { status: "not_subject", reason: "manual" },
        evidenceSetDigest: digest("advisory-evidence-set"),
      }),
    ).toBe("c925f0c3180deff7953a8a2b900beb4d7962f4595e756d6b2f7551b83ade7890");
    expect(semanticAdvisoryAdmissionLineageDigest({ status: "not_subject", reason: "manual" })).toBe(
      "6f7452e692bc6d792d9d645e2194dc0d6380532417d967ae2d73ca61cda4ea8f",
    );
    expect(advisoryStatementByteLength("héllo")).toBe(6);
    expect(() => semanticAdvisoryEvidenceSetDigest(["b".repeat(64), "a".repeat(64)])).toThrowError(
      expect.objectContaining({ code: expect.stringMatching(/^schema\./) }),
    );
  });
});

describe("candidate scope membership index", () => {
  it("builds, parses, and refuses tampered membership projections", async () => {
    const harness = await createAdvisoryHarness();
    const membership = buildCandidateScopeMembership(harness.candidate);
    expect(parseCandidateScopeMembership(toJsonValue(membership))).toEqual(membership);
    expect(membership.candidateDigest).toBe(harness.candidate.contentDigest);
    for (const tampered of [
      { ...membership, candidateDigest: "3".repeat(64) },
      { ...membership, scopeDigest: "4".repeat(64) },
      { ...membership, indexDigest: "5".repeat(64) },
    ]) {
      expect(() => parseCandidateScopeMembership(tampered)).toThrowError(
        expect.objectContaining({ code: expect.stringMatching(/^schema\./) }),
      );
    }
  });
});
