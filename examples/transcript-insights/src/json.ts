// Narrowing helpers over kernel JsonValue data and raw `unknown` store values.
// Parse, don't cast: every read is a typeof/shape check, never an assertion.
import type { JsonValue } from "@cormidia/learning-loop";

export type JsonObject = { readonly [key: string]: JsonValue };

function isJsonArray(value: JsonValue): value is readonly JsonValue[] {
  return Array.isArray(value);
}

export function jsonObject(value: JsonValue | undefined): JsonObject | undefined {
  if (value === undefined || typeof value !== "object" || value === null || isJsonArray(value)) return undefined;
  return value;
}

export function jsonString(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function jsonNumber(value: JsonValue | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function jsonBoolean(value: JsonValue | undefined): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

/** Shape guard for values arriving as `unknown` (store reads, CLI evidence). */
export function isUnknownRecord(value: unknown): value is { readonly [key: string]: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
