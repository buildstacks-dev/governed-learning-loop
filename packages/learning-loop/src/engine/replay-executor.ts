// Kernel-owned ReplayExecutor factory and exact runtime binding (decision
// 0028), following the identity-port and authority-port discipline of
// decisions 0003 and 0025. Stable registration metadata `{ id, version,
// configurationDigest }` digests to the registration digest an
// ExperimentDefinition freezes as `replayExecutorDigest`; a private token per
// factory call is the non-serializable proof that an executor object was
// minted here. The host's `attempt` callback is captured at definition time
// so later mutation of the caller's object cannot change what runs, and its
// result crosses the boundary as `unknown` for the engine to parse.
import { sha256HexOfCanonicalJson } from "../canonical/canonical-json.js";
import { invalid, readFields } from "../parse/toolkit.js";
import { replayExecutorBrand } from "../records/brands.js";
import type { ReplayAttemptRequest, ReplayExecutor } from "../records/replay.js";
import { parseExecutorRegistrationText } from "../records/replay.js";
import { parseDigestAt } from "../records/semantic-shared.js";

export interface ReplayExecutorRegistration {
  readonly id: string;
  readonly version: string;
  readonly configurationDigest: string;
  readonly registrationDigest: string;
}

interface PrivateRegistration extends ReplayExecutorRegistration {
  readonly token: object;
}

const executorRegistrations = new WeakMap<ReplayExecutor, PrivateRegistration>();

/** Registration digest over the exact host-owned metadata; adapter behavior is excluded. */
export function replayExecutorRegistrationDigest(input: {
  readonly id: string;
  readonly version: string;
  readonly configurationDigest: string;
}): string {
  return sha256HexOfCanonicalJson({
    id: input.id,
    version: input.version,
    configurationDigest: input.configurationDigest,
  });
}

export function defineReplayExecutor(input: {
  readonly id: string;
  readonly version: string;
  readonly configurationDigest: string;
  readonly attempt: (input: ReplayAttemptRequest) => Promise<unknown>;
}): ReplayExecutor {
  const fields = readFields(input, ["replayExecutor"]);
  const id = fields.req("id", parseExecutorRegistrationText);
  const version = fields.req("version", parseExecutorRegistrationText);
  const configurationDigest = fields.req("configurationDigest", parseDigestAt);
  const attempt = input.attempt;
  if (typeof attempt !== "function") {
    throw invalid("schema.invalid", "replay executor attempt must be a function", ["replayExecutor", "attempt"]);
  }
  const registrationDigest = replayExecutorRegistrationDigest({ id, version, configurationDigest });
  const registration: PrivateRegistration = Object.freeze({
    id,
    version,
    configurationDigest,
    registrationDigest,
    token: Object.freeze({}),
  });
  const executor: ReplayExecutor = {
    id,
    version,
    registrationDigest,
    attempt: (request) => attempt(request),
    [replayExecutorBrand]: true,
  };
  const frozen = Object.freeze(executor);
  executorRegistrations.set(frozen, registration);
  return frozen;
}

/** The exact registration of a factory-minted executor; a structural lookalike is refused. */
export function replayExecutorRegistryProjection(
  executor: ReplayExecutor,
  path: readonly (string | number)[] = ["replayExecutors"],
): ReplayExecutorRegistration {
  const unknownExecutor: unknown = executor;
  if (typeof unknownExecutor !== "object" || unknownExecutor === null) {
    throw invalid("config.invalid", "replay executor must be an object", path);
  }
  const registration = executorRegistrations.get(executor);
  if (registration === undefined) {
    throw invalid("config.invalid", "replay executor was not created by defineReplayExecutor", path);
  }
  if (
    executor.id !== registration.id ||
    executor.version !== registration.version ||
    executor.registrationDigest !== registration.registrationDigest
  ) {
    throw invalid("config.invalid", "replay executor metadata does not match its kernel registration", path);
  }
  return {
    id: registration.id,
    version: registration.version,
    configurationDigest: registration.configurationDigest,
    registrationDigest: registration.registrationDigest,
  };
}
