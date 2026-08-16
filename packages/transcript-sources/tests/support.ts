// Shared test support. ALL fixtures are hand-authored synthetic sessions —
// never copied from real transcripts (see ../AGENTS.md).
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

export const TEST_LOCATOR_KEY = "test-locator-key";

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
