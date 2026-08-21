// Shared fixtures for the Activate tests (decisions 0025 and 0026). Not a
// test file. Builds a loop with one spy destination (scripted `prepare`,
// `applyEffect` delegated to an inert in-memory destination unless scripted)
// and one scripted authority port on top of the engine harness evidence, and
// exposes store snapshots so tests can prove "no write".
import type {
  AuthorityPort,
  AuthorizationBinding,
  Candidate,
  ContentPolicy,
  DestinationRegistration,
  IdentityPort,
  LearningLoop,
  LearningStore,
  PreparedEffect,
  PublicationDestination,
  PublicationOutcome,
  PublicationReceipt,
  RegisteredSource,
  VerifiedPrincipal,
} from "../src/index.js";
import {
  authorizationBindingDigest,
  conservativePolicy,
  createAuthorityPort,
  createLearningLoop,
  defineSourceRegistration,
  scopeDigest,
  sha256HexOfCanonicalJson,
} from "../src/index.js";
import type { FixedClock, InMemoryDestination, ManualEvidenceInput } from "../src/testing/index.js";
import {
  createExactScopePolicy,
  createFixedClock,
  createInMemoryDestination,
  createInMemoryStore,
  createManualEvidenceSource,
  createSequentialIds,
  createStructuredContentPolicy,
  createTestIdentityPort,
} from "../src/testing/index.js";
import { CONTENT_POLICY_ID, SCOPE, candidateInput, journeyEvidence, reviewerFor } from "./engine-harness.js";

export const DESTINATION_ID = "agent-instructions";
export const NOW = "2026-08-16T10:00:00.000Z";
export const AUTHORIZED_AT = "2026-08-16T09:59:00.000Z";
export const EXPIRES_AT = "2026-08-17T00:00:00.000Z";
export const AUTHORITY_CONFIGURATION_DIGEST = "2".repeat(64);
export const APPROVER_ATTESTATION_DIGEST = "b".repeat(64);

export interface DestinationSpy {
  readonly adapter: PublicationDestination;
  readonly calls: { prepare: number; applyEffect: number };
  readonly prepareInputs: unknown[];
  readonly applyInputs: { readonly effect: PreparedEffect; readonly idempotencyKey: string }[];
  /** The inert in-memory destination that backs `applyEffect` unless it was scripted. */
  readonly memory: InMemoryDestination;
}

/** A well-formed context effect derived from the candidate's intervention content. */
export function effectFor(candidate: Candidate, overrides: Partial<PreparedEffect> = {}): PreparedEffect {
  const payload = overrides.payload ?? candidate.intervention.content;
  const id = overrides.id ?? "effect-1";
  const target = overrides.target ?? `${DESTINATION_ID}/CLAUDE.md`;
  const base: PreparedEffect = {
    id,
    kind: "instruction.write",
    target,
    payload,
    payloadDigest: sha256HexOfCanonicalJson(payload),
    // The in-memory destination executes this declared payload on disable.
    afterEffect: { kind: "disable", payload: { disables: { target, effectId: id } } },
  };
  return { ...base, ...overrides };
}

/**
 * Spy destination: `prepare` answers from a script (default: one effect
 * echoing the requested base, with no base when none was requested) and
 * `applyEffect` counts the call, records its input, and delegates to an inert
 * in-memory destination unless `applyEffect` is scripted. Refusal tests
 * assert the count stays zero.
 */
export function inertDestination(
  options: {
    readonly id?: string;
    readonly prepare?: (input: { readonly candidate: Candidate; readonly expectedBase?: string }) => unknown;
    readonly applyEffect?: (input: { readonly effect: PreparedEffect; readonly idempotencyKey: string }) => unknown;
    readonly clock?: FixedClock;
  } = {},
): DestinationSpy {
  const calls = { prepare: 0, applyEffect: 0 };
  const prepareInputs: unknown[] = [];
  const applyInputs: { readonly effect: PreparedEffect; readonly idempotencyKey: string }[] = [];
  const script = options.prepare;
  const applyScript = options.applyEffect;
  const id = options.id ?? DESTINATION_ID;
  const memory = createInMemoryDestination({ id, clock: options.clock ?? createFixedClock(NOW) });
  const adapter: PublicationDestination = {
    id,
    prepare: (input) => {
      calls.prepare += 1;
      prepareInputs.push(input);
      const effects: unknown =
        script !== undefined
          ? script(input)
          : [effectFor(input.candidate, input.expectedBase !== undefined ? { expectedBase: input.expectedBase } : {})];
      // Adapters can lie about their types; the engine must re-validate. The
      // cast lives in test code only.
      return Promise.resolve(effects as readonly PreparedEffect[]);
    },
    applyEffect: async (input) => {
      calls.applyEffect += 1;
      applyInputs.push(input);
      if (applyScript !== undefined) {
        const receipt: unknown = await applyScript(input);
        return receipt as PublicationReceipt;
      }
      // The spy accepts whatever base the test bound (the in-memory
      // destination's own base discipline is exercised in its own tests) and
      // echoes that base in the receipt, as the kernel requires.
      const { expectedBase, ...unbased } = input.effect;
      const receipt = await memory.applyEffect({ effect: unbased, idempotencyKey: input.idempotencyKey });
      return expectedBase === undefined ? receipt : { ...receipt, expectedBase };
    },
  };
  return { adapter, calls, prepareInputs, applyInputs, memory };
}

export function registrationFor(
  destination: DestinationSpy,
  overrides: Partial<Omit<DestinationRegistration, "adapter">> = {},
): DestinationRegistration {
  return {
    adapter: destination.adapter,
    effectClass: "context",
    riskFloor: "T1",
    permittedTargetPatterns: [`${DESTINATION_ID}/*`],
    authorizationRuleId: "host-approval-v1",
    contentPolicyId: CONTENT_POLICY_ID,
    ...overrides,
  };
}

export interface AuthorityScriptInput {
  readonly evidence: unknown;
  readonly binding: AuthorizationBinding;
}

interface EvidenceShape {
  readonly decision?: string;
  readonly bindingDigest?: string;
  readonly expiresAt?: string | null;
  readonly principalId?: string;
}

function asEvidenceShape(input: unknown): EvidenceShape {
  return typeof input === "object" && input !== null ? (input as EvidenceShape) : {};
}

/**
 * Evidence-driven host authority: `{ decision }` selects the status; an
 * authorized decision binds the exact verified binding unless the evidence
 * names another `bindingDigest` (the wrong-base case).
 */
export function defaultAuthorityScript(input: AuthorityScriptInput): unknown {
  const evidence = asEvidenceShape(input.evidence);
  const decision = evidence.decision ?? "authorized";
  if (decision !== "authorized") {
    return {
      status: decision,
      diagnostics: [{ code: `host.${decision}`, severity: "error", message: `host approval is ${decision}` }],
    };
  }
  const expiresAt = evidence.expiresAt === undefined ? EXPIRES_AT : evidence.expiresAt;
  return {
    status: "authorized",
    authorization: {
      id: "approval-1",
      principal: { id: evidence.principalId ?? "approver-h", kind: "human", independenceDomain: "ops" },
      principalAttestationDigest: APPROVER_ATTESTATION_DIGEST,
      bindingDigest: evidence.bindingDigest ?? authorizationBindingDigest(input.binding),
      authorizedAt: AUTHORIZED_AT,
      ...(expiresAt === null ? {} : { expiresAt }),
    },
  };
}

export interface AuthoritySpy {
  readonly port: AuthorityPort;
  readonly calls: AuthorityScriptInput[];
}

export function scriptedAuthority(
  script: (input: AuthorityScriptInput) => unknown = defaultAuthorityScript,
  registration: { readonly id?: string; readonly version?: string; readonly configurationDigest?: string } = {},
): AuthoritySpy {
  const calls: AuthorityScriptInput[] = [];
  const port = createAuthorityPort({
    id: registration.id ?? "authority.harness",
    version: registration.version ?? "1.0.0",
    configurationDigest: registration.configurationDigest ?? AUTHORITY_CONFIGURATION_DIGEST,
    verify: (input) => {
      calls.push(input);
      return Promise.resolve(script(input));
    },
  });
  return { port, calls };
}

export interface PublicationHarness {
  readonly store: LearningStore;
  readonly learning: LearningLoop;
  readonly identities: IdentityPort;
  readonly manual: RegisteredSource<ManualEvidenceInput>;
  readonly proposer: VerifiedPrincipal;
  readonly reviewerB: VerifiedPrincipal;
  readonly reviewerSameDomain: VerifiedPrincipal;
  readonly destination: DestinationSpy;
  readonly authority: AuthoritySpy | undefined;
  readonly clock: FixedClock;
  readonly registrations: readonly DestinationRegistration[];
  /** Proposes the harness candidate and has reviewerB accept it. */
  acceptedCandidate(overrides?: Parameters<typeof candidateInput>[1]): Promise<Candidate>;
  /** Canonical listing of every engine-owned record (all namespaces the tests can reach). */
  storeSnapshot(): Promise<string>;
}

export interface PublicationHarnessOptions {
  readonly store?: LearningStore;
  readonly destination?: DestinationSpy;
  readonly registration?: Partial<Omit<DestinationRegistration, "adapter">>;
  /** Extra registrations beyond the primary destination. */
  readonly extraRegistrations?: readonly DestinationRegistration[];
  /** `null` configures no authority port. */
  readonly authority?: AuthoritySpy | null;
  readonly identity?: IdentityPort;
  readonly omitDestinations?: boolean;
  /** Additional content policies a destination registration may name. */
  readonly extraContentPolicies?: readonly ContentPolicy[];
}

export async function createPublicationHarness(options: PublicationHarnessOptions = {}): Promise<PublicationHarness> {
  const identities = options.identity ?? createTestIdentityPort();
  const proposer = await identities.verify({
    principalId: "distiller-a",
    kind: "agent",
    independenceDomain: "provider-a",
  });
  const reviewerB = await identities.verify({
    principalId: "reviewer-b",
    kind: "agent",
    independenceDomain: "provider-b",
  });
  const reviewerSameDomain = await identities.verify({
    principalId: "reviewer-a2",
    kind: "agent",
    independenceDomain: "provider-a",
  });
  const manual = defineSourceRegistration({
    source: createManualEvidenceSource(),
    trustCeiling: "observed",
    contentPolicyId: CONTENT_POLICY_ID,
  });
  const store = options.store ?? createInMemoryStore();
  const destination = options.destination ?? inertDestination();
  const registrations = [registrationFor(destination, options.registration), ...(options.extraRegistrations ?? [])];
  const authority = options.authority === null ? undefined : (options.authority ?? scriptedAuthority());
  const clock = createFixedClock(NOW);
  const learning = createLearningLoop({
    store,
    policy: conservativePolicy(),
    identity: identities,
    scopePolicy: createExactScopePolicy(),
    contentPolicies: [
      createStructuredContentPolicy({ id: CONTENT_POLICY_ID }),
      ...(options.extraContentPolicies ?? []),
    ],
    sources: [manual],
    ...(options.omitDestinations === true ? {} : { destinations: registrations }),
    ...(authority === undefined ? {} : { authority: authority.port }),
    clock,
    ids: createSequentialIds("t"),
  });
  await learning.ingest(manual, journeyEvidence());
  const scopeNamespace = `learning-candidate-scope-${scopeDigest(SCOPE)}`;
  const interventionNamespace = `learning-intervention-scope-${scopeDigest(SCOPE)}`;
  return {
    store,
    learning,
    identities,
    manual,
    proposer,
    reviewerB,
    reviewerSameDomain,
    destination,
    authority,
    clock,
    registrations,
    acceptedCandidate: async (overrides = {}) => {
      const { candidate } = await learning.propose(candidateInput(proposer, overrides));
      await learning.reviewCandidate({
        id: `review-${candidate.id}`,
        candidateId: candidate.id,
        reviewer: reviewerFor(reviewerB),
      });
      return candidate;
    },
    storeSnapshot: async () => {
      const listing: unknown[] = [];
      for (const namespace of ["learning", scopeNamespace, interventionNamespace]) {
        const page = await store.list({ namespace, limit: 10_000 });
        for (const record of page.records) listing.push([record.key.kind, record.key.id, record.digest]);
      }
      return JSON.stringify(listing);
    },
  };
}

export { CONTENT_POLICY_ID, SCOPE, candidateInput, reviewerFor };

export interface StoreFault {
  readonly operation: "create" | "append";
  /** Record kind of the write to fault (`key.kind`), in any namespace. */
  readonly kind: string;
  /** 1-based occurrence of that write after arming; default the first. */
  readonly occurrence?: number;
  /** `before` throws instead of writing; `after` writes and then throws (a lost acknowledgement). */
  readonly when: "before" | "after";
}

export interface FaultedStore {
  readonly store: LearningStore;
  readonly fired: () => boolean;
  /** Starts counting occurrences; faults created with `armed: false` ignore writes until armed. */
  readonly arm: () => void;
}

/** Wraps a store so exactly one write crashes, before or after it lands. */
export function faultStore(
  base: LearningStore,
  fault: StoreFault,
  options: { readonly armed?: boolean } = {},
): FaultedStore {
  let armed = options.armed ?? true;
  let seen = 0;
  let fired = false;
  const target = fault.occurrence ?? 1;
  async function guard<T>(operation: StoreFault["operation"], kind: string, run: () => Promise<T>): Promise<T> {
    if (fired || !armed || operation !== fault.operation || kind !== fault.kind) return run();
    seen += 1;
    if (seen !== target) return run();
    fired = true;
    if (fault.when === "before") throw new Error(`injected crash before ${operation} ${kind} #${seen}`);
    await run();
    throw new Error(`injected crash after ${operation} ${kind} #${seen}`);
  }
  return {
    store: {
      get: (key) => base.get(key),
      create: (key, value, digest, operationId) =>
        guard("create", key.kind, () => base.create(key, value, digest, operationId)),
      compareAndSet: (key, expectedRevision, value, digest, operationId) =>
        base.compareAndSet(key, expectedRevision, value, digest, operationId),
      append: (stream, expectedRevision, entries, operationId) =>
        guard("append", stream.kind, () => base.append(stream, expectedRevision, entries, operationId)),
      tombstone: (input) => base.tombstone(input),
      list: (query) => base.list(query),
    },
    fired: () => fired,
    arm: () => {
      armed = true;
    },
  };
}

export const JOURNAL_KINDS = [
  "publication-authorization",
  "intervention",
  "intervention-transition",
  "publication-receipt",
] as const;

/** Sorted listing of every journal record (learning namespace kinds plus the scope membership index). */
export async function journalSnapshot(store: LearningStore): Promise<string> {
  const listing: string[] = [];
  for (const kind of JOURNAL_KINDS) {
    const page = await store.list({ namespace: "learning", kind, limit: 10_000 });
    for (const record of page.records) listing.push(JSON.stringify([kind, record.key.id, record.digest]));
  }
  const scoped = await store.list({ namespace: `learning-intervention-scope-${scopeDigest(SCOPE)}`, limit: 10_000 });
  for (const record of scoped.records) listing.push(JSON.stringify([record.key.kind, record.key.id, record.digest]));
  return JSON.stringify(listing.sort());
}

/** Narrows a completion outcome or throws with the refusal diagnostics. */
export function completed(
  outcome: PublicationOutcome,
): Extract<PublicationOutcome, { readonly intervention: unknown }> {
  if ("intervention" in outcome) return outcome;
  throw new Error(`publish returned ${outcome.status}: ${JSON.stringify(outcome.diagnostics)}`);
}

/** Narrows a refusal outcome or throws. */
export function refused(outcome: PublicationOutcome): Extract<PublicationOutcome, { readonly diagnostics: unknown }> {
  if ("diagnostics" in outcome) return outcome;
  throw new Error(`publish returned ${outcome.status} instead of a refusal`);
}
