// Programmatic CLI entry: `runCli(argv, out)` — tests drive this directly;
// src/cli.ts binds it to process.argv/stdout. Argv is parsed by hand with
// node:util parseArgs; no dependency.
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { LearningLoopError } from "@cormidia/learning-loop";
import { runBackfillCommand, runIngestCommand } from "./commands/ingest.js";
import { runDistillCommand } from "./commands/distill.js";
import { runReportCommand } from "./commands/report.js";
import { runReviewCommand } from "./commands/review.js";
import { composeDemoLoop } from "./compose.js";
import type { Provider } from "./discovery.js";
import { isValidDay } from "./discovery.js";
import type { CliOutput } from "./output.js";

export type { CliOutput } from "./output.js";

const USAGE: readonly string[] = [
  "transcript-insights — governed local insights over your own session logs",
  "",
  "usage:",
  "  ingest   --provider claude-code|codex --root <dir> --day YYYY-MM-DD --state <dir>",
  "  backfill --provider claude-code|codex --root <dir> --from YYYY-MM-DD --to YYYY-MM-DD --state <dir>",
  "  report   --state <dir>",
  "  distill  --state <dir>",
  "  review   --state <dir> --candidate <id> --accept|--reject [--note <text>]",
  "",
  "Everything is local: no network, no model calls, deterministic heuristics only.",
  "The demo (not the adapters) discovers session files under the --root you name:",
  "  claude-code: <root>/*/*.jsonl whose file mtime falls on --day (local time)",
  "  codex:       <root>/YYYY/MM/DD/*.jsonl from the day's directory",
];

class UsageError extends Error {}

interface ParsedOptions {
  readonly [key: string]: string | boolean | undefined;
}

function parseOptions(
  args: readonly string[],
  stringKeys: readonly string[],
  booleanKeys: readonly string[] = [],
): ParsedOptions {
  const options: Record<string, { type: "string" } | { type: "boolean" }> = {};
  for (const key of stringKeys) options[key] = { type: "string" };
  for (const key of booleanKeys) options[key] = { type: "boolean" };
  try {
    const { values } = parseArgs({ args: [...args], options, strict: true, allowPositionals: false });
    return values;
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : "invalid arguments");
  }
}

function requireText(values: ParsedOptions, key: string): string {
  const value = values[key];
  if (typeof value !== "string" || value.length === 0) throw new UsageError(`--${key} is required`);
  return value;
}

function requireProvider(values: ParsedOptions): Provider {
  const value = requireText(values, "provider");
  if (value === "claude-code" || value === "codex") return value;
  throw new UsageError(`--provider must be "claude-code" or "codex", not "${value}"`);
}

function requireDay(values: ParsedOptions, key: string): string {
  const value = requireText(values, key);
  if (!isValidDay(value)) throw new UsageError(`--${key} must be a real calendar day in YYYY-MM-DD form`);
  return value;
}

async function dispatch(command: string, rest: readonly string[], out: CliOutput): Promise<number> {
  switch (command) {
    case "ingest": {
      const values = parseOptions(rest, ["provider", "root", "day", "state"]);
      const provider = requireProvider(values);
      const root = requireText(values, "root");
      const day = requireDay(values, "day");
      const stateDir = resolve(requireText(values, "state"));
      out.write(`ingest: start state=${stateDir} provider=${provider} day=${day}`);
      const loop = await composeDemoLoop(stateDir);
      return runIngestCommand(loop, provider, root, day, out);
    }
    case "backfill": {
      const values = parseOptions(rest, ["provider", "root", "from", "to", "state"]);
      const provider = requireProvider(values);
      const root = requireText(values, "root");
      const from = requireDay(values, "from");
      const to = requireDay(values, "to");
      const stateDir = resolve(requireText(values, "state"));
      out.write(`backfill: start state=${stateDir} provider=${provider} days=${from}..${to}`);
      const loop = await composeDemoLoop(stateDir);
      return runBackfillCommand(loop, provider, root, from, to, out);
    }
    case "report": {
      const values = parseOptions(rest, ["state"]);
      const stateDir = resolve(requireText(values, "state"));
      out.write(`report: start state=${stateDir} operation=read-only`);
      const loop = await composeDemoLoop(stateDir, { initializeState: false });
      return runReportCommand(loop, out);
    }
    case "distill": {
      const values = parseOptions(rest, ["state"]);
      const stateDir = resolve(requireText(values, "state"));
      out.write(`distill: start state=${stateDir} scan=read-only writes=candidate-proposals-only`);
      const loop = await composeDemoLoop(stateDir, { initializeState: false });
      return runDistillCommand(loop, out);
    }
    case "review": {
      const values = parseOptions(rest, ["state", "candidate", "note"], ["accept", "reject"]);
      const candidateId = requireText(values, "candidate");
      const accept = values.accept === true;
      const reject = values.reject === true;
      if (accept === reject) throw new UsageError("pass exactly one of --accept or --reject");
      const note = typeof values.note === "string" ? values.note : undefined;
      const stateDir = resolve(requireText(values, "state"));
      out.write(`review: start state=${stateDir} candidate=${candidateId}`);
      const loop = await composeDemoLoop(stateDir, { initializeState: false });
      return runReviewCommand(loop, candidateId, accept ? "accept" : "reject", note, out);
    }
    default: {
      out.write(`unknown command: ${command}`);
      for (const line of USAGE) out.write(line);
      return 2;
    }
  }
}

export async function runCli(argv: readonly string[], out: CliOutput): Promise<number> {
  // pnpm forwards the `--` separator of `pnpm start -- <args>` verbatim.
  const [command, ...rest] = argv[0] === "--" ? argv.slice(1) : argv;
  if (command === undefined || command === "--help" || command === "-h" || command === "help") {
    for (const line of USAGE) out.write(line);
    return command === undefined ? 2 : 0;
  }
  try {
    return await dispatch(command, rest, out);
  } catch (error) {
    if (error instanceof UsageError) {
      out.write(`usage error: ${error.message}`);
      for (const line of USAGE) out.write(line);
      return 2;
    }
    if (error instanceof LearningLoopError) {
      // Kernel refusals carry stable codes; the message never echoes
      // transcript content (adapter guarantee).
      out.write(`error [${error.code}]: ${error.message}`);
      return 1;
    }
    if (error instanceof Error) {
      out.write(`error: ${error.message}`);
      return 1;
    }
    out.write("error: unknown failure");
    return 1;
  }
}
