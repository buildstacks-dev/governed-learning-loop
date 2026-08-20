// Private, inert outcome records for one provider-neutral semantic turn. These
// records carry no provider callback, persistence path, Candidate/Review
// writer, publication capability, or effect authority.
import { Buffer } from "node:buffer";
import { canonicalJsonText, sha256HexOfCanonicalJson } from "../canonical/canonical-json.js";
import type { JsonValue } from "../canonical/json.js";
import { toJsonValue } from "../canonical/to-json-value.js";
import { invalid, parseJson, parseNonEmptyText, parseOneOf } from "../parse/toolkit.js";
import type { Parse } from "../parse/toolkit.js";
import {
  assertSortedUnique,
  canonicalKey,
  parseDigestAt,
  parseDurableId,
  parseId,
  parseNullable,
} from "../records/semantic-shared.js";
import type { SemanticWorkflowDefinition } from "./workflow-definition.js";
import { SEMANTIC_WORKFLOW_MAX_CANONICAL_BYTES } from "./workflow-definition.js";
import {
  assertSemanticWorkflowStructureBound,
  parseSemanticWorkflowArray as parseBoundedArray,
  readSemanticWorkflowFields as readFields,
} from "./workflow-structure.js";

const RESULT_STATUSES = [
  "completed",
  "provider_refused",
  "provider_failed",
  "result_invalid",
  "result_limit",
  "outcome_unknown",
] as const;
const WORKFLOW_LANES = ["generation", "advisory_review"] as const;
const OUTPUT_KINDS = ["none", "generation", "advisory_review"] as const;
const UNREPORTED_USAGE_REASONS = ["usage.not_reported", "usage.outcome_unknown"] as const;
const MAX_REASON_CODES = 1;
const MAX_DERIVATION_REFS = 100;
const MAX_TIMESTAMP_LENGTH = 24;
const DISPATCH_DOMAIN = "semantic-workflow-dispatch:v1";
const NORMALIZED_RESULT_DOMAIN = "semantic-workflow-normalized-result:v1";
const RESULT_BINDING_DOMAIN = "semantic-workflow-result-binding:v1";
const TURN_RECEIPT_DOMAIN = "semantic-workflow-turn-receipt:v1";
const TURN_SCOPE_INDEX_DOMAIN = "semantic-workflow-turn-scope-index:v1";
const CANONICAL_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export type SemanticResultStatus = (typeof RESULT_STATUSES)[number];

export interface SemanticDispatchMarker {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly turnKeyDigest: string;
  readonly reservationDigest: string;
  readonly authorizationDigest: string | null;
  readonly providerOperationId: string;
  readonly idempotencyKey: string | null;
  readonly startedAt: string;
  readonly dispatchDigest: string;
}

export type SemanticUsage =
  | {
      readonly status: "reported";
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly durationMs: number;
      readonly costMinorUnits: number | null;
      readonly currency: string | null;
    }
  | {
      readonly status: "unreported";
      readonly reasonCode: string;
    };

export interface SemanticResponseMetadata {
  readonly providerReceiptId: string;
  readonly providerReceiptDigest: string;
  readonly requestAttestationDigest: string;
  readonly responseByteLength: number;
  readonly responseKeyedDigest: string;
  readonly keyPolicyDigest: string;
}

export interface SemanticResultBinding {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly turnKeyDigest: string;
  readonly reservationDigest: string;
  readonly dispatchDigest: string;
  readonly status: SemanticResultStatus;
  readonly response: SemanticResponseMetadata | null;
  readonly usage: SemanticUsage;
  readonly normalizedResult: JsonValue | null;
  readonly normalizedResultDigest: string | null;
  readonly reasonCodes: readonly string[];
  readonly bindingDigest: string;
}

export interface SemanticTurnReceipt {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly turnKeyDigest: string;
  readonly reservation: {
    readonly id: string;
    readonly reservationDigest: string;
  };
  readonly authorization: {
    readonly id: string;
    readonly authorizationDigest: string;
  } | null;
  readonly dispatch: {
    readonly id: string;
    readonly dispatchDigest: string;
  };
  readonly result: {
    readonly id: string;
    readonly bindingDigest: string;
  };
  readonly lane: SemanticWorkflowDefinition["lane"];
  readonly scopeDigest: string;
  readonly status: SemanticResultStatus;
  readonly output:
    | {
        readonly kind: "none";
        readonly reasonCode: string;
      }
    | {
        readonly kind: "generation";
        readonly workflowExecutionId: string;
        readonly workflowExecutionKeyDigest: string;
        readonly workflowExecutionDigest: string;
        readonly derivationRefs: readonly {
          readonly id: string;
          readonly derivationDigest: string;
          readonly scopeDigest: string;
        }[];
      }
    | {
        readonly kind: "advisory_review";
        readonly assessmentId: string;
        readonly assessmentDigest: string;
      };
  readonly turnDigest: string;
}

export interface SemanticTurnScopeIndex {
  readonly schemaVersion: 1;
  readonly scopeDigest: string;
  readonly turnId: string;
  readonly turnKeyDigest: string;
  readonly turnDigest: string;
  readonly indexDigest: string;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

function structuralDigest(domain: string, content: unknown): string {
  assertSemanticWorkflowStructureBound(content);
  return sha256HexOfCanonicalJson(toJsonValue({ domain, content }));
}

function parseSafeInteger(minimum: number, maximum: number, label: string): Parse<number> {
  return (input, path) => {
    if (typeof input !== "number" || !Number.isSafeInteger(input) || input < minimum || input > maximum) {
      throw invalid("schema.invalid", `${label} must be an integer from ${minimum} through ${maximum}`, path);
    }
    return input;
  };
}

const parseCanonicalTimestamp: Parse<string> = (input, path) => {
  const value = parseNonEmptyText(input, path);
  const parsed = Date.parse(value);
  if (
    value.length !== MAX_TIMESTAMP_LENGTH ||
    !CANONICAL_TIMESTAMP.test(value) ||
    !Number.isFinite(parsed) ||
    new Date(parsed).toISOString() !== value
  ) {
    throw invalid("schema.invalid", "timestamp must be canonical RFC 3339 UTC with milliseconds", path);
  }
  return value;
};

const parseCurrency: Parse<string> = (input, path) => {
  const value = parseNonEmptyText(input, path);
  if (!/^[A-Z]{3}$/.test(value)) {
    throw invalid("schema.invalid", "currency must be a three-letter upper-case code", path);
  }
  return value;
};

function dispatchId(turnKeyDigest: string): string {
  return `semantic-workflow-dispatch-${turnKeyDigest}`;
}

function resultId(turnKeyDigest: string): string {
  return `semantic-workflow-result-${turnKeyDigest}`;
}

function turnId(turnKeyDigest: string): string {
  return `semantic-workflow-turn-${turnKeyDigest}`;
}

function dispatchContent(input: Omit<SemanticDispatchMarker, "schemaVersion" | "id" | "dispatchDigest">): unknown {
  return input;
}

export function semanticDispatchDigest(
  input: Omit<SemanticDispatchMarker, "schemaVersion" | "id" | "dispatchDigest">,
): string {
  return structuralDigest(DISPATCH_DOMAIN, dispatchContent(input));
}

export function parseSemanticDispatchMarker(input: unknown): SemanticDispatchMarker {
  const fields = readFields(input, []);
  const schemaVersion = fields.schemaVersion1();
  const base = {
    turnKeyDigest: fields.req("turnKeyDigest", parseDigestAt),
    reservationDigest: fields.req("reservationDigest", parseDigestAt),
    authorizationDigest: fields.req("authorizationDigest", parseNullable(parseDigestAt)),
    providerOperationId: fields.req("providerOperationId", parseDurableId),
    idempotencyKey: fields.req("idempotencyKey", parseNullable(parseDurableId)),
    startedAt: fields.req("startedAt", parseCanonicalTimestamp),
  };
  const id = fields.req("id", parseDurableId);
  if (id !== dispatchId(base.turnKeyDigest)) {
    throw invalid("schema.corrupt", "semantic dispatch id does not match its turn key", ["id"]);
  }
  const dispatchDigest = fields.req("dispatchDigest", parseDigestAt);
  if (dispatchDigest !== semanticDispatchDigest(base)) {
    throw invalid("schema.corrupt", "semantic dispatch digest does not match its content", ["dispatchDigest"]);
  }
  return deepFreeze({ schemaVersion, id, ...base, dispatchDigest });
}

export function buildSemanticDispatchMarker(
  input: Omit<SemanticDispatchMarker, "schemaVersion" | "id" | "dispatchDigest">,
): SemanticDispatchMarker {
  return parseSemanticDispatchMarker({
    schemaVersion: 1,
    id: dispatchId(input.turnKeyDigest),
    ...input,
    dispatchDigest: semanticDispatchDigest(input),
  });
}

const parseResponseAt: Parse<SemanticResponseMetadata> = (input, path) => {
  const fields = readFields(input, path);
  return {
    providerReceiptId: fields.req("providerReceiptId", parseDurableId),
    providerReceiptDigest: fields.req("providerReceiptDigest", parseDigestAt),
    requestAttestationDigest: fields.req("requestAttestationDigest", parseDigestAt),
    responseByteLength: fields.req(
      "responseByteLength",
      parseSafeInteger(0, Number.MAX_SAFE_INTEGER, "response byte length"),
    ),
    responseKeyedDigest: fields.req("responseKeyedDigest", parseDigestAt),
    keyPolicyDigest: fields.req("keyPolicyDigest", parseDigestAt),
  };
};

const parseReportedUsageAt: Parse<Extract<SemanticUsage, { readonly status: "reported" }>> = (input, path) => {
  const fields = readFields(input, path);
  const costMinorUnits = fields.req(
    "costMinorUnits",
    parseNullable(parseSafeInteger(0, Number.MAX_SAFE_INTEGER, "cost minor units")),
  );
  const currency = fields.req("currency", parseNullable(parseCurrency));
  if ((costMinorUnits === null) !== (currency === null)) {
    throw invalid("schema.invalid", "reported cost minor units and currency must be present or null together", path);
  }
  return {
    status: fields.req("status", parseOneOf(["reported"])),
    inputTokens: fields.req("inputTokens", parseSafeInteger(0, Number.MAX_SAFE_INTEGER, "input tokens")),
    outputTokens: fields.req("outputTokens", parseSafeInteger(0, Number.MAX_SAFE_INTEGER, "output tokens")),
    durationMs: fields.req("durationMs", parseSafeInteger(0, Number.MAX_SAFE_INTEGER, "duration milliseconds")),
    costMinorUnits,
    currency,
  };
};

const parseUnreportedUsageAt: Parse<Extract<SemanticUsage, { readonly status: "unreported" }>> = (input, path) => {
  const fields = readFields(input, path);
  return {
    status: fields.req("status", parseOneOf(["unreported"])),
    reasonCode: fields.req("reasonCode", parseOneOf(UNREPORTED_USAGE_REASONS)),
  };
};

const parseUsageAt: Parse<SemanticUsage> = (input, path) => {
  const fields = readFields(input, path);
  const status = fields.req("status", parseOneOf(["reported", "unreported"]));
  return status === "reported" ? parseReportedUsageAt(input, path) : parseUnreportedUsageAt(input, path);
};

export function semanticNormalizedResultDigest(input: JsonValue): string {
  return structuralDigest(NORMALIZED_RESULT_DOMAIN, input);
}

function resultBindingContent(input: Omit<SemanticResultBinding, "schemaVersion" | "id" | "bindingDigest">): unknown {
  return input;
}

export function semanticResultBindingDigest(
  input: Omit<SemanticResultBinding, "schemaVersion" | "id" | "bindingDigest">,
): string {
  return structuralDigest(RESULT_BINDING_DOMAIN, resultBindingContent(input));
}

function assertResultPairing(
  status: SemanticResultStatus,
  response: SemanticResponseMetadata | null,
  usage: SemanticUsage,
  normalizedResult: JsonValue | null,
  normalizedResultDigest: string | null,
  reasonCodes: readonly string[],
): void {
  if (
    usage.status === "unreported" &&
    usage.reasonCode !== (status === "outcome_unknown" ? "usage.outcome_unknown" : "usage.not_reported")
  ) {
    throw invalid("schema.corrupt", "unreported semantic usage reason does not match its result status", []);
  }
  if (status === "completed") {
    if (
      response === null ||
      usage.status !== "reported" ||
      normalizedResult === null ||
      normalizedResultDigest === null ||
      reasonCodes.length !== 0 ||
      normalizedResultDigest !== semanticNormalizedResultDigest(normalizedResult)
    ) {
      throw invalid("schema.corrupt", "completed semantic results require exact response and normalized result", []);
    }
    return;
  }
  if (
    normalizedResult !== null ||
    normalizedResultDigest !== null ||
    reasonCodes.length !== 1 ||
    reasonCodes[0] !== `workflow.${status}`
  ) {
    throw invalid("schema.corrupt", "non-completed semantic result reason does not match its exact status", []);
  }
  if ((status === "result_invalid" || status === "result_limit") && response === null) {
    throw invalid("schema.corrupt", "invalid or oversized results require known response metadata", []);
  }
  if (status === "provider_refused" && response === null) {
    throw invalid("schema.corrupt", "provider refusal requires known response metadata", []);
  }
  if (status === "outcome_unknown" && (response !== null || usage.status !== "unreported")) {
    throw invalid("schema.corrupt", "unknown outcomes have no response or reported usage", []);
  }
}

export function parseSemanticResultBinding(input: unknown): SemanticResultBinding {
  const fields = readFields(input, []);
  const schemaVersion = fields.schemaVersion1();
  const turnKeyDigest = fields.req("turnKeyDigest", parseDigestAt);
  const status = fields.req("status", parseOneOf(RESULT_STATUSES));
  const response = fields.req("response", parseNullable(parseResponseAt));
  const usage = fields.req("usage", parseUsageAt);
  const normalizedResult = fields.req(
    "normalizedResult",
    parseNullable((value, path) => {
      assertSemanticWorkflowStructureBound(value);
      const parsed = parseJson(value, path);
      if (Buffer.byteLength(canonicalJsonText(parsed), "utf8") > SEMANTIC_WORKFLOW_MAX_CANONICAL_BYTES) {
        throw invalid("semantic.workflow_limit", "normalized semantic result exceeds its canonical byte ceiling", path);
      }
      return parsed;
    }),
  );
  const normalizedResultDigest = fields.req("normalizedResultDigest", parseNullable(parseDigestAt));
  const reasonCodes = fields.req(
    "reasonCodes",
    parseBoundedArray(parseId, MAX_REASON_CODES, "semantic result reason codes"),
  );
  assertSortedUnique(reasonCodes, (value) => value, ["reasonCodes"]);
  assertResultPairing(status, response, usage, normalizedResult, normalizedResultDigest, reasonCodes);
  const base = {
    turnKeyDigest,
    reservationDigest: fields.req("reservationDigest", parseDigestAt),
    dispatchDigest: fields.req("dispatchDigest", parseDigestAt),
    status,
    response,
    usage,
    normalizedResult,
    normalizedResultDigest,
    reasonCodes,
  };
  const id = fields.req("id", parseDurableId);
  if (id !== resultId(turnKeyDigest)) {
    throw invalid("schema.corrupt", "semantic result id does not match its turn key", ["id"]);
  }
  const bindingDigest = fields.req("bindingDigest", parseDigestAt);
  if (bindingDigest !== semanticResultBindingDigest(base)) {
    throw invalid("schema.corrupt", "semantic result binding digest does not match its content", ["bindingDigest"]);
  }
  return deepFreeze({ schemaVersion, id, ...base, bindingDigest });
}

export function buildSemanticResultBinding(
  input: Omit<SemanticResultBinding, "schemaVersion" | "id" | "bindingDigest">,
): SemanticResultBinding {
  return parseSemanticResultBinding({
    schemaVersion: 1,
    id: resultId(input.turnKeyDigest),
    ...input,
    bindingDigest: semanticResultBindingDigest(input),
  });
}

const parseRecordRefAt: Parse<{ readonly id: string; readonly reservationDigest: string }> = (input, path) => {
  const fields = readFields(input, path);
  return {
    id: fields.req("id", parseDurableId),
    reservationDigest: fields.req("reservationDigest", parseDigestAt),
  };
};

const parseAuthorizationRefAt: Parse<NonNullable<SemanticTurnReceipt["authorization"]>> = (input, path) => {
  const fields = readFields(input, path);
  return {
    id: fields.req("id", parseDurableId),
    authorizationDigest: fields.req("authorizationDigest", parseDigestAt),
  };
};

const parseDispatchRefAt: Parse<SemanticTurnReceipt["dispatch"]> = (input, path) => {
  const fields = readFields(input, path);
  return {
    id: fields.req("id", parseDurableId),
    dispatchDigest: fields.req("dispatchDigest", parseDigestAt),
  };
};

const parseResultRefAt: Parse<SemanticTurnReceipt["result"]> = (input, path) => {
  const fields = readFields(input, path);
  return {
    id: fields.req("id", parseDurableId),
    bindingDigest: fields.req("bindingDigest", parseDigestAt),
  };
};

const parseDerivationRefAt: Parse<
  Extract<SemanticTurnReceipt["output"], { readonly kind: "generation" }>["derivationRefs"][number]
> = (input, path) => {
  const fields = readFields(input, path);
  const id = fields.req("id", parseDurableId);
  const derivationDigest = fields.req("derivationDigest", parseDigestAt);
  if (id !== `insight-${derivationDigest}`) {
    throw invalid("schema.corrupt", "workflow derivation id does not match its digest", [...path, "id"]);
  }
  return {
    id,
    derivationDigest,
    scopeDigest: fields.req("scopeDigest", parseDigestAt),
  };
};

const parseOutputAt: Parse<SemanticTurnReceipt["output"]> = (input, path) => {
  const fields = readFields(input, path);
  const kind = fields.req("kind", parseOneOf(OUTPUT_KINDS));
  if (kind === "none") return { kind, reasonCode: fields.req("reasonCode", parseId) };
  if (kind === "advisory_review") {
    return {
      kind,
      assessmentId: fields.req("assessmentId", parseDurableId),
      assessmentDigest: fields.req("assessmentDigest", parseDigestAt),
    };
  }
  const derivationRefs = fields.req(
    "derivationRefs",
    parseBoundedArray(parseDerivationRefAt, MAX_DERIVATION_REFS, "workflow derivation references"),
  );
  if (derivationRefs.length === 0) {
    throw invalid("schema.invalid", "completed generation requires at least one derivation reference", [
      ...path,
      "derivationRefs",
    ]);
  }
  assertSortedUnique(
    derivationRefs,
    (reference) => canonicalKey([reference.id, reference.derivationDigest, reference.scopeDigest]),
    [...path, "derivationRefs"],
  );
  const workflowExecutionId = fields.req("workflowExecutionId", parseDurableId);
  const workflowExecutionKeyDigest = fields.req("workflowExecutionKeyDigest", parseDigestAt);
  if (workflowExecutionId !== `semantic-workflow-execution-${workflowExecutionKeyDigest}`) {
    throw invalid("schema.corrupt", "workflow execution id does not match its key digest", [
      ...path,
      "workflowExecutionId",
    ]);
  }
  return {
    kind,
    workflowExecutionId,
    workflowExecutionKeyDigest,
    workflowExecutionDigest: fields.req("workflowExecutionDigest", parseDigestAt),
    derivationRefs,
  };
};

function turnReceiptContent(input: Omit<SemanticTurnReceipt, "schemaVersion" | "id" | "turnDigest">): unknown {
  return input;
}

export function semanticTurnDigest(input: Omit<SemanticTurnReceipt, "schemaVersion" | "id" | "turnDigest">): string {
  return structuralDigest(TURN_RECEIPT_DOMAIN, turnReceiptContent(input));
}

function assertTurnOutputPairing(
  lane: SemanticWorkflowDefinition["lane"],
  status: SemanticResultStatus,
  scopeDigest: string,
  output: SemanticTurnReceipt["output"],
): void {
  if (status !== "completed") {
    if (output.kind !== "none" || output.reasonCode !== `workflow.${status}`) {
      throw invalid("schema.corrupt", "failed semantic turns require their exact static no-output reason", []);
    }
    return;
  }
  if (output.kind === "none") {
    if (lane !== "generation" || output.reasonCode !== "workflow.condition_not_detected") {
      throw invalid("schema.corrupt", "completed no-output turns require an exact negative generation result", []);
    }
    return;
  }
  if (
    (lane === "generation" && output.kind !== "generation") ||
    (lane === "advisory_review" && output.kind !== "advisory_review")
  ) {
    throw invalid("schema.corrupt", "completed semantic turn output does not match its workflow lane", []);
  }
  if (
    output.kind === "generation" &&
    output.derivationRefs.some((reference) => reference.scopeDigest !== scopeDigest)
  ) {
    throw invalid("schema.corrupt", "workflow derivation reference belongs to another scope", []);
  }
}

export function parseSemanticTurnReceipt(input: unknown): SemanticTurnReceipt {
  const fields = readFields(input, []);
  const schemaVersion = fields.schemaVersion1();
  const turnKeyDigest = fields.req("turnKeyDigest", parseDigestAt);
  const lane = fields.req("lane", parseOneOf(WORKFLOW_LANES));
  const scopeDigest = fields.req("scopeDigest", parseDigestAt);
  const status = fields.req("status", parseOneOf(RESULT_STATUSES));
  const output = fields.req("output", parseOutputAt);
  if (
    output.kind === "advisory_review" &&
    output.assessmentId !== `semantic-review-assessment-${output.assessmentDigest}`
  ) {
    throw invalid("schema.corrupt", "semantic review assessment id does not match its digest", [
      "output",
      "assessmentId",
    ]);
  }
  assertTurnOutputPairing(lane, status, scopeDigest, output);
  const base = {
    turnKeyDigest,
    reservation: fields.req("reservation", parseRecordRefAt),
    authorization: fields.req("authorization", parseNullable(parseAuthorizationRefAt)),
    dispatch: fields.req("dispatch", parseDispatchRefAt),
    result: fields.req("result", parseResultRefAt),
    lane,
    scopeDigest,
    status,
    output,
  };
  if (base.dispatch.id !== dispatchId(turnKeyDigest) || base.result.id !== resultId(turnKeyDigest)) {
    throw invalid("schema.corrupt", "semantic turn receipt contains a foreign dispatch or result reference", []);
  }
  const id = fields.req("id", parseDurableId);
  if (id !== turnId(turnKeyDigest)) {
    throw invalid("schema.corrupt", "semantic turn receipt id does not match its turn key", ["id"]);
  }
  const turnDigest = fields.req("turnDigest", parseDigestAt);
  if (turnDigest !== semanticTurnDigest(base)) {
    throw invalid("schema.corrupt", "semantic turn digest does not match its content", ["turnDigest"]);
  }
  return deepFreeze({ schemaVersion, id, ...base, turnDigest });
}

export function buildSemanticTurnReceipt(
  input: Omit<SemanticTurnReceipt, "schemaVersion" | "id" | "turnDigest">,
): SemanticTurnReceipt {
  return parseSemanticTurnReceipt({
    schemaVersion: 1,
    id: turnId(input.turnKeyDigest),
    ...input,
    turnDigest: semanticTurnDigest(input),
  });
}

function scopeIndexContent(input: Omit<SemanticTurnScopeIndex, "schemaVersion" | "indexDigest">): unknown {
  return input;
}

export function semanticTurnScopeIndexDigest(
  input: Omit<SemanticTurnScopeIndex, "schemaVersion" | "indexDigest">,
): string {
  return structuralDigest(TURN_SCOPE_INDEX_DOMAIN, scopeIndexContent(input));
}

export function parseSemanticTurnScopeIndex(input: unknown): SemanticTurnScopeIndex {
  const fields = readFields(input, []);
  const schemaVersion = fields.schemaVersion1();
  const turnKeyDigest = fields.req("turnKeyDigest", parseDigestAt);
  const base = {
    scopeDigest: fields.req("scopeDigest", parseDigestAt),
    turnId: fields.req("turnId", parseDurableId),
    turnKeyDigest,
    turnDigest: fields.req("turnDigest", parseDigestAt),
  };
  if (base.turnId !== turnId(turnKeyDigest)) {
    throw invalid("schema.corrupt", "semantic turn scope index id does not match its turn key", ["turnId"]);
  }
  const indexDigest = fields.req("indexDigest", parseDigestAt);
  if (indexDigest !== semanticTurnScopeIndexDigest(base)) {
    throw invalid("schema.corrupt", "semantic turn scope index digest does not match its content", ["indexDigest"]);
  }
  return deepFreeze({ schemaVersion, ...base, indexDigest });
}

export function buildSemanticTurnScopeIndex(
  input: Omit<SemanticTurnScopeIndex, "schemaVersion" | "indexDigest">,
): SemanticTurnScopeIndex {
  return parseSemanticTurnScopeIndex({
    schemaVersion: 1,
    ...input,
    indexDigest: semanticTurnScopeIndexDigest(input),
  });
}
