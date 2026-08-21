// Shared helpers for the negative-control catalog (decision 0024). Every
// fixture here is hand-authored and adversarial by construction; none copies a
// real transcript. Canaries are uppercase-and-hyphen so no 6-character window
// can coincide with a lowercase hex locator by chance.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type {
  EvidencePage,
  EvidenceSource,
  LearningLoop,
  LearningStore,
  RegisteredSource,
} from "@cormidia/learning-loop";
import {
  conservativePolicy,
  createExactScopePolicy,
  createLearningLoop,
  defineSourceRegistration,
} from "@cormidia/learning-loop";
import { createFileStore } from "@cormidia/learning-loop/node";
import { createStructuredContentPolicy, createTestIdentityPort } from "@cormidia/learning-loop/testing";
import type { TranscriptFilesInput, TranscriptPrivacyPolicy } from "../../src/index.js";
import { defaultTranscriptPrivacyPolicy, transcriptPrivacyPolicyDigest } from "../../src/index.js";

export const CONTENT_POLICY_ID = "transcript-structural-test";

/** Asserts that neither the canary nor any window of `minimum` characters of it appears in `text`. */
export function expectNoFragment(text: string, canary: string, minimum = 6): void {
  if (text.includes(canary)) throw new Error("canary appeared verbatim");
  for (let start = 0; start + minimum <= canary.length; start += 1) {
    const window = canary.slice(start, start + minimum);
    if (text.includes(window)) throw new Error(`canary fragment ${JSON.stringify(window)} appeared`);
  }
}

export function walkFiles(dir: string): readonly string[] {
  const files: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) files.push(...walkFiles(path));
    else files.push(path);
  }
  return files;
}

export function allStoredBytes(storeDir: string): string {
  return walkFiles(storeDir)
    .map((file) => readFileSync(file, "utf8"))
    .join("\n");
}

/** A policy derived from the default with one tightening applied and an honest digest. */
export function tightenedPolicy(
  mutate: (content: {
    ceilings: {
      maximumFileBytes: number;
      maximumLineBytes: number;
      maximumRecordsPerFile: number;
      maximumNestingDepth: number;
      maximumProcessingMillisPerFile: number;
    };
    input: { rootConfinement: "required" | "optional" };
    id: string;
  }) => void,
): TranscriptPrivacyPolicy {
  const base = defaultTranscriptPrivacyPolicy();
  const content = {
    id: base.id,
    version: base.version,
    input: { ...base.input },
    ceilings: { ...base.ceilings },
    decoding: { ...base.decoding },
    persistence: { ...base.persistence },
    recurrence: { ...base.recurrence },
    outbound: { ...base.outbound },
    publication: { ...base.publication },
    processingBasis: { ...base.processingBasis },
    disposition: { ...base.disposition },
  };
  mutate(content);
  return { schemaVersion: 1, ...content, policyDigest: transcriptPrivacyPolicyDigest(content) };
}

export interface KernelHarness {
  readonly learning: LearningLoop;
  readonly store: LearningStore;
  readonly registered: RegisteredSource<TranscriptFilesInput>;
}

/** A real kernel loop over a filesystem store so durable bytes can be grepped for canaries. */
export function kernelHarness(source: EvidenceSource<TranscriptFilesInput>, storeDir: string): KernelHarness {
  const registered = defineSourceRegistration({ source, trustCeiling: "advisory", contentPolicyId: CONTENT_POLICY_ID });
  const store = createFileStore({ rootDir: storeDir });
  const learning = createLearningLoop({
    store,
    policy: conservativePolicy(),
    identity: createTestIdentityPort(),
    scopePolicy: createExactScopePolicy(),
    contentPolicies: [createStructuredContentPolicy({ id: CONTENT_POLICY_ID })],
    sources: [registered],
    queryCursorScope: "negative-controls",
  });
  return { learning, store, registered };
}

export async function collect<T>(iterable: AsyncIterable<{ readonly items: readonly T[] }>): Promise<readonly T[]> {
  const items: T[] = [];
  for await (const page of iterable) items.push(...page.items);
  return items;
}

export function observationsOf(pages: readonly EvidencePage[], kind: string) {
  return pages.flatMap((page) => page.observations.filter((observation) => observation.kind === kind));
}

/** Closed structural vocabulary every emitted observation must stay inside. */
export const ALLOWED_DATA_KEYS: { readonly [kind: string]: readonly string[] } = {
  "transcript.session.meta": ["provider", "adapterVersion", "providerVersionBand", "cwdLocator", "branchLocator"],
  "transcript.message": ["actor", "charCount", "hasToolBlocks", "correctionSignal"],
  "transcript.tool.completed": ["toolName", "outcome"],
  "transcript.usage": ["tokensIn", "tokensOut", "quality"],
  "transcript.task.signal": ["signal"],
  "transcript.unknown": ["nativeType"],
};

export const STRUCTURAL_STRING = /^[A-Za-z0-9_.:+/-]{1,128}$/;
