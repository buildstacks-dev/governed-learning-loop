import { Buffer } from "node:buffer";
import { canonicalJsonText, sha256HexOfCanonicalJson } from "../canonical/canonical-json.js";
import { toJsonValue } from "../canonical/to-json-value.js";
import { invalid, parseNonEmptyText } from "../parse/toolkit.js";
import type { EngineContext } from "../engine/context.js";
import { parseDigestAt } from "../records/semantic-shared.js";
import type { SemanticTurnPersistenceGraph } from "./semantic-turn-persistence.js";
import {
  loadSemanticTurnByScope,
  parseStoredRecordAt,
  parseStoredScopedTurn,
  parseStoredScopeIndex,
  turnScopeDefinitionNamespace,
  turnScopeNamespace,
} from "./semantic-turn-persistence.js";
import { readSemanticWorkflowFields as readFields } from "./workflow-structure.js";

const TURN_KIND = "semantic-workflow-turn";
const TURN_SCOPE_INDEX_KIND = "semantic-workflow-turn-index";
const REVISION_DOMAIN = "semantic-workflow-revision:v1";
const parseUnknown = (input: unknown): unknown => input;

export async function* querySemanticTurnsByScope(
  context: EngineContext,
  input: {
    readonly scopeDigest: string;
    readonly limit: number;
    readonly cursor?: string;
  },
  loadGraph: (
    context: EngineContext,
    turnId: unknown,
    scopeDigest: unknown,
  ) => Promise<SemanticTurnPersistenceGraph | undefined> = loadSemanticTurnByScope,
): AsyncIterable<{
  readonly graphs: readonly SemanticTurnPersistenceGraph[];
  readonly nextCursor?: string;
  readonly snapshotRevision: string;
}> {
  let cursor = input.cursor;
  const maximumAggregateBytes = 64 * 1_048_576;
  const maximumChildReferences = 5_000;
  const seen = new Set<string>();
  if (cursor !== undefined) seen.add(cursor);
  for (;;) {
    const rawPage: unknown = await context.store.list({
      namespace: turnScopeNamespace(input.scopeDigest),
      kind: TURN_SCOPE_INDEX_KIND,
      ...(cursor === undefined ? {} : { cursor }),
      limit: input.limit,
    });
    const fields = readFields(rawPage, ["store", "list", TURN_SCOPE_INDEX_KIND]);
    const records = fields.req("records", (value, path) => {
      if (!Array.isArray(value) || value.length > input.limit) {
        throw invalid("store.corrupt", "semantic workflow query page is invalid", path);
      }
      return value;
    });
    const graphs: SemanticTurnPersistenceGraph[] = [];
    let aggregateBytes = 0;
    let childReferences = 0;
    for (const [index, record] of records.entries()) {
      const scopeIndex = parseStoredScopeIndex(record, input.scopeDigest, undefined, [
        "store",
        "list",
        TURN_SCOPE_INDEX_KIND,
        index,
      ]);
      const graph = await loadGraph(context, scopeIndex.turnId, input.scopeDigest);
      if (graph === undefined) throw invalid("store.corrupt", "listed semantic turn is not loadable", []);
      aggregateBytes += Buffer.byteLength(canonicalJsonText(toJsonValue(graph)), "utf8");
      childReferences += graph.turn.output.kind === "generation" ? graph.turn.output.derivationRefs.length + 1 : 0;
      if (aggregateBytes > maximumAggregateBytes || childReferences > maximumChildReferences) {
        throw invalid("query.incomplete", "semantic workflow query exceeds its aggregate work ceiling", []);
      }
      graphs.push(graph);
    }
    const nextCursor = fields.opt("nextCursor", parseNonEmptyText);
    yield {
      graphs,
      ...(nextCursor === undefined ? {} : { nextCursor }),
      snapshotRevision: await semanticWorkflowSnapshotRevision(context, input.scopeDigest),
    };
    if (nextCursor === undefined) return;
    if (seen.has(nextCursor)) throw invalid("store.corrupt", "semantic workflow query cursor cycled", []);
    seen.add(nextCursor);
    cursor = nextCursor;
  }
}

/**
 * Durable exact lineage guard for semantic_judgment child reads. Deterministic
 * executions have no plan/binding and return unchanged.
 */

async function turnScopeIndexRevision(context: EngineContext, exactScopeDigest: string): Promise<string> {
  const rawPage: unknown = await context.store.list({
    namespace: turnScopeNamespace(exactScopeDigest),
    kind: TURN_SCOPE_INDEX_KIND,
    limit: 1,
  });
  const fields = readFields(rawPage, ["store", "list", TURN_SCOPE_INDEX_KIND]);
  const rawRecords = fields.req("records", parseUnknown);
  if (!Array.isArray(rawRecords) || rawRecords.length > 1) {
    throw invalid("store.corrupt", "semantic turn scope-index revision page is invalid", ["records"]);
  }
  for (const [index, record] of rawRecords.entries()) {
    parseStoredScopeIndex(record, exactScopeDigest, undefined, ["store", "list", TURN_SCOPE_INDEX_KIND, index]);
  }
  return fields.req("snapshotRevision", parseNonEmptyText);
}

async function turnScopeTerminalRevision(context: EngineContext, exactScopeDigest: string): Promise<string> {
  const rawPage: unknown = await context.store.list({
    namespace: turnScopeNamespace(exactScopeDigest),
    kind: TURN_KIND,
    limit: 1,
  });
  const fields = readFields(rawPage, ["store", "list", TURN_KIND]);
  const rawRecords = fields.req("records", parseUnknown);
  if (!Array.isArray(rawRecords) || rawRecords.length > 1) {
    throw invalid("store.corrupt", "scoped semantic turn revision page is invalid", ["records"]);
  }
  for (const [index, record] of rawRecords.entries()) {
    const stored = parseStoredRecordAt(record, ["store", "list", TURN_KIND, index]);
    parseStoredScopedTurn(record, exactScopeDigest, stored.key.id, ["store", "list", TURN_KIND, index]);
  }
  return fields.req("snapshotRevision", parseNonEmptyText);
}

/** Composite revision for bounded workflow graph snapshot/retry checks. */
export async function semanticWorkflowSnapshotRevision(
  context: EngineContext,
  exactScopeDigestInput: unknown,
): Promise<string> {
  const exactScopeDigest = parseDigestAt(exactScopeDigestInput, ["scopeDigest"]);
  const scopeIndex = await turnScopeIndexRevision(context, exactScopeDigest);
  const scopedTurn = await turnScopeTerminalRevision(context, exactScopeDigest);
  return sha256HexOfCanonicalJson(
    toJsonValue({
      domain: REVISION_DOMAIN,
      scopeDigest: exactScopeDigest,
      scopeIndex,
      scopedTurn,
    }),
  );
}

export const SEMANTIC_TURN_SCOPE_INDEX_KIND = TURN_SCOPE_INDEX_KIND;

export async function* querySemanticTurnsByDefinition(
  context: EngineContext,
  input: {
    readonly scopeDigest: string;
    readonly definitionDigest: string;
    readonly limit: number;
    readonly cursor?: string;
  },
  loadGraph: (
    context: EngineContext,
    turnId: unknown,
    scopeDigest: unknown,
  ) => Promise<SemanticTurnPersistenceGraph | undefined>,
): AsyncIterable<{
  readonly graphs: readonly SemanticTurnPersistenceGraph[];
  readonly nextCursor?: string;
  readonly snapshotRevision: string;
}> {
  let cursor = input.cursor;
  const seen = new Set<string>();
  if (cursor !== undefined) seen.add(cursor);
  for (;;) {
    const storeLimit = Math.min(input.limit, 4);
    const rawPage: unknown = await context.store.list({
      namespace: turnScopeDefinitionNamespace(input.scopeDigest, input.definitionDigest),
      kind: TURN_KIND,
      ...(cursor === undefined ? {} : { cursor }),
      limit: storeLimit,
    });
    const fields = readFields(rawPage, ["store", "list", TURN_KIND]);
    const records = fields.req("records", (value, path) => {
      if (!Array.isArray(value) || value.length > storeLimit) {
        throw invalid("store.corrupt", "semantic workflow definition query page is invalid", path);
      }
      return value;
    });
    const graphs: SemanticTurnPersistenceGraph[] = [];
    let aggregateBytes = 0;
    let childReferences = 0;
    for (const [index, record] of records.entries()) {
      const stored = parseStoredRecordAt(record, ["store", "list", TURN_KIND, index]);
      const turn = parseStoredScopedTurn(
        record,
        input.scopeDigest,
        stored.key.id,
        ["store", "list", TURN_KIND, index],
        input.definitionDigest,
      );
      const graph = await loadGraph(context, turn.id, input.scopeDigest);
      if (graph === undefined || graph.reservation.definition.definitionDigest !== input.definitionDigest) {
        throw invalid("store.corrupt", "definition-local semantic turn is not loadable", []);
      }
      aggregateBytes += Buffer.byteLength(canonicalJsonText(toJsonValue(graph)), "utf8");
      childReferences += graph.turn.output.kind === "generation" ? graph.turn.output.derivationRefs.length + 1 : 0;
      if (aggregateBytes > 64 * 1_048_576 || childReferences > 5_000) {
        throw invalid("query.incomplete", "semantic workflow query exceeds its aggregate work ceiling", []);
      }
      graphs.push(graph);
    }
    const nextCursor = fields.opt("nextCursor", parseNonEmptyText);
    const definitionTurnRevision = fields.req("snapshotRevision", parseNonEmptyText);
    yield {
      graphs,
      ...(nextCursor === undefined ? {} : { nextCursor }),
      snapshotRevision: sha256HexOfCanonicalJson(
        toJsonValue({
          domain: "semantic-workflow-definition-revision:v1",
          scopeDigest: input.scopeDigest,
          definitionDigest: input.definitionDigest,
          definitionTurnRevision,
        }),
      ),
    };
    if (nextCursor === undefined) return;
    if (seen.has(nextCursor)) throw invalid("store.corrupt", "semantic workflow query cursor cycled", []);
    seen.add(nextCursor);
    cursor = nextCursor;
  }
}
