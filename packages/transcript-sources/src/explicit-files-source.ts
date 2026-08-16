// Generic explicit-files EvidenceSource: one EvidencePage per session file,
// sourceRevision = sha256 of the file bytes (import idempotency), cursor =
// index into the caller's ordered path list (resumability). Refused files
// still yield a diagnostics-only page so the cursor stays index-aligned.
import type { EvidencePage, EvidenceSource } from "@cormidia/learning-loop";
import type { TranscriptFilesInput } from "./input.js";
import { parseTranscriptFilesInput, startIndexFromCursor } from "./input.js";
import { probeExplicitFiles } from "./probe.js";
import type { SessionDraft } from "./project.js";
import { UNAVAILABLE_SOURCE_REVISION, assemblePage, newSessionDraft } from "./project.js";
import type { FileRef, ParsedLine } from "./session-file.js";
import { readSessionFile, refOf } from "./session-file.js";

export interface TranscriptProviderSpec {
  /** Scope/id prefix, e.g. "claude-code". */
  readonly provider: string;
  /** SourceDescriptor.id. */
  readonly sourceId: string;
  /** SourceDescriptor.adapterVersion, encoding the accepted version band. */
  readonly adapterVersion: string;
  /** Probe band over the first content line; returns an error message or undefined. */
  readonly firstLineBand: (record: Record<string, unknown>) => string | undefined;
  /** Maps parsed records into minimized observation drafts on the session draft. */
  readonly mapRecords: (draft: SessionDraft, lines: readonly ParsedLine[], ref: FileRef) => void;
}

export function createExplicitFilesSource(spec: TranscriptProviderSpec): EvidenceSource<TranscriptFilesInput> {
  return {
    descriptor: { id: spec.sourceId, adapterVersion: spec.adapterVersion },
    probe: (input) => probeExplicitFiles(input, spec.firstLineBand),
    read: (input, cursor) => readPages(spec, input, cursor),
  };
}

async function* readPages(
  spec: TranscriptProviderSpec,
  input: TranscriptFilesInput,
  cursor: string | undefined,
): AsyncGenerator<EvidencePage, void, undefined> {
  const parsed = parseTranscriptFilesInput(input);
  const start = startIndexFromCursor(cursor, parsed.paths.length);
  for (let index = start; index < parsed.paths.length; index += 1) {
    const path = parsed.paths[index];
    if (path === undefined) continue;
    const page = await projectFile(spec, path, index, parsed.locatorKey);
    yield index === parsed.paths.length - 1 ? page : { ...page, nextCursor: String(index + 1) };
  }
}

async function projectFile(
  spec: TranscriptProviderSpec,
  path: string,
  index: number,
  locatorKey: string,
): Promise<EvidencePage> {
  const ref = refOf(path, index);
  const file = await readSessionFile(path, ref);
  if (file.status === "refused") {
    return {
      sourceRevision: file.sourceRevision ?? UNAVAILABLE_SOURCE_REVISION,
      observations: [],
      measurements: [],
      episodes: [],
      diagnostics: file.diagnostics,
    };
  }
  const draft = newSessionDraft(spec.provider);
  spec.mapRecords(draft, file.lines, ref);
  return assemblePage({
    draft,
    ref,
    sourceRevision: file.sourceRevision,
    adapterVersion: spec.adapterVersion,
    locatorKey,
    degraded: file.skippedLineCount > 0,
    fileDiagnostics: file.diagnostics,
  });
}
