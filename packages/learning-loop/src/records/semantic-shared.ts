// Internal primitives shared by the immutable semantic record parsers.
import { canonicalJsonText, sha256HexOfCanonicalJson } from "../canonical/canonical-json.js";
import type { JsonValue } from "../canonical/json.js";
import { toJsonValue } from "../canonical/to-json-value.js";
import { invalid, parseJson, parseNonEmptyText, parseOneOf, readFields } from "../parse/toolkit.js";
import type { Parse } from "../parse/toolkit.js";
import { candidateScopeDigest } from "./candidate.js";
import { parseScopeShapeAt } from "./episode.js";
import type { Scope } from "./scope.js";

export const MAX_SET_VALUES = 1_000;
export const MAX_ORDERED_VALUES = 10_000;

const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const MAX_ID_LENGTH = 1_000;
const MAX_DURABLE_ID_LENGTH = 4_096;
const MAX_TEXT_LENGTH = 10_000;
const STANDARD_LEARNING_CLASSES = [
  "mechanical_execution",
  "human_agent_interaction",
  "role_craft",
  "system_meta",
] as const;
const EPISODE_CLASS_MODES: readonly ["any", "include"] = ["any", "include"];
const SCOPE_CONSTRAINT_MODES: readonly ["invocation", "exact"] = ["invocation", "exact"];
const LENS_CONSTRAINT_MODES: readonly ["independent", "required"] = ["independent", "required"];
const LENS_SELECTIONS: readonly ["any_registered", "allowlist"] = ["any_registered", "allowlist"];

export type LearningClass = (typeof STANDARD_LEARNING_CLASSES)[number] | `host:${string}`;

export interface DetectorRef {
  readonly id: string;
  readonly version: string;
  readonly registrationDigest: string;
}

export interface PackRef {
  readonly id: string;
  readonly version: string;
  readonly manifestDigest: string;
}

export interface LensRef {
  readonly id: string;
  readonly version: string;
  readonly registrationDigest: string;
}

export interface DigestedScope {
  readonly scope: Scope;
  readonly scopeDigest: string;
}

export type EpisodeClasses =
  | { readonly mode: "any" }
  | { readonly mode: "include"; readonly values: readonly string[] };

export type ScopeConstraint =
  | { readonly mode: "invocation" }
  | { readonly mode: "exact"; readonly scopes: readonly DigestedScope[] };

export type LensConstraint =
  | { readonly mode: "independent" }
  | {
      readonly mode: "required";
      readonly selection: "any_registered" | "allowlist";
      readonly registrations: readonly LensRef[];
    };

export type JsonObject = { readonly [key: string]: JsonValue };

export function parseBoundedText(maximumLength: number, label: string): Parse<string> {
  return (input, path) => {
    const value = parseNonEmptyText(input, path);
    if (value.length > maximumLength) {
      throw invalid("schema.invalid", `${label} exceeds ${maximumLength} characters`, path);
    }
    for (const character of value) {
      const code = character.codePointAt(0) ?? 0;
      if (code < 0x20 || code === 0x7f) {
        throw invalid("schema.invalid", `${label} contains a control character`, path);
      }
    }
    return value;
  };
}

export const parseId = parseBoundedText(MAX_ID_LENGTH, "identifier");
export const parseDurableId = parseBoundedText(MAX_DURABLE_ID_LENGTH, "durable id");
export const parseStatement = parseBoundedText(MAX_TEXT_LENGTH, "statement");

export const parseDigestAt: Parse<string> = (input, path) => {
  const digest = parseNonEmptyText(input, path);
  if (!DIGEST_PATTERN.test(digest)) {
    throw invalid("schema.invalid", "expected a lowercase SHA-256 digest", path);
  }
  return digest;
};

/** Canonical RFC 3339 UTC timestamp with milliseconds, exactly as `Date#toISOString` renders it. */
export const parseCanonicalTimestampAt: Parse<string> = (input, path) => {
  const value = parseNonEmptyText(input, path);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw invalid("schema.invalid", "timestamp must be canonical RFC 3339 UTC with milliseconds", path);
  }
  return value;
};

export function parseNullable<T>(parse: Parse<T>): Parse<T | null> {
  return (input, path) => (input === null ? null : parse(input, path));
}

export function parseBoundedArray<T>(parse: Parse<T>, maximum: number, label: string): Parse<readonly T[]> {
  return (input, path) => {
    if (!Array.isArray(input)) throw invalid("schema.invalid", `${label} must be an array`, path);
    if (input.length > maximum) throw invalid("schema.invalid", `${label} exceeds ${maximum} entries`, path);
    return input.map((value: unknown, index: number) => parse(value, [...path, index]));
  };
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function assertSortedUnique<T>(
  values: readonly T[],
  keyOf: (value: T) => string,
  path: readonly (string | number)[],
): void {
  let previous: string | undefined;
  for (const [index, value] of values.entries()) {
    const key = keyOf(value);
    if (previous !== undefined && compareText(previous, key) >= 0) {
      throw invalid("schema.invalid", "set-like values must be sorted and unique", [...path, index]);
    }
    previous = key;
  }
}

export function assertUniqueRefVersions<T extends { readonly id: string; readonly version: string }>(
  values: readonly T[],
  path: readonly (string | number)[],
): void {
  const versions = new Set<string>();
  for (const [index, value] of values.entries()) {
    const key = canonicalKey([value.id, value.version]);
    if (versions.has(key)) {
      throw invalid("schema.invalid", "a semantic id and version must bind exactly one digest", [...path, index]);
    }
    versions.add(key);
  }
}

export function canonicalKey(value: unknown): string {
  return canonicalJsonText(toJsonValue(value));
}

export function detectorRefKey(value: DetectorRef): string {
  return canonicalKey([value.id, value.version, value.registrationDigest]);
}

export function packRefKey(value: PackRef): string {
  return canonicalKey([value.id, value.version, value.manifestDigest]);
}

export function lensRefKey(value: LensRef): string {
  return canonicalKey([value.id, value.version, value.registrationDigest]);
}

export function digestOf(value: unknown): string {
  return sha256HexOfCanonicalJson(toJsonValue(value));
}

export function parseSemVer(input: unknown, path: readonly (string | number)[]): string {
  const version = parseBoundedText(200, "semantic version")(input, path);
  const plusParts = version.split("+");
  if (plusParts.length > 2) throw invalid("schema.invalid", "version must be canonical SemVer", path);
  const coreAndPre = plusParts[0];
  const build = plusParts[1];
  if (coreAndPre === undefined || (build !== undefined && !validIdentifiers(build, false))) {
    throw invalid("schema.invalid", "version must be canonical SemVer", path);
  }
  const dash = coreAndPre.indexOf("-");
  const core = dash < 0 ? coreAndPre : coreAndPre.slice(0, dash);
  const prerelease = dash < 0 ? undefined : coreAndPre.slice(dash + 1);
  const parts = core.split(".");
  if (
    parts.length !== 3 ||
    parts.some((part) => !/^(0|[1-9][0-9]*)$/.test(part)) ||
    (prerelease !== undefined && !validIdentifiers(prerelease, true))
  ) {
    throw invalid("schema.invalid", "version must be canonical SemVer", path);
  }
  return version;
}

function validIdentifiers(value: string, rejectNumericLeadingZero: boolean): boolean {
  if (value.length === 0) return false;
  for (const identifier of value.split(".")) {
    if (!/^[0-9A-Za-z-]+$/.test(identifier)) return false;
    if (
      rejectNumericLeadingZero &&
      /^[0-9]+$/.test(identifier) &&
      identifier.length > 1 &&
      identifier.startsWith("0")
    ) {
      return false;
    }
  }
  return true;
}

function isHostLearningClass(value: string): value is `host:${string}` {
  return value.startsWith("host:") && value.length > "host:".length;
}

export const parseLearningClassAt: Parse<LearningClass> = (input, path) => {
  const value = parseId(input, path);
  if (value === "mechanical_execution") return value;
  if (value === "human_agent_interaction") return value;
  if (value === "role_craft") return value;
  if (value === "system_meta") return value;
  if (isHostLearningClass(value)) return value;
  throw invalid("schema.invalid", "learning class must be standard or use a nonempty host: prefix", path);
};

export function parseJsonObject(input: unknown, path: readonly (string | number)[]): JsonObject {
  const value = parseJson(input, path);
  if (value === null || typeof value !== "object" || isJsonArray(value)) {
    throw invalid("schema.invalid", "expected a JSON object", path);
  }
  return value;
}

function isJsonArray(value: JsonValue): value is readonly JsonValue[] {
  return Array.isArray(value);
}

export function parseTrue(input: unknown, path: readonly (string | number)[]): true {
  if (input !== true) throw invalid("schema.invalid", "expected true", path);
  return true;
}

export function scopeDigest(scope: Scope): string {
  return candidateScopeDigest(scope);
}

export function parseScopeAt(input: unknown, path: readonly (string | number)[]): Scope {
  const scope = parseScopeShapeAt(input, path);
  if (scope.length === 0) throw invalid("schema.invalid", "scope must not be empty", path);
  const parseScopeText = parseBoundedText(200, "scope segment text");
  for (const [index, segment] of scope.entries()) {
    parseScopeText(segment.type, [...path, index, "type"]);
    parseScopeText(segment.id, [...path, index, "id"]);
  }
  return scope;
}

export function parseDetectorRefAt(input: unknown, path: readonly (string | number)[]): DetectorRef {
  const fields = readFields(input, path);
  return {
    id: fields.req("id", parseId),
    version: fields.req("version", parseSemVer),
    registrationDigest: fields.req("registrationDigest", parseDigestAt),
  };
}

export function parsePackRefAt(input: unknown, path: readonly (string | number)[]): PackRef {
  const fields = readFields(input, path);
  return {
    id: fields.req("id", parseId),
    version: fields.req("version", parseSemVer),
    manifestDigest: fields.req("manifestDigest", parseDigestAt),
  };
}

export function parseLensRefAt(input: unknown, path: readonly (string | number)[]): LensRef {
  const fields = readFields(input, path);
  return {
    id: fields.req("id", parseId),
    version: fields.req("version", parseSemVer),
    registrationDigest: fields.req("registrationDigest", parseDigestAt),
  };
}

function parseDigestedScopeAt(input: unknown, path: readonly (string | number)[]): DigestedScope {
  const fields = readFields(input, path);
  const scope = fields.req("scope", parseScopeAt);
  const digest = fields.req("scopeDigest", parseDigestAt);
  if (digest !== scopeDigest(scope)) {
    throw invalid("schema.corrupt", "scope digest does not match exact scope", [...path, "scopeDigest"]);
  }
  return { scope, scopeDigest: digest };
}

export function parseEpisodeClassesAt(input: unknown, path: readonly (string | number)[]): EpisodeClasses {
  const fields = readFields(input, path);
  const mode = fields.req("mode", parseOneOf(EPISODE_CLASS_MODES));
  if (mode === "any") return { mode };
  const values = fields.req("values", parseBoundedArray(parseId, MAX_SET_VALUES, "episode classes"));
  if (values.length === 0) {
    throw invalid("schema.invalid", "included episode classes must not be empty", [...path, "values"]);
  }
  assertSortedUnique(values, (value) => value, [...path, "values"]);
  return { mode, values };
}

export function parseScopeConstraintAt(input: unknown, path: readonly (string | number)[]): ScopeConstraint {
  const fields = readFields(input, path);
  const mode = fields.req("mode", parseOneOf(SCOPE_CONSTRAINT_MODES));
  if (mode === "invocation") return { mode };
  const scopes = fields.req("scopes", parseBoundedArray(parseDigestedScopeAt, MAX_SET_VALUES, "scopes"));
  if (scopes.length === 0) {
    throw invalid("schema.invalid", "exact scope constraint must not be empty", [...path, "scopes"]);
  }
  assertSortedUnique(scopes, (value) => value.scopeDigest, [...path, "scopes"]);
  return { mode, scopes };
}

export function parseLensConstraintAt(input: unknown, path: readonly (string | number)[]): LensConstraint {
  const fields = readFields(input, path);
  const mode = fields.req("mode", parseOneOf(LENS_CONSTRAINT_MODES));
  if (mode === "independent") return { mode };
  const selection = fields.req("selection", parseOneOf(LENS_SELECTIONS));
  const registrations = fields.req(
    "registrations",
    parseBoundedArray(parseLensRefAt, MAX_SET_VALUES, "lens registrations"),
  );
  assertSortedUnique(registrations, lensRefKey, [...path, "registrations"]);
  assertUniqueRefVersions(registrations, [...path, "registrations"]);
  if (selection === "any_registered" && registrations.length !== 0) {
    throw invalid("schema.invalid", "any_registered lens selection must not carry an allowlist", [
      ...path,
      "registrations",
    ]);
  }
  if (selection === "allowlist" && registrations.length === 0) {
    throw invalid("schema.invalid", "allowlist lens selection requires registrations", [...path, "registrations"]);
  }
  return { mode, selection, registrations };
}

export function verifyJsonDigest(value: JsonValue, digest: string, path: readonly (string | number)[]): void {
  if (digest !== digestOf(value)) throw invalid("schema.corrupt", "content digest does not match exact JSON", path);
}

export function verifyNullableJsonDigest(
  value: JsonValue | null,
  digest: string | null,
  valuePath: readonly (string | number)[],
  digestPath: readonly (string | number)[],
): void {
  if ((value === null) !== (digest === null)) {
    throw invalid("schema.invalid", "nullable content and digest must be present or null together", valuePath);
  }
  if (value !== null && digest !== null) verifyJsonDigest(value, digest, digestPath);
}
