// Private execution-to-recurrence lineage and bounded committed-group folds.
import { sha256HexOfCanonicalJson } from "../canonical/canonical-json.js";
import { toJsonValue } from "../canonical/to-json-value.js";
import { LearningLoopError } from "../diagnostics.js";
import type { StreamEntry } from "../ports/store.js";
import { invalid, readFields } from "../parse/toolkit.js";
import type { Parse } from "../parse/toolkit.js";
import type { DetectorExecutionRecord } from "../records/detector-execution.js";
import type { DetectorRecurrenceLocator } from "../records/detector-recurrence.js";
import {
  DETECTOR_RECURRENCE_GROUP_MEMBER_LIMIT,
  parseDetectorRecurrenceLocatorAt,
} from "../records/detector-recurrence.js";
import type { DetectorRegistration } from "../records/detector-registration.js";
import {
  parseBoundedArray,
  detectorRefKey,
  parseDetectorRefAt,
  parseDigestAt,
  parseDurableId,
  parseLensRefAt,
  parseNullable,
  parsePackRefAt,
  parseScopeAt,
  scopeDigest,
} from "../records/semantic-shared.js";
import type { EngineContext } from "./context.js";
import { createOnly, loadStoredRecord, parseWriteResult, recordDigest, recordKey } from "./context.js";
import { loadDetectorExecutionRecord, semanticGraphSnapshotRevision } from "./semantic-graph.js";

const MAX_APPEND_ATTEMPTS = 8;
const MAX_GROUP_MEMBERS = DETECTOR_RECURRENCE_GROUP_MEMBER_LIMIT;
const MAX_GROUP_EPISODES = 5_000;
const MAX_GROUP_EPISODE_REFERENCES = 50_000;

export type DetectorRunRecurrence =
  | {
      readonly status: "grouped";
      readonly groupKeyDigest: string;
      readonly locator: DetectorRecurrenceLocator;
      readonly distinctEpisodeCount: number;
      readonly executionCount: number;
    }
  | { readonly status: "execution_not_materialized" }
  | {
      readonly status: "execution_not_applied";
      readonly executionStatus: "not_applicable" | "incomplete";
    }
  | { readonly status: "condition_not_detected" }
  | { readonly status: "locator_unavailable" };

interface RecurrenceEpisodeMember {
  readonly episodeRecordId: string;
  readonly episodeIdentityDigest: string;
  readonly episodeViewDigest: string;
}

export interface ExecutionRecurrenceBinding {
  readonly schemaVersion: 1;
  readonly executionId: string;
  readonly executionKeyDigest: string;
  readonly executionDigest: string;
  readonly detector: DetectorExecutionRecord["detector"];
  readonly pack: DetectorExecutionRecord["pack"];
  readonly lens: DetectorExecutionRecord["lens"];
  readonly scope: DetectorExecutionRecord["scope"];
  readonly scopeDigest: string;
  readonly scopePolicyDigest: string;
  readonly locator: DetectorRecurrenceLocator | null;
  readonly groupKeyDigest: string | null;
  readonly memberEpisodes: readonly RecurrenceEpisodeMember[];
  readonly bindingDigest: string;
}

export interface RecurrenceGroupMember {
  readonly schemaVersion: 1;
  readonly groupKeyDigest: string;
  readonly executionId: string;
  readonly executionKeyDigest: string;
  readonly executionDigest: string;
  readonly bindingDigest: string;
  readonly pack: DetectorExecutionRecord["pack"];
  readonly memberDigest: string;
}

interface StoredGroupMember {
  readonly id: string;
  readonly digest: string;
  readonly value: RecurrenceGroupMember;
}

interface GroupStats {
  readonly memberCount: number;
  readonly episodeReferenceCount: number;
  readonly storedExecutionIds: ReadonlySet<string>;
  readonly storedEpisodeIdentityDigests: ReadonlySet<string>;
  readonly executionIds: ReadonlySet<string>;
  readonly episodeIdentityDigests: ReadonlySet<string>;
  readonly committedMembers: readonly RecurrenceCommittedMemberSnapshot[];
}

export interface RecurrenceCommittedMemberSnapshot {
  readonly executionId: string;
  readonly executionKeyDigest: string;
  readonly executionDigest: string;
  readonly decisionBindingDigest: string;
  readonly memberDigest: string;
}

function sameCanonical(left: unknown, right: unknown): boolean {
  return recordDigest(toJsonValue(left)) === recordDigest(toJsonValue(right));
}

function recurrenceGroupKeyContent(execution: DetectorExecutionRecord, locator: DetectorRecurrenceLocator): unknown {
  return {
    domain: "detector-recurrence-group:v1",
    detector: execution.detector,
    lens: execution.lens,
    scope: execution.scope,
    scopeDigest: execution.scopeDigest,
    scopePolicyDigest: execution.scopePolicyDigest,
    locator,
  };
}

export function detectorRecurrenceGroupKeyDigest(
  execution: DetectorExecutionRecord,
  locator: DetectorRecurrenceLocator,
): string {
  return sha256HexOfCanonicalJson(toJsonValue(recurrenceGroupKeyContent(execution, locator)));
}

function parseDetectorProjectionAt(
  input: unknown,
  path: readonly (string | number)[],
): DetectorExecutionRecord["detector"] {
  const fields = readFields(input, path);
  const reference = parseDetectorRefAt(input, path);
  return {
    ...reference,
    configurationDigest: fields.req("configurationDigest", parseDigestAt),
    implementationDigest: fields.req("implementationDigest", parseDigestAt),
  };
}

const parseEpisodeMemberAt: Parse<RecurrenceEpisodeMember> = (input, path) => {
  const fields = readFields(input, path);
  return {
    episodeRecordId: fields.req("episodeRecordId", parseDurableId),
    episodeIdentityDigest: fields.req("episodeIdentityDigest", parseDigestAt),
    episodeViewDigest: fields.req("episodeViewDigest", parseDigestAt),
  };
};

export function parseExecutionRecurrenceBinding(
  input: unknown,
  path: readonly (string | number)[] = [],
): ExecutionRecurrenceBinding {
  const fields = readFields(input, path);
  const schemaVersion = fields.schemaVersion1();
  const detector = fields.req("detector", parseDetectorProjectionAt);
  const pack = fields.req("pack", parsePackRefAt);
  const lens = fields.req("lens", parseNullable(parseLensRefAt));
  const scope = fields.req("scope", parseScopeAt);
  const exactScopeDigest = fields.req("scopeDigest", parseDigestAt);
  if (scopeDigest(scope) !== exactScopeDigest) {
    throw invalid("schema.corrupt", "recurrence binding scope digest does not match its scope", [
      ...path,
      "scopeDigest",
    ]);
  }
  const locator = fields.req("locator", parseNullable(parseDetectorRecurrenceLocatorAt));
  const groupKeyDigest = fields.req("groupKeyDigest", parseNullable(parseDigestAt));
  if ((locator === null) !== (groupKeyDigest === null)) {
    throw invalid("schema.corrupt", "recurrence locator and group key must occur together", path);
  }
  const memberEpisodes = fields.req(
    "memberEpisodes",
    parseBoundedArray(parseEpisodeMemberAt, 500, "recurrence member episodes"),
  );
  if (memberEpisodes.length === 0) {
    throw invalid("store.corrupt", "recurrence binding requires at least one episode member", [
      ...path,
      "memberEpisodes",
    ]);
  }
  let previousEpisodeKey: string | undefined;
  const recordIds = new Set<string>();
  const identityDigests = new Set<string>();
  const viewDigests = new Set<string>();
  for (const [index, episode] of memberEpisodes.entries()) {
    const episodeKey = episode.episodeRecordId;
    if (
      (previousEpisodeKey !== undefined && previousEpisodeKey >= episodeKey) ||
      recordIds.has(episode.episodeRecordId) ||
      identityDigests.has(episode.episodeIdentityDigest) ||
      viewDigests.has(episode.episodeViewDigest)
    ) {
      throw invalid("store.corrupt", "recurrence binding episode lineage must be unique", [
        ...path,
        "memberEpisodes",
        index,
      ]);
    }
    previousEpisodeKey = episodeKey;
    recordIds.add(episode.episodeRecordId);
    identityDigests.add(episode.episodeIdentityDigest);
    viewDigests.add(episode.episodeViewDigest);
  }
  const base = {
    executionId: fields.req("executionId", parseDurableId),
    executionKeyDigest: fields.req("executionKeyDigest", parseDigestAt),
    executionDigest: fields.req("executionDigest", parseDigestAt),
    detector,
    pack,
    lens,
    scope,
    scopeDigest: exactScopeDigest,
    scopePolicyDigest: fields.req("scopePolicyDigest", parseDigestAt),
    locator,
    groupKeyDigest,
    memberEpisodes,
  };
  const bindingDigest = fields.req("bindingDigest", parseDigestAt);
  if (base.executionId !== `detector-execution-${base.executionKeyDigest}`) {
    throw invalid("schema.corrupt", "recurrence binding execution id does not match its key digest", [
      ...path,
      "executionId",
    ]);
  }
  if (bindingDigest !== sha256HexOfCanonicalJson(toJsonValue(base))) {
    throw invalid("schema.corrupt", "recurrence binding digest does not match its content", [...path, "bindingDigest"]);
  }
  const projectedExecution = {
    detector,
    lens,
    scope,
    scopeDigest: exactScopeDigest,
    scopePolicyDigest: base.scopePolicyDigest,
  };
  if (locator !== null) {
    if (
      groupKeyDigest !==
      sha256HexOfCanonicalJson(toJsonValue({ domain: "detector-recurrence-group:v1", ...projectedExecution, locator }))
    ) {
      throw invalid("schema.corrupt", "recurrence group key does not match its binding", [...path, "groupKeyDigest"]);
    }
  }
  return { schemaVersion, ...base, bindingDigest };
}

function parseMemberAt(input: unknown, path: readonly (string | number)[]): RecurrenceGroupMember {
  const fields = readFields(input, path);
  const schemaVersion = fields.schemaVersion1();
  const base = {
    groupKeyDigest: fields.req("groupKeyDigest", parseDigestAt),
    executionId: fields.req("executionId", parseDurableId),
    executionKeyDigest: fields.req("executionKeyDigest", parseDigestAt),
    executionDigest: fields.req("executionDigest", parseDigestAt),
    bindingDigest: fields.req("bindingDigest", parseDigestAt),
    pack: fields.req("pack", parsePackRefAt),
  };
  const memberDigest = fields.req("memberDigest", parseDigestAt);
  if (base.executionId !== `detector-execution-${base.executionKeyDigest}`) {
    throw invalid("schema.corrupt", "recurrence member execution id does not match its key digest", [
      ...path,
      "executionId",
    ]);
  }
  if (memberDigest !== sha256HexOfCanonicalJson(toJsonValue(base))) {
    throw invalid("schema.corrupt", "recurrence group member digest does not match its content", [
      ...path,
      "memberDigest",
    ]);
  }
  return { schemaVersion, ...base, memberDigest };
}

const parseStreamEntryAt: Parse<StoredGroupMember> = (input, path) => {
  const fields = readFields(input, path);
  const value = fields.req("value", parseMemberAt);
  const id = fields.req("id", parseDurableId);
  const digest = fields.req("digest", parseDigestAt);
  if (id !== `execution:${value.executionId}:${value.executionDigest}` || digest !== recordDigest(toJsonValue(value))) {
    throw invalid("store.corrupt", "recurrence group stream entry does not bind its exact member", path);
  }
  return { id, digest, value };
};

function parseStoredMembers(input: unknown, groupKeyDigest: string): readonly StoredGroupMember[] {
  if (!Array.isArray(input)) {
    throw invalid("store.corrupt", "detector recurrence group must be a stream-entry array", []);
  }
  if (input.length > MAX_GROUP_MEMBERS) {
    throw new LearningLoopError("detector.limit_exceeded", [
      { code: "detector.limit_exceeded", severity: "error", message: "detector recurrence group exceeds its ceiling" },
    ]);
  }
  const entries = input.map((entry: unknown, index: number) =>
    parseStreamEntryAt(entry, ["detector-recurrence-group", index]),
  );
  const ids = new Set<string>();
  for (const [index, entry] of entries.entries()) {
    if (entry.value.groupKeyDigest !== groupKeyDigest || ids.has(entry.id)) {
      throw invalid("store.corrupt", "recurrence group contains a foreign or duplicate member", [index]);
    }
    ids.add(entry.id);
  }
  return entries;
}

function episodesForExecution(execution: DetectorExecutionRecord): readonly RecurrenceEpisodeMember[] {
  return execution.window.population.episodes.map((episode) => ({
    episodeRecordId: episode.episodeRecordId,
    episodeIdentityDigest: episode.episodeIdentityDigest,
    episodeViewDigest: episode.episodeViewDigest,
  }));
}

function buildBinding(
  execution: DetectorExecutionRecord,
  locator: DetectorRecurrenceLocator | null,
): ExecutionRecurrenceBinding {
  const base = {
    executionId: execution.id,
    executionKeyDigest: execution.executionKeyDigest,
    executionDigest: execution.executionDigest,
    detector: execution.detector,
    pack: execution.pack,
    lens: execution.lens,
    scope: execution.scope,
    scopeDigest: execution.scopeDigest,
    scopePolicyDigest: execution.scopePolicyDigest,
    locator,
    groupKeyDigest: locator === null ? null : detectorRecurrenceGroupKeyDigest(execution, locator),
    memberEpisodes: episodesForExecution(execution),
  };
  return parseExecutionRecurrenceBinding(
    { schemaVersion: 1, ...base, bindingDigest: sha256HexOfCanonicalJson(toJsonValue(base)) },
    [],
  );
}

export function buildUnavailableExecutionRecurrenceBinding(
  execution: DetectorExecutionRecord,
): ExecutionRecurrenceBinding {
  if (execution.result.status !== "applied" || !execution.result.conditionDetected) {
    throw invalid(
      "semantic.workflow_output_invalid",
      "only a positive applied execution has recurrence unavailability",
      [],
    );
  }
  return buildBinding(execution, null);
}

function memberForBinding(binding: ExecutionRecurrenceBinding): RecurrenceGroupMember {
  if (binding.groupKeyDigest === null || binding.locator === null) {
    throw invalid("store.corrupt", "unavailable recurrence decision cannot become a group member", []);
  }
  const base = {
    groupKeyDigest: binding.groupKeyDigest,
    executionId: binding.executionId,
    executionKeyDigest: binding.executionKeyDigest,
    executionDigest: binding.executionDigest,
    bindingDigest: binding.bindingDigest,
    pack: binding.pack,
  };
  return parseMemberAt({ schemaVersion: 1, ...base, memberDigest: sha256HexOfCanonicalJson(toJsonValue(base)) }, []);
}

function entryForMember(member: RecurrenceGroupMember): StreamEntry {
  const value = toJsonValue(member);
  return {
    id: `execution:${member.executionId}:${member.executionDigest}`,
    digest: recordDigest(value),
    value,
  };
}

function assertBindingMatchesExecution(
  context: EngineContext,
  binding: ExecutionRecurrenceBinding,
  execution: DetectorExecutionRecord,
): void {
  if (execution.result.status !== "applied" || !execution.result.conditionDetected) {
    throw invalid("store.corrupt", "recurrence binding references an execution without a detected condition", []);
  }
  const expected = buildBinding(execution, binding.locator);
  if (!sameCanonical(binding, expected)) {
    throw invalid("store.corrupt", "recurrence binding does not match its exact execution", []);
  }
  assertBindingPrivacy(context, binding);
}

function assertBindingPrivacy(context: EngineContext, binding: ExecutionRecurrenceBinding): void {
  if (binding.locator === null) return;
  const detector = context.semanticDetectorsByRef?.get(detectorRefKey(binding.detector));
  if (detector === undefined) throw invalid("store.corrupt", "recurrence detector registration is unavailable", []);
  try {
    validateDetectorRecurrenceLocator(detector, binding.locator);
  } catch (error) {
    if (error instanceof LearningLoopError) {
      throw invalid("store.corrupt", "stored recurrence locator violates its detector privacy policy", []);
    }
    throw error;
  }
}

export function validateDetectorRecurrenceLocator(
  detector: DetectorRegistration,
  input: unknown,
): DetectorRecurrenceLocator | null {
  if (input === undefined || input === null) return null;
  const locator = parseDetectorRecurrenceLocatorAt(input, ["recurrenceLocator"]);
  const treatment = detector.privacy.signatureTreatment;
  if (treatment === "none" || (treatment !== "mixed" && treatment !== locator.treatment)) {
    throw invalid("detector.result_invalid", "recurrence locator treatment is not permitted by the detector", []);
  }
  if (locator.treatment === "tenant_keyed_private" && locator.keyPolicyDigest !== detector.privacy.policyDigest) {
    throw invalid("detector.result_invalid", "recurrence locator key policy does not match the detector", []);
  }
  return locator;
}

export async function loadExecutionRecurrenceBinding(
  context: EngineContext,
  executionId: string,
): Promise<ExecutionRecurrenceBinding | undefined> {
  const stored = await loadStoredRecord(context, "detector-recurrence-binding", executionId);
  if (stored === undefined) return undefined;
  const binding = parseExecutionRecurrenceBinding(stored.value, []);
  if (binding.executionId !== executionId) {
    throw invalid("store.corrupt", "recurrence binding belongs to another execution", []);
  }
  return binding;
}

async function loadStoredGroupMembers(
  context: EngineContext,
  groupKeyDigest: string,
): Promise<readonly StoredGroupMember[]> {
  const stored = await loadStoredRecord(context, "detector-recurrence-group", groupKeyDigest);
  return stored === undefined ? [] : parseStoredMembers(stored.value, groupKeyDigest);
}

async function committedGroupStats(context: EngineContext, groupKeyDigest: string): Promise<GroupStats> {
  const members = await loadStoredGroupMembers(context, groupKeyDigest);
  const executionIds = new Set<string>();
  const storedExecutionIds = new Set<string>();
  const episodeIdentityDigests = new Set<string>();
  const storedEpisodeIdentityDigests = new Set<string>();
  const committedMembers: RecurrenceCommittedMemberSnapshot[] = [];
  let episodeReferenceCount = 0;
  for (const member of members) {
    storedExecutionIds.add(member.value.executionId);
    const binding = await loadExecutionRecurrenceBinding(context, member.value.executionId);
    if (binding === undefined || binding.bindingDigest !== member.value.bindingDigest) {
      throw invalid("store.corrupt", "recurrence member has no exact execution binding", []);
    }
    if (!sameCanonical(member.value, memberForBinding(binding))) {
      throw invalid("store.corrupt", "recurrence member does not match its exact binding", []);
    }
    assertBindingPrivacy(context, binding);
    for (const episode of binding.memberEpisodes) {
      episodeReferenceCount += 1;
      if (episodeReferenceCount > MAX_GROUP_EPISODE_REFERENCES) {
        throw new LearningLoopError("detector.limit_exceeded", [
          {
            code: "detector.limit_exceeded",
            severity: "error",
            message: "detector recurrence episode references exceed their ceiling",
          },
        ]);
      }
      storedEpisodeIdentityDigests.add(episode.episodeIdentityDigest);
    }
    if (storedEpisodeIdentityDigests.size > MAX_GROUP_EPISODES) {
      throw new LearningLoopError("detector.limit_exceeded", [
        {
          code: "detector.limit_exceeded",
          severity: "error",
          message: "detector recurrence stored episode population exceeds its ceiling",
        },
      ]);
    }
    const execution = await loadDetectorExecutionRecord(context, member.value.executionId);
    if (execution === undefined) continue;
    if (
      execution.executionKeyDigest !== member.value.executionKeyDigest ||
      execution.executionDigest !== member.value.executionDigest
    ) {
      throw invalid("store.corrupt", "recurrence member resolves another execution result", []);
    }
    assertBindingMatchesExecution(context, binding, execution);
    executionIds.add(execution.id);
    committedMembers.push({
      executionId: execution.id,
      executionKeyDigest: execution.executionKeyDigest,
      executionDigest: execution.executionDigest,
      decisionBindingDigest: binding.bindingDigest,
      memberDigest: member.value.memberDigest,
    });
    for (const episode of binding.memberEpisodes) episodeIdentityDigests.add(episode.episodeIdentityDigest);
    if (episodeIdentityDigests.size > MAX_GROUP_EPISODES) {
      throw new LearningLoopError("detector.limit_exceeded", [
        {
          code: "detector.limit_exceeded",
          severity: "error",
          message: "detector recurrence episode population exceeds its ceiling",
        },
      ]);
    }
  }
  return {
    memberCount: members.length,
    episodeReferenceCount,
    storedExecutionIds,
    storedEpisodeIdentityDigests,
    executionIds,
    episodeIdentityDigests,
    committedMembers: committedMembers.sort((left, right) =>
      left.executionId < right.executionId ? -1 : left.executionId > right.executionId ? 1 : 0,
    ),
  };
}

export async function prepareExecutionRecurrence(
  context: EngineContext,
  execution: DetectorExecutionRecord,
  locatorInput: unknown,
): Promise<ExecutionRecurrenceBinding | undefined> {
  if (locatorInput === undefined) return undefined;
  let existingBinding = await loadExecutionRecurrenceBinding(context, execution.id);
  const committedExecution = await loadDetectorExecutionRecord(context, execution.id);
  if (committedExecution !== undefined) {
    if (committedExecution.executionDigest !== execution.executionDigest) {
      throw invalid("store.corrupt", "recurrence decision resolves another committed execution", []);
    }
    if (existingBinding === undefined) {
      existingBinding = await loadExecutionRecurrenceBinding(context, execution.id);
      if (existingBinding === undefined) {
        throw invalid("store.corrupt", "historical execution cannot acquire a recurrence decision", []);
      }
    }
  }
  if (execution.result.status !== "applied" || !execution.result.conditionDetected) {
    if (existingBinding !== undefined) {
      throw invalid("store.corrupt", "execution without a detected condition has a recurrence decision", []);
    }
    if (locatorInput === null) return undefined;
    throw invalid("detector.result_invalid", "only a detected applied execution can carry recurrence lineage", []);
  }
  const detector = context.semanticDetectorsByRef?.get(detectorRefKey(execution.detector));
  if (detector === undefined) throw invalid("store.corrupt", "recurrence detector registration is unavailable", []);
  const locator = validateDetectorRecurrenceLocator(detector, locatorInput);
  const binding = buildBinding(execution, locator);
  if (existingBinding !== undefined && !sameCanonical(existingBinding, binding)) {
    throw invalid("store.corrupt", "execution recurrence locator conflicts with existing content", []);
  }
  if (locator === null) return binding;
  if (binding.groupKeyDigest === null) {
    throw invalid("store.corrupt", "qualified recurrence locator has no group key", []);
  }
  const stats = await committedGroupStats(context, binding.groupKeyDigest);
  const prospectiveEpisodes = new Set(stats.storedEpisodeIdentityDigests);
  for (const episode of binding.memberEpisodes) prospectiveEpisodes.add(episode.episodeIdentityDigest);
  if (
    (!stats.storedExecutionIds.has(execution.id) && stats.memberCount >= MAX_GROUP_MEMBERS) ||
    (!stats.storedExecutionIds.has(execution.id) &&
      stats.episodeReferenceCount + binding.memberEpisodes.length > MAX_GROUP_EPISODE_REFERENCES) ||
    prospectiveEpisodes.size > MAX_GROUP_EPISODES
  ) {
    throw new LearningLoopError("detector.limit_exceeded", [
      { code: "detector.limit_exceeded", severity: "error", message: "detector recurrence group is at capacity" },
    ]);
  }
  return binding;
}

async function appendGroupMember(context: EngineContext, binding: ExecutionRecurrenceBinding): Promise<void> {
  const groupKeyDigest = binding.groupKeyDigest;
  if (groupKeyDigest === null || binding.locator === null) {
    throw invalid("store.corrupt", "unavailable recurrence decision cannot be appended to a group", []);
  }
  const member = memberForBinding(binding);
  const entry = entryForMember(member);
  for (let attempt = 0; attempt < MAX_APPEND_ATTEMPTS; attempt += 1) {
    const stored = await loadStoredRecord(context, "detector-recurrence-group", groupKeyDigest);
    const members = stored === undefined ? [] : parseStoredMembers(stored.value, groupKeyDigest);
    const existing = members.find((candidate) => candidate.id === entry.id);
    if (existing !== undefined) {
      if (existing.digest !== entry.digest || !sameCanonical(existing.value, member)) {
        throw invalid("store.corrupt", "recurrence member id binds different content", []);
      }
      return;
    }
    if (members.length >= MAX_GROUP_MEMBERS) {
      throw new LearningLoopError("detector.limit_exceeded", [
        { code: "detector.limit_exceeded", severity: "error", message: "detector recurrence group is at capacity" },
      ]);
    }
    const distinctEpisodes = new Set<string>();
    let episodeReferenceCount = 0;
    for (const candidate of members) {
      const existingBinding = await loadExecutionRecurrenceBinding(context, candidate.value.executionId);
      if (
        existingBinding === undefined ||
        existingBinding.bindingDigest !== candidate.value.bindingDigest ||
        !sameCanonical(candidate.value, memberForBinding(existingBinding))
      ) {
        throw invalid("store.corrupt", "recurrence member has no exact binding during append", []);
      }
      assertBindingPrivacy(context, existingBinding);
      for (const episode of existingBinding.memberEpisodes) {
        episodeReferenceCount += 1;
        if (episodeReferenceCount > MAX_GROUP_EPISODE_REFERENCES) {
          throw new LearningLoopError("detector.limit_exceeded", [
            {
              code: "detector.limit_exceeded",
              severity: "error",
              message: "detector recurrence episode references are at capacity",
            },
          ]);
        }
        distinctEpisodes.add(episode.episodeIdentityDigest);
      }
    }
    for (const episode of binding.memberEpisodes) distinctEpisodes.add(episode.episodeIdentityDigest);
    if (episodeReferenceCount + binding.memberEpisodes.length > MAX_GROUP_EPISODE_REFERENCES) {
      throw new LearningLoopError("detector.limit_exceeded", [
        {
          code: "detector.limit_exceeded",
          severity: "error",
          message: "detector recurrence episode references are at capacity",
        },
      ]);
    }
    if (distinctEpisodes.size > MAX_GROUP_EPISODES) {
      throw new LearningLoopError("detector.limit_exceeded", [
        {
          code: "detector.limit_exceeded",
          severity: "error",
          message: "detector recurrence episode population is at capacity",
        },
      ]);
    }
    const rawResult: unknown = await context.store.append(
      recordKey("detector-recurrence-group", groupKeyDigest),
      stored?.revision,
      [entry],
      `detector-recurrence-group/${groupKeyDigest}/${entry.id}`,
    );
    const result = parseWriteResult(rawResult);
    if (result.status === "created" || result.status === "updated" || result.status === "exists_same") {
      const committed = await loadStoredGroupMembers(context, groupKeyDigest);
      if (!committed.some((candidate) => candidate.id === entry.id && candidate.digest === entry.digest)) {
        throw invalid("store.corrupt", "store acknowledged a recurrence member without preserving it", []);
      }
      return;
    }
  }
  throw new LearningLoopError("store.conflict", [
    { code: "store.conflict", severity: "error", message: "recurrence group changed too many times" },
  ]);
}

export async function persistPreparedExecutionRecurrence(
  context: EngineContext,
  binding: ExecutionRecurrenceBinding,
): Promise<void> {
  const status = await createOnly(
    context,
    "detector-recurrence-binding",
    binding.executionId,
    binding,
    `detector-recurrence-binding/${binding.executionId}/${binding.bindingDigest}`,
  );
  if (status === "conflict") {
    throw invalid("store.corrupt", "execution recurrence binding conflicts with existing content", []);
  }
  if (binding.locator !== null && binding.groupKeyDigest !== null) {
    await appendGroupMember(context, binding);
  }
}

export async function recurrenceForExecution(
  context: EngineContext,
  execution: DetectorExecutionRecord | undefined,
  locatorInput: unknown,
): Promise<DetectorRunRecurrence> {
  if (execution === undefined) return { status: "execution_not_materialized" };
  const initiallyStoredBinding = await loadExecutionRecurrenceBinding(context, execution.id);
  if (execution.result.status !== "applied") {
    if (initiallyStoredBinding !== undefined) {
      throw invalid("store.corrupt", "nonapplied execution has a recurrence binding", []);
    }
    return { status: "execution_not_applied", executionStatus: execution.result.status };
  }
  if (!execution.result.conditionDetected) {
    if (initiallyStoredBinding !== undefined) {
      throw invalid("store.corrupt", "negative execution has a recurrence binding", []);
    }
    return { status: "condition_not_detected" };
  }
  const locatorWasEvaluated = locatorInput !== undefined;
  let binding = locatorWasEvaluated
    ? await prepareExecutionRecurrence(context, execution, locatorInput)
    : initiallyStoredBinding;
  if (binding === undefined) return { status: "locator_unavailable" };
  assertBindingMatchesExecution(context, binding, execution);
  const committedExecution = await loadDetectorExecutionRecord(context, execution.id);
  if (committedExecution !== undefined && committedExecution.executionDigest !== execution.executionDigest) {
    throw invalid("store.corrupt", "recurrence preview resolves another execution result", []);
  }
  if (committedExecution !== undefined) {
    const durableBinding = await loadExecutionRecurrenceBinding(context, execution.id);
    if (durableBinding === undefined) {
      throw invalid("store.corrupt", "committed execution cannot acquire recurrence lineage during a read", []);
    }
    if (!sameCanonical(durableBinding, binding)) {
      throw invalid("store.corrupt", "committed execution recurrence decision changed during a read", []);
    }
    binding = durableBinding;
  }
  if (binding.locator === null || binding.groupKeyDigest === null) {
    return { status: "locator_unavailable" };
  }
  const stats = await committedGroupStats(context, binding.groupKeyDigest);
  const executionIds = new Set(stats.executionIds);
  const episodeIdentityDigests = new Set(stats.episodeIdentityDigests);
  if (committedExecution !== undefined && !executionIds.has(execution.id)) {
    throw invalid("store.corrupt", "committed recurrence binding has no exact group member", []);
  }
  if (committedExecution === undefined && !executionIds.has(execution.id)) {
    executionIds.add(execution.id);
    for (const episode of binding.memberEpisodes) episodeIdentityDigests.add(episode.episodeIdentityDigest);
  }
  if (executionIds.size > MAX_GROUP_MEMBERS || episodeIdentityDigests.size > MAX_GROUP_EPISODES) {
    throw new LearningLoopError("detector.limit_exceeded", [
      {
        code: "detector.limit_exceeded",
        severity: "error",
        message: "detector recurrence preview exceeds its ceiling",
      },
    ]);
  }
  return {
    status: "grouped",
    groupKeyDigest: binding.groupKeyDigest,
    locator: binding.locator,
    distinctEpisodeCount: episodeIdentityDigests.size,
    executionCount: executionIds.size,
  };
}

export function recurrenceLocatorOf(state: DetectorRunRecurrence): DetectorRecurrenceLocator | null {
  return state.status === "grouped" ? state.locator : null;
}

export async function recurrenceReceiptLineage(
  context: EngineContext,
  execution: DetectorExecutionRecord,
): Promise<{
  readonly binding: ExecutionRecurrenceBinding | undefined;
  readonly episodeIdentityDigests: readonly string[];
  readonly executionIds: readonly string[];
  readonly executionCount: number;
  readonly members: readonly RecurrenceCommittedMemberSnapshot[];
}> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const before = await semanticGraphSnapshotRevision(context);
    const recurrence = await recurrenceForExecution(context, execution, undefined);
    const binding = await loadExecutionRecurrenceBinding(context, execution.id);
    if (recurrence.status !== "grouped") {
      const after = await semanticGraphSnapshotRevision(context);
      if (before === after)
        return { binding, episodeIdentityDigests: [], executionIds: [], executionCount: 0, members: [] };
      continue;
    }
    if (binding === undefined || binding.groupKeyDigest !== recurrence.groupKeyDigest) {
      throw invalid("store.corrupt", "grouped execution has no exact recurrence decision binding", []);
    }
    const stats = await committedGroupStats(context, recurrence.groupKeyDigest);
    const episodeIdentityDigests = [...stats.episodeIdentityDigests].sort((left, right) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    const countsMatch =
      episodeIdentityDigests.length === recurrence.distinctEpisodeCount &&
      stats.executionIds.size === recurrence.executionCount;
    const after = await semanticGraphSnapshotRevision(context);
    if (before !== after) continue;
    if (!countsMatch) {
      throw invalid("store.corrupt", "recurrence receipt lineage counts do not match one stable group", []);
    }
    const executionIds = [...stats.executionIds].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
    return {
      binding,
      episodeIdentityDigests,
      executionIds,
      executionCount: executionIds.length,
      members: stats.committedMembers,
    };
  }
  throw new LearningLoopError("detector.snapshot_changed", [
    {
      code: "detector.snapshot_changed",
      severity: "error",
      message: "detector recurrence lineage changed repeatedly during receipt resolution",
    },
  ]);
}
