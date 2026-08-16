// @cormidia/learning-loop-transcript-sources — companion adapter package.
// Transcript adapters live OUTSIDE the kernel root export deliberately
// (contract §Package shape): provider formats have a different release
// cadence and privacy risk from the governed-learning protocol.
//
// Both adapters are EXPERIMENTAL EvidenceSource<TranscriptFilesInput>
// implementations. Hosts register them with a hard "advisory" trust ceiling;
// redaction precedes persistence: projections carry structural features only —
// never message text, tool arguments, tool results, instructions, or full
// filesystem paths. See ./AGENTS.md for the non-negotiable privacy rules.
//
// Emitted observation kinds (both providers): transcript.session.meta,
// transcript.message, transcript.tool.completed, transcript.usage,
// transcript.task.signal (Codex lifecycle events), transcript.unknown.
// No measurements are ever emitted: transcripts are advisory.

export type { TranscriptFilesInput } from "./input.js";
export { MAX_FILE_BYTES, MAX_LINE_BYTES, MAX_RECORDS_PER_FILE } from "./limits.js";
export { CLAUDE_CODE_ADAPTER_VERSION, createClaudeCodeTranscriptSource } from "./claude-code.js";
export { CODEX_ADAPTER_VERSION, createCodexTranscriptSource } from "./codex.js";
