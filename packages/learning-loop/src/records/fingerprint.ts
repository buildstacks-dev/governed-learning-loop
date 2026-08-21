// System fingerprint (contract §Fingerprint and experiment; decision 0028).
// A fingerprint is a digest of named, canonical host components — package
// version, repository state, model, effort, prompts, tools, policy, budget,
// configuration — without making any of those fields universal. The digest
// is order-independent: components are sorted by name before digesting and
// names must be unique, so two hosts that describe the same system in a
// different order produce the same digest. An experiment binds the control
// and treatment fingerprint digests before any result exists and the replay
// executor attests the digest it ran under; the kernel compares digests and
// never inspects component content.
import { sha256HexOfCanonicalJson } from "../canonical/canonical-json.js";
import type { JsonValue } from "../canonical/json.js";
import { invalid, readFields } from "../parse/toolkit.js";
import type { Parse, ParsePath } from "../parse/toolkit.js";
import { parseBoundedArray, parseDigestAt, parseId } from "./semantic-shared.js";

export interface FingerprintComponent {
  readonly name: string;
  readonly version?: string;
  readonly digest: string;
}

export interface SystemFingerprint {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly components: readonly FingerprintComponent[];
  readonly digest: string;
}

/** Components per fingerprint; a larger host description fails closed. */
export const MAX_FINGERPRINT_COMPONENTS = 1_000;

const FINGERPRINT_DIGEST_DOMAIN = "system-fingerprint:v1";

const parseComponentAt: Parse<FingerprintComponent> = (input, path) => {
  const fields = readFields(input, path);
  const version = fields.opt("version", parseId);
  return {
    name: fields.req("name", parseId),
    ...(version !== undefined ? { version } : {}),
    digest: fields.req("digest", parseDigestAt),
  };
};

function assertUniqueNames(components: readonly FingerprintComponent[], path: ParsePath): void {
  const seen = new Set<string>();
  for (const [index, component] of components.entries()) {
    if (seen.has(component.name)) {
      throw invalid("schema.invalid", "fingerprint component names must be unique", [...path, index, "name"]);
    }
    seen.add(component.name);
  }
}

function componentContent(component: FingerprintComponent): JsonValue {
  return {
    name: component.name,
    ...(component.version !== undefined ? { version: component.version } : {}),
    digest: component.digest,
  };
}

/**
 * Order-independent fingerprint digest: the components sorted by name under a
 * domain-separation tag. Names must be unique.
 */
export function systemFingerprintDigest(components: readonly FingerprintComponent[]): string {
  assertUniqueNames(components, ["components"]);
  const sorted = [...components].sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  return sha256HexOfCanonicalJson({ domain: FINGERPRINT_DIGEST_DOMAIN, components: sorted.map(componentContent) });
}

/** Unknown-first parser: at least one component, unique names, and a digest that matches the components. */
export function parseSystemFingerprint(input: unknown): SystemFingerprint {
  const fields = readFields(input, []);
  const schemaVersion = fields.schemaVersion1();
  const components = fields.req(
    "components",
    parseBoundedArray(parseComponentAt, MAX_FINGERPRINT_COMPONENTS, "fingerprint components"),
  );
  if (components.length === 0) {
    throw invalid("schema.invalid", "a system fingerprint requires at least one component", ["components"]);
  }
  assertUniqueNames(components, ["components"]);
  const digest = fields.req("digest", parseDigestAt);
  if (digest !== systemFingerprintDigest(components)) {
    throw invalid("schema.corrupt", "system fingerprint digest does not match its components", ["digest"]);
  }
  return { schemaVersion, id: fields.req("id", parseId), components, digest };
}
