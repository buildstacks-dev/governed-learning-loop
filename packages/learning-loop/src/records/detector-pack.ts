// Immutable detector-pack availability manifest. Installation grants no authority.
import { sha256HexOfCanonicalJson } from "../canonical/canonical-json.js";
import type { JsonValue } from "../canonical/json.js";
import { toJsonValue } from "../canonical/to-json-value.js";
import { invalid, parseOneOf, readFields } from "../parse/toolkit.js";
import type { DetectorRef, LensRef, PackRef } from "./semantic-shared.js";
import {
  assertSortedUnique,
  assertUniqueRefVersions,
  detectorRefKey,
  lensRefKey,
  MAX_SET_VALUES,
  parseBoundedArray,
  parseDetectorRefAt,
  parseDigestAt,
  parseId,
  parseLensRefAt,
  parseNullable,
  parsePackRefAt,
  parseSemVer,
} from "./semantic-shared.js";

const PACK_KINDS = ["core_structural", "reference_operational", "host"] as const;

export interface DetectorPackManifest {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly version: string;
  readonly kind: (typeof PACK_KINDS)[number];
  readonly detectors: readonly DetectorRef[];
  readonly lenses: readonly LensRef[];
  readonly changelogDigest: string;
  readonly supersedes: PackRef | null;
  readonly manifestDigest: string;
}

function packManifestContent(input: Omit<DetectorPackManifest, "schemaVersion" | "manifestDigest">): JsonValue {
  return toJsonValue({
    id: input.id,
    version: input.version,
    kind: input.kind,
    detectors: input.detectors,
    lenses: input.lenses,
    changelogDigest: input.changelogDigest,
    supersedes: input.supersedes,
  });
}

export function detectorPackManifestDigest(
  input: Omit<DetectorPackManifest, "schemaVersion" | "manifestDigest">,
): string {
  return sha256HexOfCanonicalJson(packManifestContent(input));
}

export function parseDetectorPackManifest(input: unknown): DetectorPackManifest {
  const fields = readFields(input, []);
  const schemaVersion = fields.schemaVersion1();
  const id = fields.req("id", parseId);
  const version = fields.req("version", parseSemVer);
  const detectors = fields.req("detectors", parseBoundedArray(parseDetectorRefAt, MAX_SET_VALUES, "detectors"));
  const lenses = fields.req("lenses", parseBoundedArray(parseLensRefAt, MAX_SET_VALUES, "lenses"));
  if (detectors.length === 0) {
    throw invalid("schema.invalid", "detector pack must contain at least one detector", ["detectors"]);
  }
  assertSortedUnique(detectors, detectorRefKey, ["detectors"]);
  assertSortedUnique(lenses, lensRefKey, ["lenses"]);
  assertUniqueRefVersions(detectors, ["detectors"]);
  assertUniqueRefVersions(lenses, ["lenses"]);
  const supersedes = fields.req("supersedes", parseNullable(parsePackRefAt));
  if (supersedes !== null && (supersedes.id !== id || supersedes.version === version)) {
    throw invalid("schema.invalid", "pack supersession must reference another version of the same id", ["supersedes"]);
  }
  const base = {
    id,
    version,
    kind: fields.req("kind", parseOneOf(PACK_KINDS)),
    detectors,
    lenses,
    changelogDigest: fields.req("changelogDigest", parseDigestAt),
    supersedes,
  };
  const manifestDigest = fields.req("manifestDigest", parseDigestAt);
  const manifest: DetectorPackManifest = { schemaVersion, ...base, manifestDigest };
  if (manifestDigest !== detectorPackManifestDigest(base)) {
    throw invalid("schema.corrupt", "detector pack manifest digest does not match its bound fields", [
      "manifestDigest",
    ]);
  }
  return manifest;
}
