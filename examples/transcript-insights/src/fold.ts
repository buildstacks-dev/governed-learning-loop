// Read-side fold over the kernel's typed, bounded query façade, shared by
// `report` and `distill`. The consumer never knows the engine's store namespace
// or record-kind strings. Episode views provide the source-scoped logical
// identity that observations use, while the episode record's scope supplies
// host-neutral provider/project attribution.
import type { EpisodeView, LearningLoop, Observation, QueryPage, Scope } from "@cormidia/learning-loop";
import { canonicalJsonText } from "@cormidia/learning-loop";
import { jsonBoolean, jsonNumber, jsonObject, jsonString } from "./json.js";

const PAGE_LIMIT = 200;

export interface FoldListProgress {
  readonly kind: "episodes" | "observations";
  readonly records: number;
  readonly pages: number;
  readonly heartbeat: boolean;
  readonly elapsedSeconds: number;
}

export type FoldProgress = (progress: FoldListProgress) => void;

async function consumePages<T>(
  kind: FoldListProgress["kind"],
  source: AsyncIterable<QueryPage<T>>,
  consume: (item: T) => void,
  progress?: FoldProgress,
): Promise<number> {
  let records = 0;
  let pages = 0;
  const startedAt = Date.now();
  const elapsedSeconds = (): number => Math.max(0, Math.floor((Date.now() - startedAt) / 1_000));
  const heartbeat = setInterval(() => {
    progress?.({ kind, records, pages, heartbeat: true, elapsedSeconds: elapsedSeconds() });
  }, 5_000);
  heartbeat.unref();
  try {
    for await (const page of source) {
      pages += 1;
      records += page.items.length;
      for (const item of page.items) consume(item);
      const done = page.nextCursor === undefined;
      if (pages === 1 || pages % 25 === 0 || done) {
        progress?.({
          kind,
          records,
          pages,
          heartbeat: false,
          elapsedSeconds: elapsedSeconds(),
        });
      }
    }
    // A conforming query yields one terminal empty page for an empty result.
    // Keep progress useful if a custom implementation instead yields none.
    if (pages === 0) {
      pages = 1;
      progress?.({ kind, records, pages, heartbeat: false, elapsedSeconds: elapsedSeconds() });
    }
    return records;
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
  readonly unresolvedEpisodeIdentityCount: number;
  readonly unresolvedObservationCount: number;
}

function episodeKey(sourceId: string, episodeId: string): string {
  return canonicalJsonText([sourceId, episodeId]);
}

function projectKey(provider: string, project: string): string {
  return canonicalJsonText([provider, project]);
}

function segmentId(scope: Scope, type: string): string | undefined {
  return scope.find((segment) => segment.type === type)?.id;
}

function foldObservation(fold: ProjectFold, observation: Observation): void {
  fold.observations += 1;
  const data = jsonObject(observation.data);
  const scopedEpisodeId = episodeKey(observation.provenance.sourceId, observation.episodeId);
  switch (observation.kind) {
    case "transcript.message": {
      const actor = jsonString(data?.actor);
      if (actor === "human") {
        fold.humanMessages += 1;
        if (jsonBoolean(data?.correctionSignal) === true) {
          addToCluster(fold.corrections, scopedEpisodeId, observation.id);
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
        addToCluster(cluster, scopedEpisodeId, observation.id);
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

export async function foldStore(learning: LearningLoop, progress?: FoldProgress): Promise<StoreFold> {
  const episodeScopes = new Map<string, { readonly provider: string; readonly project: string }>();
  let unresolvedEpisodeIdentityCount = 0;
  const episodeRecordCount = await consumePages(
    "episodes",
    learning.queryEpisodes({ limit: PAGE_LIMIT }),
    (view: EpisodeView) => {
      if (view.identity.status === "unresolved") {
        unresolvedEpisodeIdentityCount += 1;
        return;
      }
      episodeScopes.set(episodeKey(view.identity.sourceId, view.identity.episodeId), {
        provider: segmentId(view.episode.scope, "provider") ?? "unknown",
        project: segmentId(view.episode.scope, "project") ?? "unknown",
      });
    },
    progress,
  );

  const projects = new Map<string, ProjectFold>();
  const completeness = { complete: 0, partial: 0, unknown: 0 };
  let unknownRecordCount = 0;
  let unresolvedObservationCount = 0;
  const observationCount = await consumePages(
    "observations",
    learning.queryObservations({ limit: PAGE_LIMIT }),
    (observation: Observation) => {
      completeness[observation.provenance.completeness] += 1;
      if (observation.kind === "transcript.unknown") unknownRecordCount += 1;
      const key = episodeKey(observation.provenance.sourceId, observation.episodeId);
      const episodeScope = episodeScopes.get(key);
      if (episodeScope === undefined) {
        unresolvedObservationCount += 1;
        return;
      }
      const keyForProject = projectKey(episodeScope.provider, episodeScope.project);
      const fold = projects.get(keyForProject) ?? {
        provider: episodeScope.provider,
        project: episodeScope.project,
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
      projects.set(keyForProject, fold);
      fold.episodeIds.add(key);
      if (observation.provenance.completeness === "partial") fold.partialObservations += 1;
      foldObservation(fold, observation);
    },
    progress,
  );

  const sorted = new Map([...projects.entries()].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)));
  return {
    projects: sorted,
    episodeRecordCount,
    observationCount,
    completeness,
    unknownRecordCount,
    unresolvedEpisodeIdentityCount,
    unresolvedObservationCount,
  };
}
