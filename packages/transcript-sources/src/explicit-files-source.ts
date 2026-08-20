// Generic explicit-files EvidenceSource: one EvidencePage per session file.
// Each page carries a tenant-keyed sourceRef, a stable pageRef, and typed
// source state. Private source revisions are tenant-keyed HMACs of the
// transient content digest; refused files never receive a fake revision. The cursor remains an index
// into the caller's ordered path list (resumability), and refused files still
// yield a diagnostics-only page so the cursor stays index-aligned.
import { createHmac } from "node:crypto";
import type { EvidencePage, EvidenceSource } from "@cormidia/learning-loop";
import type { TranscriptFilesInput } from "./input.js";
import { parseTranscriptFilesInput, startIndexFromCursor } from "./input.js";
import { probeExplicitFiles } from "./probe.js";
import type { SessionDraft } from "./project.js";
import { assemblePage, newSessionDraft } from "./project.js";
import type { FileRef, ParsedLine, SessionFileResult } from "./session-file.js";
import { readSessionFile, refOf } from "./session-file.js";

const SESSION_PAGE_REF = "session";
const SOURCE_REF_DOMAIN = "transcript-source-ref:v1\0";
const SOURCE_REVISION_DOMAIN = "transcript-source-revision:v1\0";

function sourceRefFor(locatorKey: string, path: string): string {
  return createHmac("sha256", locatorKey).update(SOURCE_REF_DOMAIN, "utf8").update(path, "utf8").digest("hex");
}

function sourceRevisionFor(locatorKey: string, rawContentDigest: string): string {
  return createHmac("sha256", locatorKey)
    .update(SOURCE_REVISION_DOMAIN, "utf8")
    .update(rawContentDigest, "utf8")
    .digest("hex");
}

function refusedState(
  file: Extract<SessionFileResult, { readonly status: "refused" }>,
  observedRevision: string | undefined,
): EvidencePage["state"] {
  return {
    status: file.refusalState,
    ...(observedRevision === undefined ? {} : { observedRevision }),
  };
}

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
  const maximumTrust: "advisory" = "advisory";
  const descriptor = Object.freeze({
    id: spec.sourceId,
    adapterVersion: spec.adapterVersion,
    maximumTrust,
  });
  const source: EvidenceSource<TranscriptFilesInput> = {
    descriptor,
    probe: (input) => probeExplicitFiles(input, spec.firstLineBand),
    read: (input, cursor) => readPages(spec, input, cursor),
  };
  return Object.freeze(source);
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
  const ref = refOf(index);
  const file = await readSessionFile(path, ref);
  const sourceRef = sourceRefFor(locatorKey, path);
  const privateRevision =
    file.sourceRevision === undefined ? undefined : sourceRevisionFor(locatorKey, file.sourceRevision);
  if (file.status === "refused") {
    return {
      sourceRef,
      pageRef: SESSION_PAGE_REF,
      state: refusedState(file, privateRevision),
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
    sourceRef,
    pageRef: SESSION_PAGE_REF,
    sourceRevision: sourceRevisionFor(locatorKey, file.sourceRevision),
    adapterVersion: spec.adapterVersion,
    locatorKey,
    degraded: file.skippedLineCount > 0,
    fileDiagnostics: file.diagnostics,
  });
}
