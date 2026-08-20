// Adapter input: the CALLER enumerates files. These adapters never discover,
// glob, or crawl (AGENTS.md "Privacy rules"); the input arrives as `unknown`
// at the trust boundary and is validated here.
import { Buffer } from "node:buffer";
import { LearningLoopError } from "@cormidia/learning-loop";
import { isRecord } from "./narrow.js";

export interface TranscriptFilesInput {
  readonly kind: "explicit_files";
  /** Ordered, caller-enumerated list of session files. Cursors index into it. */
  readonly paths: readonly string[];
  /**
   * Caller-supplied secret for domain-separated HMAC locators, so filesystem
   * paths never enter a dictionary-recoverable digest.
   */
  readonly locatorKey: string;
}

const MIN_LOCATOR_KEY_BYTES = 32;

function inputError(message: string, path: readonly (string | number)[]): LearningLoopError {
  return new LearningLoopError("schema.invalid", [{ code: "schema.invalid", severity: "error", message, path }]);
}

export function parseTranscriptFilesInput(input: unknown): TranscriptFilesInput {
  if (!isRecord(input)) throw inputError("transcript source input must be an object", []);
  if (input.kind !== "explicit_files") {
    throw inputError(
      'input.kind must be "explicit_files" — the caller enumerates files; this adapter never discovers',
      ["kind"],
    );
  }
  const rawPaths = input.paths;
  if (!Array.isArray(rawPaths)) throw inputError("input.paths must be an array of file paths", ["paths"]);
  const paths: string[] = [];
  for (let index = 0; index < rawPaths.length; index += 1) {
    const path: unknown = rawPaths[index];
    if (typeof path !== "string" || path.length === 0) {
      throw inputError("every input path must be a non-empty string", ["paths", index]);
    }
    paths.push(path);
  }
  const locatorKey = input.locatorKey;
  if (typeof locatorKey !== "string" || Buffer.byteLength(locatorKey, "utf8") < MIN_LOCATOR_KEY_BYTES) {
    throw inputError(
      `input.locatorKey must contain at least ${MIN_LOCATOR_KEY_BYTES} UTF-8 bytes of secret key material`,
      ["locatorKey"],
    );
  }
  return { kind: "explicit_files", paths, locatorKey };
}

/** Cursor = decimal index into the ordered path list (resumability). */
export function startIndexFromCursor(cursor: string | undefined, pathCount: number): number {
  if (cursor === undefined) return 0;
  if (!/^\d+$/.test(cursor)) {
    throw inputError("cursor must be a decimal index into the ordered path list", ["cursor"]);
  }
  const index = Number.parseInt(cursor, 10);
  if (index > pathCount) {
    throw inputError(`cursor ${index} is beyond the ${pathCount}-entry path list`, ["cursor"]);
  }
  return index;
}
