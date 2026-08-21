// Host destination registrations, parsed and snapshotted once at loop
// construction (contract §Publication destination; decision 0024). The host
// owns effect class, risk floor, permitted target patterns, authorization
// rule, and content policy; adapter code cannot change them later. The
// registration digest contributes to the loop registry revision and to every
// plan's lineage; an `authority` destination must declare the T3 floor.
import { sha256HexOfCanonicalJson } from "../canonical/canonical-json.js";
import { invalid } from "../parse/toolkit.js";
import type { Parse, ParsePath } from "../parse/toolkit.js";
import type { Candidate, RiskTier } from "../records/candidate.js";
import type { DestinationRegistration } from "../ports/destination.js";
import type { EffectClass, PreparedEffect } from "../records/publication.js";
import { EFFECT_CLASSES } from "../records/publication.js";

const RISK_TIERS = ["T0", "T1", "T2", "T3"] as const;
const MAX_TARGET_PATTERNS = 100;
const MAX_TARGET_PATTERN_LENGTH = 200;
const MAX_CONFIG_ID_LENGTH = 1_000;
const REGISTRATION_DIGEST_DOMAIN = "destination-registration:v1";

export interface BoundDestination {
  readonly id: string;
  readonly effectClass: EffectClass;
  readonly riskFloor: RiskTier;
  readonly permittedTargetPatterns: readonly string[];
  readonly authorizationRuleId: string;
  readonly contentPolicyId: string;
  readonly registrationDigest: string;
  prepare(input: { readonly candidate: Candidate; readonly expectedBase?: string }): Promise<unknown>;
  applyEffect(input: { readonly effect: PreparedEffect; readonly idempotencyKey: string }): Promise<unknown>;
}

// Registration failures are construction errors (`config.invalid`), never
// record-schema failures: the host composed the loop wrongly.
function parseConfigText(maximumLength: number, label: string): Parse<string> {
  return (input, path) => {
    if (typeof input !== "string" || input.length === 0) {
      throw invalid("config.invalid", `${label} must be a non-empty string`, path);
    }
    if (input.length > maximumLength) {
      throw invalid("config.invalid", `${label} exceeds ${maximumLength} characters`, path);
    }
    for (const character of input) {
      const code = character.codePointAt(0) ?? 0;
      if (code < 0x20 || code === 0x7f) {
        throw invalid("config.invalid", `${label} contains a control character`, path);
      }
    }
    return input;
  };
}

const parseConfigId = parseConfigText(MAX_CONFIG_ID_LENGTH, "identifier");
const parseTargetPattern = parseConfigText(MAX_TARGET_PATTERN_LENGTH, "target pattern");

function parseConfigChoice<T extends string>(values: readonly T[]): Parse<T> {
  return (input, path) => {
    const match = values.find((value) => value === input);
    if (match === undefined) {
      throw invalid("config.invalid", `expected one of ${values.join(" | ")}`, path);
    }
    return match;
  };
}

/** Digest over exactly the host-owned registration fields; adapter behavior is excluded. */
export function destinationRegistrationDigest(input: {
  readonly destinationId: string;
  readonly effectClass: EffectClass;
  readonly riskFloor: RiskTier;
  readonly permittedTargetPatterns: readonly string[];
  readonly authorizationRuleId: string;
  readonly contentPolicyId: string;
}): string {
  return sha256HexOfCanonicalJson({
    domain: REGISTRATION_DIGEST_DOMAIN,
    destinationId: input.destinationId,
    effectClass: input.effectClass,
    riskFloor: input.riskFloor,
    permittedTargetPatterns: [...input.permittedTargetPatterns],
    authorizationRuleId: input.authorizationRuleId,
    contentPolicyId: input.contentPolicyId,
  });
}

/**
 * `*` matches any run of characters other than `/`; every other character is
 * literal. Evaluated as a bounded dynamic program so a hostile pattern cannot
 * trigger backtracking blow-up.
 */
export function targetMatchesPattern(target: string, pattern: string): boolean {
  let previous: boolean[] = new Array<boolean>(pattern.length + 1).fill(false);
  previous[0] = true;
  for (let column = 1; column <= pattern.length; column += 1) {
    previous[column] = pattern[column - 1] === "*" && previous[column - 1] === true;
  }
  for (let row = 1; row <= target.length; row += 1) {
    const current: boolean[] = new Array<boolean>(pattern.length + 1).fill(false);
    const targetCharacter = target[row - 1];
    for (let column = 1; column <= pattern.length; column += 1) {
      const patternCharacter = pattern[column - 1];
      if (patternCharacter === "*") {
        current[column] = current[column - 1] === true || (previous[column] === true && targetCharacter !== "/");
      } else {
        current[column] = previous[column - 1] === true && patternCharacter === targetCharacter;
      }
    }
    previous = current;
  }
  return previous[pattern.length] === true;
}

export function targetPermitted(target: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => targetMatchesPattern(target, pattern));
}

/** Parses one host registration from `unknown`-shaped caller input and captures adapter behavior once. */
export function bindDestinationRegistration(input: DestinationRegistration, path: ParsePath): BoundDestination {
  const unknownInput: unknown = input;
  if (typeof unknownInput !== "object" || unknownInput === null) {
    throw invalid("config.invalid", "destination registration must be an object", path);
  }
  const adapter = input.adapter;
  const unknownAdapter: unknown = adapter;
  if (typeof unknownAdapter !== "object" || unknownAdapter === null) {
    throw invalid("config.invalid", "destination registration requires an adapter object", [...path, "adapter"]);
  }
  const id = parseConfigId(adapter.id, [...path, "adapter", "id"]);
  const prepare = adapter.prepare;
  const applyEffect = adapter.applyEffect;
  if (typeof prepare !== "function" || typeof applyEffect !== "function") {
    throw invalid("config.invalid", "destination adapter must implement prepare and applyEffect", [...path, "adapter"]);
  }
  const effectClass = parseConfigChoice(EFFECT_CLASSES)(input.effectClass, [...path, "effectClass"]);
  const riskFloor = parseConfigChoice(RISK_TIERS)(input.riskFloor, [...path, "riskFloor"]);
  if (effectClass === "authority" && riskFloor !== "T3") {
    throw invalid("config.invalid", "an authority destination must declare the T3 risk floor", [...path, "riskFloor"]);
  }
  const rawPatterns: unknown = input.permittedTargetPatterns;
  if (!Array.isArray(rawPatterns)) {
    throw invalid("config.invalid", "target patterns must be an array", [...path, "permittedTargetPatterns"]);
  }
  if (rawPatterns.length > MAX_TARGET_PATTERNS) {
    throw invalid("config.invalid", `target patterns exceeds ${MAX_TARGET_PATTERNS} entries`, [
      ...path,
      "permittedTargetPatterns",
    ]);
  }
  const permittedTargetPatterns = rawPatterns.map((pattern: unknown, index: number) =>
    parseTargetPattern(pattern, [...path, "permittedTargetPatterns", index]),
  );
  if (permittedTargetPatterns.length === 0) {
    throw invalid("config.invalid", "a destination must permit at least one target pattern", [
      ...path,
      "permittedTargetPatterns",
    ]);
  }
  if (new Set(permittedTargetPatterns).size !== permittedTargetPatterns.length) {
    throw invalid("config.invalid", "target patterns must be unique", [...path, "permittedTargetPatterns"]);
  }
  const authorizationRuleId = parseConfigId(input.authorizationRuleId, [...path, "authorizationRuleId"]);
  const contentPolicyId = parseConfigId(input.contentPolicyId, [...path, "contentPolicyId"]);
  const registrationDigest = destinationRegistrationDigest({
    destinationId: id,
    effectClass,
    riskFloor,
    permittedTargetPatterns,
    authorizationRuleId,
    contentPolicyId,
  });
  const boundPrepare = prepare.bind(adapter);
  const boundApplyEffect = applyEffect.bind(adapter);
  const bound: BoundDestination = {
    id,
    effectClass,
    riskFloor,
    permittedTargetPatterns: Object.freeze([...permittedTargetPatterns]),
    authorizationRuleId,
    contentPolicyId,
    registrationDigest,
    prepare: (request) => boundPrepare(request),
    applyEffect: (request) => boundApplyEffect(request),
  };
  return Object.freeze(bound);
}
