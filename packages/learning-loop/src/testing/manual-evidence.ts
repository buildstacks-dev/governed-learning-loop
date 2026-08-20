// Manual evidence source: an EvidenceSource whose input IS the projections,
// yielded back as a single page (the contract's consumer journey ingests
// caller-shaped observation/measurement/episode records without provenance —
// the engine stamps provenance; this source supplies sourceRecordIds from the
// given ids and marks the caller's structured records complete). The source
// available-state revision is the digest of the canonical input. Each caller
// batch is its own logical page, so independent append batches do not look
// like unverifiable rewrites of one source artifact; re-reading identical
// input still reports the same page identity and revision.
import { sha256HexOfCanonicalJson } from "../canonical/canonical-json.js";
import type { JsonValue } from "../canonical/json.js";
import { toJsonValue } from "../canonical/to-json-value.js";
import type { EvidencePage, EvidenceSource } from "../ports/evidence.js";
import type { EpisodeOutcome, MetricDefinition } from "../records/episode.js";
import type { Scope } from "../records/scope.js";

export interface ManualEvidenceInput {
  readonly observations?: readonly {
    readonly id: string;
    readonly episodeId: string;
    readonly occurredAt?: string;
    readonly kind: string;
    readonly data: JsonValue;
  }[];
  readonly measurements?: readonly {
    readonly id: string;
    readonly episodeId: string;
    readonly metric: MetricDefinition;
    readonly value: number | string | boolean;
    readonly evidenceIds: readonly string[];
    readonly measuredAt?: string;
  }[];
  readonly episodes?: readonly {
    readonly id: string;
    readonly parentEpisodeId?: string;
    readonly episodeClass?: string;
    readonly scope: Scope;
    readonly openedAt: string;
    readonly closedAt?: string;
    readonly outcome?: EpisodeOutcome;
  }[];
}

function revisionFor(input: ManualEvidenceInput): string {
  return sha256HexOfCanonicalJson(toJsonValue(input));
}

function pageFor(input: ManualEvidenceInput): EvidencePage {
  const revision = revisionFor(input);
  return {
    sourceRef: "manual-evidence",
    pageRef: revision,
    state: {
      status: "available",
      sourceRevision: revision,
      completeness: "complete",
    },
    observations: (input.observations ?? []).map((observation) => ({
      sourceRecordId: observation.id,
      episodeId: observation.episodeId,
      ...(observation.occurredAt !== undefined ? { occurredAt: observation.occurredAt } : {}),
      kind: observation.kind,
      data: observation.data,
      completeness: "complete" as const,
    })),
    measurements: (input.measurements ?? []).map((measurement) => ({
      sourceRecordId: measurement.id,
      episodeId: measurement.episodeId,
      metric: measurement.metric,
      value: measurement.value,
      evidenceSourceRecordIds: measurement.evidenceIds,
      ...(measurement.measuredAt !== undefined ? { measuredAt: measurement.measuredAt } : {}),
    })),
    episodes: (input.episodes ?? []).map((episode) => ({
      sourceRecordId: episode.id,
      episodeId: episode.id,
      ...(episode.parentEpisodeId !== undefined ? { parentEpisodeId: episode.parentEpisodeId } : {}),
      ...(episode.episodeClass !== undefined ? { episodeClass: episode.episodeClass } : {}),
      completeness: "complete" as const,
      scope: episode.scope,
      openedAt: episode.openedAt,
      ...(episode.closedAt !== undefined ? { closedAt: episode.closedAt } : {}),
      ...(episode.outcome !== undefined ? { status: episode.outcome.status } : {}),
      measurementSourceRecordIds: episode.outcome?.measurementIds ?? [],
    })),
    diagnostics: [],
  };
}

export function createManualEvidenceSource(): EvidenceSource<ManualEvidenceInput> {
  return {
    descriptor: { id: "manual-evidence", adapterVersion: "1.0.0" },
    probe: (input) => Promise.resolve({ supported: true, sourceRevision: revisionFor(input), diagnostics: [] }),
    read: async function* (input): AsyncIterable<EvidencePage> {
      yield pageFor(input);
    },
  };
}
