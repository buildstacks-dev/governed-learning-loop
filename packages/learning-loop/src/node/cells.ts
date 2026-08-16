// Durable cell documents: the on-disk JSON (one document per line, JSON
// Lines-compatible) for records, streams, and tombstones, plus the
// per-namespace meta counters. Everything read from disk crosses as `unknown`
// and is shape-validated; any parse or shape failure surfaces as a typed
// LearningLoopError with code `store.corrupt` — never undefined, never an
// empty record, never a pass.
import { sha256HexOfCanonicalJson } from "../canonical/canonical-json.js";
import type { JsonValue } from "../canonical/json.js";
import { LearningLoopError } from "../diagnostics.js";
import {
  invalid,
  type Parse,
  parseArrayOf,
  parseFiniteNumber,
  parseJson,
  parseNonEmptyText,
  parseOneOf,
  parseText,
  readFields,
} from "../parse/toolkit.js";
import type { RecordKey, StoredRecord, StreamEntry } from "../ports/store.js";

export interface RecordCell {
  readonly form: "record";
  readonly key: RecordKey;
  readonly value: JsonValue;
  readonly digest: string;
  readonly revision: number;
  readonly lastOperationId: string;
  readonly insertionIndex: number;
}

export interface StreamCell {
  readonly form: "stream";
  readonly key: RecordKey;
  readonly entries: readonly StreamEntry[];
  readonly revision: number;
  readonly lastOperationId: string;
  readonly insertionIndex: number;
}

export interface TombstoneCell {
  readonly form: "tombstone";
  readonly key: RecordKey;
  readonly reasonCode: string;
  readonly revision: number;
  readonly lastOperationId: string;
  readonly insertionIndex: number;
}

export type Cell = RecordCell | StreamCell | TombstoneCell;

export interface NamespaceMeta {
  readonly nextInsertionIndex: number;
  readonly writeCount: number;
}

export function corruptStoreFile(filePath: string, detail: string): LearningLoopError {
  return new LearningLoopError("store.corrupt", [
    { code: "store.corrupt", severity: "error", message: `corrupt store file ${filePath}: ${detail}` },
  ]);
}

const parseIndex: Parse<number> = (input, path) => {
  const value = parseFiniteNumber(input, path);
  if (!Number.isInteger(value) || value < 0) {
    throw invalid("schema.invalid", `expected a non-negative integer, got ${String(value)}`, path);
  }
  return value;
};

const parseKey: Parse<RecordKey> = (input, path) => {
  const fields = readFields(input, path);
  return {
    namespace: fields.req("namespace", parseNonEmptyText),
    kind: fields.req("kind", parseNonEmptyText),
    id: fields.req("id", parseNonEmptyText),
  };
};

const parseEntry: Parse<StreamEntry> = (input, path) => {
  const fields = readFields(input, path);
  return {
    id: fields.req("id", parseNonEmptyText),
    digest: fields.req("digest", parseText),
    value: fields.req("value", parseJson),
  };
};

function parseCell(input: unknown): Cell {
  const fields = readFields(input, []);
  fields.schemaVersion1();
  const form = fields.req("form", parseOneOf(["record", "stream", "tombstone"] as const));
  const key = fields.req("key", parseKey);
  const revision = fields.req("revision", parseIndex);
  const lastOperationId = fields.req("lastOperationId", parseText);
  const insertionIndex = fields.req("insertionIndex", parseIndex);
  if (form === "record") {
    return {
      form,
      key,
      revision,
      lastOperationId,
      insertionIndex,
      value: fields.req("value", parseJson),
      digest: fields.req("digest", parseText),
    };
  }
  if (form === "stream") {
    return {
      form,
      key,
      revision,
      lastOperationId,
      insertionIndex,
      entries: fields.req("entries", parseArrayOf(parseEntry)),
    };
  }
  return { form, key, revision, lastOperationId, insertionIndex, reasonCode: fields.req("reasonCode", parseText) };
}

function parseJsonText(text: string, filePath: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw corruptStoreFile(filePath, `not valid JSON (${detail})`);
  }
}

export function parseCellText(text: string, filePath: string): Cell {
  const raw = parseJsonText(text, filePath);
  try {
    return parseCell(raw);
  } catch (error) {
    if (error instanceof LearningLoopError) throw corruptStoreFile(filePath, error.message);
    throw error;
  }
}

export function parseMetaText(text: string, filePath: string): NamespaceMeta {
  const raw = parseJsonText(text, filePath);
  try {
    const fields = readFields(raw, []);
    fields.schemaVersion1();
    return {
      nextInsertionIndex: fields.req("nextInsertionIndex", parseIndex),
      writeCount: fields.req("writeCount", parseIndex),
    };
  } catch (error) {
    if (error instanceof LearningLoopError) throw corruptStoreFile(filePath, error.message);
    throw error;
  }
}

export function serializeCell(cell: Cell): string {
  const common = {
    schemaVersion: 1,
    form: cell.form,
    key: { namespace: cell.key.namespace, kind: cell.key.kind, id: cell.key.id },
    revision: cell.revision,
    lastOperationId: cell.lastOperationId,
    insertionIndex: cell.insertionIndex,
  };
  if (cell.form === "record") return `${JSON.stringify({ ...common, value: cell.value, digest: cell.digest })}\n`;
  if (cell.form === "stream") return `${JSON.stringify({ ...common, entries: cell.entries })}\n`;
  return `${JSON.stringify({ ...common, reasonCode: cell.reasonCode })}\n`;
}

export function serializeMeta(meta: NamespaceMeta): string {
  return `${JSON.stringify({ schemaVersion: 1, nextInsertionIndex: meta.nextInsertionIndex, writeCount: meta.writeCount })}\n`;
}

export function streamDigest(entries: readonly StreamEntry[]): string {
  return sha256HexOfCanonicalJson(entries.map((entry) => entry.id));
}

export function toStoredRecord(cell: RecordCell | StreamCell): StoredRecord {
  if (cell.form === "record") {
    return { key: cell.key, value: cell.value, revision: String(cell.revision), digest: cell.digest };
  }
  return {
    key: cell.key,
    value: cell.entries.map((entry) => ({ id: entry.id, digest: entry.digest, value: entry.value })),
    revision: String(cell.revision),
    digest: streamDigest(cell.entries),
  };
}
