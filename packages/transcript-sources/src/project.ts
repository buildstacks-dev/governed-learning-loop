// Shared projection assembly. REDACTION PRECEDES PERSISTENCE: everything
// emitted here is what a host may persist, so only minimized structural
// features leave this module — never message text, tool arguments, tool
// results, instructions, or full filesystem paths (AGENTS.md "Privacy rules").
import { createHmac } from "node:crypto";
import type {
  Diagnostic,
  EvidencePage,
  JsonValue,
  ProjectedEpisode,
  ProjectedObservation,
} from "@cormidia/learning-loop";
import type { FileRef } from "./session-file.js";
import { fileDiagnostic } from "./session-file.js";

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
  /** Native records collapsed as duplicated segments (policy `recurrence.duplicateSegments: collapse`). */
  duplicateRecordCount: number;
}

export function newSessionDraft(provider: string): SessionDraft {
  return {
    provider,
    timestamps: [],
    observations: [],
    diagnostics: [],
    bandFailureCount: 0,
    duplicateRecordCount: 0,
  };
}

/** A native record whose identity was already projected from this file: it projects nothing again. */
export function addDuplicateRecord(draft: SessionDraft): void {
  draft.duplicateRecordCount += 1;
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
  return createHmac("sha256", locatorKey)
    .update("transcript-cwd-locator:v1\0", "utf8")
    .update(cwd, "utf8")
    .digest("hex");
}

function keyedSessionLocator(locatorKey: string, provider: string, nativeSessionId: string): string {
  return createHmac("sha256", locatorKey)
    .update("transcript-session-locator:v1\0", "utf8")
    .update(provider, "utf8")
    .update("\0", "utf8")
    .update(nativeSessionId, "utf8")
    .digest("hex");
}

function keyedBranchLocator(locatorKey: string, branch: string): string {
  return createHmac("sha256", locatorKey)
    .update("transcript-branch-locator:v1\0", "utf8")
    .update(branch, "utf8")
    .digest("hex");
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

// Provider-authored identifiers (native record types, tool names, version
// strings) are the only strings an adapter copies out of a transcript. An
// adversarial file can put anything there, so each is admitted only when it
// has the STRUCTURAL SHAPE of its kind; anything else projects as the fixed
// token "non_conforming". There is no truncation of arbitrary text anywhere:
// a secret cannot straddle a cut because no cut exists.
const MAX_TOKEN_LENGTH = 64;
const MAX_TOKEN_RUN_LENGTH = 24;
const DIGIT_RUN = /\d{4,}/;
const NATIVE_TYPE_PATTERN = /^[a-z][a-z0-9]*(?:[_-][a-z0-9]+)*$/;
const TOOL_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_.:-]*$/;
const VERSION_CORE_PATTERN = /^\d{1,4}(?:\.\d{1,4}){0,3}/;

export const NON_CONFORMING_TOKEN = "non_conforming";

function longestRun(value: string): number {
  let longest = 0;
  for (const run of value.split(/[_.:/-]+/)) longest = Math.max(longest, run.length);
  return longest;
}

/** Native record type names: lowercase snake/kebab tokens, e.g. `queue-operation`, `task_started`. */
export function structuralTypeToken(value: string): string {
  if (
    value.length > MAX_TOKEN_LENGTH ||
    !NATIVE_TYPE_PATTERN.test(value) ||
    longestRun(value) > MAX_TOKEN_RUN_LENGTH ||
    DIGIT_RUN.test(value)
  ) {
    return NON_CONFORMING_TOKEN;
  }
  return value;
}

/** Tool names: identifier-shaped tokens such as `Bash`, `apply_patch`, `mcp__server__tool`. */
export function structuralToolNameToken(value: string): string {
  if (
    value.length > MAX_TOKEN_LENGTH ||
    !TOOL_NAME_PATTERN.test(value) ||
    longestRun(value) > MAX_TOKEN_RUN_LENGTH ||
    DIGIT_RUN.test(value)
  ) {
    return NON_CONFORMING_TOKEN;
  }
  return value;
}

/** Provider versions project only their numeric core (`2.1.900-beta.1` → `2.1.900`); anything else is non-conforming. */
export function providerVersionBand(value: string | undefined): string {
  if (value === undefined) return "unknown";
  const core = VERSION_CORE_PATTERN.exec(value);
  return core === null ? NON_CONFORMING_TOKEN : core[0];
}

export function assemblePage(input: {
  readonly draft: SessionDraft;
  readonly ref: FileRef;
  readonly sourceRef: string;
  readonly pageRef: string;
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
  if (draft.duplicateRecordCount > 0) {
    // Not incompleteness: the segments were present and collapsed. Visible so
    // a claim over this page can state that duplicates were folded.
    diagnostics.push(
      fileDiagnostic(
        "source.duplicate_segment",
        "info",
        ref,
        `${draft.duplicateRecordCount} duplicated native record(s) collapsed; duplicates never become independent recurrence`,
        undefined,
        { duplicateRecordCount: draft.duplicateRecordCount },
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
    return {
      sourceRef: input.sourceRef,
      pageRef: input.pageRef,
      state: { status: "unsupported", observedRevision: input.sourceRevision },
      observations: [],
      measurements: [],
      episodes: [],
      diagnostics,
    };
  }

  const nativeSessionId = draft.nativeSessionId;
  let sessionLocator: string;
  if (nativeSessionId === undefined) {
    sessionLocator = `unidentified-${input.sourceRevision.slice(0, 16)}`;
    diagnostics.push(
      fileDiagnostic(
        "source.incomplete",
        "warning",
        ref,
        "no native session id found; episode uses a digest-derived identifier",
      ),
    );
  } else {
    sessionLocator = keyedSessionLocator(input.locatorKey, draft.provider, nativeSessionId);
  }
  const episodeId = `${draft.provider}/${sessionLocator}`;
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
    return `${draft.provider}/${sessionLocator}/${line}#${occurrence}`;
  };

  let openedAt = draft.timestamps[0] ?? "";
  let closedAt = openedAt;
  for (const timestamp of draft.timestamps) {
    if (Date.parse(timestamp) < Date.parse(openedAt)) openedAt = timestamp;
    if (Date.parse(timestamp) > Date.parse(closedAt)) closedAt = timestamp;
  }

  const cwdLocator =
    draft.cwd === undefined ? `unresolved-${input.sourceRef}` : keyedCwdLocator(input.locatorKey, draft.cwd);
  const branchLocator =
    draft.gitBranch === undefined ? undefined : keyedBranchLocator(input.locatorKey, draft.gitBranch);
  const degraded = input.degraded || draft.bandFailureCount > 0;
  const completeness: ProjectedObservation["completeness"] = degraded ? "partial" : "complete";

  const metaData: JsonValue = {
    provider: draft.provider,
    adapterVersion: input.adapterVersion,
    providerVersionBand: providerVersionBand(draft.providerVersion),
    cwdLocator,
    ...(branchLocator === undefined ? {} : { branchLocator }),
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
    completeness,
    scope: [
      { type: "provider", id: draft.provider },
      { type: "project", id: cwdLocator },
    ],
    openedAt,
    closedAt,
    status: "unknown",
    measurementSourceRecordIds: [],
  };

  return {
    sourceRef: input.sourceRef,
    pageRef: input.pageRef,
    state: { status: "available", sourceRevision: input.sourceRevision, completeness },
    observations,
    measurements: [],
    episodes: [episode],
    diagnostics,
  };
}
