import { sha256HexOfCanonicalJson } from "../canonical/canonical-json.js";
import type { JsonValue } from "../canonical/json.js";
import { toJsonValue } from "../canonical/to-json-value.js";
import type { DetectorResultDraft } from "../engine/detector-draft.js";
import type { DetectorWindow } from "../engine/detector-window.js";
import { invalid, parseBool, parseFiniteNumber, parseOneOf, readFields } from "../parse/toolkit.js";
import { parseDetectorRegistration } from "../records/detector-registration.js";
import { parseBoundedArray, parseDigestAt, parseId, parseNullable, parseTrue } from "../records/semantic-shared.js";
import type { ReferenceDetectorFamily } from "./types.js";

export const OPERATION_KIND = "reference.operation.completed.v1";
export const CONTEXT_UTILIZATION_KIND = "reference.context.utilization.v1";
export const CONTEXT_COMPACTION_KIND = "reference.context.compaction.v1";
export const COORDINATION_POPULATION_KIND = "reference.coordination.population.v1";
export const INTERACTION_TURN_KIND = "reference.interaction.turn.v1";

export const TRAFFIC_CAPABILITY = "reference.traffic.classification.v1";
export const OPERATION_CAPABILITY = "reference.operation.sequence.v1";
export const CONTEXT_CAPABILITY = "reference.context.pressure.v1";
export const COORDINATION_CAPABILITY = "reference.coordination.attribution.v1";
export const INTERACTION_CAPABILITY = "reference.interaction.cited-redirection.v1";

const TRAFFIC_CLASSES = ["primary", "delegated", "automated", "reviewer", "guardian", "benchmark", "replay"] as const;
const OPERATION_INTENTS = ["status_poll", "wait", "tool", "progress"] as const;
const OPERATION_STATES = ["unchanged", "changed", "succeeded", "failed", "unknown"] as const;
const TURN_ACTORS = ["human", "agent"] as const;
const DELEGATED_TRAFFIC: readonly ["delegated"] = ["delegated"];
const DETECTOR_FAMILIES: readonly ReferenceDetectorFamily[] = [
  "coordination_attribution_integrity",
  "repeated_status_polling",
  "context_pressure_compaction",
  "tool_use_concentration",
  "coordination_fanout",
  "attributed_human_redirection",
];

type TrafficClass = (typeof TRAFFIC_CLASSES)[number];

export type ReferenceDetectorPolicy =
  | {
      readonly family: "coordination_attribution_integrity";
      readonly trafficClass: "delegated";
    }
  | {
      readonly family: "repeated_status_polling";
      readonly eligibleTrafficClass: TrafficClass;
      readonly minimumConsecutiveUnchangedPolls: number;
    }
  | {
      readonly family: "context_pressure_compaction";
      readonly eligibleTrafficClass: TrafficClass;
      readonly highUtilizationBasisPoints: number;
      readonly minimumConsecutiveHighSamples: number;
      readonly minimumExplicitCompactions: number;
    }
  | {
      readonly family: "tool_use_concentration";
      readonly eligibleTrafficClass: TrafficClass;
      readonly dominantOperationClassBasisPoints: number;
      readonly minimumCompletedOperations: number;
      readonly minimumRepeatedSignatureCount: number;
    }
  | {
      readonly family: "coordination_fanout";
      readonly trafficClass: "delegated";
      readonly minimumDescendants: number;
      readonly minimumDirectChildren: number;
    }
  | {
      readonly family: "attributed_human_redirection";
      readonly eligibleTrafficClass: TrafficClass;
      readonly minimumDistinctEpisodes: number;
      readonly minimumExactPairs: number;
    };

interface ObservationEntry {
  readonly record: Extract<DetectorWindow["evidence"][number], { readonly kind: "observation" }>["record"];
  readonly referenceDigest: string;
}

interface SequencedEntry {
  readonly episodeId: string;
  readonly sequence: number;
  readonly recordId: string;
  readonly referenceDigest: string;
}

interface OperationEntry extends SequencedEntry {
  readonly intent: (typeof OPERATION_INTENTS)[number];
  readonly state: (typeof OPERATION_STATES)[number];
  readonly operationClass: string;
  readonly targetKeyedDigest: string;
  readonly signatureKeyedDigest: string;
  readonly trafficClass: TrafficClass;
}

interface ContextUtilizationEntry extends SequencedEntry {
  readonly utilizationBasisPoints: number;
  readonly trafficClass: TrafficClass;
}

interface ContextCompactionEntry extends SequencedEntry {
  readonly beforeUtilizationBasisPoints: number;
  readonly afterUtilizationBasisPoints: number;
  readonly trafficClass: TrafficClass;
}

interface CoordinationMarker extends ObservationEntry {
  readonly closedPopulation: boolean;
  readonly trafficClass: TrafficClass;
}

interface InteractionTurn extends SequencedEntry {
  readonly actor: (typeof TURN_ACTORS)[number];
  readonly correction: boolean;
  readonly replyToSequence: number | null;
  readonly trafficClass: TrafficClass;
}

interface CoordinationAnalysis {
  readonly markerRefs: readonly string[];
  readonly brokenRoots: number;
  readonly missingParents: number;
  readonly cycles: number;
  readonly directChildren: number;
  readonly descendants: number;
  readonly maximumDepth: number;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareSequenced(left: SequencedEntry, right: SequencedEntry): number {
  const episodeOrder = compareText(left.episodeId, right.episodeId);
  if (episodeOrder !== 0) return episodeOrder;
  if (left.sequence !== right.sequence) return left.sequence - right.sequence;
  return compareText(left.recordId, right.recordId);
}

function parseNonnegativeInteger(input: unknown, path: readonly (string | number)[]): number {
  const value = parseFiniteNumber(input, path);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw invalid("detector.result_invalid", "reference sequence must be a nonnegative safe integer", path);
  }
  return value;
}

function parseBasisPoints(input: unknown, path: readonly (string | number)[]): number {
  const value = parseNonnegativeInteger(input, path);
  if (value > 10_000) {
    throw invalid("detector.result_invalid", "reference utilization must be between 0 and 10000 basis points", path);
  }
  return value;
}

function parsePositiveInteger(input: unknown, path: readonly (string | number)[]): number {
  const value = parseNonnegativeInteger(input, path);
  if (value === 0) {
    throw invalid("detector.implementation_invalid", "reference threshold must be positive", path);
  }
  return value;
}

function policyInvalid(message: string, path: readonly (string | number)[] = []): never {
  throw invalid("detector.implementation_invalid", message, path);
}

function requireThresholds(thresholds: Readonly<Record<string, JsonValue>> | null): ReturnType<typeof readFields> {
  if (thresholds === null) return policyInvalid("reference detector requires exact registered thresholds", []);
  return readFields(thresholds, ["thresholds"]);
}

function exactExcludedTraffic(input: unknown, path: readonly (string | number)[]): void {
  const values = parseBoundedArray(
    parseOneOf(TRAFFIC_CLASSES),
    TRAFFIC_CLASSES.length,
    "excluded traffic classes",
  )(input, path);
  const expected = ["automated", "benchmark", "delegated", "guardian", "replay", "reviewer"];
  if (JSON.stringify(values) !== JSON.stringify(expected)) {
    policyInvalid("reference redirection traffic exclusions do not match the registered algorithm", path);
  }
}

export function parseReferenceDetectorPolicy(
  expectedFamily: ReferenceDetectorFamily,
  input: unknown,
): ReferenceDetectorPolicy {
  const registration = parseDetectorRegistration(input);
  if (registration.configurationDigest !== sha256HexOfCanonicalJson(toJsonValue(registration.configuration))) {
    return policyInvalid("reference detector configuration digest is invalid");
  }
  if (
    registration.thresholds !== null &&
    registration.thresholdDigest !== sha256HexOfCanonicalJson(toJsonValue(registration.thresholds))
  ) {
    return policyInvalid("reference detector threshold digest is invalid");
  }
  const fields = readFields(registration.configuration, ["configuration"]);
  const family = fields.req("family", parseOneOf(DETECTOR_FAMILIES));
  if (family !== expectedFamily) return policyInvalid("reference detector family binding is inconsistent");
  fields.req("closedEpisodePopulation", parseTrue);
  fields.req("singleSourcePopulation", parseTrue);
  if (family === "coordination_attribution_integrity") {
    fields.req("algorithm", parseOneOf(["closed-parent-graph-integrity"]));
    fields.req("closedPopulationRequired", parseTrue);
    const trafficClass = fields.req("trafficClass", parseOneOf(DELEGATED_TRAFFIC));
    if (registration.thresholds !== null) {
      return policyInvalid("coordination attribution integrity does not accept thresholds");
    }
    return Object.freeze({ family, trafficClass });
  }
  const thresholds = requireThresholds(registration.thresholds);
  if (family === "repeated_status_polling") {
    fields.req("algorithm", parseOneOf(["consecutive-unchanged-keyed-target"]));
    const eligibleTrafficClass = fields.req("eligibleTrafficClass", parseOneOf(TRAFFIC_CLASSES));
    fields.req("progressBreaksRun", parseTrue);
    return Object.freeze({
      family,
      eligibleTrafficClass,
      minimumConsecutiveUnchangedPolls: thresholds.req("minimumConsecutiveUnchangedPolls", parsePositiveInteger),
    });
  }
  if (family === "context_pressure_compaction") {
    fields.req("algorithm", parseOneOf(["ordered-utilization-and-explicit-compaction"]));
    fields.req("compactionInferenceFromTokenDrop", parseOneOf(["forbidden"]));
    const eligibleTrafficClass = fields.req("eligibleTrafficClass", parseOneOf(TRAFFIC_CLASSES));
    return Object.freeze({
      family,
      eligibleTrafficClass,
      highUtilizationBasisPoints: thresholds.req("highUtilizationBasisPoints", parseBasisPoints),
      minimumConsecutiveHighSamples: thresholds.req("minimumConsecutiveHighSamples", parsePositiveInteger),
      minimumExplicitCompactions: thresholds.req("minimumExplicitCompactions", parsePositiveInteger),
    });
  }
  if (family === "tool_use_concentration") {
    fields.req("algorithm", parseOneOf(["complete-operation-denominator"]));
    fields.req("eligibleIntent", parseOneOf(["tool"]));
    const eligibleTrafficClass = fields.req("eligibleTrafficClass", parseOneOf(TRAFFIC_CLASSES));
    return Object.freeze({
      family,
      eligibleTrafficClass,
      dominantOperationClassBasisPoints: thresholds.req("dominantOperationClassBasisPoints", parseBasisPoints),
      minimumCompletedOperations: thresholds.req("minimumCompletedOperations", parsePositiveInteger),
      minimumRepeatedSignatureCount: thresholds.req("minimumRepeatedSignatureCount", parsePositiveInteger),
    });
  }
  if (family === "coordination_fanout") {
    fields.req("algorithm", parseOneOf(["closed-parent-graph-fanout"]));
    fields.req("closedPopulationRequired", parseTrue);
    const trafficClass = fields.req("trafficClass", parseOneOf(DELEGATED_TRAFFIC));
    return Object.freeze({
      family,
      trafficClass,
      minimumDescendants: thresholds.req("minimumDescendants", parsePositiveInteger),
      minimumDirectChildren: thresholds.req("minimumDirectChildren", parsePositiveInteger),
    });
  }
  fields.req("algorithm", parseOneOf(["exact-cited-human-to-agent-pairs"]));
  const eligibleTrafficClass = fields.req("eligibleTrafficClass", parseOneOf(TRAFFIC_CLASSES));
  fields.req("excludedTrafficClasses", exactExcludedTraffic);
  return Object.freeze({
    family,
    eligibleTrafficClass,
    minimumDistinctEpisodes: thresholds.req("minimumDistinctEpisodes", parsePositiveInteger),
    minimumExactPairs: thresholds.req("minimumExactPairs", parsePositiveInteger),
  });
}

function observationEntries(window: DetectorWindow, kinds: readonly string[]): readonly ObservationEntry[] {
  const accepted = new Set(kinds);
  return window.evidence.flatMap((entry) =>
    entry.kind === "observation" && accepted.has(entry.record.kind)
      ? [{ record: entry.record, referenceDigest: entry.reference.referenceDigest }]
      : [],
  );
}

function assertSingleSourcePopulation(window: DetectorWindow): void {
  if (window.sourceProfiles.length !== 1) {
    throw invalid("detector.result_invalid", "reference detectors require an exact single-source population", []);
  }
  const profile = window.sourceProfiles[0];
  if (profile === undefined) {
    throw invalid("detector.result_invalid", "reference detector source profile is missing", []);
  }
  for (const episode of window.population.episodes) {
    if (
      episode.view.identity.status !== "resolved" ||
      episode.view.identity.sourceId !== profile.sourceId ||
      episode.view.episode.closedAt === undefined
    ) {
      throw invalid("detector.result_invalid", "reference population source lineage is not exact", []);
    }
  }
}

function assertUniqueSequences(entries: readonly SequencedEntry[]): void {
  const seen = new Set<string>();
  for (const entry of entries) {
    const key = JSON.stringify([entry.episodeId, entry.sequence]);
    if (seen.has(key)) {
      throw invalid("detector.result_invalid", "reference observation sequences must be unique per episode", []);
    }
    seen.add(key);
  }
}

function parseOperation(entry: ObservationEntry): OperationEntry {
  const fields = readFields(entry.record.data, [entry.record.id, "data"]);
  return {
    episodeId: entry.record.episodeId,
    sequence: fields.req("sequence", parseNonnegativeInteger),
    recordId: entry.record.id,
    referenceDigest: entry.referenceDigest,
    intent: fields.req("intent", parseOneOf(OPERATION_INTENTS)),
    state: fields.req("state", parseOneOf(OPERATION_STATES)),
    operationClass: fields.req("operationClass", parseId),
    targetKeyedDigest: fields.req("targetKeyedDigest", parseDigestAt),
    signatureKeyedDigest: fields.req("signatureKeyedDigest", parseDigestAt),
    trafficClass: fields.req("trafficClass", parseOneOf(TRAFFIC_CLASSES)),
  };
}

function parseContextUtilization(entry: ObservationEntry): ContextUtilizationEntry {
  const fields = readFields(entry.record.data, [entry.record.id, "data"]);
  return {
    episodeId: entry.record.episodeId,
    sequence: fields.req("sequence", parseNonnegativeInteger),
    recordId: entry.record.id,
    referenceDigest: entry.referenceDigest,
    utilizationBasisPoints: fields.req("utilizationBasisPoints", parseBasisPoints),
    trafficClass: fields.req("trafficClass", parseOneOf(TRAFFIC_CLASSES)),
  };
}

function parseContextCompaction(entry: ObservationEntry): ContextCompactionEntry {
  const fields = readFields(entry.record.data, [entry.record.id, "data"]);
  const parsed = {
    episodeId: entry.record.episodeId,
    sequence: fields.req("sequence", parseNonnegativeInteger),
    recordId: entry.record.id,
    referenceDigest: entry.referenceDigest,
    beforeUtilizationBasisPoints: fields.req("beforeUtilizationBasisPoints", parseBasisPoints),
    afterUtilizationBasisPoints: fields.req("afterUtilizationBasisPoints", parseBasisPoints),
    trafficClass: fields.req("trafficClass", parseOneOf(TRAFFIC_CLASSES)),
  };
  if (parsed.afterUtilizationBasisPoints >= parsed.beforeUtilizationBasisPoints) {
    throw invalid("detector.result_invalid", "explicit compaction must reduce reported utilization", [
      entry.record.id,
      "data",
    ]);
  }
  return parsed;
}

function parseCoordinationMarker(entry: ObservationEntry): CoordinationMarker {
  const fields = readFields(entry.record.data, [entry.record.id, "data"]);
  return {
    ...entry,
    closedPopulation: fields.req("closedPopulation", parseBool),
    trafficClass: fields.req("trafficClass", parseOneOf(TRAFFIC_CLASSES)),
  };
}

function parseInteractionTurn(entry: ObservationEntry): InteractionTurn {
  const fields = readFields(entry.record.data, [entry.record.id, "data"]);
  return {
    episodeId: entry.record.episodeId,
    sequence: fields.req("sequence", parseNonnegativeInteger),
    recordId: entry.record.id,
    referenceDigest: entry.referenceDigest,
    actor: fields.req("actor", parseOneOf(TURN_ACTORS)),
    correction: fields.req("correction", parseBool),
    replyToSequence: fields.req("replyToSequence", parseNullable(parseNonnegativeInteger)),
    trafficClass: fields.req("trafficClass", parseOneOf(TRAFFIC_CLASSES)),
  };
}

function negativeDraft(): DetectorResultDraft {
  return { conditionDetected: false, recurrenceLocator: null, insights: [], findings: [] };
}

function positiveDraft(input: {
  readonly family: ReferenceDetectorFamily;
  readonly learningClass: "mechanical_execution" | "human_agent_interaction" | "system_meta";
  readonly statement: string;
  readonly referenceDigests: readonly string[];
  readonly data: JsonValue;
  readonly structural: boolean;
  readonly missingEvidence?: DetectorResultDraft["insights"][number]["missingEvidence"];
}): DetectorResultDraft {
  const interpretation = input.structural
    ? null
    : {
        statement: "This structural condition requires purpose-specific review before any behavioral conclusion.",
        confidence: "unknown" as const,
        uncertainty: ["The condition alone does not establish harm, inefficiency, preference, utility, or efficacy."],
      };
  return {
    conditionDetected: true,
    recurrenceLocator: null,
    insights: [
      {
        learningClass: input.learningClass,
        directObservation: {
          statement: input.statement,
          data: input.data,
          evidenceReferenceDigests: input.referenceDigests,
        },
        interpretation,
        impactHypothesis: null,
        contradictoryEvidenceReferenceDigests: [],
        evidenceHealthFindingIds: [],
        missingEvidence: input.missingEvidence ?? [],
        applicability: {
          statement: "Applies only to the exact normalized single-source population supplied to this execution.",
          exclusions: ["No causal, quality, authority, preference, or utility conclusion is included."],
        },
        candidateIntervention: null,
        validation: null,
        supersedes: null,
      },
    ],
    findings: [],
  };
}

function evaluatePolling(
  window: DetectorWindow,
  policy: Extract<ReferenceDetectorPolicy, { readonly family: "repeated_status_polling" }>,
): DetectorResultDraft {
  const operations = observationEntries(window, [OPERATION_KIND]).map(parseOperation).sort(compareSequenced);
  assertUniqueSequences(operations);
  let currentEpisode: string | undefined;
  let currentTarget: string | undefined;
  let previousSequence: number | undefined;
  let currentRefs: string[] = [];
  let winningRefs: readonly string[] = [];
  for (const operation of operations) {
    if (
      currentEpisode !== operation.episodeId ||
      previousSequence === undefined ||
      operation.sequence !== previousSequence + 1
    ) {
      currentTarget = undefined;
      currentRefs = [];
    }
    currentEpisode = operation.episodeId;
    previousSequence = operation.sequence;
    if (
      operation.trafficClass === policy.eligibleTrafficClass &&
      operation.intent === "status_poll" &&
      operation.state === "unchanged"
    ) {
      if (currentTarget === operation.targetKeyedDigest) currentRefs.push(operation.referenceDigest);
      else {
        currentTarget = operation.targetKeyedDigest;
        currentRefs = [operation.referenceDigest];
      }
      if (currentRefs.length > winningRefs.length) winningRefs = [...currentRefs];
    } else {
      currentTarget = undefined;
      currentRefs = [];
    }
  }
  if (winningRefs.length < policy.minimumConsecutiveUnchangedPolls) return negativeDraft();
  return positiveDraft({
    family: "repeated_status_polling",
    learningClass: "mechanical_execution",
    statement: "The configured consecutive unchanged status-poll condition was observed.",
    referenceDigests: winningRefs,
    data: toJsonValue({ family: "repeated_status_polling", longestConsecutiveRun: winningRefs.length }),
    structural: false,
  });
}

function evaluateContext(
  window: DetectorWindow,
  policy: Extract<ReferenceDetectorPolicy, { readonly family: "context_pressure_compaction" }>,
): DetectorResultDraft {
  const utilization = observationEntries(window, [CONTEXT_UTILIZATION_KIND])
    .map(parseContextUtilization)
    .sort(compareSequenced);
  const compactions = observationEntries(window, [CONTEXT_COMPACTION_KIND])
    .map(parseContextCompaction)
    .sort(compareSequenced);
  assertUniqueSequences([...utilization, ...compactions].sort(compareSequenced));
  type ContextEvent =
    | { readonly kind: "utilization"; readonly entry: ContextUtilizationEntry }
    | { readonly kind: "compaction"; readonly entry: ContextCompactionEntry };
  const events: ContextEvent[] = [];
  for (const entry of utilization) events.push({ kind: "utilization", entry });
  for (const entry of compactions) events.push({ kind: "compaction", entry });
  events.sort((left, right) => compareSequenced(left.entry, right.entry));
  let currentEpisode: string | undefined;
  let previousSequence: number | undefined;
  let pressureRefs: string[] = [];
  let winningPressureRefs: readonly string[] = [];
  let maximumUtilizationBasisPoints = 0;
  const eligibleUtilization: ContextUtilizationEntry[] = [];
  const eligibleCompactions: ContextCompactionEntry[] = [];
  for (const event of events) {
    const entry = event.entry;
    if (
      currentEpisode !== entry.episodeId ||
      previousSequence === undefined ||
      entry.sequence !== previousSequence + 1
    ) {
      pressureRefs = [];
    }
    currentEpisode = entry.episodeId;
    previousSequence = entry.sequence;
    if (entry.trafficClass !== policy.eligibleTrafficClass) {
      pressureRefs = [];
      continue;
    }
    if (event.kind === "compaction") {
      eligibleCompactions.push(event.entry);
      pressureRefs = [];
      continue;
    }
    const sample = event.entry;
    eligibleUtilization.push(sample);
    maximumUtilizationBasisPoints = Math.max(maximumUtilizationBasisPoints, sample.utilizationBasisPoints);
    if (sample.utilizationBasisPoints >= policy.highUtilizationBasisPoints) {
      pressureRefs.push(sample.referenceDigest);
    } else pressureRefs = [];
    if (pressureRefs.length > winningPressureRefs.length) winningPressureRefs = [...pressureRefs];
  }
  if (
    winningPressureRefs.length < policy.minimumConsecutiveHighSamples &&
    eligibleCompactions.length < policy.minimumExplicitCompactions
  ) {
    return negativeDraft();
  }
  const refs = [
    ...new Set([...eligibleUtilization, ...eligibleCompactions].map((entry) => entry.referenceDigest)),
  ].sort(compareText);
  return positiveDraft({
    family: "context_pressure_compaction",
    learningClass: "system_meta",
    statement: "The configured explicit context-pressure or compaction condition was observed.",
    referenceDigests: refs,
    data: toJsonValue({
      family: "context_pressure_compaction",
      longestHighPressureRun: winningPressureRefs.length,
      explicitCompactions: eligibleCompactions.length,
      maximumUtilizationBasisPoints,
    }),
    structural: false,
  });
}

function evaluateTooling(
  window: DetectorWindow,
  policy: Extract<ReferenceDetectorPolicy, { readonly family: "tool_use_concentration" }>,
): DetectorResultDraft {
  const operations = observationEntries(window, [OPERATION_KIND]).map(parseOperation).sort(compareSequenced);
  assertUniqueSequences(operations);
  const tools = operations.filter(
    (entry) => entry.trafficClass === policy.eligibleTrafficClass && entry.intent === "tool",
  );
  if (tools.length < policy.minimumCompletedOperations) return negativeDraft();
  const signatures = new Map<string, number>();
  const classes = new Map<string, number>();
  for (const tool of tools) {
    signatures.set(tool.signatureKeyedDigest, (signatures.get(tool.signatureKeyedDigest) ?? 0) + 1);
    classes.set(tool.operationClass, (classes.get(tool.operationClass) ?? 0) + 1);
  }
  const repeatedSignatureCount = Math.max(0, ...signatures.values());
  const dominantClassCount = Math.max(0, ...classes.values());
  const dominantClassBasisPoints = Math.floor((dominantClassCount * 10_000) / tools.length);
  if (
    repeatedSignatureCount < policy.minimumRepeatedSignatureCount &&
    dominantClassBasisPoints < policy.dominantOperationClassBasisPoints
  ) {
    return negativeDraft();
  }
  return positiveDraft({
    family: "tool_use_concentration",
    learningClass: "mechanical_execution",
    statement: "The configured repeated or concentrated tool-use condition was observed.",
    referenceDigests: tools.map((entry) => entry.referenceDigest),
    data: toJsonValue({
      family: "tool_use_concentration",
      completedOperations: tools.length,
      maximumRepeatedSignatureCount: repeatedSignatureCount,
      dominantOperationClassBasisPoints: dominantClassBasisPoints,
    }),
    structural: false,
  });
}

function cycleCount(parents: ReadonlyMap<string, string | undefined>): number {
  const completed = new Set<string>();
  let cycles = 0;
  for (const start of parents.keys()) {
    if (completed.has(start)) continue;
    const path = new Set<string>();
    let current: string | undefined = start;
    while (current !== undefined && parents.has(current) && !completed.has(current)) {
      if (path.has(current)) {
        cycles += 1;
        break;
      }
      path.add(current);
      current = parents.get(current);
    }
    for (const value of path) completed.add(value);
  }
  return cycles;
}

function depthFromRoot(
  episodeId: string,
  rootEpisodeId: string,
  parents: ReadonlyMap<string, string | undefined>,
): number | undefined {
  let depth = 0;
  let current = episodeId;
  const seen = new Set<string>();
  while (current !== rootEpisodeId) {
    if (seen.has(current)) return undefined;
    seen.add(current);
    const parent = parents.get(current);
    if (parent === undefined) return undefined;
    current = parent;
    depth += 1;
  }
  return depth;
}

function analyzeCoordination(window: DetectorWindow, trafficClass: "delegated"): CoordinationAnalysis {
  const markers = observationEntries(window, [COORDINATION_POPULATION_KIND]).map(parseCoordinationMarker);
  if (markers.length !== 1 || markers[0]?.closedPopulation !== true) {
    throw invalid(
      "detector.result_invalid",
      "coordination reference input requires exactly one asserted closed root population",
      [],
    );
  }
  if (markers[0].trafficClass !== trafficClass) {
    throw invalid("detector.result_invalid", "coordination population markers must classify delegated traffic", []);
  }
  const rootEpisodeId = markers[0]?.record.episodeId;
  if (rootEpisodeId === undefined) {
    throw invalid("detector.result_invalid", "coordination root marker is missing", []);
  }
  const parents = new Map<string, string | undefined>();
  for (const episode of window.population.episodes) {
    const identity = episode.view.identity;
    if (identity.status !== "resolved" || parents.has(identity.episodeId)) {
      throw invalid("detector.result_invalid", "coordination population identity is ambiguous", []);
    }
    parents.set(identity.episodeId, identity.parentEpisodeId);
  }
  let brokenRoots = 0;
  if (!parents.has(rootEpisodeId) || parents.get(rootEpisodeId) !== undefined) brokenRoots += 1;
  for (const [episodeId, parent] of parents) {
    if (episodeId !== rootEpisodeId && parent === undefined) brokenRoots += 1;
  }
  let missingParents = 0;
  for (const [episodeId, parent] of parents) {
    if (episodeId !== rootEpisodeId && parent !== undefined && !parents.has(parent)) missingParents += 1;
  }
  const cycles = cycleCount(parents);
  let directChildren = 0;
  let descendants = 0;
  let maximumDepth = 0;
  for (const episodeId of parents.keys()) {
    if (episodeId === rootEpisodeId) continue;
    if (parents.get(episodeId) === rootEpisodeId) directChildren += 1;
    const depth = depthFromRoot(episodeId, rootEpisodeId, parents);
    if (depth !== undefined) {
      descendants += 1;
      maximumDepth = Math.max(maximumDepth, depth);
    }
  }
  return {
    markerRefs: markers.map((marker) => marker.referenceDigest),
    brokenRoots,
    missingParents,
    cycles,
    directChildren,
    descendants,
    maximumDepth,
  };
}

function evaluateAttributionIntegrity(
  window: DetectorWindow,
  policy: Extract<ReferenceDetectorPolicy, { readonly family: "coordination_attribution_integrity" }>,
): DetectorResultDraft {
  const graph = analyzeCoordination(window, policy.trafficClass);
  if (graph.brokenRoots === 0 && graph.missingParents === 0 && graph.cycles === 0) return negativeDraft();
  return positiveDraft({
    family: "coordination_attribution_integrity",
    learningClass: "system_meta",
    statement: "A closed coordination population contains structurally invalid attribution lineage.",
    referenceDigests: graph.markerRefs,
    data: toJsonValue({
      family: "coordination_attribution_integrity",
      brokenRootCount: graph.brokenRoots,
      missingParentCount: graph.missingParents,
      cycleCount: graph.cycles,
    }),
    structural: true,
  });
}

function evaluateFanout(
  window: DetectorWindow,
  policy: Extract<ReferenceDetectorPolicy, { readonly family: "coordination_fanout" }>,
): DetectorResultDraft {
  const graph = analyzeCoordination(window, policy.trafficClass);
  if (graph.brokenRoots !== 0 || graph.missingParents !== 0 || graph.cycles !== 0) {
    throw invalid("detector.result_invalid", "coordination fan-out requires exact acyclic closed attribution", []);
  }
  if (graph.directChildren < policy.minimumDirectChildren || graph.descendants < policy.minimumDescendants) {
    return negativeDraft();
  }
  return positiveDraft({
    family: "coordination_fanout",
    learningClass: "system_meta",
    statement: "The configured coordination fan-out condition was observed in a closed attributed population.",
    referenceDigests: graph.markerRefs,
    data: toJsonValue({
      family: "coordination_fanout",
      directChildren: graph.directChildren,
      descendants: graph.descendants,
      maximumDepth: graph.maximumDepth,
    }),
    structural: false,
  });
}

function evaluateRedirection(
  window: DetectorWindow,
  policy: Extract<ReferenceDetectorPolicy, { readonly family: "attributed_human_redirection" }>,
): DetectorResultDraft {
  const turns = observationEntries(window, [INTERACTION_TURN_KIND]).map(parseInteractionTurn).sort(compareSequenced);
  assertUniqueSequences(turns);
  const byEpisodeAndSequence = new Map(turns.map((turn) => [JSON.stringify([turn.episodeId, turn.sequence]), turn]));
  const pairRefs = new Set<string>();
  const episodes = new Set<string>();
  let pairCount = 0;
  for (const turn of turns) {
    if (
      turn.trafficClass !== policy.eligibleTrafficClass ||
      turn.actor !== "human" ||
      !turn.correction ||
      turn.replyToSequence === null
    ) {
      continue;
    }
    const target = byEpisodeAndSequence.get(JSON.stringify([turn.episodeId, turn.replyToSequence]));
    if (target === undefined) {
      throw invalid("detector.result_invalid", "reference redirection cites a missing same-episode turn", []);
    }
    if (target.sequence >= turn.sequence) {
      throw invalid("detector.result_invalid", "reference redirection must cite an earlier same-episode turn", []);
    }
    if (target.trafficClass !== policy.eligibleTrafficClass || target.actor !== "agent") {
      continue;
    }
    pairCount += 1;
    pairRefs.add(target.referenceDigest);
    pairRefs.add(turn.referenceDigest);
    episodes.add(turn.episodeId);
  }
  if (pairCount < policy.minimumExactPairs || episodes.size < policy.minimumDistinctEpisodes) return negativeDraft();
  return positiveDraft({
    family: "attributed_human_redirection",
    learningClass: "human_agent_interaction",
    statement: "The configured exact human-to-agent cited redirection condition was observed across distinct episodes.",
    referenceDigests: [...pairRefs].sort(compareText),
    data: toJsonValue({
      family: "attributed_human_redirection",
      citedPairCount: pairCount,
      distinctEpisodeCount: episodes.size,
    }),
    structural: false,
    missingEvidence: [
      {
        capability: "interaction.cited_turn_review",
        reasonCode: "interpretation.review_required",
        effect: "limits_claims",
      },
    ],
  });
}

export function evaluateReferenceDetector(
  policy: ReferenceDetectorPolicy,
  window: DetectorWindow,
): DetectorResultDraft {
  assertSingleSourcePopulation(window);
  if (policy.family === "coordination_attribution_integrity") return evaluateAttributionIntegrity(window, policy);
  if (policy.family === "repeated_status_polling") return evaluatePolling(window, policy);
  if (policy.family === "context_pressure_compaction") return evaluateContext(window, policy);
  if (policy.family === "tool_use_concentration") return evaluateTooling(window, policy);
  if (policy.family === "coordination_fanout") return evaluateFanout(window, policy);
  return evaluateRedirection(window, policy);
}
