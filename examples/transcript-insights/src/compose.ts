// Loop composition: the host wires store, policy, identity, scope policy,
// content policy, and both transcript adapter registrations BEFORE
// construction; the engine digests the registry so any change to any of these
// is a new registry revision on every receipt.
import { join, resolve } from "node:path";
import type { LearningLoop, LearningStore, RegisteredSource, VerifiedPrincipal } from "@cormidia/learning-loop";
import {
  conservativePolicy,
  createExactScopePolicy,
  createLearningLoop,
  defineSourceRegistration,
} from "@cormidia/learning-loop";
import { createFileStore } from "@cormidia/learning-loop/node";
import type { TranscriptFilesInput } from "@cormidia/learning-loop-transcript-sources";
import {
  createClaudeCodeTranscriptSource,
  createCodexTranscriptSource,
} from "@cormidia/learning-loop-transcript-sources";
import { TRANSCRIPT_CONTENT_POLICY_ID, createTranscriptContentPolicy } from "./content-policy.js";
import type { Provider } from "./discovery.js";
import { createDemoIdentityPort } from "./identity.js";
import { ensureLocatorKey, ensureStateDir } from "./state.js";

export interface DemoLoop {
  readonly learning: LearningLoop;
  readonly store: LearningStore;
  readonly sources: { readonly [P in Provider]: RegisteredSource<TranscriptFilesInput> };
  readonly distiller: VerifiedPrincipal;
  readonly human: VerifiedPrincipal;
  readonly locatorKey: string;
}

export async function composeDemoLoop(stateDirInput: string): Promise<DemoLoop> {
  const stateDir = resolve(stateDirInput);
  await ensureStateDir(stateDir);
  const locatorKey = await ensureLocatorKey(stateDir);
  const store = createFileStore({ rootDir: join(stateDir, "store") });
  const identity = createDemoIdentityPort();
  const distiller = await identity.verify({ principalId: "demo-distiller" });
  const human = await identity.verify({ principalId: "local-human" });
  // Transcript-derived evidence is registered at the hard "advisory" ceiling:
  // trust is granted by this host registration, never claimed by the adapters.
  const claudeCode = defineSourceRegistration({
    source: createClaudeCodeTranscriptSource(),
    trustCeiling: "advisory",
    contentPolicyId: TRANSCRIPT_CONTENT_POLICY_ID,
  });
  const codex = defineSourceRegistration({
    source: createCodexTranscriptSource(),
    trustCeiling: "advisory",
    contentPolicyId: TRANSCRIPT_CONTENT_POLICY_ID,
  });
  const learning = createLearningLoop({
    store,
    policy: conservativePolicy(),
    identity,
    scopePolicy: createExactScopePolicy(),
    contentPolicies: [createTranscriptContentPolicy()],
    sources: [claudeCode, codex],
  });
  return { learning, store, sources: { "claude-code": claudeCode, codex }, distiller, human, locatorKey };
}
