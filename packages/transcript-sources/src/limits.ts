// Shipped resource ceilings — the MAXIMA a TranscriptPrivacyPolicy may
// declare; a policy can only tighten them (./privacy-policy.ts). Every ceiling
// FAILS CLOSED (AGENTS.md "Privacy rules"): a breach never crashes and never
// truncates silently — the file is refused whole or the page's observations
// are marked "partial", always with a diagnostic.

/** Maximum session-file size in bytes; larger files are refused whole. */
export const MAX_FILE_BYTES = 50 * 1024 * 1024;

/** Maximum single-line size in bytes; longer lines are skipped and the page becomes partial. */
export const MAX_LINE_BYTES = 2 * 1024 * 1024;

/** Maximum records parsed per file; further lines are skipped and the page becomes partial. */
export const MAX_RECORDS_PER_FILE = 200_000;

/** Maximum JSON nesting depth per line, checked by a bounded scan BEFORE JSON.parse. */
export const MAX_NESTING_DEPTH = 128;

/** Maximum wall-clock parse time per file; the remainder is skipped and the page becomes partial. */
export const MAX_PROCESSING_MILLIS_PER_FILE = 60_000;
