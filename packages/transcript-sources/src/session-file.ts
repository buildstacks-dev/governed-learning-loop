// JSONL session-file reading with fail-closed ceilings (./limits.ts).
// lstat first, then open with O_NOFOLLOW: symlinks and non-regular files are
// refused — the caller enumerates real files explicitly; this module never
// follows links. Diagnostics reference files by input index and basename only
// (never full paths) and NEVER echo line content or JSON.parse error text
// (V8 parse errors quote input bytes).
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { lstat, open } from "node:fs/promises";
import type { Diagnostic, JsonValue } from "@cormidia/learning-loop";
import { MAX_FILE_BYTES, MAX_LINE_BYTES, MAX_RECORDS_PER_FILE } from "./limits.js";
import { isRecord } from "./narrow.js";

export interface FileRef {
  readonly index: number;
}

export function refOf(index: number): FileRef {
  return { index };
}

export function fileDiagnostic(
  code: string,
  severity: Diagnostic["severity"],
  ref: FileRef,
  message: string,
  line?: number,
  extraDetails?: { readonly [key: string]: JsonValue },
): Diagnostic {
  return {
    code,
    severity,
    message: `file[${ref.index}]: ${message}`,
    path: line === undefined ? [ref.index] : [ref.index, line],
    details: {
      fileIndex: ref.index,
      ...(line === undefined ? {} : { line }),
      ...extraDetails,
    },
  };
}

export interface ParsedLine {
  readonly lineNumber: number;
  readonly record: Record<string, unknown>;
}

export type SessionFileRefusalState = "missing" | "unreadable" | "unsupported" | "corrupt";

export type SessionFileResult =
  | {
      readonly status: "refused";
      readonly refusalState: SessionFileRefusalState;
      readonly sourceRevision?: string;
      readonly diagnostics: readonly Diagnostic[];
    }
  | {
      readonly status: "parsed";
      readonly sourceRevision: string;
      readonly lines: readonly ParsedLine[];
      readonly diagnostics: readonly Diagnostic[];
      readonly skippedLineCount: number;
    };

const MAX_PER_LINE_DIAGNOSTICS = 20;

type RegularFile =
  | { readonly ok: true; readonly handle: FileHandle; readonly size: number }
  | { readonly ok: false; readonly refusalState: SessionFileRefusalState; readonly diagnostic: Diagnostic };

function systemErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code: unknown = Reflect.get(error, "code");
  return typeof code === "string" ? code : undefined;
}

async function openRegularFile(path: string, ref: FileRef): Promise<RegularFile> {
  let size: number;
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink()) {
      return {
        ok: false,
        refusalState: "unreadable",
        diagnostic: fileDiagnostic(
          "source.input_refused",
          "error",
          ref,
          "symbolic links are refused; pass the resolved regular file explicitly",
        ),
      };
    }
    if (!stats.isFile()) {
      return {
        ok: false,
        refusalState: "unreadable",
        diagnostic: fileDiagnostic("source.input_refused", "error", ref, "not a regular file"),
      };
    }
    size = stats.size;
  } catch (error) {
    return {
      ok: false,
      refusalState: systemErrorCode(error) === "ENOENT" ? "missing" : "unreadable",
      diagnostic: fileDiagnostic("source.input_refused", "error", ref, "path does not exist or is not readable"),
    };
  }
  if (size > MAX_FILE_BYTES) {
    return {
      ok: false,
      refusalState: "unsupported",
      diagnostic: fileDiagnostic(
        "source.limit_exceeded",
        "error",
        ref,
        `file exceeds the ${MAX_FILE_BYTES}-byte per-file ceiling and was skipped`,
      ),
    };
  }
  try {
    // O_NOFOLLOW backstops the lstat check against a link swapped in between.
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    return { ok: true, handle, size };
  } catch {
    return {
      ok: false,
      refusalState: "unreadable",
      diagnostic: fileDiagnostic(
        "source.input_refused",
        "error",
        ref,
        "file could not be opened without following links",
      ),
    };
  }
}

export async function readSessionFile(path: string, ref: FileRef): Promise<SessionFileResult> {
  const opened = await openRegularFile(path, ref);
  if (!opened.ok) {
    return { status: "refused", refusalState: opened.refusalState, diagnostics: [opened.diagnostic] };
  }
  let bytes: Buffer;
  try {
    bytes = await opened.handle.readFile();
  } catch {
    return {
      status: "refused",
      refusalState: "unreadable",
      diagnostics: [fileDiagnostic("source.input_refused", "error", ref, "file could not be read")],
    };
  } finally {
    await opened.handle.close();
  }
  const sourceRevision = createHash("sha256").update(bytes).digest("hex");
  if (bytes.byteLength > MAX_FILE_BYTES) {
    return {
      status: "refused",
      refusalState: "unsupported",
      sourceRevision,
      diagnostics: [
        fileDiagnostic(
          "source.limit_exceeded",
          "error",
          ref,
          `file exceeds the ${MAX_FILE_BYTES}-byte per-file ceiling and was skipped`,
        ),
      ],
    };
  }
  const rawLines = bytes.toString("utf8").split("\n");
  const lines: ParsedLine[] = [];
  const diagnostics: Diagnostic[] = [];
  let skipped = 0;
  let perLineDiagnostics = 0;
  let accepted = false;

  const refuseFirstLine = (code: string, lineNumber: number, message: string): SessionFileResult => ({
    status: "refused",
    refusalState: code === "source.unsupported_format" ? "unsupported" : "corrupt",
    sourceRevision,
    diagnostics: [fileDiagnostic(code, "error", ref, message, lineNumber)],
  });
  const skipLine = (code: string, lineNumber: number, message: string): void => {
    skipped += 1;
    if (perLineDiagnostics < MAX_PER_LINE_DIAGNOSTICS) {
      perLineDiagnostics += 1;
      diagnostics.push(fileDiagnostic(code, "warning", ref, message, lineNumber));
    }
  };

  for (let i = 0; i < rawLines.length; i += 1) {
    const raw = rawLines[i];
    if (raw === undefined) continue;
    const lineNumber = i + 1;
    const text = raw.trim();
    if (text.length === 0) continue;
    if (lines.length >= MAX_RECORDS_PER_FILE) {
      let remaining = 0;
      for (let j = i; j < rawLines.length; j += 1) {
        const rest = rawLines[j];
        if (rest !== undefined && rest.trim().length > 0) remaining += 1;
      }
      skipped += remaining;
      diagnostics.push(
        fileDiagnostic(
          "source.limit_exceeded",
          "warning",
          ref,
          `record ceiling of ${MAX_RECORDS_PER_FILE} records reached at line ${lineNumber}; ${remaining} remaining line(s) skipped`,
          lineNumber,
          { remainingLines: remaining },
        ),
      );
      break;
    }
    if (Buffer.byteLength(raw, "utf8") > MAX_LINE_BYTES) {
      if (!accepted) {
        return refuseFirstLine(
          "source.limit_exceeded",
          lineNumber,
          `first content line (line ${lineNumber}) exceeds the ${MAX_LINE_BYTES}-byte line ceiling; file refused (completeness unknown)`,
        );
      }
      skipLine(
        "source.limit_exceeded",
        lineNumber,
        `line exceeds the ${MAX_LINE_BYTES}-byte line ceiling and was skipped`,
      );
      continue;
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      // Deliberately no parse-error detail: V8 JSON errors quote input bytes.
      if (!accepted) {
        return refuseFirstLine(
          "source.unsupported_format",
          lineNumber,
          `first content line (line ${lineNumber}) is not valid JSON; file refused (completeness unknown)`,
        );
      }
      skipLine("source.unsupported_format", lineNumber, "line is not valid JSON and was skipped");
      continue;
    }
    if (!isRecord(value)) {
      if (!accepted) {
        return refuseFirstLine(
          "source.unsupported_format",
          lineNumber,
          `first content line (line ${lineNumber}) is not a JSON object; file refused (completeness unknown)`,
        );
      }
      skipLine("source.unsupported_format", lineNumber, "line is not a JSON object and was skipped");
      continue;
    }
    accepted = true;
    lines.push({ lineNumber, record: value });
  }

  if (lines.length === 0) {
    return {
      status: "refused",
      refusalState: "unsupported",
      sourceRevision,
      diagnostics: [
        ...diagnostics,
        fileDiagnostic(
          "source.unsupported_format",
          "error",
          ref,
          "file contains no records; file refused (completeness unknown)",
        ),
      ],
    };
  }
  if (skipped > 0) {
    diagnostics.push(
      fileDiagnostic(
        "source.incomplete",
        "warning",
        ref,
        `${skipped} line(s) skipped; ${lines.length} record(s) parsed`,
        undefined,
        { skippedLineCount: skipped, parsedRecordCount: lines.length },
      ),
    );
  }
  return { status: "parsed", sourceRevision, lines, diagnostics, skippedLineCount: skipped };
}

/** Cheap probe read: first content line only, bounded by the line ceiling. */
export async function readFirstContentLine(
  path: string,
  ref: FileRef,
): Promise<
  { readonly record: Record<string, unknown>; readonly lineNumber: number } | { readonly diagnostic: Diagnostic }
> {
  const opened = await openRegularFile(path, ref);
  if (!opened.ok) return { diagnostic: opened.diagnostic };
  const budget = Math.min(opened.size, MAX_LINE_BYTES + 4096);
  const buffer = Buffer.alloc(budget);
  let bytesRead = 0;
  try {
    const result = await opened.handle.read(buffer, 0, budget, 0);
    bytesRead = result.bytesRead;
  } catch {
    return { diagnostic: fileDiagnostic("source.input_refused", "error", ref, "file could not be read") };
  } finally {
    await opened.handle.close();
  }
  const rawLines = buffer.subarray(0, bytesRead).toString("utf8").split("\n");
  for (let i = 0; i < rawLines.length; i += 1) {
    const raw = rawLines[i];
    if (raw === undefined) continue;
    const text = raw.trim();
    if (text.length === 0) continue;
    const lineNumber = i + 1;
    if (i === rawLines.length - 1 && bytesRead < opened.size) {
      return {
        diagnostic: fileDiagnostic(
          "source.limit_exceeded",
          "error",
          ref,
          `first content line exceeds the ${MAX_LINE_BYTES}-byte line ceiling`,
          lineNumber,
        ),
      };
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      // Deliberately no parse-error detail: V8 JSON errors quote input bytes.
      return {
        diagnostic: fileDiagnostic(
          "source.unsupported_format",
          "error",
          ref,
          `first content line (line ${lineNumber}) is not valid JSON`,
          lineNumber,
        ),
      };
    }
    if (!isRecord(value)) {
      return {
        diagnostic: fileDiagnostic(
          "source.unsupported_format",
          "error",
          ref,
          `first content line (line ${lineNumber}) is not a JSON object`,
          lineNumber,
        ),
      };
    }
    return { record: value, lineNumber };
  }
  return { diagnostic: fileDiagnostic("source.unsupported_format", "error", ref, "file contains no records") };
}
