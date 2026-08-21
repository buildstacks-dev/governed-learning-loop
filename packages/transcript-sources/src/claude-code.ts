// Claude Code local session logs (~/.claude/projects/<slug>/<session>.jsonl):
// one JSON object per line. Accepted band (observed against Claude Code 2.x):
// records carry a string "type" — user/assistant records carry a "message"
// whose content is a string or an array of typed blocks (text | thinking |
// tool_use | tool_result). Anything else is unknown-but-visible.
//
// EXPERIMENTAL support status. Projections are minimized before emission:
// message text, tool arguments/results, attachments, prompt echoes, and
// titles never leave this module — see ../AGENTS.md. The adapter runs under
// a content-addressed TranscriptPrivacyPolicy (decision 0024).
import type { EvidenceSource } from "@cormidia/learning-loop";
import type { TranscriptSourceOptions } from "./explicit-files-source.js";
import { createExplicitFilesSource } from "./explicit-files-source.js";
import type { TranscriptFilesInput } from "./input.js";
import { booleanField, finiteNumberField, isRecord, recordField, stringField } from "./narrow.js";
import type { SessionDraft } from "./project.js";
import {
  addBandFailure,
  addDuplicateRecord,
  addObservation,
  hasCorrectionSignal,
  structuralToolNameToken,
  structuralTypeToken,
  validTimestamp,
} from "./project.js";
import type { FileRef, ParsedLine } from "./session-file.js";

/**
 * Accepted version band: Claude Code 2.x JSONL session logs (observed
 * structure). 0.3.0 adds policy-bound reads, structural token shapes for
 * provider identifiers, and duplicate-record collapsing; 0.2.0 states remain
 * read-only audit history and are not re-ingested in place.
 */
export const CLAUDE_CODE_ADAPTER_VERSION = "0.3.0-experimental+claude-code-jsonl-2.x";

const PROVIDER = "claude-code";

// Known record types that deliberately produce no observation: their payloads
// are content-bearing (attachments, prompt echoes, titles) or queue noise.
const SILENT_TYPES = new Set(["attachment", "last-prompt", "ai-title", "queue-operation"]);

export function createClaudeCodeTranscriptSource(
  options: TranscriptSourceOptions = {},
): EvidenceSource<TranscriptFilesInput> {
  return createExplicitFilesSource(
    {
      provider: PROVIDER,
      sourceId: "claude-code-transcripts",
      adapterVersion: CLAUDE_CODE_ADAPTER_VERSION,
      firstLineBand: (record) => {
        if (stringField(record, "type") === undefined) return 'record has no string "type" field';
        if (recordField(record, "payload") !== undefined) {
          return 'record carries a "payload" object, which the Claude Code JSONL band does not';
        }
        return undefined;
      },
      mapRecords: mapClaudeRecords,
    },
    options,
  );
}

function mapClaudeRecords(draft: SessionDraft, lines: readonly ParsedLine[], ref: FileRef): void {
  const toolNamesByUseId = new Map<string, string>();
  // Claude Code records carry a native `uuid`; a repeated uuid inside one file
  // is a duplicated segment (re-logged history), never a second occurrence.
  const seenRecordIds = new Set<string>();
  for (const { lineNumber, record } of lines) {
    if (draft.firstRecordLine === undefined) draft.firstRecordLine = lineNumber;
    const type = stringField(record, "type");
    if (type === undefined) {
      addBandFailure(draft, ref, lineNumber, 'record has no string "type" field');
      continue;
    }
    const uuid = stringField(record, "uuid");
    if (uuid !== undefined) {
      if (seenRecordIds.has(uuid)) {
        addDuplicateRecord(draft);
        continue;
      }
      seenRecordIds.add(uuid);
    }
    const occurredAt = validTimestamp(record.timestamp);
    if (occurredAt !== undefined) draft.timestamps.push(occurredAt);
    if (draft.nativeSessionId === undefined) draft.nativeSessionId = stringField(record, "sessionId");
    if (draft.providerVersion === undefined) draft.providerVersion = stringField(record, "version");
    if (draft.cwd === undefined) draft.cwd = stringField(record, "cwd");
    if (draft.gitBranch === undefined) draft.gitBranch = stringField(record, "gitBranch");
    if (type === "user") {
      mapUserRecord(draft, ref, lineNumber, occurredAt, record, toolNamesByUseId);
    } else if (type === "assistant") {
      mapAssistantRecord(draft, ref, lineNumber, occurredAt, record, toolNamesByUseId);
    } else if (!SILENT_TYPES.has(type)) {
      addObservation(draft, lineNumber, "transcript.unknown", { nativeType: structuralTypeToken(type) }, occurredAt);
    }
  }
}

function mapUserRecord(
  draft: SessionDraft,
  ref: FileRef,
  lineNumber: number,
  occurredAt: string | undefined,
  record: Record<string, unknown>,
  toolNamesByUseId: ReadonlyMap<string, string>,
): void {
  const message = recordField(record, "message");
  if (message === undefined) {
    addBandFailure(draft, ref, lineNumber, '"user" record has no message object');
    return;
  }
  const content = message.content;
  let charCount = 0;
  let sawText = false;
  let correction = false;
  let hasToolBlocks = false;
  if (typeof content === "string") {
    sawText = true;
    charCount = content.length;
    correction = hasCorrectionSignal(content);
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (!isRecord(block)) continue;
      const blockType = stringField(block, "type");
      if (blockType === "text") {
        const text = stringField(block, "text");
        if (text !== undefined) {
          sawText = true;
          charCount += text.length;
          correction = correction || hasCorrectionSignal(text);
        }
      } else if (blockType === "tool_result") {
        // Outcome derives from the structural is_error flag only; the result
        // content itself is never inspected and never emitted.
        hasToolBlocks = true;
        const toolUseId = stringField(block, "tool_use_id");
        const toolName = (toolUseId === undefined ? undefined : toolNamesByUseId.get(toolUseId)) ?? "unknown";
        const isError = booleanField(block, "is_error");
        const outcome = isError === undefined ? "unknown" : isError ? "failure" : "success";
        addObservation(draft, lineNumber, "transcript.tool.completed", { toolName, outcome }, occurredAt);
      }
    }
  } else {
    addBandFailure(draft, ref, lineNumber, '"user" record message.content is neither string nor array');
    return;
  }
  if (sawText) {
    addObservation(
      draft,
      lineNumber,
      "transcript.message",
      {
        actor: "human",
        charCount,
        ...(hasToolBlocks ? { hasToolBlocks: true } : {}),
        ...(correction ? { correctionSignal: true } : {}),
      },
      occurredAt,
    );
  }
}

function mapAssistantRecord(
  draft: SessionDraft,
  ref: FileRef,
  lineNumber: number,
  occurredAt: string | undefined,
  record: Record<string, unknown>,
  toolNamesByUseId: Map<string, string>,
): void {
  const message = recordField(record, "message");
  if (message === undefined) {
    addBandFailure(draft, ref, lineNumber, '"assistant" record has no message object');
    return;
  }
  const content = message.content;
  let charCount = 0;
  let hasToolBlocks = false;
  if (typeof content === "string") {
    charCount = content.length;
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (!isRecord(block)) continue;
      const blockType = stringField(block, "type");
      if (blockType === "text") {
        const text = stringField(block, "text");
        if (text !== undefined) charCount += text.length;
      } else if (blockType === "tool_use") {
        hasToolBlocks = true;
        const id = stringField(block, "id");
        const name = stringField(block, "name");
        if (id !== undefined && name !== undefined) toolNamesByUseId.set(id, structuralToolNameToken(name));
      }
    }
  } else {
    addBandFailure(draft, ref, lineNumber, '"assistant" record message.content is neither string nor array');
    return;
  }
  addObservation(
    draft,
    lineNumber,
    "transcript.message",
    { actor: "agent", charCount, ...(hasToolBlocks ? { hasToolBlocks: true } : {}) },
    occurredAt,
  );
  const usage = recordField(message, "usage");
  if (usage !== undefined) {
    const tokensIn = finiteNumberField(usage, "input_tokens");
    const tokensOut = finiteNumberField(usage, "output_tokens");
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
}
