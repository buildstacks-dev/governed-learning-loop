// learning.report — a read-only fold over stored records. Interventions and
// evaluations structurally cannot exist in the Observe+Govern milestone, so
// those id lists are empty with an explanatory diagnostic rather than a
// silent absence.
import type { Diagnostic } from "../diagnostics.js";
import { parseCandidate } from "../records/candidate.js";
import { parseObservation } from "../records/observation.js";
import type { Scope } from "../records/scope.js";
import type { EngineContext } from "./context.js";
import { listAllRecords } from "./context.js";

export interface LearningReportQuery {
  readonly scope?: Scope;
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
  episodeIds: readonly string[],
): Promise<ReadonlySet<string>> {
  const wanted = new Set(episodeIds);
  const keys = new Set<string>();
  const stored = await listAllRecords(context.store, "observation");
  for (const record of stored) {
    const observation = parseObservation(record.value);
    if (!wanted.has(observation.episodeId)) continue;
    keys.add(observation.id);
    if (observation.provenance.recordRef !== undefined) keys.add(observation.provenance.recordRef);
  }
  return keys;
}

export async function runReport(context: EngineContext, query: LearningReportQuery): Promise<LearningReport> {
  const scope = query.scope === undefined ? undefined : context.scopePolicy.validate(query.scope);
  const evidenceKeys =
    query.episodeIds === undefined ? undefined : await episodeEvidenceKeys(context, query.episodeIds);

  const stored = await listAllRecords(context.store, "candidate");
  const candidateIds: string[] = [];
  for (const record of stored) {
    const candidate = parseCandidate(record.value);
    if (scope !== undefined && context.scopePolicy.comparePrecedence(scope, candidate.scope) !== 0) continue;
    // ISO-8601 UTC timestamps compare correctly as strings; both bounds inclusive.
    if (query.since !== undefined && candidate.proposedAt < query.since) continue;
    if (query.until !== undefined && candidate.proposedAt > query.until) continue;
    if (evidenceKeys !== undefined && !candidate.evidenceIds.some((id) => evidenceKeys.has(id))) continue;
    candidateIds.push(candidate.id);
  }

  return {
    query: {
      ...(scope !== undefined ? { scope } : {}),
      ...(query.episodeIds !== undefined ? { episodeIds: query.episodeIds } : {}),
      ...(query.since !== undefined ? { since: query.since } : {}),
      ...(query.until !== undefined ? { until: query.until } : {}),
    },
    candidateIds,
    interventionIds: [],
    evaluationIds: [],
    diagnostics: [TIERS_NOT_IMPLEMENTED],
  };
}
