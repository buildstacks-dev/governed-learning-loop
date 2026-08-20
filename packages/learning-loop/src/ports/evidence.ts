// Evidence-source port and host registration (contract §Evidence source).
// The host binds each adapter to a trust ceiling and content policy BEFORE
// loop construction; the resulting RegisteredSource<I> capability preserves
// its input type so one source's input cannot be fed to another.
import { sha256HexOfCanonicalJson } from "../canonical/canonical-json.js";
import type { JsonValue } from "../canonical/json.js";
import type { Diagnostic } from "../diagnostics.js";
import { invalid, parseNonEmptyText, parseOneOf } from "../parse/toolkit.js";
import type { MetricDefinition, EpisodeOutcome } from "../records/episode.js";
import type { SourceDescriptor, TrustClass, Completeness } from "../records/provenance.js";
import { TRUST_CLASSES } from "../records/provenance.js";
import type { Scope } from "../records/scope.js";
import { registeredSourceBrand } from "../records/brands.js";

const MAX_SOURCE_ID_LENGTH = 1_000;

function parseSourceId(input: unknown): string {
  const path = ["source", "descriptor", "id"] as const;
  const value = parseNonEmptyText(input, path);
  if (value.length > MAX_SOURCE_ID_LENGTH) {
    throw invalid("config.invalid", `source id exceeds ${MAX_SOURCE_ID_LENGTH} characters`, path);
  }
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) {
      throw invalid("config.invalid", "source id contains a control character", path);
    }
  }
  return value;
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
  readonly sourceRevision: string;
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
 * `{ sourceId, adapterVersion, trustCeiling, contentPolicyId }`, so any change
 * to the adapter version or the host grant is a new registry revision.
 */
export function defineSourceRegistration<I>(input: {
  readonly source: EvidenceSource<I>;
  readonly trustCeiling: TrustClass;
  readonly contentPolicyId: string;
}): RegisteredSource<I> {
  const id = parseSourceId(input.source.descriptor.id);
  if (id.includes("/")) {
    throw invalid("config.invalid", "source id must not contain the reserved '/' separator", [
      "source",
      "descriptor",
      "id",
    ]);
  }
  const adapterVersion = parseNonEmptyText(input.source.descriptor.adapterVersion, [
    "source",
    "descriptor",
    "adapterVersion",
  ]);
  const trustCeiling = parseOneOf(TRUST_CLASSES)(input.trustCeiling, ["trustCeiling"]);
  const contentPolicyId = parseNonEmptyText(input.contentPolicyId, ["contentPolicyId"]);
  const registryRevision = sha256HexOfCanonicalJson({
    sourceId: id,
    adapterVersion,
    trustCeiling,
    contentPolicyId,
  });
  return withSourceBrand({
    id,
    registryRevision,
    trustCeiling,
    contentPolicyId,
  });
}
