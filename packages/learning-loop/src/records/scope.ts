// Scope: an ordered hierarchy of host-defined segments (contract §Scope).
// Exact match is the safe default; unknown segment types never inherit.
import { sha256HexOfCanonicalJson } from "../canonical/canonical-json.js";
import { invalid, parseArrayOf, parseNonEmptyText, readFields } from "../parse/toolkit.js";
import type { Parse, ParsePath } from "../parse/toolkit.js";

export interface ScopeSegment {
  readonly type: string;
  readonly id: string;
}

export type Scope = readonly ScopeSegment[];

export interface ScopePolicy {
  readonly id: string;
  readonly digest: string;
  readonly isolationSegmentTypes: readonly string[];

  validate(input: unknown): Scope;
  ancestors(scope: Scope): readonly Scope[];
  comparePrecedence(left: Scope, right: Scope): -1 | 0 | 1;
}

const MAX_SEGMENT_TEXT_LENGTH = 200;

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

const parseSegmentText: Parse<string> = (input, path) => {
  const value = parseNonEmptyText(input, path);
  if (value.length > MAX_SEGMENT_TEXT_LENGTH) {
    throw invalid("schema.invalid", `scope segment text exceeds ${MAX_SEGMENT_TEXT_LENGTH} characters`, path);
  }
  if (containsControlCharacter(value)) {
    throw invalid("schema.invalid", "scope segment text must not contain control characters", path);
  }
  return value;
};

const parseValidatedSegment: Parse<ScopeSegment> = (input, path) => {
  const fields = readFields(input, path);
  const type = fields.req("type", parseSegmentText);
  const id = fields.req("id", parseSegmentText);
  return { type, id };
};

const parseValidatedScope: Parse<Scope> = (input, path) => {
  const segments = parseArrayOf(parseValidatedSegment)(input, path);
  if (segments.length === 0) throw invalid("schema.invalid", "a scope requires at least one segment", path);
  return segments;
};

function canonicalScopeText(scope: Scope): string {
  return JSON.stringify(scope.map((segment) => [segment.type, segment.id]));
}

/**
 * Exact-match scope policy — the conservative default of contract §Scope.
 *
 * - `validate` checks each segment's `type` and `id`: non-empty, at most 200
 *   characters, no control characters. Canonical order is the order given by
 *   the caller; the policy never reorders segments.
 * - `ancestors` always returns no ancestors: under exact matching nothing
 *   inherits, and `isolationSegmentTypes` (recorded and digest-bound) can
 *   therefore never be crossed.
 * - `comparePrecedence` returns 0 only for identical scopes. Otherwise the
 *   ordering is deterministic: a scope with more segments (more specific)
 *   takes precedence (returns 1 when `left` wins); equal-length scopes are
 *   ordered by UTF-16 code-unit comparison of their canonical text.
 */
export function createExactScopePolicy(options?: {
  readonly id?: string;
  readonly isolationSegmentTypes?: readonly string[];
}): ScopePolicy {
  const id = options?.id ?? "scope-exact-v1";
  const isolationSegmentTypes = [...(options?.isolationSegmentTypes ?? [])];
  const digest = sha256HexOfCanonicalJson({ kind: "exact", id, isolationSegmentTypes });
  const rootPath: ParsePath = [];
  return {
    id,
    digest,
    isolationSegmentTypes,
    validate: (input) => parseValidatedScope(input, rootPath),
    ancestors: () => [],
    comparePrecedence: (left, right) => {
      const leftText = canonicalScopeText(left);
      const rightText = canonicalScopeText(right);
      if (leftText === rightText) return 0;
      if (left.length !== right.length) return left.length > right.length ? 1 : -1;
      return leftText > rightText ? 1 : -1;
    },
  };
}
