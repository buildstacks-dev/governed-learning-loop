// Deterministic in-memory PublicationDestination for tests, examples, and the
// destination conformance suite (decision 0026). It is inert by
// construction: every effect lands in a per-target, append-only version log
// in process memory — no file, prompt, permission, repository, or network is
// touched. Semantics (the reference for adapter authors):
// - prepare is side-effect-free and returns one `context.write` effect whose
//   payload is the candidate's intervention content and whose expectedBase is
//   the requested base or, when none is requested, the target's current
//   version (`v0` for an empty target). Its after-effect is the configured
//   kind with a payload the adapter itself can execute later.
// - applyEffect refuses an expectedBase that is not the target's current
//   version (`publication.base_mismatch`), appends exactly one version per
//   new idempotency key, and answers a repeated key with the stored receipt
//   without touching the log; the same key with a different effect is refused.
// - disable/rollback/compensate effects (derived by the kernel from the
//   declared after-effects) append a version that resolves to no content or
//   to the restored content; inspection exposes the whole log.
import { sha256HexOfCanonicalJson } from "../canonical/canonical-json.js";
import type { JsonValue } from "../canonical/json.js";
import { toJsonValue } from "../canonical/to-json-value.js";
import { LearningLoopError } from "../diagnostics.js";
import { invalid, parseNonEmptyText, readFields } from "../parse/toolkit.js";
import type { Clock } from "../ports/clock.js";
import type { PublicationDestination } from "../ports/destination.js";
import type { Candidate } from "../records/candidate.js";
import type { AfterEffectSemantics, PreparedEffect, PublicationReceipt } from "../records/publication.js";
import { parsePreparedEffect, parsePublicationReceipt } from "../records/publication.js";

export interface InMemoryDestinationOptions {
  /** Destination id; default `in-memory-context`. */
  readonly id?: string;
  /** After-effect kind every prepared write declares; default `disable`. */
  readonly afterEffect?: AfterEffectSemantics["kind"];
  /** Target for a candidate; default `<id>/<intervention kind>`. */
  readonly targetFor?: (candidate: Candidate) => string;
  /** Clock for receipt `appliedAt`; default the system clock. */
  readonly clock?: Clock;
}

export interface InMemoryDestinationVersion {
  readonly version: string;
  readonly kind: "write" | "disable" | "rollback" | "compensate";
  readonly effectId: string;
  readonly idempotencyKey: string;
  readonly content: JsonValue | null;
  readonly appliedAt: string;
}

export interface InMemoryDestinationTarget {
  readonly target: string;
  readonly currentVersion: string;
  readonly content: JsonValue | null;
  readonly versions: readonly InMemoryDestinationVersion[];
}

export interface InMemoryDestination extends PublicationDestination {
  /** Call counts; `applied` counts only calls that appended a version. */
  readonly calls: { readonly prepare: number; readonly applyEffect: number; readonly applied: number };
  /** The version log of one target; an unknown target has `v0` and no versions. */
  read(target: string): InMemoryDestinationTarget;
  /** Every receipt this destination minted, in application order. */
  receipts(): readonly PublicationReceipt[];
}

const WRITE_KIND = "context.write";
const EMPTY_VERSION = "v0";

interface TargetState {
  readonly versions: InMemoryDestinationVersion[];
}

function refusal(code: string, message: string): LearningLoopError {
  return new LearningLoopError(code, [{ code, severity: "error", message }]);
}

function currentVersionOf(state: TargetState | undefined): string {
  return state === undefined || state.versions.length === 0 ? EMPTY_VERSION : `v${state.versions.length}`;
}

function currentContentOf(state: TargetState | undefined): JsonValue | null {
  const last = state?.versions[state.versions.length - 1];
  return last === undefined ? null : last.content;
}

function afterEffectFor(
  kind: AfterEffectSemantics["kind"],
  target: string,
  effectId: string,
  restore: JsonValue | null,
): AfterEffectSemantics {
  switch (kind) {
    case "disable":
      return { kind, payload: { disables: { target, effectId } } };
    case "rollback":
      return { kind, payload: { restore } };
    case "compensate":
      return { kind, payload: { compensates: { target, effectId } } };
    case "irreversible":
      return { kind, rationale: "this in-memory destination was configured to declare its writes irreversible" };
  }
}

function parseReference(payload: JsonValue, field: "disables" | "compensates"): { readonly effectId: string } {
  const fields = readFields(payload, ["payload"]);
  const reference = readFields(
    fields.req(field, (value) => value),
    ["payload", field],
  );
  return { effectId: reference.req("effectId", parseNonEmptyText) };
}

export function createInMemoryDestination(options: InMemoryDestinationOptions = {}): InMemoryDestination {
  const id = options.id ?? "in-memory-context";
  const afterEffectKind = options.afterEffect ?? "disable";
  const targetFor = options.targetFor ?? ((candidate: Candidate) => `${id}/${candidate.intervention.kind}`);
  const clock = options.clock ?? { now: () => new Date().toISOString() };
  const targets = new Map<string, TargetState>();
  const receiptsByKey = new Map<string, { readonly effectDigest: string; readonly receipt: PublicationReceipt }>();
  const minted: PublicationReceipt[] = [];
  const calls = { prepare: 0, applyEffect: 0, applied: 0 };

  function stateFor(target: string): TargetState {
    let state = targets.get(target);
    if (state === undefined) {
      state = { versions: [] };
      targets.set(target, state);
    }
    return state;
  }

  function append(
    effect: PreparedEffect,
    idempotencyKey: string,
    kind: InMemoryDestinationVersion["kind"],
    content: JsonValue | null,
  ): PublicationReceipt {
    const state = stateFor(effect.target);
    const appliedAt = clock.now();
    state.versions.push({
      version: `v${state.versions.length + 1}`,
      kind,
      effectId: effect.id,
      idempotencyKey,
      content: content === null ? null : toJsonValue(content),
      appliedAt,
    });
    calls.applied += 1;
    return parsePublicationReceipt({
      destinationId: id,
      effectId: effect.id,
      target: effect.target,
      ...(effect.expectedBase !== undefined ? { expectedBase: effect.expectedBase } : {}),
      finalVersion: currentVersionOf(state),
      payloadDigest: effect.payloadDigest,
      idempotencyKey,
      appliedAt,
    });
  }

  const destination: InMemoryDestination = {
    id,
    calls,
    prepare: (input) => {
      calls.prepare += 1;
      const candidate = input.candidate;
      const target = targetFor(candidate);
      const payload = toJsonValue(candidate.intervention.content);
      const effectId = "write-1";
      const effect = parsePreparedEffect({
        id: effectId,
        kind: WRITE_KIND,
        target,
        expectedBase: input.expectedBase ?? currentVersionOf(targets.get(target)),
        payload,
        payloadDigest: sha256HexOfCanonicalJson(payload),
        afterEffect: afterEffectFor(afterEffectKind, target, effectId, currentContentOf(targets.get(target))),
      });
      return Promise.resolve([effect]);
    },
    applyEffect: (input) => {
      calls.applyEffect += 1;
      const effect = parsePreparedEffect(input.effect);
      const idempotencyKey = parseNonEmptyText(input.idempotencyKey, ["idempotencyKey"]);
      const effectDigest = sha256HexOfCanonicalJson(toJsonValue(effect));
      const known = receiptsByKey.get(idempotencyKey);
      if (known !== undefined) {
        if (known.effectDigest !== effectDigest) {
          return Promise.reject(
            refusal("publication.receipt_mismatch", `idempotency key "${idempotencyKey}" was used for another effect`),
          );
        }
        return Promise.resolve({ ...known.receipt });
      }
      const state = targets.get(effect.target);
      if (effect.expectedBase !== undefined && effect.expectedBase !== currentVersionOf(state)) {
        return Promise.reject(
          refusal(
            "publication.base_mismatch",
            `target "${effect.target}" is at ${currentVersionOf(state)}, not the expected base "${effect.expectedBase}"`,
          ),
        );
      }
      let receipt: PublicationReceipt;
      try {
        if (effect.kind === "disable" || effect.kind === "compensate") {
          const reference = parseReference(effect.payload, effect.kind === "disable" ? "disables" : "compensates");
          if (!(state?.versions.some((version) => version.effectId === reference.effectId) ?? false)) {
            throw refusal(
              "publication.effect_invalid",
              `no applied effect "${reference.effectId}" on "${effect.target}"`,
            );
          }
          receipt = append(effect, idempotencyKey, effect.kind, null);
        } else if (effect.kind === "rollback") {
          const restore = readFields(effect.payload, ["payload"]).req("restore", (value) => toJsonValue(value));
          receipt = append(effect, idempotencyKey, "rollback", restore);
        } else {
          receipt = append(effect, idempotencyKey, "write", effect.payload);
        }
      } catch (error) {
        return Promise.reject(
          error instanceof Error ? error : invalid("publication.effect_invalid", "apply failed", []),
        );
      }
      receiptsByKey.set(idempotencyKey, { effectDigest, receipt });
      minted.push(receipt);
      return Promise.resolve({ ...receipt });
    },
    read: (target) => {
      const state = targets.get(target);
      return {
        target,
        currentVersion: currentVersionOf(state),
        content: currentContentOf(state),
        versions: (state?.versions ?? []).map((version) => ({ ...version })),
      };
    },
    receipts: () => minted.map((receipt) => ({ ...receipt })),
  };
  return destination;
}
