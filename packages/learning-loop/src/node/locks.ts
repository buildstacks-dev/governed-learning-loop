// Per-key advisory lock files. Acquisition is O_EXCL creation of the lock
// file with an owner-token + expiry payload; contenders retry with bounded
// backoff and fail with `store.unavailable` at the timeout. A crashed holder
// cannot deadlock a key: once the payload's expiresAtMs passes, a contender
// takes the stale lock over by atomically renaming it aside (rename
// arbitration — exactly one contender wins the rename) and re-running the
// O_EXCL create. Holders re-verify ownership with verifyLock() immediately
// before every commit rename, so an expired or usurped holder aborts instead
// of writing. Residual window (also documented in the PR): between the
// verification read and the commit rename — and between a takeover's
// staleness read and its rename — a scheduler pause longer than the
// remaining TTL can in principle interleave; verification shrinks the window
// to microseconds but cannot close it without an OS transactional primitive.
import { randomBytes } from "node:crypto";
import { readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { LearningLoopError } from "../diagnostics.js";
import { delay, fsErrorCode } from "./fs-util.js";

export interface LockOptions {
  readonly ttlMs: number;
  readonly timeoutMs: number;
}

export interface LockHandle {
  readonly lockPath: string;
  readonly token: string;
}

interface LockPayload {
  readonly owner: string;
  readonly expiresAtMs: number;
}

export function storeUnavailable(message: string): LearningLoopError {
  return new LearningLoopError("store.unavailable", [{ code: "store.unavailable", severity: "error", message }]);
}

function parseLockPayload(text: string): LockPayload | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  if (!("owner" in raw) || !("expiresAtMs" in raw)) return undefined;
  const { owner, expiresAtMs } = raw;
  if (typeof owner !== "string" || typeof expiresAtMs !== "number" || !Number.isFinite(expiresAtMs)) {
    return undefined;
  }
  return { owner, expiresAtMs };
}

async function readLockPayload(lockPath: string): Promise<LockPayload | "missing" | "unreadable"> {
  let text: string;
  try {
    text = await readFile(lockPath, "utf8");
  } catch (error) {
    if (fsErrorCode(error) === "ENOENT") return "missing";
    throw error;
  }
  return parseLockPayload(text) ?? "unreadable";
}

async function takeOverIfStale(lockPath: string, ttlMs: number): Promise<void> {
  const payload = await readLockPayload(lockPath);
  if (payload === "missing") return;
  if (payload === "unreadable") {
    // Torn lock write from a crashed contender: fall back to file age.
    let mtimeMs: number;
    try {
      mtimeMs = (await stat(lockPath)).mtimeMs;
    } catch (error) {
      if (fsErrorCode(error) === "ENOENT") return;
      throw error;
    }
    if (mtimeMs + ttlMs > Date.now()) return;
  } else if (payload.expiresAtMs > Date.now()) {
    return;
  }
  const graveyard = `${lockPath}.stale-${randomBytes(6).toString("hex")}`;
  try {
    await rename(lockPath, graveyard);
  } catch (error) {
    if (fsErrorCode(error) === "ENOENT") return; // another contender already took it over
    throw error;
  }
  await unlink(graveyard).catch(() => undefined);
}

export async function acquireLock(lockPath: string, options: LockOptions): Promise<LockHandle> {
  const token = `${process.pid}-${randomBytes(9).toString("hex")}`;
  const deadline = Date.now() + options.timeoutMs;
  for (;;) {
    const payload: LockPayload = { owner: token, expiresAtMs: Date.now() + options.ttlMs };
    try {
      await writeFile(lockPath, JSON.stringify(payload), { flag: "wx", mode: 0o600 });
      return { lockPath, token };
    } catch (error) {
      if (fsErrorCode(error) !== "EEXIST") throw error;
    }
    await takeOverIfStale(lockPath, options.ttlMs);
    if (Date.now() >= deadline) {
      throw storeUnavailable(`timed out after ${String(options.timeoutMs)}ms waiting for lock ${lockPath}`);
    }
    await delay(10 + Math.floor(Math.random() * 15));
  }
}

/** The pre-commit guard: an expired or usurped holder must abort, not write. */
export async function verifyLock(handle: LockHandle): Promise<void> {
  const payload = await readLockPayload(handle.lockPath);
  if (payload === "missing" || payload === "unreadable" || payload.owner !== handle.token) {
    throw storeUnavailable(`lock ${handle.lockPath} is no longer held by this owner; aborting before commit`);
  }
  if (payload.expiresAtMs <= Date.now()) {
    throw storeUnavailable(`lock ${handle.lockPath} expired before commit; aborting`);
  }
}

export async function releaseLock(handle: LockHandle): Promise<void> {
  try {
    const payload = await readLockPayload(handle.lockPath);
    if (payload !== "missing" && payload !== "unreadable" && payload.owner === handle.token) {
      await unlink(handle.lockPath);
    }
  } catch {
    // Best effort: an unreleased lock is reclaimed by expiry.
  }
}
