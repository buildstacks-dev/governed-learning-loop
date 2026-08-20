<!-- Provenance: adopted verbatim from Cormidia research/2026-08-12_learning-loop-library/api-contract.md (source snapshot 242b12acf5e733dec9fbbeeedf4d47588c22da91). This copy is the ratified contract for this repository; amend by exact diff with a decision record in docs/decisions/. -->
# Public Contract for a TypeScript Learning Loop

**Date:** 2026-08-12  
**Status:** ratified public contract; versioned records include Candidate 2 and EvidenceRef 2
**Working import:** `@cormidia/learning-loop` — provisional

## The developer experience to optimize

A TypeScript developer should be able to add governed learning to an existing agent without adopting Cormidia, changing model provider, or replacing storage. The smallest useful integration is:

1. identify one completed unit of work;
2. record provenance-bearing observations and an outcome;
3. create or generate an inert candidate;
4. record an independent review; and
5. inspect why the candidate is eligible, blocked, or rejected.

Activation and causal evaluation are additional capabilities, not prerequisites for that first value.

The intended first impression is below. The excerpts form one proposed consumer journey; later excerpts reuse setup from the first and name host-owned integrations such as `runAgent` and `hostApprovalWorkflow`. Before this contract is ratified, the journey must be converted into one packaged strict-TypeScript consumer fixture whose companion setup defines every host integration and which compiles without casts, deep imports, or undeclared helper types.

```ts
import {
  conservativePolicy,
  createLearningLoop,
  defineSourceRegistration,
} from "@cormidia/learning-loop";
import {
  createInMemoryStore,
  createManualEvidenceSource,
  createExactScopePolicy,
  createStructuredContentPolicy,
  createTestIdentityPort,
} from "@cormidia/learning-loop/testing";

const identities = createTestIdentityPort();
const proposer = await identities.verify({
  principalId: "distiller-a",
  kind: "agent",
  independenceDomain: "provider-a",
});

const localRunner = defineSourceRegistration({
  source: createManualEvidenceSource(),
  trustCeiling: "observed",
  contentPolicyId: "structured-local-events-v1",
});

const structuredContent = createStructuredContentPolicy({
  id: "structured-local-events-v1",
});

const learning = createLearningLoop({
  store: createInMemoryStore(),
  policy: conservativePolicy(),
  identity: identities,
  scopePolicy: createExactScopePolicy(),
  contentPolicies: [structuredContent],
  sources: [localRunner],
});

await learning.ingest(localRunner, {
  observations: [{
    id: "obs-42-typecheck",
    episodeId: "change-42",
    occurredAt: "2026-08-12T16:11:00.000Z",
    kind: "tool.process.completed",
    data: { commandClass: "typecheck", exitCode: 1 },
  }],
  measurements: [{
    id: "measure-42-typecheck",
    episodeId: "change-42",
    metric: {
      name: "typecheck",
      valueType: "boolean",
      unit: "pass",
      aggregation: "all",
    },
    value: false,
    evidenceIds: ["obs-42-typecheck"],
  }],
  episodes: [{
    id: "change-42",
    scope: [
      { type: "project", id: "acme-api" },
      { type: "agent", id: "coding-agent" },
    ],
    openedAt: "2026-08-12T16:00:00.000Z",
    closedAt: "2026-08-12T16:12:00.000Z",
    outcome: {
      status: "failed",
      measurementIds: ["measure-42-typecheck"],
    },
  }],
});

const proposal = await learning.propose({
  id: "candidate-typecheck-before-complete",
  scope: [
    { type: "project", id: "acme-api" },
    { type: "agent", id: "coding-agent" },
  ],
  problem: "TypeScript changes are reported complete before type checking.",
  hypothesis: "A completion preflight will catch unresolved type errors.",
  evidenceIds: ["manual-evidence/obs-42-typecheck"],
  intervention: {
    destinationId: "agent-instructions",
    kind: "procedure",
    content: {
      text: "Before reporting a TypeScript code change complete, run the repository type-check command and resolve failures.",
    },
    rollbackIntent: "Disable this instruction version.",
  },
  proposedRisk: "T1",
  proposedBy: proposer,
});

const candidate = proposal.candidate;
console.log(proposal.governance);
// { review: "required", publication: "blocked", validation: "untested" }
```

No model call, filesystem convention, vector database, or agent framework is implicit in this example. The host can add each through a port.

## Design principles for the surface

The public API should be intentionally smaller than the current Cormidia module exports.

1. **Records are public; orchestration internals are not.** Users need stable inputs, outputs, ports, validators, error codes, and lifecycle queries. They do not need every fold helper or storage function.
2. **The deterministic kernel is the authority on state.** Model-mediated workflows may propose structured output, but only the kernel validates and records transitions.
3. **Ports describe ownership.** A port exists where the host owns truth or effects: evidence, identity and authority, storage, semantic judgment, publication, replay, outcomes, or time.
4. **Adapters cannot self-certify trust.** The host registers a source with a maximum trust class. The engine stamps the effective class on accepted observations.
5. **The root package has no provider dependency.** OpenAI, Anthropic, Google, xAI, Cursor, and other integrations belong in host or companion adapters.
6. **Runtime validation and TypeScript types have one source.** Every public record has a `schemaVersion`, an `unknown` parser, and an exported inferred type.
7. **One façade covers the ordinary path.** Lower-level pure functions may be exported only when they are independently useful and have stable semantics.

## Package shape

Start with one package and subpath exports:

```text
@cormidia/learning-loop
├── .             domain records, validators, policy, engine, ports
├── node          JSON Lines/filesystem store and journal adapters
├── testing       in-memory stores, deterministic fixtures, conformance suites
└── workflows     optional distiller and reviewer workflows
```

Recommended packaging properties:

- strict TypeScript;
- ECMAScript modules first, with CommonJS support added only if adopter evidence justifies the cost;
- an explicit `exports` map with no supported deep imports;
- generated `.d.ts`, declaration maps, source maps, and API documentation;
- no model-provider software development kits in the core dependency tree;
- zero core runtime dependencies if runtime validation and canonicalization remain maintainable, otherwise one small audited dependency chosen explicitly;
- `sideEffects: false` for the deterministic root where accurate;
- a tested Node support range chosen from maintained releases at publication time, rather than inheriting Cormidia's Node 26 floor accidentally;
- browser-compatible pure records and decisions where possible, with filesystem behavior confined to `/node`.

Transcript adapters should begin outside the root export. Provider formats have a different release cadence and privacy risk from the governed-learning protocol.

## Core vocabulary and records

### JSON values

Adapter-defined content must remain serializable, canonicalizable, and safe to inspect.

```ts
export type JsonPrimitive = null | boolean | number | string;

export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };
```

Numbers must be finite. Objects with prototypes, functions, symbols, binary buffers, dates, maps, sets, and cyclic values are rejected unless an adapter encodes them into an explicit versioned JSON representation.

### Canonical bytes and digests

Protocol canonicalization uses JSON Canonicalization Scheme
semantics—deterministic object-key ordering and ECMAScript JSON number
serialization—encoded as UTF-8 without a byte-order mark, followed by SHA-256
and lower-case hexadecimal rendering. Every record schema that binds content
must pin its field set and ship cross-runtime golden vectors before
implementation is accepted.

Each bound record has a field-inclusion table. Unknown or display-only fields
never enter a digest accidentally. Where an explicit record-family decision
allows migration, it preserves the original digest as lineage and computes a
new digest for changed canonical bytes; an old digest never authenticates
changed content. Raw transcript text, secrets and other low-entropy sensitive
bytes do not enter a public digest. Private source correlation uses a
tenant-scoped keyed locator and remains outside portable authorization
bindings.

### Scope

A scope is an ordered hierarchy of host-defined segments, not a filesystem path and not a Cormidia-only `org/app/role` enum.

```ts
export interface ScopeSegment {
  readonly type: string;
  readonly id: string;
}

export type Scope = readonly ScopeSegment[];

export declare function scopeDigest(scope: Scope): string;

export interface ScopePolicy {
  readonly id: string;
  readonly digest: string;
  readonly isolationSegmentTypes: readonly string[];

  validate(input: unknown): Scope;
  ancestors(scope: Scope): readonly Scope[];
  comparePrecedence(left: Scope, right: Scope): -1 | 0 | 1;
}
```

Examples:

```ts
const projectAgentScope: Scope = [
  { type: "tenant", id: "acme" },
  { type: "project", id: "support" },
  { type: "agent", id: "triage" },
];

const cormidiaAppRoleScope: Scope = [
  { type: "org", id: "cormidia" },
  { type: "app", id: "cormidia-web" },
  { type: "role", id: "reviewer" },
];
```

`scopeDigest` is the lower-case SHA-256 digest of protocol-canonical JSON for
the exact ordered `{ type, id }` segment array. Exact match is the safe default.
Unknown segment types never inherit, and no policy may infer an ancestor across
a tenant isolation boundary. A content-bound `ScopePolicy` validates segment
type, identifier length and Unicode form; canonicalizes order; declares
isolation boundaries, permitted ancestors and precedence; and is bound into
plans, resolutions and fingerprints. Changing that policy creates a new
registry revision and cannot reinterpret an old exposure silently.

### Principal and independence

```ts
export interface PrincipalRef {
  readonly id: string;
  readonly kind: "human" | "agent" | "service";
  readonly independenceDomain: string;
}

declare const verifiedPrincipalBrand: unique symbol;
declare const identityPortBrand: unique symbol;

export interface VerifiedPrincipal {
  readonly ref: PrincipalRef;
  readonly attestationId: string;
  readonly attestationDigest: string;
  readonly [verifiedPrincipalBrand]: true;
}

export interface IdentityPort {
  readonly id: string;
  readonly version: string;
  readonly configurationDigest: string;
  readonly registrationDigest: string;
  readonly [identityPortBrand]: true;

  verify(evidence: unknown): Promise<VerifiedPrincipal>;
}

export declare function createIdentityPort(input: {
  readonly id: string;
  readonly version: string;
  readonly configurationDigest: string;
  readonly verify: (evidence: unknown) => Promise<unknown>;
}): IdentityPort;
```

`PrincipalRef` is the serializable projection, not authentication evidence. A host implements the authentication boundary passed to `createIdentityPort`; the kernel parses its opaque result into a fresh `{ ref, attestationId, attestationDigest }` value, freezes the parsed fields, and alone attaches the private `VerifiedPrincipal` brand. Identity-port `id` and `version` values are non-empty, control-free, and at most 200 characters. Factory-minted principal ids, independence domains, and attestation ids are non-empty, control-free, and at most 1,000 characters. `configurationDigest` and every returned `attestationDigest` are 64-character lower-case hexadecimal digests. The host computes `configurationDigest` over its exact verification policy and configuration; the kernel never receives or hashes raw private identity configuration. Low-entropy private configuration requires a tenant-scoped keyed digest rather than a portable unsalted digest.

The identity registration digest is the protocol SHA-256 digest of canonical JSON containing exactly `{ id, version, configurationDigest }`. The `id`, `version`, and `configurationDigest` fields are included; `registrationDigest`, the verifier function, and private runtime tokens are excluded. Equal registration inputs therefore have equal registration digests, but equality of those public bytes is not an authority capability. Each factory call creates a distinct process-local runtime token retained in a private weak association. A verified handle is accepted only by a loop configured with the exact `IdentityPort` instance that minted it; a handle from another instance is foreign even when both instances declare identical registration bytes. JavaScript-shaped lookalikes and handles from `/testing` or another loop are rejected. Handles are process-local and must be re-verified after restart; neither the brand nor the private binding is serializable.

Candidate and review requests accept the loop-bound verified handle; the engine records its `PrincipalRef` projection and attestation digest. Model output or ordinary caller data cannot choose an identity or independence domain. The kernel proves verified-handle non-equality; provider family, model, process and organizational independence remain stronger host policies.

### Source provenance and trust

```ts
export type TrustClass =
  | "untrusted"
  | "advisory"
  | "observed"
  | "verified";

export interface SourceDescriptor {
  readonly id: string;
  readonly adapterVersion: string;
  readonly maximumTrust?: TrustClass;
}

export interface ContentPolicy {
  readonly id: string;
  readonly digest: string;
  readonly maximumInputBytes: number;
  readonly outboundUse: "forbidden" | "explicit_receipt_required";

  transform(input: unknown): Promise<{
    readonly accepted: JsonValue;
    readonly classification: string;
    readonly diagnostics: readonly Diagnostic[];
  }>;
}

export interface Provenance {
  readonly sourceId: string;
  readonly adapterVersion: string;
  readonly sourceRef: string;
  readonly sourceRevision: string;
  readonly recordRef?: string;
  readonly contentDigest: string;
  readonly completeness: "complete" | "partial" | "unknown";
  readonly trust: TrustClass;
}
```

Trust classes mean:

- `untrusted`: inert imported content; useful for discovery but never an outcome metric;
- `advisory`: an attributed correction, label, or heuristic; may support a candidate but not causal proof alone;
- `observed`: a host- or tool-observed event eligible for specified operational metrics;
- `verified`: independent evidence eligible for correctness or safety guardrails under host policy.

This is an upper-bound model. A “verified” source with the wrong metric or a stale revision is still invalid for the claim at hand.

Trust and content policy belong to immutable host registration, not an adapter
claim. `SourceDescriptor.maximumTrust` is only a self-restriction: the host may
register a lower ceiling, but registration rejects a requested ceiling above
that maximum, and the field can never grant trust. Transcript sources declare
a hard advisory maximum. A provider-native tool exit may support discovery,
but only a separately authenticated human or deterministic verifier
observation can raise the trust of a claim.

### Observation

```ts
export interface Observation {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly episodeId: string;
  readonly occurredAt?: string;
  readonly kind: string;
  readonly provenance: Provenance;
  readonly data: JsonValue;
}
```

Core observation kinds use a reserved namespace such as `episode.*`, `tool.*`, `outcome.*`, `review.*`, and `human.*`. Adapters may use their own namespaced kinds. Unknown kinds are retained and surfaced; they do not silently become trusted or metric-bearing.

### Episode

```ts
export interface MetricDefinition {
  readonly name: string;
  readonly valueType: "number" | "string" | "boolean";
  readonly unit: string;
  readonly aggregation: "all" | "any" | "mean" | "median" | "sum";
  readonly comparabilityPolicyDigest?: string;
}

export interface MeasurementRecord {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly episodeId: string;
  readonly metric: MetricDefinition;
  readonly value: number | string | boolean;
  readonly evidenceIds: readonly string[];
  readonly measuredAt?: string;
  readonly provenance: Provenance;
}

export interface EpisodeOutcome {
  readonly status: "succeeded" | "failed" | "cancelled" | "unknown";
  readonly measurementIds: readonly string[];
}

export interface EpisodeRecord {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly scope: Scope;
  readonly openedAt: string;
  readonly closedAt?: string;
  readonly sourceRefs: readonly string[];
  readonly outcome?: EpisodeOutcome;
  readonly fingerprintId?: string;
  readonly exposureIds: readonly string[];
}
```

The engine-private append stream stores exact outcome attempts as:

```ts
interface EpisodeOutcomeClaim {
  readonly schemaVersion: 1;
  readonly episodeRecordId: string;
  readonly sourceId: string;
  readonly sourceRegistrationRevision: string;
  readonly sourceRef: string;
  readonly sourceRevision: string;
  readonly episodeId: string;
  readonly status: EpisodeOutcome["status"];
  readonly measurementRefs: readonly MeasurementEvidenceRefV2[];
  readonly claimDigest: string;
}
```

`claimDigest` binds every field except `schemaVersion` and `claimDigest`.
Claims are appended under the exact episode record id with deterministic entry
ids; identical retries are idempotent and every distinct attempt remains in
order. Each measurement reference must belong to the claim's exact source,
registration, source revision, and episode. The latest valid claim is the
current folded outcome, while earlier claim digests remain retained history.
This record and its append primitive are engine-private; normal ingest is the
only façade transition that may create one.

Open or low-confidence transcript sessions may be indexed, but they cannot enter efficacy evaluation until an episode boundary is confirmed. Late outcomes append evidence and produce a new folded view; they do not rewrite the original events.

`parseMeasurementRecord` validates from `unknown` and requires the runtime
scalar type of `value` to equal `metric.valueType` exactly after finite-number
parsing. It never coerces a string to a number, a number to a boolean, or a
missing value to zero. Durable source-page receipts still do not prove cited
observation, episode, or outcome ownership by themselves; that qualification
is carried by schema-version-2 measurement references and append-only outcome
claims below.

### Registered semantic learning

```ts
export type DetectorMaturity =
  | "experimental"
  | "calibrated"
  | "stable"
  | "deprecated";

export type DetectorOutputKind =
  | "evidence_health"
  | "insight_derivation";

export type LearningClass =
  | "mechanical_execution"
  | "human_agent_interaction"
  | "role_craft"
  | "system_meta"
  | `host:${string}`;

interface DetectorRef {
  readonly id: string;
  readonly version: string;
  readonly registrationDigest: string;
}

interface PackRef {
  readonly id: string;
  readonly version: string;
  readonly manifestDigest: string;
}

interface LensRef {
  readonly id: string;
  readonly version: string;
  readonly registrationDigest: string;
}

interface SemanticJsonObject {
  readonly [key: string]: JsonValue;
}

export interface DetectorRegistration {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly version: string;
  readonly maturity: DetectorMaturity;
  readonly implementationDigest: string;

  readonly configuration: SemanticJsonObject;
  readonly configurationDigest: string;
  readonly thresholds: SemanticJsonObject | null;
  readonly thresholdDigest: string | null;
  readonly observationVocabularyDigest: string;

  readonly requiredCapabilities: readonly string[];
  readonly acceptedObservationKinds: readonly string[];
  readonly minimumTrust: TrustClass;
  readonly minimumCompleteness: Provenance["completeness"];

  readonly episodeClasses:
    | { readonly mode: "any" }
    | { readonly mode: "include"; readonly values: readonly string[] };

  readonly scopePolicyDigest: string;
  readonly scopeConstraint:
    | { readonly mode: "invocation" }
    | {
        readonly mode: "exact";
        readonly scopes: readonly {
          readonly scope: Scope;
          readonly scopeDigest: string;
        }[];
      };

  readonly lensConstraint:
    | { readonly mode: "independent" }
    | {
        readonly mode: "required";
        readonly selection: "any_registered" | "allowlist";
        readonly registrations: readonly LensRef[];
      };

  readonly normalizationPolicyDigest: string;
  readonly comparabilityPolicyDigest: string | null;
  readonly outputKind: DetectorOutputKind;

  readonly positiveFixtureDigests: readonly string[];
  readonly negativeFixtureDigests: readonly string[];

  readonly falsePositivePolicy: SemanticJsonObject;
  readonly falsePositivePolicyDigest: string;
  readonly calibrationPopulation: SemanticJsonObject | null;
  readonly calibrationPopulationDigest: string | null;
  readonly calibrationEvidenceDigest: string | null;

  readonly privacy: {
    readonly signatureTreatment:
      | "none"
      | "public_structural"
      | "tenant_keyed_private"
      | "mixed";
    readonly transientContent:
      | "forbidden"
      | "memory_only"
      | "explicit_disclosure_receipt";
    readonly policyDigest: string;
  };

  readonly proposedValidationCriterion: SemanticJsonObject;
  readonly proposedValidationCriterionDigest: string;
  readonly supersedes: DetectorRef | null;
  readonly registrationDigest: string;
}

export declare function detectorRegistrationDigest(
  input: Omit<DetectorRegistration, "schemaVersion" | "registrationDigest">,
): string;

export declare function parseDetectorRegistration(
  input: unknown,
): DetectorRegistration;

export interface DetectorPackManifest {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly version: string;
  readonly kind: "core_structural" | "reference_operational" | "host";
  readonly detectors: readonly DetectorRef[];
  readonly lenses: readonly LensRef[];
  readonly changelogDigest: string;
  readonly supersedes: PackRef | null;
  readonly manifestDigest: string;
}

export declare function detectorPackManifestDigest(
  input: Omit<DetectorPackManifest, "schemaVersion" | "manifestDigest">,
): string;

export declare function parseDetectorPackManifest(
  input: unknown,
): DetectorPackManifest;

export interface LearningLensRegistration {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly version: string;
  readonly objective: string;
  readonly objectiveDigest: string;
  readonly scopePolicyDigest: string;

  readonly applicableScopes:
    | { readonly mode: "invocation" }
    | {
        readonly mode: "exact";
        readonly scopes: readonly {
          readonly scope: Scope;
          readonly scopeDigest: string;
        }[];
      };

  readonly episodeClasses:
    | { readonly mode: "any" }
    | { readonly mode: "include"; readonly values: readonly string[] };

  readonly learningClasses: readonly LearningClass[];
  readonly evidenceRequirements: readonly {
    readonly kind: "observation" | "measurement" | "episode";
    readonly minimumTrust: TrustClass;
    readonly minimumCompleteness: Provenance["completeness"];
  }[];

  readonly qualitativeRubric: SemanticJsonObject;
  readonly qualitativeRubricDigest: string;
  readonly requiredFingerprintKinds: readonly string[];
  readonly requiredCalibrationIds: readonly string[];
  readonly permittedDestinationIds: readonly string[];
  readonly permittedDestinationKinds: readonly string[];

  readonly generatorPolicy: {
    readonly allowedKinds: readonly (
      | "deterministic"
      | "human"
      | "semantic_judgment"
    )[];
    readonly identityPolicyDigest: string;
    readonly fingerprintPolicyDigest: string;
  };

  readonly reviewerPolicy: {
    readonly independentFromGenerator: true;
    readonly identityPolicyDigest: string;
    readonly calibrationPolicyDigest: string | null;
  };

  readonly privacy: {
    readonly outboundDisclosure:
      | "forbidden"
      | "explicit_disclosure_receipt";
    readonly policyDigest: string;
  };
  readonly validationStrategy: { readonly [key: string]: JsonValue };
  readonly validationStrategyDigest: string;
  readonly supersedes: LensRef | null;
  readonly registrationDigest: string;
}

export declare function learningLensRegistrationDigest(
  input: Omit<
    LearningLensRegistration,
    "schemaVersion" | "registrationDigest"
  >,
): string;

export declare function parseLearningLensRegistration(
  input: unknown,
): LearningLensRegistration;

export interface InsightDerivation {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly scope: Scope;
  readonly scopeDigest: string;
  readonly scopePolicyDigest: string;
  readonly learningClass: LearningClass;
  readonly lens: LensRef;

  readonly detector: DetectorRef & {
    readonly configurationDigest: string;
  };
  readonly pack: PackRef | null;

  readonly population: {
    readonly episodes: readonly {
      readonly episodeRecordId: string;
      readonly episodeViewDigest: string;
      readonly scopeDigest: string;
    }[];
    readonly populationDigest: string;
    readonly normalizationPolicyDigest: string;
    readonly comparabilityPolicyDigest: string | null;
  };

  readonly directObservation: {
    readonly statement: string;
    readonly data: JsonValue;
    readonly evidenceRefs: readonly EvidenceRef[];
    readonly completeness: Provenance["completeness"];
  };

  readonly evidenceHealthFindings: readonly EvidenceHealthFinding[];

  readonly interpretation: {
    readonly statement: string;
    readonly confidence: "high" | "medium" | "low" | "unknown";
    readonly uncertainty: readonly string[];
  } | null;

  readonly impactHypothesis: {
    readonly statement: string;
  } | null;

  readonly contradictoryEvidenceRefs: readonly EvidenceRef[];
  readonly missingEvidence: readonly {
    readonly capability: string;
    readonly reasonCode: string;
    readonly effect: "limits_claims" | "blocks_audit" | "blocks_use";
  }[];

  readonly applicability: {
    readonly statement: string;
    readonly exclusions: readonly string[];
  };

  readonly producer: {
    readonly kind: "deterministic" | "human" | "semantic_judgment";
    readonly implementationId: string;
    readonly implementationVersion: string;
    readonly implementationDigest: string;
    readonly principal: PrincipalRef | null;
    readonly attestation: {
      readonly id: string;
      readonly digest: string;
    } | null;
    readonly modelFingerprintDigest: string | null;
    readonly promptDigest: string | null;
    readonly toolPolicyDigest: string | null;
    readonly budgetPolicyDigest: string | null;
    readonly disclosure: {
      readonly receiptId: string;
      readonly receiptDigest: string;
      readonly minimizedBytesDigest: string;
    } | null;
  };

  readonly candidateIntervention: {
    readonly summary: string;
    readonly proposedDestinationKind: string;
    readonly proposedDestinationId: string | null;
    readonly contentDraft: JsonValue | null;
    readonly rollbackIntent: string | null;
  } | null;

  readonly validation: {
    readonly method: string;
    readonly comparablePopulation: JsonValue | null;
    readonly comparablePopulationDigest: string | null;
    readonly successCriterion: string;
    readonly guardrails: readonly string[];
    readonly strategyDigest: string;
  } | null;

  readonly supersedes: {
    readonly id: string;
    readonly derivationDigest: string;
    readonly scopeDigest: string;
  } | null;
  readonly derivationDigest: string;
}

export declare function insightDerivationDigest(
  input: Omit<InsightDerivation, "schemaVersion" | "id" | "derivationDigest">,
): string;

export declare function parseInsightDerivation(
  input: unknown,
): InsightDerivation;

export interface SourceSemanticProfile {
  readonly schemaVersion: 1;
  readonly sourceId: string;
  readonly sourceRegistrationRevision: string;
  readonly observationVocabularyDigest: string;
  readonly capabilities: readonly string[];
  readonly observationKinds: readonly string[];
  readonly profileDigest: string;
}

export declare function sourceSemanticProfileDigest(
  input: Omit<SourceSemanticProfile, "schemaVersion" | "profileDigest">,
): string;

export declare function parseSourceSemanticProfile(
  input: unknown,
): SourceSemanticProfile;

export interface SemanticRegistryConfig {
  readonly schemaVersion: 1;
  readonly scopePolicyDigest: string;
  readonly detectors: readonly DetectorRegistration[];
  readonly packs: readonly DetectorPackManifest[];
  readonly lenses: readonly LearningLensRegistration[];
  readonly sourceProfiles: readonly SourceSemanticProfile[];
  readonly selectedDetectorRefs: readonly DetectorRef[];
  readonly selectedPackRefs: readonly PackRef[];
  readonly selectedLensRefs: readonly LensRef[];
  readonly registryDigest: string;
}

export declare function semanticRegistryDigest(
  input: Omit<SemanticRegistryConfig, "schemaVersion" | "registryDigest">,
): string;

export declare function parseSemanticRegistryConfig(
  input: unknown,
): SemanticRegistryConfig;

export type DetectorExecutionStatus =
  | "applied"
  | "not_applicable"
  | "incomplete";

export interface DetectorExecutionRecord {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly loopRegistryRevision: string;
  readonly detector: DetectorRef & {
    readonly configurationDigest: string;
    readonly implementationDigest: string;
  };
  readonly pack: PackRef;
  readonly lens: LensRef | null;
  readonly scope: Scope;
  readonly scopeDigest: string;
  readonly scopePolicyDigest: string;
  readonly outputKind: DetectorOutputKind;
  readonly window: {
    readonly sourceProfiles: readonly SourceSemanticProfile[];
    readonly population: {
      readonly episodes: readonly {
        readonly episodeRecordId: string;
        readonly episodeRecordDigest: string;
        readonly episodeIdentityDigest: string;
        readonly outcomeClaimDigest: string | null;
        readonly episodeViewDigest: string;
        readonly scopeDigest: string;
      }[];
      readonly normalizationPolicyDigest: string;
      readonly comparabilityPolicyDigest: string | null;
      readonly populationDigest: string;
    };
    readonly evidenceRefs: readonly EvidenceRef[];
    readonly evidenceHealthFindings: readonly EvidenceHealthFinding[];
    readonly availableCapabilities: readonly string[];
    readonly windowDigest: string;
  };
  readonly result:
    | {
        readonly status: "applied";
        readonly conditionDetected: boolean;
        readonly derivationRefs: readonly {
          readonly id: string;
          readonly derivationDigest: string;
          readonly scopeDigest: string;
        }[];
        readonly evidenceHealthFindings: readonly EvidenceHealthFinding[];
      }
    | {
        readonly status: "not_applicable" | "incomplete";
        readonly reasonCodes: readonly string[];
        readonly missingCapabilities: readonly string[];
      };
  readonly executionKeyDigest: string;
  readonly executionDigest: string;
}

export declare function detectorExecutionKeyDigest(
  input: Omit<
    DetectorExecutionRecord,
    | "schemaVersion"
    | "id"
    | "result"
    | "executionKeyDigest"
    | "executionDigest"
  >,
): string;

export declare function detectorExecutionDigest(
  input: Omit<
    DetectorExecutionRecord,
    "schemaVersion" | "id" | "executionDigest"
  >,
): string;

export declare function parseDetectorExecutionRecord(
  input: unknown,
): DetectorExecutionRecord;

export interface InsightDerivationQuery {
  readonly scope: Scope;
  readonly derivationIds?: readonly string[];
  readonly detectorIds?: readonly string[];
  readonly detectorRegistrationDigests?: readonly string[];
  readonly packManifestDigests?: readonly string[];
  readonly lensRegistrationDigests?: readonly string[];
  readonly learningClasses?: readonly LearningClass[];
  readonly producerKinds?: readonly (
    | "deterministic"
    | "human"
    | "semantic_judgment"
  )[];
  readonly registryStatuses?: readonly (
    | "configured"
    | "historical_unconfigured"
  )[];
  readonly commitStatuses?: readonly (
    | "committed"
    | "orphaned"
    | "invalid"
  )[];
  readonly cursor?: string;
  readonly limit: number;
}

export interface DetectorExecutionQuery {
  readonly scope: Scope;
  readonly executionIds?: readonly string[];
  readonly detectorIds?: readonly string[];
  readonly detectorRegistrationDigests?: readonly string[];
  readonly packManifestDigests?: readonly string[];
  readonly lensRegistrationDigests?: readonly string[];
  readonly statuses?: readonly DetectorExecutionStatus[];
  readonly conditionDetected?: boolean;
  readonly registryStatuses?: readonly (
    | "configured"
    | "historical_unconfigured"
  )[];
  readonly commitStatuses?: readonly ("committed" | "invalid")[];
  readonly cursor?: string;
  readonly limit: number;
}

type SemanticRegistryBinding =
  | { readonly status: "configured" }
  | {
      readonly status: "historical_unconfigured";
      readonly diagnostics: readonly Diagnostic[];
    };

export interface InsightDerivationView {
  readonly derivation: InsightDerivation;
  readonly registryBinding: SemanticRegistryBinding;
  readonly commitBinding:
    | {
        readonly status: "committed";
        readonly executionRefs: readonly {
          readonly id: string;
          readonly executionKeyDigest: string;
          readonly executionDigest: string;
          readonly loopRegistryRevision: string;
          readonly semanticRegistryDigest: string;
        }[];
      }
    | {
        readonly status: "orphaned" | "invalid";
        readonly diagnostics: readonly Diagnostic[];
      };
  readonly evidenceHealth: EvidenceHealthView;
}

export interface DetectorExecutionView {
  readonly execution: DetectorExecutionRecord;
  readonly registryBinding: SemanticRegistryBinding;
  readonly commitBinding:
    | { readonly status: "committed" }
    | {
        readonly status: "invalid";
        readonly diagnostics: readonly Diagnostic[];
      };
  readonly evidenceHealth: EvidenceHealthView;
}

declare const registeredDetectorImplementationBrand: unique symbol;

export interface RegisteredDetectorImplementation {
  readonly detector: {
    readonly id: string;
    readonly version: string;
    readonly registrationDigest: string;
  };
  readonly implementationDigest: string;
  readonly registrationDigest: string;
  readonly [registeredDetectorImplementationBrand]: true;
}

export interface DetectorWindow {
  readonly schemaVersion: 1;
  readonly loopRegistryRevision: string;
  readonly detector: DetectorExecutionRecord["detector"];
  readonly pack: DetectorExecutionRecord["pack"];
  readonly lens: DetectorExecutionRecord["lens"];
  readonly scope: Scope;
  readonly scopeDigest: string;
  readonly scopePolicyDigest: string;
  readonly outputKind: DetectorOutputKind;
  readonly sourceProfiles: readonly SourceSemanticProfile[];
  readonly population: {
    readonly episodes: readonly {
      readonly view: EpisodeView;
      readonly episodeRecordDigest: string;
      readonly episodeIdentityDigest: string;
      readonly outcomeClaimDigest: string | null;
      readonly episodeViewDigest: string;
      readonly scopeDigest: string;
    }[];
    readonly normalizationPolicyDigest: string;
    readonly comparabilityPolicyDigest: string | null;
    readonly populationDigest: string;
  };
  readonly evidence: readonly (
    | {
        readonly kind: "observation";
        readonly record: Observation;
        readonly reference: ObservationEvidenceRef;
      }
    | {
        readonly kind: "measurement";
        readonly record: MeasurementRecord;
        readonly reference: MeasurementEvidenceRefV2;
      }
  )[];
  readonly evidenceHealthFindings: readonly EvidenceHealthFinding[];
  readonly availableCapabilities: readonly string[];
  readonly windowDigest: string;
}

export type DetectorRecurrenceLocator =
  | {
      readonly treatment: "public_structural";
      readonly structuralLabel: string;
    }
  | {
      readonly treatment: "tenant_keyed_private";
      readonly keyedDigest: string;
      readonly keyPolicyDigest: string;
    };

export interface DetectorOrchestrationPolicy {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly version: string;
  readonly caps: {
    readonly maximumInvocationsPerRun: number;
    readonly maximumInsightGroupsPerRun: number;
    readonly maximumEvidenceHealthGroupsPerRun: number;
  };
  readonly rejectionSuppression:
    | { readonly mode: "disabled" }
    | {
        readonly mode: "evidence_multiplier";
        readonly minimumDistinctEpisodeMultiplier: number;
      };
  readonly policyDigest: string;
}

export declare function detectorOrchestrationPolicyDigest(
  input: Omit<DetectorOrchestrationPolicy, "schemaVersion" | "policyDigest">,
): string;

export declare function parseDetectorOrchestrationPolicy(
  input: unknown,
): DetectorOrchestrationPolicy;

export type DetectorResultDraft = {
  readonly conditionDetected: boolean;
  readonly recurrenceLocator?: DetectorRecurrenceLocator | null;
  readonly insights: readonly {
    readonly learningClass: LearningClass;
    readonly directObservation: {
      readonly statement: string;
      readonly data: JsonValue;
      readonly evidenceReferenceDigests: readonly string[];
    };
    readonly interpretation: InsightDerivation["interpretation"];
    readonly impactHypothesis: InsightDerivation["impactHypothesis"];
    readonly contradictoryEvidenceReferenceDigests: readonly string[];
    readonly evidenceHealthFindingIds: readonly string[];
    readonly missingEvidence: InsightDerivation["missingEvidence"];
    readonly applicability: InsightDerivation["applicability"];
    readonly candidateIntervention: InsightDerivation["candidateIntervention"];
    readonly validation: InsightDerivation["validation"];
    readonly supersedes: { readonly id: string; readonly digest: string } | null;
  }[];
  readonly findings: readonly Omit<
    EvidenceHealthFinding,
    "schemaVersion" | "id" | "findingDigest"
  >[];
};

export interface DetectorRunInput {
  readonly mode: "dry_run" | "commit";
  readonly detector: {
    readonly id: string;
    readonly version: string;
    readonly registrationDigest: string;
  };
  readonly pack: {
    readonly id: string;
    readonly version: string;
    readonly manifestDigest: string;
  };
  readonly lens: {
    readonly id: string;
    readonly version: string;
    readonly registrationDigest: string;
  } | null;
  readonly scope: Scope;
  readonly episodeRecordIds: readonly string[];
}

export interface DetectorRunResult {
  readonly mode: "dry_run" | "commit";
  readonly status: DetectorExecutionStatus;
  readonly persistence: "none" | "committed" | "existing";
  readonly callbackInvoked: boolean;
  readonly execution?: DetectorExecutionRecord;
  readonly derivations: readonly InsightDerivation[];
  readonly recurrence:
    | {
        readonly status: "grouped";
        readonly groupKeyDigest: string;
        readonly locator: DetectorRecurrenceLocator;
        readonly distinctEpisodeCount: number;
        readonly executionCount: number;
      }
    | { readonly status: "execution_not_materialized" }
    | {
        readonly status: "execution_not_applied";
        readonly executionStatus: "not_applicable" | "incomplete";
      }
    | { readonly status: "condition_not_detected" }
    | { readonly status: "locator_unavailable" };
  readonly evidenceHealth: EvidenceHealthView;
  readonly diagnostics: readonly Diagnostic[];
}

export type DetectorOrchestrationDisposition =
  | "executed"
  | "existing"
  | "not_applicable"
  | "incomplete"
  | "capped"
  | "refused";

export interface DetectorPackRunInput {
  readonly mode: "dry_run" | "commit";
  readonly pack: {
    readonly id: string;
    readonly version: string;
    readonly manifestDigest: string;
  };
  readonly scope: Scope;
  readonly episodeRecordIds: readonly string[];
}

export interface DetectorPackRunResult {
  readonly mode: "dry_run" | "commit";
  readonly status: "completed" | "partial";
  readonly pack: DetectorPackRunInput["pack"];
  readonly scope: Scope;
  readonly items: readonly {
    readonly detector: DetectorRunInput["detector"];
    readonly lens: DetectorRunInput["lens"];
    readonly disposition: DetectorOrchestrationDisposition;
    readonly recurrenceDisposition?: "not_grouped" | "unassessed" | "capped";
    readonly callbackInvoked: boolean;
    readonly result?: DetectorRunResult;
    readonly diagnostics: readonly Diagnostic[];
  }[];
  readonly receipt?: DetectorPackRunReceipt;
  readonly diagnostics: readonly Diagnostic[];
}

export interface DetectorPackRunReceipt {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly loopRegistryRevision: string;
  readonly semanticRegistryDigest: string;
  readonly policy: DetectorOrchestrationPolicy;
  readonly pack: DetectorPackRunInput["pack"];
  readonly scope: Scope;
  readonly scopeDigest: string;
  readonly scopePolicyDigest: string;
  readonly population: {
    readonly requestedEpisodeRecordIds: readonly string[];
    readonly resolvedEpisodes: readonly {
      readonly episodeRecordId: string;
      readonly episodeRecordDigest: string;
      readonly episodeIdentityDigest: string;
      readonly outcomeClaimDigest: string | null;
      readonly episodeViewDigest: string;
      readonly scopeDigest: string;
    }[];
    readonly populationDigest: string;
  };
  readonly governanceSnapshotDigest: string;
  readonly items: readonly {
    readonly detector: {
      readonly id: string;
      readonly version: string;
      readonly registrationDigest: string;
      readonly configurationDigest: string;
      readonly implementationDigest: string;
    };
    readonly lens: DetectorRunInput["lens"];
    readonly outputKind: DetectorOutputKind;
    readonly executionDisposition:
      | "executed"
      | "not_applicable"
      | "incomplete"
      | "capped"
      | "refused";
    readonly executionRef: {
      readonly id: string;
      readonly executionKeyDigest: string;
      readonly executionDigest: string;
    } | null;
    readonly recurrence:
      | {
          readonly status: "absent";
          readonly reason:
            | "execution_not_materialized"
            | "execution_not_applied"
            | "condition_not_detected"
            | "locator_unavailable"
            | "result_not_retained";
          readonly decisionBindingDigest: string | null;
        }
      | {
          readonly status: "grouped";
          readonly groupKeyDigest: string;
          readonly locator: DetectorRecurrenceLocator;
          readonly decisionBindingDigest: string;
          readonly executionCount: number;
          readonly distinctEpisodeCount: number;
          readonly episodeIdentityDigests: readonly string[];
          readonly episodeIdentitySetDigest: string;
          readonly governance:
            | {
                readonly status: "not_assessed";
                readonly reason: "candidate_claims_deferred";
                readonly groupDisposition: "unassessed" | "capped";
              }
            | {
                readonly status: "assessed";
                readonly candidateBindings: readonly {
                  readonly candidateId: string;
                  readonly candidateDigest: string;
                  readonly claimDigest: string;
                  readonly derivationId: string;
                  readonly derivationDigest: string;
                  readonly episodeIdentitySetDigest: string;
                  readonly distinctEpisodeCount: number;
                  readonly supersedes: {
                    readonly candidateId: string;
                    readonly candidateDigest: string;
                    readonly claimDigest: string;
                  } | null;
                  readonly latestReview: {
                    readonly id: string;
                    readonly recordDigest: string;
                    readonly disposition: ReviewDisposition;
                    readonly reviewedAt: string;
                  } | null;
                }[];
                readonly groupDisposition:
                  | "available"
                  | "deduplicated"
                  | "suppressed"
                  | "capped";
                readonly requiredSupersedes: {
                  readonly candidateId: string;
                  readonly candidateDigest: string;
                  readonly claimDigest: string;
                } | null;
                readonly requiredOverrideCount: number | null;
                readonly governingRejection: {
                  readonly candidateId: string;
                  readonly candidateDigest: string;
                  readonly claimDigest: string;
                  readonly reviewId: string;
                  readonly reviewRecordDigest: string;
                } | null;
                readonly reasonCodes: readonly string[];
              };
        };
    readonly reasonCodes: readonly string[];
    readonly itemDigest: string;
  }[];
  readonly status: "completed" | "partial";
  readonly packRunKeyDigest: string;
  readonly receiptDigest: string;
}

export declare function parseDetectorPackRunReceipt(
  input: unknown,
): DetectorPackRunReceipt;

export interface DetectorPackRunQuery {
  readonly scope: Scope;
  readonly receiptIds?: readonly string[];
  readonly packIds?: readonly string[];
  readonly packVersions?: readonly string[];
  readonly packManifestDigests?: readonly string[];
  readonly policyDigests?: readonly string[];
  readonly detectorIds?: readonly string[];
  readonly detectorRegistrationDigests?: readonly string[];
  readonly lensRegistrationDigests?: readonly string[];
  readonly executionDispositions?: readonly (
    | "executed"
    | "not_applicable"
    | "incomplete"
    | "capped"
    | "refused"
  )[];
  readonly groupDispositions?: readonly (
    | "unassessed"
    | "available"
    | "deduplicated"
    | "suppressed"
    | "capped"
  )[];
  readonly recurrenceStatuses?: readonly ("absent" | "grouped")[];
  readonly governanceStatuses?: readonly ("not_assessed" | "assessed")[];
  readonly statuses?: readonly ("completed" | "partial")[];
  readonly registryStatuses?: readonly ("configured" | "historical_unconfigured")[];
  readonly commitStatuses?: readonly ("committed" | "invalid")[];
  readonly cursor?: string;
  readonly limit: number;
}

export interface DetectorPackRunView {
  readonly receipt: DetectorPackRunReceipt;
  readonly registryBinding:
    | { readonly status: "configured" }
    | { readonly status: "historical_unconfigured"; readonly diagnostics: readonly Diagnostic[] };
  readonly policyBinding:
    | { readonly status: "configured" }
    | { readonly status: "historical_unconfigured"; readonly diagnostics: readonly Diagnostic[] };
  readonly commitBinding:
    | { readonly status: "committed" }
    | { readonly status: "invalid"; readonly diagnostics: readonly Diagnostic[] };
  readonly childBindings: readonly {
    readonly executionId: string;
    readonly status: "committed" | "invalid";
    readonly diagnostics: readonly Diagnostic[];
  }[];
  readonly governanceBinding:
    | { readonly status: "not_assessed" }
    | { readonly status: "current" }
    | { readonly status: "historical"; readonly diagnostics: readonly Diagnostic[] }
    | { readonly status: "invalid"; readonly diagnostics: readonly Diagnostic[] };
  readonly evidenceHealth: EvidenceHealthView;
}

export declare function defineDetectorImplementation(input: {
  readonly registration: DetectorRegistration;
  readonly evaluate: (window: DetectorWindow) => unknown;
}): RegisteredDetectorImplementation;
```

All ids, versions, capability names, observation kinds, episode classes,
destination values, learning classes, reason codes, and method names are
bounded and control-free. Versions use canonical SemVer. Host learning classes
use a bounded `host:<namespace>` form; roles remain lens data and never become
kernel enums.

Registration content (`configuration`, present `thresholds`, false-positive policy,
calibration population, proposed validation criterion, qualitative rubric,
and validation strategy) is minimized, public-safe JSON. Its adjacent digest
is recomputed from that exact content. Lens fingerprint/calibration requirements
are explicit sorted ids, while generator, reviewer, and privacy policy objects
carry their exact policy digests. Null content and digest fields occur together;
no digest authenticates omitted private bytes. Secrets and low-entropy private
recurrence stay behind tenant-keyed host registrations.

Required configuration, false-positive policy, proposed validation criterion,
and qualitative rubric values are non-null JSON objects. Thresholds and
calibration population are either null with a null digest or non-null JSON
objects with their recomputed digest; JSON null is never accepted as disguised
required content.

Every detector has at least one positive fixture digest and one complex or
ordinary negative-control digest. Include-mode episode classes and exact-scope
selectors are nonempty. A required lens allowlist is nonempty, while
`any_registered` carries an empty list. Threshold content/digest and
calibration-population content/digest are paired. Every pack contains at least
one detector; detector and lens refs are sorted and unique by id/version/digest.

Learning-lens evidence requirements use the closed kinds `observation`,
`measurement`, and `episode`, with at most one requirement per kind. An episode
requirement is satisfied only by a nonempty exact population whose reloaded,
digested EpisodeIdentityRecord values meet the declared minimum trust and
completeness. This is an additive parser widening: existing observation and
measurement lens bytes and registration digests do not change.

A `SourceSemanticProfile` is an immutable host grant for one exact source
registration revision, not an adapter assertion. Its capabilities and
observation kinds are sorted, unique normalized ids, and `profileDigest`
recomputes over exact source id, source-registration revision,
observation-vocabulary digest, capabilities, and observation kinds. A source
without a profile contributes zero semantic capabilities to a detector window.
For backward-compatible generic Observe ingest, profile omission does not
reject otherwise valid observations; once a profile is present, ingest rejects
every normalized observation kind that is absent from the declared
`observationKinds` set.

`SemanticRegistryConfig` separates full installation from exact selection.
Installed detector, pack, lens, and source-profile records and selected
detector, pack, and lens refs are bounded, sorted, and unique. One logical
detector, pack, or lens id/version has one digest, and one source registration
revision has one semantic profile. Detector and lens scope-policy digests equal
the registry scope policy. Pack members and detector lens allowlists resolve to
exact installed records; packs cannot contain deprecated detectors. Selected
refs resolve exactly, selected detectors are not deprecated, and every selected
detector and lens belongs to a selected pack. Every selected insight detector
and one compatible selected lens under its exact constraint co-occur in at
least one exact selected pack; membership in separate packs is insufficient.
Installation and selection grant availability only—never trust, authority,
execution, publication, active context, review, validation, or efficacy.

`LearningLoopConfig.semanticRegistry` is optional. Construction parses and
recursively snapshots the registry, requires its scope policy to equal the
loop's configured scope policy, and requires every SourceSemanticProfile to
name an exact configured source id and registration revision. When configured,
the semantic registry contributes its `registryDigest` to the immutable loop
registry revision. Omitting the field preserves the exact pre-#30b loop
registry bytes; configuring even an empty semantic registry is an explicit new
registry identity.

Every set-like array is sorted and unique. Arrays whose order affects meaning
— derivation evidence, populations, supports, guardrails, and validation —
retain declared order and are duplicate-free. Exact-scope entries recompute
their `scopeDigest`. `directObservation.data` uses the normalized, minimized
provider-neutral vocabulary and is included in `derivationDigest`; it never
contains a provider-native raw record. `InsightDerivation.id` is exactly
`insight-${derivationDigest}`. `population.episodes` and
`directObservation.evidenceRefs` cannot both be empty, so a self-digested statement
without durable grounding cannot parse as a derivation. Every population
episode `scopeDigest` must equal the derivation's top-level `scopeDigest`, which
prevents a population-only derivation from crossing a project or isolation
boundary. `populationDigest` is the digest of protocol-canonical JSON for exact
`{ episodes, normalizationPolicyDigest, comparabilityPolicyDigest }`; changing
either policy therefore changes population identity even when the episode list
does not.

Population `episodeRecordId` values use the 4,096-character durable-id bound,
not the smaller semantic identifier bound. Every direct-observation and
contradictory EvidenceRef must carry `episode.scopeDigest` exactly equal to the
derivation `scopeDigest`. An Insight supersession carries the predecessor
`scopeDigest`, which must also equal the current derivation scope; semantic
revision lineage cannot cross a project or isolation boundary.

`evidenceHealthFindings` embeds complete, unknown-first-parsed
`EvidenceHealthFinding` records, so id, digest, effect, source, page,
completeness, and affected-record facts stay cryptographically coherent. The
receipt-last semantic validator proves each finding's exact source/page
relationship to the execution window before persistence and rechecks it for
public views.

Human and semantic-judgment producers require both `principal` and
`attestation`. Human producers require `principal.kind === "human"`;
semantic-judgment producers require an `agent` or `service` principal and
additionally require model, prompt, tool-policy, and budget-policy digests. Deterministic producers require those
provider fields and principal/attestation to be null. `disclosure` is optional
only for local or otherwise non-outbound production; any outbound semantic
workflow binds the exact durable receipt, minimized-byte digest, and receipt
digest. Validation comparable-population content and digest are paired.

Digest inclusion is exact:

| Record | Included | Excluded |
| --- | --- | --- |
| `DetectorRegistration` | Every field from `id` through `supersedes`, including full policy/configuration content and its verified adjacent digests | `schemaVersion`, `registrationDigest` |
| `DetectorPackManifest` | `id`, version, kind, exact detector/lens refs, changelog and supersession | `schemaVersion`, `manifestDigest` |
| `LearningLensRegistration` | Every field from `id` through `supersedes`, including full objective/rubric/requirement/policy/strategy content and adjacent digests | `schemaVersion`, `registrationDigest` |
| `InsightDerivation` | Every field from scope through producer, intervention/validation and same-scope supersession, including full evidence and complete evidence-health findings | `schemaVersion`, `id`, `derivationDigest` |
| `SourceSemanticProfile` | Source id, exact source-registration revision, observation-vocabulary digest, capabilities, and observation kinds | `schemaVersion`, `profileDigest` |
| `SemanticRegistryConfig` | Scope-policy digest; full installed detector, pack, lens, and source-profile records; exact selected detector, pack, and lens refs | `schemaVersion`, `registryDigest` |
| `DetectorOrchestrationPolicy` | Id, version, exact invocation/insight-group/evidence-health-group caps, and complete rejection-suppression configuration | `schemaVersion`, `policyDigest` |
| `DetectorExecutionRecord.executionKeyDigest` | Loop-registry revision, detector plus configuration/implementation digests, required pack, output-dependent lens, scope and policy, output kind, and the complete immutable window | `schemaVersion`, `id`, `result`, `executionKeyDigest`, `executionDigest` |
| `DetectorExecutionRecord.executionDigest` | The complete invocation/window, closed result, and `executionKeyDigest` | `schemaVersion`, `id`, `executionDigest` |
| `DetectorPackRunReceipt.populationDigest` | Exact requested episode ids and one-to-one resolved episode record/identity/outcome/view/scope lineage | `populationDigest` |
| `DetectorPackRunReceipt.items[].itemDigest` | Complete retry-normalized item: detector/lens/output kind, execution disposition/ref, recurrence/governance, reason codes | `itemDigest` |
| `DetectorPackRunReceipt.governanceSnapshotDigest` | Sorted unique group key, execution/distinct-episode counts, episode-set digest and full governance branch | `governanceSnapshotDigest` |
| `DetectorPackRunReceipt.packRunKeyDigest` | Domain; loop/semantic registry; policy ref; pack; scope/policy; population digest; governance snapshot; sorted detector/lens/output-kind selection, child execution key or null, and recurrence group key or null | `schemaVersion`, `id`, execution disposition, reason/absent codes, callback/persistence activity, child full execution digests, direct recurrence count/set fields, item/full receipt digests, `packRunKeyDigest`, `receiptDigest` |
| `DetectorPackRunReceipt.receiptDigest` | Complete receipt content including full policy, population, items, governance snapshot and `packRunKeyDigest` | `schemaVersion`, `id`, `receiptDigest` |

Changing implementation, configuration, thresholds, capabilities,
applicability, normalization, comparability, fixtures, false-positive policy,
calibration, privacy, proposed validation, lens objective/rubric/requirements,
validation strategy, or pack membership requires a new semantic version and
new digest. Maturity promotion also creates a new version with exact
`supersedes` lineage. `calibrated` and `stable` require non-null calibration
population and evidence digests. `deprecated` registrations are not executable
and must supersede the prior executable version. A pack cannot select a
deprecated registration.

Detector, pack, and lens content is installed as full immutable records, while
executable selection is exact and selected detector/lens refs must be members
of selected packs. Installation and selection grant no trust, execution,
publication, active-context, review, authorization, or validation authority. A
derivation is advisory and inert. Its deterministic observation can be certain
while interpretation and impact remain uncertain. Evidence-health references
constrain claims but never become behavioral evidence. An intervention and
validation plan are either both present or both absent; a derivation cannot
authorize or publish either.

`DetectorExecutionRecord` is the immutable fact for one exact detector
invocation and evidence window. Its detector binds exact registration,
configuration, and implementation digests; `pack` is always a non-null exact
PackRef. An `insight_derivation` execution requires an exact lens, while an
`evidence_health` execution requires `lens: null`. The top-level scope digest
is recomputed and every population episode, EvidenceRef, and output derivation
ref has that same scope. EvidenceRefs also carry the execution loop-registry
revision and resolve to exact source profiles in the window. Full input and
output EvidenceHealthFinding values name exact profiled source-registration
revisions; they are never collapsed into asserted ids or effects.

Every population episode's `episodeViewDigest` is the digest of exact
`{ episodeRecordId, episodeRecordDigest, episodeIdentityDigest,
outcomeClaimDigest, scopeDigest }`. `populationDigest` binds exact
`{ episodes, normalizationPolicyDigest, comparabilityPolicyDigest }`.
Each durable `episodeRecordId` starts with the `<sourceId>/` prefix of one exact
window SourceSemanticProfile. #30b2 still revalidates the complete source
registration and episode-identity lineage before persistence or proposal use.
`windowDigest` binds exact
`{ sourceProfiles, population, evidenceRefs, evidenceHealthFindings,
availableCapabilities }`. `availableCapabilities` is exactly the sorted set
union of every bound source profile's capabilities; a record cannot add a
capability that its profiles did not grant.

Execution status is closed to `applied`, `not_applicable`, or `incomplete`.
There is no `pass`. `applied` always says whether the registered condition was
detected. A negative condition has no outputs. A detected insight condition has
one or more unique exact derivation refs and no health output; a detected
evidence-health condition has one or more full EvidenceHealthFinding outputs
and no derivation refs. Non-applied results have nonempty sorted reason codes
and sorted missing capabilities, and no missing capability may also appear in
the exact available-capability union. Missing or incomplete evidence is never
zero and never pass.

`executionKeyDigest` binds every invocation and window field while excluding
the result, schema, id, key digest, and execution digest. The id is exactly
`detector-execution-${executionKeyDigest}`. `executionDigest` binds the same
content plus the result and `executionKeyDigest`, excluding only schema, id,
and itself. Therefore the same invocation/window with a different result has
the same id and a different execution digest. Future create-only persistence
must reject that collision rather than retain two answers for one invocation.

#30b2a adds engine-private receipt-last persistence, never a public execution
write. The private graph stores a full SemanticRegistryConfig snapshot under
the exact loop-registry revision and append-only derivation/execution links
that bind derivation id/digest/scope, execution id/key/full digest, and exact
registry provenance. The link stream entry id is
`execution:${executionId}:${executionDigest}`. After stable validation the
kernel writes the registry snapshot, result health findings, provenance links,
derivations plus their exact-scope indexes, the execution scope index, and
finally the DetectorExecutionRecord receipt, then reloads the graph. Same bytes
retry idempotently; a same-key/different-result receipt conflicts. Losing and
crash-interrupted attempts remain auditable rather than being deleted.

The public views keep three dimensions separate. `commitBinding` reports
committed, orphaned, or invalid derivation lineage and committed or invalid
execution lineage. `registryBinding` is configured only when an exact committed
execution uses the current selected registry; otherwise it is
`historical_unconfigured` and read-only. EvidenceHealthView is recomputed from
current durable evidence and is never upgraded by historical registry
integrity. A malformed stored record is corruption, not a typed invalid view.

Commit-time derivation supersession resolves the exact predecessor id, digest,
scope, and reciprocal committed execution; an asserted but missing predecessor
is refused. Historical qualified measurement health reloads every ordered
supporting observation, source-page receipt, episode identity, and current
outcome membership rather than trusting the embedded support list alone.

Every semantic query and direct get requires an exact Scope. Wrong-scope gets
return undefined without revealing whether the id exists. A private namespace
named `learning-semantic-scope-${scopeDigest}` holds fixed
`insight-derivation-index` and `detector-execution-index` kinds, so pagination
and direct gets resolve only same-scope target ids and digests. Filters are
bounded and unknown-first; `conditionDetected` filters
only applied results. Opaque cursors bind query kind, normalized filters
including scope, current loop registry, scope-local store cursor, and
cursor-scope digest. The kernel uses an internal stable composite revision
tuple covering semantic graph records,
evidence, episodes and identity/outcome lineage, source receipts and health,
derivative ownership, and both exact-scope index kinds. A page retries three
times and then fails with `query.snapshot_changed`. The public semantic page
`snapshotRevision` instead digests only the exact scope-index page revision and
canonical returned same-scope views, so an empty page exposes no foreign-scope
activity. Pages remain append-visible rather than frozen populations.

#30b2b implements derivation-backed Candidate proposal and requires committed,
configured, evidence-health-ready lineage plus exact derived content and
independent review.

#30c1 registers exact deterministic implementations through
`defineDetectorImplementation`. The returned frozen capability is backed by a
private callback WeakMap and must resolve one installed DetectorRegistration
with the same implementation digest. Callback availability stays outside the
serializable SemanticRegistryConfig. Optional runtime capabilities enter
LearningLoopConfig and the loop registry revision; omission preserves the
pre-c1 registry bytes. Capability `registrationDigest` binds exact
`{ detector, implementationDigest }`. Selected detectors without capabilities remain valid
audit registrations but cannot invoke code.

`DetectorWindow` is the only callback input. It contains exact selected
invocation metadata, scope, source profiles, resolved episode population,
normalized Observation/qualified Measurement records paired with complete
EvidenceRefs, full evidence health, capability union, and window digest. It
contains no provider-native events, raw transcripts, adapter payloads, source
readers, store handles, identity capability, or publication authority. The
kernel materializes and detaches it under a stable composite snapshot.

The implementation callback is synchronous. A Promise or any thenable return
is invalid; exceptions and malformed output produce sanitized diagnostics and
no execution receipt. DetectorResultDraft is applied-only: it may state whether
the registered condition was detected and provide insight or health drafts,
but it cannot choose not-applicable/incomplete status or supply lineage,
EvidenceRefs, producer identity, trust, ids, or canonical digests. The kernel
owns lifecycle non-application and mints every durable field.
A negative callback condition carries no drafts. A positive insight detector
carries one or more insight drafts and no findings; a positive evidence-health
detector carries one or more findings and no insight drafts.

`runDetector` rematerializes enough exact input to derive the execution key on
every call. An exact existing committed receipt is terminal for either mode and
returns `persistence: "existing"` with no callback. Otherwise eligible
`dry_run` and `commit` calls invoke the synchronous evaluator; commit never
accepts earlier dry-run bytes. Dry-run returns exact would-be execution and
derivations with zero kernel/store writes. Commit evaluates again and passes
the exact result through private receipt-last persistence. Empty/unbindable,
inapplicable, missing-capability, or unusable-evidence windows invoke no
callback. Missing/invalid is never applied false, zero, or pass. No mode calls
`propose` or creates a Candidate.

`episodeRecordIds` is canonical sorted-unique input. Reordering, duplicates,
foreign-scope ids, and more than 500 ids are refused rather than normalized or
silently truncated.

DetectorRunResult reports mode, execution status, persistence, callback
invocation, optional execution, exact derivations, evidence health, and
sanitized diagnostics. Execution is absent only when no bindable window can be
formed. Current hard ceilings are 500 episode ids, 5,000 evidence records, 100
insight drafts or 100 health findings according to output kind, 16 MiB of
canonical window bytes, and 16 MiB of canonical callback-output bytes. Limits
fail or produce incomplete without silent truncation.

#30c2a adds `runDetectorPack` as a bounded transient orchestration façade over
the same c1 child facts. Its input names one exact selected pack, mandatory
exact scope, canonical sorted-unique episode record ids, and mode. Callers do
not submit detector/lens pairs, windows, caps, results, dispositions, plans, or
persistence bytes. The kernel considers exact selected detectors from that
pack. Evidence-health detectors use `lens: null`; insight detectors fan out
over every compatible exact selected lens contained in the same pack. Exact
pair ordering uses protocol code-unit ordering of detector then lens reference
keys, never locale ordering. A coherent selected insight detector with no
compatible lens in this pack produces an explicit `not_applicable` item;
missing exact registry content is corruption and fails the call.

Every considered item carries its detector/lens pair, a closed
DetectorOrchestrationDisposition, `callbackInvoked`, an optional exact
DetectorRunResult, and sanitized diagnostics. `not_applicable` and `incomplete`
take precedence over `existing`, so durable missingness is not hidden by
idempotency. Pack status `completed | partial` describes orchestration only. It
is never a detector pass, utility result, authorization, or efficacy verdict.

Pack execution retains c1's 500-episode input ceiling. More than 5,000
detector/lens selections fails before callbacks. At most 100 child invocations
are admitted. Across one call, at most 100 unique new content-addressed output
records—derivations plus detector-output evidence-health findings—and 64 MiB
of canonical, mode-normalized child-result bytes are retained. Repeated exact
output ids inside the plan count once. Existing exact outputs do not count as
new, but their returned bytes count toward the byte ceiling. A child that would
cross an aggregate ceiling is discarded whole and reported
`capped`; its callback attempt remains explicit. Every later runnable item is
also reported capped without callback. Results, derivations, and findings are
never silently truncated.

The kernel plans all children through the c1 unknown-first dry runner under one
stable before/after semantic-graph snapshot. Public dry-run writes nothing. A
commit call independently constructs one private exact plan and then persists
retained child graphs sequentially through private receipt-last persistence;
it never accepts an earlier public dry-run and does not evaluate a child twice
within the same pack call. A snapshot change refuses the non-capped plan with
no pack write. Corrupt store or registry state remains fatal rather than a
normal item refusal. Earlier exact child commits may survive a later refusal,
so the batch is deliberately not atomic; retries rely on child-level
idempotency.

C2a creates no durable pack-run receipt, id/digest, store kind, query, or public
writer. Its fixed caps are per-call safety ceilings rather than durable rate,
deduplication, or suppression policy.

#30c2b1 adds one optional, invocation-level recurrence locator to the applied
callback draft. DetectorRecurrenceLocator is either a bounded canonical public
structural label matching `[a-z0-9](?:[a-z0-9._:-]*[a-z0-9])?` and capped at
200 characters, or a tenant-keyed private digest plus exact key-policy digest.
The locator treatment must match the exact DetectorRegistration privacy
treatment; `mixed` permits either branch and `none` permits neither. A private
key-policy digest must equal the detector privacy policy digest. Raw key
material never crosses or persists. Omission remains valid for every existing
callback, and a locator is valid only when the exact result is
`applied && conditionDetected`.

DetectorRunResult exposes recurrence independently from execution status. A
grouped result carries exact group-key and locator lineage plus current or
projected distinct-episode and execution counts. `execution_not_materialized`
means no exact execution exists; `execution_not_applied` retains the closed
`not_applicable | incomplete` status; `condition_not_detected` is reserved for
an applied negative condition; and `locator_unavailable` covers a detected
execution with no qualified binding, including historical c1/c2a facts. None
of these states implies pass, harm, preference, utility, or efficacy.

The private recurrence group key is the digest of exact
`{ domain: "detector-recurrence-group:v1", detector, lens, scope,
scopeDigest, scopePolicyDigest, locator }`, where detector includes exact id,
version, registration, configuration, and implementation digests. Pack,
loop-registry revision, population, evidence, outputs, interpretation, policy,
and disposition are excluded. Pack is distribution rather than semantics, so
the same exact detector/lens/scope/locator joins across packs; every execution
member still retains exact pack and population provenance.

A private create-only ExecutionRecurrenceBinding records every new detected
callback decision and binds exact execution id/key/full digest,
detector/pack/lens/scope, paired nullable locator/group key, exact episode
id/identity/view members in nonempty canonical-unique order, and bindingDigest.
A null pair durably records
`locator_unavailable` and creates no group member; a historical receipt has no
binding. For a non-null pair, an append-only RecurrenceGroupMember binds that
execution and binding, exact pack, and
memberDigest under the group key. Episode members remain in the exact
binding/execution and are loaded from the binding during a fold rather than
being duplicated in the group stream. `bindingDigest` hashes every binding
content field except schema version and itself; `memberDigest` does the same
for every member content field. The member stream entry id is exact
`execution:<executionId>:<executionDigest>` and its entry digest binds the full
member value. Binding and member are written before the DetectorExecutionRecord
receipt, but only after the create-only execution scope index locks that exact
execution digest. The nullable decision binding then ensures concurrent null
and non-null locator evaluations cannot both reach receipt. A competing result
or locator therefore cannot deposit later lineage after losing its locks.
Group folds
unknown-first parse and require the exact binding, member, detected-applied
execution receipt, privacy policy, and population lineage before counting a
member.

`executionCount` counts exact committed execution receipts.
`distinctEpisodeCount` unions exact episodeIdentityDigest values, never record
or view counts. A fresh dry-run previews the current committed group plus its
would-be execution once and writes nothing; commit reloads durable counts after
receipt-last persistence. Binding/member-only crash remnants are orphaned and
do not count; retry forward-completes exact bytes. Receipt-plus-binding without
the exact member, locator drift, privacy mismatch, or malformed self-bound
state is corruption. Existing receipts without bindings remain
`locator_unavailable` and never rerun for backfill.

Recurrence folds accept at most 5,000 member entries, 50,000 total episode
references across exact bindings, and 5,000 distinct episode identity digests.
Each exact ceiling is valid and the next value fails typed without truncation
or a partial count. Raw member length is refused before entry parsing and
episode references use bounded iteration. These descriptive counts are not
comparable experiments.

#30c2b2-policy adds an optional immutable DetectorOrchestrationPolicy. Its
policyDigest binds exact `{ id, version, caps, rejectionSuppression }` and
excludes schemaVersion and itself. Id and SemVer use the semantic record
grammar. All numeric fields are safe integers. maximumInvocationsPerRun is from
1 through 100; maximumInsightGroupsPerRun and
maximumEvidenceHealthGroupsPerRun are each from 0 through 100. The suppression
branch is `disabled` or `evidence_multiplier`; the latter requires
minimumDistinctEpisodeMultiplier from 2 through 100.

The policy is optional LearningLoopConfig data, parsed and recursively
snapshotted at construction. Presence contributes exact `{ policyDigest }` to
the loop registry revision. Omission preserves c2b1 registry bytes and omits
recurrenceDisposition from pack results. A changed policy intentionally creates
new child execution lineage through the changed loop registry; it never
relabels historical executions or groups.

Only the cap behavior is executable in this slice. The invocation cap lowers
c2a's maximum of 100 admitted child calls; later runnable pairs are explicitly
capped without callback. After pack evaluation, exact grouped results are
classified in stable item order with separate insight and evidence-health
counters. One exact group-key digest consumes its family counter once. A
non-grouped result is `not_grouped`, a grouped result within its family cap is
`unassessed`, and a later group is `capped`. A recurrence-capped item makes the
overall pack status partial but retains its exact DetectorRunResult and, in
commit mode, still persists its c2b1 execution/recurrence lineage. This is a
transient reporting cap—not deletion, Candidate suppression, output
truncation, or authority. It carries the static
`detector.pack_group_capped` warning diagnostic.

recurrenceDisposition is present only for an exact retained DetectorRunResult.
A capped or refused item with no retained result omits it because grouping is
unknown; omission must not be interpreted as `not_grouped`. `not_grouped` is
reserved for a retained result whose exact recurrence state is not grouped.

rejectionSuppression is registered and digested but deliberately
non-enforcing. This slice does not read Candidate/review state, create a
Candidate-to-group claim, classify a group available/deduplicated/suppressed,
refuse or revise a proposal, or authorize an override.

#30c2b2-receipts adds a kernel-created DetectorPackRunReceipt only for commit
mode with a configured orchestration policy and a population proven one-to-one
in the requested exact scope. Dry runs, policy omission, repeated snapshot
churn and nonempty missing/wrong-scope ids keep receipt absent and create no
receipt/index. This prevents arbitrary caller ids or privacy canaries from
entering a same-scope audit record. Empty input may bind an exact empty
population.

The receipt embeds the complete policy, pack, loop/semantic registry, exact
scope/policy, population, governance snapshot, normalized items and status.
Durable items omit callback activity and normalize persistence-dependent
`existing` to executed or the exact non-applied status. They retain only sorted
retry-stable reason codes. An absent recurrence records one closed reason and a
nullable decision binding; grouped recurrence records treated locator,
binding, committed counts, exact sorted identity set/digest and governance.

The runtime mints only not_assessed governance with the explicit
candidate_claims_deferred reason and exact unassessed/capped policy
classification. The parser reserves the assessed branch with exact Candidate,
derivation, claim, supersession, review, rejection and override references, but
this runtime reports such bytes historical rather than current. It creates no
Candidate claim and enforces no rejectionSuppression rule.

populationDigest binds requested ids plus one-to-one resolved episode lineage.
itemDigest binds each complete item. governanceSnapshotDigest binds sorted
group key/count/identity-set/governance projections, so group growth creates a
new snapshot. packRunKeyDigest binds registry/policy/pack/scope,
population/governance digests and sorted detector/lens/output-kind selection
plus child execution and recurrence-group keys. It excludes result-dependent execution disposition,
reasons, absent status, callback/persistence activity, child full result
digests and direct recurrence results/counts. The id is exact
`detector-pack-run-${packRunKeyDigest}`. receiptDigest binds the complete
receipt and key. Same key/different full bytes conflicts; nothing overwrites.

Child execution/recurrence graphs commit first. The kernel resolves one stable
receipt snapshot, ensures the exact semantic registry snapshot, creates an
exact-scope receipt index, and writes DetectorPackRunReceipt last. An orphan
index is invisible; retry forward-completes. Child facts may remain when a
later receipt step fails, so the receipt is not a transaction across children.
Because its identity includes post-plan group/governance facts, resolving an
existing receipt may still evaluate uncached/capped callbacks; exact child
receipts retain their own callback-skip guarantee.

queryDetectorPackRuns and getDetectorPackRun require exact scope and consult
only the corresponding private scope index before any receipt target. Queries
support bounded exact receipt/pack/policy/detector/lens/execution-disposition,
group-disposition, recurrence-status, governance-status, receipt-status and
binding-status filters plus opaque cursors; page limit is excluded from cursor
identity. There is no locator, keyed-digest, group-key, free-text or
diagnostic-message search.
Views separate receipt commit integrity, current/historical registry and policy,
each child commit, governance assessment and current aggregate evidence health.
Complete child detector/pack/lens/output/registry/scope/recurrence provenance is
revalidated together with selected detector/lens fan-out and exact
invocation/aggregate-cap ordering under the embedded policy; historical group
growth may be a superset, never a mutation of the receipt snapshot.

Receipts fail closed above 64 MiB canonical bytes, 5,000 items, 500 population
episodes, the embedded policy's 100-or-lower committed-execution and
grouped-item bounds, 50,000 total identity references, 50,000 future Candidate
bindings, 5,000 identities per group or 1,000 reason codes. A query page
additionally caps aggregate receipt bytes at 64 MiB, receipt items, child refs
and population episodes at 5,000 each, and unique group folds at 100. No digest
helper or receipt writer is public.

Private derivation/Candidate recurrence claims are implemented by decision
0016, but receipt assessment, current Candidate/review governance,
deduplication, rejection suppression and concurrent proposal admission remain
a separate governance slice. Automatic population discovery and
scheduling/routing remain outside this receipt. Core/reference/host pack
contents and reference consumers are #30d. Optional semantic-provider
generation and disclosure are #13. Default-quality and candidate-utility
claims remain #26.

#### Private derivation and Candidate recurrence claims

The kernel records observational recurrence lineage without adding a public
claim type or writer. The engine-private records are:

```ts
interface DerivationRecurrenceClaim {
  readonly schemaVersion: 1;
  readonly derivationId: string;
  readonly derivationDigest: string;
  readonly executionId: string;
  readonly executionKeyDigest: string;
  readonly executionDigest: string;
  readonly scopeDigest: string;
  readonly groupKeyDigest: string;
  readonly decisionBindingDigest: string;
  readonly populationDigest: string;
  readonly episodeIdentityDigests: readonly string[];
  readonly episodeIdentitySetDigest: string;
  readonly distinctEpisodeCount: number;
  readonly claimDigest: string;
}

interface RecurrenceCommittedMemberSnapshot {
  readonly executionId: string;
  readonly executionKeyDigest: string;
  readonly executionDigest: string;
  readonly decisionBindingDigest: string;
  readonly memberDigest: string;
}

type CandidateRecurrenceClaim =
  | {
      readonly schemaVersion: 1;
      readonly candidateId: string;
      readonly candidateDigest: string;
      readonly scopeDigest: string;
      readonly candidate: CandidateV2;
      readonly status: "not_bound";
      readonly reason: "manual" | "derivation_unbound";
      readonly claimDigest: string;
    }
  | {
      readonly schemaVersion: 1;
      readonly candidateId: string;
      readonly candidateDigest: string;
      readonly scopeDigest: string;
      readonly candidate: CandidateV2;
      readonly status: "grouped";
      readonly derivationId: string;
      readonly derivationDigest: string;
      readonly derivationClaimDigests: readonly string[];
      readonly groupKeyDigest: string;
      readonly proposalMembers: readonly RecurrenceCommittedMemberSnapshot[];
      readonly proposalMemberSnapshotDigest: string;
      readonly episodeIdentityDigestsAtProposal: readonly string[];
      readonly episodeIdentitySetDigest: string;
      readonly distinctEpisodeCount: number;
      readonly supersedes: {
        readonly candidateId: string;
        readonly candidateDigest: string;
        readonly claimDigest: string;
      } | null;
      readonly claimDigest: string;
    };
```

A derivation claim is content-addressed by claimDigest and appended by exact
`claim:<claimDigest>` reference under the derivation id. Multiple exact
execution witnesses are retained only when every committed claim resolves one
group; another group key is store corruption. Each claim revalidates the exact
derivation, execution receipt/commit view, recurrence decision, group member
and population. The claim and append reference precede the execution receipt,
so valid crash remnants remain orphaned until exact retry completes the
receipt.

Both private `claimDigest` values hash every content field shown above,
including the embedded Candidate where present, while excluding only
`schemaVersion` and `claimDigest`. `proposalMemberSnapshotDigest` hashes the
exact sorted `proposalMembers` array; `episodeIdentitySetDigest` hashes the
exact sorted episode-identity array. The Candidate content digest and all
public record goldens remain unchanged.

Every new Candidate proposal creates one nullable decision containing the exact
parsed Candidate-v2 bytes. Manual proposals
record `manual`; derivation-backed proposals without exactly one qualified
group record `derivation_unbound`. A grouped decision freezes the full
committed group at proposal through sorted exact member snapshots and their
digest, then recomputes the exact episode-identity set/count from those member
bindings. Later append-only group growth is a current superset, never a rewrite
of that baseline. Exact same-group Candidate supersession is recorded but does
not yet become an admission rule.

The Candidate-id decision is written and reloaded first, freezing exact
proposer, attestation and proposal time. The private candidate-by-content
ownership lock then additively binds the paired `recurrenceClaimDigest`,
complete parsed `recurrenceClaim`, and complete parsed `candidate` bytes for
new proposals. The optional group-Candidate append follows; it and the exact
lock are reloaded/revalidated before the Candidate record is created last. A
decision- or index-only crash therefore retains exact Candidate attribution
and proposal baseline even when evidence or the group changes. Retry requires
the same verified proposer ref/attestation, and another id cannot steal an
in-progress claim-aware lock. A claim-aware lock with a missing or mismatched
decision is invalid. Historical locks without this optional
digest/claim/Candidate triple remain byte-compatible and their Candidates
report `historical_unbound`; no read, review or upgrade backfills a claim.

Claim and group streams are capped at 5,000 entries, proposal member and
episode sets at 5,000 values, and same-group derivation witnesses share one
bounded group fold. Raw malformed bytes or impossible bindings propagate
`schema.corrupt` or `store.corrupt`; a self-consistent but referentially invalid Candidate claim is
visible through its typed invalid lineage. Claims do not alter the recurrence
group key, Candidate content digest, review matrix, pack governance snapshot,
proposal admission, publication, authority, utility or efficacy. Pack receipts
remain `not_assessed/candidate_claims_deferred` in this slice.

### Candidate

```ts
export type RiskTier = "T0" | "T1" | "T2" | "T3";

export interface CandidateIntervention {
  readonly destinationId: string;
  readonly kind: string;
  readonly content: JsonValue;
  readonly rollbackIntent: string;
}

interface EvidenceRefCommon {
  readonly recordId: string;
  readonly recordDigest: string;
  readonly sourceId: string;
  readonly sourceRegistrationRevision: string;
  readonly sourceRef: string;
  readonly sourceRevision: string;
  readonly sourceRecordId: string;
  readonly pageRef: string;
  readonly pageReceiptId: string;
  readonly pageReceiptDigest: string;
  readonly loopRegistryRevision: string;
  readonly trust: TrustClass;
  readonly completeness: Provenance["completeness"];
  readonly episode: {
    readonly sourceId: string;
    readonly episodeId: string;
    readonly episodeRecordId: string;
    readonly episodeRecordDigest: string;
    readonly episodeIdentityDigest: string;
    readonly scopeDigest: string;
    readonly pageReceiptId: string;
    readonly pageReceiptDigest: string;
  };
}

export interface EvidenceRefV1 extends EvidenceRefCommon {
  readonly schemaVersion: 1;
  readonly kind: "observation" | "measurement";
  readonly referenceDigest: string;
}

export type ObservationEvidenceRef = EvidenceRefV1 & {
  readonly kind: "observation";
};

export interface MeasurementEvidenceRefV2 extends EvidenceRefCommon {
  readonly schemaVersion: 2;
  readonly kind: "measurement";
  readonly supportingEvidenceRefs: readonly ObservationEvidenceRef[];
  readonly referenceDigest: string;
}

export type EvidenceRef = EvidenceRefV1 | MeasurementEvidenceRefV2;

export declare function evidenceRefDigest(
  input:
    | Omit<EvidenceRefV1, "schemaVersion" | "referenceDigest">
    | Omit<MeasurementEvidenceRefV2, "referenceDigest">,
): string;

export declare function parseEvidenceRef(input: unknown): EvidenceRef;

export interface CandidateV1 {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly scope: Scope;
  readonly problem: string;
  readonly hypothesis: string;
  readonly evidenceIds: readonly string[];
  readonly intervention: CandidateIntervention;
  readonly proposedRisk: RiskTier;
  readonly proposedBy: PrincipalRef;
  readonly proposerAttestationDigest: string;
  readonly proposedAt: string;
  readonly contentDigest: string;
  readonly supersedes?: string;
}

export type CandidateV2 = {
  readonly schemaVersion: 2;
  readonly id: string;
  readonly scope: Scope;
  readonly problem: string;
  readonly hypothesis: string;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly derivationRef?: {
    readonly id: string;
    readonly digest: string;
  };
  readonly intervention: CandidateIntervention;
  readonly proposedRisk: RiskTier;
  readonly proposedBy: PrincipalRef;
  readonly proposerAttestationDigest: string;
  readonly proposedAt: string;
  readonly contentDigest: string;
} & (
  | {
      readonly supersedes?: never;
      readonly originalDigest?: never;
    }
  | {
      readonly supersedes: string;
      readonly originalDigest: string;
    }
);

export type Candidate = CandidateV1 | CandidateV2;

export type CandidateDigestInput =
  | {
      readonly scope: Scope;
      readonly problem: string;
      readonly hypothesis: string;
      readonly evidenceIds: readonly string[];
      readonly intervention: CandidateIntervention;
      readonly proposedRisk: RiskTier;
      readonly supersedes?: string;
    }
  | ({
      readonly schemaVersion: 2;
      readonly scope: Scope;
      readonly problem: string;
      readonly hypothesis: string;
      readonly evidenceRefs: readonly EvidenceRef[];
      readonly derivationRef?: {
        readonly id: string;
        readonly digest: string;
      };
      readonly intervention: CandidateIntervention;
      readonly proposedRisk: RiskTier;
    } & (
      | {
          readonly supersedes?: never;
          readonly originalDigest?: never;
        }
      | {
          readonly supersedes: string;
          readonly originalDigest: string;
        }
    ));

export declare function candidateContentDigest(input: CandidateDigestInput): string;
export declare function parseCandidate(input: unknown): Candidate;
```

Schema-version-1 `EvidenceRef.referenceDigest` bytes remain unchanged and bind
every field except the schema marker and digest itself. Schema-version-2
measurement references include `schemaVersion: 2` for domain separation and
bind every common field plus every complete supporting observation reference
in order; only `referenceDigest` is excluded. References are not caller
assertions: the kernel constructs them after loading and parsing the exact
records, same-source episode record and identity claim, and source-page
receipts. An evidence record and episode may have different page receipts.
`recordId` must be exactly
`${sourceId}/${sourceRecordId}`; the episode record must belong to that source;
`pageReceiptId` must equal `source-page-${pageReceiptDigest}`; and
`episode.pageReceiptId` must equal
`source-page-${episode.pageReceiptDigest}`. The reference is refused if any
derivative tuple, digest, registration or loop revision, source/page/revision
identity, episode identity, or scope binding is missing, corrupt, ambiguous,
or inconsistent. The composite resolver compares record, receipt, episode,
identity, source-revision, and evidence-health namespace revisions before and
after the fold and retries on change; an append-visible mixture is never
reported as one stable evidence result.

Every digest in an `EvidenceRef` is a 64-character lower-case SHA-256 value.
`episode.scopeDigest` is the digest of protocol-canonical JSON for the exact
ordered candidate scope segments `{ type, id }`. Source, revision, record and
page references retain decision 0004's bounded, control-free, already
privacy-treated rules; a reference is lineage, not a new trust grant.

`MeasurementEvidenceRefV2.supportingEvidenceRefs` is nonempty, ordered, capped
at 1,000 entries, and unique by both reference digest and durable record id. Every support is a
schema-version-1 observation reference with the same source id, source
registration revision, privacy-treated source reference, source revision,
loop registry revision, and exact episode record, identity, scope, and episode
receipt as the measurement. Its own observation page may differ. Minting
resolves the measurement's ordered `evidenceIds` exactly; missing, extra,
ambiguous, cross-source, cross-revision, cross-episode, corrupt, or duplicate
citations refuse qualification. A v1 measurement reference remains parseable
audit history but is unqualified.

Candidate v1 canonical bytes and digest semantics remain unchanged. They bind
the existing scope, problem, hypothesis, ordered `evidenceIds`, intervention,
risk, and optional `supersedes` fields. Candidate v2 is domain-separated: its
digest includes `schemaVersion: 2`, scope, problem, hypothesis, every complete
`EvidenceRef` in order, optional `derivationRef`, intervention, risk, and the
optional `supersedes`/`originalDigest` pair. Candidate identity, proposer
attribution, proposal time, and the digest field itself remain outside both
content digests. Cosmetic display metadata, if any, stays outside the binding
or is clearly classified. A revised candidate receives a new digest and cannot
reuse a prior review or authorization silently.

`CandidateV2.evidenceRefs` are unique both by `referenceDigest` and by
`(kind, recordId)`. Manual Candidate v2 requires a nonempty list. An exact
`derivationRef` permits an empty list only for a store-resolved, committed,
currently configured, evidence-health-ready derivation with a nonempty exact
episode population. The parser enforces nonempty evidence or a derivationRef;
the store-backed resolver enforces the population condition. Combined direct
and contradictory derivation evidence remains duplicate-free. `parseCandidate`
and `propose` also recompute the Candidate scope digest and require it to equal
every reference's `episode.scopeDigest`.

An optional `derivationRef` binds a separately durable derivation artifact by
exact id and digest; its id is exactly `insight-${digest}`. Ordinarily it
records how evidence was selected or transformed alongside full evidence
references. The sole replacement exception is an empty EvidenceRef list backed
by the exact committed episode population above. It grants no trust and does
not make a generator authoritative.

The derivation-backed propose branch accepts only candidate id, mandatory exact
scope locator, derivation id, proposed risk, verified proposer, and optional
Candidate predecessor. The kernel resolves the scope-partitioned derivation
index and requires committed, currently configured, evidence-health-ready
lineage with non-null interpretation, impact hypothesis, intervention, and
validation. It derives problem from `interpretation.statement`, hypothesis
from `impactHypothesis.statement`, and EvidenceRefs from direct observation
followed by contradictory evidence in exact order. Destination id, kind,
content, and rollback intent map from the Candidate intervention draft and must
all be concrete. Caller-supplied semantic overrides are refused.

V2 requires `supersedes` and `originalDigest` either both to be present or both
absent. On explicit re-proposal the caller supplies only `supersedes`; the
kernel loads the exact predecessor and derives `originalDigest`. Re-proposal
uses a new candidate id and requires the predecessor to have the exact same
scope. Cross-project or cross-isolation supersession needs a separately
ratified policy path; it is never inferred from this field. The successor is
new governance content, not a record migration, and carries forward no review,
approval, authorization, or authority. Reads revalidate the predecessor id,
digest, and scope before treating the lineage as intact.

For a derivation-backed Candidate, Candidate and derivation supersession mirror
exactly: each is present if and only if the other is present. The Candidate
predecessor must carry a derivationRef equal to the derivation predecessor id
and digest. A manual predecessor or mismatched chain is refused rather than
silently bridging semantic and governance revision history.

`proposedRisk` is advisory. The engine computes effective risk as the monotonic maximum of the proposal, the host-registered destination floor, content classification and policy rules. `T0 < T1 < T2 < T3`; neither an adapter nor a proposer can lower the host result.

Schema-version-1 candidates are permanently classified `legacy_unbound` and
are audit-only. Their bare `evidenceIds` are never reinterpreted through later
receipts, and reads, re-ingestion, startup, or package upgrades never rewrite
or auto-migrate them. They cannot become publication-eligible, active context,
or evidence-backed behavioral claims. Existing v1 reviews remain historical
audit records only.

Candidate proposal may resolve observations and schema-version-2 measurement
references. A measurement is eligible only when its exact reference is a
member of the latest resolved outcome claim for its episode and its folded
evidence health permits use. A receipt or historical claim alone never makes a
measurement eligible. A referenced `blocks_use` evidence-health finding
refuses proposal resolution; `limits_claims` and `blocks_audit` remain explicit
review and claim constraints rather than silently becoming evidence.

### Review

```ts
export type ReviewDisposition =
  | "accept"
  | "revise"
  | "reject"
  | "escalate";

export interface CandidateReview {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly candidateId: string;
  readonly candidateDigest: string;
  readonly reviewer: PrincipalRef;
  readonly reviewerAttestationDigest: string;
  readonly reviewerImplementation: {
    readonly id: string;
    readonly version: string;
    readonly calibrationDigest?: string;
  };
  readonly disposition: ReviewDisposition;
  readonly findings: readonly {
    readonly code: string;
    readonly severity: "info" | "warning" | "blocking";
    readonly message: string;
  }[];
  readonly reviewedAt: string;
}
```

The engine accepts reviewer identity only from a `VerifiedPrincipal` handle and
refuses a decisive self-review. For a derivation-backed Candidate it also
refuses the derivation producer principal and the same producer implementation
id/version. The lens's mandatory producer-independence rule always requires a
different domain from a non-null derivation producer; Candidate-proposer domain
separation remains gated by host risk policy. Policy may additionally require
a human reviewer, multiple reviewers, or a calibrated reviewer version. An
`accept` with a blocking finding is invalid.
Only a v2 candidate with `ready` evidence reaches the reviewer port; raw or
legacy evidence ids never resolve at review time. The engine captures reviewer
attribution once, passes detached parsed Candidate and exact
`InsightDerivation | null` copies, binds the result to the captured Candidate
id/digest, and revalidates Candidate, mirrored supersession, derivation
lineage, producer independence, and evidence after the external callback
before writing. An occupied review id is
returned only for the same captured binding and reviewer registration;
otherwise it conflicts before another callback or disclosure.
Governance reads bind each stored review's inner id to its store key and
re-run review structural validity, proposer/producer/reviewer independence,
and the current risk tier's independence-domain rule. A forged or internally
invalid stored acceptance is typed store corruption, never a decisive review.

### Publication plan and authorization binding

Publication and activation are not the same operation. A destination may publish an inert ticket or draft without making agent context active.

```ts
export type EffectClass =
  | "proposal"
  | "context"
  | "external"
  | "authority";

export type AfterEffectSemantics =
  | { readonly kind: "disable"; readonly payload: JsonValue }
  | { readonly kind: "rollback"; readonly payload: JsonValue }
  | { readonly kind: "compensate"; readonly payload: JsonValue }
  | { readonly kind: "irreversible"; readonly rationale: string };

export interface PreparedEffect {
  readonly id: string;
  readonly kind: string;
  readonly target: string;
  readonly expectedBase?: string;
  readonly payload: JsonValue;
  readonly payloadDigest: string;
  readonly afterEffect: AfterEffectSemantics;
}

export interface PublicationPlan {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly candidateId: string;
  readonly candidateDigest: string;
  readonly destinationId: string;
  readonly action: "publish" | "disable" | "rollback" | "compensate";
  readonly effectClass: EffectClass;
  readonly effectiveRisk: RiskTier;
  readonly effects: readonly PreparedEffect[];
  readonly planDigest: string;
  readonly policyDigest: string;
  readonly createdAt: string;
}

export interface AuthorizationBinding {
  readonly planDigest: string;
  readonly candidateDigest: string;
  readonly destinationId: string;
  readonly effectClass: EffectClass;
  readonly effectiveRisk: RiskTier;
  readonly action: PublicationPlan["action"];
  readonly expectedBases: readonly string[];
  readonly policyDigest: string;
}

export interface VerifiedAuthorization {
  readonly id: string;
  readonly principal: PrincipalRef;
  readonly principalAttestationDigest: string;
  readonly bindingDigest: string;
  readonly authorizedAt: string;
  readonly expiresAt?: string;
}
```

The host supplies opaque authorization evidence to its authority adapter. The core receives only a verified, exact binding. If content, base, destination, risk-relevant metadata, or policy changes, the binding changes and the authorization is unusable.

Disable, rollback and compensation use new content-bound `PublicationPlan` records and the same policy, authority and journal path as initial publication. They are never direct adapter calls. A context destination must provide disable or rollback. An outward proposal may provide compensation, such as closing a ticket. An irreversible destination must declare that fact and therefore receives the host's corresponding risk floor.

### Intervention, exposure, and efficacy

Do not compress these dimensions into one lifecycle enum. They answer different questions.

```ts
export interface InterventionState {
  readonly publication:
    | "unpublished"
    | "published"
    | "failed"
    | "rolled_back";
  readonly authorization:
    | "not_required"
    | "pending"
    | "authorized"
    | "revoked"
    | "expired";
  readonly activation:
    | "inactive"
    | "active"
    | "disabled";
  readonly validation:
    | "untested"
    | "invalid"
    | "inconclusive"
    | "improved"
    | "regressed";
}

export interface InterventionRecord {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly candidateId: string;
  readonly planId: string;
  readonly parentInterventionId?: string;
  readonly state: InterventionState;
  readonly publicationReceiptIds: readonly string[];
  readonly authorizationIds: readonly string[];
  readonly evaluationIds: readonly string[];
  readonly latestTransitionId: string;
}

export interface InterventionTransition {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly interventionId: string;
  readonly from: InterventionState;
  readonly to: InterventionState;
  readonly evidenceIds: readonly string[];
  readonly occurredAt: string;
}

export interface ExposureEntry {
  readonly interventionId: string;
  readonly resolvedContentDigest: string;
}

export interface ExposureSetRecord {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly episodeId: string;
  readonly resolutionReceiptId: string;
  readonly entries: readonly ExposureEntry[];
  readonly assignmentId: string;
  readonly experiment?: {
    readonly experimentId: string;
    readonly arm: "control" | "treatment";
  };
  readonly fingerprintId: string;
  readonly evidenceIds: readonly string[];
  readonly exposedAt: string;
}
```

An intervention may be published but inactive, authorized but untested, active but inconclusive, or disabled after regression. Pairwise-distinct fields make false claims harder than a convenient “approved” status. State history is append-only: the engine folds `InterventionTransition` records into the current view.

The legal-transition table is part of the protocol. At minimum, it forbids active plus unpublished, improved without a bound improved evaluation, and publication using authority that was pending, expired or revoked at consumption time. Whether later revocation requires automatic disable is an explicit host policy and preauthorized effect, not an implied transition. Disable, rollback and compensation create transitions and receipts; they never rewrite the prior state. One resolution containing several interventions produces one exposure set with one entry per exact intervention.

### Fingerprint and experiment

The generic fingerprint is a digest of named, canonical host components. Cormidia can supply package version, repository state, model, effort, prompts, tools, policy, budget, and app configuration without making those fields universal.

```ts
export interface FingerprintComponent {
  readonly name: string;
  readonly version?: string;
  readonly digest: string;
}

export interface SystemFingerprint {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly components: readonly FingerprintComponent[];
  readonly digest: string;
}

export interface ExperimentDefinition {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly hypothesis: string;
  readonly interventionId: string;
  readonly eligibilityPolicyDigest: string;
  readonly eligibilitySetDigest: string;
  readonly baselineSnapshotDigest: string;
  readonly controlFingerprintDigest: string;
  readonly treatmentFingerprintDigest: string;
  readonly primaryMetric: {
    readonly definition: MetricDefinition;
    readonly direction: "higher" | "lower";
    readonly minimumUsefulEffect: number;
    readonly perEpisodeAggregation: string;
    readonly missingnessRuleDigest: string;
  };
  readonly guardrails: readonly {
    readonly metric: MetricDefinition;
    readonly rule: "must_not_regress" | "must_pass" | "maximum";
    readonly threshold?: number;
  }[];
  readonly fixtureSetDigest: string;
  readonly graderDigest: string;
  readonly decisionRuleDigest: string;
  readonly pairCount: number;
  readonly repetitionsPerPair: number;
  readonly costCeiling?: Money;
  readonly stoppingRuleDigest: string;
  readonly replayExecutorDigest: string;
  readonly sideEffectPolicyDigest: string;
  readonly assignmentAndBlindingDigest: string;
  readonly declaredAt: string;
  readonly definitionDigest: string;
}

export interface Money {
  readonly amount: number;
  readonly currency: string;
  readonly normalizationPolicyDigest?: string;
}
```

An evaluation result records every attempted arm and classifies missing, drifted, contaminated, or guardrail-regressing evidence explicitly. The episode is the independent unit; repetitions are nested within it. The core does not invent a universal statistical threshold. Policy supplies content-bound decision rules and versioned evaluators.

The host executor, not the kernel, enforces workspace isolation and side effects. The kernel verifies that a registered executor and its returned attestation match the predeclared digests. Identifiers alone are never enough to freeze an eligibility rule, grader, executor, fixture set, stopping rule or side-effect policy.

## Ports

### Evidence source

```ts
export interface ProjectedObservation {
  readonly sourceRecordId: string;
  readonly episodeId: string;
  readonly occurredAt?: string;
  readonly kind: string;
  readonly data: JsonValue;
  readonly completeness: "complete" | "partial" | "unknown";
}

export interface ProjectedMeasurement {
  readonly sourceRecordId: string;
  readonly episodeId: string;
  readonly metric: MetricDefinition;
  readonly value: number | string | boolean;
  readonly evidenceSourceRecordIds: readonly string[];
  readonly measuredAt?: string;
}

export interface ProjectedEpisode {
  readonly sourceRecordId: string;
  readonly episodeId: string;
  readonly parentEpisodeId?: string;
  readonly episodeClass?: string;
  readonly scope: Scope;
  readonly openedAt: string;
  readonly closedAt?: string;
  readonly status?: EpisodeOutcome["status"];
  readonly measurementSourceRecordIds: readonly string[];
  readonly completeness?: "complete" | "partial" | "unknown";
}

export interface EvidencePage {
  readonly sourceRef: string;
  readonly pageRef: string;
  readonly state:
    | {
        readonly status: "available";
        readonly sourceRevision: string;
        readonly completeness: "complete" | "partial" | "unknown";
      }
    | {
        readonly status: "missing" | "unreadable" | "unsupported" | "corrupt";
        readonly observedRevision?: string;
      };
  readonly nextCursor?: string;
  readonly observations: readonly ProjectedObservation[];
  readonly measurements: readonly ProjectedMeasurement[];
  readonly episodes: readonly ProjectedEpisode[];
  readonly diagnostics: readonly Diagnostic[];
}

export interface SourcePageReceipt {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly sourceId: string;
  readonly sourceRegistrationRevision: string;
  readonly adapterVersion: string;
  readonly contentPolicyId: string;
  readonly contentPolicyDigest: string;
  readonly loopRegistryRevision: string;
  readonly sourceRef: string;
  readonly pageRef: string;
  readonly state: EvidencePage["state"];
  readonly derivatives: readonly {
    readonly kind: "observation" | "measurement" | "episode";
    readonly id: string;
    readonly digest: string;
  }[];
  readonly projectionCounts: {
    readonly observations: number;
    readonly measurements: number;
    readonly episodes: number;
    readonly rejected: number;
    readonly reused?: number;
  };
  readonly diagnosticCounts: readonly {
    readonly code: string;
    readonly severity: Diagnostic["severity"];
    readonly count: number;
  }[];
  readonly healthFindingIds: readonly string[];
  readonly receiptDigest: string;
}

export interface EvidenceHealthFinding {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly code:
    | "source.missing"
    | "source.unreadable"
    | "source.unsupported"
    | "source.corrupt"
    | "source.partial"
    | "source.revision_changed"
    | "source.record_rejected"
    | "source.content_policy_refused"
    | "source.adapter_diagnostic"
    | "source.ownership_mismatch";
  readonly effect: "limits_claims" | "blocks_audit" | "blocks_use";
  readonly sourceId: string;
  readonly sourceRegistrationRevision: string;
  readonly sourceRef: string;
  readonly pageRef: string;
  readonly completeness: "complete" | "partial" | "unknown";
  readonly affectedRecords: number;
  readonly findingDigest: string;
}

export interface ImportReceipt {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly sourceId: string;
  readonly sourceRegistrationRevision: string;
  readonly loopRegistryRevision: string;
  readonly pageReceiptIds: readonly string[];
  readonly sourceRevisions: readonly string[];
  readonly completeness: "complete" | "partial" | "unknown";
  readonly healthFindingIds: readonly string[];
  readonly receiptDigest: string;
}

export declare function parseSourcePageReceipt(input: unknown): SourcePageReceipt;
export declare function parseEvidenceHealthFinding(input: unknown): EvidenceHealthFinding;
export declare function parseImportReceipt(input: unknown): ImportReceipt;

export interface EvidenceSource<I> {
  readonly descriptor: SourceDescriptor;

  probe(input: I): Promise<{
    readonly supported: boolean;
    readonly sourceRevision?: string;
    readonly diagnostics: readonly Diagnostic[];
  }>;

  read(
    input: I,
    cursor?: string,
  ): AsyncIterable<EvidencePage>;
}

declare const registeredSourceBrand: unique symbol;

export interface RegisteredSource<I> {
  readonly id: string;
  readonly registryRevision: string;
  readonly trustCeiling: TrustClass;
  readonly contentPolicyId: string;
  readonly [registeredSourceBrand]: I;
}

export declare function defineSourceRegistration<I>(input: {
  readonly source: EvidenceSource<I>;
  readonly trustCeiling: TrustClass;
  readonly contentPolicyId: string;
}): RegisteredSource<I>;
```

The host binds the adapter to a `trustCeiling` and content policy before constructing the loop. The resulting capability preserves its input type, so `learning.ingest(source, input)` cannot accept another source's input. The registry is immutable and content-digested; changing it creates a new loop configuration revision. Registered source ids must not contain `/`, which is the reserved separator between the source id and an opaque source-record id in schema-version-1 durable record ids. The engine adds canonical digests, stable IDs, effective trust, import receipts, and idempotency. The adapter never receives network, authority, publication or active-context capabilities.

Projection source-record ids, logical episode ids, observation kinds, metric names, parent ids, and episode classes are bounded to 1,000 control-free characters at ingestion. This keeps every accepted value addressable by the bounded query surface; durable ids may be longer because they frame a source id and source-record id. `ProjectedEpisode.completeness` is the adapter's assessment of that episode projection. An omitted value is `unknown`, never an implied complete record. `parentEpisodeId` records provider-neutral parent/child lineage, and `episodeClass` is a host-defined applicability label such as an interactive, automation, benchmark, or replay class. Both are data, not authority; adapters omit them rather than guess.

`sourceRef` and `pageRef` are bounded, control-free, opaque identifiers that
the adapter has already made safe to persist. A private or low-entropy locator
uses a tenant-scoped keyed digest; raw paths and native private identifiers do
not enter a receipt. An `available` page may be empty and says that the adapter
observed no projections. A `missing`, `unreadable`, `unsupported`, or `corrupt`
page must contain no projections. `observedRevision` is present only when the
adapter could authenticate exact bytes despite being unable to project them;
absence is unknown evidence, never an implied revision.

The engine persists accepted derivatives first, closed evidence-health
findings second, and the `SourcePageReceipt` last. The receipt is the commit
marker: derivatives without their valid receipt are incomplete. Receipt and
finding ids are deterministic functions of `receiptDigest` and
`findingDigest`. The page receipt binds exactly the source registration
revision, adapter version, content-policy id and digest, loop registry
revision, source/page references, state, ordered derivative
`(kind, id, digest)` tuples, projection counts (including rejected and reused records),
normalized diagnostic counts, and health-finding ids. `schemaVersion`, `id`,
and `receiptDigest` are excluded. Counts are non-negative safe integers and
must satisfy `derivatives.length + rejected + reused = total projections`,
where an omitted historical `reused` is zero. Valid projections already
committed by another exact page receipt increment `reused` and do not add an
ambiguous second derivative tuple. Historical omission is preserved in parsed
records and digest bytes; new ingest receipts include the field only when it
is nonzero, so an idempotent historical page reproduces its original bytes.
Before a derivative record is created, the engine atomically claims its one
source/page and content-policy/loop owner in a private create-only cell
(bootstrapping from a historical committed receipt). Concurrent different
pages cannot both commit
the tuple: one receipt owns it and the other counts reuse. The private claim is
not a receipt or authority; if its owner page never commits, the derivative
remains incomplete until that exact page is retried.
Diagnostic tuples are sorted by code then
severity, unique, and carry positive safe-integer counts; they never contain a
message, path, raw details, or source content. Every derivative id must use the
receipt source's schema-version-1 `<sourceId>/<sourceRecordId>` prefix, and a
page cannot bind the same `(kind, id)` tuple twice.

An evidence-health `findingDigest` binds exactly `code`, `effect`, `sourceId`,
`sourceRegistrationRevision`, `sourceRef`, `pageRef`, `completeness`, and
`affectedRecords`; `schemaVersion`, `id`, and `findingDigest` are excluded.
`affectedRecords` is a non-negative safe integer. `limits_claims` requires
downstream claims to state the finding's constraint, `blocks_audit` excludes
the affected evidence from audit-grade comparisons, and `blocks_use` refuses
the affected derivatives. None of these effects creates a learning candidate.
`source.ownership_mismatch` is always a `blocks_use` finding: a citation,
measurement, episode, or outcome that crosses its exact source/episode lineage
cannot be qualified by policy.

Revision claims are append-only per exact source registration, `sourceRef`,
and `pageRef`. An authenticated `observedRevision` on an unavailable page is a
claim just like an available `sourceRevision`; it cannot be bypassed by later
calling the same bytes available under a different revision. Repeating the
same revision is idempotent. A second distinct revision records
`source.revision_changed`, persists a receipt with no derivatives from the
unverifiable claim, and refuses those derivatives rather than guessing that
the source intentionally superseded its prior bytes. Explicit supersession
and deletion lineage is a later issue #31 slice.

An `ImportReceipt` is a durable, deterministic fold of committed page
receipts. `receiptDigest` binds every field except `schemaVersion`, `id`, and
`receiptDigest`; `pageReceiptIds` preserves source order, while
`sourceRevisions` is the sorted unique set of available and observed exact
revisions. The content-addressed page receipts transitively bind their adapter,
content-policy, derivative, count, and diagnostic lineage. Re-ingesting
identical committed pages under the same source and loop registrations
produces the same import id and bytes. Receipts and findings are
evidence-health records, not behavioral detector results, candidates,
authority, or efficacy evidence.

### Storage

The engine should depend on concurrency-explicit primitives and validate all returned values from `unknown`.

```ts
export interface RecordKey {
  readonly namespace: string;
  readonly kind: string;
  readonly id: string;
}

export interface StoredRecord {
  readonly key: RecordKey;
  readonly value: unknown;
  readonly revision: string;
  readonly digest: string;
}

export interface StreamEntry {
  readonly id: string;
  readonly digest: string;
  readonly value: JsonValue;
}

export type WriteResult =
  | { readonly status: "created" | "updated"; readonly revision: string }
  | { readonly status: "exists_same"; readonly revision: string }
  | { readonly status: "conflict"; readonly revision?: string };

export interface LearningStore {
  get(key: RecordKey): Promise<StoredRecord | undefined>;

  create(
    key: RecordKey,
    value: JsonValue,
    digest: string,
    operationId: string,
  ): Promise<WriteResult>;

  compareAndSet(
    key: RecordKey,
    expectedRevision: string,
    value: JsonValue,
    digest: string,
    operationId: string,
  ): Promise<WriteResult>;

  append(
    stream: RecordKey,
    expectedRevision: string | undefined,
    entries: readonly StreamEntry[],
    operationId: string,
  ): Promise<WriteResult>;

  tombstone(input: {
    readonly key: RecordKey;
    readonly expectedRevision: string;
    readonly reasonCode: string;
    readonly operationId: string;
  }): Promise<WriteResult>;

  list(query: {
    readonly namespace: string;
    readonly kind?: string;
    readonly cursor?: string;
    readonly limit: number;
  }): Promise<{
    readonly records: readonly StoredRecord[];
    readonly nextCursor?: string;
    readonly snapshotRevision: string;
  }>;
}
```

The exact low-level shape should be confirmed in an implementation spike. The non-negotiable semantics are create-only conflict detection, expected-revision updates, ordered append, stable entry and operation identifiers, idempotent same-content retry after an unacknowledged success, namespace isolation, consistent bounded listing, tombstones and explicit corruption. Store values still cross the engine as `unknown` and are parsed by record kind. A last-writer-wins implementation does not pass the public conformance suite.

### Authority

```ts
export interface AuthorityPort {
  verify(input: {
    readonly evidence: unknown;
    readonly binding: AuthorizationBinding;
  }): Promise<
    | {
        readonly status: "authorized";
        readonly authorization: VerifiedAuthorization;
      }
    | {
        readonly status: "pending" | "denied" | "invalid" | "expired";
        readonly diagnostics: readonly Diagnostic[];
      }
  >;
}
```

The adapter authenticates principals and maps host approvals. The kernel checks binding equality, expiry, policy, consumption, lifecycle, and idempotency. Hosts with transactional approval consumption can expose reservation and commit hooks as an advanced interface; the first contract should not pretend to provide a distributed transaction across an arbitrary approval service and destination.

### Publication destination

```ts
export interface PublicationDestination {
  readonly id: string;

  prepare(input: {
    readonly candidate: Candidate;
    readonly expectedBase?: string;
  }): Promise<readonly PreparedEffect[]>;

  applyEffect(input: {
    readonly effect: PreparedEffect;
    readonly idempotencyKey: string;
  }): Promise<PublicationReceipt>;
}

export interface PublicationReceipt {
  readonly destinationId: string;
  readonly effectId: string;
  readonly target: string;
  readonly expectedBase?: string;
  readonly finalVersion?: string;
  readonly payloadDigest: string;
  readonly idempotencyKey: string;
  readonly appliedAt: string;
}

export interface DestinationRegistration {
  readonly adapter: PublicationDestination;
  readonly effectClass: EffectClass;
  readonly riskFloor: RiskTier;
  readonly permittedTargetPatterns: readonly string[];
  readonly authorizationRuleId: string;
  readonly contentPolicyId: string;
}
```

The host, not adapter code, registers immutable effect class, risk floor, permitted targets, authority and content policy. The engine computes effective risk by monotonic maximum. `prepare` is side-effect-free. Adapters parse any external `unknown` internally and return standardized effects and receipts; their conformance suite verifies those claims. The core canonicalizes prepared effects and binds authorization before `applyEffect`. A receipt proves destination, target, payload digest, base and final version, effect ID and idempotency key.

Rollback is intentionally absent from the direct port. Disable, rollback and compensation are new bound plans executed through the same `applyEffect`, policy, authority and journal path.

The default root package should ship no destination that silently edits prompts, permissions, external systems, or source repositories.

### Semantic judgment

```ts
export interface CandidateGenerator {
  readonly id: string;
  readonly version: string;
  readonly principal: VerifiedPrincipal;

  generate(input: {
    readonly episodes: readonly EpisodeRecord[];
    readonly observations: readonly Observation[];
    readonly existingCandidates: readonly Candidate[];
    readonly budget: { readonly maximumInputTokens: number };
  }): Promise<unknown>;
}

export interface CandidateReviewer {
  readonly id: string;
  readonly version: string;
  readonly principal: VerifiedPrincipal;
  readonly calibrationDigest?: string;

  review(input: {
    readonly candidate: Candidate;
    readonly evidence: readonly (Observation | MeasurementRecord)[];
    readonly derivation: InsightDerivation | null;
    readonly policyDigest: string;
  }): Promise<unknown>;
}
```

The optional `/workflows` package validates both results and records exact provider, model, prompt, tool policy, and budget fingerprints. The kernel does not label an uncalibrated reviewer trustworthy merely because it returned valid JSON.

### Replay and outcomes

```ts
export interface ReplayExecutor {
  readonly id: string;
  readonly version: string;
  readonly registrationDigest: string;

  attempt(input: ReplayAttemptRequest): Promise<unknown>;
}

export interface ReplayAttemptRequest {
  readonly experimentId: string;
  readonly episodeId: string;
  readonly arm: "control" | "treatment";
  readonly repetition: number;
  readonly fingerprintDigest: string;
  readonly fixtureDigest: string;
  readonly sideEffectCapability: {
    readonly policyDigest: string;
    readonly denyByDefault: true;
    readonly attestationNonce: string;
  };
  readonly budget: {
    readonly maximumCost?: Money;
    readonly maximumDurationMs?: number;
  };
}

export interface OutcomeSource<I> {
  readonly descriptor: SourceDescriptor;

  measure(input: I): Promise<unknown>;
}

declare const registeredOutcomeSourceBrand: unique symbol;

export interface RegisteredOutcomeSource<I> {
  readonly id: string;
  readonly registryRevision: string;
  readonly trustCeiling: "observed" | "verified";
  readonly contentPolicyId: string;
  readonly permittedMetricDigests: readonly string[];
  readonly [registeredOutcomeSourceBrand]: I;
}

export declare function defineOutcomeSourceRegistration<I>(input: {
  readonly source: OutcomeSource<I>;
  readonly trustCeiling: "observed" | "verified";
  readonly contentPolicyId: string;
  readonly permittedMetricDigests: readonly string[];
}): RegisteredOutcomeSource<I>;
```

The executor owns restoring the environment, enforcing the deny-by-default side-effect policy, hiding fixtures, and running the agent. It returns a parsed attempt plus an attestation to the declared policy. The core cannot sandbox arbitrary host code; it verifies registration and attestation digests, detects fingerprint drift, applies frozen decision rules, and retains every attempt.

Outcome sources are registered with the same host-owned trust and content-policy mechanism as evidence sources. Their opaque results parse into `MeasurementRecord` values with episode identity, metric definition, provenance, completeness and evidence. An outcome source cannot self-assign trust, and the façade never returns unscoped bare measurements.

### Time, identifiers, and the outbox

```ts
export interface Clock {
  now(): string;
}

export interface IdGenerator {
  next(namespace: string): string;
}
```

Time and IDs are injectable for deterministic tests. Canonical serialization and cryptographic content digests are not replaceable per host. Version 1 should not expose a fallible event-sink callback inside state transitions. Typed post-commit domain events go to a durable outbox in `LearningStore` with deterministic IDs and at-least-once delivery; consumers deduplicate. A convenience sink may be added outside the transactional engine later.

## The façade

The loop configuration is immutable. Sources, outcomes, destinations, identity, content policies, scope policy, the optional semantic registry, detector implementations and detector-orchestration policy, replay executors and decision rules are composed before `createLearningLoop`; the engine binds their registry digest into plans, resolutions and fingerprints. Construction parses and snapshots policy metadata/rules, content-policy metadata/behavior, source registration/adapter behavior, scope-policy metadata/behavior, semantic records, exact detector capability metadata/callbacks, and orchestration-policy content; later mutation of caller-owned configuration objects cannot change runtime decisions under the same registry revision. The identity contribution contains exactly its public `{ id, version, configurationDigest, registrationDigest }` metadata, while exact-instance identity and detector runtime tokens remain private and process-local. A configuration change creates a new registry revision. `createLearningLoop` rejects structurally similar identity or detector capability objects not created by their kernel factories. If `semanticRegistry` is present, only its exact `registryDigest` contributes after full parsing and source/scope reconciliation. Detector implementation presence contributes its sorted exact capability registration. A configured detector-orchestration policy contributes exact `{ policyDigest }`. Omitting any optional dimension preserves its prior registry bytes.

```ts
export interface LearningPolicy {
  readonly id: string;
  readonly digest: string;
}

export interface LearningLoopConfig {
  readonly store: LearningStore;
  readonly policy: LearningPolicy;
  readonly identity: IdentityPort;
  readonly scopePolicy: ScopePolicy;
  readonly contentPolicies: readonly ContentPolicy[];
  readonly sources: readonly RegisteredSource<unknown>[];
  readonly semanticRegistry?: SemanticRegistryConfig;
  readonly detectorImplementations?: readonly RegisteredDetectorImplementation[];
  readonly detectorOrchestrationPolicy?: DetectorOrchestrationPolicy;
  readonly queryCursorScope?: string;
  readonly outcomeSources?: readonly RegisteredOutcomeSource<unknown>[];
  readonly destinations?: readonly DestinationRegistration[];
  readonly replayExecutors?: readonly ReplayExecutor[];
  readonly clock?: Clock;
  readonly ids?: IdGenerator;
}


export declare function createLearningLoop(config: LearningLoopConfig): LearningLoop;

export type EpisodeInput = Omit<
  EpisodeRecord,
  "schemaVersion" | "sourceRefs" | "fingerprintId" | "exposureIds"
>;

interface CandidateInputCommon {
  readonly id: string;
  readonly proposedRisk: RiskTier;
  readonly proposedBy: VerifiedPrincipal;
  readonly supersedes?: string;
}

export type CandidateInput =
  | (CandidateInputCommon & {
      readonly scope: Scope;
      readonly problem: string;
      readonly hypothesis: string;
      readonly evidenceIds: readonly string[];
      readonly intervention: CandidateIntervention;
      readonly derivationId?: never;
    })
  | (CandidateInputCommon & {
      readonly scope: Scope;
      readonly derivationId: string;
      readonly problem?: never;
      readonly hypothesis?: never;
      readonly evidenceIds?: never;
      readonly intervention?: never;
    });

export interface CandidateReviewInput {
  readonly id: string;
  readonly candidateId: string;
  readonly reviewer: CandidateReviewer;
}

export interface IngestReceipt {
  readonly id: string;
  readonly sourceId: string;
  readonly sourceRevisions: readonly string[];
  readonly pageReceiptIds: readonly string[];
  readonly importReceipt: ImportReceipt;
  readonly registryRevision: string;
  readonly observationIds: readonly string[];
  readonly measurementIds: readonly string[];
  readonly episodeIds: readonly string[];
  readonly completeness: "complete" | "partial" | "unknown";
  readonly diagnostics: readonly Diagnostic[];
}

export interface GovernanceView {
  readonly review: "not_required" | "required" | "accepted" | "blocked";
  readonly publication: "eligible" | "blocked";
  readonly validation: InterventionState["validation"];
  readonly reasons: readonly Diagnostic[];
}

export interface EvidenceHealthView {
  readonly status: "ready" | "incomplete" | "invalid" | "legacy_unbound";
  readonly diagnostics: readonly Diagnostic[];
}

export interface CandidateView {
  readonly candidate: Candidate;
  readonly governance: GovernanceView;
  readonly evidenceHealth: EvidenceHealthView;
  readonly derivationLineage:
    | { readonly status: "not_bound" }
    | {
        readonly status: "resolved";
        readonly derivation: InsightDerivationView;
      }
    | {
        readonly status: "invalid";
        readonly diagnostics: readonly Diagnostic[];
        readonly derivation?: InsightDerivationView;
      };
  readonly recurrenceLineage:
    | {
        readonly status: "not_bound";
        readonly reason: "manual" | "derivation_unbound" | "historical_unbound";
      }
    | {
        readonly status: "resolved";
        readonly claimDigest: string;
        readonly groupKeyDigest: string;
        readonly derivationId: string;
        readonly derivationDigest: string;
        readonly episodeIdentitySetDigest: string;
        readonly distinctEpisodeCountAtProposal: number;
        readonly currentExecutionCount: number;
        readonly currentDistinctEpisodeCount: number;
      }
    | {
        readonly status: "invalid";
        readonly diagnostics: readonly Diagnostic[];
        readonly claim?: {
          readonly claimDigest: string;
          readonly groupKeyDigest: string;
          readonly derivationId: string;
          readonly derivationDigest: string;
          readonly episodeIdentitySetDigest: string;
          readonly distinctEpisodeCountAtProposal: number;
        };
      };
}

export interface ProposeOutcome extends CandidateView {
  readonly candidate: CandidateV2;
}

export interface PreparedPublication {
  readonly plan: PublicationPlan;
  readonly authorizationBinding: AuthorizationBinding;
  readonly governance: GovernanceView;
}

export type PublicationOutcome =
  | {
      readonly status: "published" | "resumed" | "no_op";
      readonly intervention: InterventionRecord;
      readonly receipts: readonly PublicationReceipt[];
    }
  | {
      readonly status: "pending" | "denied" | "blocked" | "failed";
      readonly diagnostics: readonly Diagnostic[];
    };

export interface ResolveContextInput {
  readonly episodeId: string;
  readonly scope: Scope;
  readonly query: JsonValue;
  readonly budget: {
    readonly maximumEntries: number;
    readonly maximumCharacters: number;
  };
}

export interface ResolvedEntry {
  readonly id: string;
  readonly interventionId: string;
  readonly content: JsonValue;
  readonly contentDigest: string;
}

export interface ResolvedContext {
  readonly id: string;
  readonly episodeId: string;
  readonly entries: readonly ResolvedEntry[];
  readonly registryRevision: string;
  readonly policyDigest: string;
  readonly receiptDigest: string;
}

export interface ExposureInput {
  readonly resolutionReceiptId: string;
  readonly appliedEntryIds: readonly string[];
  readonly assignmentId: string;
  readonly experiment?: ExposureSetRecord["experiment"];
  readonly fingerprintId: string;
  readonly evidenceIds: readonly string[];
}

export type ExperimentDefinitionInput = Omit<
  ExperimentDefinition,
  "schemaVersion" | "declaredAt" | "definitionDigest"
>;

export interface EvaluationResult {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly experimentId: string;
  readonly definitionDigest: string;
  readonly attemptIds: readonly string[];
  readonly verdict: "improved" | "inconclusive" | "regressed" | "invalid";
  readonly diagnostics: readonly Diagnostic[];
}

export interface QueryPage<T> {
  readonly items: readonly T[];
  readonly nextCursor?: string;
  readonly snapshotRevision: string;
}

export interface ObservationQuery {
  readonly observationIds?: readonly string[];
  readonly sourceIds?: readonly string[];
  readonly episodeIds?: readonly string[];
  readonly kinds?: readonly string[];
  readonly trust?: readonly TrustClass[];
  readonly completeness?: readonly Provenance["completeness"][];
  readonly since?: string;
  readonly until?: string;
  readonly cursor?: string;
  readonly limit: number;
}

export interface MeasurementQuery {
  readonly measurementIds?: readonly string[];
  readonly sourceIds?: readonly string[];
  readonly episodeIds?: readonly string[];
  readonly metricNames?: readonly string[];
  readonly trust?: readonly TrustClass[];
  readonly completeness?: readonly Provenance["completeness"][];
  readonly since?: string;
  readonly until?: string;
  readonly cursor?: string;
  readonly limit: number;
}

export interface EpisodeQuery {
  readonly recordIds?: readonly string[];
  readonly sourceIds?: readonly string[];
  readonly episodeIds?: readonly string[];
  readonly parentEpisodeIds?: readonly string[];
  readonly episodeClasses?: readonly string[];
  readonly scope?: Scope;
  readonly statuses?: readonly EpisodeOutcome["status"][];
  readonly since?: string;
  readonly until?: string;
  readonly cursor?: string;
  readonly limit: number;
}

export interface SourcePageReceiptQuery {
  readonly receiptIds?: readonly string[];
  readonly sourceIds?: readonly string[];
  readonly sourceRefs?: readonly string[];
  readonly pageRefs?: readonly string[];
  readonly sourceRevisions?: readonly string[];
  readonly states?: readonly EvidencePage["state"]["status"][];
  readonly cursor?: string;
  readonly limit: number;
}

export interface EvidenceHealthQuery {
  readonly findingIds?: readonly string[];
  readonly sourceIds?: readonly string[];
  readonly sourceRefs?: readonly string[];
  readonly pageRefs?: readonly string[];
  readonly codes?: readonly EvidenceHealthFinding["code"][];
  readonly effects?: readonly EvidenceHealthFinding["effect"][];
  readonly cursor?: string;
  readonly limit: number;
}

export interface EpisodeView {
  readonly episode: EpisodeRecord;
  readonly identity:
    | {
        readonly status: "resolved";
        readonly sourceId: string;
        readonly sourceRecordId: string;
        readonly episodeId: string;
        readonly parentEpisodeId?: string;
        readonly episodeClass?: string;
        readonly registryRevision: string;
        readonly trustCeiling: TrustClass;
        readonly completeness: Provenance["completeness"];
      }
    | {
        readonly status: "unresolved";
        readonly diagnostics: readonly Diagnostic[];
      };
  readonly outcomeLineage:
    | {
        readonly status: "absent";
      }
    | {
        readonly status: "legacy_unbound";
        readonly diagnostics: readonly Diagnostic[];
      }
    | {
        readonly status: "resolved";
        readonly claimDigest: string;
        readonly historyDigests: readonly string[];
        readonly measurementRefs: readonly MeasurementEvidenceRefV2[];
        readonly evidenceHealth: EvidenceHealthView;
      };
}

export interface LearningReportQuery {
  readonly scope?: Scope;
  readonly sourceIds?: readonly string[];
  readonly episodeIds?: readonly string[];
  readonly since?: string;
  readonly until?: string;
}

export interface LearningReport {
  readonly query: LearningReportQuery;
  readonly candidateIds: readonly string[];
  readonly interventionIds: readonly string[];
  readonly evaluationIds: readonly string[];
  readonly diagnostics: readonly Diagnostic[];
}

export interface LearningLoop {
  ingest<I>(
    source: RegisteredSource<I>,
    sourceInput: I,
    options?: {
      readonly cursor?: string;
      readonly episodeBoundaryPolicyDigest?: string;
    },
  ): Promise<IngestReceipt>;

  propose(input: CandidateInput): Promise<ProposeOutcome>;
  reviewCandidate(input: CandidateReviewInput): Promise<CandidateReview>;
  runDetector(input: DetectorRunInput): Promise<DetectorRunResult>;
  runDetectorPack(input: DetectorPackRunInput): Promise<DetectorPackRunResult>;

  queryObservations(input: ObservationQuery): AsyncIterable<QueryPage<Observation>>;
  queryMeasurements(input: MeasurementQuery): AsyncIterable<QueryPage<MeasurementRecord>>;
  queryEpisodes(input: EpisodeQuery): AsyncIterable<QueryPage<EpisodeView>>;
  querySourcePageReceipts(input: SourcePageReceiptQuery): AsyncIterable<QueryPage<SourcePageReceipt>>;
  queryEvidenceHealthFindings(input: EvidenceHealthQuery): AsyncIterable<QueryPage<EvidenceHealthFinding>>;
  queryInsightDerivations(input: InsightDerivationQuery): AsyncIterable<QueryPage<InsightDerivationView>>;
  queryDetectorExecutions(input: DetectorExecutionQuery): AsyncIterable<QueryPage<DetectorExecutionView>>;
  queryDetectorPackRuns(input: DetectorPackRunQuery): AsyncIterable<QueryPage<DetectorPackRunView>>;
  getImportReceipt(input: { readonly importReceiptId: string }): Promise<ImportReceipt | undefined>;
  getInsightDerivation(input: {
    readonly derivationId: string;
    readonly scope: Scope;
  }): Promise<InsightDerivationView | undefined>;
  getDetectorExecution(input: {
    readonly executionId: string;
    readonly scope: Scope;
  }): Promise<DetectorExecutionView | undefined>;
  getDetectorPackRun(input: {
    readonly packRunReceiptId: string;
    readonly scope: Scope;
  }): Promise<DetectorPackRunView | undefined>;
  getCandidateView(input: { readonly candidateId: string }): Promise<CandidateView | undefined>;

  preparePublication(input: {
    readonly candidateId: string;
    readonly destinationId: string;
    readonly expectedBase?: string;
    readonly action?: PublicationPlan["action"];
  }): Promise<PreparedPublication>;

  publish(input: {
    readonly planId: string;
    readonly authorizationEvidence?: unknown;
  }): Promise<PublicationOutcome>;

  resolveContext(input: ResolveContextInput): Promise<ResolvedContext>;
  acknowledgeExposure(input: ExposureInput): Promise<ExposureSetRecord>;

  declareExperiment(
    input: ExperimentDefinitionInput,
  ): Promise<ExperimentDefinition>;

  runExperiment(input: {
    readonly experimentId: string;
  }): Promise<EvaluationResult>;

  recordOutcomes<I>(
    source: RegisteredOutcomeSource<I>,
    sourceInput: I,
  ): Promise<readonly MeasurementRecord[]>;

  report(input: LearningReportQuery): Promise<LearningReport>;
}
```

`IngestReceipt.id` equals `IngestReceipt.importReceipt.id`; it is not a fresh
attempt identifier. `sourceRevisions` and `pageReceiptIds` are the exact values
bound by the durable receipt. The returned derivative id arrays describe
records newly created by this call, and `diagnostics` is a sanitized transient
outcome; neither changes the deterministic durable import bytes.

The manual `CandidateInput.evidenceIds` branch is an ordered resolution request,
not Candidate record content. It must be nonempty and duplicate-free, and each
value addresses an exact durable observation or qualified measurement id. The
derivation branch instead accepts a mandatory scope locator and derivation id;
it accepts no caller semantic fields or evidence. The verified `propose`
transition resolves either request through exact records, semantic lineage,
episode identity, and source-page receipts, verifies exact scope ownership, and
persists only kernel-derived CandidateV2 content. Callers cannot provide
preassembled references, a derivation digest, or `originalDigest`. When
`supersedes` is present, `propose` loads the predecessor and derives the bound
original digest. A
missing, legacy-measurement, non-latest measurement, ambiguous, corrupt,
mismatched, or `blocks_use` request fails without creating a candidate. Evidence constrained by
`limits_claims`, `blocks_audit`, partial completeness, or unknown completeness
may create an inert v2 candidate, but its `EvidenceHealthView` is `incomplete`,
governance is blocked, and the reviewer port is not invoked.

`RegisteredSource<I>` ties each input to its preconfigured adapter, trust ceiling and content policy. `recordOutcomes` accepts only the distinct `RegisteredOutcomeSource<I>` capability. The strict-consumer test must prove the two cannot be substituted or widened, never paper over the distinction with a cast.

The typed query methods are read-only, domain-specific views over engine-owned records. `limit` is required and must be an integer from 1 through 500; it bounds each page, not the whole iterable. Items retain deterministic insertion order. Identifier arrays match exact identifiers, values within one array are alternatives, and different populated filters combine by intersection. Unknown query fields are rejected so a misspelled isolation filter cannot broaden a read. Each filter array is capped at 1,000 values, each string value at 4,096 characters (wide enough for framed durable ids), and an encoded cursor at 16,384 characters. `sourceIds`, `trust`, and `completeness` select observation/measurement provenance; `sourceIds` also selects resolved episode identity, whose view exposes its trust ceiling and completeness. `parentEpisodeIds` and `episodeClasses` select exact adapter-declared lineage/applicability values. Parent traversal should pair `parentEpisodeIds` with `sourceIds`; callers can stream repeated parent queries to traverse descendants without a provider-specific graph API. `scope` is validated by the configured `ScopePolicy` and matches the stored episode scope exactly; it does not invent ancestor inheritance. `statuses` excludes episodes with no outcome. Receipt and evidence-health queries use only their closed state/code/effect vocabularies and exact persisted references; they never search diagnostic messages or raw details.

`since` and `until` are inclusive canonical RFC 3339 UTC timestamps with milliseconds. They apply to `Observation.occurredAt`, `MeasurementRecord.measuredAt`, and `EpisodeRecord.openedAt`, respectively; a record without the relevant optional timestamp does not satisfy a time-bounded observation or measurement query. `recordIds` addresses durable `EpisodeRecord.id` values, while `episodeIds` addresses the provider-neutral episode identity shared by projections.

Query cursors are opaque and bind the domain kind, normalized filters, immutable registry revision, and a query-cursor store scope. A cursor used with another query, registry, or store scope is invalid. `LearningLoopConfig.queryCursorScope` lets a host provide a stable, non-secret tenant/store identity of at most 1,000 characters when cursors must resume across loop instances; it must not contain a secret because only its digest travels in the cursor. If omitted, the engine creates a process-local scope and cursors are valid only for that loop instance. Page `limit` is excluded from the binding so a resumed reader may change page size. Ordinary record pages expose the store revision observed for that page; semantic pages expose the scope-local derived revision specified above. Episode pages recheck their store revision after loading identity claims and fail with `query.snapshot_changed` if the composite view crossed a concurrent write. Appends may become visible on later pages, so the iterable is not a frozen detector, calibration, or experiment population; such workflows must persist and digest their exact eligible record set.

`EpisodeView.identity` comes from an engine-private, append-only sidecar claim stream created during ingestion. Each claim preserves source id, source record id, projected episode id, optional parent and episode class, registry revision, trust ceiling, and episode completeness without changing historical `EpisodeRecord` bytes. One distinct claim resolves; two claims atomically fold to conflict. Re-ingesting an existing episode idempotently backfills a missing claim. Conflicting or unavailable lineage produces `status: "unresolved"` with typed diagnostics and never a fabricated identity.

`EpisodeView.episode` never exposes an unqualified raw
`EpisodeRecord.outcome`. With no raw outcome and no appended claim,
`outcomeLineage` is `absent`. A stored schema-v1 outcome without an appended
claim is `legacy_unbound` with diagnostics and is stripped from the returned
episode. A resolved append-only claim supplies `claimDigest`, the ordered
retained `historyDigests`, exact `MeasurementEvidenceRefV2` values, and folded
evidence health. Only then does the view synthesize `episode.outcome` from the
latest claim's status and measurement record ids. Normal ingest appends these
claims after resolving measurements and citations; there is no public force-
outcome or append-outcome façade. Episode queries include the outcome stream in
their composite snapshot check, and `statuses` filters the synthesized latest
outcome rather than legacy raw bytes. `resolved` means that lineage is valid;
it does not make `succeeded` or an empty measurement list an efficacy pass.

`getImportReceipt` is an exact, pure read of one durable import receipt and
returns `undefined` only when that id does not exist. It reparses and verifies
the stored receipt digest; corruption is a typed error rather than absence.
`getCandidateView` is a pure read: it validates the stored Candidate, resolves
its exact derivation lineage when present, and folds reviews into
GovernanceView. `derivationLineage` is `not_bound`, `resolved` with the exact
InsightDerivationView, or `invalid` with diagnostics and an optional inspectable
view. Resolved is reserved for a fully eligible exact Candidate/derivation
mapping. Missing or mismatched mapping, orphaned/invalid execution, historical
registry, non-ready evidence, or broken mirrored supersession stays visible
through the invalid branch and blocks review and publication. The Candidate
EvidenceHealthView combines current Candidate refs and current
derivation/execution health. The read does not call `propose`, claim a content
digest, or mutate the store.
`recurrenceLineage` independently reports `not_bound`, `resolved`, or
`invalid`. Current manual and unavailable-derivation decisions use the closed
`manual` and `derivation_unbound` reasons; a Candidate whose historical
content-ownership lock omitted recurrence lineage remains
`historical_unbound`. A resolved view exposes exact claim/group/derivation and
proposal episode-set digests, the frozen proposal-time distinct count, and
current committed execution/episode counts. Current group growth may increase
the latter counts but cannot change the frozen member snapshot or baseline.
An invalid claim may expose only its immutable claim projection plus
diagnostics. Because decision 0016 is observational, typed recurrence
invalidity does not change GovernanceView or review/proposal disposition;
malformed raw claim/stream bytes still fail as `schema.corrupt` or
`store.corrupt`.
For a v1 candidate the fold also reports its permanent `legacy_unbound`
constraint and keeps publication blocked regardless of historical review
disposition. Reading a v1 record never resolves its evidence ids or creates a
v2 successor. `CandidateView.evidenceHealth` makes that constraint, incomplete
lineage, and invalid lineage inspectable through the closed `ready`,
`incomplete`, `invalid`, and `legacy_unbound` statuses; it is descriptive and
grants no authority.

`LearningReportQuery` uses the same closed-key, bounded-string/array,
exact-scope, and canonical-time rules as typed queries. `sourceIds` filters v2
candidates through `EvidenceRef.sourceId`; legacy-unbound v1 candidates are
audit-only and do not satisfy an evidence-backed report filter. `episodeIds`
addresses `EvidenceRef.episode.episodeId` and therefore requires `sourceIds`;
the pair is the collision-safe identity. An unscoped or ambiguous logical
episode-id report is rejected or excluded rather than merging evidence from
two sources.

The façade should not expose “force approve,” “mark validated,” or “write active memory” operations. Status is derived from accepted evidence and legal transitions.

## End-to-end usage examples

### Resolve learning for a future episode

```ts
const episodeId = "change-57";

const resolved = await learning.resolveContext({
  episodeId,
  scope: [
    { type: "project", id: "acme-api" },
    { type: "agent", id: "coding-agent" },
  ],
  query: {
    taskClass: "typescript-code-change",
    text: "Add an optional retry policy to the client.",
  },
  budget: {
    maximumEntries: 8,
    maximumCharacters: 4_000,
  },
});

await runAgent({
  task: "Add an optional retry policy to the client.",
  additionalInstructions: resolved.entries.map((entry) => entry.content),
});

await learning.acknowledgeExposure({
  resolutionReceiptId: resolved.id,
  appliedEntryIds: resolved.entries.map((entry) => entry.id),
  assignmentId: "ordinary-resolution-v1",
  fingerprintId: "fp-agent-run-v9",
  evidenceIds: ["obs-host-applied-resolution-v9"],
});
```

Only active, authorized, scope-matching entries resolve. The resolution receipt fixes exact content for the episode, so a mid-run publication cannot change treatment. Exposure acknowledgement requires host-observed evidence that the declared entries and fingerprint were actually applied; a free caller assertion is not efficacy evidence.

### Review and publish an exact intervention

```ts
const reviewerPrincipal = await identities.verify({
  principalId: "reviewer-b",
  kind: "agent",
  independenceDomain: "provider-b",
});

const reviewer: CandidateReviewer = {
  id: "reviewer-workflow-b",
  version: "1.0.0",
  principal: reviewerPrincipal,
  async review(input) {
    return {
      candidateId: input.candidate.id,
      candidateDigest: input.candidate.contentDigest,
      disposition: "accept",
      findings: [],
    };
  },
};

const review = await learning.reviewCandidate({
  id: "review-typecheck-1",
  candidateId: candidate.id,
  reviewer,
});

const prepared = await learning.preparePublication({
  candidateId: candidate.id,
  destinationId: "agent-instructions",
  expectedBase: "instructions-v7",
});

const authorizationEvidence = await hostApprovalWorkflow.request({
  reviewId: review.id,
  binding: prepared.authorizationBinding,
});

const publication = await learning.publish({
  planId: prepared.plan.id,
  authorizationEvidence,
});

if (publication.status !== "published"
  && publication.status !== "resumed"
  && publication.status !== "no_op") {
  throw new Error(`Publication did not complete: ${publication.status}`);
}

const intervention = publication.intervention;
console.log(intervention.state);
```

If any bound field changes between plan and publication, `publish` refuses. A retry with the same idempotency key returns the same receipt or finishes the same journal; it does not create a second version.

### Import a transcript without trusting it

```ts
const ingestReceipt = await transcriptLearning.ingest(
  codexExplicitExportSource,
  {
    kind: "explicit_file",
    path: "/explicit/user-selected/export.jsonl",
  },
  {
    episodeBoundaryPolicyDigest: "sha256:confirmed-boundaries-v1",
  },
);

console.log({
  imported: ingestReceipt.observationIds.length,
  sourceRevisions: ingestReceipt.sourceRevisions,
  pageReceiptIds: ingestReceipt.pageReceiptIds,
  durableImportId: ingestReceipt.importReceipt.id,
  completeness: ingestReceipt.completeness,
  diagnostics: ingestReceipt.diagnostics,
});
```

`transcriptLearning` is composed immutably with the typed `codexExplicitExportSource` capability. The adapter does not crawl for files, raw transcript bytes are not copied into the learning store by default, and all transcript-derived observations—including apparent tool records—are capped at advisory trust. A separate authenticated human or deterministic verifier source must create any higher-trust observation.

### Run a frozen paired experiment

```ts
const experiment = await learning.declareExperiment({
  id: "exp-typecheck-preflight-v1",
  hypothesis: "The preflight reduces type-check failures at completion.",
  interventionId: intervention.id,
  eligibilityPolicyDigest: "sha256:eligibility-policy",
  eligibilitySetDigest: "sha256:heldout-groups",
  baselineSnapshotDigest: "sha256:baseline-snapshots",
  controlFingerprintDigest: "sha256:control-fingerprint",
  treatmentFingerprintDigest: "sha256:treatment-fingerprint",
  primaryMetric: {
    definition: {
      name: "completion_typecheck_pass",
      valueType: "boolean",
      unit: "pass",
      aggregation: "all",
    },
    direction: "higher",
    minimumUsefulEffect: 0.15,
    perEpisodeAggregation: "majority-of-nested-repetitions-v1",
    missingnessRuleDigest: "sha256:missing-pair-invalid",
  },
  guardrails: [
    {
      metric: {
        name: "acceptance_tests",
        valueType: "boolean",
        unit: "pass",
        aggregation: "all",
      },
      rule: "must_pass",
    },
    {
      metric: {
        name: "cost",
        valueType: "number",
        unit: "USD",
        aggregation: "sum",
      },
      rule: "maximum",
      threshold: 8,
    },
  ],
  fixtureSetDigest: "sha256:hidden-fixtures-v3",
  graderDigest: "sha256:deterministic-repo-gates-v3",
  decisionRuleDigest: "sha256:paired-randomization-rule-v1",
  pairCount: 10,
  repetitionsPerPair: 2,
  costCeiling: { amount: 160, currency: "USD" },
  stoppingRuleDigest: "sha256:stop-rule-v1",
  replayExecutorDigest: "sha256:isolated-executor-v2",
  sideEffectPolicyDigest: "sha256:deny-by-default-effects-v2",
  assignmentAndBlindingDigest: "sha256:counterbalanced-blinded-v1",
});

const result = await learning.runExperiment({
  experimentId: experiment.id,
});

console.log(result.verdict);
// "improved" | "inconclusive" | "regressed" | "invalid"
```

The package records exactly why a verdict was reached. An invalid or missing arm cannot be represented as a neutral score.

## Transcript source contract

Transcript ingestion is an adapter path, not the core evidence model. A provider adapter should expose enough state to avoid pretending an open, partial, corrupt, or unsupported transcript is complete.

```ts
export type TranscriptSourceInput =
  | { readonly kind: "explicit_file"; readonly path: string }
  | { readonly kind: "caller_reader"; readonly readerId: string };

export interface TranscriptRef {
  readonly provider: string;
  readonly nativeSessionId: string;
  readonly sourceRevision?: string;
}

export interface TranscriptSourceProbe {
  readonly status: "qualified" | "experimental" | "unsupported";
  readonly detectedVersion?: string;
  readonly diagnostics: readonly Diagnostic[];
}

export interface TranscriptDiscoveryPage {
  readonly refs: readonly TranscriptRef[];
  readonly nextCursor?: string;
  readonly diagnostics: readonly Diagnostic[];
}

export interface TranscriptSourceAdapter {
  readonly adapterId: string;
  readonly adapterVersion: string;

  probe(input: TranscriptSourceInput): Promise<TranscriptSourceProbe>;

  discover(
    input: TranscriptSourceInput,
    cursor?: string,
  ): Promise<TranscriptDiscoveryPage>;

  read(
    ref: TranscriptRef,
    cursor?: string,
  ): Promise<TranscriptPage>;
}

export interface TranscriptPage {
  readonly sourceRevision: string;
  readonly state: "open" | "closed" | "unknown";
  readonly completeness:
    | "complete"
    | "partial"
    | "unsupported"
    | "corrupt";
  readonly items: readonly UntrustedTranscriptItem[];
  readonly nextCursor?: string;
  readonly diagnostics: readonly Diagnostic[];
}

export type UntrustedTranscriptItem =
  | {
      readonly kind: "message";
      readonly recordId: string;
      readonly actor: "human" | "agent" | "system" | "unknown";
      readonly occurredAt?: string;
      readonly content: {
        readonly classification: "sensitive-untrusted";
        readonly text: string;
      };
    }
  | {
      readonly kind: "tool";
      readonly recordId: string;
      readonly toolName: string;
      readonly phase: "requested" | "completed";
      readonly outcome?: "success" | "failure" | "denied" | "unknown";
      readonly argsDigest?: string;
      readonly occurredAt?: string;
    }
  | {
      readonly kind: "usage";
      readonly recordId: string;
      readonly tokensIn?: number;
      readonly tokensOut?: number;
      readonly costUsd?: number;
      readonly quality: "reported" | "estimated" | "unavailable";
    }
  | {
      readonly kind: "unknown";
      readonly recordId: string;
      readonly nativeType: string;
    };
```

`UntrustedTranscriptItem` is a transient adapter-to-content-policy value, not a durable record. Provider-native values cross as `unknown`; the adapter validates shape, then the content policy redacts and minimizes before storage. Persisting message text is explicit opt-in; the default stores extracted/redacted features and a tenant-keyed private locator. Unknown records remain visible without copying their raw payload.

Adapter and provider versions are bound into import receipts. A host-declared
append, rewrite, or deletion will create explicit immutable revision lineage,
supersede or tombstone affected derivatives, and void dependent content-bound
review or authorization where applicable; it never rewrites prior experiment
evidence. Until that declaration API is ratified, a second distinct revision
for the same source/page identity is unverifiable: it records
`source.revision_changed` and produces no derivatives. Stable record IDs are
namespaced by provider and adapter.

A session is not automatically an episode. The caller selects an episode-boundary strategy and its version. Heuristic segmentation records confidence. Low-confidence segments may support discovery but not efficacy claims.

## Policy model

The root package should provide a conservative policy builder, not a magical universal policy file. `T0`–`T3` are monotonic, host-neutral effect tiers: factual context, procedure, behavior/protocol, and tool/configuration/permission authority. Effect class and destination registration impose mandatory floors; for example, an authority destination cannot be `T0` merely because a proposer says so.

```ts
const policy = defineLearningPolicy({
  sources: {
    "codex-explicit-export": {
      trustCeiling: "advisory",
      maximumBytesPerImport: 25_000_000,
    },
    "repo-gates": {
      trustCeiling: "verified",
      metricKinds: ["outcome.test", "outcome.typecheck"],
    },
  },
  destinations: {
    "agent-instructions": {
      effectClass: "context",
      riskFloor: "T1",
      permittedTargetPatterns: ["agent-instructions/*"],
      authorization: "host",
      contentPolicyId: "instruction-text-v1",
    },
  },
  scopes: {
    defaultMatch: "exact",
    isolationSegmentTypes: ["tenant"],
  },
  risks: {
    T0: { independentReview: true },
    T1: { independentReview: true, authorization: "host" },
    T2: {
      independentReview: true,
      independentDomain: true,
      authorization: "human",
      experimentBeforeActivation: true,
    },
    T3: {
      authorization: "host-protected-change-path",
      liveCanary: "forbidden",
    },
  },
  experiments: {
    missingMeasurement: "invalid",
    retainAllAttempts: true,
    guardrailRegression: "regressed",
  },
});
```

The precise builder syntax is proposed. Its semantics are not: effective risk is the maximum of candidate suggestion, content classification, destination floor and host policy. A host can require more review, stronger authority, smaller budgets, exact-only scope or bar a destination. It cannot configure candidate auto-activation, merge authorization with validation, treat missing evidence as pass, cross an isolation boundary by default, or allow `T3` live canaries.

## Error and diagnostic model

Boundary and lifecycle failures need stable machine-readable codes and human-readable context.

```ts
export interface Diagnostic {
  readonly code: string;
  readonly severity: "info" | "warning" | "error";
  readonly message: string;
  readonly path?: readonly (string | number)[];
  readonly details?: JsonValue;
}

export declare class LearningLoopError extends Error {
  readonly code: string;
  readonly diagnostics: readonly Diagnostic[];
  constructor(code: string, diagnostics: readonly Diagnostic[]);
}
```

Initial error families should cover:

- `schema.unsupported_version`, `schema.invalid`, and `schema.corrupt`;
- `source.unsupported_format` and `source.incomplete` for transient adapter diagnostics;
- the closed durable evidence-health codes `source.missing`,
  `source.unreadable`, `source.unsupported`, `source.corrupt`,
  `source.partial`, `source.revision_changed`, `source.record_rejected`,
  `source.content_policy_refused`, `source.adapter_diagnostic`, and
  `source.ownership_mismatch`;
- `store.conflict`, `store.corrupt`, and `store.unavailable`;
- `review.not_independent` and `review.binding_mismatch`;
- `policy.blocked`, `policy.authority_insufficient`, and `policy.risk_floor`;
- `publication.base_mismatch`, `publication.binding_mismatch`, and `publication.receipt_mismatch`;
- `experiment.not_predeclared`, `experiment.fingerprint_drift`, `experiment.missing_arm`, `experiment.guardrail_regression`, and `experiment.contaminated`.

Logs and diagnostics must never echo unredacted transcript content or authorization evidence.

## Versioning and migration

Three versions must remain distinct:

1. **package version** — the TypeScript API and implementation release;
2. **record schema version** — the durable serialized contract;
3. **adapter/evaluator version** — the interpretation of an external format or score.

Rules:

- every durable record has an integer schema version;
- parsers accept `unknown`, report unsupported versions, and expose pure
  migrations only where a record-family decision explicitly allows one;
- schema-version-1 candidates have no migration: they remain
  `legacy_unbound` audit records, while an explicit new v2 proposal may bind a
  predecessor's exact digest through `supersedes` and `originalDigest`;
- schema-version-1 evidence-reference bytes remain stable; a v1 measurement
  reference stays unqualified, while exact cited-observation ownership creates
  a new schema-version-2 measurement reference rather than rewriting it;
- where another record family permits migration, it retains original digests
  as lineage, computes new digests for changed canonical bytes, and preserves
  provenance; an original digest never authenticates migrated content, and
  migration does not relabel an invalid or inconclusive historical evaluation;
- content bindings use the protocol's pinned canonical JSON, UTF-8 framing and SHA-256 algorithm plus an explicit field-inclusion table;
- a new evaluator version creates new evidence, not a retrospective rewrite;
- package minor versions may add optional fields only when old readers safely ignore them; semantic changes require a new schema or major package boundary;
- Cormidia compatibility readers remain in the Cormidia adapter, not in the generic public vocabulary.

## Conformance suites are part of the API

Every third-party store, destination, authority adapter, transcript source, and replay executor needs executable conformance tests.

The core suite should prove at least:

- candidate records never resolve into active context;
- schema-version-1 candidates remain byte-stable, `legacy_unbound`, and
  audit-only; reads and upgrades never auto-migrate them;
- candidate v2 proposal refuses cross-source id collisions, stale or corrupt
  records and receipts, unresolved episode identity, scope mismatch,
  empty or duplicate evidence, `blocks_use` evidence health, and unqualified or
  non-latest measurement references;
- metric runtime values must match `valueType`; v2 measurement references bind
  nonempty ordered, duplicate-free, same-source/revision/episode cited
  observations while v1 measurement references remain unqualified;
- append-only outcome claims retain every attempt, synthesize only the latest
  resolved episode outcome, and leave raw legacy outcomes `legacy_unbound`;
- reasserted projections use receipt `reused` accounting without creating a
  second derivative commit marker, while historical omitted `reused` bytes and
  digests remain stable;
- reordering or changing any full v2 evidence reference, derivation binding,
  predecessor id, or predecessor digest changes the candidate digest;
- a proposer cannot provide the decisive review;
- content mutation voids review and authorization bindings;
- a pending, denied, expired, or wrong-base authorization produces no destination write;
- two concurrent creates cannot both win with different content;
- a crash before or after each publication step resumes forward or no-ops exactly once;
- publication, authorization, activation, and validation states remain distinct;
- a replay with identical control and treatment fingerprints is invalid;
- missing arms, metrics, guardrails, or grader identity are invalid rather than neutral;
- a correctness regression defeats cost or speed improvement;
- imported prompt injection cannot execute, publish, or resolve;
- redacted content never appears in records, logs, diagnostics, hashes vulnerable to dictionary recovery, or outbound calls;
- deleting a source can locate and tombstone its derivatives;
- source semantic profiles are host-granted, bind one exact configured source
  registration revision, reject undeclared normalized kinds when present, and
  contribute zero detector capabilities when absent;
- semantic registries resolve every installed and selected record exactly,
  require selected detector/lens membership in selected packs, reject
  deprecated selection, snapshot caller mutation, and preserve prior loop
  registry bytes when omitted;
- detector execution keys bind every invocation/window field but not the
  result, execution digests bind the result, episode-view and capability-union
  formulae and population source-profile prefixes are recomputed, and the same
  key with a different result is a create-only conflict;
- detector execution results accept only `applied`, `not_applicable`, and
  `incomplete`; enforce output-kind/lens/output-family separation; and never
  turn missing capability or a negative condition into `pass`;
- episode lens requirements reject empty populations and populations whose
  exact reloaded identity trust/completeness falls below the registered floor;
- receipt-last semantic persistence survives a crash or lost acknowledgement
  at every step, retries exact bytes idempotently, retains competing-result
  links, and never exposes a public execution-mint method;
- semantic views distinguish commit, current-registry, and evidence-health
  status; expose orphaned/invalid derivations for same-scope audit; and never
  make historical or incomplete records proposal-eligible;
- semantic queries require exact scope, reject cross-scope direct gets, bind
  normalized scope/filters/kind/registry/store scope into opaque cursors, page
  only a scope-derived private index namespace, never touch a foreign target
  for direct gets, and retry or fail closed on composite snapshot churn;
- detector implementation capabilities reject structural forgery, registration
  or implementation-digest mismatch, duplicates, deprecation, and thenable
  callbacks;
- dry-run and commit rematerialize independently; dry-run performs zero
  kernel/store writes, while commit persists only kernel-minted exact lineage;
- empty/unbindable, inapplicable, missing-capability, unhealthy, and over-limit
  windows invoke no callback and never become applied false, zero, or pass;
- callback drafts cannot mint lifecycle status, scope, EvidenceRefs, trust,
  producer attribution, ids, digests, Candidates, or authority;
- detector-pack input rejects foreign packs, non-canonical episode ids, and
  more than 5,000 exact detector/lens combinations before callback invocation;
- detector-pack fan-out uses protocol code-unit ordering, reports every bounded
  cap/refusal explicitly, keeps `not_applicable`/`incomplete` status visible
  ahead of `existing`, and records whether a discarded child callback ran;
- detector-pack aggregate output and retained-byte ceilings discard whole
  children without truncation, dry-run writes nothing, and snapshot or corrupt
  graph failures never leave a caller-minted pack receipt;
- detector-pack commit persists only retained exact child graphs through the
  private receipt-last path and documents sequential partial-commit behavior;
- recurrence locators reject non-canonical structural labels, malformed keyed
  digests, detector privacy-treatment mismatch, key-policy mismatch, and any
  locator on a negative or non-applied execution;
- recurrence group keys isolate exact detector version/configuration,
  implementation, lens, scope and locator while proving that pack changes do
  not fork the same group;
- recurrence result locks precede bindings/members and the execution receipt
  remains last; create-only nullable decisions serialize concurrent null versus
  non-null locator evaluations, and the graph recovers idempotently from
  lock/binding/member/receipt crashes, excludes valid orphans from counts, and
  fails corrupt on mismatched binding/member/execution or forbidden stored
  privacy treatment;
- recurrence dry-run previews write nothing and count a would-be execution at
  most once; committed folds count only exact receipts, deduplicate episode
  identity digests, accept exactly 5,000 entries, 50,000 episode references,
  and 5,000 distinct identities, then fail closed at the next value without
  truncation;
- historical execution receipts without recurrence binding remain
  `locator_unavailable`, skip callbacks, and never acquire inferred lineage;
- detector-orchestration policy rejects corrupt digests, invalid SemVer,
  non-integer/out-of-range caps and suppression multipliers, and later caller
  mutation cannot change the snapshotted policy;
- configured invocation caps can only lower the hard callback ceiling, while
  omission preserves prior registry bytes and pack-result field omission;
- recurrence group caps count exact unique group keys in separate insight and
  evidence-health families, use stable pack order, classify every exact
  retained recurrence state `not_grouped | unassessed | capped`, attach the
  static group-cap diagnostic, omit unknown no-result classifications, and
  never truncate or suppress exact child facts;
- both rejection-suppression modes remain non-enforcing: no Candidate/review
  read, group claim, proposal refusal, override, durable pack receipt or
  efficacy implication occurs in the policy-only slice;
- durable pack receipt items normalize away callback/`existing` retry state,
  bind stable reason codes, and reject inconsistent execution disposition,
  reference, output/lens and absent/grouped recurrence combinations;
- receipt population persists only one-to-one exact-scope requested/resolved
  episodes; missing, wrong-scope and canary ids leave no receipt or scope index;
- governance snapshot/key/full digests change for exact group growth,
  population, policy and stable disposition changes while same-key/different
  full bytes conflict; embedded full policy remains historically inspectable;
- receipt persistence writes child graphs and exact registry snapshot before a
  scope result lock and receipt-last record, recovers every index/receipt crash,
  and documents surviving child facts rather than claiming batch atomicity;
- receipt views revalidate exact child detector/pack/lens/output/registry/scope
  and recurrence provenance, keep registry/policy/commit/governance/evidence
  dimensions separate, and never treat reserved assessed governance as current;
- receipt queries/gets require exact scope, never touch a wrong-scope target,
  bind normalized filters except page limit into opaque cursors, expose a
  scope-local public revision, and provide no locator/group-key/content search;
- receipt byte/item/population/group-identity/Candidate-binding/reason ceilings
  fail closed without truncation;
- derivation recurrence claims bind exact committed execution/decision/member
  lineage, retain multiple same-group witnesses, reject a second group, exclude
  pre-receipt orphans, memoize one bounded group fold, and fail at 5,001 claim
  references without truncation;
- every new Candidate-v2 decision embeds exact Candidate attribution and
  proposal bytes; decision, full Candidate/claim content lock, optional group
  member and Candidate receipt recover in order across failures and lost
  acknowledgements;
- same-content contenders cannot steal an anchored Candidate id or proposer,
  while distinct Candidate contents in one group remain allowed because this
  slice performs no deduplication or suppression;
- grouped Candidate claims freeze exact proposal member refs and the full
  episode-identity set, remain valid under later group growth, reject
  self-consistent member/baseline/anchor tamper, and expose only observational
  lineage without changing GovernanceView;
- historical Candidate ownership locks without claim bytes remain
  `historical_unbound` and are never backfilled on read;
- a packaged strict-TypeScript consumer compiles without deep imports or casts.

Adapter suites add format drift, cursor idempotency, out-of-order and duplicate records, torn writes, path traversal, symlink escape, resource ceilings, and receipt verification.

## Public-surface budget

The first release should expose no more than:

- one `createLearningLoop` factory and one `LearningLoop` interface;
- the explicitly ratified core record and evidence-reference types with their
  unknown-first parsers;
- the small port interfaces above;
- one policy builder with conservative defaults;
- one structured error and diagnostic model;
- the `/node` adapters actually supported;
- testing builders and conformance runners.

Do not export internal folds, every schema helper, Cormidia compatibility code, filesystem path builders, provider-specific event types, CLI functions, or experimental algorithms from the root. An export-ratchet test should require an explicit decision for every new public symbol.

## Concrete integration patterns

### OpenAI Agents SDK, LangGraph, Mastra, or a custom runner

Each host needs only four mappings:

| Host concern | Learning-loop mapping |
| --- | --- |
| Run/trace/session lifecycle | Episode source and observation source |
| Test, tool, human, or business outcome | Outcome source with an explicit trust class |
| Prompt, skill, runbook, ticket, or policy artifact | Publication destination and context resolver |
| Agent execution under stable configuration | Replay executor and fingerprint components |

The package should publish one small reference adapter for a deliberately simple custom TypeScript agent before publishing framework integrations. That reference is the best test that the concepts, not a framework's types, define the API.

### Cormidia

Cormidia keeps:

- runlog, scheduler, execution-journal, ticket, and efficiency projection;
- role and app scope mapping;
- protected paths and prompt-injection gate;
- approval root of trust and human gates;
- GitHub proposal and ticket destinations;
- org budget ledger;
- replay workspace and agent-provider execution;
- scheduled distiller and reviewer turns;
- context assembly, CLI, reporting, and retention.

It consumes from the package:

- record schemas and parsers;
- candidate, review, experiment, intervention, and exposure transitions;
- policy invariants;
- canonical binding and digest rules;
- publication transaction engine;
- resolver selection and conflict logic;
- paired-evaluation and guardrail decisions;
- conformance suites.

### Transcript dogfood

Transcript adapters contribute advisory source records and episode hints. Independent tools or future prospective capture contribute outcomes and replay inputs. The personal dashboard may show recurrence, candidate acceptance, review time, application, later correction rate, and attributable experimental deltas as separate metrics.

It must not compare Codex, Claude Code, and Cursor from ordinary self-selected daily use as if tool choice were randomized. Provider and harness belong in the fingerprint and analysis strata.

## Decisions to ratify before implementation

1. Is the root abstraction a `LearningLoop` façade, a set of pure workflows, or both? This proposal recommends both, with one façade as the supported ordinary path.
2. Are the four standard trust classes sufficiently clear and portable?
3. Does the public scope model allow ordered adapter-defined segments, or should the protocol standardize tenant/project/agent/role keys?
4. Are `T0`–`T3` public protocol tiers or only a conservative default policy? This proposal makes them public because destination authority must be portable.
5. Is the low-level `LearningStore` contract sufficient for database and filesystem adapters without requiring distributed transactions?
6. Which publication destinations, if any, ship in the first package? This proposal favors inert examples and a local versioned text-context destination only after its host-protection limitations are explicit.
7. Does `/workflows` ship with `0.x`, or remain example code until distiller and reviewer calibration exists?
8. Which exact fields enter candidate, plan, policy, and authorization digests?
9. What historical Cormidia bytes and schemas must remain compatible?
10. Which Node releases, module formats, and license serve the intended community?

The first implementation session should turn these decisions into a narrow API snapshot and red consumer/conformance tests before moving reusable code.
