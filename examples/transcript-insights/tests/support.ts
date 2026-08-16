// Shared test support. ALL fixture records are hand-authored synthetic
// sessions — never copied from real transcripts.
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runCli } from "../src/run.js";

export interface CliResult {
  readonly code: number;
  readonly text: string;
  readonly lines: readonly string[];
}

export async function cli(argv: readonly string[]): Promise<CliResult> {
  const lines: string[] = [];
  const code = await runCli(argv, {
    write: (line) => {
      lines.push(line);
    },
  });
  return { code, text: lines.join("\n"), lines };
}

export function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function removeDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

export function writeJsonl(path: string, records: readonly unknown[], mtime?: Date): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
  if (mtime !== undefined) utimesSync(path, mtime, mtime);
}

// --- Claude Code fixture records (observed 2.x JSONL band) ---

export function claudeUserText(timestamp: string, text: string, session?: { id: string; cwd: string }): unknown {
  return {
    type: "user",
    timestamp,
    ...(session === undefined ? {} : { sessionId: session.id, version: "2.1.0", cwd: session.cwd, gitBranch: "main" }),
    message: { content: text },
  };
}

export function claudeAssistantToolUse(timestamp: string, toolUseId: string, toolName: string): unknown {
  return {
    type: "assistant",
    timestamp,
    message: {
      content: [
        { type: "text", text: "working on it" },
        { type: "tool_use", id: toolUseId, name: toolName },
      ],
      usage: { input_tokens: 100, output_tokens: 50 },
    },
  };
}

export function claudeToolResult(timestamp: string, toolUseId: string, isError: boolean, resultText?: string): unknown {
  return {
    type: "user",
    timestamp,
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: toolUseId,
          is_error: isError,
          ...(resultText === undefined ? {} : { content: [{ type: "text", text: resultText }] }),
        },
      ],
    },
  };
}

// --- Codex fixture records (observed 0.x rollout band) ---

export function codexSessionMeta(timestamp: string, id: string, cwd: string): unknown {
  return {
    timestamp,
    type: "session_meta",
    payload: { id, cli_version: "0.9.0", cwd, git: { branch: "main" } },
  };
}

export function codexMessage(timestamp: string, role: "user" | "assistant", text: string): unknown {
  return {
    timestamp,
    type: "response_item",
    payload: { type: "message", role, content: [{ type: "input_text", text }] },
  };
}

export function codexToolCall(timestamp: string, callId: string, name: string, args?: string): unknown {
  return {
    timestamp,
    type: "response_item",
    payload: { type: "function_call", call_id: callId, name, ...(args === undefined ? {} : { arguments: args }) },
  };
}

export function codexToolOutput(timestamp: string, callId: string, isError: boolean, output?: string): unknown {
  return {
    timestamp,
    type: "response_item",
    payload: {
      type: "function_call_output",
      call_id: callId,
      output: output === undefined ? { is_error: isError } : output,
    },
  };
}

export function codexEvent(timestamp: string, type: string): unknown {
  return { timestamp, type: "event_msg", payload: { type } };
}
