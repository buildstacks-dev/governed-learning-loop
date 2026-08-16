// Lock-file discipline: stale locks are taken over, fresh locks block cleanly
// with store.unavailable instead of corrupting, and an expired holder cannot
// commit (verifyLock is the pre-rename guard).
import { existsSync, mkdtempSync, readdirSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { LearningLoopError } from "../src/diagnostics.js";
import { createFileStore } from "../src/node/index.js";
import { acquireLock, releaseLock, verifyLock } from "../src/node/locks.js";
import type { RecordKey } from "../src/ports/store.js";

const roots: string[] = [];

function freshRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "gll-node-lock-"));
  roots.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

const k: RecordKey = { namespace: "ns", kind: "candidate", id: "c-1" };

/** The single record file the store created under `root`. */
function recordFilePath(root: string): string {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const entryPath = join(dir, entry.name);
      if (entry.isDirectory()) walk(entryPath);
      else if (entry.isFile() && entry.name.endsWith(".json") && !entry.name.startsWith(".")) found.push(entryPath);
    }
  };
  walk(root);
  const first = found[0];
  if (first === undefined || found.length !== 1)
    throw new Error(`expected exactly one record file, found ${found.length}`);
  return first;
}

async function expectUnavailable(promise: Promise<unknown>): Promise<void> {
  const outcome = await promise.then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(outcome).toBeInstanceOf(LearningLoopError);
  if (outcome instanceof LearningLoopError) expect(outcome.code).toBe("store.unavailable");
}

describe("createFileStore locking", () => {
  it("takes over an expired lock and completes the mutation", async () => {
    const root = freshRoot();
    const store = createFileStore({ rootDir: root, lockTimeoutMs: 5_000 });
    await store.create(k, { v: 1 }, "d-1", "op-1");
    const lockPath = `${recordFilePath(root)}.lock`;
    writeFileSync(lockPath, JSON.stringify({ owner: "crashed-holder", expiresAtMs: Date.now() - 60_000 }));
    const result = await store.compareAndSet(k, "1", { v: 2 }, "d-2", "op-2");
    expect(result).toEqual({ status: "updated", revision: "2" });
    expect((await store.get(k))?.value).toEqual({ v: 2 });
    expect(existsSync(lockPath)).toBe(false); // released after the mutation
  });

  it("fails cleanly with store.unavailable while a fresh lock is held, then proceeds once it is gone", async () => {
    const root = freshRoot();
    const store = createFileStore({ rootDir: root, lockTimeoutMs: 300 });
    await store.create(k, { v: 1 }, "d-1", "op-1");
    const lockPath = `${recordFilePath(root)}.lock`;
    writeFileSync(lockPath, JSON.stringify({ owner: "live-holder", expiresAtMs: Date.now() + 60_000 }));
    await expectUnavailable(store.compareAndSet(k, "1", { v: 2 }, "d-2", "op-2"));
    const untouched = await store.get(k);
    expect(untouched?.value).toEqual({ v: 1 });
    expect(untouched?.revision).toBe("1");
    unlinkSync(lockPath);
    const result = await store.compareAndSet(k, "1", { v: 2 }, "d-2", "op-2");
    expect(result).toEqual({ status: "updated", revision: "2" });
  });

  it("waits out a lock that expires soon and then proceeds", async () => {
    const root = freshRoot();
    const store = createFileStore({ rootDir: root, lockTimeoutMs: 10_000 });
    await store.create(k, { v: 1 }, "d-1", "op-1");
    const lockPath = `${recordFilePath(root)}.lock`;
    writeFileSync(lockPath, JSON.stringify({ owner: "slow-holder", expiresAtMs: Date.now() + 400 }));
    const result = await store.compareAndSet(k, "1", { v: 2 }, "d-2", "op-2");
    expect(result).toEqual({ status: "updated", revision: "2" });
  });

  it("a takeover invalidates the expired holder before it can commit", async () => {
    const root = freshRoot();
    const lockPath = join(root, "key.lock");
    const expired = await acquireLock(lockPath, { ttlMs: 1, timeoutMs: 1_000 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const usurper = await acquireLock(lockPath, { ttlMs: 60_000, timeoutMs: 5_000 });
    await expectUnavailable(verifyLock(expired)); // the crashed/paused holder must abort, not write
    await verifyLock(usurper); // the new holder is intact
    await releaseLock(usurper);
    expect(existsSync(lockPath)).toBe(false);
    await releaseLock(expired); // must not delete anything it no longer owns
  });

  it("release only removes a lock the handle still owns", async () => {
    const root = freshRoot();
    const lockPath = join(root, "key.lock");
    const expired = await acquireLock(lockPath, { ttlMs: 1, timeoutMs: 1_000 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const usurper = await acquireLock(lockPath, { ttlMs: 60_000, timeoutMs: 5_000 });
    await releaseLock(expired);
    expect(existsSync(lockPath)).toBe(true); // the usurper's lock survives
    await releaseLock(usurper);
    expect(existsSync(lockPath)).toBe(false);
  });

  it("takes over an unparseable (torn) lock once it is older than the ttl", async () => {
    const root = freshRoot();
    const lockPath = join(root, "key.lock");
    writeFileSync(lockPath, "{torn");
    const past = (Date.now() - 60_000) / 1000;
    utimesSync(lockPath, past, past);
    const handle = await acquireLock(lockPath, { ttlMs: 1_000, timeoutMs: 2_000 });
    await verifyLock(handle);
    await releaseLock(handle);
  });

  it("a torn lock newer than the ttl still blocks", async () => {
    const root = freshRoot();
    const lockPath = join(root, "key.lock");
    writeFileSync(lockPath, "{torn");
    await expectUnavailable(acquireLock(lockPath, { ttlMs: 60_000, timeoutMs: 300 }));
  });
});
