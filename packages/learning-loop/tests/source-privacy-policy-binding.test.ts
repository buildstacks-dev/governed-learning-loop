// Decision 0024: an adapter's content-addressed privacy-policy declaration is
// snapshotted at registration, folded into the source registration revision,
// and surfaced as exact `privacyPolicy` fields on every page and import
// receipt. Undeclared sources keep their historical registry and receipt bytes.
import { describe, expect, it } from "vitest";
import type { EvidencePage, EvidenceSource, QueryPage, SourceDescriptor } from "../src/index.js";
import {
  defineSourceRegistration,
  parseImportReceipt,
  parseSourcePageReceipt,
  sha256HexOfCanonicalJson,
} from "../src/index.js";
import { buildImportReceipt, buildSourcePageReceipt } from "../src/engine/source-receipts.js";
import { CONTENT_POLICY_ID, createHarness } from "./engine-harness.js";

const POLICY_A = { id: "transcript-privacy-default", digest: "a".repeat(64) } as const;
const POLICY_B = { id: "transcript-privacy-tightened", digest: "b".repeat(64) } as const;

async function itemsOf<T>(iterable: AsyncIterable<QueryPage<T>>): Promise<readonly T[]> {
  const items: T[] = [];
  for await (const page of iterable) items.push(...page.items);
  return items;
}

function page(sourceRef: string): EvidencePage {
  return {
    sourceRef,
    pageRef: "session",
    state: { status: "available", sourceRevision: "revision-1", completeness: "complete" },
    observations: [
      {
        sourceRecordId: "record-1",
        episodeId: "episode-1",
        kind: "transcript.message",
        data: { actor: "human", charCount: 12 },
        completeness: "complete",
      },
    ],
    measurements: [],
    episodes: [],
    diagnostics: [],
  };
}

function adapter(descriptor: SourceDescriptor, sourceRef = "artifact"): EvidenceSource<null> {
  return {
    descriptor,
    probe: () => Promise.resolve({ supported: true, diagnostics: [] }),
    read: async function* (): AsyncIterable<EvidencePage> {
      yield page(sourceRef);
    },
  };
}

function registration(descriptor: SourceDescriptor) {
  return defineSourceRegistration({
    source: adapter(descriptor),
    trustCeiling: "advisory",
    contentPolicyId: CONTENT_POLICY_ID,
  });
}

describe("source privacy-policy declaration binding", () => {
  it("folds a declared policy into the registration revision and preserves undeclared historical bytes", () => {
    const base = { id: "declared-source", adapterVersion: "1.0.0" };
    const undeclared = registration(base).registryRevision;
    expect(undeclared).toBe(
      sha256HexOfCanonicalJson({
        sourceId: "declared-source",
        adapterVersion: "1.0.0",
        trustCeiling: "advisory",
        contentPolicyId: CONTENT_POLICY_ID,
      }),
    );
    const declaredA = registration({ ...base, privacyPolicy: POLICY_A }).registryRevision;
    const declaredAAgain = registration({ ...base, privacyPolicy: { ...POLICY_A } }).registryRevision;
    const declaredB = registration({ ...base, privacyPolicy: POLICY_B }).registryRevision;
    const sameIdOtherDigest = registration({
      ...base,
      privacyPolicy: { id: POLICY_A.id, digest: "c".repeat(64) },
    }).registryRevision;
    expect(declaredA).toBe(
      sha256HexOfCanonicalJson({
        sourceId: "declared-source",
        adapterVersion: "1.0.0",
        trustCeiling: "advisory",
        contentPolicyId: CONTENT_POLICY_ID,
        privacyPolicy: POLICY_A,
      }),
    );
    expect(declaredAAgain).toBe(declaredA);
    expect(new Set([undeclared, declaredA, declaredB, sameIdOtherDigest]).size).toBe(4);
  });

  it("refuses malformed declarations at registration with config.invalid", () => {
    const base = { id: "malformed-declaration", adapterVersion: "1.0.0" };
    const malformed: readonly unknown[] = [
      { id: POLICY_A.id },
      { digest: POLICY_A.digest },
      { id: "", digest: POLICY_A.digest },
      { id: "tab\tid", digest: POLICY_A.digest },
      { id: "x".repeat(1_001), digest: POLICY_A.digest },
      { id: POLICY_A.id, digest: "A".repeat(64) },
      { id: POLICY_A.id, digest: "a".repeat(63) },
      { id: POLICY_A.id, digest: "sha256:" + "a".repeat(64) },
      "not-an-object",
      null,
    ];
    for (const privacyPolicy of malformed) {
      const descriptor: unknown = { ...base, privacyPolicy };
      expect(() =>
        defineSourceRegistration({
          // The descriptor crosses the registration boundary as an untrusted value.
          source: adapter(descriptor as SourceDescriptor),
          trustCeiling: "advisory",
          contentPolicyId: CONTENT_POLICY_ID,
        }),
      ).toThrowError(expect.objectContaining({ code: "config.invalid" }));
    }
  });

  it("binds the exact declaration into page and import receipts and makes it audit-visible", async () => {
    const declared = registration({ id: "declared-source", adapterVersion: "1.0.0", privacyPolicy: POLICY_A });
    const undeclared = registration({ id: "undeclared-source", adapterVersion: "1.0.0" });
    const { learning } = await createHarness([declared, undeclared]);

    const declaredReceipt = await learning.ingest(declared, null);
    const undeclaredReceipt = await learning.ingest(undeclared, null);

    expect(declaredReceipt.importReceipt.privacyPolicy).toEqual(POLICY_A);
    expect("privacyPolicy" in undeclaredReceipt.importReceipt).toBe(false);
    await expect(learning.getImportReceipt({ importReceiptId: declaredReceipt.id })).resolves.toMatchObject({
      privacyPolicy: POLICY_A,
    });

    const pages = await itemsOf(
      learning.querySourcePageReceipts({ receiptIds: declaredReceipt.pageReceiptIds, limit: 10 }),
    );
    expect(pages).toHaveLength(1);
    expect(pages[0]?.privacyPolicy).toEqual(POLICY_A);
    expect(pages[0]?.sourceRegistrationRevision).toBe(declared.registryRevision);
    const undeclaredPages = await itemsOf(
      learning.querySourcePageReceipts({ receiptIds: undeclaredReceipt.pageReceiptIds, limit: 10 }),
    );
    expect(undeclaredPages[0] !== undefined && "privacyPolicy" in undeclaredPages[0]).toBe(false);

    // Idempotent: the same declared import reproduces the exact receipt bytes.
    const again = await learning.ingest(declared, null);
    expect(again.importReceipt).toEqual(declaredReceipt.importReceipt);
    expect(again.pageReceiptIds).toEqual(declaredReceipt.pageReceiptIds);
  });

  it("changes every receipt id when the declared policy content changes, without changing derivative ids", async () => {
    const withA = registration({ id: "policy-source", adapterVersion: "1.0.0", privacyPolicy: POLICY_A });
    const withB = registration({ id: "policy-source", adapterVersion: "1.0.0", privacyPolicy: POLICY_B });
    const loopA = await createHarness([withA]);
    const loopB = await createHarness([withB]);

    const receiptA = await loopA.learning.ingest(withA, null);
    const receiptB = await loopB.learning.ingest(withB, null);

    expect(receiptA.observationIds).toEqual(receiptB.observationIds);
    expect(receiptA.importReceipt.sourceRegistrationRevision).not.toBe(
      receiptB.importReceipt.sourceRegistrationRevision,
    );
    expect(receiptA.id).not.toBe(receiptB.id);
    expect(receiptA.pageReceiptIds).not.toEqual(receiptB.pageReceiptIds);
    expect(receiptA.importReceipt.privacyPolicy).toEqual(POLICY_A);
    expect(receiptB.importReceipt.privacyPolicy).toEqual(POLICY_B);
  });

  it("snapshots the declaration at registration so later descriptor mutation cannot rebind receipts", async () => {
    const descriptor: { id: string; adapterVersion: string; privacyPolicy: { id: string; digest: string } } = {
      id: "mutable-declaration",
      adapterVersion: "1.0.0",
      privacyPolicy: { id: POLICY_A.id, digest: POLICY_A.digest },
    };
    const registered = registration(descriptor);
    descriptor.privacyPolicy.digest = POLICY_B.digest;
    descriptor.privacyPolicy = { id: POLICY_B.id, digest: POLICY_B.digest };
    const { learning } = await createHarness([registered]);

    const receipt = await learning.ingest(registered, null);
    expect(receipt.importReceipt.privacyPolicy).toEqual(POLICY_A);
    const pages = await itemsOf(learning.querySourcePageReceipts({ receiptIds: receipt.pageReceiptIds, limit: 10 }));
    expect(pages[0]?.privacyPolicy).toEqual(POLICY_A);
  });

  it("parses, digests, and refuses corrupt privacy-policy members on durable receipts", () => {
    const common = {
      sourceId: "golden-source",
      sourceRegistrationRevision: "a".repeat(64),
      adapterVersion: "1.2.3",
      contentPolicyId: "golden-policy",
      contentPolicyDigest: "b".repeat(64),
      loopRegistryRevision: "c".repeat(64),
      sourceRef: "golden-artifact",
      pageRef: "golden-page",
      state: { status: "available" as const, sourceRevision: "golden-revision", completeness: "complete" as const },
      derivatives: [],
      projectionCounts: { observations: 0, measurements: 0, episodes: 0, rejected: 0 },
      diagnostics: [],
      healthFindingIds: [],
    };
    const historical = buildSourcePageReceipt(common);
    const declared = buildSourcePageReceipt({ ...common, privacyPolicy: POLICY_A });
    expect("privacyPolicy" in historical).toBe(false);
    expect(declared.privacyPolicy).toEqual(POLICY_A);
    expect(declared.receiptDigest).not.toBe(historical.receiptDigest);
    // Golden vectors: the declared member enters the digest exactly once.
    expect(historical.receiptDigest).toBe("782d97f5bb2e409c520fbd6739345bc437f520c1fcef51c583078a4b13f4c388");
    expect(declared.receiptDigest).toBe("7ff7b4245a0e07778c26659647ecaeac0033f7bbb4e98deab6cb8819c6987f38");
    expect(parseSourcePageReceipt(declared)).toEqual(declared);
    expect(parseSourcePageReceipt(JSON.parse(JSON.stringify(declared)))).toEqual(declared);

    const importCommon = {
      sourceId: "golden-source",
      sourceRegistrationRevision: "a".repeat(64),
      loopRegistryRevision: "c".repeat(64),
      pageReceiptIds: [declared.id],
      sourceRevisions: ["golden-revision"],
      completeness: "complete" as const,
      healthFindingIds: [],
    };
    const historicalImport = buildImportReceipt(importCommon);
    const declaredImport = buildImportReceipt({ ...importCommon, privacyPolicy: POLICY_A });
    expect("privacyPolicy" in historicalImport).toBe(false);
    expect(declaredImport.privacyPolicy).toEqual(POLICY_A);
    expect(declaredImport.receiptDigest).not.toBe(historicalImport.receiptDigest);
    expect(declaredImport.receiptDigest).toBe("91e7d88406a1ff6eabad7d4deb154731ab23611b09bf8290e7242ad19433723d");
    expect(parseImportReceipt(declaredImport)).toEqual(declaredImport);

    // A declaration that was not digested, or a digest that no longer matches,
    // is corruption; a half-declaration is a schema failure.
    expect(() => parseSourcePageReceipt({ ...historical, privacyPolicy: POLICY_A })).toThrowError(
      expect.objectContaining({ code: "schema.corrupt" }),
    );
    expect(() => parseSourcePageReceipt({ ...declared, privacyPolicy: POLICY_B })).toThrowError(
      expect.objectContaining({ code: "schema.corrupt" }),
    );
    expect(() => parseImportReceipt({ ...historicalImport, privacyPolicy: POLICY_A })).toThrowError(
      expect.objectContaining({ code: "schema.corrupt" }),
    );
    expect(() => parseSourcePageReceipt({ ...declared, privacyPolicy: { id: POLICY_A.id } })).toThrowError(
      expect.objectContaining({ code: "schema.invalid" }),
    );
    expect(() => parseImportReceipt({ ...declaredImport, privacyPolicy: { digest: POLICY_A.digest } })).toThrowError(
      expect.objectContaining({ code: "schema.invalid" }),
    );
    expect(() =>
      parseImportReceipt({ ...declaredImport, privacyPolicy: { id: POLICY_A.id, digest: "not-a-digest" } }),
    ).toThrowError(expect.objectContaining({ code: "schema.invalid" }));
  });
});
