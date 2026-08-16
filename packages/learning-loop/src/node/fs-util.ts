// Small filesystem primitives shared by the store: typed errno access,
// durable (fsynced) temp-file writes, exclusive publication via link(2), and
// O_NOFOLLOW reads that refuse symlinks at the leaf without a lstat/open race.
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, link, lstat, open, unlink } from "node:fs/promises";

export function fsErrorCode(error: unknown): string | undefined {
  if (error instanceof Error && "code" in error) {
    const code: unknown = error.code;
    if (typeof code === "string") return code;
  }
  return undefined;
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function temporaryName(): string {
  return `.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
}

/** Write `data` to a brand-new file and fsync it before returning. */
export async function writeDurable(filePath: string, data: string): Promise<void> {
  const handle = await open(filePath, "wx", 0o600);
  try {
    await handle.writeFile(data, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Atomically publish a fully written temp file to a path that must not exist
 * yet. link(2) fails with EEXIST when the target exists, so it is both the
 * exclusive-create arbiter and an atomic publication: losers never observe
 * partial content, and exactly one racer returns true.
 */
export async function publishExclusive(temporaryPath: string, finalPath: string): Promise<boolean> {
  try {
    await link(temporaryPath, finalPath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    if (fsErrorCode(error) === "EEXIST") return false;
    throw error;
  }
  await unlink(temporaryPath).catch(() => undefined);
  return true;
}

export async function fsyncDirBestEffort(dirPath: string): Promise<void> {
  try {
    const handle = await open(dirPath, constants.O_RDONLY);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Directory fsync is platform-dependent; durability of the entry rename
    // then rests on the filesystem's own journaling.
  }
}

export type PathKind = "missing" | "file" | "directory" | "symlink" | "other";

export async function pathKind(target: string): Promise<PathKind> {
  try {
    const stats = await lstat(target);
    if (stats.isSymbolicLink()) return "symlink";
    if (stats.isFile()) return "file";
    if (stats.isDirectory()) return "directory";
    return "other";
  } catch (error) {
    const code = fsErrorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") return "missing";
    throw error;
  }
}

export type NoFollowRead =
  | { readonly outcome: "missing" }
  | { readonly outcome: "symlink" }
  | { readonly outcome: "not-regular" }
  | { readonly outcome: "ok"; readonly text: string };

/** Read a regular file without following a symlink at the leaf. */
export async function readNoFollow(filePath: string): Promise<NoFollowRead> {
  let handle: FileHandle;
  try {
    handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    const code = fsErrorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") return { outcome: "missing" };
    if (code === "ELOOP" || code === "EMLINK") return { outcome: "symlink" };
    throw error;
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) return { outcome: "not-regular" };
    return { outcome: "ok", text: await handle.readFile({ encoding: "utf8" }) };
  } finally {
    await handle.close();
  }
}
