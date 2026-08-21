// Adapter input: the CALLER enumerates files. These adapters never discover,
// glob, or crawl (AGENTS.md "Privacy rules"); the input arrives as `unknown`
// at the trust boundary and is validated here against the adapter's privacy
// policy. Paths are normalized (never resolved through symlinks) so identity
// is stable and `..` traversal is visible before any filesystem access.
import { Buffer } from "node:buffer";
import { resolve } from "node:path";
import { LearningLoopError } from "@cormidia/learning-loop";
import { isRecord } from "./narrow.js";
import type { TranscriptPrivacyPolicy } from "./privacy-policy.js";

export interface TranscriptFilesInput {
  readonly kind: "explicit_files";
  /** Ordered, caller-enumerated list of session files. Cursors index into it. */
  readonly paths: readonly string[];
  /**
   * Caller-supplied secret for domain-separated HMAC locators, so filesystem
   * paths never enter a dictionary-recoverable digest.
   */
  readonly locatorKey: string;
  /**
   * Directories the caller enumerated from. Every path must resolve inside
   * one of them with no symbolic link on the way; required when the policy's
   * `input.rootConfinement` is `required`. Roots never enter any projection.
   */
  readonly roots?: readonly string[];
}

/** Validated input with normalized absolute paths and roots. */
export interface ParsedTranscriptFilesInput {
  readonly paths: readonly string[];
  readonly locatorKey: string;
  /** Normalized roots; empty when the policy permits unconfined explicit files and none were declared. */
  readonly roots: readonly string[];
}

const MIN_LOCATOR_KEY_BYTES = 32;
const MAX_PATHS = 100_000;

function inputError(message: string, path: readonly (string | number)[]): LearningLoopError {
  return new LearningLoopError("schema.invalid", [{ code: "schema.invalid", severity: "error", message, path }]);
}

function parsePathList(raw: unknown, key: "paths" | "roots"): string[] {
  if (!Array.isArray(raw)) throw inputError(`input.${key} must be an array of filesystem paths`, [key]);
  if (raw.length > MAX_PATHS) throw inputError(`input.${key} exceeds the ${MAX_PATHS}-entry ceiling`, [key]);
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < raw.length; index += 1) {
    const value: unknown = raw[index];
    if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
      throw inputError(`every input ${key} entry must be a non-empty string without NUL bytes`, [key, index]);
    }
    const normalizedValue = resolve(value);
    if (seen.has(normalizedValue)) {
      // A duplicated explicit path would project the same session twice; it is
      // a caller defect, refused typed rather than collapsed silently.
      throw inputError(`input.${key} contains the same path more than once`, [key, index]);
    }
    seen.add(normalizedValue);
    normalized.push(normalizedValue);
  }
  return normalized;
}

export function parseTranscriptFilesInput(input: unknown, policy: TranscriptPrivacyPolicy): ParsedTranscriptFilesInput {
  if (!isRecord(input)) throw inputError("transcript source input must be an object", []);
  if (input.kind !== "explicit_files") {
    throw inputError(
      'input.kind must be "explicit_files" — the caller enumerates files; this adapter never discovers',
      ["kind"],
    );
  }
  const paths = parsePathList(input.paths, "paths");
  const locatorKey = input.locatorKey;
  if (typeof locatorKey !== "string" || Buffer.byteLength(locatorKey, "utf8") < MIN_LOCATOR_KEY_BYTES) {
    throw inputError(
      `input.locatorKey must contain at least ${MIN_LOCATOR_KEY_BYTES} UTF-8 bytes of secret key material`,
      ["locatorKey"],
    );
  }
  const roots = input.roots === undefined ? [] : parsePathList(input.roots, "roots");
  if (policy.input.rootConfinement === "required" && roots.length === 0) {
    throw inputError(
      `privacy policy "${policy.id}" requires root confinement: declare the directories the files were enumerated from in input.roots`,
      ["roots"],
    );
  }
  return { paths, locatorKey, roots };
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
