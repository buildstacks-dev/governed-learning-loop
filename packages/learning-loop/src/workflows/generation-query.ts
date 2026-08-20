import { Buffer } from "node:buffer";
import { canonicalJsonText, sha256HexOfCanonicalJson } from "../canonical/canonical-json.js";
import { toJsonValue } from "../canonical/to-json-value.js";
import { invalid, parseNonEmptyText } from "../parse/toolkit.js";
import type { EngineContext } from "../engine/context.js";
import type { DetectorWindow } from "../engine/detector-window.js";
import { loadSemanticWorkflowChildViews } from "../engine/semantic-views.js";
import { parseDigestAt, parseDurableId, scopeDigest } from "../records/semantic-shared.js";
import type { SemanticWorkflowBundle } from "./types.js";
import {
  loadSemanticWorkflowExecutionBinding,
  loadSemanticGenerationTurnByScope,
  querySemanticGenerationTurnsByScope,
} from "./semantic-generation-persistence.js";
import type { SemanticTurnPersistenceGraph } from "./semantic-turn-persistence.js";
import { readSemanticWorkflowFields as readFields } from "./workflow-structure.js";

function parseNonnegativeInteger(input: unknown, path: readonly (string | number)[]): number {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input < 0) {
    throw invalid("schema.invalid", "value must be a nonnegative safe integer", path);
  }
  return input;
}

type PublicTurnView = Exclude<Awaited<ReturnType<SemanticWorkflowBundle["getTurn"]>>, undefined>;
const TURN_CURSOR_DOMAIN = "semantic-workflow-public-turn-cursor:v1";

function publicNoOutputReason(
  reasonCode: string,
): Extract<PublicTurnView["output"], { readonly kind: "none" }>["reasonCode"] {
  if (
    reasonCode === "workflow.condition_not_detected" ||
    reasonCode === "workflow.provider_refused" ||
    reasonCode === "workflow.provider_failed" ||
    reasonCode === "workflow.result_invalid" ||
    reasonCode === "workflow.result_limit" ||
    reasonCode === "workflow.outcome_unknown"
  ) {
    return reasonCode;
  }
  throw invalid("store.corrupt", "semantic workflow no-output reason is invalid", []);
}

function encodeTurnCursor(input: {
  readonly scopeDigest: string;
  readonly definitionDigest: string;
  readonly queryCursorScopeDigest: string;
  readonly registryRevision: string;
  readonly storeCursor: string;
}): string {
  const base = { schemaVersion: 1, kind: "semantic-workflow-turn", ...input };
  const cursorDigest = sha256HexOfCanonicalJson(toJsonValue({ domain: TURN_CURSOR_DOMAIN, ...base }));
  return Buffer.from(canonicalJsonText(toJsonValue({ ...base, cursorDigest })), "utf8").toString("base64url");
}

function decodeTurnCursor(
  input: string,
  expected: {
    readonly scopeDigest: string;
    readonly definitionDigest: string;
    readonly queryCursorScopeDigest: string;
    readonly registryRevision: string;
  },
): string {
  if (input.length > 16_384) throw invalid("query.cursor_invalid", "workflow cursor is invalid", []);
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(input, "base64url").toString("utf8"));
  } catch {
    throw invalid("query.cursor_invalid", "workflow cursor is invalid", []);
  }
  const fields = readFields(decoded, ["cursor"]);
  fields.schemaVersion1();
  const kind = fields.req("kind", parseNonEmptyText);
  const scopeDigestValue = fields.req("scopeDigest", parseDigestAt);
  const definitionDigest = fields.req("definitionDigest", parseDigestAt);
  const queryCursorScopeDigest = fields.req("queryCursorScopeDigest", parseDigestAt);
  const registryRevision = fields.req("registryRevision", parseDigestAt);
  const storeCursor = fields.req("storeCursor", parseNonEmptyText);
  const cursorDigest = fields.req("cursorDigest", parseDigestAt);
  const base = {
    schemaVersion: 1,
    kind,
    scopeDigest: scopeDigestValue,
    definitionDigest,
    queryCursorScopeDigest,
    registryRevision,
    storeCursor,
  };
  if (
    kind !== "semantic-workflow-turn" ||
    scopeDigestValue !== expected.scopeDigest ||
    definitionDigest !== expected.definitionDigest ||
    queryCursorScopeDigest !== expected.queryCursorScopeDigest ||
    registryRevision !== expected.registryRevision ||
    cursorDigest !== sha256HexOfCanonicalJson(toJsonValue({ domain: TURN_CURSOR_DOMAIN, ...base })) ||
    input !==
      encodeTurnCursor({
        scopeDigest: scopeDigestValue,
        definitionDigest,
        queryCursorScopeDigest,
        registryRevision,
        storeCursor,
      })
  ) {
    throw invalid("query.cursor_invalid", "workflow cursor is invalid", []);
  }
  return storeCursor;
}

async function publicTurnView(
  context: EngineContext,
  graph: SemanticTurnPersistenceGraph,
  scope: DetectorWindow["scope"],
): Promise<PublicTurnView> {
  let output: PublicTurnView["output"];
  if (graph.turn.output.kind === "none") {
    output = { kind: "none", reasonCode: publicNoOutputReason(graph.turn.output.reasonCode) };
  } else if (graph.turn.output.kind === "generation") {
    const target = graph.reservation.target;
    if (target.kind !== "generation") throw invalid("store.corrupt", "generation turn has another target", []);
    const workflowExecution = await loadSemanticWorkflowExecutionBinding(context, target.executionKeyDigest);
    if (
      workflowExecution === undefined ||
      workflowExecution.id !== graph.turn.output.workflowExecutionId ||
      workflowExecution.workflowExecutionDigest !== graph.turn.output.workflowExecutionDigest
    ) {
      throw invalid("store.corrupt", "generation turn workflow execution is unavailable", []);
    }
    const childViews = await loadSemanticWorkflowChildViews(context, workflowExecution.detectorExecution.id, scope);
    if (childViews === undefined) throw invalid("store.corrupt", "generation execution view is unavailable", []);
    output = {
      kind: "generation",
      workflowExecutionId: workflowExecution.id,
      workflowExecutionKeyDigest: workflowExecution.workflowExecutionKeyDigest,
      workflowExecutionDigest: workflowExecution.workflowExecutionDigest,
      execution: childViews.execution,
      derivations: childViews.derivations,
    };
  } else {
    throw invalid("store.corrupt", "generation bundle encountered an advisory-review turn", []);
  }
  return {
    schemaVersion: 1,
    id: graph.turn.id,
    turnKeyDigest: graph.turn.turnKeyDigest,
    definition: {
      id: graph.reservation.definition.id,
      version: graph.reservation.definition.version,
      definitionDigest: graph.reservation.definition.definitionDigest,
    },
    transport: graph.reservation.definition.transport,
    scopeDigest: graph.reservation.scopeDigest,
    status: graph.result.status,
    request: {
      byteLength: graph.reservation.request.byteLength,
      estimatedInputTokens: graph.reservation.request.estimatedInputTokens ?? null,
      minimizedBytesDigest: graph.reservation.request.minimizedBytesDigest,
      keyPolicyDigest: graph.reservation.request.keyPolicyDigest,
    },
    dispatchClaimedAt: graph.dispatch.startedAt,
    authorization:
      graph.authorization === null
        ? { status: "not_required" }
        : {
            status: "authorized",
            authorizationDigest: graph.authorization.authorizationDigest,
            authorizedAt: graph.authorization.authorizedAt,
            expiresAt: graph.authorization.expiresAt,
          },
    disclosure:
      graph.result.response === null
        ? { status: "not_observed" }
        : {
            status: "result_attested",
            responseReceiptId: graph.result.response.providerReceiptId,
            responseReceiptDigest: graph.result.response.providerReceiptDigest,
          },
    usage:
      graph.result.usage.status === "reported"
        ? graph.result.usage
        : {
            status: "unreported",
            reasonCode:
              graph.result.usage.reasonCode === "usage.outcome_unknown"
                ? "usage.outcome_unknown"
                : "usage.not_reported",
          },
    output,
    turnDigest: graph.turn.turnDigest,
  };
}

export async function getTurn(
  context: EngineContext,
  definitionDigest: string,
  input: unknown,
): ReturnType<SemanticWorkflowBundle["getTurn"]> {
  const fields = readFields(input, ["getTurn"]);
  const turnId = fields.req("turnId", parseDurableId);
  const scope = Object.freeze(
    context.scopePolicy
      .validate(fields.req("scope", (value) => value))
      .map((segment) => Object.freeze({ type: segment.type, id: segment.id })),
  );
  const graph = await loadSemanticGenerationTurnByScope(context, turnId, scopeDigest(scope), definitionDigest);
  return graph === undefined || graph.reservation.definition.definitionDigest !== definitionDigest
    ? undefined
    : await publicTurnView(context, graph, scope);
}

export function queryTurns(
  context: EngineContext,
  definitionDigest: string,
  input: unknown,
): ReturnType<SemanticWorkflowBundle["queryTurns"]> {
  const fields = readFields(input, ["queryTurns"]);
  const scope = Object.freeze(
    context.scopePolicy
      .validate(fields.req("scope", (value) => value))
      .map((segment) => Object.freeze({ type: segment.type, id: segment.id })),
  );
  const limit = fields.req("limit", (value, path) => {
    const parsed = parseNonnegativeInteger(value, path);
    if (parsed < 1 || parsed > 100) throw invalid("schema.invalid", "workflow query limit must be 1 through 100", path);
    return parsed;
  });
  const publicCursor = fields.opt("cursor", parseNonEmptyText);
  const exactScopeDigest = scopeDigest(scope);
  const cursor =
    publicCursor === undefined
      ? undefined
      : decodeTurnCursor(publicCursor, {
          scopeDigest: exactScopeDigest,
          definitionDigest,
          queryCursorScopeDigest: context.queryCursorScopeDigest,
          registryRevision: context.registryRevision,
        });
  return {
    async *[Symbol.asyncIterator]() {
      for await (const page of querySemanticGenerationTurnsByScope(context, {
        scopeDigest: exactScopeDigest,
        definitionDigest,
        limit,
        ...(cursor === undefined ? {} : { cursor }),
      })) {
        const items = [];
        for (const graph of page.graphs) {
          if (graph.reservation.definition.definitionDigest === definitionDigest) {
            items.push(await publicTurnView(context, graph, scope));
          }
        }
        yield {
          items,
          ...(page.nextCursor === undefined
            ? {}
            : {
                nextCursor: encodeTurnCursor({
                  scopeDigest: exactScopeDigest,
                  definitionDigest,
                  queryCursorScopeDigest: context.queryCursorScopeDigest,
                  registryRevision: context.registryRevision,
                  storeCursor: page.nextCursor,
                }),
              }),
          snapshotRevision: page.snapshotRevision,
        };
      }
    },
  };
}
