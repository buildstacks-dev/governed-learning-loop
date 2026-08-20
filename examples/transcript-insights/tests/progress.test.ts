import { createInMemoryStore } from "@cormidia/learning-loop/testing";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { listLearningRecords } from "../src/fold.js";
import { cli, makeTempDir, removeDir } from "./support.js";

test("a multi-page fold reports aggregate page progress before completion", async () => {
  const store = createInMemoryStore();
  for (let index = 0; index < 201; index += 1) {
    await store.create(
      { namespace: "learning", kind: "observation", id: `obs-${String(index).padStart(3, "0")}` },
      { index },
      `digest-${index}`,
      `operation-${index}`,
    );
  }

  const progress: { readonly records: number; readonly pages: number; readonly heartbeat: boolean }[] = [];
  const records = await listLearningRecords(store, "observation", (event) => {
    progress.push({ records: event.records, pages: event.pages, heartbeat: event.heartbeat });
  });

  expect(records).toHaveLength(201);
  expect(progress).toEqual([
    { records: 200, pages: 1, heartbeat: false },
    { records: 201, pages: 2, heartbeat: false },
  ]);
});

test("report announces its resolved state and remains read-only when state is absent", async () => {
  const outer = makeTempDir("ti-read-only-");
  const stateDir = join(outer, "missing-state");
  try {
    const result = await cli(["report", "--state", stateDir]);
    expect(result.code).toBe(0);
    expect(result.lines[0]).toBe(`report: start state=${stateDir} operation=read-only`);
    expect(result.text).toContain("report: listing observations records=0 pages=1");
    expect(existsSync(stateDir)).toBe(false);
  } finally {
    removeDir(outer);
  }
});
