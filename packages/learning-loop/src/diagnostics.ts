// Error and diagnostic model (docs/contract/api-contract.md §Error and
// diagnostic model). Stable machine-readable codes; human-readable context.
import type { JsonValue } from "./canonical/json.js";

export interface Diagnostic {
  readonly code: string;
  readonly severity: "info" | "warning" | "error";
  readonly message: string;
  readonly path?: readonly (string | number)[];
  readonly details?: JsonValue;
}

export class LearningLoopError extends Error {
  readonly code: string;
  readonly diagnostics: readonly Diagnostic[];

  constructor(code: string, diagnostics: readonly Diagnostic[]) {
    const first = diagnostics[0];
    super(first === undefined ? code : `${code}: ${first.message}`);
    this.name = "LearningLoopError";
    this.code = code;
    this.diagnostics = diagnostics;
  }
}
