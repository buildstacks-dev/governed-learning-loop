// createFileStore — a durable, multi-process-safe LearningStore over the
// local filesystem (issue #4; contract §Storage). Layout, all under rootDir:
//   ns/<ns>/<kind>/<id>.json   one cell document (record | stream | tombstone)
//   ns/<ns>/.meta.json         per-namespace insertion + write counters
//   *.lock                     per-key / per-meta exclusive lock files
// Writes are temp-file → fsync → link (exclusive creation: exactly one racer
// wins) or → rename (replacement, under the key lock, with lock ownership
// re-verified immediately before the rename). Reads open with O_NOFOLLOW and
// re-check realpath confinement, so symlinks into or out of the root are
// refused. Semantics mirror the in-memory reference store exactly; the
// public conformance suite runs unchanged. Listing builds one validated,
// insertion-ordered path catalog per namespace and reuses it while the
// namespace write counter and kind-directory identities stay unchanged. A
// cursor page therefore reopens only records at/after that cursor instead of
// rereading every cell in the namespace. Lock ordering: a key lock may acquire
// the namespace meta lock, never the reverse — no cycles.
import { mkdir, readdir, realpath, rename, stat, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { JsonValue } from "../canonical/json.js";
import { toJsonValue } from "../canonical/to-json-value.js";
import { LearningLoopError } from "../diagnostics.js";
import type { LearningStore, RecordKey, StoredRecord, StreamEntry, WriteResult } from "../ports/store.js";
import {
  type Cell,
  corruptStoreFile,
  type NamespaceMeta,
  parseCellText,
  parseMetaText,
  type RecordCell,
  serializeCell,
  serializeMeta,
  type StreamCell,
  type TombstoneCell,
  toStoredRecord,
} from "./cells.js";
import {
  fsErrorCode,
  fsyncDirBestEffort,
  pathKind,
  publishExclusive,
  readNoFollow,
  temporaryName,
  writeDurable,
} from "./fs-util.js";
import { acquireLock, type LockHandle, type LockOptions, releaseLock, verifyLock } from "./locks.js";
import { isConfined, kindDir, metaFile, namespaceDir, recordFile } from "./paths.js";

export interface FileStoreOptions {
  /** Directory that will contain every byte the store writes. Created on demand. */
  readonly rootDir: string;
  /** How long a held lock stays valid before a contender may take it over. Default 10_000. */
  readonly lockTtlMs?: number;
  /** How long a mutation waits for a busy lock before failing with `store.unavailable`. Default 10_000. */
  readonly lockTimeoutMs?: number;
}

function invalidQuery(message: string): LearningLoopError {
  return new LearningLoopError("schema.invalid", [{ code: "schema.invalid", severity: "error", message }]);
}

function conflictWith(cell: Cell): WriteResult {
  return { status: "conflict", revision: String(cell.revision) };
}

function createOutcome(existing: Cell, digest: string): WriteResult {
  if (existing.form === "record" && existing.digest === digest) {
    return { status: "exists_same", revision: String(existing.revision) };
  }
  return conflictWith(existing);
}

function copyKey(key: RecordKey): RecordKey {
  return { namespace: key.namespace, kind: key.kind, id: key.id };
}

function copyEntry(entry: StreamEntry): StreamEntry {
  return { id: entry.id, digest: entry.digest, value: toJsonValue(entry.value) };
}

interface CatalogEntry {
  readonly key: RecordKey;
  readonly insertionIndex: number;
}

interface NamespaceCatalog {
  readonly writeCount: number;
  readonly directorySignature: string;
  readonly all: readonly CatalogEntry[];
  readonly byKind: ReadonlyMap<string, readonly CatalogEntry[]>;
}

export function createFileStore(options: FileStoreOptions): LearningStore {
  const root = resolve(options.rootDir);
  const catalogs = new Map<string, NamespaceCatalog>();
  const lockOptions: LockOptions = {
    ttlMs: options.lockTtlMs ?? 10_000,
    timeoutMs: options.lockTimeoutMs ?? 10_000,
  };

  /**
   * realpath-based confinement: resolves `dirPath` and requires it to stay
   * inside the resolved root. Returns undefined when the directory (or the
   * root) does not exist yet; throws `store.corrupt` when a symlink smuggles
   * the directory outside the root.
   */
  async function confinedRealDir(dirPath: string): Promise<string | undefined> {
    let real: string;
    try {
      real = await realpath(dirPath);
    } catch (error) {
      const code = fsErrorCode(error);
      if (code === "ENOENT" || code === "ENOTDIR") return undefined;
      throw error;
    }
    let realRoot: string;
    try {
      realRoot = await realpath(root);
    } catch (error) {
      if (fsErrorCode(error) === "ENOENT") return undefined;
      throw error;
    }
    if (!isConfined(realRoot, real)) {
      throw corruptStoreFile(dirPath, "directory resolves outside the store root; refusing to follow");
    }
    return real;
  }

  async function readCellAt(filePath: string): Promise<Cell | undefined> {
    if ((await confinedRealDir(dirname(filePath))) === undefined) return undefined;
    const read = await readNoFollow(filePath);
    if (read.outcome === "missing") return undefined;
    if (read.outcome === "symlink") {
      throw corruptStoreFile(filePath, "record path is a symbolic link; refusing to follow");
    }
    if (read.outcome === "not-regular") throw corruptStoreFile(filePath, "record path is not a regular file");
    return parseCellText(read.text, filePath);
  }

  async function readMeta(namespace: string): Promise<NamespaceMeta> {
    const filePath = metaFile(root, namespace);
    const read = await readNoFollow(filePath);
    if (read.outcome === "missing") return { nextInsertionIndex: 0, writeCount: 0 };
    if (read.outcome === "symlink")
      throw corruptStoreFile(filePath, "meta path is a symbolic link; refusing to follow");
    if (read.outcome === "not-regular") throw corruptStoreFile(filePath, "meta path is not a regular file");
    return parseMetaText(read.text, filePath);
  }

  async function ensureDir(dirPath: string): Promise<void> {
    await mkdir(dirPath, { recursive: true });
    if ((await confinedRealDir(dirPath)) === undefined) {
      throw corruptStoreFile(dirPath, "directory vanished while preparing a write");
    }
  }

  /** Replace the file's content atomically; the lock is re-verified first. */
  async function commitReplace(lock: LockHandle, filePath: string, data: string): Promise<void> {
    const dir = dirname(filePath);
    const temporaryPath = join(dir, temporaryName());
    await writeDurable(temporaryPath, data);
    try {
      await verifyLock(lock); // an expired or usurped holder must not commit
      await rename(temporaryPath, filePath);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
    await fsyncDirBestEffort(dir);
  }

  /** Publish a brand-new cell; returns false when another writer won the race. */
  async function commitCreate(filePath: string, data: string): Promise<boolean> {
    const dir = dirname(filePath);
    const temporaryPath = join(dir, temporaryName());
    await writeDurable(temporaryPath, data);
    const published = await publishExclusive(temporaryPath, filePath);
    if (published) await fsyncDirBestEffort(dir);
    return published;
  }

  /**
   * Bump the namespace write counter (and reserve the next insertion index)
   * under the namespace meta lock. Reserved indices lost to a create race
   * become harmless gaps; the write counter may over-count by the same races.
   */
  async function reserveWrite(namespace: string, reserveIndex: boolean): Promise<number> {
    await ensureDir(namespaceDir(root, namespace));
    const filePath = metaFile(root, namespace);
    const lock = await acquireLock(`${filePath}.lock`, lockOptions);
    try {
      const meta = await readMeta(namespace);
      const updated: NamespaceMeta = {
        nextInsertionIndex: meta.nextInsertionIndex + (reserveIndex ? 1 : 0),
        writeCount: meta.writeCount + 1,
      };
      await commitReplace(lock, filePath, serializeMeta(updated));
      return meta.nextInsertionIndex;
    } finally {
      await releaseLock(lock);
    }
  }

  async function get(key: RecordKey): Promise<StoredRecord | undefined> {
    const filePath = recordFile(root, key);
    const cell = await readCellAt(filePath);
    if (cell === undefined || cell.form === "tombstone") return undefined;
    if (cell.key.namespace !== key.namespace || cell.key.kind !== key.kind || cell.key.id !== key.id) {
      throw corruptStoreFile(filePath, "stored key does not match the requested key");
    }
    return toStoredRecord(cell);
  }

  async function create(key: RecordKey, value: JsonValue, digest: string, operationId: string): Promise<WriteResult> {
    const filePath = recordFile(root, key);
    const existing = await readCellAt(filePath);
    if (existing !== undefined) return createOutcome(existing, digest);
    await ensureDir(dirname(filePath));
    const insertionIndex = await reserveWrite(key.namespace, true);
    const cell: RecordCell = {
      form: "record",
      key: copyKey(key),
      value: toJsonValue(value),
      digest,
      revision: 1,
      lastOperationId: operationId,
      insertionIndex,
    };
    if (await commitCreate(filePath, serializeCell(cell))) return { status: "created", revision: "1" };
    const winner = await readCellAt(filePath);
    if (winner === undefined) return { status: "conflict" };
    return createOutcome(winner, digest);
  }

  async function compareAndSet(
    key: RecordKey,
    expectedRevision: string,
    value: JsonValue,
    digest: string,
    operationId: string,
  ): Promise<WriteResult> {
    const filePath = recordFile(root, key);
    if ((await readCellAt(filePath)) === undefined) return { status: "conflict" };
    const lock = await acquireLock(`${filePath}.lock`, lockOptions);
    try {
      const cell = await readCellAt(filePath);
      if (cell === undefined) return { status: "conflict" };
      if (cell.form !== "record") return conflictWith(cell);
      if (String(cell.revision) === expectedRevision) {
        const updated: RecordCell = {
          ...cell,
          value: toJsonValue(value),
          digest,
          revision: cell.revision + 1,
          lastOperationId: operationId,
        };
        await reserveWrite(key.namespace, false);
        await commitReplace(lock, filePath, serializeCell(updated));
        return { status: "updated", revision: String(updated.revision) };
      }
      if (cell.lastOperationId === operationId && cell.digest === digest) {
        return { status: "exists_same", revision: String(cell.revision) };
      }
      return conflictWith(cell);
    } finally {
      await releaseLock(lock);
    }
  }

  async function append(
    stream: RecordKey,
    expectedRevision: string | undefined,
    entries: readonly StreamEntry[],
    operationId: string,
  ): Promise<WriteResult> {
    const filePath = recordFile(root, stream);
    if (expectedRevision !== undefined && (await readCellAt(filePath)) === undefined) {
      return { status: "conflict" };
    }
    await ensureDir(dirname(filePath));
    const lock = await acquireLock(`${filePath}.lock`, lockOptions);
    try {
      const cell = await readCellAt(filePath);
      if (cell === undefined) {
        if (expectedRevision !== undefined) return { status: "conflict" };
        const insertionIndex = await reserveWrite(stream.namespace, true);
        const created: StreamCell = {
          form: "stream",
          key: copyKey(stream),
          entries: entries.map(copyEntry),
          revision: 1,
          lastOperationId: operationId,
          insertionIndex,
        };
        if (await commitCreate(filePath, serializeCell(created))) return { status: "created", revision: "1" };
        const winner = await readCellAt(filePath); // lost to a concurrent create()
        if (winner === undefined) return { status: "conflict" };
        return conflictWith(winner);
      }
      if (cell.form !== "stream") return conflictWith(cell);
      if (cell.lastOperationId === operationId) return { status: "exists_same", revision: String(cell.revision) };
      if (expectedRevision !== String(cell.revision)) return conflictWith(cell);
      const knownIds = new Set(cell.entries.map((entry) => entry.id));
      if (entries.some((entry) => knownIds.has(entry.id))) return conflictWith(cell);
      const updated: StreamCell = {
        ...cell,
        entries: [...cell.entries, ...entries.map(copyEntry)],
        revision: cell.revision + 1,
        lastOperationId: operationId,
      };
      await reserveWrite(stream.namespace, false);
      await commitReplace(lock, filePath, serializeCell(updated));
      return { status: "updated", revision: String(updated.revision) };
    } finally {
      await releaseLock(lock);
    }
  }

  async function tombstone(input: {
    readonly key: RecordKey;
    readonly expectedRevision: string;
    readonly reasonCode: string;
    readonly operationId: string;
  }): Promise<WriteResult> {
    const filePath = recordFile(root, input.key);
    if ((await readCellAt(filePath)) === undefined) return { status: "conflict" };
    const lock = await acquireLock(`${filePath}.lock`, lockOptions);
    try {
      const cell = await readCellAt(filePath);
      if (cell === undefined) return { status: "conflict" };
      if (cell.form === "tombstone") {
        if (cell.lastOperationId === input.operationId) {
          return { status: "exists_same", revision: String(cell.revision) };
        }
        return conflictWith(cell);
      }
      if (String(cell.revision) !== input.expectedRevision) return conflictWith(cell);
      const dead: TombstoneCell = {
        form: "tombstone",
        key: cell.key,
        reasonCode: input.reasonCode,
        revision: cell.revision + 1,
        lastOperationId: input.operationId,
        insertionIndex: cell.insertionIndex,
      };
      await reserveWrite(input.key.namespace, false);
      await commitReplace(lock, filePath, serializeCell(dead));
      return { status: "updated", revision: String(dead.revision) };
    } finally {
      await releaseLock(lock);
    }
  }

  async function collectKindDirs(nsDir: string, namespace: string, kind: string | undefined): Promise<string[]> {
    if (kind !== undefined) {
      const dir = kindDir(root, namespace, kind);
      const state = await pathKind(dir);
      if (state === "missing") return [];
      if (state === "symlink") throw corruptStoreFile(dir, "kind directory is a symbolic link; refusing to follow");
      if (state !== "directory") throw corruptStoreFile(dir, "kind path is not a directory");
      return [dir];
    }
    const dirs: string[] = [];
    for (const entry of await readdir(nsDir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const entryPath = join(nsDir, entry.name);
      if (entry.isSymbolicLink()) {
        throw corruptStoreFile(entryPath, "kind directory is a symbolic link; refusing to follow");
      }
      if (entry.isDirectory()) dirs.push(entryPath);
    }
    return dirs.sort();
  }

  async function directorySignature(dirs: readonly string[]): Promise<string> {
    const parts: string[] = [];
    for (const dir of dirs) {
      const details = await stat(dir, { bigint: true });
      if (!details.isDirectory()) throw corruptStoreFile(dir, "kind path is not a directory");
      parts.push(`${dir}\0${String(details.dev)}\0${String(details.ino)}\0${String(details.mtimeNs)}`);
    }
    return parts.join("\n");
  }

  async function scanCatalog(nsDir: string, meta: NamespaceMeta, dirs: readonly string[]): Promise<NamespaceCatalog> {
    const entries: CatalogEntry[] = [];
    for (const dir of dirs) {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (entry.name.startsWith(".") || !entry.name.endsWith(".json")) continue;
        const filePath = join(dir, entry.name);
        if (entry.isSymbolicLink()) {
          throw corruptStoreFile(filePath, "record path is a symbolic link; refusing to follow");
        }
        if (!entry.isFile()) throw corruptStoreFile(filePath, "record path is not a regular file");
        const read = await readNoFollow(filePath);
        if (read.outcome === "missing") continue; // no code path deletes record files
        if (read.outcome !== "ok") throw corruptStoreFile(filePath, "record path is not a regular readable file");
        const cell = parseCellText(read.text, filePath);
        if (recordFile(root, cell.key) !== filePath) {
          throw corruptStoreFile(filePath, "stored key does not match its location");
        }
        entries.push({ key: copyKey(cell.key), insertionIndex: cell.insertionIndex });
      }
    }
    entries.sort((left, right) => left.insertionIndex - right.insertionIndex);
    for (let index = 1; index < entries.length; index += 1) {
      const previous = entries[index - 1];
      const current = entries[index];
      if (previous !== undefined && current !== undefined && previous.insertionIndex === current.insertionIndex) {
        throw corruptStoreFile(nsDir, `duplicate insertion index ${String(current.insertionIndex)}`);
      }
    }
    const byKind = new Map<string, CatalogEntry[]>();
    for (const entry of entries) {
      const kindEntries = byKind.get(entry.key.kind) ?? [];
      kindEntries.push(entry);
      byKind.set(entry.key.kind, kindEntries);
    }
    return {
      writeCount: meta.writeCount,
      directorySignature: await directorySignature(dirs),
      all: entries,
      byKind,
    };
  }

  async function catalogFor(
    nsDir: string,
    namespace: string,
  ): Promise<{
    readonly catalog: NamespaceCatalog;
    readonly meta: NamespaceMeta;
  }> {
    // A stable scan is normally immediate. If another process publishes a
    // cell while the catalog is being built, retry so the cached view never
    // treats a half-observed directory as current. Continuous writers do not
    // starve readers: the third scan is returned uncached and the next page
    // checks the namespace again.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const metaBefore = await readMeta(namespace);
      const dirsBefore = await collectKindDirs(nsDir, namespace, undefined);
      const signatureBefore = await directorySignature(dirsBefore);
      const cached = catalogs.get(namespace);
      if (cached !== undefined && cached.writeCount === metaBefore.writeCount) {
        if (cached.directorySignature === signatureBefore) return { catalog: cached, meta: metaBefore };
      }

      const scanned = await scanCatalog(nsDir, metaBefore, dirsBefore);
      const metaAfter = await readMeta(namespace);
      const dirsAfter = await collectKindDirs(nsDir, namespace, undefined);
      const signatureAfter = await directorySignature(dirsAfter);
      const stable =
        metaBefore.writeCount === metaAfter.writeCount &&
        signatureBefore === signatureAfter &&
        scanned.directorySignature === signatureAfter;
      if (stable) {
        catalogs.set(namespace, scanned);
        return { catalog: scanned, meta: metaAfter };
      }
      if (attempt === 2) return { catalog: scanned, meta: metaAfter };
    }
    throw new Error("unreachable catalog scan state");
  }

  function firstEntryAfter(entries: readonly CatalogEntry[], insertionIndex: number): number {
    let low = 0;
    let high = entries.length;
    while (low < high) {
      const middle = low + Math.floor((high - low) / 2);
      const entry = entries[middle];
      if (entry !== undefined && entry.insertionIndex <= insertionIndex) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  async function list(query: {
    readonly namespace: string;
    readonly kind?: string;
    readonly cursor?: string;
    readonly limit: number;
  }): Promise<{
    readonly records: readonly StoredRecord[];
    readonly nextCursor?: string;
    readonly snapshotRevision: string;
  }> {
    if (!Number.isInteger(query.limit) || query.limit < 1) {
      throw invalidQuery(`list limit must be a positive integer, got ${String(query.limit)}`);
    }
    let afterIndex = -1;
    if (query.cursor !== undefined) {
      const parsed = Number(query.cursor);
      if (!Number.isInteger(parsed) || parsed < 0) {
        throw invalidQuery(`unrecognized list cursor ${JSON.stringify(query.cursor)}`);
      }
      afterIndex = parsed;
    }
    const nsDir = namespaceDir(root, query.namespace);
    if ((await confinedRealDir(nsDir)) === undefined) {
      return { records: [], snapshotRevision: "0" };
    }
    const { catalog, meta } = await catalogFor(nsDir, query.namespace);
    const entries = query.kind === undefined ? catalog.all : (catalog.byKind.get(query.kind) ?? []);
    const live: { readonly record: StoredRecord; readonly insertionIndex: number }[] = [];
    for (let index = firstEntryAfter(entries, afterIndex); index < entries.length; index += 1) {
      const entry = entries[index];
      if (entry === undefined) break;
      const filePath = recordFile(root, entry.key);
      const cell = await readCellAt(filePath);
      if (cell === undefined) throw corruptStoreFile(filePath, "indexed record is missing");
      if (
        cell.key.namespace !== entry.key.namespace ||
        cell.key.kind !== entry.key.kind ||
        cell.key.id !== entry.key.id ||
        cell.insertionIndex !== entry.insertionIndex
      ) {
        throw corruptStoreFile(filePath, "indexed record identity does not match the stored cell");
      }
      if (cell.form !== "tombstone") {
        live.push({ record: toStoredRecord(cell), insertionIndex: cell.insertionIndex });
        if (live.length > query.limit) break;
      }
    }
    const page = live.slice(0, query.limit);
    const lastEntry = page[page.length - 1];
    return {
      records: page.map((entry) => entry.record),
      ...(live.length > page.length && lastEntry !== undefined ? { nextCursor: String(lastEntry.insertionIndex) } : {}),
      snapshotRevision: String(meta.writeCount),
    };
  }

  return { get, create, compareAndSet, append, tombstone, list };
}
