// Host-side session-file discovery. This is deliberately DEMO code, not
// adapter code: the transcript adapters never crawl — the host decides which
// files exist and hands over an explicit list (kernel privacy rule "explicit
// inputs only"). Both walks stay strictly under the user-supplied --root.
//
// Day attribution:
// - claude-code (`<root>/<project-dir>/*.jsonl`): a file belongs to --day when
//   its mtime falls on that LOCAL calendar day. This is a heuristic: a session
//   spanning midnight lands wholly on the day of its last write, and touching
//   an old file re-dates it. Cheap, offline, and honest enough for a report
//   that only ever claims recurrence.
// - codex (`<root>/YYYY/MM/DD/*.jsonl`): the provider already partitions by
//   day directory, so the path is the day.
import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

export type Provider = "claude-code" | "codex";

export function localDayOf(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

export function isValidDay(day: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const parsed = Date.parse(`${day}T00:00:00Z`);
  if (!Number.isFinite(parsed)) return false;
  return new Date(parsed).toISOString().slice(0, 10) === day;
}

/** Inclusive day range as YYYY-MM-DD strings; throws if from > to. */
export function dayRange(from: string, to: string): readonly string[] {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (start > end) throw new Error(`--from ${from} is after --to ${to}`);
  const days: string[] = [];
  for (let at = start; at <= end; at += 86_400_000) {
    days.push(new Date(at).toISOString().slice(0, 10));
  }
  return days;
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function assertRootExists(root: string): Promise<void> {
  try {
    await stat(root);
  } catch (error) {
    if (isMissing(error)) throw new Error(`--root ${root} does not exist`);
    throw error;
  }
}

async function discoverClaudeCode(root: string, day: string): Promise<readonly string[]> {
  await assertRootExists(root);
  const files: string[] = [];
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join(root, entry.name);
    const children = await readdir(dir, { withFileTypes: true });
    for (const child of children) {
      if (!child.isFile() || !child.name.endsWith(".jsonl")) continue;
      const path = join(dir, child.name);
      const stats = await stat(path);
      if (localDayOf(stats.mtime) === day) files.push(path);
    }
  }
  return files.sort();
}

async function discoverCodex(root: string, day: string): Promise<readonly string[]> {
  await assertRootExists(root);
  const dir = join(root, day.slice(0, 4), day.slice(5, 7), day.slice(8, 10));
  let entries: readonly Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    // A missing day directory simply means no sessions that day; any other
    // failure (for example a non-directory in the way) is a real error.
    if (isMissing(error)) return [];
    throw error;
  }
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(join(dir, entry.name));
  }
  return files.sort();
}

export function discoverSessionFiles(provider: Provider, root: string, day: string): Promise<readonly string[]> {
  return provider === "claude-code" ? discoverClaudeCode(root, day) : discoverCodex(root, day);
}
