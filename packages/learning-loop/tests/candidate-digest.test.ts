import { describe, expect, it } from "vitest";
import type { CandidateDigestInput } from "../src/records/candidate.js";
import { candidateContentDigest, candidateScopeDigest, maxRiskTier } from "../src/records/candidate.js";
import type { EvidenceRef } from "../src/records/evidence-ref.js";
import { evidenceRefDigest } from "../src/records/evidence-ref.js";

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

  it("keeps the ratified schema-v1 golden vector byte-stable", () => {
    expect(baseline).toBe("55dca894f0acbc890aaf67736a7c6cfd1a8a20fb1c5e23e8967b121bd66bdaf4");
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

const evidenceABound: Omit<EvidenceRef, "schemaVersion" | "referenceDigest"> = {
  kind: "observation",
  recordId: "source-a/observation-a",
  recordDigest: "1".repeat(64),
  sourceId: "source-a",
  sourceRegistrationRevision: "2".repeat(64),
  sourceRef: "artifact-a",
  sourceRevision: "revision-a",
  sourceRecordId: "observation-a",
  pageRef: "evidence-page-a",
  pageReceiptId: `source-page-${"3".repeat(64)}`,
  pageReceiptDigest: "3".repeat(64),
  loopRegistryRevision: "4".repeat(64),
  trust: "observed",
  completeness: "complete",
  episode: {
    sourceId: "source-a",
    episodeId: "episode-a",
    episodeRecordId: "source-a/episode-record-a",
    episodeRecordDigest: "5".repeat(64),
    episodeIdentityDigest: "6".repeat(64),
    scopeDigest: candidateScopeDigest(base.scope),
    pageReceiptId: `source-page-${"7".repeat(64)}`,
    pageReceiptDigest: "7".repeat(64),
  },
};

const evidenceA: EvidenceRef = {
  schemaVersion: 1,
  ...evidenceABound,
  referenceDigest: evidenceRefDigest(evidenceABound),
};

const evidenceBBound: Omit<EvidenceRef, "schemaVersion" | "referenceDigest"> = {
  ...evidenceABound,
  recordId: "source-a/observation-b",
  recordDigest: "8".repeat(64),
  sourceRecordId: "observation-b",
  pageRef: "evidence-page-b",
  pageReceiptId: `source-page-${"9".repeat(64)}`,
  pageReceiptDigest: "9".repeat(64),
};

const evidenceB: EvidenceRef = {
  schemaVersion: 1,
  ...evidenceBBound,
  referenceDigest: evidenceRefDigest(evidenceBBound),
};

const v2Base: CandidateDigestInput = {
  schemaVersion: 2,
  scope: base.scope,
  problem: base.problem,
  hypothesis: base.hypothesis,
  evidenceRefs: [evidenceA, evidenceB],
  derivationRef: { id: "derivation-a", digest: "a".repeat(64) },
  intervention: base.intervention,
  proposedRisk: base.proposedRisk,
  supersedes: "candidate-predecessor",
  originalDigest: "b".repeat(64),
};

const changedEvidenceBound = { ...evidenceABound, recordDigest: "c".repeat(64) };
const changedEvidence: EvidenceRef = {
  schemaVersion: 1,
  ...changedEvidenceBound,
  referenceDigest: evidenceRefDigest(changedEvidenceBound),
};

const evidenceRefBoundMutations: readonly {
  readonly name: string;
  readonly mutate: Omit<EvidenceRef, "schemaVersion" | "referenceDigest">;
}[] = [
  { name: "kind", mutate: { ...evidenceABound, kind: "measurement" } },
  { name: "recordId", mutate: { ...evidenceABound, recordId: "source-a/other-record" } },
  { name: "recordDigest", mutate: { ...evidenceABound, recordDigest: "c".repeat(64) } },
  { name: "sourceId", mutate: { ...evidenceABound, sourceId: "source-b" } },
  {
    name: "sourceRegistrationRevision",
    mutate: { ...evidenceABound, sourceRegistrationRevision: "d".repeat(64) },
  },
  { name: "sourceRef", mutate: { ...evidenceABound, sourceRef: "artifact-b" } },
  { name: "sourceRevision", mutate: { ...evidenceABound, sourceRevision: "revision-b" } },
  { name: "sourceRecordId", mutate: { ...evidenceABound, sourceRecordId: "other-record" } },
  { name: "pageRef", mutate: { ...evidenceABound, pageRef: "other-page" } },
  {
    name: "pageReceiptId",
    mutate: { ...evidenceABound, pageReceiptId: `source-page-${"e".repeat(64)}` },
  },
  { name: "pageReceiptDigest", mutate: { ...evidenceABound, pageReceiptDigest: "e".repeat(64) } },
  { name: "loopRegistryRevision", mutate: { ...evidenceABound, loopRegistryRevision: "f".repeat(64) } },
  { name: "trust", mutate: { ...evidenceABound, trust: "advisory" } },
  { name: "completeness", mutate: { ...evidenceABound, completeness: "partial" } },
  {
    name: "episode.sourceId",
    mutate: { ...evidenceABound, episode: { ...evidenceABound.episode, sourceId: "source-b" } },
  },
  {
    name: "episode.episodeId",
    mutate: { ...evidenceABound, episode: { ...evidenceABound.episode, episodeId: "episode-b" } },
  },
  {
    name: "episode.episodeRecordId",
    mutate: { ...evidenceABound, episode: { ...evidenceABound.episode, episodeRecordId: "source-a/episode-b" } },
  },
  {
    name: "episode.episodeRecordDigest",
    mutate: { ...evidenceABound, episode: { ...evidenceABound.episode, episodeRecordDigest: "0".repeat(64) } },
  },
  {
    name: "episode.episodeIdentityDigest",
    mutate: { ...evidenceABound, episode: { ...evidenceABound.episode, episodeIdentityDigest: "1".repeat(64) } },
  },
  {
    name: "episode.scopeDigest",
    mutate: { ...evidenceABound, episode: { ...evidenceABound.episode, scopeDigest: "2".repeat(64) } },
  },
  {
    name: "episode.pageReceiptId",
    mutate: {
      ...evidenceABound,
      episode: { ...evidenceABound.episode, pageReceiptId: `source-page-${"3".repeat(64)}` },
    },
  },
  {
    name: "episode.pageReceiptDigest",
    mutate: { ...evidenceABound, episode: { ...evidenceABound.episode, pageReceiptDigest: "3".repeat(64) } },
  },
];

const v2BoundMutations: readonly { readonly name: string; readonly mutate: CandidateDigestInput }[] = [
  { name: "scope", mutate: { ...v2Base, scope: [{ type: "project", id: "other" }] } },
  { name: "problem", mutate: { ...v2Base, problem: "Different v2 problem." } },
  { name: "hypothesis", mutate: { ...v2Base, hypothesis: "Different v2 hypothesis." } },
  { name: "EvidenceRef content", mutate: { ...v2Base, evidenceRefs: [changedEvidence, evidenceB] } },
  { name: "EvidenceRef order", mutate: { ...v2Base, evidenceRefs: [evidenceB, evidenceA] } },
  {
    name: "derivation id",
    mutate: { ...v2Base, derivationRef: { id: "other", digest: "a".repeat(64) } },
  },
  { name: "derivation digest", mutate: { ...v2Base, derivationRef: { id: "derivation-a", digest: "d".repeat(64) } } },
  {
    name: "intervention",
    mutate: { ...v2Base, intervention: { ...v2Base.intervention, content: { text: "Different v2 content." } } },
  },
  { name: "risk", mutate: { ...v2Base, proposedRisk: "T2" } },
  { name: "supersedes", mutate: { ...v2Base, supersedes: "other-predecessor" } },
  { name: "originalDigest", mutate: { ...v2Base, originalDigest: "e".repeat(64) } },
];

describe("EvidenceRef and Candidate-v2 digest inclusion", () => {
  const baseline = candidateContentDigest(v2Base);

  it("pins canonical EvidenceRef and Candidate-v2 golden vectors", () => {
    expect(evidenceA.referenceDigest).toBe("1d2d3f28b1b70abfcfbd06171bd0426153a1a1da2782e33ea19b0ce059f0ce06");
    expect(baseline).toBe("d85f10ed16516415c3e60e064c81d66f2b87cd8efed10017991450a69963190b");
  });

  it("is deterministic, domain-separated, and sensitive to evidence order", () => {
    expect(baseline).toMatch(/^[0-9a-f]{64}$/);
    expect(candidateContentDigest({ ...v2Base })).toBe(baseline);
    expect(baseline).not.toBe(candidateContentDigest(base));
    expect(candidateContentDigest({ ...v2Base, evidenceRefs: [evidenceB, evidenceA] })).not.toBe(baseline);
  });

  for (const { name, mutate } of evidenceRefBoundMutations) {
    it(`changes the EvidenceRef digest when bound field ${name} changes`, () => {
      expect(evidenceRefDigest(mutate)).not.toBe(evidenceA.referenceDigest);
    });
  }

  it("excludes only the EvidenceRef schema marker and digest itself", () => {
    const attributed = {
      ...evidenceABound,
      schemaVersion: 99,
      referenceDigest: "0".repeat(64),
    };
    expect(evidenceRefDigest(attributed)).toBe(evidenceA.referenceDigest);
  });

  for (const { name, mutate } of v2BoundMutations) {
    it(`changes when bound v2 field ${name} changes`, () => {
      expect(candidateContentDigest(mutate)).not.toBe(baseline);
    });
  }

  it("distinguishes absent derivation and supersession lineage", () => {
    const withoutLineage: CandidateDigestInput = {
      schemaVersion: 2,
      scope: v2Base.scope,
      problem: v2Base.problem,
      hypothesis: v2Base.hypothesis,
      evidenceRefs: v2Base.evidenceRefs,
      intervention: v2Base.intervention,
      proposedRisk: v2Base.proposedRisk,
    };
    expect(candidateContentDigest(withoutLineage)).not.toBe(baseline);
  });

  it("ignores v2 identity, attribution, proposal time, and the digest field itself", () => {
    const attributed = {
      ...v2Base,
      id: "candidate-v2",
      proposedBy: { id: "other", kind: "agent", independenceDomain: "other-domain" },
      proposerAttestationDigest: "f".repeat(64),
      proposedAt: "2027-01-01T00:00:00.000Z",
      contentDigest: "0".repeat(64),
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
