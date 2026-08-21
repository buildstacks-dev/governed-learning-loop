// Negative control: path traversal and symlink escape. Every explicit path is
// normalized, confined to a declared root lexically, walked component by
// component so no directory on the way is a symbolic link, and resolved with
// realpath — on top of the final-component lstat + O_NOFOLLOW refusal.
import { mkdirSync, symlinkSync } from "node:fs";
import { basename, join } from "node:path";
import { LearningLoopError } from "@cormidia/learning-loop";
import { afterEach, describe, expect, it } from "vitest";
import { createClaudeCodeTranscriptSource, createCodexTranscriptSource } from "../../src/index.js";
import { TEST_LOCATOR_KEY, allPages, makeFixtureDir, writeJsonl } from "../support.js";
import { collect, expectNoFragment, kernelHarness, tightenedPolicy } from "./support.js";

const CANARY = "CANARY-PATH-QXZW-KVJY-ESCAPE";
const SESSION_ID = "cccc3333-dddd-4eee-8fff-000044445555";

function records(): readonly unknown[] {
  return [
    {
      type: "user",
      sessionId: SESSION_ID,
      uuid: "u-1",
      cwd: "/workspaces/sample",
      timestamp: "2026-08-10T07:00:00.000Z",
      message: { role: "user", content: `hello ${CANARY}` },
    },
  ];
}

function input(paths: readonly string[], roots?: readonly string[]) {
  return {
    kind: "explicit_files" as const,
    paths,
    locatorKey: TEST_LOCATOR_KEY,
    ...(roots === undefined ? {} : { roots }),
  };
}

async function errorOf(run: () => Promise<unknown>): Promise<LearningLoopError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof LearningLoopError) return error;
    throw error;
  }
  throw new Error("expected a LearningLoopError");
}

describe("negative control: path traversal and symlink escape", () => {
  const fixtures: (() => void)[] = [];
  afterEach(() => {
    for (const cleanup of fixtures.splice(0)) cleanup();
  });
  function fixtureDir(): string {
    const fixture = makeFixtureDir();
    fixtures.push(() => fixture.cleanup());
    return fixture.dir;
  }

  it("refuses traversal outside the declared roots after lexical normalization", async () => {
    const outside = fixtureDir();
    const root = fixtureDir();
    const escaped = writeJsonl(outside, `${CANARY}.jsonl`, records());
    const inside = writeJsonl(root, "inside.jsonl", records());
    const traversal = join(root, "..", basename(outside), `${CANARY}.jsonl`);
    const roundTrip = join(root, "sub", "..", "inside.jsonl");
    const source = createClaudeCodeTranscriptSource();

    // The traversal spelling normalizes to the escaped file itself, so it is
    // the same explicit path; it is listed once here and directly below.
    const pages = await allPages(source, input([traversal, roundTrip, root], [root]));
    expect(pages).toHaveLength(3);
    expect(pages[0]?.state).toEqual({ status: "unreadable" });
    expect(pages[0]?.diagnostics[0]?.code).toBe("source.input_refused");
    expect(pages[0]?.diagnostics[0]?.message).toContain("outside every declared root");
    expect(pages[1]?.state).toMatchObject({ status: "available" });
    expect(pages[1]?.observations.length).toBeGreaterThan(0);
    // A root is a directory, never a file: it cannot be its own explicit input.
    expect(pages[2]?.state).toEqual({ status: "unreadable" });
    for (const page of [pages[0], pages[2]]) expect(page?.observations).toEqual([]);
    expect(pages[0]?.nextCursor).toBe("1");
    const direct = await allPages(source, input([escaped], [root]));
    expect(direct[0]?.state).toEqual({ status: "unreadable" });
    expect(direct[0]?.sourceRef).toBe(pages[0]?.sourceRef);
    const probe = await source.probe(input([traversal], [root]));
    expect(probe.supported).toBe(false);
    expect(probe.diagnostics[0]?.code).toBe("source.input_refused");
    // Identity uses the normalized path; the traversal spelling is not a separate source.
    expect(pages[1]?.sourceRef).toBe((await allPages(source, input([inside], [root])))[0]?.sourceRef);
    expectNoFragment(JSON.stringify({ pages, direct, probe }), CANARY);
  });

  it("refuses a symbolic-link directory on the path even when the target file is a regular file", async () => {
    const outside = fixtureDir();
    const root = fixtureDir();
    writeJsonl(outside, "session.jsonl", records());
    symlinkSync(outside, join(root, "link"));
    mkdirSync(join(root, "real"));
    const internalTarget = writeJsonl(join(root, "real"), "session.jsonl", records());
    symlinkSync(join(root, "real"), join(root, "alias"));

    const viaLink = join(root, "link", "session.jsonl");
    const viaAlias = join(root, "alias", "session.jsonl");
    const source = createCodexTranscriptSource();
    const pages = await allPages(
      createClaudeCodeTranscriptSource(),
      input([viaLink, viaAlias, internalTarget], [root]),
    );
    expect(pages[0]?.state).toEqual({ status: "unreadable" });
    expect(pages[0]?.diagnostics[0]?.message).toContain("symbolic link");
    // Even a link that stays inside the root is never followed.
    expect(pages[1]?.state).toEqual({ status: "unreadable" });
    expect(pages[1]?.diagnostics[0]?.message).toContain("symbolic link");
    expect(pages[2]?.state).toMatchObject({ status: "available" });
    const probe = await source.probe(input([viaLink], [root]));
    expect(probe.supported).toBe(false);
    expect(probe.diagnostics[0]?.code).toBe("source.input_refused");
    expectNoFragment(JSON.stringify({ pages, probe }), CANARY);
  });

  it("still refuses a final-component symlink and accepts a root that is itself a symlink", async () => {
    const real = fixtureDir();
    const holder = fixtureDir();
    const target = writeJsonl(real, "real.jsonl", records());
    symlinkSync(target, join(real, "link.jsonl"));
    const rootLink = join(holder, "root-link");
    symlinkSync(real, rootLink);
    const source = createClaudeCodeTranscriptSource();

    const direct = await allPages(source, input([join(real, "link.jsonl")], [real]));
    expect(direct[0]?.state).toEqual({ status: "unreadable" });
    expect(direct[0]?.diagnostics[0]?.message).toContain("symbolic links are refused");

    // The declared root may be reached through a link (temp dirs often are);
    // the confinement check resolves the root once and confines the file to it.
    const throughLinkedRoot = await allPages(source, input([join(rootLink, "real.jsonl")], [rootLink]));
    expect(throughLinkedRoot[0]?.state).toMatchObject({ status: "available" });
    expectNoFragment(JSON.stringify({ direct, throughLinkedRoot }), CANARY);
  });

  it("requires roots under the default policy and keeps final-link refusal when a policy makes them optional", async () => {
    const dir = fixtureDir();
    const path = writeJsonl(dir, "session.jsonl", records());
    const strict = createClaudeCodeTranscriptSource();
    const readError = await errorOf(() => allPages(strict, input([path])));
    expect(readError.code).toBe("schema.invalid");
    expect(readError.diagnostics[0]?.path).toEqual(["roots"]);
    const probeError = await errorOf(() => strict.probe(input([path], [])));
    expect(probeError.code).toBe("schema.invalid");
    expectNoFragment(JSON.stringify([readError.message, readError.diagnostics, probeError.diagnostics]), CANARY);
    expect(readError.message).not.toContain(dir);

    const relaxed = createClaudeCodeTranscriptSource({
      privacyPolicy: tightenedPolicy((content) => {
        content.id = "optional-roots";
        content.input.rootConfinement = "optional";
      }),
    });
    const unconfined = await allPages(relaxed, input([path]));
    expect(unconfined[0]?.state).toMatchObject({ status: "available" });
    symlinkSync(path, join(dir, "link.jsonl"));
    const linked = await allPages(relaxed, input([join(dir, "link.jsonl")]));
    expect(linked[0]?.state).toEqual({ status: "unreadable" });
    // Declared roots are enforced even when the policy only makes them optional.
    const other = fixtureDir();
    const confined = await allPages(relaxed, input([path], [other]));
    expect(confined[0]?.state).toEqual({ status: "unreadable" });
  });

  it("refuses malformed path lists typed, without echoing any path", async () => {
    const dir = fixtureDir();
    const path = writeJsonl(dir, `${CANARY}.jsonl`, records());
    const source = createClaudeCodeTranscriptSource();
    const duplicate = await errorOf(() => allPages(source, input([path, path], [dir])));
    expect(duplicate.code).toBe("schema.invalid");
    expect(duplicate.diagnostics[0]?.path).toEqual(["paths", 1]);
    const nul = await errorOf(() => allPages(source, input([`${path}\0`], [dir])));
    expect(nul.code).toBe("schema.invalid");
    const badRoot = await errorOf(() => allPages(source, input([path], [""])));
    expect(badRoot.code).toBe("schema.invalid");
    const duplicateRoot = await errorOf(() => allPages(source, input([path], [dir, `${dir}/`])));
    expect(duplicateRoot.code).toBe("schema.invalid");
    expectNoFragment(
      JSON.stringify([duplicate.message, duplicate.diagnostics, nul.message, badRoot.message, duplicateRoot.message]),
      CANARY,
    );
  });

  it("leaves a durable, privacy-minimized audit trail of every refusal through the kernel", async () => {
    const outside = fixtureDir();
    const root = fixtureDir();
    const escaped = writeJsonl(outside, `${CANARY}.jsonl`, records());
    symlinkSync(outside, join(root, "link"));
    const { learning, registered } = kernelHarness(createClaudeCodeTranscriptSource(), join(root, ".store"));
    const receipt = await learning.ingest(registered, input([escaped, join(root, "link", `${CANARY}.jsonl`)], [root]));
    expect(receipt.observationIds).toEqual([]);
    expect(receipt.completeness).toBe("unknown");
    const findings = await collect(learning.queryEvidenceHealthFindings({ sourceIds: [registered.id], limit: 20 }));
    expect(findings.filter((finding) => finding.code === "source.unreadable")).toHaveLength(2);
    expect(
      findings.every((finding) => finding.effect !== "limits_claims" || finding.code === "source.adapter_diagnostic"),
    ).toBe(true);
    const pages = await collect(learning.querySourcePageReceipts({ receiptIds: receipt.pageReceiptIds, limit: 10 }));
    for (const page of pages) {
      expect(page.state.status).toBe("unreadable");
      expect(page.diagnosticCounts).toEqual([{ code: "source.input_refused", severity: "error", count: 1 }]);
    }
    expectNoFragment(JSON.stringify({ receipt, findings, pages }), CANARY);
  });
});
