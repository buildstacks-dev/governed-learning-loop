// Cross-process exclusive creation: two real `node` child processes race
// create() on the same rootDir and exactly one `created` wins per key. The
// children import the BUILT package (dist/) because Node cannot type-strip
// the repo's `.js`-specifier TypeScript sources; the tsc build run in
// beforeAll is the identical artifact `pnpm build` ships. A file-based
// barrier parks both children immediately before create() so the O_EXCL/link
// window is genuinely contended. An in-process two-instance race over the
// same rootDir complements it with tighter interleaving at the syscall seam.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFileStore } from "../src/node/index.js";
import type { RecordKey } from "../src/ports/store.js";

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const distEntry = join(workspaceRoot, "packages", "learning-loop", "dist", "node", "index.js");

const outers: string[] = [];

afterAll(() => {
  for (const dir of outers) rmSync(dir, { recursive: true, force: true });
});

beforeAll(() => {
  execFileSync(
    join(workspaceRoot, "node_modules", ".bin", "tsc"),
    ["-p", join(workspaceRoot, "packages", "learning-loop", "tsconfig.build.json")],
    { cwd: workspaceRoot, stdio: "pipe" },
  );
  if (!existsSync(distEntry)) throw new Error(`build produced no ${distEntry}`);
}, 120_000);

const childScript = `
import { existsSync, writeFileSync } from "node:fs";
const [storeUrl, rootDir, controlDir, childName, digest, countText] = process.argv.slice(2);
const { createFileStore } = await import(storeUrl);
const store = createFileStore({ rootDir });
const statuses = [];
const count = Number(countText);
for (let index = 0; index < count; index += 1) {
  writeFileSync(\`\${controlDir}/ready-\${index}-\${childName}\`, "");
  while (!existsSync(\`\${controlDir}/go-\${index}\`)) {
    // spin: the parent releases each round once both children are parked here
  }
  const result = await store.create(
    { namespace: "race", kind: "target", id: \`key-\${index}\` },
    { winner: childName },
    digest,
    \`op-\${childName}-\${index}\`,
  );
  statuses.push(result.status);
}
process.stdout.write(JSON.stringify(statuses));
`;

function collect(stream: Readable | null): Promise<string> {
  return new Promise((resolvePromise) => {
    if (stream === null) {
      resolvePromise("");
      return;
    }
    let text = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      text += chunk;
    });
    stream.on("end", () => resolvePromise(text));
  });
}

async function waitFor(condition: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
}

function parseStatuses(text: string): string[] {
  const raw: unknown = JSON.parse(text);
  if (!Array.isArray(raw)) throw new Error(`expected a JSON array of statuses, got: ${text}`);
  return raw.map((status) => String(status));
}

describe("createFileStore cross-process exclusive creation", () => {
  it("two child processes racing create() on the same rootDir yield exactly one created per key", async () => {
    const outer = mkdtempSync(join(tmpdir(), "gll-node-race-"));
    outers.push(outer);
    const storeRoot = join(outer, "store");
    const controlDir = join(outer, "control");
    mkdirSync(storeRoot);
    mkdirSync(controlDir);
    const scriptPath = join(outer, "race-child.mjs");
    writeFileSync(scriptPath, childScript);
    const storeUrl = pathToFileURL(distEntry).href;
    const rounds = 8;

    const names = ["alpha", "beta"];
    const children = names.map((name) =>
      spawn(process.execPath, [scriptPath, storeUrl, storeRoot, controlDir, name, `digest-${name}`, String(rounds)], {
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
    const outputs = children.map((child) => collect(child.stdout));
    const errors = children.map((child) => collect(child.stderr));
    const exits = children.map(
      (child) =>
        new Promise<number>((resolvePromise) => {
          child.on("close", (code) => resolvePromise(code ?? -1));
        }),
    );

    for (let round = 0; round < rounds; round += 1) {
      await waitFor(
        () => names.every((name) => existsSync(join(controlDir, `ready-${round}-${name}`))),
        `round ${round} barrier`,
      );
      writeFileSync(join(controlDir, `go-${round}`), "");
    }

    const [exitAlpha, exitBeta] = await Promise.all(exits);
    const [errAlpha, errBeta] = await Promise.all(errors);
    expect(exitAlpha, errAlpha ?? "").toBe(0);
    expect(exitBeta, errBeta ?? "").toBe(0);
    const [outAlpha, outBeta] = await Promise.all(outputs);
    const statusesAlpha = parseStatuses(outAlpha ?? "");
    const statusesBeta = parseStatuses(outBeta ?? "");
    expect(statusesAlpha).toHaveLength(rounds);
    expect(statusesBeta).toHaveLength(rounds);

    const reader = createFileStore({ rootDir: storeRoot });
    for (let round = 0; round < rounds; round += 1) {
      // Different digests per child: the loser can only be a conflict.
      expect([statusesAlpha[round], statusesBeta[round]].sort()).toEqual(["conflict", "created"]);
      const winner = statusesAlpha[round] === "created" ? "alpha" : "beta";
      const stored = await reader.get({ namespace: "race", kind: "target", id: `key-${round}` });
      expect(stored?.digest).toBe(`digest-${winner}`);
      expect(stored?.value).toEqual({ winner });
      expect(stored?.revision).toBe("1");
    }
  }, 120_000);

  it("two store instances in one process racing create() yield one winner per key", async () => {
    const outer = mkdtempSync(join(tmpdir(), "gll-node-race-inproc-"));
    outers.push(outer);
    const first = createFileStore({ rootDir: outer });
    const second = createFileStore({ rootDir: outer });
    for (let index = 0; index < 10; index += 1) {
      const key: RecordKey = { namespace: "race", kind: "target", id: `key-${index}` };
      const [a, b] = await Promise.all([
        first.create(key, { owner: "first" }, "digest-first", `op-first-${index}`),
        second.create(key, { owner: "second" }, "digest-second", `op-second-${index}`),
      ]);
      expect([a.status, b.status].sort()).toEqual(["conflict", "created"]);
    }
  });
});
