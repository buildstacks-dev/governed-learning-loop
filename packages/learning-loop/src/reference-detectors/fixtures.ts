import { sha256HexOfCanonicalJson } from "../canonical/canonical-json.js";
import type { JsonValue } from "../canonical/json.js";
import { toJsonValue } from "../canonical/to-json-value.js";
import {
  CONTEXT_COMPACTION_KIND,
  CONTEXT_UTILIZATION_KIND,
  COORDINATION_POPULATION_KIND,
  INTERACTION_TURN_KIND,
  OPERATION_KIND,
} from "./evaluate.js";
import type { ReferenceDetectorFamily, ReferenceDetectorFixtureDescriptor } from "./types.js";

const FIXTURE_SCOPE = [{ type: "project", id: "reference-fixture" }];
const OPENED_AT = "2026-01-01T00:00:00.000Z";
const CLOSED_AT = "2026-01-01T00:01:00.000Z";

function keyed(label: string): string {
  return sha256HexOfCanonicalJson(["reference-fixture-tenant-key", label]);
}

function episode(id: string, parentEpisodeId?: string): JsonValue {
  return toJsonValue({
    id,
    ...(parentEpisodeId === undefined ? {} : { parentEpisodeId }),
    episodeClass: "reference",
    scope: FIXTURE_SCOPE,
    openedAt: OPENED_AT,
    closedAt: CLOSED_AT,
    outcome: { status: "unknown", measurementIds: [] },
  });
}

function observation(id: string, episodeId: string, kind: string, data: JsonValue): JsonValue {
  return toJsonValue({ id, episodeId, occurredAt: OPENED_AT, kind, data });
}

function operationObservation(input: {
  readonly id: string;
  readonly episodeId: string;
  readonly sequence: number;
  readonly intent: "status_poll" | "wait" | "tool" | "progress";
  readonly state: "unchanged" | "changed" | "succeeded" | "failed" | "unknown";
  readonly operationClass: string;
  readonly target: string;
  readonly signature: string;
  readonly trafficClass?: "primary" | "delegated" | "automated" | "reviewer" | "guardian" | "benchmark" | "replay";
}): JsonValue {
  return observation(
    input.id,
    input.episodeId,
    OPERATION_KIND,
    toJsonValue({
      sequence: input.sequence,
      intent: input.intent,
      state: input.state,
      operationClass: input.operationClass,
      targetKeyedDigest: keyed(input.target),
      signatureKeyedDigest: keyed(input.signature),
      trafficClass: input.trafficClass ?? "primary",
    }),
  );
}

function fixture(input: {
  readonly id: string;
  readonly detectorFamily: ReferenceDetectorFamily;
  readonly control: "positive" | "negative";
  readonly complexLegitimate?: boolean;
  readonly evidenceInput: JsonValue;
  readonly conditionDetected: boolean;
}): ReferenceDetectorFixtureDescriptor {
  const base: Omit<ReferenceDetectorFixtureDescriptor, "fixtureDigest"> = {
    schemaVersion: 1,
    id: input.id,
    detectorFamily: input.detectorFamily,
    control: input.control,
    complexLegitimate: input.complexLegitimate ?? false,
    input: input.evidenceInput,
    expected: { conditionDetected: input.conditionDetected },
  };
  return { ...base, fixtureDigest: sha256HexOfCanonicalJson(toJsonValue(base)) };
}

function manualInput(observations: readonly JsonValue[], episodes: readonly JsonValue[]): JsonValue {
  return toJsonValue({ observations, episodes });
}

function coordinationInput(input: {
  readonly label: string;
  readonly parents: readonly (readonly [string, string | undefined])[];
}): JsonValue {
  const root = input.parents[0]?.[0] ?? `${input.label}-root`;
  return manualInput(
    [
      observation(
        `${input.label}-marker`,
        root,
        COORDINATION_POPULATION_KIND,
        toJsonValue({ closedPopulation: true, trafficClass: "delegated" }),
      ),
    ],
    input.parents.map(([id, parent]) => episode(id, parent)),
  );
}

function pollingInput(states: readonly ("unchanged" | "changed")[]): JsonValue {
  const episodeId = "polling-episode";
  return manualInput(
    states.map((state, index) =>
      operationObservation({
        id: `poll-${String(index)}`,
        episodeId,
        sequence: index,
        intent: "status_poll",
        state,
        operationClass: "status",
        target: "poll-target",
        signature: "poll-signature",
      }),
    ),
    [episode(episodeId)],
  );
}

function contextInput(input: { readonly utilization: readonly number[]; readonly compactions: number }): JsonValue {
  const episodeId = "context-episode";
  const utilization = input.utilization.map((basisPoints, index) =>
    observation(
      `context-utilization-${String(index)}`,
      episodeId,
      CONTEXT_UTILIZATION_KIND,
      toJsonValue({ sequence: index, utilizationBasisPoints: basisPoints, trafficClass: "primary" }),
    ),
  );
  const compactions = Array.from({ length: input.compactions }, (_, index) =>
    observation(
      `context-compaction-${String(index)}`,
      episodeId,
      CONTEXT_COMPACTION_KIND,
      toJsonValue({
        sequence: input.utilization.length + index,
        beforeUtilizationBasisPoints: 9_500,
        afterUtilizationBasisPoints: 4_000,
        trafficClass: "primary",
      }),
    ),
  );
  return manualInput([...utilization, ...compactions], [episode(episodeId)]);
}

function toolingInput(input: {
  readonly count: number;
  readonly classAt: (index: number) => string;
  readonly signatureAt: (index: number) => string;
}): JsonValue {
  const episodeId = "tooling-episode";
  return manualInput(
    Array.from({ length: input.count }, (_, index) =>
      operationObservation({
        id: `tool-${String(index).padStart(2, "0")}`,
        episodeId,
        sequence: index,
        intent: "tool",
        state: "succeeded",
        operationClass: input.classAt(index),
        target: `target-${String(index)}`,
        signature: input.signatureAt(index),
      }),
    ),
    [episode(episodeId)],
  );
}

function interactionInput(validSecondPair: boolean): JsonValue {
  const firstEpisode = "redirection-episode-a";
  const secondEpisode = "redirection-episode-b";
  const turns = [
    observation(
      "redirection-a-agent",
      firstEpisode,
      INTERACTION_TURN_KIND,
      toJsonValue({ sequence: 0, actor: "agent", correction: false, replyToSequence: null, trafficClass: "primary" }),
    ),
    observation(
      "redirection-a-human",
      firstEpisode,
      INTERACTION_TURN_KIND,
      toJsonValue({ sequence: 1, actor: "human", correction: true, replyToSequence: 0, trafficClass: "primary" }),
    ),
    observation(
      "redirection-b-target",
      secondEpisode,
      INTERACTION_TURN_KIND,
      toJsonValue({
        sequence: 0,
        actor: validSecondPair ? "agent" : "human",
        correction: false,
        replyToSequence: null,
        trafficClass: validSecondPair ? "primary" : "replay",
      }),
    ),
    observation(
      "redirection-b-human",
      secondEpisode,
      INTERACTION_TURN_KIND,
      toJsonValue({ sequence: 1, actor: "human", correction: true, replyToSequence: 0, trafficClass: "primary" }),
    ),
  ];
  return manualInput(turns, [episode(firstEpisode), episode(secondEpisode)]);
}

const TOOLING_COMPLEX_NEGATIVE = toolingInput({
  count: 48,
  classAt: (index) => (index < 24 ? "class_a" : index < 36 ? "class_b" : "class_c"),
  signatureAt: (index) => `legitimate-signature-${String(index)}`,
});

export const REFERENCE_FIXTURES: readonly ReferenceDetectorFixtureDescriptor[] = [
  fixture({
    id: "reference.fixture.attributed_human_redirection.negative.v1",
    detectorFamily: "attributed_human_redirection",
    control: "negative",
    evidenceInput: interactionInput(false),
    conditionDetected: false,
  }),
  fixture({
    id: "reference.fixture.attributed_human_redirection.positive.v1",
    detectorFamily: "attributed_human_redirection",
    control: "positive",
    evidenceInput: interactionInput(true),
    conditionDetected: true,
  }),
  fixture({
    id: "reference.fixture.context_pressure_compaction.negative.v1",
    detectorFamily: "context_pressure_compaction",
    control: "negative",
    evidenceInput: contextInput({ utilization: [9_100, 8_000, 9_200, 9_300], compactions: 1 }),
    conditionDetected: false,
  }),
  fixture({
    id: "reference.fixture.context_pressure_compaction.positive.v1",
    detectorFamily: "context_pressure_compaction",
    control: "positive",
    evidenceInput: contextInput({ utilization: [9_100, 9_300, 9_500], compactions: 2 }),
    conditionDetected: true,
  }),
  fixture({
    id: "reference.fixture.coordination_attribution_integrity.negative.v1",
    detectorFamily: "coordination_attribution_integrity",
    control: "negative",
    evidenceInput: coordinationInput({
      label: "attribution-negative",
      parents: [
        ["attribution-negative-root", undefined],
        ["attribution-negative-child", "attribution-negative-root"],
      ],
    }),
    conditionDetected: false,
  }),
  fixture({
    id: "reference.fixture.coordination_attribution_integrity.positive.v1",
    detectorFamily: "coordination_attribution_integrity",
    control: "positive",
    evidenceInput: coordinationInput({
      label: "attribution-positive",
      parents: [
        ["attribution-positive-root", undefined],
        ["attribution-positive-child", "missing-parent"],
      ],
    }),
    conditionDetected: true,
  }),
  fixture({
    id: "reference.fixture.coordination_fanout.negative.v1",
    detectorFamily: "coordination_fanout",
    control: "negative",
    evidenceInput: coordinationInput({
      label: "fanout-negative",
      parents: [
        ["fanout-negative-root", undefined],
        ["fanout-negative-a", "fanout-negative-root"],
        ["fanout-negative-b", "fanout-negative-root"],
        ["fanout-negative-c", "fanout-negative-root"],
        ["fanout-negative-a1", "fanout-negative-a"],
        ["fanout-negative-b1", "fanout-negative-b"],
        ["fanout-negative-c1", "fanout-negative-c"],
      ],
    }),
    conditionDetected: false,
  }),
  fixture({
    id: "reference.fixture.coordination_fanout.positive.v1",
    detectorFamily: "coordination_fanout",
    control: "positive",
    evidenceInput: coordinationInput({
      label: "fanout-positive",
      parents: [
        ["fanout-positive-root", undefined],
        ["fanout-positive-a", "fanout-positive-root"],
        ["fanout-positive-b", "fanout-positive-root"],
        ["fanout-positive-c", "fanout-positive-root"],
        ["fanout-positive-d", "fanout-positive-root"],
        ["fanout-positive-a1", "fanout-positive-a"],
        ["fanout-positive-b1", "fanout-positive-b"],
      ],
    }),
    conditionDetected: true,
  }),
  fixture({
    id: "reference.fixture.repeated_status_polling.negative.v1",
    detectorFamily: "repeated_status_polling",
    control: "negative",
    evidenceInput: pollingInput(["unchanged", "unchanged", "changed", "unchanged", "unchanged"]),
    conditionDetected: false,
  }),
  fixture({
    id: "reference.fixture.repeated_status_polling.positive.v1",
    detectorFamily: "repeated_status_polling",
    control: "positive",
    evidenceInput: pollingInput(["unchanged", "unchanged", "unchanged", "unchanged"]),
    conditionDetected: true,
  }),
  fixture({
    id: "reference.fixture.tool_use_concentration.complex-legitimate-negative.v1",
    detectorFamily: "tool_use_concentration",
    control: "negative",
    complexLegitimate: true,
    evidenceInput: TOOLING_COMPLEX_NEGATIVE,
    conditionDetected: false,
  }),
  fixture({
    id: "reference.fixture.tool_use_concentration.positive.v1",
    detectorFamily: "tool_use_concentration",
    control: "positive",
    evidenceInput: toolingInput({
      count: 12,
      classAt: (index) => (index < 9 ? "class_a" : "class_b"),
      signatureAt: (index) => (index < 4 ? "repeated-signature" : `signature-${String(index)}`),
    }),
    conditionDetected: true,
  }),
].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
