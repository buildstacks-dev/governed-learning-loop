// learning.report — a read-only fold over stored records. Interventions and
// evaluations structurally cannot exist in the Observe+Govern milestone, so
// those id lists are empty with an explanatory diagnostic rather than a
// silent absence.
import type { Diagnostic } from "../diagnostics.js";
import { invalid } from "../parse/toolkit.js";
import { parseCandidate } from "../records/candidate.js";
import { parseObservation } from "../records/observation.js";
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

/**
 * Evidence ids referenced by candidates may use either the durable observation
 * id or the source-record id (kept in provenance.recordRef); collect both for
 * every observation belonging to the queried episodes.
 */
async function episodeEvidenceKeys(
  context: EngineContext,
  sourceIds: readonly string[],
  episodeIds?: readonly string[],
): Promise<ReadonlySet<string>> {
  const wantedSources = new Set(sourceIds);
  const wantedEpisodes = episodeIds === undefined ? undefined : new Set(episodeIds);
  const keys = new Set<string>();
  const allDurableIds = new Set<string>();
  const rawSources = new Map<string, Set<string>>();
  const matchingRawRefs = new Set<string>();
  for await (const page of iterateRecordPages(context.store, "observation", { limit: 100 })) {
    for (const record of page.records) {
      const observation = parseObservation(record.value);
      allDurableIds.add(observation.id);
      if (observation.provenance.recordRef !== undefined) {
        const sources = rawSources.get(observation.provenance.recordRef) ?? new Set<string>();
        sources.add(observation.provenance.sourceId);
        rawSources.set(observation.provenance.recordRef, sources);
      }
      if (
        !wantedSources.has(observation.provenance.sourceId) ||
        (wantedEpisodes !== undefined && !wantedEpisodes.has(observation.episodeId))
      ) {
        continue;
      }
      keys.add(observation.id);
      if (observation.provenance.recordRef !== undefined) matchingRawRefs.add(observation.provenance.recordRef);
    }
  }
  for (const rawRef of matchingRawRefs) {
    if (!allDurableIds.has(rawRef) && rawSources.get(rawRef)?.size === 1) keys.add(rawRef);
  }
  return keys;
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
  const evidenceKeys =
    query.sourceIds === undefined ? undefined : await episodeEvidenceKeys(context, query.sourceIds, query.episodeIds);

  const candidateIds: string[] = [];
  for await (const page of iterateRecordPages(context.store, "candidate", { limit: 100 })) {
    for (const record of page.records) {
      const candidate = parseCandidate(record.value);
      if (scope !== undefined && context.scopePolicy.comparePrecedence(scope, candidate.scope) !== 0) continue;
      if (!candidateInsideWindow(candidate.proposedAt, query)) continue;
      if (evidenceKeys !== undefined && !candidate.evidenceIds.some((id) => evidenceKeys.has(id))) continue;
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
