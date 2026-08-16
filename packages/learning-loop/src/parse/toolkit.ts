// Internal unknown-first parser toolkit. NOT part of the public surface.
// Every combinator validates from `unknown` and either returns a typed value
// or throws LearningLoopError with path-bearing diagnostics. Types flow from
// type predicates and control-flow narrowing only — no casts anywhere.
//
// Unknown-field policy: record parsers construct fresh objects containing only
// contract fields, so unknown input fields are ignored (preserved-irrelevant),
// never errors. Wrong or missing `schemaVersion` is `schema.unsupported_version`;
// every other shape failure is `schema.invalid`.
import type { JsonValue } from "../canonical/json.js";
import { toJsonValue } from "../canonical/to-json-value.js";
import { LearningLoopError } from "../diagnostics.js";

export type ParsePath = readonly (string | number)[];
export type Parse<T> = (input: unknown, path: ParsePath) => T;

export function invalid(code: string, message: string, path: ParsePath): LearningLoopError {
  return new LearningLoopError(code, [{ code, severity: "error", message, path }]);
}

function describe(input: unknown): string {
  if (input === null) return "null";
  if (Array.isArray(input)) return "array";
  return typeof input;
}

export const parseText: Parse<string> = (input, path) => {
  if (typeof input !== "string") throw invalid("schema.invalid", `expected string, got ${describe(input)}`, path);
  return input;
};

export const parseNonEmptyText: Parse<string> = (input, path) => {
  const value = parseText(input, path);
  if (value.length === 0) throw invalid("schema.invalid", "expected non-empty string", path);
  return value;
};

export const parseFiniteNumber: Parse<number> = (input, path) => {
  if (typeof input !== "number" || !Number.isFinite(input)) {
    throw invalid("schema.invalid", `expected finite number, got ${describe(input)}`, path);
  }
  return input;
};

export const parseBool: Parse<boolean> = (input, path) => {
  if (typeof input !== "boolean") throw invalid("schema.invalid", `expected boolean, got ${describe(input)}`, path);
  return input;
};

export const parseScalar: Parse<number | string | boolean> = (input, path) => {
  if (typeof input === "string" || typeof input === "boolean") return input;
  if (typeof input === "number") return parseFiniteNumber(input, path);
  throw invalid("schema.invalid", `expected string, finite number, or boolean, got ${describe(input)}`, path);
};

export const parseJson: Parse<JsonValue> = (input, path) => {
  try {
    return toJsonValue(input);
  } catch (error) {
    if (error instanceof LearningLoopError) {
      const inner = error.diagnostics.map((diagnostic) => ({
        ...diagnostic,
        path: [...path, ...(diagnostic.path ?? [])],
      }));
      throw new LearningLoopError(error.code, inner);
    }
    throw error;
  }
};

function isOneOf<T extends string>(input: unknown, values: readonly T[]): input is T {
  return typeof input === "string" && values.some((candidate) => candidate === input);
}

export function parseOneOf<T extends string>(values: readonly T[]): Parse<T> {
  return (input, path) => {
    if (!isOneOf(input, values)) {
      throw invalid("schema.invalid", `expected one of ${values.join(" | ")}, got ${describe(input)}`, path);
    }
    return input;
  };
}

export function parseArrayOf<T>(element: Parse<T>): Parse<readonly T[]> {
  return (input, path) => {
    if (!Array.isArray(input)) throw invalid("schema.invalid", `expected array, got ${describe(input)}`, path);
    return input.map((item: unknown, index: number) => element(item, [...path, index]));
  };
}

function isPlainRecord(input: unknown): input is Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return false;
  const prototype = Object.getPrototypeOf(input);
  return prototype === Object.prototype || prototype === null;
}

export interface FieldReader {
  req<T>(key: string, parse: Parse<T>): T;
  opt<T>(key: string, parse: Parse<T>): T | undefined;
  /** Requires `schemaVersion` to be exactly 1; wrong or missing version is `schema.unsupported_version`. */
  schemaVersion1(): 1;
}

export function readFields(input: unknown, path: ParsePath): FieldReader {
  if (!isPlainRecord(input)) throw invalid("schema.invalid", `expected object, got ${describe(input)}`, path);
  const record = input;
  return {
    req: (key, parse) => {
      const value = record[key];
      if (value === undefined) throw invalid("schema.invalid", `missing required field "${key}"`, [...path, key]);
      return parse(value, [...path, key]);
    },
    opt: (key, parse) => {
      const value = record[key];
      return value === undefined ? undefined : parse(value, [...path, key]);
    },
    schemaVersion1: () => {
      const value = record.schemaVersion;
      if (value !== 1) {
        throw invalid(
          "schema.unsupported_version",
          `unsupported schemaVersion ${value === undefined ? "(missing)" : JSON.stringify(value)}; this parser accepts schemaVersion 1`,
          [...path, "schemaVersion"],
        );
      }
      return 1;
    },
  };
}
