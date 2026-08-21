// Shared fixtures for the Activate records/authority/destination tests
// (decision 0025). Not a test file. Builds a loop with one inert spy
// destination and one scripted authority port on top of the engine harness
// evidence, and exposes store snapshots so tests can prove "no write".
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
import type { FixedClock, ManualEvidenceInput } from "../src/testing/index.js";
import {
  createExactScopePolicy,
  createFixedClock,
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
}

/** A well-formed context effect derived from the candidate's intervention content. */
export function effectFor(candidate: Candidate, overrides: Partial<PreparedEffect> = {}): PreparedEffect {
  const payload = overrides.payload ?? candidate.intervention.content;
  const base: PreparedEffect = {
    id: "effect-1",
    kind: "instruction.write",
    target: `${DESTINATION_ID}/CLAUDE.md`,
    payload,
    payloadDigest: sha256HexOfCanonicalJson(payload),
    afterEffect: { kind: "disable", payload: { disable: "effect-1" } },
  };
  return { ...base, ...overrides };
}

/**
 * Inert destination: `prepare` answers from a script (default: one effect
 * echoing the requested base) and `applyEffect` must never be reached in
 * this slice — it counts the call and rejects.
 */
export function inertDestination(
  options: {
    readonly id?: string;
    readonly prepare?: (input: { readonly candidate: Candidate; readonly expectedBase?: string }) => unknown;
  } = {},
): DestinationSpy {
  const calls = { prepare: 0, applyEffect: 0 };
  const prepareInputs: unknown[] = [];
  const script = options.prepare;
  const adapter: PublicationDestination = {
    id: options.id ?? DESTINATION_ID,
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
    applyEffect: () => {
      calls.applyEffect += 1;
      return Promise.reject(new Error("applyEffect must never be called by the records/authority slice"));
    },
  };
  return { adapter, calls, prepareInputs };
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
      for (const namespace of ["learning", scopeNamespace]) {
        const page = await store.list({ namespace, limit: 10_000 });
        for (const record of page.records) listing.push([record.key.kind, record.key.id, record.digest]);
      }
      return JSON.stringify(listing);
    },
  };
}

export { CONTENT_POLICY_ID, SCOPE, candidateInput, reviewerFor };
