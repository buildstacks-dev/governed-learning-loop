// Store-backed folds shared by propose and review: load a candidate's stored
// reviews (oldest first) and compute its governance view.
import { sha256HexOfCanonicalJson } from "../canonical/canonical-json.js";
import { toJsonValue } from "../canonical/to-json-value.js";
import type { Diagnostic } from "../diagnostics.js";
import { LearningLoopError } from "../diagnostics.js";
import type { Candidate } from "../records/candidate.js";
import type { CandidateReview } from "../records/review.js";
import { parseCandidateReview, reviewInvalidReasons } from "../records/review.js";
import { scopeDigest } from "../records/semantic-shared.js";
import type { EngineContext } from "./context.js";
import { effectiveRisk, iterateRecordPages, readRecordKindRevision } from "./context.js";
import { candidateLineageDiagnostics } from "./candidate-lineage.js";
import type { EvidenceHealthView } from "./evidence-binding.js";
import { revalidateCandidateEvidence } from "./evidence-binding.js";
import type { CandidateDerivationBinding } from "./derivation-binding.js";
import { revalidateCandidateDerivation } from "./derivation-binding.js";
import type { GovernanceView } from "./governance.js";
import { computeGovernanceView } from "./governance.js";
import { semanticGraphSnapshotRevision } from "./semantic-graph.js";
import { semanticScopeIndexSnapshotRevision } from "./semantic-scope-index.js";
import type { InsightDerivationView } from "./semantic-views.js";
import type { CandidateRecurrenceLineage } from "./recurrence-claims.js";
import { loadCandidateRecurrenceLineage } from "./recurrence-claims.js";
import { loadIndexedCandidateReviews } from "./candidate-review-index.js";
import { candidateAdmissionLineageRevision, loadCandidateAdmissionLineageRecords } from "./recurrence-admission.js";

const MAX_GOVERNANCE_SNAPSHOT_ATTEMPTS = 3;

export interface CandidateGovernanceState {
  readonly governance: GovernanceView;
  readonly evidenceHealth: EvidenceHealthView;
  readonly derivationLineage:
    | { readonly status: "not_bound" }
    | { readonly status: "resolved"; readonly derivation: InsightDerivationView }
    | {
        readonly status: "invalid";
        readonly diagnostics: readonly Diagnostic[];
        readonly derivation?: InsightDerivationView;
      };
  readonly recurrenceLineage: CandidateRecurrenceLineage;
  readonly admissionLineage:
    | {
        readonly status: "not_subject";
        readonly reason: "manual" | "recurrence_unbound" | "policy_unconfigured" | "historical_pre_admission";
      }
    | {
        readonly status: "resolved";
        readonly bindingDigest: string;
        readonly reservationKeyDigest: string;
        readonly reservationDigest: string;
        readonly snapshotDigest: string;
        readonly policyDigest: string;
        readonly basis: "group_available" | "required_supersession" | "rejection_override" | "historical_supersession";
      }
    | {
        readonly status: "historical";
        readonly bindingDigest: string;
        readonly reservationKeyDigest: string;
        readonly reservationDigest: string;
        readonly snapshotDigest: string;
        readonly policyDigest: string;
        readonly basis: "group_available" | "required_supersession" | "rejection_override" | "historical_supersession";
        readonly diagnostics: readonly Diagnostic[];
      }
    | { readonly status: "invalid"; readonly diagnostics: readonly Diagnostic[] };
}

async function candidateAdmissionLineageOf(
  context: EngineContext,
  candidate: Candidate,
): Promise<CandidateGovernanceState["admissionLineage"]> {
  if (candidate.schemaVersion !== 2) {
    return { status: "not_subject", reason: "recurrence_unbound" };
  }
  const admission = await loadCandidateAdmissionLineageRecords(context, candidate);
  if (admission.status === "not_subject") {
    return { status: "not_subject", reason: admission.reason };
  }
  if (admission.status === "invalid") {
    return {
      status: "invalid",
      diagnostics: [
        {
          code: "candidate.admission_invalid",
          severity: "error",
          message: "Candidate admission lineage is structurally invalid",
        },
      ],
    };
  }
  const projection = {
    bindingDigest: admission.binding.bindingDigest,
    reservationKeyDigest: admission.binding.reservationKeyDigest,
    reservationDigest: admission.binding.reservationDigest,
    snapshotDigest: admission.binding.snapshotDigest,
    policyDigest: admission.binding.policyDigest,
    basis: admission.reservation.basis,
  };
  if (admission.policyStatus === "configured") return { status: "resolved", ...projection };
  return {
    status: "historical",
    ...projection,
    diagnostics: [
      {
        code: "candidate.admission_policy_historical",
        severity: "warning",
        message: "Candidate admission binds a historical orchestration policy",
      },
    ],
  };
}

/**
 * Stored reviews of one candidate. `list` returns records in stable insertion
 * order, which within one engine process is persistence order; the last
 * element is therefore the latest decisive review.
 */
export async function loadReviews(
  context: EngineContext,
  candidate: Candidate,
  derivationBinding?: CandidateDerivationBinding,
): Promise<readonly CandidateReview[]> {
  const reviews: CandidateReview[] = [];
  const binding = derivationBinding ?? (await revalidateCandidateDerivation(context, candidate));
  const indexed = await loadIndexedCandidateReviews(context, candidate);
  if (indexed.status === "ready") {
    for (const review of indexed.reviews) assertStoredReviewValid(context, candidate, binding, review);
    return indexed.reviews;
  }
  for await (const page of iterateRecordPages(context.store, "review", { limit: 100 })) {
    for (const record of page.records) {
      const review = parseCandidateReview(record.value);
      if (review.id !== record.key.id) {
        throw new LearningLoopError("store.corrupt", [
          {
            code: "store.corrupt",
            severity: "error",
            message: "stored review id does not match its record key",
          },
        ]);
      }
      if (review.candidateId !== candidate.id) continue;
      assertStoredReviewValid(context, candidate, binding, review);
      reviews.push(review);
    }
  }
  return reviews;
}

export function assertStoredReviewValid(
  context: EngineContext,
  candidate: Candidate,
  binding: CandidateDerivationBinding,
  review: CandidateReview,
): void {
  const riskRule = context.policyRules.risks[effectiveRisk(candidate)];
  const producerPrincipal =
    binding.status === "resolved"
      ? binding.resolved.producerPrincipal
      : binding.status === "invalid"
        ? binding.producerPrincipal
        : undefined;
  const producerImplementation =
    binding.status === "resolved"
      ? binding.resolved.producerImplementation
      : binding.status === "invalid"
        ? binding.producerImplementation
        : undefined;
  const invalidReasons = reviewInvalidReasons(review);
  if (
    invalidReasons.length > 0 ||
    review.reviewer.id === candidate.proposedBy.id ||
    (producerPrincipal !== null && producerPrincipal !== undefined && review.reviewer.id === producerPrincipal.id) ||
    (producerPrincipal !== null &&
      producerPrincipal !== undefined &&
      review.reviewer.independenceDomain === producerPrincipal.independenceDomain) ||
    (producerImplementation !== undefined &&
      review.reviewerImplementation.id === producerImplementation.id &&
      review.reviewerImplementation.version === producerImplementation.version) ||
    (riskRule.independentDomain && review.reviewer.independenceDomain === candidate.proposedBy.independenceDomain)
  ) {
    throw new LearningLoopError("store.corrupt", [
      {
        code: "store.corrupt",
        severity: "error",
        message: "stored candidate review violates review invariants",
      },
      ...invalidReasons,
    ]);
  }
}

async function candidateGovernanceStateOnce(
  context: EngineContext,
  candidate: Candidate,
  requiresIndependentReview: boolean,
): Promise<CandidateGovernanceState> {
  const derivation = await revalidateCandidateDerivation(context, candidate);
  const recurrenceLineage = await loadCandidateRecurrenceLineage(context, candidate);
  const admissionLineage = await candidateAdmissionLineageOf(context, candidate);
  const reviews = await loadReviews(context, candidate, derivation);
  const computedGovernance = computeGovernanceView({
    candidateDigest: candidate.contentDigest,
    requiresIndependentReview,
    reviews,
  });
  const governance: GovernanceView =
    admissionLineage.status === "invalid"
      ? {
          ...computedGovernance,
          review: "blocked",
          publication: "blocked",
          reasons: [
            ...admissionLineage.diagnostics,
            ...computedGovernance.reasons.filter((reason) => reason.code !== "review.required"),
          ],
        }
      : computedGovernance;
  const evidence = await revalidateCandidateEvidence(context, candidate);
  const lineageDiagnostics = await candidateLineageDiagnostics(context, candidate);
  const derivationDiagnostics = derivation.status === "invalid" ? derivation.diagnostics : [];
  const evidenceHealth = mergeEvidenceHealth(evidence.health, derivation.health);
  let derivationLineage: CandidateGovernanceState["derivationLineage"];
  if (derivation.status === "not_bound") derivationLineage = { status: "not_bound" };
  else if (derivation.status === "resolved") {
    derivationLineage = { status: "resolved", derivation: derivation.resolved.view };
  } else {
    derivationLineage = {
      status: "invalid",
      diagnostics: derivation.diagnostics,
      ...(derivation.view === undefined ? {} : { derivation: derivation.view }),
    };
  }
  const hasSemanticSupersessionMismatch = lineageDiagnostics.some(
    (reason) => reason.code === "candidate.derivation_supersedes_mismatch",
  );
  if (lineageDiagnostics.length > 0 && (derivation.status !== "not_bound" || hasSemanticSupersessionMismatch)) {
    const derivationView =
      derivation.status === "resolved"
        ? derivation.resolved.view
        : derivation.status === "invalid"
          ? derivation.view
          : undefined;
    derivationLineage = {
      status: "invalid",
      diagnostics: [...derivationDiagnostics, ...lineageDiagnostics],
      ...(derivationView === undefined ? {} : { derivation: derivationView }),
    };
  }
  if (evidenceHealth.status === "ready" && lineageDiagnostics.length === 0 && derivationDiagnostics.length === 0) {
    return { governance, evidenceHealth, derivationLineage, recurrenceLineage, admissionLineage };
  }
  const code =
    derivationDiagnostics.length > 0
      ? "candidate.derivation_invalid"
      : lineageDiagnostics.length > 0
        ? "candidate.lineage_invalid"
        : evidenceHealth.status === "legacy_unbound"
          ? "candidate.legacy_unbound"
          : evidenceHealth.status === "incomplete"
            ? "candidate.evidence_incomplete"
            : "candidate.evidence_invalid";
  return {
    governance: {
      ...governance,
      review: "blocked",
      publication: "blocked",
      reasons: [
        {
          code,
          severity: "error",
          message: "candidate evidence is not eligible for decisive governance",
        },
        ...derivationDiagnostics,
        ...lineageDiagnostics,
        ...evidenceHealth.diagnostics,
        ...governance.reasons.filter((reason) => reason.code !== "review.required"),
      ],
    },
    evidenceHealth,
    derivationLineage,
    recurrenceLineage,
    admissionLineage,
  };
}

async function candidateGovernanceSnapshotRevision(context: EngineContext, candidate: Candidate): Promise<string> {
  const graphRevision = await semanticGraphSnapshotRevision(context);
  const scopeIndexRevision = await semanticScopeIndexSnapshotRevision(context, scopeDigest(candidate.scope));
  const candidateRevision = await readRecordKindRevision(context.store, "candidate");
  const reviewRevision = await readRecordKindRevision(context.store, "review");
  const admissionRevision =
    candidate.schemaVersion === 2 ? await candidateAdmissionLineageRevision(context, candidate) : null;
  return sha256HexOfCanonicalJson(
    toJsonValue({ graphRevision, scopeIndexRevision, candidateRevision, reviewRevision, admissionRevision }),
  );
}

export async function candidateGovernanceStateOf(
  context: EngineContext,
  candidate: Candidate,
  requiresIndependentReview: boolean,
): Promise<CandidateGovernanceState> {
  for (let attempt = 0; attempt < MAX_GOVERNANCE_SNAPSHOT_ATTEMPTS; attempt += 1) {
    const before = await candidateGovernanceSnapshotRevision(context, candidate);
    try {
      const state = await candidateGovernanceStateOnce(context, candidate, requiresIndependentReview);
      const after = await candidateGovernanceSnapshotRevision(context, candidate);
      if (before === after) return state;
    } catch (error) {
      if (
        error instanceof LearningLoopError &&
        (error.code === "evidence.snapshot_changed" ||
          error.code === "query.snapshot_changed" ||
          error.code === "candidate.derivation_snapshot_changed")
      ) {
        continue;
      }
      throw error;
    }
  }
  throw new LearningLoopError("candidate.snapshot_changed", [
    {
      code: "candidate.snapshot_changed",
      severity: "error",
      message: "candidate governance inputs changed repeatedly while folding state",
    },
  ]);
}

function mergeEvidenceHealth(left: EvidenceHealthView, right: EvidenceHealthView): EvidenceHealthView {
  const rank = { ready: 0, legacy_unbound: 1, incomplete: 2, invalid: 3 } as const;
  const status = rank[left.status] >= rank[right.status] ? left.status : right.status;
  return { status, diagnostics: [...left.diagnostics, ...right.diagnostics] };
}
