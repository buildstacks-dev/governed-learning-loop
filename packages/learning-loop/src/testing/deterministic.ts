// Deterministic time and identifier seeds for tests.
import { LearningLoopError } from "../diagnostics.js";
import type { Clock, IdGenerator } from "../ports/clock.js";

export interface FixedClock extends Clock {
  /** Advances the clock; defaults to one second. */
  tick(milliseconds?: number): void;
}

export function createFixedClock(startIso: string): FixedClock {
  let epochMs = Date.parse(startIso);
  if (Number.isNaN(epochMs)) {
    throw new LearningLoopError("schema.invalid", [
      {
        code: "schema.invalid",
        severity: "error",
        message: `createFixedClock requires an ISO timestamp, got ${JSON.stringify(startIso)}`,
      },
    ]);
  }
  return {
    now: () => new Date(epochMs).toISOString(),
    tick: (milliseconds = 1000) => {
      epochMs += milliseconds;
    },
  };
}

/** Ids are `[prefix-]namespace-N` with an independent counter per namespace. */
export function createSequentialIds(prefix?: string): IdGenerator {
  const counters = new Map<string, number>();
  return {
    next: (namespace) => {
      const count = (counters.get(namespace) ?? 0) + 1;
      counters.set(namespace, count);
      return prefix === undefined ? `${namespace}-${count}` : `${prefix}-${namespace}-${count}`;
    },
  };
}
