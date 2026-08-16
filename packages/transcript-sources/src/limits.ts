// Resource ceilings — FAIL CLOSED (AGENTS.md "Privacy rules"). A breach never
// crashes and never truncates silently: the file is skipped whole or the
// page's observations are marked "partial", always with a diagnostic.

/** Maximum session-file size in bytes; larger files are skipped whole. */
export const MAX_FILE_BYTES = 50 * 1024 * 1024;

/** Maximum single-line size in bytes; longer lines are skipped and the page becomes partial. */
export const MAX_LINE_BYTES = 2 * 1024 * 1024;

/** Maximum records parsed per file; further lines are skipped and the page becomes partial. */
export const MAX_RECORDS_PER_FILE = 200_000;
