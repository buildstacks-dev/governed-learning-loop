// Immutable host policy that can only tighten detector-pack safety ceilings.
import { sha256HexOfCanonicalJson } from "../canonical/canonical-json.js";
import { toJsonValue } from "../canonical/to-json-value.js";
import { invalid, parseFiniteNumber, parseOneOf, readFields } from "../parse/toolkit.js";
import type { Parse } from "../parse/toolkit.js";
import { parseDigestAt, parseId, parseSemVer } from "./semantic-shared.js";

export interface DetectorOrchestrationPolicy {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly version: string;
  readonly caps: {
    readonly maximumInvocationsPerRun: number;
    readonly maximumInsightGroupsPerRun: number;
    readonly maximumEvidenceHealthGroupsPerRun: number;
  };
  readonly rejectionSuppression:
    | { readonly mode: "disabled" }
    | {
        readonly mode: "evidence_multiplier";
        readonly minimumDistinctEpisodeMultiplier: number;
      };
  readonly policyDigest: string;
}

function parseSafeInteger(minimum: number, maximum: number, label: string): Parse<number> {
  return (input, path) => {
    const value = parseFiniteNumber(input, path);
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
      throw invalid("schema.invalid", `${label} must be an integer from ${minimum} through ${maximum}`, path);
    }
    return value;
  };
}

function policyContent(input: Omit<DetectorOrchestrationPolicy, "schemaVersion" | "policyDigest">): unknown {
  return {
    id: input.id,
    version: input.version,
    caps: input.caps,
    rejectionSuppression: input.rejectionSuppression,
  };
}

export function detectorOrchestrationPolicyDigest(
  input: Omit<DetectorOrchestrationPolicy, "schemaVersion" | "policyDigest">,
): string {
  return sha256HexOfCanonicalJson(toJsonValue(policyContent(input)));
}

export function parseDetectorOrchestrationPolicy(input: unknown): DetectorOrchestrationPolicy {
  const fields = readFields(input, []);
  const schemaVersion = fields.schemaVersion1();
  const capsFields = readFields(
    fields.req("caps", (value) => value),
    ["caps"],
  );
  const caps = {
    maximumInvocationsPerRun: capsFields.req(
      "maximumInvocationsPerRun",
      parseSafeInteger(1, 100, "maximum invocations per run"),
    ),
    maximumInsightGroupsPerRun: capsFields.req(
      "maximumInsightGroupsPerRun",
      parseSafeInteger(0, 100, "maximum insight groups per run"),
    ),
    maximumEvidenceHealthGroupsPerRun: capsFields.req(
      "maximumEvidenceHealthGroupsPerRun",
      parseSafeInteger(0, 100, "maximum evidence-health groups per run"),
    ),
  };
  const suppressionFields = readFields(
    fields.req("rejectionSuppression", (value) => value),
    ["rejectionSuppression"],
  );
  const mode = suppressionFields.req("mode", parseOneOf(["disabled", "evidence_multiplier"]));
  const rejectionSuppression =
    mode === "disabled"
      ? { mode: "disabled" as const }
      : {
          mode: "evidence_multiplier" as const,
          minimumDistinctEpisodeMultiplier: suppressionFields.req(
            "minimumDistinctEpisodeMultiplier",
            parseSafeInteger(2, 100, "minimum distinct-episode multiplier"),
          ),
        };
  const base = {
    id: fields.req("id", parseId),
    version: fields.req("version", parseSemVer),
    caps,
    rejectionSuppression,
  };
  const policyDigest = fields.req("policyDigest", parseDigestAt);
  if (policyDigest !== detectorOrchestrationPolicyDigest(base)) {
    throw invalid("schema.corrupt", "detector orchestration policy digest does not match its content", [
      "policyDigest",
    ]);
  }
  return { schemaVersion, ...base, policyDigest };
}
