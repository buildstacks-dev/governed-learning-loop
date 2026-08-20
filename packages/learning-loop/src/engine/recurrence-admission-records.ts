// Private serialized Candidate admission for one exact recurrence group.
import { Buffer } from "node:buffer";
import { canonicalJsonText, sha256HexOfCanonicalJson } from "../canonical/canonical-json.js";
import { toJsonValue } from "../canonical/to-json-value.js";
import { LearningLoopError } from "../diagnostics.js";
import type { StreamEntry } from "../ports/store.js";
import type { CandidateV2 } from "../records/candidate.js";
import { parseCandidate } from "../records/candidate.js";
import type { DetectorPackRunGroupGovernance } from "../records/detector-pack-run-receipt.js";
import {
  classifyAssessedRecurrenceGovernance,
  parseDetectorPackRunGroupGovernance,
} from "../records/detector-pack-run-receipt.js";
import type { DetectorOrchestrationPolicy } from "../records/detector-orchestration-policy.js";
import { parseDetectorOrchestrationPolicy } from "../records/detector-orchestration-policy.js";
import { invalid, parseOneOf, readFields } from "../parse/toolkit.js";
import type { Parse } from "../parse/toolkit.js";
import {
  assertSortedUnique,
  canonicalKey,
  parseBoundedArray,
  parseDigestAt,
  parseDurableId,
  parseNullable,
} from "../records/semantic-shared.js";
import type { CandidateContentLock } from "./candidate-content-lock.js";
import { candidateContentLockDigest, loadCandidateContentLock } from "./candidate-content-lock.js";
import type { EngineContext } from "./context.js";
import { createOnly, loadStoredRecord, parseWriteResult, recordDigest, recordKey } from "./context.js";
import type { CandidateRecurrenceClaim } from "./recurrence-claims.js";
import { loadCandidateRecurrenceLineage, parseCandidateRecurrenceClaim } from "./recurrence-claims.js";
import { loadCandidateReviewMarker } from "./candidate-review-index.js";

export const MAX_ADMISSION_SLOTS = 5_000;
const MAX_GROUP_MEMBERS = 5_000;
const MAX_GROUP_EPISODES = 5_000;
export const MAX_ADMISSION_RECORD_BYTES = 64 * 1_048_576;

export type CandidateClaimRef = {
  readonly candidateId: string;
  readonly candidateDigest: string;
  readonly claimDigest: string;
};

type AssessedGovernance = Extract<DetectorPackRunGroupGovernance, { readonly status: "assessed" }>;
export type GroupedCandidateClaim = Extract<CandidateRecurrenceClaim, { readonly status: "grouped" }>;
type GroupMemberSnapshot = {
  readonly executionId: string;
  readonly executionKeyDigest: string;
  readonly executionDigest: string;
  readonly decisionBindingDigest: string;
  readonly memberDigest: string;
};

export interface CandidateAdmissionSnapshot {
  readonly schemaVersion: 1;
  readonly loopRegistryRevision: string;
  readonly policy: DetectorOrchestrationPolicy;
  readonly groupKeyDigest: string;
  readonly scopeDigest: string;
  readonly admissionStreamSnapshotDigest: string;
  readonly groupMembers: readonly GroupMemberSnapshot[];
  readonly groupMemberSnapshotDigest: string;
  readonly executionCount: number;
  readonly episodeIdentityDigests: readonly string[];
  readonly episodeIdentitySetDigest: string;
  readonly distinctEpisodeCount: number;
  readonly assessment:
    | { readonly status: "assessed"; readonly governance: AssessedGovernance }
    | { readonly status: "historical_supersession"; readonly predecessor: CandidateClaimRef };
  readonly snapshotDigest: string;
}

export interface CandidateAdmissionReservation {
  readonly schemaVersion: 1;
  readonly reservationKeyDigest: string;
  readonly reservationDigest: string;
  readonly candidateId: string;
  readonly candidateDigest: string;
  readonly candidateClaimDigest: string;
  readonly candidateContentLockDigest: string;
  readonly groupKeyDigest: string;
  readonly scopeDigest: string;
  readonly policyDigest: string;
  readonly snapshotDigest: string;
  readonly basis: "group_available" | "required_supersession" | "rejection_override" | "historical_supersession";
  readonly requiredSupersedes: CandidateClaimRef | null;
  readonly candidate: CandidateV2;
  readonly candidateClaim: GroupedCandidateClaim;
}

export interface CandidateAdmissionBinding {
  readonly schemaVersion: 1;
  readonly candidateId: string;
  readonly candidateDigest: string;
  readonly candidateClaimDigest: string;
  readonly candidateContentLockDigest: string;
  readonly groupKeyDigest: string;
  readonly scopeDigest: string;
  readonly policyDigest: string;
  readonly snapshotDigest: string;
  readonly reservationKeyDigest: string;
  readonly reservationDigest: string;
  readonly bindingDigest: string;
}

interface AdmissionSlotValue {
  readonly schemaVersion: 1;
  readonly reservationKeyDigest: string;
  readonly reservationDigest: string;
  readonly snapshotDigest: string;
  readonly slotDigest: string;
}

export interface StoredAdmissionSlot {
  readonly id: string;
  readonly digest: string;
  readonly value: AdmissionSlotValue;
}

export interface CandidateAdmissionStreamState {
  readonly slots: readonly StoredAdmissionSlot[];
  readonly revision?: string;
  readonly snapshotDigest: string;
}

function digest(input: unknown): string {
  return sha256HexOfCanonicalJson(toJsonValue(input));
}

function parseCount(maximum: number, label: string): Parse<number> {
  return (input, path) => {
    if (!Number.isSafeInteger(input) || typeof input !== "number" || input < 0 || input > maximum) {
      throw invalid("schema.invalid", `${label} is outside its bounded range`, path);
    }
    return input;
  };
}

const parseCandidateClaimRefAt: Parse<CandidateClaimRef> = (input, path) => {
  const fields = readFields(input, path);
  return {
    candidateId: fields.req("candidateId", parseDurableId),
    candidateDigest: fields.req("candidateDigest", parseDigestAt),
    claimDigest: fields.req("claimDigest", parseDigestAt),
  };
};

const parseGroupMemberAt: Parse<GroupMemberSnapshot> = (input, path) => {
  const fields = readFields(input, path);
  const member = {
    executionId: fields.req("executionId", parseDurableId),
    executionKeyDigest: fields.req("executionKeyDigest", parseDigestAt),
    executionDigest: fields.req("executionDigest", parseDigestAt),
    decisionBindingDigest: fields.req("decisionBindingDigest", parseDigestAt),
    memberDigest: fields.req("memberDigest", parseDigestAt),
  };
  if (member.executionId !== `detector-execution-${member.executionKeyDigest}`) {
    throw invalid("schema.corrupt", "Candidate admission member execution id is mismatched", path);
  }
  return member;
};

function snapshotBase(snapshot: Omit<CandidateAdmissionSnapshot, "schemaVersion" | "snapshotDigest">): unknown {
  return snapshot;
}

export function candidateAdmissionSnapshotDigest(
  snapshot: Omit<CandidateAdmissionSnapshot, "schemaVersion" | "snapshotDigest">,
): string {
  return digest(snapshotBase(snapshot));
}

export function parseCandidateAdmissionSnapshot(input: unknown): CandidateAdmissionSnapshot {
  const snapshotValue = toJsonValue(input);
  if (Buffer.byteLength(canonicalJsonText(snapshotValue), "utf8") > MAX_ADMISSION_RECORD_BYTES) {
    throw invalid("schema.invalid", "Candidate admission snapshot exceeds its canonical byte ceiling", []);
  }
  const fields = readFields(snapshotValue, []);
  const schemaVersion = fields.schemaVersion1();
  const policy = fields.req("policy", parseDetectorOrchestrationPolicy);
  const groupMembers = fields.req(
    "groupMembers",
    parseBoundedArray(parseGroupMemberAt, MAX_GROUP_MEMBERS, "admission group members"),
  );
  assertSortedUnique(groupMembers, (member) => member.executionId, ["groupMembers"]);
  const groupMemberSnapshotDigest = fields.req("groupMemberSnapshotDigest", parseDigestAt);
  if (groupMemberSnapshotDigest !== digest(groupMembers)) {
    throw invalid("schema.corrupt", "Candidate admission group-member snapshot is mismatched", []);
  }
  const executionCount = fields.req("executionCount", parseCount(MAX_GROUP_MEMBERS, "execution count"));
  if (executionCount !== groupMembers.length || executionCount === 0) {
    throw invalid("schema.corrupt", "Candidate admission execution count is mismatched", []);
  }
  const episodeIdentityDigests = fields.req(
    "episodeIdentityDigests",
    parseBoundedArray(parseDigestAt, MAX_GROUP_EPISODES, "admission episode identities"),
  );
  assertSortedUnique(episodeIdentityDigests, (value) => value, ["episodeIdentityDigests"]);
  const distinctEpisodeCount = fields.req(
    "distinctEpisodeCount",
    parseCount(MAX_GROUP_EPISODES, "distinct episode count"),
  );
  if (distinctEpisodeCount !== episodeIdentityDigests.length || distinctEpisodeCount === 0) {
    throw invalid("schema.corrupt", "Candidate admission distinct-episode count is mismatched", []);
  }
  const episodeIdentitySetDigest = fields.req("episodeIdentitySetDigest", parseDigestAt);
  if (episodeIdentitySetDigest !== digest(episodeIdentityDigests)) {
    throw invalid("schema.corrupt", "Candidate admission episode-set digest is mismatched", []);
  }
  const assessment = fields.req("assessment", (value, path): CandidateAdmissionSnapshot["assessment"] => {
    const nested = readFields(value, path);
    const status = nested.req("status", parseOneOf(["assessed", "historical_supersession"]));
    if (status === "historical_supersession") {
      return { status: "historical_supersession", predecessor: nested.req("predecessor", parseCandidateClaimRefAt) };
    }
    const governance = nested.req("governance", parseDetectorPackRunGroupGovernance);
    if (governance.status !== "assessed" || governance.groupDisposition === "capped") {
      throw invalid("schema.corrupt", "Candidate admission requires uncapped assessed governance", path);
    }
    const expected = classifyAssessedRecurrenceGovernance({
      policy,
      currentDistinctEpisodeCount: distinctEpisodeCount,
      candidateBindings: governance.candidateBindings,
    });
    if (canonicalKey(expected) !== canonicalKey(governance)) {
      throw invalid("schema.corrupt", "Candidate admission assessment violates its exact policy", path);
    }
    return { status: "assessed", governance };
  });
  const base: Omit<CandidateAdmissionSnapshot, "schemaVersion" | "snapshotDigest"> = {
    loopRegistryRevision: fields.req("loopRegistryRevision", parseDigestAt),
    policy,
    groupKeyDigest: fields.req("groupKeyDigest", parseDigestAt),
    scopeDigest: fields.req("scopeDigest", parseDigestAt),
    admissionStreamSnapshotDigest: fields.req("admissionStreamSnapshotDigest", parseDigestAt),
    groupMembers,
    groupMemberSnapshotDigest,
    executionCount,
    episodeIdentityDigests,
    episodeIdentitySetDigest,
    distinctEpisodeCount,
    assessment,
  };
  const snapshotDigest = fields.req("snapshotDigest", parseDigestAt);
  if (snapshotDigest !== candidateAdmissionSnapshotDigest(base)) {
    throw invalid("schema.corrupt", "Candidate admission snapshot digest is mismatched", []);
  }
  return { schemaVersion, ...base, snapshotDigest };
}

function reservationKeyContent(reservation: { readonly snapshot: CandidateAdmissionSnapshot }): unknown {
  return {
    domain: "candidate-recurrence-admission-slot:v1",
    loopRegistryRevision: reservation.snapshot.loopRegistryRevision,
    policyDigest: reservation.snapshot.policy.policyDigest,
    groupKeyDigest: reservation.snapshot.groupKeyDigest,
    scopeDigest: reservation.snapshot.scopeDigest,
    admissionStreamSnapshotDigest: reservation.snapshot.admissionStreamSnapshotDigest,
    snapshotDigest: reservation.snapshot.snapshotDigest,
  };
}

export function candidateAdmissionReservationKeyDigest(snapshot: CandidateAdmissionSnapshot): string {
  return digest(reservationKeyContent({ snapshot }));
}

function reservationBase(
  reservation: Omit<CandidateAdmissionReservation, "schemaVersion" | "reservationDigest">,
): unknown {
  return reservation;
}

export function candidateAdmissionReservationDigest(
  reservation: Omit<CandidateAdmissionReservation, "schemaVersion" | "reservationDigest">,
): string {
  return digest(reservationBase(reservation));
}

export function parseCandidateAdmissionReservation(input: unknown): CandidateAdmissionReservation {
  const reservationValue = toJsonValue(input);
  if (Buffer.byteLength(canonicalJsonText(reservationValue), "utf8") > MAX_ADMISSION_RECORD_BYTES) {
    throw invalid("schema.invalid", "Candidate admission reservation exceeds its canonical byte ceiling", []);
  }
  const fields = readFields(reservationValue, []);
  const schemaVersion = fields.schemaVersion1();
  const candidate = fields.req("candidate", (value) => {
    const parsed = parseCandidate(value);
    if (parsed.schemaVersion !== 2) throw invalid("schema.corrupt", "admission embeds legacy Candidate bytes", []);
    return parsed;
  });
  const candidateClaim = fields.req("candidateClaim", (value) => {
    const parsed = parseCandidateRecurrenceClaim(value);
    if (parsed.status !== "grouped") throw invalid("schema.corrupt", "admission requires grouped recurrence", []);
    return parsed;
  });
  const base: Omit<CandidateAdmissionReservation, "schemaVersion" | "reservationDigest"> = {
    reservationKeyDigest: fields.req("reservationKeyDigest", parseDigestAt),
    candidateId: fields.req("candidateId", parseDurableId),
    candidateDigest: fields.req("candidateDigest", parseDigestAt),
    candidateClaimDigest: fields.req("candidateClaimDigest", parseDigestAt),
    candidateContentLockDigest: fields.req("candidateContentLockDigest", parseDigestAt),
    groupKeyDigest: fields.req("groupKeyDigest", parseDigestAt),
    scopeDigest: fields.req("scopeDigest", parseDigestAt),
    policyDigest: fields.req("policyDigest", parseDigestAt),
    snapshotDigest: fields.req("snapshotDigest", parseDigestAt),
    basis: fields.req(
      "basis",
      parseOneOf(["group_available", "required_supersession", "rejection_override", "historical_supersession"]),
    ),
    requiredSupersedes: fields.req("requiredSupersedes", parseNullable(parseCandidateClaimRefAt)),
    candidate,
    candidateClaim,
  };
  if (
    candidate.id !== base.candidateId ||
    candidate.contentDigest !== base.candidateDigest ||
    candidateClaim.candidateId !== base.candidateId ||
    candidateClaim.candidateDigest !== base.candidateDigest ||
    candidateClaim.claimDigest !== base.candidateClaimDigest ||
    candidateClaim.groupKeyDigest !== base.groupKeyDigest ||
    candidateClaim.scopeDigest !== base.scopeDigest ||
    recordDigest(toJsonValue(candidateClaim.candidate)) !== recordDigest(toJsonValue(candidate)) ||
    (base.requiredSupersedes === null) !== (candidateClaim.supersedes === null) ||
    (base.requiredSupersedes !== null &&
      recordDigest(toJsonValue(base.requiredSupersedes)) !== recordDigest(toJsonValue(candidateClaim.supersedes))) ||
    (base.basis === "group_available" && base.requiredSupersedes !== null) ||
    (base.basis !== "group_available" && base.requiredSupersedes === null)
  ) {
    throw invalid("schema.corrupt", "Candidate admission reservation lineage is mismatched", []);
  }
  const reservationDigest = fields.req("reservationDigest", parseDigestAt);
  if (reservationDigest !== candidateAdmissionReservationDigest(base)) {
    throw invalid("schema.corrupt", "Candidate admission reservation digest is mismatched", []);
  }
  return { schemaVersion, ...base, reservationDigest };
}

function bindingBase(binding: Omit<CandidateAdmissionBinding, "schemaVersion" | "bindingDigest">): unknown {
  return binding;
}

export function candidateAdmissionBindingDigest(
  binding: Omit<CandidateAdmissionBinding, "schemaVersion" | "bindingDigest">,
): string {
  return digest(bindingBase(binding));
}

export function parseCandidateAdmissionBinding(input: unknown): CandidateAdmissionBinding {
  const fields = readFields(toJsonValue(input), []);
  const schemaVersion = fields.schemaVersion1();
  const base = {
    candidateId: fields.req("candidateId", parseDurableId),
    candidateDigest: fields.req("candidateDigest", parseDigestAt),
    candidateClaimDigest: fields.req("candidateClaimDigest", parseDigestAt),
    candidateContentLockDigest: fields.req("candidateContentLockDigest", parseDigestAt),
    groupKeyDigest: fields.req("groupKeyDigest", parseDigestAt),
    scopeDigest: fields.req("scopeDigest", parseDigestAt),
    policyDigest: fields.req("policyDigest", parseDigestAt),
    snapshotDigest: fields.req("snapshotDigest", parseDigestAt),
    reservationKeyDigest: fields.req("reservationKeyDigest", parseDigestAt),
    reservationDigest: fields.req("reservationDigest", parseDigestAt),
  };
  const bindingDigest = fields.req("bindingDigest", parseDigestAt);
  if (bindingDigest !== candidateAdmissionBindingDigest(base)) {
    throw invalid("schema.corrupt", "Candidate admission binding digest is mismatched", []);
  }
  return { schemaVersion, ...base, bindingDigest };
}

function slotBase(slot: Omit<AdmissionSlotValue, "schemaVersion" | "slotDigest">): unknown {
  return slot;
}

function parseSlotValueAt(input: unknown, path: readonly (string | number)[]): AdmissionSlotValue {
  const fields = readFields(input, path);
  const schemaVersion = fields.schemaVersion1();
  const base = {
    reservationKeyDigest: fields.req("reservationKeyDigest", parseDigestAt),
    reservationDigest: fields.req("reservationDigest", parseDigestAt),
    snapshotDigest: fields.req("snapshotDigest", parseDigestAt),
  };
  const slotDigest = fields.req("slotDigest", parseDigestAt);
  if (slotDigest !== digest(slotBase(base))) throw invalid("store.corrupt", "admission slot digest is invalid", path);
  return { schemaVersion, ...base, slotDigest };
}

function parseSlotAt(input: unknown, path: readonly (string | number)[]): StoredAdmissionSlot {
  const fields = readFields(input, path);
  const value = fields.req("value", parseSlotValueAt);
  const id = fields.req("id", parseDurableId);
  const exactDigest = fields.req("digest", parseDigestAt);
  if (id !== `slot:${value.reservationKeyDigest}` || exactDigest !== recordDigest(toJsonValue(value))) {
    throw invalid("store.corrupt", "Candidate admission slot entry is mismatched", path);
  }
  return { id, digest: exactDigest, value };
}

function parseSlots(input: unknown): readonly StoredAdmissionSlot[] {
  if (!Array.isArray(input)) throw invalid("store.corrupt", "Candidate admission stream must be an array", []);
  if (input.length > MAX_ADMISSION_SLOTS) {
    throw new LearningLoopError("detector.limit_exceeded", [
      { code: "detector.limit_exceeded", severity: "error", message: "Candidate admission stream is at capacity" },
    ]);
  }
  const slots = input.map((value: unknown, index: number) => parseSlotAt(value, ["admission", index]));
  const ids = new Set<string>();
  for (const slot of slots) {
    if (ids.has(slot.id)) throw invalid("store.corrupt", "Candidate admission stream contains a duplicate slot", []);
    ids.add(slot.id);
  }
  return slots;
}

export function streamSnapshotDigest(slots: readonly StoredAdmissionSlot[]): string {
  let head = digest({ domain: "candidate-recurrence-admission-head:v1", previous: null });
  for (const slot of slots) head = nextStreamSnapshotDigest(head, slot);
  return head;
}

export function nextStreamSnapshotDigest(previous: string, slot: StoredAdmissionSlot): string {
  return digest({
    domain: "candidate-recurrence-admission-head:v1",
    previous,
    slot: { id: slot.id, digest: slot.digest, value: slot.value },
  });
}

export async function loadCandidateAdmissionStream(
  context: EngineContext,
  groupKeyDigest: string,
): Promise<CandidateAdmissionStreamState> {
  const stored = await loadStoredRecord(context, "candidate-recurrence-admission", groupKeyDigest);
  if (
    stored !== undefined &&
    Buffer.byteLength(canonicalJsonText(toJsonValue(stored.value)), "utf8") > MAX_ADMISSION_RECORD_BYTES
  ) {
    throw new LearningLoopError("candidate.admission_limit", [
      {
        code: "candidate.admission_limit",
        severity: "error",
        message: "Candidate recurrence admission stream exceeds its byte ceiling",
      },
    ]);
  }
  const slots = stored === undefined ? [] : parseSlots(stored.value);
  return {
    slots,
    ...(stored === undefined ? {} : { revision: stored.revision }),
    snapshotDigest: streamSnapshotDigest(slots),
  };
}

async function persistCreateOnly(
  context: EngineContext,
  kind: "candidate-admission-snapshot" | "candidate-admission-reservation" | "candidate-admission-binding",
  id: string,
  value: unknown,
  operationId: string,
): Promise<void> {
  const status = await createOnly(context, kind, id, value, operationId);
  if (status === "conflict") throw invalid("store.corrupt", "Candidate admission create-only record conflicts", []);
  const stored = await loadStoredRecord(context, kind, id);
  if (stored === undefined || recordDigest(toJsonValue(stored.value)) !== recordDigest(toJsonValue(value))) {
    throw invalid("store.corrupt", "Candidate admission create-only record was not preserved", []);
  }
}

export async function persistCandidateAdmissionSnapshot(
  context: EngineContext,
  snapshot: CandidateAdmissionSnapshot,
): Promise<void> {
  await persistCreateOnly(
    context,
    "candidate-admission-snapshot",
    snapshot.snapshotDigest,
    snapshot,
    `candidate-admission-snapshot/${snapshot.snapshotDigest}`,
  );
}

export async function persistCandidateAdmissionReservation(
  context: EngineContext,
  reservation: CandidateAdmissionReservation,
): Promise<void> {
  await persistCreateOnly(
    context,
    "candidate-admission-reservation",
    reservation.reservationDigest,
    reservation,
    `candidate-admission-reservation/${reservation.reservationDigest}`,
  );
}

export async function persistCandidateAdmissionBinding(
  context: EngineContext,
  binding: CandidateAdmissionBinding,
): Promise<void> {
  await persistCreateOnly(
    context,
    "candidate-admission-binding",
    binding.candidateId,
    binding,
    `candidate-admission-binding/${binding.candidateId}/${binding.bindingDigest}`,
  );
}

export async function appendCandidateAdmissionSlot(
  context: EngineContext,
  reservation: CandidateAdmissionReservation,
  expected: CandidateAdmissionStreamState,
): Promise<"appended" | "conflict"> {
  const base = {
    reservationKeyDigest: reservation.reservationKeyDigest,
    reservationDigest: reservation.reservationDigest,
    snapshotDigest: reservation.snapshotDigest,
  };
  const value: AdmissionSlotValue = { schemaVersion: 1, ...base, slotDigest: digest(slotBase(base)) };
  const entry: StreamEntry = {
    id: `slot:${reservation.reservationKeyDigest}`,
    digest: recordDigest(toJsonValue(value)),
    value: toJsonValue(value),
  };
  const current = await loadCandidateAdmissionStream(context, reservation.groupKeyDigest);
  const existing = current.slots.find((slot) => slot.id === entry.id);
  if (existing !== undefined) return existing.digest === entry.digest ? "appended" : "conflict";
  if (current.snapshotDigest !== expected.snapshotDigest || current.revision !== expected.revision) return "conflict";
  const raw: unknown = await context.store.append(
    recordKey("candidate-recurrence-admission", reservation.groupKeyDigest),
    expected.revision,
    [entry],
    `candidate-recurrence-admission/${reservation.groupKeyDigest}/${reservation.reservationKeyDigest}/${reservation.reservationDigest}`,
  );
  const result = parseWriteResult(raw);
  if (result.status === "conflict") return "conflict";
  const committed = await loadCandidateAdmissionStream(context, reservation.groupKeyDigest);
  const exact = committed.slots.find((slot) => slot.id === entry.id);
  if (exact === undefined || exact.digest !== entry.digest) {
    throw invalid("store.corrupt", "Candidate admission slot was not preserved", []);
  }
  return "appended";
}

export async function loadCandidateAdmissionSnapshot(
  context: EngineContext,
  snapshotDigest: string,
): Promise<CandidateAdmissionSnapshot | undefined> {
  const stored = await loadStoredRecord(context, "candidate-admission-snapshot", snapshotDigest);
  if (stored === undefined) return undefined;
  const snapshot = parseCandidateAdmissionSnapshot(stored.value);
  if (snapshot.snapshotDigest !== snapshotDigest)
    throw invalid("store.corrupt", "admission snapshot key mismatches", []);
  return snapshot;
}

export function candidateAdmissionRawBundleBytes(
  reservationValue: unknown,
  snapshotValue: unknown | undefined,
): number {
  return (
    Buffer.byteLength(canonicalJsonText(toJsonValue(reservationValue)), "utf8") +
    (snapshotValue === undefined ? 0 : Buffer.byteLength(canonicalJsonText(toJsonValue(snapshotValue)), "utf8"))
  );
}

function exactClaimRef(left: CandidateClaimRef | null, right: CandidateClaimRef | null): boolean {
  return recordDigest(toJsonValue(left)) === recordDigest(toJsonValue(right));
}

function reservationBasis(
  snapshot: CandidateAdmissionSnapshot,
  claim: GroupedCandidateClaim,
):
  | {
      readonly basis: CandidateAdmissionReservation["basis"];
      readonly requiredSupersedes: CandidateClaimRef | null;
    }
  | undefined {
  if (snapshot.assessment.status === "historical_supersession") {
    if (!exactClaimRef(claim.supersedes, snapshot.assessment.predecessor)) return undefined;
    return { basis: "historical_supersession", requiredSupersedes: snapshot.assessment.predecessor };
  }
  const governance = snapshot.assessment.governance;
  if (governance.groupDisposition !== "available") return undefined;
  const requiredSupersedes = governance.requiredSupersedes;
  if (!exactClaimRef(claim.supersedes, requiredSupersedes)) return undefined;
  if (requiredSupersedes === null) return { basis: "group_available", requiredSupersedes };
  if (governance.governingRejection !== null || governance.requiredOverrideCount !== null) {
    if (
      governance.governingRejection === null ||
      governance.requiredOverrideCount === null ||
      snapshot.distinctEpisodeCount < governance.requiredOverrideCount
    ) {
      return undefined;
    }
    return { basis: "rejection_override", requiredSupersedes };
  }
  return { basis: "required_supersession", requiredSupersedes };
}

export async function loadCandidateAdmissionReservationBundle(
  context: EngineContext,
  reservationDigest: string,
): Promise<
  | {
      readonly reservation: CandidateAdmissionReservation;
      readonly snapshot?: CandidateAdmissionSnapshot;
      readonly rawBytes: number;
    }
  | undefined
> {
  const stored = await loadStoredRecord(context, "candidate-admission-reservation", reservationDigest);
  if (stored === undefined) return undefined;
  const reservation = parseCandidateAdmissionReservation(stored.value);
  if (reservation.reservationDigest !== reservationDigest) {
    throw invalid("store.corrupt", "admission reservation key mismatches", []);
  }
  const snapshotStored = await loadStoredRecord(context, "candidate-admission-snapshot", reservation.snapshotDigest);
  const snapshot = snapshotStored === undefined ? undefined : parseCandidateAdmissionSnapshot(snapshotStored.value);
  const rawBytes = candidateAdmissionRawBundleBytes(stored.value, snapshotStored?.value);
  if (snapshot === undefined) return { reservation, rawBytes };
  if (snapshot.snapshotDigest !== reservation.snapshotDigest) {
    throw invalid("store.corrupt", "admission snapshot key mismatches", []);
  }
  if (
    reservation.reservationKeyDigest !== candidateAdmissionReservationKeyDigest(snapshot) ||
    reservation.policyDigest !== snapshot.policy.policyDigest ||
    reservation.groupKeyDigest !== snapshot.groupKeyDigest ||
    reservation.scopeDigest !== snapshot.scopeDigest
  ) {
    throw invalid("store.corrupt", "admission reservation snapshot binding is mismatched", []);
  }
  const exactBasis = reservationBasis(snapshot, reservation.candidateClaim);
  if (
    exactBasis === undefined ||
    exactBasis.basis !== reservation.basis ||
    !exactClaimRef(exactBasis.requiredSupersedes, reservation.requiredSupersedes)
  ) {
    throw invalid("store.corrupt", "admission reservation basis is mismatched", []);
  }
  return { reservation, snapshot, rawBytes };
}

export async function loadCandidateAdmissionReservation(
  context: EngineContext,
  reservationDigest: string,
): Promise<CandidateAdmissionReservation | undefined> {
  return (await loadCandidateAdmissionReservationBundle(context, reservationDigest))?.reservation;
}

export async function loadCandidateAdmissionBinding(
  context: EngineContext,
  candidateId: string,
): Promise<CandidateAdmissionBinding | undefined> {
  const stored = await loadStoredRecord(context, "candidate-admission-binding", candidateId);
  if (stored === undefined) return undefined;
  const binding = parseCandidateAdmissionBinding(stored.value);
  if (binding.candidateId !== candidateId) throw invalid("store.corrupt", "admission binding key mismatches", []);
  return binding;
}

export function buildCandidateAdmissionBinding(reservation: CandidateAdmissionReservation): CandidateAdmissionBinding {
  const base = {
    candidateId: reservation.candidateId,
    candidateDigest: reservation.candidateDigest,
    candidateClaimDigest: reservation.candidateClaimDigest,
    candidateContentLockDigest: reservation.candidateContentLockDigest,
    groupKeyDigest: reservation.groupKeyDigest,
    scopeDigest: reservation.scopeDigest,
    policyDigest: reservation.policyDigest,
    snapshotDigest: reservation.snapshotDigest,
    reservationKeyDigest: reservation.reservationKeyDigest,
    reservationDigest: reservation.reservationDigest,
  };
  return parseCandidateAdmissionBinding({
    schemaVersion: 1,
    ...base,
    bindingDigest: candidateAdmissionBindingDigest(base),
  });
}

export function candidateContentLockMatchesReservation(
  lock: CandidateContentLock,
  reservation: CandidateAdmissionReservation,
): boolean {
  return (
    lock.admissionExpected === true &&
    lock.candidateId === reservation.candidateId &&
    lock.contentDigest === reservation.candidateDigest &&
    lock.recurrenceClaimDigest === reservation.candidateClaimDigest &&
    candidateContentLockDigest(lock) === reservation.candidateContentLockDigest
  );
}

interface IndexedAdmissionSlot {
  readonly slot: StoredAdmissionSlot;
  readonly predecessorDigest: string;
}

export interface CandidateAdmissionSubjectCache {
  readonly streams: Map<string, Promise<ReadonlyMap<string, IndexedAdmissionSlot>>>;
}

export function createCandidateAdmissionSubjectCache(): CandidateAdmissionSubjectCache {
  return { streams: new Map() };
}

async function indexedAdmissionSlots(
  context: EngineContext,
  groupKeyDigest: string,
  cache: CandidateAdmissionSubjectCache,
): Promise<ReadonlyMap<string, IndexedAdmissionSlot>> {
  let pending = cache.streams.get(groupKeyDigest);
  if (pending === undefined) {
    pending = (async () => {
      const stream = await loadCandidateAdmissionStream(context, groupKeyDigest);
      const indexed = new Map<string, IndexedAdmissionSlot>();
      let predecessorDigest = streamSnapshotDigest([]);
      for (const slot of stream.slots) {
        indexed.set(slot.id, { slot, predecessorDigest });
        predecessorDigest = nextStreamSnapshotDigest(predecessorDigest, slot);
      }
      return indexed;
    })();
    cache.streams.set(groupKeyDigest, pending);
  }
  return pending;
}

export async function candidateAdmissionSubjectBindingStatus(
  context: EngineContext,
  candidate: CandidateV2,
  cache: CandidateAdmissionSubjectCache = createCandidateAdmissionSubjectCache(),
): Promise<"not_subject" | "valid" | "invalid"> {
  const lock = await loadCandidateContentLock(context, candidate.contentDigest);
  if (lock === undefined || lock.candidateId !== candidate.id || lock.contentDigest !== candidate.contentDigest) {
    return "invalid";
  }
  const binding = await loadCandidateAdmissionBinding(context, candidate.id);
  if (lock.admissionExpected !== true) return binding === undefined ? "not_subject" : "invalid";
  if (
    binding === undefined ||
    binding.candidateContentLockDigest !== candidateContentLockDigest(lock) ||
    lock.candidate === undefined ||
    recordDigest(toJsonValue(lock.candidate)) !== recordDigest(toJsonValue(candidate))
  ) {
    return "invalid";
  }
  const bundle = await loadCandidateAdmissionReservationBundle(context, binding.reservationDigest);
  const reservation = bundle?.reservation;
  const snapshot = bundle?.snapshot;
  if (
    reservation === undefined ||
    snapshot === undefined ||
    recordDigest(toJsonValue(binding)) !== recordDigest(toJsonValue(buildCandidateAdmissionBinding(reservation))) ||
    !candidateContentLockMatchesReservation(lock, reservation) ||
    recordDigest(toJsonValue(reservation.candidate)) !== recordDigest(toJsonValue(candidate))
  ) {
    return "invalid";
  }
  const slots = await indexedAdmissionSlots(context, reservation.groupKeyDigest, cache);
  const indexedSlot = slots.get(`slot:${reservation.reservationKeyDigest}`);
  if (
    indexedSlot === undefined ||
    indexedSlot.slot.value.reservationDigest !== reservation.reservationDigest ||
    indexedSlot.slot.value.snapshotDigest !== reservation.snapshotDigest ||
    snapshot.admissionStreamSnapshotDigest !== indexedSlot.predecessorDigest
  ) {
    return "invalid";
  }
  const marker = await loadCandidateReviewMarker(context, candidate);
  return marker.status === "ready" ? "valid" : "invalid";
}

export async function candidateAdmissionSubjectStatus(
  context: EngineContext,
  candidate: CandidateV2,
  cache: CandidateAdmissionSubjectCache = createCandidateAdmissionSubjectCache(),
): Promise<"not_subject" | "valid" | "invalid"> {
  const bindingStatus = await candidateAdmissionSubjectBindingStatus(context, candidate, cache);
  if (bindingStatus !== "valid") return bindingStatus;
  const recurrence = await loadCandidateRecurrenceLineage(context, candidate);
  return recurrence.status === "resolved" ? "valid" : "invalid";
}
