import type { JsonValue } from "../canonical/json.js";
import type { RegisteredDetectorImplementation } from "../engine/detector-implementation.js";
import type { DetectorPackManifest } from "../records/detector-pack.js";
import type { DetectorRegistration } from "../records/detector-registration.js";
import type { LearningLensRegistration } from "../records/learning-lens.js";

export type ReferenceDetectorFamily =
  | "coordination_attribution_integrity"
  | "repeated_status_polling"
  | "context_pressure_compaction"
  | "tool_use_concentration"
  | "coordination_fanout"
  | "attributed_human_redirection";

export interface ReferenceDetectorFixtureDescriptor {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly detectorFamily: ReferenceDetectorFamily;
  readonly control: "positive" | "negative";
  readonly complexLegitimate: boolean;
  readonly input: JsonValue;
  readonly expected: { readonly conditionDetected: boolean };
  readonly fixtureDigest: string;
}

export interface ReferenceDetectorPackFragment {
  readonly pack: DetectorPackManifest;
  readonly detectors: readonly DetectorRegistration[];
  readonly implementations: readonly RegisteredDetectorImplementation[];
}

export interface ReferenceDetectorSourceRequirement {
  readonly detectorId: string;
  readonly requiredCapabilities: readonly string[];
  readonly acceptedObservationKinds: readonly string[];
}

export interface ReferenceDetectorBundle {
  readonly schemaVersion: 1;
  readonly catalogVersion: "0.1.0";
  readonly registrationNamespace: string;
  readonly hostBindingDigest: string;
  readonly scopePolicyDigest: string;
  readonly lenses: readonly LearningLensRegistration[];
  readonly sourceRequirements: {
    readonly observationVocabularyDigest: string;
    readonly detectors: readonly ReferenceDetectorSourceRequirement[];
  };
  readonly coreStructural: ReferenceDetectorPackFragment;
  readonly referenceOperational: ReferenceDetectorPackFragment;
  readonly fixtures: readonly ReferenceDetectorFixtureDescriptor[];
}
