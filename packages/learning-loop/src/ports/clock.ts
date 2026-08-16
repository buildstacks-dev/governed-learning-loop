// Time and identifier ports (contract §Time, identifiers, and the outbox).
// Injectable for deterministic tests; canonical serialization and content
// digests are protocol, not per-host choices, and are NOT injectable.

export interface Clock {
  now(): string;
}

export interface IdGenerator {
  next(namespace: string): string;
}
