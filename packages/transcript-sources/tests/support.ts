// Shared test support. ALL fixtures are hand-authored synthetic sessions —
// never copied from real transcripts (see ../AGENTS.md).
import { createHash, createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EvidencePage, EvidenceSource } from "@cormidia/learning-loop";
import type { TranscriptFilesInput } from "../src/index.js";

export interface FixtureDir {
  readonly dir: string;
  cleanup(): void;
}

export function makeFixtureDir(): FixtureDir {
  const dir = mkdtempSync(join(tmpdir(), "transcript-sources-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function writeRaw(dir: string, name: string, content: string): string {
  const path = join(dir, name);
  writeFileSync(path, content, "utf8");
  return path;
}

export function writeJsonl(dir: string, name: string, records: readonly unknown[]): string {
  return writeRaw(dir, name, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
}

export const TEST_LOCATOR_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

export function expectedSourceRef(path: string, locatorKey: string = TEST_LOCATOR_KEY): string {
  return createHmac("sha256", locatorKey)
    .update("transcript-source-ref:v1\0", "utf8")
    .update(path, "utf8")
    .digest("hex");
}

export function expectedSourceRevision(path: string, locatorKey: string = TEST_LOCATOR_KEY): string {
  const rawDigest = createHash("sha256").update(readFileSync(path)).digest("hex");
  return createHmac("sha256", locatorKey)
    .update("transcript-source-revision:v1\0", "utf8")
    .update(rawDigest, "utf8")
    .digest("hex");
}

export function expectedCwdLocator(cwd: string, locatorKey: string = TEST_LOCATOR_KEY): string {
  return createHmac("sha256", locatorKey)
    .update("transcript-cwd-locator:v1\0", "utf8")
    .update(cwd, "utf8")
    .digest("hex");
}

export function expectedBranchLocator(branch: string, locatorKey: string = TEST_LOCATOR_KEY): string {
  return createHmac("sha256", locatorKey)
    .update("transcript-branch-locator:v1\0", "utf8")
    .update(branch, "utf8")
    .digest("hex");
}

export function expectedSessionLocator(
  provider: string,
  nativeSessionId: string,
  locatorKey: string = TEST_LOCATOR_KEY,
): string {
  return createHmac("sha256", locatorKey)
    .update("transcript-session-locator:v1\0", "utf8")
    .update(provider, "utf8")
    .update("\0", "utf8")
    .update(nativeSessionId, "utf8")
    .digest("hex");
}

export function inputOf(paths: readonly string[], locatorKey: string = TEST_LOCATOR_KEY): TranscriptFilesInput {
  return { kind: "explicit_files", paths, locatorKey };
}

export async function allPages(
  source: EvidenceSource<TranscriptFilesInput>,
  input: TranscriptFilesInput,
  cursor?: string,
): Promise<EvidencePage[]> {
  const pages: EvidencePage[] = [];
  for await (const page of source.read(input, cursor)) pages.push(page);
  return pages;
}

export function kindsOf(page: EvidencePage): readonly string[] {
  return page.observations.map((observation) => observation.kind);
}

export function ofKind(page: EvidencePage, kind: string) {
  return page.observations.filter((observation) => observation.kind === kind);
}
