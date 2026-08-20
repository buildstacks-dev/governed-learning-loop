// Content-bound, scope-exact audit receipt for one configured detector-pack run.
import { Buffer } from "node:buffer";
import { canonicalJsonText, sha256HexOfCanonicalJson } from "../canonical/canonical-json.js";
import { toJsonValue } from "../canonical/to-json-value.js";
import { invalid, parseFiniteNumber, parseOneOf, readFields } from "../parse/toolkit.js";
import type { Parse } from "../parse/toolkit.js";
import type { DetectorOutputKind } from "./detector-registration.js";
import type { DetectorRecurrenceLocator } from "./detector-recurrence.js";
import { parseDetectorRecurrenceLocatorAt } from "./detector-recurrence.js";
import type { DetectorOrchestrationPolicy } from "./detector-orchestration-policy.js";
import { parseDetectorOrchestrationPolicy } from "./detector-orchestration-policy.js";
import type { Scope } from "./scope.js";
import {
  assertSortedUnique,
  canonicalKey,
  detectorRefKey,
  lensRefKey,
  parseBoundedArray,
  parseDetectorRefAt,
  parseDigestAt,
  parseDurableId,
  parseId,
  parseLensRefAt,
  parseNullable,
  parsePackRefAt,
  parseScopeAt,
  scopeDigest,
} from "./semantic-shared.js";

const EXECUTION_DISPOSITIONS = ["executed", "not_applicable", "incomplete", "capped", "refused"] as const;
const ABSENT_REASONS = [
  "execution_not_materialized",
  "execution_not_applied",
  "condition_not_detected",
  "locator_unavailable",
  "result_not_retained",
] as const;
const GROUP_DISPOSITIONS = ["available", "deduplicated", "suppressed", "capped"] as const;
const REVIEW_DISPOSITIONS = ["accept", "revise", "reject", "escalate"] as const;
const OUTPUT_KINDS: readonly DetectorOutputKind[] = ["evidence_health", "insight_derivation"];
const RECEIPT_STATUSES = ["completed", "partial"] as const;
const MAX_ITEMS = 5_000;
const MAX_EPISODES = 500;
const MAX_GROUP_EPISODES = 5_000;
const MAX_CANDIDATES = 5_000;
const MAX_REASONS = 1_000;
const MAX_TOTAL_GROUP_IDENTITIES = 50_000;
const MAX_TOTAL_CANDIDATE_BINDINGS = 50_000;
const MAX_RECEIPT_BYTES = 64 * 1_048_576;

type DetectorProjection = {
  readonly id: string;
  readonly version: string;
  readonly registrationDigest: string;
  readonly configurationDigest: string;
  readonly implementationDigest: string;
};

type CandidateBinding = {
  readonly candidateId: string;
  readonly candidateDigest: string;
  readonly claimDigest: string;
  readonly derivationId: string;
  readonly derivationDigest: string;
  readonly episodeIdentitySetDigest: string;
  readonly distinctEpisodeCount: number;
  readonly supersedes: {
    readonly candidateId: string;
    readonly candidateDigest: string;
    readonly claimDigest: string;
  } | null;
  readonly latestReview: {
    readonly id: string;
    readonly recordDigest: string;
    readonly disposition: (typeof REVIEW_DISPOSITIONS)[number];
    readonly reviewedAt: string;
  } | null;
};

export type DetectorPackRunGroupGovernance =
  | {
      readonly status: "not_assessed";
      readonly reason:
        | "candidate_claims_deferred"
        | "candidate_review_history_unavailable"
        | "candidate_governance_not_applicable"
        | "candidate_governance_incomplete"
        | "candidate_governance_capped";
      readonly groupDisposition: "unassessed" | "capped";
    }
  | {
      readonly status: "assessed";
      readonly candidateBindings: readonly CandidateBinding[];
      readonly groupDisposition: (typeof GROUP_DISPOSITIONS)[number];
      readonly requiredSupersedes: {
        readonly candidateId: string;
        readonly candidateDigest: string;
        readonly claimDigest: string;
      } | null;
      readonly requiredOverrideCount: number | null;
      readonly governingRejection: {
        readonly candidateId: string;
        readonly candidateDigest: string;
        readonly claimDigest: string;
        readonly reviewId: string;
        readonly reviewRecordDigest: string;
      } | null;
      readonly reasonCodes: readonly string[];
    };

type AssessedGovernance = Extract<GroupGovernance, { status: "assessed" }>;
type GroupGovernance = DetectorPackRunGroupGovernance;

type ReceiptRecurrence =
  | {
      readonly status: "absent";
      readonly reason: (typeof ABSENT_REASONS)[number];
      readonly decisionBindingDigest: string | null;
    }
  | {
      readonly status: "grouped";
      readonly groupKeyDigest: string;
      readonly locator: DetectorRecurrenceLocator;
      readonly decisionBindingDigest: string;
      readonly executionCount: number;
      readonly distinctEpisodeCount: number;
      readonly episodeIdentityDigests: readonly string[];
      readonly episodeIdentitySetDigest: string;
      readonly governance: GroupGovernance;
    };

export interface DetectorPackRunReceipt {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly loopRegistryRevision: string;
  readonly semanticRegistryDigest: string;
  readonly policy: DetectorOrchestrationPolicy;
  readonly pack: { readonly id: string; readonly version: string; readonly manifestDigest: string };
  readonly scope: Scope;
  readonly scopeDigest: string;
  readonly scopePolicyDigest: string;
  readonly population: {
    readonly requestedEpisodeRecordIds: readonly string[];
    readonly resolvedEpisodes: readonly {
      readonly episodeRecordId: string;
      readonly episodeRecordDigest: string;
      readonly episodeIdentityDigest: string;
      readonly outcomeClaimDigest: string | null;
      readonly episodeViewDigest: string;
      readonly scopeDigest: string;
    }[];
    readonly populationDigest: string;
  };
  readonly governanceSnapshotDigest: string;
  readonly items: readonly {
    readonly detector: DetectorProjection;
    readonly lens: { readonly id: string; readonly version: string; readonly registrationDigest: string } | null;
    readonly outputKind: DetectorOutputKind;
    readonly executionDisposition: (typeof EXECUTION_DISPOSITIONS)[number];
    readonly executionRef: {
      readonly id: string;
      readonly executionKeyDigest: string;
      readonly executionDigest: string;
    } | null;
    readonly recurrence: ReceiptRecurrence;
    readonly reasonCodes: readonly string[];
    readonly itemDigest: string;
  }[];
  readonly status: "completed" | "partial";
  readonly packRunKeyDigest: string;
  readonly receiptDigest: string;
}

function parseSafeCount(maximum: number, label: string): Parse<number> {
  return (input, path) => {
    const value = parseFiniteNumber(input, path);
    if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
      throw invalid("schema.invalid", `${label} must be an integer from 0 through ${maximum}`, path);
    }
    return value;
  };
}

function parseDetectorProjectionAt(input: unknown, path: readonly (string | number)[]): DetectorProjection {
  const fields = readFields(input, path);
  const reference = parseDetectorRefAt(input, path);
  return {
    ...reference,
    configurationDigest: fields.req("configurationDigest", parseDigestAt),
    implementationDigest: fields.req("implementationDigest", parseDigestAt),
  };
}

const parseExecutionRefAt: Parse<NonNullable<DetectorPackRunReceipt["items"][number]["executionRef"]>> = (
  input,
  path,
) => {
  const fields = readFields(input, path);
  const executionKeyDigest = fields.req("executionKeyDigest", parseDigestAt);
  const id = fields.req("id", parseDurableId);
  if (id !== `detector-execution-${executionKeyDigest}`) {
    throw invalid("schema.corrupt", "pack receipt execution id does not match its key digest", [...path, "id"]);
  }
  return {
    id,
    executionKeyDigest,
    executionDigest: fields.req("executionDigest", parseDigestAt),
  };
};

function parseCanonicalTimestamp(input: unknown, path: readonly (string | number)[]): string {
  if (typeof input !== "string") throw invalid("schema.invalid", "review timestamp must be a string", path);
  const milliseconds = Date.parse(input);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== input) {
    throw invalid("schema.invalid", "review timestamp must be canonical UTC with milliseconds", path);
  }
  return input;
}

const parseCandidateClaimRefAt: Parse<NonNullable<CandidateBinding["supersedes"]>> = (input, path) => {
  const fields = readFields(input, path);
  return {
    candidateId: fields.req("candidateId", parseDurableId),
    candidateDigest: fields.req("candidateDigest", parseDigestAt),
    claimDigest: fields.req("claimDigest", parseDigestAt),
  };
};

const parseCandidateBindingAt: Parse<CandidateBinding> = (input, path) => {
  const fields = readFields(input, path);
  const derivationId = fields.req("derivationId", parseDurableId);
  const derivationDigest = fields.req("derivationDigest", parseDigestAt);
  if (derivationId !== `insight-${derivationDigest}`) {
    throw invalid("schema.corrupt", "candidate binding derivation id does not match its digest", path);
  }
  const latestReview = fields.req(
    "latestReview",
    parseNullable((value, reviewPath) => {
      const nested = readFields(value, reviewPath);
      return {
        id: nested.req("id", parseDurableId),
        recordDigest: nested.req("recordDigest", parseDigestAt),
        disposition: nested.req("disposition", parseOneOf(REVIEW_DISPOSITIONS)),
        reviewedAt: nested.req("reviewedAt", parseCanonicalTimestamp),
      };
    }),
  );
  const distinctEpisodeCount = fields.req("distinctEpisodeCount", parseSafeCount(MAX_GROUP_EPISODES, "episode count"));
  if (distinctEpisodeCount === 0) {
    throw invalid("schema.corrupt", "candidate binding requires at least one qualified episode", path);
  }
  return {
    candidateId: fields.req("candidateId", parseDurableId),
    candidateDigest: fields.req("candidateDigest", parseDigestAt),
    claimDigest: fields.req("claimDigest", parseDigestAt),
    derivationId,
    derivationDigest,
    episodeIdentitySetDigest: fields.req("episodeIdentitySetDigest", parseDigestAt),
    distinctEpisodeCount,
    supersedes: fields.req("supersedes", parseNullable(parseCandidateClaimRefAt)),
    latestReview,
  };
};

function parseSortedReasons(input: unknown, path: readonly (string | number)[]): readonly string[] {
  const values = parseBoundedArray(parseId, MAX_REASONS, "reason codes")(input, path);
  assertSortedUnique(values, (value) => value, path);
  return values;
}

const parseGovernanceAt: Parse<GroupGovernance> = (input, path) => {
  const fields = readFields(input, path);
  const status = fields.req("status", parseOneOf(["not_assessed", "assessed"]));
  if (status === "not_assessed") {
    return {
      status,
      reason: fields.req(
        "reason",
        parseOneOf([
          "candidate_claims_deferred",
          "candidate_review_history_unavailable",
          "candidate_governance_not_applicable",
          "candidate_governance_incomplete",
          "candidate_governance_capped",
        ]),
      ),
      groupDisposition: fields.req("groupDisposition", parseOneOf(["unassessed", "capped"])),
    };
  }
  const candidateBindings = fields.req(
    "candidateBindings",
    parseBoundedArray(parseCandidateBindingAt, MAX_CANDIDATES, "candidate bindings"),
  );
  assertSortedUnique(candidateBindings, (value) => value.candidateId, [...path, "candidateBindings"]);
  const candidateDigests = new Set<string>();
  const claimDigests = new Set<string>();
  for (const [index, binding] of candidateBindings.entries()) {
    if (candidateDigests.has(binding.candidateDigest) || claimDigests.has(binding.claimDigest)) {
      throw invalid("schema.corrupt", "candidate governance bindings must be exact and unique", [
        ...path,
        "candidateBindings",
        index,
      ]);
    }
    candidateDigests.add(binding.candidateDigest);
    claimDigests.add(binding.claimDigest);
  }
  const requiredSupersedes = fields.req("requiredSupersedes", parseNullable(parseCandidateClaimRefAt));
  const requiredOverrideCount = fields.req(
    "requiredOverrideCount",
    parseNullable(parseSafeCount(Number.MAX_SAFE_INTEGER, "required override count")),
  );
  const governingRejection = fields.req(
    "governingRejection",
    parseNullable((value, rejectionPath) => {
      const nested = readFields(value, rejectionPath);
      return {
        candidateId: nested.req("candidateId", parseDurableId),
        candidateDigest: nested.req("candidateDigest", parseDigestAt),
        claimDigest: nested.req("claimDigest", parseDigestAt),
        reviewId: nested.req("reviewId", parseDurableId),
        reviewRecordDigest: nested.req("reviewRecordDigest", parseDigestAt),
      };
    }),
  );
  const groupDisposition = fields.req("groupDisposition", parseOneOf(GROUP_DISPOSITIONS));
  if (
    (requiredOverrideCount === null) !== (governingRejection === null) ||
    (groupDisposition === "suppressed" && governingRejection === null)
  ) {
    throw invalid("schema.corrupt", "assessed governance suppression fields are inconsistent", path);
  }
  if (governingRejection !== null) {
    const governingBinding = candidateBindings.find(
      (binding) =>
        binding.candidateId === governingRejection.candidateId &&
        binding.candidateDigest === governingRejection.candidateDigest &&
        binding.claimDigest === governingRejection.claimDigest,
    );
    if (
      governingBinding?.latestReview === null ||
      governingBinding?.latestReview === undefined ||
      governingBinding.latestReview.id !== governingRejection.reviewId ||
      governingBinding.latestReview.recordDigest !== governingRejection.reviewRecordDigest ||
      governingBinding.latestReview.disposition !== "reject"
    ) {
      throw invalid("schema.corrupt", "governing rejection does not resolve an exact rejected candidate binding", path);
    }
  }
  if (
    requiredSupersedes !== null &&
    !candidateBindings.some(
      (binding) =>
        binding.candidateId === requiredSupersedes.candidateId &&
        binding.candidateDigest === requiredSupersedes.candidateDigest &&
        binding.claimDigest === requiredSupersedes.claimDigest,
    )
  ) {
    throw invalid("schema.corrupt", "required predecessor does not resolve an exact candidate binding", path);
  }
  const reasonCodes = fields.req("reasonCodes", parseSortedReasons);
  if (
    groupDisposition === "capped" &&
    (candidateBindings.length !== 0 ||
      requiredSupersedes !== null ||
      requiredOverrideCount !== null ||
      governingRejection !== null ||
      reasonCodes.length !== 1 ||
      reasonCodes[0] !== "detector.pack_group_capped")
  ) {
    throw invalid("schema.corrupt", "legacy assessed capped governance has noncanonical fields", path);
  }
  return {
    status: "assessed",
    candidateBindings,
    groupDisposition,
    requiredSupersedes,
    requiredOverrideCount,
    governingRejection,
    reasonCodes,
  };
};

export function parseDetectorPackRunGroupGovernance(input: unknown): DetectorPackRunGroupGovernance {
  return parseGovernanceAt(toJsonValue(input), []);
}

function candidateBindingRef(binding: CandidateBinding): NonNullable<AssessedGovernance["requiredSupersedes"]> {
  return {
    candidateId: binding.candidateId,
    candidateDigest: binding.candidateDigest,
    claimDigest: binding.claimDigest,
  };
}

function reviewedCandidateKey(binding: CandidateBinding): string {
  const review = binding.latestReview;
  return canonicalKey([
    binding.candidateId,
    binding.candidateDigest,
    binding.claimDigest,
    review?.id ?? "",
    review?.recordDigest ?? "",
  ]);
}

export function classifyAssessedRecurrenceGovernance(input: {
  readonly policy: DetectorOrchestrationPolicy;
  readonly currentDistinctEpisodeCount: number;
  readonly candidateBindings: readonly CandidateBinding[];
}): AssessedGovernance {
  const candidateBindings = input.candidateBindings;
  if (candidateBindings.length === 0) {
    return {
      status: "assessed",
      candidateBindings,
      groupDisposition: "available",
      requiredSupersedes: null,
      requiredOverrideCount: null,
      governingRejection: null,
      reasonCodes: ["candidate.group_available"],
    };
  }
  const suppressed: Array<{
    readonly binding: CandidateBinding;
    readonly requiredOverrideCount: number;
  }> = [];
  const required: CandidateBinding[] = [];
  let deduplicated = false;
  for (const binding of candidateBindings) {
    const disposition = binding.latestReview?.disposition;
    if (disposition === undefined || disposition === "accept" || disposition === "escalate") {
      deduplicated = true;
      continue;
    }
    if (disposition === "revise" || input.policy.rejectionSuppression.mode === "disabled") {
      required.push(binding);
      continue;
    }
    const requiredOverrideCount = Math.ceil(
      binding.distinctEpisodeCount * input.policy.rejectionSuppression.minimumDistinctEpisodeMultiplier,
    );
    if (!Number.isSafeInteger(requiredOverrideCount)) {
      throw invalid("schema.invalid", "rejection evidence threshold overflowed", []);
    }
    if (input.currentDistinctEpisodeCount < requiredOverrideCount) {
      suppressed.push({ binding, requiredOverrideCount });
    } else required.push(binding);
  }
  if (suppressed.length > 0) {
    const strictest = [...suppressed].sort((left, right) => {
      if (left.requiredOverrideCount !== right.requiredOverrideCount) {
        return right.requiredOverrideCount - left.requiredOverrideCount;
      }
      const leftKey = reviewedCandidateKey(left.binding);
      const rightKey = reviewedCandidateKey(right.binding);
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    })[0];
    if (strictest === undefined || strictest.binding.latestReview === null) {
      throw invalid("schema.corrupt", "suppressed governance has no exact rejection", []);
    }
    const reference = candidateBindingRef(strictest.binding);
    return {
      status: "assessed",
      candidateBindings,
      groupDisposition: "suppressed",
      requiredSupersedes: reference,
      requiredOverrideCount: strictest.requiredOverrideCount,
      governingRejection: {
        ...reference,
        reviewId: strictest.binding.latestReview.id,
        reviewRecordDigest: strictest.binding.latestReview.recordDigest,
      },
      reasonCodes: ["candidate.rejection_suppressed"],
    };
  }
  if (deduplicated) {
    return {
      status: "assessed",
      candidateBindings,
      groupDisposition: "deduplicated",
      requiredSupersedes: null,
      requiredOverrideCount: null,
      governingRejection: null,
      reasonCodes: ["candidate.group_deduplicated"],
    };
  }
  if (required.length > 1) {
    return {
      status: "assessed",
      candidateBindings,
      groupDisposition: "deduplicated",
      requiredSupersedes: null,
      requiredOverrideCount: null,
      governingRejection: null,
      reasonCodes: ["candidate.frontier_ambiguous", "candidate.group_deduplicated"],
    };
  }
  const binding = required[0];
  if (binding === undefined || binding.latestReview === null) {
    throw invalid("schema.corrupt", "available governance has no exact required Candidate", []);
  }
  const reference = candidateBindingRef(binding);
  if (binding.latestReview.disposition === "revise") {
    return {
      status: "assessed",
      candidateBindings,
      groupDisposition: "available",
      requiredSupersedes: reference,
      requiredOverrideCount: null,
      governingRejection: null,
      reasonCodes: ["candidate.revision_required"],
    };
  }
  if (input.policy.rejectionSuppression.mode === "disabled") {
    return {
      status: "assessed",
      candidateBindings,
      groupDisposition: "available",
      requiredSupersedes: reference,
      requiredOverrideCount: null,
      governingRejection: null,
      reasonCodes: ["candidate.rejection_suppression_disabled"],
    };
  }
  const requiredOverrideCount = Math.ceil(
    binding.distinctEpisodeCount * input.policy.rejectionSuppression.minimumDistinctEpisodeMultiplier,
  );
  return {
    status: "assessed",
    candidateBindings,
    groupDisposition: "available",
    requiredSupersedes: reference,
    requiredOverrideCount,
    governingRejection: {
      ...reference,
      reviewId: binding.latestReview.id,
      reviewRecordDigest: binding.latestReview.recordDigest,
    },
    reasonCodes: ["candidate.rejection_override_available"],
  };
}

const parseRecurrenceAt: Parse<ReceiptRecurrence> = (input, path) => {
  const fields = readFields(input, path);
  const status = fields.req("status", parseOneOf(["absent", "grouped"]));
  if (status === "absent") {
    const reason = fields.req("reason", parseOneOf(ABSENT_REASONS));
    const decisionBindingDigest = fields.req("decisionBindingDigest", parseNullable(parseDigestAt));
    if (reason !== "locator_unavailable" && decisionBindingDigest !== null) {
      throw invalid("schema.corrupt", "only locator-unavailable recurrence can retain a null decision binding", path);
    }
    return {
      status,
      reason,
      decisionBindingDigest,
    };
  }
  const episodeIdentityDigests = fields.req(
    "episodeIdentityDigests",
    parseBoundedArray(parseDigestAt, MAX_GROUP_EPISODES, "episode identity digests"),
  );
  assertSortedUnique(episodeIdentityDigests, (value) => value, [...path, "episodeIdentityDigests"]);
  if (episodeIdentityDigests.length === 0) {
    throw invalid("schema.corrupt", "grouped recurrence requires at least one episode identity", path);
  }
  const distinctEpisodeCount = fields.req(
    "distinctEpisodeCount",
    parseSafeCount(MAX_GROUP_EPISODES, "distinct episode count"),
  );
  if (distinctEpisodeCount !== episodeIdentityDigests.length) {
    throw invalid("schema.corrupt", "pack receipt episode count does not match its exact identity set", path);
  }
  const episodeIdentitySetDigest = fields.req("episodeIdentitySetDigest", parseDigestAt);
  if (episodeIdentitySetDigest !== sha256HexOfCanonicalJson(toJsonValue(episodeIdentityDigests))) {
    throw invalid("schema.corrupt", "pack receipt episode identity-set digest is invalid", path);
  }
  return {
    status: "grouped",
    groupKeyDigest: fields.req("groupKeyDigest", parseDigestAt),
    locator: fields.req("locator", parseDetectorRecurrenceLocatorAt),
    decisionBindingDigest: fields.req("decisionBindingDigest", parseDigestAt),
    executionCount: fields.req("executionCount", (value, countPath) => {
      const count = parseSafeCount(5_000, "execution count")(value, countPath);
      if (count === 0) throw invalid("schema.corrupt", "grouped recurrence requires a committed execution", countPath);
      return count;
    }),
    distinctEpisodeCount,
    episodeIdentityDigests,
    episodeIdentitySetDigest,
    governance: fields.req("governance", parseGovernanceAt),
  };
};

const parseResolvedEpisodeAt: Parse<DetectorPackRunReceipt["population"]["resolvedEpisodes"][number]> = (
  input,
  path,
) => {
  const fields = readFields(input, path);
  const base = {
    episodeRecordId: fields.req("episodeRecordId", parseDurableId),
    episodeRecordDigest: fields.req("episodeRecordDigest", parseDigestAt),
    episodeIdentityDigest: fields.req("episodeIdentityDigest", parseDigestAt),
    outcomeClaimDigest: fields.req("outcomeClaimDigest", parseNullable(parseDigestAt)),
    scopeDigest: fields.req("scopeDigest", parseDigestAt),
  };
  const episodeViewDigest = fields.req("episodeViewDigest", parseDigestAt);
  if (episodeViewDigest !== sha256HexOfCanonicalJson(toJsonValue(base))) {
    throw invalid("schema.corrupt", "pack receipt episode-view digest does not match its lineage", path);
  }
  return { ...base, episodeViewDigest };
};

function parsePopulationAt(
  input: unknown,
  path: readonly (string | number)[],
  exactScopeDigest: string,
): DetectorPackRunReceipt["population"] {
  const fields = readFields(input, path);
  const requestedEpisodeRecordIds = fields.req(
    "requestedEpisodeRecordIds",
    parseBoundedArray(parseDurableId, MAX_EPISODES, "requested episode ids"),
  );
  assertSortedUnique(requestedEpisodeRecordIds, (value) => value, [...path, "requestedEpisodeRecordIds"]);
  const resolvedEpisodes = fields.req(
    "resolvedEpisodes",
    parseBoundedArray(parseResolvedEpisodeAt, MAX_EPISODES, "resolved episodes"),
  );
  if (
    requestedEpisodeRecordIds.length !== resolvedEpisodes.length ||
    resolvedEpisodes.some(
      (episode, index) =>
        episode.episodeRecordId !== requestedEpisodeRecordIds[index] || episode.scopeDigest !== exactScopeDigest,
    )
  ) {
    throw invalid("schema.corrupt", "pack receipt population is not one-to-one in its exact scope", path);
  }
  const identityDigests = new Set<string>();
  const viewDigests = new Set<string>();
  for (const [index, episode] of resolvedEpisodes.entries()) {
    if (identityDigests.has(episode.episodeIdentityDigest) || viewDigests.has(episode.episodeViewDigest)) {
      throw invalid("schema.corrupt", "pack receipt resolved episode lineage must be unique", [
        ...path,
        "resolvedEpisodes",
        index,
      ]);
    }
    identityDigests.add(episode.episodeIdentityDigest);
    viewDigests.add(episode.episodeViewDigest);
  }
  const base = { requestedEpisodeRecordIds, resolvedEpisodes };
  const populationDigest = fields.req("populationDigest", parseDigestAt);
  if (populationDigest !== detectorPackRunPopulationDigest(base)) {
    throw invalid("schema.corrupt", "pack receipt population digest does not match its content", path);
  }
  return { ...base, populationDigest };
}

export function detectorPackRunPopulationDigest(
  input: Omit<DetectorPackRunReceipt["population"], "populationDigest">,
): string {
  return sha256HexOfCanonicalJson(toJsonValue(input));
}

export function detectorPackRunItemDigest(input: Omit<DetectorPackRunReceipt["items"][number], "itemDigest">): string {
  return sha256HexOfCanonicalJson(toJsonValue(input));
}

function parseItemAt(input: unknown, path: readonly (string | number)[]): DetectorPackRunReceipt["items"][number] {
  const fields = readFields(input, path);
  const base = {
    detector: fields.req("detector", parseDetectorProjectionAt),
    lens: fields.req("lens", parseNullable(parseLensRefAt)),
    outputKind: fields.req("outputKind", parseOneOf(OUTPUT_KINDS)),
    executionDisposition: fields.req("executionDisposition", parseOneOf(EXECUTION_DISPOSITIONS)),
    executionRef: fields.req("executionRef", parseNullable(parseExecutionRefAt)),
    recurrence: fields.req("recurrence", parseRecurrenceAt),
    reasonCodes: fields.req("reasonCodes", parseSortedReasons),
  };
  const itemDigest = fields.req("itemDigest", parseDigestAt);
  if (itemDigest !== detectorPackRunItemDigest(base)) {
    throw invalid("schema.corrupt", "detector pack receipt item digest does not match its content", path);
  }
  if (
    (base.executionDisposition === "executed" && base.executionRef === null) ||
    ((base.executionDisposition === "capped" || base.executionDisposition === "refused") && base.executionRef !== null)
  ) {
    throw invalid("schema.corrupt", "pack receipt execution disposition does not match its execution reference", path);
  }
  if (
    (base.outputKind === "insight_derivation" &&
      base.lens === null &&
      (base.executionDisposition !== "not_applicable" || base.executionRef !== null)) ||
    (base.outputKind === "evidence_health" && base.lens !== null)
  ) {
    throw invalid("schema.corrupt", "pack receipt output kind does not match its lens", path);
  }
  if (
    (base.recurrence.status === "grouped" &&
      (base.executionDisposition !== "executed" || base.executionRef === null)) ||
    (base.recurrence.status === "absent" &&
      ((base.recurrence.reason === "execution_not_materialized" &&
        (base.executionRef !== null ||
          (base.executionDisposition !== "not_applicable" && base.executionDisposition !== "incomplete"))) ||
        (base.recurrence.reason === "condition_not_detected" &&
          (base.executionDisposition !== "executed" || base.executionRef === null)) ||
        (base.recurrence.reason === "execution_not_applied" &&
          (base.executionRef === null ||
            (base.executionDisposition !== "not_applicable" && base.executionDisposition !== "incomplete"))) ||
        (base.recurrence.reason === "locator_unavailable" &&
          (base.executionDisposition !== "executed" || base.executionRef === null)) ||
        (base.recurrence.reason === "result_not_retained" &&
          (base.executionRef !== null ||
            (base.executionDisposition !== "capped" && base.executionDisposition !== "refused")))))
  ) {
    throw invalid("schema.corrupt", "pack receipt recurrence does not match its execution disposition", path);
  }
  return { ...base, itemDigest };
}

function governanceProjection(items: DetectorPackRunReceipt["items"]): unknown {
  const byGroup = new Map<
    string,
    {
      readonly executionCount: number;
      readonly distinctEpisodeCount: number;
      readonly episodeIdentitySetDigest: string;
      readonly governance: GroupGovernance;
    }
  >();
  for (const item of items) {
    if (item.recurrence.status !== "grouped") continue;
    const projection = {
      executionCount: item.recurrence.executionCount,
      distinctEpisodeCount: item.recurrence.distinctEpisodeCount,
      episodeIdentitySetDigest: item.recurrence.episodeIdentitySetDigest,
      governance: item.recurrence.governance,
    };
    const previous = byGroup.get(item.recurrence.groupKeyDigest);
    if (previous !== undefined && canonicalKey(previous) !== canonicalKey(projection)) {
      throw invalid("schema.corrupt", "one recurrence group has conflicting governance snapshots", []);
    }
    byGroup.set(item.recurrence.groupKeyDigest, projection);
  }
  return [...byGroup.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([groupKeyDigest, projection]) => ({ groupKeyDigest, ...projection }));
}

function assertGroupPolicy(items: DetectorPackRunReceipt["items"], policy: DetectorOrchestrationPolicy): void {
  const dispositions = new Map<string, { readonly outputKind: DetectorOutputKind; readonly capped: boolean }>();
  let insightGroups = 0;
  let evidenceHealthGroups = 0;
  for (const item of items) {
    if (item.recurrence.status !== "grouped") continue;
    let expected = dispositions.get(item.recurrence.groupKeyDigest);
    if (expected === undefined) {
      const capped =
        item.outputKind === "insight_derivation"
          ? insightGroups >= policy.caps.maximumInsightGroupsPerRun
          : evidenceHealthGroups >= policy.caps.maximumEvidenceHealthGroupsPerRun;
      expected = { outputKind: item.outputKind, capped };
      dispositions.set(item.recurrence.groupKeyDigest, expected);
      if (item.outputKind === "insight_derivation") insightGroups += 1;
      else evidenceHealthGroups += 1;
    }
    if (
      expected.outputKind !== item.outputKind ||
      (item.outputKind === "evidence_health" && item.recurrence.governance.status === "assessed") ||
      (item.recurrence.governance.groupDisposition === "capped") !== expected.capped ||
      (item.recurrence.governance.status === "not_assessed" &&
        item.recurrence.governance.groupDisposition !== (expected.capped ? "capped" : "unassessed"))
    ) {
      throw invalid("schema.corrupt", "pack receipt group disposition violates its exact orchestration policy", []);
    }
    if (item.recurrence.governance.status === "not_assessed") {
      const reason = item.recurrence.governance.reason;
      const reasonAllowed =
        reason === "candidate_claims_deferred" ||
        (item.outputKind === "evidence_health"
          ? reason === "candidate_governance_not_applicable"
          : expected.capped
            ? reason === "candidate_governance_capped"
            : reason === "candidate_review_history_unavailable" || reason === "candidate_governance_incomplete");
      if (!reasonAllowed) {
        throw invalid("schema.corrupt", "pack receipt governance reason does not match its output family", []);
      }
    }
  }
}

export function detectorPackRunGovernanceSnapshotDigest(items: DetectorPackRunReceipt["items"]): string {
  return sha256HexOfCanonicalJson(toJsonValue(governanceProjection(items)));
}

function packRunKeyContent(
  receipt: Omit<DetectorPackRunReceipt, "schemaVersion" | "id" | "packRunKeyDigest" | "receiptDigest">,
): unknown {
  return {
    domain: "detector-pack-run:v1",
    loopRegistryRevision: receipt.loopRegistryRevision,
    semanticRegistryDigest: receipt.semanticRegistryDigest,
    policy: {
      id: receipt.policy.id,
      version: receipt.policy.version,
      policyDigest: receipt.policy.policyDigest,
    },
    pack: receipt.pack,
    scope: receipt.scope,
    scopeDigest: receipt.scopeDigest,
    scopePolicyDigest: receipt.scopePolicyDigest,
    populationDigest: receipt.population.populationDigest,
    governanceSnapshotDigest: receipt.governanceSnapshotDigest,
    items: receipt.items.map((item) => ({
      detector: item.detector,
      lens: item.lens,
      outputKind: item.outputKind,
      executionKeyDigest: item.executionRef?.executionKeyDigest ?? null,
      groupKeyDigest: item.recurrence.status === "grouped" ? item.recurrence.groupKeyDigest : null,
    })),
  };
}

export function detectorPackRunKeyDigest(
  receipt: Omit<DetectorPackRunReceipt, "schemaVersion" | "id" | "packRunKeyDigest" | "receiptDigest">,
): string {
  return sha256HexOfCanonicalJson(toJsonValue(packRunKeyContent(receipt)));
}

export function detectorPackRunReceiptDigest(
  receipt: Omit<DetectorPackRunReceipt, "schemaVersion" | "id" | "receiptDigest">,
): string {
  return sha256HexOfCanonicalJson(toJsonValue(receipt));
}

export function parseDetectorPackRunReceipt(input: unknown): DetectorPackRunReceipt {
  const snapshot = toJsonValue(input);
  if (Buffer.byteLength(canonicalJsonText(snapshot), "utf8") > MAX_RECEIPT_BYTES) {
    throw invalid("schema.invalid", "detector pack-run receipt exceeds its canonical byte ceiling", []);
  }
  const fields = readFields(snapshot, []);
  const schemaVersion = fields.schemaVersion1();
  const policy = fields.req("policy", parseDetectorOrchestrationPolicy);
  const scope = fields.req("scope", parseScopeAt);
  const exactScopeDigest = fields.req("scopeDigest", parseDigestAt);
  if (scopeDigest(scope) !== exactScopeDigest) {
    throw invalid("schema.corrupt", "pack receipt scope digest does not match its scope", ["scopeDigest"]);
  }
  const items = fields.req("items", parseBoundedArray(parseItemAt, MAX_ITEMS, "pack receipt items"));
  assertSortedUnique(
    items,
    (item) => canonicalKey([detectorRefKey(item.detector), item.lens === null ? "" : lensRefKey(item.lens)]),
    ["items"],
  );
  assertGroupPolicy(items, policy);
  for (const [index, item] of items.entries()) {
    if (
      item.recurrence.status !== "grouped" ||
      item.recurrence.governance.status !== "assessed" ||
      item.recurrence.governance.groupDisposition === "capped"
    ) {
      continue;
    }
    const expectedGovernance = classifyAssessedRecurrenceGovernance({
      policy,
      currentDistinctEpisodeCount: item.recurrence.distinctEpisodeCount,
      candidateBindings: item.recurrence.governance.candidateBindings,
    });
    if (canonicalKey(expectedGovernance) !== canonicalKey(item.recurrence.governance)) {
      throw invalid("schema.corrupt", "assessed recurrence governance violates its exact policy matrix", [
        "items",
        index,
        "recurrence",
        "governance",
      ]);
    }
  }
  const governanceSnapshotDigest = fields.req("governanceSnapshotDigest", parseDigestAt);
  if (governanceSnapshotDigest !== detectorPackRunGovernanceSnapshotDigest(items)) {
    throw invalid("schema.corrupt", "pack receipt governance snapshot digest is invalid", ["governanceSnapshotDigest"]);
  }
  const receiptStatus = fields.req("status", parseOneOf(RECEIPT_STATUSES));
  let groupedItems = 0;
  let executionReferences = 0;
  let totalEpisodeIdentities = 0;
  let totalCandidateBindings = 0;
  for (const item of items) {
    if (item.executionRef !== null) executionReferences += 1;
    if (item.recurrence.status !== "grouped") continue;
    groupedItems += 1;
    totalEpisodeIdentities += item.recurrence.episodeIdentityDigests.length;
    if (item.recurrence.governance.status === "assessed") {
      totalCandidateBindings += item.recurrence.governance.candidateBindings.length;
    }
    if (
      groupedItems > policy.caps.maximumInvocationsPerRun ||
      executionReferences > policy.caps.maximumInvocationsPerRun ||
      totalEpisodeIdentities > MAX_TOTAL_GROUP_IDENTITIES ||
      totalCandidateBindings > MAX_TOTAL_CANDIDATE_BINDINGS
    ) {
      throw invalid("schema.invalid", "detector pack-run receipt exceeds its bounded governance population", []);
    }
  }
  const base = {
    loopRegistryRevision: fields.req("loopRegistryRevision", parseDigestAt),
    semanticRegistryDigest: fields.req("semanticRegistryDigest", parseDigestAt),
    policy,
    pack: fields.req("pack", parsePackRefAt),
    scope,
    scopeDigest: exactScopeDigest,
    scopePolicyDigest: fields.req("scopePolicyDigest", parseDigestAt),
    population: fields.req("population", (value, path) => parsePopulationAt(value, path, exactScopeDigest)),
    governanceSnapshotDigest,
    items,
    status: receiptStatus,
  };
  const expectedPartial = items.some(
    (item) =>
      item.executionDisposition === "incomplete" ||
      item.executionDisposition === "capped" ||
      item.executionDisposition === "refused" ||
      (item.recurrence.status === "grouped" && item.recurrence.governance.groupDisposition === "capped"),
  );
  if ((base.status === "partial") !== expectedPartial) {
    throw invalid("schema.corrupt", "pack receipt status does not match its exact item dispositions", ["status"]);
  }
  const packRunKeyDigest = fields.req("packRunKeyDigest", parseDigestAt);
  if (packRunKeyDigest !== detectorPackRunKeyDigest(base)) {
    throw invalid("schema.corrupt", "pack-run key digest does not match its content", ["packRunKeyDigest"]);
  }
  const id = fields.req("id", parseDurableId);
  if (id !== `detector-pack-run-${packRunKeyDigest}`) {
    throw invalid("schema.corrupt", "pack-run receipt id does not match its key digest", ["id"]);
  }
  const receiptDigest = fields.req("receiptDigest", parseDigestAt);
  const receiptBase = { ...base, packRunKeyDigest };
  if (receiptDigest !== detectorPackRunReceiptDigest(receiptBase)) {
    throw invalid("schema.corrupt", "pack-run receipt digest does not match its content", ["receiptDigest"]);
  }
  return { schemaVersion, id, ...receiptBase, receiptDigest };
}
