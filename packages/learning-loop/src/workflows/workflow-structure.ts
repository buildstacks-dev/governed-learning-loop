// Iterative resource preflight for untrusted semantic workflow JSON. This runs
// before recursive canonicalization so excessive nesting fails with a static
// diagnostic instead of a raw runtime stack overflow.
import { invalid, readFields } from "../parse/toolkit.js";
import type { FieldReader, Parse, ParsePath } from "../parse/toolkit.js";
import { Buffer } from "node:buffer";
import type { JsonValue } from "../canonical/json.js";

export const SEMANTIC_WORKFLOW_MAX_STRUCTURE_DEPTH = 100;
export const SEMANTIC_WORKFLOW_MAX_STRUCTURE_NODES = 100_000;

type StructureFrame =
  | { readonly kind: "visit"; readonly value: unknown; readonly depth: number }
  | { readonly kind: "leave"; readonly value: object };

function isPlainRecord(input: unknown): input is Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return false;
  try {
    const prototype = Object.getPrototypeOf(input);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function descriptorValue(descriptor: PropertyDescriptor | undefined): unknown {
  if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined) {
    throw invalid("schema.invalid", "semantic workflow values cannot contain accessor properties", []);
  }
  return descriptor.value;
}

function ownDescriptors(input: object, path: ParsePath): PropertyDescriptorMap {
  try {
    return Object.getOwnPropertyDescriptors(input);
  } catch {
    throw invalid("schema.invalid", "semantic workflow value cannot be inspected safely", path);
  }
}

function assertNoAccessors(descriptors: PropertyDescriptorMap): void {
  for (const descriptor of Object.values(descriptors)) descriptorValue(descriptor);
}

/**
 * Takes one shallow, inert snapshot of the enumerable own data fields that can
 * participate in canonical object bytes. Unknown accessors are ignored; a
 * known accessor, inherited field, or non-enumerable field is therefore
 * absent rather than invoked or smuggled into parsed bytes.
 */
export function readSemanticWorkflowFields(input: unknown, path: ParsePath): FieldReader {
  if (!isPlainRecord(input)) throw invalid("schema.invalid", "semantic workflow value must be an object", path);
  const snapshot: Record<string, unknown> = {};
  const descriptors = ownDescriptors(input, path);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (descriptor.enumerable === true && descriptor.get === undefined && descriptor.set === undefined) {
      snapshot[key] = descriptor.value;
    }
  }
  return readFields(snapshot, path);
}

/** Takes one own-data snapshot of bounded array elements before parsing. */
export function parseSemanticWorkflowArray<T>(parse: Parse<T>, maximum: number, label: string): Parse<readonly T[]> {
  return (input, path) => {
    if (!Array.isArray(input)) throw invalid("schema.invalid", `${label} must be an array`, path);
    const descriptors = ownDescriptors(input, path);
    const length = descriptorValue(descriptors.length);
    if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0) {
      throw invalid("schema.invalid", `${label} has an invalid length`, path);
    }
    if (length > maximum) throw invalid("schema.invalid", `${label} exceeds ${maximum} entries`, path);
    const snapshot: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined) {
        throw invalid("schema.invalid", "semantic workflow array elements must be own data properties", [
          ...path,
          index,
        ]);
      }
      snapshot.push(descriptor.value);
    }
    return snapshot.map((value, index) => parse(value, [...path, index]));
  };
}

export function assertSemanticWorkflowStructureBound(
  input: unknown,
  maximumScalarBytes = Number.MAX_SAFE_INTEGER,
): void {
  const stack: StructureFrame[] = [{ kind: "visit", value: input, depth: 0 }];
  const active = new Set<object>();
  let nodes = 0;
  let scalarBytes = 0;
  while (stack.length > 0) {
    const frame = stack.pop();
    if (frame === undefined) continue;
    if (frame.kind === "leave") {
      active.delete(frame.value);
      continue;
    }
    nodes += 1;
    if (nodes > SEMANTIC_WORKFLOW_MAX_STRUCTURE_NODES || frame.depth > SEMANTIC_WORKFLOW_MAX_STRUCTURE_DEPTH) {
      throw invalid("semantic.workflow_limit", "semantic workflow structure exceeds its hard ceiling", []);
    }
    const value = frame.value;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      scalarBytes += Buffer.byteLength(String(value), "utf8");
      if (scalarBytes > maximumScalarBytes) {
        throw invalid("semantic.workflow_limit", "semantic workflow scalar bytes exceed their hard ceiling", []);
      }
    }
    if (Array.isArray(value)) {
      if (active.has(value)) throw invalid("schema.invalid", "cyclic semantic workflow value is invalid", []);
      const descriptors = ownDescriptors(value, []);
      const length = descriptorValue(descriptors.length);
      if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0) {
        throw invalid("schema.invalid", "semantic workflow array length is invalid", []);
      }
      if (length > SEMANTIC_WORKFLOW_MAX_STRUCTURE_NODES - nodes) {
        throw invalid("semantic.workflow_limit", "semantic workflow structure exceeds its hard ceiling", []);
      }
      assertNoAccessors(descriptors);
      active.add(value);
      stack.push({ kind: "leave", value });
      for (let index = length - 1; index >= 0; index -= 1) {
        const descriptor = descriptors[String(index)];
        stack.push({ kind: "visit", value: descriptorValue(descriptor), depth: frame.depth + 1 });
      }
      continue;
    }
    if (!isPlainRecord(value)) continue;
    if (active.has(value)) throw invalid("schema.invalid", "cyclic semantic workflow value is invalid", []);
    const descriptors = ownDescriptors(value, []);
    const keys = Object.entries(descriptors)
      .filter((entry) => entry[1].enumerable === true)
      .map((entry) => entry[0]);
    for (const key of keys) scalarBytes += Buffer.byteLength(key, "utf8");
    if (scalarBytes > maximumScalarBytes) {
      throw invalid("semantic.workflow_limit", "semantic workflow scalar bytes exceed their hard ceiling", []);
    }
    if (keys.length > SEMANTIC_WORKFLOW_MAX_STRUCTURE_NODES - nodes) {
      throw invalid("semantic.workflow_limit", "semantic workflow structure exceeds its hard ceiling", []);
    }
    assertNoAccessors(descriptors);
    active.add(value);
    stack.push({ kind: "leave", value });
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      const key = keys[index];
      if (key !== undefined) {
        stack.push({ kind: "visit", value: descriptorValue(descriptors[key]), depth: frame.depth + 1 });
      }
    }
  }
}

function canonicalStringByteLength(value: string): number {
  let bytes = 2;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (
      code === 0x22 ||
      code === 0x5c ||
      code === 0x08 ||
      code === 0x09 ||
      code === 0x0a ||
      code === 0x0c ||
      code === 0x0d
    ) {
      bytes += 2;
      continue;
    }
    if (code < 0x20) {
      bytes += 6;
      continue;
    }
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 6;
      }
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      bytes += 6;
      continue;
    }
    bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : 3;
  }
  return bytes;
}

function assertNoSymbolProperties(descriptors: PropertyDescriptorMap): void {
  if (Reflect.ownKeys(descriptors).some((key) => typeof key === "symbol")) {
    throw invalid("schema.invalid", "semantic workflow JSON cannot contain symbol properties", []);
  }
}

/** Descriptor-snapshots untrusted JSON exactly once while enforcing hard canonical-byte bounds. */
export function snapshotSemanticWorkflowJson(input: unknown, maximumCanonicalBytes: number): JsonValue {
  const active = new Set<object>();
  let nodes = 0;
  let canonicalBytes = 0;
  const addBytes = (bytes: number): void => {
    canonicalBytes += bytes;
    if (canonicalBytes > maximumCanonicalBytes) {
      throw invalid(
        "semantic.workflow_response_limit",
        "semantic workflow canonical bytes exceed their hard ceiling",
        [],
      );
    }
  };
  const visit = (value: unknown, depth: number): JsonValue => {
    nodes += 1;
    if (nodes > SEMANTIC_WORKFLOW_MAX_STRUCTURE_NODES || depth > SEMANTIC_WORKFLOW_MAX_STRUCTURE_DEPTH) {
      throw invalid("semantic.workflow_limit", "semantic workflow structure exceeds its hard ceiling", []);
    }
    if (value === null) {
      addBytes(4);
      return value;
    }
    if (typeof value === "boolean") {
      addBytes(value ? 4 : 5);
      return value;
    }
    if (typeof value === "string") {
      addBytes(canonicalStringByteLength(value));
      return value;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw invalid("schema.invalid", "semantic workflow number must be finite", []);
      addBytes(Buffer.byteLength(JSON.stringify(value), "utf8"));
      return value;
    }
    if (Array.isArray(value)) {
      if (active.has(value)) throw invalid("schema.invalid", "cyclic semantic workflow value is invalid", []);
      const descriptors = ownDescriptors(value, []);
      const length = descriptorValue(descriptors.length);
      if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0) {
        throw invalid("schema.invalid", "semantic workflow array length is invalid", []);
      }
      if (length > SEMANTIC_WORKFLOW_MAX_STRUCTURE_NODES - nodes) {
        throw invalid("semantic.workflow_limit", "semantic workflow structure exceeds its hard ceiling", []);
      }
      assertNoSymbolProperties(descriptors);
      assertNoAccessors(descriptors);
      addBytes(2 + Math.max(0, length - 1));
      active.add(value);
      try {
        const result: JsonValue[] = [];
        for (let index = 0; index < length; index += 1) {
          result.push(visit(descriptorValue(descriptors[String(index)]), depth + 1));
        }
        return result;
      } finally {
        active.delete(value);
      }
    }
    if (!isPlainRecord(value)) throw invalid("schema.invalid", "semantic workflow value is not JSON", []);
    if (active.has(value)) throw invalid("schema.invalid", "cyclic semantic workflow value is invalid", []);
    const descriptors = ownDescriptors(value, []);
    assertNoSymbolProperties(descriptors);
    const keys = Object.entries(descriptors)
      .filter((entry) => entry[1].enumerable === true)
      .map((entry) => entry[0]);
    if (keys.length > SEMANTIC_WORKFLOW_MAX_STRUCTURE_NODES - nodes) {
      throw invalid("semantic.workflow_limit", "semantic workflow structure exceeds its hard ceiling", []);
    }
    assertNoAccessors(descriptors);
    addBytes(2 + Math.max(0, keys.length - 1));
    active.add(value);
    try {
      const result: Record<string, JsonValue> = {};
      for (const key of keys) {
        addBytes(canonicalStringByteLength(key) + 1);
        result[key] = visit(descriptorValue(descriptors[key]), depth + 1);
      }
      return result;
    } finally {
      active.delete(value);
    }
  };
  return visit(input, 0);
}
