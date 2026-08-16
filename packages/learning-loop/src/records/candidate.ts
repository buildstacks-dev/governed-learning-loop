// Candidate (contract §Candidate). A candidate is inert: the kernel never
// turns model output into an entitlement. The content digest binds all
// governance-relevant fields; a revised candidate gets a new digest and can
// never silently reuse a prior review or authorization.
import { sha256HexOfCanonicalJson } from "../canonical/canonical-json.js";
import type { JsonValue } from "../canonical/json.js";
import { invalid, parseArrayOf, parseJson, parseNonEmptyText, parseOneOf, readFields } from "../parse/toolkit.js";
import type { Parse } from "../parse/toolkit.js";
import { parseScopeShapeAt } from "./episode.js";
import type { PrincipalRef } from "./principal.js";
import { parsePrincipalRefAt } from "./principal.js";
import type { Scope } from "./scope.js";

export type RiskTier = "T0" | "T1" | "T2" | "T3";

const RISK_TIERS = ["T0", "T1", "T2", "T3"] as const;
const RISK_ORDER = { T0: 0, T1: 1, T2: 2, T3: 3 } as const;

/** Monotonic risk maximum: `T0 < T1 < T2 < T3`. Effective risk only ever rises. */
export function maxRiskTier(a: RiskTier, b: RiskTier): RiskTier {
  return RISK_ORDER[a] >= RISK_ORDER[b] ? a : b;
}

export interface CandidateIntervention {
  readonly destinationId: string;
  readonly kind: string;
  readonly content: JsonValue;
  readonly rollbackIntent: string;
}

export interface Candidate {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly scope: Scope;
  readonly problem: string;
  readonly hypothesis: string;
  readonly evidenceIds: readonly string[];
  readonly intervention: CandidateIntervention;
  readonly proposedRisk: RiskTier;
  readonly proposedBy: PrincipalRef;
  readonly proposerAttestationDigest: string;
  readonly proposedAt: string;
  readonly contentDigest: string;
  readonly supersedes?: string;
}

/** The governance-relevant fields bound by the candidate content digest. */
export interface CandidateDigestInput {
  readonly scope: Scope;
  readonly problem: string;
  readonly hypothesis: string;
  readonly evidenceIds: readonly string[];
  readonly intervention: CandidateIntervention;
  readonly proposedRisk: RiskTier;
  readonly supersedes?: string;
}

/**
 * Candidate content digest: lower-case hex SHA-256 of the canonical JSON of
 * exactly the fields below (contract §Candidate field-inclusion table).
 *
 * | Field                          | In digest |
 * | ------------------------------ | --------- |
 * | scope                          | yes       |
 * | problem                        | yes       |
 * | hypothesis                     | yes       |
 * | evidenceIds                    | yes       |
 * | intervention.destinationId     | yes       |
 * | intervention.kind              | yes       |
 * | intervention.content           | yes       |
 * | intervention.rollbackIntent    | yes       |
 * | proposedRisk                   | yes       |
 * | supersedes                     | yes (omitted from the canonical form when absent) |
 * | schemaVersion                  | no        |
 * | id                             | no        |
 * | proposedBy                     | no        |
 * | proposerAttestationDigest      | no        |
 * | proposedAt                     | no        |
 * | contentDigest                  | no (it is the digest) |
 *
 * Attribution (proposedBy, attestation, proposedAt) and identity (id) are
 * recorded alongside but deliberately excluded: the digest authenticates
 * *content*, so re-proposing identical content is detectable across proposers.
 */
export function candidateContentDigest(input: CandidateDigestInput): string {
  const bound: JsonValue = {
    scope: input.scope.map((segment) => ({ type: segment.type, id: segment.id })),
    problem: input.problem,
    hypothesis: input.hypothesis,
    evidenceIds: [...input.evidenceIds],
    intervention: {
      destinationId: input.intervention.destinationId,
      kind: input.intervention.kind,
      content: input.intervention.content,
      rollbackIntent: input.intervention.rollbackIntent,
    },
    proposedRisk: input.proposedRisk,
    ...(input.supersedes !== undefined ? { supersedes: input.supersedes } : {}),
  };
  return sha256HexOfCanonicalJson(bound);
}

const parseInterventionAt: Parse<CandidateIntervention> = (input, path) => {
  const fields = readFields(input, path);
  return {
    destinationId: fields.req("destinationId", parseNonEmptyText),
    kind: fields.req("kind", parseNonEmptyText),
    content: fields.req("content", parseJson),
    rollbackIntent: fields.req("rollbackIntent", parseNonEmptyText),
  };
};

/**
 * Parses a durable candidate record. Beyond shape and schema version, the
 * stored `contentDigest` is recomputed from the bound fields; a mismatch is
 * `schema.corrupt` — an old digest never authenticates changed content.
 */
export function parseCandidate(input: unknown): Candidate {
  const fields = readFields(input, []);
  const schemaVersion = fields.schemaVersion1();
  const supersedes = fields.opt("supersedes", parseNonEmptyText);
  const candidate: Candidate = {
    schemaVersion,
    id: fields.req("id", parseNonEmptyText),
    scope: fields.req("scope", parseScopeShapeAt),
    problem: fields.req("problem", parseNonEmptyText),
    hypothesis: fields.req("hypothesis", parseNonEmptyText),
    evidenceIds: fields.req("evidenceIds", parseArrayOf(parseNonEmptyText)),
    intervention: fields.req("intervention", parseInterventionAt),
    proposedRisk: fields.req("proposedRisk", parseOneOf(RISK_TIERS)),
    proposedBy: fields.req("proposedBy", parsePrincipalRefAt),
    proposerAttestationDigest: fields.req("proposerAttestationDigest", parseNonEmptyText),
    proposedAt: fields.req("proposedAt", parseNonEmptyText),
    contentDigest: fields.req("contentDigest", parseNonEmptyText),
    ...(supersedes !== undefined ? { supersedes } : {}),
  };
  const recomputed = candidateContentDigest(candidate);
  if (recomputed !== candidate.contentDigest) {
    throw invalid(
      "schema.corrupt",
      `candidate contentDigest does not match its bound fields (stored ${candidate.contentDigest}, recomputed ${recomputed})`,
      ["contentDigest"],
    );
  }
  return candidate;
}
