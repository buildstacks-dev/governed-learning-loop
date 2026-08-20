// Immutable semantic catalog plus explicit executable selection.
import { sha256HexOfCanonicalJson } from "../canonical/canonical-json.js";
import type { JsonValue } from "../canonical/json.js";
import { toJsonValue } from "../canonical/to-json-value.js";
import { invalid, readFields } from "../parse/toolkit.js";
import type { DetectorPackManifest } from "./detector-pack.js";
import { parseDetectorPackManifest } from "./detector-pack.js";
import type { DetectorRegistration } from "./detector-registration.js";
import { parseDetectorRegistration } from "./detector-registration.js";
import type { LearningLensRegistration } from "./learning-lens.js";
import { parseLearningLensRegistration } from "./learning-lens.js";
import type { DetectorRef, LensRef, PackRef } from "./semantic-shared.js";
import {
  assertSortedUnique,
  assertUniqueRefVersions,
  canonicalKey,
  detectorRefKey,
  lensRefKey,
  MAX_SET_VALUES,
  packRefKey,
  parseBoundedArray,
  parseDetectorRefAt,
  parseDigestAt,
  parseLensRefAt,
  parsePackRefAt,
} from "./semantic-shared.js";
import type { SourceSemanticProfile } from "./source-semantic-profile.js";
import { parseSourceSemanticProfile } from "./source-semantic-profile.js";

export interface SemanticRegistryConfig {
  readonly schemaVersion: 1;
  readonly scopePolicyDigest: string;
  readonly detectors: readonly DetectorRegistration[];
  readonly packs: readonly DetectorPackManifest[];
  readonly lenses: readonly LearningLensRegistration[];
  readonly sourceProfiles: readonly SourceSemanticProfile[];
  readonly selectedDetectorRefs: readonly DetectorRef[];
  readonly selectedPackRefs: readonly PackRef[];
  readonly selectedLensRefs: readonly LensRef[];
  readonly registryDigest: string;
}

function semanticRegistryContent(input: Omit<SemanticRegistryConfig, "schemaVersion" | "registryDigest">): JsonValue {
  return toJsonValue({
    scopePolicyDigest: input.scopePolicyDigest,
    detectors: input.detectors,
    packs: input.packs,
    lenses: input.lenses,
    sourceProfiles: input.sourceProfiles,
    selectedDetectorRefs: input.selectedDetectorRefs,
    selectedPackRefs: input.selectedPackRefs,
    selectedLensRefs: input.selectedLensRefs,
  });
}

export function semanticRegistryDigest(
  input: Omit<SemanticRegistryConfig, "schemaVersion" | "registryDigest">,
): string {
  return sha256HexOfCanonicalJson(semanticRegistryContent(input));
}

function parseDetectorRegistrationAt(input: unknown): DetectorRegistration {
  return parseDetectorRegistration(input);
}

function parseDetectorPackManifestAt(input: unknown): DetectorPackManifest {
  return parseDetectorPackManifest(input);
}

function parseLearningLensRegistrationAt(input: unknown): LearningLensRegistration {
  return parseLearningLensRegistration(input);
}

function parseSourceSemanticProfileAt(input: unknown): SourceSemanticProfile {
  return parseSourceSemanticProfile(input);
}

function exactDetectorRef(registration: DetectorRegistration): DetectorRef {
  return {
    id: registration.id,
    version: registration.version,
    registrationDigest: registration.registrationDigest,
  };
}

function exactPackRef(pack: DetectorPackManifest): PackRef {
  return { id: pack.id, version: pack.version, manifestDigest: pack.manifestDigest };
}

function exactLensRef(lens: LearningLensRegistration): LensRef {
  return { id: lens.id, version: lens.version, registrationDigest: lens.registrationDigest };
}

function sourceProfileKey(profile: SourceSemanticProfile): string {
  return canonicalKey([profile.sourceId, profile.sourceRegistrationRevision, profile.profileDigest]);
}

function exactRefSet<T>(values: readonly T[], keyOf: (value: T) => string): ReadonlySet<string> {
  return new Set(values.map((value) => keyOf(value)));
}

function requireResolvedRef(
  configured: ReadonlySet<string>,
  key: string,
  label: string,
  path: readonly (string | number)[],
): void {
  if (!configured.has(key)) {
    throw invalid("config.invalid", `${label} does not resolve to an exact configured record`, path);
  }
}

export function parseSemanticRegistryConfig(input: unknown): SemanticRegistryConfig {
  const fields = readFields(input, []);
  const schemaVersion = fields.schemaVersion1();
  const scopePolicyDigest = fields.req("scopePolicyDigest", parseDigestAt);
  const detectors = fields.req(
    "detectors",
    parseBoundedArray(parseDetectorRegistrationAt, MAX_SET_VALUES, "detector registrations"),
  );
  assertSortedUnique(detectors, (value) => detectorRefKey(exactDetectorRef(value)), ["detectors"]);
  assertUniqueRefVersions(detectors, ["detectors"]);
  const packs = fields.req(
    "packs",
    parseBoundedArray(parseDetectorPackManifestAt, MAX_SET_VALUES, "detector pack manifests"),
  );
  assertSortedUnique(packs, (value) => packRefKey(exactPackRef(value)), ["packs"]);
  assertUniqueRefVersions(packs, ["packs"]);
  const lenses = fields.req(
    "lenses",
    parseBoundedArray(parseLearningLensRegistrationAt, MAX_SET_VALUES, "learning lens registrations"),
  );
  assertSortedUnique(lenses, (value) => lensRefKey(exactLensRef(value)), ["lenses"]);
  assertUniqueRefVersions(lenses, ["lenses"]);
  const sourceProfiles = fields.req(
    "sourceProfiles",
    parseBoundedArray(parseSourceSemanticProfileAt, MAX_SET_VALUES, "source semantic profiles"),
  );
  assertSortedUnique(sourceProfiles, sourceProfileKey, ["sourceProfiles"]);
  const sourceProfileVersions = new Set<string>();
  for (const [index, profile] of sourceProfiles.entries()) {
    const key = canonicalKey([profile.sourceId, profile.sourceRegistrationRevision]);
    if (sourceProfileVersions.has(key)) {
      throw invalid("config.invalid", "a source registration revision may bind only one semantic profile", [
        "sourceProfiles",
        index,
      ]);
    }
    sourceProfileVersions.add(key);
  }
  const selectedDetectorRefs = fields.req(
    "selectedDetectorRefs",
    parseBoundedArray(parseDetectorRefAt, MAX_SET_VALUES, "selected detector references"),
  );
  assertSortedUnique(selectedDetectorRefs, detectorRefKey, ["selectedDetectorRefs"]);
  assertUniqueRefVersions(selectedDetectorRefs, ["selectedDetectorRefs"]);
  const selectedPackRefs = fields.req(
    "selectedPackRefs",
    parseBoundedArray(parsePackRefAt, MAX_SET_VALUES, "selected pack references"),
  );
  assertSortedUnique(selectedPackRefs, packRefKey, ["selectedPackRefs"]);
  assertUniqueRefVersions(selectedPackRefs, ["selectedPackRefs"]);
  const selectedLensRefs = fields.req(
    "selectedLensRefs",
    parseBoundedArray(parseLensRefAt, MAX_SET_VALUES, "selected lens references"),
  );
  assertSortedUnique(selectedLensRefs, lensRefKey, ["selectedLensRefs"]);
  assertUniqueRefVersions(selectedLensRefs, ["selectedLensRefs"]);

  const detectorRefs = exactRefSet(detectors.map(exactDetectorRef), detectorRefKey);
  const packRefs = exactRefSet(packs.map(exactPackRef), packRefKey);
  const lensRefs = exactRefSet(lenses.map(exactLensRef), lensRefKey);
  const detectorsByRef = new Map(detectors.map((detector) => [detectorRefKey(exactDetectorRef(detector)), detector]));
  const packsByRef = new Map(packs.map((pack) => [packRefKey(exactPackRef(pack)), pack]));

  for (const [index, detector] of detectors.entries()) {
    if (detector.scopePolicyDigest !== scopePolicyDigest) {
      throw invalid("config.invalid", "detector scope policy does not match the semantic registry", [
        "detectors",
        index,
        "scopePolicyDigest",
      ]);
    }
    if (detector.lensConstraint.mode === "required" && detector.lensConstraint.selection === "allowlist") {
      for (const [lensIndex, reference] of detector.lensConstraint.registrations.entries()) {
        requireResolvedRef(lensRefs, lensRefKey(reference), "detector lens allowlist reference", [
          "detectors",
          index,
          "lensConstraint",
          "registrations",
          lensIndex,
        ]);
      }
    }
  }
  for (const [index, lens] of lenses.entries()) {
    if (lens.scopePolicyDigest !== scopePolicyDigest) {
      throw invalid("config.invalid", "learning lens scope policy does not match the semantic registry", [
        "lenses",
        index,
        "scopePolicyDigest",
      ]);
    }
  }
  for (const [packIndex, pack] of packs.entries()) {
    for (const [index, reference] of pack.detectors.entries()) {
      requireResolvedRef(detectorRefs, detectorRefKey(reference), "pack detector reference", [
        "packs",
        packIndex,
        "detectors",
        index,
      ]);
      const detector = detectorsByRef.get(detectorRefKey(reference));
      if (detector?.maturity === "deprecated") {
        throw invalid("config.invalid", "detector packs cannot contain deprecated detectors", [
          "packs",
          packIndex,
          "detectors",
          index,
        ]);
      }
    }
    for (const [index, reference] of pack.lenses.entries()) {
      requireResolvedRef(lensRefs, lensRefKey(reference), "pack lens reference", ["packs", packIndex, "lenses", index]);
    }
  }
  for (const [index, reference] of selectedPackRefs.entries()) {
    requireResolvedRef(packRefs, packRefKey(reference), "selected pack reference", ["selectedPackRefs", index]);
  }
  for (const [index, reference] of selectedDetectorRefs.entries()) {
    const key = detectorRefKey(reference);
    requireResolvedRef(detectorRefs, key, "selected detector reference", ["selectedDetectorRefs", index]);
    if (detectorsByRef.get(key)?.maturity === "deprecated") {
      throw invalid("config.invalid", "deprecated detectors cannot be selected", ["selectedDetectorRefs", index]);
    }
  }
  for (const [index, reference] of selectedLensRefs.entries()) {
    requireResolvedRef(lensRefs, lensRefKey(reference), "selected lens reference", ["selectedLensRefs", index]);
  }

  const selectedPacks = selectedPackRefs
    .map((reference) => packsByRef.get(packRefKey(reference)))
    .filter((pack): pack is DetectorPackManifest => pack !== undefined);
  const selectedPackDetectorRefs = new Set(selectedPacks.flatMap((pack) => pack.detectors.map(detectorRefKey)));
  const selectedPackLensRefs = new Set(selectedPacks.flatMap((pack) => pack.lenses.map(lensRefKey)));
  for (const [index, reference] of selectedDetectorRefs.entries()) {
    if (!selectedPackDetectorRefs.has(detectorRefKey(reference))) {
      throw invalid("config.invalid", "selected detector is not a member of a selected pack", [
        "selectedDetectorRefs",
        index,
      ]);
    }
  }
  for (const [index, reference] of selectedLensRefs.entries()) {
    if (!selectedPackLensRefs.has(lensRefKey(reference))) {
      throw invalid("config.invalid", "selected lens is not a member of a selected pack", ["selectedLensRefs", index]);
    }
  }
  const selectedLensKeys = new Set(selectedLensRefs.map(lensRefKey));
  for (const [index, reference] of selectedDetectorRefs.entries()) {
    const detector = detectorsByRef.get(detectorRefKey(reference));
    if (detector === undefined || detector.outputKind !== "insight_derivation") continue;
    const constraint = detector.lensConstraint;
    const compatibleLensKeys = new Set(
      constraint.mode !== "required"
        ? []
        : constraint.selection === "any_registered"
          ? selectedLensKeys
          : constraint.registrations.map(lensRefKey).filter((key) => selectedLensKeys.has(key)),
    );
    const hasBackingPack = selectedPacks.some(
      (pack) =>
        pack.detectors.some((member) => detectorRefKey(member) === detectorRefKey(reference)) &&
        pack.lenses.some((member) => compatibleLensKeys.has(lensRefKey(member))),
    );
    if (!hasBackingPack) {
      throw invalid(
        "config.invalid",
        "selected insight detector has no selected pack containing both it and a compatible selected lens",
        ["selectedDetectorRefs", index],
      );
    }
  }

  const base = {
    scopePolicyDigest,
    detectors,
    packs,
    lenses,
    sourceProfiles,
    selectedDetectorRefs,
    selectedPackRefs,
    selectedLensRefs,
  };
  const registryDigest = fields.req("registryDigest", parseDigestAt);
  if (registryDigest !== semanticRegistryDigest(base)) {
    throw invalid("schema.corrupt", "semantic registry digest does not match its bound fields", ["registryDigest"]);
  }
  return { schemaVersion, ...base, registryDigest };
}
