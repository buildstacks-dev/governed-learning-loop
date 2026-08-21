// #13c advisory semantic review: exact subject binding, one provider callback
// after durable dispatch, digested-statement privacy, closed failure states,
// and absence of any Candidate/Review/admission/effect side channel.
import { describe, expect, it } from "vitest";
import { canonicalJsonText, sha256HexOfCanonicalJson, toJsonValue } from "../src/index.js";
import type { LearningStore, RecordKey } from "../src/index.js";
import { createInMemoryStore } from "../src/testing/index.js";
import type { StoreMutationTrace } from "./semantic-workflow-generation-harness.js";
import {
  providerRequestBytes,
  providerSignal,
  recordingStore,
  workflowKeyedDigest,
  WORKFLOW_SCOPE,
} from "./semantic-workflow-generation-harness.js";
import { createSemanticWorkflowBundle } from "@cormidia/learning-loop/workflows";
import { positiveProviderResult } from "./semantic-workflow-generation-harness.js";
import {
  advisoryDefinitionFor,
  createAdvisoryHarness,
  failedAdvisoryResult,
  positiveAdvisoryResult,
  proposeSubjectCandidate,
  refusedAdvisoryResult,
} from "./semantic-workflow-advisory-harness.js";
import { buildCandidateScopeMembership } from "../src/engine/candidate-scope-index.js";
import { candidateContentDigest } from "../src/records/candidate.js";

function isRecord(input: unknown): input is Readonly<Record<string, unknown>> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

async function dumpStore(store: LearningStore, namespace: string, kind: string): Promise<readonly unknown[]> {
  const raw: unknown = await store.list({ namespace, kind, limit: 1_000 });
  if (!isRecord(raw) || !Array.isArray(raw.records)) throw new Error("store list page is malformed");
  return raw.records;
}

function preparedOrThrow<T extends { readonly status: string }>(outcome: T): Extract<T, { status: "prepared" }> {
  if (outcome.status !== "prepared") {
    throw new Error(`advisory prepare returned ${outcome.status}: ${JSON.stringify(outcome)}`);
  }
  return outcome as Extract<T, { status: "prepared" }>;
}

const STATEMENT = "ADVISORY-STATEMENT-CANARY: the hypothesis has no contradicting probe.";

describe("advisory semantic review public journey", () => {
  it("prepares a zero-write exact subject preview and commits one advisory assessment", async () => {
    const trace: StoreMutationTrace = { writes: [] };
    const base = createInMemoryStore();
    const harness = await createAdvisoryHarness({ store: recordingStore(base, trace) });
    const writesBeforePrepare = trace.writes.length;
    const prepared = preparedOrThrow(await harness.advisoryBundle.prepareAdvisoryReview(harness.advisoryPrepareInput));
    expect(trace.writes.length).toBe(writesBeforePrepare);
    expect(harness.advisoryProviderState.calls.length).toBe(0);
    expect(prepared.candidateDigest).toBe(harness.candidate.contentDigest);
    expect(prepared.preview.byteLength).toBe(prepared.preview.bytes.byteLength);
    expect(prepared.preview.minimizedBytesDigest).toBe(workflowKeyedDigest(prepared.preview.bytes));
    // The preview envelope is kernel-owned: definition, prompt, and the exact
    // subject (candidate bytes, derivation, admission, evidence-set digest).
    const previewJson: unknown = JSON.parse(new TextDecoder().decode(prepared.preview.bytes));
    if (!isRecord(previewJson) || !isRecord(previewJson.subject)) throw new Error("preview envelope is malformed");
    expect(canonicalJsonText(toJsonValue(previewJson.subject.candidate))).toBe(
      canonicalJsonText(toJsonValue(harness.candidate)),
    );
    expect(previewJson.subject.derivation).toBeNull();
    const run = await harness.advisoryBundle.runAdvisoryReview({ plan: prepared.plan, authorization: null });
    expect(run.status).toBe("completed");
    expect(run.persistence).toBe("committed");
    expect(run.callbackInvoked).toBe(true);
    expect(run.turnId).toMatch(/^semantic-workflow-turn-[0-9a-f]{64}$/);
    expect(harness.advisoryProviderState.calls.length).toBe(1);
    const assessment = run.assessment;
    if (assessment === undefined) throw new Error("completed advisory run omitted its assessment view");
    expect(assessment.qualification).toBe("advisory_uncalibrated");
    expect(assessment.candidateId).toBe(harness.candidate.id);
    expect(assessment.candidateDigest).toBe(harness.candidate.contentDigest);
    expect(assessment.advisoryRecommendation).toBe("revise");
    expect(assessment.reviewer.calibration).toEqual({
      status: "unverified",
      calibrationId: null,
      calibrationDigest: null,
    });
    expect(assessment.reviewer.principal).toEqual(harness.reviewer.ref);
    expect(assessment.admission).toEqual({ status: "not_subject", reason: "manual" });
    // Finding statements are tenant-key digested with exact byte lengths; the
    // prose never persists.
    expect(assessment.findings).toEqual([
      {
        code: "advisory.hypothesis_untested",
        severity: "warning",
        statementKeyedDigest: workflowKeyedDigest(new TextEncoder().encode(STATEMENT)),
        statementByteLength: new TextEncoder().encode(STATEMENT).byteLength,
      },
    ]);
  });

  it("never persists provider statement prose, creates no Candidate/Review record, and leaves governance unchanged", async () => {
    const store = createInMemoryStore();
    const harness = await createAdvisoryHarness({ store });
    const candidatesBefore = await dumpStore(store, "learning", "candidate");
    const reviewsBefore = await dumpStore(store, "learning", "review");
    const viewBefore = await harness.learning.getCandidateView({ candidateId: harness.candidate.id });
    const prepared = preparedOrThrow(await harness.advisoryBundle.prepareAdvisoryReview(harness.advisoryPrepareInput));
    const run = await harness.advisoryBundle.runAdvisoryReview({ plan: prepared.plan, authorization: null });
    expect(run.status).toBe("completed");
    const candidatesAfter = await dumpStore(store, "learning", "candidate");
    const reviewsAfter = await dumpStore(store, "learning", "review");
    expect(candidatesAfter).toEqual(candidatesBefore);
    expect(reviewsAfter).toEqual(reviewsBefore);
    const viewAfter = await harness.learning.getCandidateView({ candidateId: harness.candidate.id });
    expect(canonicalJsonText(toJsonValue(viewAfter?.governance))).toBe(
      canonicalJsonText(toJsonValue(viewBefore?.governance)),
    );
    // Privacy canary: the exact statement prose is absent from every stored
    // byte in every namespace the store holds.
    for (const kind of [
      "semantic-workflow-reservation",
      "semantic-workflow-result",
      "semantic-workflow-advisory-plan",
      "semantic-workflow-advisory-completion",
      "semantic-workflow-advisory-assessment",
    ]) {
      for (const record of await dumpStore(store, "learning", kind)) {
        expect(JSON.stringify(record)).not.toContain("ADVISORY-STATEMENT-CANARY");
      }
    }
  });

  it("reads the committed advisory turn through definition-local get and query only", async () => {
    const store = createInMemoryStore();
    const harness = await createAdvisoryHarness({ store });
    const prepared = preparedOrThrow(await harness.advisoryBundle.prepareAdvisoryReview(harness.advisoryPrepareInput));
    const run = await harness.advisoryBundle.runAdvisoryReview({ plan: prepared.plan, authorization: null });
    if (run.turnId === null) throw new Error("committed advisory run omitted its turn id");
    const turn = await harness.advisoryBundle.getTurn({ turnId: run.turnId, scope: WORKFLOW_SCOPE });
    if (turn === undefined) throw new Error("committed advisory turn is unreadable");
    expect(turn.status).toBe("completed");
    expect(turn.definition.definitionDigest).toBe(harness.advisoryDefinition.definitionDigest);
    if (turn.output.kind !== "advisory_review") throw new Error("advisory turn output has the wrong kind");
    expect(turn.output.assessment.candidateId).toBe(harness.candidate.id);
    expect(turn.output.assessment.subjectSnapshotDigest).toBe(prepared.snapshotDigest);
    const pages = [];
    for await (const page of harness.advisoryBundle.queryTurns({ scope: WORKFLOW_SCOPE, limit: 10 })) {
      pages.push(page);
    }
    expect(pages.length).toBe(1);
    expect(pages[0]?.items.map((item) => item.id)).toEqual([run.turnId]);
    // The generation bundle on the same loop and scope sees nothing: turn
    // reads are scope-and-definition private.
    expect(await harness.bundle.getTurn({ turnId: run.turnId, scope: WORKFLOW_SCOPE })).toBeUndefined();
    for await (const page of harness.bundle.queryTurns({ scope: WORKFLOW_SCOPE, limit: 10 })) {
      expect(page.items).toEqual([]);
    }
  });

  it("converges an exact re-prepared subject to the existing terminal without a second provider call", async () => {
    const harness = await createAdvisoryHarness();
    const first = preparedOrThrow(await harness.advisoryBundle.prepareAdvisoryReview(harness.advisoryPrepareInput));
    const committed = await harness.advisoryBundle.runAdvisoryReview({ plan: first.plan, authorization: null });
    expect(committed.persistence).toBe("committed");
    const second = preparedOrThrow(await harness.advisoryBundle.prepareAdvisoryReview(harness.advisoryPrepareInput));
    expect(second.preview.minimizedBytesDigest).toBe(first.preview.minimizedBytesDigest);
    const replay = await harness.advisoryBundle.runAdvisoryReview({ plan: second.plan, authorization: null });
    expect(replay.status).toBe("completed");
    expect(replay.persistence).toBe("existing");
    expect(replay.callbackInvoked).toBe(false);
    expect(replay.turnId).toBe(committed.turnId);
    expect(replay.assessment?.assessmentDigest).toBe(committed.assessment?.assessmentDigest);
    expect(harness.advisoryProviderState.calls.length).toBe(1);
  });

  it("requires outbound authorization bound to the exact plan and forbids one locally", async () => {
    const outbound = await createAdvisoryHarness({ transport: "outbound" });
    const prepared = preparedOrThrow(
      await outbound.advisoryBundle.prepareAdvisoryReview(outbound.advisoryPrepareInput),
    );
    await expect(
      outbound.advisoryBundle.runAdvisoryReview({ plan: prepared.plan, authorization: null }),
    ).rejects.toMatchObject({ code: "semantic.workflow_authorization_invalid" });
    expect(outbound.advisoryProviderState.calls.length).toBe(0);
    const authorized = await outbound.advisoryBundle.authorizeAdvisoryReview({
      plan: prepared.plan,
      evidence: { ticket: "advisory-disclosure-approval" },
    });
    expect(outbound.advisoryAuthorityState.calls.length).toBe(1);
    const preview = outbound.advisoryAuthorityState.calls[0];
    expect(workflowKeyedDigest(providerRequestBytes({ request: (preview as { preview: unknown }).preview }))).toBe(
      prepared.preview.minimizedBytesDigest,
    );
    const run = await outbound.advisoryBundle.runAdvisoryReview({
      plan: prepared.plan,
      authorization: authorized.authorization,
    });
    expect(run.status).toBe("completed");
    const providerInput = outbound.advisoryProviderState.calls[0];
    expect(providerSignal(providerInput).aborted).toBe(false);
    expect(workflowKeyedDigest(providerRequestBytes(providerInput))).toBe(prepared.preview.minimizedBytesDigest);

    const local = await createAdvisoryHarness();
    const localPrepared = preparedOrThrow(await local.advisoryBundle.prepareAdvisoryReview(local.advisoryPrepareInput));
    await expect(
      local.advisoryBundle.authorizeAdvisoryReview({ plan: localPrepared.plan, evidence: null }),
    ).rejects.toMatchObject({ code: "semantic.workflow_disclosure_forbidden" });
  });

  it("classifies refused, failed, invalid, and over-limit provider results with exact closed reasons", async () => {
    const cases: readonly {
      readonly name: string;
      readonly script: (input: unknown) => Promise<unknown>;
      readonly status: string;
    }[] = [
      { name: "refused", script: (input) => Promise.resolve(refusedAdvisoryResult(input)), status: "provider_refused" },
      { name: "failed", script: (input) => Promise.resolve(failedAdvisoryResult(input)), status: "provider_failed" },
      {
        name: "unknown recommendation",
        script: (input) => {
          const positive = positiveAdvisoryResult(input);
          if (!isRecord(positive) || !isRecord(positive.result)) throw new Error("fixture malformed");
          return Promise.resolve({
            ...positive,
            result: { ...positive.result, advisoryRecommendation: "approve" },
          });
        },
        status: "result_invalid",
      },
      {
        name: "support with blocking finding",
        script: (input) => {
          const positive = positiveAdvisoryResult(input);
          if (!isRecord(positive) || !isRecord(positive.result)) throw new Error("fixture malformed");
          return Promise.resolve({
            ...positive,
            result: {
              advisoryRecommendation: "support",
              findings: [{ code: "advisory.blocking", severity: "blocking", statement: "contradiction" }],
            },
          });
        },
        status: "result_invalid",
      },
      {
        name: "finding flood",
        script: (input) => {
          const positive = positiveAdvisoryResult(input);
          if (!isRecord(positive) || !isRecord(positive.result)) throw new Error("fixture malformed");
          return Promise.resolve({
            ...positive,
            result: {
              advisoryRecommendation: "revise",
              findings: Array.from({ length: 101 }, (_unused, index) => ({
                code: `advisory.f${index}`,
                severity: "info",
                statement: `finding ${index}`,
              })),
            },
          });
        },
        status: "result_invalid",
      },
      {
        name: "provider prose is not a schema",
        script: () => Promise.resolve("I refuse to answer."),
        status: "result_invalid",
      },
    ];
    for (const testCase of cases) {
      const harness = await createAdvisoryHarness();
      harness.advisoryProviderState.script = testCase.script;
      const prepared = preparedOrThrow(
        await harness.advisoryBundle.prepareAdvisoryReview(harness.advisoryPrepareInput),
      );
      const run = await harness.advisoryBundle.runAdvisoryReview({ plan: prepared.plan, authorization: null });
      expect({ name: testCase.name, status: run.status }).toEqual({ name: testCase.name, status: testCase.status });
      expect(run.persistence).toBe("committed");
      expect(run.assessment).toBeUndefined();
      if (run.turnId === null) throw new Error("noncompleted advisory run omitted its turn id");
      const turn = await harness.advisoryBundle.getTurn({ turnId: run.turnId, scope: WORKFLOW_SCOPE });
      expect(turn?.output).toEqual({ kind: "none", reasonCode: `workflow.${testCase.status}` });
    }
  });

  it("classifies reported usage over every registered ceiling as result_limit", async () => {
    const harness = await createAdvisoryHarness({ maximumOutputTokens: 10 });
    harness.advisoryProviderState.script = (input) => {
      const positive = positiveAdvisoryResult(input);
      if (!isRecord(positive) || !isRecord(positive.usage)) throw new Error("fixture malformed");
      return Promise.resolve({ ...positive, usage: { ...positive.usage, outputTokens: 11 } });
    };
    const prepared = preparedOrThrow(await harness.advisoryBundle.prepareAdvisoryReview(harness.advisoryPrepareInput));
    const run = await harness.advisoryBundle.runAdvisoryReview({ plan: prepared.plan, authorization: null });
    expect(run.status).toBe("result_limit");
    expect(run.persistence).toBe("committed");
  });

  it("classifies a provider throw as permanent dispatch-only ambiguity with no automatic retry", async () => {
    const harness = await createAdvisoryHarness();
    harness.advisoryProviderState.script = () => Promise.reject(new Error("provider crashed after dispatch"));
    const prepared = preparedOrThrow(await harness.advisoryBundle.prepareAdvisoryReview(harness.advisoryPrepareInput));
    const run = await harness.advisoryBundle.runAdvisoryReview({ plan: prepared.plan, authorization: null });
    expect(run).toMatchObject({ status: "outcome_unknown", persistence: "dispatch_only", callbackInvoked: true });
    expect(harness.advisoryProviderState.calls.length).toBe(1);
    harness.advisoryProviderState.script = (input) => Promise.resolve(positiveAdvisoryResult(input));
    const replayPrepared = preparedOrThrow(
      await harness.advisoryBundle.prepareAdvisoryReview(harness.advisoryPrepareInput),
    );
    const replay = await harness.advisoryBundle.runAdvisoryReview({ plan: replayPrepared.plan, authorization: null });
    expect(replay).toMatchObject({ status: "outcome_unknown", persistence: "dispatch_only", callbackInvoked: false });
    expect(harness.advisoryProviderState.calls.length).toBe(1);
    const recovered = await harness.advisoryBundle.recoverAdvisoryReview({
      attemptId: replayPrepared.attemptId,
      scope: WORKFLOW_SCOPE,
    });
    expect(recovered).toMatchObject({ status: "outcome_unknown", persistence: "dispatch_only" });
    expect(harness.advisoryProviderState.calls.length).toBe(1);
  });

  it("refuses an unknown, wrong-scope, or foreign-digest subject without probing the global candidate record", async () => {
    const trace: StoreMutationTrace = { writes: [], reads: [] };
    const base = createInMemoryStore();
    const harness = await createAdvisoryHarness({ store: recordingStore(base, trace) });
    const foreignScope = [{ type: "project", id: "another-project" }];
    trace.reads?.splice(0);
    const wrongScope = await harness.advisoryBundle.prepareAdvisoryReview({
      candidateId: harness.candidate.id,
      scope: foreignScope,
      expiresAt: harness.advisoryPrepareInput.expiresAt,
    });
    expect(wrongScope.status).toBe("incomplete");
    if (wrongScope.status !== "incomplete") throw new Error("unreachable");
    expect(wrongScope.diagnostics.map((entry) => entry.code)).toEqual(["workflow.candidate_unavailable"]);
    const globalCandidateReads = (trace.reads ?? []).filter(
      (key: RecordKey) => key.namespace === "learning" && key.kind === "candidate",
    );
    expect(globalCandidateReads).toEqual([]);
    const unknownSubject = await harness.advisoryBundle.prepareAdvisoryReview({
      candidateId: "candidate-that-never-existed",
      scope: WORKFLOW_SCOPE,
      expiresAt: harness.advisoryPrepareInput.expiresAt,
    });
    expect(unknownSubject.status).toBe("incomplete");
  });

  it("refuses a legacy schema-v1 candidate as an advisory subject", async () => {
    const store = createInMemoryStore();
    const harness = await createAdvisoryHarness({ store });
    const legacyId = "legacy-advisory-subject";
    const legacyBase = {
      id: legacyId,
      scope: WORKFLOW_SCOPE,
      problem: "legacy problem",
      hypothesis: "legacy hypothesis",
      evidenceIds: ["manual-evidence/legacy-observation"],
      intervention: {
        destinationId: "host/semantic-note",
        kind: "report-note",
        content: { text: "legacy" },
        rollbackIntent: "remove",
      },
      proposedRisk: "T1" as const,
      proposedBy: harness.proposer.ref,
      proposerAttestationDigest: harness.proposer.attestationDigest,
      proposedAt: "2026-08-19T00:00:00.000Z",
    };
    const legacy = {
      schemaVersion: 1,
      ...legacyBase,
      contentDigest: candidateContentDigest({
        scope: legacyBase.scope,
        problem: legacyBase.problem,
        hypothesis: legacyBase.hypothesis,
        evidenceIds: legacyBase.evidenceIds,
        intervention: legacyBase.intervention,
        proposedRisk: legacyBase.proposedRisk,
      }),
    };
    const legacyValue = toJsonValue(legacy);
    await store.create(
      { namespace: "learning", kind: "candidate", id: legacyId },
      legacyValue,
      sha256HexOfCanonicalJson(legacyValue),
      "seed-legacy-candidate",
    );
    const membership = buildCandidateScopeMembership({
      schemaVersion: 1,
      ...legacyBase,
      evidenceIds: legacyBase.evidenceIds,
      contentDigest: legacy.contentDigest,
    });
    const membershipValue = toJsonValue(membership);
    await store.create(
      {
        namespace: `learning-candidate-scope-${membership.scopeDigest}`,
        kind: "candidate-scope-index",
        id: legacyId,
      },
      membershipValue,
      sha256HexOfCanonicalJson(membershipValue),
      "seed-legacy-membership",
    );
    const outcome = await harness.advisoryBundle.prepareAdvisoryReview({
      candidateId: legacyId,
      scope: WORKFLOW_SCOPE,
      expiresAt: harness.advisoryPrepareInput.expiresAt,
    });
    expect(outcome.status).toBe("incomplete");
    if (outcome.status !== "incomplete") throw new Error("unreachable");
    expect(outcome.diagnostics.map((entry) => entry.code)).toEqual(["workflow.candidate_legacy_unbound"]);
  });

  it("binds a derivation-backed subject exactly and enforces reviewer/producer independence", async () => {
    const store = createInMemoryStore();
    const harness = await createAdvisoryHarness({ store });
    harness.providerState.script = (input) => {
      const positive = positiveProviderResult(input);
      if (!isRecord(positive) || !isRecord(positive.result)) throw new Error("generation fixture malformed");
      const insights = positive.result.insights;
      if (!Array.isArray(insights) || !isRecord(insights[0])) throw new Error("generation fixture malformed");
      return Promise.resolve({
        ...positive,
        result: {
          ...positive.result,
          insights: [
            {
              ...insights[0],
              impactHypothesis: { statement: "A standing note reduces rediscovery time." },
              candidateIntervention: {
                summary: "Record the recurring structural signal as a standing note.",
                proposedDestinationKind: "report-note",
                proposedDestinationId: "host/semantic-note",
                contentDraft: { text: "Standing note draft." },
                rollbackIntent: "Delete the note.",
              },
              validation: {
                method: "human-review",
                comparablePopulation: null,
                comparablePopulationDigest: null,
                successCriterion: "A human confirms the note prevents rediscovery.",
                guardrails: [],
                // The lens permits exactly its registered validation strategy.
                strategyDigest: sha256HexOfCanonicalJson(toJsonValue({ status: "advisory" })),
              },
            },
          ],
        },
      });
    };
    const generationPrepared = await harness.bundle.prepareGeneration(harness.prepareInput);
    if (generationPrepared.status !== "prepared") throw new Error("generation prepare failed");
    const generated = await harness.bundle.runGeneration({ plan: generationPrepared.plan, authorization: null });
    expect(generated.status).toBe("completed");
    const derivation = generated.derivations[0];
    if (derivation === undefined) throw new Error("generation produced no derivation");
    const derived = await proposeSubjectCandidate(harness, harness.proposer, {
      id: "advisory-derived-subject",
      derivationId: derivation.id,
    });
    expect(derived.derivationRef?.id).toBe(derivation.id);
    const prepared = preparedOrThrow(
      await harness.advisoryBundle.prepareAdvisoryReview({
        candidateId: derived.id,
        scope: WORKFLOW_SCOPE,
        expiresAt: harness.advisoryPrepareInput.expiresAt,
      }),
    );
    const run = await harness.advisoryBundle.runAdvisoryReview({ plan: prepared.plan, authorization: null });
    expect(run.status).toBe("completed");
    expect(run.assessment?.derivationRef).toEqual({
      id: derivation.id,
      derivationDigest: derivation.derivationDigest,
      scopeDigest: derivation.scopeDigest,
    });

    // A reviewer sharing the generation producer's independence domain is refused.
    const producerDomainReviewer = await harness.identity.verify({
      principalId: "advisory-reviewer-producer-domain",
      kind: "service",
      independenceDomain: "semantic-workflow-provider-domain",
    });
    const producerDomainDefinition = advisoryDefinitionFor({
      transport: "local",
      reviewer: producerDomainReviewer,
      budgets: {
        maximumRequestBytes: 1_048_576,
        maximumResponseBytes: 1_048_576,
        maximumInputTokens: 10_000,
        maximumOutputTokens: 2_000,
        maximumDurationMs: 1_000,
      },
    });
    const producerDomainBundle = createSemanticWorkflowBundle({
      ...harness.advisoryFactoryInput,
      definition: producerDomainDefinition,
      reviewer: producerDomainReviewer,
      renderer: {
        rendererDigest: producerDomainDefinition.renderer.rendererDigest,
        render: harness.advisoryFactoryInput.renderer.render,
      },
      tokenEstimator: {
        tokenEstimatorDigest: producerDomainDefinition.budgetPolicy.tokenEstimatorDigest,
        estimateInputTokens: harness.advisoryFactoryInput.tokenEstimator.estimateInputTokens,
      },
      provider: {
        registrationDigest: producerDomainDefinition.providerModel.provider.registrationDigest,
        invoke: harness.advisoryFactoryInput.provider.invoke,
      },
    });
    await expect(
      producerDomainBundle.prepareAdvisoryReview({
        candidateId: derived.id,
        scope: WORKFLOW_SCOPE,
        expiresAt: harness.advisoryPrepareInput.expiresAt,
      }),
    ).rejects.toMatchObject({ code: "semantic.workflow_reviewer_not_independent" });

    // A reviewer implementation identical to the producer implementation is refused.
    const sameImplementationDefinition = advisoryDefinitionFor({
      transport: "local",
      reviewer: harness.reviewer,
      budgets: {
        maximumRequestBytes: 1_048_576,
        maximumResponseBytes: 1_048_576,
        maximumInputTokens: 10_000,
        maximumOutputTokens: 2_000,
        maximumDurationMs: 1_000,
      },
      implementation: { id: "hermetic-semantic-workflow", version: "1.0.0" },
    });
    const sameImplementationBundle = createSemanticWorkflowBundle({
      ...harness.advisoryFactoryInput,
      definition: sameImplementationDefinition,
      renderer: {
        rendererDigest: sameImplementationDefinition.renderer.rendererDigest,
        render: harness.advisoryFactoryInput.renderer.render,
      },
      tokenEstimator: {
        tokenEstimatorDigest: sameImplementationDefinition.budgetPolicy.tokenEstimatorDigest,
        estimateInputTokens: harness.advisoryFactoryInput.tokenEstimator.estimateInputTokens,
      },
      provider: {
        registrationDigest: sameImplementationDefinition.providerModel.provider.registrationDigest,
        invoke: harness.advisoryFactoryInput.provider.invoke,
      },
    });
    await expect(
      sameImplementationBundle.prepareAdvisoryReview({
        candidateId: derived.id,
        scope: WORKFLOW_SCOPE,
        expiresAt: harness.advisoryPrepareInput.expiresAt,
      }),
    ).rejects.toMatchObject({ code: "semantic.workflow_reviewer_not_independent" });
  });

  it("refuses a reviewer that is the proposer, and risk-gated shared proposer domains", async () => {
    const sameId = await createAdvisoryHarness({ reviewerPrincipalId: "advisory-proposer" });
    await expect(sameId.advisoryBundle.prepareAdvisoryReview(sameId.advisoryPrepareInput)).rejects.toMatchObject({
      code: "semantic.workflow_reviewer_not_independent",
    });
    // T1 tolerates a shared independence domain under the conservative policy.
    const sharedDomainT1 = await createAdvisoryHarness({
      reviewerIndependenceDomain: "advisory-proposer-domain",
    });
    await expect(
      sharedDomainT1.advisoryBundle.prepareAdvisoryReview(sharedDomainT1.advisoryPrepareInput),
    ).resolves.toMatchObject({ status: "prepared" });
    // T2 requires proposer-domain separation.
    const sharedDomainT2 = await createAdvisoryHarness({
      reviewerIndependenceDomain: "advisory-proposer-domain",
      proposedRisk: "T2",
      candidateId: "advisory-subject-t2",
    });
    await expect(
      sharedDomainT2.advisoryBundle.prepareAdvisoryReview({
        ...sharedDomainT2.advisoryPrepareInput,
        candidateId: "advisory-subject-t2",
      }),
    ).rejects.toMatchObject({ code: "semantic.workflow_reviewer_not_independent" });
  });
});
