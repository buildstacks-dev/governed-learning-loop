// Cheap probe: input validation plus a bounded read of each file's first
// content line against the provider's shape band. No hashing, no full parse.
import type { Diagnostic } from "@cormidia/learning-loop";
import { parseTranscriptFilesInput } from "./input.js";
import { fileDiagnostic, readFirstContentLine, refOf } from "./session-file.js";

export async function probeExplicitFiles(
  input: unknown,
  firstLineBand: (record: Record<string, unknown>) => string | undefined,
): Promise<{ readonly supported: boolean; readonly diagnostics: readonly Diagnostic[] }> {
  const parsed = parseTranscriptFilesInput(input);
  if (parsed.paths.length === 0) {
    return {
      supported: true,
      diagnostics: [
        { code: "source.incomplete", severity: "info", message: "no files were provided; nothing to probe" },
      ],
    };
  }
  const diagnostics: Diagnostic[] = [];
  let supported = true;
  for (let index = 0; index < parsed.paths.length; index += 1) {
    const path = parsed.paths[index];
    if (path === undefined) continue;
    const ref = refOf(index);
    const first = await readFirstContentLine(path, ref);
    if ("diagnostic" in first) {
      supported = false;
      diagnostics.push(first.diagnostic);
      continue;
    }
    const bandError = firstLineBand(first.record);
    if (bandError !== undefined) {
      supported = false;
      diagnostics.push(
        fileDiagnostic("source.unsupported_format", "error", ref, `first record: ${bandError}`, first.lineNumber),
      );
    }
  }
  return { supported, diagnostics };
}
