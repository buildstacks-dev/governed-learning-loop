// Host-bound declaration of the normalized semantic vocabulary a source may emit.
import { sha256HexOfCanonicalJson } from "../canonical/canonical-json.js";
import type { JsonValue } from "../canonical/json.js";
import { toJsonValue } from "../canonical/to-json-value.js";
import { invalid, readFields } from "../parse/toolkit.js";
import { assertSortedUnique, MAX_SET_VALUES, parseBoundedArray, parseDigestAt, parseId } from "./semantic-shared.js";

export interface SourceSemanticProfile {
  readonly schemaVersion: 1;
  readonly sourceId: string;
  readonly sourceRegistrationRevision: string;
  readonly observationVocabularyDigest: string;
  readonly capabilities: readonly string[];
  readonly observationKinds: readonly string[];
  readonly profileDigest: string;
}

function sourceSemanticProfileContent(
  input: Omit<SourceSemanticProfile, "schemaVersion" | "profileDigest">,
): JsonValue {
  return toJsonValue({
    sourceId: input.sourceId,
    sourceRegistrationRevision: input.sourceRegistrationRevision,
    observationVocabularyDigest: input.observationVocabularyDigest,
    capabilities: input.capabilities,
    observationKinds: input.observationKinds,
  });
}

export function sourceSemanticProfileDigest(
  input: Omit<SourceSemanticProfile, "schemaVersion" | "profileDigest">,
): string {
  return sha256HexOfCanonicalJson(sourceSemanticProfileContent(input));
}

export function parseSourceSemanticProfile(input: unknown): SourceSemanticProfile {
  const fields = readFields(input, []);
  const schemaVersion = fields.schemaVersion1();
  const capabilities = fields.req(
    "capabilities",
    parseBoundedArray(parseId, MAX_SET_VALUES, "source semantic capabilities"),
  );
  assertSortedUnique(capabilities, (value) => value, ["capabilities"]);
  const observationKinds = fields.req(
    "observationKinds",
    parseBoundedArray(parseId, MAX_SET_VALUES, "source observation kinds"),
  );
  assertSortedUnique(observationKinds, (value) => value, ["observationKinds"]);
  const sourceId = fields.req("sourceId", parseId);
  if (sourceId.includes("/")) {
    throw invalid("schema.invalid", "source semantic profile id contains the reserved durable-id separator", [
      "sourceId",
    ]);
  }
  const base = {
    sourceId,
    sourceRegistrationRevision: fields.req("sourceRegistrationRevision", parseDigestAt),
    observationVocabularyDigest: fields.req("observationVocabularyDigest", parseDigestAt),
    capabilities,
    observationKinds,
  };
  const profileDigest = fields.req("profileDigest", parseDigestAt);
  if (profileDigest !== sourceSemanticProfileDigest(base)) {
    throw invalid("schema.corrupt", "source semantic profile digest does not match its bound fields", [
      "profileDigest",
    ]);
  }
  return { schemaVersion, ...base, profileDigest };
}
