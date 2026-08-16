// Runtime guard for the JSON value domain. Deep-validates arbitrary input and
// returns an independent, safe copy. Rejections (contract §JSON values):
// non-finite numbers, bigints, functions, symbols, undefined values,
// non-plain-prototype objects (Date, Map, Set, class instances, buffers),
// symbol-keyed properties, and cyclic values. Sparse array holes are rejected
// like explicit undefined.
import type { JsonValue } from "./json.js";
import { LearningLoopError } from "../diagnostics.js";

type Path = readonly (string | number)[];

function reject(message: string, path: Path): never {
  throw new LearningLoopError("schema.invalid", [{ code: "schema.invalid", severity: "error", message, path }]);
}

function isPlainObject(input: unknown): input is Record<string, unknown> {
  if (typeof input !== "object" || input === null) return false;
  const prototype = Object.getPrototypeOf(input);
  return prototype === Object.prototype || prototype === null;
}

function convert(input: unknown, path: Path, seen: Set<object>): JsonValue {
  if (input === null || typeof input === "boolean" || typeof input === "string") return input;
  if (typeof input === "number") {
    if (!Number.isFinite(input)) reject(`non-finite number ${String(input)} is not a JSON value`, path);
    return input;
  }
  if (typeof input === "bigint") reject("bigint is not a JSON value", path);
  if (typeof input === "function") reject("function is not a JSON value", path);
  if (typeof input === "symbol") reject("symbol is not a JSON value", path);
  if (input === undefined) reject("undefined is not a JSON value", path);
  if (Array.isArray(input)) {
    if (seen.has(input)) reject("cyclic value is not a JSON value", path);
    seen.add(input);
    const items: JsonValue[] = [];
    for (let index = 0; index < input.length; index += 1) {
      if (!(index in input)) reject("sparse array hole is not a JSON value", [...path, index]);
      items.push(convert(input[index], [...path, index], seen));
    }
    seen.delete(input);
    return items;
  }
  if (!isPlainObject(input)) {
    reject("only plain objects and arrays are JSON values (no Date, Map, Set, buffers, or class instances)", path);
  }
  if (Object.getOwnPropertySymbols(input).length > 0) {
    reject("symbol-keyed properties cannot be represented in JSON", path);
  }
  if (seen.has(input)) reject("cyclic value is not a JSON value", path);
  seen.add(input);
  const result: Record<string, JsonValue> = {};
  for (const key of Object.keys(input)) {
    result[key] = convert(input[key], [...path, key], seen);
  }
  seen.delete(input);
  return result;
}

export function toJsonValue(input: unknown): JsonValue {
  return convert(input, [], new Set());
}
