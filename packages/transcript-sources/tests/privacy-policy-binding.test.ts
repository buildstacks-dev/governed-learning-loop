// End to end: the policy an adapter runs under is bound into the kernel's page
// and import receipts exactly, idempotently, and differently per policy.
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createClaudeCodeTranscriptSource, defaultTranscriptPrivacyPolicy } from "../src/index.js";
import { collect, kernelHarness, tightenedPolicy } from "./negative-controls/support.js";
import { allPages, inputOf, makeFixtureDir, writeJsonl } from "./support.js";

const SESSION_ID = "ffff6666-0000-4111-8222-333377778888";

function session(): readonly unknown[] {
  return [
    {
      type: "user",
      sessionId: SESSION_ID,
      uuid: "u-1",
      cwd: "/workspaces/sample",
      timestamp: "2026-08-13T04:00:00.000Z",
      message: { role: "user", content: "bind the policy" },
    },
  ];
}

describe("privacy policy receipt binding", () => {
  const fixtures: (() => void)[] = [];
  afterEach(() => {
    for (const cleanup of fixtures.splice(0)) cleanup();
  });
  function fixtureDir(): string {
    const fixture = makeFixtureDir();
    fixtures.push(() => fixture.cleanup());
    return fixture.dir;
  }

  it("binds the exact governing policy into every receipt and changes them when the policy changes", async () => {
    const dir = fixtureDir();
    const path = writeJsonl(dir, "session.jsonl", session());
    const defaults = defaultTranscriptPrivacyPolicy();
    const tightened = tightenedPolicy((content) => {
      content.id = "host-tightened";
      content.ceilings.maximumRecordsPerFile = 1_000;
    });
    const byDefault = kernelHarness(createClaudeCodeTranscriptSource(), join(dir, ".store-default"));
    const byTightened = kernelHarness(
      createClaudeCodeTranscriptSource({ privacyPolicy: tightened }),
      join(dir, ".store-tightened"),
    );

    const first = await byDefault.learning.ingest(byDefault.registered, inputOf([path]));
    const again = await byDefault.learning.ingest(byDefault.registered, inputOf([path]));
    const other = await byTightened.learning.ingest(byTightened.registered, inputOf([path]));

    expect(first.importReceipt.privacyPolicy).toEqual({ id: defaults.id, digest: defaults.policyDigest });
    expect(again.importReceipt).toEqual(first.importReceipt);
    expect(other.importReceipt.privacyPolicy).toEqual({ id: "host-tightened", digest: tightened.policyDigest });
    expect(other.observationIds).toEqual(first.observationIds);
    expect(other.id).not.toBe(first.id);
    expect(other.pageReceiptIds).not.toEqual(first.pageReceiptIds);
    expect(other.importReceipt.sourceRegistrationRevision).not.toBe(first.importReceipt.sourceRegistrationRevision);

    await expect(byDefault.learning.getImportReceipt({ importReceiptId: first.id })).resolves.toMatchObject({
      privacyPolicy: { id: defaults.id, digest: defaults.policyDigest },
    });
    const pages = await collect(
      byDefault.learning.querySourcePageReceipts({ receiptIds: first.pageReceiptIds, limit: 10 }),
    );
    expect(pages).toHaveLength(1);
    expect(pages[0]?.privacyPolicy).toEqual({ id: defaults.id, digest: defaults.policyDigest });
    expect(pages[0]?.adapterVersion).toBe(createClaudeCodeTranscriptSource().descriptor.adapterVersion);
    // Projections themselves do not carry the policy: it is receipt lineage, not content.
    const projected = await allPages(createClaudeCodeTranscriptSource(), inputOf([path]));
    expect(JSON.stringify(projected)).not.toContain(defaults.policyDigest);
  });
});
