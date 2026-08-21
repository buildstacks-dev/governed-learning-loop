// Deterministic builders/persistence for source page/import receipts and
// privacy-minimized evidence-health findings. Adapter messages/details never
// enter these durable records.
import type { Diagnostic } from "../diagnostics.js";
import type { Completeness, SourcePrivacyPolicyRef } from "../records/provenance.js";
import { invalid } from "../parse/toolkit.js";
import type {
  EvidenceHealthFinding,
  ImportReceipt,
  SourcePageReceipt,
  SourcePageState,
} from "../records/source-health.js";
import {
  evidenceHealthFindingDigest,
  importReceiptDigest,
  parseEvidenceHealthFinding,
  parseImportReceipt,
  parseSourcePageReceipt,
  sourcePageReceiptDigest,
} from "../records/source-health.js";
import type { EngineContext } from "./context.js";
import { createOnly } from "./context.js";

const SAFE_DIAGNOSTIC_CODES = new Set([
  "source.input_refused",
  "source.limit_exceeded",
  "source.unsupported_format",
  "source.incomplete",
  "schema.invalid",
  "schema.unsupported_version",
  "schema.corrupt",
  "store.conflict",
  "store.corrupt",
  "episode.identity_conflict",
  "evidence.ownership_mismatch",
  "policy.blocked",
  "source.adapter_diagnostic",
]);

function normalizedDiagnosticCode(code: string): string {
  return SAFE_DIAGNOSTIC_CODES.has(code) ? code : "source.adapter_diagnostic";
}

function transientMessage(code: string): string {
  if (code === "source.input_refused") return "source input was refused";
  if (code === "source.limit_exceeded") return "source input exceeded a configured resource limit";
  if (code === "source.unsupported_format") return "source input format is unsupported";
  if (code === "source.incomplete") return "source input was incomplete";
  if (code === "schema.invalid") return "source projection failed schema validation";
  if (code === "schema.unsupported_version") return "source projection used an unsupported schema version";
  if (code === "schema.corrupt") return "source projection failed an integrity check";
  if (code === "store.conflict") return "a create-only record conflicted with stored content";
  if (code === "store.corrupt") return "the durable store returned invalid content";
  if (code === "episode.identity_conflict") return "episode identity claims conflicted";
  if (code === "evidence.ownership_mismatch") return "evidence ownership validation failed";
  if (code === "policy.blocked") return "content policy refused projected content";
  if (code === "ingest.duplicate") return "one or more records were already stored with identical content";
  return "the source or content policy reported a privacy-minimized diagnostic";
}

/** Removes adapter-authored prose, paths, and details from the immediate result. */
export function sanitizeTransientDiagnostics(diagnostics: readonly Diagnostic[]): readonly Diagnostic[] {
  return diagnostics.map((diagnostic) => {
    const code = normalizedDiagnosticCode(diagnostic.code);
    return { code, severity: diagnostic.severity, message: transientMessage(code) };
  });
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function normalizedDiagnosticCounts(diagnostics: readonly Diagnostic[]): SourcePageReceipt["diagnosticCounts"] {
  const counts = new Map<string, { readonly code: string; readonly severity: Diagnostic["severity"]; count: number }>();
  for (const diagnostic of diagnostics) {
    const code = normalizedDiagnosticCode(diagnostic.code);
    const key = `${code}\u0000${diagnostic.severity}`;
    const existing = counts.get(key) ?? { code, severity: diagnostic.severity, count: 0 };
    existing.count += 1;
    counts.set(key, existing);
  }
  return [...counts.values()]
    .sort((left, right) => compareText(left.code, right.code) || compareText(left.severity, right.severity))
    .map((item) => ({ code: item.code, severity: item.severity, count: item.count }));
}

export function buildHealthFinding(input: {
  readonly code: EvidenceHealthFinding["code"];
  readonly effect: EvidenceHealthFinding["effect"];
  readonly sourceId: string;
  readonly sourceRegistrationRevision: string;
  readonly sourceRef: string;
  readonly pageRef: string;
  readonly completeness: Completeness;
  readonly affectedRecords: number;
}): EvidenceHealthFinding {
  const findingDigest = evidenceHealthFindingDigest(input);
  return parseEvidenceHealthFinding({
    schemaVersion: 1,
    id: `evidence-health-${findingDigest}`,
    ...input,
    findingDigest,
  });
}

export async function persistHealthFinding(context: EngineContext, finding: EvidenceHealthFinding): Promise<void> {
  const status = await createOnly(context, "evidence-health", finding.id, finding, `evidence-health/${finding.id}`);
  if (status === "conflict") {
    throw invalid("store.corrupt", "evidence health finding id collision", ["evidenceHealthFinding"]);
  }
}

export function buildSourcePageReceipt(input: {
  readonly sourceId: string;
  readonly sourceRegistrationRevision: string;
  readonly adapterVersion: string;
  readonly contentPolicyId: string;
  readonly contentPolicyDigest: string;
  readonly loopRegistryRevision: string;
  readonly sourceRef: string;
  readonly pageRef: string;
  readonly state: SourcePageState;
  readonly derivatives: SourcePageReceipt["derivatives"];
  readonly projectionCounts: SourcePageReceipt["projectionCounts"];
  readonly diagnostics: readonly Diagnostic[];
  readonly healthFindingIds: readonly string[];
  readonly privacyPolicy?: SourcePrivacyPolicyRef;
}): SourcePageReceipt {
  const bound = {
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
    diagnosticCounts: normalizedDiagnosticCounts(input.diagnostics),
    healthFindingIds: input.healthFindingIds,
    ...(input.privacyPolicy !== undefined ? { privacyPolicy: input.privacyPolicy } : {}),
  };
  const receiptDigest = sourcePageReceiptDigest(bound);
  return parseSourcePageReceipt({
    schemaVersion: 1,
    id: `source-page-${receiptDigest}`,
    ...bound,
    receiptDigest,
  });
}

export async function persistSourcePageReceipt(context: EngineContext, receipt: SourcePageReceipt): Promise<void> {
  const status = await createOnly(
    context,
    "source-page-receipt",
    receipt.id,
    receipt,
    `source-page-receipt/${receipt.id}`,
  );
  if (status === "conflict") {
    throw invalid("store.corrupt", "source page receipt id collision", ["sourcePageReceipt"]);
  }
}

export function buildImportReceipt(input: {
  readonly sourceId: string;
  readonly sourceRegistrationRevision: string;
  readonly loopRegistryRevision: string;
  readonly pageReceiptIds: readonly string[];
  readonly sourceRevisions: readonly string[];
  readonly completeness: Completeness;
  readonly healthFindingIds: readonly string[];
  readonly privacyPolicy?: SourcePrivacyPolicyRef;
}): ImportReceipt {
  const bound = {
    sourceId: input.sourceId,
    sourceRegistrationRevision: input.sourceRegistrationRevision,
    loopRegistryRevision: input.loopRegistryRevision,
    pageReceiptIds: input.pageReceiptIds,
    sourceRevisions: input.sourceRevisions,
    completeness: input.completeness,
    healthFindingIds: input.healthFindingIds,
    ...(input.privacyPolicy !== undefined ? { privacyPolicy: input.privacyPolicy } : {}),
  };
  const receiptDigest = importReceiptDigest(bound);
  return parseImportReceipt({
    schemaVersion: 1,
    id: `import-${receiptDigest}`,
    ...bound,
    receiptDigest,
  });
}

export async function persistImportReceipt(context: EngineContext, receipt: ImportReceipt): Promise<void> {
  const status = await createOnly(context, "import-receipt", receipt.id, receipt, `import-receipt/${receipt.id}`);
  if (status === "conflict") throw invalid("store.corrupt", "import receipt id collision", ["importReceipt"]);
}

export function completenessOfState(state: SourcePageState): Completeness {
  return state.status === "available" ? state.completeness : "unknown";
}
