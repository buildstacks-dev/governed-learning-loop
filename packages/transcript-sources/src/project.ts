// Shared projection assembly. REDACTION PRECEDES PERSISTENCE: everything
// emitted here is what a host may persist, so only minimized structural
// features leave this module — never message text, tool arguments, tool
// results, instructions, or full filesystem paths (AGENTS.md "Privacy rules").
import { createHash } from "node:crypto";
import type {
  Diagnostic,
  EvidencePage,
  JsonValue,
  ProjectedEpisode,
  ProjectedObservation,
} from "@cormidia/learning-loop";
import type { FileRef } from "./session-file.js";
import { fileDiagnostic } from "./session-file.js";

/** Page revision for files that were refused before any byte could be read. */
export const UNAVAILABLE_SOURCE_REVISION = "unavailable";

export interface ObservationDraft {
  readonly lineNumber: number;
  readonly kind: string;
  readonly data: JsonValue;
  readonly occurredAt?: string;
}

export interface SessionDraft {
  readonly provider: string;
  nativeSessionId?: string | undefined;
  providerVersion?: string | undefined;
  cwd?: string | undefined;
  gitBranch?: string | undefined;
  firstRecordLine?: number | undefined;
  readonly timestamps: string[];
  readonly observations: ObservationDraft[];
  readonly diagnostics: Diagnostic[];
  bandFailureCount: number;
}

export function newSessionDraft(provider: string): SessionDraft {
  return { provider, timestamps: [], observations: [], diagnostics: [], bandFailureCount: 0 };
}

export function addObservation(
  draft: SessionDraft,
  lineNumber: number,
  kind: string,
  data: JsonValue,
  occurredAt?: string,
): void {
  draft.observations.push({ lineNumber, kind, data, ...(occurredAt === undefined ? {} : { occurredAt }) });
}

const MAX_BAND_FAILURE_DIAGNOSTICS = 20;

/** A record that is valid JSON but fails the provider's accepted shape band. */
export function addBandFailure(draft: SessionDraft, ref: FileRef, lineNumber: number, message: string): void {
  draft.bandFailureCount += 1;
  if (draft.bandFailureCount <= MAX_BAND_FAILURE_DIAGNOSTICS) {
    draft.diagnostics.push(fileDiagnostic("source.unsupported_format", "warning", ref, message, lineNumber));
  }
}

/**
 * Keyed locator per the contract's dictionary-recovery rule: private source
 * correlation uses a caller-keyed digest, so the raw cwd never enters a
 * digest an attacker could recover by hashing candidate paths.
 */
export function keyedCwdLocator(locatorKey: string, cwd: string): string {
  return createHash("sha256").update(`${locatorKey}:${cwd}`, "utf8").digest("hex");
}

/** Basename of the cwd only — the rest of the path never leaves the adapter. */
export function projectSlug(cwd: string | undefined): string {
  if (cwd === undefined) return "unknown";
  const segments = cwd.split(/[\\/]+/).filter((segment) => segment.length > 0);
  const last = segments.at(-1);
  if (last === undefined || last.length === 0) return "unknown";
  return last.slice(0, 100);
}

// Transient correction heuristics over human text: the text is dropped, only
// the boolean survives (never persisted, never logged).
const CORRECTION_PATTERNS: readonly RegExp[] = [
  /\bno[,.\s!?]/i,
  /\bnot what\b/i,
  /\bwrong\b/i,
  /\binstead\b/i,
  /\bdon['’]t\b/i,
  /\bstop\b/i,
  /\brevert\b/i,
  /\bactually\b/i,
];

export function hasCorrectionSignal(text: string): boolean {
  return CORRECTION_PATTERNS.some((pattern) => pattern.test(text));
}

/** Accepts ISO-8601-shaped strings with a finite parse; anything else is dropped. */
export function validTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (!/^\d{4}-\d{2}-\d{2}T/.test(value)) return undefined;
  return Number.isFinite(Date.parse(value)) ? value : undefined;
}

const MAX_NATIVE_TYPE_LENGTH = 64;

export function truncateType(value: string): string {
  return value.length > MAX_NATIVE_TYPE_LENGTH ? value.slice(0, MAX_NATIVE_TYPE_LENGTH) : value;
}

export function assemblePage(input: {
  readonly draft: SessionDraft;
  readonly ref: FileRef;
  readonly sourceRevision: string;
  readonly adapterVersion: string;
  readonly locatorKey: string;
  readonly degraded: boolean;
  readonly fileDiagnostics: readonly Diagnostic[];
}): EvidencePage {
  const { draft, ref } = input;
  const diagnostics: Diagnostic[] = [...input.fileDiagnostics, ...draft.diagnostics];
  if (draft.bandFailureCount > 0) {
    diagnostics.push(
      fileDiagnostic(
        "source.incomplete",
        "warning",
        ref,
        `${draft.bandFailureCount} record(s) failed the accepted shape band`,
        undefined,
        { bandFailureCount: draft.bandFailureCount },
      ),
    );
  }
  if (draft.timestamps.length === 0) {
    diagnostics.push(
      fileDiagnostic(
        "source.unsupported_format",
        "error",
        ref,
        "no record carries a parseable timestamp; cannot establish episode boundaries; file refused (completeness unknown)",
      ),
    );
    return { sourceRevision: input.sourceRevision, observations: [], measurements: [], episodes: [], diagnostics };
  }

  let nativeSessionId = draft.nativeSessionId;
  if (nativeSessionId === undefined) {
    nativeSessionId = `unidentified-${input.sourceRevision.slice(0, 16)}`;
    diagnostics.push(
      fileDiagnostic(
        "source.incomplete",
        "warning",
        ref,
        "no native session id found; episode uses a digest-derived identifier",
      ),
    );
  }
  const episodeId = `${draft.provider}/${nativeSessionId}`;
  // One source line can yield several projections (e.g. a Claude Code
  // assistant record projects both a message and a usage observation), so a
  // bare line number is not a unique sourceRecordId — colliding ids made the
  // engine drop every later same-line observation as a store conflict. Each
  // line therefore carries a deterministic occurrence suffix: emission order
  // is fixed (session.meta first, then draft order), so ids are stable across
  // re-reads of the same source revision.
  const lineOccurrences = new Map<number, number>();
  const recordId = (line: number): string => {
    const occurrence = lineOccurrences.get(line) ?? 0;
    lineOccurrences.set(line, occurrence + 1);
    return `${draft.provider}/${nativeSessionId}/${line}#${occurrence}`;
  };

  let openedAt = draft.timestamps[0] ?? "";
  let closedAt = openedAt;
  for (const timestamp of draft.timestamps) {
    if (Date.parse(timestamp) < Date.parse(openedAt)) openedAt = timestamp;
    if (Date.parse(timestamp) > Date.parse(closedAt)) closedAt = timestamp;
  }

  const slug = projectSlug(draft.cwd);
  const degraded = input.degraded || draft.bandFailureCount > 0;
  const completeness: ProjectedObservation["completeness"] = degraded ? "partial" : "complete";

  const metaData: JsonValue = {
    provider: draft.provider,
    adapterVersion: input.adapterVersion,
    providerVersionBand: draft.providerVersion ?? "unknown",
    projectSlug: slug,
    ...(draft.cwd === undefined ? {} : { cwdLocator: keyedCwdLocator(input.locatorKey, draft.cwd) }),
    ...(draft.gitBranch === undefined ? {} : { gitBranch: draft.gitBranch }),
  };
  const observations: ProjectedObservation[] = [
    {
      sourceRecordId: recordId(draft.firstRecordLine ?? 1),
      episodeId,
      occurredAt: openedAt,
      kind: "transcript.session.meta",
      data: metaData,
      completeness,
    },
    ...draft.observations.map(
      (observation): ProjectedObservation => ({
        sourceRecordId: recordId(observation.lineNumber),
        episodeId,
        ...(observation.occurredAt === undefined ? {} : { occurredAt: observation.occurredAt }),
        kind: observation.kind,
        data: observation.data,
        completeness,
      }),
    ),
  ];

  // A transcript may not claim outcomes: status is ALWAYS "unknown"; task
  // lifecycle events surface as transcript.task.signal observations instead.
  const episode: ProjectedEpisode = {
    sourceRecordId: recordId(0),
    episodeId,
    scope: [
      { type: "provider", id: draft.provider },
      { type: "project", id: slug },
    ],
    openedAt,
    closedAt,
    status: "unknown",
    measurementSourceRecordIds: [],
  };

  return { sourceRevision: input.sourceRevision, observations, measurements: [], episodes: [episode], diagnostics };
}
