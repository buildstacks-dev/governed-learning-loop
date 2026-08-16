// Path mapping and confinement for the Node filesystem store (issue #4).
// Every namespace, kind, and id becomes exactly one path component: bytes
// outside [A-Za-z0-9._-] (and any leading dot) are %XX-escaped byte-wise,
// the escaped text is truncated, and a 16-hex-digit SHA-256 prefix of the raw
// component is appended. The mapping is injective, case-exact even on
// case-insensitive filesystems, and a component can never be ".", "..",
// start with a dot, or contain a separator — traversal is structurally
// impossible before any filesystem call happens.
import { createHash } from "node:crypto";
import { isAbsolute, join, relative, sep } from "node:path";
import { LearningLoopError } from "../diagnostics.js";
import type { RecordKey } from "../ports/store.js";

const ESCAPED_PREFIX_LIMIT = 64;

function invalidComponent(label: string): LearningLoopError {
  return new LearningLoopError("schema.invalid", [
    { code: "schema.invalid", severity: "error", message: `${label} must be a non-empty string` },
  ]);
}

function isSafeByte(byte: number, index: number): boolean {
  if (byte >= 0x30 && byte <= 0x39) return true; // 0-9
  if (byte >= 0x41 && byte <= 0x5a) return true; // A-Z
  if (byte >= 0x61 && byte <= 0x7a) return true; // a-z
  if (byte === 0x5f || byte === 0x2d) return true; // _ -
  if (byte === 0x2e) return index > 0; // "." is safe except as the first byte
  return false;
}

export function escapeComponent(raw: string, label: string): string {
  if (raw.length === 0) throw invalidComponent(label);
  const bytes = Buffer.from(raw, "utf8");
  let escaped = "";
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index];
    if (byte === undefined) break;
    escaped += isSafeByte(byte, index)
      ? String.fromCharCode(byte)
      : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  const digest = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
  return `${escaped.slice(0, ESCAPED_PREFIX_LIMIT)}.${digest}`;
}

export function namespaceDir(root: string, namespace: string): string {
  return join(root, "ns", escapeComponent(namespace, "namespace"));
}

export function kindDir(root: string, namespace: string, kind: string): string {
  return join(namespaceDir(root, namespace), escapeComponent(kind, "kind"));
}

export function recordFile(root: string, key: RecordKey): string {
  return join(kindDir(root, key.namespace, key.kind), `${escapeComponent(key.id, "id")}.json`);
}

export function metaFile(root: string, namespace: string): string {
  return join(namespaceDir(root, namespace), ".meta.json");
}

/** Defense in depth behind the structural escaping: is `candidate` inside `root`? */
export function isConfined(root: string, candidate: string): boolean {
  const relation = relative(root, candidate);
  if (relation === "") return true;
  if (isAbsolute(relation)) return false;
  return relation !== ".." && !relation.startsWith(`..${sep}`);
}
