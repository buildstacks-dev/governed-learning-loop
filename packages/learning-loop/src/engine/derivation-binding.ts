// Candidate/InsightDerivation binding, exact field mapping, and scoped eligibility.
import { canonicalJsonText, sha256HexOfCanonicalJson } from "../canonical/canonical-json.js";
import { toJsonValue } from "../canonical/to-json-value.js";
import type { Diagnostic } from "../diagnostics.js";
import { LearningLoopError } from "../diagnostics.js";
import type { Candidate, CandidateIntervention } from "../records/candidate.js";
import type { EvidenceRef } from "../records/evidence-ref.js";
import type { InsightDerivation } from "../records/insight-derivation.js";
import type { PrincipalRef } from "../records/principal.js";
import type { Scope } from "../records/scope.js";
import { scopeDigest } from "../records/semantic-shared.js";
import type { EngineContext } from "./context.js";
import { loadCandidate } from "./context.js";
import type { EvidenceHealthView } from "./evidence-binding.js";
import { resolveCandidateEvidence } from "./evidence-binding.js";
import { semanticGraphSnapshotRevision } from "./semantic-graph.js";
import { loadInsightDerivationScopeIndex, semanticScopeIndexSnapshotRevision } from "./semantic-scope-index.js";
import type { InsightDerivationView } from "./semantic-views.js";
import { loadInsightDerivationView } from "./semantic-views.js";

const MAX_SNAPSHOT_ATTEMPTS = 3;

export interface ResolvedCandidateDerivation {
  readonly derivation: InsightDerivation;
  readonly view: InsightDerivationView;
  readonly problem: string;
  readonly hypothesis: string;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly intervention: CandidateIntervention;
  readonly producerPrincipal: PrincipalRef | null;
  readonly producerImplementation: {
    readonly id: string;
    readonly version: string;
  };
}

export type CandidateDerivationBinding =
  | { readonly status: "not_bound"; readonly health: EvidenceHealthView }
  | {
      readonly status: "resolved";
      readonly resolved: ResolvedCandidateDerivation;
      readonly health: EvidenceHealthView;
    }
  | {
      readonly status: "invalid";
      readonly diagnostics: readonly Diagnostic[];
      readonly view?: InsightDerivationView;
      readonly producerPrincipal?: PrincipalRef;
      readonly producerImplementation?: { readonly id: string; readonly version: string };
      readonly health: EvidenceHealthView;
    };

function staticDiagnostic(code: string, severity: Diagnostic["severity"], message: string): Diagnostic {
  return { code, severity, message };
}

function sameCanonical(left: unknown, right: unknown): boolean {
  return canonicalJsonText(toJsonValue(left)) === canonicalJsonText(toJsonValue(right));
}

function snapshotScope(scope: Scope): Scope {
  return Object.freeze(scope.map((segment) => Object.freeze({ type: segment.type, id: segment.id })));
}

async function bindingSnapshotRevision(context: EngineContext, exactScopeDigest: string): Promise<string> {
  const graph = await semanticGraphSnapshotRevision(context);
  const scopeIndex = await semanticScopeIndexSnapshotRevision(context, exactScopeDigest);
  return sha256HexOfCanonicalJson(toJsonValue({ graph, scopeIndex }));
}

function mappedEvidence(derivation: InsightDerivation): readonly EvidenceRef[] {
  const direct = derivation.directObservation.evidenceRefs;
  const contradictory = derivation.contradictoryEvidenceRefs;
  if (direct.length === 0 && derivation.population.episodes.length === 0) {
    throw new LearningLoopError("candidate.derivation_invalid", [
      staticDiagnostic("candidate.derivation_invalid", "error", "derivation has no proposable evidence population"),
    ]);
  }
  const combined = [...direct, ...contradictory];
  const digests = new Set<string>();
  const records = new Set<string>();
  for (const reference of combined) {
    const recordKey = canonicalJsonText(toJsonValue([reference.kind, reference.recordId]));
    if (digests.has(reference.referenceDigest) || records.has(recordKey)) {
      throw new LearningLoopError("candidate.derivation_invalid", [
        staticDiagnostic("candidate.derivation_invalid", "error", "derivation evidence is duplicated across claims"),
      ]);
    }
    digests.add(reference.referenceDigest);
    records.add(recordKey);
  }
  return combined;
}

function mapEligibleDerivation(view: InsightDerivationView): ResolvedCandidateDerivation {
  const derivation = view.derivation;
  if (view.commitBinding.status !== "committed") {
    throw new LearningLoopError("candidate.derivation_uncommitted", [
      staticDiagnostic("candidate.derivation_uncommitted", "error", "derivation has no exact committed execution"),
    ]);
  }
  if (view.registryBinding.status !== "configured") {
    throw new LearningLoopError("candidate.derivation_historical", [
      staticDiagnostic(
        "candidate.derivation_historical",
        "error",
        "derivation is not selected by the current registry",
      ),
    ]);
  }
  if (view.evidenceHealth.status !== "ready") {
    throw new LearningLoopError("candidate.derivation_evidence_invalid", [
      staticDiagnostic("candidate.derivation_evidence_invalid", "error", "derivation evidence is not ready"),
      ...view.evidenceHealth.diagnostics,
    ]);
  }
  const interpretation = derivation.interpretation;
  const impact = derivation.impactHypothesis;
  const candidateIntervention = derivation.candidateIntervention;
  if (
    interpretation === null ||
    impact === null ||
    candidateIntervention === null ||
    derivation.validation === null ||
    candidateIntervention.proposedDestinationId === null ||
    candidateIntervention.contentDraft === null ||
    candidateIntervention.rollbackIntent === null
  ) {
    throw new LearningLoopError("candidate.derivation_invalid", [
      staticDiagnostic("candidate.derivation_invalid", "error", "derivation lacks exact proposable semantic fields"),
    ]);
  }
  return {
    derivation,
    view,
    problem: interpretation.statement,
    hypothesis: impact.statement,
    evidenceRefs: mappedEvidence(derivation),
    intervention: {
      destinationId: candidateIntervention.proposedDestinationId,
      kind: candidateIntervention.proposedDestinationKind,
      content: candidateIntervention.contentDraft,
      rollbackIntent: candidateIntervention.rollbackIntent,
    },
    producerPrincipal: derivation.producer.principal,
    producerImplementation: {
      id: derivation.producer.implementationId,
      version: derivation.producer.implementationVersion,
    },
  };
}

async function loadScopedDerivationView(
  context: EngineContext,
  derivationId: string,
  scope: Scope,
): Promise<InsightDerivationView | undefined> {
  const exactScopeDigest = scopeDigest(scope);
  const index = await loadInsightDerivationScopeIndex(context, derivationId, exactScopeDigest);
  if (index === undefined) return undefined;
  const view = await loadInsightDerivationView(context, derivationId, scope);
  if (view === undefined || view.derivation.derivationDigest !== index.targetDigest) {
    throw new LearningLoopError("store.corrupt", [
      staticDiagnostic("store.corrupt", "error", "scoped derivation index target is missing or mismatched"),
    ]);
  }
  return view;
}

export async function resolveDerivedCandidateInput(
  context: EngineContext,
  derivationId: string,
  inputScope: Scope,
): Promise<ResolvedCandidateDerivation> {
  const scope = snapshotScope(context.scopePolicy.validate(inputScope));
  const exactScopeDigest = scopeDigest(scope);
  for (let attempt = 0; attempt < MAX_SNAPSHOT_ATTEMPTS; attempt += 1) {
    const before = await bindingSnapshotRevision(context, exactScopeDigest);
    try {
      const view = await loadScopedDerivationView(context, derivationId, scope);
      if (view === undefined) {
        const after = await bindingSnapshotRevision(context, exactScopeDigest);
        if (before !== after) continue;
        throw new LearningLoopError("candidate.derivation_not_found", [
          staticDiagnostic("candidate.derivation_not_found", "error", "derivation is unavailable in the exact scope"),
        ]);
      }
      const resolved = mapEligibleDerivation(view);
      if (resolved.derivation.scopeDigest !== exactScopeDigest || !sameCanonical(resolved.derivation.scope, scope)) {
        throw new LearningLoopError("candidate.derivation_not_found", [
          staticDiagnostic("candidate.derivation_not_found", "error", "derivation is unavailable in the exact scope"),
        ]);
      }
      if (resolved.evidenceRefs.length > 0) {
        const evidence = await resolveCandidateEvidence(
          context,
          resolved.evidenceRefs.map((reference) => reference.recordId),
          scope,
        );
        if (
          evidence.health.status !== "ready" ||
          evidence.refs.length !== resolved.evidenceRefs.length ||
          !evidence.refs.every((reference, index) => sameCanonical(reference, resolved.evidenceRefs[index]))
        ) {
          throw new LearningLoopError("candidate.derivation_evidence_invalid", [
            staticDiagnostic("candidate.derivation_evidence_invalid", "error", "derivation evidence changed"),
            ...evidence.health.diagnostics,
          ]);
        }
      }
      const after = await bindingSnapshotRevision(context, exactScopeDigest);
      if (before === after) return resolved;
    } catch (error) {
      if (!(error instanceof LearningLoopError)) throw error;
      if (
        error.code === "evidence.snapshot_changed" ||
        error.code === "query.snapshot_changed" ||
        error.code === "candidate.derivation_snapshot_changed"
      ) {
        continue;
      }
      const after = await bindingSnapshotRevision(context, exactScopeDigest);
      if (before !== after) continue;
      throw error;
    }
  }
  throw new LearningLoopError("candidate.derivation_snapshot_changed", [
    staticDiagnostic("candidate.derivation_snapshot_changed", "error", "derivation changed repeatedly while resolving"),
  ]);
}

function candidateMatchesResolved(candidate: Candidate, resolved: ResolvedCandidateDerivation): boolean {
  return (
    candidate.schemaVersion === 2 &&
    candidate.derivationRef?.id === resolved.derivation.id &&
    candidate.derivationRef.digest === resolved.derivation.derivationDigest &&
    scopeDigest(candidate.scope) === resolved.derivation.scopeDigest &&
    sameCanonical(candidate.scope, resolved.derivation.scope) &&
    candidate.problem === resolved.problem &&
    candidate.hypothesis === resolved.hypothesis &&
    sameCanonical(candidate.evidenceRefs, resolved.evidenceRefs) &&
    sameCanonical(candidate.intervention, resolved.intervention)
  );
}

function invalidCandidateBinding(
  view: InsightDerivationView | undefined,
  error: LearningLoopError,
): CandidateDerivationBinding {
  const derivation = view?.derivation;
  return {
    status: "invalid",
    diagnostics: [
      staticDiagnostic("candidate.derivation_invalid", "error", "candidate derivation lineage is not eligible"),
      ...error.diagnostics,
    ],
    ...(view === undefined ? {} : { view }),
    ...(derivation?.producer.principal === null || derivation?.producer.principal === undefined
      ? {}
      : { producerPrincipal: derivation.producer.principal }),
    ...(derivation === undefined
      ? {}
      : {
          producerImplementation: {
            id: derivation.producer.implementationId,
            version: derivation.producer.implementationVersion,
          },
        }),
    health: {
      status: "invalid",
      diagnostics: [...(view?.evidenceHealth.diagnostics ?? []), ...error.diagnostics],
    },
  };
}

export async function revalidateCandidateDerivation(
  context: EngineContext,
  candidate: Candidate,
): Promise<CandidateDerivationBinding> {
  if (candidate.schemaVersion !== 2 || candidate.derivationRef === undefined) {
    return { status: "not_bound", health: { status: "ready", diagnostics: [] } };
  }
  const exactScopeDigest = scopeDigest(candidate.scope);
  let lastView: InsightDerivationView | undefined;
  for (let attempt = 0; attempt < MAX_SNAPSHOT_ATTEMPTS; attempt += 1) {
    const before = await bindingSnapshotRevision(context, exactScopeDigest);
    try {
      const view = await loadScopedDerivationView(context, candidate.derivationRef.id, candidate.scope);
      lastView = view;
      if (view === undefined || view.derivation.derivationDigest !== candidate.derivationRef.digest) {
        throw new LearningLoopError("candidate.derivation_missing", []);
      }
      const resolved = mapEligibleDerivation(view);
      if (!candidateMatchesResolved(candidate, resolved)) {
        throw new LearningLoopError("candidate.derivation_mismatch", []);
      }
      const after = await bindingSnapshotRevision(context, exactScopeDigest);
      if (before === after) return { status: "resolved", resolved, health: view.evidenceHealth };
    } catch (error) {
      if (!(error instanceof LearningLoopError)) throw error;
      if (error.code === "evidence.snapshot_changed" || error.code === "query.snapshot_changed") continue;
      const after = await bindingSnapshotRevision(context, exactScopeDigest);
      if (before !== after) continue;
      return invalidCandidateBinding(lastView, error);
    }
  }
  return invalidCandidateBinding(
    lastView,
    new LearningLoopError("candidate.derivation_snapshot_changed", [
      staticDiagnostic("candidate.derivation_snapshot_changed", "error", "candidate derivation changed repeatedly"),
    ]),
  );
}

export async function candidateDerivationSupersessionDiagnostics(
  context: EngineContext,
  candidate: Candidate,
  binding?: CandidateDerivationBinding,
): Promise<readonly Diagnostic[]> {
  const exactBinding = binding ?? (await revalidateCandidateDerivation(context, candidate));
  const currentDerivation =
    exactBinding.status === "resolved"
      ? exactBinding.resolved.derivation
      : exactBinding.status === "invalid"
        ? exactBinding.view?.derivation
        : undefined;
  if (candidate.supersedes === undefined) {
    return currentDerivation?.supersedes === null || currentDerivation === undefined
      ? []
      : [
          staticDiagnostic(
            "candidate.derivation_supersedes_mismatch",
            "error",
            "derivation supersession requires exact Candidate supersession",
          ),
        ];
  }
  const predecessor = await loadCandidate(context, candidate.supersedes);
  if (predecessor === undefined) return [];
  const predecessorRef = predecessor.schemaVersion === 2 ? predecessor.derivationRef : undefined;
  if (currentDerivation === undefined) {
    return predecessorRef === undefined
      ? []
      : [
          staticDiagnostic(
            "candidate.derivation_supersedes_mismatch",
            "error",
            "manual Candidate cannot supersede derivation-backed Candidate lineage",
          ),
        ];
  }
  const semanticPredecessor = currentDerivation.supersedes;
  if (predecessorRef === undefined) {
    return [
      staticDiagnostic(
        "candidate.derivation_supersedes_mismatch",
        "error",
        "derivation-backed Candidate cannot supersede a manual predecessor",
      ),
    ];
  }
  return semanticPredecessor !== null &&
    semanticPredecessor.id === predecessorRef.id &&
    semanticPredecessor.derivationDigest === predecessorRef.digest &&
    semanticPredecessor.scopeDigest === scopeDigest(predecessor.scope)
    ? []
    : [
        staticDiagnostic(
          "candidate.derivation_supersedes_mismatch",
          "error",
          "Candidate and derivation supersession lineage do not match",
        ),
      ];
}
