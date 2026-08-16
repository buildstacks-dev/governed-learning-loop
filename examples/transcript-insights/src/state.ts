// Demo-owned durable state: the locator key and per-day ingest summaries.
//
// The summaries live in the SAME LearningStore as the kernel's records but in
// the demo's own "demo" namespace (namespace isolation is a store guarantee).
// They hold aggregate counts and diagnostic CODES only — never diagnostic
// message bodies, transcript content, project names, or paths.
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { LearningStore, RecordKey, StoredRecord } from "@cormidia/learning-loop";
import { sha256HexOfCanonicalJson, toJsonValue } from "@cormidia/learning-loop";
import { isUnknownRecord } from "./json.js";

export const DEMO_NAMESPACE = "demo";
const SUMMARY_KIND = "ingest-day";

export async function ensureStateDir(stateDir: string): Promise<void> {
  await mkdir(stateDir, { recursive: true });
}

function hasErrnoCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

/**
 * The locator key salts the adapters' keyed cwd locator so filesystem paths
 * never enter a dictionary-recoverable digest. Minted once (32 random bytes,
 * hex, mode 0600) and reused so re-ingest stays idempotent: a new key would
 * change every session-meta digest and turn re-ingest into conflicts.
 */
export async function ensureLocatorKey(stateDir: string): Promise<string> {
  const path = join(stateDir, "locator.key");
  try {
    const text = (await readFile(path, "utf8")).trim();
    if (!/^[0-9a-f]{64}$/.test(text)) {
      throw new Error(`${path} exists but is not a 64-hex-character locator key; move it aside to mint a new one`);
    }
    return text;
  } catch (error) {
    if (!hasErrnoCode(error, "ENOENT")) throw error;
  }
  const key = randomBytes(32).toString("hex");
  await writeFile(path, `${key}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  return key;
}

export interface DayIngestSummary {
  readonly schemaVersion: 1;
  readonly provider: string;
  readonly day: string;
  readonly files: number;
  readonly newObservations: number;
  readonly newEpisodes: number;
  readonly alreadyKnown: number;
  readonly completeness: string;
  /** Diagnostic counts by code — codes only, never message bodies. */
  readonly diagnosticCounts: { readonly [code: string]: number };
  readonly recordedAt: string;
}

function summaryKey(provider: string, day: string): RecordKey {
  return { namespace: DEMO_NAMESPACE, kind: SUMMARY_KIND, id: `${provider}/${day}` };
}

export async function recordDaySummary(store: LearningStore, summary: DayIngestSummary): Promise<void> {
  const key = summaryKey(summary.provider, summary.day);
  const value = toJsonValue(summary);
  const digest = sha256HexOfCanonicalJson(value);
  const operationId = `demo/ingest-day/${summary.provider}/${summary.day}/${summary.recordedAt}`;
  const existing = await store.get(key);
  if (existing === undefined) {
    await store.create(key, value, digest, operationId);
    return;
  }
  await store.compareAndSet(key, existing.revision, value, digest, operationId);
}

function nonNegativeInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function parseSummary(value: unknown): DayIngestSummary | undefined {
  if (!isUnknownRecord(value)) return undefined;
  if (value.schemaVersion !== 1) return undefined;
  const provider = value.provider;
  const day = value.day;
  const completeness = value.completeness;
  const recordedAt = value.recordedAt;
  const files = nonNegativeInt(value.files);
  const newObservations = nonNegativeInt(value.newObservations);
  const newEpisodes = nonNegativeInt(value.newEpisodes);
  const alreadyKnown = nonNegativeInt(value.alreadyKnown);
  if (typeof provider !== "string" || typeof day !== "string") return undefined;
  if (typeof completeness !== "string" || typeof recordedAt !== "string") return undefined;
  if (files === undefined || newObservations === undefined) return undefined;
  if (newEpisodes === undefined || alreadyKnown === undefined) return undefined;
  if (!isUnknownRecord(value.diagnosticCounts)) return undefined;
  const diagnosticCounts: { [code: string]: number } = {};
  for (const [code, count] of Object.entries(value.diagnosticCounts)) {
    const parsed = nonNegativeInt(count);
    if (parsed === undefined) return undefined;
    diagnosticCounts[code] = parsed;
  }
  return {
    schemaVersion: 1,
    provider,
    day,
    files,
    newObservations,
    newEpisodes,
    alreadyKnown,
    completeness,
    diagnosticCounts,
    recordedAt,
  };
}

export interface DaySummaries {
  readonly summaries: readonly DayIngestSummary[];
  readonly corrupt: number;
}

export async function loadDaySummaries(store: LearningStore): Promise<DaySummaries> {
  const records: StoredRecord[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await store.list({
      namespace: DEMO_NAMESPACE,
      kind: SUMMARY_KIND,
      ...(cursor !== undefined ? { cursor } : {}),
      limit: 200,
    });
    records.push(...page.records);
    if (page.nextCursor === undefined) break;
    cursor = page.nextCursor;
  }
  const summaries: DayIngestSummary[] = [];
  let corrupt = 0;
  for (const record of records) {
    const summary = parseSummary(record.value);
    if (summary === undefined) corrupt += 1;
    else summaries.push(summary);
  }
  summaries.sort((left, right) => `${left.provider}/${left.day}`.localeCompare(`${right.provider}/${right.day}`));
  return { summaries, corrupt };
}
