// Read-only candidate-evidence resolution. Exact durable record ids are
// re-bound through committed source-page receipts, configured registrations,
// resolved episode identity, exact scope, and current evidence-health facts.
// This module performs no provider calls and no writes.
import { canonicalJsonText } from "../canonical/canonical-json.js";
import { toJsonValue } from "../canonical/to-json-value.js";
import type { Diagnostic } from "../diagnostics.js";
import { LearningLoopError } from "../diagnostics.js";
import { invalid } from "../parse/toolkit.js";
import type { RegisteredSource } from "../ports/evidence.js";
import type { Candidate } from "../records/candidate.js";
import { candidateScopeDigest } from "../records/candidate.js";
import type { EvidenceRef, MeasurementEvidenceRefV2, ObservationEvidenceRef } from "../records/evidence-ref.js";
import { evidenceRefDigest, parseEvidenceRef, parseObservationEvidenceRefAt } from "../records/evidence-ref.js";
import type { EpisodeRecord, MeasurementRecord } from "../records/episode.js";
import { parseEpisodeRecord, parseMeasurementRecord } from "../records/episode.js";
import type { Observation } from "../records/observation.js";
import { parseObservation } from "../records/observation.js";
import type { Scope } from "../records/scope.js";
import type { EvidenceHealthFinding, SourcePageReceipt } from "../records/source-health.js";
import { parseEvidenceHealthFinding, parseSourcePageReceipt } from "../records/source-health.js";
import type { EngineContext } from "./context.js";
import type { RecordKind } from "./context.js";
import {
  derivedRecordId,
  iterateRecordPages,
  loadStoredRecord,
  readRecordKindRevision,
  recordDigest,
} from "./context.js";
import type { EpisodeIdentityRecord } from "./episode-identity.js";
import { loadEpisodeIdentityState } from "./episode-identity.js";
import { loadLatestEpisodeOutcomeClaim } from "./episode-outcome.js";
import { adapterFor } from "./source-registration.js";

const MAX_EVIDENCE_IDS = 1_000;
const MAX_DETECTOR_EVIDENCE_IDS = 5_000;
const MAX_DURABLE_ID_LENGTH = 4_096;
const SCAN_PAGE_LIMIT = 100;
const MAX_SNAPSHOT_ATTEMPTS = 3;
const EVIDENCE_SNAPSHOT_KINDS: readonly RecordKind[] = [
  "observation",
  "measurement",
  "episode",
  "episode-identity",
  "episode-outcome",
  "source-revision",
  "source-page-receipt",
  "evidence-health",
];

type EvidenceRecord = Observation | MeasurementRecord;
type EvidenceKind = EvidenceRef["kind"];

interface ResolveOptions {
  readonly allowMeasurements: boolean;
  readonly requireOutcomeClaim: boolean;
}

export type DetectorEvidenceInput =
  | { readonly kind: "observation"; readonly recordId: string }
  | { readonly kind: "measurement"; readonly recordId: string }
  | { readonly kind: "observation"; readonly record: Observation }
  | { readonly kind: "measurement"; readonly record: MeasurementRecord };

export interface EvidenceHealthView {
  readonly status: "ready" | "incomplete" | "invalid" | "legacy_unbound";
  readonly diagnostics: readonly Diagnostic[];
}

export interface CandidateEvidenceResolution {
  readonly refs: readonly EvidenceRef[];
  readonly records: readonly EvidenceRecord[];
  readonly health: EvidenceHealthView;
}

interface MutableHealth {
  status: "ready" | "incomplete" | "invalid";
  readonly diagnostics: Diagnostic[];
}

interface LoadedEvidence {
  readonly kind: EvidenceKind;
  readonly record: EvidenceRecord;
  readonly digest: string;
}

interface ReceiptBoundEvidence extends LoadedEvidence {
  readonly receipt: SourcePageReceipt;
  readonly registration: RegisteredSource<unknown>;
}

interface ResolvedEpisode {
  readonly episode: EpisodeRecord;
  readonly episodeDigest: string;
  readonly identity: EpisodeIdentityRecord;
  readonly identityDigest: string;
}

interface FullyBoundEvidence extends ReceiptBoundEvidence {
  readonly episode: ResolvedEpisode;
  readonly episodeReceipt: SourcePageReceipt;
}

function evidenceDiagnostic(
  code: string,
  severity: Diagnostic["severity"],
  message: string,
  path?: readonly (string | number)[],
): Diagnostic {
  return { code, severity, message, ...(path === undefined ? {} : { path }) };
}

function markHealth(health: MutableHealth, status: "incomplete" | "invalid", diagnostic: Diagnostic): void {
  if (status === "invalid" || health.status === "ready") health.status = status;
  health.diagnostics.push(diagnostic);
}

function hasInvalidHealth(health: MutableHealth): boolean {
  return health.status === "invalid";
}

function result(
  refs: readonly EvidenceRef[],
  records: readonly EvidenceRecord[],
  health: MutableHealth,
): CandidateEvidenceResolution {
  return {
    refs,
    records,
    health: { status: health.status, diagnostics: health.diagnostics },
  };
}

function mergeHealth(health: MutableHealth, child: EvidenceHealthView): void {
  if (child.status === "invalid" || child.status === "legacy_unbound") health.status = "invalid";
  else if (child.status === "incomplete" && health.status === "ready") health.status = "incomplete";
  health.diagnostics.push(...child.diagnostics);
}

const COMPLETENESS_RANK = { complete: 0, partial: 1, unknown: 2 } as const;

function worstCompleteness(references: readonly ObservationEvidenceRef[]): ObservationEvidenceRef["completeness"] {
  let worst: ObservationEvidenceRef["completeness"] = "complete";
  for (const reference of references) {
    if (COMPLETENESS_RANK[reference.completeness] > COMPLETENESS_RANK[worst]) worst = reference.completeness;
  }
  return worst;
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function validateExactIds(input: readonly string[], health: MutableHealth): readonly string[] | undefined {
  if (!Array.isArray(input) || input.length === 0) {
    markHealth(
      health,
      "invalid",
      evidenceDiagnostic("evidence.ids_invalid", "error", "candidate evidence requires at least one exact durable id"),
    );
    return undefined;
  }
  if (input.length > MAX_EVIDENCE_IDS) {
    markHealth(
      health,
      "invalid",
      evidenceDiagnostic(
        "evidence.ids_invalid",
        "error",
        `candidate evidence exceeds the ${MAX_EVIDENCE_IDS}-record ceiling`,
      ),
    );
    return undefined;
  }
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const [index, id] of input.entries()) {
    const separator = typeof id === "string" ? id.indexOf("/") : -1;
    if (
      typeof id !== "string" ||
      id.length === 0 ||
      id.length > MAX_DURABLE_ID_LENGTH ||
      containsControlCharacter(id) ||
      separator <= 0 ||
      separator === id.length - 1
    ) {
      markHealth(
        health,
        "invalid",
        evidenceDiagnostic(
          "evidence.id_invalid",
          "error",
          "candidate evidence id is not an exact bounded source-qualified durable id",
          ["evidenceIds", index],
        ),
      );
      continue;
    }
    if (seen.has(id)) {
      markHealth(
        health,
        "invalid",
        evidenceDiagnostic("evidence.id_duplicate", "error", "candidate evidence ids must be unique", [
          "evidenceIds",
          index,
        ]),
      );
      continue;
    }
    seen.add(id);
    ids.push(id);
  }
  return health.status === "invalid" ? undefined : ids;
}

async function loadEvidenceRecord(
  context: EngineContext,
  id: string,
  index: number,
  health: MutableHealth,
): Promise<LoadedEvidence | undefined> {
  const observationStored = await loadStoredRecord(context, "observation", id);
  const measurementStored = await loadStoredRecord(context, "measurement", id);
  if (observationStored !== undefined && measurementStored !== undefined) {
    markHealth(
      health,
      "invalid",
      evidenceDiagnostic(
        "evidence.kind_ambiguous",
        "error",
        "durable evidence id exists in both observation and measurement namespaces",
        ["evidenceIds", index],
      ),
    );
    return undefined;
  }
  if (observationStored !== undefined) {
    const record = parseObservation(observationStored.value);
    if (record.id !== id) throw invalid("store.corrupt", "stored observation id does not match its key", ["id"]);
    return { kind: "observation", record, digest: observationStored.digest };
  }
  if (measurementStored !== undefined) {
    const record = parseMeasurementRecord(measurementStored.value);
    if (record.id !== id) throw invalid("store.corrupt", "stored measurement id does not match its key", ["id"]);
    return { kind: "measurement", record, digest: measurementStored.digest };
  }
  markHealth(
    health,
    "invalid",
    evidenceDiagnostic("evidence.not_found", "error", "exact durable evidence id was not found", [
      "evidenceIds",
      index,
    ]),
  );
  return undefined;
}

function detectorInputRecordId(input: DetectorEvidenceInput): string {
  return "record" in input ? input.record.id : input.recordId;
}

function validateDetectorInputs(
  inputs: readonly DetectorEvidenceInput[],
  health: MutableHealth,
): readonly DetectorEvidenceInput[] | undefined {
  if (!Array.isArray(inputs) || inputs.length === 0) {
    markHealth(
      health,
      "invalid",
      evidenceDiagnostic("evidence.ids_invalid", "error", "detector evidence requires at least one exact durable id"),
    );
    return undefined;
  }
  if (inputs.length > MAX_DETECTOR_EVIDENCE_IDS) {
    markHealth(
      health,
      "invalid",
      evidenceDiagnostic(
        "evidence.ids_invalid",
        "error",
        `detector evidence exceeds the ${MAX_DETECTOR_EVIDENCE_IDS}-record ceiling`,
      ),
    );
    return undefined;
  }
  const seen = new Set<string>();
  const kindsById = new Map<string, EvidenceKind>();
  for (const [index, input] of inputs.entries()) {
    const id = detectorInputRecordId(input);
    const separator = typeof id === "string" ? id.indexOf("/") : -1;
    if (
      typeof id !== "string" ||
      id.length === 0 ||
      id.length > MAX_DURABLE_ID_LENGTH ||
      containsControlCharacter(id) ||
      separator <= 0 ||
      separator === id.length - 1
    ) {
      markHealth(
        health,
        "invalid",
        evidenceDiagnostic(
          "evidence.id_invalid",
          "error",
          "detector evidence id is not an exact bounded source-qualified durable id",
          ["evidenceIds", index],
        ),
      );
      continue;
    }
    if (seen.has(id)) {
      markHealth(
        health,
        "invalid",
        evidenceDiagnostic("evidence.id_duplicate", "error", "detector evidence ids must be unique", [
          "evidenceIds",
          index,
        ]),
      );
      continue;
    }
    seen.add(id);
    kindsById.set(id, input.kind);
  }
  if (health.status === "invalid") return undefined;

  const aggregateIds = new Set(seen);
  let duplicateSupport = false;
  let missingSupport = false;
  let emptySupport = false;
  for (const input of inputs) {
    if (!("record" in input) || input.kind !== "measurement") continue;
    const supportingIds = new Set<string>();
    if (input.record.evidenceIds.length === 0) emptySupport = true;
    for (const supportingId of input.record.evidenceIds) {
      aggregateIds.add(supportingId);
      if (supportingIds.has(supportingId)) duplicateSupport = true;
      supportingIds.add(supportingId);
      if (kindsById.get(supportingId) !== "observation") missingSupport = true;
    }
  }
  if (emptySupport) {
    markHealth(
      health,
      "invalid",
      evidenceDiagnostic(
        "evidence.ownership_mismatch",
        "error",
        "measurement evidence requires at least one disclosed supporting observation",
      ),
    );
  }
  if (duplicateSupport) {
    markHealth(
      health,
      "invalid",
      evidenceDiagnostic(
        "evidence.ownership_mismatch",
        "error",
        "measurement supporting observation ids must be unique",
      ),
    );
  }
  if (missingSupport) {
    markHealth(
      health,
      "invalid",
      evidenceDiagnostic(
        "evidence.support_outside_window",
        "error",
        "measurement support must be an observation in the exact detector window",
      ),
    );
  }
  if (aggregateIds.size > MAX_DETECTOR_EVIDENCE_IDS) {
    markHealth(
      health,
      "invalid",
      evidenceDiagnostic(
        "evidence.ids_invalid",
        "error",
        `detector evidence and support exceed the ${MAX_DETECTOR_EVIDENCE_IDS}-record ceiling`,
      ),
    );
  }
  return hasInvalidHealth(health) ? undefined : inputs;
}

async function loadDetectorEvidenceRecord(
  context: EngineContext,
  input: DetectorEvidenceInput,
  index: number,
  health: MutableHealth,
): Promise<LoadedEvidence | undefined> {
  const id = detectorInputRecordId(input);
  const stored = await loadStoredRecord(context, input.kind, id);
  if (stored === undefined) {
    markHealth(
      health,
      "invalid",
      evidenceDiagnostic("evidence.not_found", "error", "exact durable detector evidence was not found", [
        "evidenceIds",
        index,
      ]),
    );
    return undefined;
  }
  const record = input.kind === "observation" ? parseObservation(stored.value) : parseMeasurementRecord(stored.value);
  if (record.id !== id) throw invalid("store.corrupt", "stored detector evidence id does not match its key", ["id"]);
  if ("record" in input && canonicalJsonText(toJsonValue(input.record)) !== canonicalJsonText(toJsonValue(record))) {
    markHealth(
      health,
      "invalid",
      evidenceDiagnostic(
        "evidence.record_mismatch",
        "error",
        "queried detector evidence no longer matches the exact durable record",
        ["evidenceIds", index],
      ),
    );
    return undefined;
  }
  return { kind: input.kind, record, digest: stored.digest };
}

function derivativeKey(kind: "observation" | "measurement" | "episode", id: string, digest: string): string {
  return canonicalJsonText([kind, id, digest]);
}

async function findDerivativeReceipts(
  context: EngineContext,
  keys: ReadonlySet<string>,
): Promise<ReadonlyMap<string, readonly SourcePageReceipt[]>> {
  const matches = new Map<string, SourcePageReceipt[]>();
  for await (const page of iterateRecordPages(context.store, "source-page-receipt", { limit: SCAN_PAGE_LIMIT })) {
    for (const stored of page.records) {
      const receipt = parseSourcePageReceipt(stored.value);
      if (receipt.id !== stored.key.id) {
        throw invalid("store.corrupt", "stored source page receipt id does not match its key", ["id"]);
      }
      for (const derivative of receipt.derivatives) {
        const key = derivativeKey(derivative.kind, derivative.id, derivative.digest);
        if (!keys.has(key)) continue;
        const values = matches.get(key) ?? [];
        if (!values.some((value) => value.id === receipt.id)) values.push(receipt);
        matches.set(key, values);
      }
    }
  }
  return matches;
}

function configuredSource(
  context: EngineContext,
  loaded: LoadedEvidence,
  receipt: SourcePageReceipt,
  index: number,
  health: MutableHealth,
  registrationsById?: ReadonlyMap<string, RegisteredSource<unknown>>,
): RegisteredSource<unknown> | undefined {
  const provenance = loaded.record.provenance;
  const registration =
    registrationsById?.get(receipt.sourceId) ?? [...context.sources].find((source) => source.id === receipt.sourceId);
  if (registration === undefined || registration.registryRevision !== receipt.sourceRegistrationRevision) {
    markHealth(
      health,
      "invalid",
      evidenceDiagnostic(
        "evidence.source_registration_mismatch",
        "error",
        "evidence receipt is not bound to the configured source registration",
        ["evidenceIds", index],
      ),
    );
    return undefined;
  }
  const adapter = adapterFor(registration);
  const contentPolicy = context.contentPoliciesById.get(registration.contentPolicyId);
  if (
    adapter === undefined ||
    contentPolicy === undefined ||
    adapter.descriptor.adapterVersion !== receipt.adapterVersion ||
    registration.contentPolicyId !== receipt.contentPolicyId ||
    contentPolicy.digest !== receipt.contentPolicyDigest
  ) {
    markHealth(
      health,
      "invalid",
      evidenceDiagnostic(
        "evidence.configuration_mismatch",
        "error",
        "evidence receipt adapter or content-policy binding does not match configured components",
        ["evidenceIds", index],
      ),
    );
    return undefined;
  }
  if (
    receipt.state.status !== "available" ||
    provenance.sourceId !== receipt.sourceId ||
    provenance.sourceRef !== receipt.sourceRef ||
    provenance.sourceRevision !== receipt.state.sourceRevision ||
    provenance.adapterVersion !== receipt.adapterVersion ||
    provenance.trust !== registration.trustCeiling ||
    provenance.recordRef === undefined ||
    derivedRecordId(provenance.sourceId, provenance.recordRef) !== loaded.record.id
  ) {
    markHealth(
      health,
      "invalid",
      evidenceDiagnostic(
        "evidence.receipt_mismatch",
        "error",
        "durable evidence provenance does not match its committed source page receipt",
        ["evidenceIds", index],
      ),
    );
    return undefined;
  }
  return registration;
}

function logicalEpisodeKey(sourceId: string, episodeId: string): string {
  return canonicalJsonText([sourceId, episodeId]);
}

async function findEpisodes(
  context: EngineContext,
  wanted: ReadonlySet<string>,
  wantedSources: ReadonlySet<string>,
): Promise<ReadonlyMap<string, readonly ResolvedEpisode[]>> {
  const matches = new Map<string, ResolvedEpisode[]>();
  for await (const page of iterateRecordPages(context.store, "episode", { limit: SCAN_PAGE_LIMIT })) {
    for (const stored of page.records) {
      const episode = parseEpisodeRecord(stored.value);
      if (episode.id !== stored.key.id) {
        throw invalid("store.corrupt", "stored episode id does not match its key", ["id"]);
      }
      if (!episode.sourceRefs.some((sourceId) => wantedSources.has(sourceId))) continue;
      const identityState = await loadEpisodeIdentityState(context, episode.id);
      if (identityState.status !== "resolved") continue;
      const identity = identityState.identity;
      const key = logicalEpisodeKey(identity.sourceId, identity.episodeId);
      if (!wanted.has(key)) continue;
      const values = matches.get(key) ?? [];
      values.push({
        episode,
        episodeDigest: stored.digest,
        identity,
        identityDigest: recordDigest(toJsonValue(identity)),
      });
      matches.set(key, values);
    }
  }
  return matches;
}

function validateEpisode(
  item: ReceiptBoundEvidence,
  episode: ResolvedEpisode,
  expectedScopeDigest: string,
  index: number,
  health: MutableHealth,
): boolean {
  if (
    !episode.episode.sourceRefs.includes(item.registration.id) ||
    episode.identity.sourceId !== item.registration.id ||
    episode.identity.episodeId !== item.record.episodeId ||
    episode.identity.registryRevision !== item.registration.registryRevision ||
    episode.identity.trustCeiling !== item.registration.trustCeiling
  ) {
    markHealth(
      health,
      "invalid",
      evidenceDiagnostic(
        "evidence.episode_identity_mismatch",
        "error",
        "episode record and resolved source identity do not match candidate evidence",
        ["evidenceIds", index],
      ),
    );
    return false;
  }
  if (candidateScopeDigest(episode.episode.scope) !== expectedScopeDigest) {
    markHealth(
      health,
      "invalid",
      evidenceDiagnostic(
        "evidence.scope_mismatch",
        "error",
        "candidate evidence episode does not have the exact candidate scope",
        ["evidenceIds", index],
      ),
    );
    return false;
  }
  return true;
}

function validateEpisodeReceipt(
  context: EngineContext,
  item: ReceiptBoundEvidence,
  episode: ResolvedEpisode,
  receipt: SourcePageReceipt,
  index: number,
  health: MutableHealth,
): boolean {
  const adapter = adapterFor(item.registration);
  const contentPolicy = context.contentPoliciesById.get(item.registration.contentPolicyId);
  // An episode may be projected on a different page, but it must belong to
  // the same registered source artifact/revision and exact loop configuration.
  if (
    receipt.state.status !== "available" ||
    item.receipt.state.status !== "available" ||
    receipt.sourceId !== item.registration.id ||
    receipt.sourceRegistrationRevision !== item.registration.registryRevision ||
    receipt.sourceRef !== item.receipt.sourceRef ||
    receipt.state.sourceRevision !== item.receipt.state.sourceRevision ||
    receipt.adapterVersion !== item.receipt.adapterVersion ||
    receipt.loopRegistryRevision !== item.receipt.loopRegistryRevision ||
    receipt.contentPolicyId !== item.receipt.contentPolicyId ||
    receipt.contentPolicyDigest !== item.receipt.contentPolicyDigest ||
    adapter === undefined ||
    adapter.descriptor.adapterVersion !== receipt.adapterVersion ||
    contentPolicy === undefined ||
    contentPolicy.digest !== receipt.contentPolicyDigest ||
    !episode.episode.sourceRefs.includes(receipt.sourceId)
  ) {
    markHealth(
      health,
      "invalid",
      evidenceDiagnostic(
        "evidence.episode_receipt_mismatch",
        "error",
        "episode derivative receipt does not match the evidence source and configuration",
        ["evidenceIds", index],
      ),
    );
    return false;
  }
  return true;
}

function pageIdentity(receipt: SourcePageReceipt): string {
  return canonicalJsonText([receipt.sourceId, receipt.sourceRegistrationRevision, receipt.sourceRef, receipt.pageRef]);
}

function findingIdentity(finding: EvidenceHealthFinding): string {
  return canonicalJsonText([finding.sourceId, finding.sourceRegistrationRevision, finding.sourceRef, finding.pageRef]);
}

async function foldReceiptHealth(
  context: EngineContext,
  receipts: readonly SourcePageReceipt[],
  health: MutableHealth,
): Promise<void> {
  const uniqueReceipts = new Map(receipts.map((receipt) => [receipt.id, receipt]));
  const pageIdentities = new Set([...uniqueReceipts.values()].map(pageIdentity));
  const findings = new Map<string, EvidenceHealthFinding>();

  for (const receipt of uniqueReceipts.values()) {
    if (receipt.state.status !== "available") {
      markHealth(
        health,
        "invalid",
        evidenceDiagnostic("evidence.receipt_unavailable", "error", "evidence receipt is not available"),
      );
    } else if (receipt.state.completeness !== "complete") {
      markHealth(
        health,
        "incomplete",
        evidenceDiagnostic("evidence.receipt_incomplete", "warning", "evidence receipt is not complete"),
      );
    }
    for (const findingId of receipt.healthFindingIds) {
      const stored = await loadStoredRecord(context, "evidence-health", findingId);
      if (stored === undefined) {
        markHealth(
          health,
          "invalid",
          evidenceDiagnostic(
            "evidence.health_missing",
            "error",
            "source page receipt references a missing evidence-health finding",
          ),
        );
        continue;
      }
      const finding = parseEvidenceHealthFinding(stored.value);
      if (finding.id !== stored.key.id) {
        throw invalid("store.corrupt", "stored evidence-health id does not match its key", ["id"]);
      }
      if (findingIdentity(finding) !== pageIdentity(receipt)) {
        markHealth(
          health,
          "invalid",
          evidenceDiagnostic(
            "evidence.health_mismatch",
            "error",
            "source page receipt references evidence health for another source page",
          ),
        );
        continue;
      }
      findings.set(finding.id, finding);
    }
  }

  // Findings created after the original page receipt still constrain current
  // use, so fold every durable finding for either evidence or episode page.
  for await (const page of iterateRecordPages(context.store, "evidence-health", { limit: SCAN_PAGE_LIMIT })) {
    for (const stored of page.records) {
      const finding = parseEvidenceHealthFinding(stored.value);
      if (finding.id !== stored.key.id) {
        throw invalid("store.corrupt", "stored evidence-health id does not match its key", ["id"]);
      }
      if (pageIdentities.has(findingIdentity(finding))) findings.set(finding.id, finding);
    }
  }

  for (const finding of findings.values()) {
    if (finding.effect === "blocks_use") {
      markHealth(
        health,
        "invalid",
        evidenceDiagnostic("evidence.health_blocks_use", "error", "current source health blocks evidence use"),
      );
    } else {
      markHealth(
        health,
        "incomplete",
        evidenceDiagnostic(
          "evidence.health_incomplete",
          "warning",
          "current source health limits evidence claims or audit use",
        ),
      );
    }
    if (finding.completeness !== "complete") {
      markHealth(
        health,
        "incomplete",
        evidenceDiagnostic("evidence.health_incomplete", "warning", "evidence-health finding is not complete"),
      );
    }
  }
}

async function foldDetectorReceiptHealth(
  context: EngineContext,
  receipts: readonly SourcePageReceipt[],
  health: MutableHealth,
): Promise<void> {
  const uniqueReceipts = new Map(receipts.map((receipt) => [receipt.id, receipt]));
  const pageIdentities = new Set([...uniqueReceipts.values()].map(pageIdentity));
  const requiredFindingReceipts = new Map<string, SourcePageReceipt[]>();
  const findings = new Map<string, EvidenceHealthFinding>();

  for (const receipt of uniqueReceipts.values()) {
    if (receipt.state.status !== "available") {
      markHealth(
        health,
        "invalid",
        evidenceDiagnostic("evidence.receipt_unavailable", "error", "evidence receipt is not available"),
      );
    } else if (receipt.state.completeness !== "complete") {
      markHealth(
        health,
        "incomplete",
        evidenceDiagnostic("evidence.receipt_incomplete", "warning", "evidence receipt is not complete"),
      );
    }
    for (const findingId of receipt.healthFindingIds) {
      const findingReceipts = requiredFindingReceipts.get(findingId) ?? [];
      findingReceipts.push(receipt);
      requiredFindingReceipts.set(findingId, findingReceipts);
    }
  }

  for await (const page of iterateRecordPages(context.store, "evidence-health", { limit: SCAN_PAGE_LIMIT })) {
    for (const stored of page.records) {
      const finding = parseEvidenceHealthFinding(stored.value);
      if (finding.id !== stored.key.id) {
        throw invalid("store.corrupt", "stored evidence-health id does not match its key", ["id"]);
      }
      const requiredReceipts = requiredFindingReceipts.get(finding.id) ?? [];
      if (requiredReceipts.some((receipt) => findingIdentity(finding) !== pageIdentity(receipt))) {
        markHealth(
          health,
          "invalid",
          evidenceDiagnostic(
            "evidence.health_mismatch",
            "error",
            "source page receipt references evidence health for another source page",
          ),
        );
        continue;
      }
      if (requiredReceipts.length > 0 || pageIdentities.has(findingIdentity(finding))) {
        findings.set(finding.id, finding);
      }
    }
  }

  for (const findingId of requiredFindingReceipts.keys()) {
    if (findings.has(findingId)) continue;
    markHealth(
      health,
      "invalid",
      evidenceDiagnostic(
        "evidence.health_missing",
        "error",
        "source page receipt references a missing evidence-health finding",
      ),
    );
  }
  for (const finding of findings.values()) {
    if (finding.effect === "blocks_use") {
      markHealth(
        health,
        "invalid",
        evidenceDiagnostic("evidence.health_blocks_use", "error", "current source health blocks evidence use"),
      );
    } else {
      markHealth(
        health,
        "incomplete",
        evidenceDiagnostic(
          "evidence.health_incomplete",
          "warning",
          "current source health limits evidence claims or audit use",
        ),
      );
    }
    if (finding.completeness !== "complete") {
      markHealth(
        health,
        "incomplete",
        evidenceDiagnostic("evidence.health_incomplete", "warning", "evidence-health finding is not complete"),
      );
    }
  }
}

function commonReferenceFields(
  item: FullyBoundEvidence,
): Omit<ObservationEvidenceRef, "schemaVersion" | "kind" | "referenceDigest"> {
  const provenance = item.record.provenance;
  const sourceRecordId = provenance.recordRef;
  if (sourceRecordId === undefined) {
    throw invalid("schema.corrupt", "resolved evidence has no source record reference", ["recordRef"]);
  }
  const episode = {
    sourceId: item.episode.identity.sourceId,
    episodeId: item.episode.identity.episodeId,
    episodeRecordId: item.episode.episode.id,
    episodeRecordDigest: item.episode.episodeDigest,
    episodeIdentityDigest: item.episode.identityDigest,
    pageReceiptId: item.episodeReceipt.id,
    pageReceiptDigest: item.episodeReceipt.receiptDigest,
    scopeDigest: candidateScopeDigest(item.episode.episode.scope),
  };
  return {
    recordId: item.record.id,
    recordDigest: item.digest,
    sourceId: provenance.sourceId,
    sourceRegistrationRevision: item.registration.registryRevision,
    sourceRef: provenance.sourceRef,
    sourceRevision: provenance.sourceRevision,
    sourceRecordId,
    pageRef: item.receipt.pageRef,
    pageReceiptId: item.receipt.id,
    pageReceiptDigest: item.receipt.receiptDigest,
    loopRegistryRevision: item.receipt.loopRegistryRevision,
    trust: provenance.trust,
    completeness: provenance.completeness,
    episode,
  };
}

function buildObservationEvidenceRef(item: FullyBoundEvidence): ObservationEvidenceRef {
  if (item.kind !== "observation") {
    throw invalid("schema.corrupt", "measurement cannot become an observation evidence reference", ["kind"]);
  }
  const common = commonReferenceFields(item);
  const bound = { kind: "observation" as const, ...common };
  const parsed = parseEvidenceRef({ schemaVersion: 1, ...bound, referenceDigest: evidenceRefDigest(bound) });
  if (parsed.schemaVersion !== 1 || parsed.kind !== "observation") {
    throw invalid("schema.corrupt", "observation evidence parser returned another reference kind", ["kind"]);
  }
  return { ...parsed, kind: "observation" };
}

function buildMeasurementEvidenceRef(
  item: FullyBoundEvidence,
  supportingEvidenceRefs: readonly ObservationEvidenceRef[],
): MeasurementEvidenceRefV2 {
  if (item.kind !== "measurement") {
    throw invalid("schema.corrupt", "observation cannot become a measurement evidence reference", ["kind"]);
  }
  const common = commonReferenceFields(item);
  const bound = {
    schemaVersion: 2 as const,
    kind: "measurement" as const,
    ...common,
    supportingEvidenceRefs,
  };
  const parsed = parseEvidenceRef({ ...bound, referenceDigest: evidenceRefDigest(bound) });
  if (parsed.schemaVersion !== 2 || parsed.kind !== "measurement") {
    throw invalid("schema.corrupt", "measurement evidence parser returned another reference kind", ["kind"]);
  }
  return parsed;
}

async function evidenceSnapshotRevision(context: EngineContext): Promise<string> {
  const revisions: Array<readonly [RecordKind, string]> = [];
  for (const kind of EVIDENCE_SNAPSHOT_KINDS) {
    revisions.push([kind, await readRecordKindRevision(context.store, kind)]);
  }
  return canonicalJsonText(revisions);
}

/** Resolves exact durable ids into immutable, receipt- and episode-bound refs. */
async function resolveCandidateEvidenceOnce(
  context: EngineContext,
  exactDurableIds: readonly string[],
  scope: Scope,
  options: ResolveOptions,
): Promise<CandidateEvidenceResolution> {
  const health: MutableHealth = { status: "ready", diagnostics: [] };
  const ids = validateExactIds(exactDurableIds, health);
  if (ids === undefined) return result([], [], health);
  const candidateScope = context.scopePolicy.validate(scope);
  const expectedScopeDigest = candidateScopeDigest(candidateScope);

  const loadedByIndex: Array<LoadedEvidence | undefined> = [];
  for (const [index, id] of ids.entries()) {
    loadedByIndex.push(await loadEvidenceRecord(context, id, index, health));
  }

  const evidenceReceiptKeys = new Set<string>();
  for (const loaded of loadedByIndex) {
    if (loaded !== undefined) evidenceReceiptKeys.add(derivativeKey(loaded.kind, loaded.record.id, loaded.digest));
  }
  const evidenceReceiptMatches = await findDerivativeReceipts(context, evidenceReceiptKeys);
  const receiptBoundByIndex: Array<ReceiptBoundEvidence | undefined> = [];
  for (const [index, loaded] of loadedByIndex.entries()) {
    if (loaded === undefined) {
      receiptBoundByIndex.push(undefined);
      continue;
    }
    const matches = evidenceReceiptMatches.get(derivativeKey(loaded.kind, loaded.record.id, loaded.digest)) ?? [];
    if (matches.length !== 1) {
      markHealth(
        health,
        "invalid",
        evidenceDiagnostic(
          matches.length === 0 ? "evidence.receipt_missing" : "evidence.receipt_ambiguous",
          "error",
          matches.length === 0
            ? "evidence record has no exact committed source page receipt"
            : "evidence record has more than one committed source page receipt",
          ["evidenceIds", index],
        ),
      );
      receiptBoundByIndex.push(undefined);
      continue;
    }
    const receipt = matches[0];
    if (receipt === undefined) {
      receiptBoundByIndex.push(undefined);
      continue;
    }
    const registration = configuredSource(context, loaded, receipt, index, health);
    receiptBoundByIndex.push(registration === undefined ? undefined : { ...loaded, receipt, registration });
  }

  const wantedEpisodes = new Set<string>();
  const wantedSources = new Set<string>();
  for (const item of receiptBoundByIndex) {
    if (item === undefined) continue;
    wantedEpisodes.add(logicalEpisodeKey(item.registration.id, item.record.episodeId));
    wantedSources.add(item.registration.id);
  }
  const episodeMatches = await findEpisodes(context, wantedEpisodes, wantedSources);
  const episodeBoundByIndex: Array<(ReceiptBoundEvidence & { readonly episode: ResolvedEpisode }) | undefined> = [];
  const episodeReceiptKeys = new Set<string>();
  for (const [index, item] of receiptBoundByIndex.entries()) {
    if (item === undefined) {
      episodeBoundByIndex.push(undefined);
      continue;
    }
    const matches = episodeMatches.get(logicalEpisodeKey(item.registration.id, item.record.episodeId)) ?? [];
    if (matches.length !== 1) {
      markHealth(
        health,
        "invalid",
        evidenceDiagnostic(
          matches.length === 0 ? "evidence.episode_missing" : "evidence.episode_ambiguous",
          "error",
          matches.length === 0
            ? "evidence does not resolve to one committed episode identity"
            : "evidence resolves to more than one episode identity",
          ["evidenceIds", index],
        ),
      );
      episodeBoundByIndex.push(undefined);
      continue;
    }
    const episode = matches[0];
    if (episode === undefined || !validateEpisode(item, episode, expectedScopeDigest, index, health)) {
      episodeBoundByIndex.push(undefined);
      continue;
    }
    episodeReceiptKeys.add(derivativeKey("episode", episode.episode.id, episode.episodeDigest));
    episodeBoundByIndex.push({ ...item, episode });
  }

  const episodeReceiptMatches = await findDerivativeReceipts(context, episodeReceiptKeys);
  const fullyBound: FullyBoundEvidence[] = [];
  for (const [index, item] of episodeBoundByIndex.entries()) {
    if (item === undefined) continue;
    const matches =
      episodeReceiptMatches.get(derivativeKey("episode", item.episode.episode.id, item.episode.episodeDigest)) ?? [];
    if (matches.length !== 1) {
      markHealth(
        health,
        "invalid",
        evidenceDiagnostic(
          matches.length === 0 ? "evidence.episode_receipt_missing" : "evidence.episode_receipt_ambiguous",
          "error",
          matches.length === 0
            ? "resolved episode has no exact committed source page receipt"
            : "resolved episode has more than one committed source page receipt",
          ["evidenceIds", index],
        ),
      );
      continue;
    }
    const episodeReceipt = matches[0];
    if (
      episodeReceipt === undefined ||
      !validateEpisodeReceipt(context, item, item.episode, episodeReceipt, index, health)
    ) {
      continue;
    }
    fullyBound.push({ ...item, episodeReceipt });
  }

  for (const item of fullyBound) {
    if (item.record.provenance.completeness !== "complete" || item.episode.identity.completeness !== "complete") {
      markHealth(
        health,
        "incomplete",
        evidenceDiagnostic("evidence.incomplete", "warning", "evidence or episode identity is not complete"),
      );
    }
  }
  await foldReceiptHealth(
    context,
    fullyBound.flatMap((item) => [item.receipt, item.episodeReceipt]),
    health,
  );

  const references: EvidenceRef[] = [];
  const records: EvidenceRecord[] = [];
  for (const item of fullyBound) {
    if (item.kind === "observation") {
      references.push(buildObservationEvidenceRef(item));
      records.push(item.record);
      continue;
    }
    if (!options.allowMeasurements) {
      markHealth(
        health,
        "invalid",
        evidenceDiagnostic(
          "evidence.ownership_mismatch",
          "error",
          "a measurement cannot support another measurement evidence reference",
        ),
      );
      continue;
    }
    const measurement = parseMeasurementRecord(toJsonValue(item.record));
    const supporting = await resolveCandidateEvidenceOnce(context, measurement.evidenceIds, scope, {
      allowMeasurements: false,
      requireOutcomeClaim: false,
    });
    mergeHealth(health, supporting.health);
    const supportingEvidenceRefs: ObservationEvidenceRef[] = [];
    let ownershipMatches = supporting.refs.length === measurement.evidenceIds.length;
    for (const [index, reference] of supporting.refs.entries()) {
      if (reference.schemaVersion !== 1 || reference.kind !== "observation") {
        ownershipMatches = false;
        continue;
      }
      if (
        reference.sourceId !== item.record.provenance.sourceId ||
        reference.sourceRegistrationRevision !== item.registration.registryRevision ||
        reference.sourceRef !== item.record.provenance.sourceRef ||
        reference.sourceRevision !== item.record.provenance.sourceRevision ||
        reference.loopRegistryRevision !== item.receipt.loopRegistryRevision ||
        reference.episode.episodeId !== item.record.episodeId ||
        reference.episode.episodeRecordId !== item.episode.episode.id
      ) {
        ownershipMatches = false;
      }
      supportingEvidenceRefs.push(parseObservationEvidenceRefAt(reference, ["supportingEvidenceRefs", index]));
    }
    if (
      supporting.health.status === "invalid" ||
      supporting.health.status === "legacy_unbound" ||
      !ownershipMatches ||
      supportingEvidenceRefs.length === 0 ||
      measurement.provenance.completeness !== worstCompleteness(supportingEvidenceRefs)
    ) {
      markHealth(
        health,
        "invalid",
        evidenceDiagnostic(
          "evidence.ownership_mismatch",
          "error",
          "measurement evidence does not bind exact same-source observations and completeness",
        ),
      );
      continue;
    }
    const reference = buildMeasurementEvidenceRef(item, supportingEvidenceRefs);
    if (options.requireOutcomeClaim) {
      const outcome = await loadLatestEpisodeOutcomeClaim(context, reference.episode.episodeRecordId);
      if (
        outcome.status !== "resolved" ||
        !outcome.latest.measurementRefs.some(
          (claimed) => canonicalJsonText(toJsonValue(claimed)) === canonicalJsonText(toJsonValue(reference)),
        )
      ) {
        markHealth(
          health,
          "invalid",
          evidenceDiagnostic(
            "evidence.outcome_unbound",
            "error",
            "measurement evidence is not bound by the latest episode outcome claim",
          ),
        );
        continue;
      }
    }
    references.push(reference);
    records.push(measurement);
  }

  return result(references, records, health);
}

async function resolveDetectorEvidenceOnce(
  context: EngineContext,
  exactInputs: readonly DetectorEvidenceInput[],
  scope: Scope,
): Promise<CandidateEvidenceResolution> {
  const health: MutableHealth = { status: "ready", diagnostics: [] };
  const inputs = validateDetectorInputs(exactInputs, health);
  if (inputs === undefined) return result([], [], health);
  const detectorScope = context.scopePolicy.validate(scope);
  const expectedScopeDigest = candidateScopeDigest(detectorScope);

  const loadedByIndex: Array<LoadedEvidence | undefined> = [];
  for (const [index, input] of inputs.entries()) {
    loadedByIndex.push(await loadDetectorEvidenceRecord(context, input, index, health));
  }

  const inputKindsById = new Map<string, EvidenceKind>();
  const aggregateIds = new Set<string>();
  for (const input of inputs) {
    const id = detectorInputRecordId(input);
    inputKindsById.set(id, input.kind);
    aggregateIds.add(id);
  }
  let duplicateSupport = false;
  let missingSupport = false;
  let emptySupport = false;
  for (const [index] of inputs.entries()) {
    const loaded = loadedByIndex[index];
    if (loaded === undefined || loaded.kind !== "measurement") continue;
    const measurement = parseMeasurementRecord(toJsonValue(loaded.record));
    const supportingIds = new Set<string>();
    if (measurement.evidenceIds.length === 0) emptySupport = true;
    for (const supportingId of measurement.evidenceIds) {
      aggregateIds.add(supportingId);
      if (supportingIds.has(supportingId)) duplicateSupport = true;
      supportingIds.add(supportingId);
      if (inputKindsById.get(supportingId) !== "observation") missingSupport = true;
    }
  }
  if (emptySupport) {
    markHealth(
      health,
      "invalid",
      evidenceDiagnostic(
        "evidence.ownership_mismatch",
        "error",
        "measurement evidence requires at least one disclosed supporting observation",
      ),
    );
  }
  if (duplicateSupport) {
    markHealth(
      health,
      "invalid",
      evidenceDiagnostic(
        "evidence.ownership_mismatch",
        "error",
        "measurement supporting observation ids must be unique",
      ),
    );
  }
  if (missingSupport) {
    markHealth(
      health,
      "invalid",
      evidenceDiagnostic(
        "evidence.support_outside_window",
        "error",
        "measurement support must be an observation in the exact detector window",
      ),
    );
  }
  if (aggregateIds.size > MAX_DETECTOR_EVIDENCE_IDS) {
    markHealth(
      health,
      "invalid",
      evidenceDiagnostic(
        "evidence.ids_invalid",
        "error",
        `detector evidence and support exceed the ${MAX_DETECTOR_EVIDENCE_IDS}-record ceiling`,
      ),
    );
  }
  if (health.status === "invalid") return result([], [], health);

  const wantedEpisodes = new Set<string>();
  const wantedSources = new Set<string>();
  for (const loaded of loadedByIndex) {
    if (loaded === undefined) continue;
    wantedEpisodes.add(logicalEpisodeKey(loaded.record.provenance.sourceId, loaded.record.episodeId));
    wantedSources.add(loaded.record.provenance.sourceId);
  }
  const episodeMatches = await findEpisodes(context, wantedEpisodes, wantedSources);
  const derivativeKeys = new Set<string>();
  for (const loaded of loadedByIndex) {
    if (loaded !== undefined) derivativeKeys.add(derivativeKey(loaded.kind, loaded.record.id, loaded.digest));
  }
  for (const matches of episodeMatches.values()) {
    for (const episode of matches) {
      derivativeKeys.add(derivativeKey("episode", episode.episode.id, episode.episodeDigest));
    }
  }
  const receiptMatches = await findDerivativeReceipts(context, derivativeKeys);
  const registrationsById = new Map([...context.sources].map((registration) => [registration.id, registration]));
  const fullyBoundByIndex: Array<FullyBoundEvidence | undefined> = [];
  for (const [index, loaded] of loadedByIndex.entries()) {
    if (loaded === undefined) {
      fullyBoundByIndex.push(undefined);
      continue;
    }
    const evidenceReceipts = receiptMatches.get(derivativeKey(loaded.kind, loaded.record.id, loaded.digest)) ?? [];
    if (evidenceReceipts.length !== 1) {
      markHealth(
        health,
        "invalid",
        evidenceDiagnostic(
          evidenceReceipts.length === 0 ? "evidence.receipt_missing" : "evidence.receipt_ambiguous",
          "error",
          evidenceReceipts.length === 0
            ? "evidence record has no exact committed source page receipt"
            : "evidence record has more than one committed source page receipt",
          ["evidenceIds", index],
        ),
      );
      fullyBoundByIndex.push(undefined);
      continue;
    }
    const receipt = evidenceReceipts[0];
    if (receipt === undefined) {
      fullyBoundByIndex.push(undefined);
      continue;
    }
    const registration = configuredSource(context, loaded, receipt, index, health, registrationsById);
    if (registration === undefined) {
      fullyBoundByIndex.push(undefined);
      continue;
    }
    const receiptBound: ReceiptBoundEvidence = { ...loaded, receipt, registration };
    const episodes = episodeMatches.get(logicalEpisodeKey(registration.id, loaded.record.episodeId)) ?? [];
    if (episodes.length !== 1) {
      markHealth(
        health,
        "invalid",
        evidenceDiagnostic(
          episodes.length === 0 ? "evidence.episode_missing" : "evidence.episode_ambiguous",
          "error",
          episodes.length === 0
            ? "evidence does not resolve to one committed episode identity"
            : "evidence resolves to more than one episode identity",
          ["evidenceIds", index],
        ),
      );
      fullyBoundByIndex.push(undefined);
      continue;
    }
    const episode = episodes[0];
    if (episode === undefined || !validateEpisode(receiptBound, episode, expectedScopeDigest, index, health)) {
      fullyBoundByIndex.push(undefined);
      continue;
    }
    const episodeReceipts =
      receiptMatches.get(derivativeKey("episode", episode.episode.id, episode.episodeDigest)) ?? [];
    if (episodeReceipts.length !== 1) {
      markHealth(
        health,
        "invalid",
        evidenceDiagnostic(
          episodeReceipts.length === 0 ? "evidence.episode_receipt_missing" : "evidence.episode_receipt_ambiguous",
          "error",
          episodeReceipts.length === 0
            ? "resolved episode has no exact committed source page receipt"
            : "resolved episode has more than one committed source page receipt",
          ["evidenceIds", index],
        ),
      );
      fullyBoundByIndex.push(undefined);
      continue;
    }
    const episodeReceipt = episodeReceipts[0];
    if (
      episodeReceipt === undefined ||
      !validateEpisodeReceipt(context, receiptBound, episode, episodeReceipt, index, health)
    ) {
      fullyBoundByIndex.push(undefined);
      continue;
    }
    fullyBoundByIndex.push({ ...receiptBound, episode, episodeReceipt });
  }

  const fullyBound = fullyBoundByIndex.flatMap((item) => (item === undefined ? [] : [item]));
  for (const item of fullyBound) {
    if (item.record.provenance.completeness !== "complete" || item.episode.identity.completeness !== "complete") {
      markHealth(
        health,
        "incomplete",
        evidenceDiagnostic("evidence.incomplete", "warning", "evidence or episode identity is not complete"),
      );
    }
  }
  await foldDetectorReceiptHealth(
    context,
    fullyBound.flatMap((item) => [item.receipt, item.episodeReceipt]),
    health,
  );

  const observationRefsById = new Map<string, ObservationEvidenceRef>();
  for (const item of fullyBound) {
    if (item.kind === "observation") observationRefsById.set(item.record.id, buildObservationEvidenceRef(item));
  }
  const outcomeMeasurementRefsByEpisode = new Map<string, ReadonlySet<string> | undefined>();
  const references: EvidenceRef[] = [];
  const records: EvidenceRecord[] = [];
  for (const item of fullyBoundByIndex) {
    if (item === undefined) continue;
    if (item.kind === "observation") {
      const reference = observationRefsById.get(item.record.id);
      if (reference !== undefined) {
        references.push(reference);
        records.push(item.record);
      }
      continue;
    }
    const measurement = parseMeasurementRecord(toJsonValue(item.record));
    const supportingEvidenceRefs: ObservationEvidenceRef[] = [];
    let ownershipMatches = measurement.evidenceIds.length > 0;
    for (const supportingId of measurement.evidenceIds) {
      const reference = observationRefsById.get(supportingId);
      if (reference === undefined) {
        ownershipMatches = false;
        continue;
      }
      if (
        reference.sourceId !== item.record.provenance.sourceId ||
        reference.sourceRegistrationRevision !== item.registration.registryRevision ||
        reference.sourceRef !== item.record.provenance.sourceRef ||
        reference.sourceRevision !== item.record.provenance.sourceRevision ||
        reference.loopRegistryRevision !== item.receipt.loopRegistryRevision ||
        reference.episode.episodeId !== item.record.episodeId ||
        reference.episode.episodeRecordId !== item.episode.episode.id
      ) {
        ownershipMatches = false;
      }
      supportingEvidenceRefs.push(reference);
    }
    if (
      !ownershipMatches ||
      supportingEvidenceRefs.length !== measurement.evidenceIds.length ||
      measurement.provenance.completeness !== worstCompleteness(supportingEvidenceRefs)
    ) {
      markHealth(
        health,
        "invalid",
        evidenceDiagnostic(
          "evidence.ownership_mismatch",
          "error",
          "measurement evidence does not bind exact same-source observations and completeness",
        ),
      );
      continue;
    }
    const reference = buildMeasurementEvidenceRef(item, supportingEvidenceRefs);
    const episodeRecordId = reference.episode.episodeRecordId;
    let claimedMeasurements = outcomeMeasurementRefsByEpisode.get(episodeRecordId);
    if (!outcomeMeasurementRefsByEpisode.has(episodeRecordId)) {
      const outcome = await loadLatestEpisodeOutcomeClaim(context, episodeRecordId);
      claimedMeasurements =
        outcome.status === "resolved"
          ? new Set(outcome.latest.measurementRefs.map((claimed) => canonicalJsonText(toJsonValue(claimed))))
          : undefined;
      outcomeMeasurementRefsByEpisode.set(episodeRecordId, claimedMeasurements);
    }
    if (claimedMeasurements === undefined || !claimedMeasurements.has(canonicalJsonText(toJsonValue(reference)))) {
      markHealth(
        health,
        "invalid",
        evidenceDiagnostic(
          "evidence.outcome_unbound",
          "error",
          "measurement evidence is not bound by the latest episode outcome claim",
        ),
      );
      continue;
    }
    references.push(reference);
    records.push(measurement);
  }

  return result(references, records, health);
}

/**
 * Retries the composite read unless every evidence-bearing namespace retained
 * one stable revision across the full record/receipt/identity/health fold.
 */
async function resolveEvidenceWithOptions(
  context: EngineContext,
  exactDurableIds: readonly string[],
  scope: Scope,
  options: ResolveOptions,
): Promise<CandidateEvidenceResolution> {
  for (let attempt = 0; attempt < MAX_SNAPSHOT_ATTEMPTS; attempt += 1) {
    const before = await evidenceSnapshotRevision(context);
    const resolved = await resolveCandidateEvidenceOnce(context, exactDurableIds, scope, options);
    const after = await evidenceSnapshotRevision(context);
    if (before === after) return resolved;
  }
  throw new LearningLoopError("evidence.snapshot_changed", [
    {
      code: "evidence.snapshot_changed",
      severity: "error",
      message: "evidence changed repeatedly while resolving candidate lineage; retry the operation",
    },
  ]);
}

export function resolveCandidateEvidence(
  context: EngineContext,
  exactDurableIds: readonly string[],
  scope: Scope,
): Promise<CandidateEvidenceResolution> {
  return resolveEvidenceWithOptions(context, exactDurableIds, scope, {
    allowMeasurements: true,
    requireOutcomeClaim: true,
  });
}

/**
 * Internal detector/window path. Unlike Candidate evidence resolution, this
 * binds the complete disclosed window as one batch and never recursively
 * loads measurement support that was absent from that window.
 */
export async function resolveDetectorEvidence(
  context: EngineContext,
  exactInputs: readonly DetectorEvidenceInput[],
  scope: Scope,
): Promise<CandidateEvidenceResolution> {
  const preflightHealth: MutableHealth = { status: "ready", diagnostics: [] };
  if (validateDetectorInputs(exactInputs, preflightHealth) === undefined) {
    return result([], [], preflightHealth);
  }
  for (let attempt = 0; attempt < MAX_SNAPSHOT_ATTEMPTS; attempt += 1) {
    const before = await evidenceSnapshotRevision(context);
    const resolved = await resolveDetectorEvidenceOnce(context, exactInputs, scope);
    const after = await evidenceSnapshotRevision(context);
    if (before === after) return resolved;
  }
  throw new LearningLoopError("evidence.snapshot_changed", [
    {
      code: "evidence.snapshot_changed",
      severity: "error",
      message: "evidence changed repeatedly while resolving detector lineage; retry the operation",
    },
  ]);
}

/** Internal outcome-ingest path: mint exact measurement refs before the claim exists. */
export function resolveOutcomeMeasurementEvidence(
  context: EngineContext,
  exactDurableIds: readonly string[],
  scope: Scope,
): Promise<CandidateEvidenceResolution> {
  return resolveEvidenceWithOptions(context, exactDurableIds, scope, {
    allowMeasurements: true,
    requireOutcomeClaim: false,
  });
}

/** Revalidates every embedded v2 reference; v1 candidates remain unbound. */
export async function revalidateCandidateEvidence(
  context: EngineContext,
  candidate: Candidate,
): Promise<CandidateEvidenceResolution> {
  if (candidate.schemaVersion === 1) {
    return {
      refs: [],
      records: [],
      health: {
        status: "legacy_unbound",
        diagnostics: [
          evidenceDiagnostic(
            "candidate.legacy_unbound",
            "warning",
            "schema-version-1 candidate has no content-bound evidence references",
          ),
        ],
      },
    };
  }
  if (candidate.evidenceRefs.length === 0 && candidate.derivationRef !== undefined) {
    return { refs: [], records: [], health: { status: "ready", diagnostics: [] } };
  }

  const resolved = await resolveCandidateEvidence(
    context,
    candidate.evidenceRefs.map((reference) => reference.recordId),
    candidate.scope,
  );
  const health: MutableHealth = {
    status:
      resolved.health.status === "ready" ? "ready" : resolved.health.status === "incomplete" ? "incomplete" : "invalid",
    diagnostics: [...resolved.health.diagnostics],
  };
  for (const [index, embedded] of candidate.evidenceRefs.entries()) {
    const current = resolved.refs[index];
    if (
      current === undefined ||
      current.referenceDigest !== embedded.referenceDigest ||
      canonicalJsonText(toJsonValue(current)) !== canonicalJsonText(toJsonValue(embedded))
    ) {
      markHealth(
        health,
        "invalid",
        evidenceDiagnostic(
          "evidence.reference_mismatch",
          "error",
          "embedded evidence reference does not match current durable evidence lineage",
          ["evidenceRefs", index],
        ),
      );
    }
  }
  return result(resolved.refs, resolved.records, health);
}
