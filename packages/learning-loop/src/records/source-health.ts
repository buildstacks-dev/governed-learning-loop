// Durable, privacy-minimized source/import lineage and evidence-health facts.
// These records describe whether evidence can support claims; they are never
// behavioral candidates and never imply efficacy.
import { sha256HexOfCanonicalJson } from "../canonical/canonical-json.js";
import { toJsonValue } from "../canonical/to-json-value.js";
import type { Diagnostic } from "../diagnostics.js";
import {
  invalid,
  parseArrayOf,
  parseFiniteNumber,
  parseNonEmptyText,
  parseOneOf,
  readFields,
} from "../parse/toolkit.js";
import type { Parse } from "../parse/toolkit.js";
import type { Completeness, SourcePrivacyPolicyRef } from "./provenance.js";
import { COMPLETENESS_VALUES } from "./provenance.js";

const UNAVAILABLE_PAGE_STATUSES = ["missing", "unreadable", "unsupported", "corrupt"] as const;
const PAGE_STATUSES = ["available", "missing", "unreadable", "unsupported", "corrupt"] as const;
const DERIVATIVE_KINDS = ["observation", "measurement", "episode"] as const;
const DIAGNOSTIC_SEVERITIES = ["info", "warning", "error"] as const;
const NORMALIZED_DIAGNOSTIC_CODES = [
  "source.input_refused",
  "source.limit_exceeded",
  "source.unsupported_format",
  "source.incomplete",
  "source.adapter_diagnostic",
  "schema.invalid",
  "schema.unsupported_version",
  "schema.corrupt",
  "store.conflict",
  "store.corrupt",
  "episode.identity_conflict",
  "evidence.ownership_mismatch",
  "policy.blocked",
] as const;
const HEALTH_CODES = [
  "source.missing",
  "source.unreadable",
  "source.unsupported",
  "source.corrupt",
  "source.partial",
  "source.revision_changed",
  "source.record_rejected",
  "source.content_policy_refused",
  "source.adapter_diagnostic",
  "source.ownership_mismatch",
] as const;
const HEALTH_EFFECTS = ["limits_claims", "blocks_audit", "blocks_use"] as const;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const RECEIPT_ID_PATTERN = /^source-page-[0-9a-f]{64}$/;
const HEALTH_FINDING_ID_PATTERN = /^evidence-health-[0-9a-f]{64}$/;
const MAX_REFERENCE_LENGTH = 1_000;
const MAX_DURABLE_ID_LENGTH = 4_096;

function parseBoundedControlFreeText(maximumLength: number, label: string): Parse<string> {
  return (input, path) => {
    const value = parseNonEmptyText(input, path);
    if (value.length > maximumLength) {
      throw invalid("schema.invalid", `${label} exceeds ${maximumLength} characters`, path);
    }
    for (const character of value) {
      const code = character.codePointAt(0) ?? 0;
      if (code < 0x20 || code === 0x7f) {
        throw invalid("schema.invalid", `${label} contains a control character`, path);
      }
    }
    return value;
  };
}

const parseReference = parseBoundedControlFreeText(MAX_REFERENCE_LENGTH, "reference");
const parseDurableId = parseBoundedControlFreeText(MAX_DURABLE_ID_LENGTH, "durable id");
const parseSourceIdAt: Parse<string> = (input, path) => {
  const sourceId = parseReference(input, path);
  if (sourceId.includes("/")) {
    throw invalid("schema.invalid", "source id contains the reserved durable-id separator", path);
  }
  return sourceId;
};

const parseDigestAt: Parse<string> = (input, path) => {
  const digest = parseNonEmptyText(input, path);
  if (!DIGEST_PATTERN.test(digest)) throw invalid("schema.invalid", "expected a lowercase SHA-256 digest", path);
  return digest;
};

function parseSafeIntegerAt(minimum: number, label: string): Parse<number> {
  return (input, path) => {
    const value = parseFiniteNumber(input, path);
    if (!Number.isSafeInteger(value) || value < minimum) {
      throw invalid("schema.invalid", `${label} must be a safe integer of at least ${minimum}`, path);
    }
    return value;
  };
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export type SourcePageState =
  | {
      readonly status: "available";
      readonly sourceRevision: string;
      readonly completeness: Completeness;
    }
  | {
      readonly status: (typeof UNAVAILABLE_PAGE_STATUSES)[number];
      readonly observedRevision?: string;
    };

interface SourceDerivativeRecord {
  readonly kind: (typeof DERIVATIVE_KINDS)[number];
  readonly id: string;
  readonly digest: string;
}

interface SourceDiagnosticCount {
  readonly code: string;
  readonly severity: Diagnostic["severity"];
  readonly count: number;
}

export interface SourcePageReceipt {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly sourceId: string;
  readonly sourceRegistrationRevision: string;
  readonly adapterVersion: string;
  readonly contentPolicyId: string;
  readonly contentPolicyDigest: string;
  readonly loopRegistryRevision: string;
  readonly sourceRef: string;
  readonly pageRef: string;
  readonly state: SourcePageState;
  readonly derivatives: readonly SourceDerivativeRecord[];
  readonly projectionCounts: {
    readonly observations: number;
    readonly measurements: number;
    readonly episodes: number;
    readonly rejected: number;
    /** Projections already committed by another exact page receipt. */
    readonly reused?: number;
  };
  readonly diagnosticCounts: readonly SourceDiagnosticCount[];
  readonly healthFindingIds: readonly string[];
  /** The adapter-declared, content-addressed privacy policy that governed this page, when declared. */
  readonly privacyPolicy?: SourcePrivacyPolicyRef;
  readonly receiptDigest: string;
}

export interface ImportReceipt {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly sourceId: string;
  readonly sourceRegistrationRevision: string;
  readonly loopRegistryRevision: string;
  readonly pageReceiptIds: readonly string[];
  readonly sourceRevisions: readonly string[];
  readonly completeness: Completeness;
  readonly healthFindingIds: readonly string[];
  /** The adapter-declared, content-addressed privacy policy that governed this import, when declared. */
  readonly privacyPolicy?: SourcePrivacyPolicyRef;
  readonly receiptDigest: string;
}

export interface EvidenceHealthFinding {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly code: (typeof HEALTH_CODES)[number];
  readonly effect: (typeof HEALTH_EFFECTS)[number];
  readonly sourceId: string;
  readonly sourceRegistrationRevision: string;
  readonly sourceRef: string;
  readonly pageRef: string;
  readonly completeness: Completeness;
  readonly affectedRecords: number;
  readonly findingDigest: string;
}

// Historical receipts carry no privacy-policy declaration; their digest bytes
// are preserved by including the member only when it is present.
function privacyPolicyContent(policy: SourcePrivacyPolicyRef): { readonly id: string; readonly digest: string } {
  return { id: policy.id, digest: policy.digest };
}

const parsePrivacyPolicyRefAt: Parse<SourcePrivacyPolicyRef> = (input, path) => {
  const fields = readFields(input, path);
  return {
    id: fields.req("id", parseReference),
    digest: fields.req("digest", parseDigestAt),
  };
};

export function sourcePageReceiptDigest(
  input: Omit<SourcePageReceipt, "schemaVersion" | "id" | "receiptDigest">,
): string {
  return sha256HexOfCanonicalJson(
    toJsonValue({
      sourceId: input.sourceId,
      sourceRegistrationRevision: input.sourceRegistrationRevision,
      adapterVersion: input.adapterVersion,
      contentPolicyId: input.contentPolicyId,
      contentPolicyDigest: input.contentPolicyDigest,
      loopRegistryRevision: input.loopRegistryRevision,
      sourceRef: input.sourceRef,
      pageRef: input.pageRef,
      state: input.state,
      derivatives: input.derivatives,
      projectionCounts: input.projectionCounts,
      diagnosticCounts: input.diagnosticCounts,
      healthFindingIds: input.healthFindingIds,
      ...(input.privacyPolicy !== undefined ? { privacyPolicy: privacyPolicyContent(input.privacyPolicy) } : {}),
    }),
  );
}

export function importReceiptDigest(input: Omit<ImportReceipt, "schemaVersion" | "id" | "receiptDigest">): string {
  return sha256HexOfCanonicalJson(
    toJsonValue({
      sourceId: input.sourceId,
      sourceRegistrationRevision: input.sourceRegistrationRevision,
      loopRegistryRevision: input.loopRegistryRevision,
      pageReceiptIds: input.pageReceiptIds,
      sourceRevisions: input.sourceRevisions,
      completeness: input.completeness,
      healthFindingIds: input.healthFindingIds,
      ...(input.privacyPolicy !== undefined ? { privacyPolicy: privacyPolicyContent(input.privacyPolicy) } : {}),
    }),
  );
}

export function evidenceHealthFindingDigest(
  input: Omit<EvidenceHealthFinding, "schemaVersion" | "id" | "findingDigest">,
): string {
  return sha256HexOfCanonicalJson(
    toJsonValue({
      code: input.code,
      effect: input.effect,
      sourceId: input.sourceId,
      sourceRegistrationRevision: input.sourceRegistrationRevision,
      sourceRef: input.sourceRef,
      pageRef: input.pageRef,
      completeness: input.completeness,
      affectedRecords: input.affectedRecords,
    }),
  );
}

export const parseSourcePageStateAt: Parse<SourcePageState> = (input, path) => {
  const fields = readFields(input, path);
  const status = fields.req("status", parseOneOf(PAGE_STATUSES));
  if (status === "available") {
    return {
      status,
      sourceRevision: fields.req("sourceRevision", parseDurableId),
      completeness: fields.req("completeness", parseOneOf(COMPLETENESS_VALUES)),
    };
  }
  const observedRevision = fields.opt("observedRevision", parseDurableId);
  return { status, ...(observedRevision !== undefined ? { observedRevision } : {}) };
};

const parseDerivativeAt: Parse<SourceDerivativeRecord> = (input, path) => {
  const fields = readFields(input, path);
  return {
    kind: fields.req("kind", parseOneOf(DERIVATIVE_KINDS)),
    id: fields.req("id", parseDurableId),
    digest: fields.req("digest", parseDigestAt),
  };
};

const parseDiagnosticCountAt: Parse<SourceDiagnosticCount> = (input, path) => {
  const fields = readFields(input, path);
  const count = fields.req("count", parseSafeIntegerAt(1, "diagnostic count"));
  return {
    code: fields.req("code", parseOneOf(NORMALIZED_DIAGNOSTIC_CODES)),
    severity: fields.req("severity", parseOneOf(DIAGNOSTIC_SEVERITIES)),
    count,
  };
};

const parseProjectionCountsAt: Parse<SourcePageReceipt["projectionCounts"]> = (input, path) => {
  const fields = readFields(input, path);
  const parseCount = parseSafeIntegerAt(0, "projection count");
  const reused = fields.opt("reused", parseCount);
  return {
    observations: fields.req("observations", parseCount),
    measurements: fields.req("measurements", parseCount),
    episodes: fields.req("episodes", parseCount),
    rejected: fields.req("rejected", parseCount),
    ...(reused !== undefined ? { reused } : {}),
  };
};

export function parseSourcePageReceipt(input: unknown): SourcePageReceipt {
  const fields = readFields(input, []);
  const pagePrivacyPolicy = fields.opt("privacyPolicy", parsePrivacyPolicyRefAt);
  const receipt: SourcePageReceipt = {
    schemaVersion: fields.schemaVersion1(),
    id: fields.req("id", parseDurableId),
    sourceId: fields.req("sourceId", parseSourceIdAt),
    sourceRegistrationRevision: fields.req("sourceRegistrationRevision", parseDigestAt),
    adapterVersion: fields.req("adapterVersion", parseNonEmptyText),
    contentPolicyId: fields.req("contentPolicyId", parseNonEmptyText),
    contentPolicyDigest: fields.req("contentPolicyDigest", parseDigestAt),
    loopRegistryRevision: fields.req("loopRegistryRevision", parseDigestAt),
    sourceRef: fields.req("sourceRef", parseReference),
    pageRef: fields.req("pageRef", parseReference),
    state: fields.req("state", parseSourcePageStateAt),
    derivatives: fields.req("derivatives", parseArrayOf(parseDerivativeAt)),
    projectionCounts: fields.req("projectionCounts", parseProjectionCountsAt),
    diagnosticCounts: fields.req("diagnosticCounts", parseArrayOf(parseDiagnosticCountAt)),
    healthFindingIds: fields.req("healthFindingIds", parseArrayOf(parseDurableId)),
    ...(pagePrivacyPolicy !== undefined ? { privacyPolicy: pagePrivacyPolicy } : {}),
    receiptDigest: fields.req("receiptDigest", parseDigestAt),
  };
  const totalProjections =
    receipt.projectionCounts.observations + receipt.projectionCounts.measurements + receipt.projectionCounts.episodes;
  const accountedProjections =
    receipt.derivatives.length + receipt.projectionCounts.rejected + (receipt.projectionCounts.reused ?? 0);
  if (
    !Number.isSafeInteger(totalProjections) ||
    !Number.isSafeInteger(accountedProjections) ||
    accountedProjections !== totalProjections
  ) {
    throw invalid("schema.corrupt", "projection counts do not agree with accepted, rejected, and reused projections", [
      "projectionCounts",
    ]);
  }
  const derivativeCounts = { observation: 0, measurement: 0, episode: 0 };
  const derivativeKeys = new Set<string>();
  const sourcePrefix = `${receipt.sourceId}/`;
  for (const [index, derivative] of receipt.derivatives.entries()) {
    if (!derivative.id.startsWith(sourcePrefix) || derivative.id.length === sourcePrefix.length) {
      throw invalid("schema.corrupt", "derivative id belongs to another source", ["derivatives", index, "id"]);
    }
    const key = `${derivative.kind}\u0000${derivative.id}`;
    if (derivativeKeys.has(key)) {
      throw invalid("schema.corrupt", "derivative tuples must be unique within a source page", ["derivatives", index]);
    }
    derivativeKeys.add(key);
    derivativeCounts[derivative.kind] += 1;
  }
  if (
    derivativeCounts.observation > receipt.projectionCounts.observations ||
    derivativeCounts.measurement > receipt.projectionCounts.measurements ||
    derivativeCounts.episode > receipt.projectionCounts.episodes
  ) {
    throw invalid("schema.corrupt", "derivative kinds exceed their projection counts", ["derivatives"]);
  }
  if (
    receipt.state.status !== "available" &&
    (totalProjections !== 0 ||
      receipt.projectionCounts.rejected !== 0 ||
      (receipt.projectionCounts.reused ?? 0) !== 0 ||
      receipt.derivatives.length !== 0)
  ) {
    throw invalid("schema.corrupt", "an unavailable source page cannot contain projections or derivatives", ["state"]);
  }
  let previousDiagnosticKey: string | undefined;
  for (const diagnostic of receipt.diagnosticCounts) {
    const key = `${diagnostic.code}\u0000${diagnostic.severity}`;
    if (previousDiagnosticKey !== undefined && compareText(previousDiagnosticKey, key) >= 0) {
      throw invalid("schema.corrupt", "diagnostic counts must be sorted and unique", ["diagnosticCounts"]);
    }
    previousDiagnosticKey = key;
  }
  for (const [index, id] of receipt.healthFindingIds.entries()) {
    if (!HEALTH_FINDING_ID_PATTERN.test(id)) {
      throw invalid("schema.corrupt", "health finding id is not content-addressed", ["healthFindingIds", index]);
    }
  }
  const recomputed = sourcePageReceiptDigest(receipt);
  if (receipt.receiptDigest !== recomputed || receipt.id !== `source-page-${recomputed}`) {
    throw invalid("schema.corrupt", "source page receipt digest or id does not match its content", ["receiptDigest"]);
  }
  return receipt;
}

export function parseImportReceipt(input: unknown): ImportReceipt {
  const fields = readFields(input, []);
  const importPrivacyPolicy = fields.opt("privacyPolicy", parsePrivacyPolicyRefAt);
  const receipt: ImportReceipt = {
    schemaVersion: fields.schemaVersion1(),
    id: fields.req("id", parseDurableId),
    sourceId: fields.req("sourceId", parseSourceIdAt),
    sourceRegistrationRevision: fields.req("sourceRegistrationRevision", parseDigestAt),
    loopRegistryRevision: fields.req("loopRegistryRevision", parseDigestAt),
    pageReceiptIds: fields.req("pageReceiptIds", parseArrayOf(parseDurableId)),
    sourceRevisions: fields.req("sourceRevisions", parseArrayOf(parseDurableId)),
    completeness: fields.req("completeness", parseOneOf(COMPLETENESS_VALUES)),
    healthFindingIds: fields.req("healthFindingIds", parseArrayOf(parseDurableId)),
    ...(importPrivacyPolicy !== undefined ? { privacyPolicy: importPrivacyPolicy } : {}),
    receiptDigest: fields.req("receiptDigest", parseDigestAt),
  };
  for (const [index, id] of receipt.pageReceiptIds.entries()) {
    if (!RECEIPT_ID_PATTERN.test(id)) {
      throw invalid("schema.corrupt", "page receipt id is not content-addressed", ["pageReceiptIds", index]);
    }
  }
  for (const [index, id] of receipt.healthFindingIds.entries()) {
    if (!HEALTH_FINDING_ID_PATTERN.test(id)) {
      throw invalid("schema.corrupt", "health finding id is not content-addressed", ["healthFindingIds", index]);
    }
  }
  for (let index = 1; index < receipt.sourceRevisions.length; index += 1) {
    const previous = receipt.sourceRevisions[index - 1];
    const current = receipt.sourceRevisions[index];
    if (previous === undefined || current === undefined || compareText(previous, current) >= 0) {
      throw invalid("schema.corrupt", "source revisions must be sorted and unique", ["sourceRevisions", index]);
    }
  }
  const recomputed = importReceiptDigest(receipt);
  if (receipt.receiptDigest !== recomputed || receipt.id !== `import-${recomputed}`) {
    throw invalid("schema.corrupt", "import receipt digest or id does not match its content", ["receiptDigest"]);
  }
  return receipt;
}

export function parseEvidenceHealthFinding(input: unknown): EvidenceHealthFinding {
  const fields = readFields(input, []);
  const finding: EvidenceHealthFinding = {
    schemaVersion: fields.schemaVersion1(),
    id: fields.req("id", parseDurableId),
    code: fields.req("code", parseOneOf(HEALTH_CODES)),
    effect: fields.req("effect", parseOneOf(HEALTH_EFFECTS)),
    sourceId: fields.req("sourceId", parseSourceIdAt),
    sourceRegistrationRevision: fields.req("sourceRegistrationRevision", parseDigestAt),
    sourceRef: fields.req("sourceRef", parseReference),
    pageRef: fields.req("pageRef", parseReference),
    completeness: fields.req("completeness", parseOneOf(COMPLETENESS_VALUES)),
    affectedRecords: fields.req("affectedRecords", parseSafeIntegerAt(0, "affectedRecords")),
    findingDigest: fields.req("findingDigest", parseDigestAt),
  };
  const recomputed = evidenceHealthFindingDigest(finding);
  if (finding.findingDigest !== recomputed || finding.id !== `evidence-health-${recomputed}`) {
    throw invalid("schema.corrupt", "evidence health finding digest or id does not match its content", [
      "findingDigest",
    ]);
  }
  return finding;
}
