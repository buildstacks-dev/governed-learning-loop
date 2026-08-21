// JSONL session-file reading under a TranscriptPrivacyPolicy with fail-closed
// ceilings. Every path is first confined to a declared root (lexically, then
// component by component with lstat so no directory on the way is a symbolic
// link, then by realpath), then lstat-ed and opened with O_NOFOLLOW: symlinks
// and non-regular files are refused — the caller enumerates real files
// explicitly; this module never follows links and never decompresses.
// Diagnostics reference files by input index only (never paths or basenames)
// and NEVER echo line content or JSON.parse error text (V8 parse errors quote
// input bytes).
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { lstat, open, realpath } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { performance } from "node:perf_hooks";
import type { Diagnostic, JsonValue } from "@cormidia/learning-loop";
import { isRecord } from "./narrow.js";
import type { TranscriptPrivacyPolicy } from "./privacy-policy.js";

export interface FileRef {
  readonly index: number;
}

export function refOf(index: number): FileRef {
  return { index };
}

/** What one read runs under: the governing policy plus the call's normalized roots. */
export interface ReadContext {
  readonly policy: TranscriptPrivacyPolicy;
  readonly roots: readonly string[];
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
const MAGIC_SCAN_BYTES = 512;

// Leading bytes of compressed containers. Such input is refused BEFORE any
// decoding: this adapter has no inflate path, so a decompression bomb has
// nothing to expand into.
const COMPRESSED_MAGIC: readonly (readonly number[])[] = [
  [0x1f, 0x8b], // gzip
  [0x28, 0xb5, 0x2f, 0xfd], // zstd
  [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00], // xz
  [0x42, 0x5a, 0x68], // bzip2
  [0x50, 0x4b, 0x03, 0x04], // zip
  [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c], // 7z
  [0x78, 0x01], // zlib
  [0x78, 0x5e],
  [0x78, 0x9c],
  [0x78, 0xda],
];

function looksCompressedOrBinary(bytes: Buffer): boolean {
  for (const magic of COMPRESSED_MAGIC) {
    if (bytes.byteLength >= magic.length && magic.every((byte, index) => bytes[index] === byte)) return true;
  }
  const scan = Math.min(bytes.byteLength, MAGIC_SCAN_BYTES);
  for (let index = 0; index < scan; index += 1) {
    if (bytes[index] === 0) return true; // raw NUL never occurs in JSON text
  }
  return false;
}

/**
 * Bounded pre-parse scan: counts unmatched `{`/`[` outside string literals.
 * Returns true as soon as the depth ceiling is crossed, so a nesting bomb is
 * refused before JSON.parse materializes it.
 */
export function exceedsNestingDepth(text: string, maximumDepth: number): boolean {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (inString) {
      if (escaped) escaped = false;
      else if (code === 0x5c) escaped = true;
      else if (code === 0x22) inString = false;
      continue;
    }
    if (code === 0x22) inString = true;
    else if (code === 0x7b || code === 0x5b) {
      depth += 1;
      if (depth > maximumDepth) return true;
    } else if ((code === 0x7d || code === 0x5d) && depth > 0) depth -= 1;
  }
  return false;
}

type RegularFile =
  | { readonly ok: true; readonly handle: FileHandle; readonly size: number }
  | { readonly ok: false; readonly refusalState: SessionFileRefusalState; readonly diagnostic: Diagnostic };

function systemErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code: unknown = Reflect.get(error, "code");
  return typeof code === "string" ? code : undefined;
}

function withTrailingSeparator(root: string): string {
  return root.endsWith(sep) ? root : `${root}${sep}`;
}

function refusal(
  ref: FileRef,
  refusalState: SessionFileRefusalState,
  message: string,
): { readonly ok: false; readonly refusalState: SessionFileRefusalState; readonly diagnostic: Diagnostic } {
  return { ok: false, refusalState, diagnostic: fileDiagnostic("source.input_refused", "error", ref, message) };
}

/**
 * Root confinement. `path` is already normalized (input.ts). With no declared
 * roots the policy permitted unconfined explicit files; otherwise the path
 * must sit lexically inside one root, no directory between the root and the
 * file may be a symbolic link, and the resolved path must still be inside
 * the resolved root.
 */
async function confinePath(
  path: string,
  ref: FileRef,
  roots: readonly string[],
): Promise<Extract<RegularFile, { readonly ok: false }> | undefined> {
  if (roots.length === 0) return undefined;
  const root = roots.find((candidate) => path.startsWith(withTrailingSeparator(candidate)));
  if (root === undefined) {
    return refusal(ref, "unreadable", "path resolves outside every declared root and was refused");
  }
  const segments = relative(root, path).split(sep);
  let current = root;
  for (let index = 0; index < segments.length - 1; index += 1) {
    current = join(current, segments[index] ?? "");
    let stats: Awaited<ReturnType<typeof lstat>>;
    try {
      stats = await lstat(current);
    } catch (error) {
      return refusal(
        ref,
        systemErrorCode(error) === "ENOENT" ? "missing" : "unreadable",
        "path does not exist or is not readable",
      );
    }
    if (stats.isSymbolicLink()) {
      return refusal(ref, "unreadable", "a directory on the path is a symbolic link; links are never followed");
    }
    if (!stats.isDirectory()) return refusal(ref, "unreadable", "a component on the path is not a directory");
  }
  try {
    const resolvedRoot = withTrailingSeparator(await realpath(root));
    const resolvedPath = await realpath(path);
    if (!resolvedPath.startsWith(resolvedRoot)) {
      return refusal(ref, "unreadable", "path resolves outside every declared root and was refused");
    }
  } catch (error) {
    return refusal(
      ref,
      systemErrorCode(error) === "ENOENT" ? "missing" : "unreadable",
      "path does not exist or is not readable",
    );
  }
  return undefined;
}

async function openRegularFile(path: string, ref: FileRef, context: ReadContext): Promise<RegularFile> {
  const confinement = await confinePath(path, ref, context.roots);
  if (confinement !== undefined) return confinement;
  let size: number;
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink()) {
      return refusal(ref, "unreadable", "symbolic links are refused; pass the resolved regular file explicitly");
    }
    if (!stats.isFile()) return refusal(ref, "unreadable", "not a regular file");
    size = stats.size;
  } catch (error) {
    return refusal(
      ref,
      systemErrorCode(error) === "ENOENT" ? "missing" : "unreadable",
      "path does not exist or is not readable",
    );
  }
  const maximumFileBytes = context.policy.ceilings.maximumFileBytes;
  if (size > maximumFileBytes) {
    return {
      ok: false,
      refusalState: "unsupported",
      diagnostic: fileDiagnostic(
        "source.limit_exceeded",
        "error",
        ref,
        `file exceeds the ${maximumFileBytes}-byte per-file ceiling and was skipped`,
        undefined,
        { ceiling: "file_bytes" },
      ),
    };
  }
  try {
    // O_NOFOLLOW backstops the lstat check against a link swapped in between.
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    return { ok: true, handle, size };
  } catch {
    return refusal(ref, "unreadable", "file could not be opened without following links");
  }
}

function compressedRefusal(ref: FileRef, sourceRevision?: string): SessionFileResult {
  return {
    status: "refused",
    refusalState: "unsupported",
    ...(sourceRevision === undefined ? {} : { sourceRevision }),
    diagnostics: [
      fileDiagnostic(
        "source.unsupported_format",
        "error",
        ref,
        "compressed or binary input is refused before decoding; this adapter never decompresses",
      ),
    ],
  };
}

export async function readSessionFile(path: string, ref: FileRef, context: ReadContext): Promise<SessionFileResult> {
  const ceilings = context.policy.ceilings;
  const opened = await openRegularFile(path, ref, context);
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
  if (bytes.byteLength > ceilings.maximumFileBytes) {
    return {
      status: "refused",
      refusalState: "unsupported",
      sourceRevision,
      diagnostics: [
        fileDiagnostic(
          "source.limit_exceeded",
          "error",
          ref,
          `file exceeds the ${ceilings.maximumFileBytes}-byte per-file ceiling and was skipped`,
          undefined,
          { ceiling: "file_bytes" },
        ),
      ],
    };
  }
  if (looksCompressedOrBinary(bytes)) return compressedRefusal(ref, sourceRevision);
  const rawLines = bytes.toString("utf8").split("\n");
  const lines: ParsedLine[] = [];
  const diagnostics: Diagnostic[] = [];
  let skipped = 0;
  let perLineDiagnostics = 0;
  let accepted = false;
  const startedAt = performance.now();

  const refuseFirstLine = (code: string, lineNumber: number, message: string): SessionFileResult => ({
    status: "refused",
    refusalState: code === "source.unsupported_format" ? "unsupported" : "corrupt",
    sourceRevision,
    diagnostics: [fileDiagnostic(code, "error", ref, message, lineNumber)],
  });
  const skipLine = (code: string, lineNumber: number, message: string, ceiling?: string): void => {
    skipped += 1;
    if (perLineDiagnostics < MAX_PER_LINE_DIAGNOSTICS) {
      perLineDiagnostics += 1;
      diagnostics.push(
        fileDiagnostic(code, "warning", ref, message, lineNumber, ceiling === undefined ? undefined : { ceiling }),
      );
    }
  };
  const remainingContentLines = (from: number): number => {
    let remaining = 0;
    for (let j = from; j < rawLines.length; j += 1) {
      const rest = rawLines[j];
      if (rest !== undefined && rest.trim().length > 0) remaining += 1;
    }
    return remaining;
  };

  for (let i = 0; i < rawLines.length; i += 1) {
    const raw = rawLines[i];
    if (raw === undefined) continue;
    const lineNumber = i + 1;
    const text = raw.trim();
    if (text.length === 0) continue;
    if (lines.length >= ceilings.maximumRecordsPerFile) {
      const remaining = remainingContentLines(i);
      skipped += remaining;
      diagnostics.push(
        fileDiagnostic(
          "source.limit_exceeded",
          "warning",
          ref,
          `record ceiling of ${ceilings.maximumRecordsPerFile} records reached at line ${lineNumber}; ${remaining} remaining line(s) skipped`,
          lineNumber,
          { ceiling: "records", remainingLines: remaining },
        ),
      );
      break;
    }
    const elapsed = performance.now() - startedAt;
    if (elapsed > ceilings.maximumProcessingMillisPerFile) {
      if (!accepted) {
        return refuseFirstLine(
          "source.limit_exceeded",
          lineNumber,
          `processing-time ceiling of ${ceilings.maximumProcessingMillisPerFile} ms reached before the first record; file refused (completeness unknown)`,
        );
      }
      const remaining = remainingContentLines(i);
      skipped += remaining;
      diagnostics.push(
        fileDiagnostic(
          "source.limit_exceeded",
          "warning",
          ref,
          `processing-time ceiling of ${ceilings.maximumProcessingMillisPerFile} ms reached at line ${lineNumber}; ${remaining} remaining line(s) skipped`,
          lineNumber,
          { ceiling: "processing_time", remainingLines: remaining },
        ),
      );
      break;
    }
    if (Buffer.byteLength(raw, "utf8") > ceilings.maximumLineBytes) {
      if (!accepted) {
        return refuseFirstLine(
          "source.limit_exceeded",
          lineNumber,
          `first content line (line ${lineNumber}) exceeds the ${ceilings.maximumLineBytes}-byte line ceiling; file refused (completeness unknown)`,
        );
      }
      skipLine(
        "source.limit_exceeded",
        lineNumber,
        `line exceeds the ${ceilings.maximumLineBytes}-byte line ceiling and was skipped`,
        "line_bytes",
      );
      continue;
    }
    if (exceedsNestingDepth(text, ceilings.maximumNestingDepth)) {
      if (!accepted) {
        return refuseFirstLine(
          "source.limit_exceeded",
          lineNumber,
          `first content line (line ${lineNumber}) exceeds the nesting depth ceiling of ${ceilings.maximumNestingDepth}; file refused (completeness unknown)`,
        );
      }
      skipLine(
        "source.limit_exceeded",
        lineNumber,
        `line exceeds the nesting depth ceiling of ${ceilings.maximumNestingDepth} and was skipped`,
        "nesting_depth",
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

/** Cheap probe read: first content line only, bounded by the line ceiling and every input refusal. */
export async function readFirstContentLine(
  path: string,
  ref: FileRef,
  context: ReadContext,
): Promise<
  { readonly record: Record<string, unknown>; readonly lineNumber: number } | { readonly diagnostic: Diagnostic }
> {
  const ceilings = context.policy.ceilings;
  const opened = await openRegularFile(path, ref, context);
  if (!opened.ok) return { diagnostic: opened.diagnostic };
  const budget = Math.min(opened.size, ceilings.maximumLineBytes + 4096);
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
  const head = buffer.subarray(0, bytesRead);
  if (looksCompressedOrBinary(head)) {
    const refused = compressedRefusal(ref);
    const diagnostic = refused.diagnostics[0];
    if (diagnostic !== undefined) return { diagnostic };
  }
  const rawLines = head.toString("utf8").split("\n");
  for (let i = 0; i < rawLines.length; i += 1) {
    const raw = rawLines[i];
    if (raw === undefined) continue;
    const text = raw.trim();
    if (text.length === 0) continue;
    const lineNumber = i + 1;
    if (
      (i === rawLines.length - 1 && bytesRead < opened.size) ||
      Buffer.byteLength(raw, "utf8") > ceilings.maximumLineBytes
    ) {
      return {
        diagnostic: fileDiagnostic(
          "source.limit_exceeded",
          "error",
          ref,
          `first content line exceeds the ${ceilings.maximumLineBytes}-byte line ceiling`,
          lineNumber,
          { ceiling: "line_bytes" },
        ),
      };
    }
    if (exceedsNestingDepth(text, ceilings.maximumNestingDepth)) {
      return {
        diagnostic: fileDiagnostic(
          "source.limit_exceeded",
          "error",
          ref,
          `first content line exceeds the nesting depth ceiling of ${ceilings.maximumNestingDepth}`,
          lineNumber,
          { ceiling: "nesting_depth" },
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
