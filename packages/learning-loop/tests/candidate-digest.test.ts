import { describe, expect, it } from "vitest";
import type { CandidateDigestInput } from "../src/records/candidate.js";
import { candidateContentDigest, maxRiskTier } from "../src/records/candidate.js";

const base: CandidateDigestInput = {
  scope: [
    { type: "project", id: "acme-api" },
    { type: "agent", id: "coding-agent" },
  ],
  problem: "Type errors are reported after completion.",
  hypothesis: "A preflight catches them earlier.",
  evidenceIds: ["obs-1", "obs-2"],
  intervention: {
    destinationId: "agent-instructions",
    kind: "procedure",
    content: { text: "Run the type-check first." },
    rollbackIntent: "Disable this instruction version.",
  },
  proposedRisk: "T1",
  supersedes: "cand-0",
};

// Every governance-relevant (bound) field must change the digest.
const boundMutations: readonly { name: string; mutate: CandidateDigestInput }[] = [
  { name: "scope", mutate: { ...base, scope: [{ type: "project", id: "other" }] } },
  { name: "scope segment order", mutate: { ...base, scope: [...base.scope].reverse() } },
  { name: "problem", mutate: { ...base, problem: "Different problem." } },
  { name: "hypothesis", mutate: { ...base, hypothesis: "Different hypothesis." } },
  { name: "evidenceIds", mutate: { ...base, evidenceIds: ["obs-1"] } },
  {
    name: "intervention.destinationId",
    mutate: { ...base, intervention: { ...base.intervention, destinationId: "other-destination" } },
  },
  { name: "intervention.kind", mutate: { ...base, intervention: { ...base.intervention, kind: "behavior" } } },
  {
    name: "intervention.content",
    mutate: { ...base, intervention: { ...base.intervention, content: { text: "Something else." } } },
  },
  {
    name: "intervention.rollbackIntent",
    mutate: { ...base, intervention: { ...base.intervention, rollbackIntent: "Revert the file." } },
  },
  { name: "proposedRisk", mutate: { ...base, proposedRisk: "T2" } },
  { name: "supersedes", mutate: { ...base, supersedes: "cand-9" } },
];

describe("candidateContentDigest inclusion table", () => {
  const baseline = candidateContentDigest(base);

  it("is deterministic and 64 lower-case hex characters", () => {
    expect(baseline).toMatch(/^[0-9a-f]{64}$/);
    expect(candidateContentDigest({ ...base })).toBe(baseline);
  });

  for (const { name, mutate } of boundMutations) {
    it(`changes when bound field ${name} changes`, () => {
      expect(candidateContentDigest(mutate)).not.toBe(baseline);
    });
  }

  it("distinguishes an absent supersedes from a present one", () => {
    const withoutSupersedes: CandidateDigestInput = {
      scope: base.scope,
      problem: base.problem,
      hypothesis: base.hypothesis,
      evidenceIds: base.evidenceIds,
      intervention: base.intervention,
      proposedRisk: base.proposedRisk,
    };
    expect(candidateContentDigest(withoutSupersedes)).not.toBe(baseline);
  });

  it("ignores excluded fields: id, proposedBy, proposerAttestationDigest, proposedAt, contentDigest", () => {
    // Simulates a full Candidate record: extra attribution fields must not
    // enter the digest, so identical content from a different proposer at a
    // different time digests identically.
    const attributed = {
      ...base,
      schemaVersion: 1,
      id: "cand-42",
      proposedBy: { id: "distiller-z", kind: "agent", independenceDomain: "provider-z" },
      proposerAttestationDigest: "attest-other",
      proposedAt: "2027-01-01T00:00:00.000Z",
      contentDigest: "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    };
    expect(candidateContentDigest(attributed)).toBe(baseline);
  });
});

describe("maxRiskTier", () => {
  it("orders T0 < T1 < T2 < T3 and is commutative", () => {
    expect(maxRiskTier("T0", "T1")).toBe("T1");
    expect(maxRiskTier("T1", "T0")).toBe("T1");
    expect(maxRiskTier("T2", "T3")).toBe("T3");
    expect(maxRiskTier("T3", "T2")).toBe("T3");
    expect(maxRiskTier("T1", "T1")).toBe("T1");
    expect(maxRiskTier("T0", "T3")).toBe("T3");
  });
});
