// Evidence-source port and host registration (contract §Evidence source).
// The host binds each adapter to a trust ceiling and content policy BEFORE
// loop construction; the resulting RegisteredSource<I> capability preserves
// its input type so one source's input cannot be fed to another.
import { sha256HexOfCanonicalJson } from "../canonical/canonical-json.js";
import type { JsonValue } from "../canonical/json.js";
import type { Diagnostic } from "../diagnostics.js";
import { invalid, parseNonEmptyText, parseOneOf } from "../parse/toolkit.js";
import type { ParsePath } from "../parse/toolkit.js";
import type { MetricDefinition, EpisodeOutcome } from "../records/episode.js";
import type { SourceDescriptor, SourcePrivacyPolicyRef, TrustClass, Completeness } from "../records/provenance.js";
import { TRUST_CLASSES } from "../records/provenance.js";
import type { Scope } from "../records/scope.js";
import type { SourcePageState } from "../records/source-health.js";
import { registeredSourceBrand } from "../records/brands.js";

const MAX_SOURCE_ID_LENGTH = 1_000;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

function parseBoundedControlFreeText(input: unknown, path: ParsePath, label: string): string {
  if (typeof input !== "string" || input.length === 0) {
    throw invalid("config.invalid", `${label} must be a non-empty string`, path);
  }
  const value = input;
  if (value.length > MAX_SOURCE_ID_LENGTH) {
    throw invalid("config.invalid", `${label} exceeds ${MAX_SOURCE_ID_LENGTH} characters`, path);
  }
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) {
      throw invalid("config.invalid", `${label} contains a control character`, path);
    }
  }
  return value;
}

function parseSourceId(input: unknown): string {
  return parseBoundedControlFreeText(input, ["source", "descriptor", "id"], "source id");
}

/**
 * An adapter's privacy-policy declaration is an opaque content-addressed
 * reference: a bounded control-free id plus a SHA-256 digest of the policy
 * content. The kernel never sees the policy content itself.
 */
export function parseSourcePrivacyPolicyRef(input: unknown, path: ParsePath): SourcePrivacyPolicyRef {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw invalid("config.invalid", "privacy policy declaration must be an { id, digest } object", path);
  }
  const rawId: unknown = Reflect.get(input, "id");
  const rawDigest: unknown = Reflect.get(input, "digest");
  if (typeof rawId !== "string") {
    throw invalid("config.invalid", "privacy policy declaration requires a string id", [...path, "id"]);
  }
  const id = parseBoundedControlFreeText(rawId, [...path, "id"], "privacy policy id");
  if (typeof rawDigest !== "string" || !DIGEST_PATTERN.test(rawDigest)) {
    throw invalid("config.invalid", "privacy policy digest must be a lowercase SHA-256 hex digest", [
      ...path,
      "digest",
    ]);
  }
  return Object.freeze({ id, digest: rawDigest });
}

export interface ProjectedObservation {
  readonly sourceRecordId: string;
  readonly episodeId: string;
  readonly occurredAt?: string;
  readonly kind: string;
  readonly data: JsonValue;
  readonly completeness: Completeness;
}

export interface ProjectedMeasurement {
  readonly sourceRecordId: string;
  readonly episodeId: string;
  readonly metric: MetricDefinition;
  readonly value: number | string | boolean;
  readonly evidenceSourceRecordIds: readonly string[];
  readonly measuredAt?: string;
}

export interface ProjectedEpisode {
  readonly sourceRecordId: string;
  readonly episodeId: string;
  readonly parentEpisodeId?: string;
  readonly episodeClass?: string;
  readonly completeness?: Completeness;
  readonly scope: Scope;
  readonly openedAt: string;
  readonly closedAt?: string;
  readonly status?: EpisodeOutcome["status"];
  readonly measurementSourceRecordIds: readonly string[];
}

export interface EvidencePage {
  readonly sourceRef: string;
  readonly pageRef: string;
  readonly state: SourcePageState;
  readonly nextCursor?: string;
  readonly observations: readonly ProjectedObservation[];
  readonly measurements: readonly ProjectedMeasurement[];
  readonly episodes: readonly ProjectedEpisode[];
  readonly diagnostics: readonly Diagnostic[];
}

export interface EvidenceSource<I> {
  readonly descriptor: SourceDescriptor;

  probe(input: I): Promise<{
    readonly supported: boolean;
    readonly sourceRevision?: string;
    readonly diagnostics: readonly Diagnostic[];
  }>;

  read(input: I, cursor?: string): AsyncIterable<EvidencePage>;
}

export interface RegisteredSource<I> {
  readonly id: string;
  readonly registryRevision: string;
  readonly trustCeiling: TrustClass;
  readonly contentPolicyId: string;
  readonly [registeredSourceBrand]: I;
}

interface RegisteredSourceBase {
  readonly id: string;
  readonly registryRevision: string;
  readonly trustCeiling: TrustClass;
  readonly contentPolicyId: string;
}

// The brand property is a phantom: its unique symbol carries the input type
// `I` at the type level only, and no runtime value of type `I` exists at
// registration time. The overload below is the sanctioned, cast-free way to
// attach the phantom brand; nothing ever reads the property at runtime.
function withSourceBrand<I>(base: RegisteredSourceBase): RegisteredSource<I>;
function withSourceBrand(base: RegisteredSourceBase): RegisteredSourceBase {
  return base;
}

/**
 * Binds an evidence-source adapter to its host-granted trust ceiling and
 * content policy. `registryRevision` is the SHA-256 of the canonical JSON of
 * `{ sourceId, adapterVersion, trustCeiling, contentPolicyId, maximumTrust?, privacyPolicy? }`,
 * so any change to the adapter version, source self-restriction, declared
 * privacy policy, or host grant is a new registry revision. Omitting the
 * optional members preserves the historical registry bytes.
 */
export function defineSourceRegistration<I>(input: {
  readonly source: EvidenceSource<I>;
  readonly trustCeiling: TrustClass;
  readonly contentPolicyId: string;
}): RegisteredSource<I> {
  const descriptor = input.source.descriptor;
  const id = parseSourceId(descriptor.id);
  if (id.includes("/")) {
    throw invalid("config.invalid", "source id must not contain the reserved '/' separator", [
      "source",
      "descriptor",
      "id",
    ]);
  }
  const adapterVersion = parseNonEmptyText(descriptor.adapterVersion, ["source", "descriptor", "adapterVersion"]);
  const trustCeiling = parseOneOf(TRUST_CLASSES)(input.trustCeiling, ["trustCeiling"]);
  const configuredMaximumTrust = descriptor.maximumTrust;
  const maximumTrust =
    configuredMaximumTrust === undefined
      ? undefined
      : parseOneOf(TRUST_CLASSES)(configuredMaximumTrust, ["source", "descriptor", "maximumTrust"]);
  if (maximumTrust !== undefined && TRUST_CLASSES.indexOf(trustCeiling) > TRUST_CLASSES.indexOf(maximumTrust)) {
    throw invalid("config.invalid", `host trust ceiling ${trustCeiling} exceeds the source maximum ${maximumTrust}`, [
      "trustCeiling",
    ]);
  }
  const contentPolicyId = parseNonEmptyText(input.contentPolicyId, ["contentPolicyId"]);
  const configuredPrivacyPolicy = descriptor.privacyPolicy;
  const privacyPolicy =
    configuredPrivacyPolicy === undefined
      ? undefined
      : parseSourcePrivacyPolicyRef(configuredPrivacyPolicy, ["source", "descriptor", "privacyPolicy"]);
  const registryRevision = sha256HexOfCanonicalJson({
    sourceId: id,
    adapterVersion,
    trustCeiling,
    contentPolicyId,
    ...(maximumTrust !== undefined ? { maximumTrust } : {}),
    ...(privacyPolicy !== undefined ? { privacyPolicy: { id: privacyPolicy.id, digest: privacyPolicy.digest } } : {}),
  });
  return withSourceBrand(
    Object.freeze({
      id,
      registryRevision,
      trustCeiling,
      contentPolicyId,
    }),
  );
}
