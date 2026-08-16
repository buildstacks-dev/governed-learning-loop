// Host-owned content policy for transcript observations. The adapters already
// minimize aggressively (structural features only, never message text), so
// this policy's job is defense in depth: validate the data is plain JSON,
// enforce a byte ceiling, and forbid outbound use.
import { Buffer } from "node:buffer";
import type { ContentPolicy, Diagnostic } from "@cormidia/learning-loop";
import { canonicalJsonText, sha256HexOfCanonicalJson, toJsonValue } from "@cormidia/learning-loop";

export const TRANSCRIPT_CONTENT_POLICY_ID = "transcript-structural-v1";

// Transcript observation payloads are tiny structural records; anything near
// this ceiling is drift worth refusing loudly rather than storing.
const MAXIMUM_INPUT_BYTES = 65_536;

export function createTranscriptContentPolicy(): ContentPolicy {
  const policy: ContentPolicy = {
    id: TRANSCRIPT_CONTENT_POLICY_ID,
    digest: sha256HexOfCanonicalJson({
      kind: "transcript-structural",
      id: TRANSCRIPT_CONTENT_POLICY_ID,
      maximumInputBytes: MAXIMUM_INPUT_BYTES,
      outboundUse: "forbidden",
    }),
    maximumInputBytes: MAXIMUM_INPUT_BYTES,
    outboundUse: "forbidden",
    transform: (input: unknown) => {
      const accepted = toJsonValue(input);
      const bytes = Buffer.byteLength(canonicalJsonText(accepted), "utf8");
      if (bytes > MAXIMUM_INPUT_BYTES) {
        const diagnostics: readonly Diagnostic[] = [
          {
            code: "policy.blocked",
            severity: "error",
            message: `observation data of ${bytes} canonical bytes exceeds the ${MAXIMUM_INPUT_BYTES}-byte ceiling`,
            details: { bytes, maximumInputBytes: MAXIMUM_INPUT_BYTES },
          },
        ];
        return Promise.resolve({ accepted: null, classification: "refused", diagnostics });
      }
      return Promise.resolve({ accepted, classification: "transcript-structural", diagnostics: [] });
    },
  };
  return policy;
}
