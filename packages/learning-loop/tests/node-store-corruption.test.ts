// Corruption is explicit: a torn, truncated, empty, wrong-shaped, or
// misplaced store file surfaces as LearningLoopError `store.corrupt` — never
// undefined, never an empty record, never a pass.
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { LearningLoopError } from "../src/diagnostics.js";
import { createFileStore } from "../src/node/index.js";
import { escapeComponent } from "../src/node/paths.js";
import type { RecordKey } from "../src/ports/store.js";

const roots: string[] = [];

function freshRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "gll-node-corrupt-"));
  roots.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

const k: RecordKey = { namespace: "ns", kind: "candidate", id: "c-1" };

function storeFiles(root: string, suffix: string, dotted: boolean): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const entryPath = join(dir, entry.name);
      if (entry.isDirectory()) walk(entryPath);
      else if (entry.isFile() && entry.name.endsWith(suffix) && entry.name.startsWith(".") === dotted) {
        found.push(entryPath);
      }
    }
  };
  walk(root);
  return found;
}

function onlyRecordFile(root: string): string {
  const files = storeFiles(root, ".json", false);
  const first = files[0];
  if (first === undefined || files.length !== 1)
    throw new Error(`expected exactly one record file, found ${files.length}`);
  return first;
}

async function expectCorrupt(promise: Promise<unknown>): Promise<void> {
  const outcome = await promise.then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(outcome).toBeInstanceOf(LearningLoopError);
  if (outcome instanceof LearningLoopError) expect(outcome.code).toBe("store.corrupt");
}

describe("createFileStore corruption surfacing", () => {
  it("a truncated record file surfaces store.corrupt from get and list", async () => {
    const root = freshRoot();
    const store = createFileStore({ rootDir: root });
    await store.create(k, { nested: { text: "naïve ☃", numbers: [1, 2, 3] } }, "d-1", "op-1");
    const filePath = onlyRecordFile(root);
    const size = readFileSync(filePath).byteLength;
    truncateSync(filePath, Math.floor(size / 2));
    await expectCorrupt(store.get(k));
    await expectCorrupt(store.list({ namespace: k.namespace, limit: 5 }));
  });

  it("an empty record file surfaces store.corrupt", async () => {
    const root = freshRoot();
    const store = createFileStore({ rootDir: root });
    await store.create(k, { v: 1 }, "d-1", "op-1");
    truncateSync(onlyRecordFile(root), 0);
    await expectCorrupt(store.get(k));
  });

  it("valid JSON with the wrong shape surfaces store.corrupt", async () => {
    const root = freshRoot();
    const store = createFileStore({ rootDir: root });
    await store.create(k, { v: 1 }, "d-1", "op-1");
    writeFileSync(onlyRecordFile(root), '{"schemaVersion":1,"form":"record"}\n');
    await expectCorrupt(store.get(k));
    await expectCorrupt(store.list({ namespace: k.namespace, limit: 5 }));
  });

  it("a record parked at another key's path surfaces store.corrupt", async () => {
    const root = freshRoot();
    const store = createFileStore({ rootDir: root });
    await store.create(k, { v: 1 }, "d-1", "op-1");
    const filePath = onlyRecordFile(root);
    const decoyPath = join(dirname(filePath), `${escapeComponent("c-2", "id")}.json`);
    copyFileSync(filePath, decoyPath);
    await expectCorrupt(store.get({ ...k, id: "c-2" }));
    await expectCorrupt(store.list({ namespace: k.namespace, limit: 5 }));
  });

  it("a truncated namespace meta file surfaces store.corrupt from list", async () => {
    const root = freshRoot();
    const store = createFileStore({ rootDir: root });
    await store.create(k, { v: 1 }, "d-1", "op-1");
    const metaFiles = storeFiles(root, ".meta.json", true);
    const metaPath = metaFiles[0];
    if (metaPath === undefined || metaFiles.length !== 1) throw new Error("expected exactly one meta file");
    truncateSync(metaPath, 3);
    await expectCorrupt(store.list({ namespace: k.namespace, limit: 5 }));
  });
});
