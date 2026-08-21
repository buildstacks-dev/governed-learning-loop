// Negative control: redacted content is absent from logs, diagnostics, thrown
// errors, and dictionary-recoverable hashes. The adapters write nothing to any
// stream, every diagnostic is a static message plus counts, and every digest
// that leaves the adapter is either a tenant-keyed HMAC or a content digest
// of already-minimized bytes — never a plain hash of a low-entropy secret.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { LearningLoopError } from "@cormidia/learning-loop";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createClaudeCodeTranscriptSource, createCodexTranscriptSource } from "../../src/index.js";
import { TEST_LOCATOR_KEY, allPages, inputOf, makeFixtureDir, writeRaw } from "../support.js";
import { allStoredBytes, expectNoFragment, kernelHarness, tightenedPolicy } from "./support.js";

const SECRET = "CANARY-LEAK-QXZW-KVJY-SECRET";
const SESSION_ID = "eeee5555-ffff-4000-8111-222266667777";
const CWD = `/tmp/${SECRET}/workspace`;
const BRANCH = `${SECRET}-branch`;

function fixtureText(): string {
  const records: readonly unknown[] = [
    {
      type: "user",
      sessionId: SESSION_ID,
      uuid: "u-1",
      cwd: CWD,
      gitBranch: BRANCH,
      version: "2.1.900",
      timestamp: "2026-08-12T05:00:00.000Z",
      message: { role: "user", content: `my key is ${SECRET}` },
    },
    {
      type: "assistant",
      sessionId: SESSION_ID,
      uuid: "u-2",
      timestamp: "2026-08-12T05:00:01.000Z",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "t-1", name: SECRET, input: { command: SECRET } }],
        usage: { input_tokens: 3, output_tokens: 1 },
      },
    },
    { type: SECRET, sessionId: SESSION_ID, uuid: "u-3", timestamp: "2026-08-12T05:00:02.000Z" },
  ];
  const deep = `{"type":"user","uuid":"u-4","timestamp":"2026-08-12T05:00:03.000Z","x":${"[".repeat(200)}"${SECRET}"${"]".repeat(200)}}`;
  const long = `{"type":"user","uuid":"u-5","timestamp":"2026-08-12T05:00:04.000Z","message":{"content":"${SECRET.repeat(40)}"}}`;
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n${deep}\n${long}\n{corrupt ${SECRET}\n`;
}

function hexTokens(text: string): ReadonlySet<string> {
  return new Set(text.match(/[0-9a-f]{64}/g) ?? []);
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("negative control: redacted content never leaks", () => {
  const fixtures: (() => void)[] = [];
  afterEach(() => {
    for (const cleanup of fixtures.splice(0)) cleanup();
    vi.restoreAllMocks();
  });
  function fixtureDir(): string {
    const fixture = makeFixtureDir();
    fixtures.push(() => fixture.cleanup());
    return fixture.dir;
  }

  it("writes nothing to any console or process stream while probing, reading, and ingesting", async () => {
    const dir = fixtureDir();
    const secretDir = join(dir, SECRET);
    const path = writeRaw(dir, "leak.jsonl", fixtureText());
    const spies = [
      vi.spyOn(console, "log"),
      vi.spyOn(console, "info"),
      vi.spyOn(console, "warn"),
      vi.spyOn(console, "error"),
      vi.spyOn(console, "debug"),
      vi.spyOn(process.stdout, "write"),
      vi.spyOn(process.stderr, "write"),
    ];
    const policy = tightenedPolicy((content) => {
      content.ceilings.maximumLineBytes = 1_024;
    });
    const source = createClaudeCodeTranscriptSource({ privacyPolicy: policy });
    const { learning, registered } = kernelHarness(source, join(dir, ".store"));
    await source.probe(inputOf([path]));
    await allPages(source, inputOf([path]));
    await learning.ingest(registered, inputOf([path]));
    await expect(allPages(source, inputOf([join(secretDir, "missing.jsonl")]))).resolves.toHaveLength(1);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it("keeps the secret out of every diagnostic, thrown error, projection, and durable byte", async () => {
    const dir = fixtureDir();
    const secretDir = join(dir, SECRET);
    mkdirSync(secretDir);
    const path = writeRaw(secretDir, "leak.jsonl", fixtureText());
    const policy = tightenedPolicy((content) => {
      content.ceilings.maximumLineBytes = 1_024;
      content.ceilings.maximumNestingDepth = 16;
    });
    const source = createClaudeCodeTranscriptSource({ privacyPolicy: policy });
    const storeDir = join(dir, ".store");
    const { learning, registered } = kernelHarness(source, storeDir);

    const probe = await source.probe(inputOf([path]));
    const pages = await allPages(source, inputOf([path]));
    const receipt = await learning.ingest(registered, inputOf([path]));
    const thrown: string[] = [];
    for (const bad of [
      () => allPages(source, inputOf([path, path])),
      () => allPages(source, { kind: "explicit_files", paths: [path], locatorKey: TEST_LOCATOR_KEY }),
      () =>
        allPages(source, { kind: "explicit_files", paths: [path], locatorKey: TEST_LOCATOR_KEY, roots: [`${path}\0`] }),
      () => allPages(source, inputOf([path]), "x"),
    ]) {
      try {
        await bad();
        throw new Error("expected refusal");
      } catch (error) {
        if (!(error instanceof LearningLoopError)) throw error;
        thrown.push(JSON.stringify({ message: error.message, diagnostics: error.diagnostics }));
      }
    }
    const page = pages[0];
    if (page === undefined) throw new Error("missing page");
    // The controls are not vacuous: the page is degraded by every planted breach.
    const codes = page.diagnostics.map((diagnostic) => diagnostic.code);
    expect(codes).toContain("source.limit_exceeded");
    expect(codes).toContain("source.unsupported_format");
    expect(page.observations.length).toBeGreaterThan(2);
    expect(receipt.observationIds.length).toBeGreaterThan(2);

    const emitted = JSON.stringify({ probe, pages, receipt, thrown });
    const stored = allStoredBytes(storeDir);
    for (const text of [emitted, stored]) {
      expectNoFragment(text, SECRET);
      expect(text).not.toContain(SESSION_ID);
      expect(text).not.toContain(basename(path));
      expect(text).not.toContain("workspace");
      expect(text).not.toContain("/tmp/");
    }
  });

  it("emits no digest that a dictionary attack over the planted values could recover", async () => {
    const dir = fixtureDir();
    const secretDir = join(dir, SECRET);
    mkdirSync(secretDir);
    const path = writeRaw(secretDir, "leak.jsonl", fixtureText());
    const source = createCodexTranscriptSource();
    const claude = createClaudeCodeTranscriptSource();
    const storeDir = join(dir, ".store");
    const { learning, registered } = kernelHarness(claude, storeDir);
    const pages = [...(await allPages(claude, inputOf([path]))), ...(await allPages(source, inputOf([path])))];
    const receipt = await learning.ingest(registered, inputOf([path]));

    const emittedTokens = new Set([
      ...hexTokens(JSON.stringify({ pages, receipt })),
      ...hexTokens(allStoredBytes(storeDir)),
    ]);
    expect(emittedTokens.size).toBeGreaterThan(4);
    const bytes = readFileSync(path);
    const lowEntropy: string[] = [
      SECRET,
      SESSION_ID,
      CWD,
      BRANCH,
      path,
      basename(path),
      secretDir,
      dir,
      `${SECRET}-branch`,
    ];
    for (const line of bytes.toString("utf8").split("\n")) if (line.length > 0) lowEntropy.push(line, line.trim());
    const candidates = new Set<string>();
    for (const value of lowEntropy) {
      for (const form of [value, value.toLowerCase(), value.toUpperCase(), `${value}\n`]) {
        candidates.add(sha256(form));
        candidates.add(sha256(JSON.stringify(form)));
      }
    }
    candidates.add(sha256(bytes));
    for (const token of emittedTokens) expect(candidates.has(token), `plain hash leaked: ${token}`).toBe(false);
    // Every private identity is a tenant-keyed locator: a different key changes all of them.
    const otherKey = "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz";
    const rekeyed = await allPages(claude, inputOf([path], otherKey));
    const rekeyedTokens = hexTokens(JSON.stringify(rekeyed));
    const originalTokens = hexTokens(JSON.stringify(pages.slice(0, 1)));
    expect(rekeyedTokens.size).toBe(originalTokens.size);
    for (const token of rekeyedTokens) expect(originalTokens.has(token)).toBe(false);
  });
});
