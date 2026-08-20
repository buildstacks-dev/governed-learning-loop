// Private derivation/Candidate recurrence claims. Claims are audit lineage only;
// this slice does not refuse, deduplicate, or suppress a proposal.
import { sha256HexOfCanonicalJson } from "../canonical/canonical-json.js";
import { toJsonValue } from "../canonical/to-json-value.js";
import type { Diagnostic } from "../diagnostics.js";
import { LearningLoopError } from "../diagnostics.js";
import type { StreamEntry } from "../ports/store.js";
import { invalid, parseOneOf, readFields } from "../parse/toolkit.js";
import type { Parse } from "../parse/toolkit.js";
import type { Candidate, CandidateV2 } from "../records/candidate.js";
import { candidateScopeDigest, parseCandidate } from "../records/candidate.js";
import type { InsightDerivation } from "../records/insight-derivation.js";
import type { DetectorExecutionRecord } from "../records/detector-execution.js";
import {
  assertSortedUnique,
  parseBoundedArray,
  parseDigestAt,
  parseDurableId,
  parseNullable,
} from "../records/semantic-shared.js";
import type { EngineContext } from "./context.js";
import { createOnly, loadCandidate, loadStoredRecord, parseWriteResult, recordDigest, recordKey } from "./context.js";
import type { ExecutionRecurrenceBinding, RecurrenceCommittedMemberSnapshot } from "./detector-recurrence.js";
import { loadExecutionRecurrenceBinding, recurrenceReceiptLineage } from "./detector-recurrence.js";
import { loadDetectorExecutionRecord, loadInsightDerivationRecord } from "./semantic-graph.js";
import { loadDetectorExecutionView } from "./semantic-views.js";

const MAX_APPEND_ATTEMPTS = 8;
const MAX_CLAIMS = 5_000;
const MAX_EPISODES = 5_000;
const MAX_CLAIM_GROUPS = 1;
const NOT_BOUND_REASONS = ["manual", "derivation_unbound"] as const;

export interface DerivationRecurrenceClaim {
  readonly schemaVersion: 1;
  readonly derivationId: string;
  readonly derivationDigest: string;
  readonly executionId: string;
  readonly executionKeyDigest: string;
  readonly executionDigest: string;
  readonly scopeDigest: string;
  readonly groupKeyDigest: string;
  readonly decisionBindingDigest: string;
  readonly populationDigest: string;
  readonly episodeIdentityDigests: readonly string[];
  readonly episodeIdentitySetDigest: string;
  readonly distinctEpisodeCount: number;
  readonly claimDigest: string;
}

export type CandidateRecurrenceClaim =
  | {
      readonly schemaVersion: 1;
      readonly candidateId: string;
      readonly candidateDigest: string;
      readonly scopeDigest: string;
      readonly candidate: CandidateV2;
      readonly status: "not_bound";
      readonly reason: "manual" | "derivation_unbound";
      readonly claimDigest: string;
    }
  | {
      readonly schemaVersion: 1;
      readonly candidateId: string;
      readonly candidateDigest: string;
      readonly scopeDigest: string;
      readonly candidate: CandidateV2;
      readonly status: "grouped";
      readonly derivationId: string;
      readonly derivationDigest: string;
      readonly derivationClaimDigests: readonly string[];
      readonly groupKeyDigest: string;
      readonly proposalMembers: readonly RecurrenceCommittedMemberSnapshot[];
      readonly proposalMemberSnapshotDigest: string;
      readonly episodeIdentityDigestsAtProposal: readonly string[];
      readonly episodeIdentitySetDigest: string;
      readonly distinctEpisodeCount: number;
      readonly supersedes: {
        readonly candidateId: string;
        readonly candidateDigest: string;
        readonly claimDigest: string;
      } | null;
      readonly claimDigest: string;
    };

export type CandidateRecurrenceLineage =
  | { readonly status: "not_bound"; readonly reason: "manual" | "derivation_unbound" | "historical_unbound" }
  | {
      readonly status: "resolved";
      readonly claimDigest: string;
      readonly groupKeyDigest: string;
      readonly derivationId: string;
      readonly derivationDigest: string;
      readonly episodeIdentitySetDigest: string;
      readonly distinctEpisodeCountAtProposal: number;
      readonly currentExecutionCount: number;
      readonly currentDistinctEpisodeCount: number;
    }
  | {
      readonly status: "invalid";
      readonly diagnostics: readonly Diagnostic[];
      readonly claim?: {
        readonly claimDigest: string;
        readonly groupKeyDigest: string;
        readonly derivationId: string;
        readonly derivationDigest: string;
        readonly episodeIdentitySetDigest: string;
        readonly distinctEpisodeCountAtProposal: number;
      };
    };

interface ClaimRef {
  readonly claimDigest: string;
}

interface StoredClaimRef {
  readonly id: string;
  readonly digest: string;
  readonly value: ClaimRef;
}

function digest(input: unknown): string {
  return sha256HexOfCanonicalJson(toJsonValue(input));
}

function parsePositiveCount(input: unknown, path: readonly (string | number)[]): number {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input < 1 || input > MAX_EPISODES) {
    throw invalid("schema.invalid", "recurrence claim count must be from 1 through 5000", path);
  }
  return input;
}

function parseEpisodeSet(
  fields: ReturnType<typeof readFields>,
  key: "episodeIdentityDigests" | "episodeIdentityDigestsAtProposal",
  path: readonly (string | number)[],
): { readonly values: readonly string[]; readonly setDigest: string; readonly count: number } {
  const values = fields.req(key, parseBoundedArray(parseDigestAt, MAX_EPISODES, "episode identity digests"));
  if (values.length === 0) throw invalid("schema.corrupt", "recurrence claim requires episode identity lineage", path);
  assertSortedUnique(values, (value) => value, [...path, key]);
  const setDigest = fields.req("episodeIdentitySetDigest", parseDigestAt);
  const count = fields.req("distinctEpisodeCount", parsePositiveCount);
  if (setDigest !== digest(values) || count !== values.length) {
    throw invalid("schema.corrupt", "recurrence claim episode-set summary is invalid", path);
  }
  return { values, setDigest, count };
}

function parseDerivationClaim(input: unknown): DerivationRecurrenceClaim {
  const fields = readFields(input, []);
  const schemaVersion = fields.schemaVersion1();
  const derivationDigest = fields.req("derivationDigest", parseDigestAt);
  const derivationId = fields.req("derivationId", parseDurableId);
  const executionKeyDigest = fields.req("executionKeyDigest", parseDigestAt);
  const executionId = fields.req("executionId", parseDurableId);
  if (derivationId !== `insight-${derivationDigest}` || executionId !== `detector-execution-${executionKeyDigest}`) {
    throw invalid("schema.corrupt", "recurrence claim ids do not match their exact digests", []);
  }
  const episodes = parseEpisodeSet(fields, "episodeIdentityDigests", []);
  const base = {
    derivationId,
    derivationDigest,
    executionId,
    executionKeyDigest,
    executionDigest: fields.req("executionDigest", parseDigestAt),
    scopeDigest: fields.req("scopeDigest", parseDigestAt),
    groupKeyDigest: fields.req("groupKeyDigest", parseDigestAt),
    decisionBindingDigest: fields.req("decisionBindingDigest", parseDigestAt),
    populationDigest: fields.req("populationDigest", parseDigestAt),
    episodeIdentityDigests: episodes.values,
    episodeIdentitySetDigest: episodes.setDigest,
    distinctEpisodeCount: episodes.count,
  };
  const claimDigest = fields.req("claimDigest", parseDigestAt);
  if (claimDigest !== digest(base))
    throw invalid("schema.corrupt", "derivation recurrence claim digest is invalid", []);
  return { schemaVersion, ...base, claimDigest };
}

const parseCandidateClaimRefAt: Parse<
  NonNullable<Extract<CandidateRecurrenceClaim, { status: "grouped" }>["supersedes"]>
> = (input, path) => {
  const fields = readFields(input, path);
  return {
    candidateId: fields.req("candidateId", parseDurableId),
    candidateDigest: fields.req("candidateDigest", parseDigestAt),
    claimDigest: fields.req("claimDigest", parseDigestAt),
  };
};

const parseProposalMemberAt: Parse<RecurrenceCommittedMemberSnapshot> = (input, path) => {
  const fields = readFields(input, path);
  const executionKeyDigest = fields.req("executionKeyDigest", parseDigestAt);
  const executionId = fields.req("executionId", parseDurableId);
  if (executionId !== `detector-execution-${executionKeyDigest}`) {
    throw invalid("schema.corrupt", "proposal recurrence member id does not match its execution key", path);
  }
  return {
    executionId,
    executionKeyDigest,
    executionDigest: fields.req("executionDigest", parseDigestAt),
    decisionBindingDigest: fields.req("decisionBindingDigest", parseDigestAt),
    memberDigest: fields.req("memberDigest", parseDigestAt),
  };
};

export function parseCandidateRecurrenceClaim(input: unknown): CandidateRecurrenceClaim {
  const fields = readFields(input, []);
  const schemaVersion = fields.schemaVersion1();
  const candidate = fields.req("candidate", (value) => {
    const parsed = parseCandidate(value);
    if (parsed.schemaVersion !== 2)
      throw invalid("schema.corrupt", "recurrence decision embeds legacy Candidate bytes", []);
    return parsed;
  });
  const common = {
    candidateId: fields.req("candidateId", parseDurableId),
    candidateDigest: fields.req("candidateDigest", parseDigestAt),
    scopeDigest: fields.req("scopeDigest", parseDigestAt),
    candidate,
  };
  if (
    candidate.id !== common.candidateId ||
    candidate.contentDigest !== common.candidateDigest ||
    candidateScopeDigest(candidate.scope) !== common.scopeDigest
  ) {
    throw invalid("schema.corrupt", "recurrence decision Candidate bytes are mismatched", []);
  }
  const status = fields.req("status", parseOneOf(["not_bound", "grouped"]));
  if (status === "not_bound") {
    const reason = fields.req("reason", parseOneOf(NOT_BOUND_REASONS));
    const base = { ...common, status: "not_bound" as const, reason };
    const manual = candidate.derivationRef === undefined;
    if ((reason === "manual") !== manual) {
      throw invalid("schema.corrupt", "recurrence decision reason does not match its Candidate bytes", []);
    }
    const claimDigest = fields.req("claimDigest", parseDigestAt);
    if (claimDigest !== digest(base))
      throw invalid("schema.corrupt", "Candidate recurrence decision digest is invalid", []);
    return { schemaVersion, ...base, claimDigest };
  }
  const derivationDigest = fields.req("derivationDigest", parseDigestAt);
  const derivationId = fields.req("derivationId", parseDurableId);
  if (derivationId !== `insight-${derivationDigest}`) {
    throw invalid("schema.corrupt", "Candidate recurrence derivation id does not match its digest", []);
  }
  const derivationClaimDigests = fields.req(
    "derivationClaimDigests",
    parseBoundedArray(parseDigestAt, MAX_CLAIMS, "derivation claim digests"),
  );
  if (derivationClaimDigests.length === 0) throw invalid("schema.corrupt", "grouped Candidate requires a claim", []);
  assertSortedUnique(derivationClaimDigests, (value) => value, ["derivationClaimDigests"]);
  const proposalMembers = fields.req(
    "proposalMembers",
    parseBoundedArray(parseProposalMemberAt, MAX_CLAIMS, "proposal recurrence members"),
  );
  if (proposalMembers.length === 0) {
    throw invalid("schema.corrupt", "grouped Candidate requires a proposal-time recurrence member", []);
  }
  assertSortedUnique(proposalMembers, (value) => value.executionId, ["proposalMembers"]);
  const proposalMemberSnapshotDigest = fields.req("proposalMemberSnapshotDigest", parseDigestAt);
  if (proposalMemberSnapshotDigest !== digest(proposalMembers)) {
    throw invalid("schema.corrupt", "Candidate proposal recurrence member snapshot digest is invalid", []);
  }
  const episodes = parseEpisodeSet(fields, "episodeIdentityDigestsAtProposal", []);
  const base = {
    ...common,
    status: "grouped" as const,
    derivationId,
    derivationDigest,
    derivationClaimDigests,
    groupKeyDigest: fields.req("groupKeyDigest", parseDigestAt),
    proposalMembers,
    proposalMemberSnapshotDigest,
    episodeIdentityDigestsAtProposal: episodes.values,
    episodeIdentitySetDigest: episodes.setDigest,
    distinctEpisodeCount: episodes.count,
    supersedes: fields.req("supersedes", parseNullable(parseCandidateClaimRefAt)),
  };
  if (
    candidate.derivationRef === undefined ||
    candidate.derivationRef.id !== derivationId ||
    candidate.derivationRef.digest !== derivationDigest ||
    (candidate.supersedes === undefined
      ? base.supersedes !== null
      : base.supersedes?.candidateId !== candidate.supersedes)
  ) {
    throw invalid("schema.corrupt", "grouped recurrence decision does not match its Candidate bytes", []);
  }
  const claimDigest = fields.req("claimDigest", parseDigestAt);
  if (claimDigest !== digest(base)) throw invalid("schema.corrupt", "Candidate recurrence claim digest is invalid", []);
  return { schemaVersion, ...base, claimDigest };
}

const parseStreamRefAt: Parse<StoredClaimRef> = (input, path) => {
  const fields = readFields(input, path);
  const valueFields = readFields(
    fields.req("value", (value) => value),
    [...path, "value"],
  );
  const value = { claimDigest: valueFields.req("claimDigest", parseDigestAt) };
  const id = fields.req("id", parseDurableId);
  const exactDigest = fields.req("digest", parseDigestAt);
  if (id !== `claim:${value.claimDigest}` || exactDigest !== recordDigest(toJsonValue(value))) {
    throw invalid("store.corrupt", "recurrence claim stream entry is invalid", path);
  }
  return { id, digest: exactDigest, value };
};

function parseStoredRefs(input: unknown, path: readonly (string | number)[]): readonly StoredClaimRef[] {
  if (!Array.isArray(input)) throw invalid("store.corrupt", "recurrence claim stream must be an array", path);
  if (input.length > MAX_CLAIMS) throw invalid("store.corrupt", "recurrence claim stream exceeds its ceiling", path);
  const refs = input.map((value: unknown, index: number) => parseStreamRefAt(value, [...path, index]));
  const ids = new Set<string>();
  for (const ref of refs) {
    if (ids.has(ref.id)) throw invalid("store.corrupt", "recurrence claim stream contains a duplicate", path);
    ids.add(ref.id);
  }
  return refs;
}

function streamEntry(claimDigest: string): StreamEntry {
  const value = toJsonValue({ claimDigest });
  return { id: `claim:${claimDigest}`, digest: recordDigest(value), value };
}

async function appendClaimRef(context: EngineContext, streamId: string, claimDigest: string): Promise<void> {
  const kind = "derivation-recurrence";
  const entry = streamEntry(claimDigest);
  for (let attempt = 0; attempt < MAX_APPEND_ATTEMPTS; attempt += 1) {
    const stored = await loadStoredRecord(context, kind, streamId);
    const refs = stored === undefined ? [] : parseStoredRefs(stored.value, [kind]);
    const existing = refs.find((ref) => ref.id === entry.id);
    if (existing !== undefined) {
      if (existing.digest !== entry.digest) throw invalid("store.corrupt", "recurrence claim ref changed", []);
      return;
    }
    if (refs.length >= MAX_CLAIMS) throw invalid("store.corrupt", "recurrence claim stream is at capacity", []);
    const raw: unknown = await context.store.append(
      recordKey(kind, streamId),
      stored?.revision,
      [entry],
      `${kind}/${streamId}/${entry.id}`,
    );
    const result = parseWriteResult(raw);
    if (result.status === "created" || result.status === "updated" || result.status === "exists_same") {
      const committed = await loadStoredRecord(context, kind, streamId);
      const committedRefs = committed === undefined ? [] : parseStoredRefs(committed.value, [kind]);
      if (!committedRefs.some((ref) => ref.id === entry.id && ref.digest === entry.digest)) {
        throw invalid("store.corrupt", "store acknowledged a derivation recurrence ref without preserving it", []);
      }
      return;
    }
  }
  throw new LearningLoopError("store.conflict", [
    { code: "store.conflict", severity: "error", message: "recurrence claim stream changed too many times" },
  ]);
}

interface CandidateGroupMember {
  readonly candidateId: string;
  readonly claimDigest: string;
}

interface StoredCandidateGroupMember {
  readonly id: string;
  readonly digest: string;
  readonly value: CandidateGroupMember;
}

const parseCandidateGroupMemberAt: Parse<StoredCandidateGroupMember> = (input, path) => {
  const fields = readFields(input, path);
  const valueFields = readFields(
    fields.req("value", (value) => value),
    [...path, "value"],
  );
  const value = {
    candidateId: valueFields.req("candidateId", parseDurableId),
    claimDigest: valueFields.req("claimDigest", parseDigestAt),
  };
  const id = fields.req("id", parseDurableId);
  const exactDigest = fields.req("digest", parseDigestAt);
  if (
    id !== `candidate:${value.candidateId}:${value.claimDigest}` ||
    exactDigest !== recordDigest(toJsonValue(value))
  ) {
    throw invalid("store.corrupt", "Candidate recurrence group entry is invalid", path);
  }
  return { id, digest: exactDigest, value };
};

function parseCandidateGroupMembers(
  input: unknown,
  path: readonly (string | number)[],
): readonly StoredCandidateGroupMember[] {
  if (!Array.isArray(input)) throw invalid("store.corrupt", "Candidate recurrence group stream must be an array", path);
  if (input.length > MAX_CLAIMS) throw invalid("store.corrupt", "Candidate recurrence group exceeds its ceiling", path);
  const members = input.map((value: unknown, index: number) => parseCandidateGroupMemberAt(value, [...path, index]));
  const ids = new Set<string>();
  for (const member of members) {
    if (ids.has(member.id)) throw invalid("store.corrupt", "Candidate recurrence group contains a duplicate", path);
    ids.add(member.id);
  }
  return members;
}

async function appendCandidateGroupMember(
  context: EngineContext,
  groupKeyDigest: string,
  claim: Extract<CandidateRecurrenceClaim, { status: "grouped" }>,
): Promise<void> {
  const value = toJsonValue({ candidateId: claim.candidateId, claimDigest: claim.claimDigest });
  const entry: StreamEntry = {
    id: `candidate:${claim.candidateId}:${claim.claimDigest}`,
    digest: recordDigest(value),
    value,
  };
  for (let attempt = 0; attempt < MAX_APPEND_ATTEMPTS; attempt += 1) {
    const stored = await loadStoredRecord(context, "detector-recurrence-group-candidate", groupKeyDigest);
    const members = stored === undefined ? [] : parseCandidateGroupMembers(stored.value, ["group-candidate"]);
    const existing = members.find((member) => member.id === entry.id);
    if (existing !== undefined) {
      if (existing.digest !== entry.digest) throw invalid("store.corrupt", "Candidate recurrence member changed", []);
      return;
    }
    if (members.length >= MAX_CLAIMS) throw invalid("store.corrupt", "Candidate recurrence group is at capacity", []);
    const raw: unknown = await context.store.append(
      recordKey("detector-recurrence-group-candidate", groupKeyDigest),
      stored?.revision,
      [entry],
      `detector-recurrence-group-candidate/${groupKeyDigest}/${entry.id}`,
    );
    const result = parseWriteResult(raw);
    if (result.status === "created" || result.status === "updated" || result.status === "exists_same") {
      const committed = await loadStoredRecord(context, "detector-recurrence-group-candidate", groupKeyDigest);
      const committedMembers =
        committed === undefined ? [] : parseCandidateGroupMembers(committed.value, ["group-candidate"]);
      if (!committedMembers.some((member) => member.id === entry.id && member.digest === entry.digest)) {
        throw invalid("store.corrupt", "store acknowledged a Candidate recurrence member without preserving it", []);
      }
      return;
    }
  }
  throw new LearningLoopError("store.conflict", [
    { code: "store.conflict", severity: "error", message: "Candidate recurrence group changed too many times" },
  ]);
}

export function buildDerivationRecurrenceClaims(
  execution: DetectorExecutionRecord,
  recurrenceBinding: ExecutionRecurrenceBinding | undefined,
  derivations: readonly InsightDerivation[],
): readonly DerivationRecurrenceClaim[] {
  if (
    recurrenceBinding === undefined ||
    recurrenceBinding.locator === null ||
    recurrenceBinding.groupKeyDigest === null
  ) {
    return [];
  }
  return derivations.map((derivation) => {
    const reference =
      execution.result.status === "applied"
        ? execution.result.derivationRefs.find((candidate) => candidate.id === derivation.id)
        : undefined;
    if (
      reference === undefined ||
      reference.derivationDigest !== derivation.derivationDigest ||
      derivation.scopeDigest !== execution.scopeDigest
    ) {
      throw invalid("store.corrupt", "derivation recurrence claim has no exact execution output", []);
    }
    const populationViews = new Map(
      derivation.population.episodes.map((episode) => [episode.episodeRecordId, episode]),
    );
    if (
      recurrenceBinding.memberEpisodes.length !== populationViews.size ||
      recurrenceBinding.memberEpisodes.some(
        (episode) => populationViews.get(episode.episodeRecordId)?.episodeViewDigest !== episode.episodeViewDigest,
      )
    ) {
      throw invalid("store.corrupt", "derivation recurrence population does not match its execution", []);
    }
    const episodeIdentityDigests = [
      ...new Set(recurrenceBinding.memberEpisodes.map((episode) => episode.episodeIdentityDigest)),
    ].sort((left, right) => (left < right ? -1 : 1));
    const base = {
      derivationId: derivation.id,
      derivationDigest: derivation.derivationDigest,
      executionId: execution.id,
      executionKeyDigest: execution.executionKeyDigest,
      executionDigest: execution.executionDigest,
      scopeDigest: execution.scopeDigest,
      groupKeyDigest: recurrenceBinding.groupKeyDigest,
      decisionBindingDigest: recurrenceBinding.bindingDigest,
      populationDigest: derivation.population.populationDigest,
      episodeIdentityDigests,
      episodeIdentitySetDigest: digest(episodeIdentityDigests),
      distinctEpisodeCount: episodeIdentityDigests.length,
    };
    return parseDerivationClaim({ schemaVersion: 1, ...base, claimDigest: digest(base) });
  });
}

export async function persistDerivationRecurrenceClaims(
  context: EngineContext,
  claims: readonly DerivationRecurrenceClaim[],
): Promise<void> {
  for (const claim of claims) {
    const status = await createOnly(
      context,
      "derivation-recurrence-claim",
      claim.claimDigest,
      claim,
      `derivation-recurrence-claim/${claim.claimDigest}`,
    );
    if (status === "conflict") throw invalid("store.corrupt", "derivation recurrence claim digest collision", []);
    await appendClaimRef(context, claim.derivationId, claim.claimDigest);
    const reloaded = await loadDerivationClaim(context, claim.claimDigest);
    if (recordDigest(toJsonValue(reloaded)) !== recordDigest(toJsonValue(claim))) {
      throw invalid("store.corrupt", "derivation recurrence claim was not preserved", []);
    }
  }
}

async function loadDerivationClaim(context: EngineContext, claimDigest: string): Promise<DerivationRecurrenceClaim> {
  const stored = await loadStoredRecord(context, "derivation-recurrence-claim", claimDigest);
  if (stored === undefined) throw invalid("store.corrupt", "derivation recurrence claim is missing", []);
  const claim = parseDerivationClaim(stored.value);
  if (claim.claimDigest !== claimDigest)
    throw invalid("store.corrupt", "derivation recurrence claim key is mismatched", []);
  return claim;
}

export async function loadCommittedDerivationRecurrenceClaims(
  context: EngineContext,
  derivationId: string,
  derivationDigest: string,
): Promise<readonly DerivationRecurrenceClaim[]> {
  const stored = await loadStoredRecord(context, "derivation-recurrence", derivationId);
  if (stored === undefined) return [];
  const refs = parseStoredRefs(stored.value, ["derivation-recurrence"]);
  const claims: DerivationRecurrenceClaim[] = [];
  const groupCache = new Map<string, { readonly executionIds: readonly string[] }>();
  for (const ref of refs) {
    const claim = await loadDerivationClaim(context, ref.value.claimDigest);
    if (claim.derivationId !== derivationId || claim.derivationDigest !== derivationDigest) {
      throw invalid("store.corrupt", "derivation recurrence stream references another derivation", []);
    }
    const firstGroupKey = claims[0]?.groupKeyDigest;
    if (firstGroupKey !== undefined && firstGroupKey !== claim.groupKeyDigest) {
      throw invalid("store.corrupt", "one derivation cannot bind multiple recurrence groups", []);
    }
    const execution = await loadDetectorExecutionRecord(context, claim.executionId);
    if (execution === undefined) continue;
    if (
      execution.executionDigest !== claim.executionDigest ||
      execution.executionKeyDigest !== claim.executionKeyDigest
    ) {
      throw invalid("store.corrupt", "derivation recurrence claim resolves another execution", []);
    }
    const derivation = await loadInsightDerivationRecord(context, derivationId);
    const binding = await loadExecutionRecurrenceBinding(context, execution.id);
    if (
      derivation === undefined ||
      derivation.derivationDigest !== derivationDigest ||
      binding === undefined ||
      binding.bindingDigest !== claim.decisionBindingDigest ||
      binding.groupKeyDigest !== claim.groupKeyDigest
    ) {
      throw invalid("store.corrupt", "derivation recurrence claim lineage is invalid", []);
    }
    const executionView = await loadDetectorExecutionView(context, execution.id, derivation.scope);
    if (executionView === undefined || executionView.commitBinding.status !== "committed") {
      throw invalid("store.corrupt", "derivation recurrence claim execution graph is not committed", []);
    }
    let recurrence = groupCache.get(claim.groupKeyDigest);
    if (recurrence === undefined) {
      if (groupCache.size >= MAX_CLAIM_GROUPS) {
        throw new LearningLoopError("detector.limit_exceeded", [
          {
            code: "detector.limit_exceeded",
            severity: "error",
            message: "derivation recurrence claims span too many groups",
          },
        ]);
      }
      const resolved = await recurrenceReceiptLineage(context, execution);
      recurrence = { executionIds: resolved.executionIds };
      groupCache.set(claim.groupKeyDigest, recurrence);
    }
    if (!recurrence.executionIds.includes(execution.id)) {
      throw invalid("store.corrupt", "derivation recurrence claim has no exact committed group member", []);
    }
    const expected = buildDerivationRecurrenceClaims(execution, binding, [derivation])[0];
    if (expected === undefined || recordDigest(toJsonValue(expected)) !== recordDigest(toJsonValue(claim))) {
      throw invalid("store.corrupt", "derivation recurrence claim does not match its exact durable lineage", []);
    }
    claims.push(claim);
  }
  return claims.sort((left, right) => (left.claimDigest < right.claimDigest ? -1 : 1));
}

function notBoundCandidateClaim(
  candidate: Candidate,
  reason: "manual" | "derivation_unbound",
): CandidateRecurrenceClaim {
  if (candidate.schemaVersion !== 2)
    throw invalid("store.corrupt", "new recurrence decision requires Candidate v2", []);
  const base = {
    candidateId: candidate.id,
    candidateDigest: candidate.contentDigest,
    scopeDigest: candidateScopeDigest(candidate.scope),
    candidate,
    status: "not_bound" as const,
    reason,
  };
  return parseCandidateRecurrenceClaim({ schemaVersion: 1, ...base, claimDigest: digest(base) });
}

function candidateClaimMatchesRecord(candidate: CandidateV2, claim: CandidateRecurrenceClaim): boolean {
  return (
    claim.candidateId === candidate.id &&
    claim.candidateDigest === candidate.contentDigest &&
    claim.scopeDigest === candidateScopeDigest(candidate.scope) &&
    recordDigest(toJsonValue(claim.candidate)) === recordDigest(toJsonValue(candidate))
  );
}

export async function prepareCandidateRecurrenceClaim(
  context: EngineContext,
  candidate: Candidate,
): Promise<CandidateRecurrenceClaim> {
  if (candidate.schemaVersion !== 2 || candidate.derivationRef === undefined)
    return notBoundCandidateClaim(candidate, "manual");
  const derivationClaims = await loadCommittedDerivationRecurrenceClaims(
    context,
    candidate.derivationRef.id,
    candidate.derivationRef.digest,
  );
  const groupKeys = new Set(derivationClaims.map((claim) => claim.groupKeyDigest));
  if (derivationClaims.length === 0 || groupKeys.size !== 1) {
    return notBoundCandidateClaim(candidate, "derivation_unbound");
  }
  const witnessClaim = derivationClaims[0];
  if (witnessClaim === undefined) return notBoundCandidateClaim(candidate, "derivation_unbound");
  const groupKeyDigest = witnessClaim.groupKeyDigest;
  const witnessExecution = await loadDetectorExecutionRecord(context, witnessClaim.executionId);
  if (witnessExecution === undefined) {
    throw invalid("store.corrupt", "Candidate recurrence witness execution is missing", []);
  }
  const groupLineage = await recurrenceReceiptLineage(context, witnessExecution);
  if (
    groupLineage.binding === undefined ||
    groupLineage.binding.groupKeyDigest !== groupKeyDigest ||
    !groupLineage.executionIds.includes(witnessExecution.id)
  ) {
    throw invalid("store.corrupt", "Candidate recurrence group lineage is mismatched", []);
  }
  let supersedes: Extract<CandidateRecurrenceClaim, { status: "grouped" }>["supersedes"] = null;
  if (candidate.supersedes !== undefined) {
    const predecessor = await loadCandidate(context, candidate.supersedes);
    const predecessorClaim = await loadCandidateRecurrenceClaim(context, candidate.supersedes);
    if (
      predecessor === undefined ||
      predecessorClaim?.status !== "grouped" ||
      predecessorClaim.groupKeyDigest !== groupKeyDigest ||
      predecessorClaim.candidateDigest !== predecessor.contentDigest ||
      predecessorClaim.scopeDigest !== candidateScopeDigest(predecessor.scope) ||
      predecessorClaim.scopeDigest !== candidateScopeDigest(candidate.scope)
    ) {
      return notBoundCandidateClaim(candidate, "derivation_unbound");
    }
    supersedes = {
      candidateId: predecessor.id,
      candidateDigest: predecessor.contentDigest,
      claimDigest: predecessorClaim.claimDigest,
    };
  }
  const episodeIdentityDigestsAtProposal = groupLineage.episodeIdentityDigests;
  const derivationClaimDigests = derivationClaims
    .map((claim) => claim.claimDigest)
    .sort((left, right) => (left < right ? -1 : 1));
  const base = {
    candidateId: candidate.id,
    candidateDigest: candidate.contentDigest,
    scopeDigest: candidateScopeDigest(candidate.scope),
    candidate,
    status: "grouped" as const,
    derivationId: candidate.derivationRef.id,
    derivationDigest: candidate.derivationRef.digest,
    derivationClaimDigests,
    groupKeyDigest,
    proposalMembers: groupLineage.members,
    proposalMemberSnapshotDigest: digest(groupLineage.members),
    episodeIdentityDigestsAtProposal,
    episodeIdentitySetDigest: digest(episodeIdentityDigestsAtProposal),
    distinctEpisodeCount: episodeIdentityDigestsAtProposal.length,
    supersedes,
  };
  return parseCandidateRecurrenceClaim({ schemaVersion: 1, ...base, claimDigest: digest(base) });
}

export async function loadCandidateRecurrenceClaim(
  context: EngineContext,
  candidateId: string,
): Promise<CandidateRecurrenceClaim | undefined> {
  const stored = await loadStoredRecord(context, "candidate-recurrence-claim", candidateId);
  if (stored === undefined) return undefined;
  const claim = parseCandidateRecurrenceClaim(stored.value);
  if (claim.candidateId !== candidateId)
    throw invalid("store.corrupt", "Candidate recurrence claim key is mismatched", []);
  return claim;
}

interface CandidateRecurrenceAnchor {
  readonly candidateId: string;
  readonly contentDigest: string;
  readonly recurrenceClaimDigest?: string;
  readonly recurrenceClaim?: CandidateRecurrenceClaim;
  readonly candidate?: CandidateV2;
}

async function loadCandidateRecurrenceAnchor(
  context: EngineContext,
  contentDigest: string,
): Promise<CandidateRecurrenceAnchor | undefined> {
  const stored = await loadStoredRecord(context, "candidate-by-digest", contentDigest);
  if (stored === undefined) return undefined;
  const fields = readFields(stored.value, ["candidate-by-digest"]);
  const recurrenceClaimDigest = fields.opt("recurrenceClaimDigest", parseDigestAt);
  const recurrenceClaim = fields.opt("recurrenceClaim", (value) => parseCandidateRecurrenceClaim(value));
  const candidate = fields.opt("candidate", (value) => {
    const parsed = parseCandidate(value);
    if (parsed.schemaVersion !== 2) throw invalid("store.corrupt", "candidate content lock embeds legacy bytes", []);
    return parsed;
  });
  if (
    (recurrenceClaimDigest === undefined) !== (recurrenceClaim === undefined) ||
    (recurrenceClaimDigest === undefined) !== (candidate === undefined) ||
    (recurrenceClaim !== undefined && recurrenceClaim.claimDigest !== recurrenceClaimDigest)
  ) {
    throw invalid("store.corrupt", "candidate content lock recurrence bytes are mismatched", []);
  }
  const candidateId = fields.req("candidateId", parseDurableId);
  const exactContentDigest = fields.req("contentDigest", parseDigestAt);
  if (
    candidate !== undefined &&
    (candidate.id !== candidateId ||
      candidate.contentDigest !== exactContentDigest ||
      recurrenceClaim === undefined ||
      !candidateClaimMatchesRecord(candidate, recurrenceClaim))
  ) {
    throw invalid("store.corrupt", "candidate content lock embedded bytes are mismatched", []);
  }
  return {
    candidateId,
    contentDigest: exactContentDigest,
    ...(recurrenceClaimDigest === undefined ? {} : { recurrenceClaimDigest }),
    ...(recurrenceClaim === undefined ? {} : { recurrenceClaim }),
    ...(candidate === undefined ? {} : { candidate }),
  };
}

export async function persistCandidateRecurrenceClaim(
  context: EngineContext,
  claim: CandidateRecurrenceClaim,
): Promise<void> {
  await persistCandidateRecurrenceDecision(context, claim);
  await persistCandidateRecurrenceGroupMember(context, claim);
}

export async function persistCandidateRecurrenceDecision(
  context: EngineContext,
  claim: CandidateRecurrenceClaim,
): Promise<void> {
  const status = await createOnly(
    context,
    "candidate-recurrence-claim",
    claim.candidateId,
    claim,
    `candidate-recurrence-claim/${claim.candidateId}/${claim.claimDigest}`,
  );
  if (status === "conflict") throw invalid("store.corrupt", "Candidate recurrence decision conflicts", []);
  const reloaded = await loadCandidateRecurrenceClaim(context, claim.candidateId);
  if (reloaded === undefined || recordDigest(toJsonValue(reloaded)) !== recordDigest(toJsonValue(claim))) {
    throw invalid("store.corrupt", "Candidate recurrence decision was not preserved", []);
  }
}

export async function persistCandidateRecurrenceGroupMember(
  context: EngineContext,
  claim: CandidateRecurrenceClaim,
): Promise<void> {
  if (claim.status === "grouped") {
    await appendCandidateGroupMember(context, claim.groupKeyDigest, claim);
    const stored = await loadStoredRecord(context, "detector-recurrence-group-candidate", claim.groupKeyDigest);
    const members = stored === undefined ? [] : parseCandidateGroupMembers(stored.value, ["group-candidate"]);
    if (
      !members.some(
        (member) => member.value.candidateId === claim.candidateId && member.value.claimDigest === claim.claimDigest,
      )
    ) {
      throw invalid("store.corrupt", "Candidate recurrence group member was not preserved", []);
    }
  }
}

export async function loadCandidateRecurrenceLineage(
  context: EngineContext,
  candidate: Candidate,
): Promise<CandidateRecurrenceLineage> {
  const anchor = await loadCandidateRecurrenceAnchor(context, candidate.contentDigest);
  const claim = await loadCandidateRecurrenceClaim(context, candidate.id);
  if (claim === undefined) {
    if (
      anchor !== undefined &&
      anchor.candidateId === candidate.id &&
      anchor.contentDigest === candidate.contentDigest &&
      anchor.recurrenceClaimDigest !== undefined
    ) {
      return {
        status: "invalid",
        diagnostics: [claimDiagnostic("claim-aware Candidate is missing its anchored recurrence decision")],
      };
    }
    return { status: "not_bound", reason: "historical_unbound" };
  }
  if (
    anchor?.candidate !== undefined &&
    recordDigest(toJsonValue(anchor.candidate)) !== recordDigest(toJsonValue(candidate))
  ) {
    throw invalid("store.corrupt", "terminal Candidate bytes differ from their claim-aware content lock", []);
  }
  if (
    recordDigest(toJsonValue(claim.candidate)) !== recordDigest(toJsonValue(candidate)) &&
    anchor?.recurrenceClaimDigest !== undefined
  ) {
    throw invalid("store.corrupt", "terminal Candidate bytes differ from their recurrence decision", []);
  }
  if (
    anchor === undefined ||
    anchor.candidateId !== candidate.id ||
    anchor.contentDigest !== candidate.contentDigest ||
    anchor.recurrenceClaimDigest !== claim.claimDigest ||
    anchor.recurrenceClaim === undefined ||
    recordDigest(toJsonValue(anchor.recurrenceClaim)) !== recordDigest(toJsonValue(claim)) ||
    anchor.candidate === undefined
  ) {
    return {
      status: "invalid",
      diagnostics: [claimDiagnostic("Candidate recurrence decision is not bound by its content-ownership lock")],
    };
  }
  if (
    claim.candidateDigest !== candidate.contentDigest ||
    claim.scopeDigest !== candidateScopeDigest(candidate.scope)
  ) {
    return { status: "invalid", diagnostics: [claimDiagnostic("candidate recurrence claim is mismatched")] };
  }
  if (claim.status === "not_bound") {
    const manual = candidate.schemaVersion !== 2 || candidate.derivationRef === undefined;
    if ((claim.reason === "manual") !== manual) {
      return {
        status: "invalid",
        diagnostics: [claimDiagnostic("candidate recurrence decision reason is mismatched")],
      };
    }
    return { status: "not_bound", reason: claim.reason };
  }
  try {
    if (
      candidate.schemaVersion !== 2 ||
      candidate.derivationRef === undefined ||
      candidate.derivationRef.id !== claim.derivationId ||
      candidate.derivationRef.digest !== claim.derivationDigest
    ) {
      throw recurrenceInvalid("Candidate recurrence claim does not match its derivation binding");
    }
    const derivationClaims = await loadCommittedDerivationRecurrenceClaims(
      context,
      claim.derivationId,
      claim.derivationDigest,
    );
    const exactClaims = new Map(derivationClaims.map((value) => [value.claimDigest, value]));
    if (
      claim.derivationClaimDigests.some(
        (claimDigest) => exactClaims.get(claimDigest)?.groupKeyDigest !== claim.groupKeyDigest,
      )
    ) {
      throw recurrenceInvalid("Candidate recurrence derivation claims are mismatched");
    }
    const witnessEpisodes = [
      ...new Set(
        claim.derivationClaimDigests.flatMap(
          (claimDigest) => exactClaims.get(claimDigest)?.episodeIdentityDigests ?? [],
        ),
      ),
    ].sort((left, right) => (left < right ? -1 : 1));
    if (witnessEpisodes.some((episodeDigest) => !claim.episodeIdentityDigestsAtProposal.includes(episodeDigest))) {
      throw recurrenceInvalid("Candidate recurrence proposal baseline omits its derivation evidence");
    }
    if (claim.supersedes !== null) {
      const predecessor = await loadCandidate(context, claim.supersedes.candidateId);
      const predecessorClaim = await loadCandidateRecurrenceClaim(context, claim.supersedes.candidateId);
      if (
        predecessor === undefined ||
        predecessor.contentDigest !== claim.supersedes.candidateDigest ||
        predecessorClaim?.claimDigest !== claim.supersedes.claimDigest ||
        predecessorClaim.status !== "grouped" ||
        predecessorClaim.groupKeyDigest !== claim.groupKeyDigest ||
        predecessorClaim.candidateDigest !== predecessor.contentDigest ||
        predecessorClaim.scopeDigest !== candidateScopeDigest(predecessor.scope) ||
        predecessorClaim.scopeDigest !== claim.scopeDigest ||
        candidate.supersedes !== predecessor.id
      ) {
        throw recurrenceInvalid("Candidate recurrence predecessor is mismatched");
      }
    } else if (candidate.supersedes !== undefined) {
      throw recurrenceInvalid("Candidate recurrence claim omitted its exact predecessor");
    }
    const stream = await loadStoredRecord(context, "detector-recurrence-group-candidate", claim.groupKeyDigest);
    const members = stream === undefined ? [] : parseCandidateGroupMembers(stream.value, ["group-candidate"]);
    if (
      !members.some(
        (member) => member.value.candidateId === claim.candidateId && member.value.claimDigest === claim.claimDigest,
      )
    ) {
      throw recurrenceInvalid("Candidate recurrence group member is missing");
    }
    const witness = derivationClaims.find((value) => value.groupKeyDigest === claim.groupKeyDigest);
    if (witness === undefined) throw recurrenceInvalid("Candidate recurrence claim has no witness");
    const execution = await loadDetectorExecutionRecord(context, witness.executionId);
    if (execution === undefined) throw recurrenceInvalid("Candidate recurrence witness execution is missing");
    const current = await recurrenceReceiptLineage(context, execution);
    if (
      current.binding?.groupKeyDigest !== claim.groupKeyDigest ||
      claim.episodeIdentityDigestsAtProposal.some(
        (episodeDigest) => !current.episodeIdentityDigests.includes(episodeDigest),
      )
    ) {
      throw recurrenceInvalid("Candidate recurrence proposal baseline is not retained by its current group");
    }
    const currentMembers = new Map(current.members.map((member) => [member.executionId, member]));
    const proposalEpisodeDigests = new Set<string>();
    for (const frozenMember of claim.proposalMembers) {
      const currentMember = currentMembers.get(frozenMember.executionId);
      if (
        currentMember === undefined ||
        recordDigest(toJsonValue(currentMember)) !== recordDigest(toJsonValue(frozenMember))
      ) {
        throw recurrenceInvalid("Candidate recurrence proposal member snapshot is not an exact current subset");
      }
      const memberExecution = await loadDetectorExecutionRecord(context, frozenMember.executionId);
      const memberBinding = await loadExecutionRecurrenceBinding(context, frozenMember.executionId);
      if (
        memberExecution === undefined ||
        memberExecution.executionKeyDigest !== frozenMember.executionKeyDigest ||
        memberExecution.executionDigest !== frozenMember.executionDigest ||
        memberBinding === undefined ||
        memberBinding.bindingDigest !== frozenMember.decisionBindingDigest ||
        memberBinding.groupKeyDigest !== claim.groupKeyDigest
      ) {
        throw recurrenceInvalid("Candidate recurrence proposal member lineage is mismatched");
      }
      for (const episode of memberBinding.memberEpisodes) proposalEpisodeDigests.add(episode.episodeIdentityDigest);
    }
    const proposalEpisodes = [...proposalEpisodeDigests].sort((left, right) => (left < right ? -1 : 1));
    if (
      recordDigest(toJsonValue(proposalEpisodes)) !==
        recordDigest(toJsonValue(claim.episodeIdentityDigestsAtProposal)) ||
      claim.episodeIdentitySetDigest !== digest(proposalEpisodes) ||
      claim.distinctEpisodeCount !== proposalEpisodes.length
    ) {
      throw recurrenceInvalid("Candidate recurrence proposal baseline is mismatched");
    }
    return {
      status: "resolved",
      claimDigest: claim.claimDigest,
      groupKeyDigest: claim.groupKeyDigest,
      derivationId: claim.derivationId,
      derivationDigest: claim.derivationDigest,
      episodeIdentitySetDigest: claim.episodeIdentitySetDigest,
      distinctEpisodeCountAtProposal: claim.distinctEpisodeCount,
      currentExecutionCount: current.executionCount,
      currentDistinctEpisodeCount: current.episodeIdentityDigests.length,
    };
  } catch (error) {
    if (error instanceof LearningLoopError && error.code === "store.corrupt") throw error;
    const diagnostics =
      error instanceof LearningLoopError
        ? error.diagnostics
        : [claimDiagnostic("Candidate recurrence lineage is unreadable")];
    return {
      status: "invalid",
      diagnostics,
      claim: {
        claimDigest: claim.claimDigest,
        groupKeyDigest: claim.groupKeyDigest,
        derivationId: claim.derivationId,
        derivationDigest: claim.derivationDigest,
        episodeIdentitySetDigest: claim.episodeIdentitySetDigest,
        distinctEpisodeCountAtProposal: claim.distinctEpisodeCount,
      },
    };
  }
}

function claimDiagnostic(message: string): Diagnostic {
  return { code: "candidate.recurrence_invalid", severity: "error", message };
}

function recurrenceInvalid(message: string): LearningLoopError {
  return new LearningLoopError("candidate.recurrence_invalid", [claimDiagnostic(message)]);
}
