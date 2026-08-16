// Canonical bytes and digests (contract §Canonical bytes and digests).
// Schema version 1 pins RFC 8785 (JSON Canonicalization Scheme) semantics:
// object keys sorted by UTF-16 code units, values serialized with ECMAScript
// JSON.stringify rules (shortest number rendering; -0 renders "0"; control
// characters escaped, other characters literal), encoded as UTF-8 without a
// byte-order mark, digested with SHA-256, rendered as lower-case hexadecimal.
// Within the validated JsonValue domain, JSON.stringify of primitives is
// exactly the JCS primitive serialization, so no re-implementation is needed.
import { createHash } from "node:crypto";
import type { JsonValue } from "./json.js";

function isJsonArray(value: JsonValue): value is readonly JsonValue[] {
  return Array.isArray(value);
}

export function canonicalJsonText(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (isJsonArray(value)) {
    return `[${value.map((item) => canonicalJsonText(item)).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  const parts: string[] = [];
  for (const key of keys) {
    const child = value[key];
    if (child === undefined) continue; // unreachable for a valid JsonValue; guards indexed access
    parts.push(`${JSON.stringify(key)}:${canonicalJsonText(child)}`);
  }
  return `{${parts.join(",")}}`;
}

export function sha256HexOfCanonicalJson(value: JsonValue): string {
  return createHash("sha256")
    .update(Buffer.from(canonicalJsonText(value), "utf8"))
    .digest("hex");
}
