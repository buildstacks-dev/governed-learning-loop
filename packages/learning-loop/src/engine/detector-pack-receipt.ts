// Private receipt-last persistence and exact-scope index for detector-pack audits.
import { sha256HexOfCanonicalJson } from "../canonical/canonical-json.js";
import { toJsonValue } from "../canonical/to-json-value.js";
import { LearningLoopError } from "../diagnostics.js";
import type { LearningStore } from "../ports/store.js";
import { invalid, parseNonEmptyText, readFields } from "../parse/toolkit.js";
import type { Parse } from "../parse/toolkit.js";
import type { DetectorPackRunReceipt } from "../records/detector-pack-run-receipt.js";
import {
  detectorPackRunGovernanceSnapshotDigest,
  detectorPackRunItemDigest,
  detectorPackRunKeyDigest,
  detectorPackRunPopulationDigest,
  detectorPackRunReceiptDigest,
  parseDetectorPackRunReceipt,
} from "../records/detector-pack-run-receipt.js";
import { parseEpisodeRecord } from "../records/episode.js";
import { detectorRefKey, parseDigestAt, parseDurableId, scopeDigest } from "../records/semantic-shared.js";
import type { EngineContext } from "./context.js";
import { createOnly, loadStoredRecord, parseWriteResult, recordDigest } from "./context.js";
import type { DetectorPackRunInput, DetectorPackRunResult } from "./detector-pack-run.js";
import { loadExecutionRecurrenceBinding, recurrenceReceiptLineage } from "./detector-recurrence.js";
import { loadEpisodeIdentityState } from "./episode-identity.js";
import { loadLatestEpisodeOutcomeClaim } from "./episode-outcome.js";
import { buildRegistrySnapshot, persistRegistrySnapshot } from "./semantic-graph.js";

const PACK_RUN_INDEX_KIND = "detector-pack-run-index";
const MAX_BUILD_ATTEMPTS = 3;

interface PackRunScopeIndexEntry {
  readonly schemaVersion: 1;
  readonly receiptId: string;
  readonly receiptDigest: string;
  readonly scopeDigest: string;
  readonly indexDigest: string;
}

export interface PackRunScopeIndexPage {
  readonly entries: readonly PackRunScopeIndexEntry[];
  readonly nextCursor?: string;
  readonly snapshotRevision: string;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function packRunScopeNamespace(exactScopeDigest: string): string {
  return `learning-pack-run-scope-${exactScopeDigest}`;
}

function indexDigest(input: Omit<PackRunScopeIndexEntry, "schemaVersion" | "indexDigest">): string {
  return sha256HexOfCanonicalJson(
    toJsonValue({
      domain: "detector-pack-run-index:v1",
      receiptId: input.receiptId,
      receiptDigest: input.receiptDigest,
      scopeDigest: input.scopeDigest,
    }),
  );
}

function parseIndexAt(input: unknown, path: readonly (string | number)[]): PackRunScopeIndexEntry {
  const fields = readFields(input, path);
  const schemaVersion = fields.schemaVersion1();
  const base = {
    receiptId: fields.req("receiptId", parseDurableId),
    receiptDigest: fields.req("receiptDigest", parseDigestAt),
    scopeDigest: fields.req("scopeDigest", parseDigestAt),
  };
  const exactIndexDigest = fields.req("indexDigest", parseDigestAt);
  if (exactIndexDigest !== indexDigest(base)) {
    throw invalid("store.corrupt", "detector pack-run scope index digest is invalid", path);
  }
  return { schemaVersion, ...base, indexDigest: exactIndexDigest };
}

const parseStoredRecordAt: Parse<{
  readonly key: { readonly namespace: string; readonly kind: string; readonly id: string };
  readonly value: unknown;
  readonly revision: string;
  readonly digest: string;
}> = (input, path) => {
  const fields = readFields(input, path);
  const keyFields = readFields(
    fields.req("key", (value) => value),
    [...path, "key"],
  );
  return {
    key: {
      namespace: keyFields.req("namespace", parseNonEmptyText),
      kind: keyFields.req("kind", parseNonEmptyText),
      id: keyFields.req("id", parseNonEmptyText),
    },
    value: fields.req("value", (value) => value),
    revision: fields.req("revision", parseNonEmptyText),
    digest: fields.req("digest", parseNonEmptyText),
  };
};

function parseStoredIndex(
  input: unknown,
  exactScopeDigest: string,
  path: readonly (string | number)[],
): PackRunScopeIndexEntry {
  const stored = parseStoredRecordAt(input, path);
  if (stored.key.namespace !== packRunScopeNamespace(exactScopeDigest) || stored.key.kind !== PACK_RUN_INDEX_KIND) {
    throw invalid("store.corrupt", "store returned a foreign detector pack-run index", [...path, "key"]);
  }
  const value = toJsonValue(stored.value);
  if (stored.digest !== recordDigest(value)) {
    throw invalid("store.corrupt", "detector pack-run index envelope digest is invalid", [...path, "digest"]);
  }
  const entry = parseIndexAt(value, [...path, "value"]);
  if (entry.receiptId !== stored.key.id || entry.scopeDigest !== exactScopeDigest) {
    throw invalid("store.corrupt", "detector pack-run index does not match its exact key", path);
  }
  return entry;
}

function exactExecutionDisposition(
  item: DetectorPackRunResult["items"][number],
): DetectorPackRunReceipt["items"][number]["executionDisposition"] {
  if (item.result?.status === "applied") return "executed";
  if (item.result?.status === "not_applicable" || item.disposition === "not_applicable") return "not_applicable";
  if (item.result?.status === "incomplete" || item.disposition === "incomplete") return "incomplete";
  return item.disposition === "refused" ? "refused" : "capped";
}

function reasonCodes(item: DetectorPackRunResult["items"][number]): readonly string[] {
  const executionResult = item.result?.execution?.result;
  if (executionResult?.status === "not_applicable" || executionResult?.status === "incomplete") {
    return executionResult.reasonCodes;
  }
  if (item.result !== undefined && item.result.execution === undefined) {
    return [...new Set(item.result.diagnostics.map((diagnostic) => diagnostic.code))]
      .filter((code) => code.startsWith("detector."))
      .sort(compareText);
  }
  if (item.result === undefined) {
    return [...new Set(item.diagnostics.map((diagnostic) => diagnostic.code))].sort(compareText);
  }
  return item.recurrenceDisposition === "capped" ? ["detector.pack_group_capped"] : [];
}

async function buildReceiptItem(
  context: EngineContext,
  item: DetectorPackRunResult["items"][number],
): Promise<Omit<DetectorPackRunReceipt["items"][number], "itemDigest">> {
  const execution = item.result?.execution;
  const registration = context.semanticDetectorsByRef?.get(detectorRefKey(item.detector));
  if (registration === undefined)
    throw invalid("store.corrupt", "pack receipt detector registration is unavailable", []);
  if (execution !== undefined && detectorRefKey(execution.detector) !== detectorRefKey(item.detector)) {
    throw invalid("store.corrupt", "pack result execution belongs to another detector", []);
  }
  const executionDisposition = exactExecutionDisposition(item);
  const executionRef =
    execution === undefined
      ? null
      : {
          id: execution.id,
          executionKeyDigest: execution.executionKeyDigest,
          executionDigest: execution.executionDigest,
        };
  let recurrence: DetectorPackRunReceipt["items"][number]["recurrence"];
  if (item.result === undefined) {
    recurrence = {
      status: "absent",
      reason:
        item.disposition === "capped" || item.disposition === "refused"
          ? "result_not_retained"
          : "execution_not_materialized",
      decisionBindingDigest: null,
    };
  } else if (item.result.recurrence.status === "grouped") {
    if (execution === undefined) throw invalid("store.corrupt", "grouped pack result has no execution", []);
    const lineage = await recurrenceReceiptLineage(context, execution);
    const binding = lineage.binding;
    if (binding === undefined || binding.locator === null || binding.groupKeyDigest === null) {
      throw invalid("store.corrupt", "grouped pack result has no exact recurrence decision", []);
    }
    const groupDisposition = item.recurrenceDisposition;
    if (groupDisposition !== "unassessed" && groupDisposition !== "capped") {
      throw invalid("store.corrupt", "configured grouped pack result has no exact policy disposition", []);
    }
    recurrence = {
      status: "grouped",
      groupKeyDigest: binding.groupKeyDigest,
      locator: binding.locator,
      decisionBindingDigest: binding.bindingDigest,
      executionCount: lineage.executionCount,
      distinctEpisodeCount: lineage.episodeIdentityDigests.length,
      episodeIdentityDigests: lineage.episodeIdentityDigests,
      episodeIdentitySetDigest: sha256HexOfCanonicalJson(toJsonValue(lineage.episodeIdentityDigests)),
      governance: { status: "not_assessed", reason: "candidate_claims_deferred", groupDisposition },
    };
  } else {
    const binding = execution === undefined ? undefined : await loadExecutionRecurrenceBinding(context, execution.id);
    recurrence = {
      status: "absent",
      reason: item.result.recurrence.status,
      decisionBindingDigest: binding?.bindingDigest ?? null,
    };
  }
  return {
    detector: execution?.detector ?? {
      id: registration.id,
      version: registration.version,
      registrationDigest: registration.registrationDigest,
      configurationDigest: registration.configurationDigest,
      implementationDigest: registration.implementationDigest,
    },
    lens: item.lens,
    outputKind: execution?.outputKind ?? registration.outputKind,
    executionDisposition,
    executionRef,
    recurrence,
    reasonCodes: reasonCodes(item),
  };
}

export async function resolveDetectorPackReceiptPopulation(
  context: EngineContext,
  input: DetectorPackRunInput,
): Promise<Omit<DetectorPackRunReceipt["population"], "populationDigest"> | undefined> {
  const exactScopeDigest = scopeDigest(input.scope);
  const resolvedEpisodes: DetectorPackRunReceipt["population"]["resolvedEpisodes"][number][] = [];
  for (const id of input.episodeRecordIds) {
    const stored = await loadStoredRecord(context, "episode", id);
    const identity = await loadEpisodeIdentityState(context, id);
    if (stored === undefined || identity.status !== "resolved") return undefined;
    const episode = parseEpisodeRecord(stored.value);
    if (episode.id !== id || scopeDigest(episode.scope) !== exactScopeDigest) return undefined;
    const outcome = await loadLatestEpisodeOutcomeClaim(context, id);
    const base = {
      episodeRecordId: id,
      episodeRecordDigest: stored.digest,
      episodeIdentityDigest: recordDigest(toJsonValue(identity.identity)),
      outcomeClaimDigest: outcome.status === "resolved" ? outcome.latest.claimDigest : null,
      scopeDigest: exactScopeDigest,
    };
    resolvedEpisodes.push({ ...base, episodeViewDigest: sha256HexOfCanonicalJson(toJsonValue(base)) });
  }
  return { requestedEpisodeRecordIds: input.episodeRecordIds, resolvedEpisodes };
}

function assertChildPopulations(
  items: DetectorPackRunResult["items"],
  population: Omit<DetectorPackRunReceipt["population"], "populationDigest">,
): void {
  const expected = new Map(population.resolvedEpisodes.map((episode) => [episode.episodeRecordId, episode]));
  for (const item of items) {
    const episodes = item.result?.execution?.window.population.episodes;
    if (episodes === undefined) continue;
    if (episodes.length !== expected.size) {
      throw invalid("store.corrupt", "pack child execution population does not match the receipt population", []);
    }
    for (const episode of episodes) {
      const exact = expected.get(episode.episodeRecordId);
      const projected = {
        episodeRecordId: episode.episodeRecordId,
        episodeRecordDigest: episode.episodeRecordDigest,
        episodeIdentityDigest: episode.episodeIdentityDigest,
        outcomeClaimDigest: episode.outcomeClaimDigest,
        episodeViewDigest: episode.episodeViewDigest,
        scopeDigest: episode.scopeDigest,
      };
      if (exact === undefined || recordDigest(toJsonValue(exact)) !== recordDigest(toJsonValue(projected))) {
        throw invalid("store.corrupt", "pack child execution has foreign population lineage", []);
      }
    }
  }
}

async function buildReceiptOnce(
  context: EngineContext,
  input: DetectorPackRunInput,
  result: DetectorPackRunResult,
): Promise<DetectorPackRunReceipt | undefined> {
  const policy = context.detectorOrchestrationPolicy;
  const registry = context.semanticRegistry;
  if (policy === undefined || registry === undefined) return undefined;
  const populationBase = await resolveDetectorPackReceiptPopulation(context, input);
  if (populationBase === undefined) return undefined;
  assertChildPopulations(result.items, populationBase);
  const population = {
    ...populationBase,
    populationDigest: detectorPackRunPopulationDigest(populationBase),
  };
  const itemBases = await Promise.all(result.items.map((item) => buildReceiptItem(context, item)));
  const items = itemBases.map((item) => ({ ...item, itemDigest: detectorPackRunItemDigest(item) }));
  const governanceSnapshotDigest = detectorPackRunGovernanceSnapshotDigest(items);
  const base = {
    loopRegistryRevision: context.registryRevision,
    semanticRegistryDigest: registry.registryDigest,
    policy,
    pack: input.pack,
    scope: input.scope,
    scopeDigest: scopeDigest(input.scope),
    scopePolicyDigest: context.scopePolicy.digest,
    population,
    governanceSnapshotDigest,
    items,
    status: result.status,
  };
  const packRunKeyDigest = detectorPackRunKeyDigest(base);
  const receiptBase = { ...base, packRunKeyDigest };
  return parseDetectorPackRunReceipt({
    schemaVersion: 1,
    id: `detector-pack-run-${packRunKeyDigest}`,
    ...receiptBase,
    receiptDigest: detectorPackRunReceiptDigest(receiptBase),
  });
}

export async function buildStableDetectorPackRunReceipt(
  context: EngineContext,
  input: DetectorPackRunInput,
  result: DetectorPackRunResult,
): Promise<DetectorPackRunReceipt | undefined> {
  for (let attempt = 0; attempt < MAX_BUILD_ATTEMPTS; attempt += 1) {
    const first = await buildReceiptOnce(context, input, result);
    const second = await buildReceiptOnce(context, input, result);
    if (first === undefined || second === undefined) {
      if (first === undefined && second === undefined) return undefined;
      continue;
    }
    if (first.receiptDigest === second.receiptDigest) return second;
  }
  throw new LearningLoopError("detector.snapshot_changed", [
    { code: "detector.snapshot_changed", severity: "error", message: "pack receipt inputs changed repeatedly" },
  ]);
}

function buildIndex(receipt: DetectorPackRunReceipt): PackRunScopeIndexEntry {
  const base = { receiptId: receipt.id, receiptDigest: receipt.receiptDigest, scopeDigest: receipt.scopeDigest };
  return { schemaVersion: 1, ...base, indexDigest: indexDigest(base) };
}

export async function loadDetectorPackRunReceipt(
  context: EngineContext,
  receiptId: string,
): Promise<DetectorPackRunReceipt | undefined> {
  const stored = await loadStoredRecord(context, "detector-pack-run-receipt", receiptId);
  if (stored === undefined) return undefined;
  const receipt = parseDetectorPackRunReceipt(stored.value);
  if (receipt.id !== receiptId) throw invalid("store.corrupt", "pack receipt id does not match its record key", []);
  return receipt;
}

export async function loadDetectorPackRunScopeIndex(
  context: EngineContext,
  receiptId: string,
  exactScopeDigest: string,
): Promise<PackRunScopeIndexEntry | undefined> {
  const raw: unknown = await context.store.get({
    namespace: packRunScopeNamespace(exactScopeDigest),
    kind: PACK_RUN_INDEX_KIND,
    id: receiptId,
  });
  return raw === undefined ? undefined : parseStoredIndex(raw, exactScopeDigest, ["store", "get", PACK_RUN_INDEX_KIND]);
}

export async function persistDetectorPackRunReceipt(
  context: EngineContext,
  receipt: DetectorPackRunReceipt,
): Promise<DetectorPackRunReceipt> {
  const registrySnapshot = buildRegistrySnapshot(context);
  if (
    registrySnapshot.loopRegistryRevision !== receipt.loopRegistryRevision ||
    registrySnapshot.semanticRegistry.registryDigest !== receipt.semanticRegistryDigest
  ) {
    throw invalid("store.corrupt", "pack receipt registry projection changed before persistence", []);
  }
  await persistRegistrySnapshot(context, registrySnapshot);
  const index = buildIndex(receipt);
  const indexValue = toJsonValue(index);
  const rawIndexResult: unknown = await context.store.create(
    {
      namespace: packRunScopeNamespace(receipt.scopeDigest),
      kind: PACK_RUN_INDEX_KIND,
      id: receipt.id,
    },
    indexValue,
    recordDigest(indexValue),
    `detector-pack-run-index/${receipt.scopeDigest}/${receipt.id}/${receipt.receiptDigest}`,
  );
  const indexResult = parseWriteResult(rawIndexResult);
  if (indexResult.status === "updated") {
    throw invalid("store.corrupt", "store updated a create-only detector pack-run index", []);
  }
  if (indexResult.status === "conflict") {
    throw new LearningLoopError("semantic.pack_run_conflict", [
      { code: "semantic.pack_run_conflict", severity: "error", message: "pack-run key already binds another receipt" },
    ]);
  }
  const lockedIndex = await loadDetectorPackRunScopeIndex(context, receipt.id, receipt.scopeDigest);
  if (lockedIndex === undefined || lockedIndex.receiptDigest !== receipt.receiptDigest) {
    throw invalid("store.corrupt", "detector pack-run scope index was not preserved before receipt commit", []);
  }
  const status = await createOnly(
    context,
    "detector-pack-run-receipt",
    receipt.id,
    receipt,
    `detector-pack-run-receipt/${receipt.id}/${receipt.receiptDigest}`,
  );
  if (status === "conflict") {
    throw new LearningLoopError("semantic.pack_run_conflict", [
      { code: "semantic.pack_run_conflict", severity: "error", message: "pack-run key already binds another receipt" },
    ]);
  }
  const reloaded = await loadDetectorPackRunReceipt(context, receipt.id);
  if (reloaded === undefined || reloaded.receiptDigest !== receipt.receiptDigest) {
    throw invalid("store.corrupt", "detector pack-run receipt was not preserved", []);
  }
  const reloadedIndex = await loadDetectorPackRunScopeIndex(context, receipt.id, receipt.scopeDigest);
  if (reloadedIndex === undefined || reloadedIndex.receiptDigest !== receipt.receiptDigest) {
    throw invalid("store.corrupt", "detector pack-run scope index was not preserved", []);
  }
  return reloaded;
}

export async function loadDetectorPackRunScopeIndexPage(
  context: EngineContext,
  exactScopeDigest: string,
  options: { readonly cursor?: string; readonly limit: number },
): Promise<PackRunScopeIndexPage> {
  const rawPage: unknown = await context.store.list({
    namespace: packRunScopeNamespace(exactScopeDigest),
    kind: PACK_RUN_INDEX_KIND,
    ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
    limit: options.limit,
  });
  const fields = readFields(rawPage, ["store", "list", PACK_RUN_INDEX_KIND]);
  const rawRecords = fields.req("records", (value) => value);
  if (!Array.isArray(rawRecords) || rawRecords.length > options.limit) {
    throw invalid("store.corrupt", "detector pack-run index page is invalid", ["records"]);
  }
  const entries = rawRecords.map((record: unknown, index: number) =>
    parseStoredIndex(record, exactScopeDigest, ["records", index]),
  );
  const nextCursor = fields.opt("nextCursor", parseNonEmptyText);
  if (nextCursor !== undefined && nextCursor.length > 16_384) {
    throw invalid("store.corrupt", "detector pack-run index cursor exceeds its ceiling", ["nextCursor"]);
  }
  return {
    entries,
    ...(nextCursor === undefined ? {} : { nextCursor }),
    snapshotRevision: fields.req("snapshotRevision", parseNonEmptyText),
  };
}

export async function detectorPackRunScopeIndexRevision(
  store: LearningStore,
  exactScopeDigest: string,
): Promise<string> {
  const raw: unknown = await store.list({
    namespace: packRunScopeNamespace(exactScopeDigest),
    kind: PACK_RUN_INDEX_KIND,
    limit: 1,
  });
  const fields = readFields(raw, ["store", "list", PACK_RUN_INDEX_KIND]);
  return fields.req("snapshotRevision", parseNonEmptyText);
}
