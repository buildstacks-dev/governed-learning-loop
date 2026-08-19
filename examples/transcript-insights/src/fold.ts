// Read-side fold over the stored records, shared by `report` and `distill`.
//
// The engine keeps its records in the "learning" namespace with kinds
// "observation" / "episode" — knowledge this consumer takes from the store
// layout because the façade exposes no read path for observations (recorded
// as consumer feedback). Every value read back is validated with the public
// record parsers; corrupt records are counted, never trusted.
//
// Observations are grouped per episode via observation.episodeId (the
// adapters' projected episode id) and attributed to provider/project via each
// episode's transcript.session.meta observation — the stored episode record
// carries a different derived id, so the meta observation is the only robust
// public join key.
import type { LearningStore, Observation, StoredRecord } from "@cormidia/learning-loop";
import { parseObservation } from "@cormidia/learning-loop";
import { jsonBoolean, jsonNumber, jsonObject, jsonString } from "./json.js";

export const LEARNING_NAMESPACE = "learning";

export interface FoldListProgress {
  readonly kind: "episodes" | "observations";
  readonly records: number;
  readonly pages: number;
  readonly heartbeat: boolean;
  readonly elapsedSeconds: number;
}

export type FoldProgress = (progress: FoldListProgress) => void;

export async function listLearningRecords(
  store: LearningStore,
  kind: "episode" | "observation",
  progress?: FoldProgress,
): Promise<readonly StoredRecord[]> {
  const records: StoredRecord[] = [];
  let cursor: string | undefined;
  let pages = 0;
  const label = kind === "episode" ? "episodes" : "observations";
  const startedAt = Date.now();
  const elapsedSeconds = (): number => Math.max(0, Math.floor((Date.now() - startedAt) / 1_000));
  const heartbeat = setInterval(() => {
    progress?.({ kind: label, records: records.length, pages, heartbeat: true, elapsedSeconds: elapsedSeconds() });
  }, 5_000);
  heartbeat.unref();
  try {
    for (;;) {
      const page = await store.list({
        namespace: LEARNING_NAMESPACE,
        kind,
        ...(cursor !== undefined ? { cursor } : {}),
        limit: 200,
      });
      pages += 1;
      records.push(...page.records);
      const done = page.nextCursor === undefined;
      if (pages === 1 || pages % 25 === 0 || done) {
        progress?.({
          kind: label,
          records: records.length,
          pages,
          heartbeat: false,
          elapsedSeconds: elapsedSeconds(),
        });
      }
      if (done) return records;
      cursor = page.nextCursor;
    }
  } finally {
    clearInterval(heartbeat);
  }
}

export interface SignalCluster {
  count: number;
  readonly episodeIds: Set<string>;
  readonly observationIds: string[];
}

function newCluster(): SignalCluster {
  return { count: 0, episodeIds: new Set(), observationIds: [] };
}

function addToCluster(cluster: SignalCluster, episodeId: string, observationId: string): void {
  cluster.count += 1;
  cluster.episodeIds.add(episodeId);
  cluster.observationIds.push(observationId);
}

export interface ProjectFold {
  readonly provider: string;
  readonly project: string;
  readonly episodeIds: Set<string>;
  observations: number;
  partialObservations: number;
  unknownRecords: number;
  humanMessages: number;
  agentMessages: number;
  readonly corrections: SignalCluster;
  readonly toolFailures: Map<string, SignalCluster>;
  toolCompletions: number;
  aborted: number;
  rolledBack: number;
  tokensIn: number;
  tokensOut: number;
}

export interface StoreFold {
  /** Keyed `${provider}/${project}`, iteration order sorted by key. */
  readonly projects: ReadonlyMap<string, ProjectFold>;
  readonly episodeRecordCount: number;
  readonly observationCount: number;
  readonly completeness: { readonly complete: number; readonly partial: number; readonly unknown: number };
  readonly unknownRecordCount: number;
  readonly corruptRecordCount: number;
}

interface EpisodeGroup {
  provider: string;
  project: string;
  readonly observations: Observation[];
}

function foldObservation(fold: ProjectFold, observation: Observation): void {
  fold.observations += 1;
  const data = jsonObject(observation.data);
  switch (observation.kind) {
    case "transcript.message": {
      const actor = jsonString(data?.actor);
      if (actor === "human") {
        fold.humanMessages += 1;
        if (jsonBoolean(data?.correctionSignal) === true) {
          addToCluster(fold.corrections, observation.episodeId, observation.id);
        }
      } else if (actor === "agent") {
        fold.agentMessages += 1;
      }
      return;
    }
    case "transcript.tool.completed": {
      fold.toolCompletions += 1;
      if (jsonString(data?.outcome) === "failure") {
        const toolName = jsonString(data?.toolName) ?? "unknown";
        const cluster = fold.toolFailures.get(toolName) ?? newCluster();
        fold.toolFailures.set(toolName, cluster);
        addToCluster(cluster, observation.episodeId, observation.id);
      }
      return;
    }
    case "transcript.task.signal": {
      const signal = jsonString(data?.signal);
      if (signal === "aborted") fold.aborted += 1;
      if (signal === "rolled_back") fold.rolledBack += 1;
      return;
    }
    case "transcript.usage": {
      fold.tokensIn += jsonNumber(data?.tokensIn) ?? 0;
      fold.tokensOut += jsonNumber(data?.tokensOut) ?? 0;
      return;
    }
    case "transcript.unknown": {
      fold.unknownRecords += 1;
      return;
    }
    default:
      return;
  }
}

export async function foldStore(store: LearningStore, progress?: FoldProgress): Promise<StoreFold> {
  // Observations dominate real backfills, so name that phase immediately
  // while the file store prepares its insertion catalog.
  const observationRecords = await listLearningRecords(store, "observation", progress);
  const episodeRecords = await listLearningRecords(store, "episode", progress);
  let corrupt = 0;

  const groups = new Map<string, EpisodeGroup>();
  const completeness = { complete: 0, partial: 0, unknown: 0 };
  let unknownRecordCount = 0;
  let observationCount = 0;
  for (const record of observationRecords) {
    let observation: Observation;
    try {
      observation = parseObservation(record.value);
    } catch {
      corrupt += 1;
      continue;
    }
    observationCount += 1;
    completeness[observation.provenance.completeness] += 1;
    if (observation.kind === "transcript.unknown") unknownRecordCount += 1;
    const group = groups.get(observation.episodeId) ?? {
      provider: "unknown",
      project: "unknown",
      observations: [],
    };
    groups.set(observation.episodeId, group);
    group.observations.push(observation);
    if (observation.kind === "transcript.session.meta") {
      const data = jsonObject(observation.data);
      group.provider = jsonString(data?.provider) ?? "unknown";
      group.project = jsonString(data?.projectSlug) ?? "unknown";
    }
  }

  const projects = new Map<string, ProjectFold>();
  for (const [episodeId, group] of groups) {
    const key = `${group.provider}/${group.project}`;
    const fold = projects.get(key) ?? {
      provider: group.provider,
      project: group.project,
      episodeIds: new Set<string>(),
      observations: 0,
      partialObservations: 0,
      unknownRecords: 0,
      humanMessages: 0,
      agentMessages: 0,
      corrections: newCluster(),
      toolFailures: new Map<string, SignalCluster>(),
      toolCompletions: 0,
      aborted: 0,
      rolledBack: 0,
      tokensIn: 0,
      tokensOut: 0,
    };
    projects.set(key, fold);
    fold.episodeIds.add(episodeId);
    for (const observation of group.observations) {
      if (observation.provenance.completeness === "partial") fold.partialObservations += 1;
      foldObservation(fold, observation);
    }
  }

  const sorted = new Map([...projects.entries()].sort(([left], [right]) => left.localeCompare(right)));
  return {
    projects: sorted,
    episodeRecordCount: episodeRecords.length,
    observationCount,
    completeness,
    unknownRecordCount,
    corruptRecordCount: corrupt,
  };
}
