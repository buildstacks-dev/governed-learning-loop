// Lane-neutral run helpers shared by the generation (#13b) and advisory
// review (#13c) lanes: exact provider-envelope parsing, closed result/usage
// pairing, the single-attempt provider timeout boundary, and the shared
// noncompleted terminal commit. No helper here invokes a provider on its own,
// redispatches, or grants Candidate/Review/effect authority.
import { invalid } from "../parse/toolkit.js";
import { parseDigestAt, parseDurableId } from "../records/semantic-shared.js";
import type { EngineContext } from "../engine/context.js";
import type { SemanticDisclosureAuthorization, SemanticTurnReservation } from "./semantic-turn-intent.js";
import type { SemanticDispatchMarker, SemanticResultBinding, SemanticUsage } from "./semantic-turn-outcome.js";
import {
  buildSemanticResultBinding,
  buildSemanticTurnReceipt,
  buildSemanticTurnScopeIndex,
} from "./semantic-turn-outcome.js";
import { persistSemanticResultBinding, persistSemanticTurnTerminal } from "./semantic-turn-persistence.js";
import type { SemanticWorkflowDefinition } from "./workflow-definition.js";
import type { CapabilityCallbacks } from "./generation-internal.js";
import { authorizationCapabilities } from "./generation-internal.js";
import { readSemanticWorkflowFields as readFields } from "./workflow-structure.js";

export function parseCanonicalTimestamp(input: unknown, path: readonly (string | number)[]): string {
  if (typeof input !== "string") throw invalid("schema.invalid", "timestamp must be a string", path);
  const milliseconds = Date.parse(input);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== input) {
    throw invalid("schema.invalid", "timestamp must be canonical RFC 3339 UTC with milliseconds", path);
  }
  return input;
}

export function parseNonnegativeInteger(input: unknown, path: readonly (string | number)[]): number {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input < 0) {
    throw invalid("schema.invalid", "value must be a nonnegative safe integer", path);
  }
  return input;
}

export function parseKeyedDigest(callback: CapabilityCallbacks["digest"], bytes: Uint8Array): string {
  return parseDigestAt(callback(new Uint8Array(bytes)), ["keyedDigester", "result"]);
}

export interface ParsedProviderEnvelope {
  readonly status: "completed" | "provider_refused" | "provider_failed";
  readonly providerReceiptId: string;
  readonly providerReceiptDigest: string;
  readonly usage: Extract<SemanticUsage, { readonly status: "reported" }> | null;
  readonly result: unknown;
}

function parseReportedUsage(input: unknown): Extract<SemanticUsage, { readonly status: "reported" }> {
  const fields = readFields(input, ["providerResponse", "usage"]);
  const status = fields.req("status", (value, path): "reported" => {
    if (value !== "reported") throw invalid("schema.invalid", "provider usage status must be reported", path);
    return value;
  });
  const costMinorUnits = fields.req("costMinorUnits", (value, path) =>
    value === null ? null : parseNonnegativeInteger(value, path),
  );
  const currency = fields.req("currency", (value, path) => {
    if (value === null) return null;
    if (typeof value !== "string" || !/^[A-Z]{3}$/.test(value)) {
      throw invalid("schema.invalid", "provider usage currency must be null or an upper-case code", path);
    }
    return value;
  });
  if ((costMinorUnits === null) !== (currency === null)) {
    throw invalid("schema.invalid", "provider usage cost and currency must be present together", []);
  }
  return {
    status,
    inputTokens: fields.req("inputTokens", parseNonnegativeInteger),
    outputTokens: fields.req("outputTokens", parseNonnegativeInteger),
    durationMs: fields.req("durationMs", parseNonnegativeInteger),
    costMinorUnits,
    currency,
  };
}

export function parseProviderEnvelope(
  input: unknown,
  expectedSchema: { readonly id: string; readonly version: string },
): ParsedProviderEnvelope {
  const fields = readFields(input, ["providerResponse"]);
  fields.schemaVersion1();
  const id = fields.req("id", (value, path) => {
    if (value !== expectedSchema.id) throw invalid("schema.invalid", "provider result id is invalid", path);
    return value;
  });
  const version = fields.req("version", (value, path) => {
    if (value !== expectedSchema.version) {
      throw invalid("schema.invalid", "provider result version is invalid", path);
    }
    return value;
  });
  void id;
  void version;
  const status = fields.req("status", (value, path) => {
    if (value !== "completed" && value !== "provider_refused" && value !== "provider_failed") {
      throw invalid("schema.invalid", "provider response status is invalid", path);
    }
    return value;
  });
  const receiptFields = readFields(
    fields.req("providerReceipt", (value) => value),
    ["providerResponse", "providerReceipt"],
  );
  const usage = fields.req("usage", (value) => (value === null ? null : parseReportedUsage(value)));
  const result = fields.req("result", (value) => value);
  if ((status === "completed" && (usage === null || result === null)) || (status !== "completed" && result !== null)) {
    throw invalid("schema.invalid", "provider response result does not match its status", []);
  }
  return {
    status,
    providerReceiptId: receiptFields.req("id", parseDurableId),
    providerReceiptDigest: receiptFields.req("digest", parseDigestAt),
    usage,
    result,
  };
}

export function unreportedUsage(): SemanticUsage {
  return { status: "unreported", reasonCode: "usage.not_reported" };
}

export function buildKnownFailureResult(input: {
  readonly reservation: SemanticTurnReservation;
  readonly dispatch: SemanticDispatchMarker;
  readonly status: "provider_refused" | "provider_failed" | "result_invalid" | "result_limit";
  readonly response: SemanticResultBinding["response"];
  readonly usage?: Extract<SemanticUsage, { readonly status: "reported" }> | null;
}): SemanticResultBinding {
  return buildSemanticResultBinding({
    turnKeyDigest: input.reservation.turnKeyDigest,
    reservationDigest: input.reservation.reservationDigest,
    dispatchDigest: input.dispatch.dispatchDigest,
    status: input.status,
    response: input.response,
    usage: input.usage ?? unreportedUsage(),
    normalizedResult: null,
    normalizedResultDigest: null,
    reasonCodes: [`workflow.${input.status}`],
  });
}

export function usageExceedsBudget(
  definition: SemanticWorkflowDefinition,
  usage: Extract<SemanticUsage, { readonly status: "reported" }>,
): boolean {
  const maximumCost = definition.budgetPolicy.maximumCost;
  return (
    usage.inputTokens > definition.budgetPolicy.maximumInputTokens ||
    usage.outputTokens > definition.budgetPolicy.maximumOutputTokens ||
    usage.durationMs > definition.budgetPolicy.maximumDurationMs ||
    (maximumCost !== null &&
      usage.costMinorUnits !== null &&
      usage.currency === maximumCost.currency &&
      usage.costMinorUnits > maximumCost.minorUnits)
  );
}

export function usageMeasurementInvalid(
  definition: SemanticWorkflowDefinition,
  usage: Extract<SemanticUsage, { readonly status: "reported" }> | null,
  completed: boolean,
): boolean {
  if (completed && usage === null) return true;
  const maximumCost = definition.budgetPolicy.maximumCost;
  return (
    maximumCost !== null && usage !== null && (usage.costMinorUnits === null || usage.currency !== maximumCost.currency)
  );
}

export function authorizationFor(
  token: object,
  planHandle: object,
  transport: SemanticWorkflowDefinition["transport"],
  input: unknown,
): { readonly handle: object | null; readonly record: SemanticDisclosureAuthorization | null } {
  if (transport === "local") {
    if (input !== null) throw invalid("schema.invalid", "local semantic turns cannot carry authorization", []);
    return { handle: null, record: null };
  }
  if (typeof input !== "object" || input === null) {
    throw invalid("semantic.workflow_authorization_invalid", "outbound semantic turns require authorization", []);
  }
  const binding = authorizationCapabilities.get(input);
  if (binding === undefined || binding.token !== token || binding.plan !== planHandle) {
    throw invalid("semantic.workflow_authorization_invalid", "authorization belongs to another prepared plan", []);
  }
  return { handle: input, record: binding.record };
}

export async function commitNoncompletedTurn(input: {
  readonly context: EngineContext;
  readonly reservation: SemanticTurnReservation;
  readonly definitionDigest: string;
  readonly lane: SemanticWorkflowDefinition["lane"];
  readonly authorization: SemanticDisclosureAuthorization | null;
  readonly dispatch: SemanticDispatchMarker;
  readonly result: SemanticResultBinding;
}): Promise<string> {
  const { context, reservation, authorization, dispatch, result } = input;
  await persistSemanticResultBinding(context, {
    reservation,
    authorization,
    dispatch,
    result,
  });
  const turn = buildSemanticTurnReceipt({
    turnKeyDigest: reservation.turnKeyDigest,
    reservation: { id: reservation.id, reservationDigest: reservation.reservationDigest },
    authorization:
      authorization === null ? null : { id: authorization.id, authorizationDigest: authorization.authorizationDigest },
    dispatch: { id: dispatch.id, dispatchDigest: dispatch.dispatchDigest },
    result: { id: result.id, bindingDigest: result.bindingDigest },
    lane: input.lane,
    scopeDigest: reservation.scopeDigest,
    status: result.status,
    output: { kind: "none", reasonCode: `workflow.${result.status}` },
  });
  const scopeIndex = buildSemanticTurnScopeIndex({
    scopeDigest: reservation.scopeDigest,
    definitionDigest: input.definitionDigest,
    turnId: turn.id,
    turnKeyDigest: turn.turnKeyDigest,
    turnDigest: turn.turnDigest,
  });
  await persistSemanticTurnTerminal(context, {
    reservation,
    authorization,
    dispatch,
    result,
    scopeIndex,
    turn,
  });
  return turn.id;
}

export async function invokeProviderWithTimeout(
  callback: CapabilityCallbacks["invokeProvider"],
  providerInput: Omit<Parameters<CapabilityCallbacks["invokeProvider"]>[0], "signal">,
  maximumDurationMs: number,
): Promise<{ readonly status: "resolved"; readonly value: unknown } | { readonly status: "unknown" }> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let returned: Promise<unknown>;
  try {
    returned = callback({ ...providerInput, signal: controller.signal });
  } catch {
    return { status: "unknown" };
  }
  const provider = Promise.resolve(returned).then(
    (value) => {
      const status: "resolved" = "resolved";
      return { status, value };
    },
    () => {
      const status: "unknown" = "unknown";
      return { status };
    },
  );
  const expired = new Promise<{ readonly status: "unknown" }>((resolve) => {
    timeout = setTimeout(() => {
      controller.abort();
      resolve({ status: "unknown" });
    }, maximumDurationMs);
  });
  const settled = await Promise.race([provider, expired]);
  if (timeout !== undefined) clearTimeout(timeout);
  return settled;
}
