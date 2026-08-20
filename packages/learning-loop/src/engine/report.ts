// learning.report — a read-only fold over stored records. Interventions and
// evaluations structurally cannot exist in the Observe+Govern milestone, so
// those id lists are empty with an explanatory diagnostic rather than a
// silent absence.
import type { Diagnostic } from "../diagnostics.js";
import { invalid } from "../parse/toolkit.js";
import { candidateScopeDigest, parseCandidate } from "../records/candidate.js";
import type { Scope } from "../records/scope.js";
import type { EngineContext } from "./context.js";
import { iterateRecordPages } from "./context.js";
import { parseLearningReportQuery } from "./query.js";

export interface LearningReportQuery {
  readonly scope?: Scope;
  readonly sourceIds?: readonly string[];
  readonly episodeIds?: readonly string[];
  readonly since?: string;
  readonly until?: string;
}

export interface LearningReport {
  readonly query: LearningReportQuery;
  readonly candidateIds: readonly string[];
  readonly interventionIds: readonly string[];
  readonly evaluationIds: readonly string[];
  readonly diagnostics: readonly Diagnostic[];
}

const TIERS_NOT_IMPLEMENTED: Diagnostic = {
  code: "report.tier_not_implemented",
  severity: "info",
  message:
    "intervention and evaluation records cannot exist yet: the activation and validation tiers are not part of the Observe+Govern milestone",
};

function candidateMatchesEvidence(
  candidate: ReturnType<typeof parseCandidate>,
  sourceIds: readonly string[],
  episodeIds?: readonly string[],
): boolean {
  if (candidate.schemaVersion === 1) return false;
  const wantedSources = new Set(sourceIds);
  const wantedEpisodes = episodeIds === undefined ? undefined : new Set(episodeIds);
  return candidate.evidenceRefs.some(
    (reference) =>
      wantedSources.has(reference.sourceId) &&
      (wantedEpisodes === undefined || wantedEpisodes.has(reference.episode.episodeId)),
  );
}

function candidateInsideWindow(candidateTimestamp: string, query: LearningReportQuery): boolean {
  if (query.since === undefined && query.until === undefined) return true;
  const time = Date.parse(candidateTimestamp);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== candidateTimestamp) {
    throw invalid("query.incomplete", "stored candidate has a noncanonical proposedAt timestamp", ["proposedAt"]);
  }
  if (query.since !== undefined && time < Date.parse(query.since)) return false;
  if (query.until !== undefined && time > Date.parse(query.until)) return false;
  return true;
}

export async function runReport(context: EngineContext, input: LearningReportQuery): Promise<LearningReport> {
  const query = parseLearningReportQuery(context, input);
  const scope = query.scope;

  const candidateIds: string[] = [];
  for await (const page of iterateRecordPages(context.store, "candidate", { limit: 100 })) {
    for (const record of page.records) {
      const candidate = parseCandidate(record.value);
      if (candidate.id !== record.key.id) {
        throw invalid("store.corrupt", "stored candidate id does not match its record key", ["id"]);
      }
      if (scope !== undefined && candidateScopeDigest(scope) !== candidateScopeDigest(candidate.scope)) continue;
      if (!candidateInsideWindow(candidate.proposedAt, query)) continue;
      if (query.sourceIds !== undefined && !candidateMatchesEvidence(candidate, query.sourceIds, query.episodeIds)) {
        continue;
      }
      candidateIds.push(candidate.id);
    }
  }

  return {
    query,
    candidateIds,
    interventionIds: [],
    evaluationIds: [],
    diagnostics: [TIERS_NOT_IMPLEMENTED],
  };
}
