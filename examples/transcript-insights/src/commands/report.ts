// `report` — plain-text fold over the governed store: ingestion health,
// per-project friction signals, and the inert candidate queue with the
// engine's governance view. The wording is deliberate: recurrence, never
// causation, and never the words the kernel reserves for measured outcomes.
import type { DemoLoop } from "../compose.js";
import { type FoldListProgress, foldStore } from "../fold.js";
import { governanceViewFor } from "../governance.js";
import type { CliOutput } from "../output.js";
import { loadDaySummaries } from "../state.js";

const FOOTER = "All evidence above is advisory and transcript-derived: it demonstrates recurrence, not causation.";

function progressLine(progress: FoldListProgress): string {
  const waiting = progress.heartbeat ? " waiting-for-page" : "";
  return (
    `report: listing ${progress.kind} records=${progress.records} pages=${progress.pages}` +
    ` elapsed=${progress.elapsedSeconds}s${waiting}`
  );
}

export async function runReportCommand(loop: DemoLoop, out: CliOutput): Promise<number> {
  const fold = await foldStore(loop.store, (progress) => out.write(progressLine(progress)));
  out.write(
    `report: fold complete projects=${fold.projects.size} observations=${fold.observationCount}` +
      ` episodes=${fold.episodeRecordCount}`,
  );
  const { summaries, corrupt: corruptSummaries } = await loadDaySummaries(loop.store);

  out.write("TRANSCRIPT INSIGHTS REPORT");
  out.write(`generated: ${new Date().toISOString()}`);
  out.write("");

  out.write("== Ingestion health ==");
  out.write(`episode records stored: ${fold.episodeRecordCount}`);
  out.write(`observations stored: ${fold.observationCount}`);
  out.write(
    `observation completeness: complete=${fold.completeness.complete} ` +
      `partial=${fold.completeness.partial} unknown=${fold.completeness.unknown}`,
  );
  out.write(`unknown transcript records (transcript.unknown): ${fold.unknownRecordCount}`);
  if (fold.corruptRecordCount > 0) out.write(`records failing validation on read: ${fold.corruptRecordCount}`);
  if (corruptSummaries > 0) out.write(`ingest summaries failing validation on read: ${corruptSummaries}`);
  out.write("episodes by provider/project:");
  if (fold.projects.size === 0) {
    out.write("  (none ingested yet)");
  } else {
    for (const project of fold.projects.values()) {
      out.write(
        `  ${project.provider}/${project.project}  episodes=${project.episodeIds.size}` +
          `  observations=${project.observations}  partial=${project.partialObservations}` +
          `  unknown-records=${project.unknownRecords}`,
      );
    }
  }
  const diagnosticTotals = new Map<string, number>();
  for (const summary of summaries) {
    for (const [code, count] of Object.entries(summary.diagnosticCounts)) {
      diagnosticTotals.set(code, (diagnosticTotals.get(code) ?? 0) + count);
    }
  }
  out.write("ingest diagnostics by code (accumulated over recorded runs):");
  if (diagnosticTotals.size === 0) {
    out.write("  (none)");
  } else {
    for (const [code, count] of [...diagnosticTotals.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      out.write(`  ${code}: ${count}`);
    }
  }
  out.write("");

  out.write("== Friction signals ==");
  if (fold.projects.size === 0) {
    out.write("  (nothing ingested yet)");
  }
  for (const project of fold.projects.values()) {
    out.write(`[${project.provider}/${project.project}]`);
    out.write(
      `  messages: human=${project.humanMessages} agent=${project.agentMessages}` +
        `  correction-signals=${project.corrections.count}` +
        ` (across ${project.corrections.episodeIds.size} episode(s))`,
    );
    const failures = [...project.toolFailures.entries()].sort(([a], [b]) => a.localeCompare(b));
    if (failures.length === 0) {
      out.write(`  tool failures: none (${project.toolCompletions} tool completion(s) observed)`);
    } else {
      out.write(`  tool failures (of ${project.toolCompletions} tool completion(s)):`);
      for (const [toolName, cluster] of failures) {
        out.write(`    ${toolName}: ${cluster.count} across ${cluster.episodeIds.size} episode(s)`);
      }
    }
    out.write(`  task signals: aborted=${project.aborted} rolled_back=${project.rolledBack}`);
    out.write(`  usage totals: tokensIn=${project.tokensIn} tokensOut=${project.tokensOut}`);
  }
  out.write("");

  out.write("== Candidates ==");
  const learningReport = await loop.learning.report({});
  if (learningReport.candidateIds.length === 0) {
    out.write("  (none — run the distill command after ingesting)");
  }
  for (const candidateId of [...learningReport.candidateIds].sort()) {
    const viewed = await governanceViewFor(loop, candidateId);
    if (viewed === undefined) {
      out.write(`  ${candidateId}: stored candidate could not be loaded`);
      continue;
    }
    const { candidate, governance } = viewed;
    const scopeText = candidate.scope.map((segment) => `${segment.type}=${segment.id}`).join(" ");
    out.write(`  ${candidate.id}`);
    out.write(`    scope: ${scopeText}`);
    out.write(`    problem: ${candidate.problem}`);
    out.write(`    risk: ${candidate.proposedRisk}  proposed by: ${candidate.proposedBy.id}`);
    out.write(`    review: ${governance.review}`);
    out.write(`    publication: ${governance.publication} — nothing in this demo can activate a candidate`);
    out.write(`    validation: ${governance.validation}`);
  }
  out.write("");
  out.write(FOOTER);
  return 0;
}
