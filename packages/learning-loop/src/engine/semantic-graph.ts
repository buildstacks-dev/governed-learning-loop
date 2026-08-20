// Private durable registry snapshots and derivation/execution provenance links.
import { sha256HexOfCanonicalJson } from "../canonical/canonical-json.js";
import { toJsonValue } from "../canonical/to-json-value.js";
import { LearningLoopError } from "../diagnostics.js";
import type { StreamEntry } from "../ports/store.js";
import { invalid, parseArrayOf, readFields } from "../parse/toolkit.js";
import type { Parse } from "../parse/toolkit.js";
import type { DetectorExecutionRecord } from "../records/detector-execution.js";
import { parseDetectorExecutionRecord } from "../records/detector-execution.js";
import type { InsightDerivation } from "../records/insight-derivation.js";
import { parseInsightDerivation } from "../records/insight-derivation.js";
import type { SemanticRegistryConfig } from "../records/semantic-registry.js";
import { parseSemanticRegistryConfig } from "../records/semantic-registry.js";
import { parseDigestAt, parseDurableId } from "../records/semantic-shared.js";
import type { EngineContext, RecordKind } from "./context.js";
import {
  createOnly,
  loadStoredRecord,
  parseWriteResult,
  readRecordKindRevision,
  recordDigest,
  recordKey,
} from "./context.js";

const MAX_APPEND_ATTEMPTS = 8;

const SEMANTIC_GRAPH_KINDS: readonly RecordKind[] = [
  "semantic-registry-snapshot",
  "insight-derivation",
  "derivation-execution",
  "detector-execution",
  "detector-recurrence-binding",
  "detector-recurrence-group",
  "derivation-recurrence-claim",
  "derivation-recurrence",
  "candidate-recurrence-claim",
  "detector-recurrence-group-candidate",
  "observation",
  "measurement",
  "episode",
  "episode-identity",
  "episode-outcome",
  "source-revision",
  "source-page-receipt",
  "evidence-health",
  "derivative-owner",
];

export interface SemanticRegistrySnapshot {
  readonly schemaVersion: 1;
  readonly loopRegistryRevision: string;
  readonly semanticRegistry: SemanticRegistryConfig;
  readonly snapshotDigest: string;
}

export interface DerivationExecutionLink {
  readonly schemaVersion: 1;
  readonly derivationId: string;
  readonly derivationDigest: string;
  readonly scopeDigest: string;
  readonly executionId: string;
  readonly executionKeyDigest: string;
  readonly executionDigest: string;
  readonly loopRegistryRevision: string;
  readonly semanticRegistryDigest: string;
  readonly linkDigest: string;
}

interface StoredDerivationExecutionLink {
  readonly id: string;
  readonly digest: string;
  readonly value: DerivationExecutionLink;
}

function snapshotDigest(input: Omit<SemanticRegistrySnapshot, "schemaVersion" | "snapshotDigest">): string {
  return sha256HexOfCanonicalJson(toJsonValue(input));
}

export function parseSemanticRegistrySnapshot(input: unknown): SemanticRegistrySnapshot {
  const fields = readFields(input, []);
  const schemaVersion = fields.schemaVersion1();
  const loopRegistryRevision = fields.req("loopRegistryRevision", parseDigestAt);
  const semanticRegistry = fields.req("semanticRegistry", (value) => parseSemanticRegistryConfig(value));
  const exactSnapshotDigest = fields.req("snapshotDigest", parseDigestAt);
  const base = { loopRegistryRevision, semanticRegistry };
  if (exactSnapshotDigest !== snapshotDigest(base)) {
    throw invalid("schema.corrupt", "semantic registry snapshot digest does not match its content", ["snapshotDigest"]);
  }
  return { schemaVersion, ...base, snapshotDigest: exactSnapshotDigest };
}

function linkDigest(input: Omit<DerivationExecutionLink, "schemaVersion" | "linkDigest">): string {
  return sha256HexOfCanonicalJson(toJsonValue(input));
}

function parseDerivationExecutionLink(input: unknown): DerivationExecutionLink {
  const fields = readFields(input, []);
  const schemaVersion = fields.schemaVersion1();
  const derivationId = fields.req("derivationId", parseDurableId);
  const derivationDigest = fields.req("derivationDigest", parseDigestAt);
  const exactScopeDigest = fields.req("scopeDigest", parseDigestAt);
  const executionId = fields.req("executionId", parseDurableId);
  const executionKeyDigest = fields.req("executionKeyDigest", parseDigestAt);
  const executionDigest = fields.req("executionDigest", parseDigestAt);
  const loopRegistryRevision = fields.req("loopRegistryRevision", parseDigestAt);
  const semanticRegistryDigest = fields.req("semanticRegistryDigest", parseDigestAt);
  if (derivationId !== `insight-${derivationDigest}`) {
    throw invalid("schema.corrupt", "derivation execution link has an invalid derivation identity", ["derivationId"]);
  }
  if (executionId !== `detector-execution-${executionKeyDigest}`) {
    throw invalid("schema.corrupt", "derivation execution link has an invalid execution identity", ["executionId"]);
  }
  const base = {
    derivationId,
    derivationDigest,
    scopeDigest: exactScopeDigest,
    executionId,
    executionKeyDigest,
    executionDigest,
    loopRegistryRevision,
    semanticRegistryDigest,
  };
  const exactLinkDigest = fields.req("linkDigest", parseDigestAt);
  if (exactLinkDigest !== linkDigest(base)) {
    throw invalid("schema.corrupt", "derivation execution link digest does not match its content", ["linkDigest"]);
  }
  return { schemaVersion, ...base, linkDigest: exactLinkDigest };
}

const parseStoredLinkAt: Parse<StoredDerivationExecutionLink> = (input, path) => {
  const fields = readFields(input, path);
  const id = fields.req("id", parseDurableId);
  const digest = fields.req("digest", parseDigestAt);
  const value = fields.req("value", (raw) => parseDerivationExecutionLink(raw));
  const expectedId = `execution:${value.executionId}:${value.executionDigest}`;
  const expectedDigest = recordDigest(toJsonValue(value));
  if (id !== expectedId || digest !== expectedDigest) {
    throw invalid("store.corrupt", "stored derivation execution link does not match its entry binding", path);
  }
  return { id, digest, value };
};

function parseStoredLinks(input: unknown, derivationId: string): readonly StoredDerivationExecutionLink[] {
  const links = parseArrayOf(parseStoredLinkAt)(input, ["derivationExecutionLinks"]);
  const entryIds = new Set<string>();
  for (const [index, link] of links.entries()) {
    if (link.value.derivationId !== derivationId || entryIds.has(link.id)) {
      throw invalid("store.corrupt", "derivation execution stream contains a foreign or duplicate link", [
        "derivationExecutionLinks",
        index,
      ]);
    }
    entryIds.add(link.id);
  }
  return links;
}

export function buildRegistrySnapshot(context: EngineContext): SemanticRegistrySnapshot {
  if (context.semanticRegistry === undefined) {
    throw invalid("semantic.registry_required", "semantic persistence requires a configured semantic registry", []);
  }
  const base = { loopRegistryRevision: context.registryRevision, semanticRegistry: context.semanticRegistry };
  return parseSemanticRegistrySnapshot({ schemaVersion: 1, ...base, snapshotDigest: snapshotDigest(base) });
}

export function buildDerivationLink(
  execution: DetectorExecutionRecord,
  semanticRegistryDigest: string,
  reference: Extract<DetectorExecutionRecord["result"], { readonly status: "applied" }>["derivationRefs"][number],
): DerivationExecutionLink {
  const base = {
    derivationId: reference.id,
    derivationDigest: reference.derivationDigest,
    scopeDigest: reference.scopeDigest,
    executionId: execution.id,
    executionKeyDigest: execution.executionKeyDigest,
    executionDigest: execution.executionDigest,
    loopRegistryRevision: execution.loopRegistryRevision,
    semanticRegistryDigest,
  };
  return parseDerivationExecutionLink({ schemaVersion: 1, ...base, linkDigest: linkDigest(base) });
}

function linkEntry(link: DerivationExecutionLink): StreamEntry {
  const value = toJsonValue(link);
  return {
    id: `execution:${link.executionId}:${link.executionDigest}`,
    digest: recordDigest(value),
    value,
  };
}

export async function loadRegistrySnapshot(
  context: EngineContext,
  loopRegistryRevision: string,
): Promise<SemanticRegistrySnapshot | undefined> {
  const stored = await loadStoredRecord(context, "semantic-registry-snapshot", loopRegistryRevision);
  if (stored === undefined) return undefined;
  const snapshot = parseSemanticRegistrySnapshot(stored.value);
  if (snapshot.loopRegistryRevision !== loopRegistryRevision) {
    throw invalid("store.corrupt", "semantic registry snapshot belongs to another loop revision", [
      "loopRegistryRevision",
    ]);
  }
  return snapshot;
}

export async function loadDerivationLinks(
  context: EngineContext,
  derivationId: string,
): Promise<readonly DerivationExecutionLink[]> {
  const stored = await loadStoredRecord(context, "derivation-execution", derivationId);
  return stored === undefined ? [] : parseStoredLinks(stored.value, derivationId).map((entry) => entry.value);
}

export async function appendDerivationLink(context: EngineContext, link: DerivationExecutionLink): Promise<void> {
  const entry = linkEntry(link);
  for (let attempt = 0; attempt < MAX_APPEND_ATTEMPTS; attempt += 1) {
    const stored = await loadStoredRecord(context, "derivation-execution", link.derivationId);
    const links = stored === undefined ? [] : parseStoredLinks(stored.value, link.derivationId);
    const existing = links.find((candidate) => candidate.id === entry.id);
    if (existing !== undefined) {
      if (
        existing.digest !== entry.digest ||
        existing.value.linkDigest !== link.linkDigest ||
        recordDigest(toJsonValue(existing.value)) !== recordDigest(toJsonValue(link))
      ) {
        throw invalid("store.corrupt", "derivation execution entry id binds different link content", []);
      }
      return;
    }
    const rawResult: unknown = await context.store.append(
      recordKey("derivation-execution", link.derivationId),
      stored?.revision,
      [entry],
      `derivation-execution/${link.derivationId}/${entry.id}`,
    );
    const result = parseWriteResult(rawResult);
    if (result.status === "created" || result.status === "updated" || result.status === "exists_same") {
      const committed = await loadDerivationLinks(context, link.derivationId);
      if (!committed.some((candidate) => candidate.linkDigest === link.linkDigest)) {
        throw invalid("store.corrupt", "store acknowledged a derivation link without preserving it", []);
      }
      return;
    }
  }
  throw new LearningLoopError("store.conflict", [
    { code: "store.conflict", severity: "error", message: "derivation link stream changed too many times" },
  ]);
}

export async function persistRegistrySnapshot(
  context: EngineContext,
  snapshot: SemanticRegistrySnapshot,
): Promise<void> {
  const status = await createOnly(
    context,
    "semantic-registry-snapshot",
    snapshot.loopRegistryRevision,
    snapshot,
    `semantic-registry-snapshot/${snapshot.loopRegistryRevision}`,
  );
  if (status === "conflict") {
    throw invalid("store.corrupt", "loop registry revision is bound to another semantic registry snapshot", []);
  }
}

export async function semanticGraphSnapshotRevision(context: EngineContext): Promise<string> {
  const revisions: Array<readonly [RecordKind, string]> = [];
  for (const kind of SEMANTIC_GRAPH_KINDS) {
    revisions.push([kind, await readRecordKindRevision(context.store, kind)]);
  }
  return sha256HexOfCanonicalJson(toJsonValue(revisions));
}

export async function loadInsightDerivationRecord(
  context: EngineContext,
  derivationId: string,
): Promise<InsightDerivation | undefined> {
  const stored = await loadStoredRecord(context, "insight-derivation", derivationId);
  if (stored === undefined) return undefined;
  const derivation = parseInsightDerivation(stored.value);
  if (derivation.id !== stored.key.id) {
    throw invalid("store.corrupt", "stored insight id does not match its key", []);
  }
  return derivation;
}

export async function loadDetectorExecutionRecord(
  context: EngineContext,
  executionId: string,
): Promise<DetectorExecutionRecord | undefined> {
  const stored = await loadStoredRecord(context, "detector-execution", executionId);
  if (stored === undefined) return undefined;
  const execution = parseDetectorExecutionRecord(stored.value);
  if (execution.id !== stored.key.id) {
    throw invalid("store.corrupt", "stored detector execution id does not match its key", []);
  }
  return execution;
}
