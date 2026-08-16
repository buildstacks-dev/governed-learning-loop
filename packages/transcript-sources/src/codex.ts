// Codex rollout logs (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl): one JSON
// object per line, shape { timestamp, type, payload }. Accepted band (observed
// against Codex CLI 0.x): top-level types session_meta / turn_context /
// world_state / response_item / event_msg; unlisted types and payload types
// are unknown-but-visible.
//
// EXPERIMENTAL support status. Projections are minimized before emission:
// message text, instructions, tool arguments/outputs, and reasoning never
// leave this module — see ../AGENTS.md. Conversation messages project from
// response_item message records; the duplicate event_msg user_message /
// agent_message events are deliberately silent to avoid double counting.
import type { EvidenceSource } from "@cormidia/learning-loop";
import { createExplicitFilesSource } from "./explicit-files-source.js";
import type { TranscriptFilesInput } from "./input.js";
import { arrayField, booleanField, finiteNumberField, isRecord, recordField, stringField } from "./narrow.js";
import type { SessionDraft } from "./project.js";
import { addBandFailure, addObservation, hasCorrectionSignal, truncateType, validTimestamp } from "./project.js";
import type { FileRef, ParsedLine } from "./session-file.js";

/** Accepted version band: Codex CLI 0.x rollout JSONL (observed structure). */
export const CODEX_ADAPTER_VERSION = "0.1.0-experimental+codex-rollout-0.x";

const PROVIDER = "codex";

// Known response_item payload types that deliberately produce no observation
// (reasoning is content; call requests pair with their *_output completions).
const SILENT_RESPONSE_ITEMS = new Set(["reasoning", "web_search_call", "tool_search_call", "tool_search_output"]);

// Known event_msg payload types that deliberately produce no observation:
// user_message/agent_message duplicate response_item messages; the rest are
// content-bearing or UI noise.
const SILENT_EVENTS = new Set([
  "user_message",
  "agent_message",
  "agent_reasoning",
  "patch_apply_end",
  "web_search_end",
]);

const TASK_SIGNALS: ReadonlyMap<string, "started" | "complete" | "aborted" | "rolled_back"> = new Map([
  ["task_started", "started"],
  ["task_complete", "complete"],
  ["turn_aborted", "aborted"],
  ["thread_rolled_back", "rolled_back"],
]);

export function createCodexTranscriptSource(): EvidenceSource<TranscriptFilesInput> {
  return createExplicitFilesSource({
    provider: PROVIDER,
    sourceId: "codex-transcripts",
    adapterVersion: CODEX_ADAPTER_VERSION,
    firstLineBand: (record) => {
      if (stringField(record, "type") === undefined) return 'record has no string "type" field';
      if (recordField(record, "payload") === undefined) return 'record has no "payload" object';
      return undefined;
    },
    mapRecords: mapCodexRecords,
  });
}

function mapCodexRecords(draft: SessionDraft, lines: readonly ParsedLine[], ref: FileRef): void {
  const toolNamesByCallId = new Map<string, string>();
  for (const { lineNumber, record } of lines) {
    if (draft.firstRecordLine === undefined) draft.firstRecordLine = lineNumber;
    const type = stringField(record, "type");
    if (type === undefined) {
      addBandFailure(draft, ref, lineNumber, 'record has no string "type" field');
      continue;
    }
    const occurredAt = validTimestamp(record.timestamp);
    if (occurredAt !== undefined) draft.timestamps.push(occurredAt);
    const payload = recordField(record, "payload");
    switch (type) {
      case "session_meta": {
        if (payload === undefined) {
          addBandFailure(draft, ref, lineNumber, "session_meta record has no payload object");
          break;
        }
        if (draft.nativeSessionId === undefined) draft.nativeSessionId = stringField(payload, "id");
        if (draft.providerVersion === undefined) draft.providerVersion = stringField(payload, "cli_version");
        if (draft.cwd === undefined) draft.cwd = stringField(payload, "cwd");
        if (draft.gitBranch === undefined) {
          const git = recordField(payload, "git");
          draft.gitBranch = git === undefined ? undefined : stringField(git, "branch");
        }
        break;
      }
      case "turn_context": {
        if (payload !== undefined && draft.cwd === undefined) draft.cwd = stringField(payload, "cwd");
        break;
      }
      case "world_state":
        break;
      case "response_item": {
        if (payload === undefined) {
          addBandFailure(draft, ref, lineNumber, "response_item record has no payload object");
          break;
        }
        mapResponseItem(draft, ref, lineNumber, occurredAt, payload, toolNamesByCallId);
        break;
      }
      case "event_msg": {
        if (payload === undefined) {
          addBandFailure(draft, ref, lineNumber, "event_msg record has no payload object");
          break;
        }
        mapEventMessage(draft, ref, lineNumber, occurredAt, payload);
        break;
      }
      default:
        addObservation(draft, lineNumber, "transcript.unknown", { nativeType: truncateType(type) }, occurredAt);
    }
  }
}

function mapResponseItem(
  draft: SessionDraft,
  ref: FileRef,
  lineNumber: number,
  occurredAt: string | undefined,
  payload: Record<string, unknown>,
  toolNamesByCallId: Map<string, string>,
): void {
  const payloadType = stringField(payload, "type");
  if (payloadType === undefined) {
    addBandFailure(draft, ref, lineNumber, 'response_item payload has no string "type" field');
    return;
  }
  switch (payloadType) {
    case "message": {
      const role = stringField(payload, "role");
      // Developer/system prompts are instructions and are never projected.
      if (role !== "user" && role !== "assistant") return;
      let charCount = 0;
      let correction = false;
      const content = arrayField(payload, "content");
      if (content !== undefined) {
        for (const block of content) {
          if (!isRecord(block)) continue;
          const text = stringField(block, "text");
          if (text !== undefined) {
            charCount += text.length;
            if (role === "user") correction = correction || hasCorrectionSignal(text);
          }
        }
      }
      addObservation(
        draft,
        lineNumber,
        "transcript.message",
        {
          actor: role === "user" ? "human" : "agent",
          charCount,
          ...(correction ? { correctionSignal: true } : {}),
        },
        occurredAt,
      );
      return;
    }
    case "function_call":
    case "custom_tool_call": {
      const callId = stringField(payload, "call_id");
      const name = stringField(payload, "name");
      if (callId !== undefined && name !== undefined) toolNamesByCallId.set(callId, name);
      return;
    }
    case "function_call_output":
    case "custom_tool_call_output": {
      const callId = stringField(payload, "call_id");
      const toolName = (callId === undefined ? undefined : toolNamesByCallId.get(callId)) ?? "unknown";
      addObservation(
        draft,
        lineNumber,
        "transcript.tool.completed",
        { toolName, outcome: toolOutcomeOf(payload.output) },
        occurredAt,
      );
      return;
    }
    default:
      if (!SILENT_RESPONSE_ITEMS.has(payloadType)) {
        addObservation(
          draft,
          lineNumber,
          "transcript.unknown",
          { nativeType: `response_item/${truncateType(payloadType)}` },
          occurredAt,
        );
      }
  }
}

// Outcome derives from STRUCTURAL signals only (is_error flag, metadata exit
// code). A string output is opaque content: never parsed, never inspected.
function toolOutcomeOf(output: unknown): "success" | "failure" | "unknown" {
  if (!isRecord(output)) return "unknown";
  const isError = booleanField(output, "is_error");
  if (isError !== undefined) return isError ? "failure" : "success";
  const metadata = recordField(output, "metadata");
  const exitCode = metadata === undefined ? undefined : finiteNumberField(metadata, "exit_code");
  if (exitCode !== undefined) return exitCode === 0 ? "success" : "failure";
  return "unknown";
}

function mapEventMessage(
  draft: SessionDraft,
  ref: FileRef,
  lineNumber: number,
  occurredAt: string | undefined,
  payload: Record<string, unknown>,
): void {
  const payloadType = stringField(payload, "type");
  if (payloadType === undefined) {
    addBandFailure(draft, ref, lineNumber, 'event_msg payload has no string "type" field');
    return;
  }
  // Task lifecycle events are advisory hints, not outcomes: they become
  // observations, never an episode status.
  const signal = TASK_SIGNALS.get(payloadType);
  if (signal !== undefined) {
    addObservation(draft, lineNumber, "transcript.task.signal", { signal }, occurredAt);
    return;
  }
  if (payloadType === "token_count") {
    const info = recordField(payload, "info");
    const lastUsage = info === undefined ? undefined : recordField(info, "last_token_usage");
    if (lastUsage !== undefined) {
      const tokensIn = finiteNumberField(lastUsage, "input_tokens");
      const tokensOut = finiteNumberField(lastUsage, "output_tokens");
      if (tokensIn !== undefined || tokensOut !== undefined) {
        addObservation(
          draft,
          lineNumber,
          "transcript.usage",
          {
            ...(tokensIn === undefined ? {} : { tokensIn }),
            ...(tokensOut === undefined ? {} : { tokensOut }),
            quality: "reported",
          },
          occurredAt,
        );
      }
    }
    return;
  }
  if (!SILENT_EVENTS.has(payloadType)) {
    addObservation(
      draft,
      lineNumber,
      "transcript.unknown",
      { nativeType: `event_msg/${truncateType(payloadType)}` },
      occurredAt,
    );
  }
}
