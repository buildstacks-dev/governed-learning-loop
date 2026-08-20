// Historical EvidenceRef revalidation without reminting current-registry lineage.
import { canonicalJsonText } from "../canonical/canonical-json.js";
import { toJsonValue } from "../canonical/to-json-value.js";
import type { Diagnostic } from "../diagnostics.js";
import { invalid } from "../parse/toolkit.js";
import type { DetectorExecutionRecord } from "../records/detector-execution.js";
import type { EvidenceRef, ObservationEvidenceRef } from "../records/evidence-ref.js";
import { parseEpisodeRecord, parseMeasurementRecord } from "../records/episode.js";
import { parseObservation } from "../records/observation.js";
import type { SemanticRegistryConfig } from "../records/semantic-registry.js";
import { canonicalKey, detectorRefKey, scopeDigest } from "../records/semantic-shared.js";
import { parseEvidenceHealthFinding, parseSourcePageReceipt } from "../records/source-health.js";
import type { EngineContext } from "./context.js";
import { iterateRecordPages, loadStoredRecord, recordDigest } from "./context.js";
import type { EvidenceHealthView } from "./evidence-binding.js";
import { loadEpisodeIdentityState } from "./episode-identity.js";
import { loadEpisodeOutcomeClaimHistory } from "./episode-outcome.js";

const SCAN_PAGE_LIMIT = 100;

function sameCanonical(left: unknown, right: unknown): boolean {
  return canonicalJsonText(toJsonValue(left)) === canonicalJsonText(toJsonValue(right));
}

function trustRank(value: EvidenceRef["trust"]): number {
  if (value === "untrusted") return 0;
  if (value === "advisory") return 1;
  if (value === "observed") return 2;
  return 3;
}

function completenessRank(value: EvidenceRef["completeness"]): number {
  if (value === "unknown") return 0;
  if (value === "partial") return 1;
  return 2;
}

function diagnostic(code: string, severity: Diagnostic["severity"], message: string): Diagnostic {
  return { code, severity, message };
}

async function validateHistoricalSupportingObservation(
  context: EngineContext,
  execution: DetectorExecutionRecord,
  reference: ObservationEvidenceRef,
  acceptedObservationKinds: readonly string[],
  pageKeys: Set<string>,
): Promise<void> {
  const stored = await loadStoredRecord(context, "observation", reference.recordId);
  if (stored === undefined || stored.digest !== reference.recordDigest) {
    throw invalid("semantic.evidence_invalid", "historical supporting observation is missing or changed", []);
  }
  const observation = parseObservation(stored.value);
  if (
    observation.id !== reference.recordId ||
    observation.episodeId !== reference.episode.episodeId ||
    observation.provenance.sourceId !== reference.sourceId ||
    observation.provenance.sourceRevision !== reference.sourceRevision ||
    observation.provenance.sourceRef !== reference.sourceRef ||
    observation.provenance.recordRef !== reference.sourceRecordId ||
    observation.provenance.trust !== reference.trust ||
    observation.provenance.completeness !== reference.completeness ||
    !acceptedObservationKinds.includes(observation.kind)
  ) {
    throw invalid("semantic.evidence_invalid", "historical supporting observation ownership is invalid", []);
  }
  const receiptStored = await loadStoredRecord(context, "source-page-receipt", reference.pageReceiptId);
  if (receiptStored === undefined) {
    throw invalid("semantic.evidence_invalid", "historical supporting observation receipt is missing", []);
  }
  const receipt = parseSourcePageReceipt(receiptStored.value);
  if (
    receipt.id !== receiptStored.key.id ||
    receipt.receiptDigest !== reference.pageReceiptDigest ||
    receipt.sourceId !== reference.sourceId ||
    receipt.sourceRegistrationRevision !== reference.sourceRegistrationRevision ||
    receipt.sourceRef !== reference.sourceRef ||
    receipt.pageRef !== reference.pageRef ||
    receipt.state.status !== "available" ||
    receipt.state.sourceRevision !== reference.sourceRevision ||
    !receipt.derivatives.some(
      (derivative) =>
        derivative.kind === "observation" &&
        derivative.id === reference.recordId &&
        derivative.digest === reference.recordDigest,
    )
  ) {
    throw invalid("semantic.evidence_invalid", "historical supporting observation receipt is invalid", []);
  }
  const episodeStored = await loadStoredRecord(context, "episode", reference.episode.episodeRecordId);
  if (episodeStored === undefined || episodeStored.digest !== reference.episode.episodeRecordDigest) {
    throw invalid("semantic.evidence_invalid", "historical supporting observation episode is missing", []);
  }
  const episode = parseEpisodeRecord(episodeStored.value);
  const identity = await loadEpisodeIdentityState(context, episode.id);
  if (
    episode.id !== reference.episode.episodeRecordId ||
    scopeDigest(episode.scope) !== execution.scopeDigest ||
    identity.status !== "resolved" ||
    recordDigest(toJsonValue(identity.identity)) !== reference.episode.episodeIdentityDigest
  ) {
    throw invalid("semantic.evidence_invalid", "historical supporting observation episode is invalid", []);
  }
  const episodeReceiptStored = await loadStoredRecord(context, "source-page-receipt", reference.episode.pageReceiptId);
  if (episodeReceiptStored === undefined) {
    throw invalid("semantic.evidence_invalid", "historical supporting episode receipt is missing", []);
  }
  const episodeReceipt = parseSourcePageReceipt(episodeReceiptStored.value);
  if (
    episodeReceipt.id !== episodeReceiptStored.key.id ||
    episodeReceipt.receiptDigest !== reference.episode.pageReceiptDigest ||
    !episodeReceipt.derivatives.some(
      (derivative) =>
        derivative.kind === "episode" && derivative.id === episode.id && derivative.digest === episodeStored.digest,
    )
  ) {
    throw invalid("semantic.evidence_invalid", "historical supporting episode receipt is invalid", []);
  }
  pageKeys.add(
    canonicalKey([receipt.sourceId, receipt.sourceRegistrationRevision, receipt.sourceRef, receipt.pageRef]),
  );
  pageKeys.add(
    canonicalKey([
      episodeReceipt.sourceId,
      episodeReceipt.sourceRegistrationRevision,
      episodeReceipt.sourceRef,
      episodeReceipt.pageRef,
    ]),
  );
}

/** Revalidates exact historical refs without reminting them under the current loop registry. */
export async function validateHistoricalWindowEvidence(
  context: EngineContext,
  execution: DetectorExecutionRecord,
  registry: SemanticRegistryConfig,
  options: { readonly includeCurrentHealth?: boolean } = {},
): Promise<EvidenceHealthView> {
  const detector = registry.detectors.find(
    (candidate) => detectorRefKey(candidate) === detectorRefKey(execution.detector),
  );
  if (detector === undefined) throw invalid("semantic.registry_mismatch", "historical detector is unavailable", []);
  let status: EvidenceHealthView["status"] = "ready";
  const diagnostics: Diagnostic[] = [];
  const pageKeys = new Set<string>();
  for (const reference of execution.window.evidenceRefs) {
    const stored = await loadStoredRecord(context, reference.kind, reference.recordId);
    if (stored === undefined || stored.digest !== reference.recordDigest) {
      throw invalid("semantic.evidence_invalid", "historical evidence record is missing or changed", []);
    }
    const record =
      reference.kind === "observation" ? parseObservation(stored.value) : parseMeasurementRecord(stored.value);
    if (
      record.id !== reference.recordId ||
      record.episodeId !== reference.episode.episodeId ||
      record.provenance.sourceId !== reference.sourceId ||
      record.provenance.sourceRevision !== reference.sourceRevision ||
      record.provenance.sourceRef !== reference.sourceRef ||
      record.provenance.recordRef !== reference.sourceRecordId ||
      record.provenance.trust !== reference.trust ||
      record.provenance.completeness !== reference.completeness
    ) {
      throw invalid("semantic.evidence_invalid", "historical evidence ownership no longer matches", []);
    }
    if (
      reference.kind === "observation" &&
      (!("kind" in record) || !detector.acceptedObservationKinds.includes(record.kind))
    ) {
      throw invalid("semantic.observation_kind_invalid", "historical observation kind is not accepted", []);
    }
    if (
      execution.result.status === "applied" &&
      (trustRank(reference.trust) < trustRank(detector.minimumTrust) ||
        completenessRank(reference.completeness) < completenessRank(detector.minimumCompleteness))
    ) {
      throw invalid("semantic.evidence_incomplete", "historical applied evidence is below detector requirements", []);
    }
    const receiptStored = await loadStoredRecord(context, "source-page-receipt", reference.pageReceiptId);
    if (receiptStored === undefined) {
      throw invalid("semantic.evidence_invalid", "historical evidence page receipt is missing or changed", []);
    }
    const receipt = parseSourcePageReceipt(receiptStored.value);
    if (
      receipt.id !== receiptStored.key.id ||
      receipt.receiptDigest !== reference.pageReceiptDigest ||
      receipt.sourceId !== reference.sourceId ||
      receipt.sourceRegistrationRevision !== reference.sourceRegistrationRevision ||
      receipt.sourceRef !== reference.sourceRef ||
      receipt.pageRef !== reference.pageRef ||
      receipt.state.status !== "available" ||
      receipt.state.sourceRevision !== reference.sourceRevision ||
      !receipt.derivatives.some(
        (derivative) =>
          derivative.kind === reference.kind &&
          derivative.id === reference.recordId &&
          derivative.digest === reference.recordDigest,
      )
    ) {
      throw invalid("semantic.evidence_invalid", "historical evidence page receipt does not bind its record", []);
    }
    const episodeStored = await loadStoredRecord(context, "episode", reference.episode.episodeRecordId);
    if (episodeStored === undefined || episodeStored.digest !== reference.episode.episodeRecordDigest) {
      throw invalid("semantic.evidence_invalid", "historical evidence episode is missing or changed", []);
    }
    const episode = parseEpisodeRecord(episodeStored.value);
    const identity = await loadEpisodeIdentityState(context, episode.id);
    if (
      episode.id !== reference.episode.episodeRecordId ||
      scopeDigest(episode.scope) !== execution.scopeDigest ||
      identity.status !== "resolved" ||
      recordDigest(toJsonValue(identity.identity)) !== reference.episode.episodeIdentityDigest
    ) {
      throw invalid("semantic.evidence_invalid", "historical evidence episode identity no longer matches", []);
    }
    const episodeReceiptStored = await loadStoredRecord(
      context,
      "source-page-receipt",
      reference.episode.pageReceiptId,
    );
    if (episodeReceiptStored === undefined) {
      throw invalid("semantic.evidence_invalid", "historical episode page receipt is missing or changed", []);
    }
    const episodeReceipt = parseSourcePageReceipt(episodeReceiptStored.value);
    if (
      episodeReceipt.id !== episodeReceiptStored.key.id ||
      episodeReceipt.receiptDigest !== reference.episode.pageReceiptDigest ||
      !episodeReceipt.derivatives.some(
        (derivative) =>
          derivative.kind === "episode" && derivative.id === episode.id && derivative.digest === episodeStored.digest,
      )
    ) {
      throw invalid("semantic.evidence_invalid", "historical episode receipt does not bind its episode", []);
    }
    pageKeys.add(
      canonicalKey([receipt.sourceId, receipt.sourceRegistrationRevision, receipt.sourceRef, receipt.pageRef]),
    );
    pageKeys.add(
      canonicalKey([
        episodeReceipt.sourceId,
        episodeReceipt.sourceRegistrationRevision,
        episodeReceipt.sourceRef,
        episodeReceipt.pageRef,
      ]),
    );
    if (reference.kind === "measurement") {
      if (reference.schemaVersion !== 2) {
        throw invalid("semantic.evidence_invalid", "historical measurement lacks qualified supporting evidence", []);
      }
      const measurement = parseMeasurementRecord(stored.value);
      const supportingIds = reference.supportingEvidenceRefs.map((supporting) => supporting.recordId);
      let supportingCompleteness: EvidenceRef["completeness"] = "complete";
      for (const supporting of reference.supportingEvidenceRefs) {
        if (supporting.trust !== reference.trust) {
          throw invalid("semantic.evidence_invalid", "historical measurement support trust does not match", []);
        }
        if (supporting.completeness === "unknown") supportingCompleteness = "unknown";
        else if (supporting.completeness === "partial" && supportingCompleteness === "complete") {
          supportingCompleteness = "partial";
        }
      }
      if (
        measurement.evidenceIds.length !== supportingIds.length ||
        !measurement.evidenceIds.every((id, index) => id === supportingIds[index]) ||
        reference.completeness !== supportingCompleteness ||
        measurement.provenance.completeness !== supportingCompleteness
      ) {
        throw invalid("semantic.evidence_invalid", "historical measurement support order no longer matches", []);
      }
      for (const supporting of reference.supportingEvidenceRefs) {
        await validateHistoricalSupportingObservation(
          context,
          execution,
          supporting,
          detector.acceptedObservationKinds,
          pageKeys,
        );
      }
      const outcomeClaims = await loadEpisodeOutcomeClaimHistory(context, episode.id);
      if (!outcomeClaims.some((claim) => claim.measurementRefs.some((claimed) => sameCanonical(claimed, reference)))) {
        throw invalid("semantic.evidence_invalid", "historical measurement is absent from retained outcomes", []);
      }
    }
    if (reference.completeness !== "complete") status = "incomplete";
  }
  if (options.includeCurrentHealth === false) return { status, diagnostics };
  for await (const page of iterateRecordPages(context.store, "evidence-health", { limit: SCAN_PAGE_LIMIT })) {
    for (const stored of page.records) {
      const finding = parseEvidenceHealthFinding(stored.value);
      if (finding.id !== stored.key.id) throw invalid("store.corrupt", "stored health id does not match its key", []);
      const key = canonicalKey([
        finding.sourceId,
        finding.sourceRegistrationRevision,
        finding.sourceRef,
        finding.pageRef,
      ]);
      if (!pageKeys.has(key)) continue;
      if (finding.effect === "blocks_use") status = "invalid";
      else if (status === "ready") status = "incomplete";
      diagnostics.push(
        diagnostic(
          finding.effect === "blocks_use" ? "semantic.evidence_blocked" : "semantic.evidence_limited",
          finding.effect === "blocks_use" ? "error" : "warning",
          "semantic evidence is constrained by current durable health",
        ),
      );
    }
  }
  return { status, diagnostics };
}
