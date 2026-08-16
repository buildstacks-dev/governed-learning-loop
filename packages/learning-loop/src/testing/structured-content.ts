// Structured content policy for tests and examples: accepts structured
// JsonValue data (validated from `unknown`), enforces a byte ceiling on the
// canonical bytes, and forbids outbound use. The digest binds the policy id
// and its enforcement parameters.
import { Buffer } from "node:buffer";
import { canonicalJsonText, sha256HexOfCanonicalJson } from "../canonical/canonical-json.js";
import { toJsonValue } from "../canonical/to-json-value.js";
import { LearningLoopError } from "../diagnostics.js";
import type { ContentPolicy } from "../records/provenance.js";

const MAXIMUM_INPUT_BYTES = 262_144;

export function createStructuredContentPolicy(options: { readonly id: string }): ContentPolicy {
  const { id } = options;
  return {
    id,
    digest: sha256HexOfCanonicalJson({
      kind: "structured",
      id,
      maximumInputBytes: MAXIMUM_INPUT_BYTES,
      outboundUse: "forbidden",
    }),
    maximumInputBytes: MAXIMUM_INPUT_BYTES,
    outboundUse: "forbidden",
    transform: async (input: unknown) => {
      const accepted = toJsonValue(input);
      const bytes = Buffer.byteLength(canonicalJsonText(accepted), "utf8");
      if (bytes > MAXIMUM_INPUT_BYTES) {
        throw new LearningLoopError("policy.blocked", [
          {
            code: "policy.blocked",
            severity: "error",
            message: `content policy "${id}" rejects ${bytes} canonical bytes (ceiling ${MAXIMUM_INPUT_BYTES})`,
            details: { bytes, maximumInputBytes: MAXIMUM_INPUT_BYTES },
          },
        ]);
      }
      return { accepted, classification: "structured", diagnostics: [] };
    },
  };
}
