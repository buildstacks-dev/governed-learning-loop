// `ingest` (one day) and `backfill` (a day range through the same path).
//
// Output policy: receipt diagnostics are printed as aggregate COUNTS BY CODE
// only. The adapters already guarantee diagnostics carry no transcript
// content, but this CLI keeps the aggregate posture anyway so its output can
// be shared without thought.
import type { IngestReceipt } from "@cormidia/learning-loop";
import type { DemoLoop } from "../compose.js";
import type { Provider } from "../discovery.js";
import { dayRange, discoverSessionFiles } from "../discovery.js";
import { jsonNumber, jsonObject } from "../json.js";
import type { DayIngestSummary } from "../state.js";
import { recordDaySummary } from "../state.js";
import type { CliOutput } from "../output.js";

export interface DayResult {
  readonly provider: Provider;
  readonly day: string;
  readonly files: number;
  readonly newObservations: number;
  readonly newEpisodes: number;
  readonly alreadyKnown: number;
  readonly completeness: string;
  readonly errorDiagnostics: number;
  /** Sorted [code, count] pairs — codes only, never message bodies. */
  readonly diagnosticCounts: readonly (readonly [string, number])[];
}

function alreadyKnownCount(receipt: IngestReceipt): number {
  for (const diagnostic of receipt.diagnostics) {
    if (diagnostic.code !== "ingest.duplicate") continue;
    const count = jsonNumber(jsonObject(diagnostic.details)?.count);
    if (count !== undefined) return count;
  }
  return 0;
}

function diagnosticCountsByCode(receipt: IngestReceipt): readonly (readonly [string, number])[] {
  const counts = new Map<string, number>();
  for (const diagnostic of receipt.diagnostics) {
    if (diagnostic.code === "ingest.duplicate") continue; // reported as already-known
    counts.set(diagnostic.code, (counts.get(diagnostic.code) ?? 0) + 1);
  }
  return [...counts.entries()].sort(([left], [right]) => left.localeCompare(right));
}

export async function ingestDay(loop: DemoLoop, provider: Provider, root: string, day: string): Promise<DayResult> {
  // Host discovery decision: THIS demo enumerates candidate files under the
  // explicitly user-supplied --root and hands the adapter an explicit list.
  // The adapters never crawl.
  const paths = await discoverSessionFiles(provider, root, day);
  let result: DayResult;
  if (paths.length === 0) {
    result = {
      provider,
      day,
      files: 0,
      newObservations: 0,
      newEpisodes: 0,
      alreadyKnown: 0,
      completeness: "complete",
      errorDiagnostics: 0,
      diagnosticCounts: [],
    };
  } else {
    const receipt = await loop.learning.ingest(loop.sources[provider], {
      kind: "explicit_files",
      paths,
      locatorKey: loop.locatorKey,
    });
    result = {
      provider,
      day,
      files: paths.length,
      newObservations: receipt.observationIds.length,
      newEpisodes: receipt.episodeIds.length,
      alreadyKnown: alreadyKnownCount(receipt),
      completeness: receipt.completeness,
      errorDiagnostics: receipt.diagnostics.filter((diagnostic) => diagnostic.severity === "error").length,
      diagnosticCounts: diagnosticCountsByCode(receipt),
    };
  }
  const diagnosticCounts: { [code: string]: number } = {};
  for (const [code, count] of result.diagnosticCounts) diagnosticCounts[code] = count;
  const summary: DayIngestSummary = {
    schemaVersion: 1,
    provider,
    day,
    files: result.files,
    newObservations: result.newObservations,
    newEpisodes: result.newEpisodes,
    alreadyKnown: result.alreadyKnown,
    completeness: result.completeness,
    diagnosticCounts,
    recordedAt: new Date().toISOString(),
  };
  await recordDaySummary(loop.store, summary);
  return result;
}

export async function runIngestCommand(
  loop: DemoLoop,
  provider: Provider,
  root: string,
  day: string,
  out: CliOutput,
): Promise<number> {
  const result = await ingestDay(loop, provider, root, day);
  out.write(`ingest ${provider} ${day}`);
  out.write(`  files considered: ${result.files}`);
  if (result.files === 0) {
    out.write("  no session files found for that day under the given root");
    return 0;
  }
  out.write(`  observations: ${result.newObservations} new`);
  out.write(`  episodes: ${result.newEpisodes} new`);
  out.write(`  already-known records (idempotent re-ingest): ${result.alreadyKnown}`);
  out.write(`  completeness: ${result.completeness}`);
  if (result.diagnosticCounts.length === 0) {
    out.write("  diagnostics by code: (none)");
  } else {
    out.write("  diagnostics by code:");
    for (const [code, count] of result.diagnosticCounts) out.write(`    ${code}: ${count}`);
  }
  return 0;
}

function dayLine(result: DayResult): string {
  const diagnostics =
    result.diagnosticCounts.length === 0
      ? ""
      : `  diags[${result.diagnosticCounts.map(([code, count]) => `${code}=${count}`).join(" ")}]`;
  return (
    `${result.day}  files=${result.files}  new-obs=${result.newObservations}` +
    `  new-episodes=${result.newEpisodes}  known=${result.alreadyKnown}` +
    `  completeness=${result.completeness}${diagnostics}`
  );
}

export async function runBackfillCommand(
  loop: DemoLoop,
  provider: Provider,
  root: string,
  from: string,
  to: string,
  out: CliOutput,
): Promise<number> {
  const days = dayRange(from, to);
  out.write(`backfill ${provider} ${from}..${to} (${days.length} day(s))`);
  let ok = 0;
  let failed = 0;
  for (const day of days) {
    try {
      const result = await ingestDay(loop, provider, root, day);
      out.write(dayLine(result));
      ok += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown failure";
      out.write(`${day}  FAILED: ${message}`);
      failed += 1;
    }
  }
  out.write(`backfill done: ${ok} day(s) ingested, ${failed} day(s) failed`);
  if (failed > 0) out.write("re-run the same backfill after fixing the failures; ingestion is idempotent");
  return failed > 0 ? 1 : 0;
}
