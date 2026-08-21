// Decision 0025 semantic closure: a derivation-backed Candidate's plan binds
// the exact derivation with its detector, lens, and pack references, so an
// approval cannot survive a change anywhere in that lineage.
import { describe, expect, it } from "vitest";
import type { CandidateInput, CandidateReviewer, DestinationRegistration, VerifiedPrincipal } from "../src/index.js";
import { persistDetectorExecution } from "../src/engine/semantic-persistence.js";
import { authorizationBindingForPlan, publicationLineageClosureDigest } from "../src/records/publication.js";
import {
  SEMANTIC_CONTENT_POLICY_ID,
  createSemanticEngineHarness,
  createSemanticFacts,
} from "./semantic-engine-harness.js";
import { effectFor, inertDestination, scriptedAuthority } from "./publication-harness.js";

const SEMANTIC_DESTINATION_ID = "host/semantic-note";

function reviewerFor(principal: VerifiedPrincipal): CandidateReviewer {
  return {
    id: "lineage-reviewer-workflow",
    version: "1.0.0",
    principal,
    review: (input) =>
      Promise.resolve({
        candidateId: input.candidate.id,
        candidateDigest: input.candidate.contentDigest,
        disposition: "accept",
        findings: [],
      }),
  };
}

describe("derivation-backed publication lineage", () => {
  it("binds the exact derivation, detector, lens, and pack into the plan lineage and closure digest", async () => {
    const destination = inertDestination({
      id: SEMANTIC_DESTINATION_ID,
      prepare: (input) => [effectFor(input.candidate, { target: "notes/semantic-note.md" })],
    });
    const registration: DestinationRegistration = {
      adapter: destination.adapter,
      effectClass: "proposal",
      riskFloor: "T1",
      permittedTargetPatterns: ["notes/*"],
      authorizationRuleId: "host-approval-v1",
      contentPolicyId: SEMANTIC_CONTENT_POLICY_ID,
    };
    const authority = scriptedAuthority();
    const harness = await createSemanticEngineHarness({ destinations: [registration], authority: authority.port });
    const facts = createSemanticFacts(harness);
    await persistDetectorExecution(harness.context, facts.execution, [facts.derivation]);
    const proposer = await harness.context.identity.verify({
      principalId: "lineage-proposer",
      kind: "agent",
      independenceDomain: "lineage-proposer-domain",
    });
    const reviewer = await harness.context.identity.verify({
      principalId: "lineage-reviewer",
      kind: "human",
      independenceDomain: "lineage-reviewer-domain",
    });
    const input: CandidateInput = {
      id: "derived-candidate",
      scope: facts.derivation.scope,
      derivationId: facts.derivation.id,
      proposedRisk: "T1",
      proposedBy: proposer,
    };
    const { candidate } = await harness.learning.propose(input);
    expect(candidate.intervention.destinationId).toBe(SEMANTIC_DESTINATION_ID);
    await harness.learning.reviewCandidate({
      id: "lineage-review",
      candidateId: candidate.id,
      reviewer: reviewerFor(reviewer),
    });

    const prepared = await harness.learning.preparePublication({
      candidateId: candidate.id,
      destinationId: SEMANTIC_DESTINATION_ID,
    });
    const { plan } = prepared;
    expect(plan.effectClass).toBe("proposal");
    expect(plan.lineage.scopeDigest).toBe(facts.derivation.scopeDigest);
    expect(plan.lineage.scopePolicyDigest).toBe(facts.derivation.scopePolicyDigest);
    expect(plan.lineage.derivation).toEqual({
      id: facts.derivation.id,
      digest: facts.derivation.derivationDigest,
      detector: {
        id: facts.derivation.detector.id,
        version: facts.derivation.detector.version,
        registrationDigest: facts.derivation.detector.registrationDigest,
      },
      lens: {
        id: facts.derivation.lens.id,
        version: facts.derivation.lens.version,
        registrationDigest: facts.derivation.lens.registrationDigest,
      },
      pack: facts.derivation.pack,
    });
    expect(plan.lineage.derivation?.pack).not.toBeNull();
    expect(candidate.derivationRef).toEqual({
      id: plan.lineage.derivation?.id,
      digest: plan.lineage.derivation?.digest,
    });
    expect(prepared.authorizationBinding).toEqual(authorizationBindingForPlan(plan));
    expect(prepared.authorizationBinding.lineageClosureDigest).toBe(
      publicationLineageClosureDigest(candidate.contentDigest, plan.lineage),
    );
    expect(prepared.authorizationBinding.lineageClosureDigest).not.toBe(
      publicationLineageClosureDigest(candidate.contentDigest, { ...plan.lineage, derivation: null }),
    );

    const snapshot = JSON.stringify(
      (await harness.store.list({ namespace: "learning", limit: 10_000 })).records.map((record) => [
        record.key.kind,
        record.key.id,
        record.digest,
      ]),
    );
    // The semantic harness clock is 2026-08-20; the approval must outlive it.
    const outcome = await harness.learning.publish({
      planId: plan.id,
      authorizationEvidence: { decision: "authorized", expiresAt: "2026-08-21T00:00:00.000Z" },
    });
    // The authorized branch now runs the journaled publisher (decision 0026):
    // a proposal-class destination publishes an inert, inactive intervention.
    expect(outcome.status).toBe("published");
    if (outcome.status !== "published") throw new Error("expected a published outcome");
    expect(outcome.intervention.state).toEqual({
      publication: "published",
      authorization: "authorized",
      activation: "inactive",
      validation: "untested",
    });
    expect(destination.calls.applyEffect).toBe(1);
    expect(
      JSON.stringify(
        (await harness.store.list({ namespace: "learning", limit: 10_000 })).records.map((record) => [
          record.key.kind,
          record.key.id,
          record.digest,
        ]),
      ),
    ).not.toBe(snapshot);
    expect(authority.calls).toHaveLength(1);
  });
});
