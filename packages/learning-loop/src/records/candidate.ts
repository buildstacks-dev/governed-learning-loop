// Candidate (contract §Candidate). A candidate is inert: the kernel never
// turns model output into an entitlement. Schema v1 remains byte-for-byte
// digest compatible but carries legacy unbound evidence ids. Schema v2 binds
// exact receipt-backed EvidenceRefs and explicit revision lineage.
import { sha256HexOfCanonicalJson } from "../canonical/canonical-json.js";
import type { JsonValue } from "../canonical/json.js";
import { toJsonValue } from "../canonical/to-json-value.js";
import { invalid, parseArrayOf, parseJson, parseNonEmptyText, parseOneOf, readFields } from "../parse/toolkit.js";
import type { Parse } from "../parse/toolkit.js";
import type { EvidenceRef } from "./evidence-ref.js";
import { parseEvidenceRefAt } from "./evidence-ref.js";
import { parseScopeShapeAt } from "./episode.js";
import type { PrincipalRef } from "./principal.js";
import { parsePrincipalRefAt } from "./principal.js";
import type { Scope } from "./scope.js";

export type RiskTier = "T0" | "T1" | "T2" | "T3";

const RISK_TIERS = ["T0", "T1", "T2", "T3"] as const;
const RISK_ORDER = { T0: 0, T1: 1, T2: 2, T3: 3 } as const;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const MAX_DURABLE_ID_LENGTH = 4_096;

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

interface CandidateCommon {
  readonly id: string;
  readonly scope: Scope;
  readonly problem: string;
  readonly hypothesis: string;
  readonly intervention: CandidateIntervention;
  readonly proposedRisk: RiskTier;
  readonly proposedBy: PrincipalRef;
  readonly proposerAttestationDigest: string;
  readonly proposedAt: string;
  readonly contentDigest: string;
}

/** Legacy candidate: evidenceIds are unbound and therefore audit-only. */
export interface CandidateV1 extends CandidateCommon {
  readonly schemaVersion: 1;
  readonly evidenceIds: readonly string[];
  readonly supersedes?: string;
}

interface CandidateV2Base extends CandidateCommon {
  readonly schemaVersion: 2;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly derivationRef?: {
    readonly id: string;
    readonly digest: string;
  };
}

/** Receipt-bound candidate; revisions bind the exact candidate they supersede. */
export type CandidateV2 = CandidateV2Base &
  (
    | {
        readonly supersedes?: never;
        readonly originalDigest?: never;
      }
    | {
        readonly supersedes: string;
        readonly originalDigest: string;
      }
  );

export type Candidate = CandidateV1 | CandidateV2;

interface CandidateV1DigestInput {
  readonly scope: Scope;
  readonly problem: string;
  readonly hypothesis: string;
  readonly evidenceIds: readonly string[];
  readonly intervention: CandidateIntervention;
  readonly proposedRisk: RiskTier;
  readonly supersedes?: string;
}

interface CandidateV2DigestBase {
  readonly schemaVersion: 2;
  readonly scope: Scope;
  readonly problem: string;
  readonly hypothesis: string;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly intervention: CandidateIntervention;
  readonly proposedRisk: RiskTier;
  readonly derivationRef?: {
    readonly id: string;
    readonly digest: string;
  };
}

type CandidateV2DigestInput = CandidateV2DigestBase &
  (
    | {
        readonly supersedes?: never;
        readonly originalDigest?: never;
      }
    | {
        readonly supersedes: string;
        readonly originalDigest: string;
      }
  );

/** V1 keeps its historical shape; V2 requires an explicit schema discriminant. */
export type CandidateDigestInput = CandidateV1DigestInput | CandidateV2DigestInput;

function boundIntervention(intervention: CandidateIntervention): JsonValue {
  return {
    destinationId: intervention.destinationId,
    kind: intervention.kind,
    content: intervention.content,
    rollbackIntent: intervention.rollbackIntent,
  };
}

function isCandidateV2DigestInput(input: CandidateDigestInput): input is CandidateV2DigestInput {
  return "schemaVersion" in input && input.schemaVersion === 2;
}

/** Canonical scope digest used by EvidenceRef episode ownership. */
export function candidateScopeDigest(scope: Scope): string {
  return sha256HexOfCanonicalJson(scope.map((segment) => ({ type: segment.type, id: segment.id })));
}

/**
 * Candidate content digest. The V1 branch is intentionally unchanged. V2 is
 * domain-separated by schemaVersion and binds full ordered EvidenceRefs,
 * optional derivation lineage, and exact supersession lineage.
 */
export function candidateContentDigest(input: CandidateDigestInput): string {
  if (!isCandidateV2DigestInput(input)) {
    const bound: JsonValue = {
      scope: input.scope.map((segment) => ({ type: segment.type, id: segment.id })),
      problem: input.problem,
      hypothesis: input.hypothesis,
      evidenceIds: [...input.evidenceIds],
      intervention: boundIntervention(input.intervention),
      proposedRisk: input.proposedRisk,
      ...(input.supersedes !== undefined ? { supersedes: input.supersedes } : {}),
    };
    return sha256HexOfCanonicalJson(bound);
  }

  const bound: JsonValue = {
    schemaVersion: 2,
    scope: input.scope.map((segment) => ({ type: segment.type, id: segment.id })),
    problem: input.problem,
    hypothesis: input.hypothesis,
    evidenceRefs: input.evidenceRefs.map((reference, index) =>
      toJsonValue(parseEvidenceRefAt(reference, ["evidenceRefs", index])),
    ),
    intervention: boundIntervention(input.intervention),
    proposedRisk: input.proposedRisk,
    ...(input.derivationRef !== undefined
      ? { derivationRef: { id: input.derivationRef.id, digest: input.derivationRef.digest } }
      : {}),
    ...(input.supersedes !== undefined ? { supersedes: input.supersedes, originalDigest: input.originalDigest } : {}),
  };
  return sha256HexOfCanonicalJson(bound);
}

const parseDigestAt: Parse<string> = (input, path) => {
  const digest = parseNonEmptyText(input, path);
  if (!DIGEST_PATTERN.test(digest)) {
    throw invalid("schema.invalid", "expected a lowercase SHA-256 digest", path);
  }
  return digest;
};

const parseDurableIdAt: Parse<string> = (input, path) => {
  const id = parseNonEmptyText(input, path);
  if (id.length > MAX_DURABLE_ID_LENGTH) {
    throw invalid("schema.invalid", `durable id exceeds ${MAX_DURABLE_ID_LENGTH} characters`, path);
  }
  for (const character of id) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) {
      throw invalid("schema.invalid", "durable id contains a control character", path);
    }
  }
  return id;
};

const parseInterventionAt: Parse<CandidateIntervention> = (input, path) => {
  const fields = readFields(input, path);
  return {
    destinationId: fields.req("destinationId", parseNonEmptyText),
    kind: fields.req("kind", parseNonEmptyText),
    content: fields.req("content", parseJson),
    rollbackIntent: fields.req("rollbackIntent", parseNonEmptyText),
  };
};

const parseDerivationRefAt: Parse<NonNullable<CandidateV2["derivationRef"]>> = (input, path) => {
  const fields = readFields(input, path);
  return {
    id: fields.req("id", parseDurableIdAt),
    digest: fields.req("digest", parseDigestAt),
  };
};

const parseCandidateSchemaVersionAt: Parse<1 | 2> = (input, path) => {
  if (input !== 1 && input !== 2) {
    throw invalid("schema.unsupported_version", "candidate schemaVersion must be 1 or 2", path);
  }
  return input;
};

function commonFields(fields: ReturnType<typeof readFields>): CandidateCommon {
  return {
    id: fields.req("id", parseNonEmptyText),
    scope: fields.req("scope", parseScopeShapeAt),
    problem: fields.req("problem", parseNonEmptyText),
    hypothesis: fields.req("hypothesis", parseNonEmptyText),
    intervention: fields.req("intervention", parseInterventionAt),
    proposedRisk: fields.req("proposedRisk", parseOneOf(RISK_TIERS)),
    proposedBy: fields.req("proposedBy", parsePrincipalRefAt),
    proposerAttestationDigest: fields.req("proposerAttestationDigest", parseNonEmptyText),
    proposedAt: fields.req("proposedAt", parseNonEmptyText),
    contentDigest: fields.req("contentDigest", parseNonEmptyText),
  };
}

function parseCandidateV1(fields: ReturnType<typeof readFields>): CandidateV1 {
  const supersedes = fields.opt("supersedes", parseNonEmptyText);
  const candidate: CandidateV1 = {
    schemaVersion: 1,
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

function parseCandidateV2(fields: ReturnType<typeof readFields>): CandidateV2 {
  const common = commonFields(fields);
  const evidenceRefs = fields.req("evidenceRefs", parseArrayOf(parseEvidenceRefAt));
  if (evidenceRefs.length === 0) {
    throw invalid("schema.invalid", "Candidate v2 requires at least one evidence reference", ["evidenceRefs"]);
  }
  const referenceDigests = new Set<string>();
  const recordKeys = new Set<string>();
  for (const [index, reference] of evidenceRefs.entries()) {
    const recordKey = `${reference.kind}\u0000${reference.recordId}`;
    if (referenceDigests.has(reference.referenceDigest) || recordKeys.has(recordKey)) {
      throw invalid("schema.invalid", "Candidate v2 evidence references must be unique", ["evidenceRefs", index]);
    }
    referenceDigests.add(reference.referenceDigest);
    recordKeys.add(recordKey);
  }
  const derivationRef = fields.opt("derivationRef", parseDerivationRefAt);
  const supersedes = fields.opt("supersedes", parseDurableIdAt);
  const originalDigest = fields.opt("originalDigest", parseDigestAt);
  if ((supersedes === undefined) !== (originalDigest === undefined)) {
    throw invalid("schema.invalid", "Candidate v2 requires originalDigest exactly when supersedes is present", [
      "originalDigest",
    ]);
  }
  const scopeDigest = candidateScopeDigest(common.scope);
  for (const [index, reference] of evidenceRefs.entries()) {
    if (reference.episode.scopeDigest !== scopeDigest) {
      throw invalid("schema.corrupt", "candidate scope does not match its evidence episode scope", [
        "evidenceRefs",
        index,
        "episode",
        "scopeDigest",
      ]);
    }
  }

  const base = {
    schemaVersion: 2 as const,
    ...common,
    evidenceRefs,
    ...(derivationRef !== undefined ? { derivationRef } : {}),
  };
  const candidate: CandidateV2 =
    supersedes === undefined || originalDigest === undefined ? base : { ...base, supersedes, originalDigest };
  const recomputed = candidateContentDigest(candidate);
  if (!DIGEST_PATTERN.test(candidate.contentDigest) || recomputed !== candidate.contentDigest) {
    throw invalid(
      "schema.corrupt",
      `candidate contentDigest does not match its bound fields (stored ${candidate.contentDigest}, recomputed ${recomputed})`,
      ["contentDigest"],
    );
  }
  return candidate;
}

/** Unknown-first parser for legacy V1 and receipt-bound V2 candidate records. */
export function parseCandidate(input: unknown): Candidate {
  const fields = readFields(input, []);
  const schemaVersion = fields.opt("schemaVersion", parseCandidateSchemaVersionAt);
  if (schemaVersion === undefined) {
    throw invalid("schema.unsupported_version", "candidate schemaVersion is required", ["schemaVersion"]);
  }
  return schemaVersion === 1 ? parseCandidateV1(fields) : parseCandidateV2(fields);
}
